'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { workDir, cleanup, write, only, snapshot } = require('./helpers');
const eclipse = require('../src/sources/eclipse-history');
const { parseIndex, readUTF, bucketName, plainPath, uriPath, linkTarget, projectRoot, onNetwork, workspacesAt, labelOf } = eclipse._internal;
const { search, describeAll, git } = require('../src/search');
const { load } = require('../src/content');
const { restore } = require('../src/restore');

const dirs = [];
after(() => dirs.forEach(cleanup));

const RES = ['.metadata', '.plugins', 'org.eclipse.core.resources'];
const T1 = Date.parse('2026-09-20T01:00:00Z');
const T2 = Date.parse('2026-09-21T02:00:00Z');

// ---- the formats, written the way Eclipse writes them ----

/** Java's DataOutputStream.writeUTF: uint16 length, then modified UTF-8, one UTF-16 unit at a time. */
function utf(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 1 && c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  const len = Buffer.alloc(2);
  len.writeUInt16BE(bytes.length);
  return Buffer.concat([len, Buffer.from(bytes)]);
}

/** A history.index: [{ key, versions: [{ uuid, time }] }]. */
function historyIndex(files, version = 2) {
  const head = Buffer.alloc(5);
  head[0] = version;
  head.writeInt32BE(files.length, 1);
  const out = [head];
  for (const f of files) {
    const n = Buffer.alloc(2);
    n.writeUInt16BE(f.versions.length);
    out.push(utf(f.key), n);
    for (const v of f.versions) {
      const time = Buffer.alloc(8);
      time.writeBigInt64LE(BigInt(v.time));
      out.push(Buffer.from(v.uuid, 'hex'), time);
    }
  }
  return Buffer.concat(out);
}

const BEGIN = Buffer.from('40b18b8123bc00141a2596e7a393be1e', 'hex');
const END = Buffer.from('c058fbf323bc00141a51f38c7bbb77c6', 'hex');

/** .projects/<project>/.location: the location string, no references, between the markers. */
function locationFile(value) {
  return Buffer.concat([BEGIN, utf(value), Buffer.alloc(4), END]);
}

let seq = 0;
const newUuid = () => (0xabc00000 + ++seq).toString(16).padStart(32, '0');

/**
 * A workspace with one project; called again, another project in it. `files` are { key,
 * folders?, versions: [{ text, time, mtime?, noState? }] }, where `folders` puts the index in
 * other folders than Eclipse would; `location` is what .location holds, or undefined for no file.
 */
function makeWorkspace(ws, { project = 'app', location, files = [], orphans = [] }) {
  const res = path.join(ws, ...RES);
  const meta = path.join(res, '.projects', project);
  fs.mkdirSync(meta, { recursive: true });
  if (location !== undefined) write(path.join(meta, '.location'), locationFile(location));
  const state = (text, mtime) => {
    const uuid = newUuid();
    const file = write(path.join(res, '.history', uuid.slice(-2), uuid), text);
    fs.utimesSync(file, mtime / 1000, mtime / 1000);
    return uuid;
  };
  const byFolder = new Map();
  for (const f of files) {
    const folders = f.folders || f.key.split('/').slice(1, -1).map(bucketName);
    const dir = path.join(meta, '.indexes', ...folders);
    const versions = f.versions.map((v) => ({
      uuid: v.noState ? newUuid() : state(v.text, v.mtime == null ? v.time : v.mtime),
      time: v.time,
    }));
    if (!byFolder.has(dir)) byFolder.set(dir, []);
    byFolder.get(dir).push({ key: f.key, versions });
  }
  for (const [dir, list] of byFolder) write(path.join(dir, 'history.index'), historyIndex(list));
  for (const o of orphans) state(o.text, o.time);
  return res;
}

function newWorkspace(name) {
  const dir = workDir(name);
  dirs.push(dir);
  return dir;
}

const find = (pattern, ws, extra = {}) =>
  search({ pattern, sources: ['eclipse-history'], locations: only({ dirs: { 'eclipse-history': [ws] } }), ...extra });
