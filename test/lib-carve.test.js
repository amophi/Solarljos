'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { workDir, cleanup, write, snapshot } = require('./helpers');
const carve = require('../src/lib/carve');
const { memoryReader, openReader, extentReader } = require('../src/lib/fat');
const { tier } = require('../src/quality');
const { restore } = require('../src/restore');

const { scan, validate, judge, candidate } = carve;
const I = carve._internal;

const dirs = [];
after(() => dirs.forEach(cleanup));

// Every file here is made by the generators below, from a seed: small, but whole by each format's
// own rules -- Pillow opens and decodes the JPEGs, PNGs, GIFs and BMPs they make. A disk is a
// buffer with files put on sector boundaries and free space between, zeros or old random data.

// ---------------------------------------------------------------- generators

const { rng, randomBytes, md5, u16, u32, le32, latin1, TiffBuilder, exifTiff, makeJpeg } = require('./make-jpeg');

function pngChunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, 'latin1');
  data.copy(b, 8);
  b.writeUInt32BE(I.crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}

const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

/** A PNG of random pixels: gray (0), RGB (2) or RGBA (6), interlaced or not, its data in several IDATs. */
function makePng({ seed = 1, width = 32, height = 24, color = 0, interlace = 0, time = null } = {}) {
  const rand = rng(seed);
  const channels = { 0: 1, 2: 3, 6: 4 }[color];
  const rows = [];
  const pass = (w, h) => {
    for (let y = 0; y < h; y++) {
      const r = Buffer.alloc(1 + w * channels);
      for (let i = 1; i < r.length; i++) r[i] = Math.floor(rand() * 256);
      rows.push(r);
    }
  };
  if (!interlace) pass(width, height);
  for (const [x0, y0, dx, dy] of interlace ? ADAM7 : []) {
    const w = Math.ceil((width - x0) / dx);
    const h = Math.ceil((height - y0) / dy);
    if (w > 0 && h > 0) pass(w, h);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = color;
  ihdr[12] = interlace;
  const z = zlib.deflateSync(Buffer.concat(rows));
  const idats = [];
  for (let i = 0; i < z.length; i += 1000) idats.push(pngChunk('IDAT', z.subarray(i, i + 1000)));
  const extra = time ? [pngChunk('tIME', Buffer.concat([u16(time[0]), Buffer.from(time.slice(1))]))] : [];
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), ...extra,
    ...idats, pngChunk('IEND', Buffer.alloc(0))]);
}

/**
 * GIF LZW, the plain way: every pixel a code of its own, a clear code every 200, and the code
 * size grown exactly when a decoder grows it.
 */
function lzw(pixels, min) {
  const clear = 1 << min;
  const eoi = clear + 1;
  const out = [];
  let acc = 0;
  let nbits = 0;
  let size = min + 1;
  let next = eoi + 1;
  let prev = false;
  let run = 0;
  const emit = (code) => {
    acc |= code << nbits;
    nbits += size;
    while (nbits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      nbits -= 8;
    }
  };
  emit(clear);
  for (const p of pixels) {
    if (run === 200) {
      emit(clear);
      size = min + 1;
      next = eoi + 1;
      prev = false;
      run = 0;
    }
    emit(p);
    if (prev && next < 4096) {
      next++;
      if (next === 1 << size && size < 12) size++;
    }
    prev = true;
    run++;
  }
  emit(eoi);
  if (nbits) out.push(acc & 0xff);
  return Buffer.from(out);
}

function makeGif({ seed = 1, width = 20, height = 10, frames = 1 } = {}) {
  const rand = rng(seed);
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0x81;
  const parts = [latin1('GIF89a'), lsd, Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255])];
  if (frames > 1) parts.push(Buffer.from([0x21, 0xff, 11]), latin1('NETSCAPE2.0'), Buffer.from([3, 1, 0, 0, 0]));
  for (let f = 0; f < frames; f++) {
    parts.push(Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]));
    const d = Buffer.alloc(10);
    d[0] = 0x2c;
    d.writeUInt16LE(width, 5);
    d.writeUInt16LE(height, 7);
    parts.push(d, Buffer.from([2]));
    const data = lzw(Array.from({ length: width * height }, () => Math.floor(rand() * 4)), 2);
    for (let i = 0; i < data.length; i += 255) {
      const s = data.subarray(i, i + 255);
      parts.push(Buffer.from([s.length]), s);
    }
    parts.push(Buffer.from([0]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

function makeBmp({ seed = 1, width = 30, height = 20 } = {}) {
  const row = Math.ceil((width * 24) / 32) * 4;
  const b = Buffer.alloc(54 + row * height);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(row * height, 34);
  randomBytes(row * height, seed).copy(b, 54);
  return b;
}

function riffChunk(id, data) {
  return Buffer.concat([latin1(id), le32(data.length), data, Buffer.alloc(data.length & 1)]);
}
const riffList = (type, chunks) => riffChunk('LIST', Buffer.concat([latin1(type), ...chunks]));
const riffFile = (form, chunks) => {
  const body = Buffer.concat([latin1(form), ...chunks]);
  return Buffer.concat([latin1('RIFF'), le32(body.length), body]);
};

/** A lossless WebP's header, with data no decoder is asked to read; VP8X and EXIF with `exif`. */
function makeWebp({ seed = 1, width = 40, height = 30, exif = null } = {}) {
  const vp8l = Buffer.concat([Buffer.from([0x2f]), le32((width - 1) | ((height - 1) << 14) | (1 << 28)), randomBytes(301, seed)]);
  const chunks = [];
  if (exif) {
    const x = Buffer.alloc(10);
    x[0] = 0x08;
    x.writeUIntLE(width - 1, 4, 3);
    x.writeUIntLE(height - 1, 7, 3);
    chunks.push(riffChunk('VP8X', x));
  }
  chunks.push(riffChunk('VP8L', vp8l));
  if (exif) chunks.push(riffChunk('EXIF', exifTiff(exif)));
  return riffFile('WEBP', chunks);
}

function makeWav({ seed = 1, samples = 8000 } = {}) {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(8000, 4);
  fmt.writeUInt32LE(16000, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  return riffFile('WAVE', [riffChunk('fmt ', fmt), riffChunk('data', randomBytes(samples * 2, seed))]);
}

/**
 * A Motion JPEG AVI. Each frame's data starts on an `align` boundary of the file, as writers
 * that pad with JUNK chunks leave them, so a carve at that step meets every frame.
 */
function makeAvi({ seed = 1, frames = 3, width = 32, height = 16, idit = 'SUN SEP 05 09:32:43 2004\n\0', align = 512, avi1 = true } = {}) {
  const jpegs = Array.from({ length: frames }, (_, i) => makeJpeg({ seed: seed * 100 + i, width, height, avi1 }));
  const avih = Buffer.alloc(56);
  avih.writeUInt32LE(40000, 0);
  avih.writeUInt32LE(0x10, 12);
  avih.writeUInt32LE(frames, 16);
  avih.writeUInt32LE(1, 24);
  avih.writeUInt32LE(width, 32);
  avih.writeUInt32LE(height, 36);
  const strh = Buffer.alloc(56);
  strh.write('vidsMJPG', 0, 'latin1');
  strh.writeUInt32LE(1, 20);
  strh.writeUInt32LE(25, 24);
  strh.writeUInt32LE(frames, 32);
  const strf = Buffer.alloc(40);
  strf.writeUInt32LE(40, 0);
  strf.writeInt32LE(width, 4);
  strf.writeInt32LE(height, 8);
  strf.writeUInt16LE(1, 12);
  strf.writeUInt16LE(24, 14);
  strf.write('MJPG', 16, 'latin1');
  const hdrl = riffList('hdrl', [riffChunk('avih', avih), riffList('strl', [riffChunk('strh', strh), riffChunk('strf', strf)]),
    ...(idit ? [riffChunk('IDIT', latin1(idit))] : [])]);
  let pos = 12 + hdrl.length + 12;
  const movi = [];
  const idx = [];
  for (const j of jpegs) {
    if (align && (pos + 8) % align) {
      const gap = (align - ((pos + 16) % align)) % align;
      movi.push(riffChunk('JUNK', Buffer.alloc(gap)));
      pos += 8 + gap;
    }
    idx.push(Buffer.concat([latin1('00dc'), le32(0x10), le32(pos - (12 + hdrl.length + 8)), le32(j.length)]));
    const c = riffChunk('00dc', j);
    movi.push(c);
    pos += c.length;
  }
  return riffFile('AVI ', [hdrl, riffList('movi', movi), riffChunk('idx1', Buffer.concat(idx))]);
}

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), latin1(type), body]);
}
const fullBox = (type, v, ...parts) => box(type, Buffer.from([v, 0, 0, 0]), ...parts);

/**
 * An ISO BMFF movie with one video track: H.264 samples of NAL units with 4-byte lengths, or
 * Motion JPEG samples (codec 'jpeg'), each on a `frameAlign` boundary when given. `moov: false`
 * leaves the movie header out, as an interrupted recording does; `openMdat` writes mdat's size as
 * 0, "to the end of the file". `free` puts a free box of that many bytes after ftyp; `thumb` puts a
 * JPEG in moov/udta, on a 512-byte boundary of the file.
 */
