'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { workDir, cleanup, write, only } = require('./helpers');
const { recordsOf, applyEdit, sessionOf } = require('../src/sources/claude-code')._internal;
const { search, git } = require('../src/search');
const { load } = require('../src/content');

const dirs = [];
after(() => dirs.forEach(cleanup));

const TS = '2026-09-27T10:00:00.000Z';
const P = 'C:\\Users\\alice\\proj\\app.js';

test('a Write gives the file as written, and the file before when it replaced one', () => {
  const recs = [...recordsOf({
    timestamp: TS,
    toolUseResult: { type: 'update', filePath: P, content: 'new', originalFile: 'old', structuredPatch: [] },
  })];
  assert.deepStrictEqual(recs.map((r) => [r.kind, r.text]), [['claude write', 'new'], ['claude, before a write', 'old']]);
  assert.strictEqual(recs[0].time, Date.parse(TS));
});

test('an Edit gives the file before, and after with the edit applied as plain text', () => {
  const recs = [...recordsOf({
    timestamp: TS,
    toolUseResult: { filePath: P, oldString: 'a', newString: '$&-$1', replaceAll: true, originalFile: 'a b a' },
  })];
  assert.deepStrictEqual(recs.map((r) => [r.kind, r.text]), [
    ['claude, before an edit', 'a b a'],
    ['claude, after an edit', '$&-$1 b $&-$1'],
  ]);
});

test('an Edit without the file before gives nothing, rather than a guess', () => {
  const recs = [...recordsOf({ toolUseResult: { filePath: P, oldString: 'a', newString: 'b', originalFile: null } })];
  assert.strictEqual(recs.length, 0);
  assert.strictEqual(applyEdit('xyz', 'a', 'b', false), null);
  assert.strictEqual(applyEdit('a a', 'a', 'b', false), 'b a');
});

test('a Read counts only when it covered the whole file', () => {
  const whole = { type: 'text', file: { filePath: P, content: 'x\ny', startLine: 1, numLines: 2, totalLines: 2 } };
  const part = { type: 'text', file: { filePath: P, content: 'y', startLine: 2, numLines: 1, totalLines: 2 } };
  assert.strictEqual([...recordsOf({ toolUseResult: whole })][0].kind, 'claude read');
  assert.strictEqual([...recordsOf({ toolUseResult: part })].length, 0);
});

test('backup events name the file behind each backup; a file that did not exist has none', () => {
  const snap = [...recordsOf({
    type: 'file-history-snapshot',
    snapshot: { trackedFileBackups: { [P]: { backupFileName: 'abc@v1', backupTime: TS }, 'C:\\new.js': { backupFileName: null } } },
  })];
  assert.deepStrictEqual(snap.map((r) => [r.path, r.backupFileName]), [[P, 'abc@v1']]);
  const delta = [...recordsOf({ type: 'file-history-delta', trackingPath: P, backup: { backupFileName: 'abc@v2', backupTime: TS } })];
  assert.strictEqual(delta[0].backupFileName, 'abc@v2');
});

const S1 = '11111111-2222-3333-4444-555555555555';

test('a transcript belongs to its own session, a subagent transcript to its parent', () => {
  const projects = path.join('x', 'projects');
  assert.strictEqual(sessionOf(path.join(projects, 'p', `${S1}.jsonl`), projects), S1);
  assert.strictEqual(sessionOf(path.join(projects, 'p', S1, 'subagents', 'agent-1.jsonl'), projects), S1);
});

function makeClaude() {
  const dir = workDir('claude');
  dirs.push(dir);
  const line = (o) => JSON.stringify(o) + '\n';
  write(path.join(dir, 'projects', 'p', `${S1}.jsonl`),
    line({ type: 'user', timestamp: TS, message: { content: 'hello app.js' } })
    + line({ type: 'user', timestamp: TS, toolUseResult: { type: 'create', filePath: P, content: 'console.log("written")' } })
    + line({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: { [P]: { backupFileName: 'aaaa@v1', backupTime: '2026-09-26T00:00:00Z' } } } })
    + line({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: { [P]: { backupFileName: 'aaaa@v1', backupTime: '2026-09-26T00:00:00Z' } } } })
    + '{ this line is broken\n');
  write(path.join(dir, 'projects', 'p', S1, 'subagents', 'agent-9.jsonl'),
    line({ type: 'file-history-delta', trackingPath: 'C:\\Users\\alice\\proj\\util.js', backup: { backupFileName: 'bbbb@v1', backupTime: '2026-09-25T00:00:00Z' } }));
  write(path.join(dir, 'file-history', S1, 'aaaa@v1'), 'console.log("backup")');
  write(path.join(dir, 'file-history', S1, 'bbbb@v1'), 'util()');
  write(path.join(dir, 'file-history', S1, 'cccc@v3'), 'nobody names me, secret-token');
  return dir;
}

test('finds written content and byte-exact backups, one result per backup', async () => {
  const claudeDir = makeClaude();
  const { results } = await search({ pattern: 'app.js', sources: ['claude'], locations: only({ claudeDir }) });
  assert.deepStrictEqual(results.map((r) => r.kind), ['claude write', 'claude backup']);
  assert.strictEqual((await load(results[1], git)).toString(), 'console.log("backup")');
});

test('a subagent transcript resolves backups in its parent session', async () => {
  const claudeDir = makeClaude();
  const { results } = await search({ pattern: 'util.js', sources: ['claude'], locations: only({ claudeDir }) });
  assert.strictEqual(results.length, 1);
  assert.strictEqual((await load(results[0], git)).toString(), 'util()');
});

test('a search by content alone also offers backups whose name was lost', async () => {
  const claudeDir = makeClaude();
  const { results } = await search({ containing: 'SECRET-token', sources: ['claude'], locations: only({ claudeDir }) });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].path, null);
  assert.strictEqual(results[0].kind, 'claude backup, name unknown');
});

test('several Claude Code folders are all read, each resolving its own backups', async () => {
  const here = makeClaude();
  const other = workDir('claude-other');
  dirs.push(other);
  write(path.join(other, 'projects', 'q', '99999999-2222-3333-4444-555555555555.jsonl'), JSON.stringify({
    type: 'file-history-snapshot',
    snapshot: { trackedFileBackups: { [P]: { backupFileName: 'aaaa@v1', backupTime: '2026-09-20T00:00:00Z' } } },
  }) + '\n');
  // The same backup name, with other content: only this folder's file-history holds the one it names.
  write(path.join(other, 'file-history', '99999999-2222-3333-4444-555555555555', 'aaaa@v1'), 'from the other machine');
  const { results } = await search({
    pattern: 'app.js', sources: ['claude'], locations: only({ claudeDir: here, dirs: { claude: [other] } }),
  });
  const backups = await Promise.all(results.filter((r) => r.kind === 'claude backup').map(async (r) => (await load(r, git)).toString()));
  assert.deepStrictEqual(backups.sort(), ['console.log("backup")', 'from the other machine']);
  const claude = require('../src/sources/claude-code');
  const lines = claude.describe({ locations: { claude: [here, other] } });
  assert.deepStrictEqual(lines, [`${here}: 2 transcript(s), 3 backup(s)`, `${other}: 1 transcript(s), 1 backup(s)`]);
  assert.deepStrictEqual(claude.roots({ claude: [here, other] }), [here, other]);
});

test('a named backup is not offered a second time as a nameless one', async () => {
  const claudeDir = makeClaude();
  const { results } = await search({ containing: 'backup', sources: ['claude'], locations: only({ claudeDir }) });
  assert.deepStrictEqual(results.map((r) => r.path), [P]);
});
