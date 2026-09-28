'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { workDir, cleanup, write, only, snapshot } = require('./helpers');
const jb = require('../src/sources/jetbrains');
const {
  javaReader, readChangeSet, lz4Block, decodeContent, provablyRaw, nameHash, recordOffset, systemsOf, historyPath,
  unchangedOnDisk,
} = jb._internal;
const { search, git } = require('../src/search');
const { load } = require('../src/content');
const { planRebuild } = require('../src/restore');

const dirs = [];
after(() => dirs.forEach(cleanup));

// ---- what IntelliJ writes, rebuilt small ----------------------------------------------------

const TIME_BASE = 33 * 365 * 24 * 3600 * 1000;
const CREATED = Date.UTC(2026, 8, 15, 1, 21, 38);
const T = (h, m = 0) => Date.UTC(2026, 8, 15, h, m);

/** DataInputOutputUtil.writeINT */
function int(v) {
  if (v >= 0 && v < 192) return Buffer.from([v]);
  const out = [192 + (v & 0x3f)];
  v >>>= 6;
  while (v >= 128) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

/** DataInputOutputUtil.writeTIME, the five-byte form. */
function time(ms) {
  const rel = BigInt(ms - TIME_BASE);
  return Buffer.from([0, 1, 2, 3, 4].map((i) => Number((rel >> BigInt(8 * (4 - i))) & 0xffn)));
}

/** IOUtil.writeUTF: short ASCII as it is, anything else as 0xFF and Java's writeUTF. */
function str(s) {
  if (s.length < 255 && /^[\x01-\x7f]*$/.test(s)) return Buffer.concat([Buffer.from([s.length]), Buffer.from(s, 'latin1')]);
  // Modified UTF-8 is UTF-8 for text with no NUL and nothing outside the BMP.
  const utf = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(utf.length);
  return Buffer.concat([Buffer.from([0xff]), len, utf]);
}

const bool = (v) => Buffer.from([v ? 1 : 0]);
const i32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v);
  return b;
};
const i64 = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt(v));
  return b;
};

const fileEntry = (name, mtime, content) => Buffer.concat([int(0), str(name), i64(mtime), bool(false), int(content)]);
const idEntry = (nameId, hash, mtime, content) =>
  Buffer.concat([int(0), str('<FILE_ID_AND_HASH>'), i32(nameId), i32(hash), i64(mtime), bool(false), int(content)]);
const dirEntry = (name, children) => Buffer.concat([int(1), str(name), int(children.length), ...children]);

const change = {
  create: (p) => Buffer.concat([int(1), int(11), str(p)]),
  content: (p, id, old) => Buffer.concat([int(3), int(12), str(p), int(id), time(old)]),
  delete: (p, entry) => Buffer.concat([int(7), int(13), str(p), entry]),
  label: (name) => Buffer.concat([int(8), int(14), str(name), str('project')]),
};

function changeSet(ms, changes) {
  return Buffer.concat([int(1), int(1), bool(false), time(ms), bool(false), bool(false), int(changes.length), ...changes]);
}

/** changes.storageRecordIndex and changes.storageData; a null set is a removed slot. */
function localHistory(dir, sets, { created, magic = 0x1f2f3f58 }) {
  const index = Buffer.alloc(32 + 32 * sets.length);
  index.writeUInt32BE(magic, 0);
  index.writeInt32BE(7, 4);
  index.writeBigInt64BE(BigInt(sets.length), 8);
  index.writeInt32BE(1, 16);
  index.writeInt32BE(sets.length, 20);
  index.writeBigInt64BE(BigInt(created), 24);
  const blobs = [Buffer.alloc(32)];
  blobs[0].writeUInt32BE(0x1f2f3f4f, 0);
  let at = 32;
  sets.forEach((b, i) => {
    const o = 32 + i * 32;
    if (b) {
      index.writeBigInt64BE(BigInt(at), o);
      index.writeInt32BE(b.length, o + 8);
      index.writeInt32BE(b.length, o + 12);
      blobs.push(b);
      at += b.length;
    } else {
      index.writeInt32BE(-1, o + 8);
    }
    index.writeInt32BE(i, o + 16);
    index.writeInt32BE(i + 1 < sets.length ? i + 2 : 0, o + 20);
  });
  write(path.join(dir, 'changes.storageRecordIndex'), index);
  write(path.join(dir, 'changes.storageData'), Buffer.concat(blobs));
}

/**
 * An append-only log: 64-byte header, records aligned to 4, padding where a page runs out. A
 * record added with `straddle` is written across the page end, as the IDE never writes one.
 */
function aolog({ pageSize = 4096, format = 0, user0 = 0 } = {}) {
  const parts = [];
  const pads = [];
  let at = 64;
  let count = 0;
  return {
    pads,
    room: () => pageSize - (at % pageSize),
    add(payload, { committed = true, straddle = false } = {}) {
      const total = payload.length + 4;
      const room = pageSize - (at % pageSize);
      if (total > room && !straddle) {
        const pad = Buffer.alloc(room);
        pad.writeUInt32LE((0x80000000 | 0x40000000 | room) >>> 0, 0);
        parts.push(pad);
        pads.push((at - 64) / 4 + 1);
        at += room;
      }
      const id = (at - 64) / 4 + 1;
      const rec = Buffer.alloc((total + 3) & ~3);
      rec.writeUInt32LE(((committed ? 0x40000000 : 0) | total) >>> 0, 0);
      payload.copy(rec, 4);
      parts.push(rec);
      at += rec.length;
      count++;
      return id;
    },
    bytes() {
      const h = Buffer.alloc(64);
      h.write('MLOA', 0, 'latin1');
      h.writeInt32LE(2, 4);
      h.writeInt32LE(format, 8);
      h.writeInt32LE(pageSize, 12);
      h.writeBigInt64LE(BigInt(at), 16);
      h.writeBigInt64LE(BigInt(at), 24);
      h.writeInt32LE(count, 32);
      h.writeInt32LE(user0, 40);
      return Buffer.concat([h, ...parts]);
    },
  };
}

