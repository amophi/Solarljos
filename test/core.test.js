'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { workDir, cleanup, write } = require('./helpers');
const { compile } = require('../src/match');
const { pathKey } = require('../src/paths');
const { planRebuild, leftOutOf, restore } = require('../src/restore');
const { safeName } = require('../src/restore')._internal;
const { resolveLocations } = require('../src/locations');
const { dedupe } = require('../src/search')._internal;
const { git } = require('../src/search');
const { FIDELITY, tier, fidelity, better, isDerived, isUnverified } = require('../src/quality');

const dirs = [];
after(() => dirs.forEach(cleanup));

test('a decomposed name (as macOS writes Hangul) matches the composed one', () => {
  const composed = '보고서.txt';
  const decomposed = composed.normalize('NFD');
  assert.notStrictEqual(composed, decomposed);
  assert.ok(compile('보고서').test('/Users/a/' + decomposed));
  assert.ok(compile(decomposed.slice(0, 6)).test('C:\\docs\\' + composed));
  assert.strictEqual(pathKey('/a/' + decomposed), pathKey('/a/' + composed));
});

test('a merged result is a draft only when every copy of it was never saved', () => {
  const base = { path: 'C:\\a.txt', hash: 'h', kind: 'k' };
  const [mixed] = dedupe([{ ...base, draft: true, time: 2 }, { ...base, kind: 'j', time: 1 }]);
  assert.strictEqual(mixed.draft, false, 'the same bytes were found saved somewhere');
  const [both] = dedupe([{ ...base, draft: true, time: 2 }, { ...base, kind: 'j', draft: true, time: 1 }]);
  assert.strictEqual(both.draft, true);
});

test('rebuild takes a draft only for a path with no saved copy, however new it is', () => {
  const plan = planRebuild([
    { path: 'C:\\p\\a.txt', time: 99, kind: 'unsaved', draft: true, text: 'draft' },
    { path: 'C:\\p\\a.txt', time: 1, kind: 'local history', text: 'saved' },
    { path: 'C:\\p\\b.txt', time: 5, kind: 'unsaved', draft: true, text: 'only' },
  ], 'C:\\p');
  assert.deepStrictEqual(plan.map((p) => [p.rel[0], p.copy.text]), [['a.txt', 'saved'], ['b.txt', 'only']]);
});

test('a saved copy represents merged identical copies, even when a draft of them is newer', () => {
  const base = { path: 'C:\\a.txt', hash: 'h' };
  const [row] = dedupe([
    { ...base, kind: 'unsaved editor buffer', draft: true, time: 9 },
    { ...base, kind: 'local history', time: 1 },
  ]);
  assert.strictEqual(row.kind, 'local history');
  assert.strictEqual(row.time, 1);
  assert.strictEqual(row.copies, 2);
});

test('rebuild takes an inexact copy only where no exact one exists', () => {
  const plan = planRebuild([
    { path: 'C:\\p\\a.txt', time: 9, kind: 'git, line endings differ', text: 'crlf?' },
    { path: 'C:\\p\\a.txt', time: 1, kind: 'recycle bin', text: 'exact' },
    { path: 'C:\\p\\b.txt', time: 9, kind: 'unsaved editor buffer', draft: true, text: 'draft' },
    { path: 'C:\\p\\b.txt', time: 1, kind: 'git, filter not run', text: 'stored' },
  ], 'C:\\p');
  assert.deepStrictEqual(plan.map((p) => p.copy.text), ['exact', 'stored']);
});

test('names Windows cannot hold are made safe; others pass through', () => {
  if (process.platform === 'win32') {
    assert.strictEqual(safeName('a:b.txt'), 'a_b.txt', 'a colon would write an alternate data stream');
    assert.strictEqual(safeName('what?.md'), 'what_.md');
    assert.strictEqual(safeName('trailing. '), 'trailing__');
    assert.strictEqual(safeName('CON'), '_CON');
    assert.strictEqual(safeName('nul.txt'), '_nul.txt');
    assert.strictEqual(safeName('..'), '__', 'trailing dots would be dropped');
  } else {
    assert.strictEqual(safeName('a:b.txt'), 'a:b.txt');
    assert.strictEqual(safeName('..'), '_..');
  }
  assert.strictEqual(safeName('plain.txt'), 'plain.txt');
});

