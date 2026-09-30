'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { t } = require('../i18n');

// Windows Explorer keeps a small picture of every file it has shown as a thumbnail, and a note
// of every item it could not make one of, in one folder per user:
//
//   %LOCALAPPDATA%\Microsoft\Windows\Explorer\
//     thumbcache_<size>.db   one cache file per size; on Windows 10 and 11 these are 16, 32, 48,
//                            96, 256, 768, 1280, 1920, 2560, sr, wide, exif, wide_alternate and
//                            custom_stream
//     thumbcache_idx.db      an index: for each item, where its pictures are
//     iconcache_<size>.db    the same format, holding programs' icons; never read here
//
// Entries last: every entry two older shadow copies of one cache held was still in it, so a
// picture can outlive its file. What comes back is not the file, though: it is a smaller picture
// Windows made of it and encoded again, with no name, no path and no time.
//
// A cache file, all numbers little-endian:
//
//   header   "CMMM", format version, cache type (a position in the list of sizes), then:
//              0x14 Vista, 0x15 7, 0x1A         first entry, free entry, entry count   24 bytes
//              0x1C                             0, first, free, count                  28 bytes
//              0x1E 8, 0x1F 8.1, 0x20 10 and 11 0, first, free                         24 bytes
//   entry    "CMMM", the entry's size, a 64-bit hash, then the sizes of the identifier, the
//            padding and the data, from 0x1A on the picture's width and height, 4 bytes, the
//            data checksum and the header checksum: 56 bytes. Windows 7 has no width and height
//            (48 bytes); Vista has neither, and an 8-byte extension after the hash instead (56).
//            Then the identifier in UTF-16LE without a NUL, the padding (2 zero bytes before a
//            BMP), the picture, and 0 to 7 zero bytes. The next entry starts where the size says.
//   free     the entry the header points at as free: hash 0, nothing in it, zeros to the end of
//            the file. An empty cache is the 24-byte header alone.
//
// The hash is the item's System.ThumbnailCacheId (see cacheIdOf). The identifier is that hash
// in hex without leading zeros for a file; "Windows?<volume serial>?<file ID>" for pictures made
// through some other interface; a shell path such as ::{...} for other items. The header
// checksum does not cover the identifier, so it is a hint and nothing more.
//
// Both checksums are CRC-64/MS: reflected, polynomial 0x259C84CBA6426349, no final XOR; its
// table is the one in thumbcache.dll. The header's runs from all ones over the entry up to the
// header checksum. The data's runs from 0 over the whole picture when it is 1,024 bytes or less;
// a larger one's is the CRC of its first 1,024 bytes XORed with a second CRC, chained from 0 over
// the first 4 bytes of each 400-byte block after them. So only about 2 KB of a 100 KB picture is
// checked, and each picture's own structure is checked as well: a JPEG's segments and scans up to
// its end marker, which must be its last two bytes; every PNG chunk's CRC-32 up to IEND, the last
// chunk; a BMP's recorded file size and its rows; and the width and height against the entry's.
//
// The index, format 0x20 (this layout is documented nowhere else; the one libwtcdb gives puts the
// first slot 72 bytes too far):
//
//   header   4 bytes, "IMMM", version, 0, 4 bytes, slots in use, slots in all, the size of each
//            of the 14 cache files, the number of entries in each, 0: 144 bytes
//   slots    72 bytes each, an open-addressed hash table: the hash (0 in an empty slot), the
//            largest picture's size as (width << 12) | height, flags -- 0x80000000 when Windows
//            could not make a thumbnail -- and the entry's offset in each cache file, 0xFFFFFFFF
//            where it has none. There is no time in it.
//
// Vista's (0x14) and 7's (0x15) index, 24 bytes of header and slots of 40 and 32 bytes with five
// offsets, Vista's with the file's last-write time, and 8.1's (0x1F), 120 bytes and slots of 64
// with eleven, are read as libwtcdb describes them. Windows 8.0's is left unread: what libwtcdb
// says of it does not add up. The index is never needed; the cache files alone give the same.
//
// Measured on Windows 11 (26200), on copies of one user's cache, whose files were made with the
// profile a year before: all 14 cache files are version 0x20, and each file's type matches its
// name. 1,775 entries, 7 of them free; all 1,775 header checksums and all 1,775 data checksums
// pass. Every chain ends exactly at the end of its file, and no entry lies off it. 810 entries
// hold a picture, and all 810 pass their structure checks with the entry's width and height: 688
// BMPs (BITMAPV5, 32 bits, bottom up) in the 16 to 96 caches, 93 JPEGs (JFIF, no EXIF) and 29
// PNGs in the 256 to 1280 caches. 167 of the BMPs are opaque; of the 521 with transparent pixels,
// 515 have colour above alpha somewhere, which premultiplied colour cannot have, so their alpha
// is straight, and the other 6 fit either reading. The index's 1,767 offsets each point at an
// entry with the same hash, its sizes and counts equal the files', every entry has a slot, and
// each slot's size is that of its largest picture (644 of 644). Reading the 15.7 MB takes about
// 20 ms, and parsing it, with both checksums and the picture checks, 8 ms. Only format 0x20 was
// checked against real files; the other layouts are as thumbcacheviewer and libwtcdb read them.

