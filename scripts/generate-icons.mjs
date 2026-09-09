/**
 * Generate toolbar icons for ON (green) and OFF (grey + red ban).
 * Pure Node — no external deps.
 *
 * Designed to be obvious at 16×16:
 *   ON  = solid green rounded square + dark G
 *   OFF = dark grey rounded square + muted G + thick red slash
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'icons');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function createPng(size, mode) {
  const rowSize = 1 + size * 4;
  const raw = Buffer.alloc(rowSize * size);
  const radius = Math.max(2, Math.floor(size * 0.2));

  const on = mode === 'on';
  // High contrast palettes
  const bg = on
    ? { r: 22, g: 130, b: 70 }
    : { r: 55, g: 55, b: 58 };
  const bg2 = on
    ? { r: 40, g: 190, b: 110 }
    : { r: 90, g: 90, b: 96 };
  const ink = on
    ? { r: 8, g: 28, b: 16 }
    : { r: 30, g: 30, b: 32 };
  const slash = { r: 230, g: 50, b: 50 };

  function inRoundRect(x, y) {
    const r = radius;
    if (x < 0 || y < 0 || x >= size || y >= size) return false;
    if (x >= r && x < size - r) return true;
    if (y >= r && y < size - r) return true;
    for (const [cx, cy] of [
      [r, r],
      [size - 1 - r, r],
      [r, size - 1 - r],
      [size - 1 - r, size - 1 - r],
    ]) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
  }

  function inG(x, y) {
    const m = size / 32;
    const left = 8.5 * m;
    const right = 23.5 * m;
    const top = 7.5 * m;
    const bottom = 24.5 * m;
    const t = Math.max(2, 3.4 * m);
    const inOuter = x >= left && x <= right && y >= top && y <= bottom;
    const inInner =
      x >= left + t && x <= right - t && y >= top + t && y <= bottom - t;
    const midY = (top + bottom) / 2;
    const barY0 = midY - t * 0.55;
    const barY1 = midY + t * 0.55;
    const barX0 = (left + right) / 2;
    const openX0 = right - t * 1.5;
    if (x >= openX0 && x <= right && y >= top + t && y <= barY0) return false;
    if (x >= barX0 && x <= right && y >= barY0 && y <= barY1) return true;
    if (x >= openX0 && y >= barY1 && y <= bottom - t && x <= right) {
      return inOuter && !inInner;
    }
    return inOuter && !inInner;
  }

  function inSlash(x, y) {
    if (on) return false;
    // Thick diagonal band — readable at 16px
    const t = Math.max(2.2, size * 0.14);
    const x0 = size * 0.78;
    const y0 = size * 0.18;
    const x1 = size * 0.22;
    const y1 = size * 0.82;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const px = x - x0;
    const py = y - y0;
    const along = (px * dx + py * dy) / (len * len);
    if (along < -0.02 || along > 1.02) return false;
    return Math.abs(px * nx + py * ny) <= t / 2;
  }

  for (let y = 0; y < size; y++) {
    const row = y * rowSize;
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 4;
      if (!inRoundRect(x, y)) {
        raw[i] = raw[i + 1] = raw[i + 2] = raw[i + 3] = 0;
        continue;
      }
      const t = y / Math.max(1, size - 1);
      let r = Math.round(bg.r + (bg2.r - bg.r) * (1 - t) * 0.55);
      let g = Math.round(bg.g + (bg2.g - bg.g) * (1 - t) * 0.55);
      let b = Math.round(bg.b + (bg2.b - bg.b) * (1 - t) * 0.55);
      if (inG(x, y)) {
        r = ink.r;
        g = ink.g;
        b = ink.b;
      }
      if (inSlash(x, y)) {
        r = slash.r;
        g = slash.g;
        b = slash.b;
      }
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const compressed = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  for (const mode of ['on', 'off']) {
    const file = path.join(outDir, `icon-${mode}-${size}.png`);
    fs.writeFileSync(file, createPng(size, mode));
    console.log('wrote', file);
  }
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), createPng(size, 'on'));
}
console.log('done');
