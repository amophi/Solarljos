'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { t } = require('../i18n');
const { isWindowsPath, pathKey } = require('../paths');
const { HASH_LIMIT, asText } = require('../content');
const fmt = require('../format');

// Every JetBrains IDE -- IntelliJ IDEA, PyCharm, WebStorm, Rider, Android Studio and the rest --
// keeps one system folder per version:
//
//   Windows  %LOCALAPPDATA%\JetBrains\<product><version>   %LOCALAPPDATA%\Google\AndroidStudio<version>
//   macOS    ~/Library/Caches/JetBrains/...                ~/Library/Caches/Google/AndroidStudio...
//   Linux    ~/.cache/JetBrains/...                        ~/.cache/Google/AndroidStudio...
//
// Two things in it hold whole files. The layouts read here are those of platform 241 (2024.1) and
// later, checked on 261; anything else is reported and not read.
//
// caches/ is the IDE's cache of the files it has read or written, kept until the cache is
// rebuilt (Invalidate Caches). Little-endian.
//
//   records.dat   40-byte header: @0 version, @4 records in use, @16 int64 created at,
//                 @32 errors the IDE noticed. Then 40 bytes per file, id 1 first:
//                 parent, name id, flags, attributes, content id, mod count, int64 mtime, int64 length
//                 flags: 0x2 folder, 0x8 / 0x80 content / length to be reloaded, 0x10 link,
//                 0x20 special, 0x400 deleted. A deletion overwrites the flags with 0x400 alone;
//                 name, parent and content stay, and ids are not reused (vfs.reuse-deleted-file-ids
//                 is off by default). Parents lead up to a root with parent 0, named C:,
//                 //server/share or /; a jar is a root named after the jar, and is not a local file.
//                 Past the first 64 MiB, records skip the header's share of each page.
//   names.dat     an append-only log (below); record <id> is one file name in UTF-8. Earlier
//                 versions of the cache called the same log names.dat.mmap.
//   content.dat   the same log; record <id> is a SHA-1 of (decimal length, NUL, bytes), an int32
//                 size -- negative when compressed, the size being its negation -- and the bytes.
//                 Content over 8,000 bytes is compressed, as a raw LZ4 block or (by choice) zlib.
//   the log       64-byte header: "AOLM", implementation 2, format (content: 0x01000000 + 1 zlib,
//                 2 LZ4, 3 none), page size, int64 next record, int64 committed up to, count,
//                 open, then user fields, the first of them the version records.dat has. Record
//                 <id> starts at 64 + (id - 1) * 4 with an int32: bit 31 padding, bit 30 committed,
//                 low 30 bits the length including those four bytes. No record crosses a page.
//
// LocalHistory/ holds about five days of changes. Big-endian, Java's DataOutput.
//
//   changes.storageRecordIndex  32-byte header: magic (0x1f2f3f58 closed, 0x12ad34e4 in use),
//                               version 7, int64 last id, first, last, int64 the cache's created-at.
//                               Then 32 bytes per change set: int64 address, size (-1 removed),
//                               capacity, previous, next, int64 time.
//   changes.storageData         32-byte header, then each change set at its address.
//
// A change set is a version, an id, a name, a time, an activity and its changes. Two kinds of
// change hold a file: a content change holds the file as it was before (a content id and the
// file's time), and a deletion holds the whole deleted tree, each file with its time and content
// id. From 262 on, names in a tree may be name ids with a hash of the name, which is checked.
// Content ids point into caches/content.dat and mean something only while the index's
// created-at is the cache's; an IDE whose cache was rebuilt throws its Local History away for
// that reason, and so does this.
//
// A copy is offered only when its log record is committed, sits inside one page, decompresses to
// exactly its size and matches its SHA-1; a size its compressed bytes could not hold is refused
// before anything is allocated for it. A cache copy must also have the length its file record
// states, and is offered only when the file is gone or no longer the same.
//
// A content id can go stale. When the IDE sees a file change on disk without reading it, it
// records the new mtime and length, flags the content to be reloaded and keeps the old content
// id, and Local History pairs that id with the new mtime as well. A live record with the flag is
// not read. A deletion overwrites the flag, so a deleted record's mtime and length can belong to
// a newer version than its content: the length check catches most of these. Beyond that, a copy
// whose content Local History had already recorded for that path, with nothing else recorded
// there in between, is dated by that first sighting, the only time those bytes are known to have
// been on disk. With nothing to go by, the date of a deleted record can still be too new.
//
// Local History can hold an editor's text of a file instead of its bytes: text as the editor
// holds it, with LF line ends and no BOM, which need not be what was on disk. Such a copy is
// labelled "as text", unless its bytes prove they came from disk: a CR before an LF (an editor's
// text never has one), a UTF-8 BOM, or the same content recorded in the cache for that path. A
// CR on its own proves nothing, since UTF-16 without a BOM, which is how the text of a UTF-16
// file is kept, can hold a 0x0D byte inside another character; where the cache holds the file
// with a UTF-16 BOM, the bytes are read as UTF-16 before looking for a CR. Text dated after the
// newest mtime the cache saw of that file on disk, or a deleted file's text stamped once its
// change set had begun, came from an editor whose changes were never saved: it is a draft, which
// rebuild takes only when no saved copy is left. (A file whose mtime was set back, by putting an
// older copy over it, can have its version before that taken for a draft.)
//
// Some paths are never looked at, since search.js looks up every path it is given as well:
// \\wsl$ and \\wsl.localhost (a look starts a stopped WSL distro, which then writes to its disk
// image), WebDAV (a server named with @, or a DavWWWRoot share, whose client starts a service and
// keeps what it reads), and A: and B:, which can stall. Their copies are left out, with a count.
// \\.\, \\?\ and the pipe and mailslot shares name devices, not files. Any other file share is
// asked once whether it can be reached: a share that is down makes every look at a file on it
// wait for the network to give up, so its cached files are then offered without that look. A
// file with less space on disk than its size may be a cloud placeholder (OneDrive, iCloud) that
// reading would download, so it is taken as changed rather than read to compare.
//
// Measured on the machine this was written on (Android Studio, platform 261, the IDE closed):
// all 285 change sets read to the byte, and all 5,149 content records, 732 of them LZ4, matched
// their SHA-1. All 1,612 cached local files matched their SHA-1 and recorded length, none had a
// reload flag, and every one of the 1,478 still on disk with the recorded size and mtime was
// the same byte for byte. 99 cached files were gone from disk -- 53 deleted in the IDE, 46 after
// it last looked -- and 34 were older than the file there now; 6 had the recorded size with a
// moved mtime, each with all of its size on disk, so each was compared. No root was a file
// share or WSL (1 drive, 706 archives, 2 others). Local History had 12 versions with content:
// 10 hold a CR before an LF, and the other 2 are empty; no content id turned up twice at one
// path, and none was a draft. A search for everything took about 0.15 seconds.

