'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { t } = require('../i18n');
const { baseName, isWindowsPath, pathKey } = require('../paths');

// Hancom Office's word processor, 한/글 (Hwp), leaves two kinds of whole copy of a document:
//
//   <temp>\Hwp<version>\<name>.asv   autosave, rewritten every few minutes while the document is
//                                     open and deleted when Hwp exits normally, so one is left
//                                     after a crash, a forced shutdown or a killed process
//   <folder>\<name>.bak              backup, when "make a backup" is on: saving <name>.hwp first
//                                     turns the version on disk into <name>.bak, beside it
//
// <version> is 80 for Hwp 2010 -- Hwp.exe 8.0 names ${Temp}\Hwp80\ -- and, per Hancom's
// developer forum, 120 for 2022 and 130 for 2024; every Hwp<digits> folder in the temp folder
// is taken. Hwp.exe 8.0 writes an autosave with its ordinary save routine, in format "HWP"
// with the option "autosave:true", so an .asv is a whole HWP document -- whatever the format of
// the document itself, and Hwp opens .hwt, .doc, .docx and .odt files as well. It names the
// autosave after the document's name less its extension (report.asv, or report[1].asv when
// that is taken), and nothing in it says which folder the document was in. A backup's name
// drops the extension the same way (_wmakepath with ".BAK"), for a template (.hwt, which is
// HWP 5 like a .hwp: all 2,990 that ship with Hwp 2010 pass the checks below) as for a
// document. (.frm is the old format's template, which has nothing to check.)
//
// %APPDATA%\HNC\Office\Recent holds a shortcut, <name>.lnk, for every document and folder
// opened lately. Those give the folders to look in for backups, and which document a copy was:
//   autosave  the one recent document of the same user profile whose name, less its extension,
//             is the autosave's -- when there is exactly one, and it has the extension the
//             content has (.hwp for HWP, .hwpx for HWPX)
//   backup    <name> with the extension of the one HWP file of that name that its folder holds
//             or the recent documents know there (.hwp or .hwt for HWP content), .hwp or
//             .hwpx when they know none
// Otherwise the path is left empty rather than guessed, and the note names what it could be.
//
// A shortcut holds the absolute path it was made for -- in Unicode, or only in the ANSI code
// page, which it does not name -- and a Unicode path relative to its own folder. The relative
// path is trusted to say where the document is now (a disk mounted elsewhere, say) only when it
// fits the absolute one: no more ".." than there are folders to climb, the same names at its
// end, and the folder it climbs to ending in the absolute path's (E:\Users\alice for
// C:\Users\alice). Otherwise the absolute path is where to look. An ANSI path that is not
// plain ASCII is rebuilt from its leading folders, when those are ASCII, and the relative
// path's names for the rest, when the two agree wherever either is ASCII.
//
// Every file is opened once, read-only. Its first 32 bytes come first, so another program's
// .bak is never read past them; then all of it, and the bytes that pass the checks are the
// bytes offered -- Hwp keeps rewriting an autosave, and the file may hold something else by the
// time it is restored. One whose size or time moved while it was read is left out. Only what
// readdir types as a plain file is opened: it types every reparse point, cloud placeholders
// included, as a link.
//
// A file is offered only when it proves whole:
//   HWP 5  a compound file (D0 CF 11 E0) of whole sectors, whose every sector chain stays inside
//          the file, is as long as its stream's size and shares no sector with another; a
//          FileHeader stream reading "HWP Document File", version 5; a DocInfo stream and
//          BodyText/Section0..n, each of which inflates and splits into records that end
//          exactly where it ends, with as many sections as DocInfo counts; and every embedded
//          item DocInfo lists (pictures, mostly) present, inflating where it says it is
//          compressed. Encrypted and distribution-only documents cannot be read inside, so for
//          them the compound file itself is all that is checked.
//   HWPX   a zip whose every entry inflates to its recorded size and CRC-32, with a mimetype
//          entry reading application/hwp+zip, Contents/header.xml and Contents/section0.xml.
// A .bak holding anything else belongs to some other program and is passed over.
//
// Measured on the machine this was written on (Hwp 2010; autosave every 10 minutes, backups
// off): Temp\Hwp80 existed and was empty, and there was no .asv and no HWP .bak anywhere in the
// user profile, so no real autosave or backup has been read. The Recent folder held 62
// shortcuts, 45 to .hwp files, 1 to an .hwpx and 16 to folders; in all 62 the Unicode
// relative path, resolved from the Recent folder, named the same file as the ANSI path. None
// held the absolute path in Unicode, and later, of 63, 58 ANSI paths were not ASCII; the path
// read -- rebuilt for those 58 -- was the ANSI path decoded as cp949 in 63 of 63, and stayed so
// with the folder read as if from E:\mnt, where all 63 relative paths were followed; as if
// from E:\Recent, or from another user's profile, none was. The checks passed on all 65 .hwp
// and 6 .hwpx documents on the Desktop and in Downloads. Of 426 copies of those cut short at
// six points each, 425 failed; the one that passed had lost only a free sector at its end,
// every stream still whole. HWP 5 carries no checksum, so a changed byte is caught only when
// it breaks the structure: 119 of 1,300 were; in .hwpx, 120 of 120.

