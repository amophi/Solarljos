'use strict';
// Files made from a seed, small but whole by each format's own rules, for the tests of carving
// and of the sources that read cards and disks: the JPEG maker and what it is built of.
const crypto = require('crypto');

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function randomBytes(n, seed) {
  const r = rng(seed);
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(r() * 256);
  return b;
}

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const u16 = (...v) => {
  const b = Buffer.alloc(2 * v.length);
  v.forEach((x, i) => b.writeUInt16BE(x, 2 * i));
  return b;
};
const u32 = (...v) => {
  const b = Buffer.alloc(4 * v.length);
  v.forEach((x, i) => b.writeUInt32BE(x >>> 0, 4 * i));
  return b;
};
const le32 = (x) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(x >>> 0);
  return b;
};
const latin1 = (s) => Buffer.from(s, 'latin1');

// JPEG: T.81 Table K.3 for DC, and a small AC table of our own -- any canonical code is legal.
const DC_COUNTS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_SYMS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_COUNTS = [0, 2, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const AC_SYMS = [0x00, 0x01, 0x02, 0x11, 0x03, 0x21, 0xf0];

function huffCodes(counts, syms) {
  const map = {};
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < counts[l - 1]; i++) map[syms[k++]] = { code: code++, len: l };
    code <<= 1;
  }
  return map;
}

class Bits {
  constructor() {
    this.out = [];
    this.acc = 0;
    this.n = 0;
  }

  put(v, len) {
    for (let i = len - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((v >> i) & 1);
      if (++this.n === 8) {
        this.out.push(this.acc);
        if (this.acc === 0xff) this.out.push(0);
        this.acc = 0;
        this.n = 0;
      }
    }
  }

  align() {
    while (this.n) this.put(1, 1);
  }
}

function seg(marker, body) {
  const h = Buffer.from([0xff, marker, 0, 0]);
  h.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([h, body]);
}

/** A little-endian TIFF, built from the bottom up: data and directories go in as they are made. */
class TiffBuilder {
  constructor(head = 'II*\0') {
    this.parts = [latin1(head), Buffer.alloc(4)];
    this.size = 8;
  }

  push(b) {
    this.parts.push(b);
    this.size += b.length;
  }

  put(buf) {
    if (this.size & 1) this.push(Buffer.alloc(1));
    const at = this.size;
    this.push(buf);
    return at;
  }

  /** entries: [tag, type, numbers | string | Buffer] */
  ifd(entries, next = 0) {
    const rows = [...entries].sort((a, b) => a[0] - b[0]).map(([tag, type, v]) => {
      let data;
      if (typeof v === 'string') {
        data = latin1(v + '\0');
      } else if (Buffer.isBuffer(v)) {
        data = v;
      } else {
        const n = { 1: 1, 3: 2, 4: 4, 13: 4 }[type];
        data = Buffer.alloc(n * v.length);
        v.forEach((x, i) => (n === 1 ? (data[i] = x) : n === 2 ? data.writeUInt16LE(x, 2 * i) : data.writeUInt32LE(x, 4 * i)));
      }
      const count = typeof v === 'string' || Buffer.isBuffer(v) ? data.length : v.length;
      return { tag, type, count, data, at: data.length > 4 ? this.put(data) : null };
    });
    const b = Buffer.alloc(2 + rows.length * 12 + 4);
    b.writeUInt16LE(rows.length, 0);
    rows.forEach((r, i) => {
      const o = 2 + 12 * i;
      b.writeUInt16LE(r.tag, o);
      b.writeUInt16LE(r.type, o + 2);
      b.writeUInt32LE(r.count, o + 4);
      if (r.at == null) r.data.copy(b, o + 8);
      else b.writeUInt32LE(r.at, o + 8);
    });
    b.writeUInt32LE(next, 2 + 12 * rows.length);
    return this.put(b);
  }

  done(first) {
    const out = Buffer.concat(this.parts);
    out.writeUInt32LE(first, 4);
    return out;
  }
}

/** Exif as a TIFF: the camera, when the picture was taken, and a thumbnail in IFD1. */
function exifTiff({ time = '2024:08:01 09:10:11', offset = null, make = 'Test Camera', thumb = null } = {}) {
  const T = new TiffBuilder();
  const exifIfd = T.ifd([[0x9003, 2, time], ...(offset ? [[0x9011, 2, offset]] : [])]);
  let ifd1 = 0;
  if (thumb) {
    const at = T.put(thumb);
    ifd1 = T.ifd([[0x0103, 3, [6]], [0x0201, 4, [at]], [0x0202, 4, [thumb.length]]]);
  }
  const ifd0 = T.ifd([[0x010f, 2, make], [0x8769, 4, [exifIfd]]], ifd1);
  return T.done(ifd0);
}

/**
 * A baseline JPEG: grayscale, or YCbCr 4:2:0 with `color`. Each block is a DC value that wanders
 * and a few AC terms. `app` false leaves out every APP segment, `avi1` makes APP0 a Motion JPEG
 * frame's, `dht` false leaves the Huffman tables out as Motion JPEG frames do, `sof` changes the
 * frame marker (0xC2 progressive, 0xC3 lossless: only the marker; the data stays baseline).
 */