const describeAt = (ws) => describeAll({ sources: ['eclipse-history'], locations: only({ dirs: { 'eclipse-history': [ws] } }) });

/** A .project with these links: [name, type, 'location' or 'locationURI', value], escaped as Eclipse does. */
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dotProject = (links) => [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<projectDescription><name>app</name><linkedResources>',
  ...links.map(([name, type, tagName, value]) =>
    `<link><name>${xml(name)}</name><type>${type}</type><${tagName}>${xml(value)}</${tagName}></link>`),
  '</linkedResources></projectDescription>',
].join('\n');
/** A path as a <location> holds it: IPath.toPortableString, with forward slashes. */
const portable = (p) => p.replace(/\\/g, '/');

/**
 * Runs `fn` while noting every path the file functions are given. A network path (two
 * separators in front) is refused without being tried, so no test reaches a server even when
 * the module is wrong.
 */
async function watchingFs(fn) {
  const names = ['readFileSync', 'statSync', 'lstatSync', 'readdirSync', 'openSync', 'existsSync', 'accessSync', 'realpathSync'];
  const saved = names.map((n) => fs[n]);
  const seen = [];
  // readFileSync opens through fs.openSync itself; only the outer call is noted.
  let depth = 0;
  names.forEach((n, i) => {
    fs[n] = function watched(p, ...rest) {
      const s = String(p);
      if (!depth) seen.push(s);
      if (/^[\\/]{2}/.test(s)) {
        if (n === 'existsSync') return false;
        throw Object.assign(new Error(`ENOENT: refused in a test, ${s}`), { code: 'ENOENT' });
      }
      depth++;
      try {
        return saved[i].call(this, p, ...rest);
      } finally {
        depth--;
      }
    };
  });
  try {
    await fn();
  } finally {
    names.forEach((n, i) => { fs[n] = saved[i]; });
  }
  return seen;
}

// ---- parsing ----

test('an index reads back: modified UTF-8 paths, versions in order, times little-endian', () => {
  const files = [
    { key: '/src/Main.java', versions: [{ uuid: 'aa'.repeat(16), time: T2 }, { uuid: 'bb'.repeat(16), time: T1 }] },
    { key: '/문서/보고서 1.txt', versions: [{ uuid: 'cc'.repeat(16), time: T1 }] },
    { key: '/\u{1F600}.txt', versions: [] },
  ];
  assert.deepStrictEqual(parseIndex(historyIndex(files)), files);
});

test('an index that is cut short, has bytes left over or is another version gives nothing', () => {
  const good = historyIndex([{ key: '/a.txt', versions: [{ uuid: 'aa'.repeat(16), time: T1 }] }]);
  assert.ok(parseIndex(good));
  assert.strictEqual(parseIndex(good.subarray(0, good.length - 1)), null, 'cut short');
  assert.strictEqual(parseIndex(Buffer.concat([good, Buffer.from([0])])), null, 'bytes left over');
  assert.strictEqual(parseIndex(historyIndex([], 1)), null, 'version 1');
  assert.strictEqual(parseIndex(Buffer.alloc(3)), null, 'too short');
});

test('Java strings: a character past U+FFFF comes as two surrogates, and plain UTF-8 for it is refused', () => {
  assert.strictEqual(readUTF(utf('a\u{1F600}b'), 0).text, 'a\u{1F600}b');
  const four = Buffer.from('\u{1F600}', 'utf8');
  assert.strictEqual(readUTF(Buffer.concat([Buffer.from([0, four.length]), four]), 0), null);
});

test('index folders are named the way Eclipse names them', () => {
  // .settings is in the folder "af" on the machine this was written on.
  assert.strictEqual(bucketName('.settings'), 'af');
  assert.strictEqual(bucketName(''), '0');
  assert.strictEqual(bucketName('a'), '61');
  // This name hashes to Integer.MIN_VALUE, whose absolute value Java leaves negative.
  assert.strictEqual(bucketName('polygenelubricants'), '0');
});

