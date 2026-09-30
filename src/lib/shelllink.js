'use strict';

// Windows shell links, and the jump lists that hold them. None of them holds a file's content.
// What they hold -- where a file was, how big it was, when it was last written, and its NTFS
// file ID -- stays long after the file is gone, and it is exactly what Windows hashes into the
// key of the file's picture in Explorer's thumbnail cache (below). So they can put a name on a
// thumbnail that has none. Nothing here reads a file: every function takes bytes and returns
// plain data, or null for anything that fails a check.
//
// Where they are, for each user:
//   %APPDATA%\Microsoft\Windows\Recent\<name>.lnk                        one per file or folder opened
//   ...\Recent\AutomaticDestinations\<AppID>.automaticDestinations-ms    a program's jump list
//   ...\Recent\CustomDestinations\<AppID>.customDestinations-ms          one a program made itself
//
// A shell link (MS-SHLLINK); every number is little-endian:
//   header      76 bytes: 0x4C, the CLSID 00021401-0000-0000-C000-000000000046, LinkFlags at 0x14,
//               the target's attributes at 0x18, its creation, access and last-write FILETIMEs
//               at 0x1C, 0x24 and 0x2C (0 when not recorded), and the low 32 bits of its size at
//               0x34, so a file of 4 GiB or more wraps
//   ID list     with flag 0x1: a u16 size, then shell items, each a u16 size and its bytes, ended
//               by a u16 0 -- the target as Explorer named it, folder by folder (below)
//   LinkInfo    with flag 0x2: the target's volume -- drive type, serial number, label -- and its
//               local path, or for a network target its share. The path is in the ANSI code page
//               of the machine that made the link, which the link does not name, and in Unicode
//               as well only when the LinkInfo header is 0x24 bytes or more
//   strings     with flags 0x4 to 0x40: description, relative path, working folder, arguments,
//               icon; each a u16 count, then that many characters, UTF-16 with flag 0x80
//   extra data  blocks of a u32 size and a u32 signature, ended by a u32 under 4. The tracker
//               block, 0xA0000003, names the machine the target was last known to be on
//
// Shell items, as libfwsi names them:
//   0x1F        a root: a GUID naming My Computer {20D04FE0-3AEA-1069-A2D8-08002B30309D}, or a
//               known folder -- the user's profile, the Desktop, Downloads -- whose place is not
//               in the link
//   0x20-0x2F   a drive: "C:\" in ASCII at 3
//   0x30-0x3F   a file entry, 0x1 set for a folder and 0x2 for a file: its size (u32, 0 for a
//               folder) at 4, its last write at 8 as a DOS date then a DOS time -- UTC, rounded
//               up to 2 seconds -- attributes at 12, and its name at 14: in UTF-16 when 0x4 is
//               set, otherwise the 8.3 name, or the name when it needs none, in the ANSI code
//               page and padded to an even length
//   0x74        a delegate item: "CFSF" at 6, a whole file entry from 10, two GUIDs, and the
//               extension block
// A file entry's extension blocks follow its name, and its last two bytes give where the first
// one, 0xBEEF0004, starts: u16 size, u16 version, the signature, the DOS creation and access
// times at 8 and 12, the long name in UTF-16 -- at 20 in version 3 (XP), 38 in 7 (Vista), 42 in
// 8 (7) and 46 in 9 (8 and later) -- a localized name after it when the u16 before it is not 0,
// and the block's own offset again as its last two bytes. From version 7 it holds the NTFS file
// reference at 20: the 48-bit MFT entry and the 16-bit sequence number, the value
// fs.statSync(p, { bigint: true }).ino gives there.
//
// A link's path is taken from the first of these that gives one:
//   1. LinkInfo's Unicode path;
//   2. LinkInfo's ANSI path, when it is plain ASCII;
//   3. LinkInfo's ANSI path rebuilt with the Unicode names the ID list ends in: its leading
//      folders as they are, when those are ASCII, and the names for the rest -- only when the two
//      agree wherever they can be compared, as many names and the same name wherever either is
//      ASCII (as hancom.js reads Hwp's shortcuts);
//   4. LinkInfo's share, with the rest of the path;
//   5. the ID list, when it runs from My Computer through a drive.
// A path no rule gives is left out rather than guessed; the name of the file is still read.
//
// A jump list, automaticDestinations-ms, is an OLE compound file (MS-CFB). Each link it keeps
// is a stream named by its entry number in lowercase hex -- "1", "a", "1f" -- sometimes with
// bytes after the link's end that are not part of it, and the DestList stream says what each
// one is:
//   header    32 bytes: u32 version, u32 entry count, u32 pinned count, and counters
//   entry     u64 hash at 0; four GUIDs at 8, the target's volume and object IDs from link
//             tracking, now and at birth; the NetBIOS name of the target's machine at 0x48;
//             version 1 (Windows 7 and 8): u32 entry number at 0x58, the FILETIME it was last
//               opened at 0x64, i32 pin at 0x6C (-1: not pinned), u16 path length at 0x70, the
//               path in UTF-16 at 0x72
//             versions 3 to 6 (Windows 10 and 11): the same up to 0x6C, then u32 open count at
//               0x74, u16 path length at 0x80, the path at 0x82 and 4 bytes after it
//   Any other version is not read: its layout is not known here.
// A DestListPropertyStore stream beside them holds no link. A customDestinations-ms file is a
// u32 version, 2, category records, and links, each behind the shell link CLSID; it ends in
// AB FB BF BA. Its links are found by their header and read one after another.
//
// Explorer's thumbnail cache keys a picture by the file's ThumbnailCacheId, a 64-bit hash that
// shell32 computes -- per thumbcacheviewer's map_entries.cpp, and confirmed on this machine --
// as h = 0x95E729BA2C37FD21, then h ^= h * 0x820 + x + (h >> 2), modulo 2^64, for each byte x of:
//   1. the volume's GUID, the one in \\?\Volume{...}\, as a GUID structure: 16 bytes
//   2. the file ID, u64: on NTFS the file reference
//   3. the extension with its dot, spelled as it is, in UTF-16LE
//   4. the last-write FILETIME as FileTimeToDosDateTime makes it, with no change of time zone
//      and rounded UP to the next 2 seconds, as the DOS times in shell items are: a u32 with the
//      DOS date in the high half and the time, in 2-second steps, in the low
//   5. from Windows 8.1, and only when it is not 0: how far step 4 rounded up -- the low 32 bits
//      of that DOS time turned back into a FILETIME, less the low 32 bits of the FILETIME -- as
//      a u32
// A link records 2, 3 and 4 of its target, and the serial of its volume, which says which GUID
// is 1 when that volume is mounted here. Otherwise every GUID known is tried: a match of 64 bits
// settles which. The key changes with the file's name, volume and last write, so a match is the
// thumbnail of the version the link recorded, as it was then. Files on FAT and exFAT have no
// lasting file ID; what Windows hashes for them is not known.
//
// Measured on the machine this was written on (Windows 11 26200), read-only. All 202 Recent
// links parsed, each ending exactly where its file does. 155 had a path, 92 of them rebuilt from
// an ANSI path that was not ASCII, and each of the 155 was the path the link's own Unicode
// relative path gives from the Recent folder; the other 47 led to web addresses and other things
// that are not files. All 36 jump lists read as compound files, 4 of them with a last sector cut
// short: 28 had a DestList of version 6, 7 an empty one and 1 none, and each of the 651 entries
// named a stream holding a link that parsed. Where both gave a path, the DestList's was the
// link's in 629 of 636; for the other 7 it held a web address or the like instead. 65 custom
// destination files held 189 links, and all of them parsed. All 4,588 file entries' extension blocks were of version 9 and found by
// their offset, and wherever a link had both a path and ID-list names, the names were the end
// of the path: 964 of 964. The last item's DOS time was the header's write time rounded up to
// 2 seconds in 902 of 914 links; the other 12 files had been written again since.
// The cache key: of 57,842 files in the user's Pictures, Desktop, Downloads, Documents and
// Videos, read by stat only, 260 hashed to an entry in the cache. 244 of those have a write
// time off the 2-second grid and match only when it is rounded up and step 5 is taken; rounded
// down, or without step 5, only the 16 on the grid match. One has a capital in its extension
// and matches only as spelled. Of 451 targets the links name with a file reference and a write
// time, 128 have a slot in thumbcache_idx.db -- 127 slots, 29 of them with a picture (21 of 256
// pixels or more) and 99 marked as ones Windows could make none of -- and 118 of the 128 needed
// step 5. Parsing it all took 20 ms, and 2,673 keys 14 ms.

