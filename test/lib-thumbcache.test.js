'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { workDir, cleanup, write, snapshot } = require('./helpers');
const tc = require('../src/lib/thumbcache');

const dirs = [];
after(() => dirs.forEach(cleanup));

// Cache and index files are built here the way Explorer writes them. Their checksums come from
// a CRC-64 of the test's own, worked bit by bit from the polynomial with no table, and a data
// checksum written the way thumbcacheviewer writes it, so that the library's table, its 32-bit
// halves and its sampling loop are checked against code they share nothing with.

const M64 = (1n << 64n) - 1n;
const POLY = 0x92c64265d32139a4n; // 0x259C84CBA6426349, reflected

function crc64Bits(buf, init) {
  let c = init;
  for (const b of buf) {
    c ^= BigInt(b);
    for (let k = 0; k < 8; k++) c = c & 1n ? (c >> 1n) ^ POLY : c >> 1n;
  }
  return c;
}

/** The first 1,024 bytes, XOR the first 4 of each 400-byte block after them, chained. */
function dataSum(data) {
  if (data.length <= 1024) return crc64Bits(data, 0n);
  const first = crc64Bits(data.subarray(0, 1024), 0n);
  const rest = data.length - 1024;
  let second = 0n;
  let p = 1024;
  for (let i = 0; i < Math.floor(rest / 400); i++, p += 400) second = crc64Bits(data.subarray(p, p + 4), second);
  if (rest % 400) second = crc64Bits(data.subarray(p, p + Math.min(rest % 400, 4)), second);
  return first ^ second;
}

