'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { workDir, cleanup, write } = require('./helpers');
const { restore } = require('../src/restore');
const { nameFor, writeNew } = require('../src/restore')._internal;
const { openCopy, collect, load } = require('../src/content');
const { git } = require('../src/search');

const dirs = [];
after(() => dirs.forEach(cleanup));

function setup() {
  const root = workDir('restore');
  dirs.push(root);
  return root;
}

test('writes the copy under its original name, and never over an existing file', async () => {
  const root = setup();
  const out = path.join(root, 'out');
  const c = { id: 'abcd1234', path: 'C:\\Users\\alice\\report.final.txt', text: 'recovered' };
  write(path.join(out, 'report.final.txt'), 'precious');

  const first = await restore(c, out, [], git);
  assert.strictEqual(path.basename(first), 'report.final (recovered 2).txt');
  const second = await restore(c, out, [], git);
  assert.strictEqual(path.basename(second), 'report.final (recovered 3).txt');
  assert.strictEqual(fs.readFileSync(path.join(out, 'report.final.txt'), 'utf8'), 'precious');
  assert.strictEqual(fs.readFileSync(first, 'utf8'), 'recovered');
});

test('creates the destination folder when it does not exist', async () => {
  const root = setup();
  const target = await restore({ id: 'x', path: '/a/b.txt', text: 'b' }, path.join(root, 'new', 'deep'), [], git);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'b');
});

test('refuses to write inside a searched location, before creating anything', async () => {
  const root = setup();
  const protectedDir = path.join(root, 'claude');
  fs.mkdirSync(protectedDir);
  const dest = path.join(protectedDir, 'sub', 'dir');
  await assert.rejects(restore({ id: 'x', path: '/a.txt', text: 'a' }, dest, [protectedDir], git), /Refusing to write inside/);
  assert.ok(!fs.existsSync(path.join(protectedDir, 'sub')));
});

test('a copy with no content left is refused', async () => {
  const root = setup();
  await assert.rejects(restore({ id: 'x', path: '/a.txt', gone: true }, root, [], git), /Nothing of this copy/);
});

test('a deleted folder is restored as a whole tree', async () => {
  const root = setup();
  const from = path.join(root, 'bin', '$RXYZ');
  write(path.join(from, 'src', 'main.js'), 'main');
  write(path.join(from, 'README.md'), 'readme');
  const target = await restore({ id: 'x', path: 'C:\\Users\\alice\\proj', isDir: true, dir: from }, path.join(root, 'out'), [], git);
  assert.strictEqual(path.basename(target), 'proj');
  assert.strictEqual(fs.readFileSync(path.join(target, 'src', 'main.js'), 'utf8'), 'main');
  assert.strictEqual(fs.readFileSync(path.join(target, 'README.md'), 'utf8'), 'readme');
});

const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir';

test('a deleted folder that is a link is refused: what it leads to was not deleted', async () => {
  const root = setup();
  const live = path.join(root, 'live');
  write(path.join(live, 'current.txt'), 'still in use');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // As Explorer leaves a deleted junction: the link itself, moved into the bin.
  fs.symlinkSync(live, path.join(bin, '$RLINK'), DIR_LINK);
  const c = { id: 'x', path: 'C:\\Users\\alice\\link-to-live', isDir: true, dir: path.join(bin, '$RLINK') };
  await assert.rejects(restore(c, path.join(live, 'restored'), [bin], git), /leads through a link/);
  await assert.rejects(restore(c, path.join(root, 'out'), [], git), /leads through a link/, 'with no locations given too');
  assert.ok(!fs.existsSync(path.join(live, 'restored')));
  assert.ok(!fs.existsSync(path.join(root, 'out')));
});

test('a deleted folder reached through a link below the searched location is refused', async () => {
  const root = setup();
  const elsewhere = path.join(root, 'elsewhere');
  write(path.join(elsewhere, '$RXYZ', 'a.txt'), 'not in the bin');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(elsewhere, path.join(bin, 'S-1-5-21-1'), DIR_LINK);
  const c = { id: 'x', path: 'C:\\a', isDir: true, dir: path.join(bin, 'S-1-5-21-1', '$RXYZ') };
  await assert.rejects(restore(c, path.join(root, 'out'), [bin], git), /leads through a link/);
});

