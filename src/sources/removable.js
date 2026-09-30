'use strict';

const fs = require('fs');
const path = require('path');
const { t } = require('../i18n');
const fat = require('../lib/fat');
const carve = require('../lib/carve');
const { HASH_LIMIT, HEAD_CHECK, blobHash, headHash } = require('../content');
const { isElevated } = require('../locations');
const { typesOfName } = require('../types');

// Memory cards, USB sticks and disk images with FAT or exFAT, which Windows sends no TRIM to: what
// was deleted there stays until something is written over it. Only places named with
// --location removable=<place> are read, never any found on their own:
//
//   E:, E:\, \\.\E:          a drive, read as the device \\.\E: -- on Windows, and only when this
//                            process runs as administrator; otherwise nothing is opened, and a note
//                            says to run it so, or to make an image of the drive with another tool
//   \\.\PhysicalDrive1       a whole disk, the same way
//   /dev/sdb, /dev/mmcblk0p1 a device elsewhere, which needs root or the disk group
//   anything else            a disk image: a raw copy of a card or a stick (.img, .dd, .raw, .bin),
//                            with a partition table (MBR, GPT) or without one; needs no rights
//
// Everything is opened for reading only, and lib/fat.js reads each table into memory. What is found:
//
//   'fat undelete', 'exfat undelete'   a deleted entry still in its folder, with its name, size and
//            times, read from where lib/fat.js says it lay and checked by lib/carve.js's validators.
//            The flags are carve.judge()'s: a stream whose checksums cover every byte (PNG, ZIP) and
//            that ends exactly at the recorded size is the file (tier 0); content that checks out,
//            or that nothing here can check, is inexact (tier 1) when every piece of the file is
//            known -- an exFAT file with no FAT chain, a FAT file of one cluster, a chain another
//            system left behind -- and unverified (tier 3) when its clusters after the first are only
//            taken to follow on, as those of a FAT file of more than one cluster are.
//              - A FAT32 file deleted by Windows lost the high half of its first cluster. Every start
//                it may have had is read, and one is offered only when its content checks out
//                whole; more than one that does are all offered, unverified.
//              - A file some of whose clusters are in use now is offered only when the clusters
//                that are still free, from its first on, hold content that checks out: unverified.
//              - One whose bytes are not of the format its name says -- a .jpg that is no JPEG at
//                all, or a PNG now, a .txt that holds a photo, a .mov whose first cluster a later
//                picture took -- was written over since, and is left out, and its clusters carved:
//                what took them may have no entry left. The exception is bytes of another format
//                that is whole, checksums over every byte, and exactly the size recorded: a PNG
//                saved as .jpg, not a later file that happened to land just there at just that
//                size. It is offered, as the format it is, with a note.
//              - A PNG, GIF or ZIP whose structure ends before the size recorded, where those
//                formats have nothing after their end, may be a later, shorter file written over
//                the start of this one: unverified, whatever the extent.
//              - Files in pieces, moved, damaged or empty are left out too. Each left out is
//                counted in a note.
//   'carved'    a file found in free space by its format alone, with no entry left to name it:
//            always unverified, since nothing records where it ended. Only a search for types of
//            file with no name to go on carves (a search for "IMG_0001" wants no list of every
//            photo the card ever held): the free clusters of each FAT or exFAT volume that no
//            deleted file offered above lies in, probed at each cluster -- the clusters of a
//            deleted entry the search did not look at, a .mov in a search for pictures, are carved
//            too, since a later picture may lie there with no entry of its own -- and a volume
//            with no file system known here -- one whose boot sector is gone -- whole, at every
//            512 bytes. At most MAX_CARVED files are listed. NTFS is not read. A device that says
//            nothing of its size, as a wiped one does not, is read up to where reading it stops.
//
// A copy's bytes are an extent in the place (content.js), so a video of any size is streamed out.
// One of 32 MB or less is read whole while it is checked, and its hash taken then, so that the
// search does not read it from the card a second time; a deleted file carved again is then dropped
// as the same bytes. A larger one keeps the hash of its first 4 KiB (the extent's `head`). Restore
// checks what it writes against these (restore.js): a card written to since the search, or
// swapped for another, fails the restore rather than giving other bytes under the file's name.
//
// Paths are the drive's own for a drive (E:\DCIM\100CANON\IMG_0001.JPG), and start with the
// image's name in brackets for an image ([card.img]\DCIM\...), with the volume's number when it
// holds more than one. A FAT short name whose first character was lost when it was deleted, as the
// 8.3 names cameras write are, has "_" in its place, and a name searched for matches whatever that
// character was. Short names beyond ASCII are read in this machine's OEM code page.
//
// roots() and volumes() keep restore and rebuild from writing onto the drive being recovered, however
// it was given and however the destination is spelled. A drive letter is kept out by its root, E:\,
// and by its volume; an image by its path. A card given as a whole disk (\\.\PhysicalDrive1) or a
// volume (\\?\Volume{...}\) names no folder: it is kept out by the serial number of each FAT or
// exFAT volume on it, from its boot sector (FAT32 at 0x43, FAT12/16 at 0x27, exFAT at 0x64), which
// is what stat() gives as dev for a file on it on Windows -- read when the search opened it, or
// else when restore asks, which then needs the same rights. A Linux device is kept out by the
// folders it is mounted at, found by what the name given really is (a /dev/disk/by-label link is
// the /dev/sdb1 it points to), and by its device number. Nothing more can be done from here to keep
// a card as it is: Windows and other programs write to a card while it is in, and a note says so,
// with what to do about it.
//
// Not measured on a real card: the machine this was written on has none, only an SSD. What was
// measured on public test images is in lib/fat.js and lib/carve.js; the tests build their own. On a
// 64 MiB FAT32 image built the tests' way, holding 300 pictures of which 150 were deleted, a search
// for pictures took 0.23 s, the command's start included, and carved 58 MiB of free space; a card
// takes as long as reading it does, 20 to 90 MB/s through a USB reader.

