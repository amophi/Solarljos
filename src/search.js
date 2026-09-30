'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');
const { compile, under } = require('./match');
const { resolveLocations } = require('./locations');
const { pathKey, isWindowsPath, absoluteFolder } = require('./paths');
const { HASH_LIMIT, blobHash, load, head, asText } = require('./content');
const { better, isDerived, isInexact, isUnverified } = require('./quality');
const { SNIFF_BYTES, parseTypes, typeOfExt, typesOfName, sniff } = require('./types');

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
  source('./sources/thumbcache', 'thumbcache'),
  source('./sources/snips', 'snips'),
  source('./sources/removable', 'removable'),
  source('./sources/vss', 'vss'),
];

// A source can look for its own places (`discover`), and can ask to run after the others
// (`followUp`) to look where they found something -- a shadow copy is searched folder by
// folder, never whole. One that keeps nothing but text says so with `media: false`, and a search
// for pictures or videos leaves it out; one that reads disks directly says `needsAdmin`. One that
// reads a store other programs keep rewriting -- Explorer's thumbnail cache -- can take it into
// memory once with `freeze`, so that nothing written after that changes what it finds.
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
async function hashOf(c) {
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
  // Pieces of a disk are read only when their size says it is worth it.
  if (c.extent && c.size != null && c.size <= HASH_LIMIT) {
    try {
      return blobHash(await load(c, git));
    } catch (_) {
      return null;
    }
  }
  return null;
}

/** What a copy's first bytes say it is, or nulls when they cannot be read or say nothing known. */
async function sniffed(c) {
  try {
    const first = await head(c, git, SNIFF_BYTES);
    if (first) return sniff(first);
  } catch (_) {
    /* unreadable: what it is cannot be told */
  }
  return { mediaType: null, ext: null };
}

/**
 * The type a copy with a name is of, by its extension; for an extension of two meanings, such as
 * .mts, the one its first bytes say, where they can be read without git -- every TypeScript file
 * in a repository's history is not worth a read -- or where `always`, and the usual one otherwise.
 */
async function typeByName(c, name, always) {
  const [usual, other] = typesOfName(name);
  if (!other || !(always || c.buffer || typeof c.text === 'string' || c.file || c.extent)) return usual || null;
  if (c.gitBlob && !c.buffer && (c.size || 0) > HASH_LIMIT) return usual;
  const got = (await sniffed(c)).mediaType;
  return got === other ? other : usual;
}

/**
 * Only the copies of the types asked for. A copy with a name is one when its name's extension
 * is of one of them -- or, for one in a format of its own such as a thumbnail, when that format
 * is. One whose name was lost is one when the type its source gave it says so, or else its first
 * bytes (types.js), and it is given the type and, when it has none, the extension they name. What
 * cannot be read to tell is left out.
 *
 * A name of two meanings, such as .mts, is read to tell only when the answer decides: when the
 * other meaning is asked for and the usual one is not. With the usual one asked for, the bytes
 * are looked at where that is cheap, so that a camcorder's clip in the Recycle Bin is not taken
 * for text, but not in git, where a TypeScript project's history would all be read. A smaller
 * copy's bytes are of its own format and say nothing about its name, so it passes for either.
 * `stop` is called before each copy, to throw when the search is to end; `signal`, the search's,
 * ends the git programs that read the copies to tell.
 */
