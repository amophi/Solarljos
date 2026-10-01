'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { workDir, cleanup, write, snapshot } = require('./helpers');
const fat = require('../src/lib/fat');

const { setChecksum, nameHash, exfatSets, defaultUpcase, dosStamp, utcOffset, CP437, longName, lfnChecksum } =
  fat._internal;

const dirs = [];
after(() => dirs.forEach(cleanup));

// Volumes are built here from the specifications (fatgen103, Microsoft's exFAT specification, the
// UEFI GPT layout) by a small formatter of this file's own, which computes every checksum itself,
// so that the library is checked against an independent writer. Files are deleted the ways the
// drivers do:
//   FAT, 'linux'       0xE5 on every entry, the chain set free; first cluster and size kept
//   FAT, 'windows'     the same, and on FAT32 the high half of the first cluster cleared
//   FAT, 'keep-chain'  0xE5 on every entry and nothing else: a system that leaves the chain
//   exFAT, 'keep'      InUse cleared in every entry, bitmap bits cleared, FAT cells and checksum kept
//   exFAT, 'zero-chain'  as 'keep', with the FAT chain zeroed too
//   exFAT, 'recompute' as 'keep', with the set checksum recomputed over the cleared bytes

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

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

/** A wall-clock time [y, mo, d, h, mi, s, hundredths] as DOS date, time and 10 ms steps. */
function dosFields([y, mo, d, h, mi, s, cs = 0]) {
  return {
    date: ((y - 1980) << 9) | (mo << 5) | d,
    time: (h << 11) | (mi << 5) | (s >> 1),
    tens: (s & 1) * 100 + cs,
  };
}

/** The same time as this machine reads a zoneless one: local. */
const localMs = ([y, mo, d, h, mi, s, cs = 0]) => new Date(y, mo - 1, d, h, mi, s, cs * 10).getTime();

const WHEN = [2024, 7, 1, 13, 45, 30, 25];

// ------------------------------------------------------------------ a FAT formatter

function sum8(name11) {
  let s = 0;
  for (let i = 0; i < 11; i++) s = ((s & 1 ? 0x80 : 0) + (s >> 1) + name11[i]) & 0xff;
  return s;
}

const SHORT_CHARS = /^[A-Z0-9!#$%&'()@^_`{}~-]+$/;

/** Where character j of a long-name entry goes: 5 at 1, 6 at 14, 2 at 28. */
const lfnAt = (j) => (j < 5 ? 1 + 2 * j : j < 11 ? 4 + 2 * j : 6 + 2 * j);

class FatImage {
  constructor({ type, sectors, clusterSize = 512, rootClusters = 1 }) {
    this.type = type;
    this.cs = clusterSize;
    this.spc = clusterSize / SECTOR;
    this.rsvd = type === 32 ? 32 : 1;
    this.fats = 2;
    this.rootEnt = type === 32 ? 0 : 512;
    this.tot = sectors;
    const rootSecs = (this.rootEnt * 32) / SECTOR;
    let fatsz = 1;
    for (;;) {
      const clusters = Math.floor((sectors - this.rsvd - rootSecs - this.fats * fatsz) / this.spc);
      const need = Math.ceil(((clusters + 2) * (type === 12 ? 1.5 : type / 8)) / SECTOR);
      if (need <= fatsz) break;
      fatsz = need;
    }
    this.fatsz = fatsz;
    this.clusters = Math.floor((sectors - this.rsvd - rootSecs - this.fats * fatsz) / this.spc);
    if (type !== 32 && (this.clusters < 4085 ? 12 : 16) !== type) {
      throw new Error(`not FAT${type}: ${this.clusters} clusters`);
    }
    this.rootOff = (this.rsvd + this.fats * fatsz) * SECTOR;
    this.dataOff = this.rootOff + rootSecs * SECTOR;
    this.eoc = { 12: 0xfff, 16: 0xffff, 32: 0x0fffffff }[type];
    this.buf = Buffer.alloc(sectors * SECTOR);
    this.fat = new Uint32Array(this.clusters + 2);
    this.fat[0] = this.eoc - 7;
    this.fat[1] = this.eoc;
    this.dirs = new Map();
    this.items = new Map();
    if (type === 32) {
      const root = Array.from({ length: rootClusters }, (_, i) => 2 + i);
      this.link(root);
      this.dirs.set('', { clusters: root, first: 2, slots: [], names: new Set() });
    } else {
      this.dirs.set('', { root: true, first: 0, slots: [], names: new Set() });
    }
  }

  at(c) {
    return this.dataOff + (c - 2) * this.cs;
  }

  link(clusters) {
    clusters.forEach((c, i) => {
      if (this.fat[c]) throw new Error(`cluster ${c} is in use`);
      this.fat[c] = i + 1 < clusters.length ? clusters[i + 1] : this.eoc;
    });
  }

  /** The short name Windows and Linux would give, with the lowercase flags or a long name. */
  shortFor(dir, name) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot + 1) : '';
    const pad = (b, e) => b.padEnd(8) + e.padEnd(3);
    const B = base.toUpperCase();
    const E = ext.toUpperCase();
    if (base.length <= 8 && ext.length <= 3 && SHORT_CHARS.test(B) && (!E || SHORT_CHARS.test(E))) {
      const lowB = base !== B && base === base.toLowerCase();
      const lowE = ext !== E && ext === ext.toLowerCase();
      if ((base === B || lowB) && (ext === E || lowE) && !dir.names.has(pad(B, E))) {
        return { name11: pad(B, E), flags: (lowB ? 0x08 : 0) | (lowE ? 0x10 : 0), long: false };
      }
    }
    const conv = (s) => [...s].filter((c) => c !== '.' && c !== ' ')
      .map((c) => (c.charCodeAt(0) >= 0x80 || '+,;=[]'.includes(c) ? '_' : c.toUpperCase())).join('');
    const b = conv(base);
    const e = conv(ext).slice(0, 3);
    for (let n = 1; ; n++) {
      const s = pad(b.slice(0, 8 - String(n).length - 1) + '~' + n, e);
      if (!dir.names.has(s)) return { name11: s, flags: 0, long: true };
    }
  }

  /** The slots of one entry: long-name entries if it needs them, then the short one. */
  entry(dirPath, name, first, size, attr, when) {
    const dir = this.dirs.get(dirPath);
    const sn = this.shortFor(dir, name);
    dir.names.add(sn.name11);
    const name11 = Buffer.from(sn.name11, 'latin1');
    const slots = [];
    if (sn.long) {
      const units = [...name].map((c) => c.charCodeAt(0));
      const n = Math.ceil(units.length / 13);
      if (units.length % 13) units.push(0);
      while (units.length < n * 13) units.push(0xffff);
      for (let k = n; k >= 1; k--) {
        const e = Buffer.alloc(32);
        e[0] = k | (k === n ? 0x40 : 0);
        e[11] = 0x0f;
        e[13] = sum8(name11);
        units.slice((k - 1) * 13, k * 13).forEach((u, j) => e.writeUInt16LE(u, lfnAt(j)));
        slots.push(e);
      }
    }
    const e = Buffer.alloc(32);
    name11.copy(e, 0);
    e[11] = attr;
    e[12] = sn.flags;
    const w = dosFields(when);
    e[13] = w.tens;
    e.writeUInt16LE(w.time, 14);
    e.writeUInt16LE(w.date, 16);
    e.writeUInt16LE(w.date, 18);
    e.writeUInt16LE(this.type === 32 ? first >>> 16 : 0, 20);
    e.writeUInt16LE(w.time, 22);
    e.writeUInt16LE(w.date, 24);
    e.writeUInt16LE(first & 0xffff, 26);
    e.writeUInt32LE(size, 28);
    slots.push(e);
    dir.slots.push(...slots);
    return slots;
  }

  /** A file at `where`: a first cluster (in one piece) or a list of clusters. */
  file(dirPath, name, data, where, when = WHEN) {
    const n = Math.max(1, Math.ceil(data.length / this.cs));
    const clusters = typeof where === 'number' ? Array.from({ length: n }, (_, i) => where + i) : where;
    assert.strictEqual(clusters.length, n);
    this.link(clusters);
    clusters.forEach((c, i) => data.copy(this.buf, this.at(c), i * this.cs, (i + 1) * this.cs));
    const p = dirPath ? `${dirPath}\\${name}` : name;
    this.items.set(p, { clusters, slots: this.entry(dirPath, name, clusters[0], data.length, 0x20, when) });
    return p;
  }

  mkdir(dirPath, name, cluster) {
    this.link([cluster]);
    this.buf.fill(0, this.at(cluster), this.at(cluster) + this.cs);
    const p = dirPath ? `${dirPath}\\${name}` : name;
    const parent = this.dirs.get(dirPath);
    const dot = (n, c) => {
      const e = Buffer.alloc(32);
      e.write(n.padEnd(11), 0, 'latin1');
      e[11] = 0x10;
      e.writeUInt16LE(this.type === 32 ? c >>> 16 : 0, 20);
      e.writeUInt16LE(c & 0xffff, 26);
      return e;
    };
    // ".." names 0 for the root, on FAT32 too.
    const up = parent.root || (this.type === 32 && parent.first === 2) ? 0 : parent.first;
    this.dirs.set(p, { clusters: [cluster], first: cluster, slots: [dot('.', cluster), dot('..', up)], names: new Set() });
    this.items.set(p, { clusters: [cluster], slots: this.entry(dirPath, name, cluster, 0, 0x10, WHEN) });
    return p;
  }

  remove(p, style) {
    const it = this.items.get(p);
    for (const s of it.slots) s[0] = 0xe5;
    if (style !== 'keep-chain') for (const c of it.clusters) this.fat[c] = 0;
    if (style === 'windows' && this.type === 32) it.slots[it.slots.length - 1].writeUInt16LE(0, 20);
  }

  /** A rename as FAT drivers do it: a new entry for the same clusters, the old one marked deleted. */
  rename(p, dirPath, name) {
    const it = this.items.get(p);
    const short = it.slots[it.slots.length - 1];
    for (const s of it.slots) s[0] = 0xe5;
    const np = dirPath ? `${dirPath}\\${name}` : name;
    const slots = this.entry(dirPath, name, it.clusters[0], short.readUInt32LE(28), 0x20, WHEN);
    this.items.set(np, { clusters: it.clusters, slots });
  }

  image() {
    const b = this.buf;
    b[0] = 0xeb;
    b[1] = this.type === 32 ? 0x58 : 0x3c;
    b[2] = 0x90;
    b.write('MSWIN4.1', 3, 'latin1');
    b.writeUInt16LE(SECTOR, 11);
    b[13] = this.spc;
    b.writeUInt16LE(this.rsvd, 14);
    b[16] = this.fats;
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
    for (let k = 0; k < this.fats; k++) {
      const base = (this.rsvd + k * this.fatsz) * SECTOR;
      for (let c = 0; c < this.fat.length; c++) {
        const v = this.fat[c];
        if (this.type === 32) b.writeUInt32LE(v, base + 4 * c);
        else if (this.type === 16) b.writeUInt16LE(v, base + 2 * c);
        else {
          const o = base + Math.floor(c * 1.5);
          const old = b.readUInt16LE(o);
          b.writeUInt16LE(c & 1 ? (old & 0x000f) | (v << 4) : (old & 0xf000) | v, o);
        }
      }
    }
    for (const d of this.dirs.values()) {
      const all = Buffer.concat(d.slots);
      if (d.root) {
        assert.ok(all.length <= this.rootEnt * 32);
        all.copy(b, this.rootOff);
      } else {
        assert.ok(all.length <= d.clusters.length * this.cs, 'folder overflow');
        spread(all, b, d.clusters.map((c) => this.at(c)), this.cs);
      }
    }
    return b;
  }
}

