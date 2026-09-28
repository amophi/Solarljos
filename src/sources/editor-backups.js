'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { t } = require('../i18n');
const { pathKey } = require('../paths');

// VS Code, and every editor built on it, keeps the text of each buffer with unsaved changes in a
// backup file, so that quitting does not lose it ("hot exit"):
//
//   <app data>/<app>/Backups/<window>/<scheme>/<name>
//     <window>  one folder per window: the md5 of its folder or workspace (32 hex digits), or for an
//               empty window a number, Date.now() plus up to 1000
//     <scheme>  the buffer's URI scheme: file, untitled, vscode-userdata, vscode-remote...
//     <name>    a hash of the buffer's URI, as below
//
//   contents    `${uri} ${JSON.stringify({ ...meta, typeId })}\n`, then the text as UTF-8 with no BOM,
//               whatever the file's own encoding; backups older than meta have only `${uri}\n`
//
// For a text file, meta is { mtime, ctime, size, etag, orphaned } of the file on disk when the editor
// last read it -- not of the backup. `orphaned` means the file was deleted while it was open. An
// untitled buffer has no meta. typeId is '' for text files, untitled buffers and custom editors, and
// notebooks set it. Notebooks and custom editors back up their own data rather than the file's text,
// so those are left out. A custom editor's backup is known by its scheme and meta instead: its URI is
// vscode-custom-editor://<viewType>/<base64 of the file's URI>?<that URI as JSON>, its meta carries
// viewType and backupId, and it holds the header alone, since the data is in the extension's own
// backup. Its URI still has the file name in it, so without that check it would pass for an empty
// buffer of that file.
//
// <name> is hash(s).toString(16), where hash is VS Code's 32-bit string hash -- seed 149417, then
// h = ((h << 5) - h + code unit) | 0 -- and s is the URI's fsPath for file and untitled (drive letter
// lower-cased, separators of the machine that wrote it) and the URI itself for anything else. Only
// window folders, scheme folders and names of those shapes are gone into, so a place that is not a
// Backups folder (the app-data folder, a home folder) opens nothing. A backup is offered only when its
// name and folder are what the editor would make from the URI inside it, its typeId is '' and it is
// not a custom editor's, and its text is valid UTF-8.
//
// Nothing in a backup records the text's length or a checksum, and the editor writes one by
// truncating first, not atomically, so a backup cut short by a crash mid-write cannot be told from a
// whole one. The one sign such a cut can leave is a file at its new size whose unwritten end reads as
// zero bytes, as NTFS gives when a crash comes after the size reached the disk and before the data
// did; a text buffer almost never ends in NUL, so a backup that does is left out. Every copy here is
// therefore a draft: text that was never saved, dated by the backup's own mtime, which rebuild takes
// only where no saved copy exists, and its note says it is UTF-8 and its length unchecked. The editor
// writes the backup about a second after each change and deletes it outright -- not to the Recycle
// Bin -- on save, revert or close. Each backup is read whole through one handle, and left out when
// its size or mtime moved since its header was read or while it was read, so the header and the text
// always come from the same write.
//
// Checked against the installed Antigravity IDE 1.107.0 (workbench.desktop.main.js): the same
// preamble, separator, end marker, 10000-character limit, name hash, URI parsing and UTF-8 text as
// upstream VS Code 1.107.0, and the hash gives all 11 values VS Code pins in its own tests. The
// bundle's own URI and hash code, run in a sandbox on made-up paths as Windows and as Linux, agreed
// with this reader in 43 of 43 checks (name, fsPath, path). Also read there: the custom editor's model
// sets typeId to the same '' constant as text files, an untitled buffer opened for a missing file
// keeps that file's URI authority, and main.js names window folders as above. Its Backups folder on
// this machine was empty when this was written, so no real backup has been read.

const PREAMBLE_MAX = 10000;
const LF = 0x0a;

// The shapes of what the editor puts in Backups: a window key, a URI scheme (SCHEME below), a hash.
const WINDOW = /^([0-9a-f]{32}|\d+)$/;
const NAME = /^-?[0-9a-f]{1,8}$/;

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

/** base/common/hash.ts: stringHash(s, 0), as the backup's name writes it. */
function hashString(s) {
  let h = 149417;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h.toString(16);
}

// base/common/uri.ts, as much of URI.parse as a backup's name depends on.
const URI_RE = /^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/;
const SCHEME = /^\w[\w\d+.-]*$/;
const ENCODED = /(%[0-9A-Za-z][0-9A-Za-z])+/g;

