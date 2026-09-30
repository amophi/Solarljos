'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { workDir, cleanup, write, infoV2, snapshot } = require('./helpers');
const fmt = require('../src/format');

const BIN = path.join(__dirname, '..', 'bin', 'solarljos.js');
const dirs = [];
after(() => dirs.forEach(cleanup));

function fixtures() {
  const root = workDir('cli');
  dirs.push(root);
  const bin = path.join(root, 'sources', '$Recycle.Bin', 'S-1-5-21-9-9-9-1001');
  write(path.join(bin, '$IQ1W2E3.txt'), infoV2('C:\\Users\\alice\\budget.txt', 7, Date.UTC(2026, 8, 1)));
  write(path.join(bin, '$RQ1W2E3.txt'), 'numbers');
  write(path.join(bin, '$IP0O9I8.png'), infoV2('C:\\Users\\alice\\chart.png', 4, Date.UTC(2026, 8, 2)));
  write(path.join(bin, '$RP0O9I8.png'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
  return { root, recycle: path.join(root, 'sources', '$Recycle.Bin') };
}

function cli(args, f, env) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--no-discover', '--recycle-dir', f.recycle], {
    cwd: f.root, encoding: 'utf8', env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('find lists copies with an ID and tells how to get one back', () => {
  const f = fixtures();
  const r = cli(['find', 'budget'], f);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /C:\\Users\\alice\\budget\.txt/);
  assert.match(r.out, /^[0-9a-f]{8} /m);
  assert.match(r.out, /solarljos restore budget .*--to <folder>/);
});

test('find exits 1 when nothing turns up', () => {
  const f = fixtures();
  const r = cli(['find', 'no-such-file'], f);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /Nothing found/);
});

test('--json prints only JSON', () => {
  const f = fixtures();
  const r = cli(['find', '*.txt', '--json'], f);
  const data = JSON.parse(r.out);
  assert.strictEqual(data.results.length, 1);
  assert.strictEqual(data.results[0].path, 'C:\\Users\\alice\\budget.txt');
  assert.strictEqual(data.results[0].kind, 'recycle bin');
});

test('show prints the content; a binary file needs --binary', () => {
  const f = fixtures();
  const id = JSON.parse(cli(['find', 'budget', '--json'], f).out).results[0].id;
  const r = cli(['show', 'budget', id.slice(0, 5)], f);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, 'numbers\n');
  const png = JSON.parse(cli(['find', 'chart', '--json'], f).out).results[0].id;
  const refused = cli(['show', 'chart', png], f);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /binary/);
});

test('restore writes under --to; the sources are left exactly as they were', () => {
  const f = fixtures();
  const before = snapshot(path.join(f.root, 'sources'));
  const id = JSON.parse(cli(['find', 'budget', '--json'], f).out).results[0].id;
  const out = path.join(f.root, 'recovered');
  const r = cli(['restore', 'budget', id, '--to', out], f);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(fs.readFileSync(path.join(out, 'budget.txt'), 'utf8'), 'numbers');
  assert.deepStrictEqual(snapshot(path.join(f.root, 'sources')), before);
});

test('restore refuses to write into a searched location', () => {
  const f = fixtures();
  const id = JSON.parse(cli(['find', 'budget', '--json'], f).out).results[0].id;
  const r = cli(['restore', 'budget', id, '--to', path.join(f.recycle, 'x')], f);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /Refusing to write inside/);
  assert.ok(!fs.existsSync(path.join(f.recycle, 'x')));
});

test('usage mistakes exit 2', () => {
  const f = fixtures();
  assert.strictEqual(cli(['find', 'x', '--bogus'], f).code, 2);
  assert.strictEqual(cli(['restore', 'budget', 'abc'], f).code, 2, 'restore without --to');
  assert.strictEqual(cli(['frobnicate'], f).code, 2);
  assert.strictEqual(cli(['find', 'x', '--since', 'someday'], f).code, 2);
});

test('an unknown ID is an error, not a guess', () => {
  const f = fixtures();
  const r = cli(['show', 'budget', 'ffffffff'], f);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /No copy has the ID/);
});

