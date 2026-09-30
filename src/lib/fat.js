'use strict';

const fs = require('fs');
const { Readable } = require('stream');
const zlib = require('zlib');
const { t } = require('../i18n');

// Reads the file systems of memory cards, USB sticks and cameras -- FAT12, FAT16, FAT32 and exFAT
// -- from a disk image, or with administrator rights from the device itself, and lists what was
// deleted on them: each file's name, size and times, and where its bytes may still lie. Nothing is
// written: a place is opened for reading only, and every table is read into memory.
//
// Where a volume starts:
//   none   a boot sector at 0, as most USB sticks and many cards are formatted ("superfloppy")
//   MBR    four entries at 446 (status @0, type @4, first sector @8, sector count @12); the logical
//          partitions of an extended one (type 05, 0F or 85) in a chain of extended boot records
//   GPT    "EFI PART" in the sector after the MBR: entry array at the sector @72, count @80, entry
//          size @84, both checked by CRC-32; each entry's type @0, first sector @32, last @40, name @56
// A FAT32 volume whose boot sector is damaged is read from its backup at sector 6, an exFAT one from
// its backup region at sector 12, as long as the backup passes the same checks.
//
// FAT12/16/32 (fatgen103):
//   type        FAT32 when the boot sector gives no 16-bit FAT size; otherwise FAT12 under 4085
//               clusters and FAT16 above
//   entry       32 bytes: name[11] @0 (0x00 ends the folder, 0xE5 deleted, 0x05 a real 0xE5),
//               attributes @11 (0x10 folder, 0x08 label, 0x0F long name), lowercase flags @12 (0x08
//               name, 0x10 extension), created @13 (10 ms steps) @14 (time) @16 (date), accessed
//               date @18, first cluster high half @20, modified @22 (time) @24 (date), first cluster
//               low half @26, size @28. Times are the wall clock of the device that wrote them, with
//               no zone; they are read as local time here.
//   long name   13 UTF-16 units per entry (@1, @14, @28), stored backwards just before the short
//               entry, and tied to it by an 8-bit checksum @13 of the short name's 11 bytes
// Deleting, in Windows' fastfat and in Linux's vfat alike, writes 0xE5 over the first byte of the
// short entry and of every long-name entry, and sets the file's chain in the FAT free (0). The size
// and the low half of the first cluster stay. Windows also clears the high half on FAT32 (fastfat
// allocsup.c FatTruncateFileAllocation, then dirsup.c writes back only the low 16 bits); Linux keeps
// both. On a FAT32 volume of more than 65,536 clusters, a deleted file whose high half reads 0 may
// therefore have started at the low half plus any multiple of 65,536, and every such start is
// tried. The long name survives whole, apart from the order bytes; the short name loses its first
// byte. The checksum is a one-to-one function of that byte, so exactly one value fits, and the long
// name is kept only when that value is the one its first character gives: the letter in upper
// case, "_" for a character a short name cannot hold, or a code-page byte for one beyond ASCII.
// Otherwise the long-name entries are not this file's, and the short name's first character is put
// back as "_". A folder's first cluster begins with "." and "..", which name its own first cluster
// and its parent's: that is how a deleted folder is recognised, and which start it had.
//
// With the chain gone, where a deleted file of more than one cluster lay is an assumption: the
// clusters from its first one on, as many as its size needs. It is refused when any of them is in
// use now -- overwritten, or the file lay around one that still exists -- or when another entry's
// first cluster lies inside them, so that the file cannot have been in one piece. Only a file that
// fits in one cluster at a known start, or one whose chain another system left behind -- exactly as
// long as its size needs, ending where it should, through no cluster a live file uses -- is known to
// lie where it is read from.
//
// exFAT (Microsoft's exFAT specification):
//   entry set   a file entry 0x85 (set checksum @2 over the whole set, attributes @4, created @8,
//               modified @12, accessed @16 as DOS date << 16 | time, 10 ms steps @20 @21, UTC
//               offsets @22 @23 @24 in quarter hours with bit 7 set when valid); a stream extension
//               0xC0 (flags @1: 1 allocation possible, 2 no FAT chain; name length @3, name hash @4,
//               valid data length @8, first cluster @20, data length @24); file name entries 0xC1 of
//               15 UTF-16 units @2; perhaps other secondary entries after them
//   in use      an allocation bitmap, bit (cluster - 2) with the lowest bit of each byte first
//   names       hashed through the volume's own up-case table, stored compressed: 0xFFFF and a
//               count stand for that many characters that map to themselves
// Deleting clears the InUse bit (0x80) of every entry in the set and the file's bits in the bitmap,
// and leaves the rest: the set checksum as it was, the first cluster, the sizes, the "no FAT chain"
// flag, and the FAT cells of a file in pieces (Windows 10 exfat.sys in Vandermeer et al. 2018,
// figures 1-5; Linux fs/exfat dir.c exfat_remove_entries and fatent.c __exfat_free_cluster). So a
// deleted set is taken when its checksum matches with the InUse bits put back, or, from a driver
// that recomputed it, as stored. Its clusters are known exactly when it was in one piece -- Windows
// sets "no FAT chain" whenever a file is -- or when its old chain still runs exactly as far as its
// size, and it is offered when the bitmap says none of them is in use now. A move leaves the old set
// behind too, the same as the new one, so a deleted set whose first cluster and size a live file has
// is that file, moved. Past the valid data length a file reads as zeros.
//
// Two deleted files can be taken to lie in the same clusters. When one of them was written there
// later -- its later time, created or modified, is later -- and its clusters are known, not
// assumed, the other was overwritten by it. Otherwise both are offered, each with a note.
//
// None of this proves that the bytes are still the file's. A later file that took the clusters,
// was deleted in turn and had its entry reused leaves no trace, which is why a caller checks the
// content before it calls a copy good.
//
// Measured on DFTT #6, a public FAT16 image whose files Windows XP created and deleted: all six
// deleted files kept their size and the low half of their first cluster. Two were refused as in
// pieces, since another deleted file started inside each. Of the four offered, the one-cluster file
// and two assumed in one piece match the published MD5s; the fourth, assumed in one piece with
// nothing to show it was not, does not -- which is why an assumed extent is never called known. On
// the sets Windows 10 wrote in the paper above, the set checksums and name hashes computed here are
// Windows' own, and the deleted sets' match only with the InUse bits restored. The rest is checked on
// images the tests build.

const SECTOR = 512;
const BLOCK = 4096;
// Opening without waiting, where there is such a flag, so that a pipe given as a place cannot hold
// anything up; a file or a device reads the same.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);
// \\.\E:, \\.\PhysicalDrive1, \\?\Volume{...}: devices, which report no size.
const WINDOWS_DEVICE = /^\\\\[.?]\\/;
// Tables are read in pieces of this size, and only the pieces that are needed.
const CHUNK = 1 << 20;
// A FAT folder holds at most 65,536 entries; an exFAT one at most 256 MiB.
const FAT_DIR_LIMIT = 65536 * 32;
const EXFAT_DIR_LIMIT = 256 * 1024 * 1024;
const MAX_DEPTH = 64;
// A FAT entry that could not be read, which is never taken for a free one.
const UNREADABLE = -1;

// ------------------------------------------------------------------ reading

/**
 * A place opened for reading only: an image file, or with administrator rights a device such as
 * \\.\E:, \\.\PhysicalDrive1 or /dev/sdb. Every read is widened to whole 4 KiB blocks, since a
 * device refuses one that does not start and end on a sector boundary; one that ends inside the last
 * block is read a sector at a time instead. A device has no size to ask for: `size` is then the one
 * given, or null, and can be set later -- from the partition table, say -- to stop reads there.
 * Unelevated, opening a device on Windows fails with EPERM.
 * @returns {{ size: number|null, read(offset, length): Buffer, readAsync(offset, length): Promise<Buffer>, close() }}
 */
