'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { workDir, cleanup, write, infoV1, infoV2, only, snapshot } = require('./helpers');
const { parseInfo, limits } = require('../src/sources/recycle-bin')._internal;
const { search, describeAll, git } = require('../src/search');
const { load } = require('../src/content');
const { restore } = require('../src/restore');

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

test('an ordinary bin is read without notes', async () => {
  const { root } = makeBin();
  const { results, perSource } = await find('*', [root]);
  assert.strictEqual(results.length, 6, 'plan.txt, proj, its src, main.js and README.md, gone.txt');
  assert.deepStrictEqual(perSource[0].notes, []);
});

// ---------------------------------------------------------------------------------------------
// Links. A junction needs no privilege on Windows; a symbolic link to a file does, unless
// Developer Mode is on, so the tests that make one run where it can be made (always on Linux).

const LINK_NOTE = /: 1 link\(s\), junction\(s\) or special file\(s\) skipped; they hold no file$/;
const dirLink = (target, link) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');

function fileLinksWork() {
  const dir = workDir('recycle-probe');
  try {
    fs.writeFileSync(path.join(dir, 'a'), '');
    fs.symlinkSync(path.join(dir, 'a'), path.join(dir, 'b'), 'file');
    return true;
  } catch (_) {
    return false;
  } finally {
    cleanup(dir);
  }
}
const noFileLinks = !fileLinksWork() && 'symbolic links to files cannot be made here';

/** A bin beside a live folder that was never deleted, which the links below lead to. */
function makeLinkedBin() {
  const root = workDir('recycle-link');
  dirs.push(root);
  const live = path.join(root, 'live-project');
  write(path.join(live, 'src', 'current.txt'), 'LIVE CONTENT, never deleted');
  const binRoot = path.join(root, '$Recycle.Bin');
  const bin = path.join(binRoot, 'S-1-5-21-1-2-3-1001');
  write(path.join(bin, '$IA1B2C3.txt'), infoV2('C:\\Users\\alice\\Desktop\\plan.txt', 5, T));
  write(path.join(bin, '$RA1B2C3.txt'), 'plan!');
  return { root, live, binRoot, bin };
}

test('a recycled junction is skipped with a note, and nothing behind it is offered', async () => {
  const { root, live, binRoot, bin } = makeLinkedBin();
  write(path.join(bin, '$IABC123'), infoV2('C:\\Users\\alice\\link-to-project', 0, T));
  dirLink(live, path.join(bin, '$RABC123'));
  const before = snapshot(live);

  const { results, perSource } = await find('*', [binRoot]);
  assert.deepStrictEqual(results.map((r) => r.path), ['C:\\Users\\alice\\Desktop\\plan.txt']);
  assert.strictEqual(perSource[0].notes.length, 1);
  assert.match(perSource[0].notes[0], LINK_NOTE);
  assert.ok(perSource[0].notes[0].startsWith(bin));
  assert.deepStrictEqual((await find('current.txt', [binRoot])).results, []);
  assert.deepStrictEqual(snapshot(live), before);

  // describe() counts what a search would read: the link is not an item.
  const [described] = await describeAll({ sources: ['recycle'], locations: only({ recycleDirs: [binRoot] }) });
  assert.strictEqual(described.lines.length, 2);
  assert.strictEqual(described.lines[0], `${bin}: 1 item(s)`);
  assert.match(described.lines[1], LINK_NOTE);
  assert.ok(fs.existsSync(path.join(root, 'live-project', 'src', 'current.txt')));
});

test('a link inside a deleted folder is neither followed nor offered', async () => {
  const { live, binRoot, bin } = makeLinkedBin();
  write(path.join(bin, '$ID4E5F6'), infoV2('C:\\Users\\alice\\proj', 300, T));
  write(path.join(bin, '$RD4E5F6', 'README.md'), '# proj');
  dirLink(live, path.join(bin, '$RD4E5F6', 'out'));

  const { results, perSource } = await find('*', [binRoot]);
  assert.deepStrictEqual(results.map((r) => r.path).sort(), [
    'C:\\Users\\alice\\Desktop\\plan.txt', 'C:\\Users\\alice\\proj', 'C:\\Users\\alice\\proj\\README.md',
  ]);
  assert.strictEqual(perSource[0].notes.length, 1);
  assert.match(perSource[0].notes[0], LINK_NOTE);
});

test('a recycled symbolic link to a file is skipped, and so is one inside a deleted folder', { skip: noFileLinks }, async () => {
  const { live, binRoot, bin } = makeLinkedBin();
  const target = path.join(live, 'src', 'current.txt');
  write(path.join(bin, '$IF00001.txt'), infoV2('C:\\Users\\alice\\notes.txt', 5, T));
  fs.symlinkSync(target, path.join(bin, '$RF00001.txt'), 'file');
  write(path.join(bin, '$IF00002'), infoV2('C:\\Users\\alice\\docs', 5, T));
  write(path.join(bin, '$RF00002', 'kept.txt'), 'kept');
  fs.symlinkSync(target, path.join(bin, '$RF00002', 'current.txt'), 'file');

  const { results, perSource } = await find('*.txt', [binRoot]);
  assert.deepStrictEqual(results.map((r) => r.path).sort(), [
    'C:\\Users\\alice\\Desktop\\plan.txt', 'C:\\Users\\alice\\docs\\kept.txt',
  ]);
  assert.match(perSource[0].notes[0], /: 2 link\(s\), junction\(s\) or special file\(s\) skipped; they hold no file$/);
});