const LINK_CLSID = Buffer.from('0114020000000000c000000000000046', 'hex');
const MY_COMPUTER = '{20d04fe0-3aea-1069-a2d8-08002b30309d}';
const DELEGATE = Buffer.from('CFSF', 'latin1');
const EXTENSION_BLOCK = 0xbeef0004;
const TRACKER_BLOCK = 0xa0000003;
const CUSTOM_FOOTER = 0xbabffbab;

const FILETIME_UNIX_OFFSET_MS = 11644473600000n;
const FILETIME_UNIX_OFFSET = 116444736000000000n; // in 100 ns
const TWO_SECONDS = 20000000n;
const M64 = (1n << 64n) - 1n;
const CACHE_ID_SEED = 0x95e729ba2c37fd21n;
const DESTLIST_VERSIONS = new Set([1, 3, 4, 5, 6]);

// ---- Small readers ---------------------------------------------------------------------------

function filetimeToMs(ft) {
  if (ft <= 0n) return null;
  return Number(ft / 10000n - FILETIME_UNIX_OFFSET_MS);
}

/** A DOS date and time -- 7 bits of year from 1980, month, day; hour, minute, 2-second step -- in ms, or null. */
function dosToMs(date, time) {
  if (!date && !time) return null;
  const y = 1980 + (date >> 9);
  const mo = (date >> 5) & 15;
  const d = date & 31;
  const h = time >> 11;
  const mi = (time >> 5) & 63;
  const s = (time & 31) * 2;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/** A GUID stored as its structure -- u32, u16, u16, then 8 bytes as they are -- as "{...}" in lowercase. */
function guidAt(b, at) {
  if (at + 16 > b.length) return null;
  const hex = (n, w) => n.toString(16).padStart(w, '0');
  const rest = b.toString('hex', at + 8, at + 16);
  return `{${hex(b.readUInt32LE(at), 8)}-${hex(b.readUInt16LE(at + 4), 4)}-${hex(b.readUInt16LE(at + 6), 4)}`
    + `-${rest.slice(0, 4)}-${rest.slice(4)}}`;
}

/** The bytes up to a NUL, or null when there is none before `end`. */
function cBytes(b, at, end = b.length) {
  const stop = b.indexOf(0, at);
  return stop < 0 || stop >= end ? null : b.subarray(at, stop);
}

/** The UTF-16 string up to a NUL on an even offset, or null when there is none before `end`. */
function wString(b, at, end = b.length) {
  for (let p = at; p + 1 < end; p += 2) {
    if (b[p] === 0 && b[p + 1] === 0) return b.toString('utf16le', at, p);
  }
  return null;
}

const isAscii = (bytes) => bytes.every((x) => x > 0 && x < 0x80);
const asciiText = (s) => /^[\x01-\x7f]*$/.test(s);

// ---- Shell items -----------------------------------------------------------------------------

/**
 * A file entry's 0xBEEF0004 block, found by the offset the item's last two bytes give and ending
 * in that same offset: { created, accessed, fileRef, longName, version }, or null when the item
 * has none.
 */
function extensionBlock(item) {
  if (item.length < 4) return null;
  const at = item.readUInt16LE(item.length - 2);
  if (at < 4 || at + 20 > item.length) return null;
  const end = at + item.readUInt16LE(at);
  if (end > item.length || end < at + 20 || item.readUInt16LE(end - 2) !== at) return null;
  if (item.readUInt32LE(at + 4) !== EXTENSION_BLOCK) return null;
  const version = item.readUInt16LE(at + 2);
  const block = {
    version,
    created: dosToMs(item.readUInt16LE(at + 8), item.readUInt16LE(at + 10)),
    accessed: dosToMs(item.readUInt16LE(at + 12), item.readUInt16LE(at + 14)),
    fileRef: null,
    longName: null,
  };
  let name;
  if (version >= 7) {
    if (at + 38 > end) return null;
    const ref = item.readBigUInt64LE(at + 20);
    block.fileRef = ref === 0n ? null : ref;
    name = at + 38 + (version >= 8 ? 4 : 0) + (version >= 9 ? 4 : 0);
  } else if (version >= 3) {
    name = at + 20;
  } else {
    return block;
  }
  const s = wString(item, name, end - 2);
  if (s) block.longName = s;
  return block;
}

/**
 * A file entry whose class byte is at `base` + 2: { isDir, size, mtime, attributes, name, ...block }.
 * `name` is the long name when the extension block has one, else the item's own name when that
 * is UTF-16 or plain ASCII; null otherwise.
 */
function fileEntry(item, base) {
  if (base + 16 > item.length) return null;
  const cls = item[base + 2];
  const entry = {
    kind: 'file',
    isDir: !!(cls & 0x01),
    size: item.readUInt32LE(base + 4),
    mtime: dosToMs(item.readUInt16LE(base + 8), item.readUInt16LE(base + 10)),
    attributes: item.readUInt16LE(base + 12),
    name: null,
    fileRef: null,
    created: null,
    accessed: null,
  };
  let own = null;
  if (cls & 0x04) {
    own = wString(item, base + 14);
  } else {
    const bytes = cBytes(item, base + 14);
    if (bytes && isAscii(bytes)) own = bytes.toString('latin1');
  }
  const block = extensionBlock(item);
  if (block) {
    entry.fileRef = block.fileRef;
    entry.created = block.created;
    entry.accessed = block.accessed;
    entry.extVersion = block.version;
  }
  entry.name = (block && block.longName) || own || null;
  return entry;
}

/** One item of an ID list, its bytes including its size. */
function shellItem(item) {
  const cls = item.length > 2 ? item[2] : -1;
  if (cls === 0x1f && item.length >= 20) return { kind: 'root', guid: guidAt(item, 4) };
  if ((cls & 0x70) === 0x20) {
    const bytes = cBytes(item, 3);
    const name = bytes && bytes.toString('latin1');
    if (name && /^[a-z]:\\$/i.test(name)) return { kind: 'drive', name: name.slice(0, 2).toUpperCase() + '\\' };
  }
  const other = { kind: 'other', type: cls };
  if ((cls & 0x70) === 0x30) return fileEntry(item, 0) || other;
  // A delegate item holds a whole file entry, its size field at 10.
  if (cls === 0x74 && item.length >= 26 && item.subarray(6, 10).equals(DELEGATE) && (item[12] & 0x70) === 0x30) {
    return fileEntry(item, 10) || other;
  }
  return other;
}

/** The items of an ID list that runs from `at` to `end`, or null when they do not end exactly at its terminator. */
function idList(b, at, end) {
  const items = [];
  let p = at;
  for (;;) {
    if (p + 2 > end) return null;
    const size = b.readUInt16LE(p);
    if (size === 0) break;
    if (size < 3 || p + size > end) return null;
    items.push(shellItem(b.subarray(p, p + size)));
    p += size;
  }
  return p + 2 === end ? items : null;
}

/** The names of the file entries the ID list ends in, as far back as each has one. */
function trailingNames(items) {
  const names = [];
  for (let i = items.length - 1; i >= 0 && items[i].kind === 'file' && items[i].name; i--) names.unshift(items[i].name);
  return names;
}

/** The path an ID list names, when it runs from My Computer through a drive to named entries. */
function idListPath(items) {
  if (items.length < 2 || items[0].kind !== 'root' || items[0].guid !== MY_COMPUTER || items[1].kind !== 'drive') return null;
  const names = trailingNames(items);
  if (names.length !== items.length - 2) return null;
  return items[1].name + names.join('\\');
}

// ---- LinkInfo --------------------------------------------------------------------------------

/**
 * LinkInfo at `at`: { size, driveType, serial, label, unicode, ansi, netName, suffix }, where
 * `unicode` is the Unicode local path, `ansi` its bytes in the ANSI code page, `netName` the
 * share and `suffix` the rest of the path after the local path or share. Null when an offset
 * leaves it.
 */
function linkInfo(b, at) {
  if (at + 28 > b.length) return null;
  const size = b.readUInt32LE(at);
  const head = b.readUInt32LE(at + 4);
  const flags = b.readUInt32LE(at + 8);
  const end = at + size;
  if (size < 28 || head < 28 || head > size || end > b.length) return null;
  const off = (n) => b.readUInt32LE(at + n);
  const inside = (o) => o > 0 && at + o < end;
  const info = { size, driveType: null, serial: null, label: null, unicode: null, ansi: null, netName: null, suffix: '' };
  if (flags & 0x1) {
    const vol = at + off(12);
    if (!inside(off(12)) || vol + 16 > end) return null;
    const volEnd = vol + b.readUInt32LE(vol);
    if (volEnd > end || volEnd < vol + 16) return null;
    info.driveType = b.readUInt32LE(vol + 4);
    info.serial = b.readUInt32LE(vol + 8);
    const labelAt = b.readUInt32LE(vol + 12);
    if (labelAt === 0x14 && vol + 20 <= volEnd) {
      info.label = wString(b, vol + b.readUInt32LE(vol + 16), volEnd);
    } else if (labelAt < volEnd - vol) {
      const label = cBytes(b, vol + labelAt, volEnd);
      info.label = label && isAscii(label) ? label.toString('latin1') : null;
    }
    if (!inside(off(16))) return null;
    info.ansi = cBytes(b, at + off(16), end);
    if (!info.ansi) return null;
    if (head >= 0x24 && inside(off(28))) info.unicode = wString(b, at + off(28), end);
  }
  if (flags & 0x2) {
    const net = at + off(20);
    if (!inside(off(20)) || net + 20 > end) return null;
    const nameAt = b.readUInt32LE(net + 8);
    const name = nameAt > 0x14 && net + 24 <= end
      ? wString(b, net + b.readUInt32LE(net + 20), end)
      : (cBytes(b, net + nameAt, end) || null);
    info.netName = typeof name === 'string' ? name : name && isAscii(name) ? name.toString('latin1') : null;
  }
  if (inside(off(24))) {
    const suffix = head >= 0x24 && inside(off(32)) ? wString(b, at + off(32), end) : cBytes(b, at + off(24), end);
    if (typeof suffix === 'string') info.suffix = suffix;
    else info.suffix = suffix && (!suffix.length || isAscii(suffix)) ? suffix.toString('latin1') : null;
  }
  return info;
}

/**
 * An ANSI path that is not ASCII, rebuilt with Unicode names: its leading folders as they are,
 * when those are ASCII, then `names` for the rest. Null unless the two agree wherever they can be
 * compared -- as many names, and the same name wherever either is ASCII. That also catches a code
 * page whose second byte of a character can be a backslash: the path then splits into more names.
 */
function fromAnsi(ansi, names) {
  const parts = [];
  for (let at = 0; ;) {
    const end = ansi.indexOf(0x5c, at);
    parts.push(ansi.subarray(at, end < 0 ? ansi.length : end));
    if (end < 0) break;
    at = end + 1;
  }
  const lead = parts.length - names.length;
  if (!names.length || lead < 1 || !parts.slice(0, lead).every((p) => p.length && isAscii(p))) return null;
  for (let i = 0; i < names.length; i++) {
    const a = parts[lead + i];
    const u = names[i];
    if (!isAscii(a) && !asciiText(u)) continue;
    if (!isAscii(a) || !asciiText(u) || a.toString('latin1').toLowerCase() !== u.toLowerCase()) return null;
  }
  return parts.slice(0, lead).map((p) => p.toString('latin1')).concat(names).join('\\');
}

/** Where the link says its target is, by the rules at the top, or null. */
function pathOf(info, items) {
  if (info && info.suffix !== null) {
    const join = (base, suffix) => (suffix ? base.replace(/\\?$/, '\\') + suffix : base);
    if (info.unicode) return join(info.unicode, info.suffix);
    if (info.ansi && info.ansi.length) {
      if (isAscii(info.ansi)) return join(info.ansi.toString('latin1'), info.suffix);
      const rebuilt = !info.suffix && fromAnsi(info.ansi, trailingNames(items));
      if (rebuilt) return rebuilt;
    }
    if (info.netName) return join(info.netName, info.suffix);
  }
  return idListPath(items);
}

// ---- Links -----------------------------------------------------------------------------------

// The strings a link may hold, by the flag that says it does, in the order they come.
const STRINGS = [[0x4, 'description'], [0x8, 'relativePath'], [0x10, 'workingDir'], [0x20, 'arguments'], [0x40, 'iconLocation']];

/** The last name in a Windows path; null for a drive or a share, which has none. */
function lastName(p) {
  const parts = p.split('\\').filter(Boolean);
  return parts.length < 2 || (p.startsWith('\\\\') && parts.length < 3) ? null : parts[parts.length - 1];
}

/**
 * One shell link, starting at `at`:
 *   length        the bytes it takes, so that links laid one after another can be read in turn
 *   path, name    where its target was and the target's name, or null (see the top)
 *   isDir, attributes, size (the low 32 bits)
 *   created, accessed, modified   the target's times in ms, or null when not recorded
 *   writeTime     the last-write FILETIME itself, a BigInt, 0n when not recorded
 *   fileRef       the NTFS file reference of the target, a BigInt, from the ID list's last item
 *                 when that is a file entry; null otherwise
 *   driveType, serial, label      of the target's volume, from LinkInfo; null without it
 *   description, relativePath, workingDir, arguments, iconLocation   the strings, or null
 *   machine       the NetBIOS name of the machine the target was last known to be on, or null
 *   items         the ID list, parsed; empty when there is none
 * Null when it is not a link, or any part of it runs past its end or out of its bounds.
 */
function parseLink(buf, at = 0) {
  try {
    const b = buf.subarray(at);
    if (b.length < 0x4c || b.readUInt32LE(0) !== 0x4c || !b.subarray(4, 20).equals(LINK_CLSID)) return null;
    const flags = b.readUInt32LE(0x14);
    const attributes = b.readUInt32LE(0x18);
    const writeTime = b.readBigUInt64LE(0x2c);
    const link = {
      length: 0,
      path: null,
      name: null,
      isDir: !!(attributes & 0x10),
      attributes,
      size: b.readUInt32LE(0x34),
      created: filetimeToMs(b.readBigUInt64LE(0x1c)),
      accessed: filetimeToMs(b.readBigUInt64LE(0x24)),
      modified: filetimeToMs(writeTime),
      writeTime,
      fileRef: null,
      driveType: null,
      serial: null,
      label: null,
      description: null,
      relativePath: null,
      workingDir: null,
      arguments: null,
      iconLocation: null,
      machine: null,
      items: [],
    };
    let p = 0x4c;
    if (flags & 0x1) {
      if (p + 2 > b.length) return null;
      const end = p + 2 + b.readUInt16LE(p);
      if (end > b.length) return null;
      link.items = idList(b, p + 2, end);
      if (!link.items) return null;
      p = end;
    }
    let info = null;
    if (flags & 0x2) {
      info = linkInfo(b, p);
      if (!info) return null;
      link.driveType = info.driveType;
      link.serial = info.serial;
      link.label = info.label;
      p += info.size;
    }
    const unicode = !!(flags & 0x80);
    for (const [bit, key] of STRINGS) {
      if (!(flags & bit)) continue;
      if (p + 2 > b.length) return null;
      const bytes = b.readUInt16LE(p) * (unicode ? 2 : 1);
      if (p + 2 + bytes > b.length) return null;
      const raw = b.subarray(p + 2, p + 2 + bytes);
      link[key] = unicode ? raw.toString('utf16le') : isAscii(raw) || !raw.length ? raw.toString('latin1') : null;
      p += 2 + bytes;
    }
    for (;;) {
      if (p + 4 > b.length) return null;
      const size = b.readUInt32LE(p);
      if (size < 4) {
        p += 4;
        break;
      }
      if (size < 8 || p + size > b.length) return null;
      // The tracker block: u32 length, u32 version, then the machine's NetBIOS name in 16 bytes.
      if (b.readUInt32LE(p + 4) === TRACKER_BLOCK && size >= 0x20) {
        const name = cBytes(b, p + 16, p + 32);
        if (name && name.length && isAscii(name)) link.machine = name.toString('latin1');
      }
      p += size;
    }
    link.length = p;
    link.path = pathOf(info, link.items);
    const last = link.items[link.items.length - 1];
    const target = last && last.kind === 'file' ? last : null;
    if (target) link.fileRef = target.fileRef;
    link.name = (link.path && lastName(link.path)) || (target && target.name) || null;
    return link;
  } catch (_) {
    return null;
  }
}

// ---- Compound files --------------------------------------------------------------------------

const FREE = 0xffffffff;
const END = 0xfffffffe;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const MINI = 64;

/** Sector numbers from `start` until ENDOFCHAIN, or null when it leaves the table or runs past `max`. */
function chain(start, table, max) {
  const out = [];
  for (let s = start; s !== END; s = table[s]) {
    if (s >= table.length || out.length >= max) return null;
    out.push(s);
  }
  return out;
}

/**
 * The streams of a compound file, as a Map of name to bytes, or null when its structure does not
 * hold: every chain must stay inside the file, be as long as its stream needs and share no
 * sector with another, and the directory must be a tree that visits each entry once. Its last
 * sector may be cut short where nothing in it is used: Windows leaves jump lists so.
 */
function readCfb(buf) {
  if (buf.length < 512 || buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) return null;
  const major = buf.readUInt16LE(26);
  const shift = buf.readUInt16LE(30);
  if (buf.readUInt16LE(28) !== 0xfffe || buf.readUInt16LE(32) !== 6 || buf.readUInt32LE(56) !== 4096) return null;
  if (!(major === 3 && shift === 9) && !(major === 4 && shift === 12)) return null;
  const ss = 1 << shift;
  // Sector s starts at (s + 1) * ss, the header taking the place of sector -1.
  const count = Math.ceil(buf.length / ss) - 1;
  if (count < 1) return null;
  const at = (s) => (s + 1) * ss;
  const used = new Uint8Array(count);
  const claim = (s) => s < count && !used[s] && (used[s] = 1);
  const whole = (s) => at(s) + ss <= buf.length;

  const nFat = buf.readUInt32LE(44);
  const perSector = ss / 4;
  if (nFat === 0 || nFat > count) return null;
  const fatIds = [];
  for (let i = 0; i < 109 && fatIds.length < nFat; i++) fatIds.push(buf.readUInt32LE(76 + i * 4));
  const difIds = [];
  let dif = buf.readUInt32LE(68);
  for (let left = buf.readUInt32LE(72); fatIds.length < nFat; left--) {
    if (left <= 0 || !claim(dif) || !whole(dif)) return null;
    difIds.push(dif);
    for (let i = 0; i < perSector - 1 && fatIds.length < nFat; i++) fatIds.push(buf.readUInt32LE(at(dif) + i * 4));
    dif = buf.readUInt32LE(at(dif) + ss - 4);
  }
  const fat = new Uint32Array(nFat * perSector);
  for (let i = 0; i < nFat; i++) {
    const s = fatIds[i];
    if (!claim(s) || !whole(s)) return null;
    for (let j = 0; j < perSector; j++) fat[i * perSector + j] = buf.readUInt32LE(at(s) + j * 4);
  }
  if (fatIds.some((s) => fat[s] !== FATSECT) || difIds.some((s) => fat[s] !== DIFSECT)) return null;
  for (let s = count; s < fat.length; s++) if (fat[s] !== FREE) return null;

  /** A stream kept in whole sectors: its chain must be exactly as long as its size needs. */
  function bigStream(start, size) {
    const n = Math.ceil(size / ss);
    const c = chain(start, fat, n);
    if (!c || c.length !== n) return null;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const need = i < n - 1 ? ss : size - i * ss;
      if (!claim(c[i]) || at(c[i]) + need > buf.length) return null;
      parts.push(buf.subarray(at(c[i]), at(c[i]) + need));
    }
    return Buffer.concat(parts);
  }

  const dirIds = chain(buf.readUInt32LE(48), fat, count);
  if (!dirIds || !dirIds.length || dirIds.some((s) => !claim(s) || !whole(s))) return null;
  const dir = Buffer.concat(dirIds.map((s) => buf.subarray(at(s), at(s) + ss)));
  const entries = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const len = dir.readUInt16LE(o + 64);
    entries.push({
      name: len >= 2 && len <= 64 && len % 2 === 0 ? dir.toString('utf16le', o, o + len - 2) : null,
      type: dir[o + 66],
      left: dir.readUInt32LE(o + 68),
      right: dir.readUInt32LE(o + 72),
      child: dir.readUInt32LE(o + 76),
      start: dir.readUInt32LE(o + 116),
      // Version 3 files may leave garbage in the high half; the format says to ignore it.
      size: dir.readUInt32LE(o + 120) + (major === 3 ? 0 : dir.readUInt32LE(o + 124) * 2 ** 32),
    });
  }
  const root = entries[0];
  if (!root || root.type !== 5) return null;

  // Streams under 4096 bytes live in the mini stream, in 64-byte pieces with a FAT of their own.
  const miniStream = root.size ? bigStream(root.start, root.size) : Buffer.alloc(0);
  if (!miniStream) return null;
  const nMiniFat = buf.readUInt32LE(64);
  const miniFatIds = nMiniFat ? chain(buf.readUInt32LE(60), fat, nMiniFat) : [];
  if (!miniFatIds || miniFatIds.length !== nMiniFat || miniFatIds.some((s) => !claim(s) || !whole(s))) return null;
  const miniFat = new Uint32Array(nMiniFat * perSector);
  miniFatIds.forEach((s, i) => {
    for (let j = 0; j < perSector; j++) miniFat[i * perSector + j] = buf.readUInt32LE(at(s) + j * 4);
  });
  const usedMini = new Uint8Array(miniFat.length);
  function miniStreamOf(start, size) {
    const n = Math.ceil(size / MINI);
    const c = chain(start, miniFat, n);
    if (!c || c.length !== n) return null;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const s = c[i];
      const need = i < n - 1 ? MINI : size - i * MINI;
      if (usedMini[s] || s * MINI + need > miniStream.length) return null;
      usedMini[s] = 1;
      parts.push(miniStream.subarray(s * MINI, s * MINI + need));
    }
    return Buffer.concat(parts);
  }

  // The directory is a tree of siblings (left, right) and children; each entry is visited once.
  const streams = new Map();
  const seen = new Uint8Array(entries.length);
  const stack = [[root.child, '']];
  while (stack.length) {
    const [id, prefix] = stack.pop();
    if (id === FREE) continue;
    if (id >= entries.length || seen[id]) return null;
    seen[id] = 1;
    const e = entries[id];
    if ((e.type !== 1 && e.type !== 2) || e.name === null) return null;
    const name = prefix + e.name;
    stack.push([e.left, prefix], [e.right, prefix]);
    if (e.type === 1) {
      stack.push([e.child, name + '/']);
      continue;
    }
    const data = e.size === 0 ? Buffer.alloc(0) : e.size < 4096 ? miniStreamOf(e.start, e.size) : bigStream(e.start, e.size);
    if (!data) return null;
    streams.set(name, data);
  }
  return streams;
}

