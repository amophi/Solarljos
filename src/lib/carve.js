'use strict';

const zlib = require('zlib');
const { t } = require('../i18n');

// Signature carving: finding files by their content alone, where no file system says any more
// where they are -- the free space of a memory card or a USB stick, or a disk image whose
// directory is gone. Everything here works over a random-access reader,
//
//   { size, read(offset, length) -> Buffer, readAsync?(offset, length) -> Promise<Buffer> }
//
// which gives fewer bytes than asked only at its end, and does nothing but read it. lib/fat.js
// makes the readers: openReader() over a disk image or a device, memoryReader() over bytes in
// memory, extentReader() over the clusters a deleted file's entry names. Its size must be known;
// a device reports none, so it is set from the partition table or the boot sector first. Where
// readAsync() is there, scan() reads the stretches it probes with it, so that a slow card holds
// nothing else up meanwhile; the checks of one file read with read().
//
// scan() probes every `step` bytes -- a sector, or a cluster when that is known -- for the first
// bytes of a format it knows, and hands each one to that format's validator, which walks the
// format's own structure as far as it holds:
//
//   JPEG      markers from SOI to EOI (T.81 Annex B): fill bytes, segment lengths, tables that add
//             up. Every MCU of a baseline or extended Huffman scan is decoded, without the IDCT:
//             valid codes, DC values within +-2^(P+2), AC sizes at most P+2 (F.1.2), runs inside
//             the block, restart markers in order, exactly as many MCUs as the frame needs and
//             nothing but padding after the last. Exif gives the time taken and the thumbnail;
//             MPF (CIPA DC-007) the images stored after the first EOI; a video that starts right
//             after the end is a motion photo's, and is taken along -- straight after it, as
//             Google's cameras put it, or after a "MotionPhoto_Data" mark, as Samsung's do. A run
//             of more than FILL_MAX bytes of 0xFF is not taken for fill bytes before a marker: it
//             is erased flash, which many cards read back as 0xFF, and the data ends there. A
//             picture cut short is decoded as far as its data goes, to say how much of it is left.
//   PNG       every chunk's CRC-32, IHDR first and IEND last, the image data's zlib Adler-32, and
//             exactly as many bytes of rows as IHDR needs, interlaced or not.
//   GIF       blocks and sub-block chains to the trailer, and every image's LZW codes decoded to
//             at least as many pixels as its descriptor has; one cut short, as far as it goes.
//   BMP       the header only: file size, pixel offset and rows agree.
//   RIFF      AVI (with its OpenDML AVIX pieces), WAV and WebP: chunks, and the chunks inside
//             every LIST, tile each RIFF exactly; one cut short is followed as far as it goes.
//   ISO BMFF  MP4, MOV, 3GP, M4V, M4A, HEIC, AVIF, CR3: top-level boxes by their sizes, a moov
//             and an mdat (or HEIF's meta); every sample of every track inside an mdat; for
//             H.264 and H.265 tracks, NAL unit lengths that tile each sample exactly; for Motion
//             JPEG tracks, SOI at every sample; for HEIF, every item extent inside the file and
//             every coded item's NAL units or OBUs tiling it. What the NAL units hold is not
//             decoded, so a foreign piece that lies wholly inside one goes unnoticed.
//   ASF       WMV and WMA: objects by their sizes, ending exactly at the size the header records,
//             and every data packet where the packet size puts it.
//   TIFF      and the camera RAW files built on it (CR2, NEF, ARW, DNG, PEF, ORF, RW2, ...): the
//             directories, and every strip, tile and JPEG they point to lying inside the file.
//             The image data is not checked.
//   PDF       up to the last %%EOF whose startxref points at a cross-reference.
//   ZIP       and what is built on it (DOCX, XLSX, PPTX, ODF, EPUB, HWPX, APK): local headers,
//             central directory and end record agreeing, and every member's CRC-32. ZIP64, for
//             archives of more than 4 GiB or 65,535 members, is not followed.
//
// Where a file's end is looked for rather than read from its structure -- a JPEG scan's next
// marker, a PDF's %%EOF, a ZIP's end record -- the search stops at space zeroed since the file was
// cut short (findUntilBlank), so a damaged file costs a mebibyte or two of reading, not MAX_LENGTH.
//
// Each hit says where it starts and how long it is, its type, extension and media type, whether
// its structure closed where the format says it closes (`complete`), which checks held, the
// problems found (it is damaged or cut short), the caveats (what the checks cannot rule out),
// and what a carve loses after the structure's end (`tail`), with width, height and the time the
// content records.
//
// A carve is never better than unverified (tier 3 in quality.js): nothing but the content says
// where the file ended, and a file that was stored in pieces carves as its first piece followed
// by whatever lay after it. judge() says so, and says what changes when a file system says where
// the file lay. Content that checks out is then inexact when the file system recorded every piece
// of the file, and still unverified when its pieces are only taken to follow each other, as those
// of a deleted FAT file are. Only a stream whose checksums cover every byte (PNG, ZIP) and that
// ends exactly at the size the file system recorded is the file itself. A carved PNG ends at IEND,
// so it is that PNG stream exactly, and not provably the file: bytes the file held after IEND are
// lost, and the PNG may have been stored inside another file.
//
// Pictures stored inside other files are not presented as photos. How scan() tells, and what it
// does with them, is written above scan().
//
// Measured on public test images and on files that ship with Windows, not on a card of this
// machine's user -- it has none, and its only disk is an SSD with TRIM, where deleted blocks read
// back as zeros:
//   - DFTT #11, a FAT32 USB-stick image with its boot sectors zeroed on purpose, carved at every
//     512 bytes in 0.1 s for 62 MB: all 7 photos and videos came back with their published MD5
//     (3 JPEG, a GIF, a MOV, 2 WMV, one of them a deleted 8 MB file), and so did both PDFs and the
//     ZIP; the damaged JPEG was rejected; the WAV came back one byte short of its file, which held
//     a byte after RIFF's end.
//   - 6,558 pictures, videos, sounds and archives that ship with Windows and installed programs,
//     each checked on its own: every one complete at exactly its file's length, but for two PNGs
//     of 69 bytes whose image data fails its CRC -- as Python's zlib finds too.
//   - In memory, free space is probed at 4 to 9 GiB/s at 512-byte steps; a card reader gives 20 to
//     90 MB/s, so a card takes as long as reading it does.
//   - By the research behind this: one 512-byte cluster of three real photos' entropy data
//     replaced by a cluster from another photo, the MCU walk caught 1,670 of 1,726, 336 of 382
//     and 114 of 114; at 4 KiB, 214 of 214, 44 of 46 and 12 of 12. Huffman decoders fall back
//     into step, so a JPEG that decodes fully is strong evidence, not proof.

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

// What one run of scan() does at most, unless told otherwise. `budget` is how much one file's
// checks may read: a longer video is checked as far as that goes, and says how far.
const DEFAULTS = {
  step: 512,
  maxBytes: 256 * GIB,
  maxFiles: 10000,
  budget: 256 * MIB,
};

// The longest file of each kind believed. A structure that would run on further is cut there
// and says so; formats whose headers record their size (ISO BMFF, RIFF, ASF, TIFF) need none.
const MAX_LENGTH = {
  jpeg: 256 * MIB,
  png: 512 * MIB,
  gif: 256 * MIB,
  pdf: 512 * MIB,
  zip: 256 * MIB,
};

// T.81 lets any number of 0xFF fill bytes come before a marker; encoders write none or a few. A
// longer run is erased flash, which many cards read back as 0xFF.
const FILL_MAX = 4096;

// Where each format's name and kind come from when nothing more specific is known.
const FORMATS = {
  jpeg: { ext: '.jpg', mediaType: 'image' },
  png: { ext: '.png', mediaType: 'image' },
  gif: { ext: '.gif', mediaType: 'image' },
  bmp: { ext: '.bmp', mediaType: 'image' },
  webp: { ext: '.webp', mediaType: 'image' },
  tiff: { ext: '.tif', mediaType: 'image' },
  heif: { ext: '.heic', mediaType: 'image' },
  avif: { ext: '.avif', mediaType: 'image' },
  cr3: { ext: '.cr3', mediaType: 'image' },
  mp4: { ext: '.mp4', mediaType: 'video' },
  mov: { ext: '.mov', mediaType: 'video' },
  m4v: { ext: '.m4v', mediaType: 'video' },
  '3gp': { ext: '.3gp', mediaType: 'video' },
  m4a: { ext: '.m4a', mediaType: 'audio' },
  avi: { ext: '.avi', mediaType: 'video' },
  wav: { ext: '.wav', mediaType: 'audio' },
  wmv: { ext: '.wmv', mediaType: 'video' },
  wma: { ext: '.wma', mediaType: 'audio' },
  pdf: { ext: '.pdf', mediaType: 'document' },
  zip: { ext: '.zip', mediaType: 'archive' },
};

const EMPTY = Buffer.alloc(0);

// ---------------------------------------------------------------- CRC-32

// zlib.crc32 arrived in Node 22.2; the table is for 22.0 and 22.1.
let TABLE = null;
function crc32Table(buf, crc = 0) {
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
  }
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
const crc32 = typeof zlib.crc32 === 'function' ? (buf, crc = 0) => zlib.crc32(buf, crc) >>> 0 : crc32Table;

// ---------------------------------------------------------------- reading

const WINDOW = MIB;
const SMALL = 64 * KIB;
const ALIGN = 4096;

/**
 * A window over the reader, so that a validator can walk far without holding the file. Reads
 * start on a 4 KiB boundary. `spent` counts the bytes read, for the checks' budget.
 */
class Cursor {
  constructor(reader, limit = reader.size) {
    this.reader = reader;
    this.limit = Math.min(reader.size, limit);
    this.at = 0;
    this.win = EMPTY;
    this.spent = 0;
  }

  load(pos, len) {
    const a = pos - (pos % ALIGN);
    const want = Math.min(len + (pos - a), this.limit - a);
    this.win = want > 0 ? this.reader.read(a, want) : EMPTY;
    this.at = a;
    this.spent += this.win.length;
  }

  has(pos, n) {
    return pos >= this.at && pos + n <= this.at + this.win.length;
  }

  /** The byte at `pos`, or -1 past the end. */
  byte(pos) {
    if (pos < 0 || pos >= this.limit) return -1;
    if (!this.has(pos, 1)) {
      this.load(pos, WINDOW);
      if (!this.has(pos, 1)) return -1;
    }
    return this.win[pos - this.at];
  }

  /** `n` bytes at `pos`, or null when they run past the end. */
  bytes(pos, n) {
    if (pos < 0 || n < 0 || !Number.isSafeInteger(pos + n) || pos + n > this.limit) return null;
    if (!this.has(pos, n)) {
      if (n > SMALL) {
        const b = this.reader.read(pos, n);
        this.spent += b.length;
        return b.length === n ? b : null;
      }
      this.load(pos, SMALL);
      if (!this.has(pos, n)) return null;
    }
    return this.win.subarray(pos - this.at, pos - this.at + n);
  }

  u16be(p) { const b = this.bytes(p, 2); return b ? b.readUInt16BE(0) : -1; }
  u16le(p) { const b = this.bytes(p, 2); return b ? b.readUInt16LE(0) : -1; }
  u32be(p) { const b = this.bytes(p, 4); return b ? b.readUInt32BE(0) : -1; }
  u32le(p) { const b = this.bytes(p, 4); return b ? b.readUInt32LE(0) : -1; }
  u64le(p) { const b = this.bytes(p, 8); return b ? Number(b.readBigUInt64LE(0)) : -1; }

  /** Where `pattern` next occurs in [from, to), or -1. */
  find(pattern, from, to) {
    const end = Math.min(to, this.limit);
    let pos = from;
    while (pos + pattern.length <= end) {
      if (!this.has(pos, pattern.length)) this.load(pos, WINDOW);
      const stop = Math.min(this.win.length, end - this.at);
      if (pos + pattern.length > this.at + stop) return -1;
      const i = this.win.indexOf(pattern, pos - this.at);
      if (i >= 0 && i + pattern.length <= stop) return this.at + i;
      if (i >= 0 || this.at + stop >= end) return -1;
      pos = this.at + stop - pattern.length + 1;
    }
    return -1;
  }
}

// A search for where a file ends -- a JPEG scan's next marker, a PDF's %%EOF, a ZIP's end record
// -- stops at space that was zeroed since the file was cut short, instead of reading on to
// MAX_LENGTH: a mebibyte without what is looked for that ends in 64 KiB of zeros. Compressed data
// holds a byte 0xFF every few hundred bytes, and even a picture of one flat colour does not code
// to that many zeros below about 170 megapixels.
const BLANK_RUN = MIB;
const ZEROS = Buffer.alloc(SMALL);

/**
 * Where `pattern` next occurs in [from, limit), looked for a mebibyte at a time: { at }, or at -1
 * when it does not occur there, with `blank` where blank space (above) stopped the search.
 */
function findUntilBlank(cur, pattern, from, limit) {
  for (let q = from; ;) {
    const stop = Math.min(limit, q + BLANK_RUN);
    const i = cur.find(pattern, q, stop);
    if (i >= 0) return { at: i };
    if (stop >= limit) return { at: -1 };
    const tail = cur.bytes(stop - SMALL, SMALL);
    if (tail && tail.equals(ZEROS)) return { at: -1, blank: stop };
    q = stop - pattern.length + 1;
  }
}

// ---------------------------------------------------------------- hits

function newHit(type, start) {
  const f = FORMATS[type];
  return {
    type, ext: f.ext, mediaType: f.mediaType, offset: start, length: 0, complete: false,
    checks: [], problems: [], caveats: [], tail: null,
    width: null, height: null, time: null, timeFrom: null,
    derived: false, embedded: null, parent: null, selfChecked: false, info: {},
    // What scan() needs and callers do not: how far every byte was verified to be this file's,
    // how far it claims to reach, what starts where inside it (see mark()), the smaller copies it
    // offers, whether anything of it is worth listing, and, when it is never listed, the count it
    // goes to instead ('raw', 'frames').
    _: { verifiedEnd: start, claimEnd: null, pointers: new Map(), children: [], usable: true, drop: null },
  };
}

// How many places inside one file are remembered: a Motion JPEG video of an hour at 30 frames a
// second has 108,000 frames. The frames past this are still told apart by their own bytes.
const MAX_POINTERS = 1 << 17;

/**
 * Remembers what starts at `at` inside a file, for scan() to know it when it meets it there:
 *   'preview'   a picture the file keeps of itself -- a RAW's preview, an Exif thumbnail
 *   'frame'     a frame of the file's Motion JPEG video
 *   'part'      a piece of the file's own structure: a movie's next box, a ZIP's next member,
 *               a motion photo's video
 *   { member }  the data of a ZIP member stored as it is, by the member's name
 */
function mark(hit, at, what) {
  if (hit._.pointers.size < MAX_POINTERS) hit._.pointers.set(at, what);
}

function publicHit(h) {
  const { _, ...rest } = h;
  return rest;
}

/** A hit's format as a person says it: JPEG, PNG, NEF, DOCX. */
function label(h) {
  return h.type === 'jpeg' ? 'JPEG' : h.ext.slice(1).toUpperCase();
}

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

// ---------------------------------------------------------------- times

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PLAUSIBLE_FROM = Date.UTC(1985, 0, 1);

function plausible(ms) {
  return Number.isFinite(ms) && ms >= PLAUSIBLE_FROM && ms <= Date.now() + 366 * 24 * 3600 * 1000;
}

/** A wall-clock time; UTC when `offsetMin` is given, otherwise this machine's local time. */
function wallClock(y, mo, d, h, mi, s, offsetMin) {
  const utc = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d
    || h > 23 || mi > 59 || s > 59) return null;
  const ms = offsetMin == null ? new Date(y, mo - 1, d, h, mi, s).getTime() : utc - offsetMin * 60000;
  return plausible(ms) ? ms : null;
}

/** Exif's "YYYY:MM:DD HH:MM:SS", with OffsetTimeOriginal's "+09:00" when there is one. */
function exifTime(text, offset) {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text || '');
  if (!m) return null;
  const off = /^([+-])(\d{2}):(\d{2})/.exec(offset || '');
  const offsetMin = off ? (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) : null;
  const ms = wallClock(...m.slice(1).map(Number), offsetMin);
  return ms == null ? null : { ms, zone: offsetMin != null };
}

/** AVI's IDIT chunk: "SUN SEP 05 09:32:43 2004", or an Exif-style time. */
function iditTime(text) {
  const m = /^\s*[a-z]{3}\s+([a-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})/i.exec(text || '');
  if (m) {
    const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    return mo ? wallClock(Number(m[6]), mo, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), null) : null;
  }
  const e = exifTime(text, null);
  return e ? e.ms : null;
}

