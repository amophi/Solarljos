'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathKey } = require('./paths');

// Where each source looks. Every location can be given explicitly, which is also how a
// drive from another machine is searched. Unless discovery is turned off, the usual places
// on this machine are added on top.

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

/** `X:\$Recycle.Bin` on every drive that has one. A: and B: are skipped; probing them can stall. */
function discoverRecycleRoots() {
  if (process.platform !== 'win32') return [];
  const out = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = letter + ':\\$Recycle.Bin';
    if (isDir(root)) out.push(root);
  }
  return out;
}

/** The folder under which editors keep their per-app data. */
function editorDataBase() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/**
 * VS Code and every fork of it -- Cursor, Windsurf, Antigravity, VSCodium and the rest -- keep
 * Local History in `<app data>/User/History`. Rather than list the forks, any app folder with
 * that layout is taken, so a fork released next month is found too.
 */
function discoverHistoryRoots() {
  const base = editorDataBase();
  let names;
  try {
    names = fs.readdirSync(base);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const name of names) {
    const dir = path.join(base, name, 'User', 'History');
    if (isDir(dir)) out.push({ label: name, dir });
  }
  return out;
}

function discoverClaudeDir() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return isDir(dir) ? dir : null;
}

/** Antigravity's data folders: ~/.gemini/antigravity-ide and any sibling of that kind with a brain. */
function discoverAntigravityDirs() {
  const base = path.join(os.homedir(), '.gemini');
  let names;
  try {
    names = fs.readdirSync(base);
  } catch (_) {
    return [];
  }
  return names
    .filter((n) => n.toLowerCase().startsWith('antigravity'))
    .map((n) => path.join(base, n))
    .filter((d) => isDir(path.join(d, 'brain')));
}

/** This machine's own places for the older sources, and the folder git looks in by default. */
const THIS_MACHINE = {
  recycle: discoverRecycleRoots,
  history: discoverHistoryRoots,
  claude: () => [].concat(discoverClaudeDir() || []),
  antigravity: discoverAntigravityDirs,
  cwd: () => process.cwd(),
};

// The older sources, whose places come from their own options as well as from --location. "git"
// and "repos", its older name, are one: the folders to look for repositories in.
const OLDER = new Set(['recycle', 'history', 'claude', 'antigravity', 'git', 'repos']);

/**
 * @param {object} o
 * @param {boolean} o.discover     add this machine's usual places
 * @param {string[]} o.recycleDirs
 * @param {string[]} o.historyDirs
 * @param {string} o.claudeDir
 * @param {string[]} o.antigravityDirs
 * @param {string[]} o.repos       folders to look for git repositories in
 * @param {object} o.dirs          { <source id>: [places] }, as --location gives them
 * @param {object} o.discoverers   { <source id>: () => places }, supplied by search.js
 * @param {object} [o.machine]     for tests: stands in for THIS_MACHINE
 */
function resolveLocations(o) {
  const discover = o.discover !== false;
  const machine = { ...THIS_MACHINE, ...(o.machine || {}) };
  const given = o.dirs || {};
  const abs = (list) => [].concat(list || []).map((p) => path.resolve(p));

  // --location adds to an older source's places as its own option does: a place given either
  // way is searched, and so is every one found on this machine.
  const recycle = [...abs(o.recycleDirs), ...abs(given.recycle)];
  const history = [...abs(o.historyDirs), ...abs(given.history)].map((p) => ({ label: p, dir: p }));
  const claude = [...abs(o.claudeDir), ...abs(given.claude)];
  const antigravity = [...abs(o.antigravityDirs), ...abs(given.antigravity)];
  // The current folder is where git looks when it is given nowhere else to, not a place found on
  // this machine: --repo and --location git= both replace it.
  const repos = [...abs(o.repos), ...abs(given.git), ...abs(given.repos)];

  if (discover) {
    recycle.push(...machine.recycle());
    history.push(...machine.history());
    claude.push(...machine.claude());
    antigravity.push(...machine.antigravity());
    if (!repos.length) repos.push(machine.cwd());
  }

  // Newer sources find their own places. Their entries are kept as given, since some are
  // more than a folder (a snapshot and the drive it belongs to, say); each source reads its own.
  const own = {};
  const ids = new Set([...Object.keys(given), ...Object.keys(o.discoverers || {})].filter((id) => !OLDER.has(id)));
  for (const id of ids) {
    let found = [];
    if (discover && o.discoverers && typeof o.discoverers[id] === 'function') {
      try {
        found = o.discoverers[id]() || [];
      } catch (_) {
        found = [];
      }
    }
    own[id] = dedupe([...(given[id] || []), ...found]);
  }

  return {
    recycle: dedupeBy(recycle, pathKey),
    history: dedupeBy(history, (h) => pathKey(h.dir)),
    claude: dedupeBy(claude, pathKey),
    antigravity: dedupeBy(antigravity, pathKey),
    repos: dedupeBy(repos, pathKey),
    ...own,
  };
}

function dedupe(list) {
  return [...new Set(list)];
}

function dedupeBy(list, key) {
  const seen = new Set();
  return list.filter((x) => (seen.has(key(x)) ? false : seen.add(key(x))));
}

module.exports = { resolveLocations, editorDataBase };
