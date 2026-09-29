import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createTabPause,
  effectiveSettingsForTab,
  tabPauseKey,
  TAB_PAUSE_BADGE,
} from '../src/core/tab-pause.mjs';
import {
  normalizeSettings,
  resolveSitePolicy,
  shouldFreezeImagesOnPage,
  shouldTimeFreezeOnPage,
} from '../src/core/settings.mjs';

function fakeChrome({ failReads = false } = {}) {
  const store = {};
  const badges = [];
  return {
    store,
    badges,
    storage: {
      session: {
        async get(keys) {
          if (failReads) throw new Error('session unavailable');
          if (keys === null) return { ...store };
          const k = typeof keys === 'string' ? keys : Object.keys(keys)[0];
          return k in store ? { [k]: store[k] } : {};
        },
        async set(obj) {
          Object.assign(store, obj);
        },
        async remove(k) {
          delete store[k];
        },
      },
    },
    action: {
      async setBadgeText(d) {
        badges.push(['text', d.text, d.tabId]);
      },
      async setBadgeBackgroundColor(d) {
        badges.push(['color', d.color, d.tabId]);
      },
    },
  };
}

test('pause, query and resume one tab', async () => {
  const chromeApi = fakeChrome();
  const pause = createTabPause({ chromeApi, now: () => 1000 });
  assert.equal(await pause.isPaused(7), false);
  assert.deepEqual(await pause.setPaused(7, true, { url: 'https://shop.example/checkout' }), {
    ok: true,
    paused: true,
  });
  assert.equal(await pause.isPaused(7), true);
  assert.equal(await pause.isPaused(8), false, 'other tabs keep filtering');
  assert.deepEqual(chromeApi.store[tabPauseKey(7)], { since: 1000, url: 'https://shop.example/checkout' });
  await pause.setPaused(7, false);
  assert.equal(await pause.isPaused(7), false);
});

test('closing a tab forgets its pause', async () => {
  const chromeApi = fakeChrome();
  const pause = createTabPause({ chromeApi });
  await pause.setPaused(3, true);
  await pause.forgetTab(3);
  assert.equal(await pause.isPaused(3), false);
  assert.deepEqual(await pause.pausedTabIds(), []);
});

test('invalid tab ids are refused and never read as paused', async () => {
  const pause = createTabPause({ chromeApi: fakeChrome() });
  assert.equal((await pause.setPaused(undefined, true)).ok, false);
  assert.equal((await pause.setPaused(-1, true)).ok, false);
  assert.equal(await pause.isPaused(undefined), false);
});

test('unreadable session storage fails open (tab not paused)', async () => {
  const pause = createTabPause({ chromeApi: fakeChrome({ failReads: true }) });
  assert.equal(await pause.isPaused(5), false);
  assert.deepEqual(await pause.pausedTabIds(), []);
});

test('global badge repaint restores the paused-tab marker', async () => {
  const chromeApi = fakeChrome();
  const pause = createTabPause({ chromeApi });
  await pause.setPaused(4, true);
  await pause.setPaused(9, true);
  chromeApi.badges.length = 0;
  await pause.repaintPausedBadges();
  const texts = chromeApi.badges.filter(([k]) => k === 'text');
  assert.deepEqual(
    texts.map(([, text, tabId]) => [text, tabId]).sort((a, b) => a[1] - b[1]),
    [
      [TAB_PAUSE_BADGE.text, 4],
      [TAB_PAUSE_BADGE.text, 9],
    ],
  );
  chromeApi.badges.length = 0;
  await pause.paintTabBadge(4, false);
  assert.deepEqual(chromeApi.badges, [['text', '', 4]]);
});

test('a paused tab resolves as inactive through the normal policy checks', () => {
  const s = normalizeSettings({ enabled: true, freezeImages: true, timeFreezeMode: 'slow', timeFreezeScope: 'all' });
  const url = 'https://news.example/article';
  assert.equal(resolveSitePolicy(url, effectiveSettingsForTab(s, false)).active, true);
  const paused = effectiveSettingsForTab(s, true);
  assert.equal(resolveSitePolicy(url, paused).active, false);
  assert.equal(shouldFreezeImagesOnPage(url, paused), false);
  assert.equal(shouldTimeFreezeOnPage(url, paused), false);
  // The stored settings object is not mutated (other tabs keep filtering).
  assert.equal(s.enabled, true);
});

test('every content script honours the tab pause', () => {
  for (const f of ['src/content/early.js', 'src/content/unstick-early.js', 'src/content/main.js']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, /GAF_TAB_PAUSE_STATE/, `${f} asks for pause state`);
    assert.match(src, /GAF_TAB_PAUSE_CHANGED/, `${f} reacts to pause changes`);
  }
});

test('service worker: popup pauses a tab, frames read it, pages cannot set it', async () => {
  const session = {};
  const listeners = {};
  const sent = [];
  const on = (name) => ({ addListener: (fn) => { (listeners[name] ||= []).push(fn); } });
  globalThis.chrome = {
    storage: {
      session: {
        get: async (k) => (k === null ? { ...session } : typeof k === 'string' ? (k in session ? { [k]: session[k] } : {}) : { ...k }),
        set: async (o) => Object.assign(session, o),
        remove: async (k) => { delete session[k]; },
      },
      local: { get: async (d) => ({ ...d }), set: async () => {} },
      sync: { get: async (d) => ({ ...d }), set: async () => {} },
      onChanged: on('storageChanged'),
    },
    runtime: { onMessage: on('message'), onInstalled: on('installed'), onStartup: on('startup'), getURL: (p) => p },
    tabs: {
      query: async () => [],
      sendMessage: async (tabId, message) => { sent.push([tabId, message.type]); },
      onRemoved: on('tabRemoved'),
      onActivated: on('tabActivated'),
      onUpdated: on('tabUpdated'),
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setIcon: async () => {}, setTitle: async () => {} },
    contextMenus: { removeAll: (cb) => cb?.(), create: () => {}, onClicked: on('menu') },
    cookies: {},
  };
  await import(`../src/background/service-worker.js?t=${Date.now()}`);
  const handler = listeners.message[0];
  const ask = (message, sender = {}) =>
    new Promise((resolve) => {
      const async = handler(message, sender, resolve);
      if (!async) setTimeout(() => resolve(undefined), 0);
    });

  // A page (content script) may not pause a tab.
  const denied = await ask({ type: 'GAF_SET_TAB_PAUSE', tabId: 12, paused: true }, { tab: { id: 12 } });
  assert.equal(denied.ok, false);

  // The popup (no sender.tab) pauses tab 12; its frames are told to re-read.
  const ok = await ask({ type: 'GAF_SET_TAB_PAUSE', tabId: 12, paused: true, url: 'https://shop.example/' });
  assert.equal(ok.ok, true);
  assert.deepEqual(sent.at(-1), [12, 'GAF_TAB_PAUSE_CHANGED']);

  // Any frame in tab 12 sees the pause; a frame in tab 13 does not, even if it asks about 12.
  assert.equal((await ask({ type: 'GAF_TAB_PAUSE_STATE' }, { tab: { id: 12 }, frameId: 3 })).paused, true);
  assert.equal((await ask({ type: 'GAF_TAB_PAUSE_STATE', tabId: 12 }, { tab: { id: 13 } })).paused, false);

  // Closing the tab clears it.
  listeners.tabRemoved.forEach((fn) => fn(12));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal((await ask({ type: 'GAF_TAB_PAUSE_STATE' }, { tab: { id: 12 } })).paused, false);
  delete globalThis.chrome;
});