function openReader(place, { align = BLOCK, size: given = null } = {}) {
  const fd = fs.openSync(place, OPEN_FLAGS);
  const device = WINDOWS_DEVICE.test(String(place));
  let size = given;
  try {
    let st = null;
    try {
      st = fs.fstatSync(fd);
    } catch (e) {
      // What a Windows volume or disk handle answers here was not measured; it has no size anyway.
      if (!device) throw e;
    }
    if (st && (st.isDirectory() || st.isFIFO() || st.isSocket())) {
      throw new Error(t('{0} is neither a disk image nor a device', place));
    }
    if (st && st.isFile() && !device) size = st.size;
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  const bounds = (off, len, a) => {
    if (api.size != null) len = Math.min(len, api.size - off);
    if (!(len > 0) || !(off >= 0)) return null;
    const from = Math.floor(off / a) * a;
    return { from, length: Math.ceil((off + len) / a) * a - from, skip: off - from, len };
  };
  const cut = (buf, n, b) => buf.subarray(Math.min(b.skip, n), Math.min(b.skip + b.len, n));
  const blocks = (b) => {
    const buf = Buffer.allocUnsafe(b.length);
    return cut(buf, fs.readSync(fd, buf, 0, b.length, b.from), b);
  };
  const blocksLater = (b) => new Promise((resolve, reject) => {
    const buf = Buffer.allocUnsafe(b.length);
    fs.read(fd, buf, 0, b.length, b.from, (e, n) => (e ? reject(e) : resolve(cut(buf, n, b))));
  });
  const api = {
    size,
    read(off, len) {
      const b = bounds(off, len, align);
      if (!b) return Buffer.alloc(0);
      try {
        return blocks(b);
      } catch (e) {
        if (align === SECTOR) throw e;
        return blocks(bounds(off, len, SECTOR));
      }
    },
    async readAsync(off, len) {
      const b = bounds(off, len, align);
      if (!b) return Buffer.alloc(0);
      try {
        return await blocksLater(b);
      } catch (e) {
        if (align === SECTOR) throw e;
        return blocksLater(bounds(off, len, SECTOR));
      }
    },
    close() {
      fs.closeSync(fd);
    },
  };
  return api;
}

/** A reader over bytes already in memory. */
function memoryReader(buf) {
  return {
    size: buf.length,
    read: (off, len) => buf.subarray(Math.max(0, off), Math.max(0, Math.min(buf.length, off + len))),
  };
}

// ------------------------------------------------------------------ checksums

// zlib.crc32 arrived in Node 22.2; the table is for 22.0 and 22.1.
let CRC_TABLE = null;
function crc32Table(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const crc32 = typeof zlib.crc32 === 'function' ? (buf) => zlib.crc32(buf) >>> 0 : crc32Table;

/** The 8-bit rotate-and-add sum that ties long-name entries to their short name's 11 bytes. */
function lfnChecksum(name11) {
  let s = 0;
  for (let i = 0; i < 11; i++) s = (((s & 1) << 7) + (s >> 1) + name11[i]) & 0xff;
  return s;
}

/** exFAT's 32-bit rotate-and-add sum, over a boot region or the up-case table; `skip` bytes left out. */
function exfatSum32(buf, skip = () => false) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) if (!skip(i)) s = ((((s & 1) << 31) | (s >>> 1)) + buf[i]) >>> 0;
  return s;
}

/** An exFAT entry set's 16-bit checksum: every byte of the set except the checksum itself (@2, @3). */
function setChecksum(set) {
  let s = 0;
  for (let i = 0; i < set.length; i++) if (i !== 2 && i !== 3) s = (((s & 1) << 15) + (s >> 1) + set[i]) & 0xffff;
  return s;
}

/** An exFAT name hash: the same kind of sum over the up-cased name, each UTF-16 unit low byte first. */
function nameHash(name, upcase) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    const u = upcase[name.charCodeAt(i)];
    h = (((h & 1) << 15) + (h >> 1) + (u & 0xff)) & 0xffff;
    h = (((h & 1) << 15) + (h >> 1) + (u >> 8)) & 0xffff;
  }
  return h;
}

// ------------------------------------------------------------------ times and names

const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * A DOS date and time: { ms, wall, offset }, or null when not recorded or not a real time. `wall`
 * is what the device's clock read; `offset` is its distance from UTC in minutes when that was
 * recorded (exFAT only), and `ms` the moment, taken as this machine's local time when it was not.
 */
function dosStamp(date, time, extraMs = 0, offset = null) {
  if (!date) return null;
  const y = 1980 + (date >> 9);
  const mo = (date >> 5) & 15;
  const d = date & 31;
  const h = time >> 11;
  const mi = (time >> 5) & 63;
  const s = (time & 31) * 2;
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || s > 58) return null;
  const extra = extraMs >= 0 && extraMs < 2000 ? extraMs : 0;
  const naive = Date.UTC(y, mo - 1, d, h, mi, s, extra);
  const wall = new Date(naive).toISOString().slice(0, 23).replace(/\.000$/, '');
  const ms = offset == null ? new Date(y, mo - 1, d, h, mi, s, extra).getTime() : naive - offset * 60000;
  return { ms, wall, offset };
}

/** An exFAT UTC offset byte: minutes east of UTC, or null when bit 7 says it was not recorded. */
function utcOffset(b) {
  if (!(b & 0x80)) return null;
  const q = b & 0x40 ? (b & 0x7f) - 0x80 : b & 0x7f;
  return q * 15;
}

/**
 * When a file was last written where it lies: the later of its created and modified times, since a
 * file copied onto a card keeps its modified time and is created there anew.
 */
function writtenAt(e) {
  const times = [e.created, e.modified].filter(Boolean).map((x) => x.ms);
  return times.length ? Math.max(...times) : null;
}

// Short names are in the code page of the system that wrote them. 437 is what FAT began with and
// what Linux and most cameras assume; another can be named with any label TextDecoder knows, such
// as 'euc-kr' for Korean Windows.
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐'
  + '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

function oemDecoder(label) {
  if (!label || String(label).toLowerCase() === 'cp437') {
    return (b) => {
      let s = '';
      for (const x of b) s += x < 0x80 ? String.fromCharCode(x) : CP437[x - 0x80];
      return s;
    };
  }
  const d = new TextDecoder(label);
  return (b) => d.decode(b);
}

// ------------------------------------------------------------------ boot sectors and partitions

// The most clusters each FAT type can number.
const MAX_CLUSTERS = { 12: 4084, 16: 65524, 32: 0x0ffffff5 };

/**
 * A FAT boot sector's geometry, or null when its BPB does not hold together. A volume is FAT32 when
 * its 16-bit FAT size is 0 and a 32-bit one is given, which is how Linux tells (fs/fat/inode.c);
 * otherwise it is FAT12 under 4085 clusters and FAT16 above. A FAT too small for every cluster the
 * volume has limits them to those it can describe, as both Windows' fastfat (allocsup.c) and Linux do.
 */
function fatBpb(b) {
  if (!b || b.length < SECTOR || (b[0] !== 0xeb && b[0] !== 0xe9)) return null;
  const bps = b.readUInt16LE(11);
  const spc = b[13];
  const rsvd = b.readUInt16LE(14);
  const fats = b[16];
  const rootEnt = b.readUInt16LE(17);
  const tot = b.readUInt16LE(19) || b.readUInt32LE(32);
  const media = b[21];
  const fat16Size = b.readUInt16LE(22);
  const type32 = !fat16Size && b.readUInt32LE(36) > 0;
  const fatsz = type32 ? b.readUInt32LE(36) : fat16Size;
  if (![512, 1024, 2048, 4096].includes(bps) || !spc || (spc & (spc - 1)) || !rsvd || !fats || fats > 4) return null;
  if (!tot || !fatsz || (media !== 0xf0 && media < 0xf8) || (!type32 && !rootEnt)) return null;
  const rootSecs = Math.ceil((rootEnt * 32) / bps);
  const meta = rsvd + fats * fatsz + rootSecs;
  if (meta >= tot) return null;
  let clusters = Math.floor((tot - meta) / spc);
  const type = type32 ? 32 : clusters < 4085 ? 12 : 16;
  clusters = Math.min(clusters, Math.floor((fatsz * bps * 8) / type) - 2);
  if (clusters < 1 || clusters > MAX_CLUSTERS[type]) return null;
  const g = { type, bps, spc, rsvd, fats, rootEnt, tot, fatsz, rootSecs, clusters };
  if (type === 32) {
    const flags = b.readUInt16LE(40);
    // Bit 7: the FATs are not mirrored, and bits 0-3 say which one is in use.
    g.activeFat = flags & 0x80 ? Math.min(flags & 0x0f, fats - 1) : 0;
    g.rootCluster = b.readUInt32LE(44);
    if (g.rootCluster < 2 || g.rootCluster > clusters + 1) return null;
  } else {
    g.activeFat = 0;
  }
  const sig = type === 32 ? 66 : 38;
  if (b[sig] === 0x29) {
    g.serial = b.readUInt32LE(sig + 1);
    g.label = b.toString('latin1', sig + 5, sig + 16).trim();
  }
  return g;
}

/** An exFAT boot sector's fields, or null when they do not hold together. */
function exfatBoot(b) {
  if (!b || b.length < SECTOR || b.toString('latin1', 3, 11) !== 'EXFAT   ') return null;
  if (b[510] !== 0x55 || b[511] !== 0xaa) return null;
  for (let i = 11; i < 64; i++) if (b[i]) return null;
  const bpsShift = b[108];
  const spcShift = b[109];
  if (bpsShift < 9 || bpsShift > 12 || spcShift > 25 - bpsShift) return null;
  const f = {
    bps: 1 << bpsShift,
    clusterSize: 2 ** (bpsShift + spcShift),
    length: Number(b.readBigUInt64LE(72)),
    fatOffset: b.readUInt32LE(80),
    fatLength: b.readUInt32LE(84),
    heapOffset: b.readUInt32LE(88),
    clusters: b.readUInt32LE(92),
    rootCluster: b.readUInt32LE(96),
    serial: b.readUInt32LE(100),
    flags: b.readUInt16LE(106),
    fats: b[110],
  };
  if (f.fats < 1 || f.fats > 2 || f.fatOffset < 24 || f.heapOffset < f.fatOffset + f.fatLength * f.fats) return null;
  if (!f.clusters || f.rootCluster < 2 || f.rootCluster > f.clusters + 1) return null;
  if (f.fatLength * f.bps < (f.clusters + 2) * 4) return null;
  return f;
}

/**
 * Whether an exFAT boot region passes its checksum: sectors 0 to 10 summed, leaving out the volume
 * flags (@106, @107) and the percent in use (@112), which change without it, and the sum repeated
 * through sector 11.
 */
