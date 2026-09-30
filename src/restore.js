'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { t } = require('./i18n');
const { baseName, isInside, pathKey, splitPath } = require('./paths');
const { HEAD_CHECK, openCopy } = require('./content');
const { better, isDerived, isUnverified, rebuildable } = require('./quality');

// Restoring is the one place anything is written, and only under the folder the user named.
// It never replaces a file: a name that is taken gets " (recovered 2)", " (recovered 3)"...
//
// Nor does a copy ever stand under its name before all of it is there. It is streamed -- a
// video of many gigabytes as much as a text file -- into a temporary file beside where it goes,
// ".~solarljos-<random>.part", and only then given its name, by a hard link: that fails rather
// than replace a file that took the name in the meantime. The temporary name is removed after.
// On a file system without hard links, as FAT and exFAT on memory cards and USB sticks are, the
// file is renamed instead once the name is seen to be free; a file appearing in that very moment
// would be replaced, which is the most those file systems allow. When anything fails -- a copy
// that cannot be read to its end, a disk that fills up -- the temporary file is removed and no
// file is left under the copy's name. A process killed while writing leaves the temporary file,
// whose name says what it is, and never a short file that looks like the copy; a front end about
// to end its own process calls removeUnfinished() first, which removes those still being written.
//
// A copy that is pieces of a disk (content.js's extent) is read again from the disk when it is
// written, and a card or a stick can change between the search and the restore: Windows and other
// programs write to a card while it is in, into the free clusters deleted files lie in, and a card
// swapped for another in the same reader reads as the same drive. So what is written is checked
// against what the search read: the whole copy against its hash, taken for one of HASH_LIMIT or
// less, and a larger one's first HEAD_CHECK bytes against theirs. One that differs fails, and
// nothing is left under its name.
//
// Where not to write is given as folders -- the places the sources read -- and as volumes. A folder
// is refused however it is reached: by its own name, through a link or a junction, and by any
// other name for the same folder, such as \\localhost\C$\... for C:\..., a SUBST letter or a mapped
// one, which realpath does not see through; those are told by the folder's volume and file ID. A
// volume, { volume, label }, is a drive being recovered that has no folder to name, such as a card
// given as \\.\PhysicalDrive1: a destination whose nearest existing folder lies on it (stat()'s
// dev, which on Windows is the volume's serial number) is refused.

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
      // The mark is said in the language Solarljos speaks, like the tags a smaller or incomplete
      // copy gets; made safe again, since a translation is text from elsewhere.
      const n = i === 1 ? stem + ext : safeName(t('{0} (recovered {1})', stem, i)) + ext;
      i++;
      return n;
    },
  };
}

/** Whether something is at `p`. Anything but "not there" is taken as there, or as an error. */
function taken(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw e;
  }
}

/** Gives a finished temporary file the first free name of `name`'s candidates, never replacing one. */
function placeNew(temp, dir, name) {
  const names = candidateNames(name);
  let linking = true;
  for (;;) {
    const target = path.join(dir, names.next());
    if (linking) {
      try {
        fs.linkSync(temp, target);
        return target;
      } catch (e) {
        if (e.code === 'EEXIST') continue;
        // No hard links here: FAT or exFAT, or a share that does not offer them.
        linking = false;
      }
    }
    if (taken(target)) continue;
    fs.renameSync(temp, target);
    return target;
  }
}

function removeQuietly(p) {
  try {
    fs.rmSync(p, { force: true });
  } catch (_) {
    /* held open by another program, such as a virus scanner: left, under a name that says what it is */
  }
}

// The temporary files being written now, for removeUnfinished().
const unfinished = new Set();

/**
 * Streams `data` into a new file in `dir`: under `name`, or the first free "name (recovered N)".
 * `check`, a Transform the bytes pass through on the way, fails the write when they are not what
 * they should be. The stream is used up or destroyed either way.
 * @returns {Promise<string>} the path written
 */
async function writeNew(dir, name, data, check) {
  const temp = path.join(dir, `.~solarljos-${crypto.randomBytes(6).toString('hex')}.part`);
  let fd;
  try {
    // Made here, so that what is removed below is only ever this file: a name that is somehow
    // taken already fails, and whatever holds it is left alone.
    fd = fs.openSync(temp, 'wx');
  } catch (e) {
    data.destroy();
    throw e;
  }
  unfinished.add(temp);
  try {
    await pipeline(data, ...(check ? [check] : []), fs.createWriteStream(temp, { fd }));
    return placeNew(temp, dir, name);
  } finally {
    unfinished.delete(temp);
    removeQuietly(temp);
  }
}

