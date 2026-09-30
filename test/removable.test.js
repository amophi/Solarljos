'use strict';

const { test, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { workDir, cleanup, write, only, snapshot } = require('./helpers');
const { search, readCopy, restoreCopy, describeSources, tier } = require('../src/index');
const removable = require('../src/sources/removable');

const { env, placeOf, nameMatches } = removable._internal;
const realEnv = { ...env };

const dirs = [];
after(() => dirs.forEach(cleanup));
afterEach(() => Object.assign(env, realEnv));

// Card images are built here by a small formatter of this file's own (fatgen103, Microsoft's exFAT
// specification), as test/lib-fat.test.js builds its own: files are written, then deleted the way
// the drivers delete them -- Linux keeps the first cluster whole, Windows clears its high half on
// FAT32 -- and the source is pointed at the image with --location removable=<file>.

const SECTOR = 512;

/** Bytes that differ from file to file, from a seeded xorshift, so every run builds the same images. */
function bytes(n, seed) {
  const b = Buffer.alloc(n);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    b[i] = x & 0xff;
  }
  return b;
}

let CRC = null;
function crc32(buf) {
  if (!CRC) {
    CRC = new Uint32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
  }
  let c = 0xffffffff;
  for (const x of buf) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, 'latin1');
  data.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}

/** An RGB PNG of random pixels, stored rather than compressed so that it spans many clusters. */
function makePng(seed, width, height) {
  const noise = bytes(height * (1 + width * 3), seed);
  for (let y = 0; y < height; y++) noise[y * (1 + width * 3)] = 0;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const z = zlib.deflateSync(noise, { level: 0 });
  const idats = [];
  for (let i = 0; i < z.length; i += 8192) idats.push(pngChunk('IDAT', z.subarray(i, i + 8192)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), ...idats,
    pngChunk('IEND', Buffer.alloc(0))]);
}

/** A wall-clock time [y, mo, d, h, mi, s] as DOS date and time. */
function dos([y, mo, d, h, mi, s]) {
  return { date: ((y - 1980) << 9) | (mo << 5) | d, time: (h << 11) | (mi << 5) | (s >> 1) };
}
const WHEN = [2023, 5, 20, 14, 30, 10];

// ------------------------------------------------------------------ a FAT formatter

function sum8(name11) {
  let s = 0;
  for (let i = 0; i < 11; i++) s = ((s & 1 ? 0x80 : 0) + (s >> 1) + name11[i]) & 0xff;
  return s;
}

/** Where character j of a long-name entry goes: 5 at 1, 6 at 14, 2 at 28. */
const lfnAt = (j) => (j < 5 ? 1 + 2 * j : j < 11 ? 4 + 2 * j : 6 + 2 * j);

class FatImage {
  constructor({ type, sectors }) {
    this.type = type;
    this.cs = SECTOR;
    this.rsvd = type === 32 ? 32 : 1;
    this.rootEnt = type === 32 ? 0 : 512;
    this.tot = sectors;
    const rootSecs = (this.rootEnt * 32) / SECTOR;
    let fatsz = 1;
    for (;;) {
      const clusters = sectors - this.rsvd - rootSecs - 2 * fatsz;
      const need = Math.ceil(((clusters + 2) * (type / 8)) / SECTOR);
      if (need <= fatsz) break;
      fatsz = need;
    }
    this.fatsz = fatsz;
    this.clusters = sectors - this.rsvd - rootSecs - 2 * fatsz;
    this.rootOff = (this.rsvd + 2 * fatsz) * SECTOR;
    this.dataOff = this.rootOff + rootSecs * SECTOR;
    this.eoc = type === 32 ? 0x0fffffff : 0xffff;
    this.buf = Buffer.alloc(sectors * SECTOR);
    this.fat = new Uint32Array(this.clusters + 2);
    this.fat[0] = this.eoc - 7;
    this.fat[1] = this.eoc;
    this.slots = [];
    this.items = new Map();
    if (type === 32) this.fat[2] = this.eoc;
  }

  at(c) {
    return this.dataOff + (c - 2) * this.cs;
  }