const LH_CLOSED = 0x1f2f3f4f + 5 + 4;
const LH_DATA_CLOSED = 0x1f2f3f4f;
const IN_USE = 0x12ad34e4;
const LH_VERSION = 7;
const LH_HEADER = 32;
const LH_SLOT = 32;

const AOLM = 0x414f4c4d;
const LOG_HEADER = 64;
const LOG_IMPL = 2;
const PADDING = 0x80000000;
const COMMITTED = 0x40000000;
const LENGTH_MASK = 0x3fffffff;

const RECORD_HEADER = 40;
const RECORD = 40;
const RECORDS_PAGE = 64 * 1024 * 1024;
const PER_PAGE = Math.floor(RECORDS_PAGE / RECORD);
const ON_FIRST_PAGE = Math.floor((RECORDS_PAGE - RECORD_HEADER) / RECORD);

const F_DIR = 0x2;
const F_RELOAD = 0x8 | 0x80;
const F_NOT_PLAIN = 0x10 | 0x20;
const F_FREE = 0x400;

const FILE_ID_MAGIC = '<FILE_ID_AND_HASH>';
const TIME_BASE = 33 * 365 * 24 * 3600 * 1000;
const MAX_DEPTH = 2000;
// Past this, a compressed record's size is taken for damage rather than allocated.
const MAX_CONTENT = 4 * HASH_LIMIT;
const CRLF = Buffer.from([0x0d, 0x0a]);

// \\.\ and \\?\ name devices, and a share called pipe or mailslot names those: none is a file.
const DEVICE = /^\/\/(?:[.?]\/|[^/]+\/(?:pipe|mailslot)(?:\/|$))/i;
// Paths not to look at: WSL, WebDAV, and the floppy drives (see the top).
const UNTOUCHABLE = /^(?:[ab]:\\|\\\\(?:wsl\$|wsl\.localhost)(?:\\|$)|\\\\[^\\]*@|\\\\[^\\]+\\davwwwroot(?:\\|$))/i;

const KIND_HISTORY = 'jetbrains history';
const KIND_TEXT = 'jetbrains history, as text';
const KIND_CACHE = 'jetbrains cache';
const KIND_NAMELESS = 'jetbrains cache, name unknown';

// ---- files --------------------------------------------------------------------------------

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

/** `length` bytes from `position`, or fewer at the end of the file. */
function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, position + done);
    if (n === 0) break;
    done += n;
  }
  return done === length ? buf : buf.subarray(0, done);
}

function open(file) {
  const fd = fs.openSync(file, 'r');
  return { fd, size: fs.fstatSync(fd).size, file };
}

function close(f) {
  if (!f) return;
  try {
    fs.closeSync(f.fd);
  } catch (_) {
    /* already closed */
  }
}

// ---- Java's DataInput, as IntelliJ writes it ------------------------------------------------