function makeMp4({ seed = 1, samples = 30, perChunk = 10, brand = 'isom', created = Date.UTC(2025, 4, 17, 10, 20, 30),
  moov = true, openMdat = false, codec = 'avc1', frameAlign = 0, width = 640, height = 480, free = 0, thumb = null } = {}) {
  const rand = rng(seed);
  const data = [];
  for (let i = 0; i < samples; i++) {
    if (codec === 'jpeg') {
      data.push(makeJpeg({ seed: seed * 1000 + i, width: 32, height: 16 }));
      continue;
    }
    const nals = [];
    const count = 1 + Math.floor(rand() * 3);
    for (let n = 0; n < count; n++) {
      const len = 100 + Math.floor(rand() * 1500);
      const nal = Buffer.alloc(4 + len);
      nal.writeUInt32BE(len, 0);
      for (let k = 5; k < nal.length; k++) nal[k] = Math.floor(rand() * 256);
      nal[4] = i % 30 === 0 ? 0x65 : 0x41;
      nals.push(nal);
    }
    data.push(Buffer.concat(nals));
  }
  const ftyp = Buffer.concat([box('ftyp', latin1(brand), u32(0x200), latin1(brand + 'mp41')), free ? box('free', Buffer.alloc(free - 8)) : Buffer.alloc(0)]);
  const mdatStart = ftyp.length + 8;
  const body = [];
  const offsets = [];
  let at = mdatStart;
  for (let i = 0; i < samples; i++) {
    if (frameAlign && at % frameAlign) {
      const pad = frameAlign - (at % frameAlign);
      body.push(Buffer.alloc(pad));
      at += pad;
    }
    offsets.push(at);
    body.push(data[i]);
    at += data[i].length;
  }
  const mdatBody = Buffer.concat(body);
  const mdat = openMdat ? Buffer.concat([u32(0), latin1('mdat'), mdatBody]) : box('mdat', mdatBody);
  if (!moov) return Buffer.concat([ftyp, mdat]);
  const per = frameAlign || codec === 'jpeg' ? 1 : perChunk;
  const chunkOffsets = offsets.filter((_, i) => i % per === 0);
  const secs = Math.floor(created / 1000) + 2082844800;
  const entry = codec === 'jpeg'
    ? box('jpeg', Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(width, height), u32(0x480000, 0x480000, 0), u16(1), Buffer.alloc(32), u16(0x18, 0xffff))
    : box('avc1', Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(width, height), u32(0x480000, 0x480000, 0), u16(1), Buffer.alloc(32), u16(0x18, 0xffff),
      box('avcC', Buffer.from([1, 0x64, 0, 0x1f, 0xff, 0xe1]), u16(4), Buffer.from([0x67, 0x64, 0, 0x1f]), Buffer.from([1]), u16(2), Buffer.from([0x68, 0xee])));
  const stbl = box('stbl',
    fullBox('stsd', 0, u32(1), entry),
    fullBox('stts', 0, u32(1, samples, 1000)),
    fullBox('stsc', 0, u32(1, 1, per, 1)),
    fullBox('stsz', 0, u32(0, samples, ...data.map((d) => d.length))),
    fullBox('stco', 0, u32(chunkOffsets.length, ...chunkOffsets)));
  const trak = box('trak',
    fullBox('tkhd', 0, u32(secs, secs, 1, 0, samples * 1000), Buffer.alloc(52), u32(width << 16, height << 16)),
    box('mdia',
      fullBox('mdhd', 0, u32(secs, secs, 30000, samples * 1000), u16(0x55c4, 0)),
      fullBox('hdlr', 0, u32(0), latin1('vide'), Buffer.alloc(12), latin1('Video\0')),
      box('minf', fullBox('vmhd', 0, Buffer.alloc(8)), box('dinf', fullBox('dref', 0, u32(1), fullBox('url ', 0))), stbl)));
  const mvhd = fullBox('mvhd', 0, u32(secs, secs, 30000, samples * 1000, 0x10000), u16(0x100), Buffer.alloc(10),
    Buffer.alloc(36), Buffer.alloc(24), u32(2));
  let udta = Buffer.alloc(0);
  if (thumb) {
    // udta, then a box of padding up to the next 512-byte boundary, then the picture's own box.
    const at = ftyp.length + mdat.length + 8 + mvhd.length + trak.length + 8;
    const pad = (512 - ((at + 8 + 8) % 512)) % 512;
    udta = box('udta', box('free', Buffer.alloc(pad)), box('thmb', thumb));
  }
  return Buffer.concat([ftyp, mdat, box('moov', mvhd, trak, udta)]);
}

/**
 * A Canon CR3 as far as carving goes: ftyp "crx ", a movie header with a thumbnail in a uuid box
 * and one track whose one sample is the full-size JPEG in mdat -- on a 512-byte boundary -- and a
 * uuid box after it holding a smaller preview.
 */
function makeCr3({ full, small, thumb }) {
  const ftyp = box('ftyp', latin1('crx '), u32(1), latin1('crx isom'));
  const thmb = box('uuid', Buffer.from('85c0b687820f11e08111f4ce462b6a48', 'hex'), box('THMB', u32(0, 0), thumb));
  const moovFor = (offset) => box('moov', thmb, box('trak',
    fullBox('tkhd', 0, u32(0, 0, 1, 0, 0), Buffer.alloc(52), u32(6000 << 16, 4000 << 16)),
    box('mdia',
      fullBox('hdlr', 0, u32(0), latin1('vide'), Buffer.alloc(12), latin1('\0')),
      box('minf', box('stbl',
        fullBox('stsd', 0, u32(1), box('CRAW', Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(6000, 4000), Buffer.alloc(50))),
        fullBox('stsc', 0, u32(1, 1, 1, 1)),
        fullBox('stsz', 0, u32(0, 1, full.length)),
        fullBox('stco', 0, u32(1, offset)))))));
  const prvw = box('uuid', Buffer.from('eaf42b5e1c984b88b9fbb7dc406e4d16', 'hex'), u32(0, 1), box('PRVW', u32(0), small));
  const head = ftyp.length + moovFor(0).length + prvw.length;
  const pad = (512 - ((head + 8 + 8) % 512)) % 512;
  const free = box('free', Buffer.alloc(pad));
  const offset = head + free.length + 8;
  return Buffer.concat([ftyp, moovFor(offset), prvw, free, box('mdat', full)]);
}

/** A HEIC: one HEVC item (NAL units with 4-byte lengths) and an Exif item, as phones write them. */
function makeHeic({ seed = 1, width = 64, height = 48, time = '2023:03:04 05:06:07', offset = '+09:00' } = {}) {
  const rand = rng(seed);
  const nal = (type, n) => {
    const b = Buffer.alloc(4 + n);
    b.writeUInt32BE(n, 0);
    b[4] = type << 1;
    b[5] = 1;
    for (let i = 6; i < b.length; i++) b[i] = Math.floor(rand() * 256);
    return b;
  };
  const image = Buffer.concat([nal(19, 1500), nal(1, 800)]);
  const exif = Buffer.concat([u32(6), latin1('Exif\0\0'), exifTiff({ time, offset })]);
  const hvcC = Buffer.alloc(23);
  hvcC[0] = 1;
  hvcC[21] = 0xf3;
  const meta = (off1, off2) => fullBox('meta', 0,
    fullBox('hdlr', 0, u32(0), latin1('pict'), Buffer.alloc(12), Buffer.from([0])),
    fullBox('pitm', 0, u16(1)),
    fullBox('iloc', 0, Buffer.from([0x44, 0x00]), u16(2), u16(1, 0, 1), u32(off1, image.length), u16(2, 0, 1), u32(off2, exif.length)),
    fullBox('iinf', 0, u16(2), fullBox('infe', 2, u16(1, 0), latin1('hvc1\0')), fullBox('infe', 2, u16(2, 0), latin1('Exif\0'))),
    box('iprp', box('ipco', box('hvcC', hvcC), fullBox('ispe', 0, u32(width, height))),
      fullBox('ipma', 0, u32(1), u16(1), Buffer.from([2, 0x81, 0x02]))));
  const ftyp = box('ftyp', latin1('heic'), u32(0), latin1('mif1heic'));
  const at = ftyp.length + meta(0, 0).length + 8;
  return Buffer.concat([ftyp, meta(at, at + image.length), box('mdat', image, exif)]);
}

const ASF = {
  header: '3026b2758e66cf11a6d900aa0062ce6c', data: '3626b2758e66cf11a6d900aa0062ce6c',
  fileProps: 'a1dcab8c47a9cf118ee400c00c205365', streamProps: '9107dcb7b7a9cf118ee600c00c205365',
  video: 'c0ef19bc4d5bcf11a8fd00805f5c442b', audio: '409e69f84d5bcf11a8fd00805f5c442b',
  simpleIndex: '90080033b1e5cf1189f400a0c90349cb',
};