test('project locations and links become real paths, and only those that can be told', () => {
  assert.strictEqual(uriPath('file:/C:/Users/alice/my%20app'), 'C:\\Users\\alice\\my app');
  assert.strictEqual(uriPath('file:///C:/Users/alice/app'), 'C:\\Users\\alice\\app');
  assert.strictEqual(uriPath('file:/home/alice/app'), '/home/alice/app');
  // Eclipse writes a UNC path with two more slashes; the form with a host is read the same.
  assert.strictEqual(uriPath('file:////server/share/app'), '\\\\server\\share\\app');
  assert.strictEqual(uriPath('file://server/share/app'), '\\\\server\\share\\app');
  assert.strictEqual(uriPath('semanticfs:/x'), null);
  for (const device of ['file://./pipe/x', 'file:////./pipe/x', 'file://?/GLOBALROOT/Device/x', 'file:////?/C:/x']) {
    assert.strictEqual(uriPath(device), null, device);
  }
  assert.strictEqual(plainPath('//server/share/app'), '\\\\server\\share\\app');
  assert.strictEqual(plainPath('\\\\server\\share\\app'), '\\\\server\\share\\app');
  assert.strictEqual(plainPath('\\\\.\\pipe\\x'), null);
  assert.strictEqual(plainPath('///x'), null);
  assert.strictEqual(plainPath('/home/alice/app'), '/home/alice/app');

  const root = 'C:\\Users\\alice\\ws\\app';
  const ws = 'C:\\Users\\alice\\ws';
  assert.strictEqual(linkTarget('C:/Users/alice/code', false, root, ws), 'C:\\Users\\alice\\code');
  assert.strictEqual(linkTarget('//server/share/lib', false, root, ws), '\\\\server\\share\\lib');
  assert.strictEqual(linkTarget('file:////server/share/lib', true, root, ws), '\\\\server\\share\\lib');
  assert.strictEqual(linkTarget('\\\\.\\pipe\\x', false, root, ws), null, 'a device');
  assert.strictEqual(linkTarget('PROJECT_LOC/gen', true, root, ws), 'C:\\Users\\alice\\ws\\app\\gen');
  assert.strictEqual(linkTarget('PARENT-2-PROJECT_LOC/shared%20lib', true, root, ws), 'C:\\Users\\alice\\shared lib');
  assert.strictEqual(linkTarget('WORKSPACE_LOC/other', true, root, ws), 'C:\\Users\\alice\\ws\\other');
  // PARENT_LOC depends on the resource being located, so a link through it has no one place.
  assert.strictEqual(linkTarget('PARENT_LOC/x', true, root, ws), null);
  assert.strictEqual(linkTarget('PARENT-1-PARENT_LOC/x', true, root, ws), null);
  assert.strictEqual(linkTarget('MY_VAR/lib', true, root, ws), null, 'a variable of its own');
  assert.strictEqual(linkTarget('virtual:/virtual', true, root, ws), null, 'a virtual folder');
  assert.strictEqual(linkTarget('constructor/x', true, root, ws), null);

  assert.strictEqual(onNetwork('\\\\server\\share\\app', ws), true);
  assert.strictEqual(onNetwork('\\\\server\\share\\ws\\app', '\\\\server\\share\\ws'), false, 'inside the workspace');
  assert.strictEqual(onNetwork(root, ws), false);
});

test('a .location naming a device, or a plain path, is read as Eclipse wrote it', () => {
  const meta = newWorkspace('eclipse-location');
  const rootOf = (value) => {
    write(path.join(meta, '.location'), locationFile(value));
    return projectRoot(meta, 'C:\\ws', 'app');
  };
  assert.strictEqual(rootOf('URI//file:////server/share/app'), '\\\\server\\share\\app');
  assert.strictEqual(rootOf('URI//file://./pipe/x'), null);
  assert.strictEqual(rootOf('\\\\.\\pipe\\x'), null);
  assert.strictEqual(rootOf('C:\\Users\\alice\\app'), 'C:\\Users\\alice\\app');
  assert.strictEqual(rootOf(''), path.join('C:\\ws', 'app'));
});