test('--help and --version', () => {
  const f = fixtures();
  const help = cli(['--help'], f).out;
  assert.match(help, /solarljos find <name>/);
  assert.ok(help.includes('notepad=D:\\old\\Users\\me'), 'the examples keep their backslashes');
  assert.ok(help.includes('trash=E:\\   git=D:\\code'));
  assert.match(cli(['--version'], f).out, /^\d+\.\d+\.\d+/);
});

test('a --location for a source that does not exist is a usage error, whatever its name', () => {
  const f = fixtures();
  for (const id of ['jetbrain', 'VSS', 'recycle-bin', 'constructor', '__proto__', 'toString']) {
    const r = cli(['find', 'budget', '--location', `${id}=D:\\old`], f);
    assert.strictEqual(r.code, 2, id);
    assert.match(r.err, new RegExp(`^Unknown source in --location: ${id}\\. Known: recycle, .*, vss, repos$`, 'm'), id);
  }
  const empty = cli(['find', 'budget', '--location', 'notepad='], f);
  assert.strictEqual(empty.code, 2);
  assert.match(empty.err, /Give a place after notepad= in --location/);
});

test('--since with a date alone means midnight where the user is, as the times shown are local', () => {
  const f = fixtures();
  const bin = path.join(f.recycle, 'S-1-5-21-9-9-9-1001');
  // Seoul is UTC+9 all year: 03:00 on 1 September there is 18:00 UTC on 31 August.
  write(path.join(bin, '$IEARLY1.txt'), infoV2('C:\\Users\\alice\\early.txt', 1, Date.UTC(2026, 7, 31, 18)));
  write(path.join(bin, '$REARLY1.txt'), 'e');
  write(path.join(bin, '$ILATE01.txt'), infoV2('C:\\Users\\alice\\the-day-before.txt', 1, Date.UTC(2026, 7, 31, 14)));
  write(path.join(bin, '$RLATE01.txt'), 'l');
  const r = cli(['find', '*.txt', '--since', '2026-09-01', '--json'], f, { TZ: 'Asia/Seoul' });
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(JSON.parse(r.out).results.map((c) => c.path).sort(),
    ['C:\\Users\\alice\\budget.txt', 'C:\\Users\\alice\\early.txt']);
  assert.strictEqual(cli(['find', 'x', '--since', '2026-02-30'], f).code, 2, 'a day that does not exist');
  const { parseSince } = require('../src/cli')._internal;
  assert.strictEqual(parseSince('2026-09-01'), new Date(2026, 8, 1).getTime());
  assert.strictEqual(parseSince('2026-09'), new Date(2026, 8, 1).getTime());
  assert.strictEqual(parseSince('2026-09-01T00:00:00Z'), Date.UTC(2026, 8, 1), 'a zone given is kept');
});

test('arguments are quoted for the shells of the system they are shown on', () => {
  const win = (s) => fmt.arg(s, 'win32');
  assert.strictEqual(win('trash=E:\\'), 'trash=E:\\', 'bare, so no quote can follow the backslash');
  assert.strictEqual(win('vss=\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy5=C:\\'),
    'vss=\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy5=C:\\');
  assert.strictEqual(win('D:\\My Files\\'), '"D:\\My Files\\\\"');
  assert.strictEqual(win('say "hi\\"'), '"say \\"hi\\\\\\""');
  assert.strictEqual(win('E:\\$Recycle.Bin'), "'E:\\$Recycle.Bin'", 'PowerShell would expand $Recycle');
  assert.strictEqual(win("it's $5"), "'it''s $5'");
  const posix = (s) => fmt.arg(s, 'linux');
  assert.strictEqual(posix('trash=/mnt/e'), 'trash=/mnt/e');
  assert.strictEqual(posix('C:\\a'), "'C:\\a'");
  assert.strictEqual(posix('/mnt/e/$Recycle.Bin'), "'/mnt/e/$Recycle.Bin'");
  assert.strictEqual(posix("it's"), "'it'\\''s'");
});

