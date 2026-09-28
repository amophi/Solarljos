'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { workDir, cleanup, write } = require('./helpers');
const { compile } = require('../src/match');
const { pathKey } = require('../src/paths');
const { planRebuild, restore } = require('../src/restore');
const { safeName } = require('../src/restore')._internal;
const { resolveLocations } = require('../src/locations');
const { dedupe } = require('../src/search')._internal;
const { git } = require('../src/search');
const { tier, fidelity } = require('../src/quality');

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
