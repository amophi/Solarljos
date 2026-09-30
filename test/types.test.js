'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { TYPES, EXTENSIONS, AMBIGUOUS, SNIFF_BYTES, parseTypes, extOf, typeOfName, typesOfName, typeOfExt, sniff } = require('../src/types');

// Every signature is built here from the formats' published layouts, a few bytes at a time; no
// real file is read.

const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pad = (buf, n) => Buffer.concat([buf, Buffer.alloc(Math.max(0, n - buf.length))]);
const is = (buf, mediaType, ext, message) => assert.deepStrictEqual(sniff(buf), { mediaType, ext }, message);

/** An ISO base media ftyp box with a major brand and compatible ones. */
const ftyp = (major, ...compatible) => {
  const body = bytes(major, [0, 0, 0, 0], ...compatible);
  return bytes(u32be(8 + body.length), 'ftyp', body, u32be(8), 'mdat');
};

/** A ZIP local file header and its data, stored as is. */
const zipEntry = (name, data = '', flags = 0) => bytes(
  'PK\x03\x04', u16le(20), u16le(flags), u16le(0), u16le(0), u16le(0), u32le(0),
  u32le(Buffer.byteLength(data)), u32le(Buffer.byteLength(data)), u16le(Buffer.byteLength(name)), u16le(0), name, data);

/** A TIFF with one IFD at 8 holding the given entries, each [tag, type, count, value or ASCII text]. */
function tiff(entries) {
  const ifd = 8;
  const dataAt = ifd + 2 + entries.length * 12 + 4;
  const extra = [];
  let at = dataAt;
  const rows = entries.map(([tag, type, text]) => {
    const row = Buffer.alloc(12);
    row.writeUInt16LE(tag, 0);
    row.writeUInt16LE(type, 2);
    const value = Buffer.from(text + '\0', 'latin1');
    row.writeUInt32LE(value.length, 4);
    if (value.length <= 4) value.copy(row, 8);
    else {
      row.writeUInt32LE(at, 8);
      extra.push(value);
      at += value.length;
    }
    return row;
  });
  return bytes('II*\0', u32le(ifd), u16le(entries.length), ...rows, u32le(0), ...extra);
}

test('the types, and the extensions of each, are fixed and do not overlap', () => {
  assert.deepStrictEqual(TYPES, ['image', 'video', 'audio', 'document', 'archive', 'text']);
  assert.strictEqual(SNIFF_BYTES, 4096);
  const seen = new Map();
  for (const type of TYPES) {
    for (const ext of EXTENSIONS[type]) {
      assert.match(ext, /^\.[a-z0-9]+$/, ext);
      assert.ok(!seen.has(ext), `${ext} is both ${seen.get(ext)} and ${type}`);
      seen.set(ext, type);
    }
  }
  for (const [ext, other] of Object.entries(AMBIGUOUS)) {
    assert.ok(seen.has(ext) && TYPES.includes(other) && seen.get(ext) !== other, ext);
  }
});

test('a name is typed by its extension, in any case, and a name with none has no type', () => {
  assert.strictEqual(typeOfName('C:\\DCIM\\IMG_0001.JPG'), 'image');
  assert.strictEqual(typeOfName('/home/u/clip.MOV'), 'video');
  // Two meanings: the usual one, and the other one the bytes may show.
  assert.strictEqual(typeOfName('src/app.ts'), 'text', 'TypeScript, not a transport stream');
  assert.deepStrictEqual(typesOfName('D:\\cam\\00001.MTS'), ['text', 'video'], 'an AVCHD clip, or a TypeScript module');
  assert.deepStrictEqual(typesOfName('go.mod'), ['text', 'video']);
  assert.deepStrictEqual(typesOfName('a.jpg'), ['image']);
  assert.deepStrictEqual(typesOfName('Makefile'), []);
  assert.strictEqual(typeOfName('보고서.hwp'), 'document');
  assert.strictEqual(typeOfName('backup.tar.gz'), 'archive');
  assert.strictEqual(typeOfName('/repo/.gitignore'), 'text');
  assert.strictEqual(typeOfName('Makefile'), null);
  assert.strictEqual(typeOfName('photo.jpg.bak'), null, 'the last extension counts');
  assert.strictEqual(typeOfName(null), null);
  assert.strictEqual(extOf('C:\\a\\B.JPEG'), '.jpeg');
  assert.strictEqual(extOf('a.'), '.');
  assert.strictEqual(typeOfExt('.PNG'), 'image');
  assert.strictEqual(typeOfExt(undefined), null);
});