function exfatBootChecksumOk(reader, at, bps) {
  const region = reader.read(at, 12 * bps);
  if (region.length < 12 * bps) return false;
  const sum = exfatSum32(region.subarray(0, 11 * bps), (i) => i === 106 || i === 107 || i === 112);
  for (let i = 11 * bps; i < 12 * bps; i += 4) if (region.readUInt32LE(i) !== sum) return false;
  return true;
}

/** 'fat', 'exfat', 'ntfs', or null: what the boot sector at the start of a volume says it is. */
function bootKind(b) {
  if (!b || b.length < SECTOR) return null;
  if (exfatBoot(b)) return 'exfat';
  if (b.toString('latin1', 3, 11) === 'NTFS    ' && b[510] === 0x55 && b[511] === 0xaa) return 'ntfs';
  return fatBpb(b) ? 'fat' : null;
}

/**
 * The file system at `offset`, from its boot sector, or from the backup a damaged one leaves: FAT32
 * keeps one at sector 6, exFAT a whole boot region at sector 12.
 * @returns {{ fs: string|null, bootAt: number, backup: boolean }}
 */
function detect(reader, offset) {
  const kind = bootKind(reader.read(offset, SECTOR));
  if (kind) return { fs: kind, bootAt: offset, backup: false };
  const fat32 = fatBpb(reader.read(offset + 6 * SECTOR, SECTOR));
  if (fat32 && fat32.type === 32) return { fs: 'fat', bootAt: offset + 6 * SECTOR, backup: true };
  for (const bps of [512, 4096]) {
    const f = exfatBoot(reader.read(offset + 12 * bps, SECTOR));
    if (f && f.bps === bps) return { fs: 'exfat', bootAt: offset + 12 * bps, backup: true };
  }
  return { fs: null, bootAt: offset, backup: false };
}

/** A GPT GUID as it is written out: the first three fields are stored little-endian. */
function guid(b) {
  const h = b.toString('hex');
  const le = (s) => s.match(/../g).reverse().join('');
  const parts = [le(h.slice(0, 8)), le(h.slice(8, 12)), le(h.slice(12, 16)), h.slice(16, 20), h.slice(20, 32)];
  return parts.join('-').toUpperCase();
}

/** A GPT header at `lba` that passes its checksum, or null. */
function gptHeader(reader, lba, lbaSize) {
  const h = reader.read(lba * lbaSize, lbaSize);
  if (h.length < 92 || h.toString('latin1', 0, 8) !== 'EFI PART') return null;
  const hsize = h.readUInt32LE(12);
  if (hsize < 92 || hsize > h.length) return null;
  const copy = Buffer.from(h.subarray(0, hsize));
  copy.writeUInt32LE(0, 16);
  return {
    ok: crc32(copy) === h.readUInt32LE(16),
    alternate: Number(h.readBigUInt64LE(32)),
    entriesAt: Number(h.readBigUInt64LE(72)),
    count: h.readUInt32LE(80),
    entrySize: h.readUInt32LE(84),
    entriesCrc: h.readUInt32LE(88),
  };
}

function gptVolumes(reader, lbaSize, notes) {
  let h = gptHeader(reader, 1, lbaSize);
  if (!h) return null;
  if (!h.ok) {
    // The backup header sits in the disk's last sector.
    const last = reader.size != null ? Math.floor(reader.size / lbaSize) - 1 : h.alternate;
    const b = last > 1 ? gptHeader(reader, last, lbaSize) : null;
    if (b && b.ok) {
      notes.push(t('The GPT header is damaged; its backup at the end of the disk was used.'));
      h = b;
    } else {
      notes.push(t('The GPT header fails its checksum; its entries were read as they are.'));
    }
  }
  if (h.entrySize < 128 || h.entrySize > 4096 || !h.count) return [];
  const count = Math.min(h.count, 1024);
  const table = reader.read(h.entriesAt * lbaSize, count * h.entrySize);
  if (count === h.count && crc32(table) !== h.entriesCrc) {
    notes.push(t('The GPT partition entries fail their checksum.'));
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    const e = table.subarray(i * h.entrySize, (i + 1) * h.entrySize);
    if (e.length < 128 || e.subarray(0, 16).every((x) => !x)) continue;
    const first = Number(e.readBigUInt64LE(32));
    const last = Number(e.readBigUInt64LE(40));
    if (!first || last < first) continue;
    const name = e.subarray(56, 128).toString('utf16le').replace(/\0[\s\S]*$/, '');
    const at = first * lbaSize;
    const size = (last - first + 1) * lbaSize;
    out.push({ index: i + 1, scheme: 'gpt', offset: at, size, type: guid(e.subarray(0, 16)), name, ...detect(reader, at) });
  }
  return out;
}

const EXTENDED = new Set([0x05, 0x0f, 0x85]);

/** The four entries of an MBR or extended boot record, or null when its status bytes say it is not one. */
function mbrEntries(s) {
  if (s.length < SECTOR || s[510] !== 0x55 || s[511] !== 0xaa) return null;
  const out = [];
  for (let i = 0; i < 4; i++) {
    const e = 446 + 16 * i;
    if (s[e] !== 0x00 && s[e] !== 0x80) return null;
    out.push({ type: s[e + 4], lba: s.readUInt32LE(e + 8), count: s.readUInt32LE(e + 12) });
  }
  return out;
}

function mbrVolumes(reader, entries) {
  const out = [];
  // MBR sector numbers are in the disk's sectors: 512 bytes, or 4096 on a disk with 4 KiB sectors.
  const locate = (lba) => {
    for (const size of [SECTOR, BLOCK]) {
      const d = detect(reader, lba * size);
      if (d.fs) return { size, d };
    }
    return { size: SECTOR, d: detect(reader, lba * SECTOR) };
  };
  const add = (index, type, lba, count) => {
    const { size, d } = locate(lba);
    out.push({ index, scheme: 'mbr', offset: lba * size, size: count * size, type, name: '', ...d });
  };
  entries.forEach((p, i) => {
    if (!p.type || !p.lba || !p.count) return;
    if (!EXTENDED.has(p.type)) {
      add(i + 1, p.type, p.lba, p.count);
      return;
    }
    // Logical partitions: each record's first entry is one, relative to the record; its second
    // leads to the next record, relative to the extended partition.
    const seen = new Set();
    let ebr = p.lba;
    for (let n = 5; n < 5 + 128 && !seen.has(ebr); n++) {
      seen.add(ebr);
      const rec = mbrEntries(reader.read(ebr * SECTOR, SECTOR));
      if (!rec) break;
      if (rec[0].type && rec[0].count) add(n, rec[0].type, ebr + rec[0].lba, rec[0].count);
      if (!EXTENDED.has(rec[1].type) || !rec[1].lba) break;
      ebr = p.lba + rec[1].lba;
    }
  });
  return out;
}

/**
 * The volumes on a disk or in an image: a bare volume, or the partitions of an MBR or a GPT. Each
 * is { index, scheme: 'none'|'mbr'|'gpt', offset, size, type, name, fs: 'fat'|'exfat'|'ntfs'|null,
 * bootAt, backup }; `size` is null when neither the table nor the reader gives one. When nothing is
 * recognised, the whole reader is one volume with fs null, for a caller to carve.
 * @returns {{ volumes: object[], notes: string[] }}
 */
function findVolumes(reader) {
  const notes = [];
  const s0 = reader.read(0, SECTOR);
  const whole = (d) => ({
    volumes: [{ index: 0, scheme: 'none', offset: 0, size: reader.size, type: null, name: '', ...d }],
    notes,
  });
  if (bootKind(s0)) return whole(detect(reader, 0));
  const entries = mbrEntries(s0);
  if (entries && entries.some((p) => p.type === 0xee)) {
    for (const lbaSize of [SECTOR, BLOCK]) {
      const gpt = gptVolumes(reader, lbaSize, notes);
      if (gpt) return { volumes: gpt, notes };
    }
  }
  if (entries && entries.some((p) => p.type && p.count)) return { volumes: mbrVolumes(reader, entries), notes };
  return whole(detect(reader, 0));
}

// ------------------------------------------------------------------ volumes

/** A set of cluster numbers, one bit each. */
class Bits {
  constructor(n) {
    this.b = new Uint8Array((n + 7) >> 3);
  }

  has(i) {
    return !!(this.b[i >> 3] & (1 << (i & 7)));
  }

  add(i) {
    this.b[i >> 3] |= 1 << (i & 7);
  }
}

/** Consecutive clusters as [first, count] runs. */
function runsOf(clusters) {
  const runs = [];
  for (const c of clusters) {
    const last = runs[runs.length - 1];
    if (last && last[0] + last[1] === c) last[1]++;
    else runs.push([c, 1]);
  }
  return runs;
}

class Volume {
  constructor(reader, offset) {
    this.reader = reader;
    this.offset = offset;
    this.notes = [];
    this.fatChunks = [];
  }

  /** Where cluster `c` starts in the reader. */
  clusterOffset(c) {
    return this.dataStart + (c - 2) * this.clusterSize;
  }

  /** Piece `k` of the FAT in use, read once. */
  fatChunk(k) {
    if (!this.fatChunks[k]) {
      const len = Math.max(0, Math.min(CHUNK, this.fatBytes - k * CHUNK));
      this.fatChunks[k] = this.reader.read(this.fatStart + k * CHUNK, len);
    }
    return this.fatChunks[k];
  }