test('an account folder that is a link is not read', async () => {
  const { root, binRoot } = makeLinkedBin();
  const elsewhere = path.join(root, 'elsewhere');
  write(path.join(elsewhere, '$IB00001.txt'), infoV2('C:\\Users\\bob\\secret.txt', 6, T));
  write(path.join(elsewhere, '$RB00001.txt'), 'secret');
  const linked = path.join(binRoot, 'S-1-5-21-1-2-3-1002');
  dirLink(elsewhere, linked);

  const { results, perSource } = await find('*', [binRoot]);
  assert.deepStrictEqual(results.map((r) => r.path), ['C:\\Users\\alice\\Desktop\\plan.txt']);
  assert.deepStrictEqual(perSource[0].notes, [`${linked}: not read, since it is not a real folder`]);
});

// ---------------------------------------------------------------------------------------------
// How far a deleted folder is read

/** A deleted folder three levels deep: a.txt, then sub\b.txt, then sub\deeper\c.txt. */
function makeDeepBin() {
  const root = workDir('recycle-deep');
  dirs.push(root);
  const binRoot = path.join(root, '$Recycle.Bin');
  const bin = path.join(binRoot, 'S-1-5-21-1-2-3-1001');
  write(path.join(bin, '$IDEEP01'), infoV2('C:\\Users\\alice\\deep', 100, T));
  write(path.join(bin, '$RDEEP01', 'a.txt'), 'a');
  write(path.join(bin, '$RDEEP01', 'sub', 'b.txt'), 'b');
  write(path.join(bin, '$RDEEP01', 'sub', 'deeper', 'c.txt'), 'c');
  return { root, binRoot, bin };
}

async function withInsideLimit(n, fn) {
  const was = limits.inside;
  limits.inside = n;
  try {
    return await fn();
  } finally {
    limits.inside = was;
  }
}

test('a deleted folder is read level by level, and a cut is said, with the folder still whole', async () => {
  const { root, binRoot } = makeDeepBin();
  // The top holds 2 entries and sub 2 more: the 4 nearest the top are a.txt, sub, sub\b.txt, sub\deeper.
  const { results, perSource } = await withInsideLimit(4, () => find('*', [binRoot]));
  assert.deepStrictEqual(results.map((r) => r.path).sort(), [
    'C:\\Users\\alice\\deep', 'C:\\Users\\alice\\deep\\a.txt', 'C:\\Users\\alice\\deep\\sub',
    'C:\\Users\\alice\\deep\\sub\\b.txt', 'C:\\Users\\alice\\deep\\sub\\deeper',
  ]);
  assert.deepStrictEqual(perSource[0].notes, [
    'Deleted folder C:\\Users\\alice\\deep: only the 4 entries nearest its top were searched; restoring the folder itself copies all of it',
  ]);

  // As the note says: the folder restores with what was not searched.
  const folder = results.find((r) => r.path === 'C:\\Users\\alice\\deep');
  const out = await restore(folder, path.join(root, 'out'), [binRoot], git);
  assert.strictEqual(fs.readFileSync(path.join(out, 'sub', 'deeper', 'c.txt'), 'utf8'), 'c');
});

test('a deleted folder that fits the limit exactly is read whole, with no note', async () => {
  const { binRoot } = makeDeepBin();
  const { results, perSource } = await withInsideLimit(5, () => find('c.txt', [binRoot]));
  assert.deepStrictEqual(results.map((r) => r.path), ['C:\\Users\\alice\\deep\\sub\\deeper\\c.txt']);
  assert.deepStrictEqual(perSource[0].notes, []);
});

test('a rebuild reads only the part of a deleted folder on its way', async () => {
  const root = workDir('recycle-rebuild');
  dirs.push(root);
  const bin = path.join(root, '$Recycle.Bin', 'S-1-5-21-1-2-3-1001');
  write(path.join(bin, '$IWORK01'), infoV2('C:\\Users\\alice\\work', 100, T));
  for (let i = 0; i < 5; i++) write(path.join(bin, '$RWORK01', 'big', `f${i}.bin`), 'x');
  write(path.join(bin, '$RWORK01', 'proj', 'src', 'main.js'), 'main');
  // A deleted folder elsewhere is not read at all.
  write(path.join(bin, '$IOTHER1'), infoV2('C:\\Users\\alice\\other', 100, T));
  for (let i = 0; i < 5; i++) write(path.join(bin, '$ROTHER1', `g${i}.bin`), 'x');

  // On the way are work's 2 entries, proj's 1 and src's 1; big's 5 would not fit beside them.
  const { results, perSource } = await withInsideLimit(4, () =>
    search({ under: 'C:\\Users\\alice\\work\\proj', sources: ['recycle'], locations: only({ recycleDirs: [bin] }) }));
  assert.deepStrictEqual(results.map((r) => r.path), ['C:\\Users\\alice\\work\\proj\\src', 'C:\\Users\\alice\\work\\proj\\src\\main.js']);
  assert.deepStrictEqual(perSource[0].notes, []);
});