// ---- searching ----

// A project folder inside the fixture, so a test never reads anything of this machine's own.
const elsewhere = (ws) => path.join(ws, 'code', 'app');
const locationOf = (dir) => 'URI//' + pathToFileURL(dir).href;

test('finds every earlier version of a file, byte for byte, at the path its project gives', async () => {
  const ws = newWorkspace('eclipse');
  makeWorkspace(ws, {
    location: locationOf(elsewhere(ws)),
    files: [{
      key: '/src/Main.java',
      versions: [{ text: 'class Main { int v = 2; }\r\n', time: T2 }, { text: 'class Main {}\n', time: T1 }],
    }],
  });
  const { results } = await find('Main.java', ws);
  assert.deepStrictEqual(results.map((r) => [r.kind, r.path, r.time]), [
    ['eclipse history', path.join(elsewhere(ws), 'src', 'Main.java'), T2],
    ['eclipse history', path.join(elsewhere(ws), 'src', 'Main.java'), T1],
  ]);
  assert.strictEqual((await load(results[0], git)).toString(), 'class Main { int v = 2; }\r\n');
  assert.strictEqual(results[1].size, Buffer.byteLength('class Main {}\n'));
});

test('a project with no location, or an empty one, is inside the workspace folder', async () => {
  for (const location of [undefined, '']) {
    const ws = newWorkspace('eclipse-default');
    makeWorkspace(ws, { project: 'notes', location, files: [{ key: '/todo.txt', versions: [{ text: 'x', time: T1 }] }] });
    const { results } = await find('todo.txt', ws);
    assert.deepStrictEqual(results.map((r) => r.path), [path.join(ws, 'notes', 'todo.txt')]);
  }
});

test('a version whose state file is missing or has another modification time is left out, and said so', async () => {
  const ws = newWorkspace('eclipse-checks');
  makeWorkspace(ws, {
    location: locationOf(elsewhere(ws)),
    files: [{
      key: '/a.txt',
      versions: [
        { text: 'kept', time: T2 },
        { text: 'kept, off by less than two seconds', time: T2 - 10000, mtime: T2 - 10000 + 1500 },
        { text: 'touched a little later', time: T2 - 20000, mtime: T2 - 20000 + 2500 },
        { text: 'touched later', time: T1, mtime: T1 + 3600 * 1000 },
        { time: T1 - 1000, noState: true },
      ],
    }],
  });
  const { results, perSource } = await find('a.txt', ws);
  assert.deepStrictEqual(results.map((r) => r.time), [T2, T2 - 10000]);
  const notes = perSource[0].notes.join('\n');
  assert.match(notes, /2 version\(s\) left out/);
  assert.match(notes, /1 version\(s\) named in an index have no state file left/);
  // Nor is a copy left out offered with no name in a search by content.
  assert.deepStrictEqual((await find('', ws, { containing: 'touched' })).results, []);
  assert.deepStrictEqual((await find('', ws, { containing: 'kept' })).results.map((r) => [r.kind, r.time]), [
    ['eclipse history', T2], ['eclipse history', T2 - 10000]]);
});

