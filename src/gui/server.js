'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { t } = require('../i18n');
const launch = require('./launch');

// The graphical front end's web server: one page (src/gui/ui), for a browser window on this
// computer, on node:http alone. Everything it shows comes through the library's API (../index.js).
// It keeps nothing on disk -- results live in this process's memory until it stops -- and writes
// nothing but what restoreCopy() and rebuildFolder() write, under the folder the user typed. The
// programs it starts are the browser window (launch.js) and, as the command line does, what the
// library's sources run while they search, all of which only read: git, to read repositories,
// and mountvol.exe, which lists the volumes' GUIDs for a search of the thumbnail cache and writes
// nothing. Not Explorer to show a restored file, which would make thumbnails of it in the very
// cache a search for photos reads, nor reg.exe or PowerShell to ask where the user's folders are.
//
// Who can reach it
//   It listens on 127.0.0.1 only, on a port the system picks, so nothing on the network sees it.
//   Each run makes a random token and opens http://127.0.0.1:<port>/?k=<token>. The page trades
//   the token for a cookie -- HttpOnly, so no script reads it; SameSite=Strict, so another
//   site's page does not send it -- and is sent on to / at once, so the token leaves the address
//   bar. The token works once: the address stands in the browser's command line, which other
//   programs of the same user can read (on Linux, other users too, through /proc), and in its
//   history, so after the window has traded it nothing else can. A reload keeps working through
//   the cookie; a second window needs Solarljos started again. A browser shares cookies between
//   all ports of a host, so the cookie's name carries the port: two runs side by side keep apart.
//   Every request is checked, in this order, before anything else about it is read:
//     Host            exactly 127.0.0.1:<port>, else 403. A page that points its own name at
//                     127.0.0.1 (DNS rebinding) arrives with its own name in Host.
//     Sec-Fetch-Site  when sent, same-origin or none (a window opened on the address), else 403.
//                     Another port of 127.0.0.1 is the same site but not the same origin.
//     Origin          when sent, exactly this origin, else 403; a POST must send it. "null", which
//                     a page under a no-referrer policy sends for a beacon, is taken only from a
//                     request the browser marks same-origin, which no other page can make.
//     method          GET, HEAD or POST, else 405. OPTIONS included: no Access-Control-* header
//                     is ever sent, so no other origin may read a reply or send a header
//     cookie          the one this run gave out, else 403
//     X-Solarljos: 1  on a POST, but the goodbye beacon (which cannot send one), else 403
//     POST body       application/json (415 otherwise), which a form on another site cannot send
//   Every reply has Cache-Control: no-store -- the browser's disk cache may itself hold the old
//   pictures a search looks for -- and nosniff, X-Frame-Options DENY, Cross-Origin-Resource-Policy
//   and Cross-Origin-Opener-Policy same-origin, and Referrer-Policy same-origin. Not no-referrer:
//   under that policy the Fetch standard has a beacon, or a form, carry "Origin: null".
//   The page itself runs under PAGE_CSP: its own scripts and styles, nothing inline, and Trusted
//   Types with no policy at all, so that nothing it is sent -- a file name can hold markup -- can
//   ever be parsed as HTML or run, whatever a later change to the page does.
//
// A copy's bytes (GET /api/copy/<uid>)
//   The type is never taken from a name. The first 4 KB go through the library's sniff(), and
//   only pictures and videos a browser shows by itself (PREVIEW) go out as that type, inline.
//   What sniff() calls text, or an SVG picture, goes out as text/plain when those bytes hold no
//   NUL -- an .html or .svg copy shows as its text and never runs. The rest, a PDF or a HEIC photo
//   among it, is application/octet-stream with Content-Disposition: attachment, for the page to
//   read with fetch() (for a hex view) and never to show. Every copy is sent with CSP "default-src
//   'none'; sandbox", so one opened in a tab of its own could run nothing -- and none is: a request
//   whose Sec-Fetch-Dest says it is not for a picture, a video or a script's fetch() (a tab, a
//   frame) gets 403, so that no copy is shown where the browser offers to save it to Downloads,
//   past every check a restore makes. Range requests get 206 through openCopy(), which streams, so
//   a video over 2 GiB plays and seeks.
//
// Progress (GET /api/events, one server-sent event stream per window)
//   A search runs in this thread. The sources keep what freeze() read -- and other state -- in
//   their modules, which a worker thread would not share; stopping a worker would lose it. The
//   price: while a source reads synchronously, nothing reaches the page. Measured on Windows with
//   Node 24: ten events written 100 ms apart inside one blocking stretch all arrived together
//   when it ended. The slowest source, Claude Code, awaits each transcript, so its progress does
//   flow. source-progress is thinned to one per source every PROGRESS_MS, the last one kept.
//   Results arrive in batches of BATCH once a search is done, the first STREAM_ITEMS of them, and
//   can be fetched by page -- the rest of a large search, or all of it again after a reload.
//   One search or plan runs at a time. One that is stopped is told so through its AbortSignal and
//   is answered as stopped at once; search() gives up at its next step -- the next source, the
//   next copy looked into -- and what it found is dropped. A source in the middle of a long read
//   finishes that read first, so the next search waits for the stopped one to settle before it
//   starts: two never run side by side over the sources' shared state.
//   The server keeps the last finished search of each view the page has (a search by name, one
//   for photos and videos: `view.mode` in the request), and the last finished plan, so one kind
//   of search does not wipe the other's results. `view` is the page's own picture of its form,
//   kept and given back as it came, so a reload shows the form as it was.
//   Shadow copies are walked, in a search by name or type, where the other sources found
//   something and in Desktop, Documents and Downloads (vss.js); a search for pictures or videos
//   adds Pictures and Videos, where those mostly are. A folder's plan has git look from the
//   nearest folder of it that still exists, where its repository may be.
//
// Staying alive
//   Before any window opens, freeze() reads the stores that change on their own -- the thumbnail
//   cache, a browser's cache -- since starting a browser, or Explorer showing a restored
//   picture, writes to them. The event stream is the heartbeat: when the last one closes, the
//   process stops after IDLE.grace, or after IDLE.bye once the page has said goodbye
//   (navigator.sendBeacon('api/bye') on pagehide -- a reload sends it too, which is why it only
//   shortens the wait, and not while a search or plan runs); when no window connects at all,
//   after IDLE.first. A wait that ends late -- a source read synchronously all through it, and
//   the reloaded page's connection may be waiting behind that -- or during which the page asked
//   for anything, as a reloaded one does before its event stream connects, is waited again
//   rather than taken as a window gone. It never stops while a restore or a rebuild is writing:
//   that finishes first. Ctrl+C and closing the console (SIGHUP, after which Windows kills the
//   process about 10 s later) wait for a write up to SIGNAL_WAIT_MS; a write still going then is
//   cut, and its temporary file removed (the library's removeUnfinished()), so no ".part" file
//   is left.
//
// Drives (GET /api/drives)
//   Looking at a drive can hang: a mapped drive whose share is gone makes realpath and statfs
//   wait for the network to give up. Each look runs in libuv's thread pool, with a time limit
//   here; a drive that does not answer is reported so, and is not looked at again until its
//   look returns. The pool has four threads, which reading copies needs too, so once two looks
//   hang no further drive is looked at. Measured on this machine: the 25 letters with no drive
//   failed with ENOENT in 0.02 to 1.4 ms each, and C: answered in 0.3 ms. They are first looked
//   at when the server starts, so that the list is there when the page asks.
//
// Where to write (POST /api/check-folder)
//   Whether a folder lies inside a place copies are read from, the library decides
//   (checkDestination), and restoreCopy() and rebuildFolder() refuse it there. Asking takes a
//   while -- 0.9 to 2.3 s here with git's places widened to the user's folders, most of it finding
//   the repositories and asking git about each -- so each answer is kept for the run, and a second
//   look at the same folder took 21 ms. Writing onto the drive the lost files were
//   on can overwrite what is still to be found, so the page is told how many of them were on the
//   volume of the folder: by stat()'s dev, the volume's serial number on Windows, which a SUBST or
//   mapped letter shares with the drive it stands for; by the drive's root where that cannot be told.
//   A copy read from a whole disk (\\.\PhysicalDrive1) is on a drive whose letter cannot be told
//   here, and is counted apart (onDevice), for the page to warn of; the library refuses to write
//   onto the volumes of such a disk itself. Run as administrator, a folder of Windows, of Program
//   Files or of ProgramData is refused as well: nothing restored belongs there, and a program
//   running as the user could otherwise have this one put a file of its choosing where only an
//   administrator may. It is refused however it is reached -- through a junction, which anyone
//   may make, or as \\localhost\C$\Windows -- by what the folder really is and by the volume and
//   file ID of each folder it lies in.
//
// The page's files come from src/gui/ui, or, in the built program, from its assets under the same
// relative names (index.html, app.js, ...). The API, all JSON, all below /api:
//   GET  info                     version, platform, elevated, how the window was opened, TYPES, ...
//   GET  sources                  { sources: [{ id, label, media, needsAdmin }], elevated }
//   GET  sources/describe?ids=    { sources: [{ id, label, lines }] }, what each source sees
//   GET  drives                   { drives: [{ root, letter, answering, network, free, total, system, error }],
//                                 skipped }: how many were not looked at, since others hang
//   GET  events                   the event stream: hello, progress, results, plan, done, failed,
//                                 cancelled, restore-progress
//   POST search                   { pattern, containing, types, sources, deletedOnly, since, locations,
//                                 view } -> 202 { job }; 409 while another search or plan runs
//   POST plan                     the same with { folder } instead of a pattern -> 202 { job }; its
//                                 files come as plan events: { rel, uid, leftOut, copy }, where
//                                 leftOut marks a file whose only copies are smaller or may be
//                                 incomplete, which a rebuild takes only when asked to
//   POST cancel                   { job }: a search or plan is dropped; its results never arrive
//   GET  job/<id>                 the job as the done event gave it
//   GET  job/<id>/items?offset=&limit=   its results, or its plan's files
//   GET  copy/<uid>               the bytes (HEAD and Range too); copy/<uid>/about: their type;
//                                 copy/<uid>/thumb: a JPEG's own small picture, or 404
//   POST check-folder             { to, uids | plan } -> { ok, path, exists, free, root, sameDrive, onDevice }
//                                 or { ok: false, error }, a folder inside a searched place included
//   POST restore                  { uids, to } -> { to, written, failed, results: [{ uid, ok, path | error }] }
//   POST rebuild                  { plan: <job>, to, exclude: [rel], include: [rel] } -> 202 { job }
//   POST bye, POST quit
// A copy in a reply is plain fields (uiCopy): uid, id, kind, kindLabel, source, path, name, ext,
// time (ms), size, state, copies, seen, isDir, gone, draft, inexact, unverified, derived, tier
// (0 exact ... 4 derived), mediaType, width, height, note, origin -- never its bytes.
// An error is { error: <what went wrong, in words> }, with the system's code, such as ENOSPC,
// as `code` when there is one.