/** A cursor over one change set. Every read checks the end, so a cut record throws. */
function javaReader(buf) {
  let p = 0;
  const need = (n) => {
    if (p + n > buf.length) throw new Error('record ends early');
  };
  const r = {
    get pos() {
      return p;
    },
    u8() {
      need(1);
      return buf[p++];
    },
    bool() {
      return r.u8() !== 0;
    },
    u16() {
      need(2);
      p += 2;
      return buf.readUInt16BE(p - 2);
    },
    i32() {
      need(4);
      p += 4;
      return buf.readInt32BE(p - 4);
    },
    i64() {
      need(8);
      p += 8;
      return Number(buf.readBigInt64BE(p - 8));
    },
    // DataInputOutputUtil.readINT: below 192 a byte is the value; otherwise the rest comes in
    // 7-bit groups. JavaScript's 32-bit shifts wrap exactly as Java's int shifts do.
    int() {
      const first = r.u8();
      if (first < 192) return first;
      let v = first - 192;
      for (let sh = 6; ; sh += 7) {
        const next = r.u8();
        v |= (next & 0x7f) << sh;
        if ((next & 0x80) === 0) return v;
      }
    },
    /** readLONG, whose value is never needed: only its bytes are passed over. */
    skipLong() {
      if (r.u8() < 192) return;
      while (r.u8() & 0x80) { /* continued */ }
    },
    // readTIME: 0xFF and an int64, or five bytes counted from 33 * 365 days after 1970.
    time() {
      const first = r.u8();
      if (first === 255) return r.i64();
      need(4);
      const high = (first << 8) | buf[p];
      const low = (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
      p += 4;
      return high * 16777216 + low + TIME_BASE;
    },
    // IOUtil.readUTF: a length byte and that many Latin-1 bytes, or 0xFF and Java's readUTF,
    // whose marker LONGER_THAN_64K is followed by an int32 count of UTF-16 units.
    str() {
      const len = r.u8();
      if (len === 255) {
        const s = r.modifiedUtf8();
        if (s !== 'LONGER_THAN_64K') return s;
        const n = r.i32();
        if (n < 0) return null;
        need(n * 2);
        const units = Buffer.from(buf.subarray(p, p + n * 2));
        p += n * 2;
        return units.swap16().toString('utf16le');
      }
      need(len);
      p += len;
      return buf.toString('latin1', p - len, p);
    },
    strOrNull() {
      return r.bool() ? r.str() : null;
    },
    // Java's readUTF: a uint16 byte count, then modified UTF-8. Malformed input throws, as in Java.
    modifiedUtf8() {
      const len = r.u16();
      const end = p + len;
      if (end > buf.length) throw new Error('record ends early');
      const units = [];
      while (p < end) {
        const a = buf[p++];
        if (a < 0x80) {
          units.push(a);
        } else if ((a & 0xe0) === 0xc0) {
          if (p >= end || (buf[p] & 0xc0) !== 0x80) throw new Error('malformed string');
          units.push(((a & 0x1f) << 6) | (buf[p++] & 0x3f));
        } else if ((a & 0xf0) === 0xe0) {
          if (p + 1 >= end || (buf[p] & 0xc0) !== 0x80 || (buf[p + 1] & 0xc0) !== 0x80) {
            throw new Error('malformed string');
          }
          units.push(((a & 0x0f) << 12) | ((buf[p] & 0x3f) << 6) | (buf[p + 1] & 0x3f));
          p += 2;
        } else {
          throw new Error('malformed string');
        }
      }
      let s = '';
      for (let i = 0; i < units.length; i += 8192) s += String.fromCharCode(...units.slice(i, i + 8192));
      return s;
    },
  };
  return r;
}

// ---- Local History ------------------------------------------------------------------------

function readEntry(r, depth) {
  if (depth > MAX_DEPTH) throw new Error('tree too deep');
  const type = r.int();
  const name = r.str();
  const e = { name };
  if (name === FILE_ID_MAGIC) {
    e.name = null;
    e.nameId = r.i32();
    e.nameHash = r.i32();
  }
  if (type === 0) {
    e.mtime = r.i64();
    r.bool();
    e.content = r.int();
  } else if (type === 1) {
    e.children = [];
    for (let n = r.int(); n > 0; n--) e.children.push(readEntry(r, depth + 1));
  } else {
    throw new Error('unknown entry type');
  }
  return e;
}

function readChange(r) {
  const type = r.int();
  if (type < 1 || type > 9) throw new Error('unknown change type');
  r.skipLong();
  const c = { type };
  if (type <= 7) c.path = r.str();
  if (type === 3) {
    c.content = r.int();
    c.oldTime = r.time();
  } else if (type === 4 || type === 6) {
    r.str();
  } else if (type === 5) {
    r.bool();
  } else if (type === 7) {
    c.entry = readEntry(r, 0);
  } else if (type >= 8) {
    r.str();
    r.str();
    if (type === 9) r.int();
  }
  return c;
}

/**
 * One change set, or an exception. It has to fill its record exactly: anything left over, or
 * missing, means the layout is not the one read here.
 */
function readChangeSet(buf) {
  const r = javaReader(buf);
  const version = r.int();
  if (version < 0 || version > 1) throw new Error('unknown change set version');
  r.skipLong();
  r.strOrNull();
  const time = r.time();
  if (version >= 1) {
    r.strOrNull();
    r.strOrNull();
  }
  const changes = [];
  for (let n = r.int(); n > 0; n--) changes.push(readChange(r));
  if (r.pos !== buf.length) throw new Error('record has bytes left over');
  return { time, changes };
}

/**
 * The header of a Local History folder, and a way to go through its change sets. Returns
 * { refused } when the files are not the layout read here.
 */
function openHistory(dir) {
  const indexFile = path.join(dir, 'changes.storageRecordIndex');
  const dataFile = path.join(dir, 'changes.storageData');
  let index;
  try {
    index = fs.readFileSync(indexFile);
  } catch (e) {
    return { refused: t('could not read {0} ({1})', indexFile, e.code || e.message) };
  }
  if (index.length < LH_HEADER || (index.length - LH_HEADER) % LH_SLOT !== 0) {
    return { refused: t('{0} is not a Local History index', indexFile) };
  }
  const magic = index.readUInt32BE(0);
  if ((magic !== LH_CLOSED && magic !== IN_USE) || index.readInt32BE(4) !== LH_VERSION) {
    return { refused: t('{0} is a Local History layout this does not read', indexFile) };
  }
  return {
    indexFile,
    dataFile,
    inUse: magic === IN_USE,
    created: Number(index.readBigInt64BE(24)),
    slots: (index.length - LH_HEADER) / LH_SLOT,
    index,
  };
}

/** Calls `fn(changeSet)` for every change set that reads exactly; returns how many did not. */
function eachChangeSet(hist, fn) {
  const data = open(hist.dataFile);
  let bad = 0;
  try {
    if (data.size < LH_HEADER) return 0;
    const magic = readAt(data.fd, 0, 4).readUInt32BE(0);
    if (magic !== LH_DATA_CLOSED && magic !== IN_USE) return hist.slots;
    for (let n = 0; n < hist.slots; n++) {
      const at = LH_HEADER + n * LH_SLOT;
      const address = Number(hist.index.readBigInt64BE(at));
      const size = hist.index.readInt32BE(at + 8);
      if (size <= 0) continue;
      if (address < LH_HEADER || address + size > data.size) {
        bad++;
        continue;
      }
      let set;
      try {
        set = readChangeSet(readAt(data.fd, address, size));
      } catch (_) {
        bad++;
        continue;
      }
      fn(set, n + 1);
    }
  } finally {
    close(data);
  }
  return bad;
}

/** StringUtil.stringHashCodeInsensitive, which a 262+ tree stores beside a name id. */
function nameHash(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    let c = name.charCodeAt(i);
    if (c <= 0x7a) {
      if (c >= 0x41 && c <= 0x5a) c += 32;
    } else if (c === 0x130) {
      c = 0x69;
    } else {
      const lower = String.fromCharCode(c).toLowerCase();
      if (lower.length === 1) c = lower.charCodeAt(0);
    }
    h = (Math.imul(h, 31) + c) | 0;
  }
  return h;
}

/** An entry's name: written out, or (262+) a name id whose hash has to agree. */
function entryName(entry, names) {
  if (entry.name != null) return entry.name;
  const name = names ? names.get(entry.nameId) : null;
  return name != null && nameHash(name) === entry.nameHash ? name : null;
}

/**
 * Every file in a deleted tree, with the path it had. A name that cannot be resolved loses that
 * entry and everything below it.
 */
function deletedFiles(entry, where, names, out) {
  const name = entryName(entry, names);
  if (!goodName(name)) return;
  const p = where + '/' + name;
  if (entry.children) {
    for (const c of entry.children) deletedFiles(c, p, names, out);
  } else {
    out.push({ path: p, mtime: entry.mtime, content: entry.content });
  }
}