async function keepTypes(list, types, stop = () => {}, signal = null) {
  const wanted = new Set(types);
  const mustRead = (c) => {
    const name = c.path || c.name;
    if (!name) return true;
    const [usual, other] = typesOfName(name);
    return !!other && !isDerived(c) && wanted.has(other) && !wanted.has(usual);
  };
  // Git objects to be told by their bytes are read in one call per repository, not one each.
  await git.preload(list.filter((c) => !c.isDir && !c.gone && mustRead(c)), signal);
  const kept = [];
  for (const c of list) {
    stop();
    if (c.isDir) continue;
    const name = c.path || c.name;
    if (name) {
      if (wanted.has(typeOfExt(c.ext)) || wanted.has(c.mediaType)) {
        kept.push(c);
        continue;
      }
      const [usual, other] = typesOfName(name);
      if (!wanted.has(usual) && !wanted.has(other)) continue;
      if (!other || isDerived(c)) {
        kept.push(c);
        continue;
      }
      const type = await typeByName(c, name, mustRead(c));
      if (wanted.has(type)) kept.push(type === usual ? c : { ...c, mediaType: type });
      continue;
    }
    if (c.gone || (c.gitBlob && !c.buffer && (c.size || 0) > HASH_LIMIT)) continue;
    const got = await sniffed(c);
    // A type the source gave comes from a closer look than the first 4 KB: carving walks an MP4's
    // tracks, and one with sound alone is audio, where its brand alone says video.
    const mediaType = c.mediaType || got.mediaType || null;
    if (!wanted.has(mediaType)) continue;
    kept.push({ ...c, mediaType, ...(c.ext || !got.ext ? {} : { ext: got.ext }) });
  }
  return kept;
}

/**
 * What kind of thing a result is (types.js), as `mediaType`: the type its source gave, or that
 * of the format it is in, or that of its name's extension. A copy in a format of its own -- a
 * thumbnail of a video is a picture -- and one with no name are told by their first bytes when
 * they are at hand, and then get the extension of that format too, to be restored under. It is
 * null for a folder and for what cannot be told without reading more.
 */