function sha(bytes) {
  return crypto.createHash('sha1').update(String(bytes.length)).update(Buffer.from([0])).update(bytes).digest();
}

/** A content record: SHA-1, size (negative when compressed), bytes. */
function contentPayload(bytes, { lz4 = null, zip = false, corrupt = false } = {}) {
  const hash = sha(bytes);
  if (corrupt) hash[0] ^= 1;
  const size = Buffer.alloc(4);
  let body = bytes;
  if (lz4 || zip) {
    size.writeInt32LE(-bytes.length);
    body = lz4 || zlib.deflateSync(bytes);
  } else {
    size.writeInt32LE(bytes.length);
  }
  return Buffer.concat([hash, size, body]);
}

/** A raw LZ4 block of one sequence -- literals, then `len` bytes from `offset` back -- and last literals. */
function lz4(literals, offset, len, tail) {
  const ext = (n) => {
    const out = [];
    for (; n >= 255; n -= 255) out.push(255);
    out.push(n);
    return out;
  };
  const m = len - 4;
  const bytes = [(Math.min(literals.length, 15) << 4) | Math.min(m, 15)];
  if (literals.length >= 15) bytes.push(...ext(literals.length - 15));
  bytes.push(...literals, offset & 0xff, offset >> 8);
  if (m >= 15) bytes.push(...ext(m - 15));
  bytes.push(Math.min(tail.length, 15) << 4);
  if (tail.length >= 15) bytes.push(...ext(tail.length - 15));
  bytes.push(...tail);
  return Buffer.from(bytes);
}

const BIG = Buffer.from('abc'.repeat(3000) + 'xyz12');
const BIG_LZ4 = lz4([...Buffer.from('abc')], 3, 8997, [...Buffer.from('xyz12')]);

/** records.dat: 40-byte header, then 40 bytes per record from id 1. */
function recordsDat(recs, { version, created, errors = 0 }) {
  const b = Buffer.alloc(40 + recs.length * 40);
  b.writeInt32LE(version, 0);
  b.writeInt32LE(recs.length, 4);
  b.writeBigInt64LE(BigInt(created), 16);
  b.writeInt32LE(errors, 32);
  recs.forEach((r, i) => {
    const o = 40 + i * 40;
    b.writeInt32LE(r.parent || 0, o);
    b.writeInt32LE(r.name || 0, o + 4);
    b.writeInt32LE(r.flags || 0, o + 8);
    b.writeInt32LE(r.content || 0, o + 16);
    b.writeBigInt64LE(BigInt(r.mtime || 0), o + 24);
    b.writeBigInt64LE(BigInt(r.length || 0), o + 32);
  });
  return b;
}

const DIR = 0x2;
const FREE = 0x400;

/** An IDE's cache under construction: names, content and file records. */
function cacheBuilder({ version = 65, contentVersion = version, namePage = 4096, contentPage = 16384, format = 0x01000002 } = {}) {
  const names = aolog({ pageSize: namePage });
  const content = aolog({ pageSize: contentPage, format, user0: contentVersion });
  const recs = [{}];
  const name = (n) => names.add(Buffer.from(n, 'utf8'));
  const add = (r) => recs.push(r);
  return {
    name,
    /** What is left of the content log's page. A file takes 28 bytes more: SHA-1, size and header. */
    contentRoom: () => content.room(),
    pads: () => ({ names: names.pads, content: content.pads }),
    content: (bytes, o) => content.add(contentPayload(bytes, o), o),
    root: (n) => add({ parent: 0, name: name(n), flags: DIR }),
    dir: (parent, n, flags = DIR) => add({ parent, name: name(n), flags }),
    file: (parent, n, bytes, { flags = 0, length = bytes.length, id, mtime = T(1) } = {}) =>
      add({ parent, name: name(n), flags, content: id || content.add(contentPayload(bytes)), mtime, length }),
    save(caches, { created = CREATED, errors = 0 } = {}) {
      write(path.join(caches, 'records.dat'), recordsDat(recs, { version, created, errors }));
      write(path.join(caches, 'names.dat'), names.bytes());
      write(path.join(caches, 'content.dat'), content.bytes());
    },
  };
}

