import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAuthoritativeSettings } from '../src/core/storage.mjs';

test('resolveAuthoritativeSettings prefers local over differing sync', () => {
  const { settings, source } = resolveAuthoritativeSettings(
    { enabled: false, videoPolicy: 'off' },
    { enabled: true, videoPolicy: 'heuristic' }
  );
  assert.equal(source, 'local');
  assert.equal(settings.enabled, false);
  assert.equal(settings.videoPolicy, 'off');
});

test('resolveAuthoritativeSettings falls back to sync when local empty', () => {
  const { settings, source } = resolveAuthoritativeSettings(null, {
    enabled: false,
    motionLevel: 'strict',
  });
  assert.equal(source, 'sync');
  assert.equal(settings.enabled, false);
  assert.equal(settings.motionLevel, 'strict');
});

test('resolveAuthoritativeSettings treats empty object as missing', () => {
  const { settings, source } = resolveAuthoritativeSettings({}, { enabled: false });
  assert.equal(source, 'sync');
  assert.equal(settings.enabled, false);
});

test('resolveAuthoritativeSettings defaults when both missing', () => {
  const { settings, source } = resolveAuthoritativeSettings(null, null);
  assert.equal(source, 'default');
  assert.equal(settings.enabled, true);
});
