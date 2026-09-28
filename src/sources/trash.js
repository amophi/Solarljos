'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { t } = require('../i18n');
const { isWindowsPath, pathKey } = require('../paths');

// Linux desktops keep deleted files in trash folders laid out by the freedesktop.org Trash
// specification 1.0:
//
//   $XDG_DATA_HOME/Trash     the home trash; ~/.local/share/Trash unless XDG_DATA_HOME is set,
//                            and that one is read too even then
//   ~/snap/<app>/<rev>/.local/share/Trash
//                            a snap's own home trash; VS Code's snap sends deletions there
//   <mount>/.Trash/<uid>     per drive, used only when .Trash is a real folder (not a link) with
//                            the sticky bit and <uid> belongs to that user -- the spec forbids it
//                            otherwise, since anyone could have made it
//   <mount>/.Trash-<uid>     per drive, otherwise
//
// Every deleted item in one is a pair:
//
//   files/<name>             the item itself -- a file, or a folder with everything in it
//   info/<name>.trashinfo    [Trash Info]
//                            Path=<the original path, percent-encoded bytes>
//                            DeletionDate=YYYY-MM-DDThh:mm:ss     (local time, no zone)
//
// Neither half is read when it is a link, and nothing in them is read through one: a link leads
// out of the trash to whatever it names now -- any folder on this machine, or the whole disk --
// and what is read there would be offered as deleted, under whatever path a record claims. A
// crafted drive needs nothing more. Such a trash is reported, not read.
//
// Path is absolute, or relative to the folder the trash sits in: $XDG_DATA_HOME for the home
// trash, the mount point for the others. The name in files/ is the writer's choice (GLib takes
// the file name, npm trash a UUID); the spec says it must never be taken for the original. What
// the writers put in those two lines, read from their source:
//
//   GLib, KIO                percent-escaped, "/" kept; absolute at home, relative on a drive
//   trash-cli, send2trash    the same escaping; send2trash is relative at home too, for a file
//                            under XDG_DATA_HOME
//   npm trash                absolute everywhere; until 2025-12 only whitespace was escaped, so a
//                            bare "%" or "=" can appear; until 2021-03 the date was UTC with "Z"
//   Rust trash crate         absolute; no DeletionDate at all without its chrono feature
//   GLib with no clock       DeletionDate=9999-12-31T23:59:59, which is no date
//   the spec's own example   DeletionDate=20040831T22:32:08
//
// A missing or unreadable date falls back to when the .trashinfo was last written, which every
// writer does at the moment of deleting -- unless the trash has since been copied without its
// times. Such a copy says so in its note.
//
// A date with no zone is the wall clock of the machine that deleted the item, and that machine
// need not have been in this one's zone: a disk from a server kept in UTC, a laptop that has
// travelled since. Every writer writes the .trashinfo within a second after the date it puts in
// it, so an mtime that keeps its fraction of a second shows which zone the date was written in
// (see pinned). A date further ahead of now than any zone could put it is no date: it would
// otherwise win every rebuild.
//
// Nothing records a size or a checksum. The item in files/ is the file itself: GLib only ever
// renames into the trash, and the writers that copy across drives (KIO, send2trash, npm trash,
// the Rust crate) remove the original only once the copy is complete; KIO also deletes a copy
// that failed. Only a machine stopping in the middle of such a copy could leave a short file,
// and nothing in the format would show it. `directorysizes`, which KIO keeps, is disk usage as
// `du` counts it on the drive the trash is on, not a check of the contents; it is not read.
//
// The machine this was written on has no trash folder of this kind -- one NTFS drive, no WSL --
// so it is checked against fixtures made to those writers' rules.

const INFO_MAX = 64 * 1024; // a .trashinfo is a few hundred bytes
const KIND = 'trash';
const KIND_INSIDE = 'trash, inside a deleted folder';
const KIND_NAMELESS = 'trash, name unknown';

// ignoreBOM keeps a leading EF BB BF as a character rather than dropping it.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Spaces, tabs and a CR only. trim() would also take U+00A0, the last byte of "à" read as latin1. */
const strip = (s) => s.replace(/^[ \t]+|[ \t\r]+$/g, '');