test('a link inside a deleted folder is left out, not followed', async () => {
  const root = setup();
  const live = path.join(root, 'live');
  write(path.join(live, 'current.txt'), 'still in use');
  const from = path.join(root, 'bin', '$RXYZ');
  write(path.join(from, 'kept.txt'), 'deleted with the folder');
  fs.symlinkSync(live, path.join(from, 'shortcut'), DIR_LINK);
  const target = await restore({ id: 'x', path: 'C:\\proj', isDir: true, dir: from }, path.join(root, 'out'), [path.join(root, 'bin')], git);
  assert.deepStrictEqual(fs.readdirSync(target), ['kept.txt']);
});

test('a folder is never restored into itself', async () => {
  const root = setup();
  const from = path.join(root, 'bin', '$RXYZ');
  write(path.join(from, 'a.txt'), 'a');
  await assert.rejects(restore({ id: 'x', path: 'C:\\proj', isDir: true, dir: from }, path.join(from, 'out'), [], git),
    /that is the folder being restored/);
  assert.deepStrictEqual(fs.readdirSync(from), ['a.txt']);
});

// Windows drops a trailing dot, so "x." is written as "x_" -- the name of the file beside it.
test('names that come out the same on Windows all come back', { skip: process.platform !== 'win32' }, async () => {
  const root = setup();
  const from = path.join(root, 'bin', '$RXYZ');
  write(path.join(from, 'x_'), 'underscore');
  write(path.join(from, 'x.'), 'dot');
  write(path.join(from, 'd_', 'one.txt'), 'one');
  write(path.join(from, 'd.', 'two.txt'), 'two');
  assert.strictEqual(fs.readdirSync(from).length, 4, 'the fixture holds both spellings');
  const target = await restore({ id: 'x', path: 'C:\\proj', isDir: true, dir: from }, path.join(root, 'out'), [], git);
  const read = (...p) => fs.readFileSync(path.join(target, ...p), 'utf8');
  assert.deepStrictEqual([read('x_'), read('x_ (recovered 2)')].sort(), ['dot', 'underscore']);
  assert.deepStrictEqual(fs.readdirSync(target).sort(), ['d_', 'd_ (recovered 2)', 'x_', 'x_ (recovered 2)']);
});

test('a copy whose name was lost gets one from its ID', async () => {
  const root = setup();
  const target = await restore({ id: 'deadbeef', path: null, text: 'x' }, root, [], git);
  assert.strictEqual(path.basename(target), 'recovered-deadbeef');
});

/** Every file left in a folder, temporary ones included. */
const left = (dir) => fs.readdirSync(dir).sort();

test('openCopy streams any range of a copy, however the copy is kept', async () => {
  const root = setup();
  const file = write(path.join(root, 'f.bin'), '0123456789');
  const fakeGit = { readBlob: async (repo, sha) => Buffer.from(`${repo}:${sha}`) };
  const read = async (c, range) => (await collect(await openCopy(c, range, fakeGit))).toString();
  for (const c of [{ file }, { buffer: Buffer.from('0123456789') }, { text: '0123456789' }]) {
    const how = Object.keys(c)[0];
    assert.strictEqual(await read(c), '0123456789', how);
    assert.strictEqual(await read(c, { start: 2, end: 4 }), '234', `${how}: both ends are included`);
    assert.strictEqual(await read(c, { start: 7 }), '789', how);
    assert.strictEqual(await read(c, { start: 5, end: 99 }), '56789', how);
    assert.strictEqual(await read(c, { start: 20 }), '', how);
    assert.strictEqual(await read(c, { start: 4, end: 3 }), '', `${how}: an end before the start is nothing`);
  }
  assert.strictEqual(await read({ gitBlob: { repo: 'r', sha: 'abc' } }, { start: 2 }), 'abc');
  await assert.rejects(openCopy({ file }, { start: -1 }), RangeError);
  await assert.rejects(openCopy({ file }, { start: 0.5 }), RangeError);
  await assert.rejects(openCopy({ file: path.join(root, 'missing') }), (e) => e.code === 'ENOENT', 'refused before any stream exists');
  await assert.rejects(openCopy({ file: root }), /not a plain file|EISDIR/);
  await assert.rejects(openCopy({ gone: true }), /Nothing of this copy/);
});

