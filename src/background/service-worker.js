/**
 * GAF service worker — badge, settings, context menu, archive, exclusions.
 */

import {
  DEFAULT_SETTINGS,
  STORAGE_KEY,
  EXCLUSIONS_KEY,
  normalizeSettings,
} from '../core/settings.mjs';
import {
  loadSettings,
  saveSettings,
  loadExclusions,
  saveExclusions,
  addArchiveEntry,
  getActiveExclusionHosts,
} from '../core/storage.mjs';
import {
  createExclusion,
  upsertExclusion,
  activeExclusionHosts,
  normalizeExclusions,
} from '../core/exclusions.mjs';
import { clearCookiesForPageUrl } from '../core/meter-reset.mjs';
import { paintActionBadge, isBadgeOn } from '../core/badge.mjs';

const MENU_ARCHIVE = 'gaf-archive-object';
const MENU_EXCLUDE = 'gaf-exclude-site';
const MENU_SNAPSHOT = 'gaf-snapshot-page';
const MENU_THAW = 'gaf-thaw-page';
const MENU_METER = 'gaf-reset-meter';

const TOP_FRAME_ID = 0;

/** Page-level actions must not run in every iframe origin. */
function sendToTopFrame(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message, { frameId: TOP_FRAME_ID });
}

async function updateBadge(enabled) {
  await paintActionBadge(enabled);
}

/** Re-read storage and refresh badge (service worker restarts leave stale OFF). */
async function refreshBadgeFromStorage() {
  try {
    const s = await loadSettings();
    await updateBadge(isBadgeOn(s.enabled));
    return s;
  } catch {
    await updateBadge(true);
    return null;
  }
}

/** After OK/EX/CLR flash on a tab, restore default badge and clear that tab override. */
function scheduleBadgeRestore(ms = 1200) {
  setTimeout(() => {
    refreshBadgeFromStorage().catch(() => {});
  }, ms);
}

async function broadcast(message) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  await Promise.allSettled(
    tabs.map((tab) => {
      if (!tab.id || !tab.url || !/^https?:/i.test(tab.url)) return Promise.resolve();
      return chrome.tabs.sendMessage(tab.id, message);
    })
  );
}

async function broadcastSettings(settings) {
  const normalized = normalizeSettings(settings);
  const exclusionHosts = await getActiveExclusionHosts();
  await broadcast({
    type: 'GAF_SETTINGS',
    settings: normalized,
    exclusionHosts,
  });
}

function ensureContextMenus() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU_ARCHIVE,
        title: 'GAF: Save object for inspection',
        contexts: ['all'],
      });
      chrome.contextMenus.create({
        id: MENU_EXCLUDE,
        title: 'GAF: Exclude site (add to review backlog)',
        contexts: ['page', 'frame', 'selection', 'link', 'image', 'video', 'audio'],
      });
      chrome.contextMenus.create({
        id: MENU_SNAPSHOT,
        title: 'GAF: Freeze reading snapshot now',
        contexts: ['page', 'frame'],
      });
      chrome.contextMenus.create({
        id: MENU_THAW,
        title: 'GAF: Thaw page (end time freeze overlay)',
        contexts: ['page', 'frame'],
      });
      chrome.contextMenus.create({
        id: MENU_METER,
        title: 'GAF: Reset free-article meter (cookies) & reload',
        contexts: ['page', 'frame', 'link'],
      });
    });
  } catch {
    /* contextMenus permission missing */
  }
}

/**
 * Clear site cookies (+ optional page storage) and reload — Incognito-style meter reset.
 * @param {number} tabId
 * @param {string} pageUrl
 * @param {{ cookieMode?: string, clearStorage?: boolean, reload?: boolean }} [opts]
 */
