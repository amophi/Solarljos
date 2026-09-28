'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { compile, under } = require('./match');
const { resolveLocations } = require('./locations');
const { pathKey, isWindowsPath } = require('./paths');
const { HASH_LIMIT, blobHash, load, asText } = require('./content');

/**
 * A source that cannot even be loaded -- a bug in one module -- should cost that one source,
 * not the whole search. It stays listed, and says why it found nothing.
 */
function source(file) {
  try {
    return require(file);
  } catch (e) {
    const id = file.replace(/^.*\//, '');
    return {
      id, label: id, broken: e.message,
      scan: async () => { throw new Error(`could not be loaded: ${e.message.split('\n')[0]}`); },
      describe: () => [`Could not be loaded: ${e.message.split('\n')[0]}`],
      roots: (loc) => loc[id] || [],
    };
  }
}

const git = require('./sources/git');
const SOURCES = [
  source('./sources/recycle-bin'),
  source('./sources/editor-history'),
  source('./sources/claude-code'),
  source('./sources/antigravity'),
  git,
  source('./sources/jetbrains'),
  source('./sources/eclipse-history'),
  source('./sources/notepad'),
  source('./sources/editor-backups'),
  source('./sources/hancom'),
  source('./sources/trash'),
  source('./sources/vss'),
];

// A source can look for its own places (`discover`), and can ask to run after the others
// (`followUp`) to look where they found something -- a shadow copy is searched folder by
// folder, never whole.
const DISCOVERERS = Object.fromEntries(
  SOURCES.filter((s) => typeof s.discover === 'function').map((s) => [s.id, s.discover]));

/** Every source's places, the ones given and, unless turned off, the ones found here. */
function locate(o = {}) {
  return resolveLocations({ ...o, discoverers: DISCOVERERS });
}

function selectSources(ids) {
  if (!ids || !ids.length) return SOURCES;
  const wanted = new Set(ids);
  const unknown = [...wanted].filter((id) => !SOURCES.some((s) => s.id === id));
  if (unknown.length) {
    const e = new Error(`Unknown source: ${unknown.join(', ')}. Known: ${SOURCES.map((s) => s.id).join(', ')}`);
    e.usage = true;
    throw e;
  }
  return SOURCES.filter((s) => wanted.has(s.id));
}

/** Reads what is needed to hash a copy, unless it is too big to be worth it. */
function hashOf(c) {
  if (c.hash !== undefined && c.hash !== null) return c.hash;
  if (c.isDir || c.gone) return null;
  if (c.buffer) return blobHash(c.buffer);
  if (typeof c.text === 'string') return blobHash(Buffer.from(c.text, 'utf8'));
  if (c.file && (c.size == null || c.size <= HASH_LIMIT)) {
    try {
      return blobHash(fs.readFileSync(c.file));
    } catch (_) {
      return null;
    }
  }
  return null;
}

function dedupeKey(c) {
  return c.hash ? pathKey(c.path || '') + '\0' + c.hash : 'at\0' + pathKey(c.origin || '') + '\0' + pathKey(c.path || '');
}

/**
 * The same content under the same name is one result, however many places hold it; the
 * newest sighting represents it. A copy whose name is lost is dropped when the same content
 * was also found under a name.
 *
 * `draft` marks text that was never saved -- an editor's unsaved buffer, say. The same bytes
 * found anywhere else prove they were saved once, so a merged result is a draft only when
 * every copy of it is.
 */
function dedupe(list) {
  const byKey = new Map();
  for (const c of list) {
    const key = dedupeKey(c);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...c, key, copies: 1, seen: [c.kind] });
      continue;
    }
    const seen = prev.seen.includes(c.kind) ? prev.seen : [...prev.seen, c.kind];
    const merged = (c.time || 0) > (prev.time || 0) ? { ...c, key } : prev;
    byKey.set(key, { ...merged, copies: prev.copies + 1, seen, draft: !!(prev.draft && c.draft) });
  }
  const named = new Set();
  for (const c of byKey.values()) if (c.path && c.hash) named.add(c.hash);
  return [...byKey.values()].filter((c) => c.path || !c.hash || !named.has(c.hash));
}

/**
 * Whether a path can be looked up on this machine at all. A path from another kind of system
 * cannot: on Windows /home/a would be read as C:\home\a, and on Linux C:\a as a relative name.
 */
function checkable(p) {
  return process.platform === 'win32' ? isWindowsPath(p) : p.startsWith('/');
}

