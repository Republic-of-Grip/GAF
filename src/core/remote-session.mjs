// Separate from filter settings: connection secrets never enter sync or filter exports.
export const REMOTE_SETTINGS_KEY = 'gafRemoteConnections';
export const REMOTE_SESSION_PREFIX = 'gafRemoteTab:';

/** Mirrors the companion's owner lease (companion/sessions.mjs leaseMs). */
export const OWNER_LEASE_MS = 90_000;

/**
 * What a failed viewer poll means. 'ended': the companion says the session is
 * gone (410). 'expired': no heartbeat landed for a whole lease, so the
 * companion has ended it. 'retry': anything else (Wi-Fi blip, busy companion).
 */
export function connectionVerdict(error, msSinceHeartbeat, leaseMs = OWNER_LEASE_MS) {
  if (error?.status === 410) return 'ended';
  if (msSinceHeartbeat > leaseMs) return 'expired';
  return 'retry';
}

export function remoteEndpoint(value) {
  const url = new URL(String(value || '').trim());
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use an HTTPS server address (HTTP is allowed only on localhost), without a path or credentials.');
  }
  return url.origin;
}

export function remotePageUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Remote sessions support HTTP/HTTPS pages without credentials in the URL.');
  }
  return url.href;
}

export function normalizeRemoteSettings(value = {}) {
  const providers = (Array.isArray(value.providers) ? value.providers : []).slice(0, 12).map((p, i) => ({
    id: String(p.id || `route-${i}`).slice(0, 80),
    name: String(p.name || '').trim().slice(0, 80) || 'Remote connection',
    endpoint: remoteEndpoint(p.endpoint),
    token: String(p.token || '').trim().slice(0, 512),
  }));
  if (new Set(providers.map(p => p.id)).size !== providers.length) throw new Error('Connection IDs must be unique.');
  return {
    providers,
    defaultProvider: providers.some(p => p.id === value.defaultProvider) ? value.defaultProvider : providers[0]?.id || '',
    idleMinutes: Math.max(1, Math.min(60, Number(value.idleMinutes) || 15)),
    agents: [...new Set((Array.isArray(value.agents) ? value.agents : []).map(a => String(a).trim().slice(0, 80)).filter(Boolean))].slice(0, 12),
  };
}

export async function loadRemoteSettings(storage = chrome.storage.local) {
  const data = await storage.get(REMOTE_SETTINGS_KEY);
  return normalizeRemoteSettings(data[REMOTE_SETTINGS_KEY]);
}

export async function saveRemoteSettings(value, storage = chrome.storage.local) {
  const normalized = normalizeRemoteSettings(value);
  await storage.set({ [REMOTE_SETTINGS_KEY]: normalized });
  return normalized;
}

export async function remoteRequest(endpoint, path, token, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${remoteEndpoint(endpoint)}${path}`, {
    method, credentials: 'omit', cache: 'no-store', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    let message = 'Remote connection failed.';
    try { message = (await response.json()).error || message; } catch { /* no content */ }
    const error = new Error(message);
    error.status = response.status; // 410 = session ended; anything else may be transient
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

export function createRemoteTabController({ chromeApi, request = remoteRequest, loadConnections = loadRemoteSettings }) {
  const starting = new Set();
  const metadataLocks = new Map();
  const storage = chromeApi.storage.session;
  const key = id => `${REMOTE_SESSION_PREFIX}${id}`;
  const viewer = chromeApi.runtime.getURL('src/remote/viewer.html');
  async function record(id) { return (await storage.get(key(id)))[key(id)] || null; }
  function withMetadataLock(id, operation) {
    const work = (metadataLocks.get(id) || Promise.resolve()).catch(() => {}).then(operation);
    metadataLocks.set(id, work);
    work.finally(() => { if (metadataLocks.get(id) === work) metadataLocks.delete(id); }).catch(() => {});
    return work;
  }
  async function end(id) {
    const session = await record(id);
    if (!session) return;
    // A slow deletion for an old session must not erase a newer session in this tab.
    // The owner's server lease handles network failure; extension metadata is discarded.
    try { await request(session.endpoint, `/sessions/${session.id}`, session.ownerToken, { method: 'DELETE' }); }
    finally {
      await withMetadataLock(id, async () => {
        if ((await record(id))?.id === session.id) await storage.remove(key(id));
      });
    }
  }
  async function open(id, providerId) {
    if (!Number.isInteger(id) || starting.has(id)) throw new Error('A remote session is already starting.');
    starting.add(id);
    let created;
    let provider;
    try {
      const tab = await chromeApi.tabs.get(id);
      const sourceUrl = remotePageUrl(tab.url);
      const settings = await loadConnections();
      provider = settings.providers.find(p => p.id === (providerId || settings.defaultProvider));
      if (!provider?.token) throw new Error('Set up a remote connection in Options → Shared sessions first.');
      created = await request(provider.endpoint, '/sessions', provider.token, {
        method: 'POST', body: { url: sourceUrl, idleMinutes: settings.idleMinutes, agents: settings.agents },
      });
      if (!/^[a-f0-9]{32}$/.test(created?.id) || typeof created?.ownerToken !== 'string') throw new Error('Invalid remote session response.');
      const current = await chromeApi.tabs.get(id);
      if (current.url !== tab.url) throw new Error('The tab changed while connecting. Try again on the current page.');
      await withMetadataLock(id, () => storage.set({ [key(id)]: {
        id: created.id, ownerToken: created.ownerToken, endpoint: provider.endpoint,
        routeName: provider.name, sourceUrl, idleMinutes: settings.idleMinutes,
      } }));
      await chromeApi.tabs.update(id, { url: viewer });
      return { ok: true };
    } catch (error) {
      if (created?.id && provider) {
        await request(provider.endpoint, `/sessions/${encodeURIComponent(created.id)}`, created.ownerToken, { method: 'DELETE' }).catch(() => {});
        await withMetadataLock(id, async () => {
          if ((await record(id))?.id === created.id) await storage.remove(key(id));
        });
      }
      throw error;
    } finally { starting.delete(id); }
  }
  async function navigated(id, url) {
    if (url && url !== viewer && await record(id)) await end(id);
  }
  return { open, end, record, navigated };
}
