'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { t } = require('../i18n');
const fmt = require('../format');
const { isWindowsPath } = require('../paths');
const { breather } = require('../breather');

// Volume Shadow Copies are read-only point-in-time snapshots of a whole volume, kept by the
// same mechanism as System Restore. Each one is exposed as a device:
//
//   \\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyN
//
// Inside it the volume appears exactly as it was when the snapshot was taken: C:\a\b.txt is at
// <device>\a\b.txt, with that file's own size and mtime, and its bytes are the bytes that were
// on disk -- so a copy is exact by construction, with nothing to rebuild or check.
//
// Enumerating snapshots the documented way (vssadmin, or WMI's Win32_ShadowCopy) needs an
// administrator prompt, and vssadmin's output is localized. But *reading* a snapshot is not
// gated by elevation: it is governed by each file's own ACL, the way \\?\GLOBALROOT paths were
// in CVE-2021-36934. So this source does not shell out at all -- spawning powershell.exe would
// itself rewrite a file in the user's profile, which the tool must never do. Instead it:
//
//   1. Probes device numbers 1..1024 with readdirSync(dev + '\\'). A present device root lists;
//      an absent one throws ENOENT. (statSync on a present device root throws EISDIR, so it is
//      not used for the probe.) Numbers keep climbing as snapshots are made and pruned, and are
//      not reused promptly, so a fixed ceiling is needed; 1024 sits far above the handful a
//      client keeps. Measured on this machine (NVMe): probing to 256 took ~2 ms, to 1024
//      ~6 ms, to 4096 ~23 ms, so the ceiling is cheap and could be raised.
//   2. Maps each snapshot to its live drive by serial: stat(<snapshot>\<top folder>, {bigint})
//      .dev equals stat(<drive>:\, {bigint}).dev for the drive the snapshot froze. Measured
//      here: both snapshots reported serial 2a47ba5b, matching C:. Several letters can report
//      one serial -- a subst drive, a letter mapped to a share of this machine, a cloned disk --
//      and then folder IDs decide: all 16 top folders of each snapshot here have the dev and ino
//      of the live C: folder of the same name. A snapshot that matches no letter, or more than
//      one, is skipped rather than guessed at. Only a device root is mapped this way; any other
//      folder has to be given with the drive it stands for.
//
// Links are where a snapshot leaks. Windows resolves a junction or an absolute symlink inside
// a snapshot against the LIVE namespace: measured here, <snapshot>\Users\USER\My Documents (the
// legacy junction to Documents) led to the live package.json -- 854 bytes, the live file's ino
// -- in both snapshots, one of which never had the file. So before a folder is read, each step
// of its path below the snapshot root is lstat'd (Node reports junctions as links too). A link
// that is relative, or whose target is on the snapshot's own drive, is followed by hand inside
// the same snapshot: readlink there gives the target as it was (C:\Users\USER\Documents, with
// no \??\ prefix). Measured after that change: the project searched through My Documents gave
// the same 22 rows as through Documents, with the older 809-byte package.json from snapshot 5
// only; and 5 of 5 folders under Users\All Users (a link to C:\ProgramData) matched the
// snapshot's own ProgramData. Any other link (another drive, a share, a volume mount point
// readlink will not name), or a '..' in the path, gets the folder skipped with a note. Links
// among a folder's entries are never followed at all.
//
// It never walks a whole snapshot. A deep walk of a drive root is refused, and Windows, System
// Volume Information and any System32\config (the registry hives, readable inside snapshots on
// machines where the CVE-2021-36934 ACLs remain; Windows.old keeps one too) are never read;
// here those ACLs are fixed, and config gives EPERM in both snapshots. In rebuild/under mode it
// maps the target folder into each snapshot on the matching drive and walks only that
// subtree. For a search by name or type (it runs as a follow-up, after the other sources) it
// walks any folder given with --location vss=walk=<folder>, then the current user's folders --
// Desktop, Documents, Downloads, Pictures, Videos and Music, the same three media folders of
// Users\Public, OneDrive's folder from its variables, Dropbox, and the folder KakaoTalk saves
// chat photos into -- skipping AppData, node_modules and .git; then it reads the folders where
// the other sources found something, one level each. With types asked for, the folders that
// mostly hold them go first, and the matcher leaves out every name of another type before
// anything is read, so a search for pictures stats only files named as pictures. Both kinds of
// folder have a budget, shared across snapshots, and what it cuts is reported.
//
// With no name to go on (--type image and no pattern) nearly every file walked is still on disk
// as it was, which is no loss to recover; a copy whose live file at the same place has the same
// size and mtime is left out and counted in a note. Measured here, read-only, over the two
// snapshots: a search for pictures read 4,730 and 4,774 folders (Desktop ~1,590 and Documents
// ~2,900 each, Downloads 238, Pictures 2) in 1.1 s in all, search included; 2,986 copies were
// the same as the live file and 4 pictures were offered, all four gone from disk. Pictures,
// Videos, Music and Public added ~0.1 s per snapshot. Before the live look, the three folders
// alone gave 2,404 copies in 3.1 s, each then read whole to be hashed. For videos: 1.1-1.4 s,
// none offered.
//
// The snapshot's own creation time is not readable without admin, so candidate times are each
// file's mtime; an approximate snapshot time (the newest mtime seen) is kept for notes only,
// in local time like every other time shown.
//
// Cloud placeholders (OneDrive Files-On-Demand) are reparse points, and readdir types every
// reparse point as a link (measured here: 29 of 29 AppExecLink files in WindowsApps), so they
// are skipped with the links and never offered. No cloud file was exercised on this machine:
// its OneDrive folder holds one plain file. Every offered file must also open and give its last
// byte; one that does not (an ACL that allows reading its attributes only, say) is skipped and
// counted.
//
// Verified read-only on this machine: of two readable snapshots, snapshot 5 held an older
// package.json of this very project -- 809 bytes against 854 live, a different blob -- with a
// length-verified read; it was absent from snapshot 4.