test('a restored name with a colon never touches an existing file on Windows', async () => {
  const root = workDir('core');
  dirs.push(root);
  const existing = write(path.join(root, 'a'), 'keep me');
  const target = await restore({ id: 'x', path: '/home/u/a:b', text: 'data' }, root, [], git);
  assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'keep me');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'data');
  if (process.platform === 'win32') assert.strictEqual(path.basename(target), 'a_b');
});

test('a destination reached through a link into a source is refused', async () => {
  const root = workDir('core');
  dirs.push(root);
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const link = path.join(root, 'link');
  fs.symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(restore({ id: 'x', path: '/a.txt', text: 'a' }, path.join(link, 'out'), [source], git), /Refusing/);
  assert.deepStrictEqual(fs.readdirSync(source), []);
});

test('--location adds to the places of the older sources instead of replacing them', () => {
  const loc = resolveLocations({
    discover: false,
    antigravityDirs: ['given'],
    claudeDir: 'claude-given',
    dirs: { antigravity: ['located'], recycle: ['bin'], claude: ['claude-a', 'claude-b'], vss: ['x=y'] },
  });
  assert.deepStrictEqual(loc.antigravity.map((p) => path.basename(p)), ['given', 'located']);
  assert.deepStrictEqual(loc.recycle.map((p) => path.basename(p)), ['bin']);
  assert.deepStrictEqual(loc.claude.map((p) => path.basename(p)), ['claude-given', 'claude-a', 'claude-b'], 'every Claude folder given, either way');
  assert.deepStrictEqual(loc.vss, ['x=y'], 'a newer source reads its own entries');
});

/** This machine's places, made up, so that discovery can be tested without looking at the real ones. */
const machine = {
  recycle: () => [],
  history: () => [],
  claude: () => [path.resolve('found-claude')],
  antigravity: () => [],
  cwd: () => path.resolve('the-current-folder'),
};

test('a found ~/.claude is searched beside the ones given, not replaced by them', () => {
  const loc = resolveLocations({ machine, claudeDir: 'claude-given', dirs: { claude: ['claude-a'] } });
  assert.deepStrictEqual(loc.claude.map((p) => path.basename(p)), ['claude-given', 'claude-a', 'found-claude']);
  assert.strictEqual(resolveLocations({ machine, dirs: { claude: [path.resolve('FOUND-CLAUDE')] } }).claude.length,
    process.platform === 'win32' ? 1 : 2, 'one folder given in another case is one folder on Windows');
});

test('git looks in the current folder only when no folder is given, by --repo or --location git= or repos=', () => {
  const repos = (o) => resolveLocations({ machine, ...o }).repos.map((p) => path.basename(p));
  assert.deepStrictEqual(repos({}), ['the-current-folder']);
  assert.deepStrictEqual(repos({ repos: ['code'] }), ['code']);
  assert.deepStrictEqual(repos({ dirs: { git: ['code'] } }), ['code']);
  assert.deepStrictEqual(repos({ dirs: { repos: ['old'] } }), ['old']);
  assert.deepStrictEqual(repos({ repos: ['a'], dirs: { git: ['b'], repos: ['c'] } }), ['a', 'b', 'c']);
  assert.deepStrictEqual(repos({ discover: false }), []);
  assert.strictEqual(resolveLocations({ machine, dirs: { git: ['code'] } }).git, undefined, 'git reads them all from repos');
});

test('an editor\'s text of a file is not exact, so an older exact copy is taken over it', () => {
  const plan = planRebuild([
    { path: 'C:\\p\\a.txt', time: 9, kind: 'jetbrains history, as text', text: 'lf, no bom' },
    { path: 'C:\\p\\a.txt', time: 1, kind: 'shadow copy', text: 'exact' },
    { path: 'C:\\p\\b.txt', time: 9, kind: 'jetbrains history, as text', text: 'only this' },
  ], 'C:\\p');
  assert.deepStrictEqual(plan.map((p) => p.copy.text), ['exact', 'only this']);
  assert.strictEqual(tier({ kind: 'jetbrains history, as text' }), tier({ kind: 'git, line endings differ' }));
  assert.strictEqual(fidelity({ kind: 'git, Git LFS pointer' }), 0, 'checkout writes the pointer itself');
});

