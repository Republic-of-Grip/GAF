import { resolveSitePolicy } from '../core/settings.mjs';
import {
  clearCookiesForPageUrl,
  meterAutoStorageKey,
  shouldAutoMeterReset,
  shouldEscalateMeterWipe,
} from '../core/meter-reset.mjs';

/** One reset at a time per tab. The retry record survives page and worker reloads. */
export function createMeterResetter({ chromeApi, loadSettings, getExclusionHosts }) {
  const busy = new Set();

  async function resetMeterForTab(tabId, pageUrl, opts = {}) {
    if (busy.has(tabId)) return { ok: false, error: 'reset-in-progress' };
    busy.add(tabId);
    try {
      const auto = opts.auto === true;
      const expectedUrl = new URL(pageUrl).href;
      if (!/^https?:/.test(expectedUrl)) return { ok: false, error: 'not-http' };
      let settings;
      async function allowed() {
        const [tab, current, exclusions] = await Promise.all([
          chromeApi.tabs.get(tabId), loadSettings(), getExclusionHosts(),
        ]);
        settings = current;
        return tab.url === expectedUrl &&
          resolveSitePolicy(expectedUrl, current, exclusions).active &&
          current.meterResetEnabled !== false && current.features?.meterReset !== false &&
          (!auto || shouldAutoMeterReset(expectedUrl, current, exclusions));
      }
      if (!(await allowed())) return { ok: false, error: 'inactive-or-page-changed' };

      const send = (message) => chromeApi.tabs.sendMessage(tabId,
        { ...message, expectedUrl, auto }, { frameId: 0 });

      // Claim before any effects; fail closed if session storage is unavailable.
      // Never store this guard in the page's sessionStorage (manual wipes erase it).
      if (auto) {
        const key = `gafMeterAttempts:${tabId}`;
        const data = await chromeApi.storage.session.get({ [key]: [] });
        const attempts = data[key];
        const pageKey = meterAutoStorageKey(expectedUrl);
        if (attempts.includes(pageKey) || attempts.length >= 500) {
          return { ok: false, error: 'already-attempted' };
        }
        await chromeApi.storage.session.set({ [key]: [...attempts, pageKey] });
        if (!(await allowed())) return { ok: false, error: 'inactive-or-page-changed' };
      }

      let disarm = null;
      try { disarm = await send({ type: 'GAF_DISARM_METER' }); } catch { /* unavailable */ }
      const useful = Boolean(disarm?.useful || (disarm?.articleChars || 0) >= 400);
      if (auto) {
        if (useful) return { ok: true, cookiesRemoved: 0, storageCleared: false, reloaded: false, disarm };
        let signals;
        try { signals = await send({ type: 'GAF_DETECT_METER_WALL' }); } catch { /* fail closed */ }
        if (!signals?.ok || !shouldEscalateMeterWipe(signals)) {
          return { ok: false, error: 'no-meter-evidence' };
        }
      }
      if (!(await allowed())) return { ok: false, error: 'inactive-or-page-changed' };
      const cookieMode = auto ? 'meter-names' : opts.cookieMode || settings.meterResetCookieMode;
      const clearStorage = !auto && Boolean(opts.clearStorage ?? settings.meterResetClearStorage);
      const clearDurable = !auto && Boolean(opts.clearDurable ?? settings.meterResetClearDurableStorage);
      const cookies = await clearCookiesForPageUrl(expectedUrl, {
        mode: cookieMode === 'all' ? 'all' : 'meter-names',
        cookiesApi: chromeApi.cookies,
        canProceed: allowed,
      });
      if (cookies.error === 'cancelled' || !(await allowed())) {
        return { ok: false, error: 'inactive-or-page-changed', cookiesRemoved: cookies.removed };
      }
      let storageCleared = false;
      if (clearStorage || clearDurable) {
        const result = await send({ type: 'GAF_CLEAR_PAGE_STORAGE', webStorage: clearStorage, durable: clearDurable });
        if (!result?.ok) return { ok: false, error: result?.error || 'storage-clear-failed',
          cookiesRemoved: cookies.removed || 0, storageCleared: false, reloaded: false };
        storageCleared = true;
      }
      let reloaded = false;
      const shouldReload = opts.reload !== false &&
        (opts.reload === true || opts.forceReload || !useful);
      if (shouldReload && await allowed()) {
        await chromeApi.tabs.reload(tabId);
        reloaded = true;
      }
      return {
        ok: cookies.ok !== false || useful,
        cookiesRemoved: cookies.removed || 0,
        cookieNames: cookies.names || [],
        domain: cookies.domain || '', storageCleared, reloaded, disarm,
        error: cookies.error,
      };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    } finally {
      busy.delete(tabId);
    }
  }

  async function resetMeterFromMessage(message, sender) {
    // Content scripts can request automatic resets only for their own top frame.
    if (message.auto === true && (!sender?.tab?.id || sender.frameId !== 0)) {
      return { ok: false, error: 'top-frame-required' };
    }
    if (sender?.tab && message.auto !== true) return { ok: false, error: 'manual-reset-requires-extension-ui' };
    const tabId = sender?.tab?.id || message.tabId;
    if (!tabId) return { ok: false, error: 'no-tab' };
    const tab = await chromeApi.tabs.get(tabId);
    const url = message.url || tab.url;
    if (url !== tab.url) return { ok: false, error: 'page-changed' };
    return resetMeterForTab(tabId, url, message);
  }

  return { resetMeterForTab, resetMeterFromMessage };
}
