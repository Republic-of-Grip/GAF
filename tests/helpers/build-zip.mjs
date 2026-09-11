import { deflateRawSync } from 'node:zlib';

function u16(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * @param {Array<{ path: string, data: string | Uint8Array }>} files
 * @param {{ method?: 'store' | 'deflate' }} [opts]
 */
export function buildZip(files, { method = 'store' } = {}) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  const zipMethod = method === 'deflate' ? 8 : 0;

  for (const file of files) {
    const name = encoder.encode(file.path);
    const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    const compressed = zipMethod === 8 ? deflateRawSync(data) : data;
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0x800),
      u16(zipMethod),
      u16(0),
      u16(0),
      u32(0),
      u32(compressed.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      compressed,
    ]);
    const central = concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x800),
      u16(zipMethod),
      u16(0),
      u16(0),
      u32(0),
      u32(compressed.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const localBlob = concat(locals);
  const cd = concat(centrals);
  const eocd = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(cd.length),
    u32(localBlob.length),
    u16(0),
  ]);
  return concat([localBlob, cd, eocd]);
}

export const SAMPLE_GAF_MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: 'GAF — General Annoyance Filter',
  short_name: 'GAF',
  version: '0.2.29',
});