test('an extent is read from its disk or image piece by piece, with zeros where a piece has no place', async () => {
  const root = setup();
  const place = write(path.join(root, 'card.img'), Buffer.concat([
    Buffer.alloc(5000, 'a'), Buffer.from('HELLO'), Buffer.alloc(9000, 'b'), Buffer.from('WORLD'),
  ]));
  const c = { extent: { place, runs: [[5000, 5], [null, 3], [14005, 5]] } };
  assert.strictEqual((await collect(await openCopy(c))).toString('latin1'), 'HELLO\0\0\0WORLD');
  assert.strictEqual((await collect(await openCopy(c, { start: 3, end: 9 }))).toString('latin1'), 'LO\0\0\0WO');
  assert.strictEqual((await load(c, git)).length, 13);
  // Runs counted in anything but bytes of a named place would read the wrong bytes.
  await assert.rejects(openCopy({ extent: { runs: [[2, 3]] } }), /not known here/);
  await assert.rejects(openCopy({ extent: { place, runs: [[-1, 5]] } }), /not known here/);
  await assert.rejects(openCopy({ extent: { place, runs: [{ cluster: 2 }] } }), /not known here/);
});

test('a copy is streamed to disk and comes back whole, with no temporary file left', async () => {
  const root = setup();
  const big = Buffer.alloc(5 * 1024 * 1024 + 123);
  for (let i = 0; i < big.length; i += 1000) big[i] = (i / 1000) % 251;
  const file = write(path.join(root, 'src', 'video.mp4'), big);
  const out = path.join(root, 'out');
  const target = await restore({ id: 'x', path: 'C:\\v\\video.mp4', file }, out, [], git);
  assert.ok(fs.readFileSync(target).equals(big));
  const place = write(path.join(root, 'card.img'), Buffer.concat([Buffer.alloc(4096), big]));
  const fromCard = await restore({ id: 'y', path: 'E:\\v\\video.mp4', extent: { place, runs: [[4096, big.length]] } }, out, [], git);
  assert.ok(fs.readFileSync(fromCard).equals(big), 'read from an image in pieces of a megabyte');
  assert.deepStrictEqual(left(out), ['video (recovered 2).mp4', 'video.mp4']);
});

test('a copy that fails part of the way leaves nothing under its name, and no temporary file', async () => {
  const root = setup();
  const place = write(path.join(root, 'card.img'), Buffer.alloc(3 * 1024 * 1024, 7));
  // Two megabytes are there; the last piece lies past the end, as if the card had been pulled out.
  const c = { id: 'x', path: 'E:\\DCIM\\clip.mp4', extent: { place, runs: [[0, 2 * 1024 * 1024], [4 * 1024 * 1024, 1024]] } };
  const out = path.join(root, 'out');
  await assert.rejects(restore(c, out, [], git), /ends before this copy does/);
  assert.deepStrictEqual(left(out), []);
});

test('a copy that cannot be read makes nothing, not even the folder', async () => {
  const root = setup();
  await assert.rejects(restore({ id: 'x', path: '/a.txt', file: path.join(root, 'missing') }, path.join(root, 'out'), [], git),
    (e) => e.code === 'ENOENT');
  assert.ok(!fs.existsSync(path.join(root, 'out')));
});

test('a file that takes the name while the copy is being written is not replaced', async () => {
  const root = setup();
  const out = path.join(root, 'out');
  fs.mkdirSync(out);
  let sent = false;
  const data = new Readable({
    read() {
      if (sent) {
        this.push(null);
        return;
      }
      sent = true;
      write(path.join(out, 'a.txt'), 'arrived meanwhile');
      this.push('the copy');
    },
  });
  const target = await writeNew(out, 'a.txt', data);
  assert.strictEqual(path.basename(target), 'a (recovered 2).txt');
  assert.strictEqual(fs.readFileSync(path.join(out, 'a.txt'), 'utf8'), 'arrived meanwhile');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'the copy');
  assert.deepStrictEqual(left(out), ['a (recovered 2).txt', 'a.txt']);
});

/** Makes fs[name] fail with `code` while `fn` runs. */
async function failing(names, code, fn) {
  const saved = names.map((n) => fs[n]);
  for (const n of names) {
    fs[n] = () => {
      const e = new Error(`${code}: made to fail, ${n}`);
      e.code = code;
      throw e;
    };
  }
  try {
    return await fn();
  } finally {
    names.forEach((n, i) => {
      fs[n] = saved[i];
    });
  }
}

