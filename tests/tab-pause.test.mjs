import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createTabPause,
  effectiveSettingsForTab,
  tabPauseKey,
  TAB_PAUSE_BADGE,
  handleTabPauseMessage,
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
  assert.deepEqual(chromeApi.badges, [['text', null, 4]]);
});

test('resume drops the per-tab badge so the global ON/OFF color shows', async () => {
  const chromeApi = fakeChrome();
  const globalColor = [22, 130, 70, 255];
  chromeApi.action.getBadgeBackgroundColor = async () => globalColor;
  const pause = createTabPause({ chromeApi });
  await pause.setPaused(4, true);
  chromeApi.badges.length = 0;
  await pause.paintTabBadge(4, false);
  assert.deepEqual(chromeApi.badges, [
    ['text', null, 4],
    ['color', globalColor, 4],
  ]);
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

test('every content script honours the tab pause and drops a stale reply', () => {
  const epochs = {
    'src/content/early.js': /tabPauseEpoch/,
    'src/content/unstick-early.js': /refreshEpoch/,
    'src/content/main.js': /enableGeneration/,
  };
  for (const [f, epoch] of Object.entries(epochs)) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, /GAF_TAB_PAUSE_STATE/, `${f} asks for pause state`);
    assert.match(src, /GAF_TAB_PAUSE_CHANGED/, `${f} reacts to pause changes`);
    assert.match(src, epoch, `${f} ignores an older pause reply`);
  }
});

test('pause messages: popup pauses a tab, frames read it, pages cannot set it', async () => {
  const chromeApi = fakeChrome();
  const tabPause = createTabPause({ chromeApi });
  const notified = [];
  const deps = { tabPause, notifyTab: async (id) => notified.push(id) };
  const send = (message, sender = {}) => handleTabPauseMessage(message, sender, deps);

  assert.equal(send({ type: 'GAF_SYNC_BADGE' }), null, 'other messages are not handled');

  // A page (content script) may not pause a tab.
  const denied = await send({ type: 'GAF_SET_TAB_PAUSE', tabId: 12, paused: true }, { tab: { id: 12 } });
  assert.equal(denied.ok, false);
  assert.equal(await tabPause.isPaused(12), false);

  // The popup (no sender.tab) pauses tab 12; its frames are told to re-read.
  const ok = await send({ type: 'GAF_SET_TAB_PAUSE', tabId: 12, paused: true, url: 'https://shop.example/' });
  assert.equal(ok.ok, true);
  assert.deepEqual(notified, [12]);
  assert.ok(chromeApi.badges.some(([k, text, tabId]) => k === 'text' && text === TAB_PAUSE_BADGE.text && tabId === 12));

  // Any frame in tab 12 sees the pause; a frame in tab 13 does not, even if it asks about 12.
  assert.equal((await send({ type: 'GAF_TAB_PAUSE_STATE' }, { tab: { id: 12 }, frameId: 3 })).paused, true);
  assert.equal((await send({ type: 'GAF_TAB_PAUSE_STATE', tabId: 12 }, { tab: { id: 13 } })).paused, false);
  // The popup may ask about a specific tab.
  assert.equal((await send({ type: 'GAF_TAB_PAUSE_STATE', tabId: 12 })).paused, true);

  // Resume clears it.
  await send({ type: 'GAF_SET_TAB_PAUSE', tabId: 12, paused: false });
  assert.equal(await tabPause.isPaused(12), false);
});

test('service worker delegates pause messages and clears pauses on tab close', () => {
  // Static check: the worker itself is not loadable in Node 18 (ESM in a .js file).
  const src = readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(src, /handleTabPauseMessage\(message, _sender/);
  assert.match(src, /onRemoved\.addListener\(\(tabId\) => \{[\s\S]*?tabPause\.forgetTab\(tabId\)/);
  assert.match(src, /repaintPausedBadges\(\)/);
  assert.match(src, /isTabPaused: \(tabId\) => tabPause\.isPaused\(tabId\)/);
});
