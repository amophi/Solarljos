'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { t } = require('../i18n');
const { fileUriToPath, isWindowsPath, isInside, pathKey } = require('../paths');

// Eclipse keeps a copy of a file whenever it replaces or deletes it through its workspace. So
// does the Java language server (redhat.java) that VS Code and its forks run, since it is
// Eclipse underneath. Its workspaces sit in the editor's storage, one per folder opened:
//
//   <app data>/<editor>/User/workspaceStorage/<hash>/redhat.java/jdt_ws/   (ss_ws: syntax server)
//   ~/eclipse-workspace/                                                    (Eclipse itself)
//
// Under each, .metadata/.plugins/org.eclipse.core.resources/ holds:
//
//   .history/<bucket>/<uuid>     one earlier version of a file, a plain copy of its bytes;
//                                the bucket is one or two hex digits, the uuid 32
//   .projects/<project>/.location
//                                where the project is: a Java UTF string between two 16-byte
//                                markers, "URI//file:/C:/..." -- or "", or no file at all, for
//                                the default, <workspace>/<project>
//   .projects/<project>/.indexes/<h>/<h>/.../history.index
//                                the versions of the files in one folder of the project, where
//                                <h> is hex(|String.hashCode(folder name)| % 256) per folder
//
// history.index, big-endian except the time:
//   byte     version = 2
//   int32    number of files
//   per file:  Java UTF   path below the project, "/src/A.java" (uint16 length, modified UTF-8)
//              uint16     number of versions, newest first
//              per version: 16 bytes   uuid, the state file's name in hex
//                           int64 LE   the modification time the file had when it was kept, ms
//
// There is no size and no checksum. What can be checked: an index must read to its last byte,
// each path must hash to the folder its index sits in, and Eclipse copies a state keeping the
// file's modification time, so the state file must still have the one recorded (to two
// seconds). A version whose state file is missing or fails that is left out, whether its path
// can be placed or not; one whose path fails, or cannot be placed, is offered only in a search
// by content, with no name and the time its index recorded.
//
// Measured on the machine this was written on: 30 language-server workspaces with a history
// folder, 13 holding any state file; 9 index files, all version 2 and read to the last byte;
// their 17 paths all hashed to their folder; all 52 versions named have their state file, each
// with exactly the recorded modification time, dated 2026-09-01 to 2026-09-28. Every one of the
// 52 is a .settings/*.prefs file the server rewrote itself: it hands source edits to the editor
// to make, and the .classpath and .project it also writes have no history. Eclipse itself keeps
// one on every save (not measured: no Eclipse workspace is on that machine). 22 of the 74 state
// files are named by no index, all of them in the 4 workspaces that have no index file at all.
// Those are offered only in a search by content, with no name.
//
// The language server keeps a project's .project, .classpath and .factorypath in
// .projects/<project>/ when the project folder has none, and a .settings/<name>.prefs there when
// the project folder has no .settings folder at all; nothing else, and nothing deeper
// (JLSFsUtils.shouldStoreInMetadataArea in org.eclipse.jdt.ls.filesystem). Such a path is taken
// as the server's copy when that rule sends it there and the server's copy was written after
// the newest version was kept -- one last written before cannot be where that history came
// from -- and as the project folder's otherwise. Of the 17 paths here, 7 existed only in the
// project folder, 4 only in the server's copy and 6 in both; in one of those 6 the server's copy
// is older than the newest version, so that history can only have come from the project folder.
// All 52 versions come out at the same place by this rule as by the looser one of taking the
// server's copy whenever the project folder lacks the file.
//
// A linked folder or file (<linkedResources> in .project) puts a path somewhere else. A link
// whose location is given by a path variable other than PROJECT_LOC or WORKSPACE_LOC (with
// PARENT-<n>-) is not followed, and its versions count as having no name. PARENT_LOC is one of
// those: Eclipse takes it as the place of the parent of whichever resource is being located, so
// a link through it has no one place. When neither the project folder nor the server keeps a
// .project any more, as after an Eclipse project folder is deleted, its links cannot be known:
// its paths are taken as the project folder's, and each such copy and the notes say so.
//
// A project or a link on a network path is not looked at, since one stat of a server that is
// gone can hang for minutes. Eclipse writes \\server\share as file:////server/share, and in a
// <location> as //server/share. Versions there are offered only in a search by content, with no
// name, unless the place is inside the workspace, which was then given on the network already.
// A device path (\\.\ or \\?\) is never taken as a place. Where a project is and what links it
// has are read only for a project with a state file left, and only once; describe reads neither.