  /** A file in the root in one piece from `first`, under an 8.3 name or with a long one. */
  file(name, data, first, when = WHEN) {
    const n = Math.max(1, Math.ceil(data.length / this.cs));
    const clusters = Array.from({ length: n }, (_, i) => first + i);
    clusters.forEach((c, i) => {
      assert.strictEqual(this.fat[c], 0, `cluster ${c} is in use`);
      this.fat[c] = i + 1 < n ? c + 1 : this.eoc;
    });
    data.copy(this.buf, this.at(first));
    const short = /^[A-Z0-9_]{1,8}\.[A-Z0-9]{1,3}$/.test(name);
    // A long name's short one starts with its first letters, which is how a deleted one is tied to it.
    const stem = name.slice(0, name.lastIndexOf('.')).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const [b, e] = short ? name.split('.') : [`${stem.slice(0, 6)}~1`, name.split('.').pop().toUpperCase().slice(0, 3)];
    const name11 = Buffer.from(b.padEnd(8) + e.padEnd(3), 'latin1');
    const slots = [];
    if (!short) {
      const units = [...name].map((ch) => ch.charCodeAt(0));
      const count = Math.ceil(units.length / 13);
      if (units.length % 13) units.push(0);
      while (units.length < count * 13) units.push(0xffff);
      for (let k = count; k >= 1; k--) {
        const s = Buffer.alloc(32);
        s[0] = k | (k === count ? 0x40 : 0);
        s[11] = 0x0f;
        s[13] = sum8(name11);
        units.slice((k - 1) * 13, k * 13).forEach((u, j) => s.writeUInt16LE(u, lfnAt(j)));
        slots.push(s);
      }
    }
    const s = Buffer.alloc(32);
    name11.copy(s, 0);
    s[11] = 0x20;
    const w = dos(when);
    s.writeUInt16LE(w.time, 14);
    s.writeUInt16LE(w.date, 16);
    s.writeUInt16LE(w.date, 18);
    s.writeUInt16LE(this.type === 32 ? first >>> 16 : 0, 20);
    s.writeUInt16LE(w.time, 22);
    s.writeUInt16LE(w.date, 24);
    s.writeUInt16LE(first & 0xffff, 26);
    s.writeUInt32LE(data.length, 28);
    slots.push(s);
    this.slots.push(...slots);
    this.items.set(name, { clusters, slots });
  }

  /** Deleted as Linux does it (first cluster kept whole), or as Windows does (its high half cleared on FAT32). */
  remove(name, style) {
    const it = this.items.get(name);
    for (const s of it.slots) s[0] = 0xe5;
    for (const c of it.clusters) this.fat[c] = 0;
    if (style === 'windows' && this.type === 32) it.slots[it.slots.length - 1].writeUInt16LE(0, 20);
  }

  image() {
    const b = this.buf;
    b[0] = 0xeb;
    b[1] = 0x3c;
    b[2] = 0x90;
    b.write('MSWIN4.1', 3, 'latin1');
    b.writeUInt16LE(SECTOR, 11);
    b[13] = 1;
    b.writeUInt16LE(this.rsvd, 14);
    b[16] = 2;
    b.writeUInt16LE(this.rootEnt, 17);
    if (this.tot < 65536) b.writeUInt16LE(this.tot, 19);
    else b.writeUInt32LE(this.tot, 32);
    b[21] = 0xf8;
    const sig = this.type === 32 ? 66 : 38;
    if (this.type === 32) {
      b.writeUInt32LE(this.fatsz, 36);
      b.writeUInt32LE(2, 44);
      b.writeUInt16LE(1, 48);
      b.writeUInt16LE(6, 50);
    } else {
      b.writeUInt16LE(this.fatsz, 22);
    }
    b[sig] = 0x29;
    b.writeUInt32LE(0x1234abcd, sig + 1);
    b.write('NO NAME    ', sig + 5, 'latin1');
    b[510] = 0x55;
    b[511] = 0xaa;
    if (this.type === 32) b.copy(b, 6 * SECTOR, 0, SECTOR);
    for (let k = 0; k < 2; k++) {
      const base = (this.rsvd + k * this.fatsz) * SECTOR;
      for (let c = 0; c < this.fat.length; c++) {
        if (this.type === 32) b.writeUInt32LE(this.fat[c], base + 4 * c);
        else b.writeUInt16LE(this.fat[c], base + 2 * c);
      }
    }
    const all = Buffer.concat(this.slots);
    all.copy(b, this.type === 32 ? this.at(2) : this.rootOff);
    return b;
  }
}

// ------------------------------------------------------------------ an exFAT formatter

function sum16(set) {
  let s = 0;
  for (let i = 0; i < set.length; i++) if (i !== 2 && i !== 3) s = ((s & 1 ? 0x8000 : 0) + (s >> 1) + set[i]) & 0xffff;
  return s;
}

function sum32(buf, skip = []) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) if (!skip.includes(i)) s = ((s & 1 ? 0x80000000 : 0) + (s >>> 1) + buf[i]) >>> 0;
  return s;
}

// An up-case table that maps ASCII letters and nothing else, compressed as the specification allows.
const UPCASE = (() => {
  const units = [0xffff, 0x61];
  for (let i = 0x61; i <= 0x7a; i++) units.push(i - 32);
  units.push(0xffff, 65536 - 0x7b);
  const b = Buffer.alloc(units.length * 2);
  units.forEach((u, k) => b.writeUInt16LE(u, 2 * k));
  return b;
})();
const up = (u) => (u >= 0x61 && u <= 0x7a ? u - 32 : u);

