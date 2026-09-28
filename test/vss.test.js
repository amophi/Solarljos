'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { workDir, cleanup, write, only, snapshot } = require('./helpers');
const { search, git } = require('../src/search');
const { load } = require('../src/content');
const { compile } = require('../src/match');
const fmt = require('../src/format');
const vss = require('../src/sources/vss');
const {
  parseLocations, resolveSnapshots, relBelowDrive, driveKeyOf, normalizeDriveRoot, toOriginal, snapDir,
  isSystemFolder, pickDrive, bytesPresent, walkSubtree, probeDevices, discover,
} = vss._internal;

const dirs = [];
after(() => dirs.forEach(cleanup));

const at = (file, ms) => fs.utimesSync(file, new Date(ms), new Date(ms));
const T1 = Date.parse('2026-01-01T00:00:00Z');
const T2 = Date.parse('2026-02-01T00:00:00Z');

// Two snapshots of drive C:, each mapped explicitly so no real device is touched. snap2's a.js
// differs from snap1's; b.txt is identical in both.
function makeSnapshots() {
  const base = workDir('vss');
  dirs.push(base);
  const snap1 = path.join(base, 'snap1');
  const snap2 = path.join(base, 'snap2');
  const app = (root) => path.join(root, 'Users', 'me', 'app');
  at(write(path.join(app(snap1), 'a.js'), 'v1 a\n'), T1);
  at(write(path.join(app(snap1), 'sub', 'b.txt'), 'shared\n'), T1);
  at(write(path.join(app(snap2), 'a.js'), 'v2 a longer\n'), T2);
  at(write(path.join(app(snap2), 'sub', 'b.txt'), 'shared\n'), T1);
  return { snap1, snap2, loc: (extra = []) => only({ dirs: { vss: [snap1 + '=C:\\', snap2 + '=C:\\', ...extra] } }) };
}

const notesOf = (perSource) => (perSource.find((s) => s.id === 'vss') || {}).notes || [];

/** A scan context built by hand, to give the source prior hits as another source would. */
const ctxOf = (vssLocations, matcher, prior = []) => ({
  matcher, containing: null, unnamed: false, locations: { vss: vssLocations },
  notes: [], stats: {}, progress() {}, prior,
});

/** A drive letter for a fixture snapshot that is not the one `p` lives on. */
const otherDrive = (p) => (driveKeyOf(p) === 'd:' ? 'E:\\' : 'D:\\');

test('rebuild/under mode returns every file below the folder from each snapshot on the drive', async () => {
  const s = makeSnapshots();
  const { results } = await search({ under: 'C:\\Users\\me\\app', sources: ['vss'], locations: s.loc() });
  assert.ok(results.every((r) => r.kind === 'shadow copy'));
  const byPath = results.map((r) => r.path).sort();
  assert.deepStrictEqual(byPath, [
    'C:\\Users\\me\\app\\a.js',
    'C:\\Users\\me\\app\\a.js',
    'C:\\Users\\me\\app\\sub\\b.txt',
  ]);
  // Two distinct versions of a.js; one merged b.txt.
  const aRows = results.filter((r) => r.path.endsWith('a.js'));
  assert.strictEqual(aRows.length, 2);
  const bRow = results.find((r) => r.path.endsWith('b.txt'));
  assert.strictEqual(bRow.copies, 2);
  // The newest a.js is snap2's.
  const newestA = aRows.sort((x, y) => y.time - x.time)[0];
  assert.strictEqual((await load(newestA, git)).toString(), 'v2 a longer\n');
});

test('identical bytes in two snapshots merge into one row', async () => {
  const s = makeSnapshots();
  const { results } = await search({ pattern: 'b.txt', sources: ['vss'], locations: s.loc(['walk=C:\\Users\\me\\app']) });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].path, 'C:\\Users\\me\\app\\sub\\b.txt');
  assert.strictEqual(results[0].copies, 2);
  assert.strictEqual((await load(results[0], git)).toString(), 'shared\n');
});

