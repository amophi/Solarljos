'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { t } = require('../i18n');
const { pathKey } = require('../paths');

// Windows 11 Notepad keeps every open tab, saved or not, so that it can bring them all back
// after a restart:
//
//   %LOCALAPPDATA%\Packages\Microsoft.WindowsNotepad_8wekyb3d8bbwe\LocalState\TabState\
//     <guid>.bin             one tab
//     <guid>.0.bin, .1.bin   that tab's caret and view options, two generations; no text
//     <guid>.bin.bak         a tab file Notepad set aside, laid out like any other
//
// A tab file is "NP", a sequence number, a header, the tab's text and a CRC32, followed by an
// edit log of what was typed since the text was last written in full. Numbers are unsigned
// LEB128 (a FILETIME takes nine bytes, so it is read as a BigInt); text is UTF-16LE, counted
// in UTF-16 units, with a lone CR for every line break; each CRC32 is stored big-endian.
//
//   type      1: a tab tied to a file   0: an untitled tab
//   type 1    path, the file's size on disk, encoding (1 ANSI, 2 UTF-16 LE, 3 UTF-16 BE,
//             4 UTF-8 with BOM, 5 UTF-8), line ending (1 CRLF, 2 CR, 3 LF), the file's
//             last-write FILETIME, SHA-256 of the file on disk, 2 bytes
//   type 0    1 byte
//   then      selection start and end, 3 option bytes, a count and that many more, the text,
//             an "unsaved" byte, and a CRC32 of everything from the type on
//   edit log  to the end of the file: position, characters deleted, characters added, the
//             added text, and a CRC32 of the entry; applied in order, each one a splice
//
// A state file has, where a tab file has its type, the number of bytes up to its CRC -- 8 or
// more -- so it can never be read as a tab. It holds no text and is not used.
//
// What a tab gives back depends on the version of Notepad that wrote it:
//   - Up to 11.2407 a file tab holds the file's text even when nothing was changed. Written
//     out with the tab's line ending and encoding, it is taken only when it has exactly the
//     recorded size and SHA-256: then it is the file as last saved, to the byte, dated by
//     the recorded FILETIME, or by nothing when that is 0. Text that cannot be matched so --
//     ANSI beyond ASCII, whose code page was the saving machine's, or a file whose mixed line
//     breaks came back all alike -- is left out, with any edits made on it, and counted.
//   - From 11.2408 an unchanged file tab holds nothing but its path. A changed one holds the
//     edited text, which was never on disk; its size and FILETIME are then those of the
//     version the edits started from.
//   - An untitled tab has its text and no name, so only a search by content alone finds it.
// Text that was never saved is a draft, dated when its tab file was last written. It is
// written out the way Notepad would save it; an ANSI file with anything beyond ASCII cannot
// be, since the code page is the saving machine's, so it comes back as UTF-8 and says so.
// A draft that comes out the same as a saved copy another tab file holds of the same file is
// that copy again, and is dropped.
// An edit log is replayed only onto text known to be the whole buffer, and only when every
// entry passes its CRC, fits inside the text, and the last one ends at the end of the file.
// Notepad adds an entry for each key pressed and folds the log into the text only when it
// saves or closes the file, so a big file edited for a long time leaves a long log, and
// splicing entries in one by one copies the whole text for each. Entries that carry on from
// the one before -- typing on, deleting forward, backspacing -- are joined into one splice
// first; that gives the same text, and fails exactly where one of them would. A log that
// would still copy more than REPLAY_WORK characters is left out rather than left to stall.
// Only plain files are read: a folder, link or pipe under a tab file's name is not Notepad's.
// Whatever fails a check is left out rather than guessed at, and the search says how many
// were.
//
// Measured on Notepad 11.2607 on Windows 11: all 22 non-empty files parsed -- 13 tab files,
// one of them a .bin.bak, and 9 state files -- and every CRC passed: 13 headers, 4 log
// entries, 9 state files, each state file naming its tab file's size. 9 tabs were tied to a
// file: 7 held only the path, and the 2 with unsaved edits recorded the size and last-write
// time of the file on disk exactly. None held a saved copy. The other 4 were untitled, the
// .bin.bak among them: a tab no longer open, whose text was left only in its edit log. On 23
// public sample tab files from older versions, all 13 saved copies hashed to the SHA-256
// Notepad recorded, and all 80 log entries passed their CRC.