/** Seconds since 1904-01-01 UTC, as QuickTime and ISO BMFF count; 0 is "not set". */
function macTime(secs) {
  if (!secs) return null;
  const ms = (secs - 2082844800) * 1000;
  return plausible(ms) ? ms : null;
}

/** A FILETIME, 100 ns since 1601-01-01 UTC. */
function fileTime(ft) {
  if (!ft) return null;
  const ms = Number(ft / 10000n) - 11644473600000;
  return plausible(ms) ? ms : null;
}

function setTime(hit, ms, from) {
  if (ms == null || hit.time != null) return;
  hit.time = ms;
  hit.timeFrom = from;
}

// ---------------------------------------------------------------- TIFF directories (Exif, RAW)

const TIFF_TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

/**
 * Reads TIFF directories through `get(pos, n)`, positions counted from the TIFF header, which
 * returns null past the end. Byte order from "II" or "MM"; the magic is left to the caller, since
 * Olympus and Panasonic RAW files have their own.
 */
function tiffReader(get) {
  const h = get(0, 8);
  if (!h) return null;
  const order = h.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const u16 = (b, o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (b, o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  return {
    le,
    magic: u16(h, 2),
    first: u32(h, 4),
    /** An IFD's entries and the next IFD's position, or null where none fits. */
    ifd(off) {
      const nb = off >= 8 ? get(off, 2) : null;
      if (!nb) return null;
      const n = u16(nb, 0);
      if (!n || n > 1000) return null;
      const body = get(off + 2, n * 12 + 4);
      if (!body) return null;
      const entries = [];
      let known = 0;
      for (let i = 0; i < n; i++) {
        const e = i * 12;
        const type = u16(body, e + 2);
        const count = u32(body, e + 4);
        const size = (TIFF_TYPE_SIZE[type] || 0) * count;
        if (TIFF_TYPE_SIZE[type]) known++;
        entries.push({
          tag: u16(body, e), type, count, size,
          at: size <= 4 ? off + 2 + e + 8 : u32(body, e + 8), inline: size <= 4,
        });
      }
      return { at: off, entries, known, next: u32(body, n * 12), end: off + 2 + n * 12 + 4 };
    },
    /** The numbers of a BYTE, SHORT, LONG or IFD entry, at most `max` of them. */
    values(e, max = 1 << 20) {
      const size = TIFF_TYPE_SIZE[e.type];
      if (![1, 3, 4, 13].includes(e.type) || e.count > max) return [];
      const b = get(e.at, e.count * size);
      if (!b) return [];
      const out = new Array(e.count);
      for (let i = 0; i < e.count; i++) out[i] = size === 1 ? b[i] : size === 2 ? u16(b, i * 2) : u32(b, i * 4);
      return out;
    },
    ascii(e) {
      if (e.type !== 2 || e.count > 4096) return null;
      const b = get(e.at, e.count);
      return b ? b.toString('latin1').replace(/[\0\s]+$/, '') : null;
    },
  };
}

/** Exif in a buffer: camera, time taken, pixel size and the thumbnail's place. */
function exifInfo(buf) {
  const T = tiffReader((pos, n) => (pos >= 0 && pos + n <= buf.length ? buf.subarray(pos, pos + n) : null));
  const out = {};
  if (!T || T.magic !== 42) return out;
  const ifd0 = T.ifd(T.first);
  if (!ifd0) return out;
  let exifAt = 0;
  for (const e of ifd0.entries) {
    if (e.tag === 0x010f) out.make = T.ascii(e);
    else if (e.tag === 0x0110) out.model = T.ascii(e);
    else if (e.tag === 0x0132) out.dateTime = T.ascii(e);
    else if (e.tag === 0x8769) exifAt = T.values(e, 1)[0] || 0;
  }
  const ex = exifAt ? T.ifd(exifAt) : null;
  for (const e of ex ? ex.entries : []) {
    if (e.tag === 0x9003) out.original = T.ascii(e);
    else if (e.tag === 0x9011) out.offset = T.ascii(e);
    else if (e.tag === 0xa002) out.width = T.values(e, 1)[0];
    else if (e.tag === 0xa003) out.height = T.values(e, 1)[0];
  }
  const ifd1 = ifd0.next ? T.ifd(ifd0.next) : null;
  if (ifd1) {
    const get = (tag) => { const e = ifd1.entries.find((x) => x.tag === tag); return e ? T.values(e, 1)[0] : 0; };
    const offset = get(0x0201);
    const length = get(0x0202);
    if (offset && length) out.thumbnail = { offset, length };
  }
  return out;
}

/** The time a picture was taken, from Exif, into the hit. */
function takeExifTime(hit, ex) {
  const taken = exifTime(ex.original, ex.offset);
  if (taken) {
    setTime(hit, taken.ms, taken.zone ? t('Exif: when the picture was taken')
      : t('Exif: when the picture was taken, by the camera\'s clock; no time zone is recorded'));
    return;
  }
  const changed = exifTime(ex.dateTime, null);
  if (changed) setTime(hit, changed.ms, t('Exif: when the picture was last changed, no time zone recorded'));
}

// ---------------------------------------------------------------- JPEG (ITU-T T.81)

const isSof = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
const LOSSLESS = new Set([0xc3, 0xc7, 0xcb, 0xcf]);
const PROGRESSIVE = new Set([0xc2, 0xc6, 0xca, 0xce]);
const FF = Buffer.from([0xff]);
const SOI = Buffer.from([0xff, 0xd8, 0xff]);
// What Samsung's cameras put between a motion photo's picture and its video.
const MOTION_MARK = Buffer.from('MotionPhoto_Data', 'latin1');

/** Where JPEGs may start in a buffer: at most `max` places where SOI and a marker are. */
function jpegStarts(buf, max = 16) {
  const out = [];
  for (let i = buf ? buf.indexOf(SOI) : -1; i >= 0 && out.length < max; i = buf.indexOf(SOI, i + 3)) out.push(i);
  return out;
}

/** A canonical Huffman table from a DHT, or null when its code lengths over-fill the code space. */
function huffTable(counts, symbols) {
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    valptr[l] = k;
    mincode[l] = code;
    code += counts[l - 1];
    k += counts[l - 1];
    if (code > (1 << l)) return null;
    maxcode[l] = counts[l - 1] ? code - 1 : -1;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { maxcode, valptr, mincode, symbols };
}

/**
 * Decodes one baseline or extended sequential Huffman scan, MCU by MCU, without dequantizing or
 * transforming anything. `data` is its entropy-coded segment, restart markers included. The walk
 * fails on a code no table has, a value out of range, a run past the block, a marker inside an
 * MCU, a restart marker missing or out of turn, and data left over after the last MCU. `mcus`
 * counts the MCUs that decoded whole; `atEnd` says a walk that failed did so where the data ran
 * out, as that of a picture cut short does.
 * @returns {{ ok: boolean, mcus: number, expected: number, why?: string, atEnd?: boolean, left?: number }}
 */
function walkScan(data, frame, scan, tables, restart) {
  let pos = 0;
  let acc = 0;
  let bits = 0;
  let marker = false;
  const bit = () => {
    if (bits === 0) {
      if (pos >= data.length) {
        marker = true;
        return 1;
      }
      const b = data[pos];
      if (b === 0xff) {
        // A stuffed zero follows a data FF; anything else is a marker, and a decoder reads ones.
        if (data[pos + 1] !== 0x00) {
          marker = true;
          return 1;
        }
        pos += 2;
      } else {
        pos++;
      }
      acc = b;
      bits = 8;
    }
    bits--;
    return (acc >> bits) & 1;
  };
  const receive = (s) => {
    let v = 0;
    for (let i = 0; i < s; i++) v = (v << 1) | bit();
    return v;
  };
  const decode = (h) => {
    let code = bit();
    let l = 1;
    while (code > h.maxcode[l]) {
      code = (code << 1) | bit();
      if (++l > 16) return -1;
    }
    return h.symbols[h.valptr[l] + code - h.mincode[l]];
  };
  const comps = scan.comps.map((c) => ({ ...c, f: frame.comps.find((f) => f.id === c.id) }));
  const hmax = Math.max(...frame.comps.map((c) => c.h));
  const vmax = Math.max(...frame.comps.map((c) => c.v));
  let expected;
  let blocks;
  if (comps.length === 1) {
    // One component on its own is coded block by block, over its own size.
    const c = comps[0].f;
    expected = Math.ceil(Math.ceil((frame.width * c.h) / hmax) / 8) * Math.ceil(Math.ceil((frame.height * c.v) / vmax) / 8);
    blocks = [1];
  } else {
    expected = Math.ceil(frame.width / (8 * hmax)) * Math.ceil(frame.height / (8 * vmax));
    blocks = comps.map((c) => c.f.h * c.f.v);
  }
  // With P-bit samples a quantized DC lies within +-2^(P+2) and an AC value's size is at most
  // P+2 (T.81 F.1.2.1, F.1.2.2): a decoder that lost its way soon breaks one or the other.
  const P = frame.precision;
  const dcLimit = 1 << (P + 2);
  const pred = comps.map(() => 0);
  const extend = (v, s) => (s && v < (1 << (s - 1)) ? v - (1 << s) + 1 : v);
  // `atEnd`: the walk failed because the data ran out, not on something wrong inside it.
  const fail = (why, mcus) => ({ ok: false, mcus, expected, why, atEnd: pos >= data.length - 1 });
  let mcus = 0;
  let nextRst = 0;
  for (;;) {
    for (let ci = 0; ci < comps.length; ci++) {
      const dc = tables.dc[comps[ci].td];
      const ac = tables.ac[comps[ci].ta];
      if (!dc || !ac) return fail(t('a Huffman table it needs is missing'), mcus);
      for (let b = 0; b < blocks[ci]; b++) {
        const s = decode(dc);
        if (s < 0 || s > P + 3) return fail(t('an invalid code'), mcus);
        pred[ci] += extend(receive(s), s);
        if (pred[ci] > dcLimit || pred[ci] < -dcLimit) return fail(t('a DC value out of range'), mcus);
        for (let k = 1; k < 64;) {
          const rs = decode(ac);
          if (rs < 0) return fail(t('an invalid code'), mcus);
          const r = rs >> 4;
          const sz = rs & 15;
          if (sz === 0) {
            if (r !== 15) break;
            k += 16;
            if (k > 64) return fail(t('a run past the end of a block'), mcus);
            continue;
          }
          if (sz > P + 2) return fail(t('an AC value out of range'), mcus);
          k += r;
          receive(sz);
          if (++k > 64) return fail(t('a run past the end of a block'), mcus);
        }
        if (marker && !(mcus + 1 === expected && ci === comps.length - 1)) return fail(t('a marker inside an MCU'), mcus);
      }
    }
    mcus++;
    if (mcus === expected) break;
    if (restart && mcus % restart === 0) {
      bits = 0;
      if (data[pos] !== 0xff || data[pos + 1] !== (0xd0 | nextRst)) return fail(t('a restart marker missing or out of turn'), mcus);
      pos += 2;
      nextRst = (nextRst + 1) & 7;
      marker = false;
      pred.fill(0);
    } else if (marker) {
      return fail(t('the data ends early'), mcus);
    }
  }
  return { ok: true, mcus, expected, left: data.length - pos };
}

/**
 * Where a scan's entropy-coded data ends: the next marker that is not a stuffed byte or a
 * restart marker. { at: its first FF, marker, rsts, inOrder }, or at -1 when none comes first:
 * with `blank` set to where the data gave out -- a run of more than FILL_MAX bytes of 0xFF, or
 * blank space as findUntilBlank() tells it -- and without it when `limit` came first.
 */
function ecsEnd(cur, from, limit) {
  let q = from;
  let rsts = 0;
  let next = 0;
  let inOrder = true;
  for (;;) {
    const f = findUntilBlank(cur, FF, q, limit);
    if (f.at < 0) return f.blank != null ? { at: -1, blank: f.blank, rsts, inOrder } : { at: -1, rsts, inOrder };
    const i = f.at;
    let j = i + 1;
    let n = cur.byte(j);
    while (n === 0xff && j < limit && j - i <= FILL_MAX) n = cur.byte(++j);
    if (n === 0xff && j - i > FILL_MAX) return { at: -1, blank: i, rsts, inOrder };
    if (n < 0 || j >= limit) return { at: -1, rsts, inOrder };
    if (n === 0x00) {
      q = j + 1;
      continue;
    }
    if (n >= 0xd0 && n <= 0xd7) {
      if ((n & 7) !== next) inOrder = false;
      next = ((n & 7) + 1) & 7;
      rsts++;
      q = j + 1;
      continue;
    }
    return { at: i, marker: n, rsts, inOrder };
  }
}

/** CIPA DC-007 Multi-Picture Format: every image the MP Index lists, from the MPF TIFF header. */
function mpfEntries(buf) {
  const T = tiffReader((pos, n) => (pos >= 0 && pos + n <= buf.length ? buf.subarray(pos, pos + n) : null));
  if (!T) return null;
  const ifd = T.ifd(T.first);
  if (!ifd) return null;
  const count = ifd.entries.find((e) => e.tag === 0xb001);
  const list = ifd.entries.find((e) => e.tag === 0xb002);
  const n = count ? T.values(count, 1)[0] : 0;
  if (!n || !list || list.size !== 16 * n || n > 64) return null;
  const b = buf.subarray(list.at, list.at + list.size);
  if (b.length !== list.size) return null;
  const u32 = (o) => (T.le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const out = [];
  for (let i = 0; i < n; i++) out.push({ size: u32(i * 16 + 4), offset: u32(i * 16 + 8) });
  return out;
}

function jpeg(cur, start, o, nested = false) {
  if (cur.byte(start) !== 0xff || cur.byte(start + 1) !== 0xd8 || cur.byte(start + 2) !== 0xff) return null;
  const hit = newHit('jpeg', start);
  const x = hit._;
  const limit = Math.min(cur.limit, start + MAX_LENGTH.jpeg);
  const tables = { dc: [], ac: [] };
  const apps = [];
  let frame = null;
  let restart = 0;
  let p = start + 2;
  let end = -1;
  let scans = 0;
  let decoded = 0;
  let hasDht = false;
  let exif = null;
  let mpf = null;
  // Where the data gave out into erased or rewritten space, when it did.
  let blank = false;
  const scanned = new Set();
  const cutShort = () => {
    hit.problems.push(limit < cur.limit
      ? t('no end within {0} MiB, the most a JPEG is taken to be', MAX_LENGTH.jpeg / MIB)
      : t('it runs past the end of what was searched: the rest is missing'));
  };
  for (;;) {
    if (cur.byte(p) !== 0xff) {
      if (p >= limit) cutShort();
      else hit.problems.push(t('no marker where one belongs, at +{0}', p - start));
      break;
    }
    const markerAt = p;
    while (cur.byte(p) === 0xff && p - markerAt <= FILL_MAX) p++;
    if (p - markerAt > FILL_MAX) {
      blank = true;
      p = markerAt;
      break;
    }
    const m = cur.byte(p);
    p++;
    if (m < 0 || p > limit) {
      cutShort();
      p = markerAt;
      break;
    }
    if (m === 0xd9) {
      end = p;
      break;
    }
    if (m === 0x01) continue;
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x00) {
      hit.problems.push(t('an unexpected marker FF{0} at +{1}', hex2(m), markerAt - start));
      p = markerAt;
      break;
    }
    const len = cur.u16be(p);
    const seg = len >= 2 ? cur.bytes(p + 2, len - 2) : null;
    if (len < 2 || !seg || p + len > limit) {
      if (len >= 2 && !seg) cutShort();
      else hit.problems.push(t('a segment of impossible length at +{0}', markerAt - start));
      p = markerAt;
      break;
    }
    const segAt = p + 2;
    p += len;
    if (m >= 0xe0 && m <= 0xef) {
      const id = seg.toString('latin1', 0, Math.min(seg.length, 5)).replace(/\0.*$/s, '');
      apps.push(`${m - 0xe0}:${id}`);
      if (m === 0xe1 && seg.length > 14 && seg.toString('latin1', 0, 6) === 'Exif\0\0') {
        exif = { info: exifInfo(seg.subarray(6)), tiffAt: segAt + 6, segEnd: segAt + seg.length };
      } else if (m === 0xe2 && !nested && seg.length > 12 && seg.toString('latin1', 0, 4) === 'MPF\0') {
        mpf = { list: mpfEntries(seg.subarray(4)), headerAt: segAt + 4 };
      }
    } else if (m === 0xdb) {
      let q = 0;
      while (q < seg.length && (seg[q] >> 4) <= 1 && (seg[q] & 15) <= 3) q += 1 + 64 * ((seg[q] >> 4) + 1);
      if (q !== seg.length) {
        hit.problems.push(t('its quantization tables (DQT) do not add up'));
        break;
      }
    } else if (m === 0xc4) {
      let q = 0;
      let bad = false;
      while (q < seg.length && !bad) {
        const tc = seg[q] >> 4;
        const th = seg[q] & 15;
        if (tc > 1 || th > 3 || q + 17 > seg.length) {
          bad = true;
          break;
        }
        const counts = [...seg.subarray(q + 1, q + 17)];
        const n = counts.reduce((a, b) => a + b, 0);
        const table = n <= 256 && q + 17 + n <= seg.length ? huffTable(counts, seg.subarray(q + 17, q + 17 + n)) : null;
        if (!table) bad = true;
        else (tc ? tables.ac : tables.dc)[th] = table;
        q += 17 + n;
      }
      if (bad || q !== seg.length) {
        hit.problems.push(t('its Huffman tables (DHT) do not add up'));
        break;
      }
      hasDht = true;
    } else if (m === 0xdd) {
      if (seg.length !== 2) {
        hit.problems.push(t('its restart interval (DRI) does not add up'));
        break;
      }
      restart = seg.readUInt16BE(0);
    } else if (isSof(m)) {
      const n = seg.length >= 6 ? seg[5] : 0;
      const f = { sof: m, precision: seg[0], height: n ? seg.readUInt16BE(1) : 0, width: n ? seg.readUInt16BE(3) : 0, comps: [] };
      for (let i = 0; i < n && 8 + i * 3 < seg.length; i++) {
        f.comps.push({ id: seg[6 + i * 3], h: seg[7 + i * 3] >> 4, v: seg[7 + i * 3] & 15, tq: seg[8 + i * 3] });
      }
      const lossless = LOSSLESS.has(m);
      if (frame || !n || n > 4 || seg.length !== 6 + 3 * n || !f.width
        || (lossless ? f.precision < 2 || f.precision > 16 : f.precision !== 8 && f.precision !== 12)
        || f.comps.some((c) => c.h < 1 || c.h > 4 || c.v < 1 || c.v > 4 || c.tq > 3)) {
        hit.problems.push(t('its frame header (SOF) does not add up'));
        break;
      }
      frame = f;
      hit.width = f.width;
      hit.height = f.height || null;
    } else if (m === 0xda) {
      const ns = seg[0];
      if (!frame || !ns || ns > 4 || seg.length !== 1 + 2 * ns + 3) {
        hit.problems.push(frame ? t('a scan header (SOS) does not add up') : t('a scan (SOS) comes before the frame header'));
        break;
      }
      const scan = { comps: [] };
      for (let i = 0; i < ns; i++) scan.comps.push({ id: seg[1 + 2 * i], td: seg[2 + 2 * i] >> 4, ta: seg[2 + 2 * i] & 15 });
      if (scan.comps.some((c) => !frame.comps.some((f) => f.id === c.id) || c.td > 3 || c.ta > 3)) {
        hit.problems.push(t('a scan names a component the frame does not have'));
        break;
      }
      for (const c of scan.comps) scanned.add(c.id);
      const ecs = ecsEnd(cur, p, limit);
      scans++;
      const sequential = frame.sof === 0xc0 || frame.sof === 0xc1;
      if (ecs.at < 0) {
        // Cut short, or given out into erased space. What is left of the scan is decoded, to say
        // how much of the picture is there.
        if (ecs.blank != null) blank = true;
        else cutShort();
        const dataEnd = trimZeros(cur, p, ecs.blank != null ? ecs.blank : limit, o.budget);
        if (sequential && o.decode !== false && frame.height && dataEnd - p <= o.budget) {
          const data = cur.bytes(p, dataEnd - p);
          const w = data ? walkScan(data, frame, scan, tables, restart) : null;
          if (w && !w.ok && w.atEnd) {
            hit.checks.push(t('scan {0}: its first {1} of {2} MCUs decode, up to where its data stops', scans, w.mcus, w.expected));
            hit.info.decodedMcus = w.mcus;
            hit.info.mcus = w.expected;
          } else if (w && !w.ok) {
            hit.problems.push(t('scan {0}: {1} after {2} of {3} MCUs', scans, w.why, w.mcus, w.expected));
          }
        }
        p = dataEnd;
        break;
      }
      if (!ecs.inOrder) hit.problems.push(t('scan {0}: its restart markers are out of turn', scans));
      if (sequential && o.decode !== false && ecs.at - p <= o.budget) {
        const data = cur.bytes(p, ecs.at - p);
        const w = data && frame.height ? walkScan(data, frame, scan, tables, restart) : null;
        if (!w) {
          // A height given later by DNL: the scan is followed, not decoded.
        } else if (!w.ok) {
          hit.problems.push(t('scan {0}: {1} after {2} of {3} MCUs', scans, w.why, w.mcus, w.expected));
        } else if (w.left > 8) {
          hit.problems.push(t('scan {0}: {1} bytes of data after its last MCU', scans, w.left));
        } else {
          decoded++;
          hit.checks.push(t('scan {0}: all {1} MCUs decode', scans, w.mcus));
          if (ecs.rsts) hit.checks.push(t('scan {0}: {1} restart markers in turn', scans, ecs.rsts));
        }
      }
      p = ecs.at;
      if (ecs.marker === 0xd8) {
        hit.problems.push(t('another image starts at +{0}, inside this one\'s data', ecs.at - start));
        break;
      }
    }
    // Anything else -- COM, DNL, DHP, EXP, DAC, the JPG extensions -- is a segment to step over.
  }

  // What the bytes say this JPEG is, whether it is whole or not.
  if (frame && LOSSLESS.has(frame.sof)) {
    x.drop = 'raw';
    hit.embedded = t('a lossless JPEG stream: the sensor data inside a camera RAW file, not a picture of its own');
  } else if (apps.some((a) => a === '0:AVI1') || (frame && !hasDht && !(frame.sof >= 0xc9))) {
    x.drop = 'frames';
    hit.embedded = t('a frame of a Motion JPEG video');
  } else if (!apps.length) {
    hit.embedded = t('it has none of the header segments a camera or an editor writes (APP0 to APP15), as a preview '
      + 'kept inside a camera RAW or another file has none');
  }
  if (frame) {
    hit.info.coding = LOSSLESS.has(frame.sof) ? 'lossless' : PROGRESSIVE.has(frame.sof) ? 'progressive'
      : frame.sof >= 0xc9 ? 'arithmetic' : frame.sof === 0xc1 ? 'extended' : 'baseline';
    hit.info.components = frame.comps.length;
  }
  if (exif) {
    const ex = exif.info;
    if (ex.make) hit.info.make = ex.make;
    if (ex.model) hit.info.model = ex.model;
    takeExifTime(hit, ex);
    const th = ex.thumbnail;
    if (th && !nested) {
      const at = exif.tiffAt + th.offset;
      if (at + th.length <= exif.segEnd) {
        mark(hit, at, 'preview');
        const small = jpeg(new Cursor(cur.reader, at + th.length), at, o, true);
        if (small && small.complete && small._.usable) hit.info.thumbnail = publicHit(small);
      }
    }
  }
  if (!frame || !scans) {
    // Headers and nothing to show: worth only the thumbnail they may hold.
    if (!hit.problems.length) hit.problems.push(t('it holds headers but no image data'));
    x.usable = false;
    hit.length = Math.max(p, start + 2) - start;
    if (hit.info.thumbnail && !nested) offerThumbnail(hit);
    return hit;
  }
  if (frame.comps.some((c) => !scanned.has(c.id)) && end >= 0) {
    hit.problems.push(t('its scans leave out a component of the image'));
  }

  if (end < 0) {
    // Cut short: the image data may run on into space that has been zeroed since. That is not
    // part of it.
    hit.length = trimZeros(cur, start + 2, Math.max(p, start + 2), o.budget) - start;
    if (blank) {
      hit.problems.push(t('its data stops at +{0}, where the space after it was erased or written over: the rest is '
        + 'missing', hit.length));
    }
    x.claimEnd = start + hit.length;
    if (hit.info.thumbnail && !nested) offerThumbnail(hit);
    return hit;
  }
  hit.checks.unshift(t('from SOI to EOI, every segment in place, {0} scan(s)', scans));
  if (hit.info.coding === 'progressive' || hit.info.coding === 'arithmetic') {
    hit.caveats.push(t('its {0} scan(s) are followed but not decoded ({1} coding), so foreign data inside them would '
      + 'go unnoticed', scans, hit.info.coding));
  } else if (decoded === scans) {
    hit.caveats.push(t('JPEG has no checksum: on real photos, 3 to 12 in 100 foreign pieces of 512 bytes put into '
      + 'the image data still decoded, so a file stored in pieces can pass'));
  } else if (!hit.problems.length && o.decode !== false) {
    hit.caveats.push(t('its image data is longer than one file\'s checks read, and was not decoded'));
  }
  let fileEnd = end;
  let verified = !hit.problems.length;
  let pictureEnd = end;

  // MPF: the other images the index lists, stored one after another behind the first.
  if (mpf && mpf.list) {
    let found = 0;
    for (let i = 1; i < mpf.list.length; i++) {
      const e = mpf.list[i];
      const at = mpf.headerAt + e.offset;
      const other = at >= end && e.size ? jpeg(new Cursor(cur.reader, at + e.size), at, o, true) : null;
      if (!other || !other.complete || other.length !== e.size) {
        hit.problems.push(t('the Multi-Picture index lists an image at +{0} that is not whole there', at - start));
        verified = false;
        break;
      }
      found++;
      fileEnd = Math.max(fileEnd, at + e.size);
    }
    if (found && found === mpf.list.length - 1) hit.checks.push(t('Multi-Picture Format: all {0} further image(s) whole', found));
    pictureEnd = fileEnd;
  }
  // A motion photo's video after the picture: straight after it, as Google's cameras append it,
  // or after the mark Samsung's put first.
  const after = nested ? null : cur.bytes(fileEnd, MOTION_MARK.length + 8);
  const lead = after && after.subarray(0, MOTION_MARK.length).equals(MOTION_MARK) ? MOTION_MARK.length : 0;
  if (after && after.toString('latin1', lead + 4, lead + 8) === 'ftyp') {
    const video = bmff(cur, fileEnd + lead, o);
    if (video && video._.usable) {
      hit.info.motionPhoto = { offset: fileEnd + lead - start, length: video.length };
      if (video.complete) hit.checks.push(t('a motion photo: the video after the picture checks out'));
      else hit.problems.push(...video.problems.map((pr) => t('its motion photo\'s video: {0}', pr)));
      // The video and what lies inside it are the photo's.
      mark(hit, fileEnd + lead, 'part');
      for (const [at, what] of video._.pointers) mark(hit, at, what);
      fileEnd += lead + video.length;
    }
  }
  hit.length = fileEnd - start;
  hit.complete = !hit.problems.length;
  hit.tail = t('anything the file held after the picture\'s end, as some phones append, is not included');
  // Every segment and every scan is in place up to EOI (and each MPF image's), so a picture found
  // inside is this one's own: its thumbnail. A motion photo's video is not checked that closely.
  x.verifiedEnd = verified ? pictureEnd : start;
  x.claimEnd = fileEnd;
  if (!hit.complete && hit.info.thumbnail && !nested) offerThumbnail(hit);
  return hit;
}

/** Where [from, to) stops holding anything but zeros at its end, reading back at most `budget`. */
function trimZeros(cur, from, to, budget) {
  let end = to;
  while (end > from && to - end < budget) {
    const n = Math.min(WINDOW, end - from);
    const b = cur.bytes(end - n, n);
    if (!b) return to;
    let i = b.length - 1;
    while (i >= 0 && b[i] === 0) i--;
    if (i >= 0) return end - n + i + 1;
    end -= n;
  }
  return end;
}

/** A damaged photo's own thumbnail, offered as a smaller copy. */
function offerThumbnail(hit) {
  const th = hit.info.thumbnail;
  hit._.children.push({
    ...th, derived: true, embedded: null, parent: { type: hit.type, offset: hit.offset },
    caveats: [t('the small preview a camera keeps inside a photo; the photo itself, found at {0}, is damaged', hit.offset),
      ...th.caveats],
  });
}

// ---------------------------------------------------------------- PNG (ISO/IEC 15948)

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

/** How many bytes of filtered rows a PNG's image data inflates to. */
function pngRowBytes(w, h, bitsPerPixel, interlace) {
  const rows = (pw, ph) => (pw && ph ? ph * (1 + Math.ceil((pw * bitsPerPixel) / 8)) : 0);
  if (!interlace) return rows(w, h);
  return ADAM7.reduce((sum, [x0, y0, dx, dy]) => sum + rows(Math.ceil((w - x0) / dx), Math.ceil((h - y0) / dy)), 0);
}

function png(cur, start, o) {
  const sig = cur.bytes(start, 8);
  if (!sig || !sig.equals(PNG_SIG)) return null;
  const hit = newHit('png', start);
  const limit = Math.min(cur.limit, start + MAX_LENGTH.png);
  let p = start + 8;
  let chunks = 0;
  let ihdr = null;
  let ended = false;
  let idatDone = false;
  let idatBytes = 0;
  const idat = [];
  while (!ended) {
    const len = cur.u32be(p);
    const type = cur.bytes(p + 4, 4);
    if (len < 0 || !type) {
      hit.problems.push(t('it runs past the end of what was searched: the rest is missing'));
      break;
    }
    const name = type.toString('latin1');
    if (len > 0x7fffffff || !/^[A-Za-z]{4}$/.test(name)) {
      hit.problems.push(t('no chunk where one belongs, at +{0}', p - start));
      break;
    }
    if (p + 12 + len > limit) {
      hit.problems.push(t('the chunk at +{0} runs past the end of what was searched', p - start));
      break;
    }
    const body = cur.bytes(p + 4, 4 + len);
    const crc = cur.u32be(p + 8 + len);
    if (!body || crc < 0 || crc32(body) !== crc) {
      hit.problems.push(t('the CRC-32 of chunk {0} at +{1} does not match', name, p - start));
      break;
    }
    chunks++;
    if (chunks === 1) {
      if (name !== 'IHDR' || len !== 13) {
        hit.problems.push(t('the first chunk is not IHDR'));
        break;
      }
      ihdr = { width: body.readUInt32BE(4), height: body.readUInt32BE(8), depth: body[12], color: body[13], interlace: body[16] };
      if (!ihdr.width || !ihdr.height || !(PNG_DEPTHS[ihdr.color] || []).includes(ihdr.depth) || body[14] || body[15]
        || ihdr.interlace > 1) {
        hit.problems.push(t('its header (IHDR) does not add up'));
        break;
      }
      hit.width = ihdr.width;
      hit.height = ihdr.height;
    }
    if (name === 'IDAT') {
      if (idatDone) hit.problems.push(t('its image data (IDAT) is split by other chunks'));
      idatBytes += len;
      if (idatBytes <= o.budget) idat.push(Buffer.from(body.subarray(4)));
    } else if (idat.length || idatBytes) {
      idatDone = true;
    }
    if (name === 'tIME' && len === 7) {
      const b = body.subarray(4);
      const ms = wallClock(b.readUInt16BE(0), b[2], b[3], b[4], b[5], b[6], 0);
      setTime(hit, ms, t('the PNG tIME chunk: when the image was last changed'));
    } else if (name === 'eXIf') {
      takeExifTime(hit, exifInfo(body.subarray(4)));
    }
    if (name === 'acTL') hit.info.animated = true;
    p += 12 + len;
    if (name === 'IEND') ended = true;
  }
  if (!ihdr) return null;
  hit.length = p - start;
  if (!idatBytes) {
    if (ended) hit.problems.push(t('it has no image data (IDAT)'));
    hit._.usable = false;
    return hit;
  }
  if (!ended) {
    hit._.claimEnd = p;
    return hit;
  }
  hit.checks.push(t('all {0} chunks from IHDR to IEND match their CRC-32', chunks));
  const want = pngRowBytes(ihdr.width, ihdr.height, PNG_CHANNELS[ihdr.color] * ihdr.depth, ihdr.interlace);
  let inflated = false;
  if (idatBytes > o.budget || want > o.budget) {
    hit.caveats.push(t('its image data is larger than one file\'s checks read, and was not inflated'));
  } else {
    try {
      const raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: want + 1 });
      if (raw.length !== want) {
        hit.problems.push(t('its image data inflates to {0} bytes where its rows need {1}', raw.length, want));
      } else {
        inflated = true;
        hit.checks.push(t('the image data inflates, its Adler-32 matches, and it is exactly as long as the rows need'));
      }
    } catch (e) {
      hit.problems.push(e.code === 'ERR_BUFFER_TOO_LARGE'
        ? t('its image data inflates to more than its rows need')
        : t('its image data does not inflate: {0}', e.message));
    }
  }
  hit.complete = !hit.problems.length;
  hit.selfChecked = hit.complete && inflated;
  hit.tail = t('a carve ends at IEND: anything the file held after it is not included');
  hit._.verifiedEnd = hit.complete ? p : start;
  hit._.claimEnd = p;
  return hit;
}