const RESOURCES = ['.metadata', '.plugins', 'org.eclipse.core.resources'];
const VERSION = 2;
const STATE_BYTES = 16 + 8;
// SafeChunkyOutputStream writes .location between these two markers.
const BEGIN_CHUNK = Buffer.from('40b18b8123bc00141a2596e7a393be1e', 'hex');
const END_CHUNK = Buffer.from('c058fbf323bc00141a51f38c7bbb77c6', 'hex');
// A FAT drive keeps modification times to two seconds, so a copied workspace still passes.
const TIME_SLACK_MS = 2000;
// What the language server may keep in its own folder instead of the project's, besides
// .settings/<name>.prefs.
const SERVER_OWN = new Set(['.project', '.classpath', '.factorypath']);
// How far below a place given by hand workspaces are looked for: an editor's data folder is
// five levels above a language server workspace.
const MAX_DEPTH = 5;

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

function entries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

/** A Java DataOutputStream string: uint16 byte length, then modified UTF-8. */
function readUTF(buf, at) {
  if (at + 2 > buf.length) return null;
  const end = at + 2 + buf.readUInt16BE(at);
  if (end > buf.length) return null;
  let text = '';
  for (let i = at + 2; i < end;) {
    const a = buf[i];
    const cont = (k) => i + k < end && (buf[i + k] & 0xc0) === 0x80;
    if (a < 0x80) {
      text += String.fromCharCode(a);
      i += 1;
    } else if ((a & 0xe0) === 0xc0 && cont(1)) {
      text += String.fromCharCode(((a & 0x1f) << 6) | (buf[i + 1] & 0x3f));
      i += 2;
    } else if ((a & 0xf0) === 0xe0 && cont(1) && cont(2)) {
      // Characters beyond U+FFFF come as two of these, one per surrogate, as Java holds them.
      text += String.fromCharCode(((a & 0x0f) << 12) | ((buf[i + 1] & 0x3f) << 6) | (buf[i + 2] & 0x3f));
      i += 3;
    } else {
      return null;
    }
  }
  return { text, next: end };
}

/** Every file in one history.index with its versions, or null unless it reads to the last byte. */
function parseIndex(buf) {
  if (!buf || buf.length < 5 || buf[0] !== VERSION) return null;
  const count = buf.readInt32BE(1);
  if (count < 0) return null;
  const files = [];
  let at = 5;
  for (let i = 0; i < count; i++) {
    const key = readUTF(buf, at);
    if (!key || key.next + 2 > buf.length) return null;
    at = key.next;
    const n = buf.readUInt16BE(at);
    at += 2;
    if (at + n * STATE_BYTES > buf.length) return null;
    const versions = [];
    for (let j = 0; j < n; j++, at += STATE_BYTES) {
      versions.push({ uuid: buf.toString('hex', at, at + 16), time: Number(buf.readBigInt64LE(at + 16)) });
    }
    files.push({ key: key.text, versions });
  }
  return at === buf.length ? files : null;
}

/** The index folder Eclipse gives a folder name: Java's String.hashCode, folded into 256. */
function bucketName(segment) {
  let h = 0;
  for (let i = 0; i < segment.length; i++) h = (Math.imul(h, 31) + segment.charCodeAt(i)) | 0;
  return (Math.abs(h) % 256).toString(16);
}

/**
 * A path as Eclipse wrote it, or null when it is not a place. Two separators in front are a UNC
 * path, which Eclipse writes //server/share; it becomes \\server\share. A device path, such as
 * \\.\pipe\x or \\?\GLOBALROOT\..., is never a project's place, nor is ///x.
 */