const P = 'C:\\Users\\alice\\proj';
const win = (rel) => P + '\\' + rel.replace(/\//g, '\\');
const lh = (rel) => 'C:/Users/alice/proj/' + rel;

/**
 * A system folder with most of what can be in one: copies that must come back, and records
 * that fail one check each and must not.
 */
function makeIde({ lhCreated = CREATED, contentVersion, errors = 0, lhMagic, twoNameLogs = false } = {}) {
  const root = workDir('jetbrains');
  dirs.push(root);
  const sys = path.join(root, 'IntelliJIdea2025.2');
  const c = cacheBuilder({ contentVersion });

  const drive = c.root('C:');
  const proj = c.dir(c.dir(c.dir(drive, 'Users'), 'alice'), 'proj');
  c.file(proj, 'gone.txt', Buffer.from('gone\n'));
  const old = c.dir(proj, 'old', FREE);
  const bigId = c.content(BIG, { lz4: BIG_LZ4 });
  c.file(old, 'big.bin', BIG, { flags: FREE, id: bigId, mtime: T(2) });
  // Leaves 16 bytes of its page, so the record after it goes to the next page, after padding.
  c.file(proj, 'padded.txt', Buffer.alloc(c.contentRoom() - 28 - 16, 0x61));
  c.file(proj, 'stale.txt', Buffer.from('stale\n'), { flags: 0x8 });
  c.file(proj, 'short.txt', Buffer.from('short\n'), { length: 7 });
  c.file(proj, 'bad.txt', null, { length: 4, id: c.content(Buffer.from('bad\n'), { corrupt: true }) });
  c.file(proj, 'half.txt', null, { length: 5, id: c.content(Buffer.from('half\n'), { committed: false }) });
  c.file(c.dir(proj, '한글'), '메모.txt', Buffer.from('안녕\r\n'));
  c.file(proj, 'empty.txt', Buffer.alloc(0));
  c.file(proj, 'link.txt', Buffer.from('link\n'), { flags: 0x10 });
  c.file(old, 'orphan.txt', Buffer.from('live under a deleted folder\n'));
  c.file(c.root('lib.jar'), 'A.class', Buffer.from('jar entry with the needle\n'));
  c.content(Buffer.from('an old version with the needle in it\n'));
  const newName = c.name('new.txt');
  const wrongName = c.name('wrong.txt');

  const LF = c.content(Buffer.from('one\ntwo\n'));
  const CRLF = c.content(Buffer.from('one\r\ntwo\r\n'));
  const X = c.content(Buffer.from('x\n'));
  const Z = c.content(Buffer.from('\ufeffz\n'));
  const NEW = c.content(Buffer.from('new\r\n'));
  const POSIX = c.content(Buffer.from('posix\n'));
  const TRAIL = c.content(Buffer.from('trailing\r\n'));
  const BAD = c.content(Buffer.from('bad ref\n'), { corrupt: true });
  c.save(path.join(sys, 'caches'), { errors });
  if (twoNameLogs) fs.copyFileSync(path.join(sys, 'caches', 'names.dat'), path.join(sys, 'caches', 'names.dat.mmap'));

  localHistory(path.join(sys, 'LocalHistory'), [
    changeSet(T(3), [change.content(lh('a.txt'), LF, T(2, 30))]),
    changeSet(T(4), [change.content(lh('a.txt'), CRLF, T(3, 30))]),
    changeSet(T(5), [change.delete(lh('old'), dirEntry('old', [
      fileEntry('x.txt', T(4, 10), X),
      fileEntry('y.txt', T(4, 11), 0),
      dirEntry('sub', [fileEntry('z.txt', T(4, 12), Z)]),
      fileEntry('big.bin', T(2), bigId),
    ]))]),
    changeSet(T(6), [change.delete(lh('new.txt'), idEntry(newName, nameHash('new.txt'), T(5, 30), NEW))]),
    changeSet(T(6, 5), [change.delete(lh('wrong.txt'), idEntry(wrongName, nameHash('wrong.txt') + 1, T(5, 31), NEW))]),
    Buffer.concat([changeSet(T(6, 10), [change.content(lh('trailing.txt'), TRAIL, T(6))]), Buffer.from([0])]),
    null,
    changeSet(T(7), [
      change.content('jar://C:/lib.jar!/A.class', X, T(6, 40)),
      change.content(lh('never.txt'), 0, T(6, 41)),
      change.label('before refactoring'),
      change.create(lh('created.txt')),
    ]),
    changeSet(T(8), [change.content('/home/alice/notes.md', POSIX, T(7, 30))]),
    changeSet(T(9), [change.content(lh('bad-ref.txt'), BAD, T(8, 30))]),
  ], { created: lhCreated, magic: lhMagic });
  return sys;
}

const find = (pattern, sys, extra = {}) =>
  search({ pattern, sources: ['jetbrains'], locations: only({ dirs: { jetbrains: [sys] } }), ...extra });

/** How many padding records a log file holds, walked as the IDE walks it. */
function paddingIn(file) {
  const b = fs.readFileSync(file);
  let n = 0;
  for (let at = 64; at + 4 <= b.length;) {
    const header = b.readUInt32LE(at);
    if (header === 0) break;
    if (header & 0x80000000) n++;
    at += ((header & 0x3fffffff) + 3) & ~3;
  }
  return n;
}

/**
 * Runs `fn` with every fs call on a network, WSL, device or A:/B: path caught and recorded, so
 * none reaches the machine: a share root listed in `up` answers as a folder, and everything
 * else there does not exist. Each call is recorded with whether this source made it.
 */
async function guarded(up, fn) {
  const calls = ['statSync', 'lstatSync', 'readFileSync', 'openSync', 'readdirSync', 'existsSync', 'accessSync'];
  const real = Object.fromEntries(calls.map((n) => [n, fs[n]]));
  const touched = [];
  for (const n of calls) {
    fs[n] = function (p, ...rest) {
      if (typeof p !== 'string' || !/^(?:\\\\|\/\/|[ab]:)/i.test(p)) return real[n].call(fs, p, ...rest);
      touched.push({ p, here: /sources[\\/]jetbrains\.js/.test(new Error().stack) });
      if (n === 'existsSync') return false;
      if (n === 'statSync' && up.includes(p)) return { isDirectory: () => true, isFile: () => false };
      throw Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });
    };
  }
  try {
    return { value: await fn(), touched };
  } finally {
    Object.assign(fs, real);
  }
}

const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const rows = (results) => results
  .map((r) => [r.kind, r.path, r.copies])
  .sort((a, b) => order(String(a[1]), String(b[1])) || order(a[0], b[0]));

// ---- units ----------------------------------------------------------------------------------