/** A WMV (or WMA): header with file and stream properties, fixed-size data packets, a simple index. */
function makeAsf({ seed = 1, packets = 20, packetSize = 256, created = Date.UTC(2004, 1, 28, 9, 23, 50), video = true, width = 320, height = 240 } = {}) {
  const obj = (g, ...parts) => {
    const body = Buffer.concat(parts);
    const h = Buffer.alloc(24);
    Buffer.from(g, 'hex').copy(h);
    h.writeBigUInt64LE(BigInt(24 + body.length), 16);
    return Buffer.concat([h, body]);
  };
  const build = (total) => {
    const fp = Buffer.alloc(80);
    fp.writeBigUInt64LE(BigInt(total), 16);
    fp.writeBigUInt64LE((BigInt(created) + 11644473600000n) * 10000n, 24);
    fp.writeBigUInt64LE(BigInt(packets), 32);
    fp.writeBigUInt64LE(50000000n, 40);
    fp.writeBigUInt64LE(3000n, 56);
    fp.writeUInt32LE(2, 64);
    fp.writeUInt32LE(packetSize, 68);
    fp.writeUInt32LE(packetSize, 72);
    const sp = Buffer.alloc(54 + 11 + 40);
    Buffer.from(video ? ASF.video : ASF.audio, 'hex').copy(sp, 0);
    sp.writeUInt32LE(11 + 40, 40);
    sp.writeUInt32LE(width, 54);
    sp.writeUInt32LE(height, 58);
    const header = obj(ASF.header, le32(2), Buffer.from([1, 2]), obj(ASF.fileProps, fp), obj(ASF.streamProps, sp));
    const rows = [];
    for (let i = 0; i < packets; i++) {
      const p = randomBytes(packetSize, seed * 1000 + i);
      p[0] = 0x82;
      p[1] = 0;
      p[2] = 0;
      rows.push(p);
    }
    const count = Buffer.alloc(8);
    count.writeBigUInt64LE(BigInt(packets));
    const data = obj(ASF.data, Buffer.alloc(16), count, Buffer.from([1, 1]), ...rows);
    const index = obj(ASF.simpleIndex, Buffer.alloc(16), Buffer.alloc(8), le32(0), le32(0));
    return Buffer.concat([header, data, index]);
  };
  return build(build(0).length);
}

/**
 * A camera RAW as Nikon and others write one: IFD0 holding the maker and a JPEG preview, a
 * SubIFD with the sensor data, and the Exif IFD. The preview starts at `previewAt`, a sector
 * boundary, where a carve meets it.
 */
function makeRaw({ seed = 1, make = 'NIKON CORPORATION', preview, previewAt = 1024, rawSize = 20000, time = '2019:05:02 10:00:00' } = {}) {
  const T = new TiffBuilder();
  T.push(Buffer.alloc(previewAt - T.size));
  const pv = T.put(preview);
  const raw = T.put(randomBytes(rawSize, seed));
  const exifIfd = T.ifd([[0x9003, 2, time]]);
  const sub = T.ifd([[0x0100, 4, [4000]], [0x0101, 4, [3000]], [0x0103, 3, [1]], [0x0106, 3, [32803]], [0x0111, 4, [raw]], [0x0117, 4, [rawSize]]]);
  const ifd0 = T.ifd([[0x0100, 4, [160]], [0x0101, 4, [120]], [0x0103, 3, [6]], [0x010f, 2, make], [0x0201, 4, [pv]],
    [0x0202, 4, [preview.length]], [0x014a, 4, [sub]], [0x8769, 4, [exifIfd]]]);
  return T.done(ifd0);
}