  /**
   * The chain from `first`, at most `max` clusters long, and how it ended: 'end' at an end-of-chain
   * mark, or 'free', 'bad', 'loop', 'range' or 'limit' when it broke off.
   */
  chain(first, max) {
    const clusters = [];
    const seen = new Set();
    for (let c = first; ;) {
      if (c < 2 || c > this.clusterCount + 1) return { clusters, end: 'range' };
      if (seen.has(c)) return { clusters, end: 'loop' };
      if (clusters.length >= max) return { clusters, end: 'limit' };
      seen.add(c);
      clusters.push(c);
      const next = this.entry(c);
      const end = this.endOf(next);
      if (end) return { clusters, end };
      c = next;
    }
  }

  /** How many clusters are free. */
  freeClusters() {
    let n = 0;
    for (let c = 2; c < this.clusterCount + 2; c++) if (this.isFree(c)) n++;
    return n;
  }

  /** Whether the volume runs past the end of the image, so that part of it cannot be read. */
  get truncated() {
    return this.reader.size != null && this.offset + this.size > this.reader.size;
  }
}

class FatVolume extends Volume {
  constructor(reader, offset, g, backup) {
    super(reader, offset);
    this.type = g.type;
    this.fs = `FAT${g.type}`;
    this.sectorSize = g.bps;
    this.clusterSize = g.bps * g.spc;
    this.clusterCount = g.clusters;
    this.size = g.tot * g.bps;
    this.fatStart = offset + (g.rsvd + g.activeFat * g.fatsz) * g.bps;
    this.fatBytes = g.fatsz * g.bps;
    this.rootStart = offset + (g.rsvd + g.fats * g.fatsz) * g.bps;
    this.rootBytes = g.rootEnt * 32;
    this.dataStart = this.rootStart + g.rootSecs * g.bps;
    this.rootCluster = g.type === 32 ? g.rootCluster : 0;
    this.serial = g.serial == null ? null : g.serial;
    this.label = g.label && g.label !== 'NO NAME' ? g.label : '';
    this.eoc = { 12: 0xff8, 16: 0xfff8, 32: 0x0ffffff8 }[g.type];
    this.bad = this.eoc - 1;
    this.fromBackup = backup;
    if (backup) this.notes.push(t('The boot sector is damaged; its backup at sector 6 was used.'));
  }

  /** Cluster `c`'s entry in the FAT: 0 free, the next cluster, the bad-cluster mark or end of chain. */
  entry(c) {
    if (c < 0 || c > this.clusterCount + 1) return UNREADABLE;
    if (this.type === 12) {
      // FAT12 entries straddle bytes; its FAT is at most 6 KiB, and read whole.
      const f = this.fatChunk(0);
      const at = Math.floor(c * 1.5);
      if (at + 2 > f.length) return UNREADABLE;
      const v = f.readUInt16LE(at);
      return c & 1 ? v >> 4 : v & 0xfff;
    }
    const width = this.type / 8;
    const k = Math.floor((c * width) / CHUNK);
    const chunk = this.fatChunk(k);
    const at = c * width - k * CHUNK;
    if (at + width > chunk.length) return UNREADABLE;
    return width === 4 ? chunk.readUInt32LE(at) & 0x0fffffff : chunk.readUInt16LE(at);
  }

  endOf(next) {
    if (next >= this.eoc) return 'end';
    if (next === 0) return 'free';
    return next === this.bad || next === UNREADABLE ? 'bad' : null;
  }

  isFree(c) {
    return c >= 2 && c <= this.clusterCount + 1 && this.entry(c) === 0;
  }
}

class ExfatVolume extends Volume {
  constructor(reader, offset, f, backup, checksumOk) {
    super(reader, offset);
    this.fs = 'exFAT';
    this.sectorSize = f.bps;
    this.clusterSize = f.clusterSize;
    this.clusterCount = f.clusters;
    this.size = f.length * f.bps;
    // Bit 0 of the volume flags: the second FAT and bitmap are the ones in use.
    this.activeFat = f.fats === 2 && f.flags & 1 ? 1 : 0;
    this.fatStart = offset + (f.fatOffset + this.activeFat * f.fatLength) * f.bps;
    this.fatBytes = f.fatLength * f.bps;
    this.dataStart = offset + f.heapOffset * f.bps;
    this.rootCluster = f.rootCluster;
    this.serial = f.serial;
    this.label = '';
    this.fromBackup = backup;
    if (backup) this.notes.push(t('The boot region is damaged; its backup at sector 12 was used.'));
    if (!checksumOk) this.notes.push(t('The boot region fails its checksum; it was read as it is.'));
    this.bitmap = null;
    this.upcase = null;
  }

  entry(c) {
    if (c < 0 || c > this.clusterCount + 1) return UNREADABLE;
    const k = Math.floor((c * 4) / CHUNK);
    const chunk = this.fatChunk(k);
    const at = c * 4 - k * CHUNK;
    return at + 4 > chunk.length ? UNREADABLE : chunk.readUInt32LE(at);
  }

  endOf(next) {
    if (next === 0xffffffff) return 'end';
    if (next === 0) return 'free';
    return next === 0xfffffff7 || next === UNREADABLE ? 'bad' : null;
  }

  isFree(c) {
    if (c < 2 || c > this.clusterCount + 1) return false;
    const i = c - 2;
    return (i >> 3) < this.bitmap.length && !(this.bitmap[i >> 3] & (1 << (i & 7)));
  }

  /** The clusters an exFAT stream lies in: one run when it has no FAT chain, else its chain. */
  streamRuns(first, bytes, noFatChain, limit) {
    const n = Math.ceil(Math.min(bytes, limit) / this.clusterSize);
    if (!n || first < 2) return [];
    if (noFatChain) return [[first, Math.max(0, Math.min(n, this.clusterCount + 2 - first))]];
    return runsOf(this.chain(first, n).clusters);
  }
}

/**
 * The volume at `where` (an entry from findVolumes(), or { offset }) opened for reading its FAT or exFAT
 * file system. Throws when there is none.
 */
function openVolume(reader, where = {}) {
  const offset = where.offset || 0;
  const d = where.bootAt != null && where.fs ? where : detect(reader, offset);
  const boot = reader.read(d.bootAt, SECTOR);
  if (d.fs === 'fat') {
    const g = fatBpb(boot);
    if (g) return new FatVolume(reader, offset, g, d.backup);
  }
  if (d.fs === 'exfat') {
    const f = exfatBoot(boot);
    if (f) {
      let ok = exfatBootChecksumOk(reader, d.bootAt, f.bps);
      let backup = d.backup;
      let fields = f;
      if (!ok && !backup) {
        // A main region that fails its checksum gives way to a backup that passes.
        const b = exfatBoot(reader.read(offset + 12 * f.bps, SECTOR));
        if (b && exfatBootChecksumOk(reader, offset + 12 * f.bps, b.bps)) {
          fields = b;
          ok = true;
          backup = true;
        }
      }
      const vol = new ExfatVolume(reader, offset, fields, backup, ok);
      loadExfatRoot(vol);
      return vol;
    }
  }
  throw new Error(d.fs === 'ntfs'
    ? t('The volume at {0} is NTFS, which is not read here.', offset)
    : t('No FAT or exFAT file system at {0}.', offset));
}

/** Reads runs of clusters as one buffer, with where each byte of it lies in the reader. */
function readRuns(vol, runs, limit) {
  const parts = [];
  const at = [];
  let total = 0;
  for (const [c, n] of runs) {
    const len = Math.min(n * vol.clusterSize, limit - total);
    if (len <= 0) break;
    const b = vol.reader.read(vol.clusterOffset(c), len);
    at.push([total, vol.clusterOffset(c)]);
    parts.push(b);
    total += b.length;
    if (b.length < len) break;
  }
  const where = (i) => {
    let k = at.length - 1;
    while (k > 0 && at[k][0] > i) k--;
    return at[k][1] + (i - at[k][0]);
  };
  return { buf: Buffer.concat(parts), where };
}

// ------------------------------------------------------------------ FAT folders

// Long-name characters: 5 units @1, 6 @14, 2 @28.
const LFN_PARTS = [[1, 5], [14, 6], [28, 2]];
// Characters no short name holds; in a long name, these become "_" in the short one.
const SHORT_BAD = new Set([...'"*+,./:;<=>?[\\]|'].map((c) => c.charCodeAt(0)));
const LONG_REPLACED = new Set([...'+,;=[]']);

const isLongEntry = (e) => (e[11] & 0x3f) === 0x0f && e[12] === 0 && e.readUInt16LE(26) === 0;

/**
 * Whether the first byte of a deleted short name that the checksum gives is the one its long name
 * would have: the first character that is not a dot or a space, in upper case; "_" for one no short
 * name holds; for one beyond ASCII, "_" or a byte of the code page (0x05 standing for 0xE5).
 */
function firstByteFits(b, long) {
  const ch = long.replace(/^[. ]+/, '')[0];
  if (!ch) return b === 0x5f;
  if (ch.charCodeAt(0) >= 0x80) return b === 0x5f || b === 0x05 || b >= 0x80;
  if (LONG_REPLACED.has(ch)) return b === 0x5f;
  return b === ch.toUpperCase().charCodeAt(0);
}

/**
 * The long name the entries before a short one give it, or null when they are not its own. Only
 * the entries next to it, in its own state and with one checksum, can be: a deleted file's may be
 * left before a live one's. They are written backwards, so the one next to the short entry holds
 * the start of the name; the one holding its end -- numbered, and marked 0x40, while live -- has a
 * NUL after the name and 0xFFFF after that. A live short name must give their checksum; a deleted
 * one, whose first byte is gone, must have the one first byte that gives it be the byte the long
 * name calls for.
 * @returns {{ name: string, first?: number }|null}
 */