test('a name search over a walk folder finds each distinct version', async () => {
  const s = makeSnapshots();
  const { results } = await search({ pattern: '*.js', sources: ['vss'], locations: s.loc(['walk=C:\\Users\\me\\app']) });
  assert.deepStrictEqual(results.map((r) => path.win32.basename(r.path)), ['a.js', 'a.js']);
  const texts = (await Promise.all(results.map((r) => load(r, git)))).map((b) => b.toString()).sort();
  assert.deepStrictEqual(texts, ['v1 a\n', 'v2 a longer\n']);
});

test('a name search looks in the folders of what the other sources found', async () => {
  const s = makeSnapshots();
  const vssLoc = [s.snap1 + '=C:\\', s.snap2 + '=C:\\'];
  const prior = [{ path: 'C:\\Users\\me\\app\\sub\\gone.txt' }];
  const found = await vss.scan(ctxOf(vssLoc, compile('*.txt'), prior));
  assert.deepStrictEqual(found.map((c) => c.path), ['C:\\Users\\me\\app\\sub\\b.txt', 'C:\\Users\\me\\app\\sub\\b.txt']);
  assert.ok(found.every((c) => c.kind === 'shadow copy' && c.file.startsWith(path.dirname(s.snap1))));
  // Only that folder, not the one above it.
  assert.deepStrictEqual(await vss.scan(ctxOf(vssLoc, compile('*.js'), prior)), []);
  assert.deepStrictEqual(await vss.scan(ctxOf(vssLoc, compile('*.txt'), [])), []);
});

test('a file at a drive root is found through a prior hit there', async () => {
  const base = workDir('vss-driveroot');
  dirs.push(base);
  const snap = path.join(base, 'snap');
  at(write(path.join(snap, 'notes.txt'), 'n\n'), T1);
  // The root as given with a trailing separator, and without one.
  for (const root of [snap, snap + path.sep]) {
    const found = await vss.scan(ctxOf([root + '=C:\\'], compile('notes.txt'), [{ path: 'C:\\notes.txt' }]));
    assert.deepStrictEqual(found.map((c) => c.path), ['C:\\notes.txt'], root);
  }
  assert.strictEqual(snapDir(snap, []), snap + path.sep);
  assert.strictEqual(snapDir(snap + path.sep, []), snap + path.sep);
  assert.strictEqual(snapDir(snap, ['a']), path.join(snap, 'a'));
});

test('AppData, node_modules and .git are skipped in a walk', async () => {
  const base = workDir('vss-skip');
  dirs.push(base);
  const app = path.join(base, 'snap', 'Users', 'me', 'app');
  at(write(path.join(app, 'keep.js'), 'k\n'), T1);
  at(write(path.join(app, 'node_modules', 'dep', 'x.js'), 'n\n'), T1);
  at(write(path.join(app, '.git', 'y.js'), 'g\n'), T1);
  at(write(path.join(app, 'AppData', 'z.js'), 'a\n'), T1);
  const loc = only({ dirs: { vss: [path.join(base, 'snap') + '=C:\\', 'walk=C:\\Users\\me\\app'] } });
  const { results } = await search({ pattern: '*.js', sources: ['vss'], locations: loc });
  assert.deepStrictEqual(results.map((r) => r.path), ['C:\\Users\\me\\app\\keep.js']);
});

test('a walk folder on another drive than the snapshot is not searched', async () => {
  const s = makeSnapshots();
  const { results } = await search({ pattern: '*.js', sources: ['vss'], locations: s.loc(['walk=D:\\Users\\me\\app']) });
  // The snapshots are of C:; the same folder on D: has nothing to give.
  assert.strictEqual(results.length, 0);
});

