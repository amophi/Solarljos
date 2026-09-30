'use strict';

// The programmatic interface. The command line is one front end on top of it; a graphical one
// can be another. Everything here returns plain data, reports progress through a callback, and
// shares the command line's rule: nothing is written except by restoreCopy and rebuildFolder,
// and only under the folder they are given.

const { search, sourceRoots, describeAll, freezeAll, locate, git, SOURCES } = require('./search');
const { restore, planRebuild, leftOutOf, rebuild, checkDestination: refuseInside, removeUnfinished } = require('./restore');
const { load, openCopy: open, looksBinary, asText } = require('./content');
const { absoluteFolder } = require('./paths');
const { isElevated } = require('./locations');
const { TYPES, sniff } = require('./types');
const { tier } = require('./quality');

/**
 * Every source, as { id, label, media, needsAdmin }: `media` is false for one that keeps only
 * text, which a search for pictures or videos leaves out; `needsAdmin` is true for one that reads
 * disks directly, which only works when isElevated() is.
 */
const sources = SOURCES.map((s) => ({ id: s.id, label: s.label, media: s.media !== false, needsAdmin: !!s.needsAdmin }));

/** What each source can see on this machine: [{ id, label, lines }]. */
function describeSources(options = {}) {
  return describeAll(options);
}

/** The bytes of one copy from a search result, all at once; openCopy() for one over 2 GiB. */
function readCopy(copy) {
  return load(copy, git);
}

/**
 * A stream of one copy's bytes, from `start` to `end`, both included and counted from 0, or to
 * its end when `end` is left out -- for a copy of any size, and for a player that seeks. The
 * stream must be read to its end or destroyed.
 * @param {object} copy
 * @param {{ start?: number, end?: number }} [range]
 * @returns {Promise<import('stream').Readable>}
 */
function openCopy(copy, range) {
  return open(copy, range || {}, git);
}

/**
 * Writes one copy into `destDir`, under its original name, never over an existing file and
 * never inside a searched location. A copy that is not simply the file says so in its name: a
 * smaller copy as "name (smaller copy 256x192).jpg", one that may be incomplete as
 * "name (may be incomplete).jpg". `locations` is the one returned by search().
 * @returns {Promise<string>} the path written
 */
async function restoreCopy(copy, destDir, locations) {
  return restore(copy, destDir, await sourceRoots(locations || locate({})), git);
}

/**
 * Throws, as restoreCopy() would, when `destDir` lies inside a place copies are searched for;
 * otherwise returns it made absolute. Nothing is written, and nothing is made.
 */
async function checkDestination(destDir, locations) {
  return refuseInside(destDir, await sourceRoots(locations || locate({})));
}

/**
 * Finds every copy of anything below `folder` and picks the one to write for each path.
 * @param {string} folder   the folder as it was, usually one that no longer exists; taken as the
 *   command line takes it: "C:" is the drive's root, and a relative folder is made absolute
 * @param {object} [options] as for search(), without a pattern
 * @returns {Promise<{ folder: string, plan: { rel: string[], copy: object }[], leftOut: { rel: string[], copy: object }[],
 *   locations: object, perSource: object[], notes: string[] }>}
 *   `folder` as it was understood; `leftOut` the paths whose only copies may be incomplete or are
 *   smaller copies, which the plan does not take unless they are added to it
 */
async function planFolder(folder, options = {}) {
  const at = absoluteFolder(folder);
  const { results, locations, perSource, notes } = await search({ ...options, pattern: undefined, under: at });
  return { folder: at, plan: planRebuild(results, at), leftOut: leftOutOf(results, at), locations, perSource, notes };
}

/**
 * Writes a plan from planFolder() into a new folder inside `destDir`.
 * @param {{ onProgress?: function }} [options]  called after each file with { done, total, rel }
 * @returns {Promise<{ root: string, written: object[], failed: object[] }>}
 */
async function rebuildFolder(plan, folder, destDir, locations, options = {}) {
  return rebuild(plan, absoluteFolder(folder), destDir, await sourceRoots(locations || locate({})), git, options);
}

/**
 * Has the sources that read stores other programs keep rewriting -- Explorer's thumbnail cache --
 * take them into memory now, before anything that could add to them or clear them: opening a
 * browser, restoring a photo and looking at it in Explorer. Searches after this read what was
 * there now. Takes { sources, locations } as search() does; writes nothing.
 * @returns {Promise<{ id: string, label: string, error?: string }[]>}
 */
function freeze(options = {}) {
  return freezeAll(options);
}

module.exports = {
  sources,
  search,
  describeSources,
  readCopy,
  openCopy,
  restoreCopy,
  checkDestination,
  planFolder,
  rebuildFolder,
  freeze,
  // For a front end about to end its process while restoreCopy() or rebuildFolder() may still be
  // writing: removes the temporary files of those writes, so that none is left behind. Nothing
  // stands under a copy's name that is not all of it either way. Synchronous, to run just before exit.
  removeUnfinished,
  sniff,
  TYPES,
  // How far a copy can be trusted, 0 to 4: exact, inexact, draft, unverified, derived (quality.js).
  tier,
  isElevated: () => isElevated(),
  looksBinary,
  asText,
};
