'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { workDir, cleanup, write, only, snapshot } = require('./helpers');
const snips = require('../src/sources/snips');
const { captureRoots, nameTime, whenTaken, pngSize, ZONES_APART } = snips._internal;
const { search } = require('../src/search');
const api = require('../src/index');
const { tier } = require('../src/quality');

const dirs = [];
after(() => dirs.forEach(cleanup));

// Folders are laid out as Windows keeps them, below a user profile:
//   AppData\Local\Packages\Microsoft.ScreenSketch_8wekyb3d8bbwe\TempState\{Snips,Recordings}
//   AppData\Local\Packages\Microsoft.Windows.ShellExperienceHost_cw5n1h2txyewy\TempState\ScreenClip

/** A PNG header of the given size: the signature, then IHDR, as every PNG starts. */
function png(width, height, fill = 0) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(200, fill)]);
}

/** The start of an MP4, as a screen recording is. */
function mp4() {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write('ftypmp42', 4, 'latin1');
  ftyp.write('isommp42', 16, 'latin1');
  return Buffer.concat([ftyp, Buffer.alloc(500, 1)]);
}

const TAKEN = Date.UTC(2025, 0, 2, 3, 4, 5);

/** A file, with its last-write time set. */
function put(file, data, mtime = TAKEN) {
  write(file, data);
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

/** A profile with the Snipping Tool's folders and a few files in them. */
function profile() {
  const root = workDir('snips');
  dirs.push(root);
  const packages = path.join(root, 'AppData', 'Local', 'Packages');
  const temp = path.join(packages, 'Microsoft.ScreenSketch_8wekyb3d8bbwe', 'TempState');
  const shell = path.join(packages, 'Microsoft.Windows.ShellExperienceHost_cw5n1h2txyewy', 'TempState');
  const f = {
    root, packages, temp, shell,
    shot: put(path.join(temp, 'Snips', 'Screenshot 2025-01-02 030405.png'), png(640, 480)),
    korean: put(path.join(temp, 'Snips', '스크린샷 2025-01-03 101112.png'), png(1920, 1080, 2), TAKEN + 86400000),
    recording: put(path.join(temp, 'Recordings', 'Screen Recording 2025-01-04 050607.mp4'), mp4(), TAKEN + 2 * 86400000),
    settings: put(path.join(temp, 'Snips', 'state.json'), '{"not":"a capture"}'),
    clip: put(path.join(shell, 'ScreenClip', '{0b5c7b58-1a2b-4c3d-8e9f-001122334455}'), png(10, 20, 3)),
    shellOther: put(path.join(shell, 'lockscreen.png'), png(5, 5, 4)),
  };
  return f;
}

const find = (f, o = {}) => search({ sources: ['snips'], locations: only({ dirs: { snips: [f.root] } }), ...o });

test('the folders behind a profile, the Packages folder, a package, or the folders themselves', () => {
  const f = profile();
  const keys = (list) => list.map((d) => path.relative(f.root, d)).sort();
  const both = keys([f.temp, path.join(f.shell, 'ScreenClip')]);
  assert.deepStrictEqual(keys(captureRoots(f.root)), both);
  assert.deepStrictEqual(keys(captureRoots(f.packages)), both);
  assert.deepStrictEqual(keys(captureRoots(path.dirname(f.temp))), keys([f.temp]));
  assert.deepStrictEqual(keys(captureRoots(f.temp)), keys([f.temp]));
  assert.deepStrictEqual(keys(captureRoots(path.join(f.temp, 'Snips'))), keys([path.join(f.temp, 'Snips')]));
  // The shell's TempState holds more than clips: only its ScreenClip is taken.
  assert.deepStrictEqual(keys(captureRoots(f.shell)), keys([path.join(f.shell, 'ScreenClip')]));
  // A folder of captures under any name, as one copied off an old drive.
  const copied = path.join(f.root, 'old');
  put(path.join(copied, 'Screenshot 2024-05-06 070809.png'), png(1, 1));
  assert.deepStrictEqual(keys(captureRoots(copied)), ['old']);
  assert.deepStrictEqual(keys(captureRoots(path.join(f.root, 'AppData'))), both);
  fs.mkdirSync(path.join(f.root, 'AppData', 'Roaming'));
  assert.deepStrictEqual(captureRoots(path.join(f.root, 'AppData', 'Roaming')), [], 'not on the way to Packages');
  assert.deepStrictEqual(captureRoots(path.join(f.root, 'nowhere')), []);
});

test('finds each capture as it was taken, named and dated, with no folder and nothing written', async () => {
  const f = profile();
  const before = snapshot(f.root);
  const r = await find(f);
  assert.deepStrictEqual(snapshot(f.root), before, 'nothing written');
  const byName = Object.fromEntries(r.results.map((c) => [c.name, c]));
  assert.deepStrictEqual(Object.keys(byName).sort(), [
    'Screen Recording 2025-01-04 050607.mp4',
    'Screenshot 2025-01-02 030405.png',
    '{0b5c7b58-1a2b-4c3d-8e9f-001122334455}.png',
    '스크린샷 2025-01-03 101112.png',
  ].sort());
  for (const c of r.results) {
    assert.strictEqual(c.kind, 'snipping tool capture');
    assert.strictEqual(c.source, 'snips');
    assert.strictEqual(c.path, null, 'where it would have been saved is not known');
    assert.strictEqual(tier(c), 0, 'the capture itself');
    assert.strictEqual(c.state, '', 'with no path, whether it is gone cannot be told');
  }
  const shot = byName['Screenshot 2025-01-02 030405.png'];
  assert.strictEqual(shot.time, TAKEN);
  assert.strictEqual(shot.mediaType, 'image');
  assert.strictEqual(shot.ext, '.png');
  assert.deepStrictEqual([shot.width, shot.height], [640, 480]);
  assert.strictEqual(shot.size, fs.statSync(f.shot).size);
  assert.strictEqual(shot.origin, f.shot);
  assert.ok(!shot.note);
  const rec = byName['Screen Recording 2025-01-04 050607.mp4'];
  assert.strictEqual(rec.mediaType, 'video');
  assert.strictEqual(rec.ext, '.mp4');
  assert.strictEqual(rec.width, undefined, 'a recording\'s size is not read');
  // A file with no extension of its format gets one, to be restored as that.
  assert.strictEqual(byName['{0b5c7b58-1a2b-4c3d-8e9f-001122334455}.png'].mediaType, 'image');
  // Newest first.
  assert.strictEqual(r.results[0].name, 'Screen Recording 2025-01-04 050607.mp4');
  const notes = r.perSource[0].notes;
  assert.ok(notes.some((n) => /^1 file\(s\) .* not a picture or a video/.test(n)), notes.join('\n'));
});

test('a name pattern and --type choose among them; a search for text reads nothing here', async () => {
  const f = profile();
  const names = async (o) => (await find(f, o)).results.map((c) => c.name).sort();
  assert.deepStrictEqual(await names({ pattern: '스크린샷' }), ['스크린샷 2025-01-03 101112.png']);
  assert.deepStrictEqual(await names({ pattern: 'Screen Recording*' }), ['Screen Recording 2025-01-04 050607.mp4']);
  assert.deepStrictEqual(await names({ pattern: '*.png', types: ['video'] }), []);
  assert.deepStrictEqual(await names({ types: ['video'] }), ['Screen Recording 2025-01-04 050607.mp4']);
  assert.strictEqual((await names({ types: ['image'] })).length, 3);
  const text = await find(f, { types: ['text'] });
  assert.deepStrictEqual(text.results, []);
  assert.deepStrictEqual(text.perSource[0].notes, [], 'no file was even looked at');
  // Rebuilding a folder needs a path, which a capture does not have.
  assert.deepStrictEqual((await find(f, { under: f.root })).results, []);
});

test('--since keeps what was taken from then on', async () => {
  const f = profile();
  const r = await find(f, { since: TAKEN + 1 });
  assert.deepStrictEqual(r.results.map((c) => c.name).sort(),
    ['Screen Recording 2025-01-04 050607.mp4', '스크린샷 2025-01-03 101112.png']);
});

test('dated by the file, unless the time in its name shows that the file\'s time is not the capture\'s', async () => {
  const named = new Date(2024, 4, 6, 7, 8, 9).getTime();
  assert.strictEqual(nameTime('Screenshot 2024-05-06 070809.png'), named, 'read in this machine\'s time zone');
  assert.strictEqual(nameTime('스크린샷 2024-05-06 070809.png'), named, 'in any language');
  assert.strictEqual(nameTime('Screenshot 2024-02-30 070809.png'), null, 'no such day');
  assert.strictEqual(nameTime('Screenshot 2024-05-06 250809.png'), null, 'no such hour');
  assert.strictEqual(nameTime('{0b5c7b58-1a2b-4c3d-8e9f-001122334455}.png'), null);
  // Any time zone apart, the file's own time stands: it is an exact instant.
  assert.deepStrictEqual(whenTaken('Screenshot 2024-05-06 070809.png', named + ZONES_APART), { time: named + ZONES_APART });
  assert.deepStrictEqual(whenTaken('Screenshot 2024-05-06 070809.png', named - 13 * 3600e3), { time: named - 13 * 3600e3 });
  assert.deepStrictEqual(whenTaken('x.png', 5), { time: 5 });
  const copied = whenTaken('Screenshot 2024-05-06 070809.png', Date.UTC(2026, 8, 1));
  assert.strictEqual(copied.time, named);
  assert.match(copied.note, /dated by the time in its name.*2026-09-01T00:00:00\.000Z/);

  const f = profile();
  put(path.join(f.temp, 'Snips', 'Screenshot 2024-05-06 070809.png'), png(3, 3, 9), Date.UTC(2026, 8, 1));
  const c = (await find(f, { pattern: '2024-05-06' })).results;
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].time, named);
  assert.match(c[0].note, /dated by the time in its name/);
});