/** %XX becomes the byte it names; a "%" without two hex digits after it is kept as it is. */
function decodePercent(raw) {
  const bytes = Buffer.from(raw, 'latin1');
  const out = Buffer.alloc(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const hex = bytes[i] === 0x25 ? bytes.toString('latin1', i + 1, i + 3) : '';
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out[n++] = parseInt(hex, 16);
      i += 2;
    } else {
      out[n++] = bytes[i];
    }
  }
  return out.subarray(0, n);
}

const DATE = /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):?(\d{2}):?(\d{2})(?:[.,](\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * DeletionDate as written, or null for anything that is not a real date, GLib's no-clock
 * placeholder included. `at` is in ms. Without a zone it is local time, read in this machine's
 * zone, as Nautilus and KIO read it: an hour that happens twice is the earlier one, an hour
 * skipped moves on. Such a date also gives `wall`, its fields read as UTC, from which the zone
 * it was written in can be worked out later; a date with a zone gives null there.
 */
function readDeletionDate(s) {
  const m = DATE.exec(strip(String(s)));
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number);
  if (y < 1970 || y >= 9999 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sec > 60) return null;
  const ms = m[7] ? Number((m[7] + '00').slice(0, 3)) : 0;
  const at = [y, mo - 1, d, h, mi, Math.min(sec, 59), ms];
  const utc = Date.UTC(...at);
  const check = new Date(utc);
  if (check.getUTCDate() !== d || check.getUTCMonth() !== mo - 1) return null;
  if (!m[8]) {
    const local = new Date(...at);
    return local.getDate() === d && local.getMonth() === mo - 1 ? { at: local.getTime(), wall: utc } : null;
  }
  if (m[8] === 'Z') return { at: utc, wall: null };
  const z = /^([+-])(\d{2}):?(\d{2})?$/.exec(m[8]);
  const offset = (Number(z[2]) * 60 + Number(z[3] || 0)) * (z[1] === '+' ? 1 : -1);
  return { at: utc - offset * 60000, wall: null };
}

/** DeletionDate in ms, as readDeletionDate reads it; null when it is no date. */
function parseDeletionDate(s) {
  const d = readDeletionDate(s);
  return d ? d.at : null;
}

/** The one character that starts at bytes[i], with its length, or null when none does. */
function charAt(bytes, i) {
  // The shortest run that decodes is exactly one character: a shorter one would have decoded first.
  for (let n = 1; n <= 4 && i + n <= bytes.length; n++) {
    try {
      return [utf8.decode(bytes.subarray(i, i + n)), n];
    } catch (_) {
      // a longer character, or none
    }
  }
  return null;
}

/**
 * The bytes of a Path as text. When they are not UTF-8, each byte that is not, and each "%", is
 * written as %XX: replacement characters would make two such paths one, and rebuild would then
 * keep only one of the two files.
 */
function pathText(bytes) {
  try {
    return { text: utf8.decode(bytes), lossy: false };
  } catch (_) {
    let text = '';
    for (let i = 0; i < bytes.length;) {
      const c = charAt(bytes, i);
      if (c && c[0] !== '%') {
        text += c[0];
        i += c[1];
      } else {
        text += '%' + bytes[i].toString(16).toUpperCase().padStart(2, '0');
        i++;
      }
    }
    return { text, lossy: true };
  }
}

/**
 * One .trashinfo, or null when it is not one: the first line that is not blank or a comment
 * must be [Trash Info]. Only that group counts, and the first Path and DeletionDate in it win.
 * `lossy` means the path's bytes are not UTF-8 and it is shown with %XX escapes (see pathText).
 * `wall` is readDeletionDate's, for a date with no zone.
 */
function parseTrashInfo(buf) {
  // latin1 keeps every byte as one character, so percent-decoding works on the bytes.
  const lines = buf.toString('latin1').replace(/^\xEF\xBB\xBF/, '').split('\n');
  let group = null;
  let rawPath = null;
  let rawDate = null;
  for (const line of lines) {
    const s = strip(line);
    if (!s || s.startsWith('#')) continue;
    if (s.startsWith('[')) {
      if (group === null && s !== '[Trash Info]') return null;
      group = s;
      continue;
    }
    if (group === null) return null;
    if (group !== '[Trash Info]') continue;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const key = strip(s.slice(0, eq));
    const value = strip(s.slice(eq + 1));
    if (key === 'Path' && rawPath === null) rawPath = value;
    else if (key === 'DeletionDate' && rawDate === null) rawDate = value;
  }
  if (group === null) return null;
  const { text, lossy } = rawPath ? pathText(decodePercent(rawPath)) : { text: null, lossy: false };
  const date = rawDate === null ? null : readDeletionDate(rawDate);
  return { path: text, lossy, deleted: date ? date.at : null, wall: date ? date.wall : null };
}

/** Where a relative Path starts: the folder a trash is in, or the drive for <drive>/.Trash/<uid>. */
function baseOf(dir) {
  const p = isWindowsPath(dir) ? path.win32 : path.posix;
  const parent = p.dirname(dir);
  return /^\d+$/.test(p.basename(dir)) && p.basename(parent) === '.Trash' ? p.dirname(parent) : parent;
}

// What a name on Windows cannot hold, and a Linux name can: a backslash, a colon (a stream of
// another file, once written), the other reserved characters, a control character, and a dot
// or space at the end.
const NOT_ON_WINDOWS = /[\\:*?"<>|\x00-\x1F]|[. ]$/;

/**
 * The original path. An absolute one stays as written, since it is a path on the machine that
 * deleted the file. A relative one is joined onto the base in the base's own style, so a stick
 * read on Windows gives E:\docs\a.txt. Path separates with "/" only; on a Windows base a name
 * Windows cannot hold gives no path, since joined it would name another file, or a stream of
 * one. A path that climbs with ".." is refused: the spec forbids it, and it could name anything.
 */
function originalPath(p, base) {
  if (!p || p.includes('\0')) return null;
  if (p.startsWith('/')) return p.split('/').includes('..') ? null : p;
  const win = isWindowsPath(base);
  const segs = p.split('/').filter((s) => s && s !== '.');
  if (!segs.length || segs.includes('..')) return null;
  if (win && segs.some((s) => NOT_ON_WINDOWS.test(s))) return null;
  return (win ? path.win32 : path.posix).join(base, ...segs);
}

// ---------------------------------------------------------------------------------------------
// Where trash folders are

function lstat(p) {
  try {
    return fs.lstatSync(p);
  } catch (_) {
    return null;
  }
}

/** A folder, following a link: the home trash may be one. */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

/** A folder that is not a link. */
function isRealDir(p) {
  const s = lstat(p);
  return !!s && s.isDirectory();
}

function names(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
}

/**
 * Whether <top>/.Trash/<uid> may be read: .Trash a real folder with the sticky bit, and <uid> a
 * real folder that belongs to that user. Windows reports no sticky bit, so there it never may.
 */
function sharedTrashOk(top, uid) {
  const shared = lstat(path.join(top, '.Trash'));
  if (!shared || !shared.isDirectory() || !(shared.mode & 0o1000)) return false;
  const own = lstat(path.join(top, '.Trash', String(uid)));
  return !!own && own.isDirectory() && own.uid === Number(uid);
}

/** A snap's home trashes under a home folder. `current` is a link to a revision; links are skipped. */
function snapTrashes(home) {
  const out = [];
  const snap = path.join(home, 'snap');
  for (const app of names(snap)) {
    for (const rev of names(path.join(snap, app))) {
      if (!isRealDir(path.join(snap, app, rev))) continue;
      const dir = path.join(snap, app, rev, '.local', 'share', 'Trash');
      if (isDir(dir)) out.push(dir);
    }
  }
  return out;
}

/** /proc/self/mounts: "<source> <mount point> <type> <options> 0 0", with \040-style escapes. */
function parseMounts(text) {
  // An escape stands for a byte; the bytes together are UTF-8.
  const unescape = (s) => {
    const raw = s.replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)));
    return Buffer.from(raw, 'latin1').toString('utf8');
  };
  const out = [];
  for (const line of String(text).split('\n')) {
    const f = line.split(' ');
    if (f.length < 3) continue;
    out.push({ source: unescape(f[0]), mountpoint: unescape(f[1]), fstype: f[2], options: f[3] || '' });
  }
  return out;
}

