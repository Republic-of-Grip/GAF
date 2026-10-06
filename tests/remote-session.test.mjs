import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRemoteSettings, remotePageUrl, remoteEndpoint, saveRemoteSettings, remoteRequest, createRemoteTabController } from '../src/core/remote-session.mjs';

test('remote settings enforce encrypted cloud endpoints and stay outside sync/export', async () => {
  for (const endpoint of ['http://cloud.example', 'https://user:pass@example.com', 'https://example.com/?key=secret', 'file:///tmp/x', 'https://example.com/api']) assert.throws(() => remoteEndpoint(endpoint));
  assert.equal(remoteEndpoint('http://127.0.0.1:8765/'), 'http://127.0.0.1:8765');
  assert.equal(remoteEndpoint('https://cloud.example/'), 'https://cloud.example');
  for (const url of ['chrome://settings', 'file:///etc/passwd', 'https://user:pass@example.com']) assert.throws(() => remotePageUrl(url));
  let stored;
  const settings = await saveRemoteSettings({ providers: [{ id: 'local', endpoint: 'http://localhost:8765', token: 'secret' }], agents: ['Agent', 'Agent'], idleMinutes: 0 }, { set: async value => { stored = value; } });
  assert.deepEqual(Object.keys(stored), ['gafRemoteConnections']);
  assert.deepEqual(settings.agents, ['Agent']);
  assert.deepEqual(normalizeRemoteSettings().providers, []);
});

test('remote requests omit local cookies, prevent redirects, and send tokens only in headers', async () => {
  await remoteRequest('https://cloud.example', '/sessions', 'secret', { method: 'POST', body: { url: 'https://example.com' }, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://cloud.example/sessions');
    assert.equal(options.headers.Authorization, 'Bearer secret');
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
    return { ok: true, json: async () => ({ id: 'id' }) };
  } });
});

function fixture() {
  const data = {};
  const calls = [];
  const tab = { id: 7, url: 'https://example.com/page' };
  const chromeApi = {
    runtime: { getURL: path => `chrome-extension://test/${path}` },
    tabs: { get: async () => ({ ...tab }), update: async (_id, update) => { Object.assign(tab, update); } },
    storage: { session: { get: async key => ({ [key]: data[key] }), set: async obj => Object.assign(data, obj), remove: async key => { delete data[key]; } } },
  };
  const request = async (...args) => { calls.push(args); return args[1] === '/sessions' ? { id: 'a'.repeat(32), ownerToken: 'owner' } : null; };
  const loadConnections = async () => normalizeRemoteSettings({ providers: [{ id: 'local', name: 'Local', endpoint: 'http://localhost:8765', token: 'key' }], agents: ['Assistant'] });
  return { tab, data, calls, chromeApi, request, loadConnections };
}

test('launch replaces only the requesting tab, and closing/navigation deletes the whole remote session', async () => {
  const f = fixture(); const controller = createRemoteTabController(f);
  await controller.open(7);
  assert.match(f.tab.url, /src\/remote\/viewer.html$/);
  assert.equal((await controller.record(7)).sourceUrl, 'https://example.com/page');
  assert.deepEqual(f.calls[0][3].body.agents, ['Assistant']);
  await controller.navigated(7, 'https://example.com/other');
  assert.equal(f.calls.at(-1)[3].method, 'DELETE');
  assert.equal(await controller.record(7), null);
});

test('launch cancels and cleans up if source tab changes while the server starts', async () => {
  const f = fixture(); const original = f.request;
  f.request = async (...args) => { const result = await original(...args); if (args[1] === '/sessions') f.tab.url = 'https://example.com/new'; return result; };
  const controller = createRemoteTabController(f);
  await assert.rejects(controller.open(7), /tab changed/);
  assert.equal(f.tab.url, 'https://example.com/new');
  assert.equal(f.calls.at(-1)[3].method, 'DELETE'); assert.equal(await controller.record(7), null);
});

test('tab replacement failure cleans up, and duplicate launches cannot leak sessions', async () => {
  const f = fixture();
  let resolve;
  f.request = (...args) => args[1] === '/sessions' ? new Promise(r => { resolve = r; }) : Promise.resolve(null);
  const controller = createRemoteTabController(f);
  const first = controller.open(7);
  await assert.rejects(controller.open(7), /already starting/);
  await new Promise(r => setTimeout(r, 0));
  f.chromeApi.tabs.update = async () => { throw new Error('closed tab'); };
  resolve({ id: 'b'.repeat(32), ownerToken: 'owner' });
  await assert.rejects(first, /closed tab/);
  assert.equal(await controller.record(7), null);
});

test('a slow old-session deletion cannot erase the new session after navigating and reopening remotely', async () => {
  const f = fixture();
  let created = 0;
  let release;
  f.request = async (_endpoint, path) => {
    if (path === '/sessions') return { id: String(++created).repeat(32), ownerToken: 'owner' };
    if (path.endsWith('1'.repeat(32))) await new Promise(resolve => { release = resolve; });
    return null;
  };
  const controller = createRemoteTabController(f);
  await controller.open(7);
  const ending = controller.end(7);
  await new Promise(resolve => setTimeout(resolve, 0));
  f.tab.url = 'https://example.com/other';
  await controller.open(7);
  release(); await ending;
  assert.equal((await controller.record(7)).id, '2'.repeat(32));
});

// ---- Review follow-ups (shared sessions) ---------------------------------
import { connectionVerdict, OWNER_LEASE_MS } from '../src/core/remote-session.mjs';
import { readFileSync } from 'node:fs';

test('failed requests carry the HTTP status so the viewer can tell "ended" from "retry"', async () => {
  const fetchImpl = async () => ({ ok: false, status: 410, json: async () => ({ error: 'Session ended or access denied.' }) });
  const error = await remoteRequest('http://127.0.0.1:8765', '/sessions/x/state', 't', { fetchImpl }).catch(e => e);
  assert.equal(error.status, 410);
  assert.equal(error.message, 'Session ended or access denied.');
});

test('a transient failure keeps the session; only 410 or a lapsed owner lease ends it', () => {
  assert.equal(connectionVerdict({ status: 410 }, 0), 'ended');
  assert.equal(connectionVerdict(new TypeError('Failed to fetch'), 5_000), 'retry', 'Wi-Fi blip');
  assert.equal(connectionVerdict({ status: 400 }, 30_000), 'retry', 'busy companion');
  assert.equal(connectionVerdict(new Error('timeout'), OWNER_LEASE_MS + 1), 'expired');
  assert.equal(OWNER_LEASE_MS, 90_000);
  const companion = readFileSync(new URL('../companion/sessions.mjs', import.meta.url), 'utf8');
  assert.match(companion, /leaseMs = 90_000/, 'viewer lease mirrors the companion');
  const viewer = readFileSync(new URL('../src/remote/viewer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(viewer, /refreshState\(\)\.catch\(\(\) => finish/, 'one failed poll must not end the session');
  assert.match(viewer, /refreshState\(\)\.catch\(connectionProblem\)/);
  assert.match(viewer, /heartbeat\(\)\.catch\(connectionProblem\)/);
});