/** The files a Delete change holds. Its path ends in the name of the entry at the top. */
function filesOfDelete(change, names) {
  const out = [];
  const cut = typeof change.path === 'string' ? change.path.lastIndexOf('/') : -1;
  if (cut <= 0 || entryName(change.entry, names) !== change.path.slice(cut + 1)) return out;
  deletedFiles(change.entry, change.path.slice(0, cut), names, out);
  return out;
}

// ---- the file cache -----------------------------------------------------------------------

/** An append-only log's header. Returns { refused } when it is not one this reads. */
function openLog(file) {
  let f;
  try {
    f = open(file);
  } catch (e) {
    return { refused: t('could not read {0} ({1})', file, e.code || e.message) };
  }
  const h = f.size >= LOG_HEADER ? readAt(f.fd, 0, LOG_HEADER) : Buffer.alloc(0);
  if (h.length < LOG_HEADER || h.readUInt32LE(0) !== AOLM || h.readInt32LE(4) !== LOG_IMPL) {
    close(f);
    return { refused: t('{0} is a cache layout this does not read', file) };
  }
  const pageSize = h.readInt32LE(12);
  const next = Number(h.readBigInt64LE(16));
  if (pageSize < LOG_HEADER || pageSize % 4 !== 0 || next < LOG_HEADER || next > f.size) {
    close(f);
    return { refused: t('{0} is a cache layout this does not read', file) };
  }
  return { ...f, format: h.readInt32LE(8), pageSize, next, count: h.readInt32LE(32), user0: h.readInt32LE(40) };
}

/**
 * Where a record sits, if <id> names one that is committed, holds data and stays within its
 * page. A log is read without being opened by its owner, so every field is checked here.
 */
function locate(log, id) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const at = LOG_HEADER + (id - 1) * 4;
  if (at + 4 > log.next) return null;
  const header = readAt(log.fd, at, 4).readUInt32LE(0);
  if ((header & PADDING) || !(header & COMMITTED)) return null;
  const total = header & LENGTH_MASK;
  if (total < 4 || at + total > log.next) return null;
  if (Math.floor(at / log.pageSize) !== Math.floor((at + total - 1) / log.pageSize)) return null;
  return { at, total };
}

/**
 * A raw LZ4 block, as net.jpountz writes it. Anything that does not fit exactly throws. No block
 * grows more than 255 times, so a larger size is refused before anything is allocated for it.
 */
function lz4Block(src, size) {
  if (!(size >= 0 && size <= (src.length + 1) * 255)) throw new Error('lz4: more than the block can hold');
  const out = Buffer.allocUnsafe(size);
  let s = 0;
  let d = 0;
  const byte = () => {
    if (s >= src.length) throw new Error('lz4: input ends early');
    return src[s++];
  };
  for (;;) {
    const token = byte();
    let lit = token >>> 4;
    if (lit === 15) for (let b = 255; b === 255;) lit += (b = byte());
    if (s + lit > src.length || d + lit > size) throw new Error('lz4: literals overrun');
    src.copy(out, d, s, s + lit);
    s += lit;
    d += lit;
    if (s === src.length) break;
    if (s + 2 > src.length) throw new Error('lz4: input ends early');
    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    if (offset === 0 || offset > d) throw new Error('lz4: bad offset');
    let len = token & 15;
    if (len === 15) for (let b = 255; b === 255;) len += (b = byte());
    len += 4;
    if (d + len > size) throw new Error('lz4: match overruns');
    for (const end = d + len; d < end; d++) out[d] = out[d - offset];
  }
  if (d !== size) throw new Error('lz4: wrong length');
  return out;
}

function contentHash(bytes) {
  return crypto.createHash('sha1').update(String(bytes.length)).update(Buffer.from([0])).update(bytes).digest();
}

/**
 * The bytes of one content record's payload, or null. The SHA-1 the IDE stored with them is
 * the check: bytes that do not match it are never returned.
 */
function decodeContent(payload, algo) {
  if (payload.length < 24) return null;
  const stored = payload.readInt32LE(20);
  const body = payload.subarray(24);
  if (-stored > MAX_CONTENT) return null;
  let bytes;
  try {
    if (stored >= 0) {
      if (body.length !== stored) return null;
      bytes = body;
    } else if (algo === 2) {
      bytes = lz4Block(body, -stored);
    } else if (algo === 1) {
      bytes = zlib.inflateSync(body, { maxOutputLength: Math.max(1, -stored) });
      if (bytes.length !== -stored) return null;
    } else {
      return null;
    }
  } catch (_) {
    return null;
  }
  return contentHash(bytes).equals(payload.subarray(0, 20)) ? Buffer.from(bytes) : null;
}

function readContent(cache, id) {
  const rec = locate(cache.content, id);
  if (!rec) return null;
  return decodeContent(readAt(cache.content.fd, rec.at + 4, rec.total - 4), cache.algo);
}

/**
 * File names by id. The log is walked from the start, as the IDE walks it, so an id that does
 * not begin a record resolves to nothing rather than to the middle of another name.
 */
function readNames(log) {
  const buf = readAt(log.fd, 0, log.next);
  const names = new Map();
  for (let at = LOG_HEADER; at + 4 <= buf.length;) {
    const header = buf.readUInt32LE(at);
    if (header === 0) break;
    const total = header & LENGTH_MASK;
    if (total < 4 || at + total > buf.length) break;
    if (!(header & PADDING) && (header & COMMITTED)) {
      names.set((at - LOG_HEADER) / 4 + 1, buf.toString('utf8', at + 4, at + total));
    }
    at += (total + 3) & ~3;
  }
  return names;
}

/** Where record <id> sits in records.dat: past the first page, the header's share is skipped. */
function recordOffset(id) {
  const n = id - 1;
  if (n < ON_FIRST_PAGE) return RECORD_HEADER + n * RECORD;
  const onLast = (n % PER_PAGE) + (PER_PAGE - ON_FIRST_PAGE);
  return (Math.floor(n / PER_PAGE) + Math.floor(onLast / PER_PAGE)) * RECORDS_PAGE + (onLast % PER_PAGE) * RECORD;
}

/**
 * The cache of one system folder, or { refused } saying why it is not read. What ties its files
 * together is checked: the content log carries records.dat's version, there is exactly one name
 * log, and a cache whose IDE noted errors in it is left alone.
 */
