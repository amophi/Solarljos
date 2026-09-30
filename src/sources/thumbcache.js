'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { t } = require('../i18n');
const fmt = require('../format');
const { pathKey, isWindowsPath } = require('../paths');
const { blobHash } = require('../content');
const tc = require('../lib/thumbcache');
const sl = require('../lib/shelllink');
const vss = require('./vss');

// Explorer's thumbnail cache: the smaller pictures Windows made of files that Explorer or a file
// dialog once showed as thumbnails, kept long after the files are gone. Each is a smaller,
// re-encoded copy -- never the file itself (quality.js, tier 4) -- with no name, no path and no
// time of its own (src/lib/thumbcache.js has the format):
//
//   %LOCALAPPDATA%\Microsoft\Windows\Explorer\thumbcache_<size>.db     the pictures
//   %APPDATA%\Microsoft\Windows\Recent\*.lnk, AutomaticDestinations\,  shortcuts to what was
//     CustomDestinations\                                             opened, to name them
//
// A place is either folder, or any folder on the way down to them from a user profile -- which is
// how a profile on a disk from another machine is given. iconcache_*.db, in the same format, holds
// programs' icons and is never read.
//
// What is offered: every picture that passes both CRC-64s and its own structure checks, one per
// item -- the largest the cache holds of it, in its own format (JPEG, PNG, or a 32-bit BMP), with
// its width, height and extension. An entry keyed by something other than a file -- a phone or
// camera seen over MTP, a drive, an app -- is left out, as is anything that is not a picture.
//
// Naming. The key of each picture is the file's ThumbnailCacheId, a hash of its volume's GUID, its
// file ID, its extension and its last write (src/lib/shelllink.js). A shortcut records the last
// three, and the volume's GUID is one of those mountvol.exe lists (it only lists; it writes
// nothing), or one given as volume={...}. A picture whose key a shortcut hashes to is that file as
// it was at the shortcut's write time: named 'thumbnail', with that path and that time, which the
// 64-bit match proves. An entry keyed "Windows?<volume serial>?<file ID>" holds no time; one whose
// file ID and volume a shortcut records is named too, but its time stays unknown -- the picture
// may be of an older or a newer version than the shortcut saw. Every other picture is 'thumbnail,
// name unknown', and is offered only in a search by type for pictures: a name search finds only
// named ones. Shortcuts that lead to no picture are never listed -- a list of the names of files
// someone opened and deleted, with nothing of them to give back, is not what a search is for.
//
// Unnamed is not deleted: a file written to since its thumbnail was made has another key, as has
// one on a drive not attached now, and the shortcuts Windows keeps are few. So nothing is said of
// whether an unnamed picture's file still exists.
//
// The cache is a live store. Explorer adds to it whenever it shows a picture -- one just restored,
// in a folder opened to look at it -- and may drop older ones to make room; Disk Cleanup and
// Storage Sense can empty it. freeze() reads the cache files and the shortcut folders into memory
// once, and every scan after that reads those bytes instead. The same folders inside each readable
// shadow copy (the vss source's places) are read too, since a snapshot can hold what the live
// cache has since lost; they do not change, so they are read at each scan.
//
// Measured on this machine (Windows 11 26200), read-only, counting only: the live cache's 14 files
// held 813 pictures that pass every check, and the same folder in two shadow copies 781 and 805,
// with 4 entries torn in one of them. Together that is 646 items, each once, none of them only in
// a snapshot. By the long side of the largest picture of each: 18 of 1,024 pixels or more, 78 of
// 256 to 1,023, 1 between 97 and 255, 457 of 48 to 96 and 92 smaller; 549 BMPs, 71 JPEGs and 26
// PNGs, each of which sniff() takes for its own format. 600 shortcuts and 226 jump lists, live and
// in the snapshots, named 29 of them with a path and a time the key proves -- 22 through jump
// lists, 5 through custom ones, 2 through shortcuts -- and 13 of those 29 paths are not there now.
// None of the 27 pictures keyed by a file ID had a shortcut with that ID. The other 617 have no
// name, and are 246 different pictures: many items share one, byte for byte, and a search lists
// each once. Reading and parsing the live folders took about 0.1 s, 0.25 s with the snapshots;
// asking mountvol, 20 ms. The pictures offered come to 9 MB in all.