const MAX_CHECK = 256 * 1024 * 1024;
const MAX_INFLATE = 512 * 1024 * 1024;

// ---- HWP 5: a compound file ------------------------------------------------------------------

const FREE = 0xffffffff; // FREESECT, and NOSTREAM for a directory link
const END = 0xfffffffe; // ENDOFCHAIN
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const MINI = 64;

/** Sector numbers from `start` until ENDOFCHAIN, or null when it leaves the table or runs past `max`. */
function chain(start, table, max) {
  const out = [];
  for (let s = start; s !== END; s = table[s]) {
    if (s >= table.length || out.length >= max) return null;
    out.push(s);
  }
  return out;
}

/**
 * Reads a compound file and checks its structure. `keep(path)` says which streams' bytes to
 * return; every stream is checked either way. Returns { names, streams } or null.
 */
function readCfb(buf, keep) {
  if (buf.length < 512 || buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) return null;
  const major = buf.readUInt16LE(26);
  const shift = buf.readUInt16LE(30);
  if (buf.readUInt16LE(28) !== 0xfffe || buf.readUInt16LE(32) !== 6 || buf.readUInt32LE(56) !== 4096) return null;
  if (!(major === 3 && shift === 9) && !(major === 4 && shift === 12)) return null;
  if (major === 3 && buf.readUInt32LE(40) !== 0) return null;
  const ss = 1 << shift;
  // A compound file is whole sectors; one that is not was cut short. Sector s starts at
  // (s + 1) * ss, the header taking the place of sector -1.
  if (buf.length < 2 * ss || buf.length % ss) return null;
  const count = buf.length / ss - 1;
  const at = (s) => (s + 1) * ss;
  const used = new Uint8Array(count);
  // Every sector belongs to one thing at most: a FAT sector, the directory, or one stream.
  const claim = (s) => s < count && !used[s] && (used[s] = 1);

  // Which sectors hold the FAT: 109 in the header, the rest in a chain of DIFAT sectors.
  const nFat = buf.readUInt32LE(44);
  const perSector = ss / 4;
  if (nFat === 0 || nFat > count) return null;
  const fatIds = [];
  for (let i = 0; i < 109 && fatIds.length < nFat; i++) fatIds.push(buf.readUInt32LE(76 + i * 4));
  const difIds = [];
  let dif = buf.readUInt32LE(68);
  for (let left = buf.readUInt32LE(72); fatIds.length < nFat; left--) {
    if (left <= 0 || !claim(dif)) return null;
    difIds.push(dif);
    for (let i = 0; i < perSector - 1 && fatIds.length < nFat; i++) fatIds.push(buf.readUInt32LE(at(dif) + i * 4));
    dif = buf.readUInt32LE(at(dif) + ss - 4);
  }
  const fat = new Uint32Array(nFat * perSector);
  for (let i = 0; i < nFat; i++) {
    const s = fatIds[i];
    if (!claim(s)) return null;
    for (let j = 0; j < perSector; j++) fat[i * perSector + j] = buf.readUInt32LE(at(s) + j * 4);
  }
  if (fatIds.some((s) => fat[s] !== FATSECT) || difIds.some((s) => fat[s] !== DIFSECT)) return null;
  // The FAT may describe more sectors than there are, but only as free ones.
  for (let s = count; s < fat.length; s++) if (fat[s] !== FREE) return null;

  /** A stream kept in whole sectors: its chain must be exactly as long as its size needs. */
  function bigStream(start, size) {
    const n = Math.ceil(size / ss);
    const c = chain(start, fat, n);
    if (!c || c.length !== n) return null;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const need = i < n - 1 ? ss : size - i * ss;
      if (!claim(c[i])) return null;
      parts.push(buf.subarray(at(c[i]), at(c[i]) + need));
    }
    return Buffer.concat(parts);
  }

  const dirIds = chain(buf.readUInt32LE(48), fat, count);
  if (!dirIds || !dirIds.length || dirIds.some((s) => !claim(s))) return null;
  const dir = Buffer.concat(dirIds.map((s) => buf.subarray(at(s), at(s) + ss)));
  const entries = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const len = dir.readUInt16LE(o + 64);
    entries.push({
      name: len >= 2 && len <= 64 ? dir.toString('utf16le', o, o + len - 2) : null,
      type: dir[o + 66],
      left: dir.readUInt32LE(o + 68),
      right: dir.readUInt32LE(o + 72),
      child: dir.readUInt32LE(o + 76),
      start: dir.readUInt32LE(o + 116),
      // Version 3 files may leave garbage in the high half; the format says to ignore it.
      size: dir.readUInt32LE(o + 120) + (major === 3 ? 0 : dir.readUInt32LE(o + 124) * 2 ** 32),
    });
  }
  const root = entries[0];
  if (!root || root.type !== 5) return null;

  // Streams under 4096 bytes live in the mini stream, in 64-byte pieces with a FAT of their own.
  const miniStream = root.size ? bigStream(root.start, root.size) : Buffer.alloc(0);
  if (!miniStream) return null;
  const nMiniFat = buf.readUInt32LE(64);
  const miniFatIds = nMiniFat ? chain(buf.readUInt32LE(60), fat, nMiniFat) : [];
  if (!miniFatIds || miniFatIds.length !== nMiniFat || miniFatIds.some((s) => !claim(s))) return null;
  const miniFat = new Uint32Array(nMiniFat * perSector);
  miniFatIds.forEach((s, i) => {
    for (let j = 0; j < perSector; j++) miniFat[i * perSector + j] = buf.readUInt32LE(at(s) + j * 4);
  });
  const usedMini = new Uint8Array(miniFat.length);
  function miniStreamOf(start, size) {
    const n = Math.ceil(size / MINI);
    const c = chain(start, miniFat, n);
    if (!c || c.length !== n) return null;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const s = c[i];
      const need = i < n - 1 ? MINI : size - i * MINI;
      if (usedMini[s] || s * MINI + need > miniStream.length) return null;
      usedMini[s] = 1;
      parts.push(miniStream.subarray(s * MINI, s * MINI + need));
    }
    return Buffer.concat(parts);
  }

  // The directory is a tree of siblings (left, right) and children; each entry is visited once.
  const names = new Set();
  const streams = new Map();
  const seen = new Uint8Array(entries.length);
  const stack = [[root.child, '']];
  while (stack.length) {
    const [id, prefix] = stack.pop();
    if (id === FREE) continue;
    if (id >= entries.length || seen[id]) return null;
    seen[id] = 1;
    const e = entries[id];
    if ((e.type !== 1 && e.type !== 2) || e.name === null) return null;
    const name = prefix + e.name;
    names.add(name);
    stack.push([e.left, prefix], [e.right, prefix]);
    if (e.type === 1) {
      stack.push([e.child, name + '/']);
    } else if (e.size > 0) {
      const data = e.size < 4096 ? miniStreamOf(e.start, e.size) : bigStream(e.start, e.size);
      if (!data) return null;
      if (keep(name)) streams.set(name, data);
    } else if (keep(name)) {
      streams.set(name, Buffer.alloc(0));
    }
  }
  return { names, streams };
}