function longName(run, name11, deleted) {
  if (!run.length) return null;
  const sum = run[run.length - 1][13];
  let from = run.length;
  while (from > 0 && (run[from - 1][0] === 0xe5) === deleted && run[from - 1][13] === sum) from--;
  const own = run.slice(from).reverse();
  const units = [];
  let used = 0;
  while (used < own.length && used < 20) {
    const e = own[used];
    if (!deleted && (e[0] & 0x3f) !== used + 1) return null;
    for (const [at, n] of LFN_PARTS) for (let j = 0; j < n; j++) units.push(e.readUInt16LE(at + 2 * j));
    used++;
    if (deleted ? units.includes(0) : e[0] & 0x40) break;
  }
  if (!used || (!deleted && !(own[used - 1][0] & 0x40))) return null;
  let len = units.indexOf(0);
  if (len < 0) len = units.length;
  else if (units.slice(len + 1).some((u) => u !== 0xffff)) return null;
  if (!len || Math.ceil(len / 13) !== used) return null;
  const name = String.fromCharCode(...units.slice(0, len));
  if (/[\x00-\x1f"*/:<>?\\|]/.test(name) || /^\.\.?$/.test(name)) return null;
  if (!deleted) return lfnChecksum(name11) === sum ? { name } : null;
  const probe = Buffer.from(name11);
  for (let b = 0; b < 256; b++) {
    probe[0] = b;
    if (lfnChecksum(probe) === sum) return firstByteFits(b, name) ? { name, first: b } : null;
  }
  return null;
}

/** A short name's 11 bytes as a name, with the lowercase flags applied to its ASCII letters. */
function shortNameOf(bytes, flags, decode) {
  const lower = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  let base = decode(bytes.subarray(0, 8)).replace(/ +$/, '');
  let ext = decode(bytes.subarray(8, 11)).replace(/ +$/, '');
  if (flags & 0x08) base = lower(base);
  if (flags & 0x10) ext = lower(ext);
  return ext ? `${base}.${ext}` : base;
}

/**
 * Whether a slot in a deleted folder's cluster still looks like a short entry: reserved attribute
 * bits clear, known lowercase flags, name bytes a short name may hold, real dates or none. Once the
 * cluster holds something else -- the folder's space was reused -- reading stops.
 */
function plausibleShort(e) {
  if (e[11] & 0xc0 || e[12] & ~0x18) return false;
  if (e[0] !== 0xe5 && e[0] !== 0x05 && (e[0] < 0x20 || SHORT_BAD.has(e[0]))) return false;
  for (let k = 1; k < 11; k++) if (e[k] < 0x20 || SHORT_BAD.has(e[k])) return false;
  if (e[11] & 0x10 && e.readUInt32LE(28)) return false;
  for (const [d, tm] of [[16, 14], [24, 22]]) {
    if (e.readUInt16LE(d) && !dosStamp(e.readUInt16LE(d), e.readUInt16LE(tm))) return false;
  }
  return true;
}

/**
 * The entries in one FAT folder's bytes. `where(i)` says where byte i lies in the reader. With
 * `strict`, for a deleted folder's cluster, reading stops at the first slot that is not an entry.
 * @returns {{ entries: object[], ended: boolean, label: string|null }}
 */
function fatEntries(vol, buf, where, decode, strict) {
  const entries = [];
  let run = [];
  let label = null;
  for (let i = 0; i + 32 <= buf.length; i += 32) {
    const e = buf.subarray(i, i + 32);
    if (e[0] === 0x00) return { entries, ended: true, label };
    if (isLongEntry(e)) {
      run.push(e);
      continue;
    }
    const before = run;
    run = [];
    if (strict && !plausibleShort(e) && !(e[0] === 0x2e)) return { entries, ended: true, label };
    const deleted = e[0] === 0xe5;
    if ((e[11] & 0x18) === 0x08) {
      if (!deleted && !(e[11] & 0x10)) label = decode(e.subarray(0, 11)).trim();
      continue;
    }
    if (!deleted && e[0] === 0x2e) continue; // "." and ".."
    const bytes = Buffer.from(e.subarray(0, 11));
    if (bytes[0] === 0x05 && !deleted) bytes[0] = 0xe5;
    const long = longName(before, bytes, deleted);
    let nameCertain = true;
    if (deleted) {
      if (long) {
        bytes[0] = long.first === 0x05 ? 0xe5 : long.first;
      } else {
        bytes[0] = 0x5f;
        nameCertain = false;
      }
    }
    const shortName = shortNameOf(bytes, e[12], decode);
    const hi = vol.type === 32 ? e.readUInt16LE(20) : 0;
    const lo = e.readUInt16LE(26);
    const tenth = e[13];
    entries.push({
      name: long ? long.name : shortName,
      shortName,
      nameCertain,
      dir: !!(e[11] & 0x10),
      attr: e[11],
      size: e[11] & 0x10 ? 0 : e.readUInt32LE(28),
      hi,
      lo,
      first: hi * 0x10000 + lo,
      created: dosStamp(e.readUInt16LE(16), e.readUInt16LE(14), tenth * 10),
      modified: dosStamp(e.readUInt16LE(24), e.readUInt16LE(22)),
      accessed: dosStamp(e.readUInt16LE(18), 0),
      deleted,
      at: where(i),
    });
  }
  return { entries, ended: false, label };
}

/**
 * Where a deleted FAT file or folder may have started. Windows clears the high half of a FAT32
 * first cluster on delete, so on a volume of more than 65,536 clusters a high half of 0 leaves the
 * low half plus any multiple of 65,536; elsewhere the start is as recorded.
 */
function fatStarts(vol, e) {
  if (!(vol.type === 32 && e.hi === 0 && vol.clusterCount + 2 > 0x10000)) return { starts: [e.first], certain: true };
  const starts = [];
  for (let s = e.lo; s <= vol.clusterCount + 1; s += 0x10000) if (s >= 2) starts.push(s);
  return { starts, certain: starts.length === 1 };
}

const dotField = (b, at, vol) => (vol.type === 32 ? b.readUInt16LE(at + 20) * 0x10000 : 0) + b.readUInt16LE(at + 26);

/**
 * The first cluster of a deleted folder: the one start, among those it may have had, that is free
 * and begins with "." naming itself and ".." naming the folder it was in. Null when none or several do.
 */
function deletedFolderStart(vol, e, parent) {
  const found = [];
  for (const s of fatStarts(vol, e).starts) {
    if (!vol.isFree(s)) continue;
    const head = vol.reader.read(vol.clusterOffset(s), 64);
    if (head.length < 64 || head.toString('latin1', 0, 11) !== '.          ') continue;
    if (head.toString('latin1', 32, 43) !== '..         ' || !(head[11] & 0x10) || !(head[43] & 0x10)) continue;
    if (dotField(head, 0, vol) !== s) continue;
    const up = dotField(head, 32, vol);
    // A folder in the root names it 0; some systems name FAT32's root cluster instead.
    if (parent.root ? up !== 0 && up !== vol.rootCluster : up !== parent.first) continue;
    found.push(s);
  }
  return found.length === 1 ? found[0] : null;
}

/**
 * Every entry of a FAT volume: live folders are followed by their chains, and a deleted folder by
 * its first cluster alone, since its chain is gone and a folder's later clusters are seldom next
 * to its first.
 */
function walkFat(vol, decode) {
  const all = [];
  const stats = { deletedFolders: 0, deletedFoldersRead: 0, deletedFoldersCut: 0 };
  let label = null;
  const seen = new Set();
  const maxClusters = Math.ceil(FAT_DIR_LIMIT / vol.clusterSize);
  const root = { root: true, first: vol.type === 32 ? vol.rootCluster : 0, path: '', deleted: false, depth: 0 };
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let bytes;
    if (d.root && vol.type !== 32) {
      const buf = vol.reader.read(vol.rootStart, vol.rootBytes);
      bytes = { buf, where: (i) => vol.rootStart + i };
    } else if (d.deleted) {
      bytes = readRuns(vol, [[d.first, 1]], vol.clusterSize);
    } else {
      bytes = readRuns(vol, runsOf(vol.chain(d.first, maxClusters).clusters), FAT_DIR_LIMIT);
    }
    const got = fatEntries(vol, bytes.buf, bytes.where, decode, d.deleted);
    if (d.root) label = got.label;
    if (d.deleted && !got.ended) stats.deletedFoldersCut++;
    for (const e of got.entries) {
      e.path = d.path ? `${d.path}\\${e.name}` : e.name;
      e.inDeletedFolder = d.deleted;
      all.push(e);
      if (!e.dir || d.depth >= MAX_DEPTH) continue;
      const gone = e.deleted || d.deleted;
      if (gone) stats.deletedFolders++;
      const first = gone ? deletedFolderStart(vol, e, d) : e.first;
      if (first == null || first < 2 || seen.has(first)) continue;
      if (gone) {
        e.first = first;
        e.startResolved = true;
        stats.deletedFoldersRead++;
      }
      seen.add(first);
      stack.push({ first, path: e.path, deleted: gone, depth: d.depth + 1 });
    }
  }
  return { all, stats, label };
}

// ------------------------------------------------------------------ exFAT folders

/** The up-case table from its compressed form, where 0xFFFF and a count skip that many characters. */
function upcaseTable(buf) {
  const map = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) map[i] = i;
  let at = 0;
  for (let i = 0; i + 1 < buf.length && at < 65536; i += 2) {
    const u = buf.readUInt16LE(i);
    if (u === 0xffff && i + 3 < buf.length) {
      at += buf.readUInt16LE(i + 2);
      i += 2;
    } else {
      map[at++] = u;
    }
  }
  return map;
}