function hash16(name) {
  let h = 0;
  for (const ch of name) {
    const u = up(ch.charCodeAt(0));
    h = ((h & 1 ? 0x8000 : 0) + (h >> 1) + (u & 0xff)) & 0xffff;
    h = ((h & 1 ? 0x8000 : 0) + (h >> 1) + (u >> 8)) & 0xffff;
  }
  return h;
}

class ExfatImage {
  constructor({ sectors }) {
    this.cs = 4096;
    this.tot = sectors;
    this.fatOffset = 128;
    this.fatLength = Math.ceil(((sectors / 8 + 2) * 4) / SECTOR);
    this.heapOffset = Math.ceil((this.fatOffset + this.fatLength) / 8) * 8;
    this.clusters = Math.floor((sectors - this.heapOffset) / 8);
    this.buf = Buffer.alloc(sectors * SECTOR);
    this.fat = new Uint32Array(this.clusters + 2);
    this.fat[0] = 0xfffffff8;
    this.fat[1] = 0xffffffff;
    this.bitmap = Buffer.alloc(Math.ceil(this.clusters / 8));
    this.items = new Map();
    for (const c of [2, 3, 4]) this.use(c, true);
    const e81 = Buffer.alloc(32);
    e81[0] = 0x81;
    e81.writeUInt32LE(2, 20);
    e81.writeBigUInt64LE(BigInt(this.bitmap.length), 24);
    const e82 = Buffer.alloc(32);
    e82[0] = 0x82;
    e82.writeUInt32LE(sum32(UPCASE), 4);
    e82.writeUInt32LE(3, 20);
    e82.writeBigUInt64LE(BigInt(UPCASE.length), 24);
    this.slots = [e81, e82];
  }

  at(c) {
    return this.heapOffset * SECTOR + (c - 2) * this.cs;
  }

  use(c, chainEnd) {
    this.bitmap[(c - 2) >> 3] |= 1 << ((c - 2) & 7);
    if (chainEnd) this.fat[c] = 0xffffffff;
  }

  /** A file in the root in one piece from `first`, with no FAT chain, as Windows writes one. */
  file(name, data, first, { when = WHEN, offsetQ = 36 } = {}) {
    const n = Math.max(1, Math.ceil(data.length / this.cs));
    const clusters = Array.from({ length: n }, (_, i) => first + i);
    for (const c of clusters) this.use(c, false);
    data.copy(this.buf, this.at(first));
    const names = Math.ceil(name.length / 15);
    const set = Buffer.alloc(32 * (2 + names));
    set[0] = 0x85;
    set[1] = 1 + names;
    set.writeUInt16LE(0x20, 4);
    const w = dos(when);
    const ts = ((w.date << 16) | w.time) >>> 0;
    for (const o of [8, 12, 16]) set.writeUInt32LE(ts, o);
    for (const o of [22, 23, 24]) set[o] = 0x80 | (offsetQ & 0x7f);
    set[32] = 0xc0;
    set[33] = 0x03;
    set[35] = name.length;
    set.writeUInt16LE(hash16(name), 36);
    set.writeBigUInt64LE(BigInt(data.length), 40);
    set.writeUInt32LE(first, 52);
    set.writeBigUInt64LE(BigInt(data.length), 56);
    for (let k = 0; k < names; k++) {
      set[64 + 32 * k] = 0xc1;
      set.write(name.slice(15 * k, 15 * k + 15), 64 + 32 * k + 2, 'utf16le');
    }
    set.writeUInt16LE(sum16(set), 2);
    this.slots.push(set);
    this.items.set(name, { set, clusters });
  }

  /** Deleted as Windows and Linux do it: InUse cleared, the bitmap bits cleared, the rest kept. */
  remove(name) {
    const it = this.items.get(name);
    for (let k = 0; k < it.set.length; k += 32) it.set[k] &= 0x7f;
    for (const c of it.clusters) this.bitmap[(c - 2) >> 3] &= ~(1 << ((c - 2) & 7));
  }