/**
 * HWP records: a 32-bit header -- tag in bits 0-9, size in bits 20-31, or 0xFFF and the size
 * in the next 32 bits -- then the data. Calls `each(tag, data)` for every record and returns
 * how many there were, or -1 when they do not end exactly where the stream does.
 */
function records(b, each) {
  let n = 0;
  let o = 0;
  while (o < b.length) {
    if (o + 4 > b.length) return -1;
    const h = b.readUInt32LE(o);
    let size = h >>> 20;
    o += 4;
    if (size === 0xfff) {
      if (o + 4 > b.length) return -1;
      size = b.readUInt32LE(o);
      o += 4;
    }
    if (o + size > b.length) return -1;
    each(h & 0x3ff, b.subarray(o, o + size), n++);
    o += size;
  }
  return n;
}

const TAG_DOCUMENT_PROPERTIES = 16;
const TAG_BIN_DATA = 18;
const TAG_PARA_HEADER = 66;
// FileHeader properties whose streams cannot be read without a key: password, distribution
// document, DRM, certificate encryption, certificate DRM.
const SEALED = 0x2 | 0x4 | 0x10 | 0x100 | 0x400;
const WANTED = /^(FileHeader|DocInfo|BodyText\/Section\d+|BinData\/.*)$/;

/**
 * What DocInfo says: how many sections there are, and every embedded item (a picture, say)
 * as the stream it must be in and whether that stream is compressed. Null when it cannot say.
 */
function readDocInfo(info, compressed) {
  let sections = null;
  const embedded = [];
  let ok = true;
  const n = records(info, (tag, d, i) => {
    if (i === 0) {
      if (tag !== TAG_DOCUMENT_PROPERTIES || d.length < 2) ok = false;
      else sections = d.readUInt16LE(0);
    } else if (tag === TAG_BIN_DATA && d.length >= 2 && (d.readUInt16LE(0) & 0xf) === 1) {
      // Attribute: type in bits 0-3 (1 = embedded), compression in bits 4-5 (0 = as the
      // document, 1 = compressed, 2 = not). Then the item's id and its extension.
      if (d.length < 6 || d.length < 6 + d.readUInt16LE(4) * 2) {
        ok = false;
        return;
      }
      const how = (d.readUInt16LE(0) >> 4) & 0x3;
      const id = d.readUInt16LE(2).toString(16).toUpperCase().padStart(4, '0');
      const ext = d.toString('utf16le', 6, 6 + d.readUInt16LE(4) * 2);
      embedded.push({ name: `bindata/bin${id}.${ext}`.toLowerCase(), compressed: how === 1 || (how === 0 && compressed) });
    }
  });
  return ok && n > 0 && sections ? { sections, embedded } : null;
}