function openCache(caches) {
  const recordsFile = path.join(caches, 'records.dat');
  if (!isFile(recordsFile)) return { refused: t('no file cache beside it') };
  const opened = [];
  const refuse = (why) => {
    opened.forEach(close);
    return { refused: why };
  };
  const layout = (file) => refuse(t('{0} is a cache layout this does not read', file));
  try {
    const records = open(recordsFile);
    opened.push(records);
    if (records.size < RECORD_HEADER) return layout(recordsFile);
    const h = readAt(records.fd, 0, RECORD_HEADER);
    const version = h.readInt32LE(0);
    const count = h.readInt32LE(4);
    const created = Number(h.readBigInt64LE(16));
    const errors = h.readInt32LE(32);
    const end = count > 0 ? recordOffset(count) + RECORD : 0;
    if (version === 0 || count < 1 || end > records.size || (count > ON_FIRST_PAGE && records.size % RECORDS_PAGE)) {
      return layout(recordsFile);
    }
    if (errors > 0) return refuse(t('the IDE noted {0} error(s) in it', errors));

    const nameLogs = ['names.dat', 'names.dat.mmap'].map((n) => path.join(caches, n)).filter(isFile).map(openLog);
    const usable = nameLogs.filter((l) => !l.refused);
    opened.push(...usable);
    if (usable.length > 1) return refuse(t('it holds two name logs, and which one is current is unclear'));
    if (!usable.length) return refuse(nameLogs.length ? nameLogs[0].refused : t('it has no name log'));
    const content = openLog(path.join(caches, 'content.dat'));
    if (content.refused) return refuse(content.refused);
    opened.push(content);
    const algo = content.format - 0x01000000;
    if (algo < 1 || algo > 3) return layout(content.file);
    if (content.user0 !== version) return refuse(t('{0} belongs to another version of the cache', content.file));

    const cache = {
      caches, version, created, count, algo, content,
      names: readNames(usable[0]),
      table: readAt(records.fd, 0, end),
    };
    close(records);
    close(usable[0]);
    return cache;
  } catch (e) {
    return refuse(t('could not read {0} ({1})', caches, e.code || e.message));
  }
}

function closeCache(cache) {
  if (cache && !cache.refused) close(cache.content);
}

function field(cache, id, at) {
  return cache.table.readInt32LE(recordOffset(id) + at);
}

function record(cache, id) {
  const o = recordOffset(id);
  const b = cache.table;
  return {
    id,
    parent: b.readInt32LE(o),
    name: b.readInt32LE(o + 4),
    flags: b.readInt32LE(o + 8),
    content: b.readInt32LE(o + 16),
    mtime: Number(b.readBigInt64LE(o + 24)),
    length: Number(b.readBigInt64LE(o + 32)),
  };
}

const REPLACEMENT = String.fromCharCode(0xfffd);

/** A path segment that can only mean one thing. U+FFFD is what bytes that were not UTF-8 became. */
function goodName(n) {
  return typeof n === 'string' && n !== '' && n !== '.' && n !== '..' && !/[/\\\0]/.test(n) && !n.includes(REPLACEMENT);
}

/** A root's name, as the start of a path with forward slashes; null for anything not local. */
function rootPrefix(name, posixRoots) {
  if (/^[A-Za-z]:\/?$/.test(name)) return name.slice(0, 2);
  if (/^\/\/[^/]+\/[^/]+\/?$/.test(name) && !DEVICE.test(name)) return name.replace(/\/$/, '');
  if (name === '/' && posixRoots === 1) return '';
  return null;
}

/**
 * Paths of records, built through their parents and remembered per folder. Every name must
 * resolve and the top must be a local root. A deletion overwrites all flags with 0x400, so a
 * deleted folder no longer says it is one; it is taken as a folder only above records that are
 * deleted too, as a recursive deletion leaves them. A live folder must say it is one.
 */
function pathMaker(cache) {
  let posixRoots = 0;
  for (let id = 2; id <= cache.count; id++) {
    if (field(cache, id, 0) !== 0) continue;
    const flags = field(cache, id, 8);
    if (!(flags & F_FREE) && (flags & F_DIR) && cache.names.get(field(cache, id, 4)) === '/') posixRoots++;
  }
  // folder id -> { path, free }: its path with forward slashes, and whether anything from it up
  // to the root is deleted. null when it leads nowhere usable.
  const dirs = new Map();
  const dirOf = (id) => {
    const chain = [];
    let cur = id;
    let known;
    for (;;) {
      if (dirs.has(cur)) {
        known = dirs.get(cur);
        break;
      }
      if (cur < 2 || cur > cache.count || chain.length > MAX_DEPTH || chain.includes(cur)) {
        known = null;
        break;
      }
      const flags = field(cache, cur, 8);
      if (!(flags & F_FREE) && !(flags & F_DIR)) {
        known = null;
        break;
      }
      chain.push(cur);
      if (field(cache, cur, 0) === 0) {
        const name = cache.names.get(field(cache, cur, 4));
        const prefix = name == null ? null : rootPrefix(name, posixRoots);
        known = prefix == null ? null : { path: prefix, free: !!(flags & F_FREE) };
        dirs.set(chain.pop(), known);
        break;
      }
      cur = field(cache, cur, 0);
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const name = cache.names.get(field(cache, chain[i], 4));
      const free = !!(field(cache, chain[i], 8) & F_FREE);
      if (known == null || !goodName(name) || (known.free && !free)) known = null;
      else known = { path: known.path + '/' + name, free: known.free || free };
      dirs.set(chain[i], known);
    }
    return known;
  };
  return (rec) => {
    if (rec.parent === 0) return null;
    const name = cache.names.get(rec.name);
    if (!goodName(name)) return null;
    const dir = dirOf(rec.parent);
    if (dir == null || (dir.free && !(rec.flags & F_FREE))) return null;
    return toNative(dir.path + '/' + name);
  };
}