test('under mode ignores a snapshot mapped to a different drive', async () => {
  const base = workDir('vss-drive');
  dirs.push(base);
  at(write(path.join(base, 'snap', 'Users', 'me', 'app', 'a.js'), 'x\n'), T1);
  const loc = only({ dirs: { vss: [path.join(base, 'snap') + '=D:\\'] } });
  const { results } = await search({ under: 'C:\\Users\\me\\app', sources: ['vss'], locations: loc });
  assert.strictEqual(results.length, 0);
});

// A junction inside a snapshot is resolved by Windows against the live volume, so a folder
// reached through one must not be read as it stands. fs.symlinkSync(..., 'junction') makes a
// junction on Windows without elevation, and a plain symlink elsewhere.
test('a folder reached through a link that leads outside the snapshot is not read, and says so', async () => {
  const base = workDir('vss-escape');
  dirs.push(base);
  const snap = path.join(base, 'snap');
  const outside = path.join(base, 'live');
  write(path.join(outside, 'live.txt'), 'LIVE bytes\n');
  fs.mkdirSync(path.join(snap, 'Users', 'me'), { recursive: true });
  fs.symlinkSync(outside, path.join(snap, 'Users', 'me', 'proj'), 'junction');
  // Mapped to a drive the target is not on, so the target is outside this snapshot.
  const drive = otherDrive(outside);
  const folder = drive + 'Users\\me\\proj';
  const said = (notes) => notes.some((n) => n.startsWith(folder + ': skipped') && /link or \.\./.test(n));

  const under = await search({ under: folder, sources: ['vss'], locations: only({ dirs: { vss: [snap + '=' + drive] } }) });
  assert.strictEqual(under.results.length, 0, 'under mode');
  assert.ok(said(notesOf(under.perSource)), 'under mode note');

  const walk = await search({ pattern: '*.txt', sources: ['vss'], locations: only({ dirs: { vss: [snap + '=' + drive, 'walk=' + folder] } }) });
  assert.strictEqual(walk.results.length, 0, 'walk folder');
  assert.ok(said(notesOf(walk.perSource)), 'walk folder note');

  const ctx = ctxOf([snap + '=' + drive], compile('*.txt'), [{ path: folder + '\\gone.txt' }]);
  assert.deepStrictEqual(await vss.scan(ctx), [], 'prior hit');
  assert.ok(said(ctx.notes), 'prior hit note');
  // Deeper below the link, the same.
  const deeper = ctxOf([snap + '=' + drive], compile('*.txt'), [{ path: folder + '\\a\\b\\gone.txt' }]);
  assert.deepStrictEqual(await vss.scan(deeper), []);
  assert.ok(deeper.notes.some((n) => n.startsWith(folder + '\\a\\b: skipped')));
});

test('a link to a folder on the snapshot\'s own drive is followed inside the same snapshot', async () => {
  const base = workDir('vss-follow');
  dirs.push(base);
  const snap = path.join(base, 'snap');
  // On Windows the target is a real folder holding "live" bytes; the snapshot has its own,
  // older copy of that folder at the same place below its root. Elsewhere a symlink's target is
  // just text, so a Windows-looking one stands in.
  const win = process.platform === 'win32';
  const target = win ? path.join(base, 'live') : 'C:\\live';
  if (win) write(path.join(target, 'live.txt'), 'LIVE bytes\n');
  const drive = target.slice(0, 2) + '\\';
  at(write(path.join(snap, ...relBelowDrive(target), 'old.txt'), 'snapshot copy\n'), T1);
  fs.mkdirSync(path.join(snap, 'Users', 'me'), { recursive: true });
  fs.symlinkSync(target, path.join(snap, 'Users', 'me', 'proj'), 'junction');

  const { results } = await search({ under: drive + 'Users\\me\\proj', sources: ['vss'], locations: only({ dirs: { vss: [snap + '=' + drive] } }) });
  assert.deepStrictEqual(results.map((r) => r.path), [drive + 'Users\\me\\proj\\old.txt']);
  assert.ok(results[0].file.startsWith(snap + path.sep), 'read from inside the snapshot');
  assert.strictEqual((await load(results[0], git)).toString(), 'snapshot copy\n');
});

