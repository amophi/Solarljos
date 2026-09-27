'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { workDir, cleanup, write, infoV1, infoV2, only } = require('./helpers');
const { parseInfo } = require('../src/sources/recycle-bin')._internal;
const { search, git } = require('../src/search');
const { load } = require('../src/content');

const dirs = [];
after(() => dirs.forEach(cleanup));

const T = Date.UTC(2026, 8, 20, 12, 30);

test('reads both $I layouts', () => {
  const v2 = parseInfo(infoV2('C:\\Users\\alice\\한글 파일.txt', 1234, T));
  assert.deepStrictEqual(v2, { version: 2, size: 1234, time: T, path: 'C:\\Users\\alice\\한글 파일.txt' });
  const v1 = parseInfo(infoV1('D:\\old\\notes.doc', 99, T));
  assert.deepStrictEqual(v1, { version: 1, size: 99, time: T, path: 'D:\\old\\notes.doc' });
});

test('rejects what is not a $I record', () => {
  assert.strictEqual(parseInfo(Buffer.alloc(10)), null);
  const bad = infoV2('C:\\a.txt', 1, T);
  bad.writeBigInt64LE(7n, 0);
  assert.strictEqual(parseInfo(bad), null);
});

/** An account folder with a deleted file, a deleted folder, and an item whose contents are gone. */
function makeBin() {
  const root = workDir('recycle');
  dirs.push(root);
  const bin = path.join(root, '$Recycle.Bin', 'S-1-5-21-1-2-3-1001');
  write(path.join(bin, '$IA1B2C3.txt'), infoV2('C:\\Users\\alice\\Desktop\\plan.txt', 5, T));
  write(path.join(bin, '$RA1B2C3.txt'), 'plan!');
  write(path.join(bin, '$ID4E5F6'), infoV2('C:\\Users\\alice\\proj', 300, T + 1000));
  write(path.join(bin, '$RD4E5F6', 'src', 'main.js'), 'console.log(1)');
  write(path.join(bin, '$RD4E5F6', 'README.md'), '# proj');
  write(path.join(bin, '$IG7H8I9.txt'), infoV2('C:\\Users\\alice\\gone.txt', 10, T + 2000));
  write(path.join(bin, 'desktop.ini'), '[.ShellClassInfo]');
  return { root: path.join(root, '$Recycle.Bin'), bin };
}

const find = (pattern, recycleDirs) => search({ pattern, sources: ['recycle'], locations: only({ recycleDirs }) });

test('finds a deleted file under its original path, from the bin root', async () => {
  const { root } = makeBin();
  const { results } = await find('plan', [root]);
  assert.strictEqual(results.length, 1);
  const r = results[0];
  assert.strictEqual(r.path, 'C:\\Users\\alice\\Desktop\\plan.txt');
  assert.strictEqual(r.kind, 'recycle bin');
  assert.strictEqual(r.time, T);
  assert.strictEqual((await load(r, git)).toString(), 'plan!');
});

test('finds files inside a deleted folder, with the paths they had', async () => {
  const { bin } = makeBin();
  const { results } = await find('main.js', [bin]);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].path, 'C:\\Users\\alice\\proj\\src\\main.js');
  assert.strictEqual(results[0].kind, 'recycle bin, inside a deleted folder');
  assert.strictEqual((await load(results[0], git)).toString(), 'console.log(1)');
});

test('a deleted folder itself is a result that restores as a folder', async () => {
  const { bin } = makeBin();
  const { results } = await find('proj', [bin]);
  const folder = results.find((r) => r.path === 'C:\\Users\\alice\\proj');
  assert.ok(folder && folder.isDir);
});

test('an item whose contents are gone is still reported, as having none', async () => {
  const { bin } = makeBin();
  const { results } = await find('gone', [bin]);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].state, 'no content');
});
