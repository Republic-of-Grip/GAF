import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeZipPath, stripArchiveRoot, unzipArrayBuffer } from '../src/core/zip.mjs';
import { buildZip, SAMPLE_GAF_MANIFEST } from './helpers/build-zip.mjs';

test('unzipArrayBuffer reads stored GitHub-style archives and strips the root folder', async () => {
  const zip = buildZip([
    { path: 'GAF-main/manifest.json', data: SAMPLE_GAF_MANIFEST },
    { path: 'GAF-main/src/core/hello.mjs', data: 'export const n = 1;\n' },
  ]);
  const entries = stripArchiveRoot(await unzipArrayBuffer(zip));
  const paths = entries.map((e) => e.path).sort();
  assert.deepEqual(paths, ['manifest.json', 'src/core/hello.mjs']);
  const manifest = entries.find((e) => e.path === 'manifest.json');
  assert.equal(new TextDecoder().decode(manifest.bytes), SAMPLE_GAF_MANIFEST);
});

test('unzipArrayBuffer inflates deflate entries', async () => {
  const zip = buildZip(
    [
      { path: 'GAF-0.2.29/manifest.json', data: SAMPLE_GAF_MANIFEST },
      { path: 'GAF-0.2.29/readme.txt', data: 'hello from deflate '.repeat(20) },
    ],
    { method: 'deflate' }
  );
  const entries = stripArchiveRoot(await unzipArrayBuffer(zip));
  const readme = entries.find((e) => e.path === 'readme.txt');
  assert.equal(new TextDecoder().decode(readme.bytes), 'hello from deflate '.repeat(20));
});

test('isSafeZipPath rejects traversal and .git', () => {
  assert.equal(isSafeZipPath('manifest.json'), true);
  assert.equal(isSafeZipPath('src/core/updates.mjs'), true);
  assert.equal(isSafeZipPath('../secret'), false);
  assert.equal(isSafeZipPath('foo/../../etc/passwd'), false);
  assert.equal(isSafeZipPath('.git/config'), false);
  assert.equal(isSafeZipPath('/tmp/x'), false);
});

test('stripArchiveRoot leaves mixed roots alone', () => {
  const out = stripArchiveRoot([
    { path: 'manifest.json', bytes: new Uint8Array([1]) },
    { path: 'src/a.js', bytes: new Uint8Array([2]) },
  ]);
  assert.deepEqual(
    out.map((e) => e.path),
    ['manifest.json', 'src/a.js']
  );
});

test('stripArchiveRoot is idempotent for a lone manifest.json', () => {
  const once = stripArchiveRoot([{ path: 'GAF-main/manifest.json', bytes: new Uint8Array([1]) }]);
  assert.deepEqual(
    once.map((e) => e.path),
    ['manifest.json']
  );
  const twice = stripArchiveRoot(once);
  assert.deepEqual(
    twice.map((e) => e.path),
    ['manifest.json']
  );
});
