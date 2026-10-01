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

/**
 * Runs main() in a child as Solarljos.exe would run it, with every way out of it a stand-in: the
 * GUI server (which fails with `fails`, a usage error when `usage`), whether it is the executable,
 * the system, the environment, which of fds 1 and 2 go nowhere (`nowhere`), the language t() is
 * set to, and the console window of its own (`tell`), which only records what it would show.
 */
function exe(argv, { sea = true, platform = 'win32', env = {}, nowhere = [], fails = null, usage = false } = {}) {
  const root = workDir('cli-exe');
  dirs.push(root);
  const i18n = JSON.stringify(path.join(__dirname, '..', 'src', 'i18n.js'));
  const script = write(path.join(root, 'run.js'), `
    const { main } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'cli.js'))});
    const i18n = require(${i18n});
    const calls = { start: [], tell: [], setLocale: [] };
    const server = { start: async (o) => {
      calls.start.push(o);
      if (${JSON.stringify(fails)}) throw Object.assign(new Error(${JSON.stringify(fails)}), { usage: ${usage} });
      return { url: 'http://127.0.0.1:5555/?k=token', close: async () => {} };
    } };
    main(${JSON.stringify(argv)}, {
      gui: () => server, isSea: () => ${sea}, platform: ${JSON.stringify(platform)}, env: ${JSON.stringify(env)},
      execPath: 'C:\\\\Users\\\\me\\\\Downloads\\\\Solarljos.exe',
      setLocale: (code) => { calls.setLocale.push(code); return i18n.setLocale(code); },
      writesNowhere: (fd) => ${JSON.stringify(nowhere)}.includes(fd),
      tell: async (lines) => { calls.tell.push(lines); return { shown: true }; },
    }).then((code) => process.stderr.write('\\n' + JSON.stringify({ code, calls }) + '\\n'));
  `);
  const r = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  const lines = r.stderr.trim().split('\n');
  return { ...JSON.parse(lines[lines.length - 1]), out: r.stdout, err: r.stderr };
}

test('--lang, or SOLARLJOS_LANG, sets the language, and gui passes it on; English is the default', () => {
  assert.deepStrictEqual(exe(['--version'], { sea: false }).calls.setLocale, [], 'nothing asked for: English, whatever the system says');
  assert.deepStrictEqual(exe(['--version', '--lang', 'ko'], { sea: false }).calls.setLocale, ['ko']);
  assert.deepStrictEqual(exe(['--version'], { sea: false, env: { SOLARLJOS_LANG: 'ja' } }).calls.setLocale, ['ja']);
  assert.deepStrictEqual(exe(['--version', '--lang=de'], { sea: false, env: { SOLARLJOS_LANG: 'ja' } }).calls.setLocale, ['de'],
    'the command line wins');
  // Read even when the rest does not parse, so that the complaint is in that language.
  const bad = exe(['find', '--bogus', '--lang', 'fr'], { sea: false });
  assert.deepStrictEqual([bad.code, bad.calls.setLocale], [2, ['fr']]);
  assert.strictEqual(exe(['--version', '--lang'], { sea: false }).code, 2, '--lang needs a code');

  const shown = exe(['gui', '--no-open', '--lang', 'ko'], { sea: false });
  assert.deepStrictEqual(shown.calls.start, [{ port: 0, open: false, host: '127.0.0.1', lang: 'ko' }]);
  const fromEnv = exe(['gui'], { sea: false, env: { SOLARLJOS_LANG: 'ja' } });
  assert.deepStrictEqual(fromEnv.calls.start, [{ port: 0, open: true, host: '127.0.0.1', lang: 'ja' }]);
  // Solarljos.exe with --lang alone is still a double-click: the GUI, in that language.
  const clicked = exe(['--lang', 'ko']);
  assert.deepStrictEqual(clicked.calls.start, [{ port: 0, open: true, host: '127.0.0.1', lang: 'ko' }]);
  assert.deepStrictEqual(exe(['--lang', 'ko'], { sea: false }).calls.start, [], 'the command line prints its help');

  // With the real catalogs: a language there is no complete translation into stays English, and says so.
  const f = fixtures();
  const xx = cli(['--version', '--lang', 'xx'], f);
  assert.deepStrictEqual([xx.code, xx.out.trim()], [0, pkg().version]);
  assert.match(xx.err, /no complete translation into xx, so it speaks English/);
  assert.match(cli(['--version'], f, { SOLARLJOS_LANG: 'xx-YY' }).err, /translation into xx-YY/);
  assert.strictEqual(cli(['--version', '--lang', 'en-GB'], f).err, '');
  const help = cli(['--help'], f).out;
  assert.match(help, /--lang <code> +the language to use/);
  assert.match(help, /en, ko, ja, zh-CN/);
});

