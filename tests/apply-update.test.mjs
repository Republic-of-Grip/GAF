import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLY_PAGE_PATH,
  NEED_DIRECTORY,
  applyUnpackedUpdate,
  assertGafDirectory,
  buildApplyPageUrl,
  createMemoryHandleStore,
  fileSystemAccessAvailable,
  isTrustedGafZipUrl,
  looksLikeGafManifest,
  openApplyUi,
  prepareZipEntries,
} from '../src/core/apply-update.mjs';
import { unzipArrayBuffer } from '../src/core/zip.mjs';
import { buildZip, SAMPLE_GAF_MANIFEST } from './helpers/build-zip.mjs';
import { createMemoryDirectory, readMemoryFile } from './helpers/memory-fs.mjs';

const ZIP_URL = 'https://github.com/Republic-of-Grip/GAF/archive/refs/heads/main.zip';

function zipResponse(bytes) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test('isTrustedGafZipUrl allows only GAF GitHub archives', () => {
  assert.equal(isTrustedGafZipUrl(ZIP_URL), true);
  assert.equal(
    isTrustedGafZipUrl('https://codeload.github.com/Republic-of-Grip/GAF/zip/refs/tags/v0.2.29'),
    true
  );
  assert.equal(isTrustedGafZipUrl('https://github.com/evil/GAF/archive/refs/heads/main.zip'), false);
  assert.equal(isTrustedGafZipUrl('https://example.test/gaf.zip'), false);
  assert.equal(isTrustedGafZipUrl('http://github.com/Republic-of-Grip/GAF/archive/refs/heads/main.zip'), false);
});

test('looksLikeGafManifest requires GAF identity', () => {
  assert.equal(looksLikeGafManifest(JSON.parse(SAMPLE_GAF_MANIFEST)), true);
  assert.equal(looksLikeGafManifest({ name: 'Unrelated', version: '1.0.0' }), false);
  assert.equal(looksLikeGafManifest(null), false);
});

test('fileSystemAccessAvailable reflects showDirectoryPicker', () => {
  assert.equal(fileSystemAccessAvailable({}), false);
  assert.equal(fileSystemAccessAvailable({ showDirectoryPicker() {} }), true);
});

test('buildApplyPageUrl carries version and zip query params', () => {
  const url = buildApplyPageUrl(
    {
      installed: '0.2.28',
      remote: '0.2.29',
      zipUrl: ZIP_URL,
    },
    (path) => `chrome-extension://gafid/${path}`
  );
  assert.ok(url.startsWith(`chrome-extension://gafid/${APPLY_PAGE_PATH}?`));
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('version'), '0.2.29');
  assert.equal(parsed.searchParams.get('installed'), '0.2.28');
  assert.equal(parsed.searchParams.get('zip'), ZIP_URL);
});

test('openApplyUi prefers a popup window then falls back to a tab', async () => {
  const windows = [];
  const tabs = [];
  const mode = await openApplyUi('chrome-extension://gafid/src/update/apply.html', {
    windows: {
      create: async (opts) => {
        windows.push(opts);
      },
    },
    tabs: {
      create: async (opts) => {
        tabs.push(opts);
      },
    },
  });
  assert.equal(mode.mode, 'window');
  assert.equal(windows[0].type, 'popup');
  assert.deepEqual(tabs, []);

  const tabMode = await openApplyUi('chrome-extension://gafid/src/update/apply.html', {
    windows: {
      create: async () => {
        throw new Error('nope');
      },
    },
    tabs: {
      create: async (opts) => {
        tabs.push(opts);
      },
    },
  });
  assert.equal(tabMode.mode, 'tab');
  assert.equal(tabs[0].url, 'chrome-extension://gafid/src/update/apply.html');
});

test('assertGafDirectory rejects a non-GAF folder', async () => {
  const empty = createMemoryDirectory({ 'notes.txt': 'hi' });
  await assert.rejects(() => assertGafDirectory(empty), /manifest.json/);
  const other = createMemoryDirectory({
    'manifest.json': JSON.stringify({ name: 'Other', version: '1.0.0' }),
  });
  await assert.rejects(() => assertGafDirectory(other), /does not look like GAF/);
});

test('prepareZipEntries drops traversal and keeps GAF files', async () => {
  const zip = buildZip([
    { path: 'GAF-main/manifest.json', data: SAMPLE_GAF_MANIFEST },
    { path: 'GAF-main/../evil.js', data: 'nope' },
    { path: 'GAF-main/src/ok.js', data: 'ok' },
  ]);
  const prepared = prepareZipEntries(await unzipArrayBuffer(zip));
  assert.deepEqual(
    prepared.map((e) => e.path).sort(),
    ['manifest.json', 'src/ok.js']
  );
});

test('applyUnpackedUpdate writes the zip over the unpacked folder and reloads', async () => {
  const zip = buildZip([
    { path: 'GAF-main/manifest.json', data: SAMPLE_GAF_MANIFEST },
    { path: 'GAF-main/src/core/hello.mjs', data: 'export const hello = true;\n' },
  ]);
  const dir = createMemoryDirectory({
    'manifest.json': JSON.stringify({
      manifest_version: 3,
      name: 'GAF — General Annoyance Filter',
      short_name: 'GAF',
      version: '0.2.28',
    }),
    'src/core/hello.mjs': 'export const hello = false;\n',
  });
  let reloads = 0;
  const result = await applyUnpackedUpdate({
    zipUrl: ZIP_URL,
    expectedVersion: '0.2.29',
    fetch: async () => zipResponse(zip),
    handleStore: createMemoryHandleStore(dir),
    reload: async () => {
      reloads += 1;
    },
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.version, '0.2.29');
  assert.equal(reloads, 1);
  assert.match(await readMemoryFile(dir, 'manifest.json'), /0\.2\.29/);
  assert.equal(await readMemoryFile(dir, 'src/core/hello.mjs'), 'export const hello = true;\n');
});

test('applyUnpackedUpdate asks for a folder when none is remembered', async () => {
  await assert.rejects(
    () =>
      applyUnpackedUpdate({
        zipUrl: ZIP_URL,
        expectedVersion: '0.2.29',
        fetch: async () => {
          throw new Error('should not fetch yet');
        },
        handleStore: createMemoryHandleStore(),
      }),
    (err) => err.code === NEED_DIRECTORY
  );
});

test('applyUnpackedUpdate reuses a picker result and stores it', async () => {
  const zip = buildZip([{ path: 'GAF-main/manifest.json', data: SAMPLE_GAF_MANIFEST }]);
  const dir = createMemoryDirectory({
    'manifest.json': JSON.stringify({
      name: 'GAF — General Annoyance Filter',
      short_name: 'GAF',
      version: '0.2.28',
    }),
  });
  const store = createMemoryHandleStore();
  let picks = 0;
  const result = await applyUnpackedUpdate({
    zipUrl: ZIP_URL,
    expectedVersion: '0.2.29',
    fetch: async () => zipResponse(zip),
    handleStore: store,
    pickDirectory: async () => {
      picks += 1;
      return dir;
    },
    reload: async () => {},
  });
  assert.equal(result.version, '0.2.29');
  assert.equal(picks, 1);
  assert.equal(await store.get(), dir);
});

test('applyUnpackedUpdate rejects an untrusted zip URL', async () => {
  await assert.rejects(
    () =>
      applyUnpackedUpdate({
        zipUrl: 'https://evil.example/gaf.zip',
        handleStore: createMemoryHandleStore(),
      }),
    /GitHub repository/
  );
});