/** 'hwp' when the file is a whole HWP 5 document, 'broken' when it is one but fails, else null. */
function checkHwp5(buf) {
  const cfb = readCfb(buf, (n) => WANTED.test(n));
  if (!cfb) return looksLikeHwp5(buf) ? 'broken' : null;
  const head = cfb.streams.get('FileHeader');
  if (!head || head.length < 40 || head.toString('latin1', 0, 17) !== 'HWP Document File') return null;
  if (head.subarray(17, 32).some((b) => b !== 0) || head.readUInt32LE(32) >>> 24 !== 5) return 'broken';
  const props = head.readUInt32LE(36);
  const docInfo = cfb.streams.get('DocInfo');
  if (!docInfo) return 'broken';
  if (props & SEALED) {
    return [...cfb.names].some((n) => /^(BodyText|ViewText)\/Section0$/.test(n)) ? 'hwp' : 'broken';
  }
  const inflate = (b) => {
    try {
      return zlib.inflateRawSync(b, { maxOutputLength: MAX_INFLATE });
    } catch (_) {
      return null;
    }
  };
  const open = (b) => (props & 1 ? inflate(b) : b);
  const info = open(docInfo);
  const doc = info && readDocInfo(info, !!(props & 1));
  if (!doc) return 'broken';
  const present = [...cfb.names].filter((n) => /^BodyText\/Section\d+$/.test(n)).length;
  if (present !== doc.sections) return 'broken';
  for (let i = 0; i < doc.sections; i++) {
    const raw = cfb.streams.get('BodyText/Section' + i);
    const body = raw && open(raw);
    let first = -1;
    if (!body || records(body, (tag, d, k) => { if (k === 0) first = tag; }) < 1 || first !== TAG_PARA_HEADER) return 'broken';
  }
  // Every embedded item DocInfo lists must be there, and inflate if it says it is compressed.
  const bins = new Map([...cfb.streams].filter(([n]) => n.startsWith('BinData/')).map(([n, d]) => [n.toLowerCase(), d]));
  for (const item of doc.embedded) {
    const data = bins.get(item.name);
    if (!data || (item.compressed && !inflate(data))) return 'broken';
  }
  return 'hwp';
}

/** A compound file that names a FileHeader and says "HWP Document File" somewhere. */
function looksLikeHwp5(buf) {
  return buf.length >= 512 && buf.readUInt32LE(0) === 0xe011cfd0
    && buf.includes(Buffer.from('FileHeader', 'utf16le')) && buf.includes('HWP Document File', 0, 'latin1');
}

// ---- HWPX: a zip -----------------------------------------------------------------------------

// zlib.crc32 arrived in Node 22.2; before that, the same sum by table.
let crcTable = null;
function tableCrc32(b) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const crc32 = typeof zlib.crc32 === 'function' ? (b) => zlib.crc32(b) : tableCrc32;

/**
 * Checks every entry of a zip against its CRC-32 and sizes. Returns a Map of entry names to
 * their bytes for those `keep(name)` asks for, or null when anything fails. Zip64 is not read.
 */
function readZip(buf, keep) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 + buf.readUInt16LE(eocd + 20) !== buf.length) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdAt = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdAt === 0xffffffff || cdAt + cdSize !== eocd) return null;
  const out = new Map();
  const spans = [];
  let p = cdAt;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (flags & 1 || local + 30 > cdAt || buf.readUInt32LE(local) !== 0x04034b50) return null;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + packed > cdAt) return null;
    spans.push([local, start + packed]);
    const raw = buf.subarray(start, start + packed);
    let data;
    if (method === 0) {
      data = raw;
    } else if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_INFLATE });
      } catch (_) {
        return null;
      }
    } else {
      return null;
    }
    if (data.length !== size || crc32(data) !== crc) return null;
    if (keep(name)) out.set(name, data);
  }
  if (p !== eocd) return null;
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) return null;
  return out;
}

const HWPX_MIME = 'application/hwp+zip';
const HWPX_PARTS = ['mimetype', 'Contents/header.xml', 'Contents/section0.xml'];

