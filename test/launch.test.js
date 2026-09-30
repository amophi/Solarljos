'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { workDir, cleanup } = require('./helpers');
const { openWindow, messageWindow, writesNowhere, hasConsole, plain, isAddress } = require('../src/gui/launch');

// How the front end's window is opened when Solarljos.exe, a Windows GUI program, has no console:
// Edge falling back to Explorer, the words chosen with and without a console, and the console
// window of its own that shows the address, or an error, when nothing printed would be seen.
// Every program is a stand-in here, which starts nothing, but for one test on Windows that runs
// cmd.exe with the very command line a window would get, in this process's own hidden console
// (start /b) and with /c for /k, so that no window opens.

const win = process.platform === 'win32';
const dirs = [];
after(() => dirs.forEach(cleanup));

const URL = 'http://127.0.0.1:54321/?k=Ab3_-xYzAb3_-xYzAb3_-xYzAb3_-xYzAb3_-xYzAb3';
const ENV = {
  'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\U\\AppData\\Local', SystemRoot: 'C:\\WINDOWS',
};
const EDGE = 'C:\\PF\\Microsoft\\Edge\\Application\\msedge.exe';
const CMD = 'C:\\WINDOWS\\System32\\cmd.exe';

/**
 * child_process.spawn as a stand-in: each call is kept, and the child says soon after that it
 * started, or fails as `fails(command)` says -- an Error to emit, or 'throw' to throw one.
 */
function spawner(fails = () => null) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const how = fails(command);
    if (how === 'throw') throw Object.assign(new Error(`spawn ${command} EACCES`), { code: 'EACCES' });
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => (how ? child.emit('error', how) : child.emit('spawn')));
    return child;
  };
  return { spawn, calls };
}

/** openWindow() on a made-up Windows machine with Edge installed; what it said, and what it started. */
async function open(o = {}) {
  const lines = [];
  const s = spawner(o.fails);
  const plan = await openWindow(o.url || URL, {
    platform: 'win32', env: ENV, exists: (p) => p === EDGE, log: (x) => lines.push(x), spawn: s.spawn, ...o,
  });
  return { plan, lines, calls: s.calls };
}