/** ASCII letters, and what else upper-cases to one character, when a volume's own table cannot be read. */
function defaultUpcase() {
  const map = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) {
    const u = i >= 0xd800 && i < 0xe000 ? String.fromCharCode(i) : String.fromCharCode(i).toUpperCase();
    map[i] = u.length === 1 ? u.charCodeAt(0) : i;
  }
  return map;
}

/**
 * The entry sets in one exFAT folder's bytes, live and deleted, and the root's bitmap, up-case and
 * label entries. A set is taken only as a whole: a stream extension, then its name entries, then
 * any other secondary entries, all live or all deleted. `checksum` says how its checksum matched:
 * 'ok' (live), 'restored' (deleted, with the InUse bits put back), 'as stored' (a driver that
 * recomputed it), or null (it does not).
 */
function exfatSets(buf, where) {
  const sets = [];
  const special = { bitmaps: [], upcase: null, label: null };
  for (let i = 0; i + 32 <= buf.length; i += 32) {
    const type = buf[i];
    if (type === 0x00) break;
    const where32 = () => ({ first: buf.readUInt32LE(i + 20), bytes: Number(buf.readBigUInt64LE(i + 24)) });
    if (type === 0x81) special.bitmaps.push({ which: buf[i + 1] & 1, ...where32() });
    if (type === 0x82) special.upcase = { sum: buf.readUInt32LE(i + 4), ...where32() };
    if (type === 0x83) special.label = buf.toString('utf16le', i + 2, i + 2 + 2 * Math.min(buf[i + 1], 11));
    if ((type & 0x7f) !== 0x05) continue;
    const live = !!(type & 0x80);
    const count = buf[i + 1];
    if (count < 2 || count > 18 || i + 32 * (count + 1) > buf.length) continue;
    const set = buf.subarray(i, i + 32 * (count + 1));
    const same = (k, code) => (set[32 * k] & 0x7f) === code && !!(set[32 * k] & 0x80) === live;
    if (!same(1, 0x40)) continue;
    const s = set.subarray(32, 64);
    const nameLength = s[3];
    const names = Math.ceil(nameLength / 15);
    if (!nameLength || names > count - 1) continue;
    let ok = true;
    for (let k = 2; k < 2 + names; k++) if (!same(k, 0x41)) ok = false;
    // Whatever follows the names must be secondary entries (bit 6) in the same state.
    for (let k = 2 + names; k <= count; k++) if (!(set[32 * k] & 0x40) || !!(set[32 * k] & 0x80) !== live) ok = false;
    if (!ok) continue;
    let name = '';
    for (let k = 0; k < names; k++) name += set.toString('utf16le', 64 + 32 * k + 2, 64 + 32 * k + 32);
    name = name.slice(0, nameLength);
    const stored = set.readUInt16LE(2);
    let checksum = null;
    if (live) {
      checksum = setChecksum(set) === stored ? 'ok' : null;
    } else {
      const restored = Buffer.from(set);
      for (let k = 0; k <= count; k++) restored[32 * k] |= 0x80;
      if (setChecksum(restored) === stored) checksum = 'restored';
      else if (setChecksum(set) === stored) checksum = 'as stored';
    }
    sets.push({
      name,
      nameHash: s.readUInt16LE(4),
      dir: !!(set.readUInt16LE(4) & 0x10),
      attr: set.readUInt16LE(4),
      allocationPossible: !!(s[1] & 1),
      noFatChain: !!(s[1] & 2),
      validSize: Number(s.readBigUInt64LE(8)),
      first: s.readUInt32LE(20),
      size: Number(s.readBigUInt64LE(24)),
      created: exfatStamp(set.readUInt32LE(8), set[20], set[22]),
      modified: exfatStamp(set.readUInt32LE(12), set[21], set[23]),
      accessed: exfatStamp(set.readUInt32LE(16), 0, set[24]),
      deleted: !live,
      checksum,
      at: where(i),
    });
    i += 32 * count;
  }
  return { sets, ...special };
}

function exfatStamp(ts, tens, offset) {
  return dosStamp(ts >>> 16, ts & 0xffff, tens * 10, utcOffset(offset));
}

/** Reads the root folder's allocation bitmap, up-case table and label, which everything else needs. */
function loadExfatRoot(vol) {
  const runs = runsOf(vol.chain(vol.rootCluster, Math.ceil(EXFAT_DIR_LIMIT / vol.clusterSize)).clusters);
  const { buf } = readRuns(vol, runs, EXFAT_DIR_LIMIT);
  const got = exfatSets(buf, (i) => i);
  // With two FATs (TexFAT), each has its bitmap; flag bit 0 says which.
  const bm = got.bitmaps.find((b) => b.which === vol.activeFat) || got.bitmaps[0];
  if (!bm) throw new Error(t('The exFAT volume at {0} has no allocation bitmap.', vol.offset));
  // Both are laid out in one piece from their first cluster, which is how Linux reads them too.
  vol.bitmap = vol.reader.read(vol.clusterOffset(bm.first), Math.min(bm.bytes, Math.ceil(vol.clusterCount / 8)));
  if (vol.bitmap.length * 8 < vol.clusterCount) vol.notes.push(t('The allocation bitmap could not be read whole.'));
  const up = got.upcase;
  const table = up ? vol.reader.read(vol.clusterOffset(up.first), Math.min(up.bytes, 128 * 1024)) : null;
  if (table && table.length === up.bytes && exfatSum32(table) === up.sum) {
    vol.upcase = upcaseTable(table);
  } else {
    vol.upcase = defaultUpcase();
    vol.notes.push(t('The up-case table could not be read or fails its checksum; names were hashed by the usual one.'));
  }
  vol.label = got.label || '';
}

/** Every entry set of an exFAT volume, following folders -- live or deleted -- by their clusters. */
function walkExfat(vol) {
  const all = [];
  const stats = { deletedFolders: 0, deletedFoldersRead: 0, deletedFoldersCut: 0 };
  const seen = new Set([vol.rootCluster]);
  const maxClusters = Math.ceil(EXFAT_DIR_LIMIT / vol.clusterSize);
  const root = runsOf(vol.chain(vol.rootCluster, maxClusters).clusters);
  const stack = [{ runs: root, path: '', deleted: false, depth: 0 }];
  while (stack.length) {
    const d = stack.pop();
    const { buf, where } = readRuns(vol, d.runs, EXFAT_DIR_LIMIT);
    for (const e of exfatSets(buf, where).sets) {
      e.path = d.path ? `${d.path}\\${e.name}` : e.name;
      e.inDeletedFolder = d.deleted;
      all.push(e);
      if (!e.dir) continue;
      const gone = e.deleted || d.deleted;
      if (gone) stats.deletedFolders++;
      if (d.depth >= MAX_DEPTH || e.first < 2 || seen.has(e.first)) continue;
      if (gone) {
        // A deleted folder is read only from clusters nothing uses now, and only when its set is sound.
        if (!e.checksum) continue;
        const x = exfatExtent(vol, e);
        if (!x.runs.length || x.problems.length || !x.runs.every(([c, n]) => allFree(vol, c, n))) continue;
        stats.deletedFoldersRead++;
        seen.add(e.first);
        stack.push({ runs: x.runs, path: e.path, deleted: true, depth: d.depth + 1 });
      } else {
        seen.add(e.first);
        const runs = vol.streamRuns(e.first, e.size, e.noFatChain, EXFAT_DIR_LIMIT);
        stack.push({ runs, path: e.path, deleted: false, depth: d.depth + 1 });
      }
    }
  }
  return { all, stats };
}

function allFree(vol, first, n) {
  for (let c = first; c < first + n; c++) if (!vol.isFree(c)) return false;
  return true;
}

// ------------------------------------------------------------------ extents

/**
 * Where a deleted file's bytes lie, as far as it is known.
 *   how        'recorded' (exFAT, no FAT chain), 'chain' (a chain still in the FAT), 'one cluster',
 *              'contiguous' (assumed), 'skipping clusters in use' (assumed, around live files),
 *              'empty' (nothing to read)
 *   complete   its clusters are known rather than assumed
 *   runs       [[first cluster, count], ...] in file order
 *   spans      [[offset in the reader, length], ...] covering the first `validSize` bytes
 *   validSize  bytes stored; from there to `size` the file reads as zeros (exFAT)
 *   problems   why it cannot be taken; empty when it can
 */
function extent(vol, how, complete, runs, size, validSize) {
  const spans = [];
  let left = validSize;
  for (const [c, n] of runs) {
    if (left <= 0) break;
    const len = Math.min(n * vol.clusterSize, left);
    spans.push([vol.clusterOffset(c), len]);
    left -= len;
  }
  const start = runs.length ? runs[0][0] : null;
  const x = { how, complete, start, runs, spans, size, validSize, problems: [], codes: [] };
  const end = spans.length ? spans[spans.length - 1][0] + spans[spans.length - 1][1] : 0;
  if (vol.reader.size != null && end > vol.reader.size) problem(x, 'damaged', t('it lies past the end of the image'));
  return x;
}