test('reads IntelliJ numbers, times and strings as Java writes them', () => {
  const long = 'x'.repeat(300);
  const r = javaReader(Buffer.concat([int(5), int(191), int(192), int(70000), int(-1), time(T(3)), str('C:/a.txt'), str('C:/한글.txt'), str(long)]));
  assert.deepStrictEqual([r.int(), r.int(), r.int(), r.int(), r.int()], [5, 191, 192, 70000, -1]);
  assert.strictEqual(r.time(), T(3));
  assert.deepStrictEqual([r.str(), r.str(), r.str()], ['C:/a.txt', 'C:/한글.txt', long]);
  assert.throws(() => r.u8(), /ends early/);
});

test('a change set has to fill its record exactly', () => {
  const set = changeSet(T(3), [change.content(lh('a.txt'), 7, T(2))]);
  const parsed = readChangeSet(set);
  assert.strictEqual(parsed.time, T(3));
  assert.deepStrictEqual(parsed.changes, [{ type: 3, path: lh('a.txt'), content: 7, oldTime: T(2) }]);
  assert.throws(() => readChangeSet(Buffer.concat([set, Buffer.from([0])])), /left over/);
  assert.throws(() => readChangeSet(set.subarray(0, set.length - 1)), /ends early/);
});

test('LZ4 blocks decode to the byte, and anything malformed is refused', () => {
  assert.deepStrictEqual(lz4Block(BIG_LZ4, BIG.length), BIG);
  assert.throws(() => lz4Block(BIG_LZ4, BIG.length + 1), /length/);
  const badOffset = Buffer.from(BIG_LZ4);
  badOffset[4] = 9;
  assert.throws(() => lz4Block(badOffset, BIG.length), /offset/);
  assert.throws(() => lz4Block(BIG_LZ4.subarray(0, 10), BIG.length), /lz4/);
});

test('a damaged size is refused before anything is allocated for it', () => {
  assert.throws(() => lz4Block(Buffer.alloc(2), 2 ** 31), /more than the block can hold/);
  const size = Buffer.alloc(4);
  size.writeInt32LE(-2147483648);
  const damaged = Buffer.concat([sha(Buffer.alloc(0)), size, Buffer.from([0x10, 0x61])]);
  const before = process.memoryUsage().arrayBuffers;
  for (const algo of [1, 2]) assert.strictEqual(decodeContent(damaged, algo), null);
  assert.ok(process.memoryUsage().arrayBuffers - before < 64 * 1024 * 1024, 'nothing large was allocated');
  // One long match grows a block about as much as LZ4 can, 249 times here, and still comes through.
  const block = Buffer.from([0x1f, 0x61, 1, 0, ...Array(200).fill(255), 254, 0x00]);
  const grown = 1 + 4 + 15 + 200 * 255 + 254;
  assert.ok(grown > block.length * 248);
  assert.deepStrictEqual(lz4Block(block, grown), Buffer.alloc(grown, 0x61));
});

test('content comes back only when it matches its SHA-1 and size', () => {
  const text = Buffer.from('hello\n'.repeat(2000));
  assert.deepStrictEqual(decodeContent(contentPayload(text), 2), text);
  assert.deepStrictEqual(decodeContent(contentPayload(text, { zip: true }), 1), text);
  assert.deepStrictEqual(decodeContent(contentPayload(BIG, { lz4: BIG_LZ4 }), 2), BIG);
  assert.strictEqual(decodeContent(contentPayload(text, { corrupt: true }), 2), null, 'checksum');
  assert.strictEqual(decodeContent(contentPayload(BIG, { lz4: BIG_LZ4 }), 3), null, 'compressed where nothing is');
  const cut = contentPayload(text);
  assert.strictEqual(decodeContent(cut.subarray(0, cut.length - 1), 2), null, 'shorter than its size');
  assert.strictEqual(decodeContent(Buffer.alloc(10), 2), null);
});

test('bytes count as straight from disk only when an editor could not have made them', () => {
  assert.strictEqual(provablyRaw(Buffer.from('a\r\nb\r\n')), true, 'CR');
  assert.strictEqual(provablyRaw(Buffer.from('\ufeffa\n')), true, 'UTF-8 BOM');
  assert.strictEqual(provablyRaw(Buffer.from('a\nb\n')), false, 'LF only');
  assert.strictEqual(provablyRaw(Buffer.alloc(0)), false, 'empty');
  assert.strictEqual(provablyRaw(Buffer.from('\ufeffa\r\n', 'utf16le')), true, 'UTF-16 with a CR');
  assert.strictEqual(provablyRaw(Buffer.from('\ufeff\u0d0a\n', 'utf16le')), false, 'a 0x0D byte inside another character');
  assert.strictEqual(provablyRaw(Buffer.from([0, 0x0d, 1])), false, 'NUL: could be UTF-16 without a BOM');
  // A UTF-16 file's text is kept without its BOM; with no ASCII in it, it has no NUL either.
  assert.strictEqual(provablyRaw(Buffer.from('갍갍', 'utf16le')), false, 'Hangul, 0D AC 0D AC');
  assert.strictEqual(provablyRaw(Buffer.from([0x0d, 0x15, 0x0d, 0x2e])), false, 'Malayalam, UTF-16BE');
  assert.strictEqual(provablyRaw(Buffer.from('我不知道', 'utf16le')), false, 'Chinese, 0D 4E');
  assert.strictEqual(provablyRaw(Buffer.from('a\rb\r')), false, 'a CR with no LF after it proves nothing');
  // U+0D0A is 0D 0A in UTF-16BE: when the cache holds the file with a UTF-16 BOM, it is read as that.
  assert.strictEqual(provablyRaw(Buffer.from([0x0d, 0x0a])), true, 'CR LF, with nothing to say otherwise');
  assert.strictEqual(provablyRaw(Buffer.from([0x0d, 0x0a]), () => 'be'), false, 'U+0D0A, as the cache says UTF-16BE');
  let asked = 0;
  const order = () => {
    asked++;
    return 'le';
  };
  provablyRaw(Buffer.from('a\nb\n'), order);
  provablyRaw(Buffer.from('﻿a\r\n'), order);
  assert.strictEqual(asked, 0, 'the cache is asked only when a CR LF would prove it');
  assert.strictEqual(provablyRaw(Buffer.from([0xfe, 0xff, 0x00])), false, 'UTF-16BE of odd length does not throw');
});

