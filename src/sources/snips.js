'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { t } = require('../i18n');
const { pathKey, isInside } = require('../paths');
const { SNIFF_BYTES, typeOfName, sniff } = require('../types');

// Screenshots and screen recordings the Snipping Tool took and nobody saved. Windows 11's tool
// saves every capture to Pictures\Screenshots (recordings to Videos\Screen Recordings) unless
// that is turned off in its settings; with it off, the capture is still written to the app's own
// folder, and stays there:
//
//   %LOCALAPPDATA%\Packages\Microsoft.ScreenSketch_8wekyb3d8bbwe\TempState\
//     Snips\        pictures, PNG
//     Recordings\   screen recordings, MP4
//   %LOCALAPPDATA%\Packages\Microsoft.Windows.ShellExperienceHost_cw5n1h2txyewy\TempState\
//     ScreenClip\   Windows 10's Snip & Sketch, the same kind of folder
//
// Each file is the capture exactly as it was taken, kind 'snipping tool capture' (quality.js,
// tier 0). It is named with the moment it was taken, in the local time of the machine that took
// it and in its language -- "Screenshot 2025-01-02 030405.png", "스크린샷 2025-01-02 030405.png"
// on Korean Windows -- but where it would have been saved is not known, so a copy has a `name`
// and no `path`. A capture found under a name elsewhere too, in the Recycle Bin say, is that one.
//
// Not every file there need be a capture, and newer versions of the tool may use other folders:
// TempState and every folder directly in it are read, and a plain file is offered when its first
// bytes are a picture or a video, whatever it is called. One with no extension of its format gets
// that extension added to its name, so it can be restored as one. A folder, link or pipe under a
// capture's name is not the tool's, and is not read.
//
// A copy's time is the file's own last-write time, an exact instant. When that is further from
// the time in its name than any time zone accounts for -- the folder was copied by something
// that did not keep file times -- it is not when the capture was taken, and the name's time is
// used instead, read in this machine's time zone, and the copy says so.
//
// Measured on Windows 11 with Snipping Tool 11.2607: saving is on and TempState is empty, as are
// the older Snip & Sketch folder and the tool's LocalState and LocalCache, so nothing was found
// here. The 309 captures it saved to Pictures\Screenshots (all PNG, 57 KB in the middle, 708 KB
// at most) are named as above, and for every one the time in the name is the file's creation time
// to within a second, and its last-write time to within five seconds. Given that folder by hand,
// this source offered all 309, each with its width and height, all dated by their own file, in a
// quarter of a second, and left out its desktop.ini. The layout of the tool's own folders is from
// published forensic notes (insiderthreatmatrix DT130, forscie), not seen.

const SKETCH = 'microsoft.screensketch_';
const SHELL = 'microsoft.windows.shellexperiencehost_';
const FOLDERS = ['snips', 'recordings', 'screenclip'];

// The time in a capture's name: its date, a space and the hour, minute and second run together.
const NAME_TIME = /(\d{4})-(\d{2})-(\d{2}) (\d{2})(\d{2})(\d{2})/;

// The furthest a machine's clock can be from another's for the same instant: UTC+14 against
// UTC-12, and the few seconds a capture takes to be written.
const ZONES_APART = 26 * 60 * 60 * 1000 + 60 * 1000;

// Opening without waiting, where there is such a flag, so that a file swapped for a pipe after
// the folder was listed cannot hold the search up; a plain file reads the same.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

/** The entries of a folder, or none when it cannot be read. */
function entries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

/**
 * The folders a place stands for, each the top of what is read. It can be any folder on the way
 * down from a user profile -- which is how a drive from another machine is given -- to one of
 * the tool's own folders:
 *
 *   <profile>\AppData\Local\Packages\Microsoft.ScreenSketch_<id>\TempState
 *   <profile>\AppData\Local\Packages\Microsoft.Windows.ShellExperienceHost_<id>\TempState\ScreenClip
 *
 * or a folder of captures under any name, as one copied off an old drive may be.
 */
