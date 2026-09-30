'use strict';

const { t } = require('./i18n');
const { baseName } = require('./paths');

// What kind of thing a copy is -- a picture, a video, a document -- for a search by type
// (--type image,video) and for a front end to know what it can show. Two ways to tell:
//
//   by name     the extension of the file name, from EXTENSIONS below. A copy with a name is
//               matched this way: "holiday.jpg" is a picture whatever its bytes are. Only an
//               extension of two meanings (AMBIGUOUS) is settled by the bytes.
//   by content  sniff(): the first SNIFF_BYTES bytes against the formats' own signatures. A copy
//               whose name was lost -- a thumbnail, a git object, a carved file -- is matched this
//               way, and gets the extension its format has, so it can be restored under one.
//
// A signature of two or three bytes, as BMP, MP3 frames and ICO have, is not taken on its own:
// the header fields after it must make sense too. Formats that share a container are told apart
// by what is inside it: an ISO base media file by its brands (HEIC, AVIF, MP4, QuickTime, 3GP,
// CR3), a RIFF file by its form (WebP, AVI, WAV), a ZIP by its first entries (DOCX, XLSX, PPTX,
// ODF, EPUB, HWPX), a TIFF by its first IFD (DNG, and the camera makers' RAW files), a compound
// file by the names in its directory (DOC, XLS, PPT, HWP). What cannot be told from 4 KB stays
// general: a compound file whose directory lies further in is a document with no extension, and
// an ISO image, whose mark lies at 32 KB, is nothing known. Text is anything else with no NUL
// byte and next to no control characters, so text in a Korean or Western code page counts, not
// only UTF-8.
//
// Measured on this machine, reading the first 4 KB of 60,000 files in the user's Pictures,
// Documents, Downloads, Desktop and Videos: sniff() agreed with the extension for all 1,001
// pictures and all 3 videos, 315 of 323 documents (the other 8 were Office's lock files, which
// hold a user name and no document), 190 of 195 archives (the other 5 ISO images) and 38,350 of
// 38,361 text files (the rest were binary logs and the like). None of the 19,496 files whose
// extension says nothing was taken for a picture, a video or sound; 12,972 of them were nothing
// known. The same look found every .mts and .mod file there to be TypeScript and Go, not a
// camcorder's clip. (A day earlier, with the folders' contents in another order, the counts were
// 1,524 pictures, 316 documents and 38,057 text files, with the same outcome.)

const TYPES = ['image', 'video', 'audio', 'document', 'archive', 'text'];

// How much of a copy sniff() looks at. Every signature below lies within it.
const SNIFF_BYTES = 4096;

const EXTENSIONS = {
  image: [
    '.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.apng', '.gif', '.bmp', '.dib', '.webp', '.heic', '.heif', '.hif',
    '.avif', '.tif', '.tiff', '.ico', '.psd', '.jp2', '.jxl', '.jxr', '.wdp', '.hdp', '.svg', '.emf', '.wmf',
    // Camera RAW files.
    '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.dng', '.orf', '.rw2', '.raf', '.pef',
    '.srw', '.x3f', '.3fr', '.erf', '.kdc', '.dcr', '.mos', '.mrw', '.raw', '.rwl', '.iiq',
  ],
  video: [
    '.mp4', '.m4v', '.mov', '.qt', '.3gp', '.3g2', '.avi', '.mkv', '.webm', '.wmv', '.asf', '.flv', '.f4v',
    '.mpg', '.mpeg', '.mpe', '.m2v', '.vob', '.m2ts', '.ogv', '.divx', '.rm', '.rmvb', '.dv', '.tod', '.insv',
    '.lrv',
  ],
  audio: [
    '.mp3', '.wav', '.flac', '.m4a', '.m4b', '.aac', '.ogg', '.oga', '.opus', '.wma', '.aif', '.aiff', '.aifc',
    '.amr', '.mid', '.midi', '.ape', '.wv', '.ac3', '.mka', '.caf', '.3ga', '.m4r',
  ],
  document: [
    '.pdf', '.doc', '.docx', '.docm', '.dot', '.dotx', '.xls', '.xlsx', '.xlsm', '.xlsb', '.xlt', '.xltx', '.ppt',
    '.pptx', '.pptm', '.pps', '.ppsx', '.pot', '.potx', '.odt', '.ods', '.odp', '.odg', '.rtf', '.hwp', '.hwpx',
    '.hwt', '.cell', '.nxl', '.show', '.epub', '.xps', '.oxps', '.djvu', '.ps', '.eps', '.pages', '.numbers',
    '.vsd', '.vsdx', '.pub', '.one', '.msg', '.eml',
  ],
  archive: [
    '.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.bz2', '.tbz2', '.xz', '.txz', '.zst', '.lz', '.lzma', '.z',
    '.cab', '.iso', '.lzh', '.lha', '.arj', '.alz', '.egg', '.jar', '.apk',
  ],
  text: [
    '.txt', '.text', '.md', '.markdown', '.rst', '.adoc', '.org', '.tex', '.bib', '.csv', '.tsv', '.log',
    '.json', '.jsonc', '.json5', '.ndjson', '.xml', '.xsd', '.xsl', '.yaml', '.yml', '.toml', '.ini', '.cfg',
    '.conf', '.properties', '.env', '.html', '.htm', '.xhtml', '.css', '.scss', '.sass', '.less', '.js', '.mjs',
    '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.vue', '.svelte', '.py', '.pyw', '.ipynb', '.java', '.kt',
    '.kts', '.gradle', '.groovy', '.scala', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.cs', '.fs',
    '.vb', '.go', '.mod', '.rs', '.rb', '.php', '.pl', '.pm', '.lua', '.r', '.swift', '.m', '.mm', '.dart',
    '.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.ps1', '.psm1', '.sql', '.srt', '.vtt', '.ass', '.smi',
    '.key', '.pem', '.gitignore', '.gitattributes', '.editorconfig', '.dockerfile', '.tf', '.hcl', '.proto',
    '.graphql',
  ],
};

