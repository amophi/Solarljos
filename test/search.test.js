'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { workDir, cleanup, write, only } = require('./helpers');
const { search } = require('../src/search');

const dirs = [];
after(() => dirs.forEach(cleanup));

/** The same file seen by an editor's history and by Claude Code, plus a file that still exists. */
/** A file URI for a path on this machine, as an editor would record it. */
const fileUri = (p) => 'file://' + (p.startsWith('/') ? '' : '/') + p.replace(/\\/g, '/');

function makeSources() {
  const root = workDir('search');
  dirs.push(root);
  const existing = write(path.join(root, 'live', 'alive.txt'), 'still here');
  // A path of this machine's own kind that does not exist, so its state can be checked.
  const gone = path.join(root, 'gone', 'notes.md');
  const history = path.join(root, 'History');
  write(path.join(history, 'f1', 'entries.json'), JSON.stringify({
    version: 1, resource: fileUri(gone), entries: [{ id: 'a.md', timestamp: 1000 }, { id: 'b.md', timestamp: 3000 }],
  }));
  write(path.join(history, 'f1', 'a.md'), 'draft one');
  write(path.join(history, 'f1', 'b.md'), 'draft two');
  write(path.join(history, 'f2', 'entries.json'), JSON.stringify({
    version: 1, resource: fileUri(existing), entries: [{ id: 'c.txt', timestamp: 500 }],
  }));
  write(path.join(history, 'f2', 'c.txt'), 'older');
  const claudeDir = path.join(root, 'claude');
  write(path.join(claudeDir, 'projects', 'p', '11111111-2222-3333-4444-555555555555.jsonl'), JSON.stringify({
    type: 'user', timestamp: new Date(2000).toISOString(),
    toolUseResult: { type: 'create', filePath: gone, content: 'draft one' },
  }) + '\n');
  return { root, history, claudeDir };
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

test('a place for a source that does not exist is a usage error, not a search of nothing', async () => {
  for (const id of ['jetbrain', 'VSS', 'recycle-bin', 'constructor', '__proto__']) {
    const dirs = Object.create(null);
    dirs[id] = ['D:\\old'];
    await assert.rejects(search({ pattern: 'x', locations: only({ dirs }) }),
      (e) => e.usage && e.message.startsWith(`Unknown source in --location: ${id}. Known: recycle, history,`) && /, repos$/.test(e.message), id);
  }
  await assert.rejects(search({ pattern: 'x', locations: only({ dirs: { notepad: [' '] } }) }), /Give a place after notepad=/);
  const { results } = await search({ pattern: 'x', sources: ['git'], locations: only({ dirs: { repos: [], git: [] } }) });
  assert.deepStrictEqual(results, [], 'repos, the older name for git\'s places, is known');
});

test('a source that cannot be loaded keeps its own id, and its places stay protected', async () => {
  const { source } = require('../src/search')._internal;
  const broken = source('./sources/no-such-source', 'history');
  assert.strictEqual(broken.id, 'history');
  assert.match(broken.broken, /Cannot find module/);
  await assert.rejects(broken.scan({}), /could not be loaded/);
  assert.deepStrictEqual(broken.roots({ history: [{ label: 'Code', dir: '/h' }] }), ['/h']);
  assert.deepStrictEqual(source('./sources/no-such-source', 'claude').roots({ claude: ['/c'] }), ['/c']);
});

test('a copy on a network share has no state: the share is never asked', async () => {
  const s = makeSources();
  write(path.join(s.history, 'f3', 'entries.json'), JSON.stringify({
    version: 1, resource: 'file://nas/share/report.txt', entries: [{ id: 'r.txt', timestamp: 100 }],
  }));
  write(path.join(s.history, 'f3', 'r.txt'), 'on the share');
  const { results } = await run({ pattern: 'report.txt' }, s);
  assert.deepStrictEqual(results.map((r) => [r.path, r.state]), [['\\\\nas\\share\\report.txt', '']]);
});

test('on Windows, a copy on a drive that is not there has no state rather than "deleted"', { skip: process.platform !== 'win32' }, async (t) => {
  const free = [...'ZYXWVUTSRQPONMLKJIHGFE'].find((d) => {
    try {
      fs.realpathSync.native(d + ':\\');
      return false;
    } catch (_) {
      return true;
    }
  });
  if (!free) return t.skip('every drive letter is in use');
  const s = makeSources();
  write(path.join(s.history, 'f3', 'entries.json'), JSON.stringify({
    version: 1, resource: `file:///${free.toLowerCase()}%3A/stick/plan.txt`, entries: [{ id: 'p.txt', timestamp: 100 }],
  }));
  write(path.join(s.history, 'f3', 'p.txt'), 'on a drive not plugged in');
  const { results } = await run({ pattern: 'plan.txt' }, s);
  assert.deepStrictEqual(results.map((r) => [r.path, r.state]), [[`${free}:\\stick\\plan.txt`, '']]);
  assert.strictEqual((await run({ pattern: 'plan.txt', deletedOnly: true }, s)).results.length, 0);
});

test('on Linux, a path on a network mount is not looked up; one on a local mount is', () => {
  const { mountOf, onNetwork } = require('../src/search')._internal;
  const mounts = new Map([
    ['/', { source: '/dev/sda1', fstype: 'ext4', options: 'rw' }],
    ['/mnt/nas', { source: 'server:/x', fstype: 'nfs4', options: 'rw' }],
    ['/mnt/nas/local', { source: '/dev/sdb1', fstype: 'ext4', options: 'rw' }],
    ['/home/u/sftp', { source: 'u@host:', fstype: 'fuse.sshfs', options: 'rw' }],
    ['/home/u/private', { source: 'gocryptfs', fstype: 'fuse.gocryptfs', options: 'rw' }],
    ['/media/u/Stick', { source: '/dev/sdc1', fstype: 'fuseblk', options: 'rw' }],
    ['/mnt/9p', { source: 'host', fstype: '9p', options: 'rw,trans=tcp' }],
    ['/mnt/c', { source: 'C:\\', fstype: '9p', options: 'rw,trans=fd' }],
    ['/tmp', { source: 'tmpfs', fstype: 'tmpfs', options: 'rw' }],
  ]);
  const net = (p) => onNetwork(mountOf(p, mounts));
  assert.deepStrictEqual(['/mnt/nas/a.txt', '/mnt/nas', '/home/u/sftp/x', '/mnt/9p/y'].map(net), [true, true, true, true]);
  assert.deepStrictEqual(['/mnt/nas/local/a', '/mnt/nasty/a', '/home/u/private/a', '/media/u/Stick/a', '/mnt/c/a', '/tmp/a', '/a']
    .map(net), [false, false, false, false, false, false, false]);
  assert.strictEqual(mountOf('/a', new Map()), null);
});