const PACKAGE = 'microsoft.windowsnotepad_';
const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TAB_FILE = new RegExp(`^${GUID}\\.bin(\\.bak)?$`, 'i');
const STATE_FILE = new RegExp(`^${GUID}\\.[01]\\.bin$`, 'i');

const FILETIME_UNIX_OFFSET_MS = 11644473600000n;
const ENCODINGS = { 1: 'ANSI', 2: 'UTF-16 LE', 3: 'UTF-16 BE', 4: 'UTF-8 with BOM', 5: 'UTF-8' };
const EOL = { 1: '\r\n', 2: '\r', 3: '\n' };
// What Notepad saves a new file as.
const UTF8 = 5;
const CRLF = 1;
// The most characters one tab's edit log may copy while it is replayed: about a second's work,
// or two thousand splices far apart in a text of a million characters.
const REPLAY_WORK = 2e9;
const TOO_LARGE = Symbol('too large to replay');

// zlib.crc32 arrived in Node 22.2; the table is for 22.0 and 22.1.
let TABLE = null;
function crc32Table(buf) {
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const crc32 = typeof zlib.crc32 === 'function' ? (buf) => zlib.crc32(buf) >>> 0 : crc32Table;

/** Reads forward through a buffer; anything past the end throws. */
class Reader {
  constructor(buf, pos) {
    this.buf = buf;
    this.pos = pos;
  }

  take(n) {
    if (!Number.isSafeInteger(n) || n < 0 || this.pos + n > this.buf.length) throw new RangeError('short');
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  u8() {
    return this.take(1)[0];
  }

  big() {
    let v = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const b = this.u8();
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return v;
    }
    throw new RangeError('varint');
  }

  num() {
    const v = this.big();
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('varint');
    return Number(v);
  }

  utf16(units) {
    return this.take(units * 2).toString('utf16le');
  }

  crc() {
    return this.take(4).readUInt32BE(0);
  }
}

function filetimeToMs(ft) {
  if (ft <= 0n) return null;
  return Number(ft / 10000n - FILETIME_UNIX_OFFSET_MS);
}

/** The edit log from `at` to the end, or null when an entry is cut short or fails its CRC. */
function readLog(buf, at) {
  const r = new Reader(buf, at);
  const log = [];
  try {
    while (r.pos < buf.length) {
      const start = r.pos;
      const pos = r.num();
      const del = r.num();
      const added = r.utf16(r.num());
      if (crc32(buf.subarray(start, r.pos)) !== r.crc()) return null;
      log.push({ pos, del, added });
    }
  } catch (_) {
    return null;
  }
  return log;
}

/**
 * A tab file's header, text and edit log, or null when it is not one or its header fails its
 * CRC. `log` is null when the edit log is damaged.
 */
function parseTab(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0x4e || buf[1] !== 0x50) return null;
  const r = new Reader(buf, 2);
  const tab = { path: null };
  try {
    r.num(); // sequence number
    const from = r.pos;
    const type = r.num();
    if (type !== 0 && type !== 1) return null;
    if (type === 1) {
      tab.path = r.utf16(r.num());
      tab.savedSize = r.num();
      tab.encoding = r.u8();
      tab.eol = r.u8();
      tab.fileTime = filetimeToMs(r.big());
      tab.sha256 = Buffer.from(r.take(32));
      r.take(2);
    } else {
      r.take(1);
    }
    r.num(); // selection start
    r.num(); // selection end
    r.take(3); // word wrap, right to left, show Unicode controls
    r.take(r.num()); // options added in later versions
    tab.text = r.utf16(r.num());
    tab.unsaved = r.u8();
    if (tab.unsaved > 1) return null;
    if (crc32(buf.subarray(from, r.pos)) !== r.crc()) return null;
  } catch (_) {
    return null;
  }
  tab.log = readLog(buf, r.pos);
  return tab;
}

/** Takes `n` characters off the end of what a run of entries puts in. */
function trimEnd(run, n) {
  run.len -= n;
  while (n > 0) {
    const last = run.parts[run.parts.length - 1];
    if (last.length <= n) {
      run.parts.pop();
      n -= last.length;
    } else {
      run.parts[run.parts.length - 1] = last.slice(0, last.length - n);
      n = 0;
    }
  }
}

/**
 * The edit log as fewer splices that give the same text. A run of entries puts its text at
 * `pos` in place of `del` characters, and what it put in ends at pos + len. An entry starting
 * there -- typing on, or deleting forward -- carries the run on. One that deletes back to there
 * from inside what the run put in -- backspacing -- takes those characters off it; one that
 * deletes back from before `pos` takes the run's text and the characters before it. Anything
 * else starts a new run. A run fits the text it is applied to exactly when each of its entries
 * would have fitted in turn, so a log that does not fit is still found out.
 */
