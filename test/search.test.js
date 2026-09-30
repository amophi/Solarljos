'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { workDir, cleanup, write, only, infoV2 } = require('./helpers');
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

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom\0\0\0\0isom')]);
/** Five packets of an AVCHD camcorder's transport stream, each a time code and then 0x47. */
const M2TS = Buffer.alloc(192 * 5);
for (let k = 0; k < 5; k++) M2TS[4 + 192 * k] = 0x47;

/** A Linux trash holding named pictures, videos and text, and items with no record, whose names are lost. */
function makeTrash() {
  const root = workDir('search-types');
  dirs.push(root);
  const tr = path.join(root, 'Trash');
  const record = (name, original, data) => {
    write(path.join(tr, 'info', name + '.trashinfo'), `[Trash Info]\nPath=${original}\nDeletionDate=2026-09-20T10:00:00\n`);
    write(path.join(tr, 'files', name), data);
  };
  record('photo.jpg', '/home/u/Pictures/photo.jpg', JPEG);
  record('fake.jpg', '/home/u/fake.jpg', 'a name is enough: this is taken for a picture');
  record('clip.MP4', '/home/u/Videos/clip.MP4', MP4);
  record('notes.txt', '/home/u/notes.txt', 'notes');
  // Two meanings: a TypeScript module, and a camcorder's clip.
  record('app.mts', '/home/u/code/app.mts', 'export const a = 1;\n');
  record('00001.MTS', '/home/u/cam/00001.MTS', M2TS);
  write(path.join(tr, 'files', 'lost-1'), PNG);
  write(path.join(tr, 'files', 'lost-2'), 'plain words, whose name is lost');
  // Not the bytes of photo.jpg: those, found under a name as well, would be that copy again.
  write(path.join(tr, 'files', 'lost-3'), Buffer.concat([JPEG, Buffer.from([1])]));
  return { root, tr, locations: only({ dirs: { trash: [tr] } }) };
}

const byType = async (s, types, o = {}) => (await search({ types, sources: ['trash'], locations: s.locations, ...o })).results;
const described = (results) => results.map((c) => [c.path || `(${path.basename(c.origin)})`, c.mediaType, c.ext || null]).sort();

test('a search by type takes a named copy by its extension, and one with no name by its first bytes', async () => {
  const s = makeTrash();
  assert.deepStrictEqual(described(await byType(s, ['image'])), [
    ['(lost-1)', 'image', '.png'],
    ['(lost-3)', 'image', '.jpg'],
    ['/home/u/Pictures/photo.jpg', 'image', null],
    ['/home/u/fake.jpg', 'image', null],
  ]);
  assert.deepStrictEqual(described(await byType(s, ['video'])), [
    ['/home/u/Videos/clip.MP4', 'video', null],
    ['/home/u/cam/00001.MTS', 'video', null],
  ], 'an extension of two meanings is settled by the bytes');
  assert.deepStrictEqual(described(await byType(s, ['text'])), [
    ['(lost-2)', 'text', '.txt'],
    ['/home/u/code/app.mts', 'text', null],
    ['/home/u/notes.txt', 'text', null],
  ]);
  assert.deepStrictEqual(described(await byType(s, ['image', 'video'], { pattern: 'photo' })), [
    ['/home/u/Pictures/photo.jpg', 'image', null],
  ], 'with a name to go on, copies whose name is lost are not offered');
  assert.deepStrictEqual(await byType(s, ['audio']), []);
});

test('every result carries what kind of thing it is, by type search or not', async () => {
  const s = makeTrash();
  const { results } = await search({ pattern: '*', sources: ['trash'], locations: s.locations });
  assert.deepStrictEqual(described(results), [
    ['/home/u/Pictures/photo.jpg', 'image', null],
    ['/home/u/Videos/clip.MP4', 'video', null],
    ['/home/u/cam/00001.MTS', 'video', null],
    ['/home/u/code/app.mts', 'text', null],
    ['/home/u/fake.jpg', 'image', null],
    ['/home/u/notes.txt', 'text', null],
  ]);
  const { results: lost } = await search({ pattern: '', containing: 'plain words', sources: ['trash'], locations: s.locations });
  assert.deepStrictEqual(described(lost), [['(lost-2)', 'text', '.txt']], 'a copy with no name gets the extension its bytes show');
});

