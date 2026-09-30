'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { workDir, cleanup, write, only, snapshot } = require('./helpers');
const tc = require('../src/lib/thumbcache');
const thumbcache = require('../src/sources/thumbcache');
const { foldersOf, inSnapshots, nameIndex, pick, gather, hooks, thaw } = thumbcache._internal;
const { search } = require('../src/search');
const { restore, planRebuild, leftOutOf, checkDestination } = require('../src/restore');
const { tier } = require('../src/quality');
const { git } = require('../src/search');

const dirs = [];
const listVolumes = hooks.listVolumes;
after(() => {
  dirs.forEach(cleanup);
  hooks.listVolumes = listVolumes;
  thaw();
});
// No test asks this machine for its volumes, and none sees what another froze.
beforeEach(() => {
  hooks.listVolumes = () => [];
  thaw();
});

// Explorer's cache files, and the shortcuts and jump lists that name its pictures, are built here
// byte by byte as Windows writes them (see src/lib/thumbcache.js and src/lib/shelllink.js, whose
// own tests check the formats themselves). Nothing is read from this machine.

const M64 = (1n << 64n) - 1n;
const VOLUME = '{00112233-4455-6677-8899-aabbccddeeff}';
const SERIAL = 0x1234abcd;
const FILETIME_OFFSET = 116444736000000000n;
const filetime = (iso, extra = 0n) => BigInt(Date.parse(iso)) * 10000n + FILETIME_OFFSET + extra;

// ---- Pictures, each whole by its own structure ------------------------------------------------

function seg(marker, body) {
  const b = Buffer.from([0xff, marker, 0, 0]);
  b.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([b, body]);
}

function jpeg(width, height) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])])),
    seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
    seg(0xc0, Buffer.from([8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0])),
    seg(0xc4, Buffer.from([0x00, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])),
    seg(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0])),
    Buffer.from([0x1f, 0xff, 0xd9]),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const b = Buffer.alloc(8 + td.length);
  b.writeUInt32BE(data.length, 0);
  td.copy(b, 4);
  b.writeUInt32BE(crc32(td), 4 + td.length);
  return b;
}

function png(width, height, fill = 0x80) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = 1 + width * 4;
  const raw = Buffer.alloc(height * row, fill);
  for (let y = 0; y < height; y++) raw[y * row] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A 32-bit BITMAPV5 BMP, bottom up, as the small caches hold them. */
function bmp(width, height) {
  const off = 14 + 124;
  const b = Buffer.alloc(off + width * 4 * height, 0x40);
  b.fill(0, 0, off);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(off, 10);
  b.writeUInt32LE(124, 14);
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(32, 28);
  b.writeUInt32LE(3, 30);
  b.writeUInt32LE(width * 4 * height, 34);
  b.writeUInt32LE(0x00ff0000, 54);
  b.writeUInt32LE(0x0000ff00, 58);
  b.writeUInt32LE(0x000000ff, 62);
  b.writeUInt32LE(0xff000000, 66);
  b.write('BGRs', 70, 'latin1');
  return b;
}

// ---- Cache files, format 0x20 -----------------------------------------------------------------

/** One entry: 56 bytes of header, the identifier, the padding, the picture. `badData` spoils its data checksum. */
function entry({ hash, id = hash.toString(16), data = Buffer.alloc(0), width = 0, height = 0, pad = 0, slack = 0, badData = false }) {
  const idb = Buffer.from(id, 'utf16le');
  const b = Buffer.alloc(56 + idb.length + pad + data.length + slack);
  b.write('CMMM', 0, 'latin1');
  b.writeUInt32LE(b.length, 4);
  b.writeBigUInt64LE(hash, 8);
  b.writeUInt32LE(idb.length, 16);
  b.writeUInt32LE(pad, 20);
  b.writeUInt32LE(data.length, 24);
  b.writeUInt32LE(width, 28);
  b.writeUInt32LE(height, 32);
  b.writeBigUInt64LE(tc.dataChecksum(data) ^ (badData ? 1n : 0n), 40);
  b.writeBigUInt64LE(tc.crc64(b.subarray(0, 48), M64), 48);
  idb.copy(b, 56);
  data.copy(b, 56 + idb.length + pad);
  return b;
}

