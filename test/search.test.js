'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { workDir, cleanup, write, only } = require('./helpers');
const { search } = require('../src/search');

const dirs = [];
after(() => dirs.forEach(cleanup));

/** The same file seen by an editor's history and by Claude Code, plus a file that still exists. */
function makeSources() {
  const root = workDir('search');
  dirs.push(root);
  const existing = write(path.join(root, 'live', 'alive.txt'), 'still here');
  const history = path.join(root, 'History');
  write(path.join(history, 'f1', 'entries.json'), JSON.stringify({
    version: 1, resource: 'file:///c%3A/work/notes.md', entries: [{ id: 'a.md', timestamp: 1000 }, { id: 'b.md', timestamp: 3000 }],
  }));
  write(path.join(history, 'f1', 'a.md'), 'draft one');
  write(path.join(history, 'f1', 'b.md'), 'draft two');
  write(path.join(history, 'f2', 'entries.json'), JSON.stringify({
    version: 1, resource: 'file://' + (existing.startsWith('/') ? '' : '/') + existing.replace(/\\/g, '/'),
    entries: [{ id: 'c.txt', timestamp: 500 }],
  }));
  write(path.join(history, 'f2', 'c.txt'), 'older');
  const claudeDir = path.join(root, 'claude');
  write(path.join(claudeDir, 'projects', 'p', '11111111-2222-3333-4444-555555555555.jsonl'), JSON.stringify({
    type: 'user', timestamp: new Date(2000).toISOString(),
    toolUseResult: { type: 'create', filePath: 'C:\\work\\notes.md', content: 'draft one' },
  }) + '\n');
  return { history, claudeDir };
}

const run = (o, s) => search({ ...o, locations: only({ historyDirs: [s.history], claudeDir: s.claudeDir }) });

test('the same content under the same name is one result, remembered from every place', async () => {
  const s = makeSources();
  const { results } = await run({ pattern: 'notes.md' }, s);
  assert.strictEqual(results.length, 2);
  const one = results.find((r) => r.copies === 2);
  assert.ok(one, 'draft one was seen twice');
  assert.deepStrictEqual(one.seen.sort(), ['claude write', 'local history']);
  assert.strictEqual(one.time, 2000, 'the newest sighting represents it');
});

test('results run newest first', async () => {
  const s = makeSources();
  const { results } = await run({ pattern: '*' }, s);
  const times = results.map((r) => r.time);
  assert.deepStrictEqual(times, [...times].sort((a, b) => b - a));
});

test('IDs follow the content, so they are the same on every run', async () => {
  const s = makeSources();
  const a = (await run({ pattern: 'notes' }, s)).results.map((r) => r.id);
  const b = (await run({ pattern: 'notes' }, s)).results.map((r) => r.id);
  assert.deepStrictEqual(a, b);
  assert.ok(a.every((id) => /^[0-9a-f]{8}$/.test(id)));
  assert.strictEqual(new Set(a).size, a.length);
});

test('a file that still exists is marked so, and --deleted-only leaves it out', async () => {
  const s = makeSources();
  const all = (await run({ pattern: 'alive' }, s)).results;
  assert.strictEqual(all[0].state, 'exists');
  assert.strictEqual((await run({ pattern: 'alive', deletedOnly: true }, s)).results.length, 0);
  assert.strictEqual((await run({ pattern: 'notes', deletedOnly: true }, s)).results[0].state, 'deleted');
});

test('--containing keeps only copies whose text has it, in any case', async () => {
  const s = makeSources();
  const { results } = await run({ pattern: 'notes', containing: 'TWO' }, s);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].time, 3000);
});

test('--since leaves out older copies', async () => {
  const s = makeSources();
  const { results } = await run({ pattern: '*', since: 2500 }, s);
  assert.deepStrictEqual(results.map((r) => r.time), [3000]);
});

test('an unknown source is a usage error', async () => {
  await assert.rejects(search({ pattern: 'x', sources: ['nope'], locations: only({}) }), /Unknown source: nope/);
});
