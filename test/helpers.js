'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Fixtures are built inside the project, under test/.work, and removed afterwards. No test
// reads this machine's real Recycle Bin, editor history, Claude Code folder or repositories:
// every search is given its locations and told not to discover any.

const WORK = path.join(__dirname, '.work');

function workDir(name) {
  const dir = path.join(WORK, `${name}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

const FILETIME_OFFSET_MS = 11644473600000n;
const filetime = (ms) => (BigInt(ms) + FILETIME_OFFSET_MS) * 10000n;

/** A Windows 10+ $I record. */
function infoV2(original, size, ms) {
  const p = Buffer.from(original + '\0', 'utf16le');
  const b = Buffer.alloc(28 + p.length);
  b.writeBigInt64LE(2n, 0);
  b.writeBigInt64LE(BigInt(size), 8);
  b.writeBigInt64LE(filetime(ms), 16);
  b.writeUInt32LE(p.length / 2, 24);
  p.copy(b, 28);
  return b;
}

/** A Vista to 8.1 $I record: the path in a fixed 520-byte field. */
function infoV1(original, size, ms) {
  const b = Buffer.alloc(24 + 520);
  b.writeBigInt64LE(1n, 0);
  b.writeBigInt64LE(BigInt(size), 8);
  b.writeBigInt64LE(filetime(ms), 16);
  Buffer.from(original, 'utf16le').copy(b, 24);
  return b;
}

/** Locations for search(): exactly these, nothing discovered. */
function only(locations) {
  return { discover: false, recycleDirs: [], historyDirs: [], repos: [], ...locations };
}

/** Every file under a folder with its size, mtime and content hash, to prove nothing changed. */
function snapshot(dir) {
  const out = {};
  const visit = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        visit(p);
      } else {
        const st = fs.statSync(p);
        out[path.relative(dir, p)] = [st.size, st.mtimeMs,
          crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')].join(' ');
      }
    }
  };
  visit(dir);
  return out;
}

module.exports = { workDir, cleanup, write, infoV1, infoV2, only, snapshot };
