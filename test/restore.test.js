'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { workDir, cleanup, write } = require('./helpers');
const { restore } = require('../src/restore');
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