// ---------------------------------------------------------------- GIF (GIF89a)

/**
 * Decodes GIF LZW codes for their lengths only, never their pixels: how many pixels come out,
 * and whether any code is one the table cannot hold yet.
 */
function lzwPixels(data, minSize) {
  const clear = 1 << minSize;
  const eoi = clear + 1;
  const len = new Uint16Array(4096);
  for (let i = 0; i < clear; i++) len[i] = 1;
  let size = minSize + 1;
  let next = eoi + 1;
  let prev = -1;
  let out = 0;
  let acc = 0;
  let accBits = 0;
  let i = 0;
  for (;;) {
    while (accBits < size && i < data.length) {
      acc |= data[i++] << accBits;
      accBits += 8;
    }
    if (accBits < size) return { ok: true, out, ended: false };
    const code = acc & ((1 << size) - 1);
    acc >>>= size;
    accBits -= size;
    if (code === clear) {
      size = minSize + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) return { ok: true, out, ended: true };
    let l;
    if (prev < 0) {
      if (code >= clear) return { ok: false, out };
      l = 1;
    } else if (code < next) {
      l = len[code];
    } else if (code === next) {
      l = len[prev] + 1;
    } else {
      return { ok: false, out };
    }
    if (prev >= 0 && next < 4096) {
      len[next] = Math.min(4096, len[prev] + 1);
      next++;
      if (next === 1 << size && size < 12) size++;
    }
    out += l;
    prev = code;
  }
}

