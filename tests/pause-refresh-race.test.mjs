import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { effectiveSettingsForTab } from '../src/core/tab-pause.mjs';

// Run the real refreshState from main.js. Two overlapping GAF_TAB_PAUSE_STATE
// reads must not let the older reply publish settings, tabPaused, or exclusion
// hosts after the newer read has won.
const main = fs.readFileSync(new URL('../src/content/main.js', import.meta.url), 'utf8');
const start = main.indexOf('let settings = null;');
const end = main.indexOf('function pushTimeFreezeConfig');
const refreshSlice = main.slice(start, end).replace(
  /function loadCore\(\) \{[\s\S]*?\n\}/,
  'function loadCore() { return Promise.resolve(globalThis.__core); }',
);

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
  for (let i = 0; i < 30; i += 1) {
    if (fn()) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function publishedEnabled(result) {
  if (result && Object.prototype.hasOwnProperty.call(result, 'settings') && result.settings) {
    return result.settings.enabled;
  }
  return result?.enabled;
}

function harness() {
  const pauseQueue = [];
  const hostQueue = [];
  const sandbox = {
    console,
    chrome: {
      runtime: {
        sendMessage() {
          const pending = deferred();
          pauseQueue.push(pending);
          return pending.promise;
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
    },
  };
  vm.createContext(sandbox);
  const prelude = refreshSlice.includes('let enableGeneration') ? '' : 'let enableGeneration = 0;\n';
  vm.runInContext(
    `${prelude}${refreshSlice}
globalThis.__hooks = {
  refreshState,
  read() {
    return {
      settings,
      tabPaused,
      exclusionHosts: exclusionHosts.slice(),
      enableGeneration,
    };
  },
};
`,
    sandbox,
  );
  return { hooks: sandbox.__hooks, pauseQueue, hostQueue };
}

async function overlap({ newerPaused, olderPaused, newerHosts, olderHosts }) {
  const { hooks, pauseQueue, hostQueue } = harness();
  const older = hooks.refreshState();
  const newer = hooks.refreshState();
  await until('both pause queries', () => pauseQueue.length === 2);

  // Newer reply lands first and still has to wait on exclusion hosts.
  pauseQueue[1].resolve({ paused: newerPaused });
  await until('newer exclusion fetch', () => hostQueue.length >= 1);
  // Older reply lands while that fetch is in flight.
  pauseQueue[0].resolve({ paused: olderPaused });
  await until('older exclusion fetch', () => hostQueue.length === 2);

  hostQueue[0].resolve(newerHosts);
  const newerResult = await newer;
  const afterNewer = hooks.read();

  hostQueue[1].resolve(olderHosts);
  const olderResult = await older;
  return { newerResult, olderResult, afterNewer, afterOlder: hooks.read() };
}

test('an older pause reply cannot turn filtering back on after a newer pause wins', async () => {
  const { newerResult, olderResult, afterNewer, afterOlder } = await overlap({
    newerPaused: true,
    olderPaused: false,
    newerHosts: ['newer.example'],
    olderHosts: ['older.example'],
  });
  assert.equal(newerResult.committed, true);
  assert.equal(olderResult.committed, false);
  assert.equal(publishedEnabled(newerResult), false);
  assert.equal(afterNewer.settings.enabled, false);
  assert.equal(afterNewer.tabPaused, true);
  assert.deepEqual(afterNewer.exclusionHosts, ['newer.example']);
  assert.equal(afterOlder.settings.enabled, false);
  assert.equal(afterOlder.tabPaused, true);
  assert.deepEqual(afterOlder.exclusionHosts, ['newer.example']);
});

test('an older pause reply cannot tear filtering down after a newer resume wins', async () => {
  const { newerResult, olderResult, afterNewer, afterOlder } = await overlap({
    newerPaused: false,
    olderPaused: true,
    newerHosts: ['live.example'],
    olderHosts: ['stale.example'],
  });
  assert.equal(newerResult.committed, true);
  assert.equal(olderResult.committed, false);
  assert.equal(publishedEnabled(newerResult), true);
  assert.equal(afterNewer.settings.enabled, true);
  assert.equal(afterNewer.tabPaused, false);
  assert.deepEqual(afterNewer.exclusionHosts, ['live.example']);
  assert.equal(afterOlder.settings.enabled, true);
  assert.equal(afterOlder.tabPaused, false);
  assert.deepEqual(afterOlder.exclusionHosts, ['live.example']);
});