function plainPath(p) {
  if (!p) return null;
  const lead = /^[\\/]*/.exec(p)[0].length;
  if (lead === 2) {
    const rest = p.slice(2);
    return !rest || /^[.?](?:[\\/]|$)/.test(rest) ? null : '\\\\' + rest.replace(/\//g, '\\');
  }
  if (lead > 2) return null;
  return isWindowsPath(p) || p.startsWith('/') ? p : null;
}

/** file:/C:/a -> C:\a, file:/home/a -> /home/a, file:////host/share or file://host/share -> \\host\share. */
function uriPath(uri) {
  if (!/^file:/i.test(uri)) return null;
  const rest = uri.slice(5);
  return plainPath(fileUriToPath('file://' + (rest.startsWith('//') ? rest.slice(2) : rest)));
}

const flavour = (p) => (isWindowsPath(p) ? path.win32 : path.posix);
const joinUnder = (root, segs) => flavour(root).join(root, ...segs);

/** Whether a place is on a network path (\\server\share) somewhere other than inside the workspace. */
function onNetwork(p, workspace) {
  if (!p.startsWith('\\\\')) return false;
  const k = pathKey(p);
  const w = pathKey(workspace).replace(/\/+$/, '');
  return !(k === w || k.startsWith(w + '/'));
}

/**
 * Where a project is, from .projects/<project>/.location. No file, or an empty string, is the
 * default place; before Eclipse 3.2 the string was a plain path. null when it cannot be told.
 */
function projectRoot(meta, workspace, name) {
  let buf;
  try {
    buf = fs.readFileSync(path.join(meta, '.location'));
  } catch (e) {
    return e.code === 'ENOENT' ? path.join(workspace, name) : null;
  }
  if (!buf.subarray(0, 16).equals(BEGIN_CHUNK)) return null;
  const end = buf.indexOf(END_CHUNK, 16);
  const s = end < 0 ? null : readUTF(buf.subarray(16, end), 0);
  if (!s) return null;
  if (s.text === '') return path.join(workspace, name);
  if (s.text.startsWith('URI//')) return uriPath(s.text.slice(5));
  return plainPath(s.text);
}

function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
    if (named) return named;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

function tag(xml, name) {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return m ? unescapeXml(m[1].trim()) : null;
}

/** Where a link points, or null when that cannot be told without guessing. */
function linkTarget(value, isUri, root, workspace) {
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]+:/i.test(value) && !isWindowsPath(value)) return isUri ? uriPath(value) : null;
  if (isWindowsPath(value) || /^[\\/]/.test(value)) {
    const p = plainPath(value);
    return p && isWindowsPath(p) ? path.win32.normalize(p) : p;
  }
  const m = /^(?:PARENT-(\d+)-)?([A-Za-z_][A-Za-z0-9_]*)(?:\/(.*))?$/.exec(value);
  if (!m) return null;
  // PARENT_LOC is the place of the parent of the resource being located, which differs from one
  // resource below the link to the next, so it is not followed either.
  let base;
  if (m[2] === 'PROJECT_LOC') base = root;
  else if (m[2] === 'WORKSPACE_LOC') base = workspace;
  if (!base) return null;
  for (let i = Number(m[1] || 0); i > 0; i--) base = flavour(base).dirname(base);
  let segs = (m[3] || '').split('/').filter(Boolean);
  if (isUri) {
    try {
      segs = segs.map(decodeURIComponent);
    } catch (_) {
      return null;
    }
  }
  return joinUnder(base, segs);
}

/** A project's .project -- in the project folder, else the server's copy -- or null when neither can be read. */
function projectFile(root, meta) {
  for (const f of [root && joinUnder(root, ['.project']), path.join(meta, '.project')]) {
    if (!f) continue;
    try {
      return fs.readFileSync(f, 'utf8');
    } catch (_) {
      /* try the next */
    }
  }
  return null;
}

/** The links a .project gives. */
function projectLinks(xml, root, workspace) {
  const out = [];
  for (const m of xml.matchAll(/<link>([\s\S]*?)<\/link>/g)) {
    const name = tag(m[1], 'name');
    if (!name) continue;
    const uri = tag(m[1], 'locationURI');
    const target = uri != null ? linkTarget(uri, true, root, workspace) : linkTarget(tag(m[1], 'location'), false, root, workspace);
    out.push({ segs: name.split('/').filter(Boolean), target });
  }
  return out;
}

/**
 * Where a project is, whether that is on a network path, and what links it has. Read the first
 * time a version of it is placed; nothing below a place on the network is read.
 */
function described(project) {
  if (project.links) return project;
  project.root = projectRoot(project.meta, project.workspace, project.name);
  project.remote = !!project.root && onNetwork(project.root, project.workspace);
  const xml = project.remote ? null : projectFile(project.root, project.meta);
  // Without a .project there is no telling whether some path went through a link.
  project.blind = !project.remote && xml == null;
  project.links = xml == null ? [] : projectLinks(xml, project.root, project.workspace);
  return project;
}