const SHADOW_DEVICE = '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy';
const DEVICE_ROOT = /^\\\\[?.]\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy\d+\\?$/i;
const DRIVE_ROOT = /^[A-Za-z]:[\\/]?$/;
const DEVICE_PROBE_MAX = 1024;
const MAX_WALK_DIRS = 50000;
const MAX_PRIOR_FOLDERS = 5000;
const MAX_TOP_FOLDERS = 8;
const NOTE_LIST = 3;
const SKIP_DIRS = new Set(['appdata', 'node_modules', '.git']);

// The folders below the profile walked in a search by name or type, with the types each mostly
// holds (null: anything). Pictures holds what a phone or camera import leaves -- Camera Roll,
// Saved Pictures, Screenshots, and the dated folders Photos' import makes -- videos among them.
const USER_FOLDERS = [
  ['Desktop', null], ['Documents', null], ['Downloads', null],
  ['Pictures', ['image', 'video']], ['Videos', ['video']], ['Music', ['audio']],
];
// The same three in the profile every user shares, C:\Users\Public.
const PUBLIC_FOLDERS = [['Pictures', ['image', 'video']], ['Videos', ['video']], ['Music', ['audio']]];
// OneDrive's own folder, from the variables its client sets; with folder backup on, Desktop,
// Documents and Pictures live inside it, under names in the system's language.
const ONEDRIVE_VARS = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'];
// KakaoTalk's settings, one folder per account; each file is a few hundred bytes.
const KAKAO_USERS = ['Kakao', 'KakaoTalk', 'users'];
const MAX_KAKAO_USERS = 16;
const MAX_INI_BYTES = 64 * 1024;

/**
 * This machine as the walk sees it: whether it is Windows, the profile, the environment, and how
 * to look at a live file. Tests put a fixture profile in its place, so no real one is read.
 */
const HOST = {
  windows: process.platform === 'win32',
  home: () => os.homedir(),
  env: process.env,
  // A Windows original path can be looked up only on Windows.
  stat: process.platform === 'win32' ? (p) => fs.statSync(p) : null,
};

// --- path helpers ---------------------------------------------------------
// Physical paths (what we read) use the running platform: a device path on Windows, a fixture
// folder on the CI runner. Original paths (what we report) are always Windows paths, rebuilt
// with path.win32 whatever the platform, since a shadow copy is a Windows thing.

/** The relative segments of a Windows path below its drive: C:\a\b -> ['a','b']. */
function relBelowDrive(winPath) {
  return String(winPath).slice(2).split(/[\\/]+/).filter(Boolean);
}

/** The lowercase drive key of a Windows path (`c:`), or null if it has no drive letter. */
function driveKeyOf(winPath) {
  return /^[a-zA-Z]:/.test(String(winPath)) ? String(winPath).slice(0, 2).toLowerCase() : null;
}