test('a relative link is followed inside the snapshot; a link loop and ".." are not', async () => {
  const base = workDir('vss-relative');
  dirs.push(base);
  const snap = path.join(base, 'snap');
  const me = path.join(snap, 'Users', 'me');
  at(write(path.join(me, 'real', 'r.txt'), 'r\n'), T1);
  write(path.join(base, 'outside', 'o.txt'), 'o\n');
  let linked = true;
  try {
    fs.symlinkSync('real', path.join(me, 'rel'), 'dir');
    fs.symlinkSync(path.join('..', 'me', 'loopB'), path.join(me, 'loopA'), 'dir');
    fs.symlinkSync('loopA', path.join(me, 'loopB'), 'dir');
  } catch (e) {
    if (e.code !== 'EPERM') throw e;
    linked = false; // a relative symlink on Windows needs developer mode or elevation
  }
  const vssLoc = [snap + '=C:\\'];
  if (linked) {
    const rel = await vss.scan(ctxOf(vssLoc, compile('*.txt'), [{ path: 'C:\\Users\\me\\rel\\x.txt' }]));
    assert.deepStrictEqual(rel.map((c) => c.path), ['C:\\Users\\me\\rel\\r.txt']);
    const loop = ctxOf(vssLoc, compile('*.txt'), [{ path: 'C:\\Users\\me\\loopA\\x.txt' }]);
    assert.deepStrictEqual(await vss.scan(loop), []);
    assert.ok(loop.notes.some((n) => /loopA: skipped/.test(n)));
  }
  // '..' climbing out of the snapshot folder, to its sibling.
  const dots = ctxOf([snap + '=C:\\', 'walk=C:\\Users\\..\\..\\outside'], compile('*.txt'));
  assert.deepStrictEqual(await vss.scan(dots), []);
  assert.ok(dots.notes.some((n) => n.startsWith('C:\\Users\\..\\..\\outside: skipped')));
});

test('links among a folder\'s entries are never followed', async () => {
  const base = workDir('vss-entries');
  dirs.push(base);
  const snap = path.join(base, 'snap');
  const app = path.join(snap, 'Users', 'me', 'app');
  at(write(path.join(app, 'keep.txt'), 'k\n'), T1);
  write(path.join(base, 'outside', 'o.txt'), 'o\n');
  fs.symlinkSync(path.join(base, 'outside'), path.join(app, 'linkdir'), 'junction');
  let fileLink = true;
  try {
    fs.symlinkSync(path.join(base, 'outside', 'o.txt'), path.join(app, 'linked.txt'), 'file');
  } catch (e) {
    if (e.code !== 'EPERM') throw e;
    fileLink = false; // a file symlink on Windows needs developer mode or elevation
  }
  const loc = only({ dirs: { vss: [snap + '=C:\\'] } });
  const { results } = await search({ under: 'C:\\Users\\me\\app', sources: ['vss'], locations: loc });
  assert.deepStrictEqual(results.map((r) => r.path), ['C:\\Users\\me\\app\\keep.txt']);
  const prior = [{ path: 'C:\\Users\\me\\app\\gone.txt' }];
  const shallow = await vss.scan(ctxOf([snap + '=C:\\'], compile('*.txt'), prior));
  assert.deepStrictEqual(shallow.map((c) => c.path), ['C:\\Users\\me\\app\\keep.txt'], fileLink ? 'file link skipped' : 'no file link here');
});

