'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { workDir, cleanup, write, only, snapshot } = require('./helpers');
const source = require('../src/sources/editor-backups');
const { hashString, parseUri, namesFor, originalPath, readHeader, discoverIn } = source._internal;
const { search, git } = require('../src/search');
const { load } = require('../src/content');
const { planRebuild, restore } = require('../src/restore');

const dirs = [];
after(() => dirs.forEach(cleanup));

// What the editor does when it backs up a buffer, written out here on its own rather than taken
// from the reader: base/common/hash.ts, URI.file(path).toString() and the fsPath it hashes.

function editorHash(s) {
  let h = ((0 << 5) - 0 + 149417) | 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h.toString(16);
}

/** URI.file(p).toString(): drive letter lower-cased, all but unreserved characters and / encoded. */
function fileUri(p) {
  const posix = /^[A-Za-z]:/.test(p) ? '/' + p[0].toLowerCase() + p.slice(1).replace(/\\/g, '/') : p;
  let out = '';
  for (const ch of posix) {
    out += /[A-Za-z0-9\-._~/]/.test(ch)
      ? ch
      : [...Buffer.from(ch, 'utf8')].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
  }
  return 'file://' + out;
}

/** fsPath on Windows: the drive letter lower-cased, backslashes kept. */
const winFsPath = (p) => p[0].toLowerCase() + p.slice(1);

/**
 * A custom editor's working copy, as toWorkingCopyResource builds it and URI.toString writes it:
 * the view type as authority, the file's URI in base64 as path, and that URI as JSON for query.
 */
