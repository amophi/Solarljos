'use strict';

const fs = require('fs');
const path = require('path');
const tty = require('tty');
const childProcess = require('child_process');
const { t } = require('../i18n');
const { fit } = require('../format');

// Opens the graphical front end's page in a browser window: the one program Solarljos starts
// besides those its sources run to read, git and mountvol.exe (which lists the volumes' GUIDs for
// the thumbnail cache, and writes nothing) -- and cmd.exe, for a console window of its own, when
// what Solarljos says could not be seen otherwise (below). What each way writes, as read from
// Chromium's source and Microsoft's documents -- no browser was started to watch it:
//
//   Edge, InPrivate, as an app window     msedge.exe --inprivate --app=<address>
//     A window with no address bar or tabs, in an InPrivate session, whose storage is kept in
//     memory ("not allowed to persist information on disk", Chromium's
//     storage_partition_config.h): the visit, the cookie the page trades its token for, and
//     whatever the page's scripts cache are not written to Edge's profile, and are gone when the
//     last InPrivate window closes. What Edge writes all the same: if it was not running, what
//     it writes on any start -- Local State, the profile's Preferences, Last Browser and Last
//     Version, BrowserMetrics, Crashpad, component updates, HKCU\Software\Microsoft\Edge\BLBeacon.
//     An InPrivate window belongs to the normal profile, which loads with its extensions, so
//     that profile's own housekeeping may run; Edge's cache can hold old pictures, which is why
//     the server reads the stores that change on their own (freeze) before this is called. If
//     InPrivate is turned off by policy (InPrivateModeAvailability), Edge opens a normal window
//     instead, which records the visit in its history. The address, token included, stands in
//     msedge.exe's command line, which programs running as the same user can read; the token
//     works once (server.js), so by the time anything reads it, the window has used it up.
//   The default browser, through Explorer   explorer.exe <address>
//     When Edge is not installed, or could not be started, and always when Solarljos runs as
//     administrator: a new explorer.exe hands the address to the Explorer already running as the
//     signed-in user and exits, so the browser is not started elevated, as one started from here
//     would be (the usual behaviour of Explorer; not tried here, where Solarljos ran unelevated).
//     The visit is then an ordinary one in that browser's normal profile: the address with its
//     token goes into the history (and Visited Links, Top Sites, the session), the page's scripts
//     into its code cache, and the cookie into its cookie jar -- on disk too when the browser
//     restores sessions. The page and every copy shown are sent with Cache-Control: no-store, so
//     they are not kept in its disk cache.
//   macOS and Linux    open <address> / xdg-open <address>: the default browser, as above.
//   Nothing            with open: false the address is only printed, to be opened by hand -- or,
//                      where nothing printed is seen, shown in a console window (below).
//
// Without a console
//   Solarljos.exe is a Windows GUI program (scripts/build-exe.js): a double-click opens no
//   console window, and Windows gives it no console even when it is started from one. What it
//   prints goes nowhere unless its output is sent to a file or a program, for Node puts the NUL
//   device in place of each standard handle a program was not given. Measured with Node 26.10,
//   on a copy of node.exe made a GUI program: started by cmd.exe's `start`, which, like a
//   double-click, hands it no handles, or from a console with nothing redirected, its fds 0 to 2
//   were all a character device that is no TTY, with the NUL device's st_rdev (0x150000) -- so
//   fs.fstatSync(1) does not throw -- and with `> file` or `| findstr` its fd 1 was that file or
//   that pipe. writesNowhere() tells them apart. As a GUI program, it says nothing of a console
//   to close or to press Ctrl+C in (hasConsole()); and when nothing it prints would be seen and
//   no browser could be started -- Edge that fails falls back to Explorer first -- or none was to
//   be (open: false), it shows the address in a console window of its own, the one way left to
//   tell it. cli.js shows the same way an error that stops it before its page opens, and what the
//   command line needs when Solarljos.exe is given arguments with nowhere to print.
//
//   A console window    cmd.exe /d /v:off /c start "Solarljos" "<System32>\cmd.exe" /d /v:on /s /k
//                       "echo(!SOLARLJOS_SAY1!&echo(!SOLARLJOS_SAY2!&..."
//     No text is on the command line, which is the same every time: each line is in an
//     environment variable, SOLARLJOS_SAY1 and on, which delayed expansion (/v:on) puts in after
//     cmd.exe has read the line's & | < > ^ ( ) and quotes, so no text can act as a command --
//     tried with each of those, % and ! too, and every one came out as it was; echo( prints a
//     line that starts with /? as well. Each line is also kept to one, with no control characters,
//     which could start a terminal's escape sequences; text from outside Solarljos, such as an
//     error's message, loses & | < > ^ % " besides (plain()); and an address is shown only when it
//     is the server's own: 127.0.0.1, a port, and a token in base64url (ADDRESS). The first
//     cmd.exe is detached, with no console, and its `start` opens the second in a console of its
//     own. Started directly, that one would be handed the NUL devices as its handles and end at
//     once; and as Solarljos's child it would be ended with it -- a child Node does not detach
//     was, when its parent exited, and a detached one was not -- where a window that tells of an
//     error must stay after Solarljos has exited. Tried from a copy of node.exe made a GUI
//     program, started with no handles and exiting 21 ms after the first cmd.exe started: the
//     program `start` ran had its new console for all three handles, and was still running 2.5 s
//     later. Neither cmd.exe writes anything: /d skips the AutoRun commands the registry may name,
//     echo and start write to no file, and what is typed at the prompt /k leaves stays in the
//     console's memory. The window itself is the system's console -- conhost, or Windows Terminal
//     where that is the default terminal, as on Windows 11, which keeps its own settings and state
//     as for any console window (not watched here). Run as administrator, the prompt left in it
//     is an administrator's too.
//
// Ways not taken: rundll32 url.dll,FileProtocolHandler, which security tools flag as a way to
// start programs (LOLBAS T1218.011); PowerShell's Start-Process, since every start of PowerShell
// rewrites a file in the user's profile; a WebView2 window, which needs a native host and writes
// a <program>.WebView2 folder beside the program; a throwaway Edge profile (--user-data-dir),
// which writes a whole new profile into the temporary folder; and, for a message, a file to show
// it from, which would be written.
//
// Windows itself notes that a program ran (Prefetch and the like), for this one as for any.

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

