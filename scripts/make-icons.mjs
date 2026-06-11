/*
 * Generates the extension icons without external dependencies:
 * red rounded background, white Shorts "pill" with play triangle,
 * dark diagonal bar. Each size is rendered directly (4x4 supersampling).
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'icons');
mkdirSync(OUT, { recursive: true });

/* ---------- PNG encoder ---------- */

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // Filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- shapes (coordinates relative 0..1) ---------- */

function inRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const dx = Math.max(qx, 0);
  const dy = Math.max(qy, 0);
  return Math.hypot(dx, dy) + Math.min(Math.max(qx, qy), 0) - r <= 0;
}

function inTriangle(x, y, ax, ay, bx, by, cx, cy) {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function inSegment(x, y, x1, y1, x2, y2, halfW) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) <= halfW;
}

const LAYERS = [
  { color: [230, 33, 23, 255], test: (x, y) => inRoundRect(x, y, 0.5, 0.5, 0.46, 0.46, 0.21) },
  { color: [255, 255, 255, 255], test: (x, y) => inRoundRect(x, y, 0.5, 0.5, 0.165, 0.30, 0.165) },
  { color: [230, 33, 23, 255], test: (x, y) => inTriangle(x, y, 0.455, 0.43, 0.455, 0.57, 0.575, 0.5) },
  { color: [26, 26, 26, 235], test: (x, y) => inSegment(x, y, 0.24, 0.22, 0.76, 0.78, 0.055) }
];

function over(src, dst) {
  const sa = src[3] / 255;
  const da = dst[3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return [0, 0, 0, 0];
  return [
    (src[0] * sa + dst[0] * da * (1 - sa)) / oa,
    (src[1] * sa + dst[1] * da * (1 - sa)) / oa,
    (src[2] * sa + dst[2] * da * (1 - sa)) / oa,
    oa * 255
  ];
}

function render(size) {
  const SS = 4;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let pr = 0, pg = 0, pb = 0, pa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          let c = [0, 0, 0, 0];
          for (const layer of LAYERS) if (layer.test(x, y)) c = over(layer.color, c);
          const a = c[3] / 255;
          pr += c[0] * a;
          pg += c[1] * a;
          pb += c[2] * a;
          pa += c[3];
        }
      }
      const n = SS * SS;
      const o = (py * size + px) * 4;
      const alpha = pa / n;
      rgba[o + 3] = Math.round(alpha);
      if (pa > 0) {
        rgba[o] = Math.round(pr * 255 / pa);
        rgba[o + 1] = Math.round(pg * 255 / pa);
        rgba[o + 2] = Math.round(pb * 255 / pa);
      }
    }
  }
  return rgba;
}

for (const size of [16, 32, 48, 128, 256]) {
  const file = join(OUT, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log('✓', file);
}