// Discovery runs before every command, whatever source it is for, and one stat on a network file
// system whose server is gone can hang for minutes. No list of network types is complete --
// FUSE alone has dozens, and davfs2 shows up as plain "fuse" -- so only a mount on a local disk
// is looked at: one backed by a block device, or one of the local file systems that have none.
// A FUSE daemon names its source as it likes, "/dev/..." included, so the only FUSE mount that
// counts is fuseblk, which the kernel ties to a block device (ntfs-3g, exfat-fuse). Anything
// else can still be given with --location trash=<mount point>.
const LOCAL_NODEV = new Set(['zfs', 'btrfs', '9p', 'drvfs']); // 9p and drvfs: WSL's /mnt/<drive>
const NET_BLOCK = /^\/dev\/(nbd|rbd)\d/; // block devices that are a server's: NBD, Ceph
const NET_9P = /(^|[,;])trans=(tcp|rdma)([,;]|$)/;
// Read-only images: nothing is ever trashed into one, and a snap system has dozens mounted.
const IMAGE_FS = new Set(['squashfs', 'iso9660', 'udf', 'erofs']);
const SKIP_AT = /^\/(proc|sys|dev|snap|var\/snap)(\/|$)|^\/run(\/(?!media\/)|$)|\/\.gvfs$/;

