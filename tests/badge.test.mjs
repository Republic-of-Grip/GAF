import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isBadgeOn,
  BADGE_ON,
  BADGE_OFF,
  ICON_PATHS_ON,
  ICON_PATHS_OFF,
  paintActionBadge,
} from '../src/core/badge.mjs';

test('isBadgeOn treats true/default as on', () => {
  assert.equal(isBadgeOn(true), true);
  assert.equal(isBadgeOn(undefined), true);
  assert.equal(isBadgeOn(null), true);
  assert.equal(isBadgeOn(1), true);
});

test('isBadgeOn treats falsey flags as off', () => {
  assert.equal(isBadgeOn(false), false);
  assert.equal(isBadgeOn(0), false);
  assert.equal(isBadgeOn('false'), false);
  assert.equal(isBadgeOn('0'), false);
});

test('badge labels', () => {
  assert.equal(BADGE_ON.text, 'ON');
  assert.equal(BADGE_OFF.text, 'OFF');
});

test('global badge repaint clears per-tab text with null and rewrites tab colors', async () => {
  const calls = [];
  const previous = globalThis.chrome;
  globalThis.chrome = {
    tabs: { query: async () => [{ id: 3 }, { id: 9 }] },
    runtime: {},
  };
  try {
    await paintActionBadge(true, {
      async setBadgeText(details) {
        calls.push(['text', details.text, details.tabId ?? null]);
      },
      async setBadgeBackgroundColor(details) {
        calls.push(['color', details.color, details.tabId ?? null]);
      },
      async setTitle() {},
      async setIcon() {},
    });
  } finally {
    globalThis.chrome = previous;
  }
  assert.deepEqual(
    calls.filter((call) => call[2] != null && call[0] === 'text').sort((a, b) => a[2] - b[2]),
    [
      ['text', null, 3],
      ['text', null, 9],
    ],
  );
  assert.ok(calls.some((call) => call[0] === 'color' && call[1] === BADGE_ON.color && call[2] === 3));
  assert.ok(calls.some((call) => call[0] === 'text' && call[1] === 'ON' && call[2] == null));
});

test('on/off icon path maps differ', () => {
  assert.ok(ICON_PATHS_ON[16].includes('icon-on-'));
  assert.ok(ICON_PATHS_OFF[16].includes('icon-off-'));
  assert.notEqual(ICON_PATHS_ON[32], ICON_PATHS_OFF[32]);
});