const EXPLORER = ['Microsoft', 'Windows', 'Explorer'];
const RECENT = ['Microsoft', 'Windows', 'Recent'];
// Where each folder can lie below a place: in it, or on the way down from a profile.
const TO_EXPLORER = [[], ['Explorer'], ['Windows', 'Explorer'], EXPLORER, ['Local', ...EXPLORER], ['AppData', 'Local', ...EXPLORER]];
const TO_RECENT = [[], ['Recent'], ['Windows', 'Recent'], RECENT, ['Roaming', ...RECENT], ['AppData', 'Roaming', ...RECENT]];
const VOLUME = /^volume=/i;

// The files in a Recent folder that hold shortcuts, by where they lie below it.
const LISTS = [
  { sub: null, kind: 'shortcut', re: /\.lnk$/i },
  { sub: 'AutomaticDestinations', kind: 'jump list', re: /\.automaticdestinations-ms$/i },
  { sub: 'CustomDestinations', kind: 'custom list', re: /\.customdestinations-ms$/i },
];
// A jump list is a few hundred KB at most; anything far larger is not one.
const MAX_LIST_BYTES = 16 * 1024 * 1024;
// Opening without waiting, where there is such a flag, so that a pipe put in a file's place
// cannot hold the read up; a plain file reads the same.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);
const FORMAT_NAMES = { jpeg: 'JPEG', png: 'PNG', bmp: 'BMP' };

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

/** The names of the plain files in a folder: a link, pipe or folder under such a name is not read. */
function filesIn(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
  } catch (_) {
    return [];
  }
}

const holdsCache = (dir) => filesIn(dir).some((n) => tc.CACHE_FILE.test(n));
const isRecent = (dir) => isDir(dir) && (path.basename(dir).toLowerCase() === 'recent'
  || isDir(path.join(dir, 'AutomaticDestinations')) || isDir(path.join(dir, 'CustomDestinations')));

/**
 * The cache folders and Recent folders behind the places given, each once, and the volume GUIDs
 * given as volume={...}. A place that stands for neither is said in `notes`, so that a folder
 * given by hand and read as nothing is not taken for an empty cache.
 */
function foldersOf(loc, notes) {
  const caches = new Map();
  const recents = new Map();
  const guids = [];
  const places = [];
  for (const raw of [].concat(loc.thumbcache || [])) {
    if (typeof raw !== 'string') continue;
    if (VOLUME.test(raw)) {
      const guid = raw.slice(raw.indexOf('=') + 1).trim();
      if (sl.guidBytes(guid)) guids.push(guid.toLowerCase());
      else if (notes) notes.push(t('{0}: not a volume GUID such as volume={00112233-4455-6677-8899-aabbccddeeff}; skipped.', raw));
      continue;
    }
    const p = path.resolve(raw);
    const dirs = [];
    for (const segs of TO_EXPLORER) {
      const d = path.join(p, ...segs);
      if (holdsCache(d)) {
        caches.set(pathKey(d), d);
        dirs.push(d);
      }
    }
    for (const segs of TO_RECENT) {
      const d = path.join(p, ...segs);
      if (isRecent(d)) {
        recents.set(pathKey(d), d);
        dirs.push(d);
      }
    }
    places.push({ place: p, dirs });
    if (!dirs.length && notes) notes.push(t('{0}: no thumbnail cache or Recent folder there', raw));
  }
  return { caches: [...caches.values()], recents: [...recents.values()], guids: [...new Set(guids)], places };
}