test('five tiers -- exact, inexact, draft, unverified, derived -- set by a copy\'s flags or its kind', () => {
  assert.strictEqual(tier({ kind: 'recycle bin' }), 0);
  assert.strictEqual(tier({ kind: 'git, filter not run' }), 1);
  assert.strictEqual(tier({ kind: 'fat undelete', inexact: true }), 1);
  assert.strictEqual(tier({ kind: 'unsaved editor buffer', draft: true }), 2);
  assert.strictEqual(tier({ kind: 'fat undelete', unverified: true }), 3);
  assert.strictEqual(tier({ kind: 'carved' }), 3, 'carved out of free space is never more, whatever its flags');
  assert.strictEqual(tier({ kind: 'carved', inexact: true }), 3);
  assert.strictEqual(tier({ kind: 'thumbnail' }), 4);
  assert.strictEqual(tier({ kind: 'thumbnail, name unknown' }), 4);
  assert.strictEqual(tier({ kind: 'web image', derived: true, draft: true }), 4, 'the least trusted flag decides');
  assert.strictEqual(tier({ kind: 'exfat undelete' }), 0, 'an undelete says with its flags what it is');
  assert.strictEqual(tier({ kind: 'snipping tool capture' }), 0, 'the capture itself');
  assert.ok(isDerived({ kind: 'thumbnail' }) && isDerived({ kind: 'x', derived: true }) && !isDerived({ kind: 'carved' }));
  assert.ok(isUnverified({ kind: 'carved' }) && isUnverified({ kind: 'x', unverified: true }) && !isUnverified({ kind: 'thumbnail' }));
  for (const kind of ['thumbnail', 'thumbnail, name unknown', 'fat undelete', 'exfat undelete', 'carved', 'snipping tool capture']) {
    assert.ok(kind in FIDELITY, kind);
  }
  assert.ok(fidelity({ kind: 'exfat undelete' }) < fidelity({ kind: 'fat undelete' }), 'a recorded extent before an assumed one');
  assert.ok(fidelity({ kind: 'fat undelete' }) < fidelity({ kind: 'carved' }));
});

test('any copy of a better tier wins, however old; a newer one wins only within its tier', () => {
  const copies = [
    { kind: 'thumbnail', time: 50 },
    { kind: 'carved', time: 40 },
    { kind: 'unsaved editor buffer', draft: true, time: 30 },
    { kind: 'git, line endings differ', time: 20 },
    { kind: 'recycle bin', time: 10 },
  ];
  const ranked = [...copies].sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
  assert.deepStrictEqual(ranked.map((c) => c.kind), ['recycle bin', 'git, line endings differ', 'unsaved editor buffer', 'carved', 'thumbnail']);
  assert.ok(better({ kind: 'carved', time: 2 }, { kind: 'carved', time: 1 }));
  assert.ok(better({ kind: 'fat undelete', unverified: true, time: 1 }, { kind: 'carved', time: 1 }), 'fidelity breaks a tie');
  assert.ok(better({ kind: 'thumbnail', time: 1 }, { kind: 'thumbnail', time: null }), 'a dated copy before an undated one');
});

test('rebuild takes no copy that may be incomplete or is only a smaller copy, and lists those paths apart', () => {
  const results = [
    { path: 'C:\\p\\a.jpg', time: 9, kind: 'thumbnail', text: 'small' },
    { path: 'C:\\p\\a.jpg', time: 1, kind: 'recycle bin', text: 'whole' },
    { path: 'C:\\p\\b.jpg', time: 9, kind: 'thumbnail', text: 'only small' },
    { path: 'C:\\p\\c.mp4', time: 9, kind: 'fat undelete', unverified: true, text: 'maybe' },
    { path: 'C:\\p\\c.mp4', time: 8, kind: 'thumbnail', text: 'a frame' },
    { path: 'C:\\p\\d.txt', time: 9, kind: 'unsaved editor buffer', draft: true, text: 'draft' },
  ];
  assert.deepStrictEqual(planRebuild(results, 'C:\\p').map((p) => [p.rel[0], p.copy.text]), [['a.jpg', 'whole'], ['d.txt', 'draft']]);
  assert.deepStrictEqual(leftOutOf(results, 'C:\\p').map((p) => [p.rel[0], p.copy.text]), [['b.jpg', 'only small'], ['c.mp4', 'maybe']],
    'each with its best copy: one that may be whole before a smaller one');
});