// How many files carving may list in one search, over every place given.
const MAX_CARVED = 10000;
// A block of a device, which reads only in whole ones.
const BLOCK = 4096;

// Formats lib/carve.js knows by their first bytes, by the extensions that name them, as the
// formats its hits say they are (hit.type): a deleted file named as one whose bytes are none of
// these holds something else now. Kin are one: a camera's RAW is a TIFF inside, and HEIC, CR3 and
// the movie formats are all ISO BMFF, told apart by brands a camera does not always set as the
// extension would have it.
const BMFF = ['heif', 'avif', 'cr3', 'mp4', 'mov', 'm4v', '3gp', 'm4a'];
const FAMILY = new Map([
  ...['.jpg', '.jpeg', '.jpe'].map((e) => [e, ['jpeg']]),
  ['.png', ['png']], ['.gif', ['gif']], ['.bmp', ['bmp']], ['.webp', ['webp']], ['.avi', ['avi']], ['.wav', ['wav']],
  ...['.tif', '.tiff', '.cr2', '.nef', '.arw', '.dng', '.orf', '.rw2', '.pef'].map((e) => [e, ['tiff']]),
  ...['.heic', '.heif', '.avif', '.cr3', '.mp4', '.mov', '.m4v', '.3gp', '.m4a'].map((e) => [e, BMFF]),
  ...['.wmv', '.wma', '.asf'].map((e) => [e, ['wmv', 'wma']]),
  ['.pdf', ['pdf']],
  ...['.zip', '.docx', '.xlsx', '.pptx'].map((e) => [e, ['zip']]),
]);
const CHECKED_EXT = new Set(FAMILY.keys());

// Formats that end where their structure does, with nothing after as a rule: one that ends before
// the size recorded may be a shorter file written over the start of a longer one. Not JPEG, after
// whose end phones and cameras append their own data.
const ENDS_EXACTLY = new Set(['png', 'gif', 'zip']);

// The types carving can find. A search for none of them has nothing to carve for.
const CARVED_TYPES = new Set(Object.values(carve.FORMATS).map((f) => f.mediaType));

// The characters a FAT short name's lost first character may have been.
const FIRST_CHARS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$~!#%&-{}()@\'`^'];

// Stand-ins for tests: whether this process may read devices, and the system it runs on.
const env = { elevated: () => isElevated(), platform: () => process.platform };