function customUri(viewType, p) {
  const res = fileUri(p);
  const b64 = Buffer.from(res).toString('base64').replace(/[+=]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const json = JSON.stringify({ $mid: 1, fsPath: winFsPath(p), external: res, path: res.slice(7), scheme: 'file' });
  return `vscode-custom-editor://${viewType.replace(/[^a-z0-9]/gi, '-')}/${b64}?${encodeURIComponent(json)}`;
}

const T = 1790000000000;
const FOLDER_WINDOW = '0110490ab9af95d10703129a73f4bb4a';
const EMPTY_WINDOW = '1790000000123';

/** One backup file, named and filled the way the editor writes it. */
function backup(backups, { window = FOLDER_WINDOW, scheme = 'file', uri, hashed, meta, typeId = '', body, legacy = false, name, mtime = T }) {
  const preamble = legacy ? `${uri}\n` : `${uri} ${JSON.stringify({ ...meta, typeId })}\n`;
  const file = path.join(backups, window, scheme, name || editorHash(hashed));
  write(file, Buffer.concat([Buffer.from(preamble, 'utf8'), Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')]));
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

/** A dirty text file's backup, with the metadata the editor adds. */
function dirty(backups, p, body, { meta, ...rest } = {}) {
  return backup(backups, {
    uri: fileUri(p), hashed: winFsPath(p), body,
    meta: { mtime: T - 86400000, ctime: T - 172800000, size: 42, etag: 'abc', orphaned: false, ...meta },
    ...rest,
  });
}

const TEXT = 'line one\r\n한국어 줄\r\n\ttab and emoji \u{1F600}\r\nno newline at end';
const SPACED = 'C:\\Users\\Some One\\proj\\a b#c.txt';

function makeApp() {
  const root = workDir('editor-backups');
  dirs.push(root);
  const app = path.join(root, 'Code');
  fs.mkdirSync(path.join(app, 'User'), { recursive: true });
  const b = path.join(app, 'Backups');
  dirty(b, SPACED, TEXT, { mtime: T + 5000 });
  backup(b, { uri: fileUri('C:\\old\\legacy.txt'), hashed: winFsPath('C:\\old\\legacy.txt'), legacy: true, body: 'legacy body' });
  dirty(b, 'C:\\Users\\alice\\app\\gone.js', 'still here\n', { meta: { orphaned: true } });
  // Empty windows are numbered; untitled buffers carry no meta.
  backup(b, { window: EMPTY_WINDOW, scheme: 'untitled', uri: 'untitled:Untitled-1', hashed: 'Untitled-1', body: 'scratch notes about the budget\n' });
  backup(b, {
    window: EMPTY_WINDOW, scheme: 'untitled', uri: 'untitled:/c%3A/Users/alice/app/new.md',
    hashed: 'c:\\Users\\alice\\app\\new.md', body: '# draft\n',
  });
  // Written on Linux or macOS: the fsPath keeps its forward slashes.
  backup(b, { uri: 'file:///home/alice/notes.txt', hashed: '/home/alice/notes.txt', body: 'posix\n' });
  // Other schemes hash the URI as written.
  const remote = 'vscode-remote://ssh-remote%2Bbox/home/alice/remote.py';
  backup(b, { scheme: 'vscode-remote', uri: remote, hashed: remote, body: 'print(1)\n' });
  const settings = 'vscode-userdata:/c%3A/Users/alice/AppData/Roaming/Code/User/settings.json';
  backup(b, { scheme: 'vscode-userdata', uri: settings, hashed: settings, body: '{ "a": 1 }\n' });
  // Opened for a missing file in an SSH window: the untitled URI keeps the remote's authority,
  // which its fsPath, and so its name, leaves out.
  backup(b, { scheme: 'untitled', uri: 'untitled://ssh-remote%2Bbox/home/alice/newfile.py', hashed: '\\home\\alice\\newfile.py', body: 'print(2)\n' });

  // What must be left out.
  write(path.join(b, FOLDER_WINDOW, 'file', '12345678'), '');
  write(path.join(b, FOLDER_WINDOW, 'file', '2345678a'), fileUri('C:\\Users\\alice\\app\\cut.js') + ' {"typeId":""');
  dirty(b, 'C:\\Users\\alice\\app\\moved.js', 'moved\n', { name: 'deadbeef' });
  dirty(b, 'C:\\Users\\alice\\app\\wrongdir.js', 'wrong folder\n', { scheme: 'untitled' });
  const nb = 'C:\\Users\\alice\\app\\nb.ipynb';
  const typeId = 'notebook/jupyter-notebook/jupyter-notebook';
  dirty(b, nb, '{"cells":[]}', { typeId, hashed: winFsPath(nb) + '\\' + editorHash(typeId) });
  dirty(b, 'C:\\Users\\alice\\app\\bad.txt', Buffer.from([0x41, 0xff, 0xfe, 0x42]));
  const metaJs = 'C:\\Users\\alice\\app\\meta.js';
  write(path.join(b, FOLDER_WINDOW, 'file', editorHash(winFsPath(metaJs))), `${fileUri(metaJs)} {not json}\nbody`);
  // A custom editor (a hex editor, say) keeps its data in its own backup and writes the header
  // alone, with the typeId of a text file.
  const fw = 'C:\\Users\\alice\\fw\\firmware.bin';
  const custom = customUri('hexEditor.hexedit', fw);
  backup(b, {
    scheme: 'vscode-custom-editor', uri: custom, hashed: custom, body: '',
    meta: { viewType: 'hexEditor.hexedit', editorResource: { $mid: 1, path: '/c:/Users/alice/fw/firmware.bin', scheme: 'file' }, backupId: '1' },
  });
  // A write cut short by a crash: the file at its new size, the part not yet written read as zeros.
  dirty(b, 'C:\\Users\\alice\\app\\torn.js', Buffer.concat([Buffer.from('const y = 2;\n'), Buffer.alloc(4096)]));
  // Not the editor's shapes, so not even opened: a folder that is no window key, a name that is no
  // hash, a folder that is no scheme. Each is empty and would count as cut short if read.
  write(path.join(b, 'not-a-window', 'file', '12ab34cd'), '');
  write(path.join(b, FOLDER_WINDOW, 'file', 'notes.txt'), '');
  write(path.join(b, FOLDER_WINDOW, 'x y', '1234abcd'), '');

  // Beside it, a Backups folder of a program that is not an editor, and a stray app folder.
  write(path.join(root, 'HeidiSQL', 'Backups', 'query-tab-2026-09-10_10-00-00-000.sql'), 'select 1;');
  fs.mkdirSync(path.join(root, 'Antigravity%252520IDE', 'User'), { recursive: true });
  return { root, app, backups: b };
}

const find = (o, place) => search({ sources: ['editor-backups'], locations: only({ dirs: { 'editor-backups': [place] } }), ...o });
const notesOf = (perSource) => perSource.find((s) => s.id === 'editor-backups').notes;
// On every copy: the text is what the editor held, re-encoded, and nothing records its length.
const AS_UTF8 = 'as UTF-8; length not checked';

test('the name hash gives the values VS Code pins in its own tests', () => {
  const names = (s) => namesFor(s, parseUri(s));
  // Windows first, then Linux and macOS.
  assert.deepStrictEqual(names('untitled:Untitled-1'), ['-7f9c1a2e', '-7f9c1a2e']);
  assert.deepStrictEqual(names('file:///foo'), ['20ffaa13', '20eb3560']);
  assert.deepStrictEqual(names('vscode-custom:somePath'), ['-44972d98']);
  assert.deepStrictEqual(names('vscode-fragment:#frag'), ['-2f6b2f1b']);
  // Typed working copies hash the resource joined with the hash of the type.
  const typed = hashString('hashTest');
  assert.strictEqual(hashString('Untitled-1\\' + typed), '-17c47cdc');
  assert.strictEqual(hashString('Untitled-1/' + typed), '-8ad5f4f');
  assert.strictEqual(hashString('\\foo\\' + typed), '-55fc55db');
  assert.strictEqual(hashString('/foo/' + typed), '51e56bf');
  assert.strictEqual(hashString('vscode-custom:somePath/' + typed), '502149c7');
  assert.strictEqual(hashString('vscode-fragment:' + typed + '#frag'), '6e82ca57');
  // The fixtures below are named by a hash written separately; it must agree.
  for (const s of ['Untitled-1', '\\foo', '/foo', 'c:\\Users\\Some One\\proj\\a b#c.txt', '한국어 \u{1F600}']) {
    assert.strictEqual(editorHash(s), hashString(s));
  }
  assert.strictEqual(fileUri(SPACED), 'file:///c%3A/Users/Some%20One/proj/a%20b%23c.txt');
});

test('a dirty file comes back as the editor held it, marked as never saved', async () => {
  const { backups } = makeApp();
  const { results } = await find({ pattern: 'a b#c.txt' }, backups);
  assert.strictEqual(results.length, 1);
  const c = results[0];
  assert.strictEqual(c.path, 'C:\\Users\\Some One\\proj\\a b#c.txt');
  assert.strictEqual(c.kind, 'unsaved editor buffer');
  assert.strictEqual(c.draft, true);
  assert.strictEqual(c.time, T + 5000, 'dated by the backup, not by the file it was made from');
  assert.strictEqual(c.size, Buffer.byteLength(TEXT, 'utf8'));
  assert.strictEqual((await load(c, git)).toString('utf8'), TEXT);
  assert.strictEqual(c.note, `Code, ${AS_UTF8}`);
});

test('an old backup with no metadata is read too, and a file deleted while open says so', async () => {
  const { backups } = makeApp();
  const legacy = (await find({ pattern: 'legacy.txt' }, backups)).results;
  assert.deepStrictEqual(legacy.map((c) => [c.path, c.text]), [['C:\\old\\legacy.txt', 'legacy body']]);
  const gone = (await find({ pattern: 'gone.js' }, backups)).results;
  assert.strictEqual(gone[0].note, `Code, deleted while open, ${AS_UTF8}`);
});

test('an untitled buffer has no name and is offered only to a content-only search', async () => {
  const { backups } = makeApp();
  assert.strictEqual((await find({ pattern: '*' }, backups)).results.some((c) => !c.path), false);
  assert.strictEqual((await find({ pattern: 'Untitled' }, backups)).results.length, 0);
  const { results } = await find({ pattern: '', containing: 'budget' }, backups);
  assert.deepStrictEqual(results.map((c) => [c.path, c.note, c.draft]), [[null, `Code, Untitled-1, ${AS_UTF8}`, true]]);
  assert.strictEqual((await load(results[0], git)).toString(), 'scratch notes about the budget\n');
});

test('an untitled buffer given a file to save to carries that path', async () => {
  const { backups } = makeApp();
  const { results } = await find({ pattern: 'new.md' }, backups);
  assert.deepStrictEqual(results.map((c) => [c.path, c.text, c.note]), [['C:\\Users\\alice\\app\\new.md', '# draft\n', `Code, untitled, ${AS_UTF8}`]]);
});

test('an untitled buffer from a remote window keeps its URI, rather than a \\\\server path that never existed', async () => {
  const { backups } = makeApp();
  const { results } = await find({ pattern: 'newfile.py' }, backups);
  assert.deepStrictEqual(results.map((c) => [c.path, c.text]), [['untitled://ssh-remote%2Bbox/home/alice/newfile.py', 'print(2)\n']]);
  const op = (s) => originalPath(s, parseUri(s));
  assert.strictEqual(op('untitled://wsl%2Bubuntu/home/a/x.py'), 'untitled://wsl%2Bubuntu/home/a/x.py');
  assert.strictEqual(op('untitled://dev-container%2B7b22/workspaces/p/y.js'), 'untitled://dev-container%2B7b22/workspaces/p/y.js');
  // A host name has no '+': a missing file on a share is still that share's path.
  assert.strictEqual(op('untitled://server/share/x.md'), '\\\\server\\share\\x.md');
});

test('backups from other systems and schemes are recognised by their own names', async () => {
  const { backups } = makeApp();
  const got = async (p) => (await find({ pattern: p }, backups)).results.map((c) => c.path);
  assert.deepStrictEqual(await got('notes.txt'), ['/home/alice/notes.txt']);
  assert.deepStrictEqual(await got('remote.py'), ['vscode-remote://ssh-remote%2Bbox/home/alice/remote.py']);
  assert.deepStrictEqual(await got('settings.json'), ['C:\\Users\\alice\\AppData\\Roaming\\Code\\User\\settings.json']);
});

test('a backup that fails a check is left out, and the search says why', async () => {
  const { backups } = makeApp();
  const { results, perSource } = await find({ pattern: '*' }, backups);
  assert.deepStrictEqual(results.map((c) => path.win32.basename(c.path.replace(/\//g, '\\'))).sort(),
    ['a b#c.txt', 'gone.js', 'legacy.txt', 'new.md', 'newfile.py', 'notes.txt', 'remote.py', 'settings.json']);
  const notes = notesOf(perSource);
  assert.strictEqual(notes.length, 5);
  assert.match(notes[0], /^2 backup file\(s\) are empty or cut short/);
  assert.match(notes[1], /^Left out 3 matching backup\(s\) whose header does not fit/);
  assert.match(notes[2], /^Left out 2 matching backup\(s\) of notebooks or custom editors/);
  assert.match(notes[3], /^Left out 1 matching backup\(s\) that are not valid UTF-8/);
  assert.match(notes[4], /^Left out 1 matching backup\(s\) whose text ends in zero bytes/);
  // Only what the search asked for is counted, except files whose name is lost with their header.
  assert.deepStrictEqual(notesOf((await find({ pattern: 'legacy.txt' }, backups)).perSource), [notes[0]]);
});

test('a custom editor\'s backup is left out, though it has a text file\'s typeId and its URI names the file', async () => {
  const { backups } = makeApp();
  const { results, perSource } = await find({ pattern: 'firmware.bin' }, backups);
  assert.strictEqual(results.length, 0);
  assert.deepStrictEqual(notesOf(perSource).slice(1),
    ['Left out 1 matching backup(s) of notebooks or custom editors; they hold the editor\'s own data, not the file.']);
  // Its meta gives it away too, whatever scheme it is under.
  const p = 'C:\\Users\\alice\\fw\\firmware.bin';
  const head = Buffer.from(`${fileUri(p)} ${JSON.stringify({ viewType: 'hexEditor.hexedit', backupId: '1', typeId: '' })}\n`);
  assert.strictEqual(readHeader(head, editorHash(winFsPath(p)), 'file').why, 'typed');
});

test('a backup whose text ends in zero bytes is left out as cut short', async () => {
  const { backups } = makeApp();
  const { results, perSource } = await find({ pattern: 'torn.js' }, backups);
  assert.strictEqual(results.length, 0);
  assert.deepStrictEqual(notesOf(perSource).slice(1),
    ['Left out 1 matching backup(s) whose text ends in zero bytes, as a write cut short by a crash leaves it.']);
});

/**
 * Makes the editor rewrite `file` with `data` the way it does, truncating first: between the
 * reader's header read and its whole read, or `during` the whole read.
 */
function editorRewrites(file, data, during) {
  const { openSync, readSync } = fs;
  let opens = 0;
  let watched = null;
  fs.openSync = function (p, ...rest) {
    const k = p === file ? ++opens : 0;
    if (k === 2 && !during) fs.writeFileSync(file, data);
    const fd = openSync.call(fs, p, ...rest);
    if (k === 2) watched = fd;
    return fd;
  };
  fs.readSync = function (fd, ...rest) {
    const n = readSync.call(fs, fd, ...rest);
    if (during && fd === watched) {
      watched = null;
      fs.writeFileSync(file, data);
    }
    return n;
  };
  return () => Object.assign(fs, { openSync, readSync });
}

test('a backup the editor rewrites while it is read is left out, and read whole the next time', async () => {
  const root = workDir('editor-backups-race');
  dirs.push(root);
  const b = path.join(root, 'Code', 'Backups');
  const file = dirty(b, 'C:\\Users\\alice\\app\\race.js', 'const x = 1;\n');
  const before = fs.readFileSync(file);
  // The first backup after the file was deleted: the header is one byte shorter, the text the same.
  const after = Buffer.from(before.toString('utf8').replace('"orphaned":false', '"orphaned":true'));
  assert.strictEqual(after.length, before.length - 1);
  for (const during of [false, true]) {
    fs.writeFileSync(file, before);
    fs.utimesSync(file, T / 1000, T / 1000);
    const undo = editorRewrites(file, after, during);
    let r;
    try {
      r = await find({ pattern: 'race.js' }, b);
    } finally {
      undo();
    }
    assert.strictEqual(r.results.length, 0, during ? 'rewritten during the read' : 'rewritten between the reads');
    assert.deepStrictEqual(notesOf(r.perSource),
      ['Left out 1 matching backup(s) that the editor rewrote while they were being read; search again to read them.']);
    const again = (await find({ pattern: 'race.js' }, b)).results;
    assert.deepStrictEqual(again.map((c) => [c.text, c.note]), [['const x = 1;\n', `Code, deleted while open, ${AS_UTF8}`]]);
  }
});

test('a place can be the Backups folder or the app folder holding it, and is read once', async () => {
  const { app, backups } = makeApp();
  const { results } = await search({
    pattern: 'legacy.txt', sources: ['editor-backups'],
    locations: only({ dirs: { 'editor-backups': [app, backups, backups + path.sep] } }),
  });
  assert.deepStrictEqual(results.map((c) => c.copies), [1]);
  assert.deepStrictEqual(source.roots({ 'editor-backups': [app] }), [path.resolve(app), fs.realpathSync.native(backups)]);
  const missing = path.join(app, 'nothing-here');
  assert.match(notesOf((await find({ pattern: '*' }, missing)).perSource)[0], /^Could not read /);
});

test('a place that is not a Backups folder is not walked, and the search says so', async () => {
  const { root } = makeApp();
  // The app-data folder given instead of the app's: files three levels down that no editor wrote.
  write(path.join(root, 'Documents', 'work', 'deadbeef'), 'not a backup');
  write(path.join(root, 'Documents', 'work', 'report.txt'), 'not a backup either');
  const { openSync } = fs;
  let opened = 0;
  fs.openSync = function (p, ...rest) {
    if (String(p).startsWith(root)) opened++;
    return openSync.call(fs, p, ...rest);
  };
  let r;
  try {
    r = await find({ pattern: '*' }, root);
  } finally {
    fs.openSync = openSync;
  }
  assert.strictEqual(r.results.length, 0);
  assert.strictEqual(opened, 0, 'nothing opened');
  const why = `${root} is not an editor Backups folder; give the Backups folder or the app folder holding it.`;
  assert.deepStrictEqual(notesOf(r.perSource), [why]);
  assert.deepStrictEqual(source.describe({ locations: { 'editor-backups': [root] } }), [why]);
  // An empty Backups folder, as an editor with nothing unsaved leaves it, and another program's
  // Backups folder, are read without a word.
  fs.mkdirSync(path.join(root, 'Empty', 'Backups'), { recursive: true });
  for (const place of [path.join(root, 'Empty'), path.join(root, 'HeidiSQL')]) {
    const e = await find({ pattern: '*' }, place);
    assert.deepStrictEqual([e.results.length, notesOf(e.perSource)], [0, []], place);
  }
});

test('restore refuses the real folder read, also when Backups or the app folder is a junction', async () => {
  const root = workDir('editor-backups-junction');
  dirs.push(root);
  const p = 'C:\\Users\\alice\\app\\far.js';
  // <app>/Backups is a junction to a folder on another drive.
  const realA = path.join(root, 'D', 'CodeBackups');
  dirty(realA, p, 'far\n');
  const appA = path.join(root, 'A', 'Code');
  fs.mkdirSync(path.join(appA, 'User'), { recursive: true });
  fs.symlinkSync(realA, path.join(appA, 'Backups'), 'junction');
  // The app folder itself is one: mklink /J %APPDATA%\Code D:\Code.
  const realB = path.join(root, 'D', 'Code');
  dirty(path.join(realB, 'Backups'), p, 'far\n');
  fs.mkdirSync(path.join(realB, 'User'));
  const appB = path.join(root, 'B', 'Code');
  fs.mkdirSync(path.dirname(appB));
  fs.symlinkSync(realB, appB, 'junction');
  const cases = [[appA, realA], [path.join(appA, 'Backups'), realA],
    [appB, path.join(realB, 'Backups')], [path.join(appB, 'Backups'), path.join(realB, 'Backups')]];
  for (const [place, real] of cases) {
    const { results } = await find({ pattern: 'far.js' }, place);
    assert.strictEqual(results.length, 1, place);
    const protect = source.roots({ 'editor-backups': [place] });
    for (const into of [path.join(place, 'restored'), path.join(fs.realpathSync.native(real), 'restored')]) {
      await assert.rejects(restore(results[0], into, protect, git), /^Error: Refusing to write inside /, into);
    }
  }
});

test('discovery takes app folders with the editor layout only', () => {
  const { root, backups } = makeApp();
  assert.deepStrictEqual(discoverIn(root), [backups]);
  assert.deepStrictEqual(discoverIn(path.join(root, 'no-such-folder')), []);
});

test('sources lists what each Backups folder holds', () => {
  const { backups } = makeApp();
  const lines = source.describe({ locations: { 'editor-backups': [backups] } });
  assert.deepStrictEqual(lines, [
    `Code: 9 unsaved buffer(s) in 2 window(s)  (${backups})`,
    'Code: 9 other file(s) that are not text buffers or fail their checks',
  ]);
  assert.deepStrictEqual(source.describe({ locations: { 'editor-backups': [] } }), ['No editor Backups folder found.']);
});

test('rebuild takes a saved copy over a newer unsaved buffer, and the buffer where nothing else exists', async () => {
  const root = workDir('editor-backups-rebuild');
  dirs.push(root);
  const b = path.join(root, 'Code', 'Backups');
  const history = path.join(root, 'Code', 'User', 'History');
  write(path.join(history, '-7a1b2c', 'entries.json'), JSON.stringify({
    version: 1, resource: fileUri('C:\\Users\\alice\\app\\server.js'), entries: [{ id: 'Ab12.js', timestamp: T - 60000 }],
  }));
  write(path.join(history, '-7a1b2c', 'Ab12.js'), 'saved\n');
  dirty(b, 'C:\\Users\\alice\\app\\server.js', 'unsaved\n');
  dirty(b, 'C:\\Users\\alice\\app\\lib\\new.js', 'only here\n');
  const folder = 'C:\\Users\\alice\\app';
  const { results } = await search({
    under: folder, sources: ['editor-backups', 'history'],
    locations: only({ historyDirs: [history], dirs: { 'editor-backups': [b] } }),
  });
  assert.strictEqual(results.length, 3);
  const plan = planRebuild(results, folder).map(({ rel, copy }) => [rel.join('/'), copy.kind, copy.text || null]);
  assert.deepStrictEqual(plan, [
    ['lib/new.js', 'unsaved editor buffer', 'only here\n'],
    ['server.js', 'local history', null],
  ]);
});

test('searching writes nothing', async () => {
  const { root, backups } = makeApp();
  const before = snapshot(root);
  await find({ pattern: '*' }, backups);
  await find({ pattern: '', containing: 'budget' }, backups);
  source.describe({ locations: { 'editor-backups': [backups] } });
  assert.deepStrictEqual(snapshot(root), before);
});
