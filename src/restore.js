'use strict';

const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');
const { baseName, isInside, pathKey, splitPath } = require('./paths');
const { load } = require('./content');
const { better } = require('./quality');

// Restoring is the one place anything is written, and only under the folder the user named.
// It never replaces a file: a name that is taken gets " (recovered 2)", " (recovered 3)"...
// and the write itself fails rather than overwrite, should a file appear in between.

function splitName(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
}

// On Windows a name from another system can mean something else. "a:b" is not a file named
// a:b but a stream b attached to a file a -- which would add to an existing file rather than
// create one. Characters Windows cannot hold become "_", as do trailing dots and spaces it
// would drop, and device names such as CON get a "_" in front.
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

function safeName(name) {
  let n = String(name).replace(/\0/g, '_');
  if (process.platform === 'win32') {
    n = n.replace(/[<>:"|?*\\/\x00-\x1f]/g, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length));
    if (WIN_RESERVED.test(n)) n = '_' + n;
  } else {
    n = n.replace(/\//g, '_');
  }
  if (!n || n === '.' || n === '..') n = '_' + n;
  return n;
}

function candidateNames(name) {
  const { stem, ext } = splitName(safeName(name));
  let i = 1;
  return {
    next() {
      const n = i === 1 ? stem + ext : `${stem} (recovered ${i})${ext}`;
      i++;
      return n;
    },
  };
}

function writeNew(dir, name, data) {
  const names = candidateNames(name);
  for (;;) {
    const target = path.join(dir, names.next());
    try {
      fs.writeFileSync(target, data, { flag: 'wx' });
      return target;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

function mkdirNew(dir, name) {
  const names = candidateNames(name);
  for (;;) {
    const target = path.join(dir, names.next());
    try {
      fs.mkdirSync(target);
      return target;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

/**
 * A folder's volume and file ID, which are the same however the folder is reached; null where the
 * file system gives none (0), so that such folders never look alike.
 */
function folderId(st) {
  return st.ino ? `${st.dev}:${st.ino}` : null;
}

/**
 * The folders a path is in, itself included, by ID: a folder with one of these IDs holds the copy
 * being written, whether it is reached by its own name, through a link, or as a mount elsewhere.
 */
function foldersHolding(p) {
  const ids = new Set();
  for (let at = realOf(p); ; at = path.dirname(at)) {
    try {
      const id = folderId(fs.statSync(at, { bigint: true }));
      if (id) ids.add(id);
    } catch (_) {
      /* not made yet */
    }
    if (path.dirname(at) === at) return ids;
  }
}

/**
 * Copies a deleted folder. A link or junction inside it is left out, not followed: what it leads
 * to was not deleted with the folder, and may be the folder being written. So is any folder that
 * holds the copy being written, which would otherwise be copied into itself without end. Two
 * names that come out the same here -- "a:b" and "a_b" on Windows, or "Readme" and "README" --
 * both come back, the second with " (recovered 2)".
 */
function copyTree(from, to, avoid) {
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const st = fs.lstatSync(src, { bigint: true });
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (!avoid.has(folderId(st))) copyTree(src, mkdirNew(to, name), avoid);
    } else if (st.isFile()) {
      writeNew(to, name, fs.readFileSync(src));
    }
  }
}

/** A path as it really is, through links and junctions, as far as it exists; the rest as given. */
function realOf(p) {
  let head = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...rest.reverse());
    } catch (_) {
      const up = path.dirname(head);
      if (up === head) return path.resolve(p);
      rest.push(path.basename(head));
      head = up;
    }
  }
}

/**
 * Refuses a destination inside any searched location, however either is spelled: a link or a
 * junction on the way to --to must not lead back into a source.
 */
function checkDestination(destDir, protect) {
  if (!destDir) throw new Error(t('Say where to put it with --to <folder>.'));
  const dest = path.resolve(destDir);
  const realDest = realOf(dest);
  for (const root of protect) {
    const realRoot = realOf(root);
    if (isInside(dest, root) || isInside(realDest, root) || isInside(dest, realRoot) || isInside(realDest, realRoot)) {
      throw new Error(t('Refusing to write inside {0}; that is where copies are searched for.', root));
    }
  }
  return dest;
}

/**
 * Whether a deleted folder leads somewhere else. A link or a junction that was deleted is still
 * a link where it was put, and read through it gives the live folder it points to -- offered as
 * deleted, and perhaps the very folder being written to. The folder must not be a link itself,
 * and must really be inside the searched location it is found in.
 */
function leadsElsewhere(dir, protect) {
  const at = path.resolve(dir);
  let st;
  try {
    st = fs.lstatSync(at);
  } catch (_) {
    return false; // gone: the copy fails on its own, saying so
  }
  if (st.isSymbolicLink()) return true;
  const real = realOf(at);
  return protect.some((root) => isInside(at, root) && !isInside(real, realOf(root)));
}

/** The name to restore a copy under: its own, the name a source knows for it, or one from its ID. */
function nameFor(c) {
  if (c.path) return baseName(c.path);
  if (c.name) return c.name;
  return `recovered-${c.id}`;
}

/**
 * @param {object} c          a search result
 * @param {string} destDir    where to put it
 * @param {string[]} protect  folders that must not be written into -- the sources themselves
 * @param {object} git        the git source, to read blobs
 * @returns {Promise<string>} the path written
 */
async function restore(c, destDir, protect, git) {
  const dest = checkDestination(destDir, protect);
  if (c.gone) throw new Error(t('Nothing of this copy is left to restore.'));
  const name = nameFor(c);
  if (c.isDir) {
    if (leadsElsewhere(c.dir, protect)) {
      throw new Error(t('Refusing to restore {0}: it leads through a link to {1}.', c.dir, realOf(c.dir)));
    }
    const avoid = foldersHolding(dest);
    if (avoid.has(folderId(fs.statSync(c.dir, { bigint: true })))) {
      throw new Error(t('Refusing to write inside {0}; that is the folder being restored.', c.dir));
    }
    fs.mkdirSync(dest, { recursive: true });
    const target = mkdirNew(dest, name);
    const own = folderId(fs.statSync(target, { bigint: true }));
    if (own) avoid.add(own);
    copyTree(c.dir, target, avoid);
    return target;
  }
  fs.mkdirSync(dest, { recursive: true });
  return writeNew(dest, name, await load(c, git));
}

// A backslash in a Linux name stays in it: /d/x\y.txt is the file "x\y.txt" in d, beside the
// folder x, and not x/y.txt, which it would otherwise take the place of (see paths.js).
const segments = splitPath;

/**
 * One copy per path below `folder`: the one to write when rebuilding it (see quality.js). A
 * draft is usually the newest thing around, so it is taken only for a path that has no saved
 * copy at all, and an inexact copy only for one with no exact copy.
 * @returns {{ rel: string[], copy: object }[]} sorted by path
 */
function planRebuild(results, folder) {
  const prefix = pathKey(folder).replace(/[\\/]+$/, '');
  const depth = segments(folder).length;
  const best = new Map();
  for (const c of results) {
    if (c.isDir || c.gone || !c.path) continue;
    const key = pathKey(c.path);
    if (!key.startsWith(prefix + '/')) continue;
    const prev = best.get(key);
    if (!prev || better(c, prev)) best.set(key, c);
  }
  return [...best.values()]
    .map((copy) => ({ rel: segments(copy.path).slice(depth), copy }))
    .filter(({ rel }) => rel.length && rel.every((s) => s !== '.' && s !== '..'))
    .sort((a, b) => a.rel.join('/').localeCompare(b.rel.join('/')));
}

/**
 * Writes a plan into a new folder under `destDir`, named after the folder being rebuilt.
 * A file that cannot be read or written is reported, not fatal: the rest still comes back.
 *
 * Every folder is made before any file. A path can be a file in one copy and a folder in another
 * -- a script "bin" that later became bin/cli.js, as git history often has -- and the file sorts
 * first. Written first, it would stand where the folder belongs and fail every file below it; as
 * it is, the folder keeps its name and the file comes back beside it as "bin (recovered 2)".
 */
async function rebuild(plan, folder, destDir, protect, git) {
  const dest = checkDestination(destDir, protect);
  fs.mkdirSync(dest, { recursive: true });
  await git.preload(plan.map((p) => p.copy));
  const root = mkdirNew(dest, baseName(folder) || 'rebuilt');
  const dirOf = (item) => path.join(root, ...item.rel.slice(0, -1).map(safeName));
  const made = new Map(); // folder -> null, or why it could not be made
  for (const item of plan) {
    const dir = dirOf(item);
    if (made.has(dir)) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      made.set(dir, null);
    } catch (e) {
      made.set(dir, e.message);
    }
  }
  const written = [];
  const failed = [];
  for (const item of plan) {
    const dir = dirOf(item);
    if (made.get(dir)) {
      failed.push({ ...item, error: made.get(dir) });
      continue;
    }
    try {
      const data = await load(item.copy, git);
      const target = writeNew(dir, item.rel[item.rel.length - 1], data);
      written.push({ ...item, target });
    } catch (e) {
      failed.push({ ...item, error: e.message });
    }
  }
  return { root, written, failed };
}

module.exports = { restore, planRebuild, rebuild, _internal: { candidateNames, safeName, realOf, nameFor, leadsElsewhere } };