function decodeGraceful(s) {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s.length > 3 ? s.slice(0, 3) + decodeGraceful(s.slice(3)) : s;
  }
}

function parseUri(s) {
  const m = URI_RE.exec(s);
  if (!m || !m[2] || !SCHEME.test(m[2])) return null;
  const scheme = m[2];
  let p = (m[5] || '').replace(ENCODED, decodeGraceful);
  if ((scheme === 'file' || scheme === 'http' || scheme === 'https') && p[0] !== '/') p = '/' + p;
  return { scheme, authority: (m[4] || '').replace(ENCODED, decodeGraceful), path: p };
}

/** uriToFsPath(uri, false): Windows flavour when `win`, the other systems' otherwise. */
function fsPath(u, win) {
  let v;
  if (u.authority && u.path.length > 1 && u.scheme === 'file') v = `//${u.authority}${u.path}`;
  else if (u.path[0] === '/' && /^[a-zA-Z]$/.test(u.path[1] || '') && u.path[2] === ':') v = u.path[1].toLowerCase() + u.path.slice(2);
  else v = u.path;
  return win ? v.replace(/\//g, '\\') : v;
}

/** The names the editor could have given this backup; which one depends on where it ran. */
function namesFor(uri, u) {
  if (u.scheme === 'file' || u.scheme === 'untitled') return [hashString(fsPath(u, true)), hashString(fsPath(u, false))];
  return [hashString(uri)];
}

/** A local path as the rest of Solarljos writes one: C:\..., \\server\..., or /... */
function localPath(u) {
  if (u.authority && u.path.length > 1) return '\\\\' + u.authority + u.path.replace(/\//g, '\\');
  if (/^\/[a-zA-Z]:/.test(u.path)) return u.path[1].toUpperCase() + u.path.slice(2).replace(/\//g, '\\');
  return u.path;
}

/**
 * Where the buffer belongs. An untitled buffer given a file to save to (untitled:/c%3A/...) has that
 * path; a plain one (untitled:Untitled-1) has none. vscode-userdata is the editor's own settings on
 * this disk. Other schemes, such as vscode-remote, keep their URI: it still ends in the file name.
 *
 * An untitled buffer keeps the authority of the file it was opened for: \\server\share for a missing
 * file there, but in an SSH, WSL or container window the remote's (untitled://ssh-remote%2Bbox/...).
 * A remote authority is always <resolver>+<data>, and '+' cannot be in a host name, so such a URI is
 * kept as written, as vscode-remote is, rather than made into a \\server path that never existed.
 */
function originalPath(uri, u) {
  if (u.scheme === 'file') return localPath(u);
  const remote = u.authority.includes('+');
  if (u.scheme === 'untitled') {
    if (!u.path.startsWith('/')) return null;
    return remote ? uri : localPath(u);
  }
  if (u.scheme === 'vscode-userdata' && u.path.startsWith('/') && !remote) return localPath(u);
  return uri;
}

/**
 * Reads the header the way the editor does -- up to the first LF within 10000 bytes, split at the
 * first space -- and checks it. `why` says what failed: 'cut' (no header the editor could have
 * written, so which file it held is unknown), 'header' (metadata that is not a JSON object, or a
 * URI that does not fit the file's name and folder), 'typed' (a notebook or custom editor).
 */
function readHeader(head, name, schemeDir) {
  const end = head.indexOf(LF);
  if (end < 0) return { why: 'cut' };
  const line = head.subarray(0, end).toString('utf8');
  const sp = line.indexOf(' ');
  const uri = sp > 0 ? line.slice(0, sp) : line;
  const u = parseUri(uri);
  if (!u) return { why: 'cut' };
  const found = { uri, u, start: end + 1, path: originalPath(uri, u), meta: null };
  if (sp > 0) {
    try {
      found.meta = JSON.parse(line.slice(sp + 1));
    } catch (_) {
      return { ...found, why: 'header' };
    }
    if (!found.meta || typeof found.meta !== 'object' || Array.isArray(found.meta)) return { ...found, why: 'header' };
  }
  const { meta } = found;
  const typeId = meta && meta.typeId !== undefined ? meta.typeId : '';
  if (typeof typeId !== 'string') return { ...found, why: 'header' };
  // A custom editor's typeId is '' like a text file's: it is known by its scheme and its meta.
  const custom = u.scheme === 'vscode-custom-editor' || (meta && ('viewType' in meta || 'backupId' in meta));
  if (typeId !== '' || custom) return { ...found, why: 'typed' };
  if (u.scheme !== schemeDir || !namesFor(uri, u).includes(name)) return { ...found, why: 'header' };
  return found;
}

/** The first 10000 bytes, enough for the header: which file a backup is for, before reading it all. */
function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    const head = Buffer.alloc(Math.min(st.size, PREAMBLE_MAX));
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return { head: head.subarray(0, n), st };
  } finally {
    fs.closeSync(fd);
  }
}

function entries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

/** A place is a Backups folder, or the app folder holding one (a portable install's data/user-data). */
function backupsDir(place) {
  const dir = path.resolve(String(place));
  const inner = path.join(dir, 'Backups');
  return isDir(inner) ? inner : dir;
}

function labelOf(dir) {
  return path.basename(dir).toLowerCase() === 'backups' ? path.basename(path.dirname(dir)) : path.basename(dir);
}

/**
 * Whether a folder is laid out as a Backups folder: so named (an editor with nothing unsaved leaves
 * it empty), or holding a window folder. Anything else is not walked at all.
 */
function isBackups(dir) {
  return path.basename(dir).toLowerCase() === 'backups' || entries(dir).some((w) => w.isDirectory() && WINDOW.test(w.name));
}

const notBackups = (dir) => t('{0} is not an editor Backups folder; give the Backups folder or the app folder holding it.', dir);

/** Every Backups folder among the places, each once. */
function backupsDirs(ctx) {
  const seen = new Set();
  const out = [];
  for (const place of ctx.locations['editor-backups'] || []) {
    const dir = backupsDir(place);
    if (seen.has(pathKey(dir))) continue;
    seen.add(pathKey(dir));
    out.push(dir);
  }
  return out;
}

/** <Backups>/<window>/<scheme>/<name>: every file at that depth whose folders and name have the editor's shapes. */
function backupFiles(dir) {
  const out = [];
  let windows = 0;
  for (const w of entries(dir)) {
    if (!w.isDirectory() || !WINDOW.test(w.name)) continue;
    windows++;
    for (const s of entries(path.join(dir, w.name))) {
      if (!s.isDirectory() || !SCHEME.test(s.name)) continue;
      for (const f of entries(path.join(dir, w.name, s.name))) {
        if (f.isFile() && NAME.test(f.name)) out.push({ file: path.join(dir, w.name, s.name, f.name), name: f.name, scheme: s.name });
      }
    }
  }
  return { windows, files: out };
}

const moved = (a, b) => a.size !== b.size || a.mtimeMs !== b.mtimeMs;

/**
 * The whole backup through one handle, its header checked again from the same bytes as its text, or
 * why it is left out: 'changed' when its size or mtime moved since `before` (the stat its header was
 * read with) or while it was read, 'zeros' when the text ends in NUL, 'utf8' when the text is not what
 * the editor writes, or what readHeader says.
 */
function readBackup(file, name, scheme, before) {
  const fd = fs.openSync(file, 'r');
  let st;
  let buf;
  try {
    st = fs.fstatSync(fd);
    buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, n);
      if (!got) break;
      n += got;
    }
    if (n !== st.size || moved(st, fs.fstatSync(fd)) || (before && moved(before, st))) return { why: 'changed' };
  } finally {
    fs.closeSync(fd);
  }
  const h = readHeader(buf.subarray(0, PREAMBLE_MAX), name, scheme);
  if (h.why) return h;
  const content = buf.subarray(h.start);
  if (content.length && content[content.length - 1] === 0) return { why: 'zeros' };
  const text = content.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(content)) return { why: 'utf8' };
  return { h, st, text, size: content.length };
}