const LOOPBACK = /^(127(\.\d{1,3}){3}|::1)$/;
const TOKEN_BYTES = 32;
const BODY_LIMIT = 8 * 1024 * 1024;
const BATCH = 500;
// Items sent on the event stream when a job ends; the rest are fetched. A copy is some 300 to 700
// bytes of JSON, so this is a few megabytes at most, well below BACKLOG_LIMIT.
const STREAM_ITEMS = 5000;
const PAGE_LIMIT = 2000;
const HEAD_BYTES = 4096;
const EXIF_BYTES = 2 + 65535 + 2 + 1024; // the start of a JPEG, an Exif block of the most it can be, and what may come before it
const PROBE_MS = 2000;
const MAX_STUCK = 2;
const DRIVES_FRESH_MS = 5000;
const PING_MS = 15000;
const PROGRESS_MS = 100;
const BACKLOG_LIMIT = 16 * 1024 * 1024;
const SIGNAL_WAIT_MS = 8000;
const REBUILDS_KEPT = 5;
const REFUSALS_KEPT = 1000;
const VIEW_LIMIT = 16 * 1024; // the page's picture of its form, as JSON
const DIR_LOOKS = 256; // folders looked at, per check, to tell which volume the originals were on
const IDLE = { grace: 30000, bye: 3000, first: 10 * 60000 };
// A wait that ends this much later than it should was held up by a stretch of synchronous work,
// behind which a window's new connection may be waiting; a timer is otherwise late by a few ms.
// Taking one for held up when it was not only waits once more.
const LATE_MS = 100;
// What a request for a copy's bytes may be for (Sec-Fetch-Dest): a picture, a video or sound, or
// a script's fetch(). A tab or a frame showing a copy on its own would offer to save it.
const COPY_DESTS = new Set(['image', 'video', 'audio', 'track', 'empty']);

const PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' blob: data:",
  "media-src 'self' blob:", "connect-src 'self'", "font-src 'self'", "base-uri 'none'",
  "form-action 'none'", "frame-ancestors 'none'", "require-trusted-types-for 'script'", "trusted-types 'none'",
].join('; ');
const COPY_CSP = "default-src 'none'; sandbox";

// What a browser shows by itself, by the extension sniff() gives. Chromium reads a file it plays
// with FFmpeg's demuxers, to which MP4, QuickTime and 3GP are one format and WebM and Matroska
// another, so those go out as MP4 and WebM (read, not tried in a browser here); a codec it lacks
// -- HEVC without the system's decoder, H.263 -- fails in the page, which says so. HEIC, TIFF,
// camera RAW, AVI and the like a browser does not show; they go out as bytes.
const PREVIEW = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.3gp': 'video/mp4', '.3g2': 'video/mp4',
  '.webm': 'video/webm', '.mkv': 'video/webm',
};

const ASSET_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
// A page file's path: plain names, no dot at the start of any, no escapes, no way up.
const ASSET_PATH = /^\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const UID = /^[0-9a-f]{32}$/;

/** An Error that becomes an HTTP status. */
function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Waits for a look at the disk, but not past `ms`: { value } | { error } | { timedOut: true }. */
function timed(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ value });
      },
      (error) => {
        clearTimeout(timer);
        resolve({ error });
      });
  });
}

/** Constant-time comparison of two strings. */
function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * A Range header as RFC 9110 reads it, for one range: { start, end } (inclusive), 'unsatisfiable',
 * or null to send the whole copy -- also for several ranges, or a header that does not parse.
 */
function parseRange(header, size) {
  if (!header || size == null) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n) || n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (!Number.isSafeInteger(start) || start >= size) return 'unsatisfiable';
  if (!m[2]) return { start, end: size - 1 };
  const last = Number(m[2]);
  if (Number.isSafeInteger(last) && last < start) return null;
  return { start, end: Number.isSafeInteger(last) ? Math.min(last, size - 1) : size - 1 };
}

/** No NUL byte where text would have none, or a UTF-16 byte order mark. */
function isText(head) {
  if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) return true;
  return !head.includes(0);
}

function textType(head) {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'text/plain; charset=utf-16le';
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'text/plain; charset=utf-16be';
  return 'text/plain; charset=utf-8';
}

/**
 * How a copy may be sent, from what sniff() made of its first bytes.
 * @returns {{ type: string, preview: 'image'|'video'|'text'|null, inline: boolean }}
 */
function previewOf(sniffed, head) {
  const kind = sniffed && sniffed.mediaType;
  const ext = sniffed && typeof sniffed.ext === 'string' ? sniffed.ext.toLowerCase() : null;
  if ((kind === 'image' || kind === 'video') && ext && PREVIEW[ext] && PREVIEW[ext].startsWith(kind + '/')) {
    return { type: PREVIEW[ext], preview: kind, inline: true };
  }
  // A picture drawn in SVG is XML, which can carry scripts: it is shown as the text it is.
  if ((kind == null || kind === 'text' || ext === '.svg') && isText(head)) {
    return { type: textType(head), preview: 'text', inline: true };
  }
  return { type: 'application/octet-stream', preview: null, inline: false };
}

/**
 * The small picture a camera or a phone puts inside a JPEG's Exif block (the second image file
 * directory, IFD1: JPEGInterchangeFormat and its length), which a grid can show instead of
 * decoding a photo of several megabytes. The Exif block is an APP1 segment, at most 64 KiB, before
 * the picture itself, so the first EXIF_BYTES of the file hold it unless a large segment comes
 * first, which leaves the grid to read the photo itself. What IFD0 says of the
 * photo's orientation comes with it: the small picture is stored as the sensor saw it, like the
 * large one, and is turned the same way. Only a picture that lies wholly inside the Exif block and
 * starts as a JPEG does is given; anything else is null, and the grid reads the photo itself.
 * @param {Buffer} buf  the start of a JPEG
 * @returns {{ data: Buffer, orientation: number }|null}  orientation 1 to 8, 1 when not said
 */
function exifThumbnail(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let at = 2;
  // Markers before the picture's data: APPn, COM, DQT and the like, each with its length.
  while (at + 4 <= buf.length && buf[at] === 0xff) {
    const marker = buf[at + 1];
    if (marker === 0xda || marker === 0xd9) return null; // the picture starts, or ends: no Exif came
    const length = buf.readUInt16BE(at + 2);
    const end = at + 2 + length;
    if (length < 2 || end > buf.length) return null;
    if (marker === 0xe1 && length >= 16 && buf.toString('latin1', at + 4, at + 10) === 'Exif\0\0') {
      return tiffThumbnail(buf.subarray(at + 10, end));
    }
    at = end;
  }
  return null;
}

/** exifThumbnail() inside the Exif block's TIFF structure, whose offsets count from its start. */
function tiffThumbnail(tiff) {
  if (tiff.length < 8) return null;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const u16 = (o) => (o + 2 <= tiff.length ? (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)) : null);
  const u32 = (o) => (o + 4 <= tiff.length ? (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o)) : null);
  if (u16(2) !== 42) return null;
  /** The tags of the directory at `o` (tag -> its value, for SHORT and LONG only), and where the next one is. */
  const directory = (o) => {
    const count = u16(o);
    if (count == null || count > 1000 || o + 2 + count * 12 + 4 > tiff.length) return null;
    const tags = new Map();
    for (let i = 0; i < count; i++) {
      const e = o + 2 + i * 12;
      const type = u16(e + 2);
      if (type === 3) tags.set(u16(e), u16(e + 8));
      else if (type === 4) tags.set(u16(e), u32(e + 8));
    }
    return { tags, next: u32(o + 2 + count * 12) };
  };
  const ifd0 = directory(u32(4));
  if (!ifd0 || !ifd0.next) return null;
  const ifd1 = directory(ifd0.next);
  if (!ifd1) return null;
  const from = ifd1.tags.get(0x0201);
  const length = ifd1.tags.get(0x0202);
  if (!from || !length || from + length > tiff.length) return null;
  const data = tiff.subarray(from, from + length);
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;
  const orientation = ifd0.tags.get(0x0112);
  return { data, orientation: orientation >= 1 && orientation <= 8 ? orientation : 1 };
}

/** The length of a copy's bytes, where it is known for sure; null sends it whole, without ranges. */
function sizeOf(c) {
  if (c.buffer) return c.buffer.length;
  if (typeof c.text === 'string') return Buffer.byteLength(c.text, 'utf8');
  return Number.isSafeInteger(c.size) && c.size >= 0 ? c.size : null;
}

// The library says a copy's tier (index.js tier()); a stand-in library that does not is read by
// its flags, worst first (quality.js: 0 exact, 1 inexact, 2 draft, 3 unverified, 4 derived).
function flagsTier(c) {
  if (c.derived) return 4;
  if (c.unverified) return 3;
  if (c.draft) return 2;
  if (c.inexact) return 1;
  return 0;
}

const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);

/**
 * What the page gets of a copy: plain fields, never its bytes or text. `uid` names it in
 * requests; `id` is the one the command line shows. Times are milliseconds.
 */