function coalesce(log) {
  const runs = [];
  let run = null;
  for (const e of log) {
    const end = run && run.pos + run.len;
    if (!run || (e.pos !== end && e.pos + e.del !== end)) {
      run = { pos: e.pos, del: e.del, parts: [], len: 0 };
      runs.push(run);
    } else if (e.pos === end) {
      run.del += e.del;
    } else if (e.pos >= run.pos) {
      trimEnd(run, e.del);
    } else {
      run.del += run.pos - e.pos;
      run.pos = e.pos;
      run.parts = [];
      run.len = 0;
    }
    if (e.added) {
      run.parts.push(e.added);
      run.len += e.added.length;
    }
  }
  return runs.map((r) => ({ pos: r.pos, del: r.del, added: r.parts.join('') }));
}

/**
 * The text after the edit log; null if an entry does not fit inside it, or TOO_LARGE when
 * replaying it would copy more than `budget` characters.
 */
function replay(text, log, budget = REPLAY_WORK) {
  let s = text;
  let work = 0;
  try {
    for (const e of coalesce(log)) {
      if (e.pos + e.del > s.length) return null;
      work += s.length + e.added.length;
      if (work > budget) return TOO_LARGE;
      s = s.slice(0, e.pos) + e.added + s.slice(e.pos + e.del);
    }
  } catch (e) {
    // Longer than a string can be here.
    if (e instanceof RangeError) return TOO_LARGE;
    throw e;
  }
  return s;
}

/** The bytes Notepad writes for its buffer, or null when that cannot be reproduced here. */
function encode(text, encoding, eol) {
  const sep = EOL[eol];
  if (!sep) return null;
  const s = text.replace(/\r/g, sep);
  switch (encoding) {
    case 5: return Buffer.from(s, 'utf8');
    case 4: return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')]);
    case 2: return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
    case 3: return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(s, 'utf16le').swap16()]);
    // ANSI is the code page of the machine that saved it; only plain ASCII is the same in all.
    case 1: return /^[\x00-\x7f]*$/.test(s) ? Buffer.from(s, 'latin1') : null;
    default: return null;
  }
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const iso = (ms) => new Date(ms).toISOString();

const count = (skipped, why) => {
  skipped[why] = (skipped[why] || 0) + 1;
};

/**
 * What one tab holds: the file as last saved, and the text that never was. A draft's time is
 * left undefined here; it is the tab file's own. What had to be left out is counted in
 * `skipped`: a saved text that does not match what Notepad recorded, a damaged edit log, one
 * too long to replay, or edits to a file whose text Notepad did not keep.
 */
function copiesOf(tab, skipped = {}) {
  const out = [];
  // The text the edit log applies to, when it is known to be the whole buffer: an untitled
  // tab's text, a changed tab's text, or a saved text that matched its hash. An unchanged tab
  // from 11.2408 on keeps no text, and replaying its log onto nothing would be wrong.
  let base = null;
  let saved = null;
  if (!tab.path || tab.unsaved) {
    base = tab.text;
  } else if (tab.text || tab.sha256.some((b) => b)) {
    // The file's text as last saved. Unless it writes out to the very bytes Notepad measured,
    // neither it nor any edit made on it can be told from a guess.
    const bytes = encode(tab.text, tab.encoding, tab.eol);
    if (!bytes || bytes.length !== tab.savedSize || !sha256(bytes).equals(tab.sha256)) {
      count(skipped, 'unverified');
      return out;
    }
    base = tab.text;
    saved = bytes;
    if (bytes.length) out.push({ kind: 'notepad, as last saved', buffer: bytes, time: tab.fileTime });
  }
  if (!tab.log) {
    count(skipped, 'damaged');
    return out;
  }
  if (base == null) {
    if (tab.log.length) count(skipped, 'noBase');
    return out;
  }
  const now = replay(base, tab.log);
  if (now === TOO_LARGE) {
    count(skipped, 'tooLarge');
    return out;
  }
  if (now == null) count(skipped, 'damaged');
  if (!now) return out;

  if (!tab.path) {
    out.push({
      kind: 'notepad, untitled, never saved', buffer: encode(now, UTF8, CRLF),
      draft: true, note: t('never saved to disk'),
    });
    return out;
  }
  const notes = [tab.fileTime != null
    ? t('never saved to disk; edits to the file as saved {0}', iso(tab.fileTime))
    : t('never saved to disk')];
  const eol = EOL[tab.eol] ? tab.eol : CRLF;
  if (eol !== tab.eol) notes.push(t('line breaks written as CRLF; the tab names a line ending not known here'));
  const bytes = encode(now, tab.encoding, eol);
  // A log that ends where it began changes nothing: the saved copy already says it all.
  if (bytes && saved && bytes.equals(saved)) return out;
  const copy = { kind: 'notepad, edits never saved', draft: true };
  if (bytes) {
    copy.buffer = bytes;
  } else {
    copy.text = now.replace(/\r/g, EOL[eol]);
    notes.push(t('written as UTF-8, while the file was {0}', ENCODINGS[tab.encoding] || t('in an encoding not known here')));
  }
  copy.note = notes.join('; ');
  out.push(copy);
  return out;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
}