/** 'hwpx' when the file is a whole HWPX document, 'broken' when it is one but fails, else null. */
function checkHwpx(buf) {
  const parts = readZip(buf, (n) => HWPX_PARTS.includes(n));
  if (!parts) return buf.includes(HWPX_MIME, 0, 'latin1') ? 'broken' : null;
  const mime = parts.get('mimetype');
  if (!mime || mime.toString('latin1').trim() !== HWPX_MIME) return null;
  return HWPX_PARTS.every((n) => parts.has(n)) ? 'hwpx' : 'broken';
}

/**
 * What a file holds: 'hwp', 'hwpx', 'hwp3' (the pre-2002 format, which has nothing in it to
 * check a copy against), 'broken' (a Hancom document that fails its checks) or null (not one).
 */
function classify(buf) {
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0xe011cfd0) return checkHwp5(buf);
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return checkHwpx(buf);
  if (buf.toString('latin1', 0, 23) === 'HWP Document File V3.00') return 'hwp3';
  return null;
}

const EXT = { hwp: '.hwp', hwpx: '.hwpx' };

// ---- Recent documents: Windows shortcuts ----------------------------------------------------

function cString(b, at) {
  const end = b.indexOf(0, at);
  return b.subarray(at, end < 0 ? b.length : end);
}

function wString(b, at) {
  let end = at;
  while (end + 1 < b.length && b.readUInt16LE(end) !== 0) end += 2;
  return b.toString('utf16le', at, end);
}

const isAscii = (b) => b.every((x) => x < 0x80);
const asciiText = (s) => /^[\x00-\x7f]*$/.test(s);
const nameKey = (s) => s.normalize('NFC').toLowerCase();

/** A relative path as how many folders it climbs and the names below that, or null for any other shape. */
function splitRel(rel) {
  const parts = rel.split(/[\\/]+/).filter((s) => s && s !== '.');
  let up = 0;
  while (up < parts.length && parts[up] === '..') up++;
  const names = parts.slice(up);
  return names.length && !names.includes('..') ? { up, names } : null;
}

/** The folders of a path of this platform below its root: C:\a\b gives [a, b], /mnt/x gives [mnt, x]. */
function belowRoot(p) {
  return p.slice(path.parse(p).root.length).split(/[\\/]+/).filter(Boolean);
}

/**
 * Whether a relative path, seen from `from`, can be the absolute path `recorded` (null when
 * that is not known): it must not climb past the root -- path.resolve would stop there and name
 * some other folder -- and must end in the same names, and the folder it climbs to must end in
 * the folders the absolute path has below its drive.
 */
function fits(from, r, recorded) {
  const here = belowRoot(from);
  if (r.up > here.length) return false;
  if (!recorded) return true;
  const rec = String(recorded).split(/[\\/]+/).filter(Boolean);
  if (/^[a-z]:$/i.test(rec[0] || '')) rec.shift();
  const lead = rec.length - r.names.length;
  if (lead < 0 || !r.names.every((n, i) => nameKey(n) === nameKey(rec[lead + i]))) return false;
  const top = here.slice(0, here.length - r.up);
  if (lead > top.length) return false;
  return rec.slice(0, lead).every((n, i) => nameKey(n) === nameKey(top[top.length - lead + i]));
}

/**
 * An absolute path in an ANSI code page that is not known: its leading folders as they are, when
 * those are ASCII, then the relative path's names for the rest. Null unless the two agree
 * wherever they can be compared -- as many names, and the same name wherever either is ASCII.
 * That also catches a code page where a character's second byte can be a backslash.
 */
function fromAnsi(ansi, r) {
  const parts = [];
  for (let at = 0; ;) {
    const end = ansi.indexOf(0x5c, at);
    parts.push(ansi.subarray(at, end < 0 ? ansi.length : end));
    if (end < 0) break;
    at = end + 1;
  }
  const lead = parts.length - r.names.length;
  if (lead < 1 || !parts.slice(0, lead).every((p) => p.length && isAscii(p))) return null;
  for (let i = 0; i < r.names.length; i++) {
    const a = parts[lead + i];
    const u = r.names[i];
    if (!isAscii(a) && !asciiText(u)) continue;
    if (!isAscii(a) || !asciiText(u) || a.toString('latin1').toLowerCase() !== u.toLowerCase()) return null;
  }
  return parts.slice(0, lead).map((p) => p.toString('latin1')).concat(r.names).join('\\');
}

/**
 * Where a .lnk points: `recorded`, the absolute path it was made for, and `now`, where that is
 * to be looked for here -- the same file seen from the shortcut's own folder through its
 * relative path, when that fits, so a drive mounted elsewhere is read where it is; otherwise
 * the absolute path. The absolute path is in the ANSI code page unless the shortcut also holds
 * it in Unicode; one that is not ASCII is rebuilt with the relative path's names, and when even
 * that cannot be done the relative path stands in for it. Returns null for anything else.
 */