const pkg = () => require('../package.json');

test('find lines its columns up by the columns the translated text takes', () => {
  const i18n = require('../src/i18n');
  const { displayWidth } = require('../src/format');
  const f = fixtures();
  for (const lang of ['ko', 'ja', 'th', 'hi']) {
    const r = cli(['find', '*', '--lang', lang], f);
    assert.strictEqual(r.code, 0, r.err);
    const lines = r.out.split('\n');
    // Each source's count ends at one column, however wide its translated label.
    const ends = [];
    for (const l of lines.slice(1)) {
      if (!l.trim()) break;
      const m = /^(.*?\S)( +)(\d+|-)(?=$| {3})/.exec(l);
      if (m) ends.push(displayWidth(m[0]));
    }
    assert.ok(ends.length >= 10, `${lang}: ${ends.length} sources`);
    assert.strictEqual(new Set(ends).size, 1, `${lang}: counts end at ${ends}`);
    // The table: the path starts at one column in every row, and the header's last cell with it.
    // (Whatever language the catalogs speak -- English, where one is not complete -- this holds.)
    let PATH;
    try {
      i18n.setLocale(lang);
      PATH = i18n.t('PATH');
    } finally {
      i18n.setLocale('en');
    }
    const first = lines.findIndex((l) => /^[0-9a-f]{8} /.test(l));
    const header = lines[first - 1];
    const rows = lines.slice(first).filter((l) => /^[0-9a-f]{8} /.test(l));
    assert.strictEqual(rows.length, 2, lang);
    const at = [displayWidth(header) - displayWidth(PATH), ...rows.map((l) => displayWidth(l.slice(0, l.indexOf('C:\\Users\\alice\\'))))];
    assert.strictEqual(new Set(at).size, 1, `${lang}: the path column starts at ${at}`);
  }
});

test('Solarljos.exe given arguments with nowhere to print says so in a console window, and does nothing', () => {
  const recycle = path.join(workDir('cli-nowhere'), 'no-such-bin');
  dirs.push(path.dirname(recycle));
  const where = ['--no-discover', '--recycle-dir', recycle];
  for (const argv of [['--version'], ['--help'], ['find', 'budget', ...where], ['find', '--bogus'], ['frobnicate']]) {
    const r = exe(argv, { nowhere: [1, 2] });
    assert.strictEqual(r.code, 2, argv.join(' '));
    assert.deepStrictEqual([r.out, r.calls.start], ['', []], argv.join(' '));
    assert.strictEqual(r.calls.tell.length, 1, argv.join(' '));
    const said = r.calls.tell[0].join('\n');
    assert.match(said, /^Solarljos\.exe was given arguments, which makes it the command line/);
    assert.match(said, /^ {2}Solarljos\.exe find budget \| more$/m);
    assert.match(said, /^ {2}Solarljos\.exe find budget > found\.txt 2>&1$/m);
    assert.match(said, /^ {2}node solarljos\.cjs find budget$/m);
  }
  // Its output sent to a file or a program: the command line, exactly as before.
  const piped = exe(['--version'], { nowhere: [2] });
  assert.deepStrictEqual([piped.code, piped.out, piped.calls.tell], [0, `${pkg().version}\n`, []]);
  // gui, with or without its name, needs nowhere to print: its page is its window.
  for (const argv of [[], ['gui'], ['gui', '--port', '8123'], ['--lang', 'ko']]) {
    const r = exe(argv, { nowhere: [1, 2] });
    assert.deepStrictEqual([r.code, r.calls.start.length, r.calls.tell], [0, 1, []], argv.join(' '));
  }
  // Only the Windows program, which has no console, does this.
  assert.deepStrictEqual(exe(['--version'], { nowhere: [1, 2], platform: 'linux' }).calls.tell, []);
  assert.deepStrictEqual(exe(['--version'], { nowhere: [1, 2], sea: false }).calls.tell, []);
});

