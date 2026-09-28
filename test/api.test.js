'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { workDir, cleanup, write, only } = require('./helpers');
const api = require('..');

const dirs = [];
after(() => dirs.forEach(cleanup));

function makeSources() {
  const root = workDir('api');
  dirs.push(root);
  const claudeDir = path.join(root, 'claude');
  const line = (o) => JSON.stringify(o) + '\n';
  write(path.join(claudeDir, 'projects', 'p', '11111111-2222-3333-4444-555555555555.jsonl'),
    line({ type: 'user', timestamp: '2026-09-01T00:00:00Z', toolUseResult: { type: 'create', filePath: 'C:\\app\\a.txt', content: 'alpha' } }));
  write(path.join(claudeDir, 'projects', 'p', '66666666-7777-8888-9999-000000000000.jsonl'),
    line({ type: 'user', timestamp: '2026-09-02T00:00:00Z', toolUseResult: { type: 'create', filePath: 'C:\\app\\sub\\b.txt', content: 'beta' } }));
  return { root, locations: only({ claudeDir }) };
}

test('lists its sources', () => {
  assert.deepStrictEqual(api.sources.map((s) => s.id), ['recycle', 'history', 'claude', 'antigravity', 'git',
    'jetbrains', 'eclipse-history', 'notepad', 'editor-backups', 'hancom', 'trash', 'vss']);
});

test('search reports progress a front end can show, in order', async () => {
  const s = makeSources();
  const events = [];
  const { results } = await api.search({ pattern: '*.txt', sources: ['claude'], locations: s.locations, onProgress: (e) => events.push(e) });
  assert.strictEqual(results.length, 2);
  assert.deepStrictEqual(events.map((e) => e.type), ['source-start', 'source-progress', 'source-progress', 'source-done', 'filtering', 'done']);
  assert.deepStrictEqual(events.filter((e) => e.type === 'source-progress').map((e) => [e.done, e.total]), [[1, 2], [2, 2]]);
  assert.strictEqual(events.at(-1).count, 2);
});

test('reads and restores one copy', async () => {
  const s = makeSources();
  const { results, locations } = await api.search({ pattern: 'a.txt', locations: s.locations });
  assert.strictEqual((await api.readCopy(results[0])).toString(), 'alpha');
  const target = await api.restoreCopy(results[0], path.join(s.root, 'out'), locations);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'alpha');
});

test('plans and rebuilds a folder', async () => {
  const s = makeSources();
  const { plan, locations } = await api.planFolder('C:\\app', { locations: s.locations });
  assert.deepStrictEqual(plan.map((p) => p.rel.join('/')), ['a.txt', 'sub/b.txt']);
  const { root, written } = await api.rebuildFolder(plan, 'C:\\app', path.join(s.root, 'out'), locations);
  assert.strictEqual(written.length, 2);
  assert.strictEqual(fs.readFileSync(path.join(root, 'sub', 'b.txt'), 'utf8'), 'beta');
});