function stateOf(c) {
  if (c.gone) return 'no content';
  if (!c.path) return '';
  if (!checkable(c.path)) return '';
  try {
    fs.statSync(c.path);
    return 'exists';
  } catch (_) {
    return 'deleted';
  }
}

function idOf(key) {
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
}

/**
 * @param {object} o
 * @param {string} [o.pattern]       name or path pattern; may be empty when `containing` is set
 * @param {string} [o.under]         instead of a pattern: everything below this folder
 * @param {string} [o.containing]    only copies whose text contains this, any case
 * @param {string[]} [o.sources]     source ids to search; all by default
 * @param {boolean} [o.deletedOnly]  only copies whose original path is gone
 * @param {number} [o.since]         only copies from this time (ms) on
 * @param {object} [o.locations]     passed to resolveLocations
 * @param {function} [o.onProgress]  called with events as the search goes, for a front end
 *   to show: { type: 'source-start', id, label }, { type: 'source-progress', id, done, total },
 *   { type: 'source-done', id, label, count, error? }, { type: 'filtering' }, { type: 'done', count }
 */
async function search(o) {
  const report = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const matcher = o.under ? under(o.under) : compile(o.pattern);
  const containing = o.containing ? String(o.containing).toLowerCase() : null;
  const ctx = {
    matcher,
    containing,
    // With no name to go on, copies whose name was lost are worth offering.
    unnamed: !!containing && matcher.everything,
    locations: locate(o.locations || {}),
    notes: [],
    stats: {},
    progress: () => {},
    prior: [],
  };

  const selected = selectSources(o.sources);
  const sources = [...selected.filter((s) => !s.followUp), ...selected.filter((s) => s.followUp)];
  const perSource = [];
  let all = [];
  for (const s of sources) {
    const notesBefore = ctx.notes.length;
    // A follow-up source sees what the others found, to know where to look.
    if (s.followUp) ctx.prior = all.slice();
    report({ type: 'source-start', id: s.id, label: s.label });
    // Sources that go through many files say how far they are; the rest just start and finish.
    ctx.progress = (done, total) => report({ type: 'source-progress', id: s.id, done, total });
    try {
      const found = await s.scan(ctx);
      all = all.concat(found);
      perSource.push({ id: s.id, label: s.label, count: found.length, notes: ctx.notes.slice(notesBefore) });
      report({ type: 'source-done', id: s.id, label: s.label, count: found.length });
    } catch (e) {
      perSource.push({ id: s.id, label: s.label, count: 0, error: e.message, notes: ctx.notes.slice(notesBefore) });
      report({ type: 'source-done', id: s.id, label: s.label, count: 0, error: e.message });
    }
  }
  ctx.progress = () => {};
  report({ type: 'filtering' });

  if (containing) {
    await git.preload(all);
    const kept = [];
    for (const c of all) {
      if (c.isDir || c.gone || (c.size || 0) > HASH_LIMIT) continue;
      try {
        const buf = await load(c, git);
        if (asText(buf).toLowerCase().includes(containing)) kept.push({ ...c, buffer: buf });
      } catch (_) {
        /* unreadable: not a match */
      }
    }
    all = kept;
  }

  for (const c of all) c.hash = hashOf(c);
  let results = dedupe(all);
  for (const c of results) {
    c.state = stateOf(c);
    c.id = idOf(c.key);
  }
  if (o.deletedOnly) results = results.filter((c) => c.state === 'deleted');
  if (o.since) results = results.filter((c) => c.time != null && c.time >= o.since);

  results.sort((a, b) =>
    (b.time == null ? -Infinity : b.time) - (a.time == null ? -Infinity : a.time)
    || (a.path || '').localeCompare(b.path || '')
    || a.kind.localeCompare(b.kind)
    || a.id.localeCompare(b.id));

  report({ type: 'done', count: results.length });
  return { results, perSource, locations: ctx.locations, stats: ctx.stats };
}

/** Every folder a source reads from. Restoring into one of them is refused. */
async function sourceRoots(locations) {
  const roots = [];
  for (const s of SOURCES) roots.push(...s.roots(locations));
  roots.push(...(await git.gitDirs(locations)));
  return roots;
}

async function describeAll(o) {
  const locations = locate(o.locations || {});
  const ctx = { locations, notes: [] };
  const out = [];
  for (const s of selectSources(o.sources)) out.push({ id: s.id, label: s.label, lines: await s.describe(ctx) });
  return out;
}

module.exports = { search, sourceRoots, describeAll, locate, git, SOURCES, _internal: { dedupe } };