function uiCopy(c, uid, tierOf) {
  const tier = tierOf(c);
  return {
    uid,
    id: c.id || null,
    kind: c.kind || null,
    kindLabel: c.kind ? t(c.kind) : null,
    source: c.source || null,
    path: c.path || null,
    name: c.name || null,
    ext: c.ext || null,
    time: finite(c.time),
    size: finite(c.size),
    state: c.state || '',
    copies: c.copies || 1,
    seen: Array.isArray(c.seen) ? c.seen : [c.kind],
    isDir: !!c.isDir,
    gone: !!c.gone,
    draft: !!c.draft,
    inexact: !!c.inexact || tier === 1,
    // A kind can make a copy one of these as well as a flag can (quality.js), as the tier shows.
    unverified: !!c.unverified || tier === 3,
    derived: !!c.derived || tier === 4,
    tier,
    mediaType: c.mediaType || null,
    width: finite(c.width),
    height: finite(c.height),
    note: c.note || null,
    origin: c.origin || null,
  };
}

/**
 * Looks at drives and folders without ever waiting long on one. `fsp` is fs.promises, or a
 * stand-in in tests.
 */
function driveProber({ fsp = fs.promises, platform = process.platform, env = process.env, ms = PROBE_MS } = {}) {
  const SKIPPED = Symbol('not looked at');
  const stuck = new Set(); // drives with a look still out past its limit
  let cached = null;
  let cachedAt = 0;
  let running = null;

  /**
   * One look at something on the drive `root`: { value } | { error } | { timedOut } | { skipped }.
   * `spare`: a look the user did not ask for -- listing drives -- which is skipped once looks hang
   * elsewhere, to keep threads for reading copies and for the folder the user typed.
   */
  async function look(root, fn, spare = false) {
    const key = String(root).toLowerCase();
    if (stuck.has(key)) return { timedOut: true };
    if (spare && stuck.size >= MAX_STUCK) return { skipped: true };
    const p = Promise.resolve().then(fn);
    const r = await timed(p, ms);
    if (r.timedOut) {
      stuck.add(key);
      const clear = () => stuck.delete(key);
      p.then(clear, clear);
    }
    return r;
  }

  const space = (st) => (st && st.value
    ? { free: Number(st.value.bavail) * Number(st.value.bsize), total: Number(st.value.blocks) * Number(st.value.bsize) }
    : { free: null, total: null });

  /** A drive; null when there is none at `root`, and SKIPPED when it was not looked at. */
  async function probe(root) {
    const unknown = { root, network: null, free: null, total: null, error: null };
    const real = await look(root, () => fsp.realpath(root), true);
    if (real.skipped) return SKIPPED;
    if (real.timedOut) return { ...unknown, answering: false };
    if (real.error) {
      if (real.error.code === 'ENOENT') return null; // no such drive
      return { ...unknown, answering: false, error: real.error.code || real.error.message };
    }
    // A letter mapped to a share resolves to \\server\share; a SUBST letter to a local folder.
    const network = platform === 'win32' ? String(real.value).startsWith('\\\\') : null;
    const st = await look(root, () => fsp.statfs(root), true);
    const answering = st.value ? true : st.skipped ? null : false;
    return { ...unknown, answering, network, ...space(st) };
  }

  /** Where drives are mounted on Linux and macOS, below the usual places. */
  async function mounted() {
    let user = env.USER || env.LOGNAME || '';
    try {
      user = os.userInfo().username;
    } catch (_) {
      /* no such user in the passwd file: keep the variable */
    }
    const out = [];
    const places = platform === 'darwin' ? ['/Volumes'] : ['/media/' + user, '/run/media/' + user, '/mnt'];
    for (const dir of places) {
      const r = await look(dir, () => fsp.readdir(dir, { withFileTypes: true }), true);
      if (!r.value) continue;
      for (const e of r.value) if (e.isDirectory()) out.push(path.posix.join(dir, e.name));
    }
    return out;
  }

  /** { drives, skipped }: `skipped` places were not looked at, since looks at others hang. */
  async function list() {
    const drives = [];
    let skipped = 0;
    const add = async (root, extra) => {
      const d = await probe(root);
      if (d === SKIPPED) skipped++;
      else if (d) drives.push({ ...d, ...extra });
    };
    if (platform === 'win32') {
      const system = String(env.SystemDrive || 'C:').slice(0, 1).toUpperCase();
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') await add(letter + ':\\', { letter, system: letter === system });
    } else {
      for (const root of ['/', ...(await mounted())]) await add(root, { letter: null, system: root === '/' });
    }
    return { drives, skipped };
  }

  /** Every drive, looked at again at most every DRIVES_FRESH_MS; callers at once share one look. */
  function drives() {
    if (cached && Date.now() - cachedAt < DRIVES_FRESH_MS) return Promise.resolve(cached);
    if (!running) {
      running = list().then((d) => {
        cached = d;
        cachedAt = Date.now();
        running = null;
        return d;
      }, (e) => {
        running = null;
        throw e;
      });
    }
    return running;
  }

  return { look, drives, fsp, platform };
}

/** A path as typed or pasted: Explorer's "Copy as path" puts it in double quotes. */
function unquote(s) {
  return String(s).trim().replace(/^"([^"]*)"$/, '$1').trim();
}

/** The folders an elevated front end never writes into (see the top of this file), as `env` names them. */
function systemFolders(env) {
  return [env.SystemRoot || env.windir, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.ProgramData]
    .filter((f) => typeof f === 'string' && /^[A-Za-z]:[\\/]/.test(f))
    .map((f) => path.win32.resolve(f));
}

/** Whether the Windows path `a` is the folder `b` or lies below it, in any case. */
function insideOf(a, b) {
  const x = path.win32.resolve(a).toLowerCase();
  const y = path.win32.resolve(b).toLowerCase().replace(/\\+$/, '');
  return x === y || x.startsWith(y + '\\');
}

/**
 * The first of `kept` that the folder `at`, which exists, is or lies in by another name than its
 * own: through a junction, which anyone may make to System32 and realpath follows, or as
 * \\localhost\C$\Windows, which realpath leaves as it is and which is told by the volume and
 * file ID of each folder it lies in. Null for none.
 */
async function keptByAnotherName(at, kept, prober) {
  const w = path.win32;
  const real = await prober.look(w.parse(at).root, () => prober.fsp.realpath(at));
  const where = real.value ? String(real.value) : at;
  const hit = kept.find((f) => insideOf(where, f));
  if (hit) return hit;
  const idOf = (st) => (st && st.ino ? `${st.dev}:${st.ino}` : null);
  const ids = new Map();
  for (const f of kept) {
    const id = idOf((await prober.look(w.parse(f).root, () => prober.fsp.stat(f, { bigint: true }))).value);
    if (id) ids.set(id, f);
  }
  if (!ids.size) return null;
  for (let x = where; ; x = w.dirname(x)) {
    const id = idOf((await prober.look(w.parse(x).root, () => prober.fsp.stat(x, { bigint: true }))).value);
    if (id && ids.has(id)) return ids.get(id);
    if (w.dirname(x) === x) return null;
  }
}

/**
 * Where a restore or a rebuild may write: a whole path as typed, whose nearest existing part is
 * a folder on a drive that answers. Whether it lies inside a place copies are read from, the
 * library decides when it writes: restoreCopy() and rebuildFolder() refuse it there.
 * Run as administrator on Windows (`o.elevated`), the folders of the system and of programs are
 * refused too (see the top of this file), by the folders `o.env` names, however they are reached.
 * @returns {Promise<{ path: string, root: string, exists: boolean, free: number|null, at: string, dev: string|null }>}
 *   `at` is the nearest part of the path that exists, `dev` the volume it is on
 */
async function checkFolder(to, prober, o = {}) {
  const platform = prober.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (typeof to !== 'string' || !unquote(to)) throw fail(400, t('Type the folder to put it in.'));
  const raw = unquote(to);
  if (raw.includes('\0') || raw.length > 32000) throw fail(400, t('That is not a folder path.'));
  if (platform === 'win32') {
    if (/^[\\/]{2}[?.][\\/]/.test(raw)) {
      throw fail(400, t('Give a folder on a drive, such as D:\\Recovered, not a device path.'));
    }
    if (!/^[A-Za-z]:[\\/]/.test(raw) && !/^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(raw)) {
      throw fail(400, t('Give the whole path of the folder, with its drive, such as D:\\Recovered.'));
    }
  } else if (!raw.startsWith('/')) {
    throw fail(400, t('Give the whole path of the folder, starting with /.'));
  }
  const dir = p.resolve(raw);
  const root = p.parse(dir).root;
  const kept = platform === 'win32' && o.elevated ? systemFolders(o.env || process.env) : [];
  const refuseKept = (folder) => fail(400, t('Solarljos runs as administrator, so it does not write inside {0}: nothing '
    + 'restored belongs there. Choose a folder of your own.', folder));
  const named = kept.find((f) => insideOf(dir, f));
  if (named) throw refuseKept(named);
  let at = dir;
  let dev = null;
  for (;;) {
    const r = await prober.look(root, () => prober.fsp.stat(at, { bigint: true }));
    if (r.timedOut) throw fail(400, t('{0} does not answer. Is the drive or the share there?', root));
    if (r.value) {
      if (!r.value.isDirectory()) {
        throw fail(400, at === dir
          ? t('{0} is a file, not a folder.', at)
          : t('{0} is a file, so no folder can be made inside it.', at));
      }
      dev = r.value.dev != null ? String(r.value.dev) : null;
      break;
    }
    if (r.error.code !== 'ENOENT' && r.error.code !== 'ENOTDIR') throw fail(400, t('Cannot use {0}: {1}', at, r.error.message));
    const up = p.dirname(at);
    if (up === at) throw fail(400, t('There is no drive {0} on this computer.', root));
    at = up;
  }
  // What is below `at` does not exist yet, so it leads nowhere else: `at` is where another name can.
  const unnamed = kept.length ? await keptByAnotherName(at, kept, prober) : null;
  if (unnamed) throw refuseKept(unnamed);
  const st = await prober.look(root, () => prober.fsp.statfs(at));
  const free = st.value ? Number(st.value.bavail) * Number(st.value.bsize) : null;
  return { path: dir, root, exists: at === dir, free, at, dev };
}

