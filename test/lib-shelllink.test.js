'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseLink, readCfb, parseDestList, parseJumpList, parseCustomDestinations, extensionOf, guidBytes,
  dosDateTime, thumbnailCacheId, cacheIdCandidates, writeTimeOf, volumesFromMountvol,
} = require('../src/lib/shelllink');

// Links, jump lists and custom destinations are built here byte by byte, as Windows lays them out
// (see the top of src/lib/shelllink.js). Nothing is read from this machine and nothing is written:
// every parser takes bytes.

const LINK_CLSID = Buffer.from('0114020000000000c000000000000046', 'hex');
const MY_COMPUTER = '{20d04fe0-3aea-1069-a2d8-08002b30309d}';
const PROFILE = '{59031a47-3f72-44a7-89c5-5595fe6b30ee}';
const DELEGATE_CLSID = '{5e591a74-df96-48d3-8d67-1733bcee28ba}';
const VOLUME = '{00112233-4455-6677-8899-aabbccddeeff}';
const OTHER_VOLUME = '{8899aabb-ccdd-eeff-0011-223344556677}';

const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const wz = (s) => Buffer.from(s + '\0', 'utf16le');
const az = (s) => Buffer.concat([Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'), Buffer.from([0])]);
const FILETIME_OFFSET = 116444736000000000n;
const filetime = (iso, extra = 0n) => BigInt(Date.parse(iso)) * 10000n + FILETIME_OFFSET + extra;

/** A GUID as the structure Windows stores: u32, u16, u16 little-endian, then 8 bytes as written. */
function guid(s) {
  const h = s.replace(/[{}-]/g, '');
  const b = Buffer.from(h, 'hex');
  return Buffer.concat([Buffer.from(b.subarray(0, 4)).reverse(), Buffer.from(b.subarray(4, 6)).reverse(),
    Buffer.from(b.subarray(6, 8)).reverse(), b.subarray(8)]);
}

/** A DOS date and time as shell items hold them: UTC, rounded up to 2 seconds. */
function dos(iso) {
  const d = new Date(Math.ceil(Date.parse(iso) / 2000) * 2000);
  return Buffer.concat([
    u16(((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()),
    u16((d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1)),
  ]);
}

// ---- Shell items -----------------------------------------------------------------------------

const rootItem = (g) => Buffer.concat([u16(20), Buffer.from([0x1f, 0x50]), guid(g)]);
const driveItem = (letter) => {
  const b = Buffer.alloc(25);
  b.writeUInt16LE(25, 0);
  b[2] = 0x2f;
  b.write(`${letter}:\\`, 3, 'latin1');
  return b;
};
const uriItem = () => Buffer.concat([u16(12), Buffer.from([0x61, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);

/** A 0xBEEF0004 block of `version`, its own offset `at` as its last two bytes. */
function beef0004({ version = 9, fileRef = 0n, longName, localized }, at) {
  const parts = [u16(0), u16(version), u32(0xbeef0004), dos('2025-01-02T03:04:05Z'), dos('2026-01-02T03:04:05Z')];
  if (version >= 7) {
    parts.push(u16(0x2e), u16(0), u64(fileRef), u64(0), u16(localized ? 1 : 0));
    if (version >= 9) parts.push(u32(0));
    if (version >= 8) parts.push(u32(0));
  } else {
    parts.push(u16(0x14), u16(localized ? 1 : 0));
  }
  parts.push(wz(longName));
  if (localized) parts.push(wz(localized));
  parts.push(u16(at));
  const b = Buffer.concat(parts);
  b.writeUInt16LE(b.length, 0);
  return b;
}

/**
 * A file entry: 0x31 a folder, 0x32 a file, with 0x04 its name in UTF-16. `primary` is the item's
 * own name (the 8.3 name, for an ASCII one); the extension block holds the long name and file
 * reference. `after` adds another extension block behind it, as Windows sometimes does.
 */
function fileItem({ cls = 0x32, size = 0, mtime = '2026-09-01T10:00:00.5Z', primary, longName, fileRef = 0n, version = 9, after, block = true, localized }) {
  const head = Buffer.concat([u16(0), Buffer.from([cls, 0]), u32(size), dos(mtime), u16(0x20)]);
  let name = cls & 0x04 ? wz(primary) : az(primary);
  if ((head.length + name.length) % 2) name = Buffer.concat([name, Buffer.from([0])]);
  const at = head.length + name.length;
  const parts = [head, name];
  if (block) parts.push(beef0004({ version, fileRef, longName: longName || primary, localized }, at));
  if (after) parts.push(after, u16(at));
  const item = Buffer.concat(parts);
  item.writeUInt16LE(item.length, 0);
  return item;
}

/** A delegate item: "CFSF", a file entry with no extension block of its own, two GUIDs, then the block. */
function delegateItem({ primary, longName, fileRef = 0n }) {
  const inner = Buffer.concat([u16(0), Buffer.from([0x31, 0]), u32(0), dos('2026-09-01T10:00:00Z'), u16(0x10), az(primary)]);
  const sub = (inner.length % 2) ? Buffer.concat([inner, Buffer.from([0])]) : inner;
  sub.writeUInt16LE(sub.length, 0);
  const head = Buffer.concat([u16(0), Buffer.from([0x74, 0]), u16(sub.length + 6), Buffer.from('CFSF', 'latin1')]);
  const at = head.length + sub.length + 2 + 32;
  const item = Buffer.concat([head, sub, u16(0), guid(DELEGATE_CLSID), guid('{04731b67-d933-450a-90e6-4acd2e9408fe}'),
    beef0004({ fileRef, longName: longName || primary }, at)]);
  item.writeUInt16LE(item.length, 0);
  return item;
}

// ---- Links -----------------------------------------------------------------------------------

/** LinkInfo for a local path: ANSI bytes, and the Unicode path too when `unicode` is given. */
function localInfo({ serial = 0x1234abcd, driveType = 3, label = 'DATA', ansi, unicode, suffix = '' }) {
  const head = unicode != null ? 0x24 : 0x1c;
  const vol = Buffer.concat([u32(0), u32(driveType), u32(serial), u32(0x10), az(label)]);
  vol.writeUInt32LE(vol.length, 0);
  const base = az(ansi);
  const suf = az(suffix);
  const volAt = head;
  const baseAt = volAt + vol.length;
  const sufAt = baseAt + base.length;
  const tail = [];
  let uAt = 0;
  let uSufAt = 0;
  if (unicode != null) {
    uAt = sufAt + suf.length;
    tail.push(wz(unicode));
    uSufAt = uAt + tail[0].length;
    tail.push(wz(suffix));
  }
  const header = Buffer.concat([u32(0), u32(head), u32(1), u32(volAt), u32(baseAt), u32(0), u32(sufAt),
    ...(unicode != null ? [u32(uAt), u32(uSufAt)] : [])]);
  const info = Buffer.concat([header, vol, base, suf, ...tail]);
  info.writeUInt32LE(info.length, 0);
  return info;
}

/** LinkInfo for a file on a share. */
function netInfo({ share, suffix }) {
  const net = Buffer.concat([u32(0), u32(2), u32(0x14), u32(0), u32(0x20000), az(share)]);
  net.writeUInt32LE(net.length, 0);
  const netAt = 0x1c;
  const sufAt = netAt + net.length;
  const info = Buffer.concat([u32(0), u32(0x1c), u32(2), u32(0), u32(0), u32(netAt), u32(sufAt), net, az(suffix)]);
  info.writeUInt32LE(info.length, 0);
  return info;
}

const tracker = (machine) => {
  const name = Buffer.alloc(16);
  name.write(machine, 'latin1');
  return Buffer.concat([u32(0x60), u32(0xa0000003), u32(0x58), u32(0), name, Buffer.alloc(64)]);
};

/**
 * A shell link. `items` is the ID list, `info` LinkInfo, `strings` the string data (Unicode), and
 * `extra` extra data blocks before the terminal one.
 */
function link({ items, info, strings = {}, extra = [], write = filetime('2026-09-01T10:00:00.5Z'), size = 12345, attributes = 0x20 }) {
  let flags = 0x80;
  const parts = [];
  if (items) {
    flags |= 0x1;
    const list = Buffer.concat([...items, u16(0)]);
    parts.push(u16(list.length), list);
  }
  if (info) {
    flags |= 0x2;
    parts.push(info);
  }
  for (const [bit, key] of [[0x4, 'description'], [0x8, 'relativePath'], [0x10, 'workingDir'], [0x20, 'arguments'], [0x40, 'iconLocation']]) {
    if (strings[key] == null) continue;
    flags |= bit;
    parts.push(u16(strings[key].length), Buffer.from(strings[key], 'utf16le'));
  }
  const header = Buffer.concat([u32(0x4c), LINK_CLSID, u32(flags), u32(attributes),
    u64(filetime('2025-05-05T05:05:05Z')), u64(filetime('2026-09-02T00:00:00Z')), u64(write), u32(size),
    u32(0), u32(1), u16(0), u16(0), u32(0), u32(0)]);
  return Buffer.concat([header, ...parts, ...extra, u32(0)]);
}

/** A photo two folders down on C:, its file reference 0x0005000000001234. */
function photoLink(over = {}) {
  return link({
    items: [
      rootItem(MY_COMPUTER), driveItem('C'),
      fileItem({ cls: 0x31, primary: 'PHOTOS', longName: 'Photos', fileRef: 0x0001000000000100n }),
      fileItem({ cls: 0x35, primary: 'Trip 2026', fileRef: 0x0001000000000200n }),
      fileItem({ primary: 'IMG_00~1.JPG', longName: 'IMG_0001.JPG', size: 12345, fileRef: 0x0005000000001234n }),
    ],
    info: localInfo({ ansi: 'C:\\Photos\\Trip 2026\\IMG_0001.JPG' }),
    strings: { relativePath: '..\\..\\Photos\\Trip 2026\\IMG_0001.JPG', workingDir: 'C:\\Photos\\Trip 2026' },
    extra: [tracker('DESKTOP-01')],
    ...over,
  });
}

test('parseLink reads the header, the ID list, LinkInfo, the strings and the tracker block', () => {
  const buf = photoLink();
  const l = parseLink(buf);
  assert.ok(l);
  assert.strictEqual(l.length, buf.length);
  assert.strictEqual(l.path, 'C:\\Photos\\Trip 2026\\IMG_0001.JPG');
  assert.strictEqual(l.name, 'IMG_0001.JPG');
  assert.strictEqual(l.size, 12345);
  assert.strictEqual(l.isDir, false);
  assert.strictEqual(l.writeTime, filetime('2026-09-01T10:00:00.5Z'));
  assert.strictEqual(l.modified, Date.parse('2026-09-01T10:00:00.5Z'));
  assert.strictEqual(l.created, Date.parse('2025-05-05T05:05:05Z'));
  assert.strictEqual(l.fileRef, 0x0005000000001234n);
  assert.strictEqual(l.serial, 0x1234abcd);
  assert.strictEqual(l.driveType, 3);
  assert.strictEqual(l.label, 'DATA');
  assert.strictEqual(l.machine, 'DESKTOP-01');
  assert.strictEqual(l.relativePath, '..\\..\\Photos\\Trip 2026\\IMG_0001.JPG');
  assert.strictEqual(l.workingDir, 'C:\\Photos\\Trip 2026');
  assert.deepStrictEqual(l.items.map((i) => i.kind), ['root', 'drive', 'file', 'file', 'file']);
  assert.strictEqual(l.items[0].guid, MY_COMPUTER);
  assert.strictEqual(l.items[1].name, 'C:\\');
  const last = l.items[4];
  assert.strictEqual(last.name, 'IMG_0001.JPG', 'the long name, not the 8.3 one');
  assert.strictEqual(last.size, 12345);
  // Shell items round the write time up to 2 seconds.
  assert.strictEqual(last.mtime, Date.parse('2026-09-01T10:00:02Z'));
  assert.strictEqual(last.created, Date.parse('2025-01-02T03:04:06Z'));
  assert.strictEqual(last.extVersion, 9);
  assert.strictEqual(l.items[3].name, 'Trip 2026', 'a UTF-16 item name');
  assert.strictEqual(l.items[3].isDir, true);
});

test('the ID list alone gives the path when it runs from My Computer through a drive', () => {
  const l = parseLink(photoLink({ info: null }));
  assert.strictEqual(l.path, 'C:\\Photos\\Trip 2026\\IMG_0001.JPG');
  assert.strictEqual(l.serial, null);
  // From a known folder, whose place the link does not hold, there is no path; the name stays.
  const known = parseLink(link({ items: [rootItem(PROFILE), fileItem({ primary: 'a.txt', fileRef: 7n })] }));
  assert.strictEqual(known.path, null);
  assert.strictEqual(known.name, 'a.txt');
  assert.strictEqual(known.fileRef, 7n);
});

test('an ANSI path that is not ASCII is rebuilt with the names the ID list ends in', () => {
  // "사진" in some double-byte code page; which one does not matter.
  const folder = Buffer.from([0xbb, 0xe7, 0xc1, 0xf8]);
  const ansi = Buffer.concat([Buffer.from('C:\\Users\\me\\', 'latin1'), folder, Buffer.from('\\a.jpg', 'latin1')]);
  const items = [rootItem(PROFILE), fileItem({ cls: 0x35, primary: '사진' }), fileItem({ primary: 'a.jpg', fileRef: 9n })];
  const l = parseLink(link({ items, info: localInfo({ ansi }) }));
  assert.strictEqual(l.path, 'C:\\Users\\me\\사진\\a.jpg');
  assert.strictEqual(l.name, 'a.jpg');

  // Names that disagree where both are ASCII: no path, rather than a guess.
  const wrong = [rootItem(PROFILE), fileItem({ cls: 0x35, primary: '사진' }), fileItem({ primary: 'b.jpg' })];
  const w = parseLink(link({ items: wrong, info: localInfo({ ansi }) }));
  assert.strictEqual(w.path, null);
  assert.strictEqual(w.name, 'b.jpg');

  // A code page whose second byte can be a backslash splits the path into more names than there are.
  const split = Buffer.concat([Buffer.from('C:\\Users\\me\\', 'latin1'), Buffer.from([0x95, 0x5c]), Buffer.from('\\a.jpg', 'latin1')]);
  const s = parseLink(link({ items: [rootItem(PROFILE), fileItem({ cls: 0x35, primary: '表' }), fileItem({ primary: 'a.jpg' })], info: localInfo({ ansi: split }) }));
  assert.strictEqual(s.path, null);

  // Leading folders that are not ASCII cannot be rebuilt either.
  const lead = Buffer.concat([Buffer.from('C:\\Users\\', 'latin1'), folder, Buffer.from('\\a.jpg', 'latin1')]);
  const t = parseLink(link({ items: [rootItem(PROFILE), fileItem({ primary: 'a.jpg' })], info: localInfo({ ansi: lead }) }));
  assert.strictEqual(t.path, null);
});

test('a Unicode LinkInfo path and a share are read as they are', () => {
  const u = parseLink(link({ items: [rootItem(PROFILE), fileItem({ primary: 'x.png' })],
    info: localInfo({ ansi: 'C:\\??\\x.png', unicode: 'C:\\사진\\x.png' }) }));
  assert.strictEqual(u.path, 'C:\\사진\\x.png');
  const n = parseLink(link({ info: netInfo({ share: '\\\\server\\share', suffix: 'dir\\f.txt' }) }));
  assert.strictEqual(n.path, '\\\\server\\share\\dir\\f.txt');
  assert.strictEqual(n.name, 'f.txt');
  assert.strictEqual(n.serial, null);
});

test('the file reference is the last item\'s, and only when that is a file entry', () => {
  const l = parseLink(link({ items: [rootItem(MY_COMPUTER), driveItem('C'), fileItem({ cls: 0x31, primary: 'D', fileRef: 5n }), uriItem()] }));
  assert.ok(l);
  assert.strictEqual(l.fileRef, null);
  assert.strictEqual(l.items[3].kind, 'other');
  // Version 3 (XP) has a long name and no file reference.
  const xp = parseLink(link({ items: [rootItem(PROFILE), fileItem({ primary: 'LONGNA~1.TXT', longName: 'long name.txt', version: 3 })] }));
  assert.strictEqual(xp.name, 'long name.txt');
  assert.strictEqual(xp.fileRef, null);
  // Version 7 and 8 put the long name at 38 and 42.
  for (const version of [7, 8]) {
    const v = parseLink(link({ items: [rootItem(PROFILE), fileItem({ primary: 'A~1.JPG', longName: 'a picture.jpg', fileRef: 11n, version })] }));
    assert.strictEqual(v.name, 'a picture.jpg', `version ${version}`);
    assert.strictEqual(v.fileRef, 11n, `version ${version}`);
  }
  // A localized name after the long name does not change it.
  const loc = parseLink(link({ items: [rootItem(PROFILE), fileItem({ primary: 'PICTUR~1', longName: 'Pictures', localized: '@shell32.dll,-21779', cls: 0x31 })] }));
  assert.strictEqual(loc.name, 'Pictures');
});

test('an extension block followed by another is still found by the offset the item ends in', () => {
  const second = Buffer.concat([u16(28), u16(0), u32(0xbeef0026), Buffer.from('extra\0\0\0\0', 'utf16le').subarray(0, 18), u16(0)]);
  const l = parseLink(link({ items: [rootItem(PROFILE), fileItem({ primary: 'LONGFI~1.PNG', longName: 'long file name.png', fileRef: 42n, after: second })] }));
  assert.strictEqual(l.name, 'long file name.png');
  assert.strictEqual(l.fileRef, 42n);
  // Without its block the item's own name is all there is.
  const bare = parseLink(link({ items: [rootItem(PROFILE), fileItem({ primary: 'SHORT.TXT', block: false })] }));
  assert.strictEqual(bare.name, 'SHORT.TXT');
  assert.strictEqual(bare.fileRef, null);
});

test('a delegate item holds a file entry', () => {
  const l = parseLink(link({ items: [rootItem(PROFILE), delegateItem({ primary: 'Pictures', fileRef: 77n }), fileItem({ primary: 'b.gif', fileRef: 78n })] }));
  assert.strictEqual(l.items[1].kind, 'file');
  assert.strictEqual(l.items[1].name, 'Pictures');
  assert.strictEqual(l.items[1].fileRef, 77n);
  assert.strictEqual(l.items[1].isDir, true);
  assert.strictEqual(l.fileRef, 78n);
});

test('a link cut short anywhere, or damaged, is not a link, and nothing throws', () => {
  const buf = photoLink();
  for (let n = 0; n < buf.length; n++) assert.strictEqual(parseLink(buf.subarray(0, n)), null, `cut at ${n}`);
  assert.strictEqual(parseLink(Buffer.concat([buf.subarray(0, 4), Buffer.alloc(16), buf.subarray(20)])), null, 'no CLSID');
  // An ID list that does not end at its terminator.
  const bad = Buffer.from(buf);
  bad.writeUInt16LE(bad.readUInt16LE(0x4c) + 2, 0x4c);
  assert.strictEqual(parseLink(bad), null);
  // Random damage: whatever comes back, it is a link or null.
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 2000; i++) {
    const b = Buffer.from(buf);
    for (let k = 0; k < 3; k++) b[rand() % b.length] = rand() & 0xff;
    const l = parseLink(b);
    assert.ok(l === null || typeof l.length === 'number');
  }
});

test('links laid one after another are read in turn from an offset', () => {
  const a = photoLink();
  const b = link({ items: [rootItem(PROFILE), fileItem({ primary: 'n.txt' })] });
  const both = Buffer.concat([a, b]);
  const first = parseLink(both);
  assert.strictEqual(first.length, a.length);
  const second = parseLink(both, first.length);
  assert.strictEqual(second.name, 'n.txt');
  assert.strictEqual(second.length, b.length);
});

// ---- Compound files and jump lists -----------------------------------------------------------

const FREE = 0xffffffff;
const END = 0xfffffffe;

/**
 * A version 3 compound file with 512-byte sectors holding `streams` ([name, bytes], in order):
 * those under 4096 bytes in the mini stream, the rest in sectors of their own, laid out last. One
 * FAT sector, so it holds up to 128 sectors.
 */
function compoundFile(streams) {
  const SS = 512;
  const miniFat = [];
  const miniParts = [];
  const starts = new Map();
  for (const [name, data] of streams) {
    if (data.length >= 4096 || !data.length) continue;
    const n = Math.ceil(data.length / 64);
    starts.set(name, miniFat.length);
    for (let i = 0; i < n; i++) miniFat.push(i < n - 1 ? miniFat.length + 1 : END);
    const padded = Buffer.alloc(n * 64);
    data.copy(padded);
    miniParts.push(padded);
  }
  const miniStream = Buffer.concat(miniParts);
  const fat = [];
  const sectors = [];
  const place = (data) => {
    const n = Math.max(1, Math.ceil(data.length / SS));
    const start = fat.length;
    for (let i = 0; i < n; i++) {
      fat.push(i < n - 1 ? fat.length + 1 : END);
      const s = Buffer.alloc(SS);
      data.copy(s, 0, i * SS, Math.min(data.length, (i + 1) * SS));
      sectors.push(s);
    }
    return start;
  };
  fat.push(0xfffffffd);
  sectors.push(null); // the FAT itself, filled in last
  const dir = Buffer.alloc(Math.ceil((streams.length + 1) / 4) * 512);
  const dirStart = place(dir);
  const miniFatBuf = Buffer.concat(miniFat.map((x) => u32(x)));
  const miniFatStart = miniFat.length ? place(miniFatBuf) : END;
  const miniStart = miniStream.length ? place(miniStream) : END;
  for (const [name, data] of streams) if (data.length >= 4096) starts.set(name, place(data));
  const entry = (i, name, type, start, size, right, child = FREE) => {
    const o = i * 128;
    dir.write(name, o, 'utf16le');
    dir.writeUInt16LE((name.length + 1) * 2, o + 64);
    dir[o + 66] = type;
    dir.writeUInt32LE(FREE, o + 68);
    dir.writeUInt32LE(right, o + 72);
    dir.writeUInt32LE(child, o + 76);
    dir.writeUInt32LE(start, o + 116);
    dir.writeUInt32LE(size, o + 120);
  };
  entry(0, 'Root Entry', 5, miniStart, miniStream.length, FREE, streams.length ? 1 : FREE);
  streams.forEach(([name, data], i) => {
    entry(i + 1, name, 2, data.length ? starts.get(name) : END, data.length, i + 1 < streams.length ? i + 2 : FREE);
  });
  // The directory was placed before it was filled in; copy it into its sectors now.
  for (let i = 0; i < dir.length / SS; i++) dir.copy(sectors[dirStart + i], 0, i * SS, (i + 1) * SS);
  const fatSector = Buffer.alloc(SS, 0xff);
  fat.forEach((x, i) => fatSector.writeUInt32LE(x, i * 4));
  sectors[0] = fatSector;
  const header = Buffer.alloc(512);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header, 0);
  header.writeUInt16LE(0x3e, 24);
  header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(1, 44);
  header.writeUInt32LE(dirStart, 48);
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(miniFatStart, 60);
  header.writeUInt32LE(miniFat.length ? Math.ceil(miniFatBuf.length / SS) : 0, 64);
  header.writeUInt32LE(END, 68);
  header.writeUInt32LE(0, 72);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i === 0 ? 0 : FREE, 76 + i * 4);
  return Buffer.concat([header, ...sectors]);
}

/** A DestList stream: version 6 (Windows 10 and 11) or 1 (Windows 7 and 8). */
function destList(entries, version = 6) {
  const parts = [u32(version), u32(entries.length), u32(entries.filter((e) => e.pin != null).length), u32(0), u64(0), u64(0)];
  for (const e of entries) {
    const head = Buffer.alloc(version === 1 ? 0x72 : 0x82);
    head.write(e.machine || 'desktop-01', 0x48, 'latin1');
    head.writeUInt32LE(e.id, 0x58);
    head.writeBigUInt64LE(filetime(e.time), 0x64);
    head.writeInt32LE(e.pin == null ? -1 : e.pin, 0x6c);
    if (version === 1) {
      head.writeUInt16LE(e.path.length, 0x70);
    } else {
      head.writeInt32LE(-1, 0x70);
      head.writeUInt32LE(e.count || 1, 0x74);
      head.writeUInt16LE(e.path.length, 0x80);
    }
    parts.push(head, Buffer.from(e.path, 'utf16le'));
    if (version !== 1) parts.push(u32(0));
  }
  return Buffer.concat(parts);
}

test('readCfb reads streams from the mini stream and from whole sectors', () => {
  const big = Buffer.alloc(5000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
  const small = Buffer.from('a small stream of a few bytes');
  const file = compoundFile([['1', small], ['empty', Buffer.alloc(0)], ['big', big]]);
  const s = readCfb(file);
  assert.ok(s);
  assert.deepStrictEqual([...s.keys()].sort(), ['1', 'big', 'empty']);
  assert.ok(s.get('1').equals(small));
  assert.ok(s.get('big').equals(big));
  assert.strictEqual(s.get('empty').length, 0);
});

test('readCfb takes a last sector cut short only where nothing in it is used', () => {
  const big = Buffer.alloc(5000, 1);
  const file = compoundFile([['1', Buffer.from('x')], ['big', big]]);
  // The big stream is last and needs 5000 - 9 * 512 = 392 bytes of its last sector.
  assert.ok(readCfb(file.subarray(0, file.length - 120)), 'cut into unused bytes');
  assert.strictEqual(readCfb(file.subarray(0, file.length - 121)), null, 'cut into the stream');
  assert.strictEqual(readCfb(file.subarray(0, 511)), null);
});

test('readCfb refuses a chain that loops, a sector used twice and a directory that is not a tree', () => {
  const file = compoundFile([['1', Buffer.from('x')], ['big', Buffer.alloc(5000, 2)]]);
  const fatAt = 512;
  // The big stream's chain; make its last sector point back to its first.
  const s = readCfb(file);
  assert.ok(s);
  const loop = Buffer.from(file);
  let first = -1;
  for (let i = 0; i < 128; i++) if (loop.readUInt32LE(fatAt + i * 4) === END) first = i;
  loop.writeUInt32LE(first - 9, fatAt + first * 4);
  assert.strictEqual(readCfb(loop), null);
  // A directory entry that is its own sibling.
  const dirStart = file.readUInt32LE(48);
  const cyc = Buffer.from(file);
  cyc.writeUInt32LE(1, 512 * (dirStart + 1) + 128 + 72);
  assert.strictEqual(readCfb(cyc), null);
  // Two streams starting at the same sector.
  const twice = compoundFile([['a', Buffer.alloc(4096, 3)], ['b', Buffer.alloc(4096, 4)]]);
  const d = 512 * (twice.readUInt32LE(48) + 1);
  twice.writeUInt32LE(twice.readUInt32LE(d + 128 + 116), d + 256 + 116);
  assert.strictEqual(readCfb(twice), null);
  // Not a compound file at all.
  assert.strictEqual(readCfb(Buffer.alloc(4096)), null);
});

test('parseDestList reads version 6 and version 1 entries, and nothing else', () => {
  const entries = [
    { id: 1, time: '2026-09-01T00:00:00Z', path: 'C:\\Photos\\a.jpg', count: 3 },
    { id: 0x1f, time: '2026-09-02T00:00:00Z', path: 'D:\\b.mp4', pin: 0, machine: 'laptop' },
  ];
  const d = parseDestList(destList(entries));
  assert.strictEqual(d.version, 6);
  assert.deepStrictEqual(d.entries.map((e) => e.stream), ['1', '1f']);
  assert.deepStrictEqual(d.entries.map((e) => e.path), ['C:\\Photos\\a.jpg', 'D:\\b.mp4']);
  assert.deepStrictEqual(d.entries.map((e) => e.pinned), [false, true]);
  assert.deepStrictEqual(d.entries.map((e) => e.count), [3, 1]);
  assert.deepStrictEqual(d.entries.map((e) => e.machine), ['desktop-01', 'laptop']);
  assert.strictEqual(d.entries[0].time, Date.parse('2026-09-01T00:00:00Z'));

  const v1 = parseDestList(destList(entries, 1));
  assert.strictEqual(v1.version, 1);
  assert.deepStrictEqual(v1.entries.map((e) => e.path), ['C:\\Photos\\a.jpg', 'D:\\b.mp4']);
  assert.deepStrictEqual(v1.entries.map((e) => e.count), [null, null]);

  assert.deepStrictEqual(parseDestList(Buffer.alloc(0)), { version: null, entries: [] });
  assert.deepStrictEqual(parseDestList(destList([])), { version: 6, entries: [] });
  for (const version of [2, 7]) assert.strictEqual(parseDestList(destList(entries, version)), null, `version ${version}`);
  const good = destList(entries);
  assert.strictEqual(parseDestList(Buffer.concat([good, Buffer.alloc(1)])), null, 'more than the entries');
  assert.strictEqual(parseDestList(good.subarray(0, good.length - 1)), null, 'cut short');
});

test('parseJumpList pairs each link stream with its DestList entry', () => {
  const photo = photoLink();
  const other = link({ items: [rootItem(PROFILE), fileItem({ primary: 'n.txt' })] });
  const list = destList([
    { id: 1, time: '2026-09-01T00:00:00Z', path: 'C:\\Photos\\Trip 2026\\IMG_0001.JPG' },
    { id: 10, time: '2026-09-03T00:00:00Z', path: 'C:\\gone.txt' },
  ]);
  const file = compoundFile([['DestList', list], ['1', photo], ['a', other], ['2', Buffer.from('not a link')],
    ['DestListPropertyStore', Buffer.alloc(4)]]);
  const j = parseJumpList(file);
  assert.strictEqual(j.destList.version, 6);
  const byStream = Object.fromEntries(j.links.map((l) => [l.stream, l]));
  assert.deepStrictEqual(Object.keys(byStream).sort(), ['1', '2', 'a']);
  assert.strictEqual(byStream['1'].entry.path, byStream['1'].link.path);
  assert.strictEqual(byStream['a'].entry.time, Date.parse('2026-09-03T00:00:00Z'));
  assert.strictEqual(byStream['a'].link.name, 'n.txt');
  assert.strictEqual(byStream['2'].entry, null);
  assert.strictEqual(byStream['2'].link, null);

  // A stream with bytes after its link still gives the link, as 81 of 651 did on Windows 11.
  const trailing = compoundFile([['1', Buffer.concat([photo, Buffer.alloc(40, 9)])]]);
  const t = parseJumpList(trailing);
  assert.strictEqual(t.destList, null);
  assert.strictEqual(t.links[0].link.path, 'C:\\Photos\\Trip 2026\\IMG_0001.JPG');
  assert.strictEqual(parseJumpList(Buffer.alloc(1024)), null);
});

test('damaged jump lists and DestLists come back as null or as what still holds, never as a throw', () => {
  const list = destList([{ id: 1, time: '2026-09-01T00:00:00Z', path: 'C:\\a.jpg' }, { id: 2, time: '2026-09-02T00:00:00Z', path: 'C:\\b.jpg' }]);
  const file = compoundFile([['DestList', list], ['1', photoLink()], ['2', Buffer.alloc(5000, 5)]]);
  let seed = 11;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 1000; i++) {
    const f = Buffer.from(file);
    for (let k = 0; k < 4; k++) f[rand() % f.length] = rand() & 0xff;
    const j = parseJumpList(f);
    assert.ok(j === null || Array.isArray(j.links));
    const d = Buffer.from(list);
    d[rand() % d.length] = rand() & 0xff;
    const p = parseDestList(d);
    assert.ok(p === null || Array.isArray(p.entries));
  }
});

test('parseCustomDestinations reads every link in turn, past one that does not parse', () => {
  const a = photoLink();
  const b = link({ items: [rootItem(PROFILE), fileItem({ primary: 'n.txt' })] });
  const broken = Buffer.concat([u32(0x4c), LINK_CLSID, Buffer.alloc(10)]);
  const file = Buffer.concat([u32(2), u32(1), u32(0), u32(0), LINK_CLSID, a, LINK_CLSID, broken, LINK_CLSID, b, u32(0xbabffbab)]);
  const c = parseCustomDestinations(file);
  assert.deepStrictEqual(c.links.map((l) => l.name), ['IMG_0001.JPG', 'n.txt']);
  assert.strictEqual(c.failed, 1);
  assert.strictEqual(c.footer, true);
  assert.strictEqual(parseCustomDestinations(file.subarray(0, file.length - 4)).footer, false);
  assert.strictEqual(parseCustomDestinations(Buffer.concat([u32(3), a])), null);
});

// ---- ThumbnailCacheId ------------------------------------------------------------------------

/** The hash as specified, written independently: the DOS time rounded up, then how far it was. */
function referenceId(volume, fileRef, ext, ft, loss = true) {
  const M = (1n << 64n) - 1n;
  let h = 0x95e729ba2c37fd21n;
  const feed = (bytes) => {
    for (const x of bytes) h = BigInt.asUintN(64, h ^ BigInt.asUintN(64, h * 2080n + BigInt(x) + (h >> 2n)));
  };
  const rem = (ft - FILETIME_OFFSET) % 20000000n;
  const up = rem ? ft + 20000000n - rem : ft;
  const d = new Date(Number((up - FILETIME_OFFSET) / 10000n));
  feed(guid(volume));
  feed(u64(fileRef));
  feed(Buffer.from(ext, 'utf16le'));
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  feed(u32(((date << 16) | time) >>> 0));
  const lost = Number((up & 0xffffffffn) - (ft & 0xffffffffn) & 0xffffffffn);
  if (loss && lost) feed(u32(lost));
  return h & M;
}

test('thumbnailCacheId hashes the GUID, file ID, extension as spelled, and the rounded-up DOS time', () => {
  const fileRef = 0x0005000000001234n;
  const aligned = filetime('2026-09-28T12:34:56Z');
  const off = filetime('2026-09-28T12:34:57.123Z', 4567n);
  // Regression values, from the implementation checked against this machine's thumbnail cache.
  assert.strictEqual(thumbnailCacheId({ volumeGuid: VOLUME, fileRef, ext: '.png', writeTime: aligned }), 0xfb23c1a0f0f8bd28n);
  assert.strictEqual(thumbnailCacheId({ volumeGuid: VOLUME, fileRef, ext: '.png', writeTime: off }), 0x351260f4251a759fn);
  assert.strictEqual(thumbnailCacheId({ volumeGuid: VOLUME, fileRef, ext: '.png', writeTime: off }, { precisionLoss: false }), 0xfb23c1a2097c38bbn);
  assert.strictEqual(thumbnailCacheId({ volumeGuid: VOLUME, fileRef, ext: '.PNG', writeTime: off }), 0xe7773816246640c3n);
  assert.strictEqual(thumbnailCacheId({ volumeGuid: VOLUME, fileRef, ext: '', writeTime: off }), 0x4e8a6cf69c931dben);
  // The same as the specification, written another way.
  for (const [ext, ft] of [['.png', aligned], ['.png', off], ['.JPG', off], ['', off], ['.heic', filetime('1999-12-31T23:59:59.999Z', 9999n)]]) {
    assert.strictEqual(thumbnailCacheId({ volumeGuid: VOLUME, fileRef, ext, writeTime: ft }), referenceId(VOLUME, fileRef, ext, ft), `${ext} ${ft}`);
    assert.strictEqual(thumbnailCacheId({ volumeGuid: VOLUME, fileRef, ext, writeTime: ft }, { precisionLoss: false }),
      referenceId(VOLUME, fileRef, ext, ft, false));
  }
  // On the 2-second grid step 5 adds nothing; off it, it changes the key. The case of the extension counts.
  assert.strictEqual(thumbnailCacheId({ volumeGuid: VOLUME, fileRef, ext: '.png', writeTime: aligned }, { precisionLoss: false }),
    thumbnailCacheId({ volumeGuid: VOLUME, fileRef, ext: '.png', writeTime: aligned }));
  assert.notStrictEqual(thumbnailCacheId({ volumeGuid: OTHER_VOLUME, fileRef, ext: '.png', writeTime: off }),
    thumbnailCacheId({ volumeGuid: VOLUME, fileRef, ext: '.png', writeTime: off }));
  // What cannot be hashed.
  assert.strictEqual(thumbnailCacheId({ volumeGuid: VOLUME, fileRef: null, ext: '.png', writeTime: off }), null);
  assert.strictEqual(thumbnailCacheId({ volumeGuid: VOLUME, fileRef, ext: '.png', writeTime: 0n }), null);
  assert.strictEqual(thumbnailCacheId({ volumeGuid: 'not a guid', fileRef, ext: '.png', writeTime: off }), null);
  assert.strictEqual(thumbnailCacheId({ volumeGuid: VOLUME, fileRef, ext: '.png', writeTime: filetime('1979-12-31T23:59:58Z') }), null);
  assert.strictEqual(thumbnailCacheId({ volumeGuid: VOLUME, fileRef, ext: '.png', writeTime: filetime('2107-12-31T23:59:59.5Z') }), null);
});

test('dosDateTime rounds up to the next 2 seconds, across a day and a year, and fails outside 1980 to 2107', () => {
  const at = (iso, extra) => dosDateTime(filetime(iso, extra));
  const fields = (r) => r && [1980 + (r.date >> 9), (r.date >> 5) & 15, r.date & 31, r.time >> 11, (r.time >> 5) & 63, (r.time & 31) * 2];
  assert.deepStrictEqual(fields(at('2026-09-28T12:34:56Z')), [2026, 9, 28, 12, 34, 56]);
  assert.deepStrictEqual(fields(at('2026-09-28T12:34:56Z', 1n)), [2026, 9, 28, 12, 34, 58]);
  assert.deepStrictEqual(fields(at('2026-09-28T12:34:57Z')), [2026, 9, 28, 12, 34, 58]);
  assert.deepStrictEqual(fields(at('2025-12-31T23:59:59.001Z')), [2026, 1, 1, 0, 0, 0]);
  assert.strictEqual(at('2026-09-28T12:34:57Z').back, filetime('2026-09-28T12:34:58Z'));
  assert.deepStrictEqual(fields(at('1980-01-01T00:00:00Z')), [1980, 1, 1, 0, 0, 0]);
  assert.strictEqual(at('1979-12-31T23:59:58Z'), null);
  assert.deepStrictEqual(fields(at('2107-12-31T23:59:58Z')), [2107, 12, 31, 23, 59, 58]);
  assert.strictEqual(at('2107-12-31T23:59:58Z', 1n), null);
  assert.strictEqual(dosDateTime(0n), null);
});

test('cacheIdCandidates gives one key for each volume, from what a link records', () => {
  const l = parseLink(photoLink());
  const c = cacheIdCandidates(l, [VOLUME, OTHER_VOLUME]);
  assert.deepStrictEqual(c.map((x) => x.volumeGuid), [VOLUME, OTHER_VOLUME]);
  assert.strictEqual(c[0].id, thumbnailCacheId({ volumeGuid: VOLUME, fileRef: 0x0005000000001234n, ext: '.JPG', writeTime: l.writeTime }));
  // A cache holding that key names the thumbnail; with the extension lower-cased it would not.
  const cache = new Set([c[0].id]);
  assert.ok(cacheIdCandidates(l, [VOLUME]).some((x) => cache.has(x.id)));
  assert.ok(!cacheIdCandidates({ ...l, ext: '.jpg' }, [VOLUME]).some((x) => cache.has(x.id)));
  // From a path, or with nothing to hash.
  const byPath = cacheIdCandidates({ path: 'D:\\x\\y.Png', fileRef: 3n, writeTime: l.writeTime }, [VOLUME]);
  assert.strictEqual(byPath[0].id, thumbnailCacheId({ volumeGuid: VOLUME, fileRef: 3n, ext: '.Png', writeTime: l.writeTime }));
  assert.deepStrictEqual(cacheIdCandidates({ ...l, fileRef: null }, [VOLUME]), []);
  assert.deepStrictEqual(cacheIdCandidates({ ...l, writeTime: 0n }, [VOLUME]), []);
  assert.deepStrictEqual(cacheIdCandidates(l, []), []);
});

test('extensionOf finds the extension as the shell does', () => {
  assert.strictEqual(extensionOf('IMG_0001.JPG'), '.JPG');
  assert.strictEqual(extensionOf('archive.tar.gz'), '.gz');
  assert.strictEqual(extensionOf('README'), '');
  assert.strictEqual(extensionOf('.gitignore'), '.gitignore');
  assert.strictEqual(extensionOf('v1.2 notes'), '');
  assert.strictEqual(extensionOf('C:\\a.b\\c'), '');
  assert.strictEqual(extensionOf('C:\\a\\photo.heic'), '.heic');
});

test('guidBytes, writeTimeOf and volumesFromMountvol', () => {
  assert.strictEqual(guidBytes('{0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9}').toString('hex'), '3d2c1b0a5f4e71608293a4b5c6d7e8f9');
  assert.strictEqual(guidBytes('\\\\?\\Volume{0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9}\\').toString('hex'), '3d2c1b0a5f4e71608293a4b5c6d7e8f9');
  const raw = Buffer.alloc(16, 1);
  assert.strictEqual(guidBytes(raw), raw);
  assert.strictEqual(guidBytes(Buffer.alloc(15)), null);
  assert.strictEqual(guidBytes('{0a1b2c3d}'), null);

  const ft = filetime('2026-09-28T12:34:57.123Z', 4567n);
  assert.strictEqual(writeTimeOf({ mtimeNs: (ft - FILETIME_OFFSET) * 100n }), ft);

  // mountvol's own words are in the language of the system; only the volumes and mount points count.
  const text = [
    '현재 가능한 VolumeName 값과 현재 탑재 지점:',
    '',
    '    \\\\?\\Volume{0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9}\\',
    '        C:\\',
    '        D:\\mnt\\disk\\',
    '',
    '    \\\\?\\Volume{0A1B2C3D-0000-1111-2222-333344445555}\\',
    '        *** 탑재 지점 없음 ***',
    '',
  ].join('\r\n');
  assert.deepStrictEqual(volumesFromMountvol(text), [
    { guid: '{0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9}', mounts: ['C:\\', 'D:\\mnt\\disk\\'] },
    { guid: '{0a1b2c3d-0000-1111-2222-333344445555}', mounts: [] },
  ]);
  assert.deepStrictEqual(volumesFromMountvol(''), []);
});