// What each format version's file header and entries look like. `head` is an entry's fixed
// part, `at` where its three sizes start; `dims` says whether width and height follow them.
const VISTA_ENTRY = { head: 56, at: 24, dims: false, ext: true };
const WIN7_ENTRY = { head: 48, at: 16, dims: false, ext: false };
const WIN8_ENTRY = { head: 56, at: 16, dims: true, ext: false };

// The sizes each cache type stands for, by position.
const TYPES_VISTA = ['32', '96', '256', '1024', 'sr'];
const TYPES_8 = ['16', '32', '48', '96', '256', '1024', 'sr', 'wide', 'exif'];
const TYPES_81 = ['16', '32', '48', '96', '256', '1024', '1600', 'sr', 'wide', 'exif', 'wide_alternate'];
const TYPES_10 = ['16', '32', '48', '96', '256', '768', '1280', '1920', '2560', 'sr', 'wide', 'exif',
  'wide_alternate', 'custom_stream'];

const FORMATS = new Map([
  [0x14, { windows: 'Vista', header: 24, first: 12, free: 16, count: 20, entry: VISTA_ENTRY, types: TYPES_VISTA }],
  [0x15, { windows: '7', header: 24, first: 12, free: 16, count: 20, entry: WIN7_ENTRY, types: TYPES_VISTA }],
  [0x1a, { windows: '8, early builds', header: 24, first: 12, free: 16, count: 20, entry: WIN8_ENTRY, types: TYPES_8 }],
  [0x1c, { windows: '8, early builds', header: 28, first: 16, free: 20, count: 24, entry: WIN8_ENTRY, types: TYPES_8 }],
  [0x1e, { windows: '8', header: 24, first: 16, free: 20, count: null, entry: WIN8_ENTRY, types: TYPES_8 }],
  [0x1f, { windows: '8.1', header: 24, first: 16, free: 20, count: null, entry: WIN8_ENTRY, types: TYPES_81 }],
  [0x20, { windows: '10 and 11', header: 24, first: 16, free: 20, count: null, entry: WIN8_ENTRY, types: TYPES_10 }],
]);

const INDEX_FORMATS = new Map([
  [0x14, { sigAt: 0, used: 12, total: 16, header: 24, slot: 40, caches: 5, time: 8, flags: 16, offsets: 20 }],
  [0x15, { sigAt: 0, used: 12, total: 16, header: 24, slot: 32, caches: 5, flags: 8, offsets: 12 }],
  [0x1f, { sigAt: 4, used: 20, total: 24, header: 0x78, slot: 64, caches: 11, flags: 12, offsets: 16 }],
  [0x20, { sigAt: 4, used: 20, total: 24, header: 0x90, slot: 72, caches: 14, dims: 8, flags: 12, offsets: 16, sizes: 28, counts: 84 }],
]);

const SIGNATURE = 0x434d4d4d; // "CMMM", read big-endian
const NO_THUMBNAIL = 0x80000000;
const FILETIME_UNIX_OFFSET_MS = 11644473600000n;

// CRC-64/MS, kept in two 32-bit halves so that no BigInt is needed for each byte. table[128] is
// the reflected polynomial, 0x92C64265D32139A4.
const CRC_LO = new Uint32Array(256);
const CRC_HI = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let lo = n;
  let hi = 0;
  for (let k = 0; k < 8; k++) {
    const bit = lo & 1;
    lo = ((lo >>> 1) | ((hi & 1) << 31)) >>> 0;
    hi >>>= 1;
    if (bit) {
      lo = (lo ^ 0xd32139a4) >>> 0;
      hi = (hi ^ 0x92c64265) >>> 0;
    }
  }
  CRC_LO[n] = lo;
  CRC_HI[n] = hi;
}

/** The CRC over buf[start, end), carried on from the state [lo, hi]. */
function crcRun(buf, start, end, lo, hi) {
  for (let i = start; i < end; i++) {
    const x = (lo ^ buf[i]) & 0xff;
    lo = (((lo >>> 8) | (hi << 24)) ^ CRC_LO[x]) >>> 0;
    hi = ((hi >>> 8) ^ CRC_HI[x]) >>> 0;
  }
  return [lo, hi];
}

const big = ([lo, hi]) => (BigInt(hi) << 32n) | BigInt(lo);
const halves = (v) => [Number(BigInt.asUintN(64, v) & 0xffffffffn), Number(BigInt.asUintN(64, v) >> 32n)];
const hex64 = (lo, hi) => hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');

/** CRC-64/MS of a buffer, from `init` (a BigInt): all ones for a header, 0 for data. */
function crc64(buf, init = 0n) {
  const [lo, hi] = halves(BigInt(init));
  return big(crcRun(buf, 0, buf.length, lo, hi));
}

/** The data checksum as [lo, hi]: the whole of a small picture, a sample of a large one. */
function dataCrc(data) {
  const n = data.length;
  if (n <= 1024) return crcRun(data, 0, n, 0, 0);
  const [alo, ahi] = crcRun(data, 0, 1024, 0, 0);
  let lo = 0;
  let hi = 0;
  // The first 4 bytes of each 400-byte block, and of a last, shorter one as many as it has.
  for (let p = 1024; p < n; p += 400) [lo, hi] = crcRun(data, p, Math.min(p + 4, n), lo, hi);
  return [(alo ^ lo) >>> 0, (ahi ^ hi) >>> 0];
}

/** The data checksum a cache entry records for a picture, as a BigInt. */
function dataChecksum(data) {
  return big(dataCrc(data));
}

