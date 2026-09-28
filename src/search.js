'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');
const { compile, under } = require('./match');
const { resolveLocations } = require('./locations');
const { pathKey, isWindowsPath, absoluteFolder } = require('./paths');
const { HASH_LIMIT, blobHash, load, asText } = require('./content');
const { better } = require('./quality');

/**
 * A source that cannot even be loaded -- a bug in one module -- should cost that one source,
 * not the whole search. It stays listed under its own id, so --source and --location still know
 * it, says why it found nothing, and its places are still kept from being written into.
 */
function source(file, id) {
  try {
    return require(file);
  } catch (e) {
    return {
      id, label: id, broken: e.message,
      scan: async () => { throw new Error(t('could not be loaded: {0}', e.message.split('\n')[0])); },
      describe: () => [t('Could not be loaded: {0}', e.message.split('\n')[0])],
      roots: (loc) => [].concat(loc[id] || []).map((x) => (x && x.dir) || x).filter((x) => typeof x === 'string'),
    };
  }
}

const git = require('./sources/git');
const SOURCES = [
  source('./sources/recycle-bin', 'recycle'),
  source('./sources/editor-history', 'history'),
  source('./sources/claude-code', 'claude'),
  source('./sources/antigravity', 'antigravity'),
  git,
  source('./sources/jetbrains', 'jetbrains'),
  source('./sources/eclipse-history', 'eclipse-history'),
  source('./sources/notepad', 'notepad'),
  source('./sources/editor-backups', 'editor-backups'),
  source('./sources/hancom', 'hancom'),
  source('./sources/trash', 'trash'),
  source('./sources/vss', 'vss'),
];

// A source can look for its own places (`discover`), and can ask to run after the others
// (`followUp`) to look where they found something -- a shadow copy is searched folder by
// folder, never whole.
const DISCOVERERS = Object.fromEntries(
  SOURCES.filter((s) => typeof s.discover === 'function').map((s) => [s.id, s.discover]));

function usageError(message) {
  const e = new Error(message);
  e.usage = true;
  return e;
}

/**
 * Every source's places, the ones given and, unless turned off, the ones found here. A place
 * for a source that does not exist -- a typo, "VSS", or a file name such as recycle-bin -- would
 * search nothing and say nothing, so it is refused. "repos" is the older name for git's places.
 */
function locate(o = {}) {
  const dirs = o.dirs || {};
  const known = [...SOURCES.map((s) => s.id), 'repos'];
  const unknown = Object.keys(dirs).filter((id) => !known.includes(id));
  if (unknown.length) {
    throw usageError(t('Unknown source in --location: {0}. Known: {1}', unknown.join(', '), known.join(', ')));
  }
  for (const id of Object.keys(dirs)) {
    if ([].concat(dirs[id] || []).some((p) => typeof p === 'string' && !p.trim())) {
      throw usageError(t('Give a place after {0}= in --location, for example notepad=D:\\old\\TabState.', id));
    }
  }
  return resolveLocations({ ...o, discoverers: DISCOVERERS });
}