const BY_EXT = new Map();
for (const type of TYPES) for (const ext of EXTENSIONS[type]) BY_EXT.set(ext, type);

// Extensions that stand for two things: .ts and .mts are TypeScript and also MPEG transport
// streams, .mts above all an AVCHD camcorder's clips; .mod is a Go module file and a JVC
// camcorder's clip; .key a PEM key and a Keynote document. The type in EXTENSIONS is the usual
// one here (see above), and a copy whose first bytes can be read cheaply is told by them.
const AMBIGUOUS = { '.ts': 'video', '.mts': 'video', '.mod': 'video', '.key': 'document' };

// Other words a person may use for a type, on the command line or from a front end.
const ALIASES = {
  images: 'image', photo: 'image', photos: 'image', picture: 'image', pictures: 'image',
  videos: 'video', movie: 'video', movies: 'video',
  music: 'audio', sound: 'audio',
  documents: 'document', docs: 'document', doc: 'document',
  archives: 'archive',
  texts: 'text',
};

function usageError(message) {
  const e = new Error(message);
  e.usage = true;
  return e;
}

/**
 * The types asked for, as TYPES names, each once; null when none were. Accepts a list or a
 * comma-separated string, any case. A word that is not a type is refused rather than ignored,
 * since it would otherwise make the search find nothing and say nothing.
 */
function parseTypes(input) {
  if (input == null) return null;
  const words = [].concat(input).flatMap((s) => String(s).split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!words.length) return null;
  const out = [];
  for (const w of words) {
    const type = TYPES.includes(w) ? w : ALIASES[w];
    if (!type) throw usageError(t('Unknown type: {0}. Known: {1}', w, TYPES.join(', ')));
    if (!out.includes(type)) out.push(type);
  }
  return out;
}

/** A name's extension, dot included and in lower case; '' when it has none. */
function extOf(name) {
  const base = baseName(String(name || ''));
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : base.startsWith('.') && base.length > 1 ? base.toLowerCase() : '';
}

/** The type an extension stands for, or null. */
function typeOfExt(ext) {
  return BY_EXT.get(String(ext || '').toLowerCase()) || null;
}

/** The type a file name or path usually stands for, by its extension, or null. */
function typeOfName(name) {
  return typeOfExt(extOf(name));
}

/** Every type a name may stand for: the usual one, and for an extension of two meanings the other. */
function typesOfName(name) {
  const ext = extOf(name);
  const usual = typeOfExt(ext);
  if (!usual) return [];
  return AMBIGUOUS[ext] ? [usual, AMBIGUOUS[ext]] : [usual];
}

const NONE = Object.freeze({ mediaType: null, ext: null });
const found = (mediaType, ext) => ({ mediaType, ext });

// BITMAPINFOHEADER and its relatives, by size: core, info, the two Adobe ones, OS/2 2, V4, V5.
const DIB_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

