import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as settingsCore from '../src/core/settings.mjs';
import * as meterCore from '../src/core/meter-reset.mjs';

// Run the actual scheduling section with a deterministic clock; no copied logic.
const main = fs.readFileSync(new URL('../src/content/main.js', import.meta.url), 'utf8');
const scheduler = main.slice(main.indexOf('const METER_DISARM_DELAYS_MS'), main.indexOf('/**\n * Clear interaction blockers'));
function fixture() {
  const tasks = new Map(), effects = [];
  let id = 0;
  const url = 'https://www.spiked-online.com/2026/09/11/example-story/';
  const window = {}; window.top = window;
  const context = vm.createContext({
    settings: settingsCore.normalizeSettings({}), exclusionHosts: [], window,
    pageUrl: () => url, location: { hostname: 'www.spiked-online.com' }, document: {},
    setTimeout: (fn) => { tasks.set(++id, fn); return id; },
    clearTimeout: (key) => tasks.delete(key),
    chrome: { runtime: { sendMessage: (msg) => { effects.push(msg.type); return Promise.resolve(); } } },
  });
  vm.runInContext(scheduler, context);
  const core = { ...settingsCore, ...meterCore,
    disarmMeterWall: () => { effects.push('disarm'); return { useful: false }; },
    detectMeterWall: () => ({ strongSelector: true }), restoreMeterWall: () => {},
  };
  return { context, tasks, effects, core, url, run: () => { for (const fn of [...tasks.values()]) fn(); } };
}

test('OFF cancels pending meter callbacks and next enable can schedule again', () => {
  const f = fixture();
  f.context.scheduleMeterHandling(f.core, f.context.settings, f.url);
  assert.ok(f.tasks.size > 0);
  f.context.settings.enabled = false;
  f.context.cancelMeterHandling();
  f.run();
  assert.deepEqual(f.effects, []);
  assert.equal(f.tasks.size, 0);
  f.context.settings.enabled = true;
  f.context.scheduleMeterHandling(f.core, f.context.settings, f.url);
  f.run();
  assert.ok(f.effects.includes('GAF_RESET_METER'));
});

test('queued callbacks use current settings and exclusions, not the scheduled snapshot', () => {
  for (const exclude of [false, true]) {
    const f = fixture();
    f.context.scheduleMeterHandling(f.core, f.context.settings, f.url);
    if (exclude) f.context.exclusionHosts = ['spiked-online.com'];
    else f.context.settings = settingsCore.normalizeSettings({ enabled: false });
    f.run();
    assert.deepEqual(f.effects, []);
  }
});

test('iframe cannot schedule page-level disarm or reset', () => {
  const f = fixture();
  f.context.window.top = {};
  f.context.scheduleMeterHandling(f.core, f.context.settings, f.url);
  assert.equal(f.tasks.size, 0);
});

test('disarm restores original inline properties and active class across repeated passes', () => {
  const values = new Map([['display', ['flex', 'important']], ['color', ['red', '']]]);
  const attrs = new Map(); const classes = new Set(['active']);
  const gate = {
    style: {
      getPropertyValue: (k) => values.get(k)?.[0] || '',
      getPropertyPriority: (k) => values.get(k)?.[1] || '',
      setProperty: (k, v, p = '') => values.set(k, [v, p]),
      removeProperty: (k) => values.delete(k),
    },
    classList: { contains: (k) => classes.has(k), remove: (k) => classes.delete(k), add: (k) => classes.add(k) },
    getAttribute: (k) => attrs.get(k) ?? null,
    setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k),
  };
  let style;
  const doc = {
    querySelector: () => null,
    querySelectorAll: (sel) => sel === '.gated-content-wrap.paywall' ? [gate] : [],
    body: { innerText: 'Article text '.repeat(100) },
    getElementById: () => style,
    createElement: () => ({ setAttribute() {}, remove() { style = null; } }),
    head: { appendChild: (el) => { style = el; } },
  };
  meterCore.disarmMeterWall(doc);
  meterCore.disarmMeterWall(doc);
  // A subsequent site change must survive restoration.
  gate.style.setProperty('visibility', 'collapse');
  meterCore.restoreMeterWall(doc);
  assert.deepEqual(values.get('display'), ['flex', 'important']);
  assert.equal(values.has('pointer-events'), false);
  assert.equal(values.get('visibility')[0], 'collapse');
  assert.equal(values.get('color')[0], 'red');
  assert.equal(classes.has('active'), true);
  assert.equal(attrs.has('data-gaf-meter-disarmed'), false);
  assert.equal(style, null);
  meterCore.restoreMeterWall(doc);
  assert.deepEqual(values.get('display'), ['flex', 'important']);
});
