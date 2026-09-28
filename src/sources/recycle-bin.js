'use strict';

const fs = require('fs');
const path = require('path');
const { t } = require('../i18n');
const { pathKey } = require('../paths');

// Windows keeps each deleted item as a pair in <drive>:\$Recycle.Bin\<SID>\ :
//   $I<id>.<ext>   what was deleted, from where, and when
//   $R<id>.<ext>   the item itself -- a file, or a whole folder with its contents
//
// $I layout, little-endian:
//   version 1 (Vista to 8.1)   0: int64 version   8: int64 size   16: FILETIME deleted
//                              24: path, UTF-16, fixed 520 bytes, NUL-padded
//   version 2 (10 and later)   0: int64 version   8: int64 size   16: FILETIME deleted
//                              24: uint32 path length in characters, NUL included
//                              28: path, UTF-16
// Measured on Windows 11: 138 of 138 $I files were version 2 and matched that length exactly.
//
// A deleted junction or symbolic link is moved into the bin as the link itself, so its $R still
// points at wherever the link did -- a folder that was never deleted, or a drive's root. Nothing
// is read through one: what lies there would be offered as deleted, and a link to a drive's root
// would have every search walk the whole drive. Such an item, and a link inside a deleted folder,
// is skipped and counted in a note; an account folder that is a link is not read, and said so.
// Node reports a junction as a link too. Its folder listing on Windows reports any reparse point
// as one, so an entry of another kind inside a deleted folder, such as a cloud placeholder, is
// skipped along with them; reading a placeholder could have its sync app download it.
//
// A deleted folder is read level by level from its top, and no further than limits.inside
// entries, with a note when it is cut: what lies deepest is what is left out, and restoring the
// folder itself still copies all of it. Measured on Windows 11: 23 deleted folders held 16,657
// entries in all, the largest 11,178, the deepest 12 levels down. In a rebuild only the part of a
// deleted folder on the way to or below the folder being rebuilt is read.

const FILETIME_UNIX_OFFSET_MS = 11644473600000n;
const V1_PATH_BYTES = 520;
// Entries read inside one deleted folder, at most: some eighteen times the largest measured.
// Kept in an object, so that a test can lower it.
const limits = { inside: 200000 };

function filetimeToMs(ft) {
  if (ft <= 0n) return null;
  return Number(ft / 10000n - FILETIME_UNIX_OFFSET_MS);
}

function parseInfo(buf) {
  if (!buf || buf.length < 24) return null;
  const version = buf.readBigInt64LE(0);
  const size = buf.readBigInt64LE(8);
  const time = filetimeToMs(buf.readBigInt64LE(16));
  let raw;
  if (version === 1n) {
    raw = buf.subarray(24, 24 + V1_PATH_BYTES);
  } else if (version === 2n) {
    if (buf.length < 28) return null;
    raw = buf.subarray(28, 28 + buf.readUInt32LE(24) * 2);
  } else {
    return null;
  }
  const p = raw.toString('utf16le').replace(/\0[\s\S]*$/, '');
  if (!p) return null;
  return { version: Number(version), size: Number(size), time, path: p };
}

function lstat(p) {
  try {
    return fs.lstatSync(p);
  } catch (_) {
    return null;
  }
}

/** A link, a junction, or anything else that is neither a file nor a folder. */
const holdsNoFile = (st) => !st.isFile() && !st.isDirectory();

/**
 * The folders under a root that actually hold items. A root is normally `$Recycle.Bin` with
 * one folder per account, but a single account's folder can be given directly as well.
 * Other accounts' folders are unreadable without administrator rights; they are counted,
 * not treated as errors. An account folder that is a link is not read.
 */
function bins(root, notes) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch (e) {
    notes.push(t('Could not read {0} ({1})', root, e.code || e.message));
    return [];
  }
  if (names.some((n) => n.startsWith('$I'))) return [root];
  const out = [];
  let denied = 0;
  for (const n of names) {
    const p = path.join(root, n);
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        notes.push(t('{0}: not read, since it is not a real folder', p));
        continue;
      }
      if (!st.isDirectory()) continue;
      fs.readdirSync(p);
      out.push(p);
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') denied++;
    }
  }
  if (denied) notes.push(t('{0}: {1} folder(s) of other accounts need administrator rights', root, denied));
  return out;
}

/**
 * Every item in one account's bin, whether or not its contents are still there. `st` is the
 * item's own lstat, or null when it is gone. An item that is a link is counted in
 * `tally.links` and left out, and so is a $I that is one.
 */