/** Whether a mount is on a disk of this machine, so that a stat there cannot wait on a server. */
function isLocalDisk(m) {
  if (IMAGE_FS.has(m.fstype) || NET_BLOCK.test(m.source)) return false;
  if (m.fstype === 'fuseblk') return true;
  if (/^fuse(\.|$)/.test(m.fstype)) return false;
  if (m.fstype === '9p') return !NET_9P.test(m.options);
  return m.source.startsWith('/dev/') || LOCAL_NODEV.has(m.fstype);
}

/** Mount points that can hold a trash folder. */
function mountPoints(text) {
  const out = new Set();
  for (const m of parseMounts(text)) {
    if (isLocalDisk(m) && !SKIP_AT.test(m.mountpoint)) out.add(m.mountpoint);
  }
  return [...out];
}

/**
 * The trash folders of one user on one machine, as the desktop would have used them. Everything
 * read from the system is passed in, so a Linux machine can be described from any other.
 * @param {object} m  { platform, home, env, uid, mountsText }
 */
function discoverOn(m) {
  // Windows has no trash of this kind (a drive used on Linux is given by hand), and the macOS
  // Trash is laid out differently; it is not read yet.
  if (m.platform === 'win32' || m.platform === 'darwin') return [];
  const env = m.env || {};
  // A relative XDG_DATA_HOME is to be ignored, says the base directory spec. The default home
  // trash is looked at as well: the variable may be set here and not in the desktop session, or
  // have been set after that trash was used.
  const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(m.home, '.local', 'share');
  const home = path.join(m.home, '.local', 'share', 'Trash');
  const out = [path.join(data, 'Trash'), home, ...snapTrashes(m.home)].filter(isDir);
  if (m.uid != null) {
    for (const mp of mountPoints(m.mountsText || '')) {
      const own = path.join(mp, `.Trash-${m.uid}`);
      const s = lstat(own);
      if (s && s.isDirectory() && s.uid === m.uid) out.push(own);
      if (sharedTrashOk(mp, m.uid)) out.push(path.join(mp, '.Trash', String(m.uid)));
    }
  }
  return [...new Set(out)];
}

function thisMachine() {
  let mountsText = '';
  try {
    mountsText = process.platform === 'linux' ? fs.readFileSync('/proc/self/mounts', 'latin1') : '';
  } catch (_) {
    mountsText = '';
  }
  return {
    platform: process.platform,
    home: os.homedir(),
    env: process.env,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    mountsText,
  };
}