// ---- Jump lists ------------------------------------------------------------------------------

/**
 * A DestList stream: { version, entries }, each entry { id, stream, time, pinned, count, path,
 * machine }, `stream` being the name of the stream that holds its link and `time` when it was
 * last opened, in ms. An empty stream has version null and no entries. Null for a version whose
 * layout is not known here, or entries that do not end exactly where the stream does.
 */
function parseDestList(b) {
  if (!b.length) return { version: null, entries: [] };
  if (b.length < 32) return null;
  const version = b.readUInt32LE(0);
  if (!DESTLIST_VERSIONS.has(version)) return null;
  const n = b.readUInt32LE(4);
  const lengthAt = version === 1 ? 0x70 : 0x80;
  const entries = [];
  let p = 32;
  for (let i = 0; i < n; i++) {
    if (p + lengthAt + 2 > b.length) return null;
    const chars = b.readUInt16LE(p + lengthAt);
    const end = p + lengthAt + 2 + chars * 2 + (version === 1 ? 0 : 4);
    if (end > b.length) return null;
    const id = b.readUInt32LE(p + 0x58);
    const pin = b.readInt32LE(p + 0x6c);
    const machine = cBytes(b, p + 0x48, p + 0x58);
    entries.push({
      id,
      stream: id.toString(16),
      time: filetimeToMs(b.readBigUInt64LE(p + 0x64)),
      pinned: pin !== -1,
      count: version === 1 ? null : b.readUInt32LE(p + 0x74),
      path: b.toString('utf16le', p + lengthAt + 2, p + lengthAt + 2 + chars * 2),
      machine: machine && machine.length && isAscii(machine) ? machine.toString('latin1') : null,
    });
    p = end;
  }
  return p === b.length ? { version, entries } : null;
}

