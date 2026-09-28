'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { workDir, cleanup, write, only, snapshot } = require('./helpers');
const hancom = require('../src/sources/hancom');
const { classify, readCfb, readLink, readChecked, profileOf, crc32, tableCrc32 } = hancom._internal;
const { search, git } = require('../src/search');
const { load, blobHash } = require('../src/content');
const { planRebuild } = require('../src/restore');

const dirs = [];
after(() => dirs.forEach(cleanup));

// ---- Writers for the formats read, so no fixture comes from a real machine -------------------

const FREE = 0xffffffff;
const END = 0xfffffffe;

/** A version 3 compound file holding `streams`, [['Storage/Name', Buffer], ...]. */
function compoundFile(streams) {
  const entries = [{ name: 'Root Entry', type: 5, kids: [] }];
  const storages = new Map([['', 0]]);
  for (const [p, data] of streams) {
    const parts = p.split('/');
    let parent = 0;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts.slice(0, i + 1).join('/');
      if (!storages.has(key)) {
        entries.push({ name: parts[i], type: 1, kids: [] });
        storages.set(key, entries.length - 1);
        entries[parent].kids.push(entries.length - 1);
      }
      parent = storages.get(key);
    }
    entries.push({ name: parts[parts.length - 1], type: 2, data, kids: [] });
    entries[parent].kids.push(entries.length - 1);
  }
  // Small streams go into the mini stream, 64 bytes a piece; the rest into whole sectors.
  const miniFat = [];
  const miniData = [];
  const big = [];
  for (const e of entries.filter((x) => x.type === 2)) {
    if (e.data.length >= 4096) {
      big.push(e);
      continue;
    }
    const n = Math.ceil(e.data.length / 64);
    e.start = n ? miniFat.length : END;
    for (let i = 0; i < n; i++) miniFat.push(i < n - 1 ? miniFat.length + 1 : END);
    miniData.push(e.data, Buffer.alloc(n * 64 - e.data.length));
  }
  const mini = Buffer.concat(miniData);
  const sectors = (bytes) => Math.ceil(bytes / 512);
  const nDir = sectors(entries.length * 128);
  const nMiniFat = sectors(miniFat.length * 4);
  const nMini = sectors(mini.length);
  const others = nDir + nMiniFat + nMini + big.reduce((a, e) => a + sectors(e.data.length), 0);
  let nFat = 1;
  while (nFat * 128 < nFat + others) nFat++;
  const fat = new Array(nFat * 128).fill(FREE);
  let next = 0;
  const run = (n) => {
    const start = next;
    for (let i = 0; i < n; i++) fat[start + i] = i < n - 1 ? start + i + 1 : END;
    next += n;
    return n ? start : END;
  };
  for (let i = 0; i < nFat; i++) fat[next++] = 0xfffffffd;
  const dirStart = run(nDir);
  const miniFatStart = run(nMiniFat);
  entries[0].start = run(nMini);
  entries[0].size = mini.length;
  for (const e of big) e.start = run(sectors(e.data.length));

  const header = Buffer.alloc(512);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header, 0);
  header.writeUInt16LE(0x3e, 24);
  header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(nFat, 44);
  header.writeUInt32LE(dirStart, 48);
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(nMiniFat ? miniFatStart : END, 60);
  header.writeUInt32LE(nMiniFat, 64);
  header.writeUInt32LE(END, 68);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i < nFat ? i : FREE, 76 + i * 4);

  const dir = Buffer.alloc(nDir * 512);
  entries.forEach((e, id) => {
    const o = id * 128;
    const name = Buffer.from(e.name + '\0', 'utf16le');
    name.copy(dir, o);
    dir.writeUInt16LE(name.length, o + 64);
    dir[o + 66] = e.type;
    dir[o + 67] = 1;
    dir.writeUInt32LE(FREE, o + 68);
    dir.writeUInt32LE(FREE, o + 72);
    dir.writeUInt32LE(e.kids.length ? e.kids[0] : FREE, o + 76);
    dir.writeUInt32LE(e.start === undefined ? END : e.start, o + 116);
    dir.writeUInt32LE(e.type === 5 ? e.size : e.data ? e.data.length : 0, o + 120);
  });
  // Siblings as a chain to the right: not balanced, which readers do not need.
  for (const e of entries) {
    e.kids.forEach((id, i) => dir.writeUInt32LE(i + 1 < e.kids.length ? e.kids[i + 1] : FREE, id * 128 + 72));
  }

  const u32s = (list, n) => {
    const b = Buffer.alloc(n * 512, 0xff);
    list.forEach((v, i) => b.writeUInt32LE(v, i * 4));
    return b;
  };
  const pad = (b) => Buffer.concat([b, Buffer.alloc(sectors(b.length) * 512 - b.length)]);
  return Buffer.concat([header, u32s(fat, nFat), dir, u32s(miniFat, nMiniFat), pad(mini), ...big.map((e) => pad(e.data))]);
}

function record(tag, data) {
  const h = Buffer.alloc(4);
  h.writeUInt32LE((tag | (data.length << 20)) >>> 0);
  return Buffer.concat([h, data]);
}