async function scan(ctx) {
  const out = [];
  const all = [];
  for (const dir of backupsDirs(ctx)) {
    try {
      fs.readdirSync(dir);
    } catch (e) {
      ctx.notes.push(t('Could not read {0} ({1})', dir, e.code || e.message));
      continue;
    }
    if (!isBackups(dir)) {
      ctx.notes.push(notBackups(dir));
      continue;
    }
    for (const f of backupFiles(dir).files) all.push({ ...f, label: labelOf(dir) });
  }
  const left = { cut: 0, header: 0, typed: 0, utf8: 0, zeros: 0, changed: 0 };
  for (let i = 0; i < all.length; i++) {
    const { file, name, scheme, label } = all[i];
    if (ctx.progress) ctx.progress(i + 1, all.length);
    let got;
    try {
      got = readHead(file);
    } catch (e) {
      ctx.notes.push(t('Could not read {0} ({1})', file, e.code || e.message));
      continue;
    }
    const first = readHeader(got.head, name, scheme);
    if (first.why === 'cut') {
      left.cut++;
      continue;
    }
    // A buffer with no file behind it can only be found by what it says.
    if (first.path ? !ctx.matcher.test(first.path) : !ctx.unnamed) continue;
    if (first.why) {
      left[first.why]++;
      continue;
    }
    let b;
    try {
      b = readBackup(file, name, scheme, got.st);
    } catch (e) {
      ctx.notes.push(t('Could not read {0} ({1})', file, e.code || e.message));
      continue;
    }
    if (b.why) {
      left[b.why]++;
      continue;
    }
    const { h } = b;
    const untitled = h.u.scheme === 'untitled' ? (h.path ? t('untitled') : h.u.path) : null;
    out.push({
      source: 'editor-backups', kind: 'unsaved editor buffer',
      path: h.path, time: b.st.mtimeMs, size: b.size, text: b.text, draft: true, origin: file,
      note: [label, untitled, h.meta && h.meta.orphaned === true ? t('deleted while open') : null,
        t('as UTF-8; length not checked')].filter(Boolean).join(', '),
    });
  }
  if (left.cut) ctx.notes.push(t('{0} backup file(s) are empty or cut short; which file each held is unknown.', left.cut));
  if (left.header) ctx.notes.push(t('Left out {0} matching backup(s) whose header does not fit the name and folder the editor gave them.', left.header));
  if (left.typed) ctx.notes.push(t('Left out {0} matching backup(s) of notebooks or custom editors; they hold the editor\'s own data, not the file.', left.typed));
  if (left.utf8) ctx.notes.push(t('Left out {0} matching backup(s) that are not valid UTF-8, which the editor always writes.', left.utf8));
  if (left.zeros) ctx.notes.push(t('Left out {0} matching backup(s) whose text ends in zero bytes, as a write cut short by a crash leaves it.', left.zeros));
  if (left.changed) ctx.notes.push(t('Left out {0} matching backup(s) that the editor rewrote while they were being read; search again to read them.', left.changed));
  return out;
}