/**
 * An automaticDestinations-ms file: { destList, links }. `destList` is as parseDestList() gives
 * it, or null when it is missing or not readable here; `links` has one { stream, entry, link }
 * for every stream named in hex, `entry` being the DestList entry for it (null when there is
 * none) and `link` the link it holds (null when it does not parse). Null when the file is not a
 * whole compound file.
 */
function parseJumpList(buf) {
  const streams = readCfb(buf);
  if (!streams) return null;
  const destList = streams.has('DestList') ? parseDestList(streams.get('DestList')) : null;
  const byStream = new Map(destList ? destList.entries.map((e) => [e.stream, e]) : []);
  const links = [];
  for (const [name, data] of streams) {
    if (!/^[0-9a-f]+$/.test(name)) continue;
    links.push({ stream: name, entry: byStream.get(name) || null, link: parseLink(data) });
  }
  return { destList, links };
}

/**
 * A customDestinations-ms file: { links, failed, footer }, every link found by its header and read
 * in turn, how many headers began something that did not parse, and whether the file ends in its
 * footer, as one cut short does not. Null when it is not one.
 */
function parseCustomDestinations(buf) {
  if (buf.length < 8 || buf.readUInt32LE(0) !== 2) return null;
  const head = Buffer.concat([Buffer.from([0x4c, 0, 0, 0]), LINK_CLSID]);
  const links = [];
  let failed = 0;
  for (let i = buf.indexOf(head); i >= 0; i = buf.indexOf(head, i)) {
    const link = parseLink(buf, i);
    if (link) {
      links.push(link);
      i += link.length;
    } else {
      failed++;
      i += head.length;
    }
  }
  return { links, failed, footer: buf.readUInt32LE(buf.length - 4) === CUSTOM_FOOTER };
}

