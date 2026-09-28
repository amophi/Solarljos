'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { t } = require('./i18n');

// A found copy keeps its content in one of four ways:
//   file     a path to a file on disk that holds the bytes (Recycle Bin, Local History, backups)
//   text     the content itself, as a transcript recorded it
//   buffer   the bytes themselves, when a source had to decode them to check them
//   gitBlob  { repo, sha } -- an object inside a git repository; sha is what cat-file is asked
//            for: a bare object id (git's stored form) or "<id> <path>" (as checkout writes it)
// A folder (a whole deleted directory in the Recycle Bin) has `dir` instead.

// Copies larger than this are listed but not hashed, so they are never merged as duplicates.
const HASH_LIMIT = 32 * 1024 * 1024;

/**
 * Content is identified the way git identifies a blob, so a copy found in a repository and
 * the same bytes found anywhere else get the same hash without git having to be asked twice.
 */
function blobHash(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

async function load(c, git) {
  if (c.buffer) return c.buffer;
  if (typeof c.text === 'string') return Buffer.from(c.text, 'utf8');
  if (c.file) return fs.promises.readFile(c.file);
  if (c.gitBlob) return git.readBlob(c.gitBlob.repo, c.gitBlob.sha);
  throw new Error(t('Nothing of this copy is left to read.'));
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

module.exports = { HASH_LIMIT, blobHash, load, asText, looksBinary };