function describe(ctx) {
  const dirs = backupsDirs(ctx);
  if (!dirs.length) return [t('No editor Backups folder found.')];
  return dirs.map((dir) => {
    try {
      fs.readdirSync(dir);
    } catch (e) {
      return [t('{0}: could not be read ({1})', dir, e.code || e.message)];
    }
    if (!isBackups(dir)) return [notBackups(dir)];
    const { windows, files } = backupFiles(dir);
    let good = 0;
    for (const f of files) {
      try {
        const got = readHead(f.file);
        if (!readHeader(got.head, f.name, f.scheme).why && !readBackup(f.file, f.name, f.scheme, got.st).why) good++;
      } catch (_) {
        /* unreadable: not counted */
      }
    }
    const lines = [t('{0}: {1} unsaved buffer(s) in {2} window(s)  ({3})', labelOf(dir), good, windows, dir)];
    if (files.length > good) lines.push(t('{0}: {1} other file(s) that are not text buffers or fail their checks', labelOf(dir), files.length - good));
    return lines;
  }).flat();
}

/** The folder under which editors keep their per-app data, as for Local History. */
function dataBase() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/**
 * Every <app>/Backups under `base` whose app folder also has User/, which is the VS Code layout.
 * Rather than list the forks, any app folder shaped like that is taken; a Backups folder of some
 * other program, such as HeidiSQL's, has no User/ beside it.
 */
function discoverIn(base) {
  let names;
  try {
    names = fs.readdirSync(base);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const name of names) {
    const dir = path.join(base, name, 'Backups');
    if (isDir(dir) && isDir(path.join(base, name, 'User'))) out.push(dir);
  }
  return out;
}

/**
 * The folders read from, which restore will not write into: each place as given, and by its real
 * path the Backups folder it leads to. <app>/Backups, or the app folder itself, is often a junction to
 * another drive (mklink /J %APPDATA%\Code D:\Code); isDir follows it, and a comparison of path names
 * alone would not see that D:\Code\Backups is the folder read.
 */
function roots(loc) {
  const out = [];
  for (const place of loc['editor-backups'] || []) {
    out.push(path.resolve(String(place)));
    try {
      out.push(fs.realpathSync.native(backupsDir(place)));
    } catch (_) {
      /* not there: nothing is read from it */
    }
  }
  return [...new Set(out)];
}

module.exports = {
  id: 'editor-backups',
  label: 'Unsaved editor buffers',
  discover: () => {
    try {
      return discoverIn(dataBase());
    } catch (_) {
      return [];
    }
  },
  scan,
  describe,
  roots,
  _internal: { hashString, parseUri, fsPath, namesFor, originalPath, readHeader, discoverIn, backupsDir },
};