test('types are read from a list or commas, any case, with a few other words for them', () => {
  assert.deepStrictEqual(parseTypes('image,video'), ['image', 'video']);
  assert.deepStrictEqual(parseTypes(['Photos', 'image', ' VIDEO ']), ['image', 'video']);
  assert.deepStrictEqual(parseTypes(['document,text', 'archive']), ['document', 'text', 'archive']);
  assert.strictEqual(parseTypes(undefined), null);
  assert.strictEqual(parseTypes(''), null);
  assert.strictEqual(parseTypes([]), null);
  assert.throws(() => parseTypes('image,bogus'), (e) => e.usage && /^Unknown type: bogus\. Known: image, video, audio, document, archive, text$/.test(e.message));
});

test('pictures, camera RAW files included', () => {
  is(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16], 'JFIF\0'), 'image', '.jpg');
  is(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), 'IHDR'), 'image', '.png');
  is(bytes('GIF89a', [1, 0, 1, 0]), 'image', '.gif');
  is(bytes('BM', u32le(1000), u32le(0), u32le(138), u32le(124), u32le(2), u32le(2)), 'image', '.bmp');
  is(bytes('RIFF', u32le(100), 'WEBPVP8 '), 'image', '.webp');
  is(ftyp('heic', 'mif1', 'heic'), 'image', '.heic');
  is(ftyp('mif1', 'mif1', 'heic'), 'image', '.heic', 'the brand of the picture, not of the container');
  is(ftyp('avif', 'mif1', 'miaf'), 'image', '.avif');
  is(ftyp('mif1', 'mif1', 'miaf'), 'image', '.heif');
  is(ftyp('crx ', 'crx ', 'isom'), 'image', '.cr3');
  is(tiff([[0x0100, 3, 'a']]), 'image', '.tif');
  is(tiff([[0x010f, 2, 'NIKON CORPORATION']]), 'image', '.nef');
  is(tiff([[0x010f, 2, 'SONY']]), 'image', '.arw');
  is(tiff([[0x010f, 2, 'Canon'], [0xc612, 1, 'x']]), 'image', '.dng');
  is(bytes('II*\0', u32le(16), 'CR', [2, 0]), 'image', '.cr2');
  is(bytes('IIRO', u32le(8)), 'image', '.orf');
  is(bytes('IIU\0', u32le(8)), 'image', '.rw2');
  is(bytes('FUJIFILMCCD-RAW 0201'), 'image', '.raf');
  is(bytes('8BPS', [0, 1]), 'image', '.psd');
  is(bytes([0, 0, 1, 0], u16le(1), [16, 16, 0, 0], u16le(1), u16le(32), u32le(100), u32le(22)), 'image', '.ico');
  is(Buffer.from('<?xml version="1.0"?>\n<!-- drawn -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image', '.svg');
  // As Illustrator writes one: an internal subset whose entities hold ">".
  is(Buffer.from('<?xml version="1.0" encoding="utf-8"?>\n<!-- Generator: Adobe Illustrator -->\n'
    + '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n'
    + '\t<!ENTITY ns_svg "http://www.w3.org/2000/svg">\n\t<!ENTITY ns_xlink "http://www.w3.org/1999/xlink">\n]>\n'
    + '<svg version="1.1" xmlns="&ns_svg;"></svg>'), 'image', '.svg');
  is(Buffer.from('<?xml version="1.0"?>\n<?xml-stylesheet href="a.css"?>\n<svg/>'), 'image', '.svg');
});

