'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { workDir, cleanup, write, infoV2, only, snapshot } = require('./helpers');
const { under } = require('../src/match');
const { planRebuild, rebuild } = require('../src/restore');
const { search, git } = require('../src/search');

const BIN = path.join(__dirname, '..', 'bin', 'solarljos.js');
const dirs = [];
after(() => dirs.forEach(cleanup));

const PROJ = 'C:\\work\\proj';

test('a folder matches what is below it, and nothing that merely starts with its name', () => {
  const m = under(PROJ);
  assert.ok(m.test('C:\\work\\proj\\a.js'));
  assert.ok(m.test('c:/WORK/Proj/sub/b.js'), 'any case, either separator');
  assert.ok(!m.test('C:\\work\\project\\a.js'));
  assert.ok(!m.test('C:\\work\\proj'), 'the folder itself is not a file below it');
  assert.strictEqual(m.literal, 'proj');
  assert.ok(under('/home/a/proj/').test('/home/a/proj/x'));
});

test('the newest copy of each path wins; on a tie, bytes from disk beat text an agent saw', () => {
  const plan = planRebuild([
    { path: 'C:\\work\\proj\\a.js', time: 1, kind: 'local history', text: 'old' },
    { path: 'C:\\work\\proj\\a.js', time: 5, kind: 'claude write', text: 'new' },
    { path: 'C:\\work\\proj\\b.js', time: 3, kind: 'claude read', text: 'as seen' },
    { path: 'C:\\work\\proj\\b.js', time: 3, kind: 'claude backup', file: 'x' },
    { path: 'C:\\work\\proj\\gone.txt', time: 9, kind: 'recycle bin', gone: true },
    { path: 'C:\\work\\proj\\dir', time: 9, kind: 'recycle bin', isDir: true },
    { path: 'C:\\elsewhere\\c.js', time: 9, kind: 'claude write', text: 'no' },
  ], PROJ);
  assert.deepStrictEqual(plan.map((p) => [p.rel.join('/'), p.copy.kind]), [
    ['a.js', 'claude write'],
    ['b.js', 'claude backup'],
  ]);
});