test('an error that stops the GUI before its page opens is shown in a window where stderr goes nowhere', async () => {
  const failed = exe([], { nowhere: [1, 2], fails: 'Could not listen on 127.0.0.1 port 80: listen EACCES & "denied"' });
  assert.strictEqual(failed.code, 1);
  assert.deepStrictEqual(failed.calls.tell, [["Solarljos stopped with an error: Could not listen on 127.0.0.1 port 80: listen EACCES   'denied'"]]);
  const busy = exe(['gui', '--port', '8123'], { nowhere: [1, 2], fails: 'port 8123 is taken', usage: true });
  assert.deepStrictEqual([busy.code, busy.calls.tell.length], [2, 1]);
  const typo = exe(['gui', '--prot', '8123'], { nowhere: [1, 2] });
  assert.deepStrictEqual([typo.code, typo.calls.start], [2, []]);
  assert.match(typo.calls.tell[0][0], /^Solarljos stopped with an error: Unknown option '--prot'/);
  const port = exe(['gui', '--port', 'x'], { nowhere: [1, 2] });
  assert.deepStrictEqual([port.code, port.calls.tell], [2, [['Solarljos stopped with an error: Give --port as a number from 0 to 65535.']]]);
  // Where stderr is seen, it is printed there, as before, and no window opens.
  const seen = exe([], { nowhere: [1], fails: 'Could not listen' });
  assert.deepStrictEqual([seen.code, seen.calls.tell], [1, []]);
  assert.match(seen.err, /^Could not listen$/m);

  // bin/solarljos.js hands anything main() lets through to unseen() too.
  const { unseen } = require('../src/cli');
  const told = [];
  const tell = async (lines) => told.push(lines);
  await unseen('it broke\n  at "x" & y', { platform: 'win32', writesNowhere: () => true, tell });
  await unseen('seen', { platform: 'win32', writesNowhere: () => false, tell });
  await unseen('not Windows', { platform: 'linux', writesNowhere: () => true, tell });
  assert.deepStrictEqual(told, [["Solarljos stopped with an error: it broke   at 'x'   y"]]);
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

test('desktop starts the server for the Windows program, says where on stdout, and stops when its stdin closes', () => {
  const root = workDir('cli-desktop');
  dirs.push(root);
  const script = write(path.join(root, 'run.js'), `
    const { main } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'cli.js'))});
    const calls = [];
    const server = { start: async (o) => {
      calls.push({ ...o, log: typeof o.log });
      // What the server says goes to stderr, keeping stdout for the one line the program reads.
      o.log('the server speaks');
      return { port: 5555, key: 'the-key', stop: (why) => process.stderr.write('stopped: ' + why + '\\n') };
    } };
    main(['desktop', '--lang', 'en'], { gui: () => server, isSea: () => true })
      .then((code) => process.stderr.write(JSON.stringify({ code, calls }) + '\\n'));
  `);
  const r = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', input: '' });
  const line = r.stderr.split('\n').find((l) => l.startsWith('{'));
  assert.ok(line, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  const told = JSON.parse(line);
  assert.strictEqual(told.code, 0, r.stderr);
  assert.deepStrictEqual(told.calls, [{ desktop: true, open: false, host: '127.0.0.1', log: 'function', lang: 'en' }]);
  const version = require('../package.json').version;
  assert.deepStrictEqual(r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)), [{ solarljos: version, port: 5555, key: 'the-key' }]);
  assert.match(r.stderr, /the server speaks/);
  // stdin closed at once here, as it does when the program that started it ends.
  assert.match(r.stderr, /stopped: its window was closed/);
});