const picture = (hash, data, width, height, more = {}) => entry({ hash, data, width, height, pad: data[0] === 0x42 ? 2 : 0, ...more });

/** A cache file of `type` (4 is the 256 cache, 1 the 32 one): header, entries, and a free entry to its end. */
function cacheFile(type, entries) {
  const h = Buffer.alloc(24);
  h.write('CMMM', 0, 'latin1');
  h.writeUInt32LE(0x20, 4);
  h.writeUInt32LE(type, 8);
  h.writeUInt32LE(24, 16);
  const at = 24 + entries.reduce((n, e) => n + e.length, 0);
  h.writeUInt32LE(at, 20);
  return Buffer.concat([h, ...entries, entry({ hash: 0n, id: '', slack: 200 })]);
}

const EMPTY_CACHE = (type) => {
  const h = Buffer.alloc(24);
  h.write('CMMM', 0, 'latin1');
  h.writeUInt32LE(0x20, 4);
  h.writeUInt32LE(type, 8);
  h.writeUInt32LE(24, 16);
  h.writeUInt32LE(24, 20);
  return h;
};

// ---- Shell links and jump lists -----------------------------------------------------------------

const LINK_CLSID = Buffer.from('0114020000000000c000000000000046', 'hex');
const MY_COMPUTER = '{20d04fe0-3aea-1069-a2d8-08002b30309d}';
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
const az = (s) => Buffer.from(s + '\0', 'latin1');

function guid(s) {
  const b = Buffer.from(s.replace(/[{}-]/g, ''), 'hex');
  return Buffer.concat([Buffer.from(b.subarray(0, 4)).reverse(), Buffer.from(b.subarray(4, 6)).reverse(),
    Buffer.from(b.subarray(6, 8)).reverse(), b.subarray(8)]);
}

