'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { Readable } = require('stream');
const { t } = require('./i18n');

// A found copy keeps its content in one of five ways:
//   file     a path to a file on disk that holds the bytes (Recycle Bin, Local History, backups)
//   text     the content itself, as a transcript recorded it
//   buffer   the bytes themselves, when a source had to decode them to check them
//   gitBlob  { repo, sha } -- an object inside a git repository; sha is what cat-file is asked
//            for: a bare object id (git's stored form) or "<id> <path>" (as checkout writes it)
//   extent   { place, runs } -- pieces of a disk or of an image of one: `place` is a file, or a
//            device such as \\.\E: or /dev/sdb1, and each run [offset, length] a piece of it, in
//            order. A run whose offset is null stands for that many zero bytes, as a file system
//            gives past the end of a file's valid data. `head`, when set, is the SHA-1 (hex) of
//            its first HEAD_CHECK bytes as the search read them, for restore to tell that the
//            place still holds them (restore.js); a copy small enough to hash whole has `hash`.
// A folder (a whole deleted directory in the Recycle Bin) has `dir` instead.
//
// There are two ways to read one. load() gives all of a copy at once, which is how a search
// compares copies and looks into them; one read of a file is at most 2 GiB here, so a bigger
// copy fails there. openCopy() streams any part of a copy of any size, which is how restore and
// rebuild write one -- a video of several gigabytes included -- and how a front end plays one
// from the middle.

// Copies larger than this are listed but not hashed, so they are never merged as duplicates.
const HASH_LIMIT = 32 * 1024 * 1024;

// How much of an extent too large to hash is taken, to tell later whether it is still there.
const HEAD_CHECK = 4096;

/** The SHA-1 of an extent's first HEAD_CHECK bytes, as `head` holds it. */
function headHash(buf) {
  return crypto.createHash('sha1').update(buf.subarray(0, HEAD_CHECK)).digest('hex');
}

// A disk opened directly is read in whole sectors only, or the read fails; 4 KiB is a whole
// number of sectors on every disk in use. A disk image reads the same.
const ALIGN = 4096;
// How much of an extent is read at a time.
const CHUNK = 1024 * 1024;

// Opening without waiting, where there is such a flag, so that a file swapped for a pipe since it
// was found cannot hold the read up for good; a plain file reads the same.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);

/**
 * Content is identified the way git identifies a blob, so a copy found in a repository and
 * the same bytes found anywhere else get the same hash without git having to be asked twice.
 */