function readLink(file) {
  let b;
  try {
    b = fs.readFileSync(file);
    if (b.length < 0x4c || b.readUInt32LE(0) !== 0x4c) return null;
    const flags = b.readUInt32LE(0x14);
    const isDir = !!(b.readUInt32LE(0x18) & 0x10);
    let off = 0x4c;
    if (flags & 0x1) off += 2 + b.readUInt16LE(off);
    let recorded = null;
    let ansi = null;
    if (flags & 0x2) {
      const size = b.readUInt32LE(off);
      const headSize = b.readUInt32LE(off + 4);
      if (b.readUInt32LE(off + 8) & 0x1) {
        if (headSize >= 0x24) {
          recorded = wString(b, off + b.readUInt32LE(off + 0x1c)) + wString(b, off + b.readUInt32LE(off + 0x20));
        } else {
          ansi = Buffer.concat([cString(b, off + b.readUInt32LE(off + 0x10)), cString(b, off + b.readUInt32LE(off + 0x18))]);
          if (isAscii(ansi)) recorded = ansi.toString('latin1');
        }
      }
      off += size;
    }
    let rel = null;
    const unicode = !!(flags & 0x80);
    for (const bit of [0x4, 0x8, 0x10, 0x20, 0x40]) {
      if (!(flags & bit)) continue;
      const n = b.readUInt16LE(off);
      const bytes = unicode ? n * 2 : n;
      if (off + 2 + bytes > b.length) return null;
      if (bit === 0x8) {
        const raw = b.subarray(off + 2, off + 2 + bytes);
        rel = unicode ? raw.toString('utf16le') : isAscii(raw) ? raw.toString('latin1') : null;
      }
      off += 2 + bytes;
    }
    const r = rel && splitRel(rel);
    if (!recorded && ansi && r) recorded = fromAnsi(ansi, r);
    const from = path.resolve(path.dirname(file));
    const now = r && fits(from, r, recorded) ? path.resolve(from, ...Array(r.up).fill('..'), ...r.names) : recorded;
    if (!now) return null;
    return { recorded: recorded || now, now, isDir };
  } catch (_) {
    return null;
  }
}

// ---- Places ----------------------------------------------------------------------------------

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function filesIn(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch (_) {
    return null;
  }
}

/** The user profile a place belongs to -- what comes before its last \AppData\ -- or null. */
function profileOf(p) {
  const m = /^(.*)[\\/]AppData[\\/]/i.exec(p);
  return m ? pathKey(m[1]) : null;
}

const joinTo = (folder, name) => (isWindowsPath(folder) ? path.win32.join(folder, name) : path.join(folder, name));
const dirOf = (p) => (isWindowsPath(p) ? path.win32.dirname(p) : path.dirname(p));
const stemOf = (name) => name.replace(/\.[^.]*$/, '');
const extOf = (name) => (/\.[^.\\/]*$/.exec(name) || [''])[0].toLowerCase();

/**
 * Everything the given places hold: autosaves, backups and shortcuts to recent documents in
 * them, and backups in the folders those documents are in, each with the other files beside it.
 * Shortcuts are read only in the places themselves -- a document folder such as the desktop has
 * shortcuts to anything.
 */
function survey(places) {
  const autosaves = [];
  const backups = [];
  const recent = [];
  const searched = new Set();
  let documentFolders = 0;
  const lookIn = (dir, recordedDir) => {
    // A Windows path cannot be looked up anywhere else: it would be taken for a relative one.
    if (process.platform !== 'win32' && isWindowsPath(dir)) return;
    const key = pathKey(path.resolve(dir));
    if (searched.has(key)) return;
    searched.add(key);
    const names = filesIn(dir);
    if (!names) return;
    if (recordedDir) documentFolders++;
    const profile = profileOf(path.resolve(dir));
    for (const n of names) {
      const file = path.join(dir, n);
      if (/\.bak$/i.test(n)) {
        backups.push({ file, name: n, folder: recordedDir || path.resolve(dir), siblings: names });
      } else if (recordedDir) {
        continue;
      } else if (/\.asv$/i.test(n)) {
        autosaves.push({ file, name: n, profile });
      } else if (/\.lnk$/i.test(n)) {
        const link = readLink(file);
        if (link) recent.push({ ...link, profile });
      }
    }
  };
  for (const place of places) lookIn(place, null);
  for (const link of recent) {
    if (link.isDir) lookIn(link.now, link.recorded);
    else lookIn(dirOf(link.now), dirOf(link.recorded));
  }
  return { autosaves, backups, recent, documentFolders };
}

/**
 * Which document an autosave was made from. Hwp names one after the document less its
 * extension, so the recent documents of the same profile whose name less its extension is the
 * autosave's -- or whose whole name is, for a report.hwp.asv -- are all it could be. It is taken
 * for that document when there is exactly one and it has `ext`, the extension the content has.
 * Returns { path, maybe }: the document or null, and every recent document it could be.
 */