function problem(x, code, text) {
  x.codes.push(code);
  x.problems.push(text);
}

/** How many of `n` clusters from `first` are in use now. */
function inUse(vol, first, n) {
  let used = 0;
  for (let c = first; c < first + n; c++) if (!vol.isFree(c)) used++;
  return used;
}

/**
 * One start a deleted FAT file may have had. A chain some other system left in the FAT is taken
 * when it is exactly as long as the size needs, ends there, and runs through no cluster a live file
 * uses. Otherwise the clusters from the start are assumed, and refused when any of them is in use
 * or another entry's first cluster lies among them.
 */
function fatCandidate(vol, e, s, n, ctx, certain) {
  if (vol.entry(s) !== 0) {
    const ch = vol.chain(s, n + 1);
    if (ch.end === 'end' && ch.clusters.length === n && !ch.clusters.some((c) => ctx.live.has(c))) {
      return extent(vol, 'chain', true, runsOf(ch.clusters), e.size, e.size);
    }
  }
  const x = extent(vol, n === 1 ? 'one cluster' : 'contiguous', n === 1 && certain, [[s, n]], e.size, e.size);
  if (s + n - 1 > vol.clusterCount + 1) {
    problem(x, 'damaged', t('it would run past the end of the volume'));
    return x;
  }
  const used = inUse(vol, s, n);
  if (used) problem(x, 'overwritten', t('{0} of its {1} cluster(s) are in use now', used, n));
  for (let c = s + 1; c < s + n; c++) {
    const other = ctx.starts.get(c);
    if (other && other !== e) {
      problem(x, 'fragmented',
        t('the deleted {0} starts at cluster {1}, inside it, so it was not in one piece', other.path, c));
      break;
    }
  }
  return x;
}

/**
 * The Sleuth Kit's way with a file whose clusters are partly in use (tsk/fs/fatfs_meta.c): from its
 * start, take the free clusters only, skipping those in use, as many as its size needs. It is a
 * guess about a file in pieces, worth reading only when the content checks out. None when its
 * first cluster is in use, or when a deleted file's first cluster is among those it would take.
 */
function skippingInUse(vol, e, s, n, ctx) {
  if (!vol.isFree(s)) return null;
  const clusters = [];
  for (let c = s; clusters.length < n && c <= vol.clusterCount + 1; c++) {
    if (!vol.isFree(c)) continue;
    const other = ctx.starts.get(c);
    if (c !== s && other && other !== e) return null;
    clusters.push(c);
  }
  if (clusters.length < n) return null;
  return extent(vol, 'skipping clusters in use', false, runsOf(clusters), e.size, e.size);
}

/** The public form of an entry, before it is judged. */
function entryOf(e) {
  return {
    path: e.path,
    name: e.name,
    shortName: e.shortName == null ? null : e.shortName,
    nameCertain: e.nameCertain !== false,
    size: e.size,
    firstCluster: e.first,
    attributes: e.attr,
    created: e.created,
    modified: e.modified,
    accessed: e.accessed,
    inDeletedFolder: !!e.inDeletedFolder,
    at: e.at,
    status: null,
    extent: null,
    candidates: [],
    fallback: null,
    movedTo: null,
    notes: [],
    written: writtenAt(e),
  };
}

/** Settles an entry's status from the starts it may have had. */
function settle(out, candidates, certain) {
  out.candidates = candidates;
  const usable = candidates.filter((x) => !x.problems.length);
  if (usable.length === 1) {
    out.extent = usable[0];
    if (!certain) {
      // Chosen because the others were ruled out, not because it was recorded.
      out.extent.complete = false;
      out.notes.push(t('the high half of its first cluster was cleared when it was deleted; '
        + '{0} other possible start(s) were ruled out', candidates.length - 1));
    }
    out.status = out.extent.complete ? 'complete' : 'assumed';
  } else if (usable.length > 1) {
    out.status = 'ambiguous';
    out.notes.push(t('the high half of its first cluster was cleared when it was deleted; {0} possible starts fit',
      usable.length));
  } else {
    out.status = candidates.length ? candidates[0].codes[0] : 'damaged';
  }
}

function judgeFat(vol, all) {
  const live = new Bits(vol.clusterCount + 2);
  const mark = (first) => {
    for (let c = first, k = 0; c >= 2 && c <= vol.clusterCount + 1 && !live.has(c) && k <= vol.clusterCount; k++) {
      live.add(c);
      const next = vol.entry(c);
      if (next === 0 || next >= vol.bad || next === UNREADABLE) break;
      c = next;
    }
  };
  if (vol.type === 32) mark(vol.rootCluster);
  // Where live files start, and where deleted ones certainly did. A live file inside an assumed
  // extent already shows as clusters in use; a deleted one's start is what shows it was in pieces.
  const liveAt = new Map();
  const starts = new Map();
  for (const e of all) {
    if (e.first < 2) continue;
    if (!e.deleted && !e.inDeletedFolder) {
      mark(e.first);
      liveAt.set(e.first, e);
    } else if ((e.startResolved || fatStarts(vol, e).certain) && !starts.has(e.first)) {
      starts.set(e.first, e);
    }
  }
  const ctx = { live, starts };
  const out = [];
  for (const e of all) {
    if (e.dir || !(e.deleted || e.inDeletedFolder)) continue;
    const o = entryOf(e);
    out.push(o);
    if (!e.size) {
      o.status = 'empty';
      o.extent = extent(vol, 'empty', true, [], 0, 0);
      continue;
    }
    const { starts: may, certain } = fatStarts(vol, e);
    const moved = may.map((s) => liveAt.get(s)).find((l) => l && !l.dir && l.size === e.size);
    if (moved) {
      o.status = 'moved';
      o.movedTo = moved.path;
      continue;
    }
    const n = Math.ceil(e.size / vol.clusterSize);
    const candidates = may.filter((s) => s >= 2 && s <= vol.clusterCount + 1)
      .map((s) => fatCandidate(vol, e, s, n, ctx, certain));
    if (!candidates.length) {
      o.status = 'damaged';
      o.notes.push(t('its first cluster lies outside the volume'));
      continue;
    }
    settle(o, candidates, certain);
    if (certain && o.status === 'overwritten' && candidates[0].codes.every((c) => c === 'overwritten')) {
      o.fallback = skippingInUse(vol, e, may[0], n, ctx);
    }
  }
  return out;
}

/**
 * One deleted exFAT file's clusters: recorded when it had no FAT chain, its old chain when that
 * still runs exactly as far as its size and ends there, and otherwise assumed from its first
 * cluster on.
 */
function exfatExtent(vol, e) {
  const n = Math.ceil(e.size / vol.clusterSize);
  const valid = Math.min(e.validSize, e.size);
  const bad = (text) => {
    const x = extent(vol, 'contiguous', false, [], e.size, valid);
    problem(x, 'damaged', text);
    return x;
  };
  if (e.validSize > e.size) return bad(t('its entry says more of it is valid than it holds'));
  if (!e.allocationPossible || e.first < 2 || e.first > vol.clusterCount + 1) {
    return bad(t('its first cluster lies outside the volume'));
  }
  if (e.noFatChain) {
    if (e.first + n - 1 > vol.clusterCount + 1) return bad(t('it would run past the end of the volume'));
    return extent(vol, 'recorded', true, [[e.first, n]], e.size, valid);
  }
  const ch = vol.chain(e.first, n + 1);
  if (ch.end === 'end' && ch.clusters.length === n) {
    return extent(vol, 'chain', true, runsOf(ch.clusters), e.size, valid);
  }
  if (e.first + n - 1 > vol.clusterCount + 1) return bad(t('it would run past the end of the volume'));
  return extent(vol, 'contiguous', false, [[e.first, n]], e.size, valid);
}

function judgeExfat(vol, all) {
  const liveAt = new Map();
  for (const e of all) if (!e.deleted && !e.inDeletedFolder && e.first >= 2) liveAt.set(`${e.first}/${e.size}`, e);
  const out = [];
  for (const e of all) {
    if (e.dir || !(e.deleted || e.inDeletedFolder)) continue;
    const o = entryOf(e);
    out.push(o);
    if (!e.checksum) {
      o.status = 'damaged';
      o.notes.push(t('its entry fails its checksum: it was changed after the file was deleted'));
      continue;
    }
    if (e.checksum === 'as stored') {
      o.notes.push(t('its checksum was recomputed when it was deleted, which Windows and Linux do not do'));
    }
    if (nameHash(e.name, vol.upcase) !== e.nameHash) o.notes.push(t('its name hash does not match its name'));
    if (!e.size) {
      o.status = 'empty';
      o.extent = extent(vol, 'empty', true, [], 0, 0);
      continue;
    }
    const twin = liveAt.get(`${e.first}/${e.size}`);
    if (twin) {
      o.status = 'moved';
      o.movedTo = twin.path;
      continue;
    }
    const x = exfatExtent(vol, e);
    if (!x.problems.length) {
      const total = x.runs.reduce((a, r) => a + r[1], 0);
      const used = x.runs.reduce((a, [c, n]) => a + inUse(vol, c, n), 0);
      if (used) problem(x, 'overwritten', t('{0} of its {1} cluster(s) are in use now', used, total));
    }
    settle(o, [x], true);
    if (x.validSize < x.size) {
      o.notes.push(t('only its first {0} byte(s) were written; the rest reads as zeros', x.validSize));
    }
  }
  return out;
}