/**
 * Whether the language server keeps a file of the project in its own folder, by the rule jdt.ls
 * uses: .project, .classpath or .factorypath the project folder does not have, or a
 * .settings/<name>.prefs when the project folder has no .settings at all.
 */
function serverKeeps(segs, root) {
  if (segs.length === 1 && SERVER_OWN.has(segs[0])) return !exists(joinUnder(root, segs));
  if (segs.length === 2 && segs[0] === '.settings' && segs[1].endsWith('.prefs')) return !exists(joinUnder(root, ['.settings']));
  return false;
}

/**
 * Where a version's file was: { path }, with `blind` when the project has no .project left, so
 * a link in it would not be seen; or { path: null } when that cannot be told, with `remote`
 * when it would be on a network path, which is not looked at.
 */
function placeOf(v) {
  if (!v.segs) return { path: null };
  const project = described(v.project);
  const segs = v.segs;
  let link = null;
  for (const l of project.links) {
    if (l.segs.length && l.segs.length <= segs.length && l.segs.every((s, i) => s === segs[i])
      && (!link || l.segs.length > link.segs.length)) link = l;
  }
  if (link) {
    if (!link.target) return { path: null };
    if (onNetwork(link.target, project.workspace)) return { path: null, remote: true };
    return { path: joinUnder(link.target, segs.slice(link.segs.length)) };
  }
  if (project.remote) return { path: null, remote: true };
  if (!project.root) return { path: null };
  const blind = project.blind;
  if (serverKeeps(segs, project.root)) {
    const kept = path.join(project.meta, ...segs);
    const st = stat(kept);
    // A copy last written before the newest version was kept is not where that history came from.
    if (st && st.mtimeMs > v.newest) return { path: kept, blind };
  }
  return { path: joinUnder(project.root, segs), blind };
}

/** Every history.index below a project's .indexes, with the folder names leading to it. */
function indexFiles(dir, folders = [], out = []) {
  for (const e of entries(dir)) {
    if (e.isDirectory()) indexFiles(path.join(dir, e.name), [...folders, e.name], out);
    else if (e.name === 'history.index') out.push({ file: path.join(dir, e.name), folders });
  }
  return out;
}

/**
 * Everything one workspace's history holds. `versions` are those an index names, each with its
 * project and, when the path is sound and in its own folder, the path's segments, to be placed
 * with placeOf(); `states` maps every state file present by its uuid. A project is `live` when
 * some version of it still has its state file: only those are ever placed.
 */
function readWorkspace(workspace) {
  const res = path.join(workspace, ...RESOURCES);
  const states = new Map();
  for (const b of entries(path.join(res, '.history'))) {
    if (!b.isDirectory() || !/^[0-9a-f]{1,2}$/.test(b.name)) continue;
    for (const f of entries(path.join(res, '.history', b.name))) {
      if (f.isFile() && /^[0-9a-f]{32}$/.test(f.name)) states.set(f.name, path.join(res, '.history', b.name, f.name));
    }
  }
  const versions = [];
  let unreadable = 0;
  for (const p of entries(path.join(res, '.projects'))) {
    if (!p.isDirectory()) continue;
    const meta = path.join(res, '.projects', p.name);
    // Where the project is and what links it has are read by described(), when first needed.
    const project = { name: p.name, meta, workspace, live: false, links: null };
    for (const { file, folders } of indexFiles(path.join(meta, '.indexes'))) {
      let files;
      try {
        files = parseIndex(fs.readFileSync(file));
      } catch (_) {
        files = null;
      }
      if (!files) {
        unreadable++;
        continue;
      }
      for (const f of files) {
        const segs = f.key.split('/').slice(1);
        const sound = f.key.startsWith('/') && segs.length > 0 && segs.every((s) => s && s !== '.' && s !== '..');
        // A path that does not hash to the folder its index is in is not what Eclipse wrote there.
        const placed = sound && segs.slice(0, -1).map(bucketName).join('/') === folders.join('/');
        const newest = f.versions.reduce((m, v) => Math.max(m, v.time), -Infinity);
        for (const v of f.versions) {
          if (states.has(v.uuid)) project.live = true;
          versions.push({ key: f.key, segs: placed ? segs : null, uuid: v.uuid, time: v.time, newest, project });
        }
      }
    }
  }
  return { states, versions, unreadable };
}