/** A drive root normalized to end with a single separator: `C:` or `C:\` -> `C:\`. */
function normalizeDriveRoot(dr) {
  return String(dr).replace(/[\\/]*$/, '') + '\\';
}

/** The original Windows path of a file, from its drive root and the segments below it. */
function toOriginal(driveRoot, segs) {
  return path.win32.join(normalizeDriveRoot(driveRoot), ...segs);
}

/** A folder as given, for a note: unlike toOriginal it keeps any '..', which is the point. */
function shown(driveRoot, segs) {
  return normalizeDriveRoot(driveRoot) + segs.join('\\');
}

/**
 * A physical folder inside a snapshot. The root itself keeps a trailing separator: a shadow
 * device root does not open without one (path.join would drop it; readdir then gives EPERM).
 */
function snapDir(root, segs) {
  if (segs.length) return path.join(root, ...segs);
  return root.endsWith(path.sep) ? root : root + path.sep;
}

/** Lists a device or folder root. */
function readRoot(root, withTypes) {
  return fs.readdirSync(snapDir(root, []), withTypes ? { withFileTypes: true } : undefined);
}

/**
 * System folders never read from a snapshot, by lowercase segments below the drive: Windows
 * and System Volume Information at the top, and a System32\config anywhere (Windows.old keeps
 * one too) -- the registry hives, the credential ones among them.
 */
function isSystemFolder(segs) {
  const low = segs.map((s) => s.toLowerCase());
  if (low[0] === 'windows' || low[0] === 'system volume information') return true;
  for (let i = 0; i + 1 < low.length; i++) {
    if (low[i] === 'system32' && low[i + 1] === 'config') return true;
  }
  return false;
}

// --- staying inside the snapshot ------------------------------------------

const OUTSIDE = Object.freeze({ out: true, segs: null });
const MISSING = Object.freeze({ out: false, segs: null });

/**
 * A link's target as segments below the snapshot root, when it stays inside the snapshot: a
 * relative target, taken from the link's own folder (`base`), or an absolute one on the
 * snapshot's own drive. Anything else -- another drive, a share, a rooted or drive-relative
 * target, a mount point readlink will not name -- is null.
 */
function linkTarget(snap, phys, base) {
  let target;
  try {
    target = fs.readlinkSync(phys);
  } catch (_) {
    return null;
  }
  if (/^[a-zA-Z]:[\\/]/.test(target)) return driveKeyOf(target) === snap.driveKey ? relBelowDrive(target) : null;
  if (/^[\\/]/.test(target) || /^[a-zA-Z]:/.test(target)) return null;
  const segs = base.slice();
  for (const part of target.split(/[\\/]+/).filter(Boolean)) {
    if (part === '.') continue;
    if (part !== '..') segs.push(part);
    else if (segs.length) segs.pop();
    else return null;
  }
  return segs;
}

/** One step down from a folder already confined: a plain folder, a link followed, or a way out. */
function stepInto(snap, base, name) {
  if (name === '.' || name === '..') return OUTSIDE;
  const here = [...base, name];
  const phys = path.join(snap.root, ...here);
  let st;
  try {
    st = fs.lstatSync(phys);
  } catch (_) {
    return MISSING;
  }
  if (!st.isSymbolicLink()) return { out: false, segs: here };
  const target = linkTarget(snap, phys, base);
  return target ? confine(snap, target) : OUTSIDE;
}

/**
 * Where a folder really is inside a snapshot: its segments below the root with every link on
 * the way followed by hand, so the path finally read has no link in it and cannot leave the
 * snapshot. Gives { segs } (null when the folder is not there) or { out: true } when the path
 * leads outside. Cached per snapshot, since folders share their first steps; a link loop ends
 * as outside.
 */
function confine(snap, segs) {
  const cache = snap.confined || (snap.confined = new Map());
  const key = segs.join('\\').toLowerCase();
  if (cache.has(key)) return cache.get(key);
  cache.set(key, OUTSIDE);
  let res = { out: false, segs: [] };
  if (segs.length) {
    const up = confine(snap, segs.slice(0, -1));
    res = up.segs ? stepInto(snap, up.segs, segs[segs.length - 1]) : up;
  }
  cache.set(key, res);
  return res;
}