function crc32Bits(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Pictures, each whole by its own structure.

function seg(marker, body) {
  const b = Buffer.from([0xff, marker, 0, 0]);
  b.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([b, body]);
}

const DHT_DC = seg(0xc4, Buffer.from([0x00, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
const DHT_AC = seg(0xc4, Buffer.from([0x10, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00]));
const SOS = seg(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0]));

/** A baseline JFIF of one grey component. `comment` adds a COM segment of that many bytes. */
function jpeg(width, height, { comment = 0, scans = [Buffer.from([0x1f])] } = {}) {
  const parts = [
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])])),
    ...(comment ? [seg(0xfe, Buffer.alloc(comment, 0x41))] : []),
    seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
    seg(0xc0, Buffer.from([8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0])),
    DHT_DC, DHT_AC,
  ];
  scans.forEach((data, i) => parts.push(...(i ? [DHT_AC] : []), SOS, data));
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function chunk(type, data) {
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32Bits(td));
  return Buffer.concat([len, td, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An RGBA PNG. `text` adds a tEXt chunk of about that many bytes, which keeps it valid. */
function png(width, height, { text = 0 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = 1 + width * 4;
  const raw = Buffer.alloc(height * row, 0x80);
  for (let y = 0; y < height; y++) raw[y * row] = 0;
  return Buffer.concat([
    PNG_SIGNATURE, chunk('IHDR', ihdr),
    ...(text ? [chunk('tEXt', Buffer.concat([Buffer.from('Comment\0', 'latin1'), Buffer.alloc(text, 0x61)]))] : []),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A 32-bit BITMAPV5 BMP, bottom up, with the masks Explorer writes; `pixel(i)` gives B, G, R, A. */
function bmp(width, height, pixel = () => [0x10, 0x20, 0x30, 0xff], { bpp = 32, compression = 3 } = {}) {
  const stride = Math.floor((width * bpp + 31) / 32) * 4;
  const off = 14 + 124;
  const b = Buffer.alloc(off + stride * height);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(off, 10);
  b.writeUInt32LE(124, 14);
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(bpp, 28);
  b.writeUInt32LE(compression, 30);
  b.writeUInt32LE(stride * height, 34);
  b.writeUInt32LE(0x00ff0000, 54);
  b.writeUInt32LE(0x0000ff00, 58);
  b.writeUInt32LE(0x000000ff, 62);
  b.writeUInt32LE(0xff000000, 66);
  b.write('BGRs', 70, 'latin1');
  if (bpp === 32) for (let i = 0; i < width * height; i++) Buffer.from(pixel(i)).copy(b, off + i * 4);
  return b;
}

// Cache files. The entry's fixed part by format version: Vista has an extension where the others
// have sizes; 7 has neither width nor height.

function layout(v) {
  if (v === 0x14) return { head: 56, at: 24, dims: false, ext: true };
  if (v === 0x15) return { head: 48, at: 16, dims: false, ext: false };
  return { head: 56, at: 16, dims: true, ext: false };
}

/** One entry. `size` overrides the size written; its checksums hold either way. */
function entry(v, o) {
  const L = layout(v);
  const id = Buffer.from(o.id || '', 'utf16le');
  const pad = Buffer.alloc(o.pad || 0);
  const data = o.data || Buffer.alloc(0);
  const b = Buffer.alloc(L.head + id.length + pad.length + data.length + (o.slack || 0));
  b.write('CMMM', 0, 'latin1');
  b.writeUInt32LE(o.size == null ? b.length : o.size, 4);
  b.writeBigUInt64LE(o.hash, 8);
  if (L.ext) b.write(o.ext || '', 16, 'utf16le');
  b.writeUInt32LE(id.length, L.at);
  b.writeUInt32LE(pad.length, L.at + 4);
  b.writeUInt32LE(data.length, L.at + 8);
  if (L.dims) {
    b.writeUInt32LE(o.width || 0, 28);
    b.writeUInt32LE(o.height || 0, 32);
  }
  b.writeBigUInt64LE(dataSum(data), L.head - 16);
  b.writeBigUInt64LE(crc64Bits(b.subarray(0, L.head - 8), M64), L.head - 8);
  id.copy(b, L.head);
  data.copy(b, L.head + id.length + pad.length);
  return b;
}

const freeEntry = (v, size) => entry(v, { hash: 0n, slack: size - layout(v).head });

// Where each version keeps the first entry, the free entry and the count.
function headerOf(v) {
  if (v === 0x1c) return { size: 28, first: 16, free: 20, count: 24 };
  if (v >= 0x1e) return { size: 24, first: 16, free: 20, count: null };
  return { size: 24, first: 12, free: 16, count: 20 };
}

/**
 * A cache file: its header, the entries, and a free entry to `length`. `parts` may hold raw
 * buffers between entries. Returns the file and each part's offset.
 */
function cacheFile(v, type, parts, { length, first } = {}) {
  const H = headerOf(v);
  const offsets = [];
  let at = H.size;
  for (const p of parts) {
    offsets.push(at);
    at += p.length;
  }
  const total = length || at + 256;
  const h = Buffer.alloc(H.size);
  h.write('CMMM', 0, 'latin1');
  h.writeUInt32LE(v, 4);
  h.writeUInt32LE(type, 8);
  h.writeUInt32LE(first == null ? H.size : first, H.first);
  h.writeUInt32LE(at, H.free);
  if (H.count != null) h.writeUInt32LE(parts.length, H.count);
  const file = Buffer.concat([h, ...parts, ...(total > at ? [freeEntry(v, total - at)] : [])]);
  return { file, offsets, freeAt: at };
}

const hexId = (h) => h.toString(16);

const H = {
  jpeg: 0x1a2b3c4d5e6f7081n,
  png: 0x00000000abcdef12n,
  big: 0x7766554433221100n,
  none: 0x0fedcba987654321n,
  win: 0x5555666677778888n,
  scans: 0x1111222233334444n,
};
const SERIAL = '1a2b3c4d';

/** A Windows 10 cache of 256-pixel pictures like the ones measured. */
function sample() {
  const parts = [
    entry(0x20, { hash: H.jpeg, id: hexId(H.jpeg), data: jpeg(1, 1), width: 1, height: 1, slack: 3 }),
    entry(0x20, { hash: H.png, id: hexId(H.png), data: png(1, 1), width: 1, height: 1 }),
    entry(0x20, { hash: H.big, id: hexId(H.big), data: png(2, 2, { text: 3000 }), width: 2, height: 2, slack: 5 }),
    entry(0x20, { hash: H.none, id: '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}' }),
    entry(0x20, { hash: H.win, id: `Windows?${SERIAL}?5000000001234`, data: png(3, 2), width: 3, height: 2 }),
    entry(0x20, {
      hash: H.scans, id: hexId(H.scans), width: 4, height: 3, slack: 7,
      data: jpeg(4, 3, { scans: [Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff, 0xd1, 0x78]), Buffer.from([0x9a])] }),
    }),
  ];
  return { ...cacheFile(0x20, 4, parts, { length: 8192 }), parts };
}

test('CRC-64 is CRC-64/MS with thumbcache.dll\'s table', () => {
  assert.strictEqual(tc.crc64(Buffer.from('123456789'), M64), 0x75d4b74f024eceean, 'the check value in the CRC catalogue');
  const { CRC_LO, CRC_HI } = tc._internal;
  const entryOf = (n) => (BigInt(CRC_HI[n]) << 32n) | BigInt(CRC_LO[n]);
  // As thumbcacheviewer copied them out of thumbcache.dll.
  for (const [n, v] of [[1, 0x0809e8a2969451e9n], [37, 0x0c9fdab1b80d5824n], [128, 0x92c64265d32139a4n],
    [200, 0x9bea26438e132a3en], [255, 0x07f8a79e7273cf58n]]) {
    assert.strictEqual(entryOf(n), v, `table[${n}]`);
  }
  for (let n = 0; n < 256; n++) assert.strictEqual(entryOf(n), crc64Bits(Buffer.from([n]), 0n), `table[${n}] from the polynomial`);
  // PNG chunks' CRC-32, with zlib's and with the table used where Node has no zlib.crc32.
  const some = crypto.randomBytes(777);
  assert.strictEqual(tc._internal.crc32Table(some), crc32Bits(some));
  assert.strictEqual(tc._internal.crc32(some), crc32Bits(some));
  for (const len of [0, 1, 7, 48, 1000]) {
    const buf = crypto.randomBytes(len);
    const init = BigInt('0x' + crypto.randomBytes(8).toString('hex'));
    assert.strictEqual(tc.crc64(buf, init), crc64Bits(buf, init), `length ${len}`);
  }
});

test('the data checksum samples 4 bytes of every 400 after the first 1,024', () => {
  for (const len of [0, 1, 1023, 1024, 1025, 1027, 1028, 1029, 1423, 1424, 1425, 1428, 1429, 5000, 100003]) {
    const data = crypto.randomBytes(len);
    assert.strictEqual(tc.dataChecksum(data), dataSum(data), `length ${len}`);
  }
  // Bytes outside the sample do not count.
  const data = crypto.randomBytes(3000);
  const changed = Buffer.from(data);
  changed[1024 + 400 + 10] ^= 0xff;
  assert.strictEqual(tc.dataChecksum(changed), tc.dataChecksum(data));
  changed[1024 + 400 + 2] ^= 0xff;
  assert.notStrictEqual(tc.dataChecksum(changed), tc.dataChecksum(data));
});

test('reads a Windows 10 cache: every entry, its picture, and the free entry', () => {
  const { file, offsets, freeAt, parts } = sample();
  const copy = Buffer.from(file);
  const c = tc.parseCache(file);
  assert.ok(file.equals(copy), 'the buffer is not changed');
  assert.strictEqual(c.version, 0x20);
  assert.strictEqual(c.windows, '10 and 11');
  assert.strictEqual(c.type, 4);
  assert.strictEqual(c.typeName, '256');
  assert.strictEqual(c.first, 24);
  assert.strictEqual(c.free, freeAt);
  assert.strictEqual(c.count, null);
  assert.strictEqual(c.length, 8192);
  assert.deepStrictEqual(c.problems, []);
  assert.deepStrictEqual(c.entries.map((e) => e.offset), [...offsets, freeAt]);
  assert.deepStrictEqual(c.entries.map((e) => e.size), [...parts.map((p) => p.length), 8192 - freeAt]);
  assert.ok(c.entries.every((e) => e.ok && e.checks.header && e.checks.data && !e.offChain && e.formatVersion === 0x20));

  const [j, p, big, none, win, scans, free] = c.entries;
  assert.strictEqual(j.hash, '1a2b3c4d5e6f7081');
  assert.strictEqual(j.identifier, '1a2b3c4d5e6f7081');
  assert.deepStrictEqual([j.width, j.height], [1, 1]);
  assert.deepStrictEqual(j.data, jpeg(1, 1));
  assert.strictEqual(j.dataOffset, offsets[0] + 56 + 32);
  assert.deepStrictEqual(j.image, { format: 'jpeg', ext: '.jpg', width: 1, height: 1, ok: true, why: null });
  assert.strictEqual(j.extension, null);
  assert.strictEqual(p.hash, '00000000abcdef12');
  assert.strictEqual(p.image.format, 'png');
  assert.ok(big.dataSize > 1024 && big.checks.data, 'a sampled data checksum');
  assert.deepStrictEqual([big.image.ext, big.width, big.height], ['.png', 2, 2]);
  assert.strictEqual(none.dataSize, 0);
  assert.strictEqual(none.image, null);
  assert.strictEqual(none.checks.image, null);
  assert.deepStrictEqual([none.width, none.height], [0, 0]);
  assert.deepStrictEqual([scans.image.format, scans.image.ok, scans.width], ['jpeg', true, 4], 'two scans, stuffed bytes, restart markers');
  assert.strictEqual(free.free, true);
  assert.strictEqual(free.hash, '0000000000000000');
  assert.strictEqual(free.dataSize, 0);

  assert.deepStrictEqual(tc.thumbnails(c).map((e) => e.hash), [j, p, big, win, scans].map((e) => e.hash));
  assert.deepStrictEqual(tc.thumbnails(null), []);
  assert.deepStrictEqual(tc.parseIdentifier(j.identifier, j.hash), { kind: 'hash' });
  assert.deepStrictEqual(tc.parseIdentifier(p.identifier, p.hash), { kind: 'hash' }, 'no leading zeros');
  assert.deepStrictEqual(tc.parseIdentifier(win.identifier, win.hash), { kind: 'file id', volumeSerial: SERIAL, fileId: '5000000001234' });
  assert.deepStrictEqual(tc.parseIdentifier(none.identifier, none.hash), { kind: 'shell' });
  assert.deepStrictEqual(tc.parseIdentifier('', '0'), { kind: 'none' });
  assert.deepStrictEqual(tc.parseIdentifier('C:\\', none.hash), { kind: 'other' });
  assert.deepStrictEqual(tc.parseIdentifier('abc', j.hash), { kind: 'other' }, 'another hash');
});

test('an empty cache is its header alone', () => {
  const h = Buffer.alloc(24);
  h.write('CMMM', 0, 'latin1');
  h.writeUInt32LE(0x20, 4);
  h.writeUInt32LE(7, 8);
  h.writeUInt32LE(24, 16);
  h.writeUInt32LE(24, 20);
  const c = tc.parseCache(h);
  assert.deepStrictEqual([c.typeName, c.entries.length, c.problems.length], ['1920', 0, 0]);
});

test('reads the older layouts: Vista, 7, 8 and 8.1', () => {
  const vista = cacheFile(0x14, 2, [entry(0x14, { hash: H.jpeg, ext: 'jpg', id: hexId(H.jpeg), data: jpeg(3, 2) })]);
  let c = tc.parseCache(vista.file);
  assert.deepStrictEqual([c.windows, c.typeName, c.count], ['Vista', '256', 1]);
  let e = c.entries[0];
  assert.deepStrictEqual([e.ok, e.extension, e.width, e.height, e.image.format], [true, 'jpg', 3, 2, 'jpeg'], 'the size is the picture\'s');
  assert.deepStrictEqual(tc.cacheTypes(0x14), ['32', '96', '256', '1024', 'sr']);

  const seven = cacheFile(0x15, 0, [entry(0x15, { hash: H.png, id: hexId(H.png), pad: 2, data: bmp(2, 2) })]);
  c = tc.parseCache(seven.file);
  e = c.entries[0];
  assert.deepStrictEqual([c.windows, c.typeName], ['7', '32']);
  assert.deepStrictEqual([e.ok, e.size, e.dataOffset, e.width, e.height, e.image.format, e.image.ext],
    [true, 48 + 16 + 2 + bmp(2, 2).length, seven.offsets[0] + 48 + 16 + 2, 2, 2, 'bmp', '.bmp']);

  const early = cacheFile(0x1c, 3, [entry(0x1c, { hash: H.big, id: hexId(H.big), data: png(5, 4), width: 5, height: 4 })]);
  c = tc.parseCache(early.file);
  assert.deepStrictEqual([c.first, c.count, c.typeName, c.entries.length, c.problems.length], [28, 1, '96', 2, 0]);
  assert.ok(c.entries[0].ok);

  assert.strictEqual(tc.parseCache(cacheFile(0x1e, 5, []).file).typeName, '1024');
  assert.strictEqual(tc.parseCache(cacheFile(0x1f, 6, []).file).typeName, '1600');
  assert.strictEqual(tc.parseCache(cacheFile(0x1a, 8, []).file).typeName, 'exif');
  assert.deepStrictEqual(tc.VERSIONS, [0x14, 0x15, 0x1a, 0x1c, 0x1e, 0x1f, 0x20]);
});

test('not a cache, a version not known, and a type not known', () => {
  assert.strictEqual(tc.parseCache(Buffer.from('this is not a thumbnail cache at all')), null);
  assert.strictEqual(tc.parseCache(Buffer.alloc(4096)), null, 'zeros hold no entry either');
  assert.strictEqual(tc.parseCache('CMMM'), null);
  assert.strictEqual(tc.parseCache(Buffer.from('CMMM')), null);

  const unknown = sample().file;
  unknown.writeUInt32LE(0x16, 4);
  const c = tc.parseCache(unknown);
  assert.deepStrictEqual([c.version, c.entries.length, c.problems], [0x16, 0, [{ offset: 4, why: 'version' }]]);
  assert.strictEqual(tc.cacheTypes(0x16), null);

  const odd = sample().file;
  odd.writeUInt32LE(99, 8);
  const d = tc.parseCache(odd);
  assert.deepStrictEqual([d.typeName, d.problems, d.entries.length], [null, [{ offset: 8, why: 'type' }], 7]);

  const first = cacheFile(0x20, 4, [entry(0x20, { hash: H.jpeg, data: jpeg(1, 1), width: 1, height: 1 })], { first: 5 });
  const f = tc.parseCache(first.file);
  assert.deepStrictEqual(f.problems, [{ offset: 16, why: 'first' }]);
  assert.ok(f.entries[0].ok, 'read from where the header ends');
});

test('a damaged entry fails its own check, and the entries after it are still read', () => {
  // A picture byte changed: the data checksum fails.
  let s = sample();
  s.file[s.offsets[1] + 56 + 16 + 20] ^= 0x01;
  let c = tc.parseCache(s.file);
  assert.deepStrictEqual(c.entries.map((e) => e.ok), [true, false, true, true, true, true, true]);
  assert.deepStrictEqual([c.entries[1].checks.header, c.entries[1].checks.data], [true, false]);
  assert.deepStrictEqual(c.problems, []);

  // The hash changed: the header checksum fails, and its size cannot be trusted either.
  s = sample();
  s.file[s.offsets[2] + 9] ^= 0x01;
  c = tc.parseCache(s.file);
  assert.deepStrictEqual([c.entries[2].checks.header, c.entries[2].ok], [false, false]);
  assert.deepStrictEqual(c.problems, [{ offset: s.offsets[2], why: 'header', resumedAt: s.offsets[3] }]);
  assert.strictEqual(c.entries.length, 7);

  // The identifier is not covered by the header checksum: it is a hint only.
  s = sample();
  s.file[s.offsets[0] + 56] = 0x66;
  c = tc.parseCache(s.file);
  assert.deepStrictEqual([c.entries[0].ok, c.entries[0].identifier[0]], [true, 'f']);
});

test('a JPEG cut short past the sampled bytes passes its checksum and fails its own check', () => {
  // The last two bytes must lie outside the 4 sampled from the last block.
  let comment = 1500;
  while ((jpeg(8, 8, { comment }).length - 1024) % 400 < 6) comment++;
  const data = jpeg(8, 8, { comment });
  const { file, offsets } = cacheFile(0x20, 6, [entry(0x20, { hash: H.jpeg, id: hexId(H.jpeg), data, width: 8, height: 8 })]);
  const end = offsets[0] + 56 + 32 + data.length;
  file[end - 2] = 0;
  file[end - 1] = 0;
  const e = tc.parseCache(file).entries[0];
  assert.deepStrictEqual([e.checks.header, e.checks.data, e.checks.image, e.image.why, e.ok], [true, true, false, 'end', false]);
});

test('where the chain breaks, the walk goes on at the next entry whose header checksum holds', () => {
  const a = entry(0x20, { hash: H.jpeg, data: jpeg(1, 1), width: 1, height: 1 });
  const b = entry(0x20, { hash: H.png, data: png(1, 1), width: 1, height: 1 });
  const huge = entry(0x20, { hash: H.big, data: png(1, 1), width: 1, height: 1, size: 0x7fffffff });
  const junk = Buffer.alloc(37, 0xab);
  const { file, offsets, freeAt } = cacheFile(0x20, 4, [a, huge, b, junk, a]);
  const c = tc.parseCache(file);
  assert.deepStrictEqual(c.problems, [
    { offset: offsets[1], why: 'chain', resumedAt: offsets[2] },
    { offset: offsets[3], why: 'chain', resumedAt: offsets[4] },
  ]);
  assert.deepStrictEqual(c.entries.map((e) => e.offset), [offsets[0], offsets[2], offsets[4], freeAt]);
  assert.ok(c.entries.every((e) => e.ok));

  // Nothing after the break.
  const long = Buffer.alloc(100, 0xab);
  const broken = cacheFile(0x20, 4, [a, long], { length: 24 + a.length + long.length }).file;
  assert.deepStrictEqual(tc.parseCache(broken).problems, [{ offset: 24 + a.length, why: 'chain', resumedAt: -1 }]);

  // Bytes after the last entry, too few to be one.
  const tail = Buffer.concat([cacheFile(0x20, 4, [a], { length: 24 + a.length }).file, Buffer.from([1, 2, 3])]);
  assert.deepStrictEqual(tc.parseCache(tail).problems, [{ offset: 24 + a.length, why: 'end' }]);
});

test('a file whose header is gone is read from its first entry', () => {
  const { file, offsets } = sample();
  file.fill(0, 0, offsets[1]);
  const c = tc.parseCache(file);
  assert.deepStrictEqual([c.version, c.type, c.typeName, c.first, c.free], [null, null, null, null, null]);
  assert.deepStrictEqual(c.problems, [{ offset: 0, why: 'file header' }]);
  assert.deepStrictEqual(c.entries.map((e) => e.hash).slice(0, 2), ['00000000abcdef12', '7766554433221100']);
  assert.ok(c.entries.every((e) => e.ok && e.formatVersion === null));

  // Windows 7's free entry, its header checksum followed by zeros, also passes a later Windows's
  // header checksum -- the CRC of a message and its own CRC is 0 -- and must not decide the layout.
  const seven = cacheFile(0x15, 1, [entry(0x15, { hash: H.jpeg, data: jpeg(2, 2) }), entry(0x15, { hash: H.png, data: png(2, 2) })]);
  seven.file.fill(0, 0, seven.offsets[1]);
  const d = tc.parseCache(seven.file);
  assert.deepStrictEqual([d.entries.length, d.entries[0].hash, d.entries[0].width], [2, '00000000abcdef12', 2], 'Windows 7\'s layout');
});

test('entries left inside the free entry are found and marked', () => {
  const { file, freeAt } = sample();
  const left = entry(0x20, { hash: H.scans, id: hexId(H.scans), data: png(2, 1), width: 2, height: 1 });
  left.copy(file, freeAt + 200);
  const c = tc.parseCache(file);
  const found = c.entries.filter((e) => e.offChain);
  assert.deepStrictEqual(found.map((e) => [e.offset, e.ok, e.hash]), [[freeAt + 200, true, '1111222233334444']]);
  assert.ok(tc.thumbnails(c).includes(found[0]));
  assert.deepStrictEqual(c.problems, []);
});

test('each picture is checked by its own structure', () => {
  const ok = (d, w, h) => tc.checkImage(d, w, h);
  assert.deepStrictEqual(ok(jpeg(2, 3), 2, 3), { format: 'jpeg', ext: '.jpg', width: 2, height: 3, ok: true, why: null });
  assert.strictEqual(ok(jpeg(2, 3), 3, 2).why, 'dimensions');
  assert.strictEqual(ok(jpeg(2, 3)).ok, true, 'no size to compare');
  assert.strictEqual(ok(jpeg(2, 3).subarray(0, 60)).why, 'end');
  assert.strictEqual(ok(Buffer.concat([jpeg(2, 3), Buffer.from([0])])).why, 'end', 'bytes after the end marker');
  const noFrame = Buffer.concat([Buffer.from([0xff, 0xd8]), SOS, Buffer.from([0x1f, 0xff, 0xd9])]);
  assert.strictEqual(ok(noFrame).why, 'structure', 'a scan before the frame');
  const noScan = Buffer.concat([jpeg(1, 1).subarray(0, jpeg(1, 1).indexOf(SOS)), Buffer.from([0xff, 0xd9])]);
  assert.strictEqual(ok(noScan).why, 'structure', 'no scan');

  assert.deepStrictEqual(ok(png(3, 1), 3, 1), { format: 'png', ext: '.png', width: 3, height: 1, ok: true, why: null });
  const badChunk = png(3, 1);
  badChunk[40] ^= 0xff;
  assert.strictEqual(ok(badChunk).why, 'chunk');
  assert.strictEqual(ok(Buffer.concat([png(3, 1), Buffer.from('x')])).why, 'end');
  assert.strictEqual(ok(png(3, 1).subarray(0, 50)).why, 'end');
  assert.strictEqual(ok(Buffer.concat([PNG_SIGNATURE, chunk('IDAT', Buffer.alloc(4)), chunk('IEND', Buffer.alloc(0))])).why, 'structure');

  assert.deepStrictEqual(ok(bmp(2, 2), 2, 2), { format: 'bmp', ext: '.bmp', width: 2, height: 2, ok: true, why: null });
  const size = bmp(2, 2);
  size.writeUInt32LE(size.length + 2, 2);
  assert.strictEqual(ok(size).why, 'file size');
  assert.strictEqual(ok(bmp(2, 2).subarray(0, 150)).why, 'end');
  const planes = bmp(2, 2);
  planes.writeUInt16LE(0, 26);
  assert.strictEqual(ok(planes).why, 'structure');
  const topDown = bmp(2, 2);
  topDown.writeInt32LE(-2, 22);
  assert.deepStrictEqual([ok(topDown, 2, 2).ok, ok(topDown).height], [true, 2]);

  assert.deepStrictEqual(ok(Buffer.from('GIF89a......')), { format: null, ext: null, width: null, height: null, ok: false, why: 'format' });
});

test('an entry whose picture has another size than it records fails', () => {
  const { file } = cacheFile(0x20, 4, [entry(0x20, { hash: H.png, data: png(3, 2), width: 2, height: 3 })]);
  const e = tc.parseCache(file).entries[0];
  assert.deepStrictEqual([e.checks.header, e.checks.data, e.image.why, e.ok], [true, true, 'dimensions', false]);
});

test('how a BMP\'s fourth byte reads', () => {
  assert.strictEqual(tc.bmpAlpha(bmp(2, 2)), 'opaque');
  assert.strictEqual(tc.bmpAlpha(bmp(2, 2, () => [10, 20, 30, 0])), 'zero');
  assert.strictEqual(tc.bmpAlpha(bmp(2, 2, (i) => (i ? [0, 0, 0, 255] : [200, 10, 10, 100]))), 'straight');
  assert.strictEqual(tc.bmpAlpha(bmp(2, 2, (i) => (i ? [0, 0, 0, 0] : [50, 60, 70, 128]))), 'premultiplied');
  assert.strictEqual(tc.bmpAlpha(bmp(2, 2, () => [10, 20, 30, 0], { compression: 0 })), 'zero', 'BI_RGB, fourth byte unused');
  assert.strictEqual(tc.bmpAlpha(bmp(2, 2, undefined, { bpp: 24, compression: 0 })), null);
  const masks = bmp(2, 2);
  masks.writeUInt32LE(0x000000ff, 54);
  assert.strictEqual(tc.bmpAlpha(masks), null, 'colours in other places');
  assert.strictEqual(tc.bmpAlpha(png(1, 1)), null);
});

// The index, format 0x20: 144 bytes of header, then 72-byte slots.

function index32(slots, total, { sizes = [], counts = [], used } = {}) {
  const b = Buffer.alloc(144 + 72 * total);
  b.writeUInt32LE(0x2030000c, 0);
  b.write('IMMM', 4, 'latin1');
  b.writeUInt32LE(0x20, 8);
  b.writeUInt32LE(127, 16);
  b.writeUInt32LE(used == null ? slots.length : used, 20);
  b.writeUInt32LE(total, 24);
  for (let i = 0; i < 14; i++) {
    b.writeUInt32LE(sizes[i] || 0, 28 + 4 * i);
    b.writeUInt32LE(counts[i] || 0, 84 + 4 * i);
  }
  for (const s of slots) {
    const p = 144 + 72 * s.slot;
    b.writeBigUInt64LE(s.hash, p);
    b.writeUInt32LE(((s.width || 0) << 12 | (s.height || 0)) >>> 0, p + 8);
    b.writeUInt32LE(s.flags || 0, p + 12);
    for (let t = 0; t < 14; t++) b.writeUInt32LE(s.offsets[t] == null ? 0xffffffff : s.offsets[t], p + 16 + 4 * t);
  }
  return b;
}

test('reads the index, format 0x20, and checks it against the cache files', () => {
  const s = sample();
  const cache = tc.parseCache(s.file);
  const small = cacheFile(0x20, 0, [entry(0x20, { hash: H.jpeg, id: hexId(H.jpeg), pad: 2, data: bmp(1, 1), width: 1, height: 1 })]);
  const smallCache = tc.parseCache(small.file);
  const at4 = (i) => ({ 4: s.offsets[i] });
  const slots = [
    { slot: 0, hash: H.jpeg, width: 1, height: 1, offsets: { 0: small.offsets[0], 4: s.offsets[0] } },
    { slot: 1, hash: H.png, width: 1, height: 1, offsets: at4(1) },
    { slot: 2, hash: H.big, width: 2, height: 2, offsets: at4(2) },
    { slot: 3, hash: H.none, flags: 0x80000000, offsets: at4(3) },
    { slot: 4, hash: H.win, width: 3, height: 2, offsets: at4(4) },
    { slot: 6, hash: H.scans, width: 4, height: 3, flags: 0x08005002, offsets: at4(5) },
  ];
  const sizes = { 0: small.file.length, 4: s.file.length };
  const counts = { 0: 1, 4: 6 };
  const ix = tc.parseIndex(index32(slots, 7, { sizes, counts }));
  assert.deepStrictEqual([ix.version, ix.used, ix.total, ix.problems], [0x20, 6, 7, []]);
  assert.deepStrictEqual([ix.fileSizes[0], ix.fileSizes[4], ix.counts[4], ix.fileSizes.length], [small.file.length, s.file.length, 6, 14]);
  assert.deepStrictEqual(ix.slots.map((x) => x.slot), [0, 1, 2, 3, 4, 6], 'slot 0 is read: the first slot is right after the header');
  const first = ix.slots[0];
  assert.deepStrictEqual([first.hash, first.width, first.height, first.noThumbnail, first.time], ['1a2b3c4d5e6f7081', 1, 1, false, null]);
  const expected = Array(14).fill(null);
  expected[0] = small.offsets[0];
  expected[4] = s.offsets[0];
  assert.deepStrictEqual(first.offsets, expected);
  assert.deepStrictEqual([ix.slots[3].noThumbnail, ix.slots[3].width, ix.slots[5].flags], [true, 0, 0x08005002]);

  assert.deepStrictEqual(tc.crossCheck(ix, [cache, smallCache]), {
    offsets: 7, matched: 7, wrongHash: 0, nothingThere: 0, noFile: 0, unindexed: 0, sizes: true, counts: true,
  });
  assert.deepStrictEqual(tc.crossCheck(ix, [cache]).noFile, 1);

  // An offset at another entry, one at nothing, an entry with no slot, and the wrong counts.
  const wrong = slots.map((x) => ({ ...x, offsets: { ...x.offsets } }));
  wrong[1].offsets[4] = s.offsets[2];
  wrong[2].offsets[4] = 12345;
  const r = tc.crossCheck(tc.parseIndex(index32(wrong.slice(0, 5), 7, { sizes, counts: { 0: 1, 4: 5 } })), [cache, smallCache]);
  assert.deepStrictEqual(r, { offsets: 6, matched: 4, wrongHash: 1, nothingThere: 1, noFile: 0, unindexed: 1, sizes: true, counts: false });
});

test('an index cut short or miscounted says so; one of a format not read here has no slots', () => {
  const full = index32([{ slot: 1, hash: H.png, offsets: {} }], 4);
  let ix = tc.parseIndex(full.subarray(0, full.length - 10));
  assert.deepStrictEqual(ix.problems.map((p) => p.why), ['size']);
  assert.strictEqual(ix.slots.length, 1);
  ix = tc.parseIndex(index32([{ slot: 1, hash: H.png, offsets: {} }], 4, { used: 3 }));
  assert.deepStrictEqual(ix.problems, [{ offset: 20, why: 'used' }]);

  const win8 = Buffer.from(full);
  win8.writeUInt32LE(0x1e, 8);
  ix = tc.parseIndex(win8);
  assert.deepStrictEqual([ix.version, ix.slots, ix.problems], [0x1e, [], [{ offset: 8, why: 'version' }]]);

  assert.strictEqual(tc.parseIndex(Buffer.alloc(200)), null);
  assert.strictEqual(tc.parseIndex(sample().file), null, 'a cache file is not an index');
  assert.strictEqual(tc.parseIndex(null), null);
});

test('reads Vista\'s, 7\'s and 8.1\'s index as libwtcdb describes them', () => {
  const filetime = (ms) => (BigInt(ms) + 11644473600000n) * 10000n;
  const WHEN = Date.UTC(2009, 1, 3, 4, 5, 6);
  // Vista: "IMMM", version, 4 bytes, used, total, 4 bytes; slots of hash, FILETIME, flags, 5 offsets.
  const vista = Buffer.alloc(24 + 40 * 3);
  vista.write('IMMM', 0, 'latin1');
  vista.writeUInt32LE(0x14, 4);
  vista.writeUInt32LE(1, 12);
  vista.writeUInt32LE(3, 16);
  vista.writeBigUInt64LE(H.jpeg, 24 + 40);
  vista.writeBigUInt64LE(filetime(WHEN), 24 + 40 + 8);
  vista.writeUInt32LE(1, 24 + 40 + 16);
  for (let i = 0; i < 5; i++) vista.writeUInt32LE(i === 2 ? 24 : 0xffffffff, 24 + 40 + 20 + 4 * i);
  let ix = tc.parseIndex(vista);
  assert.deepStrictEqual(ix.slots, [{
    slot: 1, hash: '1a2b3c4d5e6f7081', flags: 1, offsets: [null, null, 24, null, null],
    width: null, height: null, noThumbnail: null, time: WHEN,
  }]);
  assert.deepStrictEqual(ix.problems, []);

  const seven = Buffer.alloc(24 + 32 * 2);
  seven.write('IMMM', 0, 'latin1');
  seven.writeUInt32LE(0x15, 4);
  seven.writeUInt32LE(1, 12);
  seven.writeUInt32LE(2, 16);
  seven.writeBigUInt64LE(H.png, 24);
  seven.writeUInt32LE(0, 24 + 8);
  seven.writeUInt32LE(48, 24 + 12 + 4);
  ix = tc.parseIndex(seven);
  assert.deepStrictEqual([ix.slots[0].hash, ix.slots[0].offsets, ix.slots[0].time],
    ['00000000abcdef12', [null, 48, null, null, null], null]);

  const eight = Buffer.alloc(0x78 + 64 * 2);
  eight.write('IMMM', 4, 'latin1');
  eight.writeUInt32LE(0x1f, 8);
  eight.writeUInt32LE(1, 20);
  eight.writeUInt32LE(2, 24);
  eight.writeBigUInt64LE(H.big, 0x78 + 64);
  for (let i = 0; i < 11; i++) eight.writeUInt32LE(i === 6 ? 24 : 0xffffffff, 0x78 + 64 + 16 + 4 * i);
  ix = tc.parseIndex(eight);
  assert.deepStrictEqual([ix.problems, ix.slots[0].slot, ix.slots[0].offsets[6], ix.slots[0].offsets.length, ix.fileSizes],
    [[], 1, 24, 11, null]);
  assert.deepStrictEqual(tc.INDEX_VERSIONS, [0x14, 0x15, 0x1f, 0x20]);
});

// The ThumbnailCacheId, worked out here a second way: BigInt throughout, the DOS time rounded up
// with integer arithmetic before it is taken apart.

const GUID = '{12345678-9abc-4def-8123-456789abcdef}';
const GUID_BYTES = Buffer.from('78563412bc9aef4d8123456789abcdef', 'hex');
const FT_EPOCH = 116444736000000000n;

function refCacheId(guidBytes, fileId, ext, ft, { win7 = true, loss = true } = {}) {
  const step = (h, bytes) => {
    for (const b of bytes) h = (h ^ ((h * 2080n + BigInt(b) + (h >> 2n)) % (1n << 64n))) & M64;
    return h;
  };
  const le = (v, n) => Array.from({ length: n }, (_, i) => Number((BigInt(v) >> BigInt(8 * i)) & 0xffn));
  let h = step(0x95e729ba2c37fd21n, guidBytes);
  h = step(h, le(fileId, 8));
  if (!win7) return h.toString(16).padStart(16, '0');
  h = step(h, Buffer.from(ext, 'utf16le'));
  const up = ft % 20000000n === 0n ? ft : (ft / 20000000n + 1n) * 20000000n;
  const secs = Number((up - FT_EPOCH) / 10000000n);
  const d = new Date(secs * 1000);
  const dos = ((d.getUTCFullYear() - 1980) * 512 + (d.getUTCMonth() + 1) * 32 + d.getUTCDate()) * 65536
    + d.getUTCHours() * 2048 + d.getUTCMinutes() * 32 + d.getUTCSeconds() / 2;
  h = step(h, le(dos, 4));
  const diff = Number(((up & 0xffffffffn) - (ft & 0xffffffffn) + (1n << 32n)) % (1n << 32n));
  if (loss && diff) h = step(h, le(diff, 4));
  return h.toString(16).padStart(16, '0');
}

test('the ThumbnailCacheId of a file', () => {
  const ft = (iso, extra = 0n) => BigInt(Date.parse(iso)) * 10000n + FT_EPOCH + extra;
  const even = ft('2024-03-05T06:07:08Z');
  const fraction = ft('2024-03-05T06:07:09Z', 5001234n);
  const fileId = 0x0005000000001234n;
  const id = (o, v) => tc.cacheIdOf({ volumeGuid: GUID, fileId, ext: '.jpg', filetime: even, ...o }, v);

  assert.deepStrictEqual(tc._internal.guidBytes(GUID), GUID_BYTES);
  for (const [ext, when] of [['.jpg', even], ['.JPG', even], ['.png', fraction], ['', fraction]]) {
    assert.strictEqual(id({ ext, filetime: when }), refCacheId(GUID_BYTES, fileId, ext, when), `${ext} ${when}`);
  }
  // Pinned, so that a change to either way of working it out is noticed.
  assert.strictEqual(id({}), 'f4c2e5d658399c2c');
  assert.strictEqual(id({ ext: '.png', filetime: fraction }), 'da2af54ce8013ee2');

  assert.notStrictEqual(id({ ext: '.JPG' }), id({}), 'the extension\'s case counts');
  assert.strictEqual(id({}, 0x15), id({}), 'no precision lost: 7\'s hash is the same');
  assert.strictEqual(id({ filetime: fraction }, null), id({ filetime: fraction }, 0x20),
    'a version not known, as from a file without a header');
  assert.notStrictEqual(id({ filetime: fraction }, 0x15), id({ filetime: fraction }), 'a fraction of a second is hashed from 8.1 on');
  assert.strictEqual(id({ filetime: fraction }, 0x15), refCacheId(GUID_BYTES, fileId, '.jpg', fraction, { loss: false }));
  assert.strictEqual(id({ ext: '.png', filetime: 0n }, 0x14), refCacheId(GUID_BYTES, fileId, '', 0n, { win7: false }),
    'Vista hashes the volume and file ID only');
  assert.notStrictEqual(id({ fileId: fileId + 1n }), id({}));
  assert.strictEqual(id({ fileId: Number(0x1234) }), tc.cacheIdOf({ volumeGuid: GUID, fileId: 0x1234n, ext: '.jpg', filetime: even }));

  for (const spelling of ['Volume{12345678-9ABC-4DEF-8123-456789ABCDEF}', '\\\\?\\Volume{12345678-9abc-4def-8123-456789abcdef}\\',
    '123456789abc4def8123456789abcdef', GUID_BYTES]) {
    assert.strictEqual(id({ volumeGuid: spelling }), id({}), String(spelling));
  }
  assert.throws(() => id({ volumeGuid: 'C:' }), RangeError);

  assert.strictEqual(id({ filetime: ft('1979-12-31T23:59:58Z') }), null, 'before DOS dates');
  assert.strictEqual(id({ filetime: ft('2108-01-01T00:00:00Z') }), null, 'after them');
  assert.strictEqual(id({ filetime: -1n }), null);
});

test('the DOS time is rounded up to an even second', () => {
  const { dosTime } = tc._internal;
  const at = (iso) => BigInt(Date.parse(iso)) * 10000n + FT_EPOCH;
  const pack = (y, mo, d, h, mi, s) => (((y - 1980) << 9 | mo << 5 | d) << 16 | h << 11 | mi << 5 | s >> 1) >>> 0;
  assert.deepStrictEqual(dosTime(at('2024-03-05T06:07:08Z')), { value: pack(2024, 3, 5, 6, 7, 8), back: at('2024-03-05T06:07:08Z') });
  assert.deepStrictEqual(dosTime(at('2024-03-05T06:07:08Z') + 1n), { value: pack(2024, 3, 5, 6, 7, 10), back: at('2024-03-05T06:07:10Z') });
  assert.strictEqual(dosTime(at('2024-03-05T06:07:09Z')).value, pack(2024, 3, 5, 6, 7, 10));
  assert.strictEqual(dosTime(at('1999-12-31T23:59:59.500Z')).value, pack(2000, 1, 1, 0, 0, 0), 'into the next year');
  assert.strictEqual(dosTime(at('1980-01-01T00:00:00Z')).value, pack(1980, 1, 1, 0, 0, 0));
  assert.strictEqual(dosTime(at('2107-12-31T23:59:59Z')), null, 'rounded past the last DOS year');
});

test('reads the cache files of a folder, and only those, without writing anything', () => {
  const dir = workDir('thumbcache');
  dirs.push(dir);
  const s = sample();
  const empty = cacheFile(0x20, 0, [], { length: 24 }).file.subarray(0, 24);
  write(path.join(dir, 'thumbcache_256.db'), s.file);
  write(path.join(dir, 'thumbcache_16.db'), empty);
  write(path.join(dir, 'THUMBCACHE_WIDE.DB'), empty);
  write(path.join(dir, 'thumbcache_idx.db'), index32([], 3));
  write(path.join(dir, 'iconcache_256.db'), s.file);
  write(path.join(dir, 'thumbcache_notes.txt'), 'not a cache');
  write(path.join(dir, 'thumbcache_1024.db.bak'), s.file);
  fs.mkdirSync(path.join(dir, 'thumbcache_32.db'));
  let linked = false;
  try {
    fs.symlinkSync(path.join(dir, 'thumbcache_256.db'), path.join(dir, 'thumbcache_48.db'));
    linked = true;
  } catch (_) {
    /* no right to make links here */
  }
  const before = snapshot(dir);
  const r = tc.readCacheFolder(dir);
  assert.deepStrictEqual(snapshot(dir), before);
  assert.deepStrictEqual(r.caches.map((c) => c.name).sort(), ['THUMBCACHE_WIDE.DB', 'thumbcache_16.db', 'thumbcache_256.db']);
  assert.ok(r.caches.every((c) => c.reread === false));
  assert.deepStrictEqual(r.caches.find((c) => c.name === 'thumbcache_256.db').buffer, s.file);
  assert.strictEqual(r.caches[0].file, path.join(dir, r.caches[0].name));
  assert.strictEqual(r.index.name, 'thumbcache_idx.db');
  assert.strictEqual(tc.parseIndex(r.index.buffer).total, 3);
  assert.deepStrictEqual(r.errors, []);
  if (linked) assert.ok(!r.caches.some((c) => c.name === 'thumbcache_48.db'), 'a link is not read through');

  const small = tc.readCacheFolder(dir, { maxBytes: 1000 });
  assert.deepStrictEqual(small.errors.map((e) => [path.basename(e.file), e.error]), [['thumbcache_256.db', 'TOO_LARGE']]);
  assert.strictEqual(small.index.name, 'thumbcache_idx.db');

  const missing = tc.readCacheFolder(path.join(dir, 'nothing here'));
  assert.deepStrictEqual([missing.caches, missing.index, missing.errors.map((e) => e.error)], [[], null, ['ENOENT']]);
});

test('a cache file with an entry that fails its checksum is read a second time', () => {
  const dir = workDir('thumbcache-torn');
  dirs.push(dir);
  const s = sample();
  s.file[s.offsets[1] + 56 + 16 + 20] ^= 0x01;
  write(path.join(dir, 'thumbcache_256.db'), s.file);
  const r = tc.readCacheFolder(dir);
  assert.deepStrictEqual([r.caches.length, r.caches[0].reread], [1, true]);
  assert.deepStrictEqual(r.caches[0].buffer, s.file);
});

test('the file names read are the cache files of every Windows version', () => {
  for (const n of ['thumbcache_32.db', 'thumbcache_1024.db', 'thumbcache_1600.db', 'thumbcache_sr.db', 'thumbcache_wide.db',
    'thumbcache_exif.db', 'thumbcache_wide_alternate.db', 'thumbcache_custom_stream.db', 'thumbcache_2560.db']) {
    assert.ok(tc.CACHE_FILE.test(n), n);
  }
  for (const n of ['thumbcache_idx.db', 'iconcache_256.db', 'thumbcache_.db', 'thumbcache_256.db-journal', 'thumbs.db']) {
    assert.ok(!tc.CACHE_FILE.test(n), n);
  }
  assert.ok(tc.INDEX_FILE.test('Thumbcache_IDX.db'));
});