function gif(cur, start, o) {
  const h = cur.bytes(start, 13);
  if (!h || !/^GIF8[79]a$/.test(h.toString('latin1', 0, 6))) return null;
  const hit = newHit('gif', start);
  hit.width = h.readUInt16LE(6);
  hit.height = h.readUInt16LE(8);
  if (!hit.width || !hit.height) return null;
  const limit = Math.min(cur.limit, start + MAX_LENGTH.gif);
  let p = start + 13;
  if (h[10] & 0x80) p += 3 * (1 << ((h[10] & 7) + 1));
  let images = 0;
  // Images with anything to show: pixels that decode, or data too long to decode here.
  let shown = 0;
  let decodedAll = true;
  let ended = false;
  const runsOff = () => hit.problems.push(t('it runs past the end of what was searched: the rest is missing'));
  /**
   * The sub-blocks from q to their terminator: { end, data, total }, and `cut` when they run past
   * the end of what was searched -- then with as much of their data as is there.
   */
  const subBlocks = (q, keep) => {
    const parts = [];
    let total = 0;
    const done = (cut) => ({ end: q, data: keep ? Buffer.concat(parts) : null, total, cut });
    for (;;) {
      const n = q < limit ? cur.byte(q) : -1;
      if (n < 0) return done(true);
      q++;
      if (n === 0) return done(false);
      const there = Math.min(n, limit - q);
      if (keep && total + n <= o.budget) {
        const b = cur.bytes(q, there);
        if (b) parts.push(b);
      }
      total += n;
      if (there < n) {
        q = limit;
        return done(true);
      }
      q += n;
    }
  };
  while (!ended) {
    const b = cur.byte(p);
    if (b === 0x3b) {
      p++;
      ended = true;
    } else if (b === 0x21) {
      const labelByte = cur.byte(p + 1);
      const first = cur.byte(p + 2);
      if ((labelByte === 0xf9 && first !== 4) || (labelByte === 0xff && first !== 11) || (labelByte === 0x01 && first !== 12)) {
        hit.problems.push(t('an extension block at +{0} does not add up', p - start));
        break;
      }
      const r = subBlocks(p + 2, false);
      p = r.end;
      if (r.cut) {
        runsOff();
        break;
      }
    } else if (b === 0x2c) {
      const d = cur.bytes(p, 10);
      if (!d || !d.readUInt16LE(5) || !d.readUInt16LE(7)) {
        if (d) hit.problems.push(t('an image descriptor at +{0} does not add up', p - start));
        else runsOff();
        break;
      }
      p += 10;
      if (d[9] & 0x80) p += 3 * (1 << ((d[9] & 7) + 1));
      const min = cur.byte(p);
      if (min < 0) {
        runsOff();
        break;
      }
      if (min < 2 || min > 8) {
        hit.problems.push(t('image {0} has an LZW code size of {1}', images + 1, min));
        break;
      }
      const r = subBlocks(p + 1, true);
      p = r.end;
      images++;
      const pixels = d.readUInt16LE(5) * d.readUInt16LE(7);
      if (r.total > o.budget) {
        decodedAll = false;
        shown++;
        if (!r.cut) continue;
        runsOff();
        break;
      }
      const lzw = lzwPixels(r.data, min);
      const got = Math.min(lzw.out, pixels);
      if (got) shown++;
      if (!lzw.ok) {
        hit.problems.push(t('image {0}: an LZW code the table cannot hold, after {1} of {2} pixels', images, got, pixels));
        break;
      }
      if (r.cut) {
        // What is there of the image still shows its first rows.
        runsOff();
        if (got) hit.checks.push(t('image {0}: its first {1} of {2} pixels decode, up to where its data stops', images, got, pixels));
        break;
      }
      if (lzw.out < pixels) {
        hit.problems.push(t('image {0}: its data stops after {1} of {2} pixels', images, lzw.out, pixels));
        break;
      }
    } else {
      if (b < 0) runsOff();
      else hit.problems.push(t('no block where one belongs, at +{0}', p - start));
      break;
    }
  }
  hit.length = p - start;
  if (!shown) {
    if (!hit.problems.length) hit.problems.push(t('it holds no image'));
    hit._.usable = false;
    return hit;
  }
  hit.info.frames = images;
  if (!ended) {
    hit._.claimEnd = p;
    return hit;
  }
  hit.checks.push(t('{0} image(s) and their sub-block chains, up to the trailer', images));
  if (decodedAll) hit.checks.push(t('every image\'s LZW data decodes to as many pixels as it has'));
  else hit.caveats.push(t('an image is larger than one file\'s checks read, and was not decoded'));
  hit.caveats.push(t('GIF has no checksum'));
  hit.complete = !hit.problems.length;
  hit._.verifiedEnd = hit.complete && decodedAll ? p : start;
  hit._.claimEnd = p;
  return hit;
}

// ---------------------------------------------------------------- BMP

const DIB_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

function bmp(cur, start) {
  const h = cur.bytes(start, 54);
  if (!h || h[0] !== 0x42 || h[1] !== 0x4d) return null;
  const fileSize = h.readUInt32LE(2);
  const offBits = h.readUInt32LE(10);
  const dib = h.readUInt32LE(14);
  if (h.readUInt32LE(6) !== 0 || !DIB_SIZES.has(dib) || offBits < 14 + dib || offBits > fileSize) return null;
  let width;
  let height;
  let bpp;
  let compression = 0;
  let colors = 0;
  if (dib === 12) {
    width = h.readUInt16LE(18);
    height = h.readUInt16LE(20);
    if (h.readUInt16LE(22) !== 1) return null;
    bpp = h.readUInt16LE(24);
  } else {
    width = h.readInt32LE(18);
    height = Math.abs(h.readInt32LE(22));
    if (h.readUInt16LE(26) !== 1) return null;
    bpp = h.readUInt16LE(28);
    compression = h.readUInt32LE(30);
    colors = h.readUInt32LE(46);
  }
  if (width <= 0 || width > 65535 || !height || height > 65535 || ![1, 4, 8, 16, 24, 32].includes(bpp) || compression > 6) return null;
  const palette = bpp <= 8 ? (colors || 1 << bpp) * (dib === 12 ? 3 : 4) : 0;
  if (offBits < 14 + dib + (dib === 12 ? palette : 0)) return null;
  const hit = newHit('bmp', start);
  hit.width = width;
  hit.height = height;
  // Uncompressed rows are padded to 4 bytes; compressed data has only the file size to go by.
  const rows = Math.ceil((width * bpp) / 32) * 4 * height;
  if ((compression === 0 || compression === 3 || compression === 6) && (fileSize < offBits + rows || fileSize > offBits + rows + 4096)) {
    return null;
  }
  hit.length = Math.min(fileSize, cur.limit - start);
  if (start + fileSize > cur.limit) {
    hit.problems.push(t('it runs past the end of what was searched: the rest is missing'));
  } else {
    hit.checks.push(t('its header agrees with itself: size, pixel offset and rows'));
    hit.caveats.push(t('a bitmap has no checksum, and only its header could be checked'));
    hit.complete = true;
  }
  hit._.claimEnd = start + fileSize;
  return hit;
}

// ---------------------------------------------------------------- RIFF: AVI, WAV, WebP

const FOURCC = /^[\x20-\x7e]{4}$/;

/**
 * Walks chunks from `from` to `to`, and the chunks inside every LIST: each must have a printable
 * id and a size that fits, and together they must reach `to` exactly (or one byte short or past,
 * for the pad byte of an odd last chunk). `visit(id, at, size, listType)` sees each one. When what
 * was searched ends at `cut`, inside the RIFF, a chunk that runs past it is visited too, and the
 * chunks of a LIST as far as they are there. Stops early when the budget is spent. Returns
 * { ok, at, count, partial, cut }, `cut` when the walk ended where what was searched does.
 */
function tileRiff(cur, from, to, depth, visit, stopAt, cut = Infinity) {
  let q = from;
  let count = 0;
  while (q + 8 <= to) {
    const hdr = cur.bytes(q, 8);
    if (!hdr) return { ok: false, at: q, count };
    const id = hdr.toString('latin1', 0, 4);
    const size = hdr.readUInt32LE(4);
    const end = q + 8 + size;
    // Past `to` is a chunk that does not fit, unless `to` is where what was searched ends.
    const runsOff = end > to;
    if (!FOURCC.test(id) || (runsOff && to < cut)) return { ok: false, at: q, count };
    count++;
    if (id === 'LIST' && depth < 4 && size >= 4 && q + 12 <= to) {
      const listType = cur.bytes(q + 8, 4).toString('latin1');
      visit(id, q, size, listType);
      const inner = tileRiff(cur, q + 12, Math.min(end, to), depth + 1, visit, stopAt, cut);
      count += inner.count;
      if (!inner.ok || inner.partial) return { ...inner, count };
    } else {
      visit(id, q, size, null);
    }
    if (runsOff) return { ok: false, at: to, count, cut: true };
    q = end + (size & 1);
    if (cur.spent > stopAt) return { ok: true, at: q, count, partial: true };
  }
  if (q < to && to >= cut) return { ok: false, at: q, count, cut: true };
  return { ok: q === to || q === to + 1, at: q, count };
}

// A video stream's chunk in an AVI's movi list: "00dc", "01db", ...
const AVI_VIDEO_CHUNK = /^[0-9a-f]{2}d[bc]$/i;

function riff(cur, start, o) {
  const h = cur.bytes(start, 20);
  if (!h || h.toString('latin1', 0, 4) !== 'RIFF') return null;
  const form = h.toString('latin1', 8, 12);
  const type = { 'AVI ': 'avi', WAVE: 'wav', WEBP: 'webp' }[form];
  const size = h.readUInt32LE(4);
  if (!type || size < 12 || !FOURCC.test(h.toString('latin1', 12, 16))) return null;
  const hit = newHit(type, start);
  const seen = {};
  const stopAt = cur.spent + o.budget;
  let p = start;
  let pieces = 0;
  let declaredEnd = start;
  let count = 0;
  let partial = false;
  let cut = false;
  let broken = false;
  // An OpenDML AVI goes on as RIFF 'AVIX' pieces, back to back.
  for (;;) {
    const hh = cur.bytes(p, 12);
    if (!hh || hh.toString('latin1', 0, 4) !== 'RIFF' || hh.toString('latin1', 8, 12) !== (pieces ? 'AVIX' : form)) break;
    const n = hh.readUInt32LE(4);
    const body = p + 8 + n;
    if (n < 4) break;
    pieces++;
    declaredEnd = body + (n & 1);
    const r = tileRiff(cur, p + 12, Math.min(body, cur.limit), 0, visit, stopAt, body > cur.limit ? cur.limit : Infinity);
    count += r.count;
    if (!r.ok && !r.cut) {
      hit.problems.push(t('its chunks stop fitting together at +{0}', r.at - start));
      broken = true;
    }
    if (body > cur.limit) {
      hit.problems.push(t('RIFF {0} runs past the end of what was searched: the rest is missing', pieces > 1 ? 'AVIX' : form));
      cut = true;
      p = cur.limit;
      break;
    }
    p = body + (n & 1);
    if (broken) break;
    if (r.partial) {
      partial = true;
      break;
    }
    if (type !== 'avi') break;
  }
  function visit(id, at, n, listType) {
    const key = listType ? `LIST ${listType}` : id;
    if (!seen[key]) seen[key] = [];
    if (seen[key].length < 64) seen[key].push({ at, size: n });
    // A video frame's data: a Motion JPEG frame found there is this video's.
    if (type === 'avi' && AVI_VIDEO_CHUNK.test(id)) mark(hit, at + 8, 'frame');
  }
  if (!pieces) return null;
  // A pad byte the last chunk needs may be missing at the very end of the file.
  hit.length = Math.min(p, cur.limit) - start;
  const read = (key, i, len) => (seen[key] && seen[key][i] ? cur.bytes(seen[key][i].at + 8, Math.min(len, seen[key][i].size)) : null);

  if (type === 'avi') {
    const avih = read('avih', 0, 56);
    if (!seen['LIST hdrl'] || !avih || avih.length < 40) hit.problems.push(t('no AVI header list (hdrl)'));
    if (!seen['LIST movi']) hit.problems.push(t('no movie data list (movi): the frames are missing'));
    if (avih && avih.length >= 40) {
      hit.width = avih.readUInt32LE(32) || null;
      hit.height = avih.readUInt32LE(36) || null;
      const frames = avih.readUInt32LE(16);
      const us = avih.readUInt32LE(0);
      if (frames && us) hit.info.seconds = Math.round((frames * us) / 1e6);
    }
    for (let i = 0; seen.strh && i < seen.strh.length; i++) {
      const strh = read('strh', i, 8);
      if (strh && strh.toString('latin1', 0, 4) === 'vids') hit.info.codec = strh.toString('latin1', 4, 8).replace(/\0/g, '');
    }
    const idit = read('IDIT', 0, 64);
    if (idit) setTime(hit, iditTime(idit.toString('latin1')), t('the AVI header: when the video was made, by the camera\'s clock'));
    if (pieces > 1) hit.info.pieces = pieces;
  } else if (type === 'wav') {
    const fmt = read('fmt ', 0, 16);
    if (!fmt || fmt.length < 16) hit.problems.push(t('no format chunk (fmt)'));
    if (!seen.data) hit.problems.push(t('no data chunk: the sound is missing'));
    if (fmt && fmt.length >= 16 && seen.data && fmt.readUInt32LE(8)) {
      hit.info.seconds = Math.round(seen.data[0].size / fmt.readUInt32LE(8));
    }
  } else {
    const image = ['VP8 ', 'VP8L', 'ANMF'].find((k) => seen[k] || (k === 'ANMF' && seen.ANIM));
    if (!image) hit.problems.push(t('no image chunk'));
    const vp8x = read('VP8X', 0, 10);
    const vp8 = read('VP8 ', 0, 10);
    const vp8l = read('VP8L', 0, 5);
    if (vp8x && vp8x.length === 10) {
      hit.width = vp8x.readUIntLE(4, 3) + 1;
      hit.height = vp8x.readUIntLE(7, 3) + 1;
    } else if (vp8 && vp8.length === 10 && vp8[3] === 0x9d && vp8[4] === 0x01 && vp8[5] === 0x2a) {
      hit.width = vp8.readUInt16LE(6) & 0x3fff;
      hit.height = vp8.readUInt16LE(8) & 0x3fff;
    } else if (vp8l && vp8l.length === 5 && vp8l[0] === 0x2f) {
      const bits = vp8l.readUInt32LE(1);
      hit.width = (bits & 0x3fff) + 1;
      hit.height = ((bits >> 14) & 0x3fff) + 1;
    }
    const ex = seen.EXIF ? cur.bytes(seen.EXIF[0].at + 8, Math.min(seen.EXIF[0].size, SMALL)) : null;
    if (ex) takeExifTime(hit, exifInfo(ex.toString('latin1', 0, 6) === 'Exif\0\0' ? ex.subarray(6) : ex));
  }
  if (!count) return null;
  // With the frames, the sound or the picture gone, there is nothing to offer.
  hit._.usable = type === 'avi' ? !!seen['LIST movi'] : type === 'wav' ? !!seen.data : !!(seen['VP8 '] || seen.VP8L || seen.ANMF);
  if (hit.problems.length && !hit._.usable) hit.problems.push(t('what is left of it holds nothing to play or show'));
  if (partial) {
    hit.checks.unshift(t('the first {0} chunks, down to those inside every list, fit together; the rest lie beyond '
      + 'what one file\'s checks read', count));
  } else if (cut && !broken) {
    hit.checks.unshift(t('{0} chunks, down to those inside every list, fit together up to where it is cut off', count));
  } else if (!broken) {
    hit.checks.unshift(t('{0} chunks, down to those inside every list, tile the RIFF exactly', count));
  }
  if (pieces > 1 && !partial && !broken) hit.checks.push(t('{0} OpenDML pieces back to back', pieces));
  hit.complete = !hit.problems.length;
  if (type === 'wav') hit.caveats.push(t('only its structure is checked: the sound inside has no checksum'));
  else if (type === 'webp') hit.caveats.push(t('only its structure is checked: the image data inside has no checksum'));
  else hit.caveats.push(t('only its structure is checked: the frames inside are not decoded'));
  hit.tail = t('anything the file held after the RIFF structure ends is not included');
  // Tiling chunks says nothing of the bytes inside one: a newer file may have been written there.
  hit._.claimEnd = Math.max(declaredEnd, start + hit.length);
  return hit;
}