  image() {
    const b = this.buf;
    const r = Buffer.alloc(12 * SECTOR);
    r[0] = 0xeb;
    r[1] = 0x76;
    r[2] = 0x90;
    r.write('EXFAT   ', 3, 'latin1');
    r.writeBigUInt64LE(BigInt(this.tot), 72);
    r.writeUInt32LE(this.fatOffset, 80);
    r.writeUInt32LE(this.fatLength, 84);
    r.writeUInt32LE(this.heapOffset, 88);
    r.writeUInt32LE(this.clusters, 92);
    r.writeUInt32LE(4, 96);
    r.writeUInt32LE(0xcafe1234, 100);
    r.writeUInt16LE(0x0100, 104);
    r[108] = 9;
    r[109] = 3;
    r[110] = 1;
    r[111] = 0x80;
    r[510] = 0x55;
    r[511] = 0xaa;
    for (let s = 1; s <= 8; s++) r.writeUInt32LE(0xaa550000, s * SECTOR + 508);
    const s = sum32(r.subarray(0, 11 * SECTOR), [106, 107, 112]);
    for (let i = 11 * SECTOR; i < 12 * SECTOR; i += 4) r.writeUInt32LE(s, i);
    r.copy(b, 0);
    r.copy(b, 12 * SECTOR);
    for (let c = 0; c < this.fat.length; c++) b.writeUInt32LE(this.fat[c], this.fatOffset * SECTOR + 4 * c);
    this.bitmap.copy(b, this.at(2));
    UPCASE.copy(b, this.at(3));
    Buffer.concat(this.slots).copy(b, this.at(4));
    return b;
  }
}

// ------------------------------------------------------------------ the cards

const PHOTO = makePng(1, 80, 60); // 14,5xx bytes: 29 clusters of 512
const HIDDEN = makePng(2, 40, 30);
const STORY = Buffer.from('Once upon a time. '.repeat(200));

/** A FAT16 card: a photo, a note and a story deleted by Linux; a photo carved from free space with no entry. */
function fat16Card() {
  const img = new FatImage({ type: 16, sectors: 8192 });
  img.file('holiday photo.png', PHOTO, 100);
  img.file('NOTE.TXT', Buffer.from('buy milk\r\n'), 200);
  img.file('long story.txt', STORY, 300);
  img.file('fake.jpg', bytes(3000, 9), 400);
  img.file('LIVE.TXT', Buffer.from('still here'), 500);
  img.file('bmw service.txt', Buffer.from('BMW service on Monday, 9:00'), 600);
  for (const n of ['holiday photo.png', 'NOTE.TXT', 'long story.txt', 'fake.jpg', 'bmw service.txt']) img.remove(n, 'linux');
  const buf = img.image();
  // A picture whose entry was reused long ago: nothing but its bytes is left, in free clusters.
  HIDDEN.copy(buf, img.at(1000));
  return buf;
}

function saved(name, buf) {
  const dir = workDir('removable');
  dirs.push(dir);
  return { dir, file: write(path.join(dir, name), buf) };
}

const where = (file) => only({ dirs: { removable: [file] } });
const find = (file, o = {}) => search({ sources: ['removable'], locations: where(file), ...o });
const notesOf = (res) => res.perSource.find((s) => s.id === 'removable').notes;

test('deleted files on a FAT16 image come back with flags that say how far they can be trusted', async () => {
  const { dir, file } = saved('card.img', fat16Card());
  const before = snapshot(dir);
  const res = await find(file, { pattern: '*' });
  const by = (name) => res.results.find((c) => c.path === `[card.img]\\${name}`);

  const photo = by('holiday photo.png');
  assert.ok(photo, res.results.map((c) => c.path).join(', '));
  assert.strictEqual(photo.kind, 'fat undelete');
  assert.strictEqual(photo.size, PHOTO.length);
  assert.strictEqual(photo.width, 80);
  // A PNG's CRCs cover every byte, and it ends exactly at the size its entry records: it is the file.
  assert.strictEqual(tier(photo), 0);
  assert.strictEqual(photo.mediaType, 'image');
  assert.deepStrictEqual(await readCopy(photo), PHOTO);
  assert.strictEqual(photo.time, new Date(2023, 4, 20, 14, 30, 10).getTime());

  // One cluster at a known start: where it lay is known, but nothing checks what it holds.
  const note = by('_OTE.TXT');
  assert.ok(note);
  assert.strictEqual(tier(note), 1);
  assert.match(note.note, /first character of its name was lost/);
  assert.strictEqual((await readCopy(note)).toString(), 'buy milk\r\n');

  // More than one cluster: those after the first are only taken to follow on.
  const story = by('long story.txt');
  assert.strictEqual(tier(story), 3);
  assert.deepStrictEqual(await readCopy(story), STORY);

  // Text that starts as a BMP does is still text: only a name that says BMP is held to being one.
  const bmw = by('bmw service.txt');
  assert.ok(bmw);
  assert.strictEqual(tier(bmw), 1);

  // A .jpg that holds no JPEG was written over since: left out, and counted.
  assert.ok(!by('fake.jpg'));
  assert.ok(notesOf(res).some((n) => /1 deleted file\(s\) left out: their bytes are no longer of the format/.test(n)),
    notesOf(res).join('\n'));
  // Nothing is carved for a search with a name.
  assert.ok(!res.results.some((c) => c.kind === 'carved'));
  assert.ok(!res.results.some((c) => /LIVE/.test(c.path)));
  assert.deepStrictEqual(snapshot(dir), before);
});