// ---- ThumbnailCacheId ------------------------------------------------------------------------

/**
 * The extension as the shell's PathFindExtension finds it: from the last dot of the last name,
 * unless a space follows it; "" when there is none. Ordinary extensions, and "" for a name with
 * no dot, matched the thumbnail cache here; a dot followed by a space was never there to try.
 */
function extensionOf(name) {
  let dot = -1;
  const s = String(name);
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' || s[i] === '/' || s[i] === ' ') dot = -1;
    else if (s[i] === '.') dot = i;
  }
  return dot < 0 ? '' : s.slice(dot);
}

/** A GUID, "{...}" or anything holding one such as \\?\Volume{...}\, as its 16-byte structure; null if none. */
function guidBytes(guid) {
  if (Buffer.isBuffer(guid)) return guid.length === 16 ? guid : null;
  const m = /([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})/i.exec(String(guid));
  if (!m) return null;
  const out = Buffer.alloc(16);
  out.writeUInt32LE(parseInt(m[1], 16), 0);
  out.writeUInt16LE(parseInt(m[2], 16), 4);
  out.writeUInt16LE(parseInt(m[3], 16), 6);
  Buffer.from(m[4] + m[5], 'hex').copy(out, 8);
  return out;
}

/**
 * FileTimeToDosDateTime on a FILETIME, a BigInt, with no change of time zone: the time rounded up
 * to the next 2 seconds, as { date, time, back }, `back` being that time as a FILETIME. Null
 * outside 1980 to 2107, where Windows fails.
 */