/** The page's own files: the built program's assets, or src/gui/ui when run from source. */
function defaultAssets() {
  let sea = null;
  try {
    sea = require('node:sea');
  } catch (_) {
    sea = null;
  }
  if (sea && typeof sea.isSea === 'function' && sea.isSea()) {
    return (rel) => {
      try {
        return Buffer.from(sea.getAsset(rel));
      } catch (_) {
        return null;
      }
    };
  }
  const dir = path.join(__dirname, 'ui');
  return (rel) => {
    try {
      return fs.readFileSync(path.join(dir, ...rel.split('/')));
    } catch (_) {
      return null;
    }
  };
}

function runsAsProgram() {
  try {
    const sea = require('node:sea');
    return typeof sea.isSea === 'function' && sea.isSea();
  } catch (_) {
    return false;
  }
}

/**
 * Where git looks by default. The command line looks in the current folder; a program started
 * with a double-click has its own folder as the current one -- the root of a USB stick, say --
 * so the usual homes of repositories are added: the home folder, Documents\GitHub (GitHub
 * Desktop), source\repos (Visual Studio) and Projects, those that exist. Each is looked through
 * up to two levels down, as the git source does.
 */
function gitPlaces(program, home = os.homedir()) {
  const usual = [home, path.join(home, 'Documents', 'GitHub'), path.join(home, 'source', 'repos'), path.join(home, 'Projects')];
  return existing(program ? usual : [process.cwd(), ...usual]);
}

/** The folders of `list` that exist, each once. */
function existing(list) {
  const out = [];
  for (const p of list) {
    try {
      if (fs.statSync(p).isDirectory() && !out.includes(p)) out.push(p);
    } catch (_) {
      /* not there */
    }
  }
  return out;
}

function pageFallback() {
  const say = t('Solarljos is running, but the files of its page were not found. Use a complete copy of it, or the command line.');
  const html = say.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  return Buffer.from(`<!doctype html>\n<html lang="en"><meta charset="utf-8"><link rel="icon" href="data:,">`
    + `<title>Solarljos</title><p>${html}</p></html>\n`);
}

/**
 * Sends a copy's bytes, at most `length` of them, and ends the reply only when all arrived. A
 * copy that ends short, or cannot be read on, ends the connection after what was sent, so a
 * browser never takes a part for the whole. Not res.destroy(): measured here, that also drops the
 * headers and bytes already written, and the browser learns nothing but that the socket closed.
 */
function pump(source, res, length) {
  return new Promise((resolve) => {
    let sent = 0;
    let over = false;
    const finish = (whole) => {
      if (over) return;
      over = true;
      source.destroy();
      if (whole) res.end();
      else if (res.socket && !res.socket.destroyed) res.socket.end();
      resolve();
    };
    source.on('data', (chunk) => {
      if (over) return;
      let part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (length != null && sent + part.length > length) part = part.subarray(0, length - sent);
      sent += part.length;
      if (part.length && !res.write(part)) {
        source.pause();
        res.once('drain', () => source.resume());
      }
      if (length != null && sent >= length) finish(true);
    });
    source.on('end', () => finish(length == null || sent >= length));
    source.on('error', () => finish(false));
    res.on('close', () => finish(false));
  });
}

/**
 * Starts the server, reads the stores that change on their own, and opens a window on it.
 * @param {object} [opts]
 * @param {number} [opts.port=0]            0: the system picks a free one
 * @param {string} [opts.host='127.0.0.1']  a loopback address; nothing else is accepted
 * @param {boolean|'browser'} [opts.open=true]  false: only print the address (see launch.js)
 * @param {object} [opts.locations]  the places every search starts from, as search() takes them;
 *   by default this machine's own, found as the command line finds them, with git's widened (gitPlaces)
 * @param {boolean} [opts.exit=true]  stop the process once the window is gone, and on Ctrl+C or
 *   a closed console; false leaves the process alone, for tests and embedding
 * @param {object} [opts.api]        the library (../index.js) or a stand-in
 * @param {boolean} [opts.elevated]  instead of asking the library
 * @param {boolean} [opts.program]   whether this runs as the built program, instead of asking Node
 * @param {string} [opts.home]       the user's home folder, instead of asking the system
 * @param {function} [opts.log]      prints one line; the console by default
 * @param {function} [opts.launch]   opens the window (launch.js's openWindow by default)
 * @param {function} [opts.assets]   the page's files: (relative path) => Buffer | null
 * @param {object} [opts.idle]       { grace, bye, first } in ms, instead of IDLE
 * @param {object} [opts.fsp]        fs.promises, or a stand-in for the looks at drives and folders
 * @returns {Promise<{ url: string, close: () => Promise<void>, closed: Promise<void> }>}
 *   `url` is the address with the token; `closed` settles when the server has stopped
 */