// --- device discovery and drive mapping -----------------------------------

/** The device roots `<prefix>1` .. `<prefix><max>` that list. Writes nothing and never throws. */
function probeDevices(prefix, max) {
  const out = [];
  for (let n = 1; n <= max; n++) {
    const dev = prefix + n;
    try {
      fs.readdirSync(dev + path.sep);
      out.push(dev);
    } catch (_) {
      /* absent (ENOENT) or unreadable: not a snapshot we can use */
    }
  }
  return out;
}

/** Present shadow-copy device roots on this machine. Writes nothing and never throws. */
function discover() {
  return process.platform === 'win32' ? probeDevices(SHADOW_DEVICE, DEVICE_PROBE_MAX) : [];
}

/** The live drive roots by volume serial (as hex); several letters can share one. */
function liveDriveRoots() {
  const bySerial = new Map();
  if (process.platform !== 'win32') return bySerial;
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = letter + ':\\';
    try {
      const serial = fs.statSync(root, { bigint: true }).dev.toString(16);
      bySerial.set(serial, [...(bySerial.get(serial) || []), root]);
    } catch (_) {
      /* no such drive */
    }
  }
  return bySerial;
}

/** A snapshot root's first top-level folders with their dev and ino, for its serial and drive. */
function topFolders(root) {
  let entries;
  try {
    entries = readRoot(root, true);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (out.length >= MAX_TOP_FOLDERS) break;
    if (!e.isDirectory()) continue;
    try {
      const st = fs.statSync(path.join(root, e.name), { bigint: true });
      out.push({ name: e.name, dev: st.dev, ino: st.ino });
    } catch (_) {
      /* try the next folder */
    }
  }
  return out;
}

const bigStat = (p) => fs.statSync(p, { bigint: true });

/**
 * The drive a snapshot froze, among the live drive roots that share its serial. With one, that
 * is it. With several, the one whose folder of the same name has the same dev and ino as one of
 * the snapshot's top folders; if that is not exactly one, null -- no guess.
 */
function pickDrive(roots, tops, stat = bigStat) {
  if (!roots || !roots.length) return null;
  if (roots.length === 1) return roots[0];
  const same = roots.filter((root) => tops.some((top) => {
    try {
      const st = stat(root + top.name);
      return st.dev === top.dev && st.ino === top.ino;
    } catch (_) {
      return false;
    }
  }));
  return same.length === 1 ? same[0] : null;
}

/**
 * A vss location is one of:
 *   <snapshot root>=<drive root>   an explicit mapping (a drive from another machine, or a test)
 *   <shadow-copy device root>      mapped to a drive by serial
 *   walk=<folder>                  an extra user folder to include in a name search
 * The explicit form makes the device probe and the drive mapping injectable for tests.
 */
function parseLocations(entries) {
  const snaps = [];
  const walkFolders = [];
  for (const raw of entries || []) {
    const e = String(raw).trim();
    if (!e) continue;
    if (/^walk=/i.test(e)) {
      walkFolders.push(e.slice(5).trim());
      continue;
    }
    const at = e.lastIndexOf('=');
    if (at > 0) snaps.push({ root: e.slice(0, at).trim(), driveRoot: e.slice(at + 1).trim() });
    else snaps.push({ root: e, driveRoot: null });
  }
  return { snaps, walkFolders };
}

/** Snapshots resolved to {root, driveRoot, driveKey}, dropping any that cannot be mapped. */
function resolveSnapshots(entries, notes) {
  const { snaps } = parseLocations(entries);
  let live = null;
  const out = [];
  const seen = new Set();
  for (const s of snaps) {
    let driveRoot = s.driveRoot;
    if (driveRoot) {
      if (!DRIVE_ROOT.test(driveRoot)) {
        notes.push(t('{0}: {1} is not a drive root such as C:\\; skipped.', s.root, driveRoot));
        continue;
      }
    } else {
      // Any folder on C: reports C:'s serial, so only a real device root is mapped by it.
      if (!DEVICE_ROOT.test(s.root)) {
        notes.push(t('{0}: not a shadow-copy device; give the drive it stands for, as in {0}=C:\\. Skipped.', s.root));
        continue;
      }
      if (!live) live = liveDriveRoots();
      const tops = topFolders(s.root);
      driveRoot = tops.length ? pickDrive(live.get(tops[0].dev.toString(16)), tops) : null;
      if (!driveRoot) {
        notes.push(t('{0}: could not tell which drive this snapshot belongs to; skipped.', s.root));
        continue;
      }
    }
    const key = s.root.toLowerCase() + '\0' + normalizeDriveRoot(driveRoot).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ root: s.root, driveRoot: normalizeDriveRoot(driveRoot), driveKey: driveKeyOf(driveRoot) });
  }
  return out;
}

