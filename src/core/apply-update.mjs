/**
 * Apply a GitHub GAF zip over the unpacked folder Helium/Chromium loaded,
 * then reload the extension.
 *
 * Chromium cannot write into an unpacked install dir by itself, and Windows
 * Helium will not sideload a self-hosted CRX via update_url. The File System
 * Access picker (remembered after the first grant) is the most automatic path
 * that still works for Load unpacked / --load-extension.
 */

import { compareVersions, normalizeVersion } from './updates.mjs';
import { isSafeZipPath, stripArchiveRoot, unzipArrayBuffer } from './zip.mjs';

export const GITHUB_ZIP_OWNER = 'republic-of-grip';
export const GITHUB_ZIP_REPO = 'gaf';

const HANDLE_DB = 'gaf-unpacked-install';
const HANDLE_STORE = 'kv';
const HANDLE_KEY = 'directory';

export const NEED_DIRECTORY = 'NEED_DIRECTORY';
export const CANCELLED = 'CANCELLED';

export const PICK_FOLDER_HINT =
  'Choose the GAF folder Helium loaded (the one that contains manifest.json). GAF will copy the new files into that folder and reload.';

export function fileSystemAccessAvailable(globalObj = globalThis) {
  return typeof globalObj.showDirectoryPicker === 'function';
}

export function isTrustedGafZipUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'codeload.github.com') return false;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 4) return false;
    if (parts[0].toLowerCase() !== GITHUB_ZIP_OWNER) return false;
    if (parts[1].toLowerCase() !== GITHUB_ZIP_REPO) return false;
    const rest = parts.slice(2).join('/').toLowerCase();
    return (
      rest.startsWith('archive/') ||
      rest.startsWith('zip/') ||
      rest.startsWith('zipball/')
    );
  } catch {
    return false;
  }
}

export function looksLikeGafManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return false;
  if (manifest.short_name === 'GAF') return true;
  const name = String(manifest.name || '');
  return /GAF/.test(name) && /Annoyance Filter/i.test(name);
}

export function codedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function openHandleDb(indexedDBLike) {
  return new Promise((resolve, reject) => {
    const req = indexedDBLike.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open the GAF update store.'));
  });
}

export function createMemoryHandleStore(initial = null) {
  let handle = initial;
  return {
    async get() {
      return handle;
    },
    async set(next) {
      handle = next;
    },
    async clear() {
      handle = null;
    },
  };
}