/**
 * The names of the plain files in a folder. A folder, link, pipe or device under a tab file's
 * name is not Notepad's: a link could lead out of the folder, and opening a pipe waits forever.
 */
function filesIn(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch (_) {
    return [];
  }
}

/**
 * The TabState folders a place stands for. It can be any folder on the way down from a user
 * profile -- which is how a drive from another machine is given -- to the tab files:
 *
 *   <profile>\AppData\Local\Packages\Microsoft.WindowsNotepad_<id>\LocalState\TabState
 *
 * or a folder of tab files under any name.
 */
function tabStateDirs(place) {
  const p = path.resolve(String(place));
  const found = [];
  if (isDir(p) && (path.basename(p).toLowerCase() === 'tabstate' || filesIn(p).some((n) => TAB_FILE.test(n)))) {
    found.push(p);
  }
  // The package's LocalState, and the package folder.
  for (const d of [path.join(p, 'TabState'), path.join(p, 'LocalState', 'TabState')]) {
    if (isDir(d)) found.push(d);
  }
  // Packages itself, then Local, AppData and the profile above it.
  const above = [[], ['Packages'], ['Local', 'Packages'], ['AppData', 'Local', 'Packages']];
  for (const packages of above.map((names) => path.join(p, ...names))) {
    for (const n of listDir(packages)) {
      if (!n.toLowerCase().startsWith(PACKAGE)) continue;
      const d = path.join(packages, n, 'LocalState', 'TabState');
      if (isDir(d)) found.push(d);
    }
  }
  const seen = new Set();
  return found.filter((d) => (seen.has(pathKey(d)) ? false : seen.add(pathKey(d))));
}

/**
 * Every TabState folder behind the places given, each once. A place that stands for none is
 * said in `notes`, so that a folder given by hand and read as nothing is not taken for a
 * Notepad that kept no tabs.
 */
function foldersOf(places, notes) {
  const seen = new Set();
  const out = [];
  for (const place of places || []) {
    const dirs = tabStateDirs(place);
    if (!dirs.length && notes) notes.push(t('{0}: no Notepad TabState folder there', place));
    for (const d of dirs) {
      if (seen.has(pathKey(d))) continue;
      seen.add(pathKey(d));
      out.push(d);
    }
  }
  return out;
}

function tabFiles(dir) {
  return filesIn(dir).filter((n) => TAB_FILE.test(n)).sort().map((n) => path.join(dir, n));
}

// Opening without waiting, where there is such a flag, so that a file swapped for a pipe after
// the folder was listed cannot hold the search up either; a plain file reads the same.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);

