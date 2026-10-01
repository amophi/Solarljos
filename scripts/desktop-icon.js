'use strict';

// The Windows program's icon, Solarljos.ico: the page's mark -- a sun and its eight rays, as
// index.html draws them on a 24 by 24 box -- drawn here at the sizes Windows asks an icon for,
// each a PNG inside the .ico, as Windows Vista and later read them. Drawn by sampling every pixel
// 8 by 8 times, so the edges are smooth; the same input gives the same bytes. At the small sizes
// the rays are drawn a little wider, so that they do not fade to nothing.
//
// scripts/desktop-assets.js writes it with the rest of desktop/Solarljos/Assets.

const zlib = require('zlib');

const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const SUN = [0xff, 0xbf, 0x40];
const RAYS = [0xff, 0xa8, 0x26];
const RAY_LINES = [
  [12, 2.5, 12, 4.7], [12, 19.3, 12, 21.5], [2.5, 12, 4.7, 12], [19.3, 12, 21.5, 12],
  [5.3, 5.3, 6.85, 6.85], [17.15, 17.15, 18.7, 18.7], [5.3, 18.7, 6.85, 17.15], [17.15, 6.85, 18.7, 5.3],
];

/** How far (x, y) is from the segment (x1, y1)-(x2, y2). */
function toSegment(x, y, [x1, y1, x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/** The mark at `size` pixels, as RGBA rows. */
function draw(size) {
  const n = 8;
  const scale = 24 / size;
  // 1.8 on the box, as the page draws the rays, and at least about a pixel and a quarter.
  const half = Math.max(1.8, 1.25 * scale) / 2;
  const radius = 4.5 + (size <= 24 ? 0.35 : 0);
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let sun = 0;
      let ray = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = (px + (sx + 0.5) / n) * scale;
          const y = (py + (sy + 0.5) / n) * scale;
          if (Math.hypot(x - 12, y - 12) <= radius) sun++;
          else if (RAY_LINES.some((l) => toSegment(x, y, l) <= half)) ray++;
        }
      }
      const total = n * n;
      const a = (sun + ray) / total;
      const i = (py * size + px) * 4;
      if (a === 0) continue;
      const mix = sun / (sun + ray);
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(SUN[c] * mix + RAYS[c] * (1 - mix));
      out[i + 3] = Math.round(a * 255);
    }
  }
  return out;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA rows as a PNG: no filter, deflated at the highest level, which is the same every time. */
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits per channel
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The .ico: its header, one entry per size, then each PNG. */
function icon() {
  const images = SIZES.map((s) => png(s, draw(s)));
  const head = Buffer.alloc(6 + 16 * SIZES.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // an icon
  head.writeUInt16LE(SIZES.length, 4);
  let at = head.length;
  SIZES.forEach((s, i) => {
    const e = 6 + 16 * i;
    head[e] = s >= 256 ? 0 : s; // 0 means 256
    head[e + 1] = s >= 256 ? 0 : s;
    head.writeUInt16LE(1, e + 4); // planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(images[i].length, e + 8);
    head.writeUInt32LE(at, e + 12);
    at += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

module.exports = { icon, draw, SIZES };