test('where hard links are not offered, as on FAT and exFAT, the file is renamed in, never over another', async () => {
  const root = setup();
  const out = path.join(root, 'out');
  write(path.join(out, 'a.txt'), 'precious');
  const target = await failing(['linkSync'], 'EPERM', () => restore({ id: 'x', path: '/p/a.txt', text: 'copy' }, out, [], git));
  assert.strictEqual(path.basename(target), 'a (recovered 2).txt');
  assert.strictEqual(fs.readFileSync(path.join(out, 'a.txt'), 'utf8'), 'precious');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'copy');
  assert.deepStrictEqual(left(out), ['a (recovered 2).txt', 'a.txt']);
});

test('a temporary name that is somehow taken fails the write, and what holds it is left alone', async () => {
  const crypto = require('crypto');
  const root = setup();
  const out = path.join(root, 'out');
  const theirs = write(path.join(out, '.~solarljos-000000000000.part'), 'not ours');
  const { randomBytes } = crypto;
  crypto.randomBytes = (n) => Buffer.alloc(n);
  try {
    await assert.rejects(restore({ id: 'x', path: '/p/a.txt', text: 'copy' }, out, [], git), (e) => e.code === 'EEXIST');
  } finally {
    crypto.randomBytes = randomBytes;
  }
  assert.strictEqual(fs.readFileSync(theirs, 'utf8'), 'not ours');
  assert.deepStrictEqual(left(out), ['.~solarljos-000000000000.part']);
});

test('when the file cannot be given its name, the temporary file goes too', async () => {
  const root = setup();
  const out = path.join(root, 'out');
  await assert.rejects(failing(['linkSync', 'renameSync'], 'EIO', () => restore({ id: 'x', path: '/p/a.txt', text: 'copy' }, out, [], git)),
    /EIO: made to fail, renameSync/);
  assert.deepStrictEqual(left(out), []);
});

test('a copy that is not simply the file says what it is in its name', async () => {
  const root = setup();
  const out = path.join(root, 'out');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const cases = [
    [{ path: 'C:\\v\\clip.mp4', kind: 'thumbnail', derived: true, ext: '.jpg', width: 256, height: 144 }, 'clip (smaller copy 256x144).jpg'],
    [{ path: 'C:\\p\\holiday.heic', kind: 'thumbnail', ext: '.jpg' }, 'holiday (smaller copy).jpg'],
    [{ path: 'E:\\DCIM\\IMG_0001.JPG', kind: 'fat undelete', unverified: true }, 'IMG_0001 (may be incomplete).JPG'],
    [{ path: null, kind: 'carved', ext: '.jpg' }, 'recovered-c4 (may be incomplete).jpg'],
    [{ path: null, name: 'IMG_0002.JPG', kind: 'carved' }, 'IMG_0002 (may be incomplete).JPG'],
    [{ path: null, kind: 'thumbnail, name unknown', ext: '.png', width: 96, height: 96 }, 'recovered-c6 (smaller copy 96x96).png'],
    [{ path: null, kind: 'exif thumbnail', derived: true, unverified: true, ext: '.jpg', width: 160, height: 120 },
      'recovered-c7 (smaller copy 160x120, may be incomplete).jpg'],
    [{ path: null, kind: 'trash, name unknown', ext: '.jpg' }, 'recovered-c8.jpg'],
    [{ path: null, name: 'Screenshot 2025-01-02 030405.png', kind: 'snipping tool capture' }, 'Screenshot 2025-01-02 030405.png'],
  ];
  for (let i = 0; i < cases.length; i++) {
    const [c, name] = cases[i];
    const copy = { id: `c${i + 1}`, buffer: jpeg, ...c };
    assert.strictEqual(nameFor(copy), name);
    assert.strictEqual(path.basename(await restore(copy, out, [], git)), name);
  }
  const again = await restore({ id: 'c1', buffer: jpeg, ...cases[0][0] }, out, [], git);
  assert.strictEqual(path.basename(again), 'clip (smaller copy 256x144) (recovered 2).jpg');
});