/** Whether this runs as the built program, Solarljos.exe, which is a Windows GUI program. */
function runsAsProgram() {
  try {
    const sea = require('node:sea');
    return typeof sea.isSea === 'function' && sea.isSea();
  } catch (_) {
    return false;
  }
}

/**
 * Whether what is written to `fd` goes nowhere: it has no handle, or a character device that is
 * no TTY -- the NUL device Node puts in place of a missing one, or a console this process is not
 * attached to (see the top of this file). A file, a pipe or its own console is somewhere.
 */
function writesNowhere(fd = 1) {
  try {
    return fs.fstatSync(fd).isCharacterDevice() && !tty.isatty(fd);
  } catch (_) {
    return true;
  }
}

/**
 * Whether this process has a console that closing, or Ctrl+C in it, stops: node.exe is a console
 * program, which on Windows always has one, its own or the one it was started from, and a
 * terminal is taken to be there elsewhere; Solarljos.exe, a GUI program, has none.
 */
function hasConsole(platform = process.platform, program = runsAsProgram()) {
  return !(platform === 'win32' && program);
}

/** msedge.exe where Edge installs itself: for every user, or for one. */
function findEdge(env = process.env, exists = isFile) {
  for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA]) {
    if (!base) continue;
    const exe = path.win32.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (exists(exe)) return exe;
  }
  return null;
}

/** The default browser, through Explorer. */
function explorerPlan(url, env) {
  const windows = env.SystemRoot || env.windir || 'C:\\Windows';
  return { how: 'explorer', command: path.win32.join(windows, 'explorer.exe'), args: [url] };
}

/**
 * How the page would be opened, worked out without starting anything.
 * @param {string} url
 * @param {object} [o]   as for openWindow(), plus `platform`, `env` and `exists` to stand in for the machine's
 * @returns {{ how: 'edge'|'explorer'|'open'|'xdg-open'|'none', command: string|null, args: string[] }}
 */
