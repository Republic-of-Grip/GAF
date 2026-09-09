import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExclusion,
  normalizeExclusions,
  activeExclusionHosts,
  upsertExclusion,
  updateExclusion,
  migrateAllowHostsToExclusions,
} from '../src/core/exclusions.mjs';

test('createExclusion normalizes host and defaults status open', () => {
  const e = createExclusion({ host: 'www.Telegraph.co.uk', reason: 'broke login' });
  assert.equal(e.host, 'telegraph.co.uk');
  assert.equal(e.status, 'open');
  assert.ok(e.id);
});

test('activeExclusionHosts ignores resolved', () => {
  const list = normalizeExclusions([
    createExclusion({ host: 'a.test' }),
    { ...createExclusion({ host: 'b.test' }), status: 'resolved' },
    { ...createExclusion({ host: 'c.test' }), status: 'reviewing' },
  ]);
  const hosts = activeExclusionHosts(list);
  assert.deepEqual(hosts.sort(), ['a.test', 'c.test']);
});

test('upsert replaces per host', () => {
  let list = [createExclusion({ host: 'x.test', reason: 'old' })];
  list = upsertExclusion(list, createExclusion({ host: 'x.test', reason: 'new' }));
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, 'new');
});

test('updateExclusion changes status', () => {
  const e = createExclusion({ host: 'y.test' });
  const list = updateExclusion([e], e.id, { status: 'resolved' });
  assert.equal(list[0].status, 'resolved');
});

test('migrateAllowHostsToExclusions', () => {
  const list = migrateAllowHostsToExclusions(['a.com', 'www.b.com'], []);
  assert.equal(list.length, 2);
  assert.ok(list.every((x) => x.status === 'open'));
  assert.ok(list.some((x) => x.host === 'b.com'));
});