/** A size as people read it. */
const bytes = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GiB`
  : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : `${Math.ceil(n / 1024)} KiB`);

const extOf = (name) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
};

/**
 * One place as given: a drive, a device or an image. `open` is what is opened -- \\.\E: for a
 * drive -- `root` what restore must not write into, `label` how notes name it, and `name` what the
 * paths found on a device or an image start with, in brackets.
 */
function placeOf(given) {
  const s = String(given);
  const drive = /^(?:\\\\[.?]\\)?([a-zA-Z]):[\\/]?$/.exec(s);
  if (drive) {
    const letter = drive[1].toUpperCase();
    return {
      given: s, kind: 'drive', open: `\\\\.\\${letter}:`, root: `${letter}:\\`, label: t('drive {0}', letter), name: `${letter}:`,
    };
  }
  if (/^\\\\[.?]\\/.test(s)) {
    return { given: s, kind: 'device', open: s, root: null, label: s, name: s.slice(4).replace(/[\\/]+$/, '') };
  }
  if (/^\/dev\//.test(s)) return { given: s, kind: 'device', open: s, root: null, label: s, name: path.posix.basename(s) };
  const file = path.resolve(s);
  return { given: s, kind: 'image', open: file, root: file, label: `[${path.basename(file)}]`, name: path.basename(file) };
}

const places = (loc) => [].concat(loc.removable || []).filter((p) => typeof p === 'string' && p.trim()).map(placeOf);

/** What the paths on one volume start with; on a disk of several, the volume by its partition's number. */
function prefixOf(p, part, count) {
  if (p.kind === 'drive') return p.root;
  return `[${p.name}${count > 1 ? ', ' + t('volume {0}', part.index || 1) : ''}]\\`;
}

/**
 * The code page FAT short names beyond ASCII are read in: this machine's, by its language, since a
 * card is most often written by the machine it is read on or by a camera, whose names are ASCII.
 * CP437 when it is not one of these, or when this Node cannot decode it.
 */
function oemLabel() {
  let locale = '';
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
  } catch (_) {
    return null;
  }
  const label = /^ko/.test(locale) ? 'euc-kr'
    : /^ja/.test(locale) ? 'shift_jis'
      : /^zh-(hant|tw|hk|mo)/.test(locale) ? 'big5'
        : /^zh/.test(locale) ? 'gbk'
          : null;
  if (!label) return null;
  try {
    new TextDecoder(label); // eslint-disable-line no-new
    return label;
  } catch (_) {
    return null;
  }
}

/** Why a place cannot be opened, as a note, or null when it may be. */
function refusal(p) {
  if (p.kind === 'image') return null;
  const windows = env.platform() === 'win32';
  if (p.kind === 'drive' && !windows) {
    return t('{0}: a drive letter can be read only on Windows; give the device, such as /dev/sdb1, or an image of it.',
      p.given);
  }
  if (windows && !env.elevated()) return adminNote(p);
  return null;
}

function adminNote(p) {
  return env.platform() === 'win32'
    ? t('Reading {0} directly needs administrator rights. Run as administrator, or make a disk image with '
      + 'another tool and give its path.', p.label)
    : t('Reading {0} directly needs root. Run as root, or make a disk image with another tool and give its path.',
      p.label);
}

/** What to say when a place cannot be opened. */
function openFailed(p, e) {
  if (p.kind !== 'image' && (e.code === 'EPERM' || e.code === 'EACCES')) return adminNote(p);
  if (e.code === 'ENOENT') return t('{0}: no such drive or file', p.given);
  let folder = e.code === 'EISDIR';
  try {
    folder = folder || (p.kind === 'image' && fs.statSync(p.open).isDirectory());
  } catch (_) {
    /* said below, as it failed */
  }
  if (folder) return t('{0} is a folder: give a drive letter such as E:, or a disk image file.', p.given);
  return t('Could not open {0} ({1})', p.given, e.code || e.message);
}

/** The note every drive and device gets, since nothing here can stop other programs writing to it. */
function lockNote(p) {
  return t('{0}: nothing is written to it here, but Windows and other programs may write to a card while it is in. '
    + 'Take an SD card out, slide its lock switch to Lock and put it back; and never save or copy anything onto it -- '
    + 'recovered files and this program included -- until everything you need is back.', p.label);
}

/**
 * How far a device of no known size can be read, found by halving: the end of the last 4 KiB block
 * that reads whole, below 16 TiB. A bad block where it looks makes it seem to end there, which is why
 * this is used only when nothing on the device says its size. Null when nothing reads.
 */
function probeSize(reader) {
  const reads = (block) => {
    try {
      return reader.read(block * BLOCK, BLOCK).length === BLOCK;
    } catch (_) {
      return false;
    }
  };
  if (!reads(0)) return null;
  let lo = 0;
  let hi = 2 ** 32;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (reads(mid)) lo = mid;
    else hi = mid;
  }
  return (lo + 1) * BLOCK;
}

// The serial numbers of the FAT and exFAT volumes found on each place opened, by what was opened:
// what volumes() keeps restore from writing onto.
const serials = new Map();

const placeKey = (p) => (env.platform() === 'win32' ? p.open.toLowerCase() : p.open);

function remember(p, serial) {
  const key = placeKey(p);
  if (!serials.has(key)) serials.set(key, new Set());
  serials.get(key).add(serial >>> 0);
}

/** Opens a place and finds its volumes, setting a device's size from them. */
function openPlace(p) {
  const reader = fat.openReader(p.open);
  try {
    const found = fat.findVolumes(reader);
    const volumes = [];
    const raw = [];
    const notes = found.notes.slice();
    for (const part of found.volumes) {
      if (part.fs === 'ntfs') {
        notes.push(t('the volume at byte {0} is NTFS, which is not read here', part.offset));
        continue;
      }
      if (part.fs !== 'fat' && part.fs !== 'exfat') {
        raw.push(part);
        continue;
      }
      try {
        const volume = fat.openVolume(reader, part);
        volumes.push({ part, volume });
        if (volume.serial != null) remember(p, volume.serial);
      } catch (e) {
        notes.push(e.message);
        raw.push(part);
      }
    }
    // A device reports no size: it ends where its last volume does, as far as that is known.
    if (reader.size == null) {
      const ends = [...volumes.map((v) => v.volume.offset + v.volume.size),
        ...found.volumes.filter((v) => v.size != null).map((v) => v.offset + v.size)];
      if (ends.length) reader.size = Math.max(...ends);
      // One wiped whole names none: then it ends where reading it stops.
      if (reader.size == null && raw.length) {
        reader.size = probeSize(reader);
        if (reader.size != null) notes.push(t('no file system gives its size; reading it stops after {0} byte(s)', reader.size));
      }
    }
    return { reader, volumes, raw, notes, count: found.volumes.filter((v) => v.fs === 'fat' || v.fs === 'exfat').length };
  } catch (e) {
    reader.close();
    throw e;
  }
}

/**
 * Whether a deleted file's name matches the search. A short name whose first character was lost is
 * tried with every character it could have been.
 */
function nameMatches(matcher, prefix, o) {
  if (matcher.test(prefix + o.path)) return true;
  if (o.nameCertain !== false) return false;
  const cut = o.path.lastIndexOf('\\') + 1;
  const dir = prefix + o.path.slice(0, cut);
  const rest = o.path.slice(cut + 1);
  return FIRST_CHARS.some((ch) => matcher.test(dir + ch + rest));
}

/** Whether content that `validate()` gave holds together as a whole file of at most `size` bytes. */
function checksOut(hit, size) {
  return !!hit && hit.usable !== false && hit.complete && !hit.problems.length && hit.length <= size;
}

/**
 * Whether content that `validate()` gave is of the kind a deleted file's name says: 'yes' when it
 * is, or when there is none or the name says nothing known; 'renamed' for another format's bytes
 * that are whole, checksums over every byte, at exactly the size recorded (see the top of this
 * file); 'no' for another file's bytes.
 */
function kinOf(name, hit, size) {
  if (!hit) return 'yes';
  const family = FAMILY.get(extOf(name));
  let same;
  if (family) {
    same = family.includes(hit.type);
  } else {
    const [usual, other] = typesOfName(name);
    same = !usual || hit.mediaType === usual || hit.mediaType === other;
  }
  if (same) return 'yes';
  return hit.selfChecked && hit.complete && !hit.problems.length && hit.length === size ? 'renamed' : 'no';
}

/**
 * Reads the bytes an extent names and checks them. A file of HASH_LIMIT or less is read whole once,
 * checked in memory and hashed; a larger one is checked where it lies, as far as the checks read,
 * and the hash of its first HEAD_CHECK bytes taken. The whole read waits without holding the
 * process, so that a front end in it stays answering while a slow card is read; the checks of a
 * larger one read as they go, and do hold it.
 * @returns {Promise<{ hit: object|null, hash: string|null, head: string|null }>}
 */
async function inspect(reader, x) {
  const short = (got, want) => {
    const e = new Error(t('only {0} of {1} byte(s) could be read', got, want));
    e.code = 'short';
    return e;
  };
  if (x.size <= HASH_LIMIT) {
    const bytes = await fat.extentReader(reader, x).readAsync(0, x.size);
    if (bytes.length !== x.size) throw short(bytes.length, x.size);
    return { hit: carve.validate(fat.memoryReader(bytes), 0), hash: blobHash(bytes), head: null };
  }
  const first = await fat.extentReader(reader, x).readAsync(0, HEAD_CHECK);
  if (first.length !== HEAD_CHECK) throw short(first.length, HEAD_CHECK);
  return { hit: carve.validate(fat.extentReader(reader, x), 0), hash: null, head: headHash(first) };
}

/**
 * An extent as content.js reads it: the pieces lib/fat.js gives, then zeros up to the size; with
 * `head` for one too large to hash.
 */
function extentOf(place, x, head) {
  const runs = x.spans.map(([off, len]) => [off, len]);
  if (x.size > x.validSize) runs.push([null, x.size - x.validSize]);
  return { place, runs, ...(head ? { head } : {}) };
}

/**
 * The copies one deleted entry gives, and what became of it, in `tally`: a count for each reason it
 * was left out. Where each copy offered lies goes in `claimed`, so that carving does not find it
 * again; an entry whose clusters hold something else now claims none of them.
 */
async function undeleted(reader, p, volume, prefix, o, tally, claimed) {
  const kind = volume.fs === 'exFAT' ? 'exfat undelete' : 'fat undelete';
  const name = o.path.slice(o.path.lastIndexOf('\\') + 1);
  // A name that says a format checked here is held to it. Any other file's first bytes may look like
  // the start of one by chance -- a note that begins "BM" -- and count only when they are one, whole.
  const claims = CHECKED_EXT.has(extOf(name));
  const said = [
    ...(o.nameCertain === false ? [t('the first character of its name was lost when it was deleted; "_" stands in for it')] : []),
    ...(o.inDeletedFolder ? [t('it was in a folder that was deleted too')] : []),
    ...o.notes,
  ];
  const copy = (x, got, extra) => {
    const hit = got.hit;
    const { reasons, ...flags } = carve.judge(hit, { size: o.size, known: x.complete });
    const at = x.spans.length ? x.spans[0][0] : 0;
    const own = [];
    if (hit && hit.complete && ENDS_EXACTLY.has(hit.type) && o.size > hit.length) {
      flags.unverified = true;
      own.push(t('a {0} has nothing after its end, which comes {1} bytes before the size recorded: it may be a shorter '
        + 'file written over the start of this one', hit.ext.slice(1).toUpperCase(), o.size - hit.length));
    }
    if (extra.renamed) {
      own.push(t('its bytes are a whole {0}, of exactly the size recorded, though its name says otherwise: the file was '
        + 'one under that name', hit.ext.slice(1).toUpperCase()));
    }
    claimed.push({ extent: x });
    return {
      source: 'removable', kind, path: prefix + o.path,
      time: o.modified ? o.modified.ms : o.created ? o.created.ms : null,
      size: o.size,
      extent: extentOf(p.open, x, got.head),
      ...(got.hash ? { hash: got.hash } : {}),
      ...flags,
      ...(extra.unverified ? { unverified: true } : {}),
      ...(extra.renamed ? { mediaType: hit.mediaType, ext: hit.ext } : {}),
      ...(hit && hit.width ? { width: hit.width, height: hit.height } : {}),
      note: [...said, ...(extra.note ? [extra.note] : []), ...own, ...reasons].join('; '),
      origin: t('{0}, at byte {1}', p.open, at),
    };
  };
  const look = async (x) => {
    try {
      const got = await inspect(reader, x);
      return claims || checksOut(got.hit, o.size) ? got : { ...got, hit: null };
    } catch (e) {
      if (!tally.unreadable) tally.firstError = e.code || e.message;
      tally.unreadable = (tally.unreadable || 0) + 1;
      return null;
    }
  };
  const bump = (why) => {
    tally[why] = (tally[why] || 0) + 1;
    return [];
  };

  switch (o.status) {
    case 'complete':
    case 'assumed': {
      const got = await look(o.extent);
      if (!got) return [];
      if (got.hit && got.hit.usable === false) return bump('unusable');
      const kin = got.hit ? kinOf(name, got.hit, o.size) : claims ? 'no' : 'yes';
      if (kin === 'no') return bump('mismatch');
      return [copy(o.extent, got, { renamed: kin === 'renamed' })];
    }
    case 'ambiguous': {
      const fits = [];
      for (const x of o.candidates.filter((c) => !c.problems.length)) {
        const got = await look(x);
        const kin = got && checksOut(got.hit, o.size) ? kinOf(name, got.hit, o.size) : 'no';
        if (kin !== 'no') fits.push([x, got, kin]);
      }
      if (!fits.length) return bump('ambiguous');
      const note = fits.length > 1
        ? t('{0} of the places it may have started hold a whole {1}; which of them is the file cannot be told',
          fits.length, fits[0][1].hit.ext.slice(1).toUpperCase())
        : t('of those, only the one it was read from holds content that checks out');
      return fits.map(([x, got, kin]) => copy(x, got, { unverified: fits.length > 1, note, renamed: kin === 'renamed' }));
    }
    case 'overwritten': {
      if (!o.fallback) return bump('overwritten');
      const got = await look(o.fallback);
      const kin = got && checksOut(got.hit, o.size) ? kinOf(name, got.hit, o.size) : 'no';
      if (kin === 'no') return bump('overwritten');
      return [copy(o.fallback, got, {
        unverified: true,
        renamed: kin === 'renamed',
        note: t('some of its clusters are in use now; it was read from the free ones that follow its first, '
          + 'and its content checks out'),
      })];
    }
    case 'empty':
      return bump('empty');
    default:
      return bump(o.status || 'damaged');
  }
}

/** Notes on what a volume's deleted files that matched the search came to. */
function tallyNotes(label, tally) {
  const out = [];
  const say = (key, text) => {
    if (tally[key]) out.push(t('{0}: {1} {2}', label, tally[key], text));
  };
  say('overwritten', t('deleted file(s) left out: clusters they lay in are in use now'));
  say('fragmented', t('deleted file(s) left out: they were in pieces, and where the pieces lay is not recorded'));
  say('ambiguous', t('deleted file(s) left out: none of the places they may have started holds content that checks out'));
  say('mismatch', t('deleted file(s) left out: their bytes are no longer of the format their names say'));
  say('unusable', t('deleted file(s) left out: nothing of their content is left to show'));
  say('moved', t('deleted entry(ies) left out: the file was moved or renamed, and is still there'));
  say('damaged', t('deleted entry(ies) left out: they do not hold together'));
  say('empty', t('deleted file(s) left out: they held nothing'));
  if (tally.unreadable) {
    out.push(t('{0}: {1} deleted file(s) could not be read ({2})', label, tally.unreadable, tally.firstError));
  }
  return out;
}

/** The [from, to) ranges of a place to carve, and the step to probe them at, one set per volume. */
function carveRanges(opened, reader, claimed) {
  const out = [];
  for (const { volume } of opened.volumes) {
    const ranges = [];
    for (const [c, n] of fat.freeRuns(volume, claimed.get(volume) || [])) {
      const from = volume.clusterOffset(c);
      ranges.push([from, from + n * volume.clusterSize]);
    }
    if (ranges.length) out.push({ ranges, step: volume.clusterSize, free: true });
  }
  for (const part of opened.raw) {
    const end = part.size != null ? part.offset + part.size : reader.size;
    if (end != null && end > part.offset) out.push({ ranges: [[part.offset, end]], step: 512, free: false });
  }
  return out;
}

async function scanPlace(ctx, p, state) {
  const out = [];
  let opened;
  try {
    opened = openPlace(p);
  } catch (e) {
    ctx.notes.push(openFailed(p, e));
    return out;
  }
  const { reader } = opened;
  try {
    for (const n of opened.notes) ctx.notes.push(t('{0}: {1}', p.label, n));
    const claimed = new Map();
    for (const { part, volume } of opened.volumes) {
      const prefix = prefixOf(p, part, opened.count);
      const where = p.kind === 'drive' ? p.label : prefix.slice(0, -1);
      let scanned;
      try {
        scanned = fat.scanVolume(volume, { oem: state.oem });
      } catch (e) {
        if (e.code) throw e;
        ctx.notes.push(t('{0}: its folders could not be read ({1})', where, e.message));
        continue;
      }
      for (const n of scanned.notes) ctx.notes.push(t('{0}: {1}', where, n));
      const tally = {};
      // Only what was offered claims its clusters. A deleted entry that was not looked at -- not
      // of the types searched for -- or that holds something else now leaves them to carving.
      const offered = [];
      const matched = scanned.deleted.filter((o) => nameMatches(ctx.matcher, prefix, o));
      for (let i = 0; i < matched.length; i++) {
        if (ctx.signal) ctx.signal.throwIfAborted();
        if (ctx.progress) ctx.progress(i + 1, matched.length);
        const o = matched[i];
        out.push(...(await undeleted(reader, p, volume, prefix, o, tally, offered)));
      }
      ctx.notes.push(t('{0}: {1}, {2}-byte clusters; {3} deleted file(s) in its folders, {4} matching this search',
        where, volume.fs, volume.clusterSize, scanned.deleted.length, matched.length));
      ctx.notes.push(...tallyNotes(where, tally));
      claimed.set(volume, offered);
    }
    if (state.carve) out.push(...(await carvePlace(ctx, p, opened, claimed, state)));
  } finally {
    reader.close();
  }
  return out;
}

async function carvePlace(ctx, p, opened, claimed, state) {
  const { reader } = opened;
  const out = [];
  if (reader.size == null) {
    ctx.notes.push(t('{0}: its size cannot be told, so its free space was not carved', p.label));
    return out;
  }
  const jobs = carveRanges(opened, reader, claimed);
  const total = jobs.reduce((s, j) => s + j.ranges.reduce((a, [f, to]) => a + (to - f), 0), 0);
  let done = 0;
  for (const job of jobs) {
    if (state.carvedLeft <= 0) break;
    const res = await carve.scan(reader, {
      ranges: job.ranges, step: job.step, types: ctx.types, maxFiles: state.carvedLeft, signal: ctx.signal || undefined,
      onProgress: (n) => ctx.progress && ctx.progress(done + n, total),
    });
    done += res.total;
    if (ctx.signal) ctx.signal.throwIfAborted();
    for (const n of res.notes) ctx.notes.push(t('{0}: {1}', p.label, n));
    for (const hit of res.found) {
      const c = carve.candidate(hit);
      let hash = null;
      let head = null;
      try {
        const small = hit.length <= HASH_LIMIT;
        const data = await reader.readAsync(hit.offset, small ? hit.length : HEAD_CHECK);
        if (small && data.length === hit.length) hash = blobHash(data);
        else if (!small && data.length === HEAD_CHECK) head = headHash(data);
      } catch (_) {
        /* read again when it is restored, and failed then with a reason */
      }
      out.push({
        ...c, source: 'removable', path: null,
        extent: { place: p.open, runs: [[hit.offset, hit.length]], ...(head ? { head } : {}) },
        ...(hash ? { hash } : {}),
        origin: t('{0}, at byte {1}', p.open, hit.offset),
      });
    }
    state.carvedLeft -= res.found.length;
    ctx.notes.push(job.free
      ? t('{0}: {1} of free space carved, {2} file(s) found', p.label, bytes(res.scanned), res.found.length)
      : t('{0}: {1} with no file system known here carved, {2} file(s) found', p.label, bytes(res.scanned),
        res.found.length));
  }
  return out;
}

async function scan(ctx) {
  const out = [];
  const given = places(ctx.locations);
  if (!given.length) return out;
  const state = {
    oem: oemLabel(),
    // Carving lists files with no name, which only a search for types of file with no name to go on wants.
    carve: !!ctx.unnamed && !!ctx.types && ctx.types.some((x) => CARVED_TYPES.has(x)),
    carvedLeft: MAX_CARVED,
  };
  for (const p of given) {
    if (p.kind !== 'image') ctx.notes.push(lockNote(p));
    const no = refusal(p);
    if (no) {
      ctx.notes.push(no);
      continue;
    }
    out.push(...(await scanPlace(ctx, p, state)));
  }
  return out;
}

function describe(ctx) {
  const given = places(ctx.locations);
  if (!given.length) {
    return [t('Nothing given: name a card, USB drive or disk image with --location removable=<E: or an image file>.')];
  }
  const lines = [];
  for (const p of given) {
    const no = refusal(p);
    if (no) {
      lines.push(no);
      continue;
    }
    let opened;
    try {
      opened = openPlace(p);
    } catch (e) {
      lines.push(openFailed(p, e));
      continue;
    }
    try {
      for (const n of opened.notes) lines.push(t('{0}: {1}', p.label, n));
      for (const { part, volume } of opened.volumes) {
        lines.push(t('{0}: {1}, {2}, {3}-byte clusters, {4} of {5} free',
          p.kind === 'drive' ? p.label : prefixOf(p, part, opened.count).slice(0, -1), volume.fs, bytes(volume.size),
          volume.clusterSize, volume.freeClusters(), volume.clusterCount));
      }
      for (const part of opened.raw) {
        lines.push(t('{0}: no FAT or exFAT file system at byte {1}; only a search for types of file carves it',
          p.label, part.offset));
      }
    } finally {
      opened.reader.close();
    }
    if (p.kind !== 'image') lines.push(lockNote(p));
  }
  return lines;
}

/** What a device's name really is: /dev/disk/by-label/CARD is the /dev/sdb1 it links to. */
function realDevice(device) {
  try {
    return fs.realpathSync(device);
  } catch (_) {
    return device;
  }
}

/**
 * /proc/self/mounts: where each device given is mounted, so that none of those folders is written
 * into. Both the name given and each mount's are taken as what they really are, so a link names
 * the device it leads to.
 */
function mountsOf(device, text = null) {
  if (text == null) {
    try {
      text = fs.readFileSync('/proc/self/mounts', 'latin1');
    } catch (_) {
      return [];
    }
  }
  // \040-style escapes stand for bytes; the bytes together are UTF-8.
  const unescape = (s) => Buffer.from(s.replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8))), 'latin1')
    .toString('utf8');
  const names = [...new Set([device, realDevice(device)])];
  const out = [];
  for (const line of text.split('\n')) {
    const [src, at] = line.split(' ');
    if (!src || !at) continue;
    const given = unescape(src);
    const all = given.startsWith('/dev/') ? [...new Set([given, realDevice(given)])] : [given];
    const mine = all.some((s) => names.some((d) => s === d || (s.startsWith(d) && /^p?\d+$/.test(s.slice(d.length)))));
    if (mine) out.push(unescape(at));
  }
  return [...new Set(out)];
}

/**
 * Where restore must never write: a drive's whole root, and an image file itself. A Linux device
 * is kept safe through the folders it is mounted at; volumes() keeps the rest safe.
 */
function roots(loc) {
  const out = [];
  for (const p of places(loc)) {
    if (p.root) out.push(p.root);
    else if (p.open.startsWith('/dev/')) out.push(...mountsOf(p.open));
  }
  return out;
}

/**
 * The volumes restore must never write onto, as { volume, label }: `volume` is what stat() gives
 * as dev for a file on it (see the top of this file). A drive letter's, from its root; a Windows
 * device's, from the serial numbers of the volumes on it, read when it was searched or else now;
 * a \\?\Volume{...}\ path's from its root as well; and a POSIX device's own device number. A place
 * that cannot be read now -- a whole disk, without administrator rights -- is left to its note.
 */
function volumes(loc) {
  const out = [];
  const add = (dev, p) => {
    if (dev != null && !out.some((v) => v.volume === String(dev))) out.push({ volume: String(dev), label: p.label });
  };
  const statDev = (at) => {
    try {
      return fs.statSync(at, { bigint: true }).dev;
    } catch (_) {
      return null;
    }
  };
  for (const p of places(loc)) {
    if (p.kind === 'image') continue;
    if (p.kind === 'drive') {
      if (env.platform() === 'win32') add(statDev(p.root), p);
      continue;
    }
    if (p.open.startsWith('/dev/')) {
      try {
        add(fs.statSync(realDevice(p.open), { bigint: true }).rdev || null, p);
      } catch (_) {
        /* not there: its mounts, if any, are in roots() */
      }
      continue;
    }
    if (/^\\\\\?\\Volume\{/i.test(p.given)) add(statDev(p.given.replace(/[\\/]*$/, '\\')), p);
    if (!serials.has(placeKey(p)) && !refusal(p)) {
      try {
        openPlace(p).reader.close();
      } catch (_) {
        /* cannot be read now; nothing was found on it either */
      }
    }
    for (const s of serials.get(placeKey(p)) || []) add(s, p);
  }
  return out;
}

module.exports = {
  id: 'removable',
  label: 'Cards and USB drives',
  needsAdmin: true,
  // Nothing is read that was not named: a card is given with --location removable=<place>.
  discover: () => [],
  scan,
  describe,
  roots,
  volumes,
  _internal: {
    env, placeOf, nameMatches, checksOut, kinOf, oemLabel, mountsOf, extentOf, probeSize, remember, serials, MAX_CARVED,
    CHECKED_EXT, FAMILY,
  },
};