// zlib.crc32 arrived in Node 22.2; the table is for 22.0 and 22.1.
let CRC32_TABLE = null;
function crc32Table(buf) {
  if (!CRC32_TABLE) {
    CRC32_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC32_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const crc32 = typeof zlib.crc32 === 'function' ? (buf) => zlib.crc32(buf) >>> 0 : crc32Table;

const EXT = { jpeg: '.jpg', png: '.png', bmp: '.bmp' };

function formatOf(d) {
  if (d.length >= 3 && d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return 'jpeg';
  if (d.length >= 8 && d.readUInt32BE(0) === 0x89504e47 && d.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (d.length >= 2 && d[0] === 0x42 && d[1] === 0x4d) return 'bmp';
  return null;
}

// A frame header: every SOFn but DHT (C4), JPG (C8) and DAC (CC).
const isFrame = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/**
 * A JPEG's segments from SOI on, and each scan's entropy-coded data to the marker after it, which
 * is found as a 0xFF not followed by 0x00 (a stuffed byte) or a restart marker. It must end with
 * EOI exactly at its last byte, after a frame header and at least one scan.
 */
function checkJpeg(d) {
  const n = d.length;
  let width = null;
  let height = null;
  let scans = 0;
  let p = 2;
  for (;;) {
    if (p + 2 > n) return { width, height, why: 'end' };
    if (d[p] !== 0xff) return { width, height, why: 'structure' };
    const m = d[p + 1];
    if (m === 0xff) {
      p++; // a fill byte before a marker
      continue;
    }
    if (m === 0xd9) {
      if (width == null || !scans) return { width, height, why: 'structure' };
      return { width, height, why: p + 2 === n ? null : 'end' };
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      p += 2;
      continue;
    }
    if (m === 0x00 || m === 0xd8) return { width, height, why: 'structure' };
    if (p + 4 > n) return { width, height, why: 'end' };
    const len = d.readUInt16BE(p + 2);
    if (len < 2) return { width, height, why: 'structure' };
    if (p + 2 + len > n) return { width, height, why: 'end' };
    if (isFrame(m)) {
      if (len < 8) return { width, height, why: 'structure' };
      height = d.readUInt16BE(p + 5);
      width = d.readUInt16BE(p + 7);
    }
    p += 2 + len;
    if (m !== 0xda) continue;
    if (width == null) return { width, height, why: 'structure' };
    scans++;
    for (;;) {
      const q = d.indexOf(0xff, p);
      if (q < 0 || q + 1 >= n) return { width, height, why: 'end' };
      const next = d[q + 1];
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        p = q + 2;
      } else if (next === 0xff) {
        p = q + 1;
      } else {
        p = q;
        break;
      }
    }
  }
}

/** Every chunk of a PNG and its CRC-32, from IHDR, which must come first, to IEND, which must end it. */
function checkPng(d) {
  const n = d.length;
  let width = null;
  let height = null;
  let idat = false;
  for (let p = 8; ;) {
    if (p + 12 > n) return { width, height, why: 'end' };
    const len = d.readUInt32BE(p);
    if (len > 0x7fffffff || p + 12 + len > n) return { width, height, why: 'end' };
    const type = d.toString('latin1', p + 4, p + 8);
    if (crc32(d.subarray(p + 4, p + 8 + len)) !== d.readUInt32BE(p + 8 + len)) return { width, height, why: 'chunk' };
    if (p === 8) {
      if (type !== 'IHDR' || len !== 13) return { width, height, why: 'structure' };
      width = d.readUInt32BE(p + 8);
      height = d.readUInt32BE(p + 12);
      if (!width || !height) return { width, height, why: 'structure' };
    } else if (type === 'IDAT') {
      idat = true;
    } else if (type === 'IEND') {
      if (!idat) return { width, height, why: 'structure' };
      return { width, height, why: p + 12 === n ? null : 'end' };
    }
    p += 12 + len;
  }
}

const DIB_SIZES = new Set([40, 52, 56, 108, 124]);

/** A BMP's file header and bitmap header: the file size it records, and room for all its rows. */
function bmpHeader(d) {
  const n = d.length;
  if (n < 26) return null;
  const dib = d.readUInt32LE(14);
  const h = { offBits: d.readUInt32LE(10), dib, compression: 0 };
  if (dib === 12) {
    Object.assign(h, { width: d.readUInt16LE(18), height: d.readUInt16LE(20), planes: d.readUInt16LE(22), bpp: d.readUInt16LE(24) });
  } else if (DIB_SIZES.has(dib) && n >= 14 + dib) {
    Object.assign(h, {
      width: d.readInt32LE(18), height: d.readInt32LE(22), planes: d.readUInt16LE(26), bpp: d.readUInt16LE(28),
      compression: d.readUInt32LE(30),
    });
  } else {
    return null;
  }
  h.rows = Math.abs(h.height);
  h.topDown = h.height < 0;
  return h;
}

function checkBmp(d) {
  const h = bmpHeader(d);
  if (!h) return { width: null, height: null, why: 'structure' };
  const out = { width: h.width, height: h.rows };
  if (h.planes !== 1 || h.width <= 0 || !h.rows || h.offBits < 14 + h.dib || h.offBits > d.length) return { ...out, why: 'structure' };
  // Uncompressed rows, padded to 4 bytes: BI_RGB, BI_BITFIELDS and BI_ALPHABITFIELDS.
  if ([0, 3, 6].includes(h.compression)) {
    const stride = Math.floor((h.width * h.bpp + 31) / 32) * 4;
    if (h.offBits + stride * h.rows > d.length) return { ...out, why: 'end' };
  }
  if (d.readUInt32LE(2) !== d.length) return { ...out, why: 'file size' };
  return { ...out, why: null };
}

/**
 * Whether a picture is whole, by its own structure. `width` and `height` are what the cache entry
 * says, when it says; a picture of another size is not the one the entry was written with.
 * @returns {{ format: 'jpeg'|'png'|'bmp'|null, ext: string|null, width: number|null,
 *   height: number|null, ok: boolean, why: string|null }} `why` is what failed: 'format' (none of
 *   the three), 'structure', 'end' (cut short, or bytes after its end), 'chunk' (a PNG chunk's
 *   CRC), 'file size' (a BMP's), or 'dimensions'
 */
function checkImage(data, width = null, height = null) {
  const format = formatOf(data);
  if (!format) return { format: null, ext: null, width: null, height: null, ok: false, why: 'format' };
  const r = format === 'jpeg' ? checkJpeg(data) : format === 'png' ? checkPng(data) : checkBmp(data);
  let why = r.why;
  if (!why && width != null && height != null && (r.width !== width || r.height !== height)) why = 'dimensions';
  return { format, ext: EXT[format], width: r.width, height: r.height, ok: !why, why };
}

/**
 * How a 32-bit BMP's fourth byte should be read, for turning it into another format. A BGRA
 * bitmap can hold straight alpha, premultiplied colour, or a fourth byte left 0 everywhere; the
 * thumbnails measured here hold straight alpha (see the top of this file).
 *   'opaque'         every pixel's alpha is 255
 *   'zero'           every pixel's alpha is 0: it is unused, and the picture is opaque
 *   'straight'       some colour value exceeds its alpha, which premultiplied colour cannot
 *   'premultiplied'  no colour value exceeds its alpha: premultiplied, or straight colour that
 *                    happens to be that dark, which cannot be told apart
 * null for any other BMP: not 32 bits, compressed, or with its colours in other places.
 */
function bmpAlpha(d) {
  const h = bmpHeader(d);
  if (!h || h.bpp !== 32 || h.width <= 0 || !h.rows || h.dib === 12) return null;
  if (h.compression === 3 || h.compression === 6) {
    if (d.length < 66 || d.readUInt32LE(54) !== 0x00ff0000 || d.readUInt32LE(58) !== 0x0000ff00
      || d.readUInt32LE(62) !== 0x000000ff) return null;
    if (h.dib >= 56 && d.length >= 70 && d.readUInt32LE(66) !== 0xff000000) return null;
  } else if (h.compression !== 0) {
    return null;
  }
  const end = h.offBits + h.width * 4 * h.rows;
  if (end > d.length) return null;
  let all255 = true;
  let all0 = true;
  let above = false;
  for (let p = h.offBits; p < end; p += 4) {
    const a = d[p + 3];
    if (a !== 255) all255 = false;
    if (a !== 0) all0 = false;
    if (d[p] > a || d[p + 1] > a || d[p + 2] > a) above = true;
  }
  if (all255) return 'opaque';
  if (all0) return 'zero';
  return above ? 'straight' : 'premultiplied';
}

/**
 * The entry at `p`, or null when none starts there: no signature, or a size that is smaller than
 * an entry's fixed part or runs past the end of the file.
 */
function entryAt(buf, p, E, formatVersion) {
  if (p + E.head > buf.length || buf.readUInt32BE(p) !== SIGNATURE) return null;
  const size = buf.readUInt32LE(p + 4);
  if (size < E.head || size > buf.length - p) return null;
  const hashLo = buf.readUInt32LE(p + 8);
  const hashHi = buf.readUInt32LE(p + 12);
  const idSize = buf.readUInt32LE(p + E.at);
  const padSize = buf.readUInt32LE(p + E.at + 4);
  const dataSize = buf.readUInt32LE(p + E.at + 8);
  const [hlo, hhi] = crcRun(buf, p, p + E.head - 8, 0xffffffff, 0xffffffff);
  const headerOk = hlo === buf.readUInt32LE(p + E.head - 8) && hhi === buf.readUInt32LE(p + E.head - 4);
  // The identifier, the padding and the picture must fit in the entry.
  const fits = E.head + idSize + padSize + dataSize <= size;
  const idStart = p + E.head;
  const dataOffset = idStart + idSize + padSize;
  const data = fits ? buf.subarray(dataOffset, dataOffset + dataSize) : buf.subarray(0, 0);
  const [dlo, dhi] = dataCrc(data);
  const dataOk = fits && dlo === buf.readUInt32LE(p + E.head - 16) && dhi === buf.readUInt32LE(p + E.head - 12);
  const e = {
    offset: p,
    size,
    hash: hex64(hashLo, hashHi),
    identifier: fits ? buf.toString('utf16le', idStart, idStart + idSize - (idSize % 2)) : '',
    extension: E.ext ? buf.toString('utf16le', p + 16, p + 24).replace(/\0[\s\S]*$/, '') : null,
    width: E.dims ? buf.readUInt32LE(p + 28) : null,
    height: E.dims ? buf.readUInt32LE(p + 32) : null,
    dataOffset: fits ? dataOffset : null,
    dataSize: fits ? dataSize : 0,
    data,
    free: !hashLo && !hashHi,
    offChain: false,
    formatVersion,
    image: null,
    checks: { header: headerOk, data: dataOk, image: null },
    ok: false,
  };
  if (data.length) {
    e.image = checkImage(data, e.width, e.height);
    e.checks.image = e.image.ok;
    // Vista and 7 do not record the size; the picture does.
    if (!E.dims) {
      e.width = e.image.width;
      e.height = e.image.height;
    }
  }
  e.ok = headerOk && dataOk && e.checks.image !== false;
  return e;
}

/** The first offset from `from` on, before `to`, where an entry starts whose header checksum holds; -1 if none. */
function findEntry(buf, from, to, E) {
  for (let q = buf.indexOf('CMMM', from, 'latin1'); q >= 0 && q < to; q = buf.indexOf('CMMM', q + 1, 'latin1')) {
    if (q + E.head > buf.length) return -1;
    const size = buf.readUInt32LE(q + 4);
    if (size < E.head || size > buf.length - q) continue;
    const [lo, hi] = crcRun(buf, q, q + E.head - 8, 0xffffffff, 0xffffffff);
    if (lo === buf.readUInt32LE(q + E.head - 8) && hi === buf.readUInt32LE(q + E.head - 4)) return q;
  }
  return -1;
}

/**
 * Parses a thumbnail cache file.
 *
 * Entries follow one another by their sizes. Where no entry starts where the one before ended, or
 * an entry fails its header checksum -- and so its size cannot be trusted either -- the walk
 * goes on at the next entry whose header checksum holds, and `problems` says where. The inside of
 * a free entry is searched the same way for entries left over from before, marked `offChain`.
 *
 * A file whose own header is gone is read from its first entry whose header checksum holds, as
 * laid out from Windows 8 on or else as on 7; its version and type are then null. A shadow copy
 * taken while Explorer was writing can hold such a file. Of one snapshot's 14 cache files here, 2
 * began with zeros where the header and the first entries belong, and 5 ran into zeros part way,
 * just after an entry that was cut short and fails its data checksum (in one, the free entry came
 * after the zeros, and the walk went on to it). Read so, the snapshot gave 1,721 entries, 132 of
 * them from the two files without a header, and 1,716 passed both checksums.
 *
 * Each entry's `data` is a view into `buf`, not a copy: keeping one keeps the whole file in memory.
 *
 * @param {Buffer} buf the whole file
 * @returns {null | {
 *   version: number|null, windows: string|null, type: number|null, typeName: string|null,
 *   first: number|null, free: number|null, count: number|null, length: number,
 *   entries: object[], problems: { offset: number, why: string, resumedAt?: number }[]
 * }} null when it is not a thumbnail cache at all. Each entry is
 *   { offset, size, hash (16 hex digits), identifier, extension (Vista only), width, height,
 *     dataOffset, dataSize, data, free, offChain, formatVersion, image (from checkImage, or null
 *     without data), checks: { header, data, image }, ok }, `ok` when every check made passed.
 *   `why` is 'file header' (none: read from the first entry found), 'version' (a format not
 *   known here: no entries are read), 'type', 'first' (the first entry is not where the header
 *   says), 'chain' (no entry where the last one ended), 'header' (an entry that fails its header
 *   checksum), or 'end' (bytes after the last entry, too few to be one).
 */
function parseCache(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== SIGNATURE) return headerless(buf);
  const version = buf.readUInt32LE(4);
  const type = buf.readUInt32LE(8);
  const f = FORMATS.get(version);
  const out = {
    version, windows: null, type, typeName: null, first: null, free: null, count: null, length: buf.length,
    entries: [], problems: [],
  };
  if (!f || buf.length < f.header) {
    out.problems.push({ offset: 4, why: 'version' });
    return out;
  }
  out.windows = f.windows;
  out.typeName = f.types[type] || null;
  if (!out.typeName) out.problems.push({ offset: 8, why: 'type' });
  out.first = buf.readUInt32LE(f.first);
  out.free = buf.readUInt32LE(f.free);
  out.count = f.count == null ? null : buf.readUInt32LE(f.count);
  let p = out.first;
  if (p < f.header || p > buf.length) {
    // 0 means not set, as on an older Windows.
    if (p !== 0) out.problems.push({ offset: f.first, why: 'first' });
    p = f.header;
  }
  walk(buf, p, f.entry, version, out);
  return out;
}

/**
 * Which layout a file without a header has is told by its first entry that passes both
 * checksums. The header checksum alone cannot tell it: this CRC over a message followed by the
 * message's own CRC comes to 0, so a Windows 7 entry followed by 8 zero bytes -- a free entry --
 * passes as a later Windows's header too, and fails only its data checksum then.
 */
function headerless(buf) {
  let best = null;
  for (const E of [WIN8_ENTRY, WIN7_ENTRY]) {
    for (let q = findEntry(buf, 0, buf.length, E); q >= 0; q = findEntry(buf, q + 1, buf.length, E)) {
      if (!entryAt(buf, q, E, null).checks.data) continue;
      if (!best || q < best.at) best = { at: q, E };
      break;
    }
  }
  if (!best) return null;
  const out = {
    version: null, windows: null, type: null, typeName: null, first: null, free: null, count: null,
    length: buf.length, entries: [], problems: [{ offset: 0, why: 'file header' }],
  };
  // From the first entry whose header holds, which may be one cut short before that one.
  walk(buf, findEntry(buf, 0, buf.length, best.E), best.E, null, out);
  return out;
}

/** Follows the entries from `p` to the end of the file, into `out`. */
function walk(buf, p, E, version, out) {
  const resume = (why) => {
    const next = findEntry(buf, p + 1, buf.length, E);
    out.problems.push({ offset: p, why, resumedAt: next });
    return next;
  };
  while (p < buf.length) {
    if (p + E.head > buf.length) {
      if (buf.subarray(p).some((b) => b)) out.problems.push({ offset: p, why: 'end' });
      break;
    }
    const e = entryAt(buf, p, E, version);
    if (!e) {
      p = resume('chain');
      if (p < 0) break;
      continue;
    }
    out.entries.push(e);
    if (!e.checks.header) {
      p = resume('header');
      if (p < 0) break;
      continue;
    }
    if (e.free) leftovers(buf, e, E, version, out.entries);
    p += e.size;
  }
}

/** Entries whose header checksum holds, inside a free entry's zeros. */
function leftovers(buf, free, E, version, into) {
  const end = free.offset + free.size;
  for (let q = findEntry(buf, free.offset + E.head, end, E); q >= 0; q = findEntry(buf, q, end, E)) {
    const e = entryAt(buf, q, E, version);
    e.offChain = true;
    into.push(e);
    q += Math.max(e.size, 1);
    if (q >= end) break;
  }
}

/** The entries that hold a picture that passed every check. */
function thumbnails(cache) {
  return cache ? cache.entries.filter((e) => e.ok && !e.free && e.dataSize > 0) : [];
}

/**
 * Parses a thumbcache_idx.db.
 * @returns {null | { version: number, used: number|null, total: number|null,
 *   fileSizes: number[]|null, counts: number[]|null, slots: object[],
 *   problems: { offset: number, why: string }[] }} null when it is not an index. `slots` holds
 *   the slots in use, each { slot, hash, flags, offsets, width, height, noThumbnail, time }:
 *   `offsets[type]` is the entry's offset in the cache file of that type, or null; width, height
 *   and noThumbnail are known from format 0x20 on, and time (ms, the file's last write) in
 *   Vista's only; each is null where it is not. `why` is 'version' (a format not read here: no
 *   slots), 'size' (the file is not the header and a whole number of slots) or 'used' (the header
 *   counts another number of slots in use).
 */
function parseIndex(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  let sigAt = -1;
  if (buf.toString('latin1', 0, 4) === 'IMMM') sigAt = 0;
  else if (buf.length >= 28 && buf.toString('latin1', 4, 8) === 'IMMM') sigAt = 4;
  if (sigAt < 0) return null;
  const version = buf.readUInt32LE(sigAt + 4);
  const f = INDEX_FORMATS.get(version);
  const out = { version, used: null, total: null, fileSizes: null, counts: null, slots: [], problems: [] };
  if (!f || f.sigAt !== sigAt || buf.length < f.header) {
    out.problems.push({ offset: sigAt + 4, why: 'version' });
    return out;
  }
  out.used = buf.readUInt32LE(f.used);
  out.total = buf.readUInt32LE(f.total);
  if (f.sizes != null) {
    out.fileSizes = Array.from({ length: f.caches }, (_, i) => buf.readUInt32LE(f.sizes + 4 * i));
    out.counts = Array.from({ length: f.caches }, (_, i) => buf.readUInt32LE(f.counts + 4 * i));
  }
  if (buf.length !== f.header + out.total * f.slot) out.problems.push({ offset: f.total, why: 'size' });
  for (let i = 0, p = f.header; p + f.slot <= buf.length; i++, p += f.slot) {
    const lo = buf.readUInt32LE(p);
    const hi = buf.readUInt32LE(p + 4);
    if (!lo && !hi) continue;
    const offsets = [];
    for (let k = 0; k < f.caches; k++) {
      const o = buf.readUInt32LE(p + f.offsets + 4 * k);
      offsets.push(o === 0 || o === 0xffffffff ? null : o);
    }
    const flags = buf.readUInt32LE(p + f.flags);
    const dims = f.dims == null ? null : buf.readUInt32LE(p + f.dims);
    let time = null;
    if (f.time != null) {
      const ft = buf.readBigUInt64LE(p + f.time);
      if (ft > 0n) time = Number(ft / 10000n - FILETIME_UNIX_OFFSET_MS);
    }
    out.slots.push({
      slot: i, hash: hex64(lo, hi), flags, offsets,
      width: dims == null ? null : dims >>> 12,
      height: dims == null ? null : dims & 0xfff,
      noThumbnail: dims == null ? null : !!(flags & NO_THUMBNAIL),
      time,
    });
  }
  if (out.slots.length !== out.used) out.problems.push({ offset: f.used, why: 'used' });
  return out;
}

/**
 * Checks an index against the cache files beside it, parsed: that each offset it gives points at
 * an entry with the same hash, that every entry has a slot, and, where the index records them,
 * that each file's size and number of entries are what it says. Caches of another format
 * version than the index's are not compared.
 * @returns {{ offsets: number, matched: number, wrongHash: number, nothingThere: number,
 *   noFile: number, unindexed: number, sizes: boolean|null, counts: boolean|null }}
 */
function crossCheck(index, caches) {
  const byType = new Map();
  for (const c of caches || []) {
    if (c && c.version === index.version && !byType.has(c.type)) byType.set(c.type, c);
  }
  const at = new Map([...byType].map(([type, c]) => [type, new Map(c.entries.filter((e) => !e.offChain).map((e) => [e.offset, e]))]));
  const r = { offsets: 0, matched: 0, wrongHash: 0, nothingThere: 0, noFile: 0, unindexed: 0, sizes: null, counts: null };
  const hashes = new Set();
  for (const s of index.slots) {
    hashes.add(s.hash);
    s.offsets.forEach((o, type) => {
      if (o == null) return;
      r.offsets++;
      if (!at.has(type)) {
        r.noFile++;
        return;
      }
      const e = at.get(type).get(o);
      if (!e) r.nothingThere++;
      else if (e.hash !== s.hash) r.wrongHash++;
      else r.matched++;
    });
  }
  for (const entries of at.values()) {
    for (const e of entries.values()) if (!e.free && !hashes.has(e.hash)) r.unindexed++;
  }
  if (index.fileSizes && byType.size) {
    r.sizes = [...byType].every(([type, c]) => index.fileSizes[type] === c.length);
    r.counts = [...byType].every(([type, c]) => index.counts[type] === c.entries.filter((e) => !e.free && !e.offChain).length);
  }
  return r;
}

/**
 * What an entry's identifier says about its item:
 *   { kind: 'hash' }                                the entry's own hash in hex: a file
 *   { kind: 'file id', volumeSerial, fileId }       "Windows?<serial>?<file ID>", in lowercase hex
 *   { kind: 'shell' }                               a shell path, ::{CLSID}...
 *   { kind: 'none' } or { kind: 'other' }
 */
function parseIdentifier(identifier, hash) {
  if (!identifier) return { kind: 'none' };
  const low = identifier.toLowerCase();
  if (/^[0-9a-f]{1,16}$/.test(low) && hash && low.padStart(16, '0') === hash) return { kind: 'hash' };
  const m = /^windows\?([0-9a-f]{8})\?([0-9a-f]{1,32})$/.exec(low);
  if (m) return { kind: 'file id', volumeSerial: m[1], fileId: m[2] };
  if (identifier.startsWith('::{')) return { kind: 'shell' };
  return { kind: 'other' };
}

const M64 = (1n << 64n) - 1n;

/** shell32's hash step, over each byte in turn. */
function hashBytes(bytes, h) {
  for (const b of bytes) h ^= ((h * 0x820n) + BigInt(b) + (h >> 2n)) & M64;
  return h;
}

/** A GUID in any common spelling -- {...}, Volume{...}, \\?\Volume{...}\ -- as the 16 bytes of a GUID structure. */
function guidBytes(guid) {
  if (Buffer.isBuffer(guid)) {
    if (guid.length !== 16) throw new RangeError(t('A volume GUID is 16 bytes.'));
    return guid;
  }
  const m = /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})/i.exec(String(guid));
  if (!m) throw new RangeError(t('Not a volume GUID: {0}', guid));
  const b = Buffer.alloc(16);
  b.writeUInt32LE(parseInt(m[1], 16), 0);
  b.writeUInt16LE(parseInt(m[2], 16), 4);
  b.writeUInt16LE(parseInt(m[3], 16), 6);
  Buffer.from(m[4] + m[5], 'hex').copy(b, 8);
  return b;
}