// Brands of the ISO base media format (MP4, QuickTime, HEIF and the rest), from the ftyp box.
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'];

// Boxes a QuickTime movie made before ftyp existed can start with.
const QT_FIRST = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

// The camera makers whose RAW files are TIFF inside, by the Make tag of the first IFD. DNG says
// so with a tag of its own, and Canon's CR2 with "CR" after the TIFF header.
const RAW_MAKES = [
  [/^nikon/i, '.nef'], [/^sony/i, '.arw'], [/^(pentax|ricoh)/i, '.pef'], [/^samsung/i, '.srw'],
  [/^hasselblad/i, '.3fr'], [/^kodak/i, '.dcr'], [/^(seiko )?epson/i, '.erf'], [/^leaf/i, '.mos'],
  [/^phase one/i, '.iiq'], [/^minolta|^konica/i, '.mrw'],
];

// MPEG audio: bit rates in kbit/s by version and layer, and sample rates by version.
const MPEG_RATES = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
MPEG_RATES['2-3'] = MPEG_RATES['2-2'];
const MPEG_SAMPLES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

/** The length of the MPEG audio frame at `i`, or 0 when no valid frame header is there. */
function mpegFrame(b, i) {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return 0;
  const v = (b[i + 1] >> 3) & 3; // 3: MPEG 1, 2: MPEG 2, 0: MPEG 2.5
  const layer = 4 - ((b[i + 1] >> 1) & 3); // 1, 2 or 3; 4 is reserved
  const rate = (b[i + 2] >> 4) & 15;
  const sampleIndex = (b[i + 2] >> 2) & 3;
  if (v === 1 || layer === 4 || rate === 0 || rate === 15 || sampleIndex === 3) return 0;
  const version = v === 3 ? 1 : v === 2 ? 2 : 25;
  const kbps = MPEG_RATES[`${version === 1 ? 1 : 2}-${layer}`][rate];
  const hz = MPEG_SAMPLES[version][sampleIndex];
  const pad = (b[i + 2] >> 1) & 1;
  if (layer === 1) return Math.floor((12 * kbps * 1000) / hz + pad) * 4;
  const per = layer === 3 && version !== 1 ? 72 : 144;
  return Math.floor((per * kbps * 1000) / hz) + pad;
}