function dos(iso) {
  const d = new Date(Math.ceil(Date.parse(iso) / 2000) * 2000);
  return Buffer.concat([
    u16(((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()),
    u16((d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1)),
  ]);
}

const rootItem = (g) => Buffer.concat([u16(20), Buffer.from([0x1f, 0x50]), guid(g)]);
const driveItem = (letter) => {
  const b = Buffer.alloc(25);
  b.writeUInt16LE(25, 0);
  b[2] = 0x2f;
  b.write(`${letter}:\\`, 3, 'latin1');
  return b;
};

/** A version 9 0xBEEF0004 block holding the long name and the file reference. */
function beef0004(fileRef, longName, at) {
  const b = Buffer.concat([u16(0), u16(9), u32(0xbeef0004), dos('2025-01-02T03:04:05Z'), dos('2026-01-02T03:04:05Z'),
    u16(0x2e), u16(0), u64(fileRef), u64(0), u16(0), u32(0), u32(0), wz(longName), u16(at)]);
  b.writeUInt16LE(b.length, 0);
  return b;
}

/** A file entry, 0x32 a file and 0x31 a folder, its ASCII name padded to an even length. */
function fileItem({ cls = 0x32, name, fileRef = 0n, mtime = '2026-09-01T10:00:00.5Z', size = 0 }) {
  const head = Buffer.concat([u16(0), Buffer.from([cls, 0]), u32(size), dos(mtime), u16(0x20)]);
  let own = az(name);
  if ((head.length + own.length) % 2) own = Buffer.concat([own, Buffer.from([0])]);
  const item = Buffer.concat([head, own, beef0004(fileRef, name, head.length + own.length)]);
  item.writeUInt16LE(item.length, 0);
  return item;
}

/** LinkInfo for a local path, in ANSI. */
function localInfo(ansi, serial = SERIAL) {
  const vol = Buffer.concat([u32(0), u32(3), u32(serial), u32(0x10), az('DATA')]);
  vol.writeUInt32LE(vol.length, 0);
  const base = az(ansi);
  const info = Buffer.concat([u32(0), u32(0x1c), u32(1), u32(0x1c), u32(0x1c + vol.length), u32(0),
    u32(0x1c + vol.length + base.length), vol, base, az('')]);
  info.writeUInt32LE(info.length, 0);
  return info;
}

/** A shortcut to `target` (C:\folder\...\name) with this file reference and last write. */
function shortcut(target, { fileRef, write, serial = SERIAL }) {
  const parts = target.slice(3).split('\\');
  const items = [rootItem(MY_COMPUTER), driveItem(target[0]),
    ...parts.slice(0, -1).map((name, i) => fileItem({ cls: 0x31, name, fileRef: BigInt(0x100 + i) })),
    fileItem({ name: parts[parts.length - 1], fileRef, size: 12345 })];
  const list = Buffer.concat([...items, u16(0)]);
  const header = Buffer.concat([u32(0x4c), LINK_CLSID, u32(0x80 | 0x1 | 0x2), u32(0x20),
    u64(filetime('2025-05-05T05:05:05Z')), u64(filetime('2026-09-02T00:00:00Z')), u64(write), u32(12345),
    u32(0), u32(1), u16(0), u16(0), u32(0), u32(0)]);
  return Buffer.concat([header, u16(list.length), list, localInfo(target, serial), u32(0)]);
}

const FREE = 0xffffffff;
const END = 0xfffffffe;

/** A version 3 compound file of 512-byte sectors; every stream here is under 4096 bytes, in the mini stream. */
function compoundFile(streams) {
  const miniFat = [];
  const miniParts = [];
  const starts = new Map();
  for (const [name, data] of streams) {
    const n = Math.ceil(data.length / 64);
    starts.set(name, miniFat.length);
    for (let i = 0; i < n; i++) miniFat.push(i < n - 1 ? miniFat.length + 1 : END);
    const padded = Buffer.alloc(n * 64);
    data.copy(padded);
    miniParts.push(padded);
  }
  const miniStream = Buffer.concat(miniParts);
  const fat = [0xfffffffd];
  const sectors = [null];
  const place = (data) => {
    const n = Math.max(1, Math.ceil(data.length / 512));
    const start = fat.length;
    for (let i = 0; i < n; i++) {
      fat.push(i < n - 1 ? fat.length + 1 : END);
      const s = Buffer.alloc(512);
      data.copy(s, 0, i * 512, Math.min(data.length, (i + 1) * 512));
      sectors.push(s);
    }
    return start;
  };
  const dir = Buffer.alloc(Math.ceil((streams.length + 1) / 4) * 512);
  const dirStart = place(dir);
  const miniFatBuf = Buffer.concat(miniFat.map((x) => u32(x)));
  const miniFatStart = place(miniFatBuf);
  const miniStart = place(miniStream);
  const dirEntry = (i, name, type, start, size, right, child = FREE) => {
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
  dirEntry(0, 'Root Entry', 5, miniStart, miniStream.length, FREE, 1);
  streams.forEach(([name, data], i) => dirEntry(i + 1, name, 2, starts.get(name), data.length, i + 1 < streams.length ? i + 2 : FREE));
  for (let i = 0; i < dir.length / 512; i++) dir.copy(sectors[dirStart + i], 0, i * 512, (i + 1) * 512);
  const fatSector = Buffer.alloc(512, 0xff);
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
  header.writeUInt32LE(Math.ceil(miniFatBuf.length / 512), 64);
  header.writeUInt32LE(END, 68);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i === 0 ? 0 : FREE, 76 + i * 4);
  return Buffer.concat([header, ...sectors]);
}

/** A version 6 DestList: each entry's stream number, last-opened time and path. */
function destList(entries) {
  const parts = [u32(6), u32(entries.length), u32(0), u32(0), u64(0), u64(0)];
  for (const e of entries) {
    const head = Buffer.alloc(0x82);
    head.write('desktop-01', 0x48, 'latin1');
    head.writeUInt32LE(e.id, 0x58);
    head.writeBigUInt64LE(filetime(e.time), 0x64);
    head.writeInt32LE(-1, 0x6c);
    head.writeInt32LE(-1, 0x70);
    head.writeUInt32LE(1, 0x74);
    head.writeUInt16LE(e.path.length, 0x80);
    parts.push(head, Buffer.from(e.path, 'utf16le'), u32(0));
  }
  return Buffer.concat(parts);
}

// ---- The fixture: a profile's Explorer and Recent folders ---------------------------------------

const PHOTO = { path: 'C:\\Photos\\Trip 2026\\IMG_0001.JPG', fileRef: 0x0005000000001234n, write: filetime('2026-09-01T10:00:00.5Z') };
const SCAN = { path: 'C:\\Scans\\page.pdf', fileRef: 0x0006000000000042n, write: filetime('2026-08-15T09:30:01.25Z') };
const MOVED = { path: 'C:\\Old\\report.docx', fileRef: 0x0007000000000077n, write: filetime('2026-07-01T12:00:00Z') };
const keyOf = (f) => BigInt('0x' + tc.cacheIdOf({ volumeGuid: VOLUME, fileId: f.fileRef, ext: path.win32.extname(f.path), filetime: f.write }));
const PHONE = '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}\\\\\\?\\usb#vid_04e8&pid_6860#r58m#{6ac27878-a6fa-4155-ba85-f98f491d4f33}\\SID-{10001,,1}\\{1}';

const PICTURES = {
  photo: jpeg(256, 192),
  photoSmall: bmp(32, 24),
  scan: png(181, 256),
  lost: png(200, 100),
  lostSmall: bmp(32, 16),
  phone: png(96, 96),
  moved: jpeg(192, 256),
};
const LOST = 0x0123456789abcdefn;

function profile({ recent = true } = {}) {
  const dir = workDir('thumbcache');
  dirs.push(dir);
  const explorer = path.join(dir, 'AppData', 'Local', 'Microsoft', 'Windows', 'Explorer');
  const recentDir = path.join(dir, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Recent');
  write(path.join(explorer, 'thumbcache_256.db'), cacheFile(4, [
    picture(keyOf(PHOTO), PICTURES.photo, 256, 192),
    picture(keyOf(SCAN), PICTURES.scan, 181, 256),
    picture(LOST, PICTURES.lost, 200, 100),
    picture(0x2222n, PICTURES.phone, 96, 96, { id: PHONE }),
    picture(0x3333n, png(10, 10), 10, 10, { badData: true }),
    picture(keyOf(MOVED), PICTURES.moved, 192, 256, { id: `Windows?${SERIAL.toString(16)}?${MOVED.fileRef.toString(16)}` }),
    // An item Windows could make no picture of: nothing to offer.
    entry({ hash: 0x4444n }),
  ]));
  write(path.join(explorer, 'thumbcache_32.db'), cacheFile(1, [
    picture(keyOf(PHOTO), PICTURES.photoSmall, 32, 24),
    picture(LOST, PICTURES.lostSmall, 32, 16),
  ]));
  write(path.join(explorer, 'thumbcache_1920.db'), EMPTY_CACHE(7));
  // Programs' icons, in the same format: never read.
  write(path.join(explorer, 'iconcache_256.db'), cacheFile(4, [picture(0x5555n, png(48, 48), 48, 48)]));
  if (recent) {
    write(path.join(recentDir, 'IMG_0001.JPG.lnk'), shortcut(PHOTO.path, PHOTO));
    // A shortcut to a file of which no picture is kept: it names nothing and is never listed.
    write(path.join(recentDir, 'secret.txt.lnk'), shortcut('C:\\Private\\secret.txt', { fileRef: 0x99n, write: filetime('2026-01-01T00:00:00Z') }));
    // A jump list names the scan, with when it was last opened; a custom one names the moved file by its ID.
    write(path.join(recentDir, 'AutomaticDestinations', '1b4dd67f29cb1962.automaticDestinations-ms'), compoundFile([
      ['1', shortcut(SCAN.path, SCAN)],
      ['DestList', destList([{ id: 1, time: '2026-09-10T08:00:00Z', path: SCAN.path }])],
    ]));
    const custom = Buffer.concat([u32(2), u32(0), shortcut(MOVED.path, MOVED), u32(0xbabffbab)]);
    write(path.join(recentDir, 'CustomDestinations', '9b9cdc69c1c24e2b.customDestinations-ms'), custom);
  }
  return { dir, explorer, recentDir };
}

const locs = (...places) => only({ dirs: { thumbcache: [...places, `volume=${VOLUME}`] } });
const find = (o, locations) => search({ sources: ['thumbcache'], locations, ...o });
const byKind = (results) => results.map((c) => [c.kind, c.path || c.name || null, c.width, c.height, c.ext])
  .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

// ---- Tests ---------------------------------------------------------------------------------------

test('a search for pictures by type offers each picture once, the largest kept, named where a shortcut leads to it', async () => {
  const { dir } = profile();
  const { results, perSource } = await find({ pattern: '', types: ['image'] }, locs(dir));
  assert.deepStrictEqual(byKind(results), [
    ['thumbnail', MOVED.path, 192, 256, '.jpg'],
    ['thumbnail', PHOTO.path, 256, 192, '.jpg'],
    ['thumbnail', SCAN.path, 181, 256, '.png'],
    ['thumbnail, name unknown', null, 200, 100, '.png'],
  ]);
  for (const c of results) {
    assert.strictEqual(c.derived, true);
    assert.strictEqual(tier(c), 4, 'a smaller copy is never the file');
    assert.strictEqual(c.mediaType, 'image');
    assert.strictEqual(c.source, 'thumbcache');
  }
  const photo = results.find((c) => c.path === PHOTO.path);
  assert.deepStrictEqual(photo.buffer, PICTURES.photo, 'the picture itself, from the 256 cache rather than the 32 one');
  assert.strictEqual(photo.size, PICTURES.photo.length);
  // The key proves the version: the shortcut's last write, to the millisecond.
  assert.strictEqual(photo.time, Date.parse('2026-09-01T10:00:00.5Z'));
  assert.match(photo.note, /256x192 JPEG picture Windows made of this file as it was on/);
  assert.match(photo.note, /named by a shortcut/);
  const scan = results.find((c) => c.path === SCAN.path);
  assert.strictEqual(scan.time, Date.parse('2026-08-15T09:30:01.25Z'));
  assert.match(scan.note, /named by a jump list; last opened /);
  // Matched by its file ID alone: which version it shows, and so its time, is not known.
  const moved = results.find((c) => c.path === MOVED.path);
  assert.strictEqual(moved.time, null);
  assert.match(moved.note, /with this file ID, of a version not known/);
  const lost = results.find((c) => !c.path);
  assert.deepStrictEqual(lost.buffer, PICTURES.lost);
  assert.strictEqual(lost.time, null);
  assert.strictEqual(lost.state, '', 'whether its file still exists cannot be told');
  assert.match(lost.note, /The file's name, type and date are not known/);
  assert.match(lost.origin, /thumbcache_256\.db#\d+$/);

  const notes = perSource[0].notes.join('\n');
  assert.match(notes, /1 thumbnail\(s\) failed a checksum/);
  assert.match(notes, /1 thumbnail\(s\) of things other than files -- a phone or camera/);
  assert.match(notes, /1 thumbnail\(s\) have no name/);
  assert.ok(!results.some((c) => c.width === 48), 'the icon cache is never read');
  assert.ok(!results.some((c) => /secret/.test(c.path || '')), 'a shortcut with no picture is not listed');
});

test('a name search finds only named pictures, by the name of the file they were made of', async () => {
  const { dir } = profile();
  const { results, perSource } = await find({ pattern: 'IMG_0001' }, locs(dir));
  assert.deepStrictEqual(byKind(results), [['thumbnail', PHOTO.path, 256, 192, '.jpg']]);
  assert.match(perSource[0].notes.join('\n'), /1 thumbnail\(s\) with no name are not listed; a search by type for pictures/);

  const all = await find({ pattern: '*' }, locs(dir));
  assert.strictEqual(all.results.length, 3, 'every named one, and no nameless one');
  assert.strictEqual((await find({ pattern: 'secret' }, locs(dir))).results.length, 0);
  // A thumbnail of a PDF is a picture of a document: a search for either finds it.
  assert.deepStrictEqual((await find({ pattern: 'page', types: ['document'] }, locs(dir))).results.map((c) => c.path), [SCAN.path]);
  assert.deepStrictEqual((await find({ pattern: 'page', types: ['image'] }, locs(dir))).results.map((c) => c.path), [SCAN.path]);
  // No video was ever named, and a picture with no name is not taken for one.
  assert.strictEqual((await find({ pattern: '', types: ['video'] }, locs(dir))).results.length, 0);
});

test('pictures with no name that are the same bytes are one row, and are counted so', async () => {
  const dir = workDir('thumbcache-same');
  dirs.push(dir);
  const blank = png(64, 64, 0xff);
  write(path.join(dir, 'thumbcache_256.db'), cacheFile(4, [
    picture(0xa1n, blank, 64, 64), picture(0xa2n, blank, 64, 64), picture(0xa3n, png(64, 64, 0x10), 64, 64),
  ]));
  const { results, perSource } = await find({ pattern: '', types: ['image'] }, only({ dirs: { thumbcache: [dir] } }));
  assert.deepStrictEqual(results.map((c) => c.copies).sort(), [1, 2]);
  assert.match(perSource[0].notes.join('\n'), /^2 thumbnail\(s\) have no name/m);
  const named = await find({ pattern: 'x' }, only({ dirs: { thumbcache: [dir] } }));
  assert.match(named.perSource[0].notes.join('\n'), /^2 thumbnail\(s\) with no name are not listed/m);
});

test('a date limit keeps the pictures with no date, and says how many', async () => {
  const { dir } = profile();
  const { results, notes } = await find({ pattern: '', types: ['image'], since: Date.parse('2026-08-20T00:00:00Z') }, locs(dir));
  assert.deepStrictEqual(results.map((c) => c.path).sort(), [MOVED.path, PHOTO.path, null].sort());
  assert.match(notes.join('\n'), /2 copy\(ies\) carry no date/);
});

test('without the volume GUID nothing can be hashed; the GUIDs this machine lists are asked for only when needed', async () => {
  const { dir } = profile();
  let asked = 0;
  hooks.listVolumes = () => {
    asked++;
    return [];
  };
  const bare = only({ dirs: { thumbcache: [dir] } });
  const { results } = await find({ pattern: '', types: ['image'] }, bare);
  assert.strictEqual(asked, 1);
  // The file-ID key needs no GUID; the others stay nameless.
  assert.deepStrictEqual(results.map((c) => c.path).sort(), [MOVED.path, null, null, null].sort());

  hooks.listVolumes = () => {
    asked++;
    return [VOLUME.toUpperCase()];
  };
  const listed = await find({ pattern: 'IMG_0001' }, bare);
  assert.deepStrictEqual(listed.results.map((c) => c.path), [PHOTO.path]);

  // With no shortcut at all there is nothing to hash, and nothing is asked.
  const bareProfile = profile({ recent: false });
  asked = 0;
  await find({ pattern: '', types: ['image'] }, only({ dirs: { thumbcache: [bareProfile.dir] } }));
  assert.strictEqual(asked, 0);
});

test('a key names a picture only when every input matches: another extension case or write time names nothing', () => {
  const photoLink = { link: { fileRef: PHOTO.fileRef, writeTime: PHOTO.write, name: 'IMG_0001.JPG', path: PHOTO.path, serial: SERIAL }, kind: 'shortcut' };
  const lower = { link: { ...photoLink.link, name: 'IMG_0001.jpg', path: 'C:\\x\\IMG_0001.jpg' }, kind: 'shortcut' };
  const later = { link: { ...photoLink.link, writeTime: PHOTO.write + 1n }, kind: 'shortcut' };
  const folder = { link: { ...photoLink.link, isDir: true }, kind: 'shortcut' };
  const key = keyOf(PHOTO).toString(16).padStart(16, '0');
  const { byKey, byFileId } = nameIndex([photoLink, lower, later, folder], [VOLUME], new Set([0x20]));
  assert.deepStrictEqual(byKey.get(key), [photoLink]);
  assert.strictEqual(byFileId.get(`${SERIAL.toString(16)}:${PHOTO.fileRef.toString(16)}`).length, 3, 'a folder is not a file');
});

test('of several shortcuts to one file, a live one with a path used last names it, and the others are counted', () => {
  const r = (p, accessed, snapshot = null, lastOpened = null) => ({ link: { path: p, name: p && path.win32.basename(p), accessed }, snapshot, lastOpened });
  const a = r('C:\\a\\x.jpg', 10);
  const b = r('C:\\b\\x.jpg', 30);
  const c = r('C:\\c\\x.jpg', 99, 'snap');
  const d = r(null, 99);
  const e = r('C:\\e\\x.jpg', 5, null, 50);
  assert.deepStrictEqual(pick([a, b, c, d]), { record: b, others: 3 });
  assert.deepStrictEqual(pick([a, b, e]), { record: e, others: 2 });
  assert.deepStrictEqual(pick([a, r('C:\\A\\X.JPG', 1)]), { record: a, others: 0 }, 'the same path in another case is one');
});

test('freeze reads the cache and the shortcuts once; later changes to them change nothing found until it is called again', async () => {
  const { dir, explorer, recentDir } = profile();
  await thumbcache.freeze({ thumbcache: [dir, `volume=${VOLUME}`] });
  // Explorer empties its cache, and the shortcut goes.
  fs.writeFileSync(path.join(explorer, 'thumbcache_256.db'), EMPTY_CACHE(4));
  fs.writeFileSync(path.join(explorer, 'thumbcache_32.db'), EMPTY_CACHE(1));
  fs.rmSync(path.join(recentDir, 'IMG_0001.JPG.lnk'));
  const kept = await find({ pattern: '', types: ['image'] }, locs(dir));
  assert.strictEqual(kept.results.length, 4);
  assert.ok(kept.results.some((c) => c.path === PHOTO.path));
  assert.match(kept.perSource[0].notes.join('\n'), /Read as taken into memory at /);
  const described = await thumbcache.describe({ locations: { thumbcache: [dir, `volume=${VOLUME}`] } });
  assert.match(described.join('\n'), /taken into memory at/);

  await thumbcache.freeze({ thumbcache: [dir] });
  const now = await find({ pattern: '', types: ['image'] }, locs(dir));
  assert.strictEqual(now.results.length, 0);
});

test('a smaller copy is restored under a name that says so, in its own format, and rebuild never takes it', async () => {
  const { dir } = profile();
  const to = workDir('thumbcache-to');
  dirs.push(to);
  const { results } = await find({ pattern: '', types: ['image'] }, locs(dir));
  const photo = results.find((c) => c.path === PHOTO.path);
  const written = await restore(photo, to, thumbcache.roots({ thumbcache: [dir] }), git);
  assert.strictEqual(path.basename(written), 'IMG_0001 (smaller copy 256x192).jpg');
  assert.deepStrictEqual(fs.readFileSync(written), PICTURES.photo);
  const scan = results.find((c) => c.path === SCAN.path);
  assert.strictEqual(path.basename(await restore(scan, to, [], git)), 'page (smaller copy 181x256).png');
  const lost = results.find((c) => !c.path);
  assert.strictEqual(path.basename(await restore(lost, to, [], git)), `recovered-${lost.id} (smaller copy 200x100).png`);

  const under = await search({ under: 'C:\\Photos', sources: ['thumbcache'], locations: locs(dir) });
  assert.strictEqual(under.results.length, 1);
  assert.deepStrictEqual(planRebuild(under.results, 'C:\\Photos'), []);
  assert.strictEqual(leftOutOf(under.results, 'C:\\Photos').length, 1);
});

test('restore will not write into the cache or Recent folder, but a profile given as a place is not all kept out', () => {
  const { dir, explorer, recentDir } = profile();
  const protect = thumbcache.roots({ thumbcache: [dir, `volume=${VOLUME}`] });
  assert.throws(() => checkDestination(explorer, protect));
  assert.throws(() => checkDestination(path.join(recentDir, 'AutomaticDestinations'), protect));
  const documents = path.join(dir, 'Documents');
  fs.mkdirSync(documents);
  assert.strictEqual(checkDestination(documents, protect), documents);
  const nowhere = path.join(dir, 'nothing-here');
  assert.ok(thumbcache.roots({ thumbcache: [nowhere] }).includes(nowhere), 'a place that stands for nothing is kept out itself');
});

test('places: the folders themselves or any folder above them; others, and a bad volume GUID, are said', () => {
  const { dir, explorer, recentDir } = profile();
  for (const place of [dir, path.join(dir, 'AppData'), path.join(dir, 'AppData', 'Local'), explorer]) {
    assert.deepStrictEqual(foldersOf({ thumbcache: [place] }, []).caches, [explorer], place);
  }
  assert.deepStrictEqual(foldersOf({ thumbcache: [path.join(dir, 'AppData', 'Roaming')] }, []).recents, [recentDir]);
  assert.deepStrictEqual(foldersOf({ thumbcache: [recentDir] }, []).recents, [recentDir]);
  const notes = [];
  const f = foldersOf({ thumbcache: [path.join(dir, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Recent', 'CustomDestinations', 'x'), 'volume=nope', `volume=${VOLUME}`] }, notes);
  assert.deepStrictEqual(f.guids, [VOLUME]);
  assert.strictEqual(notes.length, 2);
  assert.match(notes[0], /no thumbnail cache or Recent folder there/);
  assert.match(notes[1], /volume=nope: not a volume GUID/);
});

test('describe says what each folder holds, in counts', async () => {
  const { dir } = profile();
  const lines = await thumbcache.describe({ locations: { thumbcache: [dir, `volume=${VOLUME}`] } });
  const text = lines.join('\n');
  assert.match(text, /Explorer: 3 cache file\(s\), 6 picture\(s\) that pass every check/);
  assert.match(text, /Recent: 4 shortcut file\(s\) and jump list\(s\), read to name thumbnails/);
  assert.match(text, /4 picture\(s\) in all: 3 named by a shortcut, 1 with no name, which a search by type for pictures lists as 1 different picture\(s\)/);
  assert.deepStrictEqual(await thumbcache.describe({ locations: {} }), ['No Explorer thumbnail cache found.']);
});

test('the same folders inside a shadow copy are found through the snapshot, never through a way out of it', () => {
  const snapRoot = workDir('thumbcache-snap');
  dirs.push(snapRoot);
  const original = 'C:\\Users\\someone\\AppData\\Local\\Microsoft\\Windows\\Explorer';
  const inside = path.join(snapRoot, 'Users', 'someone', 'AppData', 'Local', 'Microsoft', 'Windows', 'Explorer');
  fs.mkdirSync(inside, { recursive: true });
  const snap = { root: snapRoot, driveRoot: 'C:\\', driveKey: 'c:' };
  const skipped = { outside: 0 };
  const found = inSnapshots([snap, { ...snap, driveKey: 'd:' }], [original, 'D:\\elsewhere', '/not/windows'], skipped);
  assert.deepStrictEqual(found, [{ dir: inside, snapshot: snapRoot, original }]);
  assert.strictEqual(skipped.outside, 0);
  assert.deepStrictEqual(inSnapshots([snap], ['C:\\Users\\..\\..\\Windows'], skipped), []);
  assert.strictEqual(skipped.outside, 1);
});

test('a shadow copy of the cache adds what only it still holds, and says so', { skip: process.platform !== 'win32' && 'a snapshot maps a drive letter' }, async () => {
  const { dir, explorer } = profile();
  const snapRoot = workDir('thumbcache-snap');
  dirs.push(snapRoot);
  const drive = path.parse(explorer).root;
  const inside = path.join(snapRoot, path.relative(drive, explorer));
  const older = png(64, 48, 0x20);
  write(path.join(inside, 'thumbcache_256.db'), cacheFile(4, [
    picture(0x7777n, older, 64, 48),
    // The same item as live, at a larger size: the larger is offered.
    picture(LOST, png(400, 200), 400, 200),
  ]));
  const locations = only({ dirs: { thumbcache: [dir, `volume=${VOLUME}`], vss: [`${snapRoot}=${drive}`] } });
  const { results, perSource } = await find({ pattern: '', types: ['image'] }, locations);
  const nameless = results.filter((c) => !c.path).map((c) => [c.width, c.height, c.note.includes('found only in a shadow copy')]);
  assert.deepStrictEqual(nameless.sort(), [[400, 200, false], [64, 48, true]].sort());
  assert.match(perSource[0].notes.join('\n'), /Also read the thumbnail cache in 1 shadow copy\(ies\); 1 picture\(s\) were found only there/);
});

test('searching, freezing and describing write nothing', async () => {
  const { dir } = profile();
  const before = snapshot(dir);
  await thumbcache.freeze({ thumbcache: [dir] });
  await find({ pattern: '', types: ['image'] }, locs(dir));
  await thumbcache.describe({ locations: { thumbcache: [dir] } });
  assert.deepStrictEqual(snapshot(dir), before);
});

test('a search stopped part way stops reading', () => {
  const { dir } = profile();
  const ac = new AbortController();
  ac.abort(new Error('stopped'));
  assert.throws(() => gather({ thumbcache: [dir] }, [], { signal: ac.signal }), /stopped/);
});