function captureRoots(place) {
  const p = path.resolve(String(place));
  const found = [];
  const base = path.basename(p).toLowerCase();
  // The shell's TempState holds more than Snip & Sketch's clips: only its ScreenClip is read.
  const tempState = base === 'tempstate' && !path.basename(path.dirname(p)).toLowerCase().startsWith(SHELL);
  if (isDir(p) && (tempState || FOLDERS.includes(base) || holdsCaptures(p))) found.push(p);
  // A package folder: the tool's own TempState, or the shell's ScreenClip in it.
  for (const d of [path.join(p, 'TempState', 'ScreenClip'), path.join(p, 'ScreenClip')]) {
    if (isDir(d)) found.push(d);
  }
  if (base.startsWith(SKETCH) && isDir(path.join(p, 'TempState'))) found.push(path.join(p, 'TempState'));
  // Packages itself, then Local, AppData and the profile above it.
  const above = [[], ['Packages'], ['Local', 'Packages'], ['AppData', 'Local', 'Packages']];
  for (const packages of above.map((names) => path.join(p, ...names))) {
    for (const e of entries(packages)) {
      const n = e.name.toLowerCase();
      const d = n.startsWith(SKETCH) ? path.join(packages, e.name, 'TempState')
        : n.startsWith(SHELL) ? path.join(packages, e.name, 'TempState', 'ScreenClip') : null;
      if (d && isDir(d)) found.push(d);
    }
  }
  const seen = new Set();
  const unique = found.filter((d) => (seen.has(pathKey(d)) ? false : seen.add(pathKey(d))));
  // A folder inside another one found is read as part of it.
  return unique.filter((d) => !unique.some((o) => o !== d && isInside(d, o)));
}

/** Whether a folder holds a file named as a capture is, which is how a folder of them given by hand is known. */
function holdsCaptures(dir) {
  return entries(dir).some((e) => e.isFile() && NAME_TIME.test(e.name));
}

/** A root and every folder directly in it: TempState, Snips, Recordings, and whatever a newer tool adds. */
function foldersIn(root) {
  const subs = entries(root).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name)).sort();
  return [root, ...subs];
}

/**
 * Every folder behind the places given, each once. A place that stands for none is said in
 * `notes`, so that a folder given by hand and read as nothing is not taken for a tool that kept
 * no captures.
 */
function foldersOf(places, notes) {
  const seen = new Set();
  const out = [];
  for (const place of places || []) {
    const roots = captureRoots(place);
    if (!roots.length && notes) notes.push(t('{0}: no Snipping Tool folder there', place));
    for (const d of roots.flatMap(foldersIn)) {
      if (seen.has(pathKey(d))) continue;
      seen.add(pathKey(d));
      out.push(d);
    }
  }
  return out;
}

/** The plain files in a folder. A link could lead out of it, and a pipe would wait forever. */
function filesIn(dir) {
  return entries(dir).filter((e) => e.isFile()).map((e) => path.join(dir, e.name)).sort();
}