async function resetMeterForTab(tabId, pageUrl, opts = {}) {
  const settings = await loadSettings();
  if (settings.meterResetEnabled === false || settings.features?.meterReset === false) {
    return { ok: false, error: 'meter-reset-disabled' };
  }
  const isAuto = opts.auto === true;
  const cookieMode = isAuto
    ? 'meter-names'
    : opts.cookieMode || settings.meterResetCookieMode || 'meter-names';
  const clearStorage =
    opts.clearStorage !== undefined ? opts.clearStorage : settings.meterResetClearStorage !== false;
  const clearDurable = isAuto
    ? false
    : Boolean(opts.clearDurable ?? settings.meterResetClearDurableStorage);
  let reload = opts.reload !== false;
  const forceReload = opts.forceReload === true;

  // 1) Disarm gate chrome first — Spiked ships full body + CSS gate
  let disarm = null;
  if (tabId) {
    try {
      disarm = await sendToTopFrame(tabId, { type: 'GAF_DISARM_METER' });
    } catch {
      disarm = null;
    }
  }

  // 2) Cookie wipe — only cookies that match this page URL
  const cookieResult = await clearCookiesForPageUrl(pageUrl, {
    mode: cookieMode === 'all' && !isAuto ? 'all' : 'meter-names',
  });

  // 3) Storage wipe (top frame only; durable stores only if explicitly selected)
  let storageCleared = false;
  if (clearStorage && tabId) {
    try {
      const response = await sendToTopFrame(tabId, {
        type: 'GAF_CLEAR_PAGE_STORAGE',
        durable: clearDurable,
      });
      storageCleared = Boolean(response?.ok);
    } catch {
      storageCleared = false;
    }
  }

  // 4) Reload only if body still looks empty / caller forces it
  const usefulDisarm = Boolean(disarm?.useful || (disarm?.articleChars || 0) >= 400);
  if (usefulDisarm && !forceReload && opts.reload !== true) {
    // Content already readable after disarm — skip reload so the user keeps scroll position
    reload = false;
  }
  if (opts.reload === true) reload = true;

  if (reload && tabId) {
    try {
      await chrome.tabs.reload(tabId);
    } catch {
      /* ignore */
    }
  }

  return {
    ok: cookieResult.ok !== false || usefulDisarm,
    cookiesRemoved: cookieResult.removed || 0,
    cookieNames: cookieResult.names || [],
    domain: cookieResult.domain || '',
    storageCleared,
    reloaded: reload,
    disarm,
    error: cookieResult.error,
  };
}

chrome.runtime.onInstalled.addListener(async (details) => {
  ensureContextMenus();
  if (details.reason === 'install') {
    await saveSettings(DEFAULT_SETTINGS);
    await updateBadge(true);
  } else {
    // Upgrade / reload: never leave a stale OFF badge
    await refreshBadgeFromStorage();
    await loadExclusions();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  ensureContextMenus();
  await refreshBadgeFromStorage();
});

// Service worker wake: keep badge honest
refreshBadgeFromStorage();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' || area === 'local') {
    if (changes[STORAGE_KEY]) {
      const next = normalizeSettings(changes[STORAGE_KEY].newValue);
      updateBadge(isBadgeOn(next.enabled));
    }
  }
});

