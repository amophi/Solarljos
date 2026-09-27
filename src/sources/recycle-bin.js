'use strict';

const fs = require('fs');
const path = require('path');
const { t } = require('../i18n');

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

const FILETIME_UNIX_OFFSET_MS = 11644473600000n;
const V1_PATH_BYTES = 520;

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

/**
 * The folders under a root that actually hold items. A root is normally `$Recycle.Bin` with
 * one folder per account, but a single account's folder can be given directly as well.
 * Other accounts' folders are unreadable without administrator rights; they are counted,
 * not treated as errors.
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
      if (!fs.statSync(p).isDirectory()) continue;
      fs.readdirSync(p);
      out.push(p);
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') denied++;
    }
  }
  if (denied) notes.push(t('{0}: {1} folder(s) of other accounts need administrator rights', root, denied));
  return out;
}

/** Every item in one account's bin, whether or not its contents are still there. */
function items(bin) {
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
    let info;
    try {
      info = parseInfo(fs.readFileSync(path.join(bin, n)));
    } catch (_) {
      continue;
    }
    if (!info) continue;
    const rName = '$R' + n.slice(2);
    const rPath = path.join(bin, rName);
    let st = null;
    if (present.has(rName)) {
      try {
        st = fs.statSync(rPath);
      } catch (_) {
        st = null;
      }
    }
    out.push({ info, infoPath: path.join(bin, n), rPath, st });
  }
  return out;
}

/** Files inside a deleted folder, each with the path it had before the folder was deleted. */
function walkInside(dir, info, matcher, out, rel) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
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
      walkInside(phys, info, matcher, out, relNext);
    } else if (e.isFile() && matcher.test(original)) {
      let st;
      try {
        st = fs.statSync(phys);
      } catch (_) {
        continue;
      }
      out.push({
        source: 'recycle', kind: 'recycle bin, inside a deleted folder',
        path: original, time: info.time, size: st.size, file: phys, origin: phys,
      });
    }
  }
}

async function scan(ctx) {
  const out = [];
  for (const root of ctx.locations.recycle) {
    for (const bin of bins(root, ctx.notes)) {
      for (const { info, infoPath, rPath, st } of items(bin)) {
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
        if (folder) walkInside(rPath, info, ctx.matcher, out, '');
      }
    }
  }
  return out;
}

function describe(ctx) {
  const lines = [];
  const notes = [];
  for (const root of ctx.locations.recycle) {
    for (const bin of bins(root, notes)) {
      lines.push(t('{0}: {1} item(s)', bin, items(bin).length));
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
  _internal: { parseInfo, filetimeToMs },
};