test('pieces of a disk that changed since the search are not written under the file\'s name', async () => {
  const { blobHash, headHash } = require('../src/content');
  const root = setup();
  const out = path.join(root, 'out');
  const was = Buffer.alloc(10000);
  for (let i = 0; i < was.length; i++) was[i] = (i * 7) & 0xff;
  const disk = write(path.join(root, 'card.img'), was);
  const small = { id: 's', path: 'E:\\DCIM\\a.jpg', size: was.length, extent: { place: disk, runs: [[0, was.length]] }, hash: blobHash(was) };
  // Too large to hash whole: its first 4 KiB were.
  const large = { id: 'l', path: 'E:\\DCIM\\b.mp4', size: was.length, extent: { place: disk, runs: [[0, was.length]], head: headHash(was) } };
  assert.deepStrictEqual(fs.readFileSync(await restore(small, out, [], git)), was);
  assert.deepStrictEqual(fs.readFileSync(await restore(large, out, [], git)), was);
  assert.deepStrictEqual(left(out), ['a.jpg', 'b.mp4']);
  // Something wrote to the card: after the first 4 KiB, then inside them.
  const fd = fs.openSync(disk, 'r+');
  fs.writeSync(fd, Buffer.from('written since'), 0, 13, 9000);
  await assert.rejects(restore(small, out, [], git), /no longer holds what the search found there/);
  fs.writeSync(fd, Buffer.from('written since'), 0, 13, 100);
  fs.closeSync(fd);
  await assert.rejects(restore(large, out, [], git), /no longer holds what the search found there/);
  assert.deepStrictEqual(left(out), ['a.jpg', 'b.mp4'], 'nothing new, and no temporary file');
  // A copy with neither is written as it reads.
  const { hash, ...plain } = small;
  assert.ok(fs.existsSync(await restore(plain, out, [], git)));
  assert.ok(hash);
});

test('a destination on a volume being recovered, or inside a searched folder by another name, is refused', async () => {
  const { checkDestination } = require('../src/restore');
  const { volumeOf } = require('../src/restore')._internal;
  const root = setup();
  const here = volumeOf(root);
  assert.match(here, /^\d+$/);
  const card = { volume: here, label: 'the card' };
  assert.throws(() => checkDestination(path.join(root, 'new', 'deep'), [card]), /Refusing to write onto the card; that is the drive being recovered/);
  assert.strictEqual(checkDestination(path.join(root, 'out'), [{ volume: '1', label: 'another' }]), path.join(root, 'out'));
  assert.strictEqual(checkDestination(path.join(root, 'out'), [path.join(root, 'claude')]), path.join(root, 'out'));
  // A folder reached under another name that realpath does not see through: on Windows, this
  // machine's own admin share. Tried only where it can be reached.
  const protectedDir = path.join(root, 'claude');
  fs.mkdirSync(protectedDir);
  const unc = process.platform === 'win32' ? `\\\\localhost\\${protectedDir[0]}$${protectedDir.slice(2)}` : null;
  let reachable = false;
  try {
    reachable = !!unc && fs.statSync(unc).isDirectory();
  } catch (_) {
    reachable = false;
  }
  if (reachable) {
    assert.throws(() => checkDestination(path.join(unc, 'sub'), [protectedDir]), /Refusing to write inside/);
    assert.throws(() => checkDestination(unc, [protectedDir]), /Refusing to write inside/);
  }
});

test('a process ending while a copy is written leaves no temporary file behind', () => {
  const { execFileSync } = require('child_process');
  const root = setup();
  const out = path.join(root, 'out');
  fs.mkdirSync(out);
  const lib = path.join(__dirname, '..', 'src', 'restore.js');
  // A copy that never ends, cut by the process ending as a front end ends it: removeUnfinished(), then exit.
  const script = `
    const { Readable } = require('stream');
    const r = require(${JSON.stringify(lib)});
    const data = new Readable({ read() { this.push(Buffer.alloc(65536, 1)); } });
    r._internal.writeNew(${JSON.stringify(out)}, 'clip.mp4', data).catch(() => {});
    setTimeout(() => {
      const fs = require('fs');
      process.stdout.write(String(fs.readdirSync(${JSON.stringify(out)}).length));
      r.removeUnfinished();
      process.exit(0);
    }, 200);
  `;
  const before = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.strictEqual(before, '1', 'the temporary file was there while it was written');
  assert.deepStrictEqual(left(out), []);
});