// Re-paint when switching tabs so a stale per-tab badge cannot linger
try {
  chrome.tabs.onActivated.addListener(() => {
    refreshBadgeFromStorage().catch(() => {});
  });
  chrome.tabs.onUpdated.addListener((_tabId, info) => {
    if (info.status === 'complete') {
      refreshBadgeFromStorage().catch(() => {});
    }
  });
} catch {
  /* ignore */
}

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === MENU_ARCHIVE) {
    try {
      const frameId = Number.isInteger(info.frameId) ? info.frameId : TOP_FRAME_ID;
      const response = await chrome.tabs.sendMessage(
        tab.id,
        { type: 'GAF_ARCHIVE_ELEMENT' },
        { frameId },
      );
      if (response?.ok && response.entry) {
        await addArchiveEntry(response.entry);
        // Brief badge flash
        await chrome.action.setBadgeText({ text: 'OK', tabId: tab.id });
        scheduleBadgeRestore(1200);
      } else {
        console.warn('[GAF] archive failed', response?.error);
      }
    } catch (e) {
      console.warn('[GAF] archive message failed', e);
    }
    return;
  }

  if (info.menuItemId === MENU_EXCLUDE) {
    try {
      const url = tab.url || info.pageUrl || '';
      const host = new URL(url).hostname;
      const list = await loadExclusions();
      const entry = createExclusion({
        host,
        urlSample: url,
        reason: 'Excluded via context menu — site misbehaved under GAF',
        note: 'Review later; re-enable filtering when fixed.',
        source: 'context-menu',
        status: 'open',
      });
      await saveExclusions(upsertExclusion(list, entry));
      // Also clear from deny if present
      const settings = await loadSettings();
      const denyHosts = (settings.denyHosts || []).filter(
        (h) => h !== entry.host && !entry.host.endsWith(`.${h}`)
      );
      await saveSettings({ denyHosts });
      await broadcast({ type: 'GAF_EXCLUSIONS_CHANGED' });
      await chrome.action.setBadgeText({ text: 'EX', tabId: tab.id });
      scheduleBadgeRestore(1200);
    } catch (e) {
      console.warn('[GAF] exclude failed', e);
    }
    return;
  }

  if (info.menuItemId === MENU_SNAPSHOT) {
    try {
      await sendToTopFrame(tab.id, { type: 'GAF_SNAPSHOT_NOW' });
    } catch {
      /* ignore */
    }
    return;
  }

  if (info.menuItemId === MENU_THAW) {
    try {
      await sendToTopFrame(tab.id, { type: 'GAF_THAW' });
    } catch {
      /* ignore */
    }
    return;
  }

  if (info.menuItemId === MENU_METER) {
    try {
      const url = info.linkUrl || tab.url || info.pageUrl || '';
      // If user right-clicked a link, open meter-reset flow on that URL in the same tab
      // only when it matches the current page; otherwise reset cookies for the current page.
      const targetUrl = tab.url || url;
      const result = await resetMeterForTab(tab.id, targetUrl);
      await chrome.action.setBadgeText({
        text: result.ok ? 'CLR' : '!',
        tabId: tab.id,
      });
      scheduleBadgeRestore(1500);
    } catch (e) {
      console.warn('[GAF] meter reset failed', e);
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'GAF_SYNC_BADGE') {
    refreshBadgeFromStorage()
      .then((s) => sendResponse({ ok: true, enabled: isBadgeOn(s?.enabled), text: isBadgeOn(s?.enabled) ? 'ON' : 'OFF' }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (message?.type === 'GAF_GET_SETTINGS') {
    Promise.all([loadSettings(), loadExclusions()]).then(async ([s, ex]) => {
      await updateBadge(isBadgeOn(s.enabled));
      sendResponse({
        ok: true,
        settings: s,
        exclusions: ex,
        exclusionHosts: activeExclusionHosts(ex),
      });
    });
    return true;
  }

  if (message?.type === 'GAF_SAVE_SETTINGS') {
    saveSettings(message.settings || {})
      .then(async (s) => {
        await updateBadge(isBadgeOn(s.enabled));
        await broadcastSettings(s);
        sendResponse({ ok: true, settings: s });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (message?.type === 'GAF_TOGGLE') {
    loadSettings()
      .then(async (s) => {
        const next = await saveSettings({ ...s, enabled: !s.enabled });
        await updateBadge(isBadgeOn(next.enabled));
        await broadcastSettings(next);
        sendResponse({ ok: true, settings: next });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (message?.type === 'GAF_EXCLUDE_HOST') {
    loadExclusions()
      .then(async (list) => {
        const entry = createExclusion({
          host: message.host,
          urlSample: message.urlSample || '',
          reason: message.reason || 'Excluded — site misbehaved under GAF',
          note: message.note || 'Review later; re-enable when fixed.',
          source: message.source || 'popup',
          status: 'open',
        });
        const next = await saveExclusions(upsertExclusion(list, entry));
        await broadcast({ type: 'GAF_EXCLUSIONS_CHANGED' });
        sendResponse({ ok: true, exclusions: next, entry });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (message?.type === 'GAF_SAVE_EXCLUSIONS') {
    saveExclusions(message.exclusions || [])
      .then(async (next) => {
        await broadcast({ type: 'GAF_EXCLUSIONS_CHANGED' });
        sendResponse({ ok: true, exclusions: next });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (message?.type === 'GAF_GET_ARCHIVE') {
    chrome.storage.local.get({ gafArchive: [] }).then((data) => {
      sendResponse({ ok: true, archive: data.gafArchive || [] });
    });
    return true;
  }

  if (message?.type === 'GAF_CLEAR_ARCHIVE') {
    chrome.storage.local.set({ gafArchive: [] }).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === 'GAF_DELETE_ARCHIVE_ENTRY') {
    chrome.storage.local.get({ gafArchive: [] }).then(async (data) => {
      const next = (data.gafArchive || []).filter((e) => e.id !== message.id);
      await chrome.storage.local.set({ gafArchive: next });
      sendResponse({ ok: true, archive: next });
    });
    return true;
  }

  if (message?.type === 'GAF_RESET_METER') {
    (async () => {
      try {
        let tabId = message.tabId || _sender?.tab?.id;
        let pageUrl = message.url || _sender?.tab?.url || '';
        if (!tabId || !pageUrl) {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          tabId = tab?.id;
          pageUrl = pageUrl || tab?.url || '';
        }
        if (!tabId || !pageUrl) {
          sendResponse({ ok: false, error: 'no-tab' });
          return;
        }
        const result = await resetMeterForTab(tabId, pageUrl, {
          cookieMode: message.cookieMode,
          clearStorage: message.clearStorage,
          clearDurable: message.clearDurable,
          reload: message.reload !== false,
          forceReload: message.forceReload === true,
          auto: message.auto === true,
        });
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  return false;
});

// Init (service worker start / restart)
ensureContextMenus();
refreshBadgeFromStorage();