function selectSources(ids) {
  if (!ids || !ids.length) return SOURCES;
  const wanted = new Set(ids);
  const unknown = [...wanted].filter((id) => !SOURCES.some((s) => s.id === id));
  if (unknown.length) {
    throw usageError(t('Unknown source: {0}. Known: {1}', unknown.join(', '), SOURCES.map((s) => s.id).join(', ')));
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
 * The same content under the same name is one result, however many places hold it. The
 * sighting that represents it is chosen as rebuild chooses between copies (quality.js): a saved
 * copy over a draft, then the newest. A copy whose name is lost is dropped when the same
 * content was also found under a name.
 *
 * `draft` marks text that was never saved -- an editor's unsaved buffer, say. The same bytes
 * found anywhere else prove they were saved once, so a merged result is a draft only when
 * every copy of it is. The same goes for `inexact`.
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
    const merged = better(c, prev) ? { ...c, key } : prev;
    byKey.set(key, {
      ...merged, copies: prev.copies + 1, seen,
      draft: !!(prev.draft && c.draft), inexact: !!(prev.inexact && c.inexact),
    });
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
  if (process.platform === 'win32') return isWindowsPath(p);
  return p.startsWith('/');
}

// A path on a network share is not looked up either: a share that is down makes every look at a
// file on it wait for the network to give up, once for every copy found there. Its state is left
// unknown. What counts as one, without running anything to ask:
//
//   Windows  a \\server\share path, and a path on a drive letter mapped to a share, whose root
//            resolves to \\server\share. Each drive letter is asked once per search, at its root;
//            one that does not answer at all -- a share that is down, a disk not plugged in --
//            leaves its paths unknown too, since whether a file is gone cannot be told there.
//   Linux    a path on a network mount, by its type in /proc/self/mounts, read once per search:
//            NFS, SMB, AFS, Ceph and the like, 9p over the network, a disk served by NBD or Ceph,
//            the FUSE clients of a network (sshfs, rclone, gvfs's shares, ...) and a FUSE mount
//            that does not name its daemon, as davfs2 does not. Other FUSE mounts are looked up:
//            an encrypted home (gocryptfs, encfs) or a pooled disk (mergerfs) is local, and
//            leaving it out would leave every copy in it unknown. A path reached through a link
//            onto a network mount is not recognised: telling would mean resolving the link, which
//            is the wait.
//   macOS    every path is looked up: nothing tells a network mount from a local one there
//            without asking the mount itself.
const NET_FS = new RegExp('^(nfs4?|cifs|smb3|smbfs|ncpfs|afs|ceph|glusterfs|lustre|gpfs|fuse'
  + '|fuse\\.(sshfs|rclone|s3fs|gcsfuse|goofys|juicefs|ceph-fuse|glusterfs|gvfsd-fuse|davfs2?|blobfuse2?|onedriver|curlftpfs))$');

/** /proc/self/mounts, as trash.js reads it: a Map of mount point to mount, the last one at a point on top. */
function linuxMounts() {
  const out = new Map();
  let text;
  try {
    text = fs.readFileSync('/proc/self/mounts', 'latin1');
  } catch (_) {
    return out;
  }
  // \040-style escapes stand for bytes; the bytes together are UTF-8.
  const unescape = (s) => Buffer.from(s.replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8))), 'latin1').toString('utf8');
  for (const line of text.split('\n')) {
    const f = line.split(' ');
    if (f.length >= 3) out.set(unescape(f[1]), { source: unescape(f[0]), fstype: f[2], options: f[3] || '' });
  }
  return out;
}

/** The mount a POSIX path lies on: the nearest folder above it, or itself, that is a mount point. */
function mountOf(p, mounts) {
  for (let at = p; ; at = path.posix.dirname(at)) {
    if (mounts.has(at)) return mounts.get(at);
    if (at === path.posix.dirname(at)) return null;
  }
}

/** Whether a Linux mount is one of the network kinds above. */
function onNetwork(m) {
  if (NET_FS.test(m.fstype)) return true;
  if (m.fstype === '9p') return /(^|,)trans=(tcp|rdma)(,|$)/.test(m.options);
  return /^\/dev\/(nbd|rbd)\d/.test(m.source);
}

/** Tells, for one search, each copy's state: whether its original path exists, is gone, or cannot be told. */
function stateChecker() {
  const drives = new Map();
  let mounts = null;
  const unreachable = (p) => {
    if (p.startsWith('\\\\')) return true;
    if (process.platform === 'win32') {
      const letter = p[0].toUpperCase();
      if (!drives.has(letter)) {
        let local = false;
        try {
          local = !fs.realpathSync.native(letter + ':\\').startsWith('\\\\');
        } catch (_) {
          local = false;
        }
        drives.set(letter, local);
      }
      return !drives.get(letter);
    }
    if (process.platform === 'linux') {
      if (!mounts) mounts = linuxMounts();
      const m = mountOf(p, mounts);
      return !!m && onNetwork(m);
    }
    return false;
  };
  return (c) => {
    if (c.gone) return 'no content';
    if (!c.path || !checkable(c.path) || unreachable(c.path)) return '';
    try {
      fs.statSync(c.path);
      return 'exists';
    } catch (_) {
      return 'deleted';
    }
  };
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
  const matcher = o.under ? under(absoluteFolder(o.under)) : compile(o.pattern);
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
  const stateOf = stateChecker();
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

module.exports = { search, sourceRoots, describeAll, locate, git, SOURCES, _internal: { dedupe, source, mountOf, onNetwork } };