test('reads only plain files, and says when a place given holds no Snipping Tool folder', async () => {
  const f = profile();
  fs.mkdirSync(path.join(f.temp, 'Snips', 'Screenshot 2025-02-02 020202.png'));
  const empty = path.join(f.root, 'empty');
  fs.mkdirSync(empty);
  const r = await search({ sources: ['snips'], locations: only({ dirs: { snips: [f.root, empty] } }) });
  assert.strictEqual(r.results.length, 4, 'a folder under a capture\'s name is not read');
  assert.ok(r.perSource[0].notes.includes(`${empty}: no Snipping Tool folder there`), r.perSource[0].notes.join('\n'));
  assert.ok(!r.perSource[0].error);
});

test('a capture comes back under its name, exactly, and never into the tool\'s own folders', async () => {
  const f = profile();
  const { results, locations } = await find(f, { pattern: 'Screenshot 2025' });
  assert.strictEqual(results.length, 1);
  const out = path.join(f.root, 'restored');
  const written = await api.restoreCopy(results[0], out, locations);
  assert.strictEqual(path.basename(written), 'Screenshot 2025-01-02 030405.png');
  assert.deepStrictEqual(fs.readFileSync(written), fs.readFileSync(f.shot));
  assert.deepStrictEqual(fs.readdirSync(out), ['Screenshot 2025-01-02 030405.png'], 'no temporary file left');
  await assert.rejects(api.restoreCopy(results[0], path.join(f.temp, 'Snips', 'out'), locations));
  await assert.rejects(api.restoreCopy(results[0], path.join(f.shell, 'ScreenClip'), locations));
  assert.ok(!fs.existsSync(path.join(f.temp, 'Snips', 'out')), 'nothing created there');

  const rootKeys = snips.roots({ snips: [f.root] }).map((d) => path.relative(f.root, d));
  assert.ok(rootKeys.includes(path.relative(f.root, f.temp)));
  assert.ok(rootKeys.includes(path.relative(f.root, path.join(f.shell, 'ScreenClip'))));
  // A place that stands for no folder is still kept from being written into.
  assert.deepStrictEqual(snips.roots({ snips: [path.join(f.root, 'gone')] }), [path.join(f.root, 'gone')]);
});

test('describe counts what each folder has to offer', async () => {
  const f = profile();
  const lines = snips.describe({ locations: { snips: [f.root] } });
  assert.ok(lines.some((l) => l === `${path.join(f.temp, 'Snips')}: 3 file(s), 2 picture(s) and 0 recording(s) to offer`), lines.join('\n'));
  assert.ok(lines.some((l) => l === `${path.join(f.temp, 'Recordings')}: 1 file(s), 0 picture(s) and 1 recording(s) to offer`));
  assert.deepStrictEqual(snips.describe({ locations: { snips: [] } }), ['No Snipping Tool folder found.']);
});

test('a PNG\'s size comes from its header; anything else has none', () => {
  assert.deepStrictEqual(pngSize(png(7, 9)), { width: 7, height: 9 });
  assert.strictEqual(pngSize(png(0, 9)), null);
  assert.strictEqual(pngSize(mp4()), null);
  assert.strictEqual(pngSize(png(7, 9).subarray(0, 20)), null);
});
