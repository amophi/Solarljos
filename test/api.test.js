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

test('lists its sources, and which keep only text and which read disks directly', () => {
  assert.deepStrictEqual(api.sources.map((s) => s.id), ['recycle', 'history', 'claude', 'antigravity', 'git',
    'jetbrains', 'eclipse-history', 'notepad', 'editor-backups', 'hancom', 'trash', 'thumbcache', 'snips', 'removable', 'vss']);
  assert.deepStrictEqual(api.sources.filter((s) => !s.media).map((s) => s.id),
    ['history', 'claude', 'antigravity', 'eclipse-history', 'notepad', 'editor-backups']);
  assert.deepStrictEqual(api.sources.filter((s) => s.needsAdmin).map((s) => s.id), ['removable']);
  for (const s of api.sources) assert.deepStrictEqual(Object.keys(s), ['id', 'label', 'media', 'needsAdmin'], s.id);
});

test('gives a front end what it needs to tell copies apart', () => {
  for (const f of ['search', 'describeSources', 'readCopy', 'openCopy', 'restoreCopy', 'checkDestination', 'planFolder',
    'rebuildFolder', 'freeze', 'sniff', 'tier', 'isElevated']) {
    assert.strictEqual(typeof api[f], 'function', f);
  }
  assert.deepStrictEqual(api.TYPES, ['image', 'video', 'audio', 'document', 'archive', 'text']);
  assert.deepStrictEqual(api.sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), { mediaType: 'image', ext: '.jpg' });
  assert.deepStrictEqual([{ kind: 'recycle bin' }, { kind: 'thumbnail' }, { kind: 'x', unverified: true }].map(api.tier), [0, 4, 3]);
});

test('every result says what kind of thing it is, and openCopy streams any part of one', async () => {
  const s = makeSources();
  const { results, notes } = await api.search({ pattern: 'a.txt', locations: s.locations });
  assert.strictEqual(results[0].mediaType, 'text');
  assert.deepStrictEqual(notes, []);
  const parts = [];
  for await (const part of await api.openCopy(results[0], { start: 1, end: 3 })) parts.push(part);
  assert.strictEqual(Buffer.concat(parts).toString(), 'lph');
  for (const range of [undefined, null, {}]) {
    const whole = [];
    for await (const part of await api.openCopy(results[0], range)) whole.push(part);
    assert.strictEqual(Buffer.concat(whole).toString(), 'alpha', String(range));
  }
});

test('a destination is checked without anything being written', async () => {
  const s = makeSources();
  const { locations } = await api.search({ pattern: 'a.txt', locations: s.locations });
  await assert.rejects(api.checkDestination(path.join(s.root, 'claude', 'x'), locations), /Refusing to write inside/);
  const ok = path.join(s.root, 'not', 'made', 'yet');
  assert.strictEqual(await api.checkDestination(ok, locations), ok);
  assert.ok(!fs.existsSync(path.join(s.root, 'not')));
});

test('freeze has each source with a store others rewrite take it now, and says which did', async () => {
  const { SOURCES } = require('../src/search');
  const thumbs = SOURCES.find((x) => x.id === 'thumbcache');
  const had = Object.prototype.hasOwnProperty.call(thumbs, 'freeze');
  const before = thumbs.freeze;
  const seen = [];
  thumbs.freeze = async (loc) => {
    seen.push(loc.thumbcache);
  };
  try {
    const out = await api.freeze({ sources: ['thumbcache', 'recycle'], locations: only({ dirs: { thumbcache: ['given'] } }) });
    assert.deepStrictEqual(out, [{ id: 'thumbcache', label: thumbs.label }], 'a source without a store of that kind is not listed');
    assert.deepStrictEqual(seen, [['given']]);
    thumbs.freeze = async () => {
      throw new Error('torn');
    };
    assert.deepStrictEqual(await api.freeze({ sources: ['thumbcache'], locations: only({}) }),
      [{ id: 'thumbcache', label: thumbs.label, error: 'torn' }]);
  } finally {
    if (had) thumbs.freeze = before;
    else delete thumbs.freeze;
  }
});