/**
 * Removes the temporary files of every write still going on, for a process about to end: the
 * process leaves no ".part" file behind, and no file under a copy's name either, since a copy is
 * given its name only once it is all there. Synchronous, so that it can run just before exit. On
 * Windows a file still open is removed when the process lets go of it.
 */
function removeUnfinished() {
  for (const temp of unfinished) removeQuietly(temp);
  unfinished.clear();
}

/**
 * Checks, as they are written, that a copy's bytes are still those the search read (see the top
 * of this file); null for a copy that is not pieces of a disk, or that nothing was taken of.
 * @returns {import('stream').Transform|null}
 */
function sameAsFound(c) {
  const x = c.extent;
  if (!x || !Array.isArray(x.runs) || (!c.hash && !x.head)) return null;
  const total = x.runs.reduce((n, run) => n + (Array.isArray(run) && Number.isSafeInteger(run[1]) ? run[1] : 0), 0);
  const whole = c.hash ? crypto.createHash('sha1').update(`blob ${total}\0`) : null;
  const first = !whole ? crypto.createHash('sha1') : null;
  let firstLeft = first ? Math.min(HEAD_CHECK, total) : 0;
  const changed = () => new Error(t('{0} no longer holds what the search found there: something was written to it since, '
    + 'or it is another card. Nothing was saved; search again.', x.place));
  return new Transform({
    transform(chunk, _enc, done) {
      if (whole) whole.update(chunk);
      if (firstLeft > 0) {
        const part = chunk.subarray(0, firstLeft);
        first.update(part);
        firstLeft -= part.length;
        if (!firstLeft && first.digest('hex') !== x.head) return done(changed());
      }
      return done(null, chunk);
    },
    flush(done) {
      if ((whole && whole.digest('hex') !== c.hash) || firstLeft > 0) return done(changed());
      return done();
    },
  });
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
async function copyTree(from, to, avoid) {
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const st = fs.lstatSync(src, { bigint: true });
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (!avoid.has(folderId(st))) await copyTree(src, mkdirNew(to, name), avoid);
    } else if (st.isFile()) {
      await writeNew(to, name, await openCopy({ file: src }));
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

/** The folders among the places not to write into; the rest are volumes. */
const foldersOf = (protect) => protect.filter((p) => typeof p === 'string' && p);

/** The volume a path is on, as stat() gives it (dev), from its nearest part that exists; null for none. */
function volumeOf(p) {
  for (let at = realOf(p); ; at = path.dirname(at)) {
    try {
      return String(fs.statSync(at, { bigint: true }).dev);
    } catch (_) {
      if (path.dirname(at) === at) return null;
    }
  }
}

/**
 * Refuses a destination inside any searched location, however either is spelled: a link or a
 * junction on the way to --to must not lead back into a source, nor another name for the same
 * folder (see the top of this file). Refuses one on a volume being recovered, too.
 * @param {string} destDir
 * @param {(string|{ volume: string, label: string })[]} protect  folders, and volumes by stat()'s dev
 */
function checkDestination(destDir, protect) {
  if (!destDir) throw new Error(t('Say where to put it with --to <folder>.'));
  const dest = path.resolve(destDir);
  const realDest = realOf(dest);
  const refuse = (root) => new Error(t('Refusing to write inside {0}; that is where copies are searched for.', root));
  const folders = foldersOf(protect);
  for (const root of folders) {
    const realRoot = realOf(root);
    if (isInside(dest, root) || isInside(realDest, root) || isInside(dest, realRoot) || isInside(realDest, realRoot)) {
      throw refuse(root);
    }
  }
  // The same folders by any other name: the destination, or a folder it is in, is one of them.
  const holding = foldersHolding(dest);
  for (const root of folders) {
    let id = null;
    try {
      id = folderId(fs.statSync(realOf(root), { bigint: true }));
    } catch (_) {
      /* not there: nothing can be inside it */
    }
    if (id && holding.has(id)) throw refuse(root);
  }
  const volumes = protect.filter((p) => p && typeof p === 'object' && p.volume != null);
  if (volumes.length) {
    const on = volumeOf(dest);
    const hit = on != null && volumes.find((v) => String(v.volume) === on);
    if (hit) {
      throw new Error(t('Refusing to write onto {0}; that is the drive being recovered, and writing there can overwrite '
        + 'what is still to be found.', hit.label || hit.volume));
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
  return foldersOf(protect).some((root) => isInside(at, root) && !isInside(real, realOf(root)));
}

/**
 * A name that says what a copy is when it is not simply the file: "photo (smaller copy 256x192).jpg"
 * for a smaller copy made from it, which takes the extension of its own format -- a thumbnail of a
 * video is a picture -- and "photo (may be incomplete).jpg" for one that may be.
 */
function tagged(name, c) {
  const derived = isDerived(c);
  const partial = isUnverified(c);
  if (!derived && !partial) return name;
  const { stem, ext } = splitName(name);
  const said = [];
  if (derived) said.push(c.width && c.height ? t('smaller copy {0}x{1}', c.width, c.height) : t('smaller copy'));
  if (partial) said.push(t('may be incomplete'));
  const own = derived && c.ext ? c.ext : ext || c.ext || '';
  return `${stem} (${said.join(', ')})${own}`;
}

/**
 * The name to restore a copy under: its own, the name a source knows for it, or one from its ID
 * with the extension of its format, as tagged() says.
 */
function nameFor(c) {
  if (c.path) return tagged(baseName(c.path), c);
  if (c.name) return tagged(c.name, c);
  return tagged(`recovered-${c.id}${c.ext || ''}`, c);
}

/**
 * @param {object} c          a search result
 * @param {string} destDir    where to put it
 * @param {Array} protect     folders that must not be written into -- the sources themselves --
 *                            and volumes, as checkDestination() takes them
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
    await copyTree(c.dir, target, avoid);
    return target;
  }
  // Opened before anything is made, so that a copy that cannot be read leaves no folder behind.
  const data = await openCopy(c, {}, git);
  try {
    fs.mkdirSync(dest, { recursive: true });
  } catch (e) {
    data.destroy();
    throw e;
  }
  return writeNew(dest, name, data, sameAsFound(c));
}

// A backslash in a Linux name stays in it: /d/x\y.txt is the file "x\y.txt" in d, beside the
// folder x, and not x/y.txt, which it would otherwise take the place of (see paths.js).
const segments = splitPath;

/** The best copy of each path below `folder` (see quality.js), sorted by path. */
function bestByPath(results, folder) {
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
 * One copy per path below `folder`: the one to write when rebuilding it (see quality.js). A
 * draft is usually the newest thing around, so it is taken only for a path that has no saved
 * copy at all, and an inexact copy only for one with no exact copy. A path whose only copies
 * may be incomplete, or are smaller copies made from the file, is left out: see leftOutOf().
 * @returns {{ rel: string[], copy: object }[]} sorted by path
 */
function planRebuild(results, folder) {
  return bestByPath(results, folder).filter(({ copy }) => rebuildable(copy));
}

/**
 * The paths below `folder` that planRebuild() leaves out, each with its best copy: all that is
 * left of them may be incomplete, or is a smaller copy. They are for the user to choose, one by
 * one; added to a plan, rebuild writes them under names that say what they are.
 * @returns {{ rel: string[], copy: object }[]} sorted by path
 */
function leftOutOf(results, folder) {
  return bestByPath(results, folder).filter(({ copy }) => !rebuildable(copy));
}

/**
 * Writes a plan into a new folder under `destDir`, named after the folder being rebuilt.
 * A file that cannot be read or written is reported, not fatal: the rest still comes back.
 *
 * Every folder is made before any file. A path can be a file in one copy and a folder in another
 * -- a script "bin" that later became bin/cli.js, as git history often has -- and the file sorts
 * first. Written first, it would stand where the folder belongs and fail every file below it; as
 * it is, the folder keeps its name and the file comes back beside it as "bin (recovered 2)".
 * @param {{ onProgress?: function }} [o]  called after each file with { done, total, rel }
 */
async function rebuild(plan, folder, destDir, protect, git, { onProgress } = {}) {
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
  for (let i = 0; i < plan.length; i++) {
    const item = plan[i];
    const dir = dirOf(item);
    if (made.get(dir)) {
      failed.push({ ...item, error: made.get(dir) });
    } else {
      try {
        const data = await openCopy(item.copy, {}, git);
        const target = await writeNew(dir, tagged(item.rel[item.rel.length - 1], item.copy), data, sameAsFound(item.copy));
        written.push({ ...item, target });
      } catch (e) {
        failed.push({ ...item, error: e.message });
      }
    }
    if (typeof onProgress === 'function') onProgress({ done: i + 1, total: plan.length, rel: item.rel });
  }
  return { root, written, failed };
}

module.exports = {
  restore, planRebuild, leftOutOf, rebuild, checkDestination, removeUnfinished,
  _internal: { candidateNames, safeName, realOf, nameFor, tagged, leadsElsewhere, writeNew, placeNew, sameAsFound, volumeOf, unfinished },
};
