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

test('a copy whose name was lost gets one from its ID', async () => {
  const root = setup();
  const target = await restore({ id: 'deadbeef', path: null, text: 'x' }, root, [], git);
  assert.strictEqual(path.basename(target), 'recovered-deadbeef');
});