const TWO_SECONDS = 20000000n;

/**
 * FileTimeToDosDateTime on a FILETIME taken as it is, with no change to local time: the date and
 * time packed as (date << 16) | time, and the FILETIME that gives back. A time between two even
 * seconds is rounded up to the later one, as FAT rounds; rounded down, not one file whose time
 * has a fraction of a second matched its entry here. null outside the years a DOS date holds,
 * 1980 to 2107.
 */
function dosTime(filetime) {
  if (filetime < 0n) return null;
  // 1601 and 1970 are both on an even second, so this is the same on either count.
  const rest = filetime % TWO_SECONDS;
  const back = rest ? filetime - rest + TWO_SECONDS : filetime;
  const d = new Date(Number(back / 10000n - FILETIME_UNIX_OFFSET_MS));
  const y = d.getUTCFullYear();
  if (!(y >= 1980 && y <= 2107)) return null;
  const date = ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  return { value: ((date << 16) | time) >>> 0, back };
}

const u32le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

/**
 * The ThumbnailCacheId shell32 gives a file on a local volume, as thumbcacheviewer found it: from
 * 0x95E729BA2C37FD21, hashed over the volume's GUID structure, the 64-bit file ID, then -- from
 * Windows 7 on -- the extension with its dot in UTF-16LE, its case kept, and the last write as a
 * DOS date and time, and -- from 8.1 on -- the low 32 bits of the DOS time turned back into a
 * FILETIME, less those of the last write, when that is not 0. So it changes when the file is
 * renamed to another extension, moved to another volume, or written to. Folders are hashed some
 * other way, not known.
 *
 * Measured on Windows 11 against one user's cache: of 495,990 files in the profile, 313 hash to
 * an item in it -- 100 of the 617 items with a picture whose identifier is their hash -- and 273
 * of the 313 have a last write with a fraction of a second, which matches only when the DOS time
 * is rounded up (see dosTime).
 *
 * @param {object} o
 * @param {string|Buffer} o.volumeGuid  the volume's GUID, as mountvol prints it
 * @param {bigint|number} o.fileId      the file ID: fs.statSync(p, { bigint: true }).ino on NTFS
 * @param {string} o.ext                the extension as Windows gives it, with its dot; '' for none
 * @param {bigint} o.filetime           the last write, in 100 ns since 1601 UTC:
 *   st.mtimeNs / 100n + 116444736000000000n
 * @param {number|null} [formatVersion] the cache's format version, as an entry's formatVersion;
 *   0x20 when not known. 0x14 hashes as Vista does, 0x15 to 0x1E as 7 and 8 do
 * @returns {string|null} 16 hex digits, as an entry's `hash`; null for a time before 1980 or after 2107
 */