test('a name searched for finds a short name whose first character was lost', async () => {
  const { file } = saved('card.img', fat16Card());
  const res = await find(file, { pattern: 'NOTE.TXT' });
  assert.deepStrictEqual(res.results.map((c) => c.path), ['[card.img]\\_OTE.TXT']);
  const none = await find(file, { pattern: 'QUOTE.TXT' });
  assert.strictEqual(none.results.length, 0);
  const m = { test: (p) => /\\note\.txt$/i.test(p) };
  assert.ok(nameMatches(m, '[x]\\', { path: '_OTE.TXT', nameCertain: false }));
  assert.ok(!nameMatches(m, '[x]\\', { path: '_OTE.TXT', nameCertain: true }));
});

test('a search for pictures carves free space and offers what it finds, nameless and unverified', async () => {
  const { dir, file } = saved('card.img', fat16Card());
  const before = snapshot(dir);
  const res = await find(file, { pattern: '', types: ['image'] });
  const carved = res.results.filter((c) => c.kind === 'carved');
  assert.strictEqual(carved.length, 1, JSON.stringify(res.results.map((c) => [c.kind, c.path, c.size])));
  const c = carved[0];
  assert.strictEqual(c.path, null);
  assert.strictEqual(c.ext, '.png');
  assert.strictEqual(c.mediaType, 'image');
  assert.strictEqual(c.size, HIDDEN.length);
  assert.strictEqual(tier(c), 3);
  assert.deepStrictEqual(await readCopy(c), HIDDEN);
  // The deleted photo, which has its entry, is not carved a second time; text is not a picture.
  const paths = res.results.map((r) => r.path);
  assert.ok(paths.includes('[card.img]\\holiday photo.png'));
  assert.ok(!paths.some((p) => p && /\.txt$/i.test(p)));
  assert.ok(notesOf(res).some((n) => /^\[card\.img\]: .* of free space carved, 1 file\(s\) found$/.test(n)), notesOf(res).join('\n'));

  const out = path.join(dir, 'out');
  const written = await restoreCopy(c, out, res.locations);
  assert.strictEqual(path.basename(written), `recovered-${c.id} (may be incomplete).png`);
  assert.deepStrictEqual(fs.readFileSync(written), HIDDEN);
  const photo = await restoreCopy(res.results.find((r) => r.path && r.path.endsWith('holiday photo.png')), out, res.locations);
  assert.strictEqual(path.basename(photo), 'holiday photo.png');
  assert.deepStrictEqual(fs.readFileSync(photo), PHOTO);
  assert.deepStrictEqual(fs.readdirSync(out).sort(), ['holiday photo.png', path.basename(written)].sort());
  // The image is still exactly as it was.
  assert.strictEqual(snapshot(dir)['card.img'], before['card.img']);
});

test('nothing is restored onto the image, and a drive given is protected whole', async () => {
  const { file } = saved('card.img', fat16Card());
  const res = await find(file, { pattern: 'holiday' });
  await assert.rejects(restoreCopy(res.results[0], path.join(file, 'x'), res.locations), /Refusing to write inside/);
  assert.deepStrictEqual(removable.roots({ removable: [file] }), [path.resolve(file)]);
  assert.deepStrictEqual(removable.roots({ removable: ['e:', '\\\\.\\F:', 'G:\\'] }), ['E:\\', 'F:\\', 'G:\\']);
  assert.deepStrictEqual(removable.roots({ removable: ['\\\\.\\PhysicalDrive1'] }), []);
});

test('places: a drive letter is its device, anything else an image', () => {
  assert.deepStrictEqual(
    ['E:', 'e:\\', '\\\\.\\E:', '\\\\?\\e:'].map((s) => placeOf(s).open),
    ['\\\\.\\E:', '\\\\.\\E:', '\\\\.\\E:', '\\\\.\\E:']);
  assert.strictEqual(placeOf('\\\\.\\PhysicalDrive2').kind, 'device');
  assert.strictEqual(placeOf('/dev/sdb1').kind, 'device');
  assert.strictEqual(placeOf('/dev/sdb1').name, 'sdb1');
  assert.strictEqual(placeOf('card.img').kind, 'image');
  assert.strictEqual(placeOf('card.img').open, path.resolve('card.img'));
});