async function start(opts = {}) {
  const api = opts.api || require('../index');
  const host = opts.host == null ? '127.0.0.1' : String(opts.host);
  if (!LOOPBACK.test(host)) {
    const e = new Error(t('The page is served on this computer only: give 127.0.0.1 or ::1 as the host, not {0}.', host));
    e.usage = true;
    throw e;
  }
  const port = opts.port == null ? 0 : Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    const e = new Error(t('A port is a whole number from 0 to 65535, not {0}.', opts.port));
    e.usage = true;
    throw e;
  }
  const log = opts.log || ((s) => process.stdout.write(s + '\n'));
  const idle = { ...IDLE, ...(opts.idle || {}) };
  const exitProcess = opts.exit !== false;
  const assets = opts.assets || defaultAssets();
  const openWindow = opts.launch || launch.openWindow;
  const program = opts.program !== undefined ? !!opts.program : runsAsProgram();
  const prober = driveProber({ fsp: opts.fsp || fs.promises });
  const P = prober.platform === 'win32' ? path.win32 : path.posix;
  const home = opts.home || os.homedir();
  const base = opts.locations || { discover: true };
  const defaultGit = gitPlaces(program, home);
  const version = (() => {
    try {
      return require('../../package.json').version;
    } catch (_) {
      return null;
    }
  })();
  const tierOf = (c) => (Number.isInteger(c.tier) ? c.tier : typeof api.tier === 'function' ? api.tier(c) : flagsTier(c));
  const sourceIds = () => (api.sources || []).map((s) => s.id);

  let elevated = false;
  if (opts.elevated !== undefined) {
    elevated = !!opts.elevated;
  } else if (typeof api.isElevated === 'function') {
    try {
      elevated = !!(await api.isElevated());
    } catch (_) {
      elevated = false;
    }
  }

  // Null once traded: the address works once (see the top of this file).
  let token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const session = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const streams = new Set();
  const jobs = new Map();
  const refusals = new Map(); // checkDestination's answers, by the places asked with and the folder
  const placeIds = new WeakMap();
  let placeSeq = 0;
  let seq = 0;
  let settled = Promise.resolve(); // the last search or plan, once it has ended, however it ends
  let writing = 0;
  let pendingStop = null; // { why, force }: a stop that waits for a write to finish
  let exitTimer = null;
  let pinger = null;
  let byeAt = 0;
  let askedAt = 0; // when a window last asked for anything but to say goodbye
  let closing = false;
  let windowHow = 'none';
  let frozen = null;
  let origin = null;
  let hostHeader = null;
  let cookieName = null;
  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  const signalHandlers = [];

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => replyError(req, res, e));
  });
  server.headersTimeout = 20000;

  // ---- replies -----------------------------------------------------------------------------

  function headers(extra = {}) {
    return {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Content-Security-Policy': PAGE_CSP,
      ...extra,
    };
  }

  function send(req, res, status, body, type, extra = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    res.writeHead(status, headers({ 'Content-Type': type, 'Content-Length': buf.length, ...extra }));
    res.end(req.method === 'HEAD' ? undefined : buf);
  }

  const reply = (req, res, status, obj) => send(req, res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

  function refuse(req, res, status, message, extra) {
    req.resume();
    send(req, res, status, message, 'text/plain; charset=utf-8', extra);
    return null;
  }

  /** { error: message }, with the system's own code (ENOSPC, EACCES...) when there is one. */
  function replyError(req, res, e) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = e.status || (e.usage ? 400 : 500);
    const code = typeof e.code === 'string' && /^E[A-Z0-9]+$/.test(e.code) ? e.code : undefined;
    send(req, res, status, JSON.stringify({ error: e.message, ...(code ? { code } : {}), ...(e.job ? { job: e.job } : {}) }),
      'application/json; charset=utf-8');
  }

  function readJson(req) {
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) {
      req.resume();
      return Promise.reject(fail(415, t('Send JSON.')));
    }
    return new Promise((resolve, reject) => {
      let size = 0;
      const parts = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > BODY_LIMIT) {
          reject(fail(413, t('That request is too large.')));
          req.destroy();
        } else {
          parts.push(c);
        }
      });
      req.on('end', () => {
        try {
          const body = parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {};
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
          resolve(body);
        } catch (_) {
          reject(fail(400, t('That request is not JSON the server understands.')));
        }
      });
      req.on('error', reject);
    });
  }

  // ---- who may ask ---------------------------------------------------------------------------

  /** The checks at the top of this file. Returns the request's URL, or null once it is answered. */
  function guard(req, res) {
    if (String(req.headers.host || '').toLowerCase() !== hostHeader) {
      return refuse(req, res, 403, t('This page is served only as {0}.', hostHeader));
    }
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      return refuse(req, res, 403, t('Refused a request from another site.'));
    }
    const from = req.headers.origin;
    const fromHere = from === origin || (from === 'null' && site === 'same-origin');
    if (from !== undefined && !fromHere) return refuse(req, res, 403, t('Refused a request from another site.'));
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
      return refuse(req, res, 405, t('Not allowed.'), { Allow: 'GET, HEAD, POST' });
    }
    if (req.method === 'POST' && !fromHere) {
      return refuse(req, res, 403, t('Refused a request that does not say where it comes from.'));
    }
    let url;
    try {
      url = new URL(req.url, origin);
    } catch (_) {
      return refuse(req, res, 400, t('That address does not parse.'));
    }
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('k')) {
      if (token === null) {
        // Traded already. The window that traded it has the cookie, and a reload of its address
        // (the token gone from it) goes on below.
        if (same(cookieOf(req, cookieName) || '', session)) {
          res.writeHead(302, headers({ Location: '/', 'Content-Length': 0 }));
          res.end();
          return null;
        }
        return refuse(req, res, 403, t('This address works once, and has been used. Open Solarljos from the window it opened, '
          + 'or start it again.'));
      }
      if (!same(url.searchParams.get('k'), token)) {
        return refuse(req, res, 403, t('This address is from another run of Solarljos. Start it again and use the window it opens.'));
      }
      token = null;
      res.writeHead(302, headers({
        Location: '/',
        'Set-Cookie': `${cookieName}=${session}; Path=/; HttpOnly; SameSite=Strict`,
        'Content-Length': 0,
      }));
      res.end();
      return null;
    }
    if (!same(cookieOf(req, cookieName) || '', session)) {
      return refuse(req, res, 403, t('Open Solarljos from the window it opened, or start it again.'));
    }
    if (req.method === 'POST' && url.pathname !== '/api/bye' && req.headers['x-solarljos'] !== '1') {
      return refuse(req, res, 403, t('Refused a request that does not come from the Solarljos page.'));
    }
    return url;
  }

  async function handle(req, res) {
    const url = guard(req, res);
    if (!url) return;
    const p = url.pathname;
    if (p !== '/api/bye') askedAt = Date.now();
    if (p === '/api/events' && req.method === 'GET') return openStream(req, res);
    if (p.startsWith('/api/')) return route(req, res, url);
    return serveAsset(req, res, p);
  }

  function serveAsset(req, res, p) {
    if (req.method === 'POST') return refuse(req, res, 405, t('Not allowed.'), { Allow: 'GET, HEAD' });
    const rel = p === '/' ? 'index.html' : ASSET_PATH.test(p) ? p.slice(1) : null;
    const type = rel && ASSET_TYPES[path.posix.extname(rel).toLowerCase()];
    const body = type ? assets(rel) : null;
    if (body) return send(req, res, 200, body, type);
    if (rel === 'index.html') return send(req, res, 200, pageFallback(), ASSET_TYPES['.html']);
    return refuse(req, res, 404, t('Not found.'));
  }

  // ---- the event stream, which is also the heartbeat ----------------------------------------

  function emit(event, data) {
    if (!streams.size) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) {
      // A window that stopped reading is dropped; when it comes back, hello tells it where things are.
      if (res.writableLength > BACKLOG_LIMIT) res.destroy();
      else res.write(msg);
    }
  }

  function openStream(req, res) {
    res.writeHead(200, headers({ 'Content-Type': 'text/event-stream; charset=utf-8' }));
    req.socket.setNoDelay(true);
    res.on('error', () => {});
    res.write('retry: 2000\n\n');
    streams.add(res);
    clearTimeout(exitTimer);
    exitTimer = null;
    if (pendingStop && !pendingStop.force) pendingStop = null;
    res.write(`event: hello\ndata: ${JSON.stringify(hello())}\n\n`);
    res.on('close', () => {
      streams.delete(res);
      if (closing || streams.size) return;
      armExit(Date.now() - byeAt < 5000 ? byeWait() : idle.grace, t('its window was closed'));
    });
  }

  /** How long to wait after a goodbye: not the short wait while a search or plan runs (see the top of this file). */
  function byeWait() {
    return finding() ? idle.grace : idle.bye;
  }

  function hello() {
    return { version, elevated, writing, jobs: [...jobs.values()].map(snapshot) };
  }

  function armExit(ms, why) {
    clearTimeout(exitTimer);
    const armedAt = Date.now();
    exitTimer = setTimeout(() => {
      exitTimer = null;
      if (streams.size) return;
      // Late: the wait was spent in synchronous work, during which no window could come back.
      // Asked for something meanwhile: a page is loading, whose event stream is still to come.
      if (Date.now() - armedAt > ms + LATE_MS || askedAt > armedAt) {
        armExit(ms, why);
        return;
      }
      requestStop(why, false);
    }, ms);
  }

  /** Stops now, or once the write in progress is done. `force`: even with a window still open. */
  function requestStop(why, force) {
    if (!writing) return shutdown(why);
    if (!pendingStop || force) pendingStop = { why, force };
    return undefined;
  }

  function writeStarted() {
    writing++;
  }

  function writeDone() {
    writing--;
    if (!writing && pendingStop && (pendingStop.force || !streams.size)) shutdown(pendingStop.why);
  }

  function shutdown(why) {
    if (closing) return;
    log(t('Solarljos stopped: {0}.', why));
    close();
    if (exitProcess) {
      // The server was the last thing keeping the process alive; this is for a drive look that
      // still hangs, which would keep it waiting, and for a write cut short by Ctrl+C, whose
      // temporary file goes with it.
      setTimeout(() => {
        try {
          if (typeof api.removeUnfinished === 'function') api.removeUnfinished();
        } finally {
          process.exit(0);
        }
      }, 1000).unref();
    }
  }

  function close() {
    if (closing) return closed;
    closing = true;
    clearTimeout(exitTimer);
    clearInterval(pinger);
    for (const [signal, fn] of signalHandlers) process.removeListener(signal, fn);
    for (const res of streams) res.end();
    streams.clear();
    for (const job of jobs.values()) if (job.abort) job.abort.abort();
    server.close(() => resolveClosed());
    server.closeAllConnections();
    return closed;
  }

  // ---- searches, plans and rebuilds ----------------------------------------------------------

  function snapshot(job) {
    return {
      id: job.id,
      kind: job.kind,
      state: job.state,
      request: job.request,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      sources: [...job.sources.values()],
      total: job.items ? job.items.length : null,
      ...job.summary,
    };
  }

  function newJob(kind, request, ids) {
    const job = {
      id: String(++seq), kind, state: 'running', request, startedAt: Date.now(), finishedAt: null, error: null,
      sources: new Map(), summary: {}, items: null, copies: null, about: new Map(), abort: new AbortController(),
      lastTick: new Map(), heldTick: new Map(),
    };
    const labels = new Map((api.sources || []).map((s) => [s.id, s.label]));
    for (const id of ids || []) job.sources.set(id, { id, label: t(labels.get(id) || id), state: 'waiting' });
    jobs.set(job.id, job);
    return job;
  }

  /** Which of the page's views a search belongs to, as the page named it; '' for the rest. */
  const viewOf = (job) => (job.kind === 'search' && job.request && job.request.view ? String(job.request.view.mode || '') : '');

  /** Ends a job and drops the older ones of its kind and view, so that memory holds one of each. */
  function finishJob(job, state, summary = {}) {
    job.state = state;
    job.finishedAt = Date.now();
    job.abort = null;
    if (summary.error !== undefined) job.error = summary.error;
    Object.assign(job.summary, summary);
    delete job.summary.error;
    if (state === 'done') for (const s of job.sources.values()) if (s.state === 'waiting') s.state = 'skipped';
    const older = [...jobs.values()].filter((j) => j !== job && j.kind === job.kind && viewOf(j) === viewOf(job) && j.state !== 'running');
    for (const j of older.slice(0, job.kind === 'rebuild' ? Math.max(0, older.length - REBUILDS_KEPT + 1) : older.length)) {
      jobs.delete(j.id);
    }
    emit(state, snapshot(job));
  }

  const finding = () => [...jobs.values()].find((j) => (j.kind === 'search' || j.kind === 'plan') && j.state === 'running');

  /** Passes the library's progress on, thinning source-progress to one per source every PROGRESS_MS. */
  function progressOf(job) {
    const sendTick = (e) => emit('progress', { job: job.id, ...e });
    return (e) => {
      if (job.state !== 'running' || !e || typeof e !== 'object') return;
      if (typeof e.id === 'string') {
        if (!job.sources.has(e.id)) job.sources.set(e.id, { id: e.id, label: t(String(e.label || e.id)), state: 'waiting' });
      } else if (/^source-/.test(e.type)) {
        return; // a source event that names no source: nothing to show it on
      }
      const s = job.sources.get(e.id);
      if (e.type === 'source-start') {
        s.state = 'running';
      } else if (e.type === 'source-progress') {
        s.done = e.done;
        s.total = e.total;
        const now = Date.now();
        if (now - (job.lastTick.get(e.id) || 0) < PROGRESS_MS) {
          job.heldTick.set(e.id, e);
          return;
        }
        job.lastTick.set(e.id, now);
        job.heldTick.delete(e.id);
      } else if (e.type === 'source-done') {
        if (job.heldTick.has(e.id)) sendTick(job.heldTick.get(e.id));
        job.heldTick.delete(e.id);
        // skipped: a source that keeps only text, in a search for pictures or videos.
        s.state = e.error ? 'failed' : e.skipped ? 'skipped' : 'done';
        s.count = e.count;
        s.error = e.error || null;
      }
      sendTick(typeof e.label === 'string' ? { ...e, label: t(e.label) } : e);
    };
  }

  /** A name for a copy in requests: the same copy has the same one in every search. */
  function uidOf(c, job, i, taken) {
    const key = typeof c.key === 'string' ? c.key : `${job.id}\0${i}`;
    let uid = crypto.createHash('sha1').update(key).digest('hex').slice(0, 32);
    if (taken.has(uid)) uid = crypto.createHash('sha1').update(`${key}\0${job.id}\0${i}`).digest('hex').slice(0, 32);
    return uid;
  }

  const perSourceOf = (list) => (list || []).map((s) => ({
    id: s.id, label: t(String(s.label || s.id)), count: s.count || 0, error: s.error || null, skipped: !!s.skipped,
    notes: s.notes || [],
  }));

  /**
   * A finished job's items, in batches of BATCH, as `event` events -- the first STREAM_ITEMS of
   * them. They are written in one go, and a window reads them only as fast as it can, so a search
   * of a whole PC's photos written whole would outgrow BACKLOG_LIMIT and have the window's stream
   * dropped; the page asks for the rest by page (job/<id>/items), as it does after a reload.
   */
  function sendItems(event, job, items) {
    const upTo = Math.min(items.length, STREAM_ITEMS);
    for (let i = 0; i < upTo; i += BATCH) {
      emit(event, { job: job.id, offset: i, total: items.length, items: items.slice(i, Math.min(i + BATCH, upTo)) });
    }
  }

  /** What the library is asked: the options without the page's own picture of its form. */
  function libraryOptions(job, options) {
    const o = { ...options, onProgress: progressOf(job), signal: job.abort.signal };
    delete o.view;
    return o;
  }

  /**
   * Runs a search or a plan once the one before it has settled -- a stopped one included, which
   * may still be finishing a read (see the top of this file). One stopped while it waited never starts.
   */
  function queue(job, run) {
    settled = settled.then(() => (job.state === 'running' ? run() : undefined));
  }

  async function runSearch(job, options) {
    try {
      const out = await api.search(libraryOptions(job, options));
      if (job.state !== 'running') return;
      const copies = new Map();
      const items = out.results.map((c, i) => {
        const uid = uidOf(c, job, i, copies);
        copies.set(uid, c);
        return uiCopy(c, uid, tierOf);
      });
      job.copies = copies;
      job.items = items;
      job.locations = out.locations;
      sendItems('results', job, items);
      finishJob(job, 'done', {
        perSource: perSourceOf(out.perSource), stats: out.stats || {}, notes: Array.isArray(out.notes) ? out.notes : [],
      });
    } catch (e) {
      if (job.state === 'running') finishJob(job, 'failed', { error: e.message });
    }
  }

  /**
   * The plan's files, then those left out of it -- whose only copies are smaller ones or may be
   * incomplete (planFolder's leftOut) -- marked so, for the page to offer to add.
   */
  async function runPlan(job, folder, options) {
    try {
      const out = await api.planFolder(folder, libraryOptions(job, options));
      if (job.state !== 'running') return;
      const copies = new Map();
      const entries = [...out.plan, ...(out.leftOut || []).map((item) => ({ ...item, leftOut: true }))];
      const items = entries.map(({ rel, copy, leftOut }, i) => {
        const uid = uidOf(copy, job, i, copies);
        copies.set(uid, copy);
        return { rel: rel.join('/'), uid, leftOut: !!leftOut, copy: uiCopy(copy, uid, tierOf) };
      });
      job.copies = copies;
      job.items = items;
      job.plan = entries;
      job.folder = out.folder;
      job.locations = out.locations;
      sendItems('plan', job, items);
      finishJob(job, 'done', {
        folder: out.folder, files: out.plan.length, leftOut: entries.length - out.plan.length,
        perSource: perSourceOf(out.perSource), notes: Array.isArray(out.notes) ? out.notes : [],
      });
    } catch (e) {
      if (job.state === 'running') finishJob(job, 'failed', { error: e.message });
    }
  }

  async function runRebuild(job, plan, items, to) {
    writeStarted();
    try {
      emit('progress', { job: job.id, type: 'writing', done: 0, total: items.length });
      let last = 0;
      const onProgress = (e) => {
        const now = Date.now();
        if (e.done !== e.total && now - last < PROGRESS_MS) return;
        last = now;
        emit('progress', { job: job.id, type: 'writing', done: e.done, total: e.total, rel: [].concat(e.rel || []).join('/') });
      };
      const out = await api.rebuildFolder(items, plan.folder, to, plan.locations, { onProgress });
      const byKind = new Map();
      for (const w of out.written) byKind.set(w.copy.kind, (byKind.get(w.copy.kind) || 0) + 1);
      finishJob(job, 'done', {
        root: out.root,
        files: items.length,
        written: out.written.length,
        byKind: [...byKind].sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({ kind, label: t(kind), count })),
        failed: out.failed.map((f) => ({ rel: f.rel.join('/'), error: f.error })),
      });
    } catch (e) {
      finishJob(job, 'failed', { error: e.message });
    } finally {
      writeDone();
    }
  }

  // ---- what a request asks for ---------------------------------------------------------------

  function text(v, what) {
    if (v == null || v === '') return undefined;
    if (typeof v !== 'string' || v.length > 32000 || v.includes('\0')) throw fail(400, t('{0} must be text.', what));
    return v;
  }

  function list(v, what) {
    if (v == null) return undefined;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw fail(400, t('{0} must be a list of names.', what));
    return v.length ? v : undefined;
  }

  /**
   * The places a search starts from: the server's own, with what the request adds, git's widened
   * to the usual folders (gitPlaces), and `extra`: { git: [folders to look for repositories in],
   * walk: [folders to walk inside shadow copies, as vss=walk=<folder>] }.
   */
  function locationsFor(given, extra = {}) {
    if (given != null && (typeof given !== 'object' || Array.isArray(given))) {
      throw fail(400, t('Give the places as {0}.', '{ "discover": true, "dirs": { "<source>": ["<place>"] } }'));
    }
    const g = given || {};
    const discover = g.discover === undefined ? base.discover !== false : !!g.discover;
    // No prototype: "__proto__" or "constructor" is a key like any other, and search() refuses it.
    const dirs = Object.create(null);
    for (const from of [base.dirs, g.dirs]) {
      if (from == null) continue;
      if (typeof from !== 'object' || Array.isArray(from)) {
        throw fail(400, t('Give the places as {0}.', '{ "<source>": ["<place>"] }'));
      }
      for (const id of Object.keys(from)) {
        const places = [].concat(from[id]);
        if (!places.every((x) => typeof x === 'string' && x.trim())) throw fail(400, t('Give a place for {0}.', id));
        dirs[id] = (dirs[id] || []).concat(places);
      }
    }
    // Folders differ by case alone only where the file system tells case apart, which Windows' does not.
    const key = (p) => (prober.platform === 'win32' ? p.toLowerCase() : p);
    const add = (id, places) => {
      const have = dirs[id] || [];
      const fresh = places.filter((p) => !have.some((q) => key(q) === key(p)));
      if (fresh.length) dirs[id] = [...have, ...fresh];
    };
    // A git place given replaces the folder git looks in by default (locations.js), so this
    // machine's usual ones are added to it rather than left out: a repository on another disk,
    // added in the page, is searched as well as the user's own, not instead of them.
    if (discover && defaultGit.length) add(dirs.repos && !dirs.git ? 'repos' : 'git', defaultGit);
    if (extra.git && extra.git.length) add(dirs.repos && !dirs.git ? 'repos' : 'git', extra.git);
    if (extra.walk && extra.walk.length) add('vss', extra.walk.map((f) => 'walk=' + f));
    return { ...base, discover, dirs };
  }

  /** Whether a path can be looked at here: a Windows one on Windows, a POSIX one elsewhere. */
  const local = (p) => typeof p === 'string' && (prober.platform === 'win32' ? /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]/.test(p) : p.startsWith('/'));

  /**
   * The nearest folder at or above `p` that exists; null for none, for a drive that does not
   * answer, and for a path of another kind of system.
   */
  async function nearestFolder(p) {
    if (!local(p)) return null;
    let at = P.resolve(p);
    const root = P.parse(at).root;
    for (let i = 0; i < 64; i++) {
      const r = await prober.look(root, () => prober.fsp.stat(at));
      if (r.value) return r.value.isDirectory() ? at : null;
      if (r.timedOut || !r.error || (r.error.code !== 'ENOENT' && r.error.code !== 'ENOTDIR')) return null;
      const up = P.dirname(at);
      if (up === at) return null;
      at = up;
    }
    return null;
  }

  function searchOptions(body, extra) {
    const types = list(body.types, 'types');
    const known = Array.isArray(api.TYPES) ? api.TYPES : [];
    const unknownTypes = (types || []).filter((x) => !known.includes(x));
    if (unknownTypes.length) throw fail(400, t('Unknown type: {0}. Known: {1}', unknownTypes.join(', '), known.join(', ')));
    const sources = list(body.sources, 'sources');
    const unknown = (sources || []).filter((x) => !sourceIds().includes(x));
    if (unknown.length) throw fail(400, t('Unknown source: {0}. Known: {1}', unknown.join(', '), sourceIds().join(', ')));
    let since;
    if (body.since != null) {
      since = Number(body.since);
      if (typeof body.since !== 'number' || !Number.isFinite(since)) throw fail(400, t('Give since as a time in milliseconds.'));
    }
    // Pictures and videos are mostly kept in Pictures and Videos, which shadow copies are not
    // walked in otherwise.
    const media = !!types && types.some((x) => x === 'image' || x === 'video');
    const walk = media ? existing([P.join(home, 'Pictures'), P.join(home, 'Videos')]) : [];
    let view = null;
    if (body.view != null) {
      const size = typeof body.view === 'object' && !Array.isArray(body.view) ? JSON.stringify(body.view).length : Infinity;
      if (size > VIEW_LIMIT) throw fail(400, t('{0} must be a small object.', 'view'));
      view = body.view;
    }
    return {
      view,
      pattern: text(body.pattern, 'pattern'),
      containing: text(body.containing, 'containing'),
      types,
      sources,
      deletedOnly: !!body.deletedOnly,
      since,
      locations: locationsFor(body.locations, { walk, ...(extra || {}) }),
    };
  }

  function echo(o, extra = {}) {
    return {
      pattern: o.pattern || null, containing: o.containing || null, types: o.types || null, sources: o.sources || null,
      deletedOnly: o.deletedOnly, since: o.since == null ? null : o.since, view: o.view || null, ...extra,
    };
  }

  function jobOr404(id) {
    const job = jobs.get(id);
    if (!job) throw fail(404, t('That search is no longer kept; search again.'));
    return job;
  }

  /** A copy from a search or plan still kept, by its uid. */
  function entryOf(uid) {
    for (const job of jobs.values()) {
      if (job.copies && job.copies.has(uid)) return { job, uid, copy: job.copies.get(uid) };
    }
    return null;
  }

  function entryOr404(uid) {
    const entry = entryOf(uid);
    if (!entry) throw fail(404, t('That copy is no longer kept; search again.'));
    return entry;
  }

  /** The first `n` bytes of a copy, or all of it when it is shorter. */
  async function readHead(c, n = HEAD_BYTES) {
    const stream = await api.openCopy(c, { start: 0, end: n - 1 });
    const parts = [];
    let got = 0;
    try {
      for await (const chunk of stream) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        parts.push(b);
        got += b.length;
        if (got >= n) break;
      }
    } finally {
      stream.destroy();
    }
    return Buffer.concat(parts).subarray(0, n);
  }

  /**
   * A JPEG's own small picture (exifThumbnail), for the grid; 404 when it has none, and the page
   * then reads the photo itself. Its orientation comes as X-Solarljos-Orientation.
   */
  async function serveThumb(req, res, uid) {
    const entry = entryOr404(uid);
    const a = await about(entry);
    let found = null;
    if (a.preview === 'image' && a.ext === '.jpg') {
      try {
        found = exifThumbnail(await readHead(entry.copy, EXIF_BYTES));
      } catch (_) {
        found = null; // unreadable here: the photo itself says why, when the page asks for it
      }
    }
    if (!found) throw fail(404, t('This picture has no small copy of its own.'));
    return send(req, res, 200, found.data, 'image/jpeg', {
      'Content-Disposition': 'inline', 'Content-Security-Policy': COPY_CSP, 'X-Solarljos-Orientation': String(found.orientation),
    });
  }

  /** What a copy's bytes are, and how they may be sent; worked out once per copy. */
  async function about(entry) {
    const { job, uid, copy: c } = entry;
    if (job.about.has(uid)) return job.about.get(uid);
    if (c.isDir) throw fail(409, t('That is a folder; restore it instead.'));
    if (c.gone) throw fail(410, t('Nothing of this copy is left to read.'));
    let head;
    try {
      head = await readHead(c);
    } catch (e) {
      // With the system's code, for the page to say what it means.
      throw Object.assign(fail(e.code === 'ENOENT' ? 410 : 500, t('Could not read this copy: {0}', e.message)), { code: e.code });
    }
    let sniffed = null;
    try {
      sniffed = typeof api.sniff === 'function' ? api.sniff(head) : null;
    } catch (_) {
      sniffed = null;
    }
    const how = previewOf(sniffed, head);
    const a = {
      uid, size: sizeOf(c), type: how.type, preview: how.preview, inline: how.inline,
      mediaType: (sniffed && sniffed.mediaType) || null, ext: (sniffed && sniffed.ext) || null,
    };
    job.about.set(uid, a);
    return a;
  }

  async function serveCopy(req, res, uid) {
    const entry = entryOr404(uid);
    const a = await about(entry);
    const own = {
      'Content-Type': a.type,
      'Content-Disposition': a.inline ? 'inline' : 'attachment',
      'Content-Security-Policy': COPY_CSP,
    };
    const size = a.size;
    if (size == null) {
      // A length not known for sure: the whole copy, as it comes.
      const stream = req.method === 'HEAD' ? null : await api.openCopy(entry.copy, {});
      res.writeHead(200, headers({ ...own, 'Accept-Ranges': 'none' }));
      if (!stream) return res.end();
      return pump(stream, res, null);
    }
    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, headers({ ...own, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 }));
      return res.end();
    }
    const from = range ? range.start : 0;
    const to = range ? range.end : size - 1;
    const length = size ? to - from + 1 : 0;
    const stream = req.method === 'HEAD' || !length ? null : await api.openCopy(entry.copy, { start: from, end: to });
    res.writeHead(range ? 206 : 200, headers({
      ...own,
      'Accept-Ranges': 'bytes',
      'Content-Length': length,
      ...(range ? { 'Content-Range': `bytes ${from}-${to}/${size}` } : {}),
    }));
    if (!stream) return res.end();
    return pump(stream, res, length);
  }

  function uidsOf(v) {
    if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'string' && UID.test(x))) {
      throw fail(400, t('Say which copies, by the uid each result has.'));
    }
    return v;
  }

  /**
   * How many of these copies' originals were on the volume `dev` of the folder checked -- or, where
   * a volume cannot be told, on its drive `root`: writing there may overwrite what is still to be
   * found. A copy read from a drive directly counts as on that drive, found in free space and with
   * no path included (\\.\E:); one read from a whole disk or a device, whose letter cannot be told
   * here, is counted in `onDevice` instead. A path of another kind of system, or none, was on no
   * drive here. Each folder is looked at once; after DIR_LOOKS of them, the drive's root alone decides.
   * @returns {Promise<{ same: number, onDevice: number }>}
   */
  async function sameDrive(copies, dev, root) {
    const devs = new Map();
    let looks = 0;
    const devOf = async (dir) => {
      if (devs.has(dir)) return devs.get(dir);
      if (looks >= DIR_LOOKS) return null;
      looks++;
      const r = await prober.look(P.parse(dir).root, () => prober.fsp.stat(dir, { bigint: true }));
      let got = null;
      if (r.value) {
        got = r.value.dev != null ? String(r.value.dev) : null;
      } else if (r.error && (r.error.code === 'ENOENT' || r.error.code === 'ENOTDIR')) {
        const up = P.dirname(dir);
        got = up === dir ? null : await devOf(up);
      }
      devs.set(dir, got);
      return got;
    };
    let n = 0;
    let onDevice = 0;
    for (const c of copies) {
      if (!c) continue;
      const place = c.extent && typeof c.extent.place === 'string' ? c.extent.place : null;
      let where = c.path;
      if (place && prober.platform === 'win32') {
        const letter = /^\\\\[.?]\\([A-Za-z]):$/.exec(place);
        if (letter) {
          where = `${letter[1].toUpperCase()}:\\`;
        } else if (/^\\\\[.?]\\/.test(place)) {
          onDevice++;
          continue;
        }
      } else if (place && place.startsWith('/dev/')) {
        onDevice++;
        continue;
      }
      if (!local(where)) continue;
      const at = P.resolve(where);
      const d = dev != null ? await devOf(c.path === where ? P.dirname(at) : at) : null;
      if (d != null ? d === dev : P.parse(at).root.toLowerCase() === root.toLowerCase()) n++;
    }
    return { same: n, onDevice };
  }

  /**
   * Why the library would refuse to write into `dir`, with the places `locations` names -- a
   * search's own; undefined for this machine's -- or null. Kept for the run (see the top of this file).
   */
  function refusal(dir, locations) {
    if (typeof api.checkDestination !== 'function') return Promise.resolve(null);
    if (locations && !placeIds.has(locations)) placeIds.set(locations, ++placeSeq);
    const key = `${locations ? placeIds.get(locations) : 0}\0${dir}`;
    if (!refusals.has(key)) {
      if (refusals.size >= REFUSALS_KEPT) refusals.clear();
      refusals.set(key, Promise.resolve()
        .then(() => api.checkDestination(dir, locations || undefined))
        .then(() => null, (e) => e.message));
    }
    return refusals.get(key);
  }

  /** The places of the search or plan that finished last, for a folder checked with no copy in view. */
  function latestPlaces() {
    let last = null;
    for (const job of jobs.values()) if (job.locations && (!last || Number(job.id) > Number(last.id))) last = job;
    return last ? last.locations : undefined;
  }

  /**
   * Refuses, as a restore would, a folder inside the places the search read copies from; said
   * before anything is written, rather than once for every copy. Writes nothing.
   */
  async function refuseInside(dir, locations) {
    const why = await refusal(dir, locations || latestPlaces());
    if (why) throw fail(400, why);
  }

  /** The places the search behind these copies, or this plan, read from. */
  function locationsOf(uids, planId) {
    const plan = planId != null ? jobs.get(String(planId)) : null;
    if (plan && plan.locations) return plan.locations;
    for (const uid of Array.isArray(uids) ? uids : []) {
      const entry = typeof uid === 'string' ? entryOf(uid) : null;
      if (entry) return entry.job.locations;
    }
    return null;
  }

  async function restore(req, res, body) {
    const uids = uidsOf(body.uids);
    const folder = await checkFolder(body.to, prober, { elevated });
    await refuseInside(folder.path, locationsOf(uids));
    const results = [];
    writeStarted();
    try {
      for (const uid of uids) {
        const entry = entryOf(uid);
        if (!entry) {
          results.push({ uid, ok: false, error: t('That copy is no longer kept; search again.') });
        } else {
          try {
            const target = await api.restoreCopy(entry.copy, folder.path, entry.job.locations);
            results.push({ uid, ok: true, path: target });
          } catch (e) {
            results.push({ uid, ok: false, error: e.message, code: e.code || null });
          }
        }
        if (uids.length > 1) emit('restore-progress', { done: results.length, total: uids.length });
      }
    } finally {
      // Counted as writing until the answer has left: a stop that waited for this write would
      // otherwise close the connection before the page learns where the copies went.
      if (res.destroyed) writeDone();
      else res.once('close', writeDone);
    }
    return reply(req, res, 200, {
      to: folder.path, written: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results,
    });
  }

  async function route(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    let r;
    if (m === 'GET' && p === '/api/info') {
      return reply(req, res, 200, {
        version,
        platform: process.platform,
        elevated,
        program,
        window: windowHow,
        home,
        systemDrive: process.platform === 'win32' ? String(process.env.SystemDrive || 'C:').slice(0, 2) + '\\' : '/',
        runsFrom: program ? path.parse(process.execPath).root : null,
        types: Array.isArray(api.TYPES) ? api.TYPES : [],
        frozen,
        writing,
      });
    }
    if (m === 'GET' && p === '/api/sources') {
      const sources = (api.sources || []).map((s) => ({
        id: s.id, label: t(s.label), media: s.media !== false, needsAdmin: !!s.needsAdmin,
      }));
      return reply(req, res, 200, { sources, elevated });
    }
    if (m === 'GET' && p === '/api/sources/describe') {
      const ids = (url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
      const out = await api.describeSources({ locations: locationsFor(null), sources: ids.length ? ids : undefined });
      return reply(req, res, 200, { sources: out.map((g) => ({ id: g.id, label: t(g.label), lines: g.lines })) });
    }
    if (m === 'GET' && p === '/api/drives') return reply(req, res, 200, await prober.drives());
    if (m === 'GET' && (r = /^\/api\/job\/([0-9]+)$/.exec(p))) return reply(req, res, 200, snapshot(jobOr404(r[1])));
    if (m === 'GET' && (r = /^\/api\/job\/([0-9]+)\/items$/.exec(p))) {
      const job = jobOr404(r[1]);
      const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset'), 10) || 0);
      const limit = Math.min(PAGE_LIMIT, Math.max(1, Number.parseInt(url.searchParams.get('limit'), 10) || BATCH));
      const items = job.items || [];
      return reply(req, res, 200, {
        job: job.id, offset, total: job.items ? items.length : null, items: items.slice(offset, offset + limit),
      });
    }
    if (/^\/api\/copy\/[0-9a-f]{32}(\/thumb)?$/.test(p)) {
      const dest = req.headers['sec-fetch-dest'];
      if (dest !== undefined && !COPY_DESTS.has(dest)) {
        return refuse(req, res, 403, t('A copy is not shown on its own page, where the browser would offer to save it; '
          + 'use Restore to keep it.'));
      }
    }
    if ((m === 'GET' || m === 'HEAD') && (r = /^\/api\/copy\/([0-9a-f]{32})$/.exec(p))) return serveCopy(req, res, r[1]);
    if (m === 'GET' && (r = /^\/api\/copy\/([0-9a-f]{32})\/about$/.exec(p))) {
      return reply(req, res, 200, await about(entryOr404(r[1])));
    }
    if (m === 'GET' && (r = /^\/api\/copy\/([0-9a-f]{32})\/thumb$/.exec(p))) return serveThumb(req, res, r[1]);
    if (m !== 'POST') {
      if (m === 'HEAD' || !/^\/api\/(search|plan|cancel|check-folder|restore|rebuild|bye|quit)$/.test(p)) {
        return refuse(req, res, 404, t('Not found.'));
      }
      return refuse(req, res, 405, t('Not allowed.'), { Allow: 'POST' });
    }

    if (p === '/api/bye') {
      // navigator.sendBeacon on pagehide: no JSON to read, and nothing to answer.
      req.resume();
      byeAt = Date.now();
      if (!streams.size) armExit(byeWait(), t('its window was closed'));
      res.writeHead(204, headers());
      return res.end();
    }
    const body = await readJson(req);
    switch (p) {
      case '/api/search': {
        const o = searchOptions(body);
        if (!o.pattern && !o.containing && !o.types) {
          throw fail(400, t('Give a name to look for, a word it contained, or the kinds of file to find.'));
        }
        const running = finding();
        if (running) return reply(req, res, 409, { error: t('A search is still running; stop it first.'), job: running.id });
        const job = newJob('search', echo(o), o.sources || sourceIds());
        queue(job, () => runSearch(job, o));
        return reply(req, res, 202, { job: snapshot(job) });
      }
      case '/api/plan': {
        const typed = text(body.folder, 'folder');
        const folder = typed && unquote(typed);
        if (!folder || !(/^[A-Za-z]:([\\/]|$)/.test(folder) || /^[\\/]/.test(folder))) {
          throw fail(400, t('Give the folder as it was, with its whole path, such as C:\\work\\app.'));
        }
        // Its repository may be the folder itself, deleted, or one it was in: git looks from the
        // nearest folder of it that is still there.
        const near = await nearestFolder(folder);
        const o = searchOptions({ ...body, pattern: undefined, containing: undefined }, { git: near ? [near] : [] });
        const running = finding();
        if (running) return reply(req, res, 409, { error: t('A search is still running; stop it first.'), job: running.id });
        const job = newJob('plan', echo(o, { folder }), o.sources || sourceIds());
        queue(job, () => runPlan(job, folder, o));
        return reply(req, res, 202, { job: snapshot(job) });
      }
      case '/api/cancel': {
        const job = jobOr404(String(body.job));
        if (job.kind === 'rebuild') {
          throw fail(409, t('A folder being written is not stopped halfway; it finishes on its own.'));
        }
        if (job.state === 'running') {
          job.abort.abort();
          finishJob(job, 'cancelled');
        }
        return reply(req, res, 200, { job: snapshot(job) });
      }
      case '/api/check-folder': {
        try {
          const folder = await checkFolder(body.to, prober, { elevated });
          await refuseInside(folder.path, locationsOf(body.uids, body.plan));
          // The copies to be written: those named, or the plan's files.
          const planJob = body.plan != null ? jobs.get(String(body.plan)) : null;
          let copies = null;
          if (planJob && planJob.plan) copies = planJob.plan.map((item) => item.copy);
          else if (Array.isArray(body.uids)) copies = body.uids.map((uid) => (typeof uid === 'string' ? entryOf(uid) : null)).filter(Boolean).map((e) => e.copy);
          const on = copies ? await sameDrive(copies, folder.dev, folder.root) : null;
          return reply(req, res, 200, {
            ok: true, path: folder.path, root: folder.root, exists: folder.exists, free: folder.free,
            sameDrive: on ? on.same : null, onDevice: on ? on.onDevice : null,
          });
        } catch (e) {
          if (e.status !== 400) throw e;
          return reply(req, res, 200, { ok: false, error: e.message });
        }
      }
      case '/api/restore':
        return restore(req, res, body);
      case '/api/rebuild': {
        const plan = jobOr404(String(body.plan));
        if (plan.kind !== 'plan' || plan.state !== 'done') throw fail(409, t('That plan is not ready.'));
        if ([...jobs.values()].some((j) => j.kind === 'rebuild' && j.state === 'running')) {
          throw fail(409, t('A folder is still being written; wait for it to finish.'));
        }
        // Unticked files stay out; files the plan left out come in only when asked for by name.
        const exclude = new Set(list(body.exclude, 'exclude') || []);
        const include = new Set(list(body.include, 'include') || []);
        const items = plan.plan
          .filter((item) => (item.leftOut ? include.has(item.rel.join('/')) : !exclude.has(item.rel.join('/'))))
          .map(({ rel, copy }) => ({ rel, copy }));
        if (!items.length) throw fail(400, t('Nothing is left to write: every file was left out.'));
        const folder = await checkFolder(body.to, prober, { elevated });
        await refuseInside(folder.path, plan.locations);
        const job = newJob('rebuild', { plan: plan.id, folder: plan.folder, to: folder.path, files: items.length }, []);
        runRebuild(job, plan, items, folder.path);
        return reply(req, res, 202, { job: snapshot(job) });
      }
      case '/api/quit':
        // Once the answer has left: stopping closes every connection, this one included.
        res.once('close', () => requestStop(t('asked to quit'), true));
        return reply(req, res, 200, { writing });
      default:
        return refuse(req, res, 404, t('Not found.'));
    }
  }

  // ---- starting --------------------------------------------------------------------------------

  await new Promise((resolve, reject) => {
    server.once('error', (e) => {
      const err = new Error(t('Could not listen on {0} port {1}: {2}', host, port, e.message));
      err.usage = e.code === 'EADDRINUSE' || e.code === 'EACCES';
      reject(err);
    });
    server.listen({ host, port, exclusive: true }, resolve);
  });
  server.on('error', (e) => log(t('The server reported: {0}', e.message)));
  const bound = server.address().port;
  hostHeader = `${host.includes(':') ? `[${host}]` : host}:${bound}`;
  origin = `http://${hostHeader}`;
  cookieName = `solarljos-${bound}`;
  const url = `${origin}/?k=${token}`;

  if (typeof api.freeze === 'function') {
    // Before any window: a browser, or Explorer, may change these the moment it starts.
    log(t('Reading what changes on its own, such as the thumbnail cache, before a window opens...'));
    const at = Date.now();
    try {
      // [{ id, label, error? }]: each source that read something ahead.
      const read = await api.freeze({ locations: locationsFor(null) });
      const sources = (Array.isArray(read) ? read : []).map((s) => ({
        id: s.id, label: t(String(s.label || s.id)), error: s.error || null,
      }));
      frozen = { at, ms: Date.now() - at, error: null, sources };
      for (const s of sources) if (s.error) log(t('{0} could not be read ahead: {1}', s.label, s.error));
    } catch (e) {
      frozen = { at, ms: Date.now() - at, error: e.message, sources: [] };
      log(t('Could not read them ahead: {0}', e.message));
    }
  }
  // The drives are looked at now, so that the list is there when the page first asks for it.
  prober.drives().catch(() => {});

  if (exitProcess) {
    const onSignal = (signal) => {
      requestStop(signal === 'SIGHUP' ? t('its console was closed') : t('it was interrupted'), true);
      // A write still running after this long is cut: Windows kills the process soon after SIGHUP.
      setTimeout(() => shutdown(t('it was interrupted')), SIGNAL_WAIT_MS).unref();
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(signal, onSignal);
      signalHandlers.push([signal, onSignal]);
    }
  }
  pinger = setInterval(() => {
    for (const res of streams) res.write(': ping\n\n');
  }, PING_MS);
  pinger.unref();

  // Said here, for the command line leaves the telling to the server: where it is, then how its
  // window opened and how it stops (launch.js).
  log(t('Solarljos is running at {0}', url));
  armExit(idle.first, t('no window connected'));
  try {
    const opened = await openWindow(url, { open: opts.open === undefined ? true : opts.open, elevated, log });
    windowHow = (opened && opened.how) || 'none';
  } catch (e) {
    log(t('Could not open a window ({0}). Open the address above in a browser.', e.message));
  }
  return { url, close, closed };
}

module.exports = {
  start,
  _internal: {
    parseRange, previewOf, sizeOf, flagsTier, uiCopy, driveProber, checkFolder, gitPlaces, timed, unquote, exifThumbnail,
    PREVIEW, PAGE_CSP, COPY_CSP,
  },
};