function discover() {
  try {
    return discoverOn(thisMachine());
  } catch (_) {
    return [];
  }
}

/** Whether a trash has this half: a folder, or a link, which is reported when the trash is read. */
function has(dir, half) {
  const s = lstat(path.join(dir, half));
  return !!s && (s.isDirectory() || s.isSymbolicLink());
}

/** A trash folder: named like one and holding either half, or holding both halves. */
function isTrash(dir) {
  const p = isWindowsPath(dir) ? path.win32 : path.posix;
  const name = p.basename(dir);
  const named = name === 'Trash' || /^\.Trash-\d+$/.test(name) || (/^\d+$/.test(name) && p.basename(p.dirname(dir)) === '.Trash');
  const info = has(dir, 'info');
  const files = has(dir, 'files');
  return named ? info || files : info && files;
}

/**
 * Which halves of a trash may be read. One that is a link, or anything else that is not a real
 * folder, may not (see the top of this file); one that is not there holds nothing, which is fine.
 * When files/ may not be read, nothing of the trash is: every record's item would be read through
 * it. When info/ may not, what is in files/ is offered by content only, as items with no record.
 */
function halves(dir, notes) {
  const ok = (half) => {
    const p = path.join(dir, half);
    const s = lstat(p);
    if (!s || s.isDirectory()) return true;
    notes.push(t('{0}: not read, since it is not a real folder', p));
    return false;
  };
  return { info: ok('info'), files: ok('files') };
}

/**
 * The trash folders at the top of a drive, any user's: the drive may come from another machine.
 * A shared .Trash/<uid> must pass the spec's checks; one that does not is reported, not read.
 */
function driveTrashes(top, notes) {
  const all = names(top);
  const out = all.filter((n) => /^\.Trash-\d+$/.test(n)).map((n) => path.join(top, n)).filter(isRealDir);
  if (all.includes('.Trash')) {
    const shared = path.join(top, '.Trash');
    if (!isRealDir(shared)) {
      notes.push(t('{0}: not read, since it is not a real folder', shared));
    } else {
      for (const u of names(shared).filter((n) => /^\d+$/.test(n))) {
        const dir = path.join(shared, u);
        if (sharedTrashOk(top, u)) out.push(dir);
        else notes.push(t('{0}: not read, since .Trash lacks the sticky bit or {1} does not belong to user {1}; give --location trash={0} to read it anyway', dir, u));
      }
    }
  }
  if (all.includes('.Trashes')) notes.push(t('{0}: macOS trash folders are not read yet', path.join(top, '.Trashes')));
  return out;
}

/**
 * The trash folders for one place given with --location trash=<place>: a trash folder itself,
 * or a folder that holds some -- a data folder (Trash), a home folder (.local/share/Trash and a
 * snap's), a drive or mount point (.Trash-<uid>, .Trash/<uid>).
 */
function trashesAt(place, notes) {
  const dir = path.resolve(place);
  if (!isDir(dir)) {
    notes.push(t('{0}: no such folder', dir));
    return [];
  }
  if (isTrash(dir)) return [dir];
  const said = notes.length;
  const out = [path.join(dir, 'Trash'), path.join(dir, '.local', 'share', 'Trash')].filter(isTrash);
  out.push(...snapTrashes(dir), ...driveTrashes(dir, notes));
  if (!out.length && notes.length === said) notes.push(t('{0}: no trash folder found there', dir));
  return out;
}

/**
 * Every trash folder, each once: the same folder can be reached twice, through a bind mount or a
 * link. For reading only; roots() lists every spelling.
 */