/** A plain file's bytes, from one open. */
function readPlain(file, max) {
  const fd = fs.openSync(file, OPEN_FLAGS);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(t('not a plain file'));
    if (st.size > max) throw new Error(t('larger than {0} bytes', max));
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Every shortcut file of a Recent folder, read into memory: { dir, files: [{ file, kind, buffer }], errors }. */
function readRecent(dir) {
  const out = { dir, files: [], errors: [] };
  for (const list of LISTS) {
    const d = list.sub ? path.join(dir, list.sub) : dir;
    for (const name of filesIn(d)) {
      if (!list.re.test(name)) continue;
      const file = path.join(d, name);
      try {
        out.files.push({ file, kind: list.kind, buffer: readPlain(file, MAX_LIST_BYTES) });
      } catch (e) {
        out.errors.push({ file, error: e.code || e.message });
      }
    }
  }
  return out;
}

/** The volume GUIDs mountvol.exe lists. It only lists; it is given no argument that changes anything. */
function listVolumes() {
  if (process.platform !== 'win32') return [];
  try {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'mountvol.exe');
    const out = execFileSync(exe, [], { windowsHide: true, encoding: 'latin1', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
    return sl.volumesFromMountvol(out).map((v) => v.guid);
  } catch (_) {
    return [];
  }
}

// Stand-ins for tests: listing this machine's volumes is the one thing here that runs a program.
const hooks = { listVolumes };

// What freeze() took: each live folder's files, by pathKey, and when.
const frozen = { caches: new Map(), recents: new Map() };

/**
 * Reads the live cache folders and Recent folders behind the places into memory, now. Every scan
 * after this reads these bytes instead of the files, so what Explorer writes later -- a picture
 * restored and looked at, older ones dropped to make room -- changes nothing it finds. Called
 * again, it reads them again. Nothing is written.
 */
async function freeze(loc) {
  const { caches, recents } = foldersOf(loc, null);
  const at = Date.now();
  for (const dir of caches) frozen.caches.set(pathKey(dir), { at, read: tc.readCacheFolder(dir) });
  for (const dir of recents) frozen.recents.set(pathKey(dir), { at, read: readRecent(dir) });
  return { caches: caches.length, recents: recents.length };
}

/** A folder's files: as frozen, for a live folder that was, or read now. */
function cacheFiles(dir, live) {
  const f = live && frozen.caches.get(pathKey(dir));
  return f ? { read: f.read, at: f.at } : { read: tc.readCacheFolder(dir), at: null };
}

function recentFiles(dir, live) {
  const f = live && frozen.recents.get(pathKey(dir));
  return f ? { read: f.read, at: f.at } : { read: readRecent(dir), at: null };
}

/**
 * The same folders inside each shadow copy on their drive, reached as the vss source reaches any
 * folder: every link on the way followed by hand inside the snapshot, and none that leads out of
 * it. Gives [{ dir, snapshot, original }]; `outside` counts those skipped for leading out.
 */
function inSnapshots(snaps, dirs, skipped) {
  const { driveKeyOf, relBelowDrive, confine, snapDir } = vss._internal;
  const out = [];
  for (const snap of snaps) {
    for (const original of dirs) {
      if (!isWindowsPath(original) || driveKeyOf(original) !== snap.driveKey) continue;
      const where = confine(snap, relBelowDrive(original));
      if (where.out) skipped.outside++;
      else if (where.segs) out.push({ dir: snapDir(snap.root, where.segs), snapshot: snap.root, original });
    }
  }
  return out;
}

/** The shortcuts in one Recent folder's files: [{ link, kind, lastOpened, snapshot }], and counts. */
function linksOf(read, snapshot, stats) {
  const out = [];
  for (const f of read.files) {
    if (f.kind === 'shortcut') {
      stats.shortcuts++;
      const link = sl.parseLink(f.buffer);
      if (link) out.push({ link, kind: f.kind, lastOpened: null, snapshot });
    } else if (f.kind === 'jump list') {
      stats.jumpLists++;
      const list = sl.parseJumpList(f.buffer);
      for (const x of (list && list.links) || []) {
        if (x.link) out.push({ link: x.link, kind: f.kind, lastOpened: x.entry && x.entry.time, snapshot });
      }
    } else {
      stats.jumpLists++;
      const list = sl.parseCustomDestinations(f.buffer);
      for (const link of (list && list.links) || []) out.push({ link, kind: f.kind, lastOpened: null, snapshot });
    }
  }
  return out;
}

const hex8 = (n) => (n >>> 0).toString(16).padStart(8, '0');

/**
 * The shortcuts that can name a picture, by the key each hashes to under every volume GUID and
 * cache format in play, and by the volume serial and file ID each records. Only a file's shortcut
 * with a file ID and a name counts; a folder's key is made some other way.
 */
function nameIndex(records, guids, versions) {
  const byKey = new Map();
  const byFileId = new Map();
  const add = (map, key, r) => map.set(key, [...(map.get(key) || []), r]);
  for (const r of records) {
    const l = r.link;
    if (l.isDir || l.fileRef == null || !(l.path || l.name)) continue;
    if (l.serial != null) add(byFileId, `${hex8(l.serial)}:${l.fileRef.toString(16)}`, r);
    if (!l.writeTime) continue;
    const ext = sl.extensionOf(l.name || '');
    const keys = new Set();
    for (const volumeGuid of guids) {
      for (const v of versions) {
        let key = null;
        try {
          key = tc.cacheIdOf({ volumeGuid, fileId: l.fileRef, ext, filetime: l.writeTime }, v);
        } catch (_) {
          key = null;
        }
        if (key) keys.add(key);
      }
    }
    for (const key of keys) add(byKey, key, r);
  }
  return { byKey, byFileId };
}

/**
 * Of several shortcuts to one picture's file, the one to name it by: a live one before one in a
 * snapshot, one with a path before one with a name alone, then the one used last. A file moved on
 * its volume keeps its key, so they can give different paths; the others are counted.
 */
function pick(records) {
  const score = (r) => Math.max(r.lastOpened || 0, r.link.accessed || 0);
  const best = records.slice().sort((a, b) => (a.snapshot ? 1 : 0) - (b.snapshot ? 1 : 0)
    || (b.link.path ? 1 : 0) - (a.link.path ? 1 : 0)
    || score(b) - score(a))[0];
  const where = (r) => pathKey(r.link.path || r.link.name);
  const others = new Set(records.map(where).filter((k) => k !== where(best))).size;
  return { record: best, others };
}

/**
 * Everything the places give, read and parsed: one item per picture, the largest the cache folders
 * hold of it, each with the shortcut that names it, if any; and counts of what was left out.
 */
function gather(loc, notes, { signal, progress } = {}) {
  const stop = () => signal && signal.throwIfAborted();
  const { caches, recents, guids } = foldersOf(loc, notes);
  const stats = {
    files: 0, damaged: 0, notPictures: 0, problems: 0,
    shortcuts: 0, jumpLists: 0, outside: 0, snapshots: 0, frozenAt: null,
  };
  const folders = [];
  // Counted by key, as the same item is in each snapshot too.
  const devices = new Set();

  const vssPlaces = [].concat(loc.vss || []);
  const snaps = vssPlaces.length ? vss._internal.resolveSnapshots(vssPlaces, []) : [];
  const cacheSets = [
    ...caches.map((dir) => ({ dir, snapshot: null, original: dir })),
    ...inSnapshots(snaps, caches, stats),
  ];
  const recentSets = [
    ...recents.map((dir) => ({ dir, snapshot: null, original: dir })),
    ...inSnapshots(snaps, recents, stats),
  ];

  // One group per key: the largest picture, and where else the key was seen.
  const groups = new Map();
  const snapshotsRead = new Set();
  for (let i = 0; i < cacheSets.length; i++) {
    stop();
    if (progress) progress(i + 1, cacheSets.length);
    const set = cacheSets[i];
    const { read, at } = cacheFiles(set.dir, !set.snapshot);
    if (at && (!stats.frozenAt || at < stats.frozenAt)) stats.frozenAt = at;
    for (const e of read.errors) notes.push(t('Could not read {0} ({1})', e.file, e.error));
    if (set.snapshot && read.caches.length) snapshotsRead.add(set.snapshot);
    const folder = { dir: set.dir, snapshot: set.snapshot, kind: 'cache', files: read.caches.length, pictures: 0, damaged: 0, frozenAt: at };
    folders.push(folder);
    for (const file of read.caches) {
      stats.files++;
      const cache = tc.parseCache(file.buffer);
      if (!cache) continue;
      stats.problems += cache.problems.filter((p) => p.why !== 'file header').length;
      for (const e of cache.entries) {
        if (e.free || !e.dataSize) continue;
        // A failed header checksum leaves the key and the identifier unproven too.
        if (!e.checks.header || !e.checks.data) {
          stats.damaged++;
          folder.damaged++;
          continue;
        }
        const id = tc.parseIdentifier(e.identifier, e.hash);
        if (id.kind === 'shell' || id.kind === 'other') {
          devices.add(e.hash);
          continue;
        }
        if (!e.ok) {
          if (e.image && e.image.why === 'format') {
            stats.notPictures++;
          } else {
            stats.damaged++;
            folder.damaged++;
          }
          continue;
        }
        folder.pictures++;
        const g = groups.get(e.hash);
        const area = e.image.width * e.image.height;
        if (!g) {
          groups.set(e.hash, { e, id, file: file.file, snapshot: set.snapshot, area, live: !set.snapshot });
        } else {
          if (!set.snapshot) g.live = true;
          if (area > g.area) Object.assign(g, { e, id, file: file.file, snapshot: set.snapshot, area });
        }
      }
    }
  }
  stats.snapshots = snapshotsRead.size;
  stats.devices = devices.size;

  const records = [];
  for (const set of recentSets) {
    stop();
    const { read, at } = recentFiles(set.dir, !set.snapshot);
    for (const e of read.errors) notes.push(t('Could not read {0} ({1})', e.file, e.error));
    const before = stats.shortcuts + stats.jumpLists;
    records.push(...linksOf(read, set.snapshot, stats));
    folders.push({ dir: set.dir, snapshot: set.snapshot, kind: 'recent', files: stats.shortcuts + stats.jumpLists - before, frozenAt: at });
  }

  // The volume GUIDs are asked for only when there is something to hash with them.
  const hashable = records.some((r) => r.link.fileRef != null && r.link.writeTime) && groups.size;
  const allGuids = [...new Set([...guids, ...(hashable ? hooks.listVolumes() : [])])];
  const versions = new Set([...groups.values()].map((g) => g.e.formatVersion));
  const { byKey, byFileId } = nameIndex(records, allGuids, versions);

  const items = [];
  for (const g of groups.values()) {
    let match = null;
    if (g.id.kind === 'file id') {
      const found = byFileId.get(`${g.id.volumeSerial}:${BigInt('0x' + g.id.fileId).toString(16)}`);
      if (found) match = { ...pick(found), how: 'file id', proves: false };
    } else {
      const found = byKey.get(g.e.hash);
      // Vista's key has neither the extension nor the time in it: it names the file, not the version.
      if (found) match = { ...pick(found), how: 'key', proves: g.e.formatVersion == null || g.e.formatVersion >= 0x15 };
    }
    items.push({ ...g, match });
  }
  return { items, stats, folders, caches, recents };
}

/** What a picture is and what it is not, for its note. */
function describePicture(item) {
  const e = item.e;
  const m = item.match;
  const f = FORMAT_NAMES[e.image.format] || e.image.format;
  const said = [];
  if (!m) {
    said.push(t('a {0}x{1} {2} picture Windows made of a file for Explorer; smaller and re-encoded, not the file itself. '
      + 'The file\'s name, type and date are not known', e.image.width, e.image.height, f));
  } else if (m.proves) {
    said.push(t('a {0}x{1} {2} picture Windows made of this file as it was on {3}; smaller and re-encoded, not the file itself',
      e.image.width, e.image.height, f, fmt.when(m.record.link.modified)));
  } else {
    said.push(t('a {0}x{1} {2} picture Windows made of the file with this file ID, of a version not known; '
      + 'smaller and re-encoded, not the file itself', e.image.width, e.image.height, f));
  }
  if (m) said.push(m.record.kind === 'shortcut' ? t('named by a shortcut') : t('named by a jump list'));
  if (m && m.record.lastOpened) said.push(t('last opened {0}', fmt.when(m.record.lastOpened)));
  if (m && m.others) said.push(t('{0} other shortcut(s) give it another path', m.others));
  if (item.snapshot && !item.live) said.push(t('found only in a shadow copy'));
  return said.join('; ');
}

function candidate(item) {
  const e = item.e;
  const m = item.match;
  const link = m && m.record.link;
  return {
    source: 'thumbcache',
    kind: link ? 'thumbnail' : 'thumbnail, name unknown',
    path: (link && link.path) || null,
    ...(link && !link.path ? { name: link.name } : {}),
    // Only a match of the key proves the version, and with it the time.
    time: m && m.proves && link.modified != null ? link.modified : null,
    size: e.dataSize,
    // A copy: the entry's data is a view into the whole cache file.
    buffer: Buffer.from(e.data),
    derived: true,
    mediaType: 'image',
    ext: e.image.ext,
    width: e.image.width,
    height: e.image.height,
    note: describePicture(item),
    origin: `${item.file}#${e.offset}`,
  };
}

async function scan(ctx) {
  const g = gather(ctx.locations, ctx.notes, { signal: ctx.signal, progress: ctx.progress });
  const out = [];
  // A picture with no name is offered only when pictures are asked for by type, with no name.
  const nameless = !!ctx.unnamed && !!ctx.types && ctx.types.includes('image');
  // Counted as the list shows them: many items share one picture, byte for byte, and search()
  // makes one row of the same bytes with no name.
  // One that is the same bytes as a named one is that one's row.
  const unnamed = new Set();
  const named = new Set();
  for (const item of g.items) {
    const link = item.match && item.match.record.link;
    if (link) {
      named.add(blobHash(item.e.data));
      // Its own format says nothing of its name: the name alone is matched, and search() sees to types.
      if (ctx.matcher.testName(link.path || link.name)) out.push(candidate(item));
      continue;
    }
    unnamed.add(blobHash(item.e.data));
    if (nameless) out.push(candidate(item));
  }
  for (const h of named) unnamed.delete(h);
  const s = g.stats;
  if (s.frozenAt) ctx.notes.push(t('Read as taken into memory at {0}; what Explorer has added since is not included.', fmt.when(s.frozenAt)));
  if (s.snapshots) {
    const only = g.items.filter((i) => !i.live).length;
    ctx.notes.push(t('Also read the thumbnail cache in {0} shadow copy(ies); {1} picture(s) were found only there.', s.snapshots, only));
  }
  if (s.outside) ctx.notes.push(t('{0} folder(s) in shadow copies were skipped: inside the snapshot their path leads out of it, to live files.', s.outside));
  if (s.damaged) ctx.notes.push(t('{0} thumbnail(s) failed a checksum or their picture\'s own checks, and were left out', s.damaged));
  if (s.devices) {
    ctx.notes.push(t('{0} thumbnail(s) of things other than files -- a phone or camera, a drive, an app -- were left out', s.devices));
  }
  if (s.notPictures) ctx.notes.push(t('{0} cache entr(ies) hold something other than a JPEG, PNG or BMP picture, and were left out', s.notPictures));
  if (s.problems) {
    ctx.notes.push(t('{0} place(s) in the cache files where an entry does not lead on to the next; read on from the next whole entry', s.problems));
  }
  if (nameless && unnamed.size) {
    ctx.notes.push(t('{0} thumbnail(s) have no name: no shortcut here leads to the file each was made of, so what it was called, '
      + 'and whether it still exists, cannot be told', unnamed.size));
  } else if (unnamed.size && !ctx.types && !ctx.matcher.folder) {
    ctx.notes.push(t('{0} thumbnail(s) with no name are not listed; a search by type for pictures (--type image) lists them', unnamed.size));
  }
  return out;
}

function describe(ctx) {
  const notes = [];
  const g = gather(ctx.locations, notes);
  if (!g.caches.length && !g.recents.length) return [t('No Explorer thumbnail cache found.')].concat(notes);
  const lines = [];
  for (const f of g.folders) {
    const where = f.snapshot ? t('{0} (in a shadow copy)', f.dir) : f.dir;
    const when = f.frozenAt ? t('; taken into memory at {0}', fmt.when(f.frozenAt)) : '';
    if (f.kind === 'cache') lines.push(t('{0}: {1} cache file(s), {2} picture(s) that pass every check', where, f.files, f.pictures) + when);
    else lines.push(t('{0}: {1} shortcut file(s) and jump list(s), read to name thumbnails', where, f.files) + when);
  }
  const named = g.items.filter((i) => i.match).length;
  // Counted as scan() lists them: items that are one picture byte for byte are one row, and one
  // that is a named item's picture is that item's row.
  const namedPictures = new Set(g.items.filter((i) => i.match).map((i) => blobHash(i.e.data)));
  const otherPictures = new Set(g.items.filter((i) => !i.match).map((i) => blobHash(i.e.data)).filter((h) => !namedPictures.has(h)));
  lines.push(t('{0} picture(s) in all: {1} named by a shortcut, {2} with no name, which a search by type for pictures lists as {3} different picture(s)',
    g.items.length, named, g.items.length - named, otherPictures.size));
  return lines.concat(notes);
}

/**
 * The folders read from, which restore will not write into: the cache and Recent folders behind
 * each place, or the place itself when there are none, each also by its real path.
 */
function roots(loc) {
  const out = [];
  const seen = new Set();
  const add = (d) => {
    if (!seen.has(pathKey(d))) {
      seen.add(pathKey(d));
      out.push(d);
    }
  };
  // A profile given as a place stands for its two folders, not for all of it: restoring into its
  // Documents is fine.
  for (const d of foldersOf(loc, null).places.flatMap((p) => (p.dirs.length ? p.dirs : [p.place]))) {
    add(d);
    try {
      add(fs.realpathSync.native(d));
    } catch (_) {
      /* not there: nothing is read from it */
    }
  }
  return out;
}

/** This user's cache folder and Recent folder, where there are such. */
function discover() {
  if (process.platform !== 'win32') return [];
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return [path.join(local, ...EXPLORER), path.join(roaming, ...RECENT)].filter(isDir);
}

module.exports = {
  id: 'thumbcache',
  label: 'Explorer thumbnails',
  discover,
  freeze,
  scan,
  describe,
  roots,
  _internal: {
    foldersOf, readRecent, inSnapshots, linksOf, nameIndex, pick, gather, candidate, hooks, listVolumes,
    thaw: () => {
      frozen.caches.clear();
      frozen.recents.clear();
    },
  },
};