// --- reading files out of a snapshot --------------------------------------

/**
 * Whether a file can be read: it opens and gives its last byte. stat's size is the stream's end
 * of file, so this cannot see bytes that are missing -- cloud placeholders are kept out by the
 * link skip instead. What it catches is a file whose attributes can be read but not its data.
 * An empty file is fine as it is.
 */
function bytesPresent(phys, size) {
  if (size === 0) return true;
  let fd;
  try {
    fd = fs.openSync(phys, 'r');
    return fs.readSync(fd, Buffer.alloc(1), 0, 1, size - 1) === 1;
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* already gone */
      }
    }
  }
}

function candidate(snap, phys, segs, st) {
  return {
    source: 'vss',
    kind: 'shadow copy',
    path: toOriginal(snap.driveRoot, segs),
    time: st.mtimeMs,
    size: st.size,
    file: phys,
    origin: phys,
    note: snap.approx ? t('snapshot taken about {0}', snap.approx) : undefined,
  };
}

/** What a scan left out, for its notes. */
function newSkipped() {
  return { unreadable: 0, unchanged: 0, outside: new Set(), system: new Set(), whole: new Set() };
}

/** Throws when the search this scan is part of has been stopped. */
function stopIfAsked(ctx) {
  if (ctx.signal) ctx.signal.throwIfAborted();
}

/**
 * Whether the file still at a copy's original place has the copy's size and time, so that the
 * copy has nothing to give that the live file does not. Never true where that cannot be looked
 * up: off Windows, or when the live file is not there.
 */
function sameAsLive(original, st) {
  if (!HOST.stat) return false;
  try {
    const live = HOST.stat(original);
    return live.isFile() && live.size === st.size && live.mtimeMs === st.mtimeMs;
  } catch (_) {
    return false;
  }
}

/**
 * One matched file, added unless it cannot be read -- or, with `dropUnchanged`, unless the file
 * at its original place is the same size and time. Returns 0 or 1. The matcher tests the name,
 * and with ctx.types its extension, before anything is read, so a search for pictures stats
 * only files named as pictures.
 */
function offerFile(snap, phys, segs, ctx, out, skipped, dropUnchanged) {
  const original = toOriginal(snap.driveRoot, segs);
  if (!ctx.matcher.test(original)) return 0;
  let st;
  try {
    st = fs.statSync(phys);
  } catch (_) {
    return 0;
  }
  if (!st.isFile()) return 0;
  if (dropUnchanged && sameAsLive(original, st)) {
    skipped.unchanged++;
    return 0;
  }
  if (!bytesPresent(phys, st.size)) {
    skipped.unreadable++;
    return 0;
  }
  out.push(candidate(snap, phys, segs, st));
  return 1;
}

/**
 * The physical segments of a folder about to be read, or null when it is not to be read: it is
 * not in the snapshot, it is a system folder, or its path leads out of the snapshot (the last
 * two are noted).
 */
function enterFolder(snap, segs, skipped) {
  const original = shown(snap.driveRoot, segs);
  if (isSystemFolder(segs)) {
    skipped.system.add(original);
    return null;
  }
  const where = segs.some((s) => s === '.' || s === '..') ? OUTSIDE : confine(snap, segs);
  if (where.out) {
    skipped.outside.add(original);
    return null;
  }
  if (!where.segs) return null;
  if (isSystemFolder(where.segs)) {
    skipped.system.add(original);
    return null;
  }
  return where.segs;
}

/**
 * The direct files of one folder inside a snapshot (no recursion). `budget` is { dirs, max, cut },
 * shared by the folders of one search, one folder read each.
 */
function scanFolderShallow(snap, folderSegs, ctx, out, skipped, budget, dropUnchanged) {
  if (budget.dirs >= budget.max) {
    budget.cut = true;
    return;
  }
  const phys = enterFolder(snap, folderSegs, skipped);
  if (!phys) return;
  const dir = snapDir(snap.root, phys);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  budget.dirs++;
  for (const e of entries) {
    if (e.isSymbolicLink() || !e.isFile()) continue;
    offerFile(snap, path.join(dir, e.name), [...folderSegs, e.name], ctx, out, skipped, dropUnchanged);
  }
}