/** An ADTS (AAC) frame's length at `i`, or 0. */
function adtsFrame(b, i) {
  if (i + 7 > b.length || b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) return 0;
  if (((b[i + 2] >> 2) & 15) > 12) return 0; // sampling frequency index
  const len = ((b[i + 3] & 3) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
  return len >= 7 ? len : 0;
}

/** Two MPEG audio or AAC frames in a row: one header alone is only eleven bits of evidence. */
function audioFrames(b) {
  const mp3 = mpegFrame(b, 0);
  if (mp3 && mpegFrame(b, mp3)) return found('audio', '.mp3');
  const aac = adtsFrame(b, 0);
  if (aac && adtsFrame(b, aac)) return found('audio', '.aac');
  return null;
}

/** An ISO base media file by its brands: the major one, then the compatible ones. */
function isoMedia(b) {
  const size = b.readUInt32BE(0);
  const major = b.toString('latin1', 8, 12);
  const brands = [major];
  for (let i = 16; i + 4 <= Math.min(size, b.length); i += 4) brands.push(b.toString('latin1', i, i + 4));
  const has = (list) => brands.some((x) => list.includes(x));
  if (major === 'crx ') return found('image', '.cr3');
  if (has(['avif', 'avis'])) return found('image', '.avif');
  if (has(HEIC_BRANDS)) return found('image', '.heic');
  if (has(['mif1', 'msf1'])) return found('image', '.heif');
  if (major === 'qt  ') return found('video', '.mov');
  if (major.startsWith('3g2')) return found('video', '.3g2');
  if (/^3g[pegs]/.test(major)) return found('video', '.3gp');
  if (major === 'M4A ' || major === 'M4B ' || major === 'M4P ') return found('audio', major === 'M4B ' ? '.m4b' : '.m4a');
  if (major.startsWith('M4V')) return found('video', '.m4v');
  if (major === 'f4v ') return found('video', '.f4v');
  if (major === 'jp2 ' || major === 'jpx ') return found('image', '.jp2');
  return found('video', '.mp4');
}

/**
 * A QuickTime movie made before ftyp existed. Four letters and a size are easily met by chance --
 * text reading "the free ..." has both -- so more is asked: a moov box must start with one of the
 * boxes a moov holds, a small first box must be followed by another, and an mdat's size must not
 * be four printable characters.
 */
function oldQuickTime(b) {
  if (b.length < 16) return false;
  const type = b.toString('latin1', 4, 8);
  if (!QT_FIRST.has(type)) return false;
  const size = b.readUInt32BE(0);
  if (type === 'moov') return size >= 16 && ['mvhd', 'cmov', 'prfl', 'udta', 'trak', 'iods'].includes(b.toString('latin1', 12, 16));
  if (type === 'mdat') return size <= 1 || (size >= 8 && ![0, 1, 2, 3].every((i) => b[i] >= 0x20 && b[i] <= 0x7e));
  return size >= 8 && size + 8 <= b.length && QT_FIRST.has(b.toString('latin1', size + 4, size + 8));
}

/** A TIFF, or a camera's RAW file built on one. */
function tiff(b, str) {
  if (str(8, 'CR') && b[10] === 2) return found('image', '.cr2');
  const le = b[0] === 0x49;
  const u16 = (i) => (le ? b.readUInt16LE(i) : b.readUInt16BE(i));
  const u32 = (i) => (le ? b.readUInt32LE(i) : b.readUInt32BE(i));
  const ifd = b.length >= 8 ? u32(4) : 0;
  if (ifd >= 8 && ifd + 2 <= b.length) {
    const n = u16(ifd);
    for (let k = 0; k < n && ifd + 14 + 12 * k <= b.length; k++) {
      const e = ifd + 2 + 12 * k;
      const tag = u16(e);
      if (tag === 0xc612) return found('image', '.dng');
      if (tag === 0x010f && u16(e + 2) === 2) {
        const count = u32(e + 4);
        const at = count <= 4 ? e + 8 : u32(e + 8);
        if (at + count <= b.length) {
          const make = b.toString('latin1', at, at + count).replace(/\0.*$/s, '').trim();
          const hit = RAW_MAKES.find(([re]) => re.test(make));
          if (hit) return found('image', hit[1]);
        }
      }
    }
  }
  return found('image', '.tif');
}

/** An OLE compound file -- Word, Excel and PowerPoint before 2007, HWP 5 -- by the stream names in reach. */
function compound(b) {
  const has = (name) => b.includes(Buffer.from(name + '\0', 'utf16le'));
  if (has('FileHeader') && (has('BodyText') || has('DocInfo'))) return found('document', '.hwp');
  if (has('WordDocument')) return found('document', '.doc');
  if (has('Workbook') || has('Book')) return found('document', '.xls');
  if (has('PowerPoint Document')) return found('document', '.ppt');
  if (has('VisioDocument')) return found('document', '.vsd');
  if (b.includes(Buffer.from('__substg1.0_', 'utf16le'))) return found('document', '.msg');
  return found('document', null);
}

// ODF and its relatives name themselves in a first, uncompressed entry called "mimetype".
const ZIP_MIME = {
  'application/vnd.oasis.opendocument.text': ['document', '.odt'],
  'application/vnd.oasis.opendocument.spreadsheet': ['document', '.ods'],
  'application/vnd.oasis.opendocument.presentation': ['document', '.odp'],
  'application/vnd.oasis.opendocument.graphics': ['document', '.odg'],
  'application/epub+zip': ['document', '.epub'],
  'application/hwp+zip': ['document', '.hwpx'],
};

/** A ZIP by its first entries: an Office Open XML, ODF, EPUB or HWPX document, a Java or Android package, or a plain ZIP. */
function zip(b) {
  const names = [];
  let mime = null;
  for (let i = 0; i + 30 <= b.length && names.length < 32 && b.readUInt32LE(i) === 0x04034b50;) {
    const flags = b.readUInt16LE(i + 6);
    const method = b.readUInt16LE(i + 8);
    const csize = b.readUInt32LE(i + 18);
    const nlen = b.readUInt16LE(i + 26);
    const xlen = b.readUInt16LE(i + 28);
    const name = b.toString('utf8', i + 30, Math.min(b.length, i + 30 + nlen));
    const data = i + 30 + nlen + xlen;
    if (!names.length && name === 'mimetype' && method === 0 && data + csize <= b.length) {
      mime = b.toString('latin1', data, data + csize).trim();
    }
    names.push(name);
    // With bit 3 set the size comes after the data, so where the next entry starts is not known.
    if (flags & 8) break;
    i = data + csize;
  }
  if (mime && ZIP_MIME[mime]) return found(...ZIP_MIME[mime]);
  if (mime && mime.startsWith('application/vnd.oasis.opendocument.')) return found('document', null);
  const any = (re) => names.some((n) => re.test(n));
  if (any(/^word\//)) return found('document', '.docx');
  if (any(/^xl\//)) return found('document', '.xlsx');
  if (any(/^ppt\//)) return found('document', '.pptx');
  if (any(/^visio\//)) return found('document', '.vsdx');
  if (any(/^Contents\/section\d+\.xml$/)) return found('document', '.hwpx');
  if (any(/^\[Content_Types\]\.xml$/)) return found('document', null);
  if (any(/^AndroidManifest\.xml$|^classes\d*\.dex$/)) return found('archive', '.apk');
  if (any(/^META-INF\/MANIFEST\.MF$/)) return found('archive', '.jar');
  return found('archive', '.zip');
}

/** Text: no NUL byte, and control characters other than tab, line and page breaks and escape in at most 1 byte of 100. */
function text(b) {
  if (!b.length) return NONE;
  const bom = (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) || (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff);
  if (!bom) {
    let control = 0;
    for (const x of b) {
      if (x === 0) return NONE;
      if (x < 0x20 && x !== 9 && x !== 10 && x !== 11 && x !== 12 && x !== 13 && x !== 27) control++;
    }
    if (control * 100 > b.length) return NONE;
  }
  const head = (bom && b[0] !== 0xef ? '' : b.toString('utf8')).replace(/^\uFEFF/, '').trimStart().toLowerCase();
  // What may come before a root element: processing instructions, comments, and a doctype, which
  // Illustrator writes with an internal subset full of ">".
  const prolog = '(?:<\\?[\\s\\S]*?\\?>\\s*|<!--[\\s\\S]*?-->\\s*|<!doctype\\s[^[>]*(?:\\[[\\s\\S]*?\\])?\\s*>\\s*)*';
  if (new RegExp(`^${prolog}<svg[\\s/>]`).test(head)) return found('image', '.svg');
  if (new RegExp(`^${prolog}<html[\\s/>]`).test(head) || /^<!doctype html/.test(head)) return found('text', '.html');
  if (head.startsWith('<?xml')) return found('text', '.xml');
  if (head.startsWith('%!ps')) return found('document', '.ps');
  return found('text', '.txt');
}

/**
 * What a copy's first bytes say it is: { mediaType, ext }, one of TYPES and the extension its
 * format has, or nulls when they say nothing known. Only the first SNIFF_BYTES are looked at.
 * @param {Buffer|Uint8Array} input
 */
function sniff(input) {
  if (!input || !input.length) return NONE;
  const all = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const b = all.subarray(0, SNIFF_BYTES);
  const at = (i, ...bytes) => i + bytes.length <= b.length && bytes.every((x, k) => b[i + k] === x);
  const str = (i, s) => i + s.length <= b.length && b.toString('latin1', i, i + s.length) === s;

  // Pictures.
  if (at(0, 0xff, 0xd8, 0xff)) return found('image', '.jpg');
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return found('image', '.png');
  if (str(0, 'GIF87a') || str(0, 'GIF89a')) return found('image', '.gif');
  if (str(0, 'BM') && b.length >= 18 && b.readUInt32LE(6) === 0 && DIB_SIZES.has(b.readUInt32LE(14))) return found('image', '.bmp');
  if (str(0, 'RIFF') && b.length >= 12) {
    const form = b.toString('latin1', 8, 12);
    if (form === 'WEBP') return found('image', '.webp');
    if (form === 'AVI ') return found('video', '.avi');
    if (form === 'WAVE') return found('audio', '.wav');
    if (form === 'RMID') return found('audio', '.mid');
  }
  if (str(4, 'ftyp') && b.length >= 12) return isoMedia(b);
  if (str(0, 'II*\0') || str(0, 'MM\0*')) return tiff(b, str);
  if (str(0, 'IIRO') || str(0, 'IIRS') || str(0, 'MMOR')) return found('image', '.orf');
  if (str(0, 'IIU\0')) return found('image', '.rw2');
  if (str(0, 'II\x1a\0') && str(6, 'HEAPCCDR')) return found('image', '.crw');
  if (str(0, 'FUJIFILMCCD-RAW')) return found('image', '.raf');
  if (str(0, 'FOVb')) return found('image', '.x3f');
  if (str(0, '8BPS') && (at(4, 0, 1) || at(4, 0, 2))) return found('image', '.psd');
  if (at(0, 0, 0, 0, 0x0c) && str(4, 'jP  ')) return found('image', '.jp2');
  if (at(0, 0xff, 0x0a) || (at(0, 0, 0, 0, 0x0c) && str(4, 'JXL '))) return found('image', '.jxl');
  if (at(0, 0, 0, 1, 0) && b.length >= 22 && b.readUInt16LE(4) > 0 && b[9] === 0 && b.readUInt16LE(10) <= 1) {
    return found('image', '.ico');
  }

  // Video.
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) {
    return b.subarray(0, 64).includes('webm') ? found('video', '.webm') : found('video', '.mkv');
  }
  if (at(0, 0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11)) {
    // The stream types: Video Media and Audio Media, as GUIDs are stored.
    if (b.includes(Buffer.from('c0ef19bc4d5bcf11a8fd00805f5c442b', 'hex'))) return found('video', '.wmv');
    if (b.includes(Buffer.from('409e69f84d5bcf11a8fd00805f5c442b', 'hex'))) return found('audio', '.wma');
    return found('video', '.wmv');
  }
  if (str(0, 'FLV') && b[3] === 1) return found('video', '.flv');
  if (at(0, 0, 0, 1, 0xba) || at(0, 0, 0, 1, 0xb3)) return found('video', '.mpg');
  // A transport stream: 188-byte packets, or 192 with a time code in front (AVCHD), each starting
  // with the byte 0x47. That is a "G" too, so five packets in a row are asked for.
  if ([0, 1, 2, 3, 4].every((k) => b[188 * k] === 0x47)) return found('video', '.ts');
  if ([0, 1, 2, 3, 4].every((k) => b[4 + 192 * k] === 0x47)) return found('video', '.mts');
  if (oldQuickTime(b)) return found('video', '.mov');

  // Sound.
  if (str(0, 'ID3') && b[3] >= 2 && b[3] <= 4) return found('audio', '.mp3');
  if (str(0, 'fLaC')) return found('audio', '.flac');
  if (str(0, 'OggS')) {
    const page = b.subarray(0, 512);
    if (page.includes('\x80theora', 0, 'latin1')) return found('video', '.ogv');
    if (page.includes('OpusHead')) return found('audio', '.opus');
    return found('audio', '.ogg');
  }
  if (str(0, 'FORM') && (str(8, 'AIFF') || str(8, 'AIFC'))) return found('audio', '.aiff');
  if (str(0, '#!AMR')) return found('audio', '.amr');
  if (str(0, 'MThd') && at(4, 0, 0, 0, 6)) return found('audio', '.mid');
  if (str(0, 'caff')) return found('audio', '.caf');
  if (str(0, 'MAC ')) return found('audio', '.ape');
  if (str(0, 'wvpk')) return found('audio', '.wv');

  // Documents.
  if (str(0, '%PDF-')) return found('document', '.pdf');
  if (str(0, '{\\rtf')) return found('document', '.rtf');
  if (str(0, 'HWP Document File')) return found('document', '.hwp');
  if (at(0, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return compound(b);
  if (str(0, 'PK\x03\x04')) return zip(b);
  if (str(0, 'PK\x05\x06')) return found('archive', '.zip');
  if (str(0, 'AT&TFORM') && (str(12, 'DJVU') || str(12, 'DJVM'))) return found('document', '.djvu');

  // Archives.
  if (at(0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return found('archive', '.7z');
  if (str(0, 'Rar!\x1a\x07')) return found('archive', '.rar');
  if (at(0, 0x1f, 0x8b, 0x08)) return found('archive', '.gz');
  if (str(0, 'BZh') && b[3] >= 0x31 && b[3] <= 0x39 && at(4, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59)) return found('archive', '.bz2');
  if (at(0, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return found('archive', '.xz');
  if (at(0, 0x28, 0xb5, 0x2f, 0xfd)) return found('archive', '.zst');
  if (str(0, 'MSCF') && at(4, 0, 0, 0, 0)) return found('archive', '.cab');
  if (str(0, 'ALZ\x01')) return found('archive', '.alz');
  if (str(0, 'EGGA')) return found('archive', '.egg');
  if (str(257, 'ustar')) return found('archive', '.tar');

  // Frames of MPEG audio have no file header at all, and text has none either.
  return audioFrames(b) || text(b);
}

module.exports = { TYPES, EXTENSIONS, AMBIGUOUS, SNIFF_BYTES, parseTypes, extOf, typeOfExt, typeOfName, typesOfName, sniff };