/** The bytes of a plain file and when it was last written, from one open. */
function readWithTime(file) {
  const fd = fs.openSync(file, OPEN_FLAGS);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(t('not a plain file'));
    return { buf: fs.readFileSync(fd), mtime: st.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

/** This user's Notepad tab folder. Other accounts' profiles cannot be read without administrator rights. */
function discover() {
  if (process.platform !== 'win32') return [];
  try {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return tabStateDirs(path.join(local, 'Packages'));
  } catch (_) {
    return [];
  }
}

async function scan(ctx) {
  const out = [];
  const files = foldersOf(ctx.locations.notepad, ctx.notes).flatMap(tabFiles);
  let failed = 0;
  const skipped = {};
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (ctx.progress) ctx.progress(i + 1, files.length);
    let read;
    try {
      read = readWithTime(file);
    } catch (e) {
      ctx.notes.push(t('Could not read {0} ({1})', file, e.code || e.message));
      continue;
    }
    const tab = parseTab(read.buf);
    if (!tab) {
      failed++;
      continue;
    }
    if (tab.path ? !ctx.matcher.test(tab.path) : !ctx.unnamed) continue;
    for (const c of copiesOf(tab, skipped)) {
      const size = c.buffer ? c.buffer.length : Buffer.byteLength(c.text, 'utf8');
      out.push({
        source: 'notepad', kind: c.kind, path: tab.path,
        time: c.time === undefined ? read.mtime : c.time, size,
        ...(c.buffer ? { buffer: c.buffer } : { text: c.text }),
        ...(c.draft ? { draft: true } : {}),
        ...(c.note ? { note: c.note } : {}),
        origin: file,
      });
    }
  }
  if (failed) ctx.notes.push(t('{0} tab file(s) failed their checksum or have a layout not known here; left out', failed));
  if (skipped.unverified) {
    ctx.notes.push(t('{0} tab(s) hold a saved file\'s text that could not be matched to the size and SHA-256 '
      + 'Notepad recorded (as with ANSI text beyond ASCII, or mixed line breaks); left out, with any edits made on it',
    skipped.unverified));
  }
  if (skipped.damaged) {
    ctx.notes.push(t('{0} tab(s) have a damaged edit log; the text typed into them was left out', skipped.damaged));
  }
  if (skipped.tooLarge) {
    ctx.notes.push(t('{0} tab(s) have an edit log too large to replay; the text typed into them was left out',
      skipped.tooLarge));
  }
  if (skipped.noBase) {
    ctx.notes.push(t('{0} tab(s) hold edits to a file Notepad kept no copy of; they cannot be rebuilt and were left out',
      skipped.noBase));
  }
  return withoutEchoes(out);
}

/**
 * Drafts that are a saved copy again. A tab typed back to what another tab file holds as the
 * same file saved adds nothing, and the search would merge the two into one copy dated by the
 * draft's tab file, later than that text was saved.
 */
function withoutEchoes(copies) {
  const saved = new Map();
  for (const c of copies) {
    if (c.draft || !c.buffer) continue;
    const key = pathKey(c.path);
    saved.set(key, [...(saved.get(key) || []), c.buffer]);
  }
  return copies.filter((c) => {
    if (!c.draft || !c.path || !saved.has(pathKey(c.path))) return true;
    const bytes = c.buffer || Buffer.from(c.text, 'utf8');
    return !saved.get(pathKey(c.path)).some((b) => b.equals(bytes));
  });
}

function describe(ctx) {
  const places = ctx.locations.notepad || [];
  if (!places.length) return [t('No Notepad tab folder found.')];
  const lines = [];
  for (const dir of foldersOf(places, lines)) {
    const files = tabFiles(dir);
    const states = filesIn(dir).filter((n) => STATE_FILE.test(n)).length;
    let readable = 0;
    let withText = 0;
    for (const f of files) {
      let tab = null;
      try {
        tab = parseTab(readWithTime(f).buf);
      } catch (_) {
        tab = null;
      }
      if (!tab) continue;
      readable++;
      if (copiesOf(tab).length) withText++;
    }
    lines.push(t('{0}: {1} tab file(s), {2} readable, {3} with text to offer; {4} state file(s), which hold no text',
      dir, files.length, readable, withText, states));
  }
  return lines;
}

/**
 * The folders read from, which restore will not write into: the TabState folders behind each
 * place, or the place itself when there are none, each also by its real path. Restore compares
 * names as they are spelled, and a Packages folder moved to another drive with a junction
 * would otherwise leave the folder it leads to open to a restore naming it directly.
 */
function roots(loc) {
  const out = [];
  const seen = new Set();
  const add = (d) => {
    if (!seen.has(pathKey(d))) {
      seen.add(pathKey(d));
      out.push(d);
    }
  };
  for (const place of loc.notepad || []) {
    const dirs = tabStateDirs(place);
    for (const d of dirs.length ? dirs : [path.resolve(String(place))]) {
      add(d);
      try {
        add(fs.realpathSync.native(d));
      } catch (_) {
        /* not there: nothing is read from it */
      }
    }
  }
  return out;
}

module.exports = {
  id: 'notepad',
  label: 'Windows Notepad',
  discover,
  scan,
  describe,
  roots,
  _internal: {
    parseTab, readLog, coalesce, replay, encode, copiesOf, withoutEchoes, tabStateDirs, crc32, crc32Table,
    REPLAY_WORK, TOO_LARGE,
  },
};