test('a path in the wrong index folder, or whose link cannot be followed, has no name', async () => {
  const ws = newWorkspace('eclipse-unplaced');
  write(path.join(ws, 'app', '.project'), dotProject([
    ['lib', 2, 'locationURI', 'MY_VAR/lib'],
    ['up', 2, 'locationURI', 'PARENT_LOC/up'],
  ]));
  // The folder next to the one "src" hashes to: as deep as it should be, but the wrong one.
  const nextToSrc = ((parseInt(bucketName('src'), 16) + 1) % 256).toString(16);
  makeWorkspace(ws, {
    files: [
      { key: '/src/moved.txt', folders: [nextToSrc], versions: [{ text: 'misplaced secret', time: T1 }] },
      { key: '/src/deeper.txt', folders: [bucketName('src'), 'ff'], versions: [{ text: 'too deep secret', time: T1 }] },
      { key: '/lib/B.txt', versions: [{ text: 'linked secret', time: T1 }] },
      { key: '/up/C.txt', versions: [{ text: 'parent secret', time: T1 }] },
      { key: '/lib/touched.txt', versions: [{ text: 'touched secret', time: T1, mtime: T1 + 3600 * 1000 }] },
    ],
  });
  const byName = await find('*.txt', ws);
  assert.deepStrictEqual(byName.results, []);
  const notes = byName.perSource[0].notes.join('\n');
  assert.match(notes, /4 version\(s\) whose place cannot be told/);
  assert.match(notes, /1 version\(s\) left out/);

  // By content they come with no name and the time the index recorded; the touched one not at all.
  const byContent = await find('', ws, { containing: 'secret' });
  assert.deepStrictEqual(byContent.results.map((r) => [r.kind, r.path, r.time]),
    Array(4).fill(['eclipse history, name unknown', null, T1]));
  assert.ok(byContent.results.every((r) => !fs.readFileSync(r.file, 'utf8').includes('touched')));
});

test('an index that cannot be read is said so, and what it names is offered only by content', async () => {
  const ws = newWorkspace('eclipse-cut');
  const res = makeWorkspace(ws, {
    files: [
      { key: '/a.txt', versions: [{ text: 'a readable secret', time: T1 }] },
      { key: '/src/b.txt', versions: [{ text: 'a cut secret', time: T2 }] },
    ],
  });
  const index = path.join(res, '.projects', 'app', '.indexes', bucketName('src'), 'history.index');
  write(index, fs.readFileSync(index).subarray(0, -1));
  const byName = await find('*.txt', ws);
  assert.deepStrictEqual(byName.results.map((r) => r.path), [path.join(ws, 'app', 'a.txt')]);
  assert.match(byName.perSource[0].notes.join('\n'), /1 history index file\(s\) could not be read/);
  const byContent = await find('', ws, { containing: 'secret' });
  assert.deepStrictEqual(byContent.results.map((r) => [r.kind, r.path, r.time]), [
    ['eclipse history, name unknown', null, T2],
    ['eclipse history', path.join(ws, 'app', 'a.txt'), T1],
  ]);
});

test('linked folders and files lead to where they point', async () => {
  const ws = newWorkspace('eclipse-links');
  write(path.join(ws, 'app', '.project'), dotProject([
    ['_', 2, 'location', portable(path.join(ws, 'code'))],
    ['ext/shared', 2, 'locationURI', 'PARENT-1-PROJECT_LOC/shared%20lib'],
    ['one.txt', 1, 'location', portable(path.join(ws, 'Tom & Jerry.txt'))],
  ]));
  makeWorkspace(ws, {
    files: [
      { key: '/_/src/A.java', versions: [{ text: 'a', time: T1 }] },
      { key: '/ext/shared/B.java', versions: [{ text: 'b', time: T1 }] },
      { key: '/ext/C.java', versions: [{ text: 'c', time: T1 }] },
      { key: '/one.txt', versions: [{ text: 'd', time: T1 }] },
    ],
  });
  const { results } = await find('*', ws);
  assert.deepStrictEqual(results.map((r) => r.path).sort(), [
    path.join(ws, 'Tom & Jerry.txt'),
    path.join(ws, 'code', 'src', 'A.java'),
    path.join(ws, 'app', 'ext', 'C.java'),
    path.join(ws, 'shared lib', 'B.java'),
  ].sort());
});