test('a drive is not opened without administrator rights, and the notes say what to do instead', async () => {
  env.platform = () => 'win32';
  env.elevated = () => false;
  const res = await find('Q:', { pattern: '*' });
  assert.strictEqual(res.results.length, 0);
  const notes = notesOf(res).join('\n');
  assert.match(notes, /Reading drive Q directly needs administrator rights\. Run as administrator, or make a disk image with another tool and give its path\./);
  assert.match(notes, /lock switch/);
  assert.match(notes, /never save or copy anything onto it/);
  const [d] = await describeSources({ sources: ['removable'], locations: where('Q:') });
  assert.ok(d.lines.some((l) => /Run as administrator/.test(l)));

  env.platform = () => 'linux';
  const elsewhere = await find('Q:', { pattern: '*' });
  assert.match(notesOf(elsewhere).join('\n'), /a drive letter can be read only on Windows/);
});

test('a place that is missing or a folder says so', async () => {
  const { dir } = saved('x.txt', 'x');
  const res = await find(path.join(dir, 'nothing.img'), { pattern: '*' });
  assert.match(notesOf(res).join('\n'), /no such drive or file/);
  const folder = await find(dir, { pattern: '*' });
  assert.match(notesOf(folder).join('\n'), /is a folder/);
});

test('exFAT: a file recorded in one piece comes back exact when its content proves it, inexact otherwise', async () => {
  const img = new ExfatImage({ sectors: 8192 });
  img.file('DSC_0001.png', PHOTO, 10, { offsetQ: 36 });
  img.file('diary.txt', STORY, 20);
  img.file('kept.txt', Buffer.from('kept'), 30);
  img.remove('DSC_0001.png');
  img.remove('diary.txt');
  const { file } = saved('sd.img', img.image());
  const res = await find(file, { pattern: '*' });
  const photo = res.results.find((c) => c.path === '[sd.img]\\DSC_0001.png');
  assert.ok(photo, JSON.stringify(res.results.map((c) => c.path)));
  assert.strictEqual(photo.kind, 'exfat undelete');
  assert.strictEqual(tier(photo), 0);
  // +09:00, as its entry records.
  assert.strictEqual(photo.time, Date.UTC(2023, 4, 20, 5, 30, 10));
  assert.deepStrictEqual(await readCopy(photo), PHOTO);
  const diary = res.results.find((c) => c.path === '[sd.img]\\diary.txt');
  assert.strictEqual(tier(diary), 1);
  assert.deepStrictEqual(await readCopy(diary), STORY);
  assert.ok(!res.results.some((c) => /kept/.test(c.path)));
  const [d] = await describeSources({ sources: ['removable'], locations: where(file) });
  assert.ok(d.lines.some((l) => /exFAT, .*4096-byte clusters/.test(l)), d.lines.join('\n'));
});

test('FAT32 deleted by Windows: the start that holds a whole picture is found; text that cannot be told is left out', async () => {
  const img = new FatImage({ type: 32, sectors: 72000 });
  assert.ok(img.clusters > 0x10000);
  img.file('Pic.png', PHOTO, 70000);
  img.file('Words.txt', STORY, 69000);
  img.remove('Pic.png', 'windows');
  img.remove('Words.txt', 'windows');
  const { file } = saved('big.img', img.image());
  const res = await find(file, { pattern: '*' });
  assert.deepStrictEqual(res.results.map((c) => c.path), ['[big.img]\\Pic.png']);
  assert.deepStrictEqual(await readCopy(res.results[0]), PHOTO);
  assert.strictEqual(res.results[0].extent.runs[0][0], img.at(70000));
  assert.ok(notesOf(res).some((n) => /1 deleted file\(s\) left out: none of the places they may have started/.test(n)),
    notesOf(res).join('\n'));
});

test('an image with no file system left is carved whole', async () => {
  const buf = Buffer.alloc(256 * 1024);
  PHOTO.copy(buf, 8192);
  const { file } = saved('wiped.img', buf);
  const res = await find(file, { pattern: '', types: ['image', 'video'] });
  assert.strictEqual(res.results.length, 1);
  assert.strictEqual(res.results[0].extent.runs[0][0], 8192);
  assert.deepStrictEqual(await readCopy(res.results[0]), PHOTO);
  // A search for text has nothing to carve for.
  const text = await find(file, { pattern: '', types: ['text'] });
  assert.strictEqual(text.results.length, 0);
  const [d] = await describeSources({ sources: ['removable'], locations: where(file) });
  assert.ok(d.lines.some((l) => /no FAT or exFAT file system/.test(l)), d.lines.join('\n'));
});