test('system folders and whole drives are never walked', async () => {
  const base = workDir('vss-system');
  dirs.push(base);
  const snap = path.join(base, 'snap');
  at(write(path.join(snap, 'Windows', 'System32', 'config', 'SAM'), 'hive\n'), T1);
  at(write(path.join(snap, 'Windows', 'notepad.txt'), 'w\n'), T1);
  at(write(path.join(snap, 'System Volume Information', 'x.txt'), 's\n'), T1);
  at(write(path.join(snap, 'Windows.old', 'Windows', 'System32', 'config', 'SYSTEM'), 'hive\n'), T1);
  at(write(path.join(snap, 'Windows.old', 'Windows', 'kept.txt'), 'k\n'), T1);
  at(write(path.join(snap, 'Users', 'me', 'a.txt'), 'a\n'), T1);
  const loc = (extra = []) => only({ dirs: { vss: [snap + '=C:\\', ...extra] } });
  const under = (folder) => search({ under: folder, sources: ['vss'], locations: loc() });

  const whole = await under('C:\\');
  assert.strictEqual(whole.results.length, 0, 'a drive root');
  assert.ok(notesOf(whole.perSource).some((n) => n.startsWith('C:\\: a whole drive is not walked')));

  for (const folder of ['C:\\Windows', 'C:\\Windows\\System32\\config', 'C:\\System Volume Information']) {
    const r = await under(folder);
    assert.strictEqual(r.results.length, 0, folder);
    assert.ok(notesOf(r.perSource).some((n) => n.startsWith(folder + ': skipped; system folders')), folder);
  }

  const old = await under('C:\\Windows.old');
  assert.deepStrictEqual(old.results.map((r) => r.path), ['C:\\Windows.old\\Windows\\kept.txt']);
  assert.ok(notesOf(old.perSource).some((n) => n.startsWith('C:\\Windows.old\\Windows\\System32\\config: skipped')));

  const walked = await search({ pattern: '*', sources: ['vss'], locations: loc(['walk=C:\\Windows', 'walk=C:\\']) });
  assert.strictEqual(walked.results.length, 0, 'walk folders');
  const prior = await vss.scan(ctxOf([snap + '=C:\\'], compile('SAM'), [{ path: 'C:\\Windows\\System32\\config\\SAM.LOG1' }]));
  assert.deepStrictEqual(prior, [], 'a prior hit inside config');

  assert.strictEqual(isSystemFolder(['WINDOWS', 'Temp']), true);
  assert.strictEqual(isSystemFolder(['Backup', 'Windows', 'System32', 'Config']), true);
  assert.strictEqual(isSystemFolder(['Users', 'me', 'Windows']), false);
  assert.strictEqual(isSystemFolder([]), false);
});

test('a folder reached through a link into a system folder is not read either', async () => {
  const base = workDir('vss-syslink');
  dirs.push(base);
  const snap = path.join(base, 'snap');
  // The link's target is a System32\config on the snapshot's own drive. On Windows that is a
  // fixture folder, never the real one; elsewhere a symlink's target is just text.
  const win = process.platform === 'win32';
  const target = win ? path.join(base, 'System32', 'config') : 'C:\\Windows\\System32\\config';
  if (win) write(path.join(target, 'SAM'), 'live hive\n');
  const drive = target.slice(0, 2) + '\\';
  at(write(path.join(snap, ...relBelowDrive(target), 'SAM'), 'hive\n'), T1);
  fs.mkdirSync(path.join(snap, 'Users', 'me'), { recursive: true });
  fs.symlinkSync(target, path.join(snap, 'Users', 'me', 'cfg'), 'junction');
  const folder = drive + 'Users\\me\\cfg';
  const { results, perSource } = await search({ under: folder, sources: ['vss'], locations: only({ dirs: { vss: [snap + '=' + drive] } }) });
  assert.strictEqual(results.length, 0);
  assert.ok(notesOf(perSource).some((n) => n.startsWith(folder + ': skipped; system folders')));
});

test('a walk stops at its folder budget and says it was cut', () => {
  const base = workDir('vss-budget');
  dirs.push(base);
  const snap = { root: path.join(base, 'snap'), driveRoot: 'C:\\', driveKey: 'c:' };
  for (const d of ['a', 'b', 'c']) at(write(path.join(snap.root, 'top', d, 'f.txt'), d), T1);
  const ctx = ctxOf([], compile('*.txt'));
  const out = [];
  const budget = { dirs: 0, max: 2, cut: false };
  walkSubtree(snap, ['top'], ctx, out, { unreadable: 0, outside: new Set(), system: new Set(), whole: new Set() }, budget);
  assert.strictEqual(budget.cut, true);
  assert.strictEqual(budget.dirs, 2);
  assert.strictEqual(out.length, 1, 'only the folders within the budget were read');
});