/** The first bytes of a plain file, with its size and last-write time, from one open. */
function readHead(file) {
  const fd = fs.openSync(file, OPEN_FLAGS);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(t('not a plain file'));
    const buf = Buffer.alloc(Math.min(SNIFF_BYTES, st.size));
    const got = buf.length ? fs.readSync(fd, buf, 0, buf.length, 0) : 0;
    return { head: buf.subarray(0, got), size: st.size, mtime: st.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

/** A PNG's width and height, from its IHDR chunk, which comes first; null for anything else. */
function pngSize(head) {
  if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47 || head.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  return width && height ? { width, height } : null;
}

/** The moment in a capture's name, read in this machine's time zone, or null when it names none. */
function nameTime(name) {
  const m = NAME_TIME.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const at = new Date(y, mo - 1, d, h, mi, s);
  // 2025-02-30 would roll over into March; a name that is no date is not read as one.
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d
    || at.getHours() !== h || at.getMinutes() !== mi || at.getSeconds() !== s) return null;
  return at.getTime();
}

/**
 * When a capture was taken: the file's last-write time, unless the time in its name shows that
 * is not it. Returns { time, note? }.
 */
function whenTaken(name, mtime) {
  const named = nameTime(name);
  if (named == null || Math.abs(mtime - named) <= ZONES_APART) return { time: mtime };
  return {
    time: named,
    note: t('dated by the time in its name, read in this machine\'s time zone: the file\'s own time, {0}, is not when it was taken',
      new Date(mtime).toISOString()),
  };
}

/**
 * What one file is as a capture, or a reason it is not: 'notMedia' for bytes that are no picture
 * or video. `name` has the extension of the file's format when its own says nothing of it.
 */
function captureOf(file, read) {
  const got = sniff(read.head);
  if (got.mediaType !== 'image' && got.mediaType !== 'video') return { skip: 'notMedia' };
  const own = path.basename(file);
  const name = typeOfName(own) === got.mediaType ? own : own + got.ext;
  const when = whenTaken(own, read.mtime);
  return {
    name, mediaType: got.mediaType, ext: got.ext, time: when.time,
    ...(pngSize(read.head) || {}),
    ...(when.note ? { note: when.note } : {}),
  };
}

/** This user's Snipping Tool folders. Other accounts' profiles cannot be read without administrator rights. */
function discover() {
  if (process.platform !== 'win32') return [];
  try {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return captureRoots(path.join(local, 'Packages'));
  } catch (_) {
    return [];
  }
}

async function scan(ctx) {
  // Captures are pictures and videos: a search for anything else has nothing to read here.
  if (ctx.types && !ctx.types.includes('image') && !ctx.types.includes('video')) return [];
  const out = [];
  const files = foldersOf(ctx.locations.snips, ctx.notes).flatMap(filesIn);
  let notMedia = 0;
  for (let i = 0; i < files.length; i++) {
    if (ctx.signal) ctx.signal.throwIfAborted();
    const file = files[i];
    if (ctx.progress) ctx.progress(i + 1, files.length);
    let read;
    try {
      read = readHead(file);
    } catch (e) {
      ctx.notes.push(t('Could not read {0} ({1})', file, e.code || e.message));
      continue;
    }
    const c = captureOf(file, read);
    if (c.skip) {
      notMedia++;
      continue;
    }
    if (!ctx.matcher.test(c.name)) continue;
    out.push({
      source: 'snips', kind: 'snipping tool capture', path: null, name: c.name,
      time: c.time, size: read.size, file,
      mediaType: c.mediaType, ext: c.ext,
      ...(c.width ? { width: c.width, height: c.height } : {}),
      ...(c.note ? { note: c.note } : {}),
      origin: file,
    });
  }
  if (notMedia) ctx.notes.push(t('{0} file(s) in the Snipping Tool\'s folders are not a picture or a video; left out', notMedia));
  return out;
}

function describe(ctx) {
  const places = ctx.locations.snips || [];
  if (!places.length) return [t('No Snipping Tool folder found.')];
  const lines = [];
  for (const dir of foldersOf(places, lines)) {
    const files = filesIn(dir);
    const counts = { image: 0, video: 0 };
    for (const f of files) {
      let c = null;
      try {
        c = captureOf(f, readHead(f));
      } catch (_) {
        c = null;
      }
      if (c && !c.skip) counts[c.mediaType]++;
    }
    lines.push(t('{0}: {1} file(s), {2} picture(s) and {3} recording(s) to offer', dir, files.length, counts.image, counts.video));
  }
  return lines;
}

/**
 * The folders read from, which restore will not write into: the tops behind each place, or the
 * place itself when there are none, each also by its real path. Restore compares names as they
 * are spelled, and a Packages folder moved to another drive with a junction would otherwise leave
 * the folder it leads to open to a restore naming it directly.
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
  for (const place of [].concat(loc.snips || []).filter((p) => typeof p === 'string')) {
    const tops = captureRoots(place);
    for (const d of tops.length ? tops : [path.resolve(place)]) {
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
  id: 'snips',
  label: 'Snipping Tool',
  discover,
  scan,
  describe,
  roots,
  _internal: { captureRoots, foldersOf, nameTime, whenTaken, pngSize, captureOf, ZONES_APART },
};