test('a disk with two volumes names each in its paths', async () => {
  const one = fat16Card();
  const two = new FatImage({ type: 16, sectors: 8192 });
  two.file('SECOND.TXT', Buffer.from('from the second volume'), 50);
  two.remove('SECOND.TXT', 'linux');
  const vol2 = two.image();
  const first = 2048;
  const second = first + one.length / SECTOR;
  const disk = Buffer.alloc(second * SECTOR + vol2.length);
  one.copy(disk, first * SECTOR);
  vol2.copy(disk, second * SECTOR);
  [[first, one.length / SECTOR], [second, vol2.length / SECTOR]].forEach(([lba, count], i) => {
    const e = 446 + 16 * i;
    disk[e + 4] = 0x06;
    disk.writeUInt32LE(lba, e + 8);
    disk.writeUInt32LE(count, e + 12);
  });
  disk[510] = 0x55;
  disk[511] = 0xaa;
  const { file } = saved('disk.img', disk);
  const res = await find(file, { pattern: '*.txt' });
  const paths = res.results.map((c) => c.path).sort();
  assert.ok(paths.includes('[disk.img, volume 2]\\_ECOND.TXT'), paths.join(', '));
  assert.ok(paths.includes('[disk.img, volume 1]\\long story.txt'), paths.join(', '));
  assert.deepStrictEqual((await readCopy(res.results.find((c) => /_ECOND/.test(c.path)))).toString(), 'from the second volume');
});

test('a device that says nothing of its size ends where reading it stops', () => {
  const { probeSize } = removable._internal;
  const device = (size) => ({
    size: null,
    read(off, len) {
      if (off >= size) throw Object.assign(new Error('past the end'), { code: 'EIO' });
      return Buffer.alloc(Math.min(len, size - off));
    },
  });
  assert.strictEqual(probeSize(device(3 * 1024 * 1024)), 3 * 1024 * 1024);
  assert.strictEqual(probeSize(device(4096 * 1001 + 100)), 4096 * 1001);
  assert.strictEqual(probeSize(device(0)), null);
});

test('a search that is stopped stops', async () => {
  const { file } = saved('card.img', fat16Card());
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(find(file, { pattern: '', types: ['image'], signal: stop.signal }), { name: 'AbortError' });
});

test('a deleted file whose clusters hold another format now is left out, and what is there carved', async () => {
  const png = makePng(7, 40, 30);
  // exFAT, where a file in one piece is recorded whole: a .JPG whose clusters hold a PNG and more.
  const ex = new ExfatImage({ sectors: 8192 });
  ex.file('IMG_0001.JPG', Buffer.concat([png, bytes(300, 3)]), 10);
  ex.remove('IMG_0001.JPG');
  const { file: exFile } = saved('ex.img', ex.image());
  const named = await find(exFile, { pattern: '*' });
  assert.deepStrictEqual(named.results.map((c) => c.path), []);
  assert.ok(notesOf(named).some((n) => /1 deleted file\(s\) left out: their bytes are no longer of the format/.test(n)), notesOf(named).join('\n'));
  const pictures = await find(exFile, { pattern: '', types: ['image'] });
  assert.deepStrictEqual(pictures.results.map((c) => [c.kind, c.ext, c.size]), [['carved', '.png', png.length]]);

  // FAT16: an old clip deleted, and a later picture written into its clusters, whose own entry
  // is gone too. The clip is not the picture, and its entry, not looked at in a search for
  // pictures, does not keep the picture from being carved.
  const f = new FatImage({ type: 16, sectors: 8192 });
  f.file('CLIP0001.MOV', bytes(png.length + 2000, 4), 300);
  f.remove('CLIP0001.MOV', 'linux');
  const buf = f.image();
  png.copy(buf, f.at(300));
  const { file: fatFile } = saved('clip.img', buf);
  for (const types of [['image'], ['image', 'video']]) {
    const res = await find(fatFile, { pattern: '', types });
    assert.deepStrictEqual(res.results.map((c) => [c.kind, c.ext]), [['carved', '.png']], types.join());
  }
});

test('bytes of another format that are whole, to the recorded size, are the file under a name not its own', async () => {
  const tiny = makePng(5, 4, 4);
  const f = new FatImage({ type: 16, sectors: 8192 });
  f.file('IMG_0002.JPG', tiny, 100);
  f.remove('IMG_0002.JPG', 'linux');
  const ex = new ExfatImage({ sectors: 8192 });
  const png = makePng(6, 40, 30);
  ex.file('notes.txt', png, 10);
  ex.remove('notes.txt');
  const { file: fatFile } = saved('renamed.img', f.image());
  const [photo] = (await find(fatFile, { pattern: '*' })).results;
  assert.deepStrictEqual([photo.path, photo.ext, photo.mediaType, tier(photo)], ['[renamed.img]\\_MG_0002.JPG', '.png', 'image', 0]);
  assert.match(photo.note, /its bytes are a whole PNG, of exactly the size recorded/);
  assert.deepStrictEqual(await readCopy(photo), tiny);
  // A .txt that holds a picture: not looked at in a search for pictures, whose carving finds it.
  const { file: exFile } = saved('notes.img', ex.image());
  const pictures = await find(exFile, { pattern: '', types: ['image'] });
  assert.deepStrictEqual(pictures.results.map((c) => [c.kind, c.ext]), [['carved', '.png']]);
  const [text] = (await find(exFile, { pattern: '*' })).results;
  assert.deepStrictEqual([text.path, text.mediaType, text.ext], ['[notes.img]\\notes.txt', 'image', '.png']);
});