function windowPlan(url, o = {}) {
  const platform = o.platform || process.platform;
  const env = o.env || process.env;
  if (o.open === false) return { how: 'none', command: null, args: [] };
  if (platform === 'win32') {
    const edge = o.open === 'browser' || o.elevated ? null : findEdge(env, o.exists || isFile);
    if (edge) return { how: 'edge', command: edge, args: ['--inprivate', `--app=${url}`] };
    return explorerPlan(url, env);
  }
  if (platform === 'darwin') return { how: 'open', command: 'open', args: [url] };
  return { how: 'xdg-open', command: 'xdg-open', args: [url] };
}

// How it stops, said with the console (`here`) only when there is one to close or press Ctrl+C in.
const SAID = {
  none: (here) => (here
    ? t('Open that address in a browser on this computer. Solarljos stops a little after its page is closed, and when this window is closed or Ctrl+C is pressed here.')
    : t('Open that address in a browser on this computer. Solarljos stops a little after its page is closed.')),
  edge: (here) => (here
    ? t('It opened in an Edge InPrivate window, which keeps no history of it. Closing that window stops Solarljos, as does closing this one or pressing Ctrl+C here.')
    : t('It opened in an Edge InPrivate window, which keeps no history of it. Closing that window stops Solarljos.')),
  browser: (here) => (here
    ? t('It opened in your default browser, which keeps this visit in its history. Closing the page stops Solarljos, as does closing this window or pressing Ctrl+C here.')
    : t('It opened in your default browser, which keeps this visit in its history. Closing the page stops Solarljos.')),
};

// How long to wait to hear whether a program started. Node says one way or the other as soon as
// the system has tried; this is for a stand-in that never says.
const SPAWN_WAIT_MS = 5000;

// The address as server.js makes it on 127.0.0.1: a port, and a token in base64url (32 bytes,
// 43 characters, there). A console window shows no other.
const ADDRESS = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/\?k=[A-Za-z0-9_-]{16,128}$/;

// What a console window shows at most: lines, and columns in each, cut between graphemes.
const MESSAGE_LINES = 24;
const MESSAGE_WIDTH = 2000;

/** Whether `url` is an address of the server's own (ADDRESS). */
function isAddress(url) {
  const m = ADDRESS.exec(String(url));
  return !!m && Number(m[1]) <= 65535;
}

/** One line of a console window: its control characters, line breaks among them, become spaces. */
function oneLine(s) {
  return fit(String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '), MESSAGE_WIDTH);
}

/**
 * Text from outside Solarljos, such as an error's message, as it may go into a console window:
 * one line, and none of the characters cmd.exe gives a meaning -- & | < > ^ % and ", which
 * becomes ' -- although the window never reads its text as a command (see the top of this file).
 */
function plain(s) {
  return oneLine(s).replace(/"/g, "'").replace(/[&|<>^%]/g, ' ');
}

/**
 * Starts a program detached, so that it outlives this process and a closed console, with none of
 * this one's handles, and waits until the system has said whether it started: the Error it gave,
 * or null.
 */
async function started(command, args, options, spawn = childProcess.spawn) {
  let child;
  try {
    child = spawn(command, args, { ...options, detached: true, stdio: 'ignore' });
  } catch (e) {
    return e;
  }
  const failed = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), SPAWN_WAIT_MS);
    if (timer.unref) timer.unref();
    const done = (e) => {
      clearTimeout(timer);
      resolve(e);
    };
    child.on('spawn', () => done(null));
    child.on('error', (e) => done(e));
  });
  if (typeof child.unref === 'function') child.unref();
  return failed;
}

/**
 * Shows lines in a console window of their own, on Windows (see the top of this file), and
 * resolves once the system has said whether cmd.exe started; the window outlives this process.
 * Never rejects.
 * @param {string[]} lines   Solarljos's own text; what comes from outside goes through plain() first
 * @param {object} [o]       `platform`, `env` and `spawn` to stand in for the machine's
 * @returns {Promise<{ shown: boolean, error?: string }>}
 */