export function createHandleStore({ indexedDBLike = globalThis.indexedDB } = {}) {
  if (!indexedDBLike) return createMemoryHandleStore();
  return {
    async get() {
      const db = await openHandleDb(indexedDBLike);
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(HANDLE_STORE, 'readonly');
          const req = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
    async set(handle) {
      const db = await openHandleDb(indexedDBLike);
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(HANDLE_STORE, 'readwrite');
          const req = tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
    async clear() {
      const db = await openHandleDb(indexedDBLike);
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(HANDLE_STORE, 'readwrite');
          const req = tx.objectStore(HANDLE_STORE).delete(HANDLE_KEY);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
  };
}

export async function queryReadWritePermission(handle) {
  if (!handle) return 'denied';
  if (typeof handle.queryPermission === 'function') {
    try {
      return await handle.queryPermission({ mode: 'readwrite' });
    } catch {
      return 'denied';
    }
  }
  return 'granted';
}

export async function requestReadWritePermission(handle) {
  if (!handle) return 'denied';
  if (typeof handle.requestPermission === 'function') {
    try {
      return await handle.requestPermission({ mode: 'readwrite' });
    } catch {
      return 'denied';
    }
  }
  return 'granted';
}

export async function readJsonFromDirectory(dirHandle, relativePath = 'manifest.json') {
  const parts = String(relativePath).split('/').filter(Boolean);
  let dir = dirHandle;
  const fileName = parts.pop();
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part);
  }
  const fileHandle = await dir.getFileHandle(fileName);
  const file = await fileHandle.getFile();
  return JSON.parse(await file.text());
}

export async function assertGafDirectory(dirHandle) {
  let manifest;
  try {
    manifest = await readJsonFromDirectory(dirHandle, 'manifest.json');
  } catch {
    throw new Error(
      'That folder does not contain manifest.json. Pick the GAF folder you loaded unpacked.'
    );
  }
  if (!looksLikeGafManifest(manifest)) {
    throw new Error(
      'That folder does not look like GAF. Pick the folder that contains the GAF manifest.json.'
    );
  }
  return manifest;
}

export async function tryReuseInstallDirectory(handleStore) {
  const handle = await handleStore?.get?.();
  if (!handle) return null;
  const permission = await queryReadWritePermission(handle);
  if (permission !== 'granted') return null;
  try {
    await assertGafDirectory(handle);
    return handle;
  } catch {
    return null;
  }
}

export async function pickAndStoreDirectory({ handleStore, pickDirectory }) {
  if (typeof pickDirectory !== 'function') {
    throw codedError(PICK_FOLDER_HINT, NEED_DIRECTORY);
  }
  let handle;
  try {
    handle = await pickDirectory();
  } catch (err) {
    if (err?.name === 'AbortError' || err?.code === CANCELLED) {
      throw codedError('Folder selection was cancelled. Nothing was installed.', CANCELLED);
    }
    throw err;
  }
  if (!handle) {
    throw codedError('Folder selection was cancelled. Nothing was installed.', CANCELLED);
  }
  const permission = await requestReadWritePermission(handle);
  if (permission !== 'granted') {
    throw new Error('GAF needs write access to that folder to install the update.');
  }
  await assertGafDirectory(handle);
  await handleStore?.set?.(handle);
  return handle;
}

export async function ensureWritableGafDirectory({ handleStore, pickDirectory }) {
  const reused = await tryReuseInstallDirectory(handleStore);
  if (reused) return reused;
  const stored = await handleStore?.get?.();
  if (stored) {
    const permission = await requestReadWritePermission(stored);
    if (permission === 'granted') {
      await assertGafDirectory(stored);
      return stored;
    }
  }
  return pickAndStoreDirectory({ handleStore, pickDirectory });
}

export async function writeFileAt(rootHandle, relativePath, bytes) {
  const parts = String(relativePath).split('/').filter(Boolean);
  const fileName = parts.pop();
  let dir = rootHandle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

export function prepareZipEntries(entries) {
  const stripped = stripArchiveRoot(entries);
  const prepared = [];
  for (const entry of stripped) {
    const path = String(entry.path || '').replace(/\\/g, '/');
    if (!isSafeZipPath(path)) continue;
    prepared.push({ path, bytes: entry.bytes });
  }
  return prepared;
}

export async function syncDirectory(dirHandle, entries) {
  const prepared = prepareZipEntries(entries);
  if (!prepared.some((e) => e.path === 'manifest.json')) {
    throw new Error('The download did not contain manifest.json.');
  }
  for (const entry of prepared) {
    await writeFileAt(dirHandle, entry.path, entry.bytes);
  }
  return prepared;
}

async function fetchZipBuffer(zipUrl, fetchFn) {
  let response;
  try {
    response = await fetchFn(zipUrl, {
      headers: { Accept: 'application/zip,application/octet-stream,*/*' },
    });
  } catch {
    throw new Error('Could not download the update from GitHub. Check your connection and try again.');
  }
  if (!response?.ok) {
    throw new Error('Could not download the update from GitHub.');
  }
  const buffer = await response.arrayBuffer();
  if (!buffer || buffer.byteLength < 22) {
    throw new Error('The download was not a valid ZIP.');
  }
  return buffer;
}

export function manifestFromEntries(entries) {
  const prepared = prepareZipEntries(entries);
  const manifestEntry = prepared.find((e) => e.path === 'manifest.json');
  if (!manifestEntry) {
    throw new Error('The download did not contain manifest.json.');
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestEntry.bytes));
  } catch {
    throw new Error('The download manifest.json was not valid JSON.');
  }
  if (!looksLikeGafManifest(manifest)) {
    throw new Error('The download does not look like GAF.');
  }
  return { manifest, version: normalizeVersion(manifest.version), entries: prepared };
}

/**
 * Download the published zip, write it over the unpacked GAF folder, reload.
 */
export async function applyUnpackedUpdate({
  zipUrl,
  expectedVersion,
  fetch: fetchFn = globalThis.fetch,
  handleStore,
  pickDirectory,
  reload,
  unzip = unzipArrayBuffer,
} = {}) {
  if (!isTrustedGafZipUrl(zipUrl)) {
    throw new Error('Update ZIP must come from the GAF GitHub repository.');
  }
  const dir = await ensureWritableGafDirectory({ handleStore, pickDirectory });
  const buffer = await fetchZipBuffer(zipUrl, fetchFn);
  const { manifest, version, entries } = manifestFromEntries(await unzip(buffer));
  if (expectedVersion && compareVersions(version, expectedVersion) < 0) {
    throw new Error('The download was older than expected. Try again.');
  }
  await syncDirectory(dir, entries.map((e) => ({ path: e.path, bytes: e.bytes })));
  const written = await readJsonFromDirectory(dir, 'manifest.json');
  if (normalizeVersion(written.version) !== version) {
    throw new Error('The update did not write the new GAF version to disk.');
  }
  if (typeof reload === 'function') {
    await reload();
  }
  return { status: 'applied', version, name: manifest.name };
}

export const APPLY_PAGE_PATH = 'src/update/apply.html';

export function buildApplyPageUrl(result, getURL) {
  if (typeof getURL !== 'function') {
    throw new Error('getURL is required');
  }
  const abs = new URL(getURL(APPLY_PAGE_PATH));
  if (result?.remote) abs.searchParams.set('version', result.remote);
  if (result?.installed) abs.searchParams.set('installed', result.installed);
  if (result?.zipUrl) abs.searchParams.set('zip', result.zipUrl);
  return abs.href;
}

export async function openApplyUi(url, chromeLike = globalThis.chrome) {
  if (chromeLike?.windows?.create) {
    try {
      await chromeLike.windows.create({
        url,
        type: 'popup',
        width: 560,
        height: 540,
        focused: true,
      });
      return { mode: 'window' };
    } catch {
      /* some Chromium builds reject extension popup windows */
    }
  }
  if (chromeLike?.tabs?.create) {
    await chromeLike.tabs.create({ url });
    return { mode: 'tab' };
  }
  throw new Error('Could not open the GAF installer.');
}