test('isElevated opens the first disk for reading only, closes it, and writes nothing', () => {
  const { isElevated } = require('../src/locations');
  const calls = [];
  const saved = {};
  const replace = (name, impl) => {
    saved[name] = fs[name];
    fs[name] = (...a) => {
      calls.push([name, ...a]);
      return impl(...a);
    };
  };
  // Nothing may be written: every call that could is made to fail loudly, and counted.
  for (const name of ['writeSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync',
    'copyFileSync', 'linkSync', 'symlinkSync', 'truncateSync', 'ftruncateSync', 'utimesSync', 'futimesSync', 'chmodSync']) {
    replace(name, () => {
      throw new Error('written');
    });
  }
  try {
    // The device itself is never touched here: the open is answered by the test.
    replace('openSync', () => 42);
    replace('closeSync', () => {});
    assert.strictEqual(isElevated('win32'), true);
    fs.openSync = (...a) => {
      calls.push(['openSync', ...a]);
      const e = new Error('EPERM: operation not permitted');
      e.code = 'EPERM';
      throw e;
    };
    assert.strictEqual(isElevated('win32'), false, 'refused, as it is to a process not run as administrator');
  } finally {
    Object.assign(fs, saved);
  }
  const W = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
  assert.deepStrictEqual(calls.map((c) => c[0]), ['openSync', 'closeSync', 'openSync']);
  for (const [, file, flags] of calls.filter((c) => c[0] === 'openSync')) {
    assert.strictEqual(file, '\\\\.\\PhysicalDrive0');
    assert.strictEqual(flags & W, 0, 'opened for reading only');
  }
  assert.deepStrictEqual(calls[1], ['closeSync', 42]);
  // Elsewhere it is only a question of the user id.
  if (process.platform !== 'win32') assert.strictEqual(api.isElevated(), process.geteuid() === 0);
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

test('a folder is taken as the command line takes it: a bare drive is its root', async () => {
  const s = makeSources();
  for (const drive of ['C:', 'C:\\', 'c:/']) {
    const { folder, plan } = await api.planFolder(drive, { locations: s.locations });
    assert.strictEqual(folder, drive.slice(0, 2) + '\\');
    assert.deepStrictEqual(plan.map((p) => p.rel.join('/')), ['app/a.txt', 'app/sub/b.txt'], drive);
  }
  const { folder } = await api.planFolder('C:\\app\\', { locations: s.locations });
  assert.strictEqual(folder, 'C:\\app');
  const { results } = await api.search({ under: 'C:', locations: s.locations });
  assert.strictEqual(results.length, 2, 'search takes it the same way');
});

test('plans and rebuilds a folder', async () => {
  const s = makeSources();
  const { plan, leftOut, locations } = await api.planFolder('C:\\app', { locations: s.locations });
  assert.deepStrictEqual(plan.map((p) => p.rel.join('/')), ['a.txt', 'sub/b.txt']);
  assert.deepStrictEqual(leftOut, []);
  const events = [];
  const { root, written } = await api.rebuildFolder(plan, 'C:\\app', path.join(s.root, 'out'), locations, { onProgress: (e) => events.push(e) });
  assert.strictEqual(written.length, 2);
  assert.strictEqual(fs.readFileSync(path.join(root, 'sub', 'b.txt'), 'utf8'), 'beta');
  assert.deepStrictEqual(events.map((e) => [e.done, e.total, e.rel.join('/')]), [[1, 2, 'a.txt'], [2, 2, 'sub/b.txt']]);
});

test('a search for pictures leaves out the sources that keep only text, and says so', async () => {
  const s = makeSources();
  const events = [];
  const { results, perSource } = await api.search({ types: ['image'], sources: ['claude'], locations: s.locations, onProgress: (e) => events.push(e) });
  assert.deepStrictEqual(results, []);
  assert.deepStrictEqual(perSource.map((p) => [p.id, p.count, p.skipped]), [['claude', 0, true]]);
  assert.match(perSource[0].notes[0], /^Not searched: it keeps only text, and the search is for image\.$/);
  assert.deepStrictEqual(events.map((e) => e.type), ['source-done', 'filtering', 'done']);
  assert.strictEqual(events[0].skipped, true);
  // A search that includes documents or text searches it.
  const { results: docs } = await api.search({ types: ['text'], sources: ['claude'], locations: s.locations });
  assert.deepStrictEqual(docs.map((c) => c.path).sort(), ['C:\\app\\a.txt', 'C:\\app\\sub\\b.txt']);
});