// ---------------------------------------------------------------- ASF: WMV, WMA

const GUID = {
  header: '3026b2758e66cf11a6d900aa0062ce6c',
  data: '3626b2758e66cf11a6d900aa0062ce6c',
  fileProps: 'a1dcab8c47a9cf118ee400c00c205365',
  streamProps: '9107dcb7b7a9cf118ee600c00c205365',
  video: 'c0ef19bc4d5bcf11a8fd00805f5c442b',
};
const ASF_INDEXES = new Set([
  '90080033b1e5cf1189f400a0c90349cb', // Simple Index
  'd329e2d6da35d111903400a0c90349be', // Index
  'f803b1fead12644c840f2a1d2f7ad48c', // Media Object Index
  'd03fb73c4a0c0348953dedf7b6228f0c', // Timecode Index
]);

function asf(cur, start, o) {
  const h = cur.bytes(start, 30);
  if (!h || h.toString('hex', 0, 16) !== GUID.header) return null;
  const hsize = Number(h.readBigUInt64LE(16));
  const nobj = h.readUInt32LE(24);
  if (hsize < 30 + 24 || nobj > 1000) return null;
  const hit = newHit('wmv', start);
  let fp = null;
  let video = false;
  for (let q = start + 30, i = 0; i < nobj && q + 24 <= start + hsize; i++) {
    const obj = cur.bytes(q, 24);
    if (!obj) break;
    const osz = cur.u64le(q + 16);
    const g = obj.toString('hex', 0, 16);
    if (g === GUID.fileProps) fp = cur.bytes(q + 24, 80);
    if (g === GUID.streamProps) {
      // The stream type, then for video, past 54 bytes of fields, the encoded picture's size.
      const kind = cur.bytes(q + 24, 16);
      const dims = cur.bytes(q + 78, 8);
      if (kind && kind.toString('hex') === GUID.video) {
        video = true;
        if (dims && !hit.width) {
          hit.width = dims.readUInt32LE(0) || null;
          hit.height = dims.readUInt32LE(4) || null;
        }
      }
    }
    if (osz < 24) break;
    q += osz;
  }
  if (!fp || fp.length < 80) return null;
  if (!video) {
    hit.type = 'wma';
    hit.ext = FORMATS.wma.ext;
    hit.mediaType = FORMATS.wma.mediaType;
  }
  const fileSize = Number(fp.readBigUInt64LE(16));
  const broadcast = (fp.readUInt32LE(64) & 1) === 1;
  const packets = Number(fp.readBigUInt64LE(32));
  const minPacket = fp.readUInt32LE(68);
  const maxPacket = fp.readUInt32LE(72);
  const duration = Number(fp.readBigUInt64LE(40)) / 1e7 - Number(fp.readBigUInt64LE(56)) / 1000;
  if (duration > 0) hit.info.seconds = Math.round(duration);
  setTime(hit, fileTime(fp.readBigUInt64LE(24)), t('the file properties: when the video was made'));

  let p = start;
  let data = null;
  const stopAt = cur.spent + o.budget;
  while (p + 24 <= cur.limit) {
    const obj = cur.bytes(p, 24);
    const g = obj.toString('hex', 0, 16);
    const sz = cur.u64le(p + 16);
    if ((p === start) !== (g === GUID.header) || (g !== GUID.header && g !== GUID.data && !ASF_INDEXES.has(g)) || sz < 24) break;
    if (g === GUID.data) data = { at: p, size: sz };
    if (p + sz > cur.limit) {
      hit.problems.push(t('an object runs past the end of what was searched: the rest is missing'));
      p = cur.limit;
      break;
    }
    p += sz;
  }
  hit.length = p - start;
  if (!data) {
    hit.problems.push(t('no data object: the stream itself is missing'));
    hit._.usable = hit.length > hsize;
    return hit;
  }
  hit.checks.push(t('its objects follow one another by their sizes'));
  if (!broadcast) {
    if (fileSize === hit.length) hit.checks.push(t('it ends exactly at the file size its header records'));
    else if (!hit.problems.length) hit.problems.push(t('its objects end at {0} bytes, while its header records {1}', hit.length, fileSize));
  }
  // Fixed-size packets: the data object holds exactly as many as the header counts, and each one
  // starts with the same error-correction byte, 0x82, where that is used.
  if (minPacket && minPacket === maxPacket && data.at + data.size <= cur.limit) {
    if (data.size !== 50 + packets * minPacket) {
      hit.problems.push(t('its data object does not hold the {0} packets of {1} bytes its header counts', packets, minPacket));
    } else if (cur.byte(data.at + 50) === 0x82) {
      let bad = -1;
      let i = 0;
      for (; i < packets && cur.spent <= stopAt; i++) {
        if (cur.byte(data.at + 50 + i * minPacket) !== 0x82) {
          bad = i;
          break;
        }
      }
      if (bad >= 0) hit.problems.push(t('packet {0} of {1} does not start where a packet starts', bad + 1, packets));
      else if (i === packets) hit.checks.push(t('all {0} data packets start where their size puts them', packets));
      else hit.caveats.push(t('{0} of {1} data packets checked; the rest lie beyond what one file\'s checks read', i, packets));
    }
  }
  hit.caveats.push(t('only its structure is checked: the frames inside are not decoded'));
  hit.complete = !hit.problems.length;
  hit._.claimEnd = start + Math.max(hit.length, broadcast ? 0 : fileSize);
  return hit;
}

// ---------------------------------------------------------------- ISO BMFF: MP4, MOV, 3GP, HEIC, AVIF, CR3

const BMFF_TOP = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'uuid', 'meta', 'pnot', 'PICT', 'udta',
  'moof', 'mfra', 'sidx', 'ssix', 'styp', 'pdin', 'prft', 'emsg', 'junk', 'Xtra']);
// A QuickTime movie from before ftyp starts with one of these; it is taken only with a moov and an mdat.
const QT_FIRST = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);
const BOX_TYPE = /^[\x20-\x7e]{4}$/;

/** A box header at `p`: { at, type, size, header, end, open }, or null. */
function boxAt(cur, p, limit) {
  const h = cur.bytes(p, 8);
  if (!h) return null;
  const type = h.toString('latin1', 4, 8);
  if (!BOX_TYPE.test(type)) return null;
  let size = h.readUInt32BE(0);
  let header = 8;
  if (size === 1) {
    const b = cur.bytes(p + 8, 8);
    if (!b) return null;
    size = Number(b.readBigUInt64BE(0));
    header = 16;
  } else if (size === 0) {
    return { at: p, type, size: limit - p, header, end: limit, open: true };
  }
  if (size < header || !Number.isSafeInteger(size)) return null;
  return { at: p, type, size, header, end: p + size, open: false };
}

/** The boxes inside a buffer between `from` and `to`, as far as they fit. */
function boxesIn(buf, from, to) {
  const out = [];
  let p = from;
  while (p + 8 <= to) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1 && p + 16 <= to) {
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) {
      size = to - p;
    }
    if (size < header || p + size > to || !BOX_TYPE.test(type)) break;
    out.push({ type, at: p, size, header, body: p + header, end: p + size });
    p += size;
  }
  return out;
}

const childOf = (buf, box, type, skip = 0) => boxesIn(buf, box.body + skip, box.end).find((b) => b.type === type);
function pathOf(buf, box, types) {
  let b = box;
  for (const type of types) {
    b = b && childOf(buf, b, type);
  }
  return b || null;
}

/** Unsigned big-endian number of `n` bytes, n up to 8. */
function readN(buf, at, n) {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + buf[at + i];
  return v;
}

/** Whether NAL units with `lenSize`-byte lengths tile [at, at+size) exactly, forbidden bits clear. */
function nalTiles(cur, at, size, lenSize) {
  let q = 0;
  while (q < size) {
    if (q + lenSize + 1 > size) return false;
    const b = cur.bytes(at + q, lenSize + 1);
    if (!b) return false;
    const l = readN(b, 0, lenSize);
    if (!l || b[lenSize] & 0x80) return false;
    q += lenSize + l;
  }
  return q === size;
}

/** Whether AV1 OBUs tile [at, at+size) exactly (the last may run to the end without a size). */
function obuTiles(cur, at, size) {
  let q = 0;
  while (q < size) {
    const h = cur.byte(at + q);
    if (h < 0 || h & 0x81) return false;
    let p = q + 1 + ((h >> 2) & 1);
    if (!((h >> 1) & 1)) return true;
    let v = 0;
    let mul = 1;
    for (let i = 0; ; i++) {
      const b = cur.byte(at + p);
      if (b < 0 || i >= 8) return false;
      p++;
      v += (b & 0x7f) * mul;
      mul *= 128;
      if (!(b & 0x80)) break;
    }
    q = p + v;
  }
  return q === size;
}

function bmffKind(major, compat, video, audio) {
  const all = [major, ...compat];
  const as = (type, ext, mediaType) => ({ type, ext: ext || FORMATS[type].ext, mediaType: mediaType || FORMATS[type].mediaType });
  if (major === 'crx ') return as('cr3');
  if (major === 'avif' || major === 'avis' || ((major === 'mif1' || major === 'msf1') && all.includes('avif'))) return as('avif');
  if (HEIC_BRANDS.has(major) || major === 'mif1' || major === 'msf1') {
    return as('heif', all.some((b) => HEIC_BRANDS.has(b)) ? '.heic' : '.heif');
  }
  const soundOnly = !video && audio;
  if (!major || major === 'qt  ') return as('mov', '.mov', soundOnly ? 'audio' : 'video');
  if (major.startsWith('3g2')) return as('3gp', '.3g2', soundOnly ? 'audio' : 'video');
  if (major.startsWith('3g')) return as('3gp', '.3gp', soundOnly ? 'audio' : 'video');
  if (major === 'M4V ' || major === 'M4VH' || major === 'M4VP') return as('m4v');
  if (major === 'M4A ' || major === 'M4B ' || major === 'M4P ') return as('m4a', major === 'M4B ' ? '.m4b' : '.m4a');
  if (major === 'f4v ') return as('mp4', '.f4v');
  return soundOnly ? as('m4a') : as('mp4');
}

function bmff(cur, start, o) {
  const first = boxAt(cur, start, cur.limit);
  if (!first) return null;
  const ftyp = first.type === 'ftyp';
  if (ftyp ? first.size < 16 || first.size > 4096 : !QT_FIRST.has(first.type)) return null;
  const top = [];
  let p = start;
  let problem = null;
  let open = false;
  const has = (type) => top.some((b) => b.type === type);
  while (p < cur.limit) {
    const b = boxAt(cur, p, cur.limit);
    if (!b || !BMFF_TOP.has(b.type) || (b.type === 'ftyp' && p !== start)) break;
    // A second moov, or a wide box once a movie is whole, begins the next file.
    if ((b.type === 'moov' && has('moov')) || (b.type === 'wide' && has('moov') && has('mdat'))) break;
    top.push(b);
    if (b.end > cur.limit) {
      problem = t('its {0} box runs past the end of what was searched: the rest is missing', b.type);
      p = cur.limit;
      break;
    }
    p = b.end;
    if (b.open) {
      open = true;
      break;
    }
  }
  if (!ftyp && !(has('moov') && has('mdat'))) return null;
  const end = p;
  let major = null;
  const compat = [];
  if (ftyp) {
    const f = cur.bytes(start + 8, first.size - 8);
    major = f.toString('latin1', 0, 4);
    for (let i = 8; i + 4 <= f.length; i += 4) compat.push(f.toString('latin1', i, i + 4));
  }
  const moov = top.find((b) => b.type === 'moov');
  const meta = top.find((b) => b.type === 'meta');
  const mdats = top.filter((b) => b.type === 'mdat').map((b) => [b.at + b.header, Math.min(b.end, cur.limit)]);
  const heifBrand = ftyp && (HEIC_BRANDS.has(major) || ['mif1', 'msf1', 'avif', 'avis'].includes(major));

  const facts = { video: false, audio: false };
  const hit = newHit('mp4', start);
  hit.length = end - start;
  // A box after the first is this file's own: a movie seen from its second box on is no movie.
  for (const b of top.slice(1)) mark(hit, b.at, 'part');
  if (problem) hit.problems.push(problem);
  if (open) hit.problems.push(t('its last box runs "to the end of the file": its length is not recorded'));
  hit.checks.push(t('top-level boxes by their sizes: {0}', top.map((b) => b.type.trim()).join(' ')));
  // The JPEGs it keeps of itself: thumbnails and cover pictures in its movie header, previews in
  // uuid boxes as Canon's CR3 has them, and samples that are pictures (moovCheck).
  const spots = [];
  if (moov) moovCheck(cur, start, moov, mdats, hit, facts, o, spots);
  for (const b of top) {
    if (b.type !== 'uuid' || b.size > 16 * MIB || b.end > cur.limit) continue;
    for (const i of jpegStarts(cur.bytes(b.at, b.size))) spots.push([b.at + i, b.end - b.at - i]);
  }
  if (heifBrand && meta) heifCheck(cur, start, end, meta, hit, o);
  else if (heifBrand) hit.problems.push(t('no meta box: the item table is missing'));
  if (!moov && !heifBrand) hit.problems.push(t('no moov box: the recording was cut off, or its end was lost'));
  if (moov && !mdats.length) hit.problems.push(t('no mdat box: the media data is missing'));
  if (top.some((b) => b.type === 'moof')) {
    hit.caveats.push(t('it is made of movie fragments, whose samples are not checked'));
  }
  const kind = bmffKind(major, compat, facts.video, facts.audio);
  hit.type = kind.type;
  hit.ext = kind.ext;
  hit.mediaType = kind.mediaType;
  if (major) hit.info.brand = major.trim();
  if (kind.type === 'cr3') offerPreview(hit, cur, spots, o);
  else for (const [at] of spots) mark(hit, at, 'preview');
  hit.complete = !hit.problems.length;
  hit._.usable = top.length > 1 || hit.complete;
  hit._.claimEnd = top.length ? Math.max(end, top[top.length - 1].end) : end;
  return hit;
}

/**
 * Checks a movie header's tracks against the media data, and adds to `spots` -- [offset, the most
 * it can be long] -- the JPEGs it keeps: inside the header itself, and as the first samples of a
 * track whose samples are not otherwise checked, as a CR3's full-size picture is.
 */