/** Bytes that do not compress, so a picture's stream is big enough to need whole sectors. */
function noise(n, seed = 7) {
  const b = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

/** An HWP 5 document: FileHeader, DocInfo, its sections and one embedded picture. */
function hwp({ text = ['안녕하세요'], sections, listed, picture = noise(6000), props = 1, extra = [] } = {}) {
  const head = Buffer.alloc(256);
  head.write('HWP Document File', 0, 'latin1');
  head.writeUInt32LE(0x05000300, 32);
  head.writeUInt32LE(props, 36);
  const count = Buffer.alloc(26);
  count.writeUInt16LE(sections == null ? text.length : sections, 0);
  const bin = Buffer.alloc(12);
  bin.writeUInt16LE(0x0001, 0);
  bin.writeUInt16LE(1, 2);
  bin.writeUInt16LE(3, 4);
  Buffer.from('png', 'utf16le').copy(bin, 6);
  const pack = (b) => (props & 1 ? zlib.deflateRawSync(b) : b);
  const streams = [
    ['FileHeader', head],
    ['DocInfo', pack(Buffer.concat([record(16, count), record(18, bin)]))],
    ...text.map((s, i) => [`BodyText/Section${i}`, pack(Buffer.concat([record(66, Buffer.alloc(22)), record(67, Buffer.from(s, 'utf16le'))]))]),
    ['PrvText', Buffer.from(text.join('\r\n'), 'utf16le')],
  ];
  if (listed !== false) streams.push(['BinData/BIN0001.png', pack(picture)]);
  return compoundFile(streams.concat(extra));
}

/** A password (0x2) or distribution (0x4) document: what is inside cannot be read without a key. */
function sealedHwp(props, streams) {
  const head = Buffer.alloc(256);
  head.write('HWP Document File', 0, 'latin1');
  head.writeUInt32LE(0x05000300, 32);
  head.writeUInt32LE(props, 36);
  return compoundFile([['FileHeader', head], ['DocInfo', noise(40)], ...streams]);
}

/** Where a directory entry of this name starts in a compound file. */
function entryAt(buf, name) {
  for (let o = 512; o + 128 <= buf.length; o += 128) {
    if (buf.readUInt16LE(o + 64) === (name.length + 1) * 2 && buf.toString('utf16le', o, o + name.length * 2) === name) return o;
  }
  return -1;
}

/** Sector s's entry in the first FAT sector of a compound file. */
const fatAt = (buf, s) => 512 + buf.readUInt32LE(76) * 512 + s * 4;

/** A zip; entries are [name, data, store?]. */
function zip(entries) {
  const locals = [];
  const central = [];
  let at = 0;
  for (const [name, data, store] of entries) {
    const packed = store ? data : zlib.deflateRawSync(data);
    const n = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(tableCrc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x800, 8);
    cd.writeUInt16LE(store ? 0 : 8, 10);
    cd.writeUInt32LE(tableCrc32(data), 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(n.length, 28);
    cd.writeUInt32LE(at, 42);
    locals.push(local, n, packed);
    central.push(cd, n);
    at += 30 + n.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(at, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** The central directory of a zip: where each entry's record is, and the end record. */
function centralDirectory(z) {
  const eocd = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const out = [];
  let p = z.readUInt32LE(eocd + 16);
  for (let i = 0; i < z.readUInt16LE(eocd + 10); i++) {
    const len = 46 + z.readUInt16LE(p + 28) + z.readUInt16LE(p + 30) + z.readUInt16LE(p + 32);
    out.push({ at: p, len, name: z.toString('utf8', p + 46, p + 46 + z.readUInt16LE(p + 28)) });
    p += len;
  }
  return { eocd, entries: out };
}

function hwpx(body = '<hs:sec/>') {
  return zip([
    ['mimetype', Buffer.from('application/hwp+zip'), true],
    ['version.xml', Buffer.from('<version/>'), true],
    ['Contents/header.xml', Buffer.from('<hh:head/>')],
    ['Contents/section0.xml', Buffer.from(body)],
  ]);
}

/**
 * A shortcut as Hancom's Recent folder holds them: an absolute path in the ANSI code page (or
 * in Unicode too), and a Unicode path relative to the shortcut's own folder.
 */
function shortcut({ ansi, unicode, rel, folder = false }) {
  const head = Buffer.alloc(0x4c);
  head.writeUInt32LE(0x4c, 0);
  Buffer.from('0114020000000000c000000000000046', 'hex').copy(head, 4);
  head.writeUInt32LE(0x2 | (rel ? 0x8 : 0) | 0x80, 0x14);
  head.writeUInt32LE(folder ? 0x10 : 0x20, 0x18);
  const headSize = unicode ? 0x24 : 0x1c;
  const volume = Buffer.alloc(0x11);
  volume.writeUInt32LE(0x11, 0);
  volume.writeUInt32LE(3, 4);
  volume.writeUInt32LE(0x10, 12);
  const base = Buffer.concat([ansi, Buffer.from([0])]);
  const suffix = Buffer.from([0]);
  const wide = unicode ? Buffer.from(unicode + '\0', 'utf16le') : Buffer.alloc(0);
  const wideSuffix = unicode ? Buffer.from('\0', 'utf16le') : Buffer.alloc(0);
  const info = Buffer.alloc(headSize);
  const volumeAt = headSize;
  const baseAt = volumeAt + volume.length;
  const suffixAt = baseAt + base.length;
  const wideAt = suffixAt + suffix.length;
  const size = wideAt + wide.length + wideSuffix.length;
  info.writeUInt32LE(size, 0);
  info.writeUInt32LE(headSize, 4);
  info.writeUInt32LE(1, 8);
  info.writeUInt32LE(volumeAt, 12);
  info.writeUInt32LE(baseAt, 16);
  info.writeUInt32LE(suffixAt, 24);
  if (unicode) {
    info.writeUInt32LE(wideAt, 28);
    info.writeUInt32LE(wideAt + wide.length, 32);
  }
  const parts = [head, info, volume, base, suffix, wide, wideSuffix];
  if (rel) {
    const count = Buffer.alloc(2);
    count.writeUInt16LE(rel.length);
    parts.push(count, Buffer.from(rel, 'utf16le'));
  }
  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts);
}

// ---- The checks --------------------------------------------------------------------------------

test('CRC-32 by table matches the standard check value, and zlib where it has one', () => {
  assert.strictEqual(tableCrc32(Buffer.from('123456789')), 0xcbf43926);
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('a whole HWP 5 document passes, with small and large streams read back exactly', () => {
  const picture = noise(6000);
  const doc = hwp({ text: ['첫 구역', 'second section'], picture });
  assert.strictEqual(classify(doc), 'hwp');
  const cfb = readCfb(doc, () => true);
  assert.deepStrictEqual([...cfb.names].sort(), ['BinData', 'BinData/BIN0001.png', 'BodyText', 'BodyText/Section0', 'BodyText/Section1', 'DocInfo', 'FileHeader', 'PrvText']);
  assert.ok(zlib.inflateRawSync(cfb.streams.get('BinData/BIN0001.png')).equals(picture), 'the picture spans whole sectors');
  assert.strictEqual(cfb.streams.get('PrvText').toString('utf16le'), '첫 구역\r\nsecond section');
  assert.strictEqual(classify(hwp({ props: 0 })), 'hwp', 'an uncompressed document is read as it is');
});

test('an HWP 5 document cut short anywhere fails', () => {
  const doc = hwp();
  for (const n of [512, 1024, doc.length / 2, doc.length - 512, doc.length - 1]) {
    assert.notStrictEqual(classify(doc.subarray(0, n)), 'hwp', `cut at ${n} of ${doc.length}`);
  }
});

test('an HWP 5 document whose parts disagree fails', () => {
  assert.strictEqual(classify(hwp({ sections: 2 })), 'broken', 'DocInfo counts a section that is not there');
  assert.strictEqual(classify(hwp({ listed: false })), 'broken', 'DocInfo lists a picture that is not there');

  // A section whose records run past its end.
  const doc = hwp({ props: 0 });
  const cfb = readCfb(doc, () => true);
  const section = cfb.streams.get('BodyText/Section0');
  const at = doc.indexOf(section);
  const bad = Buffer.from(doc);
  bad.writeUInt32LE((66 | (0xffe << 20)) >>> 0, at);
  assert.strictEqual(classify(bad), 'broken');

  // Two streams of the same size pointed at the same sectors: each chain alone is fine.
  const picture = noise(6000);
  const shared = Buffer.from(hwp({ picture, extra: [['BinData/BIN0002.png', zlib.deflateRawSync(picture)]] }));
  assert.strictEqual(classify(shared), 'hwp');
  const first = entryAt(shared, 'BIN0001.png');
  shared.writeUInt32LE(shared.readUInt32LE(first + 116), entryAt(shared, 'BIN0002.png') + 116);
  assert.strictEqual(classify(shared), 'broken');
});

test('an HWP 5 document fails on any one part that is wrong', () => {
  assert.strictEqual(classify(hwp({ listed: false, extra: [['BinData/BIN0001.png', Buffer.alloc(100, 0xff)]] })), 'broken',
    'a picture DocInfo says is compressed that does not inflate');
  assert.strictEqual(classify(hwp({ text: ['one', 'two'], sections: 1 })), 'broken', 'a section DocInfo does not count');

  // A section whose first record is not a paragraph header.
  const doc = Buffer.from(hwp({ props: 0 }));
  const at = doc.indexOf(readCfb(doc, () => true).streams.get('BodyText/Section0'));
  doc.writeUInt32LE(((doc.readUInt32LE(at) & ~0x3ff) | 67) >>> 0, at);
  assert.strictEqual(classify(doc), 'broken');

  // A FileHeader of another version.
  const v4 = Buffer.from(hwp());
  v4.writeUInt32LE(0x04000000, v4.indexOf('HWP Document File', 0, 'latin1') + 32);
  assert.strictEqual(classify(v4), 'broken');
});

test('a password or distribution document needs a section, since nothing inside can be read', () => {
  assert.strictEqual(classify(sealedHwp(0x2, [['BodyText/Section0', noise(300)]])), 'hwp');
  assert.strictEqual(classify(sealedHwp(0x4, [['ViewText/Section0', noise(300)]])), 'hwp');
  assert.strictEqual(classify(sealedHwp(0x2, [['PrvText', Buffer.from('x', 'utf16le')]])), 'broken');
});

test('every sector of a compound file belongs to one thing, and the FAT says what each is', () => {
  // Two small streams pointed at the same 64-byte piece of the mini stream.
  const mini = Buffer.from(hwp());
  const head = entryAt(mini, 'FileHeader');
  const last = mini.readUInt32LE(head + 116) + Math.ceil(mini.readUInt32LE(head + 120) / 64) - 1;
  mini.writeUInt32LE(last, entryAt(mini, 'PrvText') + 116);
  assert.strictEqual(classify(mini), 'broken');

  // The FAT's own sector marked free.
  const fat = Buffer.from(hwp());
  fat.writeUInt32LE(FREE, fatAt(fat, fat.readUInt32LE(76)));
  assert.strictEqual(classify(fat), 'broken');

  // A sector past the end of the file that the FAT does not leave free.
  const past = Buffer.from(hwp());
  past.writeUInt32LE(END, fatAt(past, past.length / 512 - 1));
  assert.strictEqual(classify(past), 'broken');

  // A stream laid over the directory's own sectors.
  const extra = [['Extra', Buffer.alloc(4096, 3)]];
  for (let i = 0; i < 30; i++) extra.push([`X${i}`, Buffer.alloc(8, i)]);
  const over = Buffer.from(hwp({ extra }));
  assert.strictEqual(classify(over), 'hwp');
  let dirSectors = 0;
  for (let s = over.readUInt32LE(48); s !== END; s = over.readUInt32LE(fatAt(over, s))) dirSectors++;
  assert.ok(dirSectors >= 8, 'the directory is as long as the stream');
  const e = entryAt(over, 'Extra');
  over.writeUInt32LE(over.readUInt32LE(48), e + 116);
  over.writeUInt32LE(dirSectors * 512, e + 120);
  assert.strictEqual(classify(over), 'broken');
});

test('a compound file that is not an HWP document is not claimed', () => {
  const other = compoundFile([['WordDocument', Buffer.alloc(100, 1)], ['1Table', Buffer.alloc(50, 2)]]);
  assert.strictEqual(classify(other), null);
  assert.strictEqual(classify(Buffer.from('plain text backup of something else')), null);
  assert.strictEqual(classify(Buffer.from('HWP Document File V3.00 \x1a\x01\x02\x03\x04\x05 and more', 'latin1')), 'hwp3');
});

test('a whole HWPX document passes; a changed byte, a cut or another kind of zip does not', () => {
  const doc = hwpx('<hs:sec>본문</hs:sec>');
  assert.strictEqual(classify(doc), 'hwpx');
  const changed = Buffer.from(doc);
  changed[doc.indexOf('<version/>') + 3] ^= 1;
  assert.strictEqual(classify(changed), 'broken', 'a stored byte that no longer matches its CRC');
  assert.strictEqual(classify(doc.subarray(0, doc.length - 1)), 'broken');
  assert.strictEqual(classify(zip([['mimetype', Buffer.from('application/vnd.oasis.opendocument.text'), true]])), null);
  assert.strictEqual(classify(zip([['mimetype', Buffer.from('application/hwp+zip'), true]])), 'broken', 'no sections');
});

test('an HWPX entry must have its recorded size, stay out of the directory and share no bytes', () => {
  const size = Buffer.from(hwpx());
  const version = centralDirectory(size).entries.find((x) => x.name === 'version.xml');
  size.writeUInt32LE(size.readUInt32LE(version.at + 24) + 1, version.at + 24);
  assert.strictEqual(classify(size), 'broken', 'a size one off, the CRC still right');

  const long = Buffer.from(hwpx());
  const section = centralDirectory(long).entries.find((x) => x.name === 'Contents/section0.xml');
  long.writeUInt32LE(long.readUInt32LE(section.at + 20) + 1, section.at + 20);
  assert.strictEqual(classify(long), 'broken', 'packed bytes running into the central directory');

  // A second directory entry for the bytes version.xml already has.
  const z = hwpx();
  const { eocd, entries } = centralDirectory(z);
  const v = entries.find((x) => x.name === 'version.xml');
  const dup = z.subarray(v.at, v.at + v.len);
  const tail = Buffer.from(z.subarray(eocd));
  tail.writeUInt16LE(tail.readUInt16LE(8) + 1, 8);
  tail.writeUInt16LE(tail.readUInt16LE(10) + 1, 10);
  tail.writeUInt32LE(tail.readUInt32LE(12) + dup.length, 12);
  assert.strictEqual(classify(Buffer.concat([z.subarray(0, eocd), dup, tail])), 'broken');
});

// 보고서.hwp on alice's desktop, in the Korean code page (cp949), as a shortcut's ANSI path holds it.
const CP949 = Buffer.concat([Buffer.from('C:\\Users\\alice\\Desktop\\'), Buffer.from('bab8b0edbcad', 'hex'), Buffer.from('.hwp')]);
const UP5 = '..\\..\\..\\..\\..\\';

test('a shortcut gives the path it was made for, and where that is now when its relative path fits', () => {
  const dir = workDir('hancom-lnk');
  dirs.push(dir);
  const recent = path.join(dir, 'Users', 'alice', 'AppData', 'Roaming', 'HNC', 'Office', 'Recent');
  const rel = UP5 + 'Desktop\\report.hwp';
  const desktop = path.join(dir, 'Users', 'alice', 'Desktop');

  write(path.join(recent, 'a.lnk'), shortcut({ ansi: Buffer.from('C:\\Users\\alice\\Desktop\\report.hwp'), rel }));
  assert.deepStrictEqual(readLink(path.join(recent, 'a.lnk')), { recorded: 'C:\\Users\\alice\\Desktop\\report.hwp', now: path.join(desktop, 'report.hwp'), isDir: false });

  // The code page is not recorded, so the path is rebuilt: its ASCII folders, then the relative path's names.
  write(path.join(recent, 'b.lnk'), shortcut({ ansi: CP949, rel: UP5 + 'Desktop\\보고서.hwp' }));
  assert.deepStrictEqual(readLink(path.join(recent, 'b.lnk')), { recorded: 'C:\\Users\\alice\\Desktop\\보고서.hwp', now: path.join(desktop, '보고서.hwp'), isDir: false });

  // When the two disagree where one is ASCII, the relative path stands in for it.
  write(path.join(recent, 'b2.lnk'), shortcut({ ansi: CP949, rel }));
  assert.deepStrictEqual(readLink(path.join(recent, 'b2.lnk')), { recorded: path.join(desktop, 'report.hwp'), now: path.join(desktop, 'report.hwp'), isDir: false });

  // 表.hwp in Shift-JIS, whose second byte is a backslash: splitting there gives a name too many.
  const sjis = Buffer.concat([Buffer.from('C:\\Users\\alice\\Desktop\\'), Buffer.from('955c', 'hex'), Buffer.from('.hwp')]);
  write(path.join(recent, 'b3.lnk'), shortcut({ ansi: sjis, rel: UP5 + 'Desktop\\表.hwp' }));
  assert.deepStrictEqual(readLink(path.join(recent, 'b3.lnk')), { recorded: path.join(desktop, '表.hwp'), now: path.join(desktop, '表.hwp'), isDir: false });

  // Only names at the end come from the relative path: a folder above it that is not ASCII cannot be rebuilt.
  const user = Buffer.concat([Buffer.from('C:\\Users\\'), Buffer.from('bec3b8aebdba', 'hex'), Buffer.from('\\Desktop\\report.hwp')]);
  write(path.join(recent, 'b4.lnk'), shortcut({ ansi: user, rel }));
  assert.deepStrictEqual(readLink(path.join(recent, 'b4.lnk')), { recorded: path.join(desktop, 'report.hwp'), now: path.join(desktop, 'report.hwp'), isDir: false });

  write(path.join(recent, 'c.lnk'), shortcut({ ansi: CP949, unicode: 'C:\\Users\\alice\\Desktop\\보고서.hwp', rel: UP5 + 'Desktop\\보고서.hwp' }));
  assert.deepStrictEqual(readLink(path.join(recent, 'c.lnk')), { recorded: 'C:\\Users\\alice\\Desktop\\보고서.hwp', now: path.join(desktop, '보고서.hwp'), isDir: false });

  write(path.join(recent, 'd.lnk'), shortcut({ ansi: Buffer.from('C:\\Users\\alice\\Desktop'), folder: true }));
  assert.deepStrictEqual(readLink(path.join(recent, 'd.lnk')), { recorded: 'C:\\Users\\alice\\Desktop', now: 'C:\\Users\\alice\\Desktop', isDir: true });

  write(path.join(recent, 'e.lnk'), Buffer.from('not a shortcut'));
  assert.strictEqual(readLink(path.join(recent, 'e.lnk')), null);
  write(path.join(recent, 'f.lnk'), shortcut({ ansi: Buffer.from('C:\\x.hwp'), rel }).subarray(0, 120));
  assert.strictEqual(readLink(path.join(recent, 'f.lnk')), null);
});

test('a relative path that cannot be the recorded one is not followed', () => {
  const dir = workDir('hancom-rel');
  dirs.push(dir);
  const report = 'C:\\Users\\alice\\Desktop\\report.hwp';
  const at = (folder, name, link) => readLink(write(path.join(folder, name), shortcut(link)));
  const fits = path.join(dir, 'Users', 'alice', 'AppData', 'Roaming', 'HNC', 'Office', 'Recent');

  // More ".." than there are folders: path.resolve would stop at the root and go down elsewhere.
  const climbs = '..\\'.repeat(40) + 'Desktop\\report.hwp';
  assert.deepStrictEqual(at(fits, 'a.lnk', { ansi: Buffer.from(report), rel: climbs }), { recorded: report, now: report, isDir: false });
  assert.strictEqual(at(fits, 'a2.lnk', { ansi: CP949, rel: '..\\'.repeat(40) + 'Desktop\\보고서.hwp' }).now, 'C:\\Users\\alice\\Desktop\\보고서.hwp');
  assert.strictEqual(at(fits, 'a3.lnk', { ansi: Buffer.from('D:\\work\\report.hwp'), rel: '..\\'.repeat(40) + 'work\\report.hwp' }).now, 'D:\\work\\report.hwp');

  // A Recent folder in some other user's profile: the folder climbed to is not C:\Users\alice.
  const other = path.join(dir, 'Users', 'bob', 'AppData', 'Roaming', 'HNC', 'Office', 'Recent');
  assert.strictEqual(at(other, 'b.lnk', { ansi: Buffer.from(report), rel: UP5 + 'Desktop\\report.hwp' }).now, report);

  // A relative path to another file.
  assert.strictEqual(at(fits, 'c.lnk', { ansi: Buffer.from(report), rel: UP5 + 'Desktop\\other.hwp' }).now, report);

  // Where it fits, it is followed whatever the root is: a disk mounted elsewhere.
  assert.strictEqual(at(fits, 'd.lnk', { ansi: Buffer.from(report), rel: UP5 + 'Desktop\\report.hwp' }).now,
    path.join(dir, 'Users', 'alice', 'Desktop', 'report.hwp'));
});

test('a place belongs to the profile before its last AppData', () => {
  assert.strictEqual(profileOf('C:\\Users\\alice\\AppData\\Local\\Temp\\Hwp80'), 'c:/users/alice');
  assert.strictEqual(profileOf('C:\\Users\\alice\\AppData\\Roaming\\HNC\\Office\\Recent'), 'c:/users/alice');
  assert.strictEqual(profileOf('/mnt/old/Users/bob/AppData/Local/Temp/Hwp120'), '/mnt/old/Users/bob');
  assert.strictEqual(profileOf('D:\\rescue'), null);
});

// ---- End to end ------------------------------------------------------------------------------

const REPORT = 'C:\\Users\\alice\\Desktop\\report.hwp';
const PLAN = 'C:\\Users\\alice\\Desktop\\plan.hwpx';
const T_BAK = Date.parse('2026-09-10T09:00:00Z');
const T_ASV = Date.parse('2026-09-12T10:00:00Z');

/**
 * One user's profile: two autosaves and a broken one in Temp\Hwp80, a Recent folder that knows
 * report.hwp and plan.hwpx on the desktop, and on the desktop backups -- two of Hancom's and
 * one of some other program's.
 */
function makeProfile() {
  const root = workDir('hancom');
  dirs.push(root);
  const home = path.join(root, 'Users', 'alice');
  const temp = path.join(home, 'AppData', 'Local', 'Temp', 'Hwp80');
  const recent = path.join(home, 'AppData', 'Roaming', 'HNC', 'Office', 'Recent');
  const desktop = path.join(home, 'Desktop');
  const files = {
    reportAsv: write(path.join(temp, 'report.asv'), hwp({ text: ['edited, not saved'] })),
    untitledAsv: write(path.join(temp, '빈 문서 1.asv'), hwp({ text: ['never named'] })),
    cutAsv: write(path.join(temp, 'cut.asv'), hwp().subarray(0, 2048)),
    reportBak: write(path.join(desktop, 'report.bak'), hwp({ text: ['as saved before'] })),
    planBak: write(path.join(desktop, 'plan.bak'), hwpx('<hs:sec>older plan</hs:sec>')),
    otherBak: write(path.join(desktop, 'settings.bak'), Buffer.from('[settings]\nkey=value\n')),
  };
  write(path.join(recent, 'report.hwp.lnk'), shortcut({ ansi: Buffer.from(REPORT), rel: '..\\..\\..\\..\\..\\Desktop\\report.hwp' }));
  write(path.join(recent, 'plan.hwpx.lnk'), shortcut({ ansi: Buffer.from(PLAN), rel: '..\\..\\..\\..\\..\\Desktop\\plan.hwpx' }));
  write(path.join(recent, 'Desktop.folder.lnk'), shortcut({ ansi: Buffer.from('C:\\Users\\alice\\Desktop'), rel: '..\\..\\..\\..\\..\\Desktop', folder: true }));
  fs.utimesSync(files.reportBak, T_BAK / 1000, T_BAK / 1000);
  fs.utimesSync(files.reportAsv, T_ASV / 1000, T_ASV / 1000);
  return { root, temp, recent, desktop, files };
}

const WORK = path.join(__dirname, '.work');
const inWork = (p) => {
  const rel = path.relative(WORK, path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Runs `fn` with every fs call the hancom source makes on a path outside test/.work refused as
 * not there, and returns what it gave and the paths refused. The places searched are all
 * fixtures, but a shortcut names a folder of its own: one taken as it was recorded, such as
 * C:\Users\alice\Desktop, is a real folder on a Windows machine that has that profile.
 */
async function confined(fn) {
  const calls = ['statSync', 'lstatSync', 'readFileSync', 'openSync', 'readdirSync', 'existsSync', 'accessSync'];
  const real = Object.fromEntries(calls.map((n) => [n, fs[n]]));
  const refused = [];
  for (const n of calls) {
    fs[n] = function (p, ...rest) {
      if (typeof p !== 'string' || inWork(p) || !/sources[\\/]hancom\.js/.test(new Error().stack)) return real[n].call(fs, p, ...rest);
      refused.push(p);
      if (n === 'existsSync') return false;
      throw Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });
    };
  }
  try {
    return { value: await fn(), refused };
  } finally {
    Object.assign(fs, real);
  }
}

/** confined(), failing the test when anything was refused. */
async function kept(fn) {
  const { value, refused } = await confined(fn);
  assert.deepStrictEqual(refused, [], 'the hancom source looked outside test/.work');
  return value;
}

/** A search of these places alone, by this source alone, kept inside the fixtures. */
const within = (places, o) => kept(() => search({ sources: ['hancom'], locations: only({ dirs: { hancom: places } }), ...o }));
const find = (pattern, places, o = {}) => within(places, { pattern, ...o });

test('finds the autosave and the backup of a document, each with its path and its bytes', async () => {
  const p = makeProfile();
  const { results } = await find('report', [p.temp, p.recent]);
  assert.deepStrictEqual(results.map((r) => [r.kind, r.path, !!r.draft]), [
    ['hancom autosave', REPORT, true],
    ['hancom backup', REPORT, false],
  ]);
  assert.strictEqual(results[0].time, T_ASV);
  assert.strictEqual(results[1].time, T_BAK);
  assert.ok((await load(results[0], git)).equals(hwp({ text: ['edited, not saved'] })));
  assert.ok((await load(results[1], git)).equals(hwp({ text: ['as saved before'] })));
  assert.match(results[0].note, /report\.hwp/);
});

test('an HWPX backup comes back under its own extension; another program\'s .bak does not', async () => {
  const p = makeProfile();
  const { results } = await find('*.hwpx', [p.temp, p.recent]);
  assert.deepStrictEqual(results.map((r) => [r.kind, r.path]), [['hancom backup', PLAN]]);
  const all = await find('*', [p.temp, p.recent]);
  assert.ok(!all.results.some((r) => /settings/.test(r.origin)));
});

test('an autosave whose document is unknown keeps its name in the note and no path', async () => {
  const p = makeProfile();
  const { results } = await find('빈 문서', [p.temp, p.recent]);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].path, null);
  assert.match(results[0].note, /빈 문서 1\.hwp/);
});

test('a broken autosave is left out, and says so', async () => {
  const p = makeProfile();
  const { results, perSource } = await find('*', [p.temp, p.recent]);
  assert.ok(!results.some((r) => /cut\.asv$/.test(r.origin)));
  assert.deepStrictEqual(perSource[0].notes, ['1 autosave(s) or backup(s) failed their check and were left out']);
});

test('an autosave takes no folder when two recent documents share its name, or from another profile', async () => {
  const p = makeProfile();
  write(path.join(p.recent, 'report.hwp (2).lnk'), shortcut({ ansi: Buffer.from('D:\\work\\report.hwp'), rel: '..\\..\\..\\..\\..\\..\\..\\work\\report.hwp' }));
  let { results } = await find('report', [p.temp, p.recent]);
  assert.deepStrictEqual(results.filter((r) => r.kind === 'hancom autosave').map((r) => r.path), [null]);

  const q = makeProfile();
  const elsewhere = path.join(q.root, 'rescue', 'Hwp80');
  write(path.join(elsewhere, 'report.asv'), hwp());
  ({ results } = await find('report', [elsewhere, q.recent]));
  assert.deepStrictEqual(results.filter((r) => r.kind === 'hancom autosave').map((r) => r.path), [null]);
});

test('rebuilding a folder takes what is known to be below it, and prefers a backup to an autosave', async () => {
  const p = makeProfile();
  const { results } = await within([p.temp, p.recent], { under: 'C:\\Users\\alice\\Desktop' });
  assert.deepStrictEqual(results.map((r) => [r.kind, path.win32.basename(r.path)]).sort(), [
    ['hancom autosave', 'report.hwp'], ['hancom backup', 'plan.hwpx'], ['hancom backup', 'report.hwp'],
  ]);
  const plan = planRebuild(results, 'C:\\Users\\alice\\Desktop');
  assert.deepStrictEqual(plan.map((x) => [x.rel.join('/'), x.copy.kind]), [['plan.hwpx', 'hancom backup'], ['report.hwp', 'hancom backup']]);
});

test('searching writes nothing, and describe and roots report the places', async () => {
  const p = makeProfile();
  const before = snapshot(p.root);
  await find('*', [p.temp, p.recent]);
  assert.deepStrictEqual(snapshot(p.root), before);

  const lines = await kept(() => hancom.describe({ locations: { hancom: [p.temp, p.recent] } }));
  assert.deepStrictEqual(lines, [
    `${p.temp}: 3 autosave(s), 0 .bak file(s), 0 shortcut(s) to recent documents or folders`,
    `${p.recent}: 0 autosave(s), 0 .bak file(s), 3 shortcut(s) to recent documents or folders`,
    '1 folder(s) of recent documents searched for backups; 3 .bak file(s) in all',
  ]);
  assert.deepStrictEqual(hancom.roots({ hancom: [p.temp] }), [p.temp]);
  assert.deepStrictEqual(await hancom.describe({ locations: { hancom: [] } }), ['No Hancom Office folder found.']);
});

test('a profile read from another root keeps the paths it had, for names in any code page', async () => {
  const p = makeProfile();
  // Listed before the others, so it is the first to name the desktop.
  write(path.join(p.recent, '0 보고서.hwp.lnk'), shortcut({ ansi: CP949, rel: UP5 + 'Desktop\\보고서.hwp' }));
  write(path.join(p.temp, '보고서.asv'), hwp({ text: ['고치는 중'] }));
  write(path.join(p.desktop, '보고서.bak'), hwp({ text: ['저장했던 것'] }));
  const { results } = await find('*', [p.temp, p.recent]);
  assert.deepStrictEqual(results.filter((r) => r.path).map((r) => r.path).filter((x) => !x.startsWith('C:\\Users\\alice\\')), []);

  const u = await within([p.temp, p.recent], { under: 'C:\\Users\\alice\\Desktop' });
  assert.deepStrictEqual(u.results.map((r) => [r.kind, path.win32.basename(r.path)]).sort(), [
    ['hancom autosave', 'report.hwp'], ['hancom autosave', '보고서.hwp'],
    ['hancom backup', 'plan.hwpx'], ['hancom backup', 'report.hwp'], ['hancom backup', '보고서.hwp'],
  ]);
});

test('a relative path into another profile is not followed, so what is there is not offered as alice\'s', async () => {
  const root = workDir('hancom-bob');
  dirs.push(root);
  // alice's report.hwp as the shortcut recorded it: under the fixtures, since the folder it names
  // is looked in, and in Unicode too, so the path stays whole whatever the fixtures' path holds.
  const mine = path.join(root, 'Users', 'alice', 'Desktop', 'report.hwp');
  const recent = path.join(root, 'Users', 'bob', 'AppData', 'Roaming', 'HNC', 'Office', 'Recent');
  write(path.join(recent, 'report.hwp.lnk'), shortcut({ ansi: Buffer.from(mine), unicode: mine, rel: UP5 + 'Desktop\\report.hwp' }));
  write(path.join(root, 'Users', 'bob', 'Desktop', 'report.bak'), hwp({ text: ['bob\'s'] }));
  assert.deepStrictEqual((await find('*', [recent])).results, []);

  // The folder it was recorded in is looked in instead.
  const bak = write(path.join(root, 'Users', 'alice', 'Desktop', 'report.bak'), hwp({ text: ['alice\'s'] }));
  const { results } = await find('*', [recent]);
  assert.deepStrictEqual(results.map((r) => [r.kind, r.path, r.origin]), [['hancom backup', mine, bak]]);
  assert.ok((await load(results[0], git)).equals(hwp({ text: ['alice\'s'] })));
});

test('a shortcut\'s Windows path is looked in on Windows alone, and never outside the fixtures here', async () => {
  const root = workDir('hancom-away');
  dirs.push(root);
  const recent = path.join(root, 'Users', 'bob', 'AppData', 'Roaming', 'HNC', 'Office', 'Recent');
  write(path.join(recent, 'report.hwp.lnk'), shortcut({ ansi: Buffer.from(REPORT), rel: UP5 + 'Desktop\\report.hwp' }));
  const { value, refused } = await confined(() => search({ pattern: '*', sources: ['hancom'], locations: only({ dirs: { hancom: [recent] } }) }));
  assert.deepStrictEqual(value.results, []);
  // Elsewhere C:\Users\alice would be taken for a relative name, so it is not looked up at all.
  assert.deepStrictEqual([...new Set(refused)], process.platform === 'win32' ? ['C:\\Users\\alice\\Desktop'] : []);
});

test('an autosave is taken for a recent document only when that is the one of its name, whatever the extension', async () => {
  // Hwp opens report.docx too, and would autosave it as report.asv, in HWP.
  const p = makeProfile();
  write(path.join(p.recent, 'report.docx.lnk'), shortcut({ ansi: Buffer.from('C:\\Users\\alice\\Documents\\report.docx'), rel: UP5 + 'Documents\\report.docx' }));
  let { results } = await find('report', [p.temp, p.recent]);
  let asv = results.filter((r) => r.kind === 'hancom autosave');
  assert.deepStrictEqual(asv.map((r) => r.path), [null]);
  assert.match(asv[0].note, /report\.docx/);
  assert.match(asv[0].note, /report\.hwp/);
  const u = await within([p.temp, p.recent], { under: 'C:\\Users\\alice' });
  assert.ok(!u.results.some((r) => r.kind === 'hancom autosave' && /report/.test(r.origin)));

  // The one recent document of that name is an .hwpx, and this autosave's content is HWP.
  const q = makeProfile();
  write(path.join(q.temp, 'plan.asv'), hwp({ text: ['plan, not saved'] }));
  ({ results } = await find('plan', [q.temp, q.recent]));
  asv = results.filter((r) => r.kind === 'hancom autosave');
  assert.deepStrictEqual(asv.map((r) => r.path), [null]);
  assert.match(asv[0].note, /plan\.hwpx/);

  // A name that keeps its extension.
  const s = makeProfile();
  fs.renameSync(s.files.reportAsv, path.join(s.temp, 'report.hwp.asv'));
  ({ results } = await find('report', [s.temp, s.recent]));
  assert.deepStrictEqual(results.filter((r) => r.kind === 'hancom autosave').map((r) => r.path), [REPORT]);
});

test('a backup takes the extension of the one HWP file of its name that is known there, and no path when two are', async () => {
  const p = makeProfile();
  const FORM = 'C:\\Users\\alice\\Desktop\\form.hwt';
  write(path.join(p.desktop, 'form.hwt'), hwp({ text: ['the template now'] }));
  write(path.join(p.desktop, 'form.bak'), hwp({ text: ['the template before'] }));
  let { results } = await find('*.hwt', [p.temp, p.recent]);
  assert.deepStrictEqual(results.map((r) => [r.kind, r.path]), [['hancom backup', FORM]]);
  assert.match(results[0].note, /form\.hwt/);

  // A deleted form.hwp that the recent documents know: the backup could be of either.
  write(path.join(p.recent, 'form.hwp.lnk'), shortcut({ ansi: Buffer.from('C:\\Users\\alice\\Desktop\\form.hwp'), rel: UP5 + 'Desktop\\form.hwp' }));
  ({ results } = await find('form', [p.temp, p.recent]));
  assert.deepStrictEqual(results.map((r) => [r.kind, r.path]), [['hancom backup', null]]);
  assert.match(results[0].note, /form\.hwp, form\.hwt/);
  const u = await within([p.temp, p.recent], { under: 'C:\\Users\\alice\\Desktop' });
  assert.ok(!u.results.some((r) => /form/.test(r.origin)));
});

test('the bytes offered are the ones checked, whatever the file holds afterwards', async () => {
  const p = makeProfile();
  const whole = hwp({ text: ['edited, not saved'] });
  const saved = hwp({ text: ['as saved before'] });
  const { results } = await find('report', [p.temp, p.recent]);
  const asv = results.find((r) => r.kind === 'hancom autosave');
  const bak = results.find((r) => r.kind === 'hancom backup');
  assert.strictEqual(asv.size, whole.length);
  assert.strictEqual(asv.hash, blobHash(whole));
  // Hwp writing them again, caught halfway.
  fs.writeFileSync(p.files.reportAsv, whole.subarray(0, 2048));
  fs.writeFileSync(p.files.reportBak, saved.subarray(0, 2048));
  assert.ok((await load(asv, git)).equals(whole));
  assert.ok((await load(bak, git)).equals(saved));
});

test('a file that changes while it is read is left out, and says so', async () => {
  const p = makeProfile();
  const { openSync, readSync, writeFileSync } = fs;
  let armed = true;
  let target = null;
  fs.openSync = function (file, ...rest) {
    const fd = openSync.call(fs, file, ...rest);
    if (armed && String(file) === p.files.reportAsv) {
      armed = false;
      target = fd;
    }
    return fd;
  };
  fs.readSync = function (fd, ...rest) {
    const n = readSync.call(fs, fd, ...rest);
    if (fd === target) {
      target = null;
      writeFileSync.call(fs, p.files.reportAsv, hwp({ text: ['saved again, and longer than it was'] }));
    }
    return n;
  };
  let found;
  try {
    found = await find('report', [p.temp, p.recent]);
  } finally {
    Object.assign(fs, { openSync, readSync });
  }
  assert.ok(!armed, 'the autosave was opened');
  assert.deepStrictEqual(found.results.map((r) => r.kind), ['hancom backup']);
  assert.deepStrictEqual(found.perSource[0].notes, ['1 autosave(s) or backup(s) that changed while they were being read were left out; search again to read them']);
});

test('another program\'s .bak is read no further than its first bytes, and only a Hancom one is ever too big', async () => {
  const p = makeProfile();
  const foreign = write(path.join(p.desktop, 'db.bak'), Buffer.alloc(1024 * 1024, 0x42));
  write(path.join(p.desktop, 'old.bak'), Buffer.from('HWP Document File V3.00 \x1a\x01\x02\x03\x04\x05', 'latin1'));
  const { openSync, readSync, closeSync } = fs;
  const open = new Set();
  let opened = 0;
  let bytes = 0;
  fs.openSync = function (file, ...rest) {
    const fd = openSync.call(fs, file, ...rest);
    if (String(file) === foreign) {
      open.add(fd);
      opened++;
    }
    return fd;
  };
  fs.readSync = function (fd, ...rest) {
    const n = readSync.call(fs, fd, ...rest);
    if (open.has(fd)) bytes += n;
    return n;
  };
  fs.closeSync = function (fd) {
    open.delete(fd);
    return closeSync.call(fs, fd);
  };
  let found;
  try {
    found = await find('*', [p.temp, p.recent]);
  } finally {
    Object.assign(fs, { openSync, readSync, closeSync });
  }
  assert.strictEqual(opened, 1, 'it was opened');
  assert.ok(bytes <= 32, `${bytes} bytes read`);
  assert.deepStrictEqual(found.perSource[0].notes, [
    '1 autosave(s) or backup(s) failed their check and were left out',
    '1 backup(s) in the HWP 3 format were left out: that format has nothing to check a copy against',
  ]);

  // The size limit is for what starts as a Hancom document; the rest is not one at any size.
  assert.strictEqual(readChecked(foreign, 1024).kind, null);
  assert.strictEqual(readChecked(p.files.reportBak, 1024).kind, 'big');
  assert.strictEqual(readChecked(p.files.reportBak).kind, 'hwp');
});