test('quoted arguments reach the program as given, through this system\'s shell', () => {
  const root = workDir('cli-args');
  dirs.push(root);
  const echo = write(path.join(root, 'echo.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const values = ['trash=E:\\', 'D:\\My Files\\', 'next', 'a b', '*.docx', 'x,y', '/home/a b/', "it's", 'say "hi"'];
  // PowerShell takes $ in single quotes, and cmd, which spawn uses on Windows, does not.
  if (process.platform !== 'win32') values.push('/mnt/e/$Recycle.Bin', 'back\\slash', '~/x');
  const line = [process.execPath, echo, ...values].map((v) => fmt.arg(v)).join(' ');
  const r = spawnSync(line, { shell: true, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), values);
});

test('a mistyped --location is refused before a search is announced', () => {
  const f = fixtures();
  const r = cli(['find', 'budget', '--location', 'nosuch=' + f.root], f);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /Unknown source in --location: nosuch/);
  assert.doesNotMatch(r.err, /Searching/);
});

test('--type finds files of those types, with no name needed, and --json says what each copy is', () => {
  const f = fixtures();
  const json = JSON.parse(cli(['find', '--type', 'image', '--json'], f).out);
  assert.deepStrictEqual(json.results.map((c) => c.path), ['C:\\Users\\alice\\chart.png'], 'by its name, whatever its bytes');
  const c = json.results[0];
  assert.deepStrictEqual([c.mediaType, c.tier, c.derived, c.unverified, c.width, c.height], ['image', 0, false, false, null, null]);
  assert.deepStrictEqual(JSON.parse(cli(['find', 'budget', '--json'], f).out).results[0].mediaType, 'text');
  const r = cli(['find', '--type', 'photos,documents'], f);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.err, /Searching for any file of type image, document\.\.\./);
  // Quoted on Windows, where PowerShell would take a,b for a list.
  assert.match(r.out, /solarljos restore --type ("photos,documents"|photos,documents) .*<id> --to <folder>/, 'the follow-up repeats the types');
  assert.strictEqual(cli(['find', 'budget', '--type', 'image'], f).code, 1);
});

test('a copy found by type alone is shown and restored by its ID', () => {
  const f = fixtures();
  const id = JSON.parse(cli(['find', '--type', 'text', '--json'], f).out).results[0].id;
  assert.strictEqual(cli(['show', id, '--type', 'text'], f).out, 'numbers\n');
  const out = path.join(f.root, 'recovered');
  const r = cli(['restore', id, '--type', 'text', '--to', out], f);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(fs.readFileSync(path.join(out, 'budget.txt'), 'utf8'), 'numbers');
});

test('a type that does not exist is a usage error, refused before a search is announced', () => {
  const f = fixtures();
  const r = cli(['find', 'x', '--type', 'image,sheets'], f);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /^Unknown type: sheets\. Known: image, video, audio, document, archive, text$/m);
  assert.doesNotMatch(r.err, /Searching/);
  assert.strictEqual(cli(['find'], f).code, 2, 'nothing to go on at all');
});

test('the list says what a copy is when it is not simply the file, and --since says what it kept undated', () => {
  const { kindLabel, shownPath } = require('../src/cli')._internal;
  assert.strictEqual(kindLabel({ kind: 'thumbnail', copies: 1 }), 'thumbnail (smaller copy)');
  assert.strictEqual(kindLabel({ kind: 'carved', copies: 2 }), 'carved (may be incomplete) x2');
  assert.strictEqual(kindLabel({ kind: 'fat undelete', unverified: true, copies: 1 }), 'fat undelete (may be incomplete)');
  assert.strictEqual(kindLabel({ kind: 'claude, before an edit', draft: true, copies: 1 }), 'claude, before an edit (never saved)');
  assert.strictEqual(kindLabel({ kind: 'unsaved editor buffer', draft: true, copies: 1 }), 'unsaved editor buffer');
  assert.strictEqual(kindLabel({ kind: 'recycle bin', copies: 1 }), 'recycle bin');
  assert.strictEqual(shownPath({ path: null, ext: '.jpg', width: 256, height: 192 }), '(name unknown, a .jpg file)  256x192');
  assert.strictEqual(shownPath({ path: null }), '(name unknown)');
  assert.strictEqual(shownPath({ path: 'C:\\a.jpg', width: 1, height: 2 }), 'C:\\a.jpg  1x2');

  const f = fixtures();
  const bin = path.join(f.recycle, 'S-1-5-21-9-9-9-1001');
  write(path.join(bin, '$IUNDATE.txt'), infoV2('C:\\Users\\alice\\undated.txt', 1, -11644473600000));
  write(path.join(bin, '$RUNDATE.txt'), 'u');
  const r = cli(['find', '*.txt', '--since', '2026-09-01'], f);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /! 1 copy\(ies\) carry no date; they were kept/);
  assert.match(r.out, /undated\.txt/);
});