test('name hashes follow Java, ignoring case', () => {
  assert.strictEqual(nameHash('a.txt'), 91067235);
  assert.strictEqual(nameHash('A.TXT'), 91067235);
  assert.strictEqual(nameHash(String.fromCharCode(0x130)), nameHash('i'), 'dotted capital I, as Java lowers it');
});

test('records past the first 64 MiB skip what the header takes from each page', () => {
  assert.strictEqual(recordOffset(1), 40);
  assert.strictEqual(recordOffset(1677720), 40 + 1677719 * 40);
  assert.strictEqual(recordOffset(1677721), 64 * 1024 * 1024);
  assert.strictEqual(recordOffset(1677722), 64 * 1024 * 1024 + 40);
});

test('Local History paths become local paths; archives and other schemes do not', () => {
  assert.strictEqual(historyPath('C:/Users/a/b.txt'), 'C:\\Users\\a\\b.txt');
  assert.strictEqual(historyPath('//server/share/a.txt'), '\\\\server\\share\\a.txt');
  assert.strictEqual(historyPath('/home/a/b.txt'), '/home/a/b.txt');
  assert.strictEqual(historyPath('jar://C:/lib.jar!/A.class'), null);
  assert.strictEqual(historyPath('temp:///src/a.txt'), null);
  assert.strictEqual(historyPath('relative/a.txt'), null);
  for (const device of ['//./pipe/foo', '//?/C:/x.txt', '//server/pipe/foo', '//server/MAILSLOT/x']) {
    assert.strictEqual(historyPath(device), null, device);
  }
});

test('a file that may be a cloud placeholder is not read to compare it', () => {
  const p = process.platform === 'win32' ? 'C:\\placeholder\\a.txt' : '/placeholder/a.txt';
  const rec = { length: 5000, mtime: 1000 };
  const real = { statSync: fs.statSync, readFileSync: fs.readFileSync };
  const reads = [];
  const check = (blocks) => {
    fs.statSync = (q, ...rest) => (q === p
      ? { isFile: () => true, size: 5000, mtimeMs: 2000, blocks }
      : real.statSync.call(fs, q, ...rest));
    fs.readFileSync = (q, ...rest) => {
      if (q !== p) return real.readFileSync.call(fs, q, ...rest);
      reads.push(blocks);
      return Buffer.alloc(5000);
    };
    try {
      return unchangedOnDisk(p, rec, () => Buffer.alloc(5000));
    } finally {
      Object.assign(fs, real);
    }
  };
  assert.strictEqual(check(0), false, 'online only: taken as changed');
  assert.strictEqual(check(undefined), false, 'no allocation known: taken as changed');
  assert.strictEqual(check(16), true, 'all there: read, and the same');
  assert.deepStrictEqual(reads, [16]);
});

// ---- end to end -----------------------------------------------------------------------------

test('finds cached files and Local History versions, and nothing that fails a check', async () => {
  const sys = makeIde();
  const { results, perSource } = await find('*', sys);
  assert.deepStrictEqual(rows(results), [
    ['jetbrains history, as text', '/home/alice/notes.md', 1],
    ['jetbrains history', win('a.txt'), 1],
    ['jetbrains history, as text', win('a.txt'), 1],
    ['jetbrains cache', win('empty.txt'), 1],
    ['jetbrains cache', win('gone.txt'), 1],
    ['jetbrains history', win('new.txt'), 1],
    ['jetbrains cache', win('old/big.bin'), 2],
    ['jetbrains history', win('old/sub/z.txt'), 1],
    ['jetbrains history, as text', win('old/x.txt'), 1],
    ['jetbrains cache', win('padded.txt'), 1],
    ['jetbrains cache', win('한글/메모.txt'), 1],
  ]);
  const by = (p, kind) => results.find((r) => r.path === p && (!kind || r.kind === kind));
  assert.deepStrictEqual(await load(by(win('old/big.bin')), git), BIG);
  assert.deepStrictEqual(by(win('old/big.bin')).seen.sort(), ['jetbrains cache', 'jetbrains history']);
  assert.strictEqual((await load(by(win('a.txt'), 'jetbrains history'), git)).toString(), 'one\r\ntwo\r\n');
  assert.strictEqual((await load(by(win('a.txt'), 'jetbrains history, as text'), git)).toString(), 'one\ntwo\n');
  assert.strictEqual((await load(by(win('한글/메모.txt')), git)).toString(), '안녕\r\n');
  const padded = await load(by(win('padded.txt')), git);
  assert.ok(padded.length > 16000 && padded.every((b) => b === 0x61));
  // Every record after padded.txt sits past a padding record, on the next page.
  assert.strictEqual(paddingIn(path.join(sys, 'caches', 'content.dat')), 1);
  assert.ok(results.every((r) => !r.draft), 'nothing here is newer than what the cache saw');
  assert.strictEqual(by(win('a.txt'), 'jetbrains history, as text').time, T(2, 30));
  assert.strictEqual(by(win('new.txt')).time, T(5, 30));
  assert.match(by(win('old/big.bin')).note, /deleted in the IDE/);
  assert.match(by(win('old/x.txt')).note, /editor's text/);
  const notes = perSource.flatMap((s) => s.notes);
  assert.deepStrictEqual(notes, ['IntelliJIdea2025.2: 5 record(s) failed a check and were left out']);
});

test('a name search reaches files inside deleted folders and Korean names', async () => {
  const sys = makeIde();
  assert.deepStrictEqual(rows((await find('z.txt', sys)).results), [['jetbrains history', win('old/sub/z.txt'), 1]]);
  assert.deepStrictEqual(rows((await find('메모', sys)).results), [['jetbrains cache', win('한글/메모.txt'), 1]]);
  const { results } = await search({ under: P + '\\old', sources: ['jetbrains'], locations: only({ dirs: { jetbrains: [sys] } }) });
  assert.deepStrictEqual(results.map((r) => r.path).sort(), [win('old/big.bin'), win('old/sub/z.txt'), win('old/x.txt')]);
});

test('Local History of an earlier cache is not read, since its content ids mean something else', async () => {
  const sys = makeIde({ lhCreated: CREATED + 1 });
  const { results, perSource } = await find('*', sys);
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.kind === 'jetbrains cache'), 'cache copies only');
  assert.ok(perSource[0].notes.some((n) => /earlier file cache/.test(n)));
});