test('a project with no .project left has its paths taken as the project folder\'s, and says so', async () => {
  const files = [{ key: '/lib/B.java', versions: [{ text: 'b', time: T1 }] }];
  const gone = newWorkspace('eclipse-gone');
  makeWorkspace(gone, { files });
  const { results, perSource } = await find('B.java', gone);
  assert.deepStrictEqual(results.map((r) => r.path), [path.join(gone, 'app', 'lib', 'B.java')]);
  assert.match(results[0].note, /no \.project left, so a link in it would not be seen/);
  assert.match(perSource[0].notes.join('\n'), /project app has no \.project left/);

  // The language server's own copy of .project still tells where its links go.
  const kept = newWorkspace('eclipse-kept');
  const res = makeWorkspace(kept, { files });
  write(path.join(res, '.projects', 'app', '.project'), dotProject([['lib', 2, 'location', portable(path.join(kept, 'shared'))]]));
  const again = await find('B.java', kept);
  assert.deepStrictEqual(again.results.map((r) => [r.path, r.note]), [[path.join(kept, 'shared', 'B.java'), undefined]]);
  assert.deepStrictEqual(again.perSource[0].notes, []);
});

test("the language server's own copy stands in only where jdt.ls would have kept it", async () => {
  const ws = newWorkspace('eclipse-jdtls');
  const at = (file, ms) => {
    fs.utimesSync(file, ms / 1000, ms / 1000);
    return file;
  };
  const after = T2 + 24 * 3600 * 1000;
  const before = T1 - 24 * 3600 * 1000;
  // "app" has a .settings folder, so every .prefs file of it lives in the project folder.
  const appDir = path.join(ws, 'code', 'app');
  write(path.join(appDir, '.settings', 'in.project.prefs'), 'now');
  const app = makeWorkspace(ws, {
    location: locationOf(appDir),
    files: [
      { key: '/.settings/org.eclipse.jdt.core.prefs', versions: [{ text: 'old', time: T1 }] },
      { key: '/.settings/in.project.prefs', versions: [{ text: 'old', time: T1 }] },
      { key: '/.classpath', versions: [{ text: '<classpath/>', time: T1 }] },
      { key: '/.factorypath', versions: [{ text: '<factorypath/>', time: T2 }, { text: '<factorypath/>', time: T1 }] },
    ],
  });
  const own = (project, ...segs) => write(path.join(app, '.projects', project, ...segs), 'now');
  at(own('app', '.settings', 'org.eclipse.jdt.core.prefs'), after);
  const classpath = at(own('app', '.classpath'), after);
  // Written before the newest version was kept, so not where that history came from.
  at(own('app', '.factorypath'), before);

  // "other" has no .settings folder: its .prefs files go to the server's copy, and nothing else does.
  const otherDir = path.join(ws, 'code', 'other');
  fs.mkdirSync(otherDir, { recursive: true });
  makeWorkspace(ws, {
    project: 'other',
    location: locationOf(otherDir),
    files: [
      { key: '/.settings/org.eclipse.jdt.core.prefs', versions: [{ text: 'old', time: T1 }] },
      { key: '/.settings/sub/deep.prefs', versions: [{ text: 'old', time: T1 }] },
      { key: '/.settings/notes.txt', versions: [{ text: 'old', time: T1 }] },
    ],
  });
  const prefs = at(own('other', '.settings', 'org.eclipse.jdt.core.prefs'), after);
  at(own('other', '.settings', 'sub', 'deep.prefs'), after);
  at(own('other', '.settings', 'notes.txt'), after);

  const { results } = await find('*', ws);
  assert.deepStrictEqual([...new Set(results.map((r) => r.path))].sort(), [
    path.join(appDir, '.settings', 'org.eclipse.jdt.core.prefs'),
    path.join(appDir, '.settings', 'in.project.prefs'),
    classpath,
    path.join(appDir, '.factorypath'),
    prefs,
    path.join(otherDir, '.settings', 'sub', 'deep.prefs'),
    path.join(otherDir, '.settings', 'notes.txt'),
  ].sort());
});

test('what no index names is offered only in a search by content, with no name', async () => {
  const ws = newWorkspace('eclipse-orphans');
  makeWorkspace(ws, {
    location: locationOf(elsewhere(ws)),
    files: [{ key: '/named.txt', versions: [{ text: 'a secret, named', time: T1 }] }],
    orphans: [{ text: 'a secret nobody names', time: T2 }],
  });
  assert.deepStrictEqual((await find('*', ws)).results.map((r) => r.kind), ['eclipse history']);
  const { results } = await find('', ws, { containing: 'secret' });
  assert.deepStrictEqual(results.map((r) => [r.kind, r.path, r.time]), [
    ['eclipse history, name unknown', null, T2],
    ['eclipse history', path.join(elsewhere(ws), 'named.txt'), T1],
  ]);
});