/**
 * Every file below one folder inside a snapshot, skipping AppData, node_modules, .git and the
 * system folders. `budget` is { dirs, max, cut }, shared by the walks of one search; `breathe`
 * gives the event loop its turns while the folders are read, which takes seconds.
 */
async function walkSubtree(snap, folderSegs, ctx, out, skipped, budget, dropUnchanged, breathe = breather()) {
  if (!folderSegs.length) {
    skipped.whole.add(shown(snap.driveRoot, []));
    return;
  }
  const start = enterFolder(snap, folderSegs, skipped);
  if (!start) return;
  // Below the start, `rel` is the same for the original path and the physical one.
  const stack = [[]];
  while (stack.length) {
    if (budget.dirs >= budget.max) {
      budget.cut = true;
      return;
    }
    stopIfAsked(ctx);
    await breathe();
    const rel = stack.pop();
    const dir = snapDir(snap.root, [...start, ...rel]);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    budget.dirs++;
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const segs = [...folderSegs, ...rel, e.name];
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
        if (isSystemFolder(segs) || isSystemFolder([...start, ...rel, e.name])) {
          skipped.system.add(shown(snap.driveRoot, segs));
          continue;
        }
        stack.push([...rel, e.name]);
      } else if (e.isFile()) {
        offerFile(snap, path.join(dir, e.name), segs, ctx, out, skipped, dropUnchanged);
      }
    }
  }
}

/** The newest mtime among a folder's direct entries, for an approximate snapshot time. */
function newestTop(dir) {
  let newest = 0;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return 0;
  }
  for (const name of names) {
    try {
      const m = fs.lstatSync(path.join(dir, name)).mtimeMs;
      if (m > newest) newest = m;
    } catch (_) {
      /* skip */
    }
  }
  return newest;
}

/** The approximate snapshot time, in local time like the times shown next to it. */
function estimateSnapshotTime(snap) {
  let newest = newestTop(snapDir(snap.root, []));
  if (process.platform === 'win32' && driveKeyOf(os.homedir()) === snap.driveKey) {
    const home = confine(snap, relBelowDrive(os.homedir()));
    if (home.segs) newest = Math.max(newest, newestTop(snapDir(snap.root, home.segs)));
  }
  return newest ? fmt.when(newest) : null;
}

// --- the two search modes -------------------------------------------------

/** One value of an INI file, from its section; a BOM, the case of names and the space around '=' do not matter. */
function iniValue(text, section, key) {
  let inSection = false;
  const body = String(text);
  const noBom = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
  for (const line of noBom.split(/\r?\n/)) {
    const head = /^\s*\[([^\]]*)\]\s*$/.exec(line);
    if (head) {
      inSection = head[1].trim().toLowerCase() === section.toLowerCase();
      continue;
    }
    const at = line.indexOf('=');
    if (inSection && at > 0 && line.slice(0, at).trim().toLowerCase() === key.toLowerCase()) return line.slice(at + 1).trim();
  }
  return null;
}

/**
 * The folders KakaoTalk saves the photos and videos opened from a chat into, as plain files named
 * KakaoTalk_<date>_<time>.<ext>: [KAKAO_TALK] download_path in each account's user_pref.ini
 * below %LOCALAPPDATA%\Kakao\KakaoTalk\users. An empty value means its default folder, which is
 * below Documents and walked with it. Only those small files are read; nothing else of
 * KakaoTalk's is opened, and a file that is not as expected gives no folder rather than an error.
 */