test('videos', () => {
  is(ftyp('isom', 'isom', 'iso2', 'avc1', 'mp41'), 'video', '.mp4');
  is(ftyp('mp42', 'mp42', 'isom'), 'video', '.mp4');
  is(ftyp('qt  ', 'qt  '), 'video', '.mov');
  is(ftyp('M4V ', 'M4V ', 'mp42'), 'video', '.m4v');
  is(ftyp('3gp4', '3gp4', 'isom'), 'video', '.3gp');
  is(ftyp('3g2a', '3g2a'), 'video', '.3g2');
  // QuickTime from before ftyp: a small box followed by another, or a moov that starts as one does.
  is(bytes(u32be(8), 'wide', u32be(1000), 'mdat', Buffer.alloc(8)), 'video', '.mov');
  is(bytes(u32be(500), 'moov', u32be(108), 'mvhd'), 'video', '.mov');
  is(bytes('RIFF', u32le(1000), 'AVI LIST'), 'video', '.avi');
  is(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0x82, 0x88], 'matroska'), 'video', '.mkv');
  is(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0x82, 0x84], 'webm'), 'video', '.webm');
  const asf = Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex');
  is(bytes(asf, Buffer.alloc(40), Buffer.from('c0ef19bc4d5bcf11a8fd00805f5c442b', 'hex')), 'video', '.wmv');
  is(bytes(asf, Buffer.alloc(40), Buffer.from('409e69f84d5bcf11a8fd00805f5c442b', 'hex')), 'audio', '.wma');
  is(bytes('FLV', [1, 5, 0, 0, 0, 9]), 'video', '.flv');
  is(bytes([0, 0, 1, 0xba, 0x44]), 'video', '.mpg');
  const ts = Buffer.alloc(188 * 5);
  for (let k = 0; k < 5; k++) ts[188 * k] = 0x47;
  is(ts, 'video', '.ts');
  const m2ts = Buffer.alloc(192 * 5);
  for (let k = 0; k < 5; k++) m2ts[4 + 192 * k] = 0x47;
  is(m2ts, 'video', '.mts');
  is(bytes('OggS', [0, 2], Buffer.alloc(22), [1, 30], '\x80theora'), 'video', '.ogv');
});

test('sound, MPEG frames with no header of their own included', () => {
  is(bytes('ID3', [3, 0, 0, 0, 0, 0, 0]), 'audio', '.mp3');
  // MPEG 1 layer III, 128 kbit/s at 44.1 kHz: frames of 144 * 128000 / 44100 = 417 bytes.
  const frame = pad(Buffer.from([0xff, 0xfb, 0x90, 0x00]), 417);
  is(Buffer.concat([frame, frame]), 'audio', '.mp3');
  assert.notStrictEqual(sniff(frame.subarray(0, 4)).ext, '.mp3', 'one header alone is not enough');
  // ADTS: a 7-byte header whose length field says 20.
  const adts = pad(Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x9f, 0xfc]), 20);
  is(Buffer.concat([adts, adts]), 'audio', '.aac');
  is(bytes('fLaC', [0, 0, 0, 34]), 'audio', '.flac');
  is(bytes('RIFF', u32le(100), 'WAVEfmt '), 'audio', '.wav');
  is(bytes('OggS', [0, 2], Buffer.alloc(22), [1, 19], 'OpusHead'), 'audio', '.opus');
  is(bytes('OggS', [0, 2], Buffer.alloc(22), [1, 30], '\x01vorbis'), 'audio', '.ogg');
  is(ftyp('M4A ', 'M4A ', 'mp42'), 'audio', '.m4a');
  is(bytes('FORM', u32be(100), 'AIFF'), 'audio', '.aiff');
  is(bytes('#!AMR\n'), 'audio', '.amr');
  is(bytes('MThd', u32be(6), [0, 1]), 'audio', '.mid');
});