function moovCheck(cur, start, moov, mdats, hit, facts, o, spots) {
  if (moov.size > 64 * MIB || moov.end > cur.limit) {
    if (moov.end <= cur.limit) hit.caveats.push(t('its movie header is too large to check'));
    return;
  }
  const buf = cur.bytes(moov.at, moov.size);
  for (const i of jpegStarts(buf)) spots.push([moov.at + i, moov.size - i]);
  const root = { body: moov.header, end: moov.size };
  const mvhd = childOf(buf, root, 'mvhd');
  if (mvhd && mvhd.size >= 8 + 20) {
    const v = buf[mvhd.body];
    const created = v === 1 ? Number(buf.readBigUInt64BE(mvhd.body + 4)) : buf.readUInt32BE(mvhd.body + 4);
    const scale = v === 1 ? buf.readUInt32BE(mvhd.body + 20) : buf.readUInt32BE(mvhd.body + 12);
    const dur = v === 1 && mvhd.size >= 8 + 32 ? Number(buf.readBigUInt64BE(mvhd.body + 24)) : buf.readUInt32BE(mvhd.body + 16);
    setTime(hit, macTime(created), t('the movie header: when the video was made (UTC, though some cameras write local time)'));
    if (scale && dur) hit.info.seconds = Math.round(dur / scale);
  }
  const inMdat = (a, z) => mdats.some(([s, e]) => a >= s && z <= e);
  const stopAt = cur.spent + o.budget;
  let samples = 0;
  let outside = 0;
  let tiled = 0;
  let broken = 0;
  let unchecked = 0;
  let codable = 0;
  let nalTracks = 0;
  const codecs = [];
  for (const trak of boxesIn(buf, root.body, root.end).filter((b) => b.type === 'trak')) {
    const hdlr = pathOf(buf, trak, ['mdia', 'hdlr']);
    const handler = hdlr && hdlr.size >= 8 + 12 ? buf.toString('latin1', hdlr.body + 8, hdlr.body + 12) : '?';
    if (handler === 'vide') facts.video = true;
    if (handler === 'soun') facts.audio = true;
    const tkhd = childOf(buf, trak, 'tkhd');
    if (handler === 'vide' && tkhd && tkhd.size >= 8 + 84) {
      hit.width = hit.width || buf.readUInt32BE(tkhd.end - 8) >>> 16 || null;
      hit.height = hit.height || buf.readUInt32BE(tkhd.end - 4) >>> 16 || null;
    }
    const stbl = pathOf(buf, trak, ['mdia', 'minf', 'stbl']);
    if (!stbl) continue;
    const kid = Object.fromEntries(boxesIn(buf, stbl.body, stbl.end).map((b) => [b.type, b]));
    if (!kid.stsz || !kid.stsc || !(kid.stco || kid.co64)) {
      if (kid.stz2) {
        hit.caveats.push(t('a track with compact sample sizes (stz2), which are not checked'));
      } else if (!kid.stsz && !kid.stco && !kid.co64) {
        continue;
      } else {
        hit.problems.push(t('a {0} track without its sample tables', handler));
      }
      continue;
    }
    const stsz = kid.stsz;
    const co = kid.stco || kid.co64;
    const wide = !kid.stco;
    if (stsz.size < 20 || kid.stsc.size < 16 || co.size < 16) {
      hit.problems.push(t('a {0} track whose sample tables do not add up', handler));
      continue;
    }
    const fixed = buf.readUInt32BE(stsz.body + 4);
    const n = buf.readUInt32BE(stsz.body + 8);
    const runsN = buf.readUInt32BE(kid.stsc.body + 4);
    const nc = buf.readUInt32BE(co.body + 4);
    if ((!fixed && stsz.body + 12 + 4 * n > stsz.end) || kid.stsc.body + 8 + 12 * runsN > kid.stsc.end
      || co.body + 8 + (wide ? 8 : 4) * nc > co.end) {
      hit.problems.push(t('a {0} track whose sample tables do not add up', handler));
      continue;
    }
    const sizeOf = (i) => fixed || buf.readUInt32BE(stsz.body + 12 + 4 * i);
    const offsetOf = (i) => (wide ? Number(buf.readBigUInt64BE(co.body + 8 + 8 * i)) : buf.readUInt32BE(co.body + 8 + 4 * i));
    // What the samples hold, for the tracks whose samples can be checked.
    const stsd = kid.stsd;
    const fmt = stsd && stsd.size >= 8 + 16 ? buf.toString('latin1', stsd.body + 12, stsd.body + 16) : '';
    if (fmt) codecs.push(fmt.trim());
    let lenSize = 0;
    let jpegs = false;
    if (fmt === 'avc1' || fmt === 'avc3' || fmt === 'hvc1' || fmt === 'hev1') {
      const conf = buf.indexOf(fmt.startsWith('avc') ? 'avcC' : 'hvcC', stsd.body + 16, 'latin1');
      const at = conf + 4;
      if (conf > 0 && conf < stsd.end && (fmt.startsWith('avc') ? at + 5 : at + 22) <= stsd.end) {
        lenSize = (buf[fmt.startsWith('avc') ? at + 4 : at + 21] & 3) + 1;
      }
    } else if (fmt === 'jpeg' || fmt === 'mjpa') {
      jpegs = true;
    }
    if (handler === 'vide' && (lenSize || jpegs)) codable++;
    if (lenSize) nalTracks++;
    let s = 0;
    let pictures = 0;
    for (let c = 0; c < nc && s < n; c++) {
      let per = 0;
      for (let r = 0; r < runsN; r++) {
        if (buf.readUInt32BE(kid.stsc.body + 8 + 12 * r) - 1 <= c) per = buf.readUInt32BE(kid.stsc.body + 12 + 12 * r);
        else break;
      }
      let at = start + offsetOf(c);
      for (let k = 0; k < per && s < n; k++, s++) {
        const z = sizeOf(s);
        // A Motion JPEG frame found here is this video's.
        if (jpegs) mark(hit, at, 'frame');
        if (!inMdat(at, at + z)) {
          outside++;
        } else if ((lenSize || jpegs) && z) {
          if (cur.spent > stopAt) {
            unchecked++;
          } else if (lenSize ? nalTiles(cur, at, z, lenSize) : (cur.bytes(at, 3) || EMPTY).equals(SOI)) {
            tiled++;
          } else {
            broken++;
          }
        } else if (z > 64 && pictures < 16 && (cur.bytes(at, 3) || EMPTY).equals(SOI)) {
          // A sample that is a picture of its own, in a track not otherwise checked.
          pictures++;
          spots.push([at, z]);
        }
        at += z;
      }
    }
    samples += s;
    if (s !== n) hit.problems.push(t('its {0} track\'s chunk table covers {1} of its {2} samples', handler, s, n));
  }
  if (codecs.length) hit.info.codecs = [...new Set(codecs)];
  if (outside) hit.problems.push(t('{0} sample(s) lie outside every mdat', outside));
  else if (samples) hit.checks.push(t('all {0} samples lie inside the media data', samples));
  if (broken) {
    hit.problems.push(t('{0} video sample(s) are not what their track says they hold', broken));
  } else if (tiled) {
    hit.checks.push(t('all {0} video samples checked hold what their track says (NAL unit lengths, or JPEG starts)', tiled));
    hit.caveats.push(nalTracks
      ? t('what the NAL units hold is not decoded, so a foreign piece lying wholly inside one would go unnoticed')
      : t('of each Motion JPEG frame only its start is checked'));
  }
  if (unchecked) {
    hit.caveats.push(t('{0} of {1} video samples checked; the rest lie beyond what one file\'s checks read', tiled + broken, tiled + broken + unchecked));
  }
  if (facts.video && !codable) {
    hit.caveats.push(t('its video codec ({0}) is not checked: only where the samples lie is', (hit.info.codecs || ['?']).join(', ')));
  }
  if (!facts.video) {
    hit.caveats.push(t('only where its samples lie is checked, not what they hold'));
  }
}

function heifCheck(cur, start, end, meta, hit, o) {
  if (meta.size > 16 * MIB || meta.end > cur.limit) {
    return;
  }
  const buf = cur.bytes(meta.at, meta.size);
  const root = { body: meta.header + 4, end: meta.size };
  const kids = boxesIn(buf, root.body, root.end);
  const box = (type) => kids.find((b) => b.type === type);
  const iloc = box('iloc');
  const iinf = box('iinf');
  if (!iloc) {
    hit.problems.push(t('no item locations (iloc)'));
    return;
  }
  // Item types, from iinf's infe boxes (version 2 and 3).
  const types = new Map();
  if (iinf) {
    const skip = buf[iinf.body] === 0 ? 6 : 8;
    for (const infe of boxesIn(buf, iinf.body + skip, iinf.end).filter((b) => b.type === 'infe')) {
      const v = buf[infe.body];
      if (v === 2 && infe.size >= 8 + 12) types.set(buf.readUInt16BE(infe.body + 4), buf.toString('latin1', infe.body + 8, infe.body + 12));
      if (v === 3 && infe.size >= 8 + 14) types.set(buf.readUInt32BE(infe.body + 4), buf.toString('latin1', infe.body + 10, infe.body + 14));
    }
  }
  // Properties: pixel size from ispe, NAL length size from hvcC.
  const ipco = pathOf(buf, box('iprp') || null, ['ipco']);
  let lenSize = 0;
  for (const prop of ipco ? boxesIn(buf, ipco.body, ipco.end) : []) {
    if (prop.type === 'ispe' && prop.size >= 8 + 12) {
      const w = buf.readUInt32BE(prop.body + 4);
      const h = buf.readUInt32BE(prop.body + 8);
      if (w * h > (hit.width || 0) * (hit.height || 0)) {
        hit.width = w;
        hit.height = h;
      }
    }
    if (prop.type === 'hvcC' && prop.size >= 8 + 22 && !lenSize) lenSize = (buf[prop.body + 21] & 3) + 1;
  }
  // iloc: every item's extents, by version.
  const b = buf;
  let q = iloc.body;
  const v = b[q];
  const offSize = b[q + 4] >> 4;
  const lengthSize = b[q + 4] & 15;
  const baseSize = b[q + 5] >> 4;
  const idxSize = v >= 1 ? b[q + 5] & 15 : 0;
  q += 6;
  const rd = (n) => {
    if (q + n > iloc.end) throw new RangeError('iloc');
    const x = readN(b, q, n);
    q += n;
    return x;
  };
  let extents = 0;
  let outside = 0;
  let coded = 0;
  let good = 0;
  let unchecked = 0;
  const stopAt = cur.spent + o.budget;
  try {
    const count = v < 2 ? rd(2) : rd(4);
    for (let i = 0; i < count; i++) {
      const id = v < 2 ? rd(2) : rd(4);
      const method = v >= 1 ? rd(2) & 15 : 0;
      rd(2);
      const base = rd(baseSize);
      const ne = rd(2);
      const list = [];
      for (let e = 0; e < ne; e++) {
        if (idxSize) rd(idxSize);
        list.push([base + rd(offSize), rd(lengthSize)]);
      }
      extents += ne;
      if (method !== 0) continue;
      for (const [off, len] of list) if (!len || start + off + len > end || off < 0) outside++;
      const type = types.get(id);
      if (list.length !== 1 || !list[0][1] || start + list[0][0] + list[0][1] > end) continue;
      const [off, len] = list[0];
      if (type === 'Exif' && len <= SMALL) {
        const ex = cur.bytes(start + off, len);
        const skip = ex && ex.length >= 4 ? ex.readUInt32BE(0) + 4 : -1;
        if (skip >= 4 && skip < len) {
          const info = exifInfo(ex.subarray(skip));
          takeExifTime(hit, info);
          if (info.thumbnail) mark(hit, start + off + skip + info.thumbnail.offset, 'preview');
        }
      } else if ((type === 'hvc1' && lenSize) || type === 'av01') {
        coded++;
        if (cur.spent > stopAt) unchecked++;
        else if (type === 'hvc1' ? nalTiles(cur, start + off, len, lenSize) : obuTiles(cur, start + off, len)) good++;
      } else if (type === 'jpeg') {
        // A JPEG item -- a thumbnail, say -- is this file's own picture.
        mark(hit, start + off, 'preview');
      }
    }
  } catch (_) {
    hit.problems.push(t('its item locations (iloc) do not add up'));
    return;
  }
  if (outside) hit.problems.push(t('{0} of {1} item extents lie outside the file', outside, extents));
  else hit.checks.push(t('all {0} item extents lie inside the file', extents));
  if (coded && good === coded) {
    hit.checks.push(t('all {0} coded items tile exactly into NAL units or OBUs', coded));
    hit.caveats.push(t('what the NAL units or OBUs hold is not decoded, so a foreign piece lying wholly inside one would go unnoticed'));
  } else if (coded - good - unchecked > 0) {
    hit.problems.push(t('{0} of {1} coded items are not what their type says they hold', coded - good - unchecked, coded));
  }
  if (unchecked) hit.caveats.push(t('{0} of {1} coded items checked; the rest lie beyond what one file\'s checks read', coded - unchecked, coded));
  if (!coded) hit.caveats.push(t('no item is coded in a way that is checked here'));
}

// ---------------------------------------------------------------- TIFF and camera RAW

// The camera makers whose RAW files are a TIFF inside, by the Make tag, as types.js tells them.
// Olympus and Panasonic mark theirs with a signature of their own instead, Canon's CR2 has "CR"
// after the header, and a DNG has a tag of its own; a plain TIFF from any other camera stays one.
const RAW_BY_MAKE = [
  [/^nikon/i, '.nef'], [/^sony/i, '.arw'], [/^(pentax|ricoh)/i, '.pef'], [/^samsung/i, '.srw'],
  [/^hasselblad/i, '.3fr'], [/^kodak/i, '.dcr'], [/^(seiko )?epson/i, '.erf'], [/^leaf/i, '.mos'],
  [/^phase one/i, '.iiq'],
];
const RAW_SIGNATURES = { IIRO: '.orf', IIRS: '.orf', MMOR: '.orf', 'IIU\0': '.rw2' };

/**
 * Offers the largest whole picture among a RAW file's own previews as a smaller copy of it -- a
 * RAW cannot be shown as it is -- and remembers each one as the file's own, for scan(). `spots`
 * are [offset, the most it can be long] of the JPEGs the file's structure points at.
 */
function offerPreview(hit, cur, spots, o) {
  let best = null;
  for (const [at, most] of spots) {
    mark(hit, at, 'preview');
    const pv = most > 64 ? jpeg(new Cursor(cur.reader, Math.min(cur.limit, at + most)), at, o, true) : null;
    if (pv && pv.complete && pv._.usable && !pv._.drop && (!best || pv.width * pv.height > best.width * best.height)) best = pv;
  }
  if (!best) return;
  hit._.children = [{
    ...publicHit(best), derived: true, embedded: null, parent: { type: hit.type, offset: hit.offset },
    caveats: [t('the preview a {0} file keeps of itself, at {1}x{2}', label(hit), best.width, best.height), ...best.caveats],
  }];
}

function tiff(cur, start, o) {
  const h = cur.bytes(start, 12);
  if (!h) return null;
  const sig = h.toString('latin1', 0, 4);
  const special = RAW_SIGNATURES[sig];
  if (sig !== 'II*\0' && sig !== 'MM\0*' && !special) return null;
  const T = tiffReader((pos, n) => cur.bytes(start + pos, n));
  if (!T || T.first < 8 || T.first >= cur.limit - start) return null;
  const hit = newHit('tiff', start);
  const x = hit._;
  let fileEnd = 8;
  let past = 0;
  let ifds = 0;
  let make = null;
  let dng = false;
  let dateTime = null;
  let original = null;
  let offset = null;
  const jpegs = [];
  const queue = [T.first];
  const visited = new Set();
  const size = cur.limit - start;
  while (queue.length && ifds < 64) {
    const at = queue.shift();
    if (!at || visited.has(at)) continue;
    visited.add(at);
    const ifd = T.ifd(at);
    if (!ifd || ifd.known < ifd.entries.length * 0.8) {
      if (!ifds) return null;
      hit.problems.push(t('a directory at +{0} is not one', at));
      continue;
    }
    ifds++;
    fileEnd = Math.max(fileEnd, ifd.end);
    const tag = (n) => ifd.entries.find((e) => e.tag === n);
    const num = (n) => { const e = tag(n); return e ? T.values(e, 1)[0] : undefined; };
    for (const e of ifd.entries) {
      if (!e.inline && e.size < 2 * GIB) {
        if (e.at + e.size > size) past++;
        else fileEnd = Math.max(fileEnd, e.at + e.size);
      }
    }
    // Strips, tiles and JPEGs: where the image data is.
    for (const [offTag, lenTag] of [[0x0111, 0x0117], [0x0144, 0x0145], [0x0201, 0x0202]]) {
      const offs = tag(offTag) ? T.values(tag(offTag)) : [];
      const lens = tag(lenTag) ? T.values(tag(lenTag)) : [];
      for (let i = 0; i < offs.length && i < lens.length; i++) {
        if (offs[i] + lens[i] > size) past++;
        else fileEnd = Math.max(fileEnd, offs[i] + lens[i]);
      }
      if (offs.length === 1 && lens.length === 1 && (offTag === 0x0201 || [6, 7].includes(num(0x0103)))) {
        jpegs.push({ offset: offs[0], length: lens[0] });
      }
    }
    const w = num(0x0100);
    const hgt = num(0x0101);
    if (w && hgt && w * hgt > (hit.width || 0) * (hit.height || 0)) {
      hit.width = w;
      hit.height = hgt;
    }
    for (const e of ifd.entries) {
      if (e.tag === 0x010f) make = make || T.ascii(e);
      else if (e.tag === 0x0132) dateTime = dateTime || T.ascii(e);
      else if (e.tag === 0x9003) original = original || T.ascii(e);
      else if (e.tag === 0x9011) offset = offset || T.ascii(e);
      else if (e.tag === 0xc612) dng = true;
      else if ([0x014a, 0x8769, 0x8825, 0xa005].includes(e.tag)) queue.push(...T.values(e, 64));
    }
    if (ifd.next) queue.push(ifd.next);
  }
  if (!ifds || (!hit.width && !make)) return null;
  // What kind of file: CR2 marks itself, DNG has a version tag, the rest are told by their maker.
  if (sig === 'II*\0' && h.toString('latin1', 8, 10) === 'CR' && h[10] === 2) hit.ext = '.cr2';
  else if (special) hit.ext = special;
  else if (dng) hit.ext = '.dng';
  else if (make) hit.ext = (RAW_BY_MAKE.find(([re]) => re.test(make)) || [null, '.tif'])[1];
  if (make) hit.info.make = make;
  takeExifTime(hit, { original, offset, dateTime });
  hit.length = Math.min(fileEnd, size);
  if (past) hit.problems.push(t('{0} piece(s) of its data lie past the end of what was searched', past));
  else hit.checks.push(t('{0} directories, and all the data they point to, inside the file', ifds));
  // Its previews: pictures kept inside it, found where its directories say.
  offerPreview(hit, cur, jpegs.filter((j) => start + j.offset + j.length <= cur.limit).map((j) => [start + j.offset, j.length]), o);
  if (hit.ext !== '.tif') hit.info.raw = true;
  hit.caveats.push(t('the image data of a TIFF or camera RAW file is not checked: only where it lies is known'));
  hit.tail = t('data only a maker\'s own notes point to may lie after the end taken here, and is then lost');
  hit.complete = !hit.problems.length;
  // A RAW's data is not checked, so what lies inside it may be a newer file; its previews are its own.
  x.claimEnd = start + hit.length;
  return hit;
}