/** A project spread over three sources: history, a deleted folder in the bin, and Claude. */
function makeSources() {
  const root = workDir('rebuild');
  dirs.push(root);
  const history = path.join(root, 'History');
  write(path.join(history, 'f1', 'entries.json'), JSON.stringify({
    version: 1, resource: 'file:///c%3A/work/proj/src/main.js', entries: [{ id: 'a.js', timestamp: 1000 }],
  }));
  write(path.join(history, 'f1', 'a.js'), 'main v1');
  const bin = path.join(root, 'bin', 'S-1-5-21-1-1-1-1001');
  write(path.join(bin, '$IABCDEF'), infoV2('C:\\work\\proj\\assets', 10, 5000));
  write(path.join(bin, '$RABCDEF', 'logo.svg'), '<svg/>');
  write(path.join(bin, '$RABCDEF', 'fonts', 'a.woff'), Buffer.from([0, 1, 2, 3]));
  const claudeDir = path.join(root, 'claude');
  write(path.join(claudeDir, 'projects', 'p', '11111111-2222-3333-4444-555555555555.jsonl'), [
    { type: 'user', timestamp: new Date(3000).toISOString(), toolUseResult: { type: 'create', filePath: 'C:\\work\\proj\\src\\main.js', content: 'main v2' } },
    { type: 'user', timestamp: new Date(3000).toISOString(), toolUseResult: { type: 'create', filePath: 'C:\\work\\proj\\README.md', content: '# proj' } },
    { type: 'user', timestamp: new Date(3000).toISOString(), toolUseResult: { type: 'create', filePath: 'C:\\work\\other\\x.md', content: 'not ours' } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  return { root, history, recycle: path.join(root, 'bin'), claudeDir };
}

const locationsOf = (s) => only({ historyDirs: [s.history], recycleDirs: [s.recycle], claudeDir: s.claudeDir });

test('rebuilds the folder tree from every source into a new folder, and again beside it', async () => {
  const s = makeSources();
  const { results } = await search({ under: PROJ, locations: locationsOf(s) });
  const plan = planRebuild(results, PROJ);
  assert.deepStrictEqual(plan.map((p) => p.rel.join('/')), ['assets/fonts/a.woff', 'assets/logo.svg', 'README.md', 'src/main.js']);

  const out = path.join(s.root, 'out');
  const first = await rebuild(plan, PROJ, out, [], git);
  assert.strictEqual(path.basename(first.root), 'proj');
  assert.strictEqual(first.written.length, 4);
  assert.strictEqual(fs.readFileSync(path.join(first.root, 'src', 'main.js'), 'utf8'), 'main v2', 'the newest version');
  assert.deepStrictEqual([...fs.readFileSync(path.join(first.root, 'assets', 'fonts', 'a.woff'))], [0, 1, 2, 3]);

  const second = await rebuild(plan, PROJ, out, [], git);
  assert.strictEqual(path.basename(second.root), 'proj (recovered 2)', 'never merged into the first');
});

test('refuses a destination inside a searched location', async () => {
  const s = makeSources();
  const { results } = await search({ under: PROJ, locations: locationsOf(s) });
  await assert.rejects(rebuild(planRebuild(results, PROJ), PROJ, path.join(s.claudeDir, 'x'), [s.claudeDir], git), /Refusing/);
  assert.ok(!fs.existsSync(path.join(s.claudeDir, 'x')));
});

test('a copy that cannot be read is reported, and the rest still comes back', async () => {
  const s = makeSources();
  const plan = [
    { rel: ['ok.txt'], copy: { kind: 'claude write', text: 'fine' } },
    { rel: ['broken.txt'], copy: { kind: 'recycle bin', file: path.join(s.root, 'does-not-exist') } },
  ];
  const r = await rebuild(plan, PROJ, path.join(s.root, 'out'), [], git);
  assert.deepStrictEqual(r.written.map((w) => w.rel[0]), ['ok.txt']);
  assert.deepStrictEqual(r.failed.map((f) => f.rel[0]), ['broken.txt']);
});

test('a path that was a file in one copy and a folder in another brings back both', async () => {
  const s = makeSources();
  // As git history often has it: a script "bin", later replaced by a folder bin/.
  const plan = planRebuild([
    { path: 'C:\\work\\proj\\bin', time: 1, kind: 'git commit', text: 'the old script' },
    { path: 'C:\\work\\proj\\bin\\cli.js', time: 2, kind: 'git commit', text: 'cli' },
    { path: 'C:\\work\\proj\\bin\\util.js', time: 2, kind: 'git commit', text: 'util' },
  ], PROJ);
  assert.deepStrictEqual(plan.map((p) => p.rel.join('/')), ['bin', 'bin/cli.js', 'bin/util.js'], 'the file sorts first');
  const r = await rebuild(plan, PROJ, path.join(s.root, 'out'), [], git);
  assert.deepStrictEqual(r.failed, []);
  assert.strictEqual(fs.readFileSync(path.join(r.root, 'bin', 'cli.js'), 'utf8'), 'cli');
  assert.strictEqual(fs.readFileSync(path.join(r.root, 'bin', 'util.js'), 'utf8'), 'util');
  assert.strictEqual(fs.readFileSync(path.join(r.root, 'bin (recovered 2)'), 'utf8'), 'the old script');
});

function cli(args, s) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--no-discover',
    '--history-dir', s.history, '--recycle-dir', s.recycle, '--claude-dir', s.claudeDir], { cwd: s.root, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('rebuild --dry-run lists the plan and writes nothing', () => {
  const s = makeSources();
  const before = snapshot(s.root);
  const r = cli(['rebuild', PROJ, '--dry-run'], s);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /src\\main\.js/);
  assert.match(r.out, /4 file\(s\) would be written\. Nothing was written\./);
  assert.deepStrictEqual(snapshot(s.root), before);
});

test('rebuild --to writes and summarises by source', () => {
  const s = makeSources();
  const r = cli(['rebuild', PROJ, '--to', path.join(s.root, 'restored')], s);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /Rebuilt 4 of 4 file\(s\)/);
  assert.ok(fs.existsSync(path.join(s.root, 'restored', 'proj', 'README.md')));
});

test('rebuild without --to is a usage error; an empty folder finds nothing', () => {
  const s = makeSources();
  assert.strictEqual(cli(['rebuild', PROJ], s).code, 2);
  assert.strictEqual(cli(['rebuild', 'C:\\nothing\\here', '--dry-run'], s).code, 1);
  const json = JSON.parse(cli(['rebuild', PROJ, '--dry-run', '--json'], s).out);
  assert.strictEqual(json.files.length, 4);
});

test('a bare drive is its root, on every system', () => {
  const s = makeSources();
  for (const drive of ['C:', 'c:\\', 'C:/']) {
    const json = JSON.parse(cli(['rebuild', drive, '--dry-run', '--json'], s).out);
    assert.strictEqual(json.folder, drive.slice(0, 2) + '\\', drive);
    assert.ok(json.files.some((f) => f.path === 'work/proj/src/main.js'), drive);
  }
});