test('a project or a link on a network path is not looked at, and its versions have no name', async () => {
  const ws = newWorkspace('eclipse-network');
  // As Eclipse writes a project on \\server\share\app.
  makeWorkspace(ws, {
    location: 'URI//file:////server/share/app',
    files: [{ key: '/src/A.java', versions: [{ text: 'class A { /* secret */ }', time: T1 }] }],
  });
  // A local project with a folder linked to a share, and one of its versions touched since.
  write(path.join(ws, 'local', '.project'), dotProject([['net', 2, 'location', '//server/share/lib']]));
  makeWorkspace(ws, {
    project: 'local',
    files: [
      { key: '/net/B.java', versions: [{ text: 'class B { /* secret */ }', time: T1 }] },
      { key: '/net/C.java', versions: [{ text: 'class C { /* secret */ }', time: T1, mtime: T1 + 3600 * 1000 }] },
    ],
  });
  let byName;
  let byContent;
  const seen = await watchingFs(async () => {
    byName = await find('*.java', ws);
    byContent = await find('', ws, { containing: 'secret' });
    await describeAt(ws);
  });
  assert.deepStrictEqual(seen.filter((p) => /^[\\/]{2}/.test(p)), [], 'nothing on the network is tried');
  assert.deepStrictEqual(byName.results, []);
  const notes = byName.perSource[0].notes.join('\n');
  assert.match(notes, /2 version\(s\) of a project or link on a network path were not placed/);
  assert.match(notes, /1 version\(s\) left out/);
  assert.deepStrictEqual(byContent.results.map((r) => [r.kind, r.path, r.time]),
    Array(2).fill(['eclipse history, name unknown', null, T1]));
});

test('a project with no state file left is not looked up, and describe looks up none', async () => {
  const ws = newWorkspace('eclipse-lazy');
  const idleDir = path.join(ws, 'code', 'idle');
  write(path.join(idleDir, '.project'), dotProject([]));
  makeWorkspace(ws, {
    project: 'idle',
    location: locationOf(idleDir),
    files: [{ key: '/gone.txt', versions: [{ time: T1, noState: true }] }],
  });
  // No history at all, on a share: not even its .location is read.
  makeWorkspace(ws, { project: 'far', location: 'URI//file://nas.example/share/far' });
  makeWorkspace(ws, { files: [{ key: '/a.txt', versions: [{ text: 'a', time: T1 }] }] });
  let results;
  const seen = await watchingFs(async () => {
    ({ results } = await find('report.docx', ws));
    await find('gone.txt', ws);
    await describeAt(ws);
  });
  assert.deepStrictEqual(results, []);
  const projects = path.join(ws, ...RES, '.projects');
  assert.deepStrictEqual(seen.filter((p) => p.startsWith(idleDir) || /^[\\/]{2}/.test(p)
    || p === path.join(projects, 'idle', '.location') || p === path.join(projects, 'far', '.location')), []);

  // Describe reads no project's place at all; a search reads a live project's once.
  const described = await watchingFs(() => describeAt(ws));
  assert.deepStrictEqual(described.filter((p) => p.endsWith('.location') || p.endsWith('.project')), []);
  const searched = await watchingFs(() => find('*', ws));
  assert.deepStrictEqual(searched.filter((p) => p.endsWith('.location')), [path.join(projects, 'app', '.location')]);
});

test('a workspace is found from itself, its .metadata, its resources folder or a folder above it', () => {
  const top = newWorkspace('eclipse-places');
  const ws = path.join(top, 'Antigravity IDE', 'User', 'workspaceStorage', 'abc123', 'redhat.java', 'jdt_ws');
  makeWorkspace(ws, {});
  for (const place of [ws, path.join(ws, '.metadata'), path.join(ws, ...RES), path.join(top, 'Antigravity IDE')]) {
    assert.deepStrictEqual(workspacesAt(place), [ws], place);
  }
  assert.strictEqual(labelOf(ws), 'Antigravity IDE, Java language server');
  assert.strictEqual(labelOf(top), top);
});

