'use strict';

// The programmatic interface. The command line is one front end on top of it; a graphical one
// can be another. Everything here returns plain data, reports progress through a callback, and
// shares the command line's rule: nothing is written except by restoreCopy and rebuildFolder,
// and only under the folder they are given.

const { search, sourceRoots, describeAll, locate, git, SOURCES } = require('./search');
const { restore, planRebuild, rebuild } = require('./restore');
const { load, looksBinary, asText } = require('./content');
const { absoluteFolder } = require('./paths');

/** Every source, as { id, label }. */
const sources = SOURCES.map((s) => ({ id: s.id, label: s.label }));

/** What each source can see on this machine: [{ id, label, lines }]. */
function describeSources(options = {}) {
  return describeAll(options);
}

/** The bytes of one copy from a search result. */
function readCopy(copy) {
  return load(copy, git);
}

/**
 * Writes one copy into `destDir`, under its original name, never over an existing file and
 * never inside a searched location. `locations` is the one returned by search().
 * @returns {Promise<string>} the path written
 */
async function restoreCopy(copy, destDir, locations) {
  return restore(copy, destDir, await sourceRoots(locations || locate({})), git);
}

/**
 * Finds every copy of anything below `folder` and picks the one to write for each path.
 * @param {string} folder   the folder as it was, usually one that no longer exists; taken as the
 *   command line takes it: "C:" is the drive's root, and a relative folder is made absolute
 * @param {object} [options] as for search(), without a pattern
 * @returns {Promise<{ folder: string, plan: { rel: string[], copy: object }[], locations: object, perSource: object[] }>}
 *   `folder` as it was understood
 */
async function planFolder(folder, options = {}) {
  const at = absoluteFolder(folder);
  const { results, locations, perSource } = await search({ ...options, pattern: undefined, under: at });
  return { folder: at, plan: planRebuild(results, at), locations, perSource };
}

/**
 * Writes a plan from planFolder() into a new folder inside `destDir`.
 * @returns {Promise<{ root: string, written: object[], failed: object[] }>}
 */
async function rebuildFolder(plan, folder, destDir, locations) {
  return rebuild(plan, absoluteFolder(folder), destDir, await sourceRoots(locations || locate({})), git);
}

module.exports = {
  sources,
  search,
  describeSources,
  readCopy,
  restoreCopy,
  planFolder,
  rebuildFolder,
  looksBinary,
  asText,
};
