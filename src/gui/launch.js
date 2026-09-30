'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { t } = require('../i18n');

// Opens the graphical front end's page in a browser window: the one program Solarljos starts
// besides those its sources run to read, git and mountvol.exe (which lists the volumes' GUIDs for
// the thumbnail cache, and writes nothing). What each way writes, as read from Chromium's source
// and Microsoft's documents -- no browser was started to watch it:
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
//     When Edge is not installed, and always when Solarljos runs as administrator: a new
//     explorer.exe hands the address to the Explorer already running as the signed-in user and
//     exits, so the browser is not started elevated, as one started from here would be (the
//     usual behaviour of Explorer; not tried here, where Solarljos ran unelevated). The visit is
//     then an ordinary one in that browser's normal profile: the address with its token goes
//     into the history (and Visited Links, Top Sites, the session), the page's scripts into its
//     code cache, and the cookie into its cookie jar -- on disk too when the browser restores
//     sessions. The page and every copy shown are sent with Cache-Control: no-store, so they are
//     not kept in its disk cache.
//   macOS and Linux    open <address> / xdg-open <address>: the default browser, as above.
//   Nothing            with open: false the address is only printed, to be opened by hand.
//
// Ways not taken: rundll32 url.dll,FileProtocolHandler, which security tools flag as a way to
// start programs (LOLBAS T1218.011); PowerShell's Start-Process, since every start of PowerShell
// rewrites a file in the user's profile; a WebView2 window, which needs a native host and writes
// a <program>.WebView2 folder beside the program; and a throwaway Edge profile (--user-data-dir),
// which writes a whole new profile into the temporary folder.
//
// Windows itself notes that a program ran (Prefetch and the like), for this one as for any.

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
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
    const windows = env.SystemRoot || env.windir || 'C:\\Windows';
    return { how: 'explorer', command: path.win32.join(windows, 'explorer.exe'), args: [url] };
  }
  if (platform === 'darwin') return { how: 'open', command: 'open', args: [url] };
  return { how: 'xdg-open', command: 'xdg-open', args: [url] };
}

const SAID = {
  none: () => t(
    'Open that address in a browser on this computer. Solarljos stops a little after its page is closed, and when this window is closed or Ctrl+C is pressed here.'),
  edge: () => t(
    'It opened in an Edge InPrivate window, which keeps no history of it. Closing that window stops Solarljos, as does closing this one or pressing Ctrl+C here.'),
  browser: () => t(
    'It opened in your default browser, which keeps this visit in its history. Closing the page stops Solarljos, as does closing this window or pressing Ctrl+C here.'),
};

// How long to wait to hear whether the browser started. Node says one way or the other as soon as
// the system has tried; this is for a stand-in that never says.
const SPAWN_WAIT_MS = 5000;

/**
 * Opens the page and says how, on the console, once the system has said whether the browser
 * started: one that could not -- no xdg-open, an msedge.exe gone since it was found -- is said so,
 * with how to open the address by hand, and comes back as `how: 'none'`.
 * @param {string} url
 * @param {object} [o]
 * @param {boolean|'browser'} [o.open=true]  false: only print; 'browser': the default browser even where Edge is
 * @param {boolean} [o.elevated]   this process runs as administrator: the browser is started through Explorer
 * @param {function} [o.log]       prints one line
 * @param {function} [o.spawn]     child_process.spawn, or a stand-in
 * @returns {Promise<{ how: string, command: string|null, args: string[], error?: string }>}
 */
async function openWindow(url, o = {}) {
  const log = o.log || ((s) => process.stdout.write(s + '\n'));
  const plan = windowPlan(url, o);
  if (plan.how === 'none') {
    log(SAID.none());
    return plan;
  }
  if (o.elevated && (o.platform || process.platform) === 'win32') {
    log(t('Solarljos runs as administrator, so the page opens in your default browser as you, not in an Edge InPrivate window.'));
  }
  const cannot = (e) => {
    log(t('Could not open a window ({0}). Open the address above in a browser.', e.message));
    return { ...plan, how: 'none', error: e.message };
  };
  let child;
  try {
    // Detached, so that closing this console does not close the browser with it.
    child = (o.spawn || childProcess.spawn)(plan.command, plan.args, { detached: true, stdio: 'ignore' });
  } catch (e) {
    return cannot(e);
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
  if (failed) return cannot(failed);
  log(plan.how === 'edge' ? SAID.edge() : SAID.browser());
  return plan;
}

module.exports = { openWindow, windowPlan, findEdge };