// ---------------------------------------------------------------- PDF

const PDF_EOF = Buffer.from('%%EOF', 'latin1');

function pdf(cur, start) {
  const h = cur.bytes(start, 8);
  if (!h || !/^%PDF-[12]\.\d$/.test(h.toString('latin1'))) return null;
  const hit = newHit('pdf', start);
  const limit = Math.min(cur.limit, start + MAX_LENGTH.pdf);
  let from = start + 8;
  let end = -1;
  let ends = 0;
  for (;;) {
    const e = findUntilBlank(cur, PDF_EOF, from, limit).at;
    if (e < 0) break;
    let after = e + 5;
    if (cur.byte(after) === 0x0d) after++;
    if (cur.byte(after) === 0x0a) after++;
    from = after;
    // startxref and the offset of the cross-reference, which must be there.
    const back = Math.max(start, e - 48);
    const m = /startxref\s+(\d+)\s*$/.exec(cur.bytes(back, e - back).toString('latin1'));
    const at = m ? start + Number(m[1]) : -1;
    const there = at >= start && at < e ? cur.bytes(at, 24) : null;
    if (!there || !/^(xref|\d+\s+\d+\s+obj)/.test(there.toString('latin1'))) continue;
    end = after;
    ends++;
    // An incremental update, or the rest of a linearized file, goes on with an object or a table.
    const next = cur.bytes(after, 32);
    if (!next || !/^\s*(\d+\s+\d+\s+obj|xref|%)/.test(next.toString('latin1'))) break;
  }
  if (end < 0) {
    hit._.usable = false;
    return hit;
  }
  hit.length = end - start;
  hit.checks.push(t('it ends at %%EOF, with startxref pointing at a cross-reference'));
  if (ends > 1) hit.checks.push(t('{0} sections, each ending that way', ends));
  hit.caveats.push(t('a PDF has no checksum over its contents, and they are not checked'));
  hit.tail = t('anything the file held after its last %%EOF is not included');
  hit.complete = true;
  hit._.claimEnd = end;
  return hit;
}

// ---------------------------------------------------------------- ZIP, and the documents built on it

const PK_LOCAL = 0x04034b50;
const PK_CENTRAL = 0x02014b50;
const PK_END = 0x06054b50;
const PK_END_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
// What ODF, EPUB and HWPX name themselves in a first, uncompressed entry called "mimetype".
const ODF = {
  'application/vnd.oasis.opendocument.text': '.odt', 'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/vnd.oasis.opendocument.presentation': '.odp', 'application/vnd.oasis.opendocument.graphics': '.odg',
  'application/epub+zip': '.epub', 'application/hwp+zip': '.hwpx',
};

/**
 * What a ZIP is by the names of its members and its "mimetype", by the rules types.js tells a
 * ZIP's first bytes by: { ext, mediaType }. A document of a kind not named here keeps '.zip'.
 */
