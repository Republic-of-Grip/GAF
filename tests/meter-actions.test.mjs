import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeterResetter } from '../src/background/meter-actions.mjs';
import { normalizeSettings } from '../src/core/settings.mjs';

const url = 'https://www.spiked-online.com/2026/09/11/example-story/';
function fixture() {
  const state = { settings: normalizeSettings({}), exclusions: [], url, session: {}, effects: [],
    evidence: true, onReadCookies: null, onRemoveCookie: null, sessionUnavailable: false };
  const chromeApi = {
    tabs: {
      get: async () => ({ id: 7, url: state.url }),
      reload: async () => state.effects.push('reload'),
      sendMessage: async (id, message, target) => {
        assert.equal(id, 7);
        assert.equal(target.frameId, 0);
        assert.equal(message.expectedUrl, url);
        if (message.type === 'GAF_DISARM_METER') return { ok: true, useful: false, articleChars: 0 };
        if (message.type === 'GAF_DETECT_METER_WALL') return { ok: true, strongSelector: state.evidence };
        state.effects.push(message);
        return state.storageFailure ? { ok: false, error: 'storage unavailable' } : { ok: true };
      },
    },
    storage: { session: {
      get: async (defaults) => {
        if (state.sessionUnavailable) throw new Error('session unavailable');
        return { ...defaults, ...state.session };
      },
      set: async (value) => Object.assign(state.session, value),
    } },
    cookies: {
      getAll: async () => {
        state.onReadCookies?.();
        return ['meter_count', 'access_token', 'session', 'free_article_count'].map((name) => ({
          name, domain: 'www.spiked-online.com', path: '/', secure: true, storeId: '0',
        }));
      },
      remove: async (details) => { state.effects.push(details.name); state.onRemoveCookie?.(); return details; },
    },
  };
  const deps = { chromeApi, loadSettings: async () => state.settings, getExclusionHosts: async () => state.exclusions };
  return { state, deps, ...createMeterResetter(deps) };
}

test('automatic reset ignores broad deletion options and keeps its retry marker across worker restart', async () => {
  const f = fixture();
  const options = { auto: true, clearStorage: true, clearDurable: true, cookieMode: 'all', reload: true };
  const result = await f.resetMeterForTab(7, url, options);
  assert.equal(result.ok, true);
  assert.equal(result.storageCleared, false);
  assert.deepEqual(f.state.effects, ['meter_count', 'free_article_count', 'reload']);
  const freshWorker = createMeterResetter(f.deps);
  assert.equal((await freshWorker.resetMeterForTab(7, url, options)).error, 'already-attempted');
  assert.equal(f.state.effects.filter((v) => v === 'reload').length, 1);
});

test('manual reset can explicitly clear all cookies and selected storage', async () => {
  const f = fixture();
  const result = await f.resetMeterForTab(7, url, { cookieMode: 'all', clearStorage: true, clearDurable: true });
  assert.equal(result.storageCleared, true);
  assert.ok(f.state.effects.includes('access_token'));
  const clear = f.state.effects.find((v) => v.type === 'GAF_CLEAR_PAGE_STORAGE');
  assert.equal(clear.auto, false);
  assert.equal(clear.webStorage, true);
  assert.equal(clear.durable, true);
});

test('automatic reset refuses OFF, exclusions, manual mode, and changed tab URLs', async () => {
  for (const change of [
    (s) => { s.settings.enabled = false; },
    (s) => { s.exclusions = ['spiked-online.com']; },
    (s) => { s.settings.meterResetMode = 'manual'; },
    (s) => { s.url = 'https://example.com/'; },
  ]) {
    const f = fixture(); change(f.state);
    assert.equal((await f.resetMeterForTab(7, url, { auto: true })).ok, false);
    assert.deepEqual(f.state.effects, []);
  }
});

test('recheck policy and URL after cookie enumeration, before deletion', async () => {
  for (const change of [
    (s) => { s.settings.enabled = false; },
    (s) => { s.exclusions = ['spiked-online.com']; },
    (s) => { s.url = 'https://example.com/'; },
  ]) {
    const f = fixture(); f.state.onReadCookies = () => change(f.state);
    assert.equal((await f.resetMeterForTab(7, url, { auto: true })).ok, false);
    assert.deepEqual(f.state.effects, []);
  }
});

test('OFF during deletion stops subsequent deletions and reload', async () => {
  const f = fixture();
  f.state.onRemoveCookie = () => { f.state.settings.enabled = false; };
  await f.resetMeterForTab(7, url, { auto: true });
  assert.deepEqual(f.state.effects, ['meter_count']);
});

test('fail closed without retry storage or fresh wall evidence', async () => {
  for (const key of ['sessionUnavailable', 'evidence']) {
    const f = fixture(); f.state[key] = key === 'sessionUnavailable';
    assert.equal((await f.resetMeterForTab(7, url, { auto: true })).ok, false);
    assert.deepEqual(f.state.effects, []);
  }
});

test('simultaneous automatic requests do not repeat deletion', async () => {
  const f = fixture();
  const results = await Promise.all([
    f.resetMeterForTab(7, url, { auto: true }), f.resetMeterForTab(7, url, { auto: true }),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(f.state.effects.filter((v) => v === 'reload').length, 1);
});

test('automatic messages must come from the top frame and cannot target another tab or URL', async () => {
  const f = fixture();
  const message = { auto: true, url, tabId: 999 };
  assert.equal((await f.resetMeterFromMessage(message, { tab: { id: 7 }, frameId: 2 })).error, 'top-frame-required');
  assert.equal((await f.resetMeterFromMessage(message, {})).error, 'top-frame-required');
  assert.equal((await f.resetMeterFromMessage({ ...message, url: 'https://example.com/' }, { tab: { id: 7 }, frameId: 0 })).error, 'page-changed');
  assert.deepEqual(f.state.effects, []);
  assert.equal((await f.resetMeterFromMessage(message, { tab: { id: 7 }, frameId: 0 })).ok, true);
});

test('manual storage failure is reported without reloading', async () => {
  const f = fixture();
  f.state.storageFailure = true;
  const result = await f.resetMeterForTab(7, url, { clearStorage: true, reload: true });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'storage unavailable');
  assert.equal(result.reloaded, false);
  assert.ok(!f.state.effects.includes('reload'));
});