/**
 * Deleted files taken to lie in the same clusters. The one written there later -- when its clusters
 * are known, not assumed -- overwrote the other; otherwise both keep a note, since at most one of
 * them can be right there.
 */
function overlaps(entries) {
  const runs = [];
  for (const o of entries) {
    if (!o.extent) continue;
    for (const [c, n] of o.extent.runs) runs.push([c, c + n - 1, o]);
  }
  runs.sort((a, b) => a[0] - b[0]);
  const pairs = new Map();
  const active = [];
  for (const r of runs) {
    for (let i = active.length - 1; i >= 0; i--) if (active[i][1] < r[0]) active.splice(i, 1);
    for (const a of active) {
      if (a[2] === r[2]) continue;
      const [one, two] = a[2].at < r[2].at ? [a[2], r[2]] : [r[2], a[2]];
      const lo = Math.max(a[0], r[0]);
      const hi = Math.min(a[1], r[1]);
      const k = one.at + '/' + two.at;
      const prev = pairs.get(k) || { a: one, b: two, lo, hi };
      pairs.set(k, { a: one, b: two, lo: Math.min(prev.lo, lo), hi: Math.max(prev.hi, hi) });
    }
    active.push(r);
  }
  const fall = [];
  for (const { a, b, lo, hi } of pairs.values()) {
    const known = a.written != null && b.written != null && a.written !== b.written;
    const later = known ? (a.written > b.written ? a : b) : null;
    if (later && later.extent.complete) {
      fall.push([later === a ? b : a, later]);
      continue;
    }
    a.notes.push(t('clusters {0}-{1} are also where the deleted {2} is taken to lie', lo, hi, b.path));
    b.notes.push(t('clusters {0}-{1} are also where the deleted {2} is taken to lie', lo, hi, a.path));
  }
  for (const [o, by] of fall) {
    if (!o.extent) continue;
    problem(o.extent, 'overwritten', t('{0}, deleted too, was written over it later', by.path));
    o.extent = null;
    o.status = 'overwritten';
  }
}

/**
 * Every deleted file on a volume from openVolume(), judged.
 * @param {object} [options]
 * @param {string} [options.oem]  the code page of FAT short names, as a TextDecoder label; 437 by default
 * @returns {{ deleted: object[], stats: object, notes: string[] }} `deleted` holds, for each file:
 *   path (inside the volume, "\"-separated), name, shortName (FAT), nameCertain (false when a FAT
 *   short name's lost first character was put back as "_"), size, firstCluster (as recorded),
 *   attributes, created / modified / accessed ({ ms, wall, offset } or null), inDeletedFolder, at
 *   (where its entry lies in the reader), written (the later of created and modified, in ms),
 *   status, extent, candidates, fallback, movedTo and notes. `status` is one of:
 *     complete     its clusters are known and none is in use now: read `extent`
 *     assumed      its clusters are assumed from its first one and none is in use now: read `extent`
 *     ambiguous    several starts fit (FAT32 deleted by Windows): tell `candidates` apart by content
 *     overwritten  some of its clusters are in use now, or another deleted file was written over it;
 *                  `fallback` may still hold it, if its content checks out
 *     fragmented   another deleted file's first cluster lies inside where it would be
 *     moved        a live file has its first cluster and size: it was renamed or moved (`movedTo`)
 *     damaged      its entry does not hold together
 *     empty        it held nothing
 */
function scanVolume(vol, options = {}) {
  const deletedFiles = [];
  let walked;
  if (vol instanceof FatVolume) {
    walked = walkFat(vol, oemDecoder(options.oem));
    if (walked.label) vol.label = walked.label;
    deletedFiles.push(...judgeFat(vol, walked.all));
  } else {
    walked = walkExfat(vol);
    deletedFiles.push(...judgeExfat(vol, walked.all));
  }
  overlaps(deletedFiles);
  const notes = vol.notes.slice();
  if (vol.truncated) notes.push(t('The image ends before the volume does; what lies past its end cannot be read.'));
  const stats = {
    files: walked.all.filter((e) => !e.dir && !e.deleted && !e.inDeletedFolder).length,
    folders: walked.all.filter((e) => e.dir && !e.deleted && !e.inDeletedFolder).length,
    deletedFiles: deletedFiles.length,
    ...walked.stats,
    byStatus: {},
  };
  for (const o of deletedFiles) {
    stats.byStatus[o.status] = (stats.byStatus[o.status] || 0) + 1;
    for (const x of o.candidates) delete x.codes;
    if (o.fallback) delete o.fallback.codes;
    if (o.extent) delete o.extent.codes;
  }
  if (walked.stats.deletedFoldersCut) {
    notes.push(t('{0} deleted folder(s) fill their first cluster; entries they held beyond it are lost',
      walked.stats.deletedFoldersCut));
  }
  return { deleted: deletedFiles, stats, notes };
}

/**
 * Every volume in a reader, and on each FAT or exFAT one the deleted files: findVolumes() and
 * scanVolume() in one call. A volume that cannot be read says why in `error`.
 */
function scan(reader, options = {}) {
  const found = findVolumes(reader);
  return {
    notes: found.notes,
    volumes: found.volumes.map((part) => {
      const none = { ...part, volume: null, deleted: [], stats: null, notes: [] };
      if (part.fs !== 'fat' && part.fs !== 'exfat') return none;
      try {
        const volume = openVolume(reader, part);
        return { ...part, volume, ...scanVolume(volume, options) };
      } catch (e) {
        return { ...none, error: e.message };
      }
    }),
  };
}

// ------------------------------------------------------------------ reading a deleted file

/**
 * A reader over one deleted file's bytes as an extent lays them out -- what a content check reads.
 * Past `validSize` the file reads as zeros.
 */
function extentReader(reader, x) {
  const pieces = [];
  let at = 0;
  for (const [off, len] of x.spans) {
    pieces.push([at, off, len]);
    at += len;
  }
  const plan = (off, len) => {
    const end = Math.min(x.size, off + len);
    const parts = [];
    for (let p = Math.max(0, off); p < end;) {
      const piece = pieces.find(([from, , n]) => p >= from && p < from + n);
      if (!piece) {
        parts.push({ zeros: end - p });
        break;
      }
      const n = Math.min(piece[0] + piece[2], end) - p;
      parts.push({ off: piece[1] + (p - piece[0]), len: n });
      p += n;
    }
    return parts;
  };
  const join = (parts, bufs) => Buffer.concat(parts.map((q, i) => (q.zeros ? Buffer.alloc(q.zeros) : bufs[i])));
  return {
    size: x.size,
    read(off, len) {
      const parts = plan(off, len);
      return join(parts, parts.map((q) => (q.zeros ? null : reader.read(q.off, q.len))));
    },
    async readAsync(off, len) {
      const parts = plan(off, len);
      const get = (q) => (reader.readAsync ? reader.readAsync(q.off, q.len) : reader.read(q.off, q.len));
      return join(parts, await Promise.all(parts.map((q) => (q.zeros ? null : get(q)))));
    },
  };
}

/**
 * The bytes of a deleted file from `start` to `end`, both included, as fs.createReadStream counts
 * them, read a piece at a time so that a video of any size can be written out. A read that comes
 * back short -- an image that ends early, a card pulled out -- ends the stream with an error rather
 * than leaving a file shorter than it was.
 */
function streamExtent(reader, x, { start = 0, end = Infinity, chunk = CHUNK } = {}) {
  const src = extentReader(reader, x);
  const stop = Math.min(x.size, end + 1);
  let at = Math.max(0, start);
  return new Readable({
    highWaterMark: chunk,
    read() {
      if (at >= stop) {
        this.push(null);
        return;
      }
      const n = Math.min(chunk, stop - at);
      src.readAsync(at, n).then((b) => {
        if (b.length < n) {
          this.destroy(new Error(t('Only {0} of {1} byte(s) could be read at {2}.', b.length, n, at)));
          return;
        }
        at += n;
        this.push(b);
      }, (e) => this.destroy(e));
    },
  });
}

/**
 * Runs of free clusters that no deleted file with an extent is taken to lie in: where a carver
 * looks for what has no entry left. Yields [first cluster, count].
 */
function* freeRuns(vol, deleted = []) {
  const claimed = new Bits(vol.clusterCount + 2);
  for (const o of deleted) {
    if (o.extent) for (const [c, n] of o.extent.runs) for (let k = c; k < c + n; k++) claimed.add(k);
  }
  let run = null;
  for (let c = 2; c <= vol.clusterCount + 1; c++) {
    if (vol.isFree(c) && !claimed.has(c)) {
      if (run) run[1]++;
      else run = [c, 1];
    } else if (run) {
      yield run;
      run = null;
    }
  }
  if (run) yield run;
}

module.exports = {
  openReader,
  memoryReader,
  findVolumes,
  openVolume,
  scanVolume,
  scan,
  extentReader,
  streamExtent,
  freeRuns,
  FatVolume,
  ExfatVolume,
  _internal: {
    lfnChecksum, exfatSum32, setChecksum, nameHash, crc32, crc32Table, dosStamp, utcOffset, fatBpb, exfatBoot,
    exfatBootChecksumOk, bootKind, detect, longName, firstByteFits, fatEntries, exfatSets, upcaseTable, defaultUpcase,
    oemDecoder, CP437, runsOf,
  },
};
