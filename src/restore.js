'use strict';

const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');
const { baseName, isInside, pathKey } = require('./paths');
const { load } = require('./content');

// Restoring is the one place anything is written, and only under the folder the user named.
// It never replaces a file: a name that is taken gets " (recovered 2)", " (recovered 3)"...
// and the write itself fails rather than overwrite, should a file appear in between.

function splitName(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
}

function candidateNames(name) {
  const { stem, ext } = splitName(name);
  let i = 1;
  return {
    next() {
      const n = i === 1 ? name : `${stem} (recovered ${i})${ext}`;
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

function copyTree(from, to) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(dst);
      copyTree(src, dst);
    } else if (e.isFile()) {
      fs.writeFileSync(dst, fs.readFileSync(src), { flag: 'wx' });
    }
  }
}

function checkDestination(destDir, protect) {
  if (!destDir) throw new Error(t('Say where to put it with --to <folder>.'));
  const dest = path.resolve(destDir);
  for (const root of protect) {
    if (isInside(dest, root)) throw new Error(t('Refusing to write inside {0}; that is where copies are searched for.', root));
  }
  return dest;
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
  fs.mkdirSync(dest, { recursive: true });
  const name = c.path ? baseName(c.path) : `recovered-${c.id}`;
  if (c.isDir) {
    const target = mkdirNew(dest, name);
    copyTree(c.dir, target);
    return target;
  }
  return writeNew(dest, name, await load(c, git));
}

// Rebuilding a folder takes, for every path below it, the newest copy found anywhere. Between
// copies from the same moment, bytes that were on disk beat text as an agent saw it, and an
// edit rebuilt by applying it comes last.
const FIDELITY = {
  'recycle bin': 0,
  'recycle bin, inside a deleted folder': 0,
  'local history': 0,
  'claude backup': 0,
  'git commit': 0,
  'git index': 0,
  'git, deleted in a commit': 0,
  'claude write': 1,
  'antigravity write': 1,
  'antigravity read': 1,
  'claude read': 2,
  'claude, before a write': 2,
  'claude, before an edit': 2,
  'claude, after an edit': 3,
};

function newer(a, b) {
  const ta = a.time == null ? -Infinity : a.time;
  const tb = b.time == null ? -Infinity : b.time;
  if (ta !== tb) return ta > tb;
  const fa = a.kind in FIDELITY ? FIDELITY[a.kind] : 9;
  const fb = b.kind in FIDELITY ? FIDELITY[b.kind] : 9;
  return fa < fb;
}

const segments = (p) => String(p).split(/[\\/]/).filter(Boolean);

/**
 * One copy per path below `folder`: the one to write when rebuilding it. A draft -- text that
 * was never saved -- is usually the newest thing around, so it is taken only for a path that
 * has no saved copy at all.
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
    if (!prev) best.set(key, c);
    else if (!!prev.draft !== !!c.draft) {
      if (prev.draft) best.set(key, c);
    } else if (newer(c, prev)) best.set(key, c);
  }
  return [...best.values()]
    .map((copy) => ({ rel: segments(copy.path).slice(depth), copy }))
    .filter(({ rel }) => rel.length && rel.every((s) => s !== '.' && s !== '..'))
    .sort((a, b) => a.rel.join('/').localeCompare(b.rel.join('/')));
}

/**
 * Writes a plan into a new folder under `destDir`, named after the folder being rebuilt.
 * A file that cannot be read is reported, not fatal: the rest still comes back.
 */
async function rebuild(plan, folder, destDir, protect, git) {
  const dest = checkDestination(destDir, protect);
  fs.mkdirSync(dest, { recursive: true });
  await git.preload(plan.map((p) => p.copy));
  const root = mkdirNew(dest, baseName(folder) || 'rebuilt');
  const written = [];
  const failed = [];
  for (const item of plan) {
    try {
      const data = await load(item.copy, git);
      const dir = path.join(root, ...item.rel.slice(0, -1));
      fs.mkdirSync(dir, { recursive: true });
      const target = writeNew(dir, item.rel[item.rel.length - 1], data);
      written.push({ ...item, target });
    } catch (e) {
      failed.push({ ...item, error: e.message });
    }
  }
  return { root, written, failed };
}

module.exports = { restore, planRebuild, rebuild, _internal: { candidateNames, newer } };