test('a cache whose parts disagree, or whose IDE noted errors, is not read at all', async () => {
  const why = [
    [{ contentVersion: 64 }, /another version of the cache/],
    [{ errors: 2 }, /noted 2 error/],
    [{ twoNameLogs: true }, /two name logs/],
  ];
  for (const [opts, reason] of why) {
    const sys = makeIde(opts);
    const { results, perSource } = await find('*', sys);
    assert.deepStrictEqual(results, []);
    assert.ok(perSource[0].notes.some((n) => /file cache not read/.test(n) && reason.test(n)), JSON.stringify(opts));
    assert.ok(perSource[0].notes.some((n) => /Local History names its versions/.test(n)));
  }
});

test('Local History that is open in a running IDE is still read', async () => {
  const sys = makeIde({ lhMagic: 0x12ad34e4 });
  const { results } = await find('a.txt', sys);
  assert.strictEqual(results.length, 2);
});

test('a search by content alone offers cached versions no file points to any more', async () => {
  const sys = makeIde();
  const { results } = await find('', sys, { containing: 'NEEDLE' });
  assert.deepStrictEqual(results.map((r) => [r.kind, r.path]), [['jetbrains cache, name unknown', null]]);
  assert.strictEqual((await load(results[0], git)).toString(), 'an old version with the needle in it\n');
});

test('a cached file still on disk as it was is not offered; one changed since is', async () => {
  const root = workDir('jetbrains-real');
  dirs.push(root);
  const files = path.join(root, 'files');
  const same = write(path.join(files, 'same.txt'), 'same\n');
  // Big enough to have space of their own on disk (a small file lives inside NTFS's own record
  // and takes none), and random, so no compressing file system gives them less than their size.
  const [older, newer, touching] = [0, 1, 2].map(() => crypto.randomBytes(9000));
  write(path.join(files, 'changed.txt'), newer);
  const touched = write(path.join(files, 'touched.txt'), touching);
  const c = cacheBuilder();
  // The real folder, as the IDE would have recorded it: C: (or /) and then each folder in it.
  const top = path.parse(files).root;
  let parent = c.root(process.platform === 'win32' ? top.slice(0, 2) : '/');
  for (const s of path.relative(top, files).split(path.sep)) parent = c.dir(parent, s);
  c.file(parent, 'same.txt', Buffer.from('same\n'), { mtime: Math.trunc(fs.statSync(same).mtimeMs) });
  // Same size as on disk; only the bytes say whether it is the same file.
  c.file(parent, 'changed.txt', older, { mtime: 1000 });
  c.file(parent, 'touched.txt', touching, { mtime: Math.trunc(fs.statSync(touched).mtimeMs) - 5000 });
  const sys = path.join(root, 'PyCharm2025.2');
  c.save(path.join(sys, 'caches'));
  const { results } = await find('*.txt', sys);
  assert.deepStrictEqual(results.map((r) => [path.basename(r.path), r.state]), [['changed.txt', 'exists']]);
  assert.deepStrictEqual(await load(results[0], git), older);
});

test('padding is stepped over; a record that is padding or crosses a page end is refused', async () => {
  const root = workDir('jetbrains-pages');
  dirs.push(root);
  const sys = path.join(root, 'GoLand2025.2');
  // Pages small enough for both logs to pad, and zlib, the other way content can be compressed.
  const c = cacheBuilder({ namePage: 128, contentPage: 256, format: 0x01000001 });
  const proj = c.dir(c.dir(c.dir(c.root('C:'), 'Users'), 'alice'), 'proj');
  c.file(proj, 'first.txt', Buffer.from('first\r\n'));
  c.file(proj, 'fill.txt', Buffer.alloc(c.contentRoom() - 28 - 16, 0x61));
  c.file(proj, 'next.txt', Buffer.from('on the next page\r\n'));
  c.file(proj, 'pad.txt', null, { id: c.pads().content[0], length: 12 });
  // Whole and true to its SHA-1: only where it sits is wrong.
  const acrossBytes = Buffer.alloc(c.contentRoom(), 0x62);
  c.file(proj, 'across.txt', null, { id: c.content(acrossBytes, { straddle: true }), length: acrossBytes.length });
  const zipped = Buffer.from('hello\r\n'.repeat(500));
  c.file(proj, 'zipped.txt', null, { id: c.content(zipped, { zip: true }), length: zipped.length });
  c.content(Buffer.from('an old version with the needle in it\r\n'));
  c.save(path.join(sys, 'caches'));
  assert.ok(paddingIn(path.join(sys, 'caches', 'names.dat')) > 0, 'the name log pads');
  assert.ok(paddingIn(path.join(sys, 'caches', 'content.dat')) > 0, 'the content log pads');

  const { results, perSource } = await find('*', sys);
  assert.deepStrictEqual(results.map((r) => path.win32.basename(r.path)).sort(), ['fill.txt', 'first.txt', 'next.txt', 'zipped.txt']);
  assert.deepStrictEqual(await load(results.find((r) => r.path.endsWith('zipped.txt')), git), zipped);
  assert.deepStrictEqual(perSource[0].notes, ['GoLand2025.2: 2 record(s) failed a check and were left out']);
  const nameless = await find('', sys, { containing: 'needle' });
  assert.deepStrictEqual(nameless.results.map((r) => r.kind), ['jetbrains cache, name unknown']);
});