/** What a console window would show: its lines, from the variables its command line echoes. */
function shown(call) {
  const echoed = /\/k "(.*)"$/.exec(call.args[3])[1].split('&');
  return echoed.map((e) => (e === 'echo(' ? '' : call.options.env[/^echo\(!(SOLARLJOS_SAY\d+)!$/.exec(e)[1]]));
}

test('tells where output goes nowhere: no handle, or the NUL device Node puts in place of one', () => {
  const dir = workDir('launch');
  dirs.push(dir);
  const file = fs.openSync(path.join(dir, 'out.txt'), 'w');
  const nul = fs.openSync(win ? '\\\\.\\NUL' : '/dev/null', 'r+');
  try {
    assert.strictEqual(writesNowhere(file), false, 'a file');
    assert.strictEqual(writesNowhere(nul), true, 'the NUL device');
    assert.strictEqual(writesNowhere(987654), true, 'no handle at all');
  } finally {
    fs.closeSync(file);
    fs.closeSync(nul);
  }
  assert.strictEqual(hasConsole('win32', true), false, 'Solarljos.exe, a GUI program, has none');
  assert.strictEqual(hasConsole('win32', false), true, 'node.exe, a console program, has one');
  assert.strictEqual(hasConsole('linux', true), true);
});

test('shows only an address of the server\'s own, and outside text without what cmd.exe reads', () => {
  assert.strictEqual(isAddress(URL), true);
  assert.strictEqual(isAddress('http://127.0.0.1:65535/?k=AAAAAAAAAAAAAAAA'), true);
  for (const bad of [
    'http://127.0.0.1:0/?k=AAAAAAAAAAAAAAAA', 'http://127.0.0.1:65536/?k=AAAAAAAAAAAAAAAA', 'http://127.0.0.1:080/?k=AAAAAAAAAAAAAAAA',
    'http://localhost:5000/?k=AAAAAAAAAAAAAAAA', 'http://[::1]:5000/?k=AAAAAAAAAAAAAAAA', 'http://127.0.0.2:5000/?k=AAAAAAAAAAAAAAAA',
    'https://127.0.0.1:5000/?k=AAAAAAAAAAAAAAAA', 'http://127.0.0.1:5000/x?k=AAAAAAAAAAAAAAAA', 'http://127.0.0.1:5000/?k=AAAA',
    `${URL}&x=1`, `${URL}"`, `${URL}%PATH%`, `${URL}\n`, `${URL} & calc`, 'http://127.0.0.1:5000/?k=AAAAAAAAAAAAAAA=', '', null,
  ]) {
    assert.strictEqual(isAddress(bad), false, String(bad));
  }
  assert.strictEqual(plain('a & b | c < d > e ^ f % g "h"'), "a   b   c   d   e   f   g 'h'");
  assert.strictEqual(plain('one\r\ntwo\tthree\u001b[31m\u009bx'), 'one  two three [31m x');
  assert.strictEqual(plain('포트 8080을 쓸 수 없습니다: EADDRINUSE (127.0.0.1)'), '포트 8080을 쓸 수 없습니다: EADDRINUSE (127.0.0.1)');
});

test('a console window gets its lines in variables, and a command line that is always the same', async () => {
  const nasty = 'x & del *.* | more < in > out ^ %PATH% !PATH! "quoted" (paren /?';
  const s = spawner();
  const r = await messageWindow(['first line', '', `second\nline\u001b]52;c;x\u0007`, nasty], { platform: 'win32', env: ENV, spawn: s.spawn });
  assert.deepStrictEqual(r, { shown: true });
  assert.strictEqual(s.calls.length, 1);
  const [call] = s.calls;
  assert.strictEqual(call.command, CMD);
  assert.deepStrictEqual(call.args, ['/d', '/v:off', '/c',
    `start "Solarljos" "${CMD}" /d /v:on /s /k "echo(!SOLARLJOS_SAY1!&echo(&echo(!SOLARLJOS_SAY3!&echo(!SOLARLJOS_SAY4!"`]);
  assert.deepStrictEqual([call.options.detached, call.options.stdio, call.options.windowsVerbatimArguments], [true, 'ignore', true]);
  assert.strictEqual(call.options.windowsHide, undefined, 'not hidden: start would hide the window it opens');
  assert.deepStrictEqual(shown(call), ['first line', '', 'second line ]52;c;x ', nasty]);
  assert.strictEqual(call.options.env.SystemRoot, 'C:\\WINDOWS', 'the rest of the environment goes along');

  // No text reaches the command line, however it is written; and no variable of that name but its
  // own reaches the window, in whatever case the environment had one.
  const other = spawner();
  await messageWindow([nasty.repeat(3)], { platform: 'win32', env: { ...ENV, solarljos_say1: 'left over', SOLARLJOS_SAY2: 'x' }, spawn: other.spawn });
  assert.strictEqual(other.calls[0].args[3], `start "Solarljos" "${CMD}" /d /v:on /s /k "echo(!SOLARLJOS_SAY1!"`);
  assert.deepStrictEqual(Object.keys(other.calls[0].options.env).filter((k) => /say/i.test(k)), ['SOLARLJOS_SAY1']);

  // At most 24 lines, each at most 2000 characters.
  const many = spawner();
  await messageWindow(Array.from({ length: 30 }, (_, i) => `line ${i + 1} `.padEnd(3000, 'x')), { platform: 'win32', env: ENV, spawn: many.spawn });
  const lines = shown(many.calls[0]);
  assert.deepStrictEqual([lines.length, lines[23].length, lines[23].slice(0, 8)], [24, 2000, 'line 24 ']);
  // Counted in columns, and cut between graphemes: whole syllables, whole emoji.
  const wide = spawner();
  await messageWindow(['휴'.repeat(1500), `${'x'.repeat(1999)}👩\u200d💻`], { platform: 'win32', env: ENV, spawn: wide.spawn });
  assert.deepStrictEqual(shown(wide.calls[0]), ['휴'.repeat(1000), 'x'.repeat(1999)]);
});

test('a console window is not opened where it cannot be', async () => {
  const s = spawner();
  assert.strictEqual((await messageWindow(['x'], { platform: 'linux', env: ENV, spawn: s.spawn })).shown, false);
  const odd = await messageWindow(['x'], { platform: 'win32', env: { SystemRoot: 'C:\\W" & calc & "' }, spawn: s.spawn });
  assert.deepStrictEqual([odd.shown, /not a plain path/.test(odd.error)], [false, true], 'a system folder that is no plain path');
  assert.strictEqual(s.calls.length, 0);
  const thrown = await messageWindow(['x'], { platform: 'win32', env: ENV, spawn: spawner(() => 'throw').spawn });
  assert.deepStrictEqual(thrown, { shown: false, error: `spawn ${CMD} EACCES` });
  const failed = await messageWindow(['x'], { platform: 'win32', env: ENV, spawn: spawner(() => new Error('ENOENT')).spawn });
  assert.deepStrictEqual(failed, { shown: false, error: 'ENOENT' });
});

test('Edge that cannot be started falls back to the default browser through Explorer', async () => {
  const r = await open({ fails: (c) => (c === EDGE ? new Error('spawn msedge.exe EPERM') : null) });
  assert.deepStrictEqual(r.calls.map((c) => [c.command, c.args]), [
    [EDGE, ['--inprivate', `--app=${URL}`]], ['C:\\WINDOWS\\explorer.exe', [URL]],
  ]);
  assert.deepStrictEqual([r.plan.how, r.plan.command], ['explorer', 'C:\\WINDOWS\\explorer.exe']);
  assert.match(r.lines[0], /Could not start Edge \(spawn msedge\.exe EPERM\), so the page opens in your default browser instead/);
  assert.match(r.lines[1], /It opened in your default browser/);
  const thrown = await open({ fails: (c) => (c === EDGE ? 'throw' : null) });
  assert.strictEqual(thrown.plan.how, 'explorer');
});

test('says there is a console to close or press Ctrl+C in only when there is one', async () => {
  const attached = await open({ console: true, seen: true });
  assert.match(attached.lines.join('\n'), /InPrivate window.*as does closing this one or pressing Ctrl\+C here/);
  const none = await open({ console: false, seen: true });
  assert.deepStrictEqual(none.lines, ['It opened in an Edge InPrivate window, which keeps no history of it. Closing that window stops Solarljos.']);
  const browser = await open({ console: false, seen: true, open: 'browser' });
  assert.deepStrictEqual(browser.lines, ['It opened in your default browser, which keeps this visit in its history. Closing the page stops Solarljos.']);
  const address = await open({ console: false, seen: true, open: false });
  assert.deepStrictEqual(address.lines, ['Open that address in a browser on this computer. Solarljos stops a little after its page is closed.']);
  assert.strictEqual(address.calls.length, 0, 'what is printed is seen: no window');
  for (const r of [none, browser, address]) assert.doesNotMatch(r.lines.join('\n'), /Ctrl\+C|this window/);
});

test('with nothing printed seen, the address is shown in a console window, and only once no browser could start', async () => {
  // A browser started: no console window, whatever is seen.
  const fine = await open({ console: false, seen: false });
  assert.deepStrictEqual(fine.calls.map((c) => c.command), [EDGE]);
  assert.strictEqual(fine.plan.addressShown, undefined);

  // Neither Edge nor Explorer: the address, in a window of its own.
  const neither = await open({ console: false, seen: false, fails: (c) => (c === CMD ? null : new Error(`spawn ${c} "EACCES" & more`)) });
  assert.deepStrictEqual(neither.calls.map((c) => c.command), [EDGE, 'C:\\WINDOWS\\explorer.exe', CMD]);
  assert.deepStrictEqual([neither.plan.how, neither.plan.addressShown], ['none', true]);
  assert.strictEqual(neither.plan.error, 'spawn C:\\WINDOWS\\explorer.exe "EACCES" & more');
  assert.deepStrictEqual(shown(neither.calls[2]), [
    `Solarljos is running at ${URL}`,
    "Could not open a window (spawn C:\\WINDOWS\\explorer.exe 'EACCES'   more). Open the address above in a browser.",
    'This window only shows the address: closing it does not stop Solarljos.',
  ]);
  assert.strictEqual(neither.calls[2].options.detached, true);

  // Seen: said so as it always was, and no window.
  const printed = await open({ console: true, seen: true, fails: (c) => new Error(`spawn ${c} ENOENT`) });
  assert.deepStrictEqual([printed.plan.how, printed.calls.length], ['none', 2]);
  assert.match(printed.lines.join('\n'), /Could not open a window \(spawn C:\\WINDOWS\\explorer\.exe ENOENT\)/);

  // --no-open: no browser at all, so the window is the one way to tell the address.
  const quiet = await open({ console: false, seen: false, open: false });
  assert.deepStrictEqual(quiet.calls.map((c) => c.command), [CMD]);
  assert.deepStrictEqual(shown(quiet.calls[0]), [
    `Solarljos is running at ${URL}`,
    'Open that address in a browser on this computer. Solarljos stops a little after its page is closed.',
    'This window only shows the address: closing it does not stop Solarljos.',
  ]);

  // An address that is not the server's own is never shown; nor is anything shown off Windows.
  for (const url of ['http://127.0.0.1:5000/?k=abc', `${URL}&x=%PATH%`]) {
    const odd = await open({ url, console: false, seen: false, open: false });
    assert.deepStrictEqual([odd.calls.length, odd.plan.addressShown], [0, false], url);
  }
  const linux = await open({ platform: 'linux', console: false, seen: false, fails: () => new Error('spawn xdg-open ENOENT') });
  assert.deepStrictEqual([linux.plan.how, linux.plan.addressShown, linux.calls.map((c) => c.command)], ['none', false, ['xdg-open']]);
});

test('cmd.exe echoes the lines as they are, reading none of them as a command', { skip: !win && 'cmd.exe is on Windows only' }, async () => {
  // The lines are ASCII: through a pipe cmd.exe writes the ANSI code page, where a console window
  // gets Unicode.
  const lines = [
    `Solarljos is running at ${URL}`,
    'x & echo INJECTED | more < in > out ^ %PATH% !PATH! %% ^^ "quoted" \'single\'',
    '/? at the start, ) and ( unbalanced (',
    '',
    'the end!',
  ];
  const s = spawner();
  await messageWindow(lines, { platform: 'win32', spawn: s.spawn });
  const [call] = s.calls;
  // The same command line, but in this console (start /b) and ending when done (/c for /k).
  const command = call.args[3].replace(/^start "Solarljos" /, 'start "Solarljos" /b ').replace(/ \/s \/k "/, ' /s /c "');
  assert.notStrictEqual(command, call.args[3]);
  const r = spawnSync(call.command, [...call.args.slice(0, 3), command], {
    windowsVerbatimArguments: true, env: call.options.env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(r.stdout.split('\r\n'), [...lines, '']);
});
