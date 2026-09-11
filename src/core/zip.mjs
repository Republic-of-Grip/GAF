/**
 * Minimal ZIP reader for GitHub source archives (store + deflate).
 * No runtime dependencies — uses DecompressionStream in the browser and
 * node:zlib in tests.
 */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

function viewOf(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

function findEocdOffset(u8) {
  const view = viewOf(u8);
  const min = Math.max(0, u8.length - 22 - 65535);
  for (let i = u8.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  throw new Error('The download was not a valid ZIP.');
}

async function inflateRaw(bytes) {
  // Helium/Chrome support deflate-raw. Node 18 advertises DecompressionStream
  // but rejects that format; fall through to zlib there.
  if (typeof DecompressionStream === 'function') {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      /* try zlib */
    }
  }
  try {
    const zlib = await import('node:zlib');
    const { promisify } = await import('node:util');
    const inflated = await promisify(zlib.inflateRaw)(bytes);
    return inflated instanceof Uint8Array ? inflated : new Uint8Array(inflated);
  } catch {
    throw new Error('The download ZIP uses an unsupported compression method.');
  }
}

function decodePath(bytes, utf8) {
  if (utf8) return new TextDecoder('utf-8').decode(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/**
 * @param {ArrayBuffer | Uint8Array} input
 * @returns {Promise<Array<{ path: string, bytes: Uint8Array }>>}
 */
export async function unzipArrayBuffer(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u8.length < 22) throw new Error('The download was not a valid ZIP.');
  const view = viewOf(u8);
  const eocd = findEocdOffset(u8);
  const count = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (view.getUint32(cdOffset, true) !== CD_SIG) {
      throw new Error('The download was not a valid ZIP.');
    }
    const flags = view.getUint16(cdOffset + 8, true);
    const method = view.getUint16(cdOffset + 10, true);
    const compressedSize = view.getUint32(cdOffset + 20, true);
    const uncompressedSize = view.getUint32(cdOffset + 24, true);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const extraLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    const localOffset = view.getUint32(cdOffset + 42, true);
    const nameBytes = u8.subarray(cdOffset + 46, cdOffset + 46 + nameLen);
    const path = decodePath(nameBytes, Boolean(flags & 0x800)).replace(/\\/g, '/');
    cdOffset += 46 + nameLen + extraLen + commentLen;

    if (!path || path.endsWith('/')) continue;
    if (flags & 1) {
      throw new Error('The download ZIP is encrypted, which GAF cannot read.');
    }

    if (view.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new Error('The download was not a valid ZIP.');
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = u8.subarray(dataStart, dataStart + compressedSize);

    let bytes;
    if (method === METHOD_STORE) {
      bytes = compressed.slice();
    } else if (method === METHOD_DEFLATE) {
      bytes = await inflateRaw(compressed);
    } else {
      throw new Error('The download ZIP uses an unsupported compression method.');
    }
    if (uncompressedSize && bytes.length !== uncompressedSize) {
      throw new Error('The download ZIP was corrupt.');
    }
    entries.push({ path, bytes });
  }
  return entries;
}

/**
 * GitHub archives wrap files in a single root folder (GAF-main/, GAF-0.2.29/, …).
 */
export function stripArchiveRoot(entries) {
  const files = (entries || []).filter((e) => e?.path && !String(e.path).endsWith('/'));
  if (!files.length) return [];
  const normalized = files.map((e) => ({ ...e, path: String(e.path).replace(/\\/g, '/') }));
  const roots = new Set(normalized.map((e) => e.path.split('/')[0]));
  if (roots.size !== 1) return normalized;
  const root = [...roots][0];
  const prefix = `${root}/`;
  if (!normalized.every((e) => e.path.startsWith(prefix))) return normalized;
  return normalized
    .map((e) => ({
      ...e,
      path: e.path.slice(prefix.length),
    }))
    .filter((e) => e.path);
}

export function isSafeZipPath(path) {
  if (!path) return false;
  const normalized = String(path).replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.includes('://')) return false;
  const parts = normalized.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  if (parts[0] === '.git') return false;
  return true;
}