/** Workspaces at or below a place: a workspace, its .metadata, or a folder somewhere above. */
function workspacesAt(place) {
  const dir = path.resolve(place);
  if (path.basename(dir) === 'org.eclipse.core.resources'
    && path.basename(path.dirname(path.dirname(dir))) === '.metadata') return [path.resolve(dir, '..', '..', '..')];
  if (path.basename(dir) === '.metadata' && isDir(path.join(dir, '.plugins', 'org.eclipse.core.resources'))) {
    return [path.dirname(dir)];
  }
  const out = [];
  const visit = (d, depth) => {
    if (isDir(path.join(d, ...RESOURCES))) {
      out.push(d);
      return;
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries(d)) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') visit(path.join(d, e.name), depth + 1);
    }
  };
  visit(dir, 0);
  return out;
}

function workspaces(ctx, notes) {
  const seen = new Set();
  const out = [];
  for (const place of ctx.locations['eclipse-history'] || []) {
    const found = workspacesAt(place);
    if (!found.length) notes.push(t('{0}: no Eclipse workspace there', place));
    for (const w of found) {
      if (!seen.has(w)) out.push(w);
      seen.add(w);
    }
  }
  return out;
}

/** "Antigravity IDE, Java language server" for an editor's workspace; the folder otherwise. */
function labelOf(workspace) {
  const parts = workspace.split(/[\\/]/);
  const i = parts.lastIndexOf('workspaceStorage');
  if (i >= 2 && parts[i - 1] === 'User' && parts[i + 2] === 'redhat.java') return t('{0}, Java language server', parts[i - 2]);
  return workspace;
}

/** The folder under which editors keep their per-app data, as in locations.js. */
function appDataBase() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/** Every language-server workspace of every editor here that has a history, and Eclipse's default. */
function discover() {
  const names = (d) => entries(d).filter((e) => e.isDirectory()).map((e) => e.name);
  const out = [];
  const base = appDataBase();
  for (const app of names(base)) {
    const storage = path.join(base, app, 'User', 'workspaceStorage');
    for (const ws of names(storage)) {
      const server = path.join(storage, ws, 'redhat.java');
      for (const w of names(server)) {
        if (isDir(path.join(server, w, ...RESOURCES, '.history'))) out.push(path.join(server, w));
      }
    }
  }
  const eclipse = path.join(os.homedir(), 'eclipse-workspace');
  if (isDir(path.join(eclipse, ...RESOURCES, '.history'))) out.push(eclipse);
  return out;
}

function stat(file) {
  try {
    return fs.statSync(file);
  } catch (_) {
    return null;
  }
}