function dosDateTime(ft) {
  if (typeof ft !== 'bigint' || ft < FILETIME_UNIX_OFFSET) return null;
  const back = ((ft - FILETIME_UNIX_OFFSET + TWO_SECONDS - 1n) / TWO_SECONDS) * TWO_SECONDS + FILETIME_UNIX_OFFSET;
  const d = new Date(Number((back - FILETIME_UNIX_OFFSET) / 10000n));
  const y = d.getUTCFullYear();
  if (y < 1980 || y > 2107) return null;
  const date = ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  return { date, time, back };
}

function mix(h, bytes) {
  for (let i = 0; i < bytes.length; i++) h ^= (h * 0x820n + BigInt(bytes[i]) + (h >> 2n)) & M64;
  return h;
}

// The hash after a volume's GUID, which every file on it starts from.
const volumeSeeds = new Map();
function volumeSeed(guid) {
  const key = guid.toString('hex');
  if (!volumeSeeds.has(key)) volumeSeeds.set(key, mix(CACHE_ID_SEED, guid));
  return volumeSeeds.get(key);
}

/**
 * The ThumbnailCacheId of a file, a BigInt, from its volume's GUID, its file ID (a BigInt), its
 * extension with the dot (spelled as it is; "" for none) and its last-write FILETIME (a BigInt, in
 * UTC). `precisionLoss` false leaves out step 5, for a cache written before Windows 8.1. Null
 * when the GUID cannot be read, the file ID is not known, or the time is outside 1980 to 2107.
 */