async function describeMedia(c) {
  if (c.isDir) {
    c.mediaType = null;
    return;
  }
  const name = c.path || c.name || null;
  const own = !name || isDerived(c);
  let type = c.mediaType || typeOfExt(c.ext) || (own ? null : await typeByName(c, name, false));
  const first = c.buffer || (typeof c.text === 'string' ? Buffer.from(c.text.slice(0, SNIFF_BYTES), 'utf8') : null);
  if (first && (!type || (own && !c.ext))) {
    const got = sniff(first);
    type = type || got.mediaType;
    if (own && !c.ext && got.ext) c.ext = got.ext;
  }
  c.mediaType = type || null;
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
 * every copy of it is. The same goes for `inexact`, and for `unverified`: a carved file whose
 * bytes are also found whole is whole. And for `derived`, though a smaller copy and the file
 * never have the same bytes. A kind can be one of these without the flag -- 'carved' always
 * is unverified -- so each copy is asked as tier() asks it, and all of them at once: an undelete
 * flagged unverified and a carve of the same bytes are unverified together, whichever of them
 * represents the two.
 *
 * A nameless copy dropped for the same bytes under a name counts as a copy of that named one: it
 * is added to its `copies` and `seen`, and the flags are asked of both as above -- an undelete
 * that may be incomplete is whole when the same bytes were also found whole with no name.
 */
function dedupe(list) {
  const groups = new Map();
  for (const c of list) {
    const key = dedupeKey(c);
    if (groups.has(key)) groups.get(key).push(c);
    else groups.set(key, [c]);
  }
  const out = [];
  for (const [key, group] of groups) {
    const best = group.reduce((a, c) => (better(c, a) ? c : a));
    const seen = [...new Set(group.map((c) => c.kind))];
    if (group.length === 1) {
      out.push({ ...best, key, copies: 1, seen });
      continue;
    }
    const every = (is) => group.every((c) => is(c));
    out.push({
      ...best, key, copies: group.length, seen,
      draft: every((c) => !!c.draft), inexact: every(isInexact), unverified: every(isUnverified), derived: every(isDerived),
    });
  }
  const named = new Map();
  for (const c of out) {
    if (!c.path || !c.hash) continue;
    if (named.has(c.hash)) named.get(c.hash).push(c);
    else named.set(c.hash, [c]);
  }
  const kept = [];
  for (const c of out) {
    const same = !c.path && c.hash ? named.get(c.hash) : null;
    if (!same) {
      kept.push(c);
      continue;
    }
    for (const n of same) {
      n.copies += c.copies;
      n.seen = [...new Set([...n.seen, ...c.seen])];
      n.draft = !!n.draft && !!c.draft;
      n.inexact = isInexact(n) && isInexact(c);
      n.unverified = isUnverified(n) && isUnverified(c);
      n.derived = isDerived(n) && isDerived(c);
    }
  }
  return kept;
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
 * @param {string} [o.pattern]       name or path pattern; may be empty when `containing` or `types` is set
 * @param {string} [o.under]         instead of a pattern: everything below this folder
 * @param {string} [o.containing]    only copies whose text contains this, any case
 * @param {string[]} [o.types]       only copies of these types (types.js TYPES): a copy with a name
 *   by its extension, one without by its first bytes. With no name to go on, copies whose name
 *   was lost are offered too. Without 'text' and 'document', the sources that keep only text
 *   are not searched, and say so.
 * @param {string[]} [o.sources]     source ids to search; all by default
 * @param {boolean} [o.deletedOnly]  only copies whose original path is gone
 * @param {number} [o.since]         only copies from this time (ms) on. A copy that carries no
 *   time -- a thumbnail, say -- is kept, since how old it is cannot be told, and counted in `notes`
 * @param {object} [o.locations]     passed to resolveLocations
 * @param {function} [o.onProgress]  called with events as the search goes, for a front end
 *   to show: { type: 'source-start', id, label }, { type: 'source-progress', id, done, total },
 *   { type: 'source-done', id, label, count, error?, skipped? }, { type: 'filtering' },
 *   { type: 'done', count }. A source left out for the types asked for has only 'source-done',
 *   with `skipped: true`.
 * @param {AbortSignal} [o.signal]   a front end's way to stop a search it no longer wants: once it
 *   fires, the search stops before its next step -- the next source, the next copy looked into --
 *   and rejects with the signal's reason. Sources see it as ctx.signal.
 * @returns {Promise<{ results: object[], perSource: object[], locations: object, stats: object, notes: string[] }>}
 *   `notes` says what applies to the whole search rather than to one source
 */
async function search(o) {
  const report = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const signal = o.signal || null;
  const stop = () => signal && signal.throwIfAborted();
  const types = parseTypes(o.types);
  const matcher = o.under ? under(absoluteFolder(o.under), { types }) : compile(o.pattern, { types });
  const containing = o.containing ? String(o.containing).toLowerCase() : null;
  const ctx = {
    matcher,
    containing,
    // The types asked for, or null: a source can leave out early what cannot be one of them.
    types,
    // With no name to go on, copies whose name was lost are worth offering: by what they
    // contain, or by what their bytes say they are.
    unnamed: matcher.everything && (!!containing || !!types),
    locations: locate(o.locations || {}),
    notes: [],
    stats: {},
    progress: () => {},
    prior: [],
    signal,
  };
  const notes = [];

  const selected = selectSources(o.sources);
  const sources = [...selected.filter((s) => !s.followUp), ...selected.filter((s) => s.followUp)];
  // A search for pictures, videos, sound or archives has nothing to find where only text is kept.
  const textless = !!types && !types.includes('text') && !types.includes('document');
  const perSource = [];
  let all = [];
  for (const s of sources) {
    stop();
    if (textless && s.media === false) {
      const said = t('Not searched: it keeps only text, and the search is for {0}.', types.join(', '));
      perSource.push({ id: s.id, label: s.label, count: 0, skipped: true, notes: [said] });
      report({ type: 'source-done', id: s.id, label: s.label, count: 0, skipped: true });
      continue;
    }
    const notesBefore = ctx.notes.length;
    // A follow-up source sees what the others found, to know where to look.
    if (s.followUp) ctx.prior = all.slice();
    report({ type: 'source-start', id: s.id, label: s.label });
    // Sources that go through many files say how far they are; the rest just start and finish.
    // A stopped search ends there, at the next file of the source it is in, not after all of them.
    ctx.progress = (done, total) => {
      stop();
      report({ type: 'source-progress', id: s.id, done, total });
    };
    try {
      const found = await s.scan(ctx);
      all = all.concat(found);
      perSource.push({ id: s.id, label: s.label, count: found.length, notes: ctx.notes.slice(notesBefore) });
      report({ type: 'source-done', id: s.id, label: s.label, count: found.length });
    } catch (e) {
      // Stopped: the search ends, rather than the source being counted as failed.
      if (signal && signal.aborted) throw signal.reason;
      perSource.push({ id: s.id, label: s.label, count: 0, error: e.message, notes: ctx.notes.slice(notesBefore) });
      report({ type: 'source-done', id: s.id, label: s.label, count: 0, error: e.message });
    }
  }
  ctx.progress = () => {};
  stop();
  report({ type: 'filtering' });

  if (containing) {
    await git.preload(all, signal);
    const kept = [];
    for (const c of all) {
      stop();
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
  if (types) all = await keepTypes(all, types, stop, signal);

  for (const c of all) {
    stop();
    c.hash = await hashOf(c);
  }
  let results = dedupe(all);
  const stateOf = stateChecker();
  for (const c of results) {
    stop();
    c.state = stateOf(c);
    c.id = idOf(c.key);
    await describeMedia(c);
  }
  if (o.deletedOnly) results = results.filter((c) => c.state === 'deleted');
  if (o.since) {
    // Thumbnails and carved files often carry no time at all. Leaving them out would hide what
    // may be the only copy of an old photo behind a date it may well be from; they are kept, and
    // counted, so the list can say why they are there.
    const undated = results.filter((c) => c.time == null).length;
    results = results.filter((c) => c.time == null || c.time >= o.since);
    if (undated) notes.push(t('{0} copy(ies) carry no date; they were kept, since how old they are cannot be told', undated));
  }

  results.sort((a, b) =>
    (b.time == null ? -Infinity : b.time) - (a.time == null ? -Infinity : a.time)
    || (a.path || '').localeCompare(b.path || '')
    || a.kind.localeCompare(b.kind)
    || a.id.localeCompare(b.id));

  report({ type: 'done', count: results.length });
  return { results, perSource, locations: ctx.locations, stats: ctx.stats, notes };
}

/**
 * Every folder a source reads from, and every volume a source reads directly that names no folder
 * -- a card given as a whole disk -- as { volume, label } (restore.js). Restoring onto one of them
 * is refused.
 */
async function sourceRoots(locations) {
  const roots = [];
  for (const s of SOURCES) {
    roots.push(...s.roots(locations));
    if (typeof s.volumes === 'function') {
      try {
        roots.push(...s.volumes(locations));
      } catch (_) {
        /* its folders still stand */
      }
    }
  }
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

/**
 * Has each selected source that reads a store other programs keep rewriting take it into memory
 * now. Explorer adds to its thumbnail cache whenever it shows a picture -- one just restored, in
 * a folder opened to look at it, among them -- and may drop older ones to make room; after this,
 * searches read what was there at this moment. Nothing is written.
 * @returns {Promise<{ id: string, label: string, error?: string }[]>} the sources that took theirs
 */
async function freezeAll(o = {}) {
  const locations = locate(o.locations || {});
  const out = [];
  for (const s of selectSources(o.sources)) {
    if (typeof s.freeze !== 'function') continue;
    try {
      await s.freeze(locations);
      out.push({ id: s.id, label: s.label });
    } catch (e) {
      out.push({ id: s.id, label: s.label, error: e.message });
    }
  }
  return out;
}

module.exports = {
  search, sourceRoots, describeAll, freezeAll, locate, git, SOURCES,
  _internal: { dedupe, source, mountOf, onNetwork, keepTypes, describeMedia },
};