function documentFor(asv, recent, ext) {
  if (!asv.profile) return { path: null, maybe: [] };
  const want = nameKey(stemOf(baseName(asv.name)));
  const hits = new Map();
  for (const r of recent) {
    if (r.isDir || r.profile !== asv.profile) continue;
    const name = baseName(r.recorded);
    if (nameKey(stemOf(name)) === want || nameKey(name) === want) hits.set(pathKey(r.recorded), r.recorded);
  }
  const maybe = [...hits.values()].sort();
  return { path: maybe.length === 1 && extOf(maybe[0]) === ext ? maybe[0] : null, maybe };
}

// The extensions Hwp saves each kind of content under; the first is taken when nothing says which.
const SAVED_AS = { hwp: ['.hwp', '.hwt'], hwpx: ['.hwpx'] };
const ALL_SAVED_AS = Object.values(SAVED_AS).flat();

/**
 * Which document a backup was: its name with the one extension, of those its content is saved
 * under, that a file of that name beside it or a recent document in its folder has -- the
 * first when none has. Returns { path, maybe }: the document, or null and every one it could be.
 */
function documentOfBackup(bak, recent, kind) {
  const stem = nameKey(docName(bak.name, ''));
  const exts = SAVED_AS[kind];
  const known = new Map();
  const consider = (name) => {
    const ext = extOf(name);
    if (exts.includes(ext) && nameKey(stemOf(name)) === stem && !known.has(ext)) known.set(ext, name);
  };
  for (const n of bak.siblings) consider(n);
  for (const r of recent) if (!r.isDir && pathKey(dirOf(r.recorded)) === pathKey(bak.folder)) consider(baseName(r.recorded));
  const maybe = (known.size ? [...known.values()].sort() : [docName(bak.name, exts[0])]).map((n) => joinTo(bak.folder, n));
  return { path: maybe.length === 1 ? maybe[0] : null, maybe };
}

/** The name a copy had: its own without .asv or .bak, with the extension its content has. */
function docName(file, ext) {
  return stemOf(baseName(file)).replace(/\.hwpx?$/i, '') + ext;
}

// ---- The source ------------------------------------------------------------------------------

/** Every Hwp<digits> folder in the temp folder, and Hancom's recent-documents folders. */
function discover() {
  if (process.platform !== 'win32') return [];
  const out = [];
  try {
    const temps = [os.tmpdir()];
    if (process.env.LOCALAPPDATA) temps.push(path.join(process.env.LOCALAPPDATA, 'Temp'));
    for (const temp of temps) {
      for (const n of filesAndDirs(temp)) {
        if (/^hwp\d+$/i.test(n) && isDir(path.join(temp, n))) out.push(path.join(temp, n));
      }
    }
    const hnc = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'HNC');
    const visit = (dir, depth) => {
      for (const n of filesAndDirs(dir)) {
        const p = path.join(dir, n);
        if (!isDir(p)) continue;
        if (n.toLowerCase() === 'recent') out.push(p);
        else if (depth < 3) visit(p, depth + 1);
      }
    };
    visit(hnc, 1);
  } catch (_) {
    /* nothing found is an answer too */
  }
  const seen = new Set();
  return out.filter((p) => (seen.has(pathKey(p)) ? false : seen.add(pathKey(p))));
}

function filesAndDirs(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
}

const HEAD = 32;
const moved = (a, b) => a.size !== b.size || a.mtimeMs !== b.mtimeMs;

/** Whether a file starts the way a Hancom document does: a compound file, a zip, or HWP 3. */
function startsAsHancom(head) {
  if (head.length >= 4 && (head.readUInt32LE(0) === 0xe011cfd0 || head.readUInt32LE(0) === 0x04034b50)) return true;
  return head.toString('latin1', 0, 23) === 'HWP Document File V3.00';
}

/**
 * What a file holds, read through one handle: its first bytes, and only when those are a Hancom
 * document's -- and it is no bigger than `max` -- the rest. Returns { st, kind, buf }, with
 * `kind` as classify() says of `buf`, or 'big' (not read) or 'changed' (its size or time moved
 * while it was read); or null when it cannot be read.
 */