test('a place given by hand that holds no workspace is said so', async () => {
  const empty = newWorkspace('eclipse-empty');
  const { results, perSource } = await find('*', empty);
  assert.deepStrictEqual(results, []);
  assert.deepStrictEqual(perSource[0].notes, [`${empty}: no Eclipse workspace there`]);
  const [d] = await describeAll({ sources: ['eclipse-history'], locations: only({ dirs: { 'eclipse-history': [empty] } }) });
  assert.deepStrictEqual(d.lines, ['No Eclipse or Java language server workspace found.', `${empty}: no Eclipse workspace there`]);
});

test('searching writes nothing, and describe counts what is there', async () => {
  const ws = newWorkspace('eclipse-readonly');
  makeWorkspace(ws, {
    location: locationOf(elsewhere(ws)),
    files: [{ key: '/a.txt', versions: [{ text: '1', time: T1 }, { text: '2', time: T2 }] }],
    orphans: [{ text: 'x', time: T1 }],
  });
  const before = snapshot(ws);
  await find('', ws, { containing: '1' });
  await find('a.txt', ws);
  assert.deepStrictEqual(snapshot(ws), before);
  const [d] = await describeAll({ sources: ['eclipse-history'], locations: only({ dirs: { 'eclipse-history': [ws] } }) });
  assert.deepStrictEqual(d.lines, [`${ws}: 1 workspace(s), 1 file(s) with 2 earlier version(s), 1 more that no index names`]);
  assert.deepStrictEqual(eclipse.roots({ 'eclipse-history': [ws] }), [path.join(ws, '.metadata')]);
});

test('restore writes into a project in the workspace folder, but not into what is read, also through a junction', async () => {
  const top = newWorkspace('eclipse-restore');
  // Eclipse's own layout: each project in the workspace folder, next to .metadata.
  const ws = path.join(top, 'eclipse-workspace');
  const res = path.join(ws, ...RES);
  // .history is a junction to a folder on another drive, which the scan follows.
  const realHistory = path.join(top, 'D', 'eclipse-history');
  fs.mkdirSync(realHistory, { recursive: true });
  fs.mkdirSync(res, { recursive: true });
  fs.symlinkSync(realHistory, path.join(res, '.history'), 'junction');
  makeWorkspace(ws, { files: [{ key: '/src/Main.java', versions: [{ text: 'class Main {}', time: T1 }] }] });
  const src = path.join(ws, 'app', 'src');
  // The workspace, a folder above it, its .metadata and its resources folder all protect the same.
  for (const place of [ws, top, path.join(ws, '.metadata'), res]) {
    const { results, locations } = await find('Main.java', place);
    assert.deepStrictEqual(results.map((r) => r.path), [path.join(src, 'Main.java')], place);
    const protect = eclipse.roots(locations);
    assert.deepStrictEqual(protect, [path.join(ws, '.metadata'), fs.realpathSync.native(realHistory)], place);
    for (const into of [src, ws]) {
      const written = await restore(results[0], into, protect, git);
      assert.strictEqual(written, path.join(into, 'Main.java'), `${place} -> ${into}`);
      assert.strictEqual(fs.readFileSync(written, 'utf8'), 'class Main {}');
      fs.rmSync(written);
    }
    for (const into of [path.join(ws, '.metadata'), path.join(res, '.projects', 'app'),
      path.join(res, '.history', 'restored'), path.join(realHistory, 'restored')]) {
      await assert.rejects(restore(results[0], into, protect, git), /^Error: Refusing to write inside /, `${place} -> ${into}`);
    }
  }
  // Nothing is read from a place that holds no workspace, so it protects nothing.
  assert.deepStrictEqual(eclipse.roots({ 'eclipse-history': [newWorkspace('eclipse-none')] }), []);
});