test('merged identical copies are unverified, or derived, only when every one of them is', () => {
  const base = { path: 'E:\\DCIM\\a.jpg', hash: 'h' };
  const [whole] = dedupe([{ ...base, kind: 'fat undelete', unverified: true, time: 2 }, { ...base, kind: 'recycle bin', time: 1 }]);
  assert.strictEqual(whole.unverified, false, 'the same bytes found whole elsewhere');
  assert.strictEqual(whole.kind, 'recycle bin');
  assert.strictEqual(tier(whole), 0);
  const [both] = dedupe([{ ...base, kind: 'fat undelete', unverified: true, time: 2 }, { ...base, kind: 'carved', unverified: true, time: 2 }]);
  assert.strictEqual(both.unverified, true);
  assert.strictEqual(both.kind, 'fat undelete');
  const [small] = dedupe([{ ...base, kind: 'x', derived: true, time: 1 }, { ...base, kind: 'y', derived: true, time: 1 }]);
  assert.strictEqual(small.derived, true);
});

test('a kind that is always unverified counts as one when merged, flag or no flag', () => {
  const base = { path: 'E:\\DCIM\\a.jpg', hash: 'h', time: 2 };
  // The undelete ranks first (fidelity 5 before 6), and the carve says what it is by its kind alone.
  for (const list of [[{ ...base, kind: 'fat undelete', unverified: true }, { ...base, kind: 'carved' }],
    [{ ...base, kind: 'carved' }, { ...base, kind: 'fat undelete', unverified: true }]]) {
    const [one] = dedupe(list);
    assert.strictEqual(one.kind, 'fat undelete');
    assert.strictEqual(tier(one), 3, 'two copies that may be incomplete are not one that is exact');
    assert.deepStrictEqual([one.copies, one.seen.sort()], [2, ['carved', 'fat undelete']]);
  }
  // A copy with an inexact kind and one flagged inexact are inexact together, in either order.
  const git = { ...base, kind: 'git, filter not run', time: 1 };
  const fat = { ...base, kind: 'exfat undelete', inexact: true, time: 3 };
  for (const list of [[git, fat], [fat, git]]) assert.strictEqual(tier(dedupe(list)[0]), 1);
  // One exact copy among them makes the bytes exact.
  assert.strictEqual(tier(dedupe([git, fat, { ...base, kind: 'recycle bin', time: 0 }])[0]), 0);
  // A copy found once keeps its own fields as they are.
  const [alone] = dedupe([{ ...base, kind: 'carved' }]);
  assert.strictEqual(alone.unverified, undefined);
  assert.strictEqual(tier(alone), 3);
});

test('a copy with no name that proves a named one whole counts as a copy of it', () => {
  // An undelete that may be incomplete, and the same bytes found whole where the name was lost.
  const named = { path: 'E:\\DCIM\\a.jpg', hash: 'h1', kind: 'fat undelete', unverified: true, time: 2 };
  const nameless = { path: null, hash: 'h1', kind: 'trash, name unknown', time: 1 };
  for (const list of [[named, nameless], [nameless, named]]) {
    const out = dedupe(list.map((c) => ({ ...c })));
    assert.strictEqual(out.length, 1);
    const [row] = out;
    assert.deepStrictEqual([row.path, row.kind, tier(row), row.copies, row.seen.sort()],
      ['E:\\DCIM\\a.jpg', 'fat undelete', 0, 2, ['fat undelete', 'trash, name unknown']]);
  }
  // A nameless copy no better than the named one leaves it as it was, but counted.
  const [still] = dedupe([{ ...named }, { path: null, hash: 'h1', kind: 'carved', time: 1 }]);
  assert.deepStrictEqual([tier(still), still.copies], [3, 2]);
  // Other bytes change nothing.
  assert.strictEqual(dedupe([{ ...named }, { ...nameless, hash: 'h2' }]).length, 2);
});