/**
 * Runs main() in a child with a stand-in GUI server, which says where it is as the real one
 * does, and says what it was started with.
 */
function gui(argv, { sea = false } = {}) {
  const root = workDir('cli-gui');
  dirs.push(root);
  const script = write(path.join(root, 'run.js'), `
    const { main } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'cli.js'))});
    const calls = [];
    const server = { start: async (o) => {
      calls.push(o);
      process.stdout.write('stand-in running at http://127.0.0.1:5555/?k=token\\n');
      return { url: 'http://127.0.0.1:5555/?k=token', close: async () => {} };
    } };
    main(${JSON.stringify(argv)}, { gui: () => server, isSea: () => ${sea} }).then((code) => {
      const loaded = Object.keys(require.cache).some((k) => /[\\\\/]gui[\\\\/]/.test(k));
      process.stderr.write('\\n' + JSON.stringify({ code, calls, loaded }) + '\\n');
    });
  `);
  const r = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  const lines = r.stderr.trim().split('\n');
  return { ...JSON.parse(lines[lines.length - 1]), out: r.stdout, err: r.stderr };
}

test('gui starts the server on 127.0.0.1, with no window for --no-open, and leaves the telling to it', () => {
  const quiet = gui(['gui', '--no-open', '--port', '0']);
  assert.strictEqual(quiet.code, 0, quiet.err);
  assert.deepStrictEqual(quiet.calls, [{ port: 0, open: false, host: '127.0.0.1' }]);
  // The server prints the address, and how it stops; the command line adds nothing to it.
  assert.strictEqual(quiet.out, 'stand-in running at http://127.0.0.1:5555/?k=token\n');
  const shown = gui(['gui', '--port', '8123']);
  assert.deepStrictEqual(shown.calls, [{ port: 8123, open: true, host: '127.0.0.1' }]);
  assert.strictEqual(shown.out, 'stand-in running at http://127.0.0.1:5555/?k=token\n');
  for (const port of ['x', '70000', '-1', '1.5']) {
    const bad = gui(['gui', '--port', port]);
    assert.strictEqual(bad.code, 2, port);
    assert.deepStrictEqual(bad.calls, [], port);
  }
});

test('the single executable run with no arguments opens the GUI; anything else is the command line', () => {
  const clicked = gui([], { sea: true });
  assert.deepStrictEqual(clicked.calls, [{ port: 0, open: true, host: '127.0.0.1' }]);
  const plain = gui([], { sea: false });
  assert.deepStrictEqual(plain.calls, []);
  assert.match(plain.out, /solarljos gui +open the graphical front end/);
  const help = gui(['--help'], { sea: true });
  assert.deepStrictEqual(help.calls, []);
  assert.strictEqual(help.loaded, false, 'the server is not even loaded for the command line');
});

test('rebuild says what the sources noted, above all when nothing turned up', () => {
  const f = fixtures();
  // A folder with no Linux trash in it: the trash source says so.
  const r = cli(['rebuild', path.join(f.root, 'nothing-here'), '--dry-run', '--location', 'trash=' + f.root], f);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /! Trash \(Linux\): .+/);
  assert.match(r.out, /Nothing found below/);
  const json = JSON.parse(cli(['rebuild', path.join(f.root, 'nothing-here'), '--dry-run', '--json', '--location', 'trash=' + f.root], f).out);
  assert.ok(json.sources.find((s) => s.id === 'trash').notes.length >= 1);
});