test('a name of two meanings is read only when that decides, and a smaller copy passes for either', async () => {
  const { keepTypes } = require('../src/search')._internal;
  const { git } = require('../src/search');
  const { readBlob, preload } = git;
  const asked = [];
  git.readBlob = async (repo, sha) => {
    asked.push(sha);
    return sha === 'clip' ? M2TS : Buffer.from('export {};\n');
  };
  git.preload = async () => {};
  const fromGit = (p, sha) => ({ path: p, kind: 'git commit', gitBlob: { repo: '/r', sha }, size: 10 });
  const kinds = (list) => list.map((c) => [c.path, c.mediaType || null]);
  try {
    const list = [fromGit('/r/app.ts', 'app'), fromGit('/r/clip.mts', 'clip')];
    // Text asked for: TypeScript is what .ts and .mts usually are, and git is not asked.
    assert.deepStrictEqual(kinds(await keepTypes(list, ['text'])), [['/r/app.ts', null], ['/r/clip.mts', null]]);
    assert.deepStrictEqual(asked, []);
    // Video asked for and not text: only the bytes can tell.
    assert.deepStrictEqual(kinds(await keepTypes(list, ['video'])), [['/r/clip.mts', 'video']]);
    assert.deepStrictEqual(asked.sort(), ['app', 'clip']);
    asked.length = 0;
    assert.strictEqual((await keepTypes(list, ['video', 'text'])).length, 2, 'both asked for: nothing to decide');
    assert.deepStrictEqual(asked, []);
  } finally {
    Object.assign(git, { readBlob, preload });
  }
  // A thumbnail of a camcorder clip: its bytes are a picture, and its name a video's.
  const thumb = { path: 'D:\\cam\\00001.MTS', kind: 'thumbnail', buffer: JPEG, ext: '.jpg', mediaType: 'image' };
  assert.strictEqual((await keepTypes([thumb], ['video'])).length, 1);
  assert.strictEqual((await keepTypes([thumb], ['image'])).length, 1);
  assert.strictEqual((await keepTypes([thumb], ['audio'])).length, 0);
});

test('a copy with no name keeps the type its source gave it over what its first bytes say', async () => {
  const { keepTypes } = require('../src/search')._internal;
  // A voice recording carved from a card: an MP4 with a sound track alone, which carving tells
  // by walking its tracks, and whose brand alone says video.
  const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(12), Buffer.alloc(100, 7)]);
  const voice = { kind: 'carved', path: null, mediaType: 'audio', ext: '.m4a', buffer: ftyp, unverified: true };
  const audio = await keepTypes([voice], ['audio']);
  assert.deepStrictEqual(audio.map((c) => [c.mediaType, c.ext]), [['audio', '.m4a']]);
  assert.strictEqual((await keepTypes([voice], ['video'])).length, 0);
  // With none given, the first bytes say.
  const told = await keepTypes([{ kind: 'trash, name unknown', path: null, buffer: ftyp }], ['video']);
  assert.deepStrictEqual(told.map((c) => [c.mediaType, c.ext]), [['video', '.mp4']]);
});

test('a search stops when its signal fires, before the next source', async () => {
  const s = makeTrash();
  const before = new AbortController();
  before.abort();
  const events = [];
  await assert.rejects(search({ pattern: '*', sources: ['trash'], locations: s.locations, signal: before.signal, onProgress: (e) => events.push(e) }),
    (e) => e.name === 'AbortError');
  assert.deepStrictEqual(events, [], 'nothing was searched');
  const during = new AbortController();
  const seen = [];
  const locations = only({ dirs: { trash: [s.tr] }, recycleDirs: [path.join(s.root, 'no-bin')] });
  await assert.rejects(search({
    pattern: '*', sources: ['recycle', 'trash'], locations, signal: during.signal,
    onProgress: (e) => {
      seen.push(`${e.type} ${e.id || ''}`.trim());
      if (e.type === 'source-done') during.abort();
    },
  }), (e) => e.name === 'AbortError');
  assert.deepStrictEqual(seen, ['source-start recycle', 'source-done recycle']);
  // One that does not fire changes nothing.
  const { results } = await search({ pattern: '*', sources: ['trash'], locations: s.locations, signal: new AbortController().signal });
  assert.strictEqual(results.length, 6, 'the six with a name');
});

test('--since keeps copies that carry no date, and counts them', async () => {
  const root = workDir('search-since');
  dirs.push(root);
  const bin = path.join(root, '$Recycle.Bin', 'S-1-5-21-1-1-1-1001');
  // A deletion time of 0 is no time at all.
  write(path.join(bin, '$IUNDATE.txt'), infoV2('C:\\u\\undated.txt', 1, -11644473600000));
  write(path.join(bin, '$RUNDATE.txt'), 'u');
  write(path.join(bin, '$IOLD001.txt'), infoV2('C:\\u\\old.txt', 1, Date.UTC(2020, 0, 1)));
  write(path.join(bin, '$ROLD001.txt'), 'o');
  write(path.join(bin, '$INEW001.txt'), infoV2('C:\\u\\new.txt', 1, Date.UTC(2026, 8, 1)));
  write(path.join(bin, '$RNEW001.txt'), 'n');
  const locations = only({ recycleDirs: [path.join(root, '$Recycle.Bin')] });
  const { results, notes } = await search({ pattern: '*.txt', since: Date.UTC(2026, 0, 1), locations });
  assert.deepStrictEqual(results.map((c) => [c.path, c.time]), [['C:\\u\\new.txt', Date.UTC(2026, 8, 1)], ['C:\\u\\undated.txt', null]]);
  assert.deepStrictEqual(notes, ['1 copy(ies) carry no date; they were kept, since how old they are cannot be told']);
  assert.deepStrictEqual((await search({ pattern: '*.txt', locations })).notes, [], 'said only when --since is used');
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