function kakaoFolders(host) {
  const base = host.env && host.env.LOCALAPPDATA;
  if (!base) return [];
  const users = path.join(base, ...KAKAO_USERS);
  let entries;
  try {
    entries = fs.readdirSync(users, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const out = [];
  for (const e of entries.filter((x) => x.isDirectory()).slice(0, MAX_KAKAO_USERS)) {
    const ini = path.join(users, e.name, 'user_pref.ini');
    try {
      const st = fs.lstatSync(ini);
      if (!st.isFile() || st.size > MAX_INI_BYTES) continue;
      const folder = iniValue(fs.readFileSync(ini, 'utf8'), 'KAKAO_TALK', 'download_path');
      if (folder) out.push(folder);
    } catch (_) {
      /* no settings for this account */
    }
  }
  return out;
}

/**
 * The folders a search by name or type walks in every snapshot on their drive, in the order
 * walked: with types asked for, first the folders that mostly hold them, then those that hold
 * anything, then the rest -- so that when the folder budget runs out, it has been spent where
 * what is wanted mostly is. A drive root is never among them.
 */
function userFolders(types, host = HOST) {
  if (!host.windows) return [];
  const home = host.home();
  if (!home || !isWindowsPath(home)) return [];
  const list = [];
  const add = (folder, holds) => {
    if (typeof folder !== 'string' || !isWindowsPath(folder) || DRIVE_ROOT.test(folder)) return;
    const key = folder.toLowerCase().replace(/[\\/]+$/, '');
    if (!list.some((x) => x.key === key)) list.push({ folder, holds, key });
  };
  for (const [name, holds] of USER_FOLDERS) add(path.win32.join(home, name), holds);
  const shared = path.win32.join(path.win32.dirname(home), 'Public');
  for (const [name, holds] of PUBLIC_FOLDERS) add(path.win32.join(shared, name), holds);
  for (const name of ONEDRIVE_VARS) add(host.env && host.env[name], null);
  add(path.win32.join(home, 'Dropbox'), null);
  for (const folder of kakaoFolders(host)) add(folder, null);
  const rank = (holds) => (!types ? 0 : !holds ? 1 : holds.some((x) => types.includes(x)) ? 0 : 2);
  return list
    .map((x, i) => ({ ...x, i, rank: rank(x.holds) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.folder);
}

/** Whether a deep walk of `deep` reads `folder`: it is that folder or below it, past no skipped one. */
function walkedBy(folder, deep) {
  const f = String(folder).toLowerCase().replace(/[\\/]+$/, '');
  const d = String(deep).toLowerCase().replace(/[\\/]+$/, '');
  if (f === d) return true;
  if (!f.startsWith(d + '\\')) return false;
  return !f.slice(d.length + 1).split('\\').some((s) => SKIP_DIRS.has(s));
}

/**
 * The folders to look in for a name search: the walk folders given, then this user's folders
 * (userFolders), walked deep; and the parents of prior hits, read one level each, unless a deep
 * walk reads them already -- a file found twice would count as two copies of itself.
 */
function nameSearchFolders(ctx, walkFolders) {
  const shallow = new Map();
  const deep = new Map();
  const add = (map, original) => {
    const key = String(original).toLowerCase().replace(/[\\/]+$/, '');
    if (!map.has(key)) map.set(key, original);
  };
  for (const f of [...walkFolders, ...userFolders(ctx.types || null)]) {
    if (isWindowsPath(f)) add(deep, f);
  }
  const deepList = [...deep.values()];
  for (const c of ctx.prior || []) {
    if (!c.path || !isWindowsPath(c.path)) continue;
    const parent = path.win32.dirname(c.path);
    if (!deepList.some((d) => walkedBy(parent, d))) add(shallow, parent);
  }
  return { shallow: [...shallow.values()], deep: deepList };
}

/** Notes for what a scan left out: a few folders by name, then a count. */
function noteSkipped(ctx, skipped) {
  const list = (set, say) => {
    const all = [...set];
    for (const f of all.slice(0, NOTE_LIST)) ctx.notes.push(say(f));
    if (all.length > NOTE_LIST) ctx.notes.push(t('...and {0} more folder(s) skipped for the same reason.', all.length - NOTE_LIST));
  };
  list(skipped.whole, (f) => t('{0}: a whole drive is not walked inside a snapshot; name a folder below it.', f));
  list(skipped.outside, (f) => t('{0}: skipped; inside the snapshot this path goes through a link or .. that leads out of it, to live files.', f));
  list(skipped.system, (f) => t('{0}: skipped; system folders are not read from a snapshot.', f));
  if (skipped.unreadable) ctx.notes.push(t('{0} file(s) in the snapshot could not be read and were skipped.', skipped.unreadable));
  if (skipped.unchanged) {
    ctx.notes.push(t('{0} snapshot copy(ies) have the same size and time as the file still in their place, and were left out: with no name to go on, only what is gone or changed is offered.', skipped.unchanged));
  }
}

async function scan(ctx) {
  const out = [];
  const snaps = resolveSnapshots(ctx.locations.vss, ctx.notes);
  if (!snaps.length) {
    ctx.notes.push(t('No shadow copies found to read. Listing them needs administrator rights; reading their files does not.'));
    return out;
  }
  for (const snap of snaps) snap.approx = estimateSnapshotTime(snap);
  const skipped = newSkipped();

  if (ctx.matcher.folder) {
    // rebuild / under mode: only the target folder's subtree, in each snapshot on its drive.
    const folder = ctx.matcher.pattern;
    const wantDrive = driveKeyOf(folder) || ctx.matcher.folder.slice(0, 2);
    const segs = relBelowDrive(folder);
    const mine = snaps.filter((snap) => snap.driveKey === wantDrive);
    for (const [i, snap] of mine.entries()) {
      stopIfAsked(ctx);
      const budget = { dirs: 0, max: MAX_WALK_DIRS, cut: false };
      await walkSubtree(snap, segs, ctx, out, skipped, budget);
      if (budget.cut) ctx.notes.push(t('{0}: stopped after {1} folders; some were not searched.', snap.root, MAX_WALK_DIRS));
      ctx.progress(i + 1, mine.length);
    }
  } else {
    // name or type search (a follow-up): known folders only, never a whole snapshot. With no
    // name to go on, a file just as it still is in its place is not worth a row.
    const { walkFolders } = parseLocations(ctx.locations.vss);
    const { shallow, deep } = nameSearchFolders(ctx, walkFolders);
    const dropUnchanged = !!ctx.unnamed;
    const budget = { dirs: 0, max: MAX_WALK_DIRS, cut: false };
    const priorBudget = { dirs: 0, max: MAX_PRIOR_FOLDERS, cut: false };
    const on = (snap) => (f) => driveKeyOf(f) === snap.driveKey;
    const total = snaps.reduce((n, snap) => n + deep.filter(on(snap)).length + shallow.filter(on(snap)).length, 0);
    let done = 0;
    const breathe = breather();
    for (const snap of snaps) {
      for (const original of deep.filter(on(snap))) {
        stopIfAsked(ctx);
        await walkSubtree(snap, relBelowDrive(original), ctx, out, skipped, budget, dropUnchanged, breathe);
        ctx.progress(++done, total);
      }
      for (const original of shallow.filter(on(snap))) {
        stopIfAsked(ctx);
        await breathe();
        scanFolderShallow(snap, relBelowDrive(original), ctx, out, skipped, priorBudget, dropUnchanged);
        ctx.progress(++done, total);
      }
    }
    if (budget.cut) ctx.notes.push(t('Stopped after {0} folders; some snapshot folders were not searched.', MAX_WALK_DIRS));
    if (priorBudget.cut) {
      ctx.notes.push(t('Stopped after reading {0} snapshot folders where the other sources found something; the rest were not searched.', MAX_PRIOR_FOLDERS));
    }
  }

  noteSkipped(ctx, skipped);
  return out;
}

function describe(ctx) {
  const notes = [];
  const snaps = resolveSnapshots(ctx.locations.vss, notes);
  if (!snaps.length) {
    return [t('No shadow copies found to read. Listing them needs administrator rights; reading their files does not.')].concat(notes);
  }
  const lines = snaps.map((snap) => {
    const approx = estimateSnapshotTime(snap);
    return approx
      ? t('{0} (drive {1}): readable; taken about {2}', snap.root, snap.driveRoot, approx)
      : t('{0} (drive {1}): readable; when it was taken is not known', snap.root, snap.driveRoot);
  });
  return lines.concat(notes);
}

module.exports = {
  id: 'vss',
  label: 'Volume Shadow Copies',
  followUp: true,
  discover,
  scan,
  describe,
  roots: (loc) => parseLocations(loc.vss).snaps.map((s) => s.root),
  _internal: {
    parseLocations,
    resolveSnapshots,
    relBelowDrive,
    driveKeyOf,
    normalizeDriveRoot,
    toOriginal,
    snapDir,
    isSystemFolder,
    confine,
    pickDrive,
    bytesPresent,
    nameSearchFolders,
    userFolders,
    kakaoFolders,
    iniValue,
    walkedBy,
    walkSubtree,
    scanFolderShallow,
    newSkipped,
    probeDevices,
    discover,
    HOST,
  },
};