test('documents: PDF, Office, OpenDocument, EPUB and Hancom, told apart by what their container holds', () => {
  is(Buffer.from('%PDF-1.7\n'), 'document', '.pdf');
  is(Buffer.from('{\\rtf1\\ansi'), 'document', '.rtf');
  is(Buffer.from('HWP Document File V3.00 \x1a\x01\x02\x03\x04\x05', 'latin1'), 'document', '.hwp');
  const cfb = (...names) => bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], Buffer.alloc(504),
    ...names.map((n) => pad(Buffer.from(n + '\0', 'utf16le'), 128)));
  is(cfb('Root Entry', 'FileHeader', 'DocInfo', 'BodyText'), 'document', '.hwp');
  is(cfb('Root Entry', 'WordDocument', '1Table'), 'document', '.doc');
  is(cfb('Root Entry', 'Workbook'), 'document', '.xls');
  is(cfb('Root Entry', 'PowerPoint Document'), 'document', '.ppt');
  is(cfb(), 'document', null);
  is(bytes(zipEntry('[Content_Types].xml', '<Types/>'), zipEntry('_rels/.rels', '<R/>'), zipEntry('word/document.xml', '<w/>')), 'document', '.docx');
  is(bytes(zipEntry('[Content_Types].xml', '<Types/>'), zipEntry('xl/workbook.xml', '<x/>')), 'document', '.xlsx');
  is(bytes(zipEntry('[Content_Types].xml', '<Types/>'), zipEntry('ppt/presentation.xml', '<p/>')), 'document', '.pptx');
  is(bytes(zipEntry('mimetype', 'application/vnd.oasis.opendocument.text'), zipEntry('content.xml', '<o/>')), 'document', '.odt');
  is(bytes(zipEntry('mimetype', 'application/epub+zip')), 'document', '.epub');
  is(bytes(zipEntry('mimetype', 'application/hwp+zip'), zipEntry('Contents/section0.xml', '<h/>')), 'document', '.hwpx');
  is(bytes(zipEntry('[Content_Types].xml', '', 8)), 'document', null, 'a size given after the data ends the look');
});

test('archives', () => {
  is(bytes(zipEntry('photos/a.jpg', 'x')), 'archive', '.zip');
  is(bytes(zipEntry('AndroidManifest.xml', 'x')), 'archive', '.apk');
  is(bytes('PK\x05\x06', Buffer.alloc(18)), 'archive', '.zip');
  is(bytes([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]), 'archive', '.7z');
  is(bytes('Rar!\x1a\x07\x01\x00'), 'archive', '.rar');
  is(bytes([0x1f, 0x8b, 0x08, 0]), 'archive', '.gz');
  is(bytes('BZh9', [0x31, 0x41, 0x59, 0x26, 0x53, 0x59]), 'archive', '.bz2');
  is(bytes([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), 'archive', '.xz');
  is(bytes([0x28, 0xb5, 0x2f, 0xfd]), 'archive', '.zst');
  const tar = Buffer.alloc(512);
  tar.write('a.txt', 0);
  tar.write('ustar\x0000', 257, 'latin1');
  is(tar, 'archive', '.tar');
});

test('text in any code page is text; a binary file is nothing known', () => {
  is(Buffer.from('hello\r\nworld\n'), 'text', '.txt');
  is(Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x20, 0xb9, 0xae, 0xbc, 0xad, 0x0a]), 'text', '.txt', 'Korean in CP949 is not UTF-8, and still text');
  is(Buffer.from('\uFEFFplain', 'utf8'), 'text', '.txt');
  is(Buffer.from('\uFEFFwide', 'utf16le'), 'text', '.txt', 'UTF-16 with a byte order mark, NUL bytes and all');
  is(Buffer.from('<!DOCTYPE html><html></html>'), 'text', '.html');
  is(Buffer.from('<?xml version="1.0"?><root/>'), 'text', '.xml');
  is(Buffer.from([1, 2, 3, 0, 5, 6, 7]), null, null);
  is(Buffer.alloc(0), null, null);
  is(null, null, null);
});

test('signatures of two or four bytes are not taken on their own', () => {
  // Each of these starts like a format and is only text.
  is(Buffer.from('BM is how it begins, then words'), 'text', '.txt');
  is(Buffer.from('GIFT card for you'), 'text', '.txt');
  is(Buffer.from('the free software, as ever'), 'text', '.txt', '"free" at offset 4, and a size made of letters');
  is(Buffer.from('xxxxmdat is not a box here'), 'text', '.txt');
  is(Buffer.from('Grand plan\n'.repeat(200)), 'text', '.txt', 'a "G" where transport stream packets would start');
  is(Buffer.from('MThd without the rest'), 'text', '.txt');
});

test('only the first 4 KB are looked at', () => {
  const late = Buffer.concat([Buffer.from('a'.repeat(SNIFF_BYTES)), Buffer.from([0])]);
  is(late, 'text', '.txt', 'a NUL after the first 4 KB is not seen');
  is(Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]), 'image', '.jpg', 'a Uint8Array works as a Buffer does');
});