function thumbnailCacheId({ volumeGuid, fileRef, ext, writeTime }, { precisionLoss = true } = {}) {
  const guid = guidBytes(volumeGuid);
  if (!guid || fileRef == null || typeof writeTime !== 'bigint' || writeTime <= 0n) return null;
  const dos = dosDateTime(writeTime);
  if (!dos) return null;
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(BigInt(fileRef) & M64);
  let h = mix(volumeSeed(guid), id);
  h = mix(h, Buffer.from(String(ext || ''), 'utf16le'));
  const dt = Buffer.alloc(4);
  dt.writeUInt32LE(((dos.date << 16) | dos.time) >>> 0);
  h = mix(h, dt);
  if (precisionLoss) {
    // How far the time was rounded up, taken from the low halves as Windows takes it.
    const loss = Number(((dos.back & 0xffffffffn) - (writeTime & 0xffffffffn)) & 0xffffffffn);
    if (loss !== 0) {
      const lb = Buffer.alloc(4);
      lb.writeUInt32LE(loss);
      h = mix(h, lb);
    }
  }
  return h;
}

/**
 * The ThumbnailCacheIds a file may be cached under, one for each volume it may have been on:
 * [{ volumeGuid, id }]. `target` gives `fileRef` and `writeTime`, and `ext`, or a `name` or
 * `path` to take it from -- a link from parseLink() does. Empty when the file ID or last-write
 * time is not known.
 */