function cacheIdOf({ volumeGuid, fileId, ext = '', filetime }, formatVersion = null) {
  if (formatVersion == null) formatVersion = 0x20;
  let h = hashBytes(guidBytes(volumeGuid), 0x95e729ba2c37fd21n);
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(BigInt.asUintN(64, BigInt(fileId)));
  h = hashBytes(id, h);
  if (formatVersion >= 0x15) {
    const ft = BigInt(filetime);
    const dos = dosTime(ft);
    if (!dos) return null;
    h = hashBytes(Buffer.from(String(ext), 'utf16le'), h);
    h = hashBytes(u32le(dos.value), h);
    if (formatVersion >= 0x1f) {
      const loss = (Number(dos.back & 0xffffffffn) - Number(ft & 0xffffffffn)) >>> 0;
      if (loss) h = hashBytes(u32le(loss), h);
    }
  }
  return h.toString(16).padStart(16, '0');
}

const CACHE_FILE = /^thumbcache_(\d+|sr|wide|exif|wide_alternate|custom_stream)\.db$/i;
const INDEX_FILE = /^thumbcache_idx\.db$/i;
// Offsets in a cache file are 32 bits, so no cache file can be larger.
const MAX_BYTES = 2 ** 32;
const CHUNK = 64 * 1024 * 1024;
// Opening without waiting, where there is such a flag, so that a pipe put in a file's place
// cannot hold the read up; a plain file reads the same.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);