function zipKind(names, mime) {
  const any = (re) => names.some((n) => re.test(n));
  const doc = (ext) => ({ ext, mediaType: 'document' });
  if (ODF[mime]) return doc(ODF[mime]);
  if (mime.startsWith('application/vnd.oasis.opendocument.')) return doc('.zip');
  if (any(/^word\//)) return doc('.docx');
  if (any(/^xl\//)) return doc('.xlsx');
  if (any(/^ppt\//)) return doc('.pptx');
  if (any(/^visio\//)) return doc('.vsdx');
  if (any(/^Contents\/section\d+\.xml$/)) return doc('.hwpx');
  if (any(/^\[Content_Types\]\.xml$/)) return doc('.zip');
  if (any(/^AndroidManifest\.xml$|^classes\d*\.dex$/)) return { ext: '.apk', mediaType: 'archive' };
  if (any(/^META-INF\/MANIFEST\.MF$/)) return { ext: '.jar', mediaType: 'archive' };
  return { ext: '.zip', mediaType: 'archive' };
}

/**
 * Tells scan() what lies inside a ZIP: each further member's local header is a part of it, and
 * the data of a member stored as it is -- a picture, say -- is known by the member's name. In a
 * document or an app, a member was made part of it; in an archive, it is a file someone put there.
 */
function markMembers(hit, start, members) {
  const inside = hit.mediaType === 'document' || hit.ext === '.apk' || hit.ext === '.jar';
  for (const [at, m] of members) {
    if (at !== start) mark(hit, at, 'part');
    if (m.method === 0 && m.csize > 0) mark(hit, m.data, { member: m.name, inside });
  }
}

function zip(cur, start, o) {
  const h = cur.bytes(start, 30);
  if (!h || h.readUInt32LE(0) !== PK_LOCAL) return null;
  const nlen = h.readUInt16LE(26);
  if (h.readUInt16LE(4) > 100 || !nlen || nlen > 1024) return null;
  const hit = newHit('zip', start);
  const limit = Math.min(cur.limit, start + MAX_LENGTH.zip);
  // Each member's local header, by where it is: its name, how it is stored, and where its data is.
  const members = new Map();
  const local = (at) => {
    if (members.has(at)) return members.get(at);
    const l = cur.bytes(at, 30);
    if (!l || l.readUInt32LE(0) !== PK_LOCAL) return null;
    const nl = l.readUInt16LE(26);
    const m = {
      name: (cur.bytes(at + 30, nl) || EMPTY).toString('utf8'), flags: l.readUInt16LE(6), method: l.readUInt16LE(8),
      csize: l.readUInt32LE(18), data: at + 30 + nl + l.readUInt16LE(28),
    };
    members.set(at, m);
    return m;
  };
  const mimeOf = () => {
    const m = members.get(start);
    return m && m.name === 'mimetype' && m.method === 0 ? (cur.bytes(m.data, Math.min(m.csize, 64)) || EMPTY).toString('latin1').trim() : '';
  };
  // The local headers, hopped by their sizes, reach the central directory -- unless a member's
  // sizes come after its data, when the end record is looked for instead.
  let p = start;
  let hop = true;
  for (let m = local(p); m; m = local(p)) {
    if ((m.flags & 8) || m.csize === 0xffffffff) {
      hop = false;
      break;
    }
    p = m.data + m.csize;
  }
  let cdAt = hop && cur.u32le(p) === PK_CENTRAL ? p : -1;
  let eocd = -1;
  if (cdAt >= 0) {
    let q = cdAt;
    while (cur.u32le(q) === PK_CENTRAL) {
      const c = cur.bytes(q, 46);
      if (!c) break;
      q += 46 + c.readUInt16LE(28) + c.readUInt16LE(30) + c.readUInt16LE(32);
    }
    if (cur.u32le(q) === PK_END) eocd = q;
  } else {
    for (let from = p; ;) {
      const e = findUntilBlank(cur, PK_END_SIG, from, limit).at;
      if (e < 0) break;
      const size = cur.u32le(e + 12);
      const off = cur.u32le(e + 16);
      if (start + off + size === e && cur.u32le(start + off) === PK_CENTRAL) {
        eocd = e;
        cdAt = start + off;
        break;
      }
      from = e + 1;
    }
  }
  const eh = eocd >= 0 ? cur.bytes(eocd, 22) : null;
  if (!eh) {
    // Nothing to open, but its local headers still say what lies where.
    hit.problems.push(t('its member list breaks off at +{0}: the rest was overwritten or lies elsewhere', p - start));
    hit.length = p - start;
    Object.assign(hit, zipKind([...members.values()].map((m) => m.name), mimeOf()));
    markMembers(hit, start, members);
    hit._.usable = false;
    return hit;
  }
  const entries = eh.readUInt16LE(10);
  const cdSize = eh.readUInt32LE(12);
  const cdOff = eh.readUInt32LE(16);
  const end = eocd + 22 + eh.readUInt16LE(20);
  hit.length = Math.min(end, cur.limit) - start;
  if (end > cur.limit) hit.problems.push(t('it runs past the end of what was searched: the rest is missing'));
  if (cdAt - start !== cdOff || eocd - cdAt !== cdSize) hit.problems.push(t('its end record does not point at its central directory'));
  // Every member, by the central directory: its local header in place, and its CRC-32.
  const names = [];
  let checked = 0;
  let count = 0;
  let newest = null;
  let encrypted = 0;
  let placed = !hit.problems.length;
  const stopAt = cur.spent + o.budget;
  for (let q = cdAt; q < eocd && cur.u32le(q) === PK_CENTRAL;) {
    const c = cur.bytes(q, 46);
    if (!c) break;
    const nl = c.readUInt16LE(28);
    const name = (cur.bytes(q + 46, nl) || EMPTY).toString('utf8');
    names.push(name);
    count++;
    const [method, flags, crc, csize, usize, at] = [c.readUInt16LE(10), c.readUInt16LE(8), c.readUInt32LE(16),
      c.readUInt32LE(20), c.readUInt32LE(24), c.readUInt32LE(42)];
    const dos = c.readUInt32LE(12);
    const ms = wallClock((dos >>> 25) + 1980, (dos >>> 21) & 15, (dos >>> 16) & 31, (dos >>> 11) & 31, (dos >>> 5) & 63, (dos & 31) * 2, null);
    if (ms != null && (dos >>> 25) > 0 && (newest == null || ms > newest)) newest = ms;
    q += 46 + nl + c.readUInt16LE(30) + c.readUInt16LE(32);
    const lh = local(start + at);
    if (!lh) {
      hit.problems.push(t('member {0}\'s local header is not where the directory says', count));
      placed = false;
      continue;
    }
    // The directory's sizes are the ones to go by: a local header may hold zeros and put them after the data.
    lh.csize = csize;
    lh.method = method;
    if (flags & 1) {
      encrypted++;
      continue;
    }
    if ((method !== 0 && method !== 8) || cur.spent > stopAt || csize > o.budget) continue;
    const data = cur.bytes(lh.data, csize);
    let plain = null;
    try {
      plain = method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: usize + 1 });
    } catch (_) {
      plain = null;
    }
    if (!plain || plain.length !== usize || crc32(plain) !== crc) {
      hit.problems.push(t('member {0} does not match its CRC-32', count));
    } else {
      checked++;
    }
  }
  if (count !== entries) {
    hit.problems.push(t('its central directory lists {0} members where its end record counts {1}', count, entries));
    placed = false;
  }
  Object.assign(hit, zipKind(names, mimeOf()));
  markMembers(hit, start, members);
  setTime(hit, newest, t('the ZIP directory: when a member was last changed, no time zone recorded'));
  if (placed) hit.checks.push(t('its local headers, central directory and end record agree: {0} members', count));
  if (checked) hit.checks.push(t('{0} of {1} members match their CRC-32', checked, count));
  if (encrypted) hit.caveats.push(t('{0} encrypted member(s) cannot be checked', encrypted));
  else if (checked < count && !hit.problems.length) hit.caveats.push(t('{0} member(s) were not checked', count - checked));
  hit.complete = !hit.problems.length;
  hit.selfChecked = hit.complete && checked === count;
  hit._.verifiedEnd = hit.selfChecked ? start + hit.length : start;
  hit._.claimEnd = start + hit.length;
  return hit;
}

// ---------------------------------------------------------------- recognizing a start

const BMFF_FIRST = new Set(['ftyp', ...QT_FIRST].map((s) => Buffer.from(s, 'latin1').readUInt32BE(0)));

/** The validator for what starts at b[i], by its first bytes, or null. */
function validatorAt(b, i) {
  if (i + 12 > b.length) return null;
  if (BMFF_FIRST.has(b.readUInt32BE(i + 4))) return bmff;
  switch (b[i]) {
    case 0xff: return b[i + 1] === 0xd8 && b[i + 2] === 0xff ? jpeg : null;
    case 0x89: return b[i + 1] === 0x50 && b[i + 2] === 0x4e && b[i + 3] === 0x47 ? png : null;
    case 0x47: return b[i + 1] === 0x49 && b[i + 2] === 0x46 && b[i + 3] === 0x38 ? gif : null;
    case 0x42: return b[i + 1] === 0x4d ? bmp : null;
    case 0x52: return b.toString('latin1', i, i + 4) === 'RIFF' ? riff : null;
    case 0x49: return /^II(\*\0|RO|RS|U\0)$/.test(b.toString('latin1', i, i + 4)) ? tiff : null;
    case 0x4d: return /^MM(\0\*|OR)$/.test(b.toString('latin1', i, i + 4)) ? tiff : null;
    case 0x30: return b[i + 1] === 0x26 && b[i + 2] === 0xb2 && b[i + 3] === 0x75 ? asf : null;
    case 0x25: return b.toString('latin1', i, i + 5) === '%PDF-' ? pdf : null;
    case 0x50: return b.readUInt32LE(i) === PK_LOCAL ? zip : null;
    default: return null;
  }
}

function options(o = {}) {
  return { budget: o.budget || DEFAULTS.budget, decode: o.decode !== false };
}

/** A reader's size. Carving needs it: a device's is not known until it is set from its tables. */
function sizeOf(reader) {
  if (!reader || typeof reader.read !== 'function' || !Number.isSafeInteger(reader.size) || reader.size < 0) {
    throw new Error(t('What is to be carved has no known size; set it from the partition table or the boot sector first.'));
  }
  return reader.size;
}

/**
 * Runs one validator. A quirk it did not foresee -- a field read past what it checked -- costs
 * that one hit, not the scan; a read that fails, such as a bad sector, is thrown on with `read`
 * set, for the scan to note.
 */
function run(v, cur, at, opts) {
  try {
    return v(cur, at, opts);
  } catch (e) {
    if (e instanceof RangeError || e instanceof TypeError) return null;
    if (e.code) e.read = true;
    throw e;
  }
}

/**
 * The file that starts at `offset`, checked by its format's own structure, or null when no
 * format known here starts there. A damaged file comes back with its problems and `complete`
 * false, and `usable` false when nothing of its content is left to show. What judge() makes of
 * it depends on where the bytes came from. `previews` are the smaller copies it holds, as scan()
 * would offer them. A read that fails, such as one of a bad sector, throws.
 *
 * A hit, here and in scan()'s `found`:
 *   type, ext, mediaType   the format (FORMATS), the extension of its kind (.jpg, .nef, .docx) and
 *                          its type as types.js names them
 *   offset, length         where it starts in the reader and how long its structure is
 *   complete               its structure closed where the format says it closes
 *   checks, problems       what held, and what did not: damage, a cut, pieces of something else
 *   caveats, tail          what the checks cannot rule out, and what a carve loses after the end
 *   width, height, time, timeFrom   the picture's size, and the time the content records with
 *                          where it is from; null when it records none
 *   selfChecked            checksums cover every byte of it (PNG, ZIP)
 *   derived, parent        a smaller copy another file keeps, and { type, offset } of that file
 *   embedded               why its own bytes say it was made to live inside another file, or null
 *   info                   what else it says: make, model, coding, frames, seconds, codecs,
 *                          motionPhoto, member, thumbnail, decodedMcus of mcus, raw ...
 * @param {{ size: number, read: function }} reader
 * @param {number} offset
 * @param {object} [o]  { budget, decode: false to skip decoding JPEG scans }
 */
function validate(reader, offset, o = {}) {
  sizeOf(reader);
  const head = reader.read(offset, 16);
  const v = validatorAt(head, 0);
  const hit = v ? run(v, new Cursor(reader), offset, options(o)) : null;
  if (!hit) return null;
  const out = publicHit(hit);
  out.usable = hit._.usable;
  out.previews = hit._.children.map((c) => ({ ...c }));
  return out;
}

// ---------------------------------------------------------------- scanning

/**
 * The ranges to probe, in order, within the reader, and merged where they overlap: the probes
 * of a range are `step` apart from its start. From `start` on only, which is where an earlier run
 * stopped, on the probes of the range it lies in.
 */
function rangesOf(list, size, start, step) {
  const sorted = list.map(([a, b]) => [Math.max(0, Math.floor(a)), Math.min(size, Math.floor(b))])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  const merged = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a < last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged.map(([a, b]) => [a < start ? a + Math.ceil((start - a) / step) * step : a, b]).filter(([a, b]) => b > a);
}

// A picture that is part of an earlier file, by what that file says starts there: the count it goes to.
const OWN_COUNT = { preview: 'previews', frame: 'frames', part: 'parts' };

/**
 * Carves a reader: every `step` bytes of each range, anything a validator recognizes.
 *
 * Pictures kept inside other files are told apart as far as the bytes allow:
 *   - A hit inside the part of an earlier file whose every byte was checked to be that file's --
 *     a JPEG up to EOI with its scans decoded, a PNG's CRCs, a GIF's LZW data, a ZIP's CRCs -- is
 *     part of it, and is not even looked at: a photo's thumbnail, a DOCX's pictures.
 *   - A JPEG that starts exactly where an earlier file keeps a picture of its own is that
 *     file's, and is counted, not listed: a RAW's preview, a photo's Exif thumbnail, a HEIF's
 *     JPEG item, a movie's thumbnail, and the frames of a Motion JPEG AVI or MOV. A RAW file --
 *     a CR3 among them -- offers its largest preview as a smaller copy instead, since a RAW
 *     cannot be shown as it is, and a damaged photo offers its thumbnail.
 *   - What starts exactly where an earlier file's own structure goes on -- a movie's next box, a
 *     ZIP's next member, a motion photo's video -- is part of it too, and is counted.
 *   - A file a damaged ZIP stored as it is, where the ZIP's headers say, is listed under the name
 *     the ZIP gave it: as embedded, which judge() makes a smaller copy, when the ZIP is a document
 *     or an app, and as the file someone archived when it is an archive.
 *   - A JPEG whose own bytes show it was made to live inside something else: lossless (a RAW's
 *     sensor data) and Motion JPEG frames (APP0 "AVI1", or no Huffman tables of their own) are
 *     counted, not listed; one with no APP segment at all, or right after a PDF's "stream", is
 *     listed as embedded.
 *   - Anything else that starts inside the claimed extent of an earlier file is listed with a
 *     caveat naming that file. Chunks that tile, samples in place, a RAW's pointers: none of
 *     that says a newer file was not written over the middle of an old one since, and a newer
 *     photo matters more than a duplicate row.
 *
 * A stretch that cannot be read is read again in pieces of 64 KiB, and a piece that still cannot
 * be -- a bad sector -- is passed over and counted, as is a file whose checks could not be read.
 *
 * @param {{ size: number, read: function, readAsync?: function }} reader
 * @param {object} [o]
 * @param {number} [o.step]         probe every this many bytes: 512, or the cluster size
 * @param {number[][]} [o.ranges]   [from, to) ranges to probe, such as free clusters; a file may
 *   still run on past the end of its range. Probes are `step` apart from each `from`. The whole
 *   reader when not given
 * @param {number} [o.start]        go on from here: the `next` of a run that stopped, with the
 *   same ranges and step
 * @param {string[]} [o.types]      media types to list (types.js TYPES); all when not given.
 *   Other formats are still recognized, to know what lies inside them
 * @param {number} [o.maxBytes]     probe at most this many bytes in one run
 * @param {number} [o.maxFiles]     list at most this many files in one run
 * @param {number} [o.budget]       how much one file's checks may read
 * @param {boolean} [o.decode]      false to follow JPEG scans without decoding them: faster, weaker
 * @param {function} [o.onProgress] (bytesDone, bytesTotal)
 * @param {function} [o.onFound]    each hit, as it is listed
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{ found: object[], scanned: number, total: number, next: number|null, notes: string[], counts: object }>}
 *   `next` is where to go on from when a limit or a cancel stopped the run, and null when all of
 *   it was probed
 */
async function scan(reader, o = {}) {
  const size = sizeOf(reader);
  const step = Math.max(1, Math.floor(o.step || DEFAULTS.step));
  const maxBytes = o.maxBytes == null ? DEFAULTS.maxBytes : o.maxBytes;
  const maxFiles = o.maxFiles == null ? DEFAULTS.maxFiles : o.maxFiles;
  const wanted = o.types && o.types.length ? new Set(o.types) : null;
  const opts = options(o);
  const ranges = rangesOf(o.ranges || [[0, size]], size, o.start || 0, step);
  const total = ranges.reduce((s, [a, b]) => s + (b - a), 0);
  const found = [];
  const notes = [];
  const counts = { previews: 0, frames: 0, raw: 0, parts: 0, falseStarts: 0, unreadable: 0, unreadableFiles: 0 };
  let claims = [];
  let skipUntil = 0;
  let scanned = 0;
  let next = null;
  const listed = (h) => !wanted || wanted.has(h.mediaType);
  const add = (h) => {
    const out = publicHit(h);
    found.push(out);
    if (o.onFound) o.onFound(out);
  };
  /** The 8 bytes before `at`, as text; none where they cannot be read. */
  const before8 = (at) => {
    try {
      return reader.read(at - 8, 8).toString('latin1');
    } catch (_) {
      return '';
    }
  };

  /** What to do with one hit, by what it is and where it lies (see above). */
  function place(hit) {
    const at = hit.offset;
    const x = hit._;
    claims = claims.filter((c) => c.end > at);
    const around = claims.filter((c) => c.start < at);
    const owner = around.find((c) => c.pointers.has(at));
    const own = owner ? owner.pointers.get(at) : null;
    if (typeof own === 'string') {
      counts[OWN_COUNT[own]]++;
      return;
    }
    if (x.drop) {
      counts[x.drop]++;
      return;
    }
    if (own) {
      const where = t('it is stored inside the {0} found at {1}, as {2}', owner.label, owner.start, own.member);
      hit.info.member = own.member;
      if (own.inside) hit.embedded = where;
      else hit.caveats.push(where);
    } else if (hit.type === 'jpeg' && at >= 8 && !hit.embedded && /stream\r?\n$|stream\r$/.test(before8(at))) {
      hit.embedded = t('an image stream of a PDF: the bytes before it end with "stream"');
    }
    for (const c of around) {
      if (c === owner) continue;
      hit.caveats.push(t('it starts inside the {0} found at {1}, so it may be part of that file, or newer data written '
        + 'over it', c.label, c.start));
    }
    claims.push({ start: at, end: x.claimEnd == null ? at + hit.length : x.claimEnd, pointers: x.pointers, label: label(hit) });
    skipUntil = Math.max(skipUntil, x.verifiedEnd);
    if (x.usable && listed(hit)) add(hit);
    for (const child of x.children) if (listed(child)) add({ ...child, _: null });
  }

  const readSome = (at, len) => (reader.readAsync ? reader.readAsync(at, len) : reader.read(at, len));
  const unreadable = (at, len, e) => {
    if (!counts.unreadable) notes.push(t('Could not read at byte {0} ({1}); what could not be read was passed over.', at, e.code || e.message));
    counts.unreadable += Math.max(0, Math.min(len, size - at));
  };
  /** The bytes a stretch of probes looks at; a piece that cannot be read comes back as zeros, which start nothing. */
  const readBlock = async (at, len) => {
    try {
      return await readSome(at, len);
    } catch (e) {
      if (len <= SMALL) {
        unreadable(at, len, e);
        return Buffer.alloc(len);
      }
    }
    const parts = [];
    for (let p = at; p < at + len; p += SMALL) {
      const n = Math.min(SMALL, at + len - p);
      try {
        parts.push(await readSome(p, n));
      } catch (e) {
        unreadable(p, n, e);
        parts.push(Buffer.alloc(n));
      }
    }
    return Buffer.concat(parts);
  };

  const BLOCK = 4 * MIB;
  const perProbe = step >= SMALL;
  outer:
  for (let r = 0; r < ranges.length; r++) {
    const [from, to] = ranges[r];
    // The first probe from `pos` on, in this range or a later one; null when none is left.
    const resumeAt = (pos) => {
      for (let k = r; k < ranges.length; k++) {
        const [a, b] = ranges[k];
        const q = pos <= a ? a : a + Math.ceil((pos - a) / step) * step;
        if (q < b) return q;
      }
      return null;
    };
    let at = from;
    while (at < to) {
      // Inside a file already checked to the byte there is nothing new to find.
      if (skipUntil > at) {
        const resume = Math.min(to, from + Math.ceil((skipUntil - from) / step) * step);
        scanned += resume - at;
        at = resume;
        continue;
      }
      if (o.signal && o.signal.aborted) {
        next = at;
        notes.push(t('Stopped at byte {0}: cancelled.', at));
        break outer;
      }
      const left = Math.floor((maxBytes - scanned) / step) * step;
      if (left <= 0) {
        next = at;
        notes.push(t('Stopped at byte {0} after probing {1} bytes, the most one run probes; scan again from there to go on.',
          at, scanned));
        break outer;
      }
      const span = Math.min(perProbe ? step : Math.max(step, Math.floor(BLOCK / step) * step), to - at, left);
      const block = await readBlock(at, perProbe ? 16 : span + 16);
      for (let i = 0; i < span; i += step) {
        const abs = at + i;
        if (abs < skipUntil) continue;
        const v = validatorAt(block, i);
        if (!v) continue;
        let hit;
        try {
          hit = run(v, new Cursor(reader), abs, opts);
        } catch (e) {
          if (!e.read) throw e;
          if (!counts.unreadableFiles) notes.push(t('Could not read the file that starts at byte {0} ({1}); left out.', abs, e.code));
          counts.unreadableFiles++;
          continue;
        }
        const worth = hit && (hit._.usable || hit._.children.length);
        if (!worth) counts.falseStarts++;
        // One with nothing to list may still say what lies inside it, as a ZIP whose end is lost does.
        if (!hit || !(worth || hit._.pointers.size)) continue;
        place(hit);
        if (found.length >= maxFiles) {
          // Go on after this file, and after anything it holds that was checked to be its own.
          const after = Math.max(abs + step, skipUntil);
          next = resumeAt(after);
          scanned += Math.min(after, to) - at;
          if (next != null) {
            notes.push(t('Stopped at byte {0} after listing {1} files, the most one run lists; scan again from there to go on.',
              next, found.length));
          }
          break outer;
        }
      }
      at += span;
      scanned += span;
      if (o.onProgress) o.onProgress(scanned, total);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  if (!wanted || wanted.has('image')) {
    if (counts.previews) notes.push(t('{0} picture(s) found where another file keeps a preview or thumbnail of its own were not listed on their own.', counts.previews));
    if (counts.frames) notes.push(t('{0} Motion JPEG video frame(s) were not listed as pictures.', counts.frames));
    if (counts.raw) notes.push(t('{0} lossless JPEG stream(s), the sensor data of camera RAW files, were not listed as pictures.', counts.raw));
  }
  if (counts.parts) {
    notes.push(t('{0} place(s) where a file found before goes on -- a movie\'s next box, a ZIP\'s next member, a motion photo\'s '
      + 'video -- were not listed on their own.', counts.parts));
  }
  if (counts.falseStarts) notes.push(t('{0} place(s) began like a known format but held too little of one to list.', counts.falseStarts));
  if (counts.unreadable) notes.push(t('{0} byte(s) could not be read and were passed over.', counts.unreadable));
  if (counts.unreadableFiles > 1) notes.push(t('{0} file(s) could not be read to be checked, and were left out.', counts.unreadableFiles));
  found.sort((a, b) => a.offset - b.offset);
  return { found, scanned: Math.min(scanned, total), total, next, notes, counts };
}

// ---------------------------------------------------------------- how far a copy can be trusted

/**
 * The copy flags of quality.js for bytes taken as `hit` -- what validate() or scan() gave, or
 * null when no format known here recognized them -- and why. Without `size` the bytes were carved:
 * only their content says where the file ended, and they are unverified. When a file system says
 * where the file lay (lib/fat.js) and the bytes were read from there (its extentReader()), `size`
 * is the size it records, and `known` says it recorded where every piece of the file lies -- the
 * extent's `complete` -- rather than leaving the pieces after the first to be taken as following
 * on from it:
 *
 *   a stream whose checksums cover every byte (PNG, ZIP), whole     the file itself: no flag
 *     and ending exactly at `size`
 *   content that checks out, or that no check here covers           inexact when `known`, else
 *                                                                   unverified
 *   content that is damaged, or that needs more than `size` bytes   unverified
 *
 * A smaller copy a file keeps of itself is derived. So is a picture carved out of free space whose
 * bytes show it was made to live inside another file; one a file system names is that file.
 * @param {object|null} hit
 * @param {{ size?: number, known?: boolean }} [o]
 * @returns {{ unverified?: true, inexact?: true, derived?: true, reasons: string[] }}
 */
function judge(hit, o = {}) {
  const proven = o.size != null;
  const carvedOnly = t('found by its content alone: nothing records where the file ended');
  const assumed = t('the file system records where it began and how long it was, but not where the rest of it lay: '
    + 'that is taken to follow on');
  if (!hit) {
    if (!proven) return { unverified: true, reasons: [carvedOnly] };
    const why = t('its format is not one whose structure is checked here');
    return o.known ? { inexact: true, reasons: [why] } : { unverified: true, reasons: [assumed, why] };
  }
  const out = { reasons: [...hit.problems] };
  if (hit.derived || (hit.embedded && !proven)) out.derived = true;
  if (hit.embedded && !proven) out.reasons.push(hit.embedded);
  if (!proven) {
    out.unverified = true;
    out.reasons.push(carvedOnly);
    if (hit.tail) out.reasons.push(hit.tail);
  } else if (!hit.complete || o.size < hit.length) {
    out.unverified = true;
    if (o.size < hit.length) {
      out.reasons.push(t('the file system records {0} bytes, fewer than its structure needs ({1})', o.size, hit.length));
    }
  } else if (!(hit.selfChecked && o.size === hit.length)) {
    if (o.known) {
      out.inexact = true;
    } else {
      out.unverified = true;
      out.reasons.push(assumed);
    }
    if (o.size > hit.length) out.reasons.push(t('its last {0} bytes, after where its structure ends, are not checked', o.size - hit.length));
  }
  out.reasons.push(...hit.caveats);
  return out;
}

/**
 * The fields of a search result for a carved hit: kind 'carved', what it is, its flags, and a note
 * that says why and where its time comes from; `name` when a damaged archive still names the file
 * someone put in it. The source adds where the bytes lie -- an extent of one run, [hit.offset,
 * hit.length], counted in the place it reads -- and the rest.
 */
function candidate(hit) {
  const j = judge(hit);
  const c = {
    kind: 'carved', mediaType: hit.mediaType, ext: hit.ext, size: hit.length, time: hit.time,
    width: hit.width, height: hit.height, unverified: true,
  };
  if (j.derived) c.derived = true;
  const member = !hit.embedded && hit.info && hit.info.member ? hit.info.member.split(/[\\/]/).pop() : '';
  if (member) c.name = member;
  const dated = hit.time != null && hit.timeFrom ? [t('dated by {0}', hit.timeFrom)] : [];
  c.note = [...j.reasons, ...dated].join('; ');
  return c;
}

module.exports = {
  scan,
  validate,
  judge,
  candidate,
  DEFAULTS,
  FORMATS,
  _internal: {
    Cursor, crc32, crc32Table, walkScan, huffTable, lzwPixels, tiffReader, exifInfo, exifTime, iditTime, macTime,
    pngRowBytes, validatorAt, ecsEnd, rangesOf, zipKind, jpeg, png, gif, bmp, riff, asf, bmff, tiff, pdf, zip, MAX_LENGTH,
    FILL_MAX, BLANK_RUN,
  },
};