function cacheIdCandidates(target, volumeGuids, options) {
  if (!target || target.fileRef == null) return [];
  const ext = target.ext != null ? target.ext : extensionOf(target.name || (target.path && lastName(target.path)) || '');
  const out = [];
  for (const volumeGuid of volumeGuids || []) {
    const id = thumbnailCacheId({ volumeGuid, fileRef: target.fileRef, ext, writeTime: target.writeTime }, options);
    if (id != null) out.push({ volumeGuid, id });
  }
  return out;
}

/** The last-write FILETIME, a BigInt, from fs.statSync(p, { bigint: true }). */
function writeTimeOf(stat) {
  return stat.mtimeNs / 100n + FILETIME_UNIX_OFFSET;
}

/**
 * What mountvol.exe lists with no arguments: [{ guid, mounts }], each volume's GUID as "{...}" in
 * lowercase and the folders it is mounted at. Its other lines, in the language of the system, are
 * passed over.
 */
function volumesFromMountvol(text) {
  const out = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const vol = /^\s*\\\\\?\\Volume(\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\})\\\s*$/i.exec(line);
    if (vol) {
      current = { guid: vol[1].toLowerCase(), mounts: [] };
      out.push(current);
      continue;
    }
    const mount = /^\s+([a-z]:\\.*?)\s*$/i.exec(line);
    if (current && mount) current.mounts.push(mount[1]);
  }
  return out;
}

module.exports = {
  parseLink,
  readCfb,
  parseDestList,
  parseJumpList,
  parseCustomDestinations,
  extensionOf,
  guidBytes,
  dosDateTime,
  thumbnailCacheId,
  cacheIdCandidates,
  writeTimeOf,
  volumesFromMountvol,
  _internal: { shellItem, extensionBlock, linkInfo, fromAnsi, idListPath, trailingNames, pathOf, dosToMs, guidAt, mix },
};