/** A plain file's bytes, however large, from one open. */
function readPlain(file, maxBytes) {
  const fd = fs.openSync(file, OPEN_FLAGS);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(t('not a plain file'));
    if (st.size > maxBytes) {
      const e = new Error(t('larger than {0} bytes', maxBytes));
      e.code = 'TOO_LARGE';
      throw e;
    }
    const buf = Buffer.allocUnsafe(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, Math.min(buf.length - got, CHUNK), got);
      if (!n) break;
      got += n;
    }
    return got < buf.length ? buf.subarray(0, got) : buf;
  } finally {
    fs.closeSync(fd);
  }
}

/** How many entries of a cache file fail a checksum. */
function damaged(buf) {
  const c = parseCache(buf);
  return c ? c.entries.filter((e) => !e.checks.header || !e.checks.data).length : 0;
}

/**
 * Reads a cache folder's thumbcache files into memory, once, so that what Explorer writes later
 * cannot change what is parsed. Only plain files named thumbcache_<size>.db and
 * thumbcache_idx.db are read: not iconcache_*.db, and not a link or folder under such a name.
 *
 * Explorer writes the files through a memory map while they are read, so an entry can be caught
 * half written and fail its checksums. A cache file with such an entry is read once more, and the
 * read with fewer of them is kept; `reread` says it was. A file's times are not given: Explorer's
 * writes through the map do not change them, so they say nothing of when a picture was made.
 *
 * @param {string} dir
 * @param {{ maxBytes?: number }} [options] files larger than this are left out, in `errors`
 * @returns {{ dir: string, caches: { name: string, file: string, buffer: Buffer, reread: boolean }[],
 *   index: { name: string, file: string, buffer: Buffer } | null, errors: { file: string, error: string }[] }}
 */
