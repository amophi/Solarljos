'use strict';

const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');
const { baseName, isInside } = require('./paths');
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

/**
 * @param {object} c          a search result
 * @param {string} destDir    where to put it
 * @param {string[]} protect  folders that must not be written into -- the sources themselves
 * @param {object} git        the git source, to read blobs
 * @returns {Promise<string>} the path written
 */
async function restore(c, destDir, protect, git) {
  if (!destDir) throw new Error(t('Say where to put it with --to <folder>.'));
  const dest = path.resolve(destDir);
  for (const root of protect) {
    if (isInside(dest, root)) throw new Error(t('Refusing to write inside {0}; that is where copies are searched for.', root));
  }
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

module.exports = { restore, _internal: { candidateNames } };