async function messageWindow(lines, o = {}) {
  if ((o.platform || process.platform) !== 'win32') return { shown: false, error: 'no console window but on Windows' };
  const env = o.env || process.env;
  const cmd = path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'cmd.exe');
  // The one thing on the command line that is not always the same, so it must be a plain path.
  if (!/^[A-Za-z]:\\[\w .()\\-]+$/.test(cmd)) return { shown: false, error: `${cmd} is not a plain path` };
  // The variables it echoes are its own alone: Windows reads their names in any case.
  const said = Object.fromEntries(Object.entries(env).filter(([name]) => !/^SOLARLJOS_SAY\d+$/i.test(name)));
  const echo = [...lines].slice(0, MESSAGE_LINES).map((line, i) => {
    const text = oneLine(line);
    if (!text.trim()) return 'echo(';
    said[`SOLARLJOS_SAY${i + 1}`] = text;
    return `echo(!SOLARLJOS_SAY${i + 1}!`;
  });
  const command = `start "Solarljos" "${cmd}" /d /v:on /s /k "${echo.join('&')}"`;
  const failed = await started(cmd, ['/d', '/v:off', '/c', command], { windowsVerbatimArguments: true, env: said }, o.spawn);
  return failed ? { shown: false, error: failed.message } : { shown: true };
}

/** The address in a console window of its own, when it is the server's own (ADDRESS). */
async function showAddress(url, why, o) {
  if (!isAddress(url)) return { shown: false, error: 'not an address of the server' };
  return messageWindow([
    t('Solarljos is running at {0}', url),
    why,
    t('This window only shows the address: closing it does not stop Solarljos.'),
  ], o);
}

/**
 * Opens the page and says how, once the system has said whether the browser started. Edge that
 * cannot be started falls back to the default browser through Explorer; a browser that cannot be
 * -- no xdg-open, no Explorer either -- is said so, with how to open the address by hand, and
 * comes back as `how: 'none'`. When what `log` prints would not be seen (`o.seen`), the address
 * is then shown in a console window of its own, as it is with `open: false`: `addressShown`.
 * @param {string} url
 * @param {object} [o]
 * @param {boolean|'browser'} [o.open=true]  false: only print; 'browser': the default browser even where Edge is
 * @param {boolean} [o.elevated]   this process runs as administrator: the browser is started through Explorer
 * @param {function} [o.log]       prints one line
 * @param {boolean} [o.console]    whether there is a console to close or press Ctrl+C in; hasConsole() by default
 * @param {boolean} [o.seen]       whether what `log` prints is seen; by default, whether fd 1 goes anywhere
 * @param {function} [o.spawn]     child_process.spawn, or a stand-in
 * @returns {Promise<{ how: string, command: string|null, args: string[], error?: string, addressShown?: boolean }>}
 */
async function openWindow(url, o = {}) {
  const log = o.log || ((s) => process.stdout.write(s + '\n'));
  const platform = o.platform || process.platform;
  const here = o.console !== undefined ? !!o.console : hasConsole(platform);
  const seen = o.seen !== undefined ? !!o.seen : !writesNowhere(1);
  const plan = windowPlan(url, o);
  if (plan.how === 'none') {
    log(SAID.none(here));
    if (seen) return plan;
    return { ...plan, addressShown: (await showAddress(url, SAID.none(false), o)).shown };
  }
  if (o.elevated && platform === 'win32') {
    log(t('Solarljos runs as administrator, so the page opens in your default browser as you, not in an Edge InPrivate window.'));
  }
  let tried = plan;
  let failed = await started(plan.command, plan.args, {}, o.spawn);
  if (failed && plan.how === 'edge') {
    log(t('Could not start Edge ({0}), so the page opens in your default browser instead.', failed.message));
    tried = explorerPlan(url, o.env || process.env);
    failed = await started(tried.command, tried.args, {}, o.spawn);
  }
  if (failed) {
    log(t('Could not open a window ({0}). Open the address above in a browser.', failed.message));
    const none = { ...tried, how: 'none', error: failed.message };
    if (seen) return none;
    const why = t('Could not open a window ({0}). Open the address above in a browser.', plain(failed.message));
    return { ...none, addressShown: (await showAddress(url, why, o)).shown };
  }
  log(tried.how === 'edge' ? SAID.edge(here) : SAID.browser(here));
  return tried;
}

module.exports = { openWindow, windowPlan, findEdge, messageWindow, writesNowhere, hasConsole, plain, isAddress };