test('nothing under WSL, WebDAV, a device or A: is looked at, and a share that is down is asked once', async () => {
  const root = workDir('jetbrains-unc');
  dirs.push(root);
  const sys = path.join(root, 'IntelliJIdea2025.2');
  const c = cacheBuilder();
  const at = (top, ...rest) => rest.reduce((p, n) => c.dir(p, n), c.root(top));
  const wsl = at('//wsl.localhost/Ubuntu', 'home');
  c.file(wsl, 'a.txt', Buffer.from('a\r\n'), { flags: FREE });
  c.file(wsl, 'b.txt', Buffer.from('b\r\n'));
  c.file(at('//WSL$/Debian'), 'c.txt', Buffer.from('c\r\n'));
  c.file(at('//./pipe'), 'p', Buffer.from('p\r\n'));
  c.file(at('A:'), 'f.txt', Buffer.from('f\r\n'));
  c.file(at('//host@SSL/DavWWWRoot'), 'w.txt', Buffer.from('w\r\n'));
  const nas = at('//nas/share', 'proj');
  c.file(nas, 'n1.txt', Buffer.from('n1\r\n'), { flags: FREE });
  c.file(nas, 'n2.txt', Buffer.from('n2\r\n'));
  c.file(at('//srv/up', 'proj'), 's.txt', Buffer.from('s\r\n'));
  const X = c.content(Buffer.from('x\r\n'));
  c.save(path.join(sys, 'caches'));
  localHistory(path.join(sys, 'LocalHistory'), [changeSet(T(3), [
    change.content('//wsl$/Ubuntu/home/u/x.txt', X, T(2)),
    change.content('//./pipe/lh', X, T(2)),
    change.content('//nas/share/proj/old.txt', X, T(2)),
  ])], { created: CREATED });

  const { value: { results, perSource }, touched } = await guarded(['\\\\srv\\up\\'], () => find('*', sys));
  assert.deepStrictEqual(results.map((r) => r.path).sort(), [
    '\\\\nas\\share\\proj\\n1.txt', '\\\\nas\\share\\proj\\n2.txt', '\\\\nas\\share\\proj\\old.txt', '\\\\srv\\up\\proj\\s.txt',
  ]);
  const notes = perSource[0].notes;
  assert.ok(notes.some((n) => n.startsWith('IntelliJIdea2025.2: 6 file(s) on WSL, WebDAV, A: or B: were left out')), notes.join('\n'));
  assert.ok(touched.every((call) => /^\\\\(?:nas\\share|srv\\up)\\/.test(call.p)), 'only the two file shares');
  if (process.platform === 'win32') {
    // This source asks each share once, and looks at a file only on the share that answered.
    assert.deepStrictEqual(touched.filter((call) => call.here).map((call) => call.p),
      ['\\\\nas\\share\\', '\\\\srv\\up\\', '\\\\srv\\up\\proj\\s.txt']);
    const down = 'IntelliJIdea2025.2: \\\\nas\\share could not be reached, so 2 cached file(s) on it are offered'
      + ' without comparing them with the files there';
    assert.ok(notes.includes(down), notes.join('\n'));
    for (const name of ['n1.txt', 'n2.txt']) {
      assert.match(results.find((r) => r.path.endsWith(name)).note, /could not be reached/);
    }
  } else {
    assert.deepStrictEqual(touched, [], 'Windows paths are not looked up anywhere else');
  }
});