function items(bin, tally) {
  let names;
  try {
    names = fs.readdirSync(bin);
  } catch (_) {
    return [];
  }
  const present = new Set(names);
  const out = [];
  for (const n of names) {
    if (!n.startsWith('$I')) continue;
    const infoPath = path.join(bin, n);
    const is = lstat(infoPath);
    if (!is || !is.isFile()) {
      if (is && holdsNoFile(is)) tally.links++;
      continue;
    }
    let info;
    try {
      info = parseInfo(fs.readFileSync(infoPath));
    } catch (_) {
      continue;
    }
    if (!info) continue;
    const rName = '$R' + n.slice(2);
    const rPath = path.join(bin, rName);
    const st = present.has(rName) ? lstat(rPath) : null;
    if (st && holdsNoFile(st)) {
      tally.links++;
      continue;
    }
    out.push({ info, infoPath, rPath, st });
  }
  return out;
}

/** Whether a folder can hold a match. In a rebuild, only one on the way to or below the folder can. */
function worthWalking(p, matcher) {
  if (!matcher.folder) return true;
  const k = pathKey(p);
  return k === matcher.folder || k.startsWith(matcher.folder + '/') || matcher.folder.startsWith(k + '/');
}

/**
 * Files inside a deleted folder, each with the path it had before the folder was deleted. The
 * folder is read level by level, and no more than `limits.inside` of its entries; links are
 * counted in `tally.links`, never followed.
 * @returns {boolean} whether entries were left unread
 */
function walkInside(top, info, matcher, out, tally) {
  const queue = [{ dir: top, rel: '' }];
  let read = 0;
  for (let i = 0; i < queue.length; i++) {
    const { dir, rel } = queue[i];
    queue[i] = null;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      if (++read > limits.inside) return true;
      const phys = path.join(dir, e.name);
      const relNext = rel ? rel + '\\' + e.name : e.name;
      const original = path.win32.join(info.path, relNext);
      if (e.isDirectory()) {
        if (matcher.test(original)) {
          out.push({
            source: 'recycle', kind: 'recycle bin, inside a deleted folder',
            path: original, time: info.time, size: null, isDir: true, dir: phys, origin: phys,
          });
        }
        if (worthWalking(original, matcher)) queue.push({ dir: phys, rel: relNext });
      } else if (!e.isFile()) {
        tally.links++;
      } else if (matcher.test(original)) {
        // Looked at again without following: it may have been swapped for a link since the listing.
        const st = lstat(phys);
        if (!st || !st.isFile()) continue;
        out.push({
          source: 'recycle', kind: 'recycle bin, inside a deleted folder',
          path: original, time: info.time, size: st.size, file: phys, origin: phys,
        });
      }
    }
  }
  return false;
}

function report(bin, tally, notes) {
  if (tally.links) notes.push(t('{0}: {1} link(s), junction(s) or special file(s) skipped; they hold no file', bin, tally.links));
}

async function scan(ctx) {
  const out = [];
  for (const root of ctx.locations.recycle) {
    for (const bin of bins(root, ctx.notes)) {
      const tally = { links: 0 };
      for (const { info, infoPath, rPath, st } of items(bin, tally)) {
        const folder = !!(st && st.isDirectory());
        if (ctx.matcher.test(info.path)) {
          out.push({
            source: 'recycle', kind: 'recycle bin',
            path: info.path, time: info.time,
            size: st && !folder ? st.size : info.size,
            isDir: folder,
            file: st && st.isFile() ? rPath : undefined,
            dir: folder ? rPath : undefined,
            gone: !st,
            origin: st ? rPath : infoPath,
          });
        }
        if (folder && worthWalking(info.path, ctx.matcher) && walkInside(rPath, info, ctx.matcher, out, tally)) {
          ctx.notes.push(t('Deleted folder {0}: only the {1} entries nearest its top were searched; restoring the folder itself copies all of it', info.path, limits.inside));
        }
      }
      report(bin, tally, ctx.notes);
    }
  }
  return out;
}

function describe(ctx) {
  const lines = [];
  const notes = [];
  for (const root of ctx.locations.recycle) {
    for (const bin of bins(root, notes)) {
      const tally = { links: 0 };
      lines.push(t('{0}: {1} item(s)', bin, items(bin, tally).length));
      report(bin, tally, notes);
    }
  }
  if (!ctx.locations.recycle.length) lines.push(t('No Recycle Bin found.'));
  return lines.concat(notes);
}

module.exports = {
  id: 'recycle',
  label: 'Recycle Bin',
  scan,
  describe,
  roots: (loc) => loc.recycle,
  _internal: { parseInfo, filetimeToMs, limits },
};
