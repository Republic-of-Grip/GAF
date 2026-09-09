import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isBadgeOn,
  BADGE_ON,
  BADGE_OFF,
  ICON_PATHS_ON,
  ICON_PATHS_OFF,
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

test('on/off icon path maps differ', () => {
  assert.ok(ICON_PATHS_ON[16].includes('icon-on-'));
  assert.ok(ICON_PATHS_OFF[16].includes('icon-off-'));
  assert.notEqual(ICON_PATHS_ON[32], ICON_PATHS_OFF[32]);
});