function readCacheFolder(dir, { maxBytes = MAX_BYTES } = {}) {
  const out = { dir, caches: [], index: null, errors: [] };
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
  } catch (e) {
    out.errors.push({ file: dir, error: e.code || e.message });
    return out;
  }
  for (const name of names) {
    const isIndex = INDEX_FILE.test(name);
    if (!isIndex && !CACHE_FILE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      let buffer = readPlain(file, maxBytes);
      if (isIndex) {
        out.index = { name, file, buffer };
        continue;
      }
      let reread = false;
      const torn = damaged(buffer);
      if (torn) {
        const again = readPlain(file, maxBytes);
        if (damaged(again) < torn) buffer = again;
        reread = true;
      }
      out.caches.push({ name, file, buffer, reread });
    } catch (e) {
      out.errors.push({ file, error: e.code || e.message });
    }
  }
  return out;
}

/** The sizes a format version's cache types stand for, by type; null for a version not known here. */
function cacheTypes(version) {
  const f = FORMATS.get(version);
  return f ? f.types.slice() : null;
}

module.exports = {
  parseCache,
  parseIndex,
  crossCheck,
  thumbnails,
  readCacheFolder,
  checkImage,
  bmpAlpha,
  parseIdentifier,
  cacheIdOf,
  cacheTypes,
  crc64,
  dataChecksum,
  VERSIONS: [...FORMATS.keys()],
  INDEX_VERSIONS: [...INDEX_FORMATS.keys()],
  CACHE_FILE,
  INDEX_FILE,
  _internal: { CRC_LO, CRC_HI, crcRun, dataCrc, crc32, crc32Table, dosTime, guidBytes, hashBytes, entryAt, findEntry, formatOf },
};