function blobHash(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/** Everything a stream gives, as one Buffer. */
async function collect(stream) {
  const parts = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
}

async function load(c, git) {
  if (c.buffer) return c.buffer;
  if (typeof c.text === 'string') return Buffer.from(c.text, 'utf8');
  if (c.file) return fs.promises.readFile(c.file);
  if (c.gitBlob) return git.readBlob(c.gitBlob.repo, c.gitBlob.sha);
  if (c.extent) return collect(await openCopy(c, {}, git));
  throw new Error(t('Nothing of this copy is left to read.'));
}

/** Bytes already in memory, as a stream of the part asked for. */
function bytesStream(buf, from, last) {
  const part = buf.subarray(from, last === Infinity ? undefined : last + 1);
  return Readable.from(part.length ? [part] : [], { objectMode: false });
}

async function fileStream(file, from, last) {
  const fh = await fs.promises.open(file, OPEN_FLAGS);
  try {
    if (!(await fh.stat()).isFile()) throw new Error(t('{0} is not a plain file', file));
  } catch (e) {
    await fh.close();
    throw e;
  }
  return fh.createReadStream({ start: from, end: last, autoClose: true });
}

/**
 * The pieces of a disk an extent names, read in whole blocks of ALIGN and cut to size. A place
 * that ends before the extent does fails the stream: the copy would come out short.
 */
async function extentStream(extent, from, last) {
  // Anything else -- runs counted in clusters, say -- would read the wrong bytes, so it is refused.
  const bad = () => new Error(t('This copy names pieces of a disk in a way not known here, so nothing was read.'));
  if (typeof extent.place !== 'string' || !Array.isArray(extent.runs)) throw bad();
  const pieces = [];
  let size = 0;
  for (const run of extent.runs) {
    const [offset, length] = Array.isArray(run) ? run : [];
    if (!Number.isSafeInteger(length) || length < 0 || (offset !== null && (!Number.isSafeInteger(offset) || offset < 0))) throw bad();
    pieces.push({ at: size, offset, length });
    size += length;
  }
  const fh = await fs.promises.open(extent.place, 'r');
  const stop = Math.min(last + 1, size);
  let pos = from;
  let piece = 0;

  const readAt = async (want) => {
    while (pieces[piece].at + pieces[piece].length <= pos) piece++;
    const p = pieces[piece];
    const n = Math.min(want, p.at + p.length - pos);
    if (p.offset == null) return Buffer.alloc(n);
    const at = p.offset + (pos - p.at);
    const first = Math.floor(at / ALIGN) * ALIGN;
    const span = Math.ceil((at + n) / ALIGN) * ALIGN - first;
    const buf = Buffer.alloc(span);
    let got = 0;
    while (got < span) {
      const { bytesRead } = await fh.read(buf, got, span - got, first + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    if (got < at - first + n) throw new Error(t('{0} ends before this copy does; it may have been taken out', extent.place));
    return buf.subarray(at - first, at - first + n);
  };

  return new Readable({
    read() {
      if (pos >= stop) {
        this.push(null);
        return;
      }
      readAt(Math.min(CHUNK, stop - pos)).then((buf) => {
        pos += buf.length;
        this.push(buf);
      }, (e) => this.destroy(e));
    },
    destroy(err, done) {
      fh.close().then(() => done(err), () => done(err));
    },
  });
}

/**
 * A copy's bytes as a stream, from `start` to `end` -- counted from 0, both included, as
 * fs.createReadStream counts them -- or to its end when `end` is left out. A copy that cannot be
 * opened at all rejects here, before anything is streamed; one that fails part of the way fails
 * the stream. Whoever takes the stream reads it to its end or destroys it, which closes what it
 * holds open.
 * @param {object} c                  a search result
 * @param {{ start?: number, end?: number }} [range]
 * @param {object} git                the git source, to read blobs
 * @returns {Promise<import('stream').Readable>}
 */
async function openCopy(c, { start, end } = {}, git) {
  const from = start == null ? 0 : start;
  if (!Number.isSafeInteger(from) || from < 0 || (end != null && !Number.isSafeInteger(end))) {
    throw new RangeError(t('Not a range of bytes: {0} to {1}', start, end));
  }
  // An end before the start is an empty range, as it is to fs.createReadStream's reader.
  const last = end == null ? Infinity : end;
  if (last < from) return Readable.from([], { objectMode: false });
  if (c.buffer) return bytesStream(c.buffer, from, last);
  if (typeof c.text === 'string') return bytesStream(Buffer.from(c.text, 'utf8'), from, last);
  if (c.file) return fileStream(c.file, from, last);
  if (c.extent) return extentStream(c.extent, from, last);
  if (c.gitBlob) return bytesStream(await git.readBlob(c.gitBlob.repo, c.gitBlob.sha), from, last);
  throw new Error(t('Nothing of this copy is left to read.'));
}

/** The first `n` bytes of a copy, or fewer when it is shorter; null when nothing of it is left. */
async function head(c, git, n) {
  if (c.buffer) return c.buffer.subarray(0, n);
  if (typeof c.text === 'string') return Buffer.from(c.text.slice(0, n), 'utf8').subarray(0, n);
  if (!c.file && !c.extent && !c.gitBlob) return null;
  return collect(await openCopy(c, { start: 0, end: n - 1 }, git));
}

/** Decodes for a text search. UTF-16 with a byte order mark is common on Windows. */
function asText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buf.toString('utf8');
}

/** A NUL byte near the start is the usual sign of a binary file. */
function looksBinary(buf) {
  const head = buf.subarray(0, 8000);
  if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) {
    return false;
  }
  return head.includes(0);
}

module.exports = { HASH_LIMIT, HEAD_CHECK, blobHash, headHash, load, openCopy, head, collect, asText, looksBinary };