/** A one-page PDF whose picture is a JPEG stream, put on an `align` boundary by a comment line. */
function makePdf({ jpeg, width = 64, height = 48, align = 512 } = {}) {
  const parts = [];
  let size = 0;
  const push = (b) => {
    const buf = typeof b === 'string' ? latin1(b) : b;
    parts.push(buf);
    size += buf.length;
  };
  const offsets = [];
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  offsets[1] = size;
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  offsets[2] = size;
  push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  offsets[3] = size;
  push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);
  const head = `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`;
  let pad = (align - ((size + head.length) % align)) % align;
  if (pad && pad < 2) pad += align;
  if (pad) push('%' + ' '.repeat(pad - 2) + '\n');
  offsets[4] = size;
  push(head);
  push(jpeg);
  push('\nendstream\nendobj\n');
  const content = `q ${width} 0 0 ${height} 0 0 cm /Im1 Do Q`;
  offsets[5] = size;
  push(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  const xref = size;
  push('xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join(''));
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

const DOS_TIME = ((2023 - 1980) << 25) | (6 << 21) | (1 << 16) | (12 << 11);

/**
 * A ZIP of `members` ({ name, data, deflate, descriptor, align }): a member with `align` has its
 * data put on that boundary by an extra field, one with `descriptor` has its sizes after its data.
 */
function makeZip(members) {
  const locals = [];
  const central = [];
  let pos = 0;
  for (const m of members) {
    const comp = m.deflate ? zlib.deflateRawSync(m.data) : m.data;
    const crc = I.crc32(m.data);
    const name = Buffer.from(m.name, 'utf8');
    let extra = Buffer.alloc(0);
    if (m.align) {
      let gap = (m.align - ((pos + 30 + name.length) % m.align)) % m.align;
      if (gap && gap < 4) gap += m.align;
      if (gap) {
        extra = Buffer.alloc(gap);
        extra.writeUInt16LE(0xcafe, 0);
        extra.writeUInt16LE(gap - 4, 2);
      }
    }
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(m.descriptor ? 8 : 0, 6);
    h.writeUInt16LE(m.deflate ? 8 : 0, 8);
    h.writeUInt32LE(DOS_TIME, 10);
    if (!m.descriptor) {
      h.writeUInt32LE(crc, 14);
      h.writeUInt32LE(comp.length, 18);
      h.writeUInt32LE(m.data.length, 22);
    }
    h.writeUInt16LE(name.length, 26);
    h.writeUInt16LE(extra.length, 28);
    const desc = m.descriptor ? Buffer.concat([le32(0x08074b50), le32(crc), le32(comp.length), le32(m.data.length)]) : Buffer.alloc(0);
    locals.push(h, name, extra, comp, desc);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(m.descriptor ? 8 : 0, 8);
    c.writeUInt16LE(m.deflate ? 8 : 0, 10);
    c.writeUInt32LE(DOS_TIME, 12);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(m.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(pos, 42);
    central.push(c, name);
    pos += 30 + name.length + extra.length + comp.length + desc.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(pos, 16);
  return Buffer.concat([...locals, cd, end]);
}

const docx = (picture) => makeZip([
  { name: '[Content_Types].xml', data: latin1('<?xml version="1.0"?><Types/>'), deflate: true },
  { name: 'word/document.xml', data: latin1('<w:document>' + 'text '.repeat(200) + '</w:document>'), deflate: true },
  { name: 'word/media/image1.png', data: picture, align: 512 },
]);

/** A disk: `files` as [offset, bytes] on free space of zeros, or of old random data. */
function disk(size, files, { fill = 'zero', seed = 7 } = {}) {
  const d = fill === 'random' ? randomBytes(size, seed) : Buffer.alloc(size);
  const taken = [];
  for (const [at, buf] of files) {
    assert.ok(at + buf.length <= size, `a file at ${at} does not fit`);
    assert.ok(!taken.some(([a, z]) => at < z && a < at + buf.length), `files overlap at ${at}`);
    taken.push([at, at + buf.length]);
    buf.copy(d, at);
  }
  return d;
}

const S = 512;
const MIB = 1024 * 1024;

/** A reader that counts the bytes read through it. */
function counting(reader) {
  const c = {
    size: reader.size,
    bytes: 0,
    read(off, len) {
      const b = reader.read(off, len);
      c.bytes += b.length;
      return b;
    },
  };
  return c;
}

/** A reader over `buf` whose bytes in [bad, bad + 4096) cannot be read, as a bad sector cannot. */
function withBadSector(buf, bad) {
  const inner = memoryReader(buf);
  const check = (off, len) => {
    if (off < bad + 4096 && off + len > bad) throw Object.assign(new Error('i/o error'), { code: 'EIO' });
  };
  return {
    size: inner.size,
    read(off, len) {
      check(off, len);
      return inner.read(off, len);
    },
    async readAsync(off, len) {
      check(off, len);
      return inner.read(off, len);
    },
  };
}

/** The flags of judge(), without its reasons. */
const flags = ({ reasons, ...rest }) => rest;

// ---------------------------------------------------------------- tests

test('CRC-32 is the standard one, with or without zlib', () => {
  assert.strictEqual(I.crc32Table(latin1('123456789')), 0xcbf43926);
  const data = randomBytes(5000, 3);
  assert.strictEqual(I.crc32(data), I.crc32Table(data));
  assert.strictEqual(I.crc32(data.subarray(100), I.crc32(data.subarray(0, 100))), I.crc32(data));
});

test('times are read as each format defines them', () => {
  assert.deepStrictEqual(I.exifTime('2024:08:01 09:10:11', '+09:00'), { ms: Date.UTC(2024, 7, 1, 0, 10, 11), zone: true });
  assert.deepStrictEqual(I.exifTime('2024:08:01 09:10:11', null), { ms: new Date(2024, 7, 1, 9, 10, 11).getTime(), zone: false });
  assert.strictEqual(I.exifTime('0000:00:00 00:00:00'), null, 'the "not set" Exif writes');
  assert.strictEqual(I.exifTime('2023:02:30 10:00:00'), null, 'a day that does not exist');
  assert.strictEqual(I.iditTime('SUN SEP 05 09:32:43 2004\n'), new Date(2004, 8, 5, 9, 32, 43).getTime());
  assert.strictEqual(I.macTime(Math.floor(Date.UTC(2025, 4, 17, 10, 20, 30) / 1000) + 2082844800), Date.UTC(2025, 4, 17, 10, 20, 30));
  assert.strictEqual(I.macTime(0), null, 'QuickTime writes 0 for "not set"');
  assert.strictEqual(I.macTime(100), null, '1904 is not a time a video was made');
});

test('a JPEG is walked marker by marker, and every MCU of its scan decoded', () => {
  const thumb = makeJpeg({ seed: 9, width: 16, height: 16, app: false });
  for (const o of [{ width: 64, height: 48 }, { width: 100, height: 75, color: true }, { width: 120, height: 90, color: true, restart: 4 }]) {
    const j = makeJpeg({ seed: 3, ...o, exif: { time: '2024:08:01 09:10:11', offset: '+09:00', thumb } });
    const h = validate(memoryReader(j), 0);
    assert.ok(h.complete, h.problems.join('; '));
    assert.strictEqual(h.length, j.length);
    assert.strictEqual(h.type, 'jpeg');
    assert.strictEqual(h.ext, '.jpg');
    assert.strictEqual(h.mediaType, 'image');
    assert.deepStrictEqual([h.width, h.height], [o.width, o.height]);
    const mcus = o.color ? Math.ceil(o.width / 16) * Math.ceil(o.height / 16) : Math.ceil(o.width / 8) * Math.ceil(o.height / 8);
    assert.ok(h.checks.includes(`scan 1: all ${mcus} MCUs decode`), h.checks.join('; '));
    if (o.restart) assert.ok(h.checks.some((c) => /restart markers in turn/.test(c)));
    assert.strictEqual(h.time, Date.UTC(2024, 7, 1, 0, 10, 11), '09:10:11 at +09:00');
    assert.match(h.timeFrom, /Exif/);
    assert.strictEqual(h.info.make, 'Test Camera');
    assert.deepStrictEqual([h.info.thumbnail.width, h.info.thumbnail.height], [16, 16]);
    assert.strictEqual(h.selfChecked, false, 'JPEG has no checksum');
    assert.strictEqual(h.embedded, null);
    assert.deepStrictEqual(h.previews, [], 'a whole photo offers no smaller copy');
    assert.ok(h.tail, 'what a carve loses after EOI is said');
  }
});

test('a JPEG cut short, pieced together or written over is caught', () => {
  const j = makeJpeg({ seed: 7, width: 256, height: 192, color: true });
  const whole = validate(memoryReader(j), 0);
  assert.ok(whole.complete);

  const cut = j.subarray(0, Math.floor(j.length * 0.6));
  let h = validate(memoryReader(cut), 0);
  assert.ok(!h.complete && h.usable);
  assert.match(h.problems.join('; '), /runs past the end/);
  assert.strictEqual(h.length, cut.length);

  // Cut short, then space that was wiped: the carve stops where the data does.
  h = validate(memoryReader(Buffer.concat([cut, Buffer.alloc(64 * 1024)])), 0);
  assert.ok(h.length <= cut.length && h.length > cut.length - 16, `${h.length} of ${cut.length}`);

  // A 512-byte piece of another photo, or of anything, where the file went on elsewhere.
  for (const piece of [makeJpeg({ seed: 8, width: 256, height: 192, color: true }).subarray(2048, 2560), randomBytes(512, 5)]) {
    const spliced = Buffer.from(j);
    piece.copy(spliced, 2048);
    h = validate(memoryReader(spliced), 0);
    assert.ok(!h.complete, 'caught');
    assert.match(h.problems.join('; '), /scan 1: .+ after \d+ of 192 MCUs|unexpected marker|no marker/);
  }

  // A header byte damaged, as DFTT #11's haxor2.jpg has it: a DQT of length 0.
  const bad = Buffer.from(j);
  const dqt = bad.indexOf(Buffer.from([0xff, 0xdb]));
  bad.writeUInt16BE(0, dqt + 2);
  h = validate(memoryReader(bad), 0);
  assert.strictEqual(h.usable, false);
  assert.match(h.problems[0], /impossible length/);
});

test('the images MPF lists and a motion photo\'s video belong to the JPEG before them', () => {
  const second = makeJpeg({ seed: 4, width: 64, height: 64 });
  const m = makeJpeg({ seed: 5, width: 128, height: 64, mpf: second });
  let h = validate(memoryReader(m), 0);
  assert.ok(h.complete, h.problems.join('; '));
  assert.strictEqual(h.length, m.length, 'MPF carries the file past the first EOI');
  assert.ok(h.checks.some((c) => /Multi-Picture Format: all 1 further/.test(c)));
  // The second image missing: the file is not whole.
  h = validate(memoryReader(Buffer.concat([m.subarray(0, m.length - second.length), Buffer.alloc(4096)])), 0);
  assert.ok(!h.complete);
  assert.match(h.problems.join('; '), /Multi-Picture index lists an image/);

  const photo = makeJpeg({ seed: 6, width: 64, height: 48, exif: {} });
  const video = makeMp4({ seed: 6, samples: 5 });
  h = validate(memoryReader(Buffer.concat([photo, video, Buffer.alloc(1024)])), 0);
  assert.ok(h.complete, h.problems.join('; '));
  assert.strictEqual(h.length, photo.length + video.length);
  assert.deepStrictEqual(h.info.motionPhoto, { offset: photo.length, length: video.length });
});

test('PNG: every chunk\'s CRC and the rows\' size; a carve ends at IEND', () => {
  for (const o of [{}, { color: 2, width: 33, height: 7 }, { color: 6, interlace: 1, width: 37, height: 21 }]) {
    const p = makePng({ seed: 2, ...o });
    const h = validate(memoryReader(Buffer.concat([p, randomBytes(700, 1)])), 0);
    assert.ok(h.complete && h.selfChecked, h.problems.join('; '));
    assert.strictEqual(h.length, p.length, 'what follows IEND is not taken');
    assert.match(h.tail, /IEND/);
  }
  const timed = validate(memoryReader(makePng({ time: [2021, 6, 7, 8, 9, 10] })), 0);
  assert.strictEqual(timed.time, Date.UTC(2021, 5, 7, 8, 9, 10));

  const p = makePng({ seed: 3, width: 64, height: 64 });
  let h = validate(memoryReader(p.subarray(0, 2000)), 0);
  assert.ok(!h.complete && h.usable, 'cut short, but its first rows are there');
  const spliced = Buffer.from(p);
  randomBytes(300, 9).copy(spliced, 1500);
  h = validate(memoryReader(spliced), 0);
  assert.ok(!h.complete);
  assert.match(h.problems[0], /CRC-32 of chunk IDAT/);
  assert.ok(h.length < 1500, 'taken only up to the chunk that failed');
});

test('GIF: every frame\'s LZW data decodes to its pixels', () => {
  const g = makeGif({ seed: 4, width: 50, height: 40, frames: 3 });
  const h = validate(memoryReader(Buffer.concat([g, Buffer.alloc(100)])), 0);
  assert.ok(h.complete, h.problems.join('; '));
  assert.strictEqual(h.length, g.length);
  assert.deepStrictEqual([h.width, h.height, h.info.frames], [50, 40, 3]);
  assert.ok(h.checks.some((c) => /LZW data decodes/.test(c)));

  const spliced = Buffer.from(g);
  randomBytes(200, 2).copy(spliced, 700);
  assert.ok(!validate(memoryReader(spliced), 0).complete);
  // Cut inside its first frame: what is there still shows the first rows, and says how many pixels.
  const cut = validate(memoryReader(g.subarray(0, 900)), 0);
  assert.ok(!cut.complete && cut.usable);
  assert.strictEqual(cut.length, 900);
  assert.ok(cut.checks.some((c) => /^image 1: its first \d+ of 2000 pixels decode, up to where its data stops$/.test(c)), cut.checks.join('; '));
  assert.strictEqual(validate(memoryReader(g.subarray(0, 800)), 0).usable, true);
  assert.strictEqual(validate(memoryReader(g.subarray(0, 40)), 0).usable, false, 'nothing of an image is there yet');
});

test('BMP by its header, WebP and WAV by their chunks', () => {
  const b = makeBmp({ width: 30, height: 20 });
  let h = validate(memoryReader(Buffer.concat([b, randomBytes(100, 1)])), 0);
  assert.ok(h.complete);
  assert.deepStrictEqual([h.type, h.length, h.width, h.height], ['bmp', b.length, 30, 20]);
  const bad = Buffer.from(b);
  bad.writeUInt32LE(100, 2);
  assert.strictEqual(validate(memoryReader(bad), 0), null, 'a size too small for its rows is no BMP');

  const w = makeWebp({ width: 40, height: 30, exif: { time: '2022:01:02 03:04:05' } });
  h = validate(memoryReader(w), 0);
  assert.ok(h.complete, h.problems.join('; '));
  assert.deepStrictEqual([h.type, h.ext, h.length, h.width, h.height], ['webp', '.webp', w.length, 40, 30]);
  assert.strictEqual(h.time, new Date(2022, 0, 2, 3, 4, 5).getTime());

  const s = makeWav({ samples: 16000 });
  h = validate(memoryReader(s), 0);
  assert.ok(h.complete);
  assert.deepStrictEqual([h.type, h.mediaType, h.length, h.info.seconds], ['wav', 'audio', s.length, 2]);
  h = validate(memoryReader(s.subarray(0, 40)), 0);
  assert.strictEqual(h.usable, false, 'the sound itself is gone');
});

test('AVI: its chunks tile down to every list; its Motion JPEG frames are not photos', async () => {
  const a = makeAvi({ frames: 4 });
  const h = validate(memoryReader(a), 0);
  assert.ok(h.complete, h.problems.join('; '));
  assert.deepStrictEqual([h.type, h.mediaType, h.length, h.width, h.height, h.info.codec], ['avi', 'video', a.length, 32, 16, 'MJPG']);
  assert.strictEqual(h.time, new Date(2004, 8, 5, 9, 32, 43).getTime());

  // Each frame starts on a sector, where a carve meets it: the AVI is listed, its frames are not.
  let r = await scan(memoryReader(disk(64 * S, [[4 * S, a]])));
  assert.deepStrictEqual(r.found.map((f) => [f.offset, f.type]), [[4 * S, 'avi']]);
  assert.strictEqual(r.counts.frames, 4);
  assert.ok(r.notes.some((n) => /4 Motion JPEG video frame/.test(n)));

  // With the AVI's header written over, its frames still show what they are.
  const headless = Buffer.from(a);
  headless.fill(0, 0, 512);
  r = await scan(memoryReader(disk(64 * S, [[4 * S, headless]])));
  assert.deepStrictEqual(r.found, []);
  assert.strictEqual(r.counts.frames, 4, 'APP0 "AVI1"');
  const noTables = makeAvi({ frames: 2, avi1: false });
  const bare = Buffer.from(noTables);
  bare.fill(0, 0, 512);
  const framesWithoutTables = makeJpeg({ seed: 11, width: 32, height: 16, app: false, dht: false });
  r = await scan(memoryReader(disk(64 * S, [[4 * S, framesWithoutTables]])));
  assert.deepStrictEqual(r.found, []);
  assert.strictEqual(r.counts.frames, 1, 'no Huffman tables of its own: a Motion JPEG frame');

  // Cut short: what is there is listed, and says so.
  const cut = validate(memoryReader(a.subarray(0, a.length - 700)), 0);
  assert.ok(!cut.complete && cut.usable);
});

test('MP4, MOV and 3GP: box sizes, moov and mdat, every sample inside mdat and its NAL units tiling it', () => {
  const v = makeMp4({ seed: 9 });
  let h = validate(memoryReader(Buffer.concat([v, Buffer.alloc(2048)])), 0);
  assert.ok(h.complete, h.problems.join('; '));
  assert.deepStrictEqual([h.type, h.ext, h.mediaType, h.length, h.width, h.height], ['mp4', '.mp4', 'video', v.length, 640, 480]);
  assert.strictEqual(h.time, Date.UTC(2025, 4, 17, 10, 20, 30));
  assert.ok(h.checks.some((c) => /all 30 video samples checked/.test(c)), h.checks.join('; '));
  assert.strictEqual(h.tail, null, 'a movie ends where its last box does');

  assert.deepStrictEqual(['3gp4', 'qt  ', 'M4V '].map((brand) => validate(memoryReader(makeMp4({ brand })), 0).ext), ['.3gp', '.mov', '.m4v']);

  const spliced = Buffer.from(v);
  randomBytes(512, 4).copy(spliced, 4096);
  h = validate(memoryReader(spliced), 0);
  assert.ok(!h.complete);
  assert.match(h.problems.join('; '), /video sample\(s\) are not what their track says/);

  h = validate(memoryReader(makeMp4({ moov: false })), 0);
  assert.ok(!h.complete && h.usable);
  assert.match(h.problems[0], /no moov box/);
  h = validate(memoryReader(makeMp4({ moov: false, openMdat: true })), 0);
  assert.match(h.problems.join('; '), /"to the end of the file"/);
  h = validate(memoryReader(v.subarray(0, 20000)), 0);
  assert.match(h.problems.join('; '), /mdat box runs past the end/);

  const mjpeg = makeMp4({ codec: 'jpeg', brand: 'qt  ', samples: 4 });
  h = validate(memoryReader(mjpeg), 0);
  assert.ok(h.complete, h.problems.join('; '));
  assert.ok(h.checks.some((c) => /all 4 video samples checked/.test(c)));
});

test('HEIC: every item extent inside the file, and its coded item tiling into NAL units', () => {
  const p = makeHeic({ width: 64, height: 48 });
  let h = validate(memoryReader(p), 0);
  assert.ok(h.complete, h.problems.join('; '));
  assert.deepStrictEqual([h.type, h.ext, h.mediaType, h.length, h.width, h.height], ['heif', '.heic', 'image', p.length, 64, 48]);
  assert.strictEqual(h.time, Date.UTC(2023, 2, 3, 20, 6, 7), '05:06:07 at +09:00');
  assert.ok(h.checks.some((c) => /all 1 coded items tile/.test(c)));
  h = validate(memoryReader(p.subarray(0, p.length - 500)), 0);
  assert.ok(!h.complete);
  // A foreign piece across the boundary of two NAL units breaks their lengths. One wholly inside a
  // NAL unit's data does not, and the caveat says that it would not.
  const data = p.indexOf(latin1('mdat')) + 4;
  assert.strictEqual(p.readUInt32BE(data + 1504), 800, 'the second NAL unit\'s length');
  const across = Buffer.from(p);
  randomBytes(300, 6).copy(across, data + 1400);
  h = validate(memoryReader(across), 0);
  assert.ok(!h.complete);
  assert.match(h.problems.join('; '), /1 of 1 coded items are not what their type says/);
  const inside = Buffer.from(p);
  randomBytes(300, 6).copy(inside, data + 200);
  h = validate(memoryReader(inside), 0);
  assert.ok(h.complete);
  assert.ok(h.caveats.some((c) => /not decoded, so a foreign piece lying wholly inside one/.test(c)), h.caveats.join('; '));
});

test('WMV and WMA: objects end at the size the header records, and every packet is in place', () => {
  const w = makeAsf({ packets: 30 });
  let h = validate(memoryReader(Buffer.concat([w, randomBytes(512, 3)])), 0);
  assert.ok(h.complete, h.problems.join('; '));
  assert.deepStrictEqual([h.type, h.ext, h.length, h.width, h.height], ['wmv', '.wmv', w.length, 320, 240]);
  assert.strictEqual(h.time, Date.UTC(2004, 1, 28, 9, 23, 50));
  assert.ok(h.checks.some((c) => /all 30 data packets/.test(c)));
  assert.strictEqual(validate(memoryReader(makeAsf({ video: false })), 0).ext, '.wma');

  const spliced = Buffer.from(w);
  randomBytes(600, 8).copy(spliced, w.length - 2000);
  h = validate(memoryReader(spliced), 0);
  assert.ok(!h.complete);
  assert.match(h.problems.join('; '), /packet \d+ of 30/);
  h = validate(memoryReader(w.subarray(0, w.length - 1000)), 0);
  assert.ok(!h.complete);
});

test('a camera RAW is listed with its preview as a smaller copy; the preview is not a photo of its own', async () => {
  const preview = makeJpeg({ seed: 21, width: 160, height: 120, app: false });
  const raw = makeRaw({ preview, previewAt: 1024 });
  const h = validate(memoryReader(raw), 0);
  assert.ok(h.complete, h.problems.join('; '));
  assert.deepStrictEqual([h.type, h.ext, h.mediaType, h.length, h.width, h.height], ['tiff', '.nef', 'image', raw.length, 4000, 3000]);
  assert.strictEqual(h.time, new Date(2019, 4, 2, 10, 0, 0).getTime());
  assert.strictEqual(h.previews.length, 1);
  assert.deepStrictEqual([h.previews[0].offset, h.previews[0].length, h.previews[0].derived], [1024, preview.length, true]);
  assert.deepStrictEqual(['SONY', 'PENTAX', 'Canon'].map((make) => validate(memoryReader(makeRaw({ make, preview })), 0).ext),
    ['.arw', '.pef', '.tif']);

  const r = await scan(memoryReader(disk(96 * S, [[8 * S, raw]])));
  assert.deepStrictEqual(r.found.map((f) => [f.offset, f.type, f.derived]), [[8 * S, 'tiff', false], [8 * S + 1024, 'jpeg', true]]);
  assert.deepStrictEqual(r.found[1].parent, { type: 'tiff', offset: 8 * S });
  assert.strictEqual(r.counts.previews, 1, 'met again on its own sector, and not listed twice');
  assert.ok(judge(r.found[1]).derived);
});

test('JPEGs made to live inside other files are not taken for photos', async () => {
  const lossless = makeJpeg({ seed: 30, sof: 0xc3 });
  const bare = makeJpeg({ seed: 31, app: false });
  const photo = makeJpeg({ seed: 32 });
  const pdf = makePdf({ jpeg: makeJpeg({ seed: 33 }) });
  const at = pdf.indexOf(latin1('stream\n')) + 7;
  assert.strictEqual(at % S, 0, 'the PDF\'s picture lies on a sector');
  const r = await scan(memoryReader(disk(128 * S, [[4 * S, lossless], [16 * S, bare], [28 * S, photo], [40 * S, pdf]])));
  assert.deepStrictEqual(r.found.map((f) => [f.offset, f.type]), [[16 * S, 'jpeg'], [28 * S, 'jpeg'], [40 * S, 'pdf'], [40 * S + at, 'jpeg']]);
  assert.strictEqual(r.counts.raw, 1, 'a lossless JPEG is a RAW\'s sensor data');
  const [noApp, real, doc, inPdf] = r.found;
  assert.match(noApp.embedded, /none of the header segments/);
  assert.strictEqual(real.embedded, null);
  assert.match(inPdf.embedded, /image stream of a PDF/);
  assert.ok(inPdf.caveats.some((c) => c.includes(`PDF found at ${40 * S}`)));
  assert.deepStrictEqual([doc.mediaType, doc.length], ['document', pdf.length]);
  assert.ok(judge(noApp).derived && judge(inPdf).derived && !judge(real).derived);
  // Found by a file system under its own name, a JPEG without APP segments is simply that file.
  assert.ok(!judge(noApp, { size: noApp.length }).derived);

  // Progressive and arithmetic scans are followed, not decoded, and say so.
  const progressive = validate(memoryReader(makeJpeg({ seed: 34, sof: 0xc2 })), 0);
  assert.ok(progressive.complete);
  assert.ok(progressive.caveats.some((c) => /not decoded \(progressive coding\)/.test(c)));
});

test('ZIP and the documents built on it: CRC-checked, and what lies inside is part of them', async () => {
  const picture = makePng({ seed: 40, width: 20, height: 20 });
  const d = docx(picture);
  const h = validate(memoryReader(d), 0);
  assert.ok(h.complete && h.selfChecked, h.problems.join('; '));
  assert.deepStrictEqual([h.type, h.ext, h.mediaType, h.length], ['zip', '.docx', 'document', d.length]);
  assert.ok(h.checks.includes('3 of 3 members match their CRC-32'));
  assert.strictEqual(h.time, new Date(2023, 5, 1, 12, 0, 0).getTime());

  const r = await scan(memoryReader(disk(64 * S, [[4 * S, d]])));
  assert.deepStrictEqual(r.found.map((f) => [f.offset, f.ext]), [[4 * S, '.docx']], 'its picture is part of it');
  const pictures = await scan(memoryReader(disk(64 * S, [[4 * S, d]])), { types: ['image'] });
  assert.deepStrictEqual(pictures.found, [], 'not listed when only pictures are asked for, and its picture not either');

  const later = makeZip([{ name: 'a.txt', data: latin1('x'.repeat(3000)), deflate: true, descriptor: true },
    { name: 'b.bin', data: randomBytes(1000, 1) }]);
  const z = validate(memoryReader(Buffer.concat([later, randomBytes(5000, 2)])), 0);
  assert.ok(z.complete && z.selfChecked, z.problems.join('; '));
  assert.deepStrictEqual([z.ext, z.mediaType, z.length], ['.zip', 'archive', later.length], 'sizes after the data: the end record is looked for');
  const broken = Buffer.from(d);
  broken[d.indexOf(latin1('word/document.xml')) + 40] ^= 0xff;
  assert.ok(!validate(memoryReader(broken), 0).complete);
});

test('one image holding whole, cut, pieced-together and embedded files', async () => {
  const thumb = makeJpeg({ seed: 50, width: 16, height: 16, app: false });
  const a = makeJpeg({ seed: 51, width: 200, height: 150, color: true, exif: { time: '2020:02:02 02:02:02', thumb } });
  const p = makePng({ seed: 52, width: 48, height: 40, color: 2 });
  const b = makeJpeg({ seed: 53, width: 200, height: 150, color: true, exif: { thumb } });
  const c = makeJpeg({ seed: 54, width: 512, height: 384 });
  const dj = makeJpeg({ seed: 55, width: 64, height: 64 });
  const g = makeGif({ seed: 56, width: 30, height: 30, frames: 2 });
  const v = makeMp4({ seed: 57, samples: 12 });
  const raw = makeRaw({ preview: makeJpeg({ seed: 58, width: 160, height: 120, app: false }) });
  const avi = makeAvi({ seed: 59, frames: 3 });
  const doc = docx(makePng({ seed: 60, width: 16, height: 16 }));
  const pdf = makePdf({ jpeg: makeJpeg({ seed: 61 }) });
  const files = [
    [16 * S, a],
    [200 * S, p],
    [400 * S, b.subarray(0, Math.floor(b.length * 0.6))], // written over after 60%
    [600 * S, c.subarray(0, 4096)], // stored in two pieces with another file between
    [608 * S, dj],
    [900 * S, c.subarray(4096)],
    [1000 * S, g],
    [1100 * S, v],
    [2000 * S, raw],
    [3000 * S, avi],
    [4000 * S, doc],
    [5000 * S, pdf],
  ];
  const image = disk(12 * 1024 * 1024, files, { fill: 'random', seed: 99 });
  const r = await scan(memoryReader(image));
  const rows = r.found.map((f) => [f.offset / S, f.ext, f.complete, f.derived]);
  const pdfAt = (5000 * S + pdf.indexOf(latin1('stream\n')) + 7) / S;
  assert.deepStrictEqual(rows, [
    [16, '.jpg', true, false],
    [200, '.png', true, false],
    [400, '.jpg', false, false],
    [400 + b.indexOf(thumb) / S, '.jpg', true, true],
    [600, '.jpg', false, false],
    [608, '.jpg', true, false],
    [1000, '.gif', true, false],
    [1100, '.mp4', true, false],
    [2000, '.nef', true, false],
    [2002, '.jpg', true, true],
    [3000, '.avi', true, false],
    [4000, '.docx', true, false],
    [5000, '.pdf', true, false],
    [pdfAt, '.jpg', true, false],
  ]);
  const byOffset = (s) => r.found.filter((f) => f.offset === s * S);
  // The photo written over: listed as it is, and its thumbnail offered as a smaller copy.
  const [damaged] = byOffset(400);
  const small = r.found.find((f) => f.offset === 400 * S + b.indexOf(thumb));
  assert.ok(damaged.problems.length);
  assert.deepStrictEqual(small.parent, { type: 'jpeg', offset: 400 * S });
  assert.deepStrictEqual([small.width, small.height, small.length], [16, 16, thumb.length]);
  // The file in two pieces: its first piece, ending where the other file begins.
  const [first] = byOffset(600);
  assert.strictEqual(first.length, 8 * S);
  assert.match(first.problems.join('; '), /another image starts at \+4096/);
  // Every whole one is its file to the byte.
  for (const [at, buf] of files) {
    const hit = r.found.find((f) => f.offset === at && f.complete && !f.derived);
    if (hit) assert.strictEqual(md5(image.subarray(at, at + hit.length)), md5(buf), `at sector ${at / S}`);
  }
  assert.strictEqual(r.counts.frames, 3);
  assert.strictEqual(r.counts.previews, 1);
  assert.strictEqual(r.scanned, image.length);
  assert.strictEqual(r.next, null);

  const pictures = await scan(memoryReader(image), { types: ['video'] });
  assert.deepStrictEqual(pictures.found.map((f) => f.ext), ['.mp4', '.avi']);
});

test('a JPEG that runs into erased or zeroed space stops there, says how much decodes, and reads little', () => {
  const j = makeJpeg({ seed: 70, width: 256, height: 192, color: true });
  let cutAt = 2000;
  while (j[cutAt - 1] === 0 || j[cutAt - 1] === 0xff) cutAt++;
  // Many cards read erased flash back as 0xFF; zeroed space reads as zeros. Either way the search
  // for the end of the data stops within a mebibyte or two, however much of it follows.
  for (const fill of [0xff, 0x00]) {
    const r = counting(memoryReader(Buffer.concat([j.subarray(0, cutAt), Buffer.alloc(32 * MIB, fill)])));
    const h = validate(r, 0);
    assert.ok(!h.complete && h.usable);
    assert.strictEqual(h.length, cutAt);
    assert.match(h.problems.join('; '), new RegExp(`its data stops at \\+${cutAt}, where the space after it was erased`));
    assert.ok(h.checks.some((c) => /^scan 1: its first \d+ of 192 MCUs decode, up to where its data stops$/.test(c)), h.checks.join('; '));
    assert.ok(h.info.decodedMcus > 0 && h.info.decodedMcus < 192);
    assert.ok(r.bytes < 4 * MIB, `read ${r.bytes} bytes`);
  }
  // Only zeros count as zeroed space: a flat picture coded with fixed tables repeats a few bytes
  // with no 0xFF among them for a long way, and is followed to its end.
  const end = Buffer.from([0xff, 0xd9]);
  const flat = Buffer.concat([Buffer.alloc(3 * MIB, Buffer.from([0x28, 0xa2, 0x8a])), end]);
  assert.deepStrictEqual(I.ecsEnd(new I.Cursor(memoryReader(flat)), 0, flat.length), { at: 3 * MIB, marker: 0xd9, rsts: 0, inOrder: true });
  const zeroed = Buffer.concat([Buffer.alloc(3 * MIB), end]);
  assert.deepStrictEqual(I.ecsEnd(new I.Cursor(memoryReader(zeroed)), 0, zeroed.length), { at: -1, blank: I.BLANK_RUN, rsts: 0, inOrder: true });
  const erased = Buffer.concat([Buffer.from([1, 2, 3]), Buffer.alloc(I.FILL_MAX + 2, 0xff), Buffer.from([0xd9])]);
  assert.strictEqual(I.ecsEnd(new I.Cursor(memoryReader(erased)), 0, erased.length).blank, 3);
  const filled = Buffer.concat([Buffer.from([1, 2, 3]), Buffer.alloc(100, 0xff), Buffer.from([0xd9])]);
  assert.strictEqual(I.ecsEnd(new I.Cursor(memoryReader(filled)), 0, filled.length).at, 3, 'a hundred fill bytes are fill bytes');
  // A PDF or a ZIP that lost its end is looked for no further than zeroed space either.
  const pdf = makePdf({ jpeg: makeJpeg({ seed: 71 }) });
  const streamed = makeZip([{ name: 'a.txt', data: latin1('y'.repeat(3000)), deflate: true, descriptor: true }]);
  for (const file of [pdf, streamed]) {
    const r = counting(memoryReader(Buffer.concat([file.subarray(0, file.length >> 1), Buffer.alloc(32 * MIB)])));
    assert.strictEqual(validate(r, 0).usable, false);
    assert.ok(r.bytes < 4 * MIB, `read ${r.bytes} bytes`);
    assert.ok(validate(memoryReader(Buffer.concat([file, Buffer.alloc(4 * MIB)])), 0).complete, 'whole, it is found whole');
  }
});

test('a Samsung motion photo keeps its video after a mark, and takes it along', () => {
  const photo = makeJpeg({ seed: 6, width: 64, height: 48, exif: {} });
  const video = makeMp4({ seed: 6, samples: 5 });
  const file = Buffer.concat([photo, latin1('MotionPhoto_Data'), video]);
  const h = validate(memoryReader(Buffer.concat([file, Buffer.alloc(512)])), 0);
  assert.ok(h.complete, h.problems.join('; '));
  assert.strictEqual(h.length, file.length);
  assert.deepStrictEqual(h.info.motionPhoto, { offset: photo.length + 16, length: video.length });
});

test('one run lists at most maxFiles files and probes at most maxBytes, and the next run goes on from `next`', async () => {
  const files = [
    [8 * S, makeJpeg({ seed: 100 })],
    [40 * S, makePng({ seed: 101 })],
    [80 * S, makeGif({ seed: 102 })],
    [120 * S, makeJpeg({ seed: 103 })],
    [160 * S, makeWav({ seed: 104, samples: 500 })],
  ];
  const reader = memoryReader(disk(256 * S, files));
  const all = files.map(([at]) => at);

  const seen = [];
  let start = 0;
  for (let run = 0; run < 3; run++) {
    const r = await scan(reader, { maxFiles: 2, start });
    seen.push(...r.found.map((f) => f.offset));
    if (run < 2) {
      assert.strictEqual(r.found.length, 2);
      assert.ok(r.next > r.found[1].offset && r.next % S === 0);
      assert.ok(r.notes.includes(`Stopped at byte ${r.next} after listing 2 files, the most one run lists; scan again from there to go on.`));
      start = r.next;
    } else {
      assert.strictEqual(r.next, null, 'nothing left');
      assert.ok(!r.notes.some((n) => /^Stopped/.test(n)));
    }
  }
  assert.deepStrictEqual(seen, all, 'each file once, in order');

  let r = await scan(reader, { maxBytes: 64 * S });
  assert.deepStrictEqual(r.found.map((f) => f.offset), [8 * S, 40 * S]);
  assert.deepStrictEqual([r.next, r.scanned], [64 * S, 64 * S]);
  assert.ok(r.notes.includes(`Stopped at byte ${64 * S} after probing ${64 * S} bytes, the most one run probes; scan again from there to go on.`));
  r = await scan(reader, { start: r.next });
  assert.deepStrictEqual(r.found.map((f) => f.offset), [80 * S, 120 * S, 160 * S]);
  assert.deepStrictEqual([r.next, r.scanned, r.total], [null, 192 * S, 192 * S]);
});

test('ranges: only free space is probed, a file may run on past its range, and `next` moves to the next range', async () => {
  const long = makeJpeg({ seed: 105, width: 512, height: 384, color: true });
  assert.ok(long.length > 12 * S, 'longer than what is left of its range');
  // Clusters of 4 sectors: files start on a cluster, as a file system puts them.
  const files = [[8 * S, long], [60 * S, makePng({ seed: 106 })], [152 * S, makePng({ seed: 107 })], [170 * S, makePng({ seed: 108 })]];
  const reader = memoryReader(disk(256 * S, files));
  const ranges = [[0, 20 * S], [100 * S, 200 * S]];
  let r = await scan(reader, { ranges, step: 4 * S });
  assert.deepStrictEqual(r.found.map((f) => [f.offset, f.length]), [[8 * S, long.length], [152 * S, files[2][1].length]],
    'the PNG at sector 60 lies outside every range, and the one at 170 on no cluster of its range');
  assert.strictEqual(r.total, 120 * S);
  r = await scan(reader, { ranges, step: 4 * S, maxFiles: 1 });
  assert.deepStrictEqual([r.found.map((f) => f.offset), r.next], [[8 * S], 100 * S]);
  r = await scan(reader, { ranges, step: 4 * S, start: r.next });
  assert.deepStrictEqual(r.found.map((f) => f.offset), [152 * S]);
  // Ranges that overlap are probed once, on the clusters of the first.
  r = await scan(reader, { ranges: [[100 * S, 180 * S], [140 * S, 200 * S]], step: 4 * S });
  assert.deepStrictEqual([r.found.map((f) => f.offset), r.total], [[152 * S], 100 * S]);
  // A file that runs on into the next range: the next run starts after it, not inside it.
  r = await scan(reader, { ranges: [[0, 12 * S], [16 * S, 64 * S]], step: 4 * S, maxFiles: 1 });
  assert.deepStrictEqual([r.found.map((f) => f.offset), r.next], [[8 * S], 16 * S + Math.ceil((8 * S + long.length - 16 * S) / (4 * S)) * 4 * S]);
});

test('a run can be cancelled and gone on with, and says how far it is', async () => {
  const image = disk(12 * MIB, [[1 * MIB, makeJpeg({ seed: 108 })], [9 * MIB, makePng({ seed: 109 })]]);
  const ac = new AbortController();
  let r = await scan(memoryReader(image), { signal: ac.signal, onFound: () => ac.abort() });
  assert.deepStrictEqual(r.found.map((f) => f.offset), [1 * MIB]);
  assert.strictEqual(r.next, 4 * MIB, 'at the end of the stretch it was probing');
  assert.ok(r.notes.includes(`Stopped at byte ${4 * MIB}: cancelled.`));
  const progress = [];
  r = await scan(memoryReader(image), { start: r.next, onProgress: (done, total) => progress.push([done, total]) });
  assert.deepStrictEqual(r.found.map((f) => f.offset), [9 * MIB]);
  assert.ok(progress.length >= 2 && progress.every(([done, total], i) => total === 8 * MIB && (!i || done > progress[i - 1][0])));
  assert.deepStrictEqual(progress[progress.length - 1], [8 * MIB, 8 * MIB]);
});

test('a bad sector costs the 64 KiB around it and the file that runs through it, not the run', async () => {
  const bad = 2 * MIB;
  const through = makeJpeg({ seed: 110, width: 256, height: 192, color: true });
  assert.ok(through.length > 1024, 'it runs on into the bad sector');
  const image = disk(5 * MIB, [[512 * 1024, makeJpeg({ seed: 111 })], [bad - 1024, through], [bad + 64 * 1024, makePng({ seed: 112 })]]);
  const r = await scan(withBadSector(image, bad));
  assert.deepStrictEqual(r.found.map((f) => f.offset), [512 * 1024, bad + 64 * 1024]);
  assert.strictEqual(r.counts.unreadable, 64 * 1024);
  assert.strictEqual(r.counts.unreadableFiles, 1);
  assert.ok(r.notes.includes(`Could not read at byte ${bad} (EIO); what could not be read was passed over.`), r.notes.join('\n'));
  assert.ok(r.notes.includes(`Could not read the file that starts at byte ${bad - 1024} (EIO); left out.`));
  assert.ok(r.notes.includes('65536 byte(s) could not be read and were passed over.'));
  assert.strictEqual(r.next, null);
});

test('how far a copy can be trusted: carved, undeleted from a recorded extent, or from one taken to follow on', () => {
  const j = validate(memoryReader(makeJpeg({ seed: 80, exif: { time: '2021:03:04 05:06:07' } })), 0);
  const p = validate(memoryReader(makePng({ seed: 81 })), 0);
  const cut = validate(memoryReader(makeJpeg({ seed: 82, width: 256, height: 192, color: true }).subarray(0, 1500)), 0);
  // Carved: unverified however well it checks out, a PNG stream too (tier 3).
  assert.deepStrictEqual(flags(judge(j)), { unverified: true });
  assert.deepStrictEqual(flags(judge(p)), { unverified: true });
  assert.ok(judge(p).reasons.some((why) => /ends at IEND/.test(why)));
  const c = candidate(j);
  assert.deepStrictEqual([c.kind, c.mediaType, c.ext, c.size, c.width, c.height, c.time, c.unverified, c.derived],
    ['carved', 'image', '.jpg', j.length, 64, 48, new Date(2021, 2, 4, 5, 6, 7).getTime(), true, undefined]);
  assert.match(c.note, /found by its content alone: nothing records where the file ended/);
  assert.match(c.note, /dated by Exif: when the picture was taken/);
  assert.strictEqual(tier(c), 3);
  // A file system recorded where every piece of the file lies (exFAT with no FAT chain, a chain
  // left intact): content that checks out is inexact, and a checksummed stream of exactly the
  // recorded size is the file itself.
  const known = (h, size) => flags(judge(h, { size, known: true }));
  assert.deepStrictEqual(known(j, j.length), { inexact: true });
  assert.deepStrictEqual(known(p, p.length), {});
  assert.deepStrictEqual(known(p, p.length + 10), { inexact: true });
  assert.ok(judge(p, { size: p.length + 10, known: true }).reasons.includes('its last 10 bytes, after where its structure ends, are not checked'));
  assert.deepStrictEqual(known(j, j.length - 100), { unverified: true });
  assert.deepStrictEqual(known(cut, 5000), { unverified: true }, 'damaged content is not the file any more');
  // Only its start and size are recorded, and the rest is taken to follow on, as on FAT.
  assert.deepStrictEqual(flags(judge(j, { size: j.length })), { unverified: true });
  assert.ok(judge(j, { size: j.length }).reasons.some((why) => /taken to follow on/.test(why)));
  assert.deepStrictEqual(flags(judge(p, { size: p.length })), {}, 'its checksums show the pieces did follow on');
  // Bytes no format here recognizes.
  assert.deepStrictEqual(flags(judge(null)), { unverified: true });
  assert.deepStrictEqual(flags(judge(null, { size: 10, known: true })), { inexact: true });
  assert.deepStrictEqual(flags(judge(null, { size: 10 })), { unverified: true });
  // As quality.js ranks them.
  assert.deepStrictEqual([
    tier({ kind: 'exfat undelete', ...flags(judge(p, { size: p.length, known: true })) }),
    tier({ kind: 'exfat undelete', ...flags(judge(j, { size: j.length, known: true })) }),
    tier({ kind: 'fat undelete', ...flags(judge(j, { size: j.length })) }),
  ], [0, 1, 3]);
  // A picture made to live inside another file is a smaller copy when carved (tier 4), and the
  // file itself when a file system names it.
  const bare = validate(memoryReader(makeJpeg({ seed: 83, app: false })), 0);
  assert.deepStrictEqual(flags(judge(bare)), { derived: true, unverified: true });
  assert.strictEqual(tier(candidate(bare)), 4);
  assert.deepStrictEqual(known(bare, bare.length), { inexact: true });
});

test('an undeleted file is checked through the clusters its entry names (lib/fat.js extentReader)', () => {
  const j = makeJpeg({ seed: 84, width: 512, height: 384, color: true });
  const split = 8 * S;
  assert.ok(j.length > split + S);
  const img = memoryReader(disk(96 * S, [[4 * S, j.subarray(0, split)], [40 * S, j.subarray(split)]]));
  const recorded = { spans: [[4 * S, split], [40 * S, j.length - split]], size: j.length };
  const h = validate(extentReader(img, recorded), 0);
  assert.ok(h.complete, h.problems.join('; '));
  assert.strictEqual(h.length, j.length);
  assert.deepStrictEqual(flags(judge(h, { size: j.length, known: true })), { inexact: true });
  // Taken to follow on from its first cluster, as a deleted FAT file is: not whole.
  const assumed = validate(extentReader(img, { spans: [[4 * S, j.length]], size: j.length }), 0);
  assert.ok(!assumed.complete && assumed.usable);
  assert.deepStrictEqual(flags(judge(assumed, { size: j.length })), { unverified: true });
});

test('a disk image is read through lib/fat.js, a carved file restored from it, and nothing else written', async () => {
  const dir = workDir('carve');
  dirs.push(dir);
  const j = makeJpeg({ seed: 85, width: 100, height: 75, color: true, exif: { time: '2019:12:31 23:59:58' } });
  const card = path.join(dir, 'card');
  const img = write(path.join(card, 'sd.img'), disk(128 * S, [[20 * S, j]], { fill: 'random', seed: 3 }));
  const before = snapshot(card);
  const reader = openReader(img);
  let r;
  try {
    r = await scan(reader, { types: ['image'] });
  } finally {
    reader.close();
  }
  assert.deepStrictEqual(r.found.map((f) => [f.offset, f.type, f.length]), [[20 * S, 'jpeg', j.length]]);
  const hit = r.found[0];
  const copy = { ...candidate(hit), id: 'c4', path: null, source: 'removable', extent: { place: img, runs: [[hit.offset, hit.length]] } };
  const out = path.join(dir, 'out');
  const written = await restore(copy, out, [card], null);
  assert.strictEqual(path.basename(written), 'recovered-c4 (may be incomplete).jpg');
  assert.ok(fs.readFileSync(written).equals(j));
  assert.deepStrictEqual(fs.readdirSync(out), ['recovered-c4 (may be incomplete).jpg'], 'no temporary file is left');
  assert.deepStrictEqual(snapshot(card), before, 'the image is read, never written');
});

test('a reader of no known size is refused rather than carved as empty', async () => {
  const device = { size: null, read: () => Buffer.alloc(0) };
  assert.throws(() => validate(device, 0), /no known size/);
  await assert.rejects(scan(device), /no known size/);
});

test('what a damaged ZIP stored as it is keeps its name: part of a document, or a file someone archived', async () => {
  const picture = makePng({ seed: 86, width: 30, height: 20 });
  const doc = docx(picture);
  const central = latin1('PK\x01\x02');
  // Both have lost their central directory and end record: nothing to open.
  const lostDoc = doc.subarray(0, doc.indexOf(central));
  const photo = makeJpeg({ seed: 87, width: 64, height: 48 });
  const archive = makeZip([{ name: 'notes.txt', data: latin1('x'.repeat(2000)), deflate: true }, { name: 'DCIM/IMG_0001.JPG', data: photo, align: 512 }]);
  const lostArchive = archive.subarray(0, archive.indexOf(central));
  const r = await scan(memoryReader(disk(128 * S, [[4 * S, lostDoc], [64 * S, lostArchive]])));
  assert.deepStrictEqual(r.found.map((f) => [f.offset, f.type]),
    [[4 * S + lostDoc.indexOf(picture), 'png'], [64 * S + lostArchive.indexOf(photo), 'jpeg']]);
  const [inDoc, inArchive] = r.found;
  assert.strictEqual(inDoc.embedded, `it is stored inside the DOCX found at ${4 * S}, as word/media/image1.png`);
  assert.strictEqual(inDoc.info.member, 'word/media/image1.png');
  assert.ok(judge(inDoc).derived, 'a picture made part of a document is a copy of it');
  assert.strictEqual(inArchive.embedded, null);
  assert.ok(inArchive.caveats.includes(`it is stored inside the ZIP found at ${64 * S}, as DCIM/IMG_0001.JPG`));
  assert.strictEqual(inArchive.info.member, 'DCIM/IMG_0001.JPG');
  assert.ok(!judge(inArchive).derived, 'a file someone archived is that file');
  assert.strictEqual(candidate(inArchive).name, 'IMG_0001.JPG', 'and it is offered under its name');
  assert.strictEqual(candidate(inDoc).name, undefined);
  assert.strictEqual(r.counts.falseStarts, 2, 'neither ZIP can be opened');
});

test('a CR3 offers its largest preview; a movie\'s own thumbnail and its own boxes are not listed apart', async () => {
  const full = makeJpeg({ seed: 90, width: 128, height: 96, app: false });
  const cr3 = makeCr3({ full, small: makeJpeg({ seed: 91, width: 64, height: 48 }), thumb: makeJpeg({ seed: 92, width: 32, height: 24 }) });
  const h = validate(memoryReader(cr3), 0);
  assert.ok(h.complete, h.problems.join('; '));
  assert.deepStrictEqual([h.type, h.ext, h.mediaType, h.length, h.width, h.height], ['cr3', '.cr3', 'image', cr3.length, 6000, 4000]);
  assert.deepStrictEqual(h.previews.map((p) => [p.offset, p.length, p.width, p.height, p.derived]), [[cr3.indexOf(full), full.length, 128, 96, true]]);
  let r = await scan(memoryReader(disk(64 * S, [[8 * S, cr3]])));
  assert.deepStrictEqual(r.found.map((f) => [f.offset, f.type, f.derived]), [[8 * S, 'cr3', false], [8 * S + cr3.indexOf(full), 'jpeg', true]]);
  assert.strictEqual(r.counts.previews, 1, 'met on its own sector, and not listed twice');

  // An MP4 with a thumbnail in moov/udta, and its mdat on a sector of its own.
  const thumb = makeJpeg({ seed: 93, width: 40, height: 30 });
  const mp4 = makeMp4({ seed: 9, thumb, free: 512 - 24 });
  assert.deepStrictEqual([mp4.indexOf(thumb) % S, mp4.indexOf(latin1('mdat')) - 4], [0, 512]);
  r = await scan(memoryReader(disk(256 * S, [[8 * S, mp4]])));
  assert.deepStrictEqual(r.found.map((f) => [f.offset, f.type, f.length]), [[8 * S, 'mp4', mp4.length]]);
  assert.deepStrictEqual([r.counts.previews, r.counts.parts], [1, 1]);
  assert.ok(r.notes.some((n) => /1 place\(s\) where a file found before goes on/.test(n)));
});