function trashes(places, notes) {
  const seen = new Set();
  const out = [];
  for (const place of places || []) {
    for (const dir of trashesAt(place, notes)) {
      let key;
      try {
        const s = fs.statSync(dir, { bigint: true });
        key = s.ino ? `${s.dev}:${s.ino}` : fs.realpathSync(dir);
      } catch (_) {
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ dir, base: baseOf(dir) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Reading one trash folder

/** Whether a folder can hold a match. In a rebuild, only one on the way to or below the folder can. */
function worthWalking(p, matcher) {
  if (!matcher.folder) return true;
  const k = pathKey(p);
  return k === matcher.folder || k.startsWith(matcher.folder + '/') || matcher.folder.startsWith(k + '/');
}

/** Files inside a deleted folder, each with the path it had. Links are never followed. */
function walkInside(dir, original, time, note, ctx, out, tally) {
  const style = isWindowsPath(original) ? path.win32 : path.posix;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    const phys = path.join(dir, e.name);
    const inner = style.join(original, e.name);
    if (e.isDirectory()) {
      if (ctx.matcher.test(inner)) {
        out.push({ source: 'trash', kind: KIND_INSIDE, path: inner, time, size: null, isDir: true, dir: phys, origin: phys, note });
      }
      if (worthWalking(inner, ctx.matcher)) walkInside(phys, inner, time, note, ctx, out, tally);
    } else if (e.isFile() && ctx.matcher.test(inner)) {
      const st = lstat(phys);
      if (!st) {
        // Node turns a name that is not UTF-8 into replacement characters, and cannot open it.
        if (e.name.includes('\uFFFD')) tally.badNames++;
        continue;
      }
      out.push({ source: 'trash', kind: KIND_INSIDE, path: inner, time, size: st.size, file: phys, origin: phys, note });
    }
  }
}

/**
 * An item whose original path is not known, offered to a search by content: a file as it is, a
 * folder as the files in it. With no deletion date, each is dated by when it last changed.
 */
function offerNameless(phys, st, time, note, out) {
  if (st.isFile()) {
    out.push({ source: 'trash', kind: KIND_NAMELESS, path: null, time: time == null ? st.mtimeMs : time, size: st.size, file: phys, origin: phys, note });
    return;
  }
  if (!st.isDirectory()) return;
  for (const n of names(phys)) {
    const p = path.join(phys, n);
    const s = lstat(p);
    if (s && (s.isFile() || s.isDirectory())) offerNameless(p, s, time, note, out);
  }
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// Nothing was deleted later than now. A date with no zone, read here, can run ahead of the truth
// by up to 26 hours -- written at UTC+14, read at UTC-12 -- so only a time past that is wrong for
// certain.
const AHEAD_MAX = 26 * HOUR;

/**
 * The instant a DeletionDate stands for. One with no zone is the deleting machine's wall clock,
 * and the .trashinfo was written within a second after it; so when the file's mtime, give or take
 * that second, is the wall clock less a whole number of quarter-hours up to 14 hours -- every zone
 * offset is one -- the date is read in that zone. An hour that happens twice is then settled as
 * well. An mtime in whole seconds is not trusted for it: FAT keeps local times in two-second
 * steps, read in whatever zone the reader is in, and a copy by tar or zip drops the fraction.
 * Otherwise, and for a date with a zone, the date stays as readDeletionDate read it.
 */
function pinned(info, mtimeMs) {
  if (info.wall == null || mtimeMs % 1000 === 0) return info.deleted;
  const off = Math.round((info.wall - mtimeMs) / (15 * MINUTE)) * 15 * MINUTE;
  // The date is cut to the second, and the file written after it: the mtime is at or just past it.
  const lag = mtimeMs - (info.wall - off);
  return Math.abs(off) <= 14 * HOUR && lag >= -1000 && lag <= 2000 ? info.wall - off : info.deleted;
}

/**
 * When an item was deleted: `time`, whether it came from the record's DeletionDate (`dated`),
 * and a note when it did not. A time later than now is none, a fallback's included; with no time
 * at all the item is taken by a rebuild only when nothing else has that path.
 */
function whenDeleted(info, is) {
  const limit = Date.now() + AHEAD_MAX;
  const written = is.mtimeMs <= limit ? is.mtimeMs : null;
  if (info.deleted == null) {
    return written != null
      ? { time: written, dated: false, note: t('no deletion date recorded; dated by its .trashinfo file') }
      : { time: null, dated: false, note: t('no deletion date recorded, and its .trashinfo file is dated in the future; undated') };
  }
  const at = pinned(info, is.mtimeMs);
  if (at <= limit) return { time: at, dated: true };
  return written != null
    ? { time: written, dated: false, note: t('its deletion date lies in the future; dated by its .trashinfo file') }
    : { time: null, dated: false, note: t('its deletion date and its .trashinfo file both lie in the future; undated') };
}

/** One info/<name>.trashinfo and the files/<name> it describes. */
function readRecord(trash, infoName, ctx, out, tally) {
  const name = infoName.slice(0, -'.trashinfo'.length);
  // No item can be called "." or "..": files/ itself, or the trash folder, would be read as one.
  if (name === '.' || name === '..') {
    tally.unreadable++;
    return;
  }
  const infoPath = path.join(trash.dir, 'info', infoName);
  const phys = path.join(trash.dir, 'files', name);
  const is = lstat(infoPath);
  if (!is) {
    if (infoName.includes('\uFFFD')) tally.badNames++;
    return;
  }
  // Only an item that is not there at all has its contents gone; one that cannot be looked at is
  // not said to be.
  let st = null;
  try {
    st = fs.lstatSync(phys);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      tally.unopened++;
      return;
    }
  }
  // A trashed link holds no file, and reading through it would read whatever it points to now.
  // A pipe or a device holds none either.
  if (st && !st.isFile() && !st.isDirectory()) {
    tally.links++;
    return;
  }
  let info = null;
  if (is.isFile() && is.size <= INFO_MAX) {
    try {
      info = parseTrashInfo(fs.readFileSync(infoPath));
    } catch (_) {
      info = null;
    }
  }
  if (!info) {
    tally.unreadable++;
    if (ctx.unnamed && st) offerNameless(phys, st, null, t('its .trashinfo could not be read'), out);
    return;
  }
  const when = whenDeleted(info, is);
  const time = when.time;
  const said = [];
  if (when.note) said.push(when.note);
  if (info.lossy) said.push(t('the original path is not UTF-8; each byte that is not, and each "%", is shown as %XX'));
  const note = said.length ? said.join('; ') : undefined;
  const original = originalPath(info.path, trash.base);
  if (!original) {
    tally.noPath++;
    if (ctx.unnamed && st) offerNameless(phys, st, when.dated ? time : null, t('its .trashinfo gives no usable original path'), out);
    return;
  }
  const folder = !!(st && st.isDirectory());
  if (ctx.matcher.test(original)) {
    out.push({
      source: 'trash', kind: KIND, path: original, time,
      size: st && !folder ? st.size : null,
      isDir: folder,
      file: st && !folder ? phys : undefined,
      dir: folder ? phys : undefined,
      gone: !st,
      origin: st ? phys : infoPath,
      note,
    });
  }
  if (folder && worthWalking(original, ctx.matcher)) walkInside(phys, original, time, note, ctx, out, tally);
}

/** What is in files/ with no record at all: the spec's emergency case, offered only by content. */
function readOrphans(trash, recorded, ctx, out, tally) {
  for (const n of names(path.join(trash.dir, 'files'))) {
    if (recorded.has(n)) continue;
    tally.orphans++;
    if (!ctx.unnamed) continue;
    const phys = path.join(trash.dir, 'files', n);
    const st = lstat(phys);
    if (st && !st.isSymbolicLink()) offerNameless(phys, st, null, t('no .trashinfo record; called {0} in the trash', n), out);
  }
}

/** The .trashinfo names in a trash. Another user's trash on a shared drive cannot be listed. */
function infoNames(dir, notes) {
  let all;
  try {
    all = fs.readdirSync(path.join(dir, 'info'));
  } catch (e) {
    if (e.code !== 'ENOENT') notes.push(t('Could not read {0} ({1})', path.join(dir, 'info'), e.code || e.message));
    return [];
  }
  return all.filter((n) => n.endsWith('.trashinfo') && n.length > '.trashinfo'.length);
}

function report(dir, n, notes) {
  if (n.unreadable) notes.push(t('{0}: {1} .trashinfo file(s) could not be read', dir, n.unreadable));
  if (n.noPath) notes.push(t('{0}: {1} record(s) give no usable original path; searched by content only', dir, n.noPath));
  if (n.orphans) notes.push(t('{0}: {1} item(s) have no .trashinfo record; searched by content only', dir, n.orphans));
  if (n.links) notes.push(t('{0}: {1} trashed link(s) or special file(s) skipped; they hold no file', dir, n.links));
  if (n.badNames) notes.push(t('{0}: {1} name(s) are not UTF-8 and could not be opened', dir, n.badNames));
  if (n.unopened) notes.push(t('{0}: {1} item(s) could not be opened', dir, n.unopened));
}

/** The trash folders to read, each with which halves may be read and the records it holds. */
function readable(places, notes) {
  return trashes(places, notes).map((tr) => {
    const ok = halves(tr.dir, notes);
    return { ...tr, ok, records: ok.info && ok.files ? infoNames(tr.dir, notes) : [] };
  });
}

async function scan(ctx) {
  const out = [];
  const list = readable(ctx.locations.trash, ctx.notes);
  const total = list.reduce((n, tr) => n + tr.records.length, 0);
  let done = 0;
  for (const trash of list) {
    if (!trash.ok.files) continue;
    const tally = { unreadable: 0, noPath: 0, orphans: 0, links: 0, badNames: 0, unopened: 0 };
    for (const n of trash.records) {
      readRecord(trash, n, ctx, out, tally);
      if (ctx.progress) ctx.progress(++done, total);
    }
    readOrphans(trash, new Set(trash.records.map((n) => n.slice(0, -'.trashinfo'.length))), ctx, out, tally);
    report(trash.dir, tally, ctx.notes);
  }
  return out;
}

/**
 * Whether a record's item is gone, as readRecord decides it: only when nothing is there at all.
 * One that cannot be looked at is not, nor is one whose record Node cannot open by its name.
 */
function isGone(dir, name) {
  if (!lstat(path.join(dir, 'info', name + '.trashinfo'))) return false;
  try {
    fs.lstatSync(path.join(dir, 'files', name));
    return false;
  } catch (e) {
    return e.code === 'ENOENT';
  }
}

function describe(ctx) {
  const notes = [];
  const list = readable(ctx.locations.trash, notes);
  const lines = list.map(({ dir, ok, records: infoList }) => {
    const records = infoList.map((n) => n.slice(0, -'.trashinfo'.length));
    const gone = records.filter((n) => isGone(dir, n)).length;
    const recorded = new Set(records);
    const orphans = ok.files ? names(path.join(dir, 'files')).filter((n) => !recorded.has(n)).length : 0;
    return t('{0}: {1} item(s), {2} with contents gone, {3} without a record', dir, records.length, gone, orphans);
  });
  if (!list.length) {
    lines.push(process.platform === 'win32'
      ? t('No trash folder found. None is looked for on Windows; give a drive used on Linux with --location trash=<drive>.')
      : t('No trash folder found.'));
  }
  lines.push(t('The macOS Trash is not read yet.'));
  return lines.concat(notes);
}

/**
 * Where restore must not write: every trash folder under every place, as it was reached and as
 * it really is, and where its two halves really are, a linked one included. Unlike trashes(),
 * nothing is merged, since restore compares paths as text and so needs every spelling.
 */
function roots(loc) {
  const out = new Set();
  for (const place of (loc && loc.trash) || []) {
    for (const dir of trashesAt(place, [])) {
      out.add(dir);
      for (const p of [dir, path.join(dir, 'files'), path.join(dir, 'info')]) {
        try {
          const real = fs.realpathSync(p);
          if (real !== p) out.add(real);
        } catch (_) {
          // Not there: nothing to keep out of.
        }
      }
    }
  }
  return [...out];
}

module.exports = {
  id: 'trash',
  label: 'Trash (Linux)',
  discover,
  scan,
  describe,
  roots,
  _internal: {
    decodePercent, parseDeletionDate, parseTrashInfo, baseOf, originalPath, parseMounts, mountPoints,
    discoverOn, sharedTrashOk, trashesAt,
  },
};