/** Writes a folder's slots over its clusters, as far as they go. */
function spread(all, b, offsets, cs) {
  offsets.forEach((at, i) => {
    if (i * cs < all.length) all.copy(b, at, i * cs, Math.min(all.length, (i + 1) * cs));
  });
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

// The up-case mapping this formatter writes: ASCII and Latin-1 letters, everything else itself.
const UP = new Uint16Array(65536).map((_, i) => i);
for (let i = 0x61; i <= 0x7a; i++) UP[i] = i - 32;
for (let i = 0xe0; i <= 0xfe; i++) if (i !== 0xf7) UP[i] = i - 32;

/** The mapping compressed as the specification allows: 0xFFFF and a count for characters mapping to themselves. */
function compressUpcase() {
  const out = [];
  for (let i = 0; i < 65536;) {
    let n = 0;
    while (i + n < 65536 && UP[i + n] === i + n && n < 0xffff) n++;
    if (n > 2) {
      out.push(0xffff, n);
      i += n;
    } else {
      out.push(UP[i]);
      i++;
    }
  }
  const b = Buffer.alloc(out.length * 2);
  out.forEach((u, k) => b.writeUInt16LE(u, 2 * k));
  return b;
}

function hash16(name) {
  let h = 0;
  for (const ch of name) {
    const u = UP[ch.charCodeAt(0)];
    h = ((h & 1 ? 0x8000 : 0) + (h >> 1) + (u & 0xff)) & 0xffff;
    h = ((h & 1 ? 0x8000 : 0) + (h >> 1) + (u >> 8)) & 0xffff;
  }
  return h;
}

class ExfatImage {
  constructor({ sectors, clusterSize = 4096 }) {
    this.cs = clusterSize;
    const spc = clusterSize / SECTOR;
    this.tot = sectors;
    this.fatOffset = 128;
    this.fatLength = Math.ceil(((Math.floor(sectors / spc) + 2) * 4) / SECTOR);
    this.heapOffset = Math.ceil((this.fatOffset + this.fatLength) / spc) * spc;
    this.clusters = Math.floor((sectors - this.heapOffset) / spc);
    this.buf = Buffer.alloc(sectors * SECTOR);
    this.fat = new Uint32Array(this.clusters + 2);
    this.fat[0] = 0xfffffff8;
    this.fat[1] = 0xffffffff;
    this.bitmap = Buffer.alloc(Math.ceil(this.clusters / 8));
    this.upcase = compressUpcase();
    this.dirs = new Map();
    this.items = new Map();
    const bm = this.alloc([2], true);
    const up = this.alloc([3], true);
    this.alloc([4, 5], true);
    this.dirs.set('', { clusters: [4, 5], slots: [] });
    const e81 = Buffer.alloc(32);
    e81[0] = 0x81;
    e81.writeUInt32LE(bm[0], 20);
    e81.writeBigUInt64LE(BigInt(this.bitmap.length), 24);
    const e82 = Buffer.alloc(32);
    e82[0] = 0x82;
    e82.writeUInt32LE(sum32(this.upcase), 4);
    e82.writeUInt32LE(up[0], 20);
    e82.writeBigUInt64LE(BigInt(this.upcase.length), 24);
    const e83 = Buffer.alloc(32);
    e83[0] = 0x83;
    e83[1] = 6;
    e83.write('MYCARD', 2, 'utf16le');
    this.dirs.get('').slots.push(e81, e82, e83);
  }

  at(c) {
    return this.heapOffset * SECTOR + (c - 2) * this.cs;
  }

  alloc(clusters, chain) {
    for (const c of clusters) {
      const i = c - 2;
      if (this.bitmap[i >> 3] & (1 << (i & 7))) throw new Error(`cluster ${c} is in use`);
      this.bitmap[i >> 3] |= 1 << (i & 7);
    }
    if (chain) clusters.forEach((c, i) => { this.fat[c] = i + 1 < clusters.length ? clusters[i + 1] : 0xffffffff; });
    return clusters;
  }

  /**
   * A file at `where`: a first cluster (in one piece, no FAT chain) or a list of clusters (a FAT
   * chain). `offsetQ` is the UTC offset in quarter hours; `valid` the valid data length.
   */
  file(dirPath, name, data, where, { when = WHEN, offsetQ = 36, valid, isDir = false } = {}) {
    const n = Math.max(1, Math.ceil(data.length / this.cs));
    const list = typeof where === 'number' ? Array.from({ length: n }, (_, i) => where + i) : where;
    this.alloc(list, typeof where !== 'number');
    list.forEach((c, i) => data.copy(this.buf, this.at(c), i * this.cs, (i + 1) * this.cs));
    const names = Math.ceil(name.length / 15);
    const set = Buffer.alloc(32 * (2 + names));
    set[0] = 0x85;
    set[1] = 1 + names;
    set.writeUInt16LE(isDir ? 0x10 : 0x20, 4);
    const w = dosFields(when);
    const ts = ((w.date << 16) | w.time) >>> 0;
    for (const o of [8, 12, 16]) set.writeUInt32LE(ts, o);
    set[20] = w.tens;
    set[21] = w.tens;
    for (const o of [22, 23, 24]) set[o] = 0x80 | (offsetQ & 0x7f);
    set[32] = 0xc0;
    set[33] = 0x01 | (typeof where === 'number' ? 0x02 : 0);
    set[35] = name.length;
    set.writeUInt16LE(hash16(name), 36);
    const size = isDir ? n * this.cs : data.length;
    set.writeBigUInt64LE(BigInt(valid == null ? size : valid), 40);
    set.writeUInt32LE(list[0], 52);
    set.writeBigUInt64LE(BigInt(size), 56);
    for (let k = 0; k < names; k++) {
      set[64 + 32 * k] = 0xc1;
      set.write(name.slice(15 * k, 15 * k + 15), 64 + 32 * k + 2, 'utf16le');
    }
    set.writeUInt16LE(sum16(set), 2);
    this.dirs.get(dirPath).slots.push(set);
    const p = dirPath ? `${dirPath}\\${name}` : name;
    this.items.set(p, { set, clusters: list });
    if (isDir) this.dirs.set(p, { clusters: list, slots: [] });
    return p;
  }

  mkdir(dirPath, name, cluster) {
    return this.file(dirPath, name, Buffer.alloc(this.cs), cluster, { isDir: true });
  }

  remove(p, style = 'keep') {
    const it = this.items.get(p);
    for (let k = 0; k < it.set.length; k += 32) it.set[k] &= 0x7f;
    for (const c of it.clusters) this.bitmap[(c - 2) >> 3] &= ~(1 << ((c - 2) & 7));
    if (style === 'zero-chain') for (const c of it.clusters) this.fat[c] = 0;
    if (style === 'recompute') it.set.writeUInt16LE(sum16(it.set), 2);
  }

  /** A move: the old set left behind inactive, a new live one elsewhere, the clusters kept. */
  move(p, toDir) {
    const it = this.items.get(p);
    const copy = Buffer.from(it.set);
    for (let k = 0; k < it.set.length; k += 32) it.set[k] &= 0x7f;
    this.dirs.get(toDir).slots.push(copy);
    const np = `${toDir}\\${p.split('\\').pop()}`;
    this.items.set(np, { set: copy, clusters: it.clusters });
    return np;
  }

  bootRegion() {
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
    r[109] = Math.log2(this.cs / SECTOR);
    r[110] = 1;
    r[111] = 0x80;
    r[510] = 0x55;
    r[511] = 0xaa;
    for (let s = 1; s <= 8; s++) r.writeUInt32LE(0xaa550000, s * SECTOR + 508);
    const s = sum32(r.subarray(0, 11 * SECTOR), [106, 107, 112]);
    for (let i = 11 * SECTOR; i < 12 * SECTOR; i += 4) r.writeUInt32LE(s, i);
    return r;
  }

  image() {
    const b = this.buf;
    const region = this.bootRegion();
    region.copy(b, 0);
    region.copy(b, 12 * SECTOR);
    for (let c = 0; c < this.fat.length; c++) b.writeUInt32LE(this.fat[c], this.fatOffset * SECTOR + 4 * c);
    this.bitmap.copy(b, this.at(2));
    this.upcase.copy(b, this.at(3));
    for (const d of this.dirs.values()) {
      const all = Buffer.concat(d.slots);
      assert.ok(all.length <= d.clusters.length * this.cs, 'folder overflow');
      spread(all, b, d.clusters.map((c) => this.at(c)), this.cs);
    }
    return b;
  }
}

// ------------------------------------------------------------------ partition tables

let CRC = null;
function crc(buf) {
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

function mbrEntry(s, i, type, lba, count) {
  const e = 446 + 16 * i;
  s[e + 4] = type;
  s.writeUInt32LE(lba, e + 8);
  s.writeUInt32LE(count, e + 12);
  s[510] = 0x55;
  s[511] = 0xaa;
}

// Microsoft basic data, as stored: the first three fields little-endian.
const BASIC_DATA = Buffer.from('a2a0d0ebe5b9334487c068b6b72699c7', 'hex');

function gptDisk(sectors, parts) {
  const disk = Buffer.alloc(sectors * SECTOR);
  mbrEntry(disk, 0, 0xee, 1, sectors - 1);
  const entries = Buffer.alloc(128 * 128);
  parts.forEach((p, i) => {
    const e = entries.subarray(i * 128, (i + 1) * 128);
    BASIC_DATA.copy(e, 0);
    bytes(16, 99 + i).copy(e, 16);
    e.writeBigUInt64LE(BigInt(p.lba), 32);
    e.writeBigUInt64LE(BigInt(p.lba + p.image.length / SECTOR - 1), 40);
    e.write(p.name, 56, 'utf16le');
    p.image.copy(disk, p.lba * SECTOR);
  });
  const h = Buffer.alloc(92);
  h.write('EFI PART', 0, 'latin1');
  h.writeUInt32LE(0x00010000, 8);
  h.writeUInt32LE(92, 12);
  h.writeBigUInt64LE(1n, 24);
  h.writeBigUInt64LE(BigInt(sectors - 1), 32);
  h.writeBigUInt64LE(34n, 40);
  h.writeBigUInt64LE(BigInt(sectors - 34), 48);
  h.writeBigUInt64LE(2n, 72);
  h.writeUInt32LE(128, 80);
  h.writeUInt32LE(128, 84);
  h.writeUInt32LE(crc(entries), 88);
  h.writeUInt32LE(crc(h), 16);
  h.copy(disk, SECTOR);
  entries.copy(disk, 2 * SECTOR);
  return disk;
}

// ------------------------------------------------------------------ helpers

const byPath = (res, p) => res.deleted.find((d) => d.path === p);
const readAll = (reader, x) => fat.extentReader(reader, x).read(0, x.size);

function saved(dir, name, buf) {
  return write(path.join(dir, name), buf);
}

// ------------------------------------------------------------------ FAT32

/**
 * One FAT32 card of 70,858 clusters of 512 bytes, so that the high half of a first cluster
 * matters: every start below 5,324 has a twin 65,536 clusters later. Files deleted the Linux way
 * lie above that, where the start is certain; those deleted the Windows way test the twins.
 */
function fat32Card() {
  const img = new FatImage({ type: 32, sectors: 72000, rootClusters: 8 });
  assert.ok(img.clusters + 2 > 0x10000 && img.clusters >= 65525);
  const data = {};
  const put = (dir, name, n, where, seed, when) => {
    data[img.file(dir, name, (data[name] = bytes(n, seed)), where, when)] = data[name];
  };
  // Linux deletes: the first cluster is kept whole.
  put('', 'Birthday cake (2).jpg', 3000, 6000, 1);
  put('', 'IMG_0001.JPG', 400, 6100, 2);
  put('', 'readme.txt', 100, 6110, 3);
  put('', '가족 사진.jpg', 1000, 6120, 4);
  put('', 'LIVE.BIN', 2048, 6205, 5);
  put('', 'around live.jpg', 5500, [6200, 6201, 6202, 6203, 6204, 6209, 6210, 6211, 6212, 6213, 6214], 6);
  put('', 'Inner.jpg', 2500, 6305, 7);
  put('', 'Outer.mp4', 5000, [6300, 6301, 6302, 6303, 6304, 6310, 6311, 6312, 6313, 6314], 8);
  put('', 'Clip.mp4', 10000, 6400, 9);
  put('', 'old name.txt', 300, 6500, 10);
  put('', 'kept chain.bin', 2000, [6600, 6601, 6605, 6606], 11);
  put('', 'stale chain.bin', 1000, [6700, 6701], 12);
  img.mkdir('', 'Trip', 7000);
  put('Trip', 'Beach day.jpg', 1500, 7001, 13);
  put('Trip', 'Sea view.jpg', 400, 7010, 14);
  for (const p of ['Birthday cake (2).jpg', 'IMG_0001.JPG', 'readme.txt', '가족 사진.jpg', 'around live.jpg', 'Inner.jpg',
    'Outer.mp4', 'Clip.mp4', 'Trip\\Beach day.jpg', 'Trip\\Sea view.jpg', 'Trip']) img.remove(p, 'linux');
  img.file('', 'NEW.BIN', bytes(2048, 20), 6410);
  img.rename('old name.txt', '', 'new name.txt');
  img.remove('kept chain.bin', 'keep-chain');
  img.remove('stale chain.bin', 'keep-chain');
  // A later file took the second cluster of the chain left behind.
  img.fat[6701] = 0;
  img.file('', 'TAKER.BIN', bytes(100, 21), 6701);
  // Windows deletes: the high half of the first cluster is gone.
  put('', 'BLOCK.BIN', 3500, 4464, 30);
  put('', 'Movie.mp4', 3000, 70000, 31);
  put('', 'Photo.jpg', 400, 3000, 32);
  put('', 'LIVE2.BIN', 512, 3464, 33);
  put('', 'One.txt', 100, 69000, 34);
  img.mkdir('', 'Old', 69500);
  put('Old', 'Note.txt', 200, 69501, 35);
  for (const p of ['Movie.mp4', 'Photo.jpg', 'One.txt', 'Old\\Note.txt', 'Old']) img.remove(p, 'windows');
  return { img, buf: img.image(), data };
}

let card = null;
const fat32 = () => card || (card = fat32Card());

test('a FAT32 card image is read without being changed, and what Linux deleted is found', async () => {
  const dir = workDir('lib-fat');
  dirs.push(dir);
  const { img, buf, data } = fat32();
  const file = saved(dir, 'card.img', buf);
  const before = snapshot(dir);
  const reader = fat.openReader(file);
  try {
    assert.strictEqual(reader.size, buf.length);
    const { volumes, notes } = fat.findVolumes(reader);
    assert.deepStrictEqual(notes, []);
    assert.strictEqual(volumes.length, 1);
    assert.strictEqual(volumes[0].scheme, 'none');
    assert.strictEqual(volumes[0].fs, 'fat');
    const vol = fat.openVolume(reader, volumes[0]);
    assert.strictEqual(vol.fs, 'FAT32');
    assert.strictEqual(vol.clusterCount, img.clusters);
    assert.strictEqual(vol.clusterSize, 512);
    assert.strictEqual(vol.serial, 0x1234abcd);
    const res = fat.scanVolume(vol);

    // A long name comes back through its checksum, and the short name is rebuilt with it.
    const cake = byPath(res, 'Birthday cake (2).jpg');
    assert.strictEqual(cake.shortName, 'BIRTHD~1.JPG');
    assert.strictEqual(cake.nameCertain, true);
    assert.strictEqual(cake.status, 'assumed');
    assert.strictEqual(cake.extent.how, 'contiguous');
    assert.strictEqual(cake.extent.complete, false);
    assert.strictEqual(md5(readAll(reader, cake.extent)), md5(data['Birthday cake (2).jpg']));
    assert.strictEqual(cake.modified.wall, '2024-07-01T13:45:30');
    assert.strictEqual(cake.modified.offset, null);
    assert.strictEqual(cake.created.wall, '2024-07-01T13:45:30.250');
    assert.strictEqual(cake.created.ms, localMs(WHEN));

    // With no long name, the first character is gone for good.
    const img1 = byPath(res, '_MG_0001.JPG');
    assert.strictEqual(img1.nameCertain, false);
    assert.strictEqual(img1.status, 'complete');
    assert.strictEqual(img1.extent.how, 'one cluster');
    assert.strictEqual(md5(readAll(reader, img1.extent)), md5(data['IMG_0001.JPG']));
    assert.ok(byPath(res, '_eadme.txt'), 'lowercase flags applied');
    const family = byPath(res, '가족 사진.jpg');
    assert.strictEqual(family.nameCertain, true);
    assert.strictEqual(md5(readAll(reader, family.extent)), md5(data['가족 사진.jpg']));

    // Lay around a live file: assumed clusters are in use; skipping them gets it back.
    const around = byPath(res, 'around live.jpg');
    assert.strictEqual(around.status, 'overwritten');
    assert.match(around.candidates[0].problems[0], /4 of its 11 cluster/);
    assert.strictEqual(around.fallback.how, 'skipping clusters in use');
    assert.deepStrictEqual(around.fallback.runs, [[6200, 5], [6209, 6]]);
    assert.strictEqual(md5(readAll(reader, around.fallback)), md5(data['around live.jpg']));

    // Lay around a deleted file whose first cluster says so.
    const outer = byPath(res, 'Outer.mp4');
    assert.strictEqual(outer.status, 'fragmented');
    assert.match(outer.candidates[0].problems[0], /deleted Inner\.jpg starts at cluster 6305/);
    assert.strictEqual(outer.fallback, null);
    assert.strictEqual(byPath(res, 'Inner.jpg').status, 'assumed');

    assert.strictEqual(byPath(res, 'Clip.mp4').status, 'overwritten');
    const renamed = byPath(res, 'old name.txt');
    assert.strictEqual(renamed.status, 'moved');
    assert.strictEqual(renamed.movedTo, 'new name.txt');

    // A chain another system left behind is known, though the file was in pieces.
    const kept = byPath(res, 'kept chain.bin');
    assert.strictEqual(kept.status, 'complete');
    assert.strictEqual(kept.extent.how, 'chain');
    assert.deepStrictEqual(kept.extent.runs, [[6600, 2], [6605, 2]]);
    assert.strictEqual(md5(readAll(reader, kept.extent)), md5(data['kept chain.bin']));
    // One whose chain a live file now runs through is not.
    assert.strictEqual(byPath(res, 'stale chain.bin').status, 'overwritten');

    // A deleted folder, found by the "." and ".." at its first cluster, and what was in it.
    const beach = byPath(res, 'Trip\\Beach day.jpg');
    assert.strictEqual(beach.inDeletedFolder, true);
    assert.strictEqual(beach.status, 'assumed');
    assert.strictEqual(md5(readAll(reader, beach.extent)), md5(data['Trip\\Beach day.jpg']));
    assert.strictEqual(byPath(res, 'Trip\\Sea view.jpg').status, 'complete');

    assert.ok(!res.deleted.some((d) => ['LIVE.BIN', 'NEW.BIN', 'new name.txt', 'TAKER.BIN'].includes(d.path)));
    assert.strictEqual(res.stats.files, 6);
    assert.ok(res.stats.deletedFoldersRead >= 2);

    // Read in pieces and out of line with the blocks, the same bytes come back.
    assert.deepStrictEqual(reader.read(12345, 777), buf.subarray(12345, 12345 + 777));
    assert.deepStrictEqual(await reader.readAsync(4095, 2), buf.subarray(4095, 4097));
    assert.strictEqual(reader.read(buf.length - 10, 100).length, 10);
    assert.strictEqual(reader.read(buf.length + 10, 100).length, 0);
    // A size set later -- a device's, from its partition table -- stops reads there.
    reader.size = 5000;
    assert.strictEqual(reader.read(4990, 100).length, 10);
    reader.size = buf.length;
  } finally {
    reader.close();
  }
  assert.deepStrictEqual(snapshot(dir), before, 'the image was not changed');
});

test('FAT32 deleted by Windows: the high half of the first cluster is gone, and every start is tried', () => {
  const { buf, data } = fat32();
  const reader = fat.memoryReader(buf);
  const res = fat.scanVolume(fat.openVolume(reader));

  // The low half alone lies in a live file; the start 65,536 clusters on is the one left.
  const movie = byPath(res, 'Movie.mp4');
  assert.strictEqual(movie.firstCluster, 70000 - 0x10000);
  assert.strictEqual(movie.candidates.length, 2);
  assert.strictEqual(movie.candidates[0].start, 4464);
  assert.strictEqual(movie.status, 'assumed');
  assert.strictEqual(movie.extent.start, 70000);
  assert.ok(movie.notes.some((n) => /high half/.test(n)));
  assert.strictEqual(md5(readAll(reader, movie.extent)), md5(data['Movie.mp4']));

  // One cluster, but its start chosen by ruling the other out: not known.
  const one = byPath(res, 'One.txt');
  assert.strictEqual(one.status, 'assumed');
  assert.strictEqual(one.extent.complete, false);
  assert.strictEqual(md5(readAll(reader, one.extent)), md5(data['One.txt']));

  // Both starts free: only the content can tell them apart.
  const photo = byPath(res, 'Photo.jpg');
  assert.strictEqual(photo.status, 'ambiguous');
  assert.strictEqual(photo.extent, null);
  assert.deepStrictEqual(photo.candidates.map((c) => c.start), [3000, 3000 + 0x10000]);
  assert.strictEqual(md5(readAll(reader, photo.candidates[0])), md5(data['Photo.jpg']));

  // A folder deleted the same way is found by the "." that names its own first cluster.
  const note = byPath(res, 'Old\\Note.txt');
  assert.ok(note, 'the deleted folder was read');
  assert.strictEqual(note.status, 'ambiguous');
});

test('a FAT32 volume whose boot sector is damaged is read from its backup', () => {
  const { buf } = fat32();
  const copy = Buffer.from(buf);
  copy.fill(0, 0, SECTOR);
  const reader = fat.memoryReader(copy);
  const { volumes } = fat.findVolumes(reader);
  assert.strictEqual(volumes.length, 1);
  assert.strictEqual(volumes[0].fs, 'fat');
  assert.strictEqual(volumes[0].backup, true);
  const vol = fat.openVolume(reader, volumes[0]);
  assert.strictEqual(vol.fromBackup, true);
  const res = fat.scanVolume(vol);
  assert.ok(res.notes.some((n) => /backup at sector 6/.test(n)));
  assert.strictEqual(byPath(res, 'Birthday cake (2).jpg').status, 'assumed');
  // With the backup gone too, nothing is recognised, and the whole image is left to carve.
  copy.fill(0, 6 * SECTOR, 7 * SECTOR);
  const none = fat.scan(fat.memoryReader(copy));
  assert.deepStrictEqual(none.volumes.map((v) => [v.scheme, v.fs, v.offset, v.size]), [['none', null, 0, copy.length]]);
});

// ------------------------------------------------------------------ FAT12 and FAT16

test('FAT12 and FAT16: the fixed root folder, long names tied by their checksum, and ones that are not', () => {
  for (const [type, sectors] of [[12, 4000], [16, 40000]]) {
    const img = new FatImage({ type, sectors });
    const pic = bytes(1300, type);
    img.file('', 'Birthday cake (2).jpg', pic, 40);
    img.file('', 'KEEP.TXT', Buffer.from('keep'), 10);
    img.file('', 'Alpha file.txt', bytes(50, 3), 60);
    img.remove('Birthday cake (2).jpg', 'windows');
    // Long-name entries left before a short entry that is not theirs.
    const alpha = img.items.get('Alpha file.txt');
    alpha.slots[alpha.slots.length - 1].write('ZZZZZZZZTXT', 0, 'latin1');
    img.remove('Alpha file.txt', 'windows');
    const reader = fat.memoryReader(img.image());
    const vol = fat.openVolume(reader);
    assert.strictEqual(vol.fs, `FAT${type}`);
    const res = fat.scanVolume(vol);
    const cake = byPath(res, 'Birthday cake (2).jpg');
    assert.strictEqual(cake.shortName, 'BIRTHD~1.JPG');
    assert.strictEqual(cake.status, 'assumed');
    assert.strictEqual(md5(readAll(reader, cake.extent)), md5(pic));
    const z = byPath(res, '_ZZZZZZZ.TXT');
    assert.ok(z, 'the long name was not trusted');
    assert.strictEqual(z.nameCertain, false);
    assert.strictEqual(res.stats.files, 1);
  }
});

test('a volume\'s serial number from either extended boot record, and its label only from the newer', () => {
  for (const type of [16, 32]) {
    const img = new FatImage({ type, sectors: type === 32 ? 70000 : 40000 });
    img.file('', 'KEEP.TXT', Buffer.from('keep'), 10);
    const buf = img.image();
    const sig = type === 32 ? 66 : 38;
    assert.strictEqual(fat.openVolume(fat.memoryReader(buf)).serial, 0x1234abcd);
    // 0x28, as DOS 4 and some cameras wrote it: the serial number, and no label after it.
    buf[sig] = 0x28;
    if (type === 32) buf.copy(buf, 6 * SECTOR, 0, SECTOR);
    const old = fat.openVolume(fat.memoryReader(buf));
    assert.strictEqual(old.serial, 0x1234abcd);
    // Neither: no serial number to go by.
    buf[sig] = 0;
    if (type === 32) buf.copy(buf, 6 * SECTOR, 0, SECTOR);
    assert.strictEqual(fat.openVolume(fat.memoryReader(buf)).serial, null);
  }
});

test('long names: the checksum picks one first byte, taken only when the long name calls for it', () => {
  const name11 = Buffer.from('BIRTHD~1JPG', 'latin1');
  const entry = (text, sum, ord) => {
    const e = Buffer.alloc(32);
    e[0] = ord;
    e[11] = 0x0f;
    e[13] = sum;
    const units = [...text].map((c) => c.charCodeAt(0));
    if (units.length < 13) units.push(0);
    while (units.length < 13) units.push(0xffff);
    units.forEach((u, j) => e.writeUInt16LE(u, lfnAt(j)));
    return e;
  };
  const sum = lfnChecksum(name11);
  const run = [entry(' (2).jpg', sum, 0x42), entry('Birthday cake', sum, 0x01)];
  assert.deepStrictEqual(longName(run, name11, false), { name: 'Birthday cake (2).jpg' });
  const gone = Buffer.from(name11);
  gone[0] = 0xe5;
  const cake = 'Birthday cake (2).jpg';
  assert.deepStrictEqual(longName(run.map((e) => Buffer.from(e).fill(0xe5, 0, 1)), gone, true), { name: cake, first: 0x42 });
  // Out of order while live: not this name's. An entry left over before them is not taken in, nor
  // are a deleted file's entries left before a live one's.
  assert.strictEqual(longName([run[1], run[0]], name11, false), null);
  assert.deepStrictEqual(longName([entry('stale', sum, 0x41), ...run], name11, false), { name: cake });
  const stale = Buffer.from(entry('old name', 0x11, 0x41)).fill(0xe5, 0, 1);
  assert.deepStrictEqual(longName([stale, ...run], name11, false), { name: cake });
  assert.strictEqual(longName([stale], name11, false), null);
  // Exactly one first byte fits any checksum.
  let fits = 0;
  for (let b = 0; b < 256; b++) if (lfnChecksum(Buffer.concat([Buffer.from([b]), name11.subarray(1)])) === sum) fits++;
  assert.strictEqual(fits, 1);
});

// ------------------------------------------------------------------ exFAT

function exfatCard() {
  const img = new ExfatImage({ sectors: 16384 });
  const data = {};
  const put = (dir, name, n, where, seed, opts) => {
    const p = img.file(dir, name, (data[name] = bytes(n, seed)), where, opts);
    data[p] = data[name];
    return p;
  };
  put('', 'DSC_0001.JPG', 10000, 100, 1);
  put('', 'VID_0002.MP4', 30000, [300, 301, 302, 303, 310, 311, 312, 313], 2);
  put('', 'VID_0003.MP4', 30000, [400, 401, 402, 403, 410, 411, 412, 413], 3);
  put('', 'DSC_0004.JPG', 10000, 500, 4);
  put('', 'moved.jpg', 5000, 600, 5);
  img.mkdir('', 'Album', 650);
  img.mkdir('', 'DCIM', 690);
  img.mkdir('DCIM', '100MEDIA', 700);
  put('DCIM\\100MEDIA', 'DSC_0005.JPG', 10000, 710, 6);
  put('', 'broken set.png', 3000, 750, 7);
  put('', 'recomputed.png', 3000, 760, 8);
  put('', 'partial.mov', 10000, 800, 9, { valid: 5000 });
  put('', 'café.jpg', 3000, 850, 10);
  img.remove('DSC_0001.JPG');
  img.remove('VID_0002.MP4');
  img.remove('VID_0003.MP4', 'zero-chain');
  img.remove('DSC_0004.JPG');
  img.file('', 'NEW.BIN', bytes(8192, 11), 501);
  img.move('moved.jpg', 'Album');
  img.remove('DCIM\\100MEDIA\\DSC_0005.JPG');
  img.remove('DCIM\\100MEDIA');
  img.remove('broken set.png');
  // Changed after it was deleted, without its checksum.
  img.items.get('broken set.png').set.writeUInt32LE(1234, 52);
  img.remove('recomputed.png', 'recompute');
  img.remove('partial.mov');
  img.remove('café.jpg');
  // Two deleted files in the same cluster: the later one was written over the earlier.
  put('', 'old.jpg', 8000, 900, 12, { when: [2024, 1, 1, 9, 0, 0] });
  img.remove('old.jpg');
  put('', 'newer.jpg', 8000, 901, 13, { when: [2024, 6, 1, 9, 0, 0] });
  img.remove('newer.jpg');
  return { img, buf: img.image(), data };
}

test('exFAT: recorded extents, old chains, the bitmap, moves, deleted folders and damaged sets', () => {
  const dir = workDir('lib-fat');
  dirs.push(dir);
  const { buf, data } = exfatCard();
  const file = saved(dir, 'sd.img', buf);
  const reader = fat.openReader(file);
  try {
    const found = fat.scan(reader);
    assert.strictEqual(found.volumes.length, 1);
    const v = found.volumes[0];
    assert.strictEqual(v.fs, 'exfat');
    assert.strictEqual(v.volume.fs, 'exFAT');
    assert.strictEqual(v.volume.label, 'MYCARD');
    assert.strictEqual(v.volume.fromBackup, false);
    assert.deepStrictEqual(v.notes, []);

    const one = byPath(v, 'DSC_0001.JPG');
    assert.strictEqual(one.status, 'complete');
    assert.strictEqual(one.extent.how, 'recorded');
    assert.strictEqual(md5(readAll(reader, one.extent)), md5(data['DSC_0001.JPG']));
    // +09:00 was recorded, so the moment is exact; the 10 ms steps add 250 ms.
    assert.strictEqual(one.modified.offset, 540);
    assert.strictEqual(one.modified.wall, '2024-07-01T13:45:30.250');
    assert.strictEqual(one.modified.ms, Date.UTC(2024, 6, 1, 13, 45, 30, 250) - 9 * 3600000);
    assert.strictEqual(one.shortName, null);

    const two = byPath(v, 'VID_0002.MP4');
    assert.strictEqual(two.status, 'complete');
    assert.strictEqual(two.extent.how, 'chain');
    assert.deepStrictEqual(two.extent.runs, [[300, 4], [310, 4]]);
    assert.strictEqual(md5(readAll(reader, two.extent)), md5(data['VID_0002.MP4']));

    const three = byPath(v, 'VID_0003.MP4');
    assert.strictEqual(three.status, 'assumed');
    assert.strictEqual(three.extent.how, 'contiguous');
    assert.notStrictEqual(md5(readAll(reader, three.extent)), md5(data['VID_0003.MP4']));

    assert.strictEqual(byPath(v, 'DSC_0004.JPG').status, 'overwritten');
    const moved = byPath(v, 'moved.jpg');
    assert.strictEqual(moved.status, 'moved');
    assert.strictEqual(moved.movedTo, 'Album\\moved.jpg');

    const five = byPath(v, 'DCIM\\100MEDIA\\DSC_0005.JPG');
    assert.strictEqual(five.inDeletedFolder, true);
    assert.strictEqual(five.status, 'complete');
    assert.strictEqual(md5(readAll(reader, five.extent)), md5(data['DSC_0005.JPG']));

    assert.strictEqual(byPath(v, 'broken set.png').status, 'damaged');
    const again = byPath(v, 'recomputed.png');
    assert.strictEqual(again.status, 'complete');
    assert.ok(again.notes.some((n) => /recomputed/.test(n)));

    // Past the valid data length the file reads as zeros.
    const partial = byPath(v, 'partial.mov');
    assert.strictEqual(partial.extent.validSize, 5000);
    const got = readAll(reader, partial.extent);
    assert.strictEqual(got.length, 10000);
    assert.deepStrictEqual(got.subarray(0, 5000), data['partial.mov'].subarray(0, 5000));
    assert.ok(got.subarray(5000).every((x) => x === 0));

    // A name beyond ASCII hashes through the volume's own up-case table.
    const cafe = byPath(v, 'café.jpg');
    assert.strictEqual(cafe.status, 'complete');
    assert.deepStrictEqual(cafe.notes, []);

    const old = byPath(v, 'old.jpg');
    assert.strictEqual(old.status, 'overwritten');
    assert.match(old.candidates[0].problems[0], /newer\.jpg/);
    assert.strictEqual(byPath(v, 'newer.jpg').status, 'complete');

    assert.ok(!v.deleted.some((d) => ['NEW.BIN', 'Album\\moved.jpg'].includes(d.path)));
    assert.strictEqual(v.stats.deletedFoldersRead, 1);

    // Where a carver would look: free clusters that no deleted file is taken to lie in.
    const runs = [...fat.freeRuns(v.volume, v.deleted)];
    assert.ok(runs.every(([c, n]) => c >= 2 && n > 0));
    const covered = new Set(runs.flatMap(([c, n]) => Array.from({ length: n }, (_, i) => c + i)));
    assert.ok(!covered.has(100) && !covered.has(501) && !covered.has(300));
    assert.ok(covered.has(410) && covered.has(1000));
    let free = 0;
    for (let c = 2; c < v.volume.clusterCount + 2; c++) if (!(v.volume.bitmap[(c - 2) >> 3] & (1 << ((c - 2) & 7)))) free++;
    assert.strictEqual(v.volume.freeClusters(), free);
  } finally {
    reader.close();
  }
});

test('exFAT: a damaged boot region gives way to its backup', () => {
  const { buf } = exfatCard();
  const copy = Buffer.from(buf);
  copy[100] ^= 0xff; // the serial number: the checksum no longer matches
  const vol = fat.openVolume(fat.memoryReader(copy));
  assert.strictEqual(vol.fromBackup, true);
  assert.strictEqual(vol.serial, 0xcafe1234);
  copy.fill(0, 0, SECTOR);
  const { volumes } = fat.findVolumes(fat.memoryReader(copy));
  assert.strictEqual(volumes[0].fs, 'exfat');
  assert.strictEqual(volumes[0].backup, true);
});

// Written by Windows 10's exfat.sys, as printed in Vandermeer et al., "Forensic Analysis of the
// exFAT artefacts" (2018, arXiv:1804.08653), figures 1, 2 and 4: an active set, the set of a
// deleted file in pieces, and the set a move left behind.
const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const WINDOWS_SETS = hex(`
85 02 19 E0 20 00 00 00 27 4B 3E 49 FD 65 86 46 27 4B 3E 49 99 00 88 88 88 00 00 00 00 00 00 00
C0 03 00 0A B0 42 00 00 8B 95 0E 00 00 00 00 00 00 00 00 00 0B 00 00 00 8B 95 0E 00 00 00 00 00
C1 00 63 00 6F 00 6C 00 6F 00 72 00 73 00 2E 00 6A 00 70 00 67 00 00 00 00 00 00 00 00 00 00 00
05 03 04 56 20 00 00 00 33 94 45 49 FB 5B 17 49 33 94 45 49 9B 00 88 88 88 00 00 00 00 00 00 00
40 01 00 10 64 08 00 00 73 A2 56 00 00 00 00 00 00 00 00 00 F5 24 00 00 73 A2 56 00 00 00 00 00
41 00 74 00 61 00 72 00 67 00 65 00 74 00 5F 00 65 00 61 00 72 00 74 00 68 00 2E 00 70 00 6E 00
41 00 67 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
05 02 87 2B 20 00 00 00 AF 70 3E 49 41 83 03 3D AF 70 3E 49 19 00 88 88 88 00 00 00 00 00 00 00
40 03 00 0A D5 3B 00 00 68 AA 4B 00 00 00 00 00 00 00 00 00 F7 02 00 00 68 AA 4B 00 00 00 00 00
41 00 73 00 71 00 75 00 61 00 72 00 65 00 2E 00 6A 00 70 00 67 00 00 00 00 00 00 00 00 00 00 00`);

test('exFAT sets written by Windows 10: its checksums and name hashes, and a deleted set\'s checksum kept', () => {
  const { sets } = exfatSets(WINDOWS_SETS, (i) => i);
  assert.deepStrictEqual(sets.map((s) => [s.name, s.deleted, s.checksum]), [
    ['colors.jpg', false, 'ok'],
    ['target_earth.png', true, 'restored'],
    ['square.jpg', true, 'restored'],
  ]);
  assert.strictEqual(setChecksum(WINDOWS_SETS.subarray(0, 96)), 0xe019);
  const up = defaultUpcase();
  assert.deepStrictEqual(sets.map((s) => nameHash(s.name, up) === s.nameHash), [true, true, true]);
  const [colors, earth, square] = sets;
  assert.deepStrictEqual([colors.first, colors.size, colors.noFatChain], [11, 0x0e958b, true]);
  assert.deepStrictEqual([earth.first, earth.size, earth.noFatChain], [0x24f5, 0x56a273, false]);
  assert.deepStrictEqual([square.first, square.size], [0x2f7, 0x4baa68]);
  assert.strictEqual(colors.modified.offset, 120);
});

// ------------------------------------------------------------------ partitions

test('partitions: MBR with a logical partition, and GPT', () => {
  const small = new FatImage({ type: 16, sectors: 20000 });
  const a = bytes(900, 41);
  small.file('', 'Gone file.txt', a, 50);
  small.remove('Gone file.txt', 'linux');
  const fatVol = small.image();
  const ex = new ExfatImage({ sectors: 8192 });
  const b = bytes(5000, 42);
  ex.file('', 'clip.mp4', b, 40);
  ex.remove('clip.mp4');
  const exVol = ex.image();

  // A primary FAT16 partition, and an extended one whose one logical partition is exFAT.
  const sectors = 2048 + 20000 + 2048 + 8192 + 64;
  const disk = Buffer.alloc(sectors * SECTOR);
  mbrEntry(disk, 0, 0x06, 2048, 20000);
  const ext = 2048 + 20000;
  mbrEntry(disk, 1, 0x0f, ext, 2048 + 8192);
  const ebr = Buffer.alloc(SECTOR);
  mbrEntry(ebr, 0, 0x07, 2048, 8192);
  ebr.copy(disk, ext * SECTOR);
  fatVol.copy(disk, 2048 * SECTOR);
  exVol.copy(disk, (ext + 2048) * SECTOR);
  const mbr = fat.scan(fat.memoryReader(disk));
  assert.deepStrictEqual(mbr.volumes.map((v) => [v.scheme, v.index, v.fs, v.offset, v.size, v.type]), [
    ['mbr', 1, 'fat', 2048 * SECTOR, 20000 * SECTOR, 0x06],
    ['mbr', 5, 'exfat', (ext + 2048) * SECTOR, 8192 * SECTOR, 0x07],
  ]);
  const r = fat.memoryReader(disk);
  const gone = byPath(mbr.volumes[0], 'Gone file.txt');
  assert.strictEqual(md5(readAll(r, gone.extent)), md5(a));
  assert.strictEqual(gone.at > 2048 * SECTOR, true);
  const clip = byPath(mbr.volumes[1], 'clip.mp4');
  assert.strictEqual(clip.status, 'complete');
  assert.strictEqual(md5(readAll(r, clip.extent)), md5(b));

  const gdisk = gptDisk(2048 + 20000 + 64, [{ lba: 2048, image: fatVol, name: 'CARD' }]);
  const gpt = fat.scan(fat.memoryReader(gdisk));
  assert.deepStrictEqual(gpt.notes, []);
  assert.deepStrictEqual(gpt.volumes.map((v) => [v.scheme, v.index, v.fs, v.offset, v.name, v.type]), [
    ['gpt', 1, 'fat', 2048 * SECTOR, 'CARD', 'EBD0A0A2-B9E5-4433-87C0-68B6B72699C7'],
  ]);
  assert.strictEqual(md5(readAll(fat.memoryReader(gdisk), byPath(gpt.volumes[0], 'Gone file.txt').extent)), md5(a));
  // A damaged header is said, and its entries still read.
  gdisk[SECTOR + 40] ^= 1;
  const bent = fat.findVolumes(fat.memoryReader(gdisk));
  assert.strictEqual(bent.volumes.length, 1);
  assert.ok(bent.notes.some((n) => /GPT header/.test(n)));
});

// ------------------------------------------------------------------ reading

test('a deleted file streams in ranges counted as fs.createReadStream counts them, zeros past its valid length', async () => {
  const { buf, data } = exfatCard();
  const reader = fat.memoryReader(buf);
  const res = fat.scanVolume(fat.openVolume(reader));
  const collect = async (s) => {
    const parts = [];
    for await (const c of s) parts.push(c);
    return Buffer.concat(parts);
  };
  const two = byPath(res, 'VID_0002.MP4');
  assert.deepStrictEqual(await collect(fat.streamExtent(reader, two.extent, { chunk: 1000 })), data['VID_0002.MP4']);
  assert.deepStrictEqual(await collect(fat.streamExtent(reader, two.extent, { start: 16000, end: 16999 })),
    data['VID_0002.MP4'].subarray(16000, 17000));
  const partial = byPath(res, 'partial.mov');
  const tail = await collect(fat.streamExtent(reader, partial.extent, { start: 4990, end: 5009 }));
  assert.deepStrictEqual(tail, Buffer.concat([data['partial.mov'].subarray(4990, 5000), Buffer.alloc(10)]));
  // An image that ends inside the file ends the stream with an error, not a short file.
  const cut = fat.memoryReader(buf.subarray(0, two.extent.spans[1][0] + 100));
  await assert.rejects(collect(fat.streamExtent(cut, two.extent)), /could be read/);
});

test('a folder or a missing file is not a place to read', () => {
  const dir = workDir('lib-fat');
  dirs.push(dir);
  assert.throws(() => fat.openReader(dir));
  assert.throws(() => fat.openReader(path.join(dir, 'missing.img')), { code: 'ENOENT' });
  assert.throws(() => fat.openVolume(fat.memoryReader(Buffer.alloc(8192))), /No FAT or exFAT/);
  assert.ok(!fs.existsSync(path.join(dir, 'missing.img')));
});

test('times and code pages', () => {
  // The 10 ms steps add up to 1.99 s to an even second, which never reaches the next minute.
  const w = dosFields([2023, 12, 31, 23, 59, 58, 99]);
  const last = dosStamp(w.date, w.time, 1990, 0);
  assert.strictEqual(last.wall, '2023-12-31T23:59:59.990');
  assert.strictEqual(last.ms, Date.UTC(2023, 11, 31, 23, 59, 59, 990));
  assert.strictEqual(dosStamp(0, 0), null);
  assert.strictEqual(dosStamp(((2023 - 1980) << 9) | (2 << 5) | 30, 0), null, 'February 30th');
  assert.strictEqual(utcOffset(0x80 | 0x7c), -60);
  assert.strictEqual(utcOffset(0x24), null);
  assert.strictEqual([...CP437].length, 128);
  assert.strictEqual(fat._internal.oemDecoder('cp437')(Buffer.from([0x41, 0x82, 0x90])), 'AéÉ');
});
