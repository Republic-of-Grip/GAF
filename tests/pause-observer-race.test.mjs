import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { effectiveSettingsForTab } from '../src/core/tab-pause.mjs';

// Run the real setEnabledFromSettings / refreshState / stateForPolicy from
// main.js. A history read during boot (stateForPolicy while settings is still
// null) or a meter re-read (refreshState) must not publish and leave the
// observer unstarted or still running.
const main = fs.readFileSync(new URL('../src/content/main.js', import.meta.url), 'utf8');

function programSource() {
  const loadStart = main.indexOf('function loadCore()');
  const loadEnd = main.indexOf('/**\n * Popup windows');
  const applyStart = main.indexOf('async function applyAll(');
  const applyEnd = main.indexOf('const METER_DISARM_DELAYS_MS');
  const boot = main.indexOf('\n// Boot\n');
  if ([loadStart, loadEnd, applyStart, applyEnd, boot].some((n) => n < 0)) {
    throw new Error(`main.js markers moved: ${[loadStart, loadEnd, applyStart, applyEnd, boot].join(',')}`);
  }
  return (
    `${main.slice(0, loadStart)
    }function loadCore() { return Promise.resolve(globalThis.__core); }\n${
      main.slice(loadEnd, applyStart)
    }async function applyAll(committed) {\n`
    + '  globalThis.__applyCalls.push(committed);\n'
    + '  return { active: Boolean(committed?.settings?.enabled) };\n'
    + `}\n${
      main.slice(applyEnd, boot)
    }globalThis.__api = {
  refreshState,
  setEnabledFromSettings,
  stateForPolicy,
  read() {
    return {
      settings,
      tabPaused,
      exclusionHosts: exclusionHosts.slice(),
      observerOn: Boolean(observer),
      enableGeneration,
      settledEnableGeneration,
    };
  },
};
`
  );
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(label, fn) {
  for (let i = 0; i < 40; i += 1) {
    if (fn()) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function harness() {
  const pauseQueue = [];
  const hostQueue = [];
  const timers = new Map();
  let timerSeq = 0;
  const window = {
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
    dispatchEvent() {},
    opener: null,
  };
  window.top = window;
  const document = {
    documentElement: {},
    location: { href: 'https://example.com/story' },
    addEventListener() {},
    removeEventListener() {},
  };
  const sandbox = {
    console,
    CustomEvent,
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    document,
    window,
    location: { href: 'https://example.com/story', hostname: 'example.com' },
    setTimeout(fn) {
      const id = ++timerSeq;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval() {
      return ++timerSeq;
    },
    clearInterval() {},
    chrome: {
      runtime: {
        sendMessage() {
          const pending = deferred();
          pauseQueue.push(pending);
          return pending.promise;
        },
        getURL(path) {
          return path;
        },
      },
      storage: {
        local: {
          async get() {
            return { gafExclusions: [] };
          },
        },
      },
    },
    __applyCalls: [],
    __core: {
      async loadSettings() {
        return { enabled: true, freezeImages: true };
      },
      normalizeSettings(raw) {
        return raw;
      },
      DEFAULT_SETTINGS: { enabled: true },
      effectiveSettingsForTab,
      activeExclusionHosts(list) {
        return list;
      },
      getActiveExclusionHosts() {
        const pending = deferred();
        hostQueue.push(pending);
        return pending.promise;
      },
      resolveSitePolicy() {
        return { active: true, host: 'example.com' };
      },
      shouldTimeFreezeOnPage() {
        return false;
      },
      timeFreezeMainConfig(settings, extra) {
        return { ...(extra || {}), settings };
      },
      restoreMeterWall() {},
      restoreScriptedMotion() {},
      removeMotionStyle() {},
      removeHideStyle() {},
      removeSiteCss() {},
      removeReadingSnapshot() {},
      restoreFrozenMedia() {},
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(programSource(), sandbox);
  return { api: sandbox.__api, pauseQueue, hostQueue, timers, applyCalls: sandbox.__applyCalls };
}

async function settleEnabled(env) {
  const done = env.api.setEnabledFromSettings();
  await until('seed pause', () => env.pauseQueue.length === 1);
  env.pauseQueue[0].resolve({ paused: false });
  await until('seed hosts', () => env.hostQueue.length === 1);
  env.hostQueue[0].resolve(['seed.example']);
  await done;
  env.pauseQueue.length = 0;
  env.hostQueue.length = 0;
  env.applyCalls.length = 0;
}

async function overlap(env, {
  startOther,
  decisionPaused,
  otherPaused,
  decisionHosts = ['older.example'],
  otherHosts = ['newer.example'],
  olderFinishesFirst = false,
}) {
  const decision = env.api.setEnabledFromSettings();
  await until('decision pause query', () => env.pauseQueue.length === 1);
  const other = startOther();
  await until('overlapping pause query', () => env.pauseQueue.length === 2);
  const decisionPause = env.pauseQueue[0];
  const otherPause = env.pauseQueue[1];
  if (olderFinishesFirst) {
    decisionPause.resolve({ paused: decisionPaused });
    await until('decision hosts', () => env.hostQueue.length >= 1);
    otherPause.resolve({ paused: otherPaused });
    await until('other hosts', () => env.hostQueue.length === 2);
    env.hostQueue[0].resolve(decisionHosts);
    await flush();
    env.hostQueue[1].resolve(otherHosts);
  } else {
    otherPause.resolve({ paused: otherPaused });
    await until('other hosts', () => env.hostQueue.length >= 1);
    decisionPause.resolve({ paused: decisionPaused });
    await until('decision hosts', () => env.hostQueue.length === 2);
    env.hostQueue[0].resolve(otherHosts);
    env.hostQueue[1].resolve(decisionHosts);
  }
  await decision;
  await other;
  return env.api.read();
}

test('a history read during boot still starts the observer when filtering stays on', { timeout: 2000 }, async () => {
  const env = harness();
  const state = await overlap(env, {
    startOther: () => env.api.stateForPolicy(),
    decisionPaused: false,
    otherPaused: false,
  });
  assert.equal(state.enableGeneration, 2);
  assert.equal(state.settledEnableGeneration, 2);
  assert.equal(state.observerOn, true);
  assert.equal(state.settings.enabled, true);
  assert.equal(state.tabPaused, false);
  assert.deepEqual(state.exclusionHosts, ['newer.example']);
  assert.equal(env.timers.size, 2);
  assert.equal(env.applyCalls.length, 1);
  assert.equal(env.applyCalls[0].settings.enabled, true);
});

test('a meter re-read overlapping pause still stops the observer', { timeout: 2000 }, async () => {
  const env = harness();
  await settleEnabled(env);
  assert.equal(env.api.read().observerOn, true);
  const state = await overlap(env, {
    startOther: () => env.api.refreshState(),
    decisionPaused: true,
    otherPaused: true,
    olderFinishesFirst: true,
  });
  assert.equal(state.enableGeneration, 3);
  assert.equal(state.settledEnableGeneration, 3);
  assert.equal(state.observerOn, false);
  assert.equal(state.settings.enabled, false);
  assert.equal(state.tabPaused, true);
  assert.deepEqual(state.exclusionHosts, ['newer.example']);
  assert.equal(env.timers.size, 0);
});

test('the observer matches the newer read when it disagrees with the decision reply', { timeout: 2000 }, async () => {
  const turnedOn = harness();
  const resumed = await overlap(turnedOn, {
    startOther: () => turnedOn.api.refreshState(),
    decisionPaused: true,
    otherPaused: false,
  });
  assert.equal(resumed.observerOn, true);
  assert.equal(resumed.settings.enabled, true);
  assert.equal(resumed.tabPaused, false);
  assert.deepEqual(resumed.exclusionHosts, ['newer.example']);

  const turnedOff = harness();
  await settleEnabled(turnedOff);
  const paused = await overlap(turnedOff, {
    startOther: () => turnedOff.api.refreshState(),
    decisionPaused: false,
    otherPaused: true,
    olderFinishesFirst: true,
  });
  assert.equal(paused.observerOn, false);
  assert.equal(paused.settings.enabled, false);
  assert.equal(paused.tabPaused, true);
  assert.deepEqual(paused.exclusionHosts, ['newer.example']);
});

test('an older enable cannot restart the observer after a newer pause decision wins', { timeout: 2000 }, async () => {
  const env = harness();
  await settleEnabled(env);
  const older = env.api.setEnabledFromSettings();
  await until('older pause query', () => env.pauseQueue.length === 1);
  const newer = env.api.setEnabledFromSettings();
  await until('newer pause query', () => env.pauseQueue.length === 2);
  env.pauseQueue[1].resolve({ paused: true });
  await until('newer hosts', () => env.hostQueue.length >= 1);
  env.pauseQueue[0].resolve({ paused: false });
  await until('older hosts', () => env.hostQueue.length === 2);
  env.hostQueue[0].resolve(['paused.example']);
  env.hostQueue[1].resolve(['resumed.example']);
  await newer;
  await older;
  const state = env.api.read();
  assert.equal(state.observerOn, false);
  assert.equal(state.settings.enabled, false);
  assert.equal(state.tabPaused, true);
  assert.deepEqual(state.exclusionHosts, ['paused.example']);
});