test('a file that cannot be opened is skipped with a note that says so', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, async () => {
  // chmod does not deny reading on Windows, and root reads anything.
  const base = workDir('vss-unreadable');
  dirs.push(base);
  const snap = path.join(base, 'snap');
  at(write(path.join(snap, 'Users', 'me', 'ok.txt'), 'ok\n'), T1);
  const locked = write(path.join(snap, 'Users', 'me', 'locked.txt'), 'locked\n');
  fs.chmodSync(locked, 0o000);
  try {
    const { results, perSource } = await search({ under: 'C:\\Users\\me', sources: ['vss'], locations: only({ dirs: { vss: [snap + '=C:\\'] } }) });
    assert.deepStrictEqual(results.map((r) => r.path), ['C:\\Users\\me\\ok.txt']);
    assert.ok(notesOf(perSource).includes('1 file(s) in the snapshot could not be read and were skipped.'));
  } finally {
    fs.chmodSync(locked, 0o644);
  }
});

test('no readable shadow copies gives a note and nothing', async () => {
  const { results, perSource } = await search({ pattern: 'a.js', sources: ['vss'], locations: only({ dirs: { vss: [] } }) });
  assert.strictEqual(results.length, 0);
  assert.ok(notesOf(perSource).some((n) => /No shadow copies/.test(n)));
});

test('bytesPresent is a can-it-be-read check', () => {
  const base = workDir('vss-bytes');
  dirs.push(base);
  const file = write(path.join(base, 'f.bin'), Buffer.alloc(1000, 7));
  const empty = write(path.join(base, 'e.bin'), Buffer.alloc(0));
  assert.strictEqual(bytesPresent(file, 1000), true);
  assert.strictEqual(bytesPresent(empty, 0), true);
  assert.strictEqual(bytesPresent(path.join(base, 'missing.bin'), 5), false);
  assert.strictEqual(bytesPresent(base, 5), false, 'a folder does not read as a file');
});

test('parseLocations reads the three location forms', () => {
  const { snaps, walkFolders } = parseLocations([
    'C:\\snapA=C:\\',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy4',
    'walk=C:\\Users\\me\\Desktop',
    '  ',
  ]);
  assert.deepStrictEqual(snaps, [
    { root: 'C:\\snapA', driveRoot: 'C:\\' },
    { root: '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy4', driveRoot: null },
  ]);
  assert.deepStrictEqual(walkFolders, ['C:\\Users\\me\\Desktop']);
});

test('only a device root is mapped by serial, and only a bare drive root is taken as a mapping', () => {
  const s = makeSnapshots();
  const notes = [];
  const out = resolveSnapshots([s.snap1, s.snap2 + '=C:\\Users', s.snap2 + '=\\\\srv\\share', s.snap1 + '=d:'], notes);
  assert.deepStrictEqual(out, [{ root: s.snap1, driveRoot: 'd:\\', driveKey: 'd:' }]);
  assert.ok(notes[0].startsWith(s.snap1 + ': not a shadow-copy device'));
  assert.ok(notes[1].startsWith(s.snap2 + ': C:\\Users is not a drive root'));
  assert.ok(notes[2].startsWith(s.snap2 + ': \\\\srv\\share is not a drive root'));
  assert.strictEqual(notes.length, 3);
});

test('a device root with no drive to match is skipped with a note', { skip: process.platform === 'win32' }, () => {
  // Off Windows there are no live drives, so nothing can match; on Windows this would probe a
  // real device, which a test must not do.
  const notes = [];
  const dev = '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy9';
  assert.deepStrictEqual(resolveSnapshots([dev], notes), []);
  assert.deepStrictEqual(notes, [dev + ': could not tell which drive this snapshot belongs to; skipped.']);
});