/** IntelliJ writes C:/a/b and //server/share/a; they are given back as Windows paths. */
function toNative(p) {
  if (/^[A-Za-z]:\//.test(p) || /^\/\/[^/]/.test(p)) return p.replace(/\//g, '\\');
  return p;
}

/** A Local History path, or null for anything that is not a local file (jar://, temp://...). */
function historyPath(p) {
  if (typeof p !== 'string' || /^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return null;
  if (/^[A-Za-z]:\//.test(p) || /^\/[^/]/.test(p)) return toNative(p);
  if (/^\/\/[^/]+\/[^/]/.test(p) && !DEVICE.test(p)) return toNative(p);
  return null;
}

/** \\server\share, for a path on a file share; otherwise null. */
function shareOf(p) {
  const m = /^(\\\\[^\\]+\\[^\\]+)(?:\\|$)/.exec(p);
  return m ? m[1] : null;
}

/**
 * Whether a file share can be reached, asked once per share and search: a share that is down
 * makes every look at a file on it wait for the network to give up, one after another.
 */
function shareCheck() {
  const known = new Map();
  return (share) => {
    const key = share.toLowerCase();
    if (!known.has(key)) {
      let up = false;
      try {
        up = fs.statSync(share + '\\').isDirectory();
      } catch (_) {
        up = false;
      }
      known.set(key, up);
    }
    return known.get(key);
  };
}

/** Whether a path can be looked up on this machine at all; the same rule search.js keeps. */
function checkable(p) {
  return process.platform === 'win32' ? isWindowsPath(p) : p.startsWith('/');
}

/**
 * Whether the file a cache record describes is still on disk as it was: same size and mtime,
 * or, when only the mtime moved, the same bytes. `bytes` is asked for only then. A file with
 * less space on disk than its size is not read to compare: it may be a cloud placeholder, which
 * a read would download. It counts as changed, so its copy is offered, exact if perhaps the same.
 */
function unchangedOnDisk(p, rec, bytes) {
  if (!checkable(p)) return false;
  let st;
  try {
    st = fs.statSync(p);
  } catch (_) {
    return false;
  }
  if (!st.isFile() || st.size !== rec.length) return false;
  if (Math.trunc(st.mtimeMs) === rec.mtime) return true;
  if (st.size > HASH_LIMIT || !(st.blocks * 512 >= st.size)) return false;
  const b = bytes();
  if (!b) return false;
  try {
    return fs.readFileSync(p).equals(b);
  } catch (_) {
    return false;
  }
}

/** UTF-16 bytes with no BOM as text, in the byte order given; an odd last byte is left off. */
function utf16Text(b, order) {
  const even = Buffer.from(b.subarray(0, b.length & ~1));
  return (order === 'be' ? even.swap16() : even).toString('utf16le');
}

/**
 * Whether content from Local History is certainly the bytes that were on disk. An editor's text
 * never holds a CR and is never written with a UTF-8 BOM; UTF-16 is looked at as text, since
 * its bytes can hold 0x0D inside other characters. Bytes with no BOM count only for a CR before
 * an LF, and `utf16()` -- asked only then -- names the byte order when the cache holds the same
 * file as UTF-16 with a BOM: these bytes are then that file's text without one.
 */
function provablyRaw(b, utf16 = () => null) {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return true;
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) {
    return utf16Text(b.subarray(2), b[0] === 0xff ? 'le' : 'be').includes('\r');
  }
  if (b.includes(0) || !b.includes(CRLF)) return false;
  const order = utf16();
  return order ? utf16Text(b, order).includes('\r') : true;
}

// ---- where the IDEs keep their folders ------------------------------------------------------

function cacheBases() {
  const home = os.homedir();
  let base;
  if (process.platform === 'win32') base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  else if (process.platform === 'darwin') base = path.join(home, 'Library', 'Caches');
  else base = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
  return [
    { dir: path.join(base, 'JetBrains'), only: null },
    { dir: path.join(base, 'Google'), only: /^AndroidStudio/i },
  ];
}

function isSystemDir(dir) {
  return isFile(path.join(dir, 'LocalHistory', 'changes.storageRecordIndex'))
    || isFile(path.join(dir, 'caches', 'records.dat'));
}

/** Every IDE system folder on this machine. Only reads folder listings; never throws. */
function discover() {
  const out = [];
  try {
    for (const { dir, only } of cacheBases()) {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch (_) {
        continue;
      }
      for (const n of names.sort()) {
        if (only && !only.test(n)) continue;
        const sys = path.join(dir, n);
        if (isSystemDir(sys)) out.push(sys);
      }
    }
  } catch (_) {
    /* nothing found is an answer too */
  }
  return out;
}

/**
 * What a place given for this source stands for: a system folder, its LocalHistory or caches
 * folder, or a folder holding system folders, such as %LOCALAPPDATA%\JetBrains.
 */
function systemsOf(place) {
  const dir = path.resolve(String(place));
  const sys = (base, history, caches) => ({ label: path.basename(base), dir: base, history, caches });
  if (isSystemDir(dir)) return [sys(dir, path.join(dir, 'LocalHistory'), path.join(dir, 'caches'))];
  if (isFile(path.join(dir, 'changes.storageRecordIndex'))) {
    const up = path.dirname(dir);
    return [sys(up, dir, path.join(up, 'caches'))];
  }
  if (isFile(path.join(dir, 'records.dat'))) {
    const up = path.dirname(dir);
    return [sys(up, path.join(up, 'LocalHistory'), dir)];
  }
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch (_) {
    return [];
  }
  return names
    .map((n) => path.join(dir, n))
    .filter(isSystemDir)
    .map((d) => sys(d, path.join(d, 'LocalHistory'), path.join(d, 'caches')));
}

function systemsIn(ctx) {
  const seen = new Set();
  const out = [];
  for (const place of ctx.locations.jetbrains || []) {
    for (const s of systemsOf(place)) {
      if (seen.has(pathKey(s.dir))) continue;
      seen.add(pathKey(s.dir));
      out.push(s);
    }
  }
  return out;
}

// ---- search -------------------------------------------------------------------------------

// What a search of one system folder gathers as it goes (see scan):
//   known      per path: the content ids the cache records, the newest mtime it saw, and the
//              copies of deleted records, for Local History to compare and date by
//   sightings  per path: every file Local History recorded there, in order -- content id, time,
//              whether a deletion recorded it, and the copies made of it
//   used       every content id Local History names, matched or not
//   failed, avoided, unreached   what was left out or not looked at, for the notes

/** Files in the cache. */
function scanCache(sys, cache, ctx, out, run) {
  const pathOf = pathMaker(cache);
  for (let id = 2; id <= cache.count; id++) {
    const rec = record(cache, id);
    if (rec.content <= 0 || (rec.flags & (F_DIR | F_NOT_PLAIN))) continue;
    const p = pathOf(rec);
    if (!p || !ctx.matcher.test(p)) continue;
    if (UNTOUCHABLE.test(p)) {
      run.avoided++;
      continue;
    }
    const key = pathKey(p);
    if (!run.known.has(key)) run.known.set(key, { contents: new Set(), newest: 0, freed: [] });
    const k = run.known.get(key);
    k.contents.add(rec.content);
    k.newest = Math.max(k.newest, rec.mtime);
    if (rec.flags & F_RELOAD) continue;
    const free = !!(rec.flags & F_FREE);
    const share = checkable(p) ? shareOf(p) : null;
    const unreached = share != null && !run.reach(share);
    let bytes;
    const load = () => (bytes === undefined ? (bytes = readContent(cache, rec.content)) : bytes);
    if (!unreached && unchangedOnDisk(p, rec, load)) continue;
    const b = load();
    if (!b || b.length !== rec.length) {
      run.failed++;
      continue;
    }
    if (unreached) run.unreached.set(share, (run.unreached.get(share) || 0) + 1);
    const copy = {
      source: 'jetbrains', kind: KIND_CACHE, path: p,
      time: rec.mtime > 0 ? rec.mtime : null, size: b.length, buffer: b,
      origin: `${cache.content.file} #${rec.content}`,
      note: [
        sys.label,
        free ? t('deleted in the IDE') : '',
        unreached ? t('not compared with the file: {0} could not be reached', share) : '',
      ].filter(Boolean).join(', '),
    };
    out.push(copy);
    if (free) k.freed.push({ content: rec.content, mtime: rec.mtime, copy });
  }
}

/**
 * Versions in Local History: the file before each content change, and every file of a deleted
 * tree.
 */
function scanHistory(sys, hist, cache, ctx, out, run) {
  // The byte order of a path's UTF-16 BOM in the cache, looked for only when a CR needs it.
  const orders = new Map();
  const utf16Of = (key) => () => {
    if (!orders.has(key)) {
      let order = null;
      for (const id of run.known.has(key) ? run.known.get(key).contents : []) {
        const b = readContent(cache, id);
        if (b && b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) order = 'le';
        else if (b && b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) order = 'be';
        if (order) break;
      }
      orders.set(key, order);
    }
    return orders.get(key);
  };
  const bad = eachChangeSet(hist, (set, n) => {
    for (const c of set.changes) {
      let files = [];
      let note = '';
      if (c.type === 3) {
        files = [{ path: c.path, mtime: c.oldTime, content: c.content }];
        note = t('replaced {0}', fmt.when(set.time));
      } else if (c.type === 7) {
        files = filesOfDelete(c, cache.names);
        note = t('deleted {0}', fmt.when(set.time));
      }
      for (const f of files) {
        if (f.content !== 0) run.used.add(f.content);
        const p = historyPath(f.path);
        if (!p || !ctx.matcher.test(p)) continue;
        if (UNTOUCHABLE.test(p)) {
          if (f.content !== 0) run.avoided++;
          continue;
        }
        const key = pathKey(p);
        // A version with no content still says something else was there, so it is a sighting.
        const sighting = { content: f.content, time: f.mtime, deletion: c.type === 7, copies: [] };
        if (!run.sightings.has(key)) run.sightings.set(key, []);
        run.sightings.get(key).push(sighting);
        if (f.content === 0) continue;
        const bytes = readContent(cache, f.content);
        if (!bytes) {
          run.failed++;
          continue;
        }
        const k = run.known.get(key);
        const raw = !!(k && k.contents.has(f.content)) || provablyRaw(bytes, utf16Of(key));
        // A time no disk version can have: after the newest mtime the cache saw of the file, or,
        // for a deleted file, once its change set had begun -- when the editor's text was taken.
        const draft = !raw && f.mtime > 0
          && ((k && k.newest > 0 && f.mtime > k.newest) || (c.type === 7 && f.mtime >= set.time));
        let text = '';
        if (draft) text = t('the editor\'s text, never saved');
        else if (!raw) text = t('may be the editor\'s text: line ends and BOM can differ from the file on disk');
        const copy = {
          source: 'jetbrains', kind: raw ? KIND_HISTORY : KIND_TEXT, path: p,
          time: f.mtime > 0 ? f.mtime : null, size: bytes.length, buffer: bytes,
          ...(draft ? { draft: true } : {}),
          origin: `${hist.dataFile} #${n}`,
          note: [sys.label, note, text].filter(Boolean).join(', '),
        };
        out.push(copy);
        sighting.copies.push(copy);
      }
    }
  });
  run.failed += bad;
}

/**
 * Dates copies whose content id may have gone stale. Such an id keeps turning up at its path with
 * newer mtimes, so every sighting of one content with nothing else recorded there in between is
 * dated by the first of them. A deleted record goes with the deletion that recorded the same
 * content and mtime; without one it comes after everything Local History recorded there. A
 * content that comes back after another (a revert) keeps its own date.
 */
function dateBySightings(run) {
  for (const [key, list] of run.sightings) {
    const seq = list.slice();
    for (const r of run.known.has(key) ? run.known.get(key).freed : []) {
      let i = seq.length - 1;
      while (i >= 0 && !(seq[i].deletion && seq[i].content === r.content && seq[i].time === r.mtime)) i--;
      if (i >= 0) seq[i].copies.push(r.copy);
      else seq.push({ content: r.content, time: r.mtime, copies: [r.copy] });
    }
    let first = null;
    seq.forEach((s, i) => {
      if (i === 0 || !s.content || s.content !== seq[i - 1].content) first = s.time;
      if (s.time === first) return;
      for (const copy of s.copies) {
        copy.time = first > 0 ? first : null;
        copy.note = [copy.note, t('dated when these bytes were first recorded there')].join(', ');
      }
    });
  }
}

/** Text for a search, as asText reads it; asText throws on UTF-16BE of odd length, this does not. */
function textOf(b) {
  const odd = b.length % 2 === 1 && b[0] === 0xfe && b[1] === 0xff;
  return asText(odd ? b.subarray(0, b.length - 1) : b);
}

/**
 * With nothing but text to go on, content no file record points to any more: older versions
 * whose names are gone. Only what holds the text is kept, so memory stays with the matches.
 */
function scanNameless(sys, cache, ctx, out, used) {
  const referenced = new Set(used);
  for (let id = 2; id <= cache.count; id++) {
    const c = field(cache, id, 16);
    if (c > 0) referenced.add(c);
  }
  const log = cache.content;
  for (let at = LOG_HEADER; at + 4 <= log.next;) {
    const header = readAt(log.fd, at, 4).readUInt32LE(0);
    if (header === 0) break;
    const total = header & LENGTH_MASK;
    if (total < 4) break;
    const id = (at - LOG_HEADER) / 4 + 1;
    if (!(header & PADDING) && (header & COMMITTED) && !referenced.has(id)) {
      const bytes = readContent(cache, id);
      if (bytes && bytes.length <= HASH_LIMIT && textOf(bytes).toLowerCase().includes(ctx.containing)) {
        out.push({
          source: 'jetbrains', kind: KIND_NAMELESS, path: null, time: null,
          size: bytes.length, buffer: bytes, origin: `${log.file} #${id}`, note: sys.label,
        });
      }
    }
    at += (total + 3) & ~3;
  }
}

async function scan(ctx) {
  const out = [];
  const systems = systemsIn(ctx);
  const reach = shareCheck();
  for (let i = 0; i < systems.length; i++) {
    const sys = systems[i];
    const hist = isFile(path.join(sys.history, 'changes.storageRecordIndex')) ? openHistory(sys.history) : null;
    const cache = openCache(sys.caches);
    const run = {
      known: new Map(), sightings: new Map(), used: new Set(),
      failed: 0, avoided: 0, unreached: new Map(), reach,
    };
    try {
      if (cache.refused) {
        ctx.notes.push(t('{0}: file cache not read: {1}', sys.label, cache.refused));
      } else {
        scanCache(sys, cache, ctx, out, run);
      }
      if (hist && hist.refused) {
        ctx.notes.push(t('{0}: Local History not read: {1}', sys.label, hist.refused));
      } else if (hist && cache.refused) {
        ctx.notes.push(t('{0}: Local History names its versions by the file cache, so none could be read', sys.label));
      } else if (hist && hist.created !== cache.created) {
        ctx.notes.push(t('{0}: Local History belongs to an earlier file cache, so its versions cannot be read', sys.label));
      } else if (hist) {
        scanHistory(sys, hist, cache, ctx, out, run);
        dateBySightings(run);
      }
      if (ctx.unnamed && ctx.containing && !cache.refused) scanNameless(sys, cache, ctx, out, run.used);
    } catch (e) {
      ctx.notes.push(t('{0}: stopped early ({1})', sys.label, e.code || e.message));
    } finally {
      closeCache(cache);
    }
    if (run.avoided) {
      ctx.notes.push(t('{0}: {1} file(s) on WSL, WebDAV, A: or B: were left out, since even looking at one can start a WSL distro or stall',
        sys.label, run.avoided));
    }
    for (const [share, n] of run.unreached) {
      ctx.notes.push(t('{0}: {1} could not be reached, so {2} cached file(s) on it are offered without comparing them with the files there',
        sys.label, share, n));
    }
    if (run.failed) ctx.notes.push(t('{0}: {1} record(s) failed a check and were left out', sys.label, run.failed));
    if (ctx.progress) ctx.progress(i + 1, systems.length);
  }
  return out;
}

function describe(ctx) {
  const systems = systemsIn(ctx);
  if (!systems.length) return [t('No JetBrains IDE folder found.')];
  const lines = [];
  for (const sys of systems) {
    const cache = openCache(sys.caches);
    try {
      if (cache.refused) {
        lines.push(t('{0}: file cache not read: {1}', sys.dir, cache.refused));
      } else {
        let withContent = 0;
        let deleted = 0;
        for (let id = 2; id <= cache.count; id++) {
          const flags = field(cache, id, 8);
          if (field(cache, id, 16) <= 0 || (flags & F_DIR)) continue;
          withContent++;
          if (flags & F_FREE) deleted++;
        }
        lines.push(t('{0}: file cache, {1} file(s) with content, {2} of them deleted in the IDE',
          sys.dir, withContent, deleted));
      }
      if (!isFile(path.join(sys.history, 'changes.storageRecordIndex'))) continue;
      const hist = openHistory(sys.history);
      if (hist.refused) {
        lines.push(t('{0}: Local History not read: {1}', sys.dir, hist.refused));
        continue;
      }
      let sets = 0;
      let versions = 0;
      const names = cache.refused ? null : cache.names;
      eachChangeSet(hist, (set) => {
        sets++;
        for (const c of set.changes) {
          if (c.type === 3 && c.content !== 0) versions++;
          if (c.type === 7) versions += filesOfDelete(c, names).filter((f) => f.content !== 0).length;
        }
      });
      if (cache.refused) {
        lines.push(t('{0}: Local History, {1} change set(s); not read without its file cache', sys.dir, sets));
      } else if (hist.created !== cache.created) {
        lines.push(t('{0}: Local History, {1} change set(s), from an earlier file cache; not read', sys.dir, sets));
      } else {
        lines.push(t('{0}: Local History, {1} change set(s), {2} version(s) with content', sys.dir, sets, versions));
      }
    } catch (e) {
      lines.push(t('{0}: could not be read ({1})', sys.dir, e.code || e.message));
    } finally {
      closeCache(cache);
    }
  }
  return lines;
}

/** The folders read from, which restore will not write into. */
function roots(loc) {
  const out = [];
  for (const place of loc.jetbrains || []) {
    out.push(path.resolve(String(place)));
    for (const s of systemsOf(place)) out.push(s.dir, s.history, s.caches);
  }
  return [...new Set(out)];
}

module.exports = {
  id: 'jetbrains',
  label: 'JetBrains IDEs',
  discover,
  scan,
  describe,
  roots,
  _internal: {
    javaReader, readChangeSet, lz4Block, decodeContent, contentHash, provablyRaw, nameHash, recordOffset,
    systemsOf, historyPath, openCache, closeCache, openHistory, eachChangeSet, filesOfDelete, pathMaker,
    record, readContent, unchangedOnDisk, KINDS: [KIND_HISTORY, KIND_TEXT, KIND_CACHE, KIND_NAMELESS],
  },
};