function readChecked(file, max = MAX_CHECK) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (_) {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const head = Buffer.alloc(Math.min(HEAD, st.size));
    const got = fs.readSync(fd, head, 0, head.length, 0);
    if (!startsAsHancom(head.subarray(0, got))) return { st, kind: null };
    if (st.size > max) return { st, kind: 'big' };
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < buf.length) {
      const k = fs.readSync(fd, buf, n, buf.length - n, n);
      if (!k) break;
      n += k;
    }
    if (n !== st.size || moved(st, fs.fstatSync(fd))) return { st, kind: 'changed' };
    return { st, kind: classify(buf), buf };
  } catch (_) {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether a copy with no known path is offered: never for a folder, and for a name when one it could have fits. */
const fitsUnplaced = (m, names) => !m.folder && names.some((n) => m.test(n));

async function scan(ctx) {
  const out = [];
  const { autosaves, backups, recent } = survey(ctx.locations.hancom || []);
  const m = ctx.matcher;
  const left = { broken: 0, hwp3: 0, big: 0, changed: 0 };
  const total = autosaves.length + backups.length;
  let done = 0;
  const tick = () => ctx.progress && ctx.progress(++done, total);

  for (const asv of autosaves) {
    // Which names it could be offered under, before reading it: its document, if one is known,
    // and otherwise its bare name or a recent document it could be, which fit a search by name
    // but never a folder.
    const could = Object.values(EXT).map((ext) => {
      const d = documentFor(asv, recent, ext);
      return d.path ? m.test(d.path) : fitsUnplaced(m, [docName(asv.name, ext), ...d.maybe]);
    });
    if (!could.some(Boolean)) {
      tick();
      continue;
    }
    const r = readChecked(asv.file);
    tick();
    if (!r) continue;
    // Hwp writes nothing else under that name, so anything that is not a whole document fails.
    if (!EXT[r.kind]) {
      left[r.kind === 'big' || r.kind === 'changed' ? r.kind : 'broken']++;
      continue;
    }
    const name = docName(asv.name, EXT[r.kind]);
    const d = documentFor(asv, recent, EXT[r.kind]);
    if (d.path ? !m.test(d.path) : !fitsUnplaced(m, [name, ...d.maybe])) continue;
    let note;
    if (d.path) note = t('autosave of {0}; its folder is the one in Hancom\'s recent documents', baseName(d.path));
    else if (d.maybe.length) note = t('autosave of {0}; which document it was is not certain: Hancom\'s recent documents have {1}', name, d.maybe.join(', '));
    else note = t('autosave of {0}; which folder that was in is not recorded', name);
    out.push({
      source: 'hancom', kind: 'hancom autosave', path: d.path, time: r.st.mtimeMs, size: r.buf.length,
      // The document's name, for when its folder is not known: shown, and used to restore it.
      name: d.path ? undefined : name,
      buffer: r.buf, draft: true, origin: asv.file, note,
    });
  }

  for (const bak of backups) {
    if (!ALL_SAVED_AS.some((ext) => m.test(joinTo(bak.folder, docName(bak.name, ext))))) {
      tick();
      continue;
    }
    const r = readChecked(bak.file);
    tick();
    if (!r) continue;
    if (!EXT[r.kind]) {
      if (r.kind in left) left[r.kind]++;
      continue;
    }
    const d = documentOfBackup(bak, recent, r.kind);
    if (d.path ? !m.test(d.path) : !fitsUnplaced(m, d.maybe)) continue;
    out.push({
      source: 'hancom', kind: 'hancom backup', path: d.path, time: r.st.mtimeMs, size: r.buf.length,
      buffer: r.buf, origin: bak.file,
      note: d.path
        ? t('the version before {0} was saved again, kept as {1}', baseName(d.path), baseName(bak.file))
        : t('an earlier version of one of {0}, kept as {1}; which of them it was is not certain', d.maybe.map(baseName).join(', '), baseName(bak.file)),
    });
  }

  if (left.broken) ctx.notes.push(t('{0} autosave(s) or backup(s) failed their check and were left out', left.broken));
  if (left.hwp3) ctx.notes.push(t('{0} backup(s) in the HWP 3 format were left out: that format has nothing to check a copy against', left.hwp3));
  if (left.big) ctx.notes.push(t('{0} .asv or .bak file(s) over {1} MB that may hold a Hancom document were not checked and were left out', left.big, MAX_CHECK / 1024 / 1024));
  if (left.changed) ctx.notes.push(t('{0} autosave(s) or backup(s) that changed while they were being read were left out; search again to read them', left.changed));
  return out;
}

function describe(ctx) {
  const places = ctx.locations.hancom || [];
  if (!places.length) return [t('No Hancom Office folder found.')];
  const lines = [];
  for (const place of places) {
    const names = filesIn(place);
    if (!names) {
      lines.push(t('{0}: could not be read', place));
      continue;
    }
    const count = (re) => names.filter((n) => re.test(n)).length;
    lines.push(t('{0}: {1} autosave(s), {2} .bak file(s), {3} shortcut(s) to recent documents or folders',
      place, count(/\.asv$/i), count(/\.bak$/i), count(/\.lnk$/i)));
  }
  const { backups, recent, documentFolders } = survey(places);
  if (recent.length) {
    lines.push(t('{0} folder(s) of recent documents searched for backups; {1} .bak file(s) in all', documentFolders, backups.length));
  }
  return lines;
}

module.exports = {
  id: 'hancom',
  label: 'Hancom Office',
  discover,
  scan,
  describe,
  roots: (loc) => loc.hancom || [],
  _internal: { readCfb, checkHwp5, checkHwpx, readZip, classify, readLink, readChecked, profileOf, crc32, tableCrc32 },
};
