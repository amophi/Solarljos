'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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

/**
 * @param {object} o
 * @param {boolean} o.discover     add this machine's usual places
 * @param {string[]} o.recycleDirs
 * @param {string[]} o.historyDirs
 * @param {string} o.claudeDir
 * @param {string[]} o.antigravityDirs
 * @param {string[]} o.repos       folders to look for git repositories in
 * @param {object} o.dirs          { <source id>: [places] } for sources that find their own places
 * @param {object} o.discoverers   { <source id>: () => places }, supplied by search.js
 */
function resolveLocations(o) {
  const discover = o.discover !== false;
  const recycle = [...(o.recycleDirs || [])].map((p) => path.resolve(p));
  const history = (o.historyDirs || []).map((p) => ({ label: path.resolve(p), dir: path.resolve(p) }));
  let claude = o.claudeDir ? path.resolve(o.claudeDir) : null;
  const antigravity = (o.antigravityDirs || []).map((p) => path.resolve(p));
  const repos = (o.repos || []).map((p) => path.resolve(p));

  if (discover) {
    recycle.push(...discoverRecycleRoots());
    history.push(...discoverHistoryRoots());
    if (!claude) claude = discoverClaudeDir();
    antigravity.push(...discoverAntigravityDirs());
    if (!repos.length) repos.push(process.cwd());
  }

  // Newer sources find their own places. Their entries are kept as given, since some are
  // more than a folder (a snapshot and the drive it belongs to, say); each source reads its own.
  const own = {};
  const ids = new Set([...Object.keys(o.dirs || {}), ...Object.keys(o.discoverers || {})]);
  for (const id of ids) {
    const given = (o.dirs && o.dirs[id]) || [];
    let found = [];
    if (discover && o.discoverers && typeof o.discoverers[id] === 'function') {
      try {
        found = o.discoverers[id]() || [];
      } catch (_) {
        found = [];
      }
    }
    own[id] = dedupe([...given, ...found]);
  }

  return {
    recycle: dedupe(recycle),
    history: dedupeBy(history, (h) => h.dir),
    claude,
    antigravity: dedupe(antigravity),
    repos: dedupe(repos),
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

module.exports = { resolveLocations };