test('drives that share a serial are told apart by folder id, and never guessed', () => {
  const tops = [{ name: 'Users', dev: 7n, ino: 100n }, { name: 'Program Files', dev: 7n, ino: 200n }];
  // C: is the real volume; X: a subst drive of a folder on it (same serial, no such folders);
  // E: a clone (same serial and the same folder ids).
  const stats = {
    'C:\\Users': { dev: 7n, ino: 100n },
    'C:\\Program Files': { dev: 7n, ino: 200n },
    'X:\\Users': { dev: 7n, ino: 555n },
    'E:\\Users': { dev: 7n, ino: 100n },
  };
  const stat = (p) => {
    if (!stats[p]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return stats[p];
  };
  assert.strictEqual(pickDrive(['C:\\'], tops, stat), 'C:\\', 'one letter: that one');
  assert.strictEqual(pickDrive(['C:\\', 'X:\\'], tops, stat), 'C:\\', 'the subst drive has other folders');
  assert.strictEqual(pickDrive(['X:\\', 'C:\\'], tops, stat), 'C:\\', 'whatever the order');
  assert.strictEqual(pickDrive(['C:\\', 'E:\\'], tops, stat), null, 'a clone cannot be told apart');
  assert.strictEqual(pickDrive(['X:\\', 'Y:\\'], tops, stat), null, 'none matches');
  assert.strictEqual(pickDrive([], tops, stat), null);
  assert.strictEqual(pickDrive(undefined, tops, stat), null);
});

test('path helpers rebuild Windows original paths whatever the platform', () => {
  assert.deepStrictEqual(relBelowDrive('C:\\a\\b\\c.txt'), ['a', 'b', 'c.txt']);
  assert.deepStrictEqual(relBelowDrive('C:/a/b'), ['a', 'b']);
  assert.strictEqual(driveKeyOf('C:\\a'), 'c:');
  assert.strictEqual(driveKeyOf('\\\\?\\GLOBALROOT\\x'), null);
  assert.strictEqual(normalizeDriveRoot('C:'), 'C:\\');
  assert.strictEqual(normalizeDriveRoot('C:\\'), 'C:\\');
  assert.strictEqual(toOriginal('C:\\', ['Users', 'me', 'a.js']), 'C:\\Users\\me\\a.js');
});

test('describe lists a mapped snapshot with its time in local time, and reports when there are none', () => {
  const s = makeSnapshots();
  at(path.join(s.snap1, 'Users'), T2);
  const lines = vss.describe({ locations: { vss: [s.snap1 + '=C:\\'] } });
  assert.ok(lines.some((l) => l.includes(s.snap1) && /drive C:/.test(l)));
  assert.ok(lines.some((l) => l.endsWith('taken about ' + fmt.when(T2))), 'the same local form as WHEN');
  const empty = vss.describe({ locations: { vss: [] } });
  assert.ok(empty.some((l) => /No shadow copies/.test(l)));
});

test('the device probe takes what lists, stops at its ceiling and writes nothing', () => {
  const base = workDir('vss-probe');
  dirs.push(base);
  fs.mkdirSync(path.join(base, 'dev2'));
  write(path.join(base, 'dev3'), 'a file, not a device\n');
  fs.mkdirSync(path.join(base, 'dev4'));
  fs.mkdirSync(path.join(base, 'dev6'));
  const before = snapshot(base);
  assert.deepStrictEqual(probeDevices(path.join(base, 'dev'), 5), [path.join(base, 'dev2'), path.join(base, 'dev4')]);
  assert.deepStrictEqual(snapshot(base), before);
  // The real probe runs on Windows only; elsewhere it finds nothing without looking.
  if (process.platform !== 'win32') assert.deepStrictEqual(discover(), []);
});