test('the editor\'s text of a file deleted unsaved is a draft, and rebuild takes the saved bytes', async () => {
  const root = workDir('jetbrains-draft');
  dirs.push(root);
  const sys = path.join(root, 'WebStorm2025.2');
  const c = cacheBuilder();
  const proj = c.dir(c.dir(c.dir(c.root('C:'), 'Users'), 'alice'), 'proj');
  c.file(proj, 'doc.txt', Buffer.from('saved\r\ntext\r\n'), { flags: FREE, mtime: T(1) });
  c.file(proj, 'kept.txt', Buffer.from('kept on disk\r\n'), { flags: FREE, mtime: T(4) });
  const EDITED = c.content(Buffer.from('saved\ntext\nand more, never saved\n'));
  const EARLIER = c.content(Buffer.from('an earlier version\n'));
  const SOLO = c.content(Buffer.from('open in the editor when deleted\n'));
  c.save(path.join(sys, 'caches'));
  localHistory(path.join(sys, 'LocalHistory'), [
    changeSet(T(2), [change.content(lh('kept.txt'), EARLIER, T(1, 30))]),
    changeSet(T(5), [change.delete(lh('doc.txt'), fileEntry('doc.txt', T(5, 1), EDITED))]),
    changeSet(T(6), [change.delete(lh('solo.txt'), fileEntry('solo.txt', T(6, 1), SOLO))]),
  ], { created: CREATED });

  const { results } = await find('*', sys);
  const text = (name) => results.find((r) => r.path === win(name) && r.kind === 'jetbrains history, as text');
  // Dated after the newest mtime the cache saw; and, with no cache record, stamped at deletion.
  for (const name of ['doc.txt', 'solo.txt']) {
    assert.strictEqual(text(name).draft, true, name);
    assert.match(text(name).note, /never saved/);
  }
  // Older than what the cache saw: maybe the editor's text, but not newer than anything saved.
  assert.strictEqual(text('kept.txt').draft, undefined);
  assert.deepStrictEqual(planRebuild(results, P).map(({ rel, copy }) => [rel.join('/'), copy.kind, copy.time]), [
    ['doc.txt', 'jetbrains cache', T(1)],
    ['kept.txt', 'jetbrains cache', T(4)],
    ['solo.txt', 'jetbrains history, as text', T(6, 1)],
  ]);
});

test('a content id gone stale is dated by the first time Local History recorded it there', async () => {
  // As the IDE leaves it: a change seen on disk but never read keeps the old content id beside
  // the new mtime, and a deletion wipes the flag that said so.
  const ide = (label, { length = 4, sets }) => {
    const root = workDir('jetbrains-stale');
    dirs.push(root);
    const sys = path.join(root, label);
    const c = cacheBuilder();
    const proj = c.dir(c.dir(c.dir(c.root('C:'), 'Users'), 'alice'), 'proj');
    const V1 = c.content(Buffer.from('v1\r\n'));
    const V2 = c.content(Buffer.from('v2 is longer\r\n'));
    c.file(proj, 'v.txt', null, { id: V1, flags: FREE, mtime: T(5), length });
    c.save(path.join(sys, 'caches'));
    localHistory(path.join(sys, 'LocalHistory'), sets(V1, V2), { created: CREATED });
    return sys;
  };
  const deleted = (id, mtime) => change.delete(lh('v.txt'), fileEntry('v.txt', mtime, id));
  const versions = async (sys) => (await find('v.txt', sys)).results
    .map((r) => [r.time, r.copies, r.buffer.toString()]).sort((a, b) => a[0] - b[0]);

  // The cache alone, then with the deletion Local History recorded: v1 is known only from T(1).
  const a = ide('Rider2025.2', { sets: (V1) => [changeSet(T(2), [change.content(lh('v.txt'), V1, T(1))])] });
  assert.deepStrictEqual(await versions(a), [[T(1), 2, 'v1\r\n']]);
  assert.match((await find('v.txt', a)).results[0].note, /first recorded/);
  const b = ide('Rider2025.2', { sets: (V1) => [
    changeSet(T(2), [change.content(lh('v.txt'), V1, T(1))]),
    changeSet(T(6), [deleted(V1, T(5))]),
  ] });
  assert.deepStrictEqual(await versions(b), [[T(1), 3, 'v1\r\n']]);
  // A newer version of another length fails the cache's own check; Local History is dated all the same.
  const c = ide('Rider2025.2', { length: 5, sets: (V1) => [
    changeSet(T(2), [change.content(lh('v.txt'), V1, T(1))]),
    changeSet(T(6), [deleted(V1, T(5))]),
  ] });
  assert.deepStrictEqual(await versions(c), [[T(1), 2, 'v1\r\n']]);
  // A revert, v1 then v2 then v1 again, is not stale: v1 keeps the date it was deleted with.
  const d = ide('Rider2025.2', { sets: (V1, V2) => [
    changeSet(T(2), [change.content(lh('v.txt'), V1, T(1))]),
    changeSet(T(4), [change.content(lh('v.txt'), V2, T(3))]),
    changeSet(T(6), [deleted(V1, T(5))]),
  ] });
  assert.deepStrictEqual(await versions(d), [[T(3), 1, 'v2 is longer\r\n'], [T(5), 3, 'v1\r\n']]);
});

test('a place can be a system folder, its LocalHistory or caches folder, or a folder of them', () => {
  const sys = makeIde();
  const parent = path.dirname(sys);
  for (const place of [sys, path.join(sys, 'LocalHistory'), path.join(sys, 'caches'), parent]) {
    assert.deepStrictEqual(systemsOf(place).map((s) => s.dir), [sys], place);
  }
  const protectedDirs = jb.roots({ jetbrains: [path.join(sys, 'LocalHistory')] });
  assert.ok(protectedDirs.includes(path.join(sys, 'caches')), 'the cache beside it is protected too');
  assert.deepStrictEqual(systemsOf(path.join(parent, 'nothing-here')), []);
});

test('describe says what each folder holds', () => {
  const sys = makeIde();
  const lines = jb.describe({ locations: { jetbrains: [sys] } });
  assert.deepStrictEqual(lines, [
    `${sys}: file cache, 12 file(s) with content, 1 of them deleted in the IDE`,
    `${sys}: Local History, 8 change set(s), 9 version(s) with content`,
  ]);
  assert.deepStrictEqual(jb.describe({ locations: { jetbrains: [] } }), ['No JetBrains IDE folder found.']);
});

test('searching writes nothing into the IDE folder', async () => {
  const sys = makeIde();
  const before = snapshot(sys);
  await find('*', sys);
  await find('', sys, { containing: 'needle' });
  jb.describe({ locations: { jetbrains: [sys] } });
  assert.deepStrictEqual(snapshot(sys), before);
});