async function scan(ctx) {
  const out = [];
  const all = workspaces(ctx, ctx.notes);
  for (let i = 0; i < all.length; i++) {
    const workspace = all[i];
    const label = labelOf(workspace);
    const note = label === workspace ? undefined : label;
    const { states, versions, unreadable } = readWorkspace(workspace);
    if (unreadable) ctx.notes.push(t('{0}: {1} history index file(s) could not be read', workspace, unreadable));
    const nameless = (file, st, time) => ({
      source: 'eclipse-history', kind: 'eclipse history, name unknown', path: null,
      time, size: st.size, file, origin: file, note,
    });
    // Every state file an index names, whatever became of it; the others are offered below.
    const named = new Set(versions.map((v) => v.uuid));
    const blind = new Set();
    let missing = 0;
    let changed = 0;
    let unplaced = 0;
    let remote = 0;
    for (const v of versions) {
      const file = states.get(v.uuid);
      const st = file && stat(file);
      // A project none of whose versions has its state file left is not looked up at all.
      const where = v.project.live ? placeOf(v) : { path: null };
      // The time check holds whether the path can be placed or not.
      if (!st || Math.abs(st.mtimeMs - v.time) > TIME_SLACK_MS) {
        if (ctx.matcher.test(where.path || v.key)) {
          if (st) changed++;
          else missing++;
        }
        continue;
      }
      if (!where.path) {
        if (ctx.unnamed) out.push(nameless(file, st, v.time));
        else if (ctx.matcher.test(v.key)) {
          if (where.remote) remote++;
          else unplaced++;
        }
        continue;
      }
      if (!ctx.matcher.test(where.path)) continue;
      if (where.blind) blind.add(v.project.name);
      const unsure = where.blind && t('its project has no .project left, so a link in it would not be seen');
      out.push({
        source: 'eclipse-history', kind: 'eclipse history', path: where.path, time: v.time,
        size: st.size, file, origin: file, note: [note, unsure].filter(Boolean).join('; ') || undefined,
      });
    }
    if (missing) ctx.notes.push(t('{0}: {1} version(s) named in an index have no state file left', workspace, missing));
    if (changed) {
      ctx.notes.push(t('{0}: {1} version(s) left out; the state file does not have the modification time Eclipse recorded, so it may have changed since', workspace, changed));
    }
    for (const name of blind) {
      ctx.notes.push(t('{0}: project {1} has no .project left; a linked folder or file in it would not be seen, so its paths are taken as the project folder\'s', workspace, name));
    }
    // A search by content alone also offers what no index names. Those that match a named copy
    // are merged away later, by content.
    if (ctx.unnamed) {
      for (const [uuid, file] of states) {
        if (named.has(uuid)) continue;
        const st = stat(file);
        if (st) out.push(nameless(file, st, st.mtimeMs));
      }
    } else {
      if (unplaced) {
        ctx.notes.push(t('{0}: {1} version(s) whose place cannot be told are offered only in a search by content', workspace, unplaced));
      }
      if (remote) {
        ctx.notes.push(t('{0}: {1} version(s) of a project or link on a network path were not placed, so that no search waits on the network; they are offered only in a search by content', workspace, remote));
      }
    }
    if (ctx.progress) ctx.progress(i + 1, all.length);
  }
  return out;
}

function describe(ctx) {
  const notes = [];
  const all = workspaces(ctx, notes);
  if (!all.length) return [t('No Eclipse or Java language server workspace found.'), ...notes];
  const groups = new Map();
  for (const workspace of all) {
    const label = labelOf(workspace);
    const g = groups.get(label) || { count: 0, files: 0, versions: 0, unnamed: 0 };
    const { states, versions } = readWorkspace(workspace);
    const named = new Set(versions.map((v) => v.uuid));
    g.count++;
    g.files += new Set(versions.map((v) => v.key)).size;
    g.versions += versions.filter((v) => states.has(v.uuid)).length;
    g.unnamed += [...states.keys()].filter((u) => !named.has(u)).length;
    groups.set(label, g);
  }
  return [...groups].map(([label, g]) =>
    t('{0}: {1} workspace(s), {2} file(s) with {3} earlier version(s), {4} more that no index names',
      label, g.count, g.files, g.versions, g.unnamed)).concat(notes);
}

/**
 * The folders read from, which restore will not write into: the .metadata of each workspace
 * found at a place, not the place itself. Eclipse keeps its projects in the workspace folder,
 * next to .metadata (~/eclipse-workspace/<project>), and that is where a file is most often put
 * back. No copy is read from anywhere below a workspace but .metadata/.plugins/
 * org.eclipse.core.resources -- a project's own .project is read only to place its paths -- and
 * nothing at all from a place above one but its workspaces. The resources folder, .history and
 * .projects are added by their real paths too, since the scan follows a link to another drive
 * (.history -> D:\eclipse-history) and restore resolves only the folders it is given. A place
 * that holds no workspace has nothing read from it, so it adds nothing.
 */
function roots(loc) {
  const out = [];
  const add = (p) => {
    if (!out.some((r) => isInside(p, r))) out.push(p);
  };
  for (const place of loc['eclipse-history'] || []) {
    for (const workspace of workspacesAt(place)) {
      const res = path.join(workspace, ...RESOURCES);
      add(path.join(workspace, '.metadata'));
      for (const dir of [res, path.join(res, '.history'), path.join(res, '.projects')]) {
        try {
          add(fs.realpathSync.native(dir));
        } catch (_) {
          /* not there: nothing is read from it */
        }
      }
    }
  }
  return out;
}

module.exports = {
  id: 'eclipse-history',
  label: 'Eclipse Local History',
  // Text only: a search for pictures or videos leaves it out.
  media: false,
  discover,
  scan,
  describe,
  roots,
  _internal: { parseIndex, readUTF, bucketName, plainPath, uriPath, onNetwork, linkTarget, projectRoot, workspacesAt, labelOf },
};