function makeJpeg(o = {}) {
  const { seed = 1, width = 64, height = 48, color = false, restart = 0, exif = null, app = true, avi1 = false,
    dht = true, sof = 0xc0, mpf = null } = o;
  const rand = rng(seed);
  const dc = huffCodes(DC_COUNTS, DC_SYMS);
  const ac = huffCodes(AC_COUNTS, AC_SYMS);
  const comps = color ? [{ id: 1, h: 2, v: 2 }, { id: 2, h: 1, v: 1 }, { id: 3, h: 1, v: 1 }] : [{ id: 1, h: 1, v: 1 }];
  const m = color ? 16 : 8;
  const mcus = Math.ceil(width / m) * Math.ceil(height / m);
  const bits = new Bits();
  const parts = [];
  const pred = comps.map(() => 0);
  let rst = 0;
  const block = (ci) => {
    // A DC value in range (|DC| <= 1024 for 8-bit samples), coded as its difference to the last.
    const target = Math.max(-500, Math.min(500, pred[ci] + Math.floor(rand() * 121) - 60));
    const d = target - pred[ci];
    pred[ci] = target;
    const s = d === 0 ? 0 : 32 - Math.clz32(Math.abs(d));
    bits.put(dc[s].code, dc[s].len);
    if (s) bits.put(d > 0 ? d : d + (1 << s) - 1, s);
    let k = 1;
    const terms = Math.floor(rand() * 6);
    for (let i = 0; i < terms && k < 60; i++) {
      const sym = [0x01, 0x02, 0x11, 0x03, 0x21][Math.floor(rand() * 5)];
      const size = sym & 15;
      bits.put(ac[sym].code, ac[sym].len);
      bits.put(Math.floor(rand() * (1 << (size - 1))) | (1 << (size - 1)), size);
      k += (sym >> 4) + 1;
    }
    bits.put(ac[0].code, ac[0].len);
  };
  for (let i = 0; i < mcus; i++) {
    comps.forEach((c, ci) => {
      for (let b = 0; b < c.h * c.v; b++) block(ci);
    });
    if (restart && (i + 1) % restart === 0 && i + 1 < mcus) {
      bits.align();
      parts.push(Buffer.from(bits.out), Buffer.from([0xff, 0xd0 | rst]));
      rst = (rst + 1) & 7;
      bits.out = [];
      pred.fill(0);
    }
  }
  bits.align();
  parts.push(Buffer.from(bits.out));
  const table = (cls, counts, syms) => Buffer.concat([Buffer.from([cls << 4]), Buffer.from(counts), Buffer.from(syms)]);
  const head = [Buffer.from([0xff, 0xd8])];
  if (app) head.push(seg(0xe0, avi1 ? latin1('AVI1\0\0\0\0\0\0\0\0') : latin1('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')));
  if (exif) head.push(seg(0xe1, Buffer.concat([latin1('Exif\0\0'), exifTiff(exif)])));
  let mpfAt = -1;
  if (mpf) {
    mpfAt = head.reduce((a, b) => a + b.length, 0);
    head.push(seg(0xe2, Buffer.alloc(4 + 8 + 2 + 3 * 12 + 4 + 32)));
  }
  head.push(seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])));
  head.push(seg(sof, Buffer.from([8, height >> 8, height & 255, width >> 8, width & 255, comps.length,
    ...comps.flatMap((c) => [c.id, (c.h << 4) | c.v, 0])])));
  if (dht) head.push(seg(0xc4, table(0, DC_COUNTS, DC_SYMS)), seg(0xc4, table(1, AC_COUNTS, AC_SYMS)));
  if (restart) head.push(seg(0xdd, u16(restart)));
  head.push(seg(0xda, Buffer.from([comps.length, ...comps.flatMap((c) => [c.id, 0x00]), 0, 63, 0])));
  let file = Buffer.concat([...head, ...parts, Buffer.from([0xff, 0xd9])]);
  if (mpf) {
    // CIPA DC-007: APP2 "MPF\0", a big-endian TIFF header, and an MP Index IFD with two entries;
    // the second image's offset counts from that TIFF header.
    const tiffAt = mpfAt + 4 + 4;
    const t = Buffer.alloc(8 + 2 + 3 * 12 + 4 + 32);
    t.write('MM', 0, 'latin1');
    t.writeUInt16BE(42, 2);
    t.writeUInt32BE(8, 4);
    t.writeUInt16BE(3, 8);
    const ent = (i, tag, type, count, val) => {
      const at = 10 + i * 12;
      t.writeUInt16BE(tag, at);
      t.writeUInt16BE(type, at + 2);
      t.writeUInt32BE(count, at + 4);
      t.writeUInt32BE(val, at + 8);
    };
    ent(0, 0xb000, 7, 4, 0x30313030);
    ent(1, 0xb001, 4, 1, 2);
    ent(2, 0xb002, 7, 32, 10 + 3 * 12 + 4);
    const e = 10 + 3 * 12 + 4;
    t.writeUInt32BE(0x20030000, e);
    t.writeUInt32BE(file.length, e + 4);
    t.writeUInt32BE(0, e + 8);
    t.writeUInt32BE(0x00020002, e + 16);
    t.writeUInt32BE(mpf.length, e + 20);
    t.writeUInt32BE(file.length - tiffAt, e + 24);
    latin1('MPF\0').copy(file, mpfAt + 4);
    t.copy(file, mpfAt + 8);
    file = Buffer.concat([file, mpf]);
  }
  return file;
}

module.exports = { rng, randomBytes, md5, u16, u32, le32, latin1, DC_COUNTS, DC_SYMS, AC_COUNTS, AC_SYMS, huffCodes, Bits, seg, TiffBuilder, exifTiff, makeJpeg };