test('a PNG that ends before the size recorded may be a shorter file written over a longer one', async () => {
  const png = makePng(8, 40, 30);
  const ex = new ExfatImage({ sectors: 8192 });
  ex.file('DSC_0003.png', Buffer.concat([png, bytes(300, 5)]), 10);
  ex.remove('DSC_0003.png');
  const { file } = saved('short.img', ex.image());
  const [c] = (await find(file, { pattern: '*' })).results;
  assert.strictEqual(tier(c), 3);
  assert.match(c.note, /has nothing after its end, which comes 300 bytes before the size recorded/);
});

test('a card changed since the search is not restored from', async () => {
  const png = makePng(9, 40, 30);
  const ex = new ExfatImage({ sectors: 8192 });
  ex.file('DSC_0002.png', png, 10);
  ex.remove('DSC_0002.png');
  const { dir, file } = saved('changed.img', ex.image());
  const res = await find(file, { pattern: '*' });
  const [c] = res.results;
  assert.strictEqual(tier(c), 0);
  // Windows, or another card in the same reader, wrote to its free clusters.
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, Buffer.from('written since'), 0, 13, c.extent.runs[0][0] + 100);
  fs.closeSync(fd);
  const out = path.join(dir, 'out');
  await assert.rejects(restoreCopy(c, out, res.locations), /no longer holds what the search found there/);
  assert.deepStrictEqual(fs.readdirSync(out), []);
});

test('a card given as a whole disk is kept from being written onto by its volumes\' serial numbers', async () => {
  const { remember, serials } = removable._internal;
  const { checkDestination } = require('../src/restore');
  // An image is protected by its path, and its volumes are read when it is searched.
  const { file } = saved('card.img', fat16Card());
  await find(file, { pattern: 'holiday' });
  assert.deepStrictEqual(removable.volumes({ removable: [file] }), []);
  assert.ok([...serials.get(env.platform() === 'win32' ? file.toLowerCase() : file)].includes(0x1234abcd));

  // A whole disk on Windows, not readable now: nothing to go on, and nothing opened.
  env.platform = () => 'win32';
  env.elevated = () => false;
  const disk = '\\\\.\\PhysicalDrive7';
  assert.deepStrictEqual(removable.volumes({ removable: [disk] }), []);
  // Searched before, as administrator: its volumes by their serial numbers, as stat() gives dev.
  remember(placeOf(disk), 0x1234abcd);
  assert.deepStrictEqual(removable.volumes({ removable: [disk] }), [{ volume: String(0x1234abcd), label: disk }]);
  assert.deepStrictEqual(removable.roots({ removable: [disk] }), []);
  // restore.js refuses a folder on that volume, whatever it is called.
  const root = saved('x.txt', 'x').dir;
  const here = String(fs.statSync(root, { bigint: true }).dev);
  assert.throws(() => checkDestination(path.join(root, 'out'), [{ volume: here, label: disk }]), /that is the drive being recovered/);
});

test('on Linux, a device given by a link is the device it links to', { skip: process.platform === 'win32' }, () => {
  const { mountsOf } = removable._internal;
  const { dir } = saved('sdb1', 'a stand-in for a device');
  const device = path.join(dir, 'sdb1');
  fs.mkdirSync(path.join(dir, 'by-label'));
  const link = path.join(dir, 'by-label', 'CARD');
  fs.symlinkSync(device, link);
  // A made-up /dev name, which realpath leaves as it is: the machine's own devices are not looked at.
  const mounts = `${device} /media/u/CARD vfat rw 0 0\n/dev/solarljos-test0 / ext4 rw 0 0\n${device}9 /media/u/OTHER vfat rw 0 0\n`;
  assert.deepStrictEqual(mountsOf(link, mounts), ['/media/u/CARD', '/media/u/OTHER']);
  assert.deepStrictEqual(mountsOf(device, mounts), ['/media/u/CARD', '/media/u/OTHER']);
  assert.deepStrictEqual(mountsOf('/dev/solarljos-test9', mounts), []);
});

test('nothing given, nothing read', async () => {
  const res = await search({ pattern: '*', sources: ['removable'], locations: only({}) });
  assert.strictEqual(res.results.length, 0);
  const [d] = await describeSources({ sources: ['removable'], locations: only({}) });
  assert.match(d.lines[0], /--location removable=/);
});
