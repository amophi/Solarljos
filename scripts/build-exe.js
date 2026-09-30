'use strict';

// Builds dist/Solarljos.exe: all of Solarljos in one Windows program, the bundle from
// scripts/bundle.js made the main script of a Node single executable application inside a copy
// of the node.exe running this script, and made a GUI program, which opens no console window.
// Nothing is downloaded, and nothing from npm is used.
//
//   node scripts/build-exe.js
//
// It needs Windows and Node 25.5 or later, for `node --build-sea`, which writes the program
// itself; Node 26 is LTS from 2026-10-28. With an older Node it writes the bundle and says what to
// do. The release workflow (.github/workflows/release.yml) builds with the Node version pinned
// there on every v* tag.
//
//   1. The bundle, dist/solarljos.cjs.
//   2. A copy of node.exe without its Authenticode signature. Neither --build-sea nor postject
//      removes it: the certificate table stays named in the header while the file around it
//      changes, which leaves a signature that no longer verifies -- treated worse by security
//      products than none. On node.exe 24.20 and 26.10 it is a 15,688-byte table at the very end
//      of the file, the one place Authenticode puts it, so taking it off is what
//      `signtool remove /s` does: cut the file there and zero the header's entry for it.
//   3. The configuration. The code cache is off: V8's differs from build to build (29,553 bytes
//      differed between two builds of the same source) and saved about 3 ms of a 75 ms start;
//      without it, one commit built with one Node version gives the same exe byte for byte.
//      execArgvExtension "none" keeps NODE_OPTIONS from adding --require or anything else to the
//      program, as it could to node.exe. The page files go in as assets (see bundle.js), from
//      copies made in dist/build when the tree was bundled, so that the exe holds them as they
//      were then, and as the tries compare them, whatever is saved in src/gui meanwhile. The blob
//      keeps an asset's key and bytes, not the file it came from.
//   4. --build-sea, then the header's Subsystem made the Windows GUI's (2) instead of the
//      console's (3), which node.exe has, and only then its checksum made right again: injecting
//      keeps the copy's, which no longer fits, and the Subsystem is among what it sums. Windows
//      checks the checksum only for drivers, but a right one costs nothing. A console program
//      started by Explorer gets a console window of its own, which is all a double-click showed
//      besides the page; a GUI program gets none, nor is it given the console of one it is
//      started from, so what it prints goes nowhere unless its output is sent to a file or a
//      program. src/gui/launch.js says where that was measured and what makes up for it. The
//      Subsystem is read back from the file written, which must say 2.
//   5. The program is tried, with pipes for its output, which a GUI program is handed as any
//      other is: its version, its help, that every source loads (search.js turns one that does
//      not into a source that finds nothing), a search and a restore on a made-up Linux trash,
//      and the graphical front end, opened at the address it prints as a browser would: its
//      page must be index.html itself, byte for byte, not the notice the server shows when the
//      exe lacks its page files; every page file bundle.js lists must come back as its own
//      bytes, those the page fetches itself (lang/*.json, say) as well as those it names; and
//      any other file the page names must come back too. It is started with --no-open, so no
//      browser opens, and never without arguments, which opens a window. It reads what changes
//      on its own, such as the thumbnail cache, before printing the address, as it always does;
//      nothing more. Everything written stays in dist/build.
//   6. dist/Solarljos.exe.sha256 and dist/solarljos.cjs.sha256, as `sha256sum -c` reads them --
//      only once every check passed, so an exe without one beside it is left from a build that
//      failed. release.yml attaches all four to the release.
//
// Measured on Windows 11 with Node 26.10.0, for 0.4.0 -- 35 modules (a bundle of 920,017 bytes)
// and 4 page files: an exe of 106,036,224 bytes -- node.exe's 104,714,056 less its signature, plus
// the bundle and the page -- made and tried in 9.7 s the first time, most of it Defender looking at
// a new 100 MB program and the front end reading the thumbnail cache before it printed its
// address, and in 1.7 s the next. For 0.5.0, with the translations -- 54 modules (2,769,774 bytes,
// the 17 catalogs among them) and 21 page files (17 of them the page's language tables) -- the exe
// is 109,127,680 bytes, made and tried in 11.4 s. The exe names no certificate table, and its checksum is what
// CheckSumMappedFile computes (which gives the one shipped in node.exe 24.20 and 26.10). The
// configuration names every file relative to the project: the blob keeps the main script's name
// as given, and an absolute one put the builder's folder, user name included, into the program.
// So one commit built with one Node version gives the same exe byte for byte in any folder: those
// two builds were made in two folders of different names, and came out with the same SHA-256,
// holding no part of either folder's path. release.yml's claim that a download can be checked by
// building it again rests on this.
//
// The exe is not signed. Windows SmartScreen asks before running a downloaded unsigned program
// ("More info", then "Run anyway"), and Smart App Control, where it is on, blocks it; there
// `node bin/solarljos.js gui` runs the same thing on the signed node.exe.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { bundle, ROOT } = require('./bundle');

const DIST = path.join(ROOT, 'dist');
const WORK = path.join(DIST, 'build');
const EXE = path.join(DIST, 'Solarljos.exe');
const BUNDLE = path.join(DIST, 'solarljos.cjs');
const TIMEOUT = 120000;

// The Subsystem values that matter here (winnt.h): a GUI program, and a console one, as node.exe is.
const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;

// The PE header fields touched here (Microsoft's "PE Format"): the optional header starts 24 bytes
// after "PE\0\0"; CheckSum is at +64 in it, Subsystem at +68, and the data directories follow the
// Windows-specific fields, at +96 in PE32 and +112 in PE32+, with their count just before. The
// fifth directory, the certificate table, is the one whose address is a file offset.
function peHeader(buf) {
  const bad = () => new Error('not a Windows program (no PE header)');
  if (buf.length < 64 || buf.readUInt16LE(0) !== 0x5a4d) throw bad();
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 + 112 + 5 * 8 > buf.length || buf.readUInt32LE(pe) !== 0x4550) throw bad();
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  if (magic !== 0x10b && magic !== 0x20b) throw bad();
  const plus = magic === 0x20b;
  const dirs = buf.readUInt32LE(opt + (plus ? 108 : 92));
  return {
    checksumAt: opt + 64,
    subsystemAt: opt + 68,
    subsystem: buf.readUInt16LE(opt + 68),
    certAt: dirs > 4 ? opt + (plus ? 112 : 96) + 4 * 8 : -1,
  };
}

/** The certificate table's offset and size; 0 and 0 when there is none. */
function certificate(buf, h = peHeader(buf)) {
  if (h.certAt < 0) return { at: 0, size: 0 };
  return { at: buf.readUInt32LE(h.certAt), size: buf.readUInt32LE(h.certAt + 4) };
}

/**
 * The PE checksum, as ImageHlp's CheckSumMappedFile computes it: the file as 16-bit words, the
 * CheckSum field counted as 0, added with the carries folded back in, plus the file's length.
 * The sum stays below 2^53 for any file under 256 TB, so it is folded once at the end.
 */
function peChecksum(buf, h = peHeader(buf)) {
  let sum = 0;
  const end = buf.length - (buf.length & 1);
  for (let i = 0; i < end; i += 2) sum += buf[i] | (buf[i + 1] << 8);
  if (buf.length & 1) sum += buf[buf.length - 1];
  for (let p = h.checksumAt; p < h.checksumAt + 4; p++) sum -= buf[p] * (p & 1 ? 0x100 : 1);
  while (sum > 0xffff) sum = (sum % 0x10000) + Math.floor(sum / 0x10000);
  return (sum + buf.length) >>> 0;
}

/** A copy of a PE file without its certificate table, with its checksum made right. */
function withoutSignature(buf) {
  const h = peHeader(buf);
  const cert = certificate(buf, h);
  const signed = cert.at !== 0 || cert.size !== 0;
  if (signed && cert.at + cert.size !== buf.length) {
    throw new Error(`The certificate table (${cert.size} bytes at ${cert.at}) is not at the end of the file; `
      + 'refusing to cut it off.');
  }
  const out = Buffer.from(buf.subarray(0, signed ? cert.at : buf.length));
  if (signed) {
    out.writeUInt32LE(0, h.certAt);
    out.writeUInt32LE(0, h.certAt + 4);
  }
  out.writeUInt32LE(peChecksum(out, h), h.checksumAt);
  return { data: out, removed: signed ? cert.size : 0 };
}

/**
 * A copy of a PE file with its Subsystem set -- IMAGE_SUBSYSTEM_WINDOWS_GUI, say -- and then its
 * checksum made right, since the field is among what it sums.
 */
function setSubsystem(buf, subsystem) {
  if (!Number.isInteger(subsystem) || subsystem < 1 || subsystem > 0xffff) {
    throw new RangeError(`A PE Subsystem is a number from 1 to 65535, not ${subsystem}`);
  }
  const h = peHeader(buf);
  const out = Buffer.from(buf);
  out.writeUInt16LE(subsystem, h.subsystemAt);
  out.writeUInt32LE(peChecksum(out, h), h.checksumAt);
  return out;
}

function stop(message) {
  const e = new Error(message);
  e.stop = true;
  return e;
}

/** Runs the built program from an empty folder of its own, so git looks at nothing but this project. */
function tryExe(args) {
  const r = spawnSync(EXE, args, { cwd: path.join(WORK, 'run'), encoding: 'utf8', timeout: TIMEOUT, windowsHide: true });
  if (r.error) throw new Error(`Solarljos.exe ${args.join(' ')}: ${r.error.message}`);
  return r;
}

function check(ok, what, r) {
  if (!ok) throw new Error(`Solarljos.exe failed a check: ${what}${r ? `\n--- exit ${r.status}\n${r.stdout}${r.stderr}` : ''}`);
}

/**
 * A GET as a browser's first visit makes it, with the cookies set so far (`jar`) and no Origin
 * or Sec-Fetch-Site, so the server's own guards decide.
 */
function get(url, jar) {
  return new Promise((resolve, reject) => {
    const headers = jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {};
    const req = http.get(url, { agent: false, timeout: 30000, headers }, (res) => {
      for (const c of [].concat(res.headers['set-cookie'] || [])) {
        const pair = c.split(';')[0];
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({
        status: res.statusCode, type: res.headers['content-type'] || '', location: res.headers.location, body: Buffer.concat(chunks),
      }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from ${url}`)));
    req.on('error', reject);
  });
}

/** get(), following redirects on the same origin, as the address with its one-time key is. */
async function visit(url, jar) {
  let at = new URL(url);
  for (let hops = 0; hops < 5; hops++) {
    const r = await get(at.href, jar);
    if (r.status < 300 || r.status > 399 || !r.location) return { ...r, url: at };
    const next = new URL(r.location, at);
    check(next.origin === at.origin, `the page sends the browser to ${next.origin}`);
    at = next;
  }
  throw new Error(`Solarljos.exe failed a check: ${url} redirects more than 5 times`);
}

/**
 * Starts the front end with --no-open, takes the address it prints, and opens it as a browser
 * would: the page must be src/gui/<folder>/index.html itself, not the notice the server gives
 * when the exe lacks it; every page file must come back by its key as its own bytes, whether the
 * page names it or fetches it itself; and every other file the page names by a relative address
 * must come back too. The process is ended afterwards either way.
 * @param {{ key: string, file: string, bytes: Buffer }[]} pages   as they went into the exe
 * @returns {Promise<{ pages: number, named: number }>}  how many page files, and how many files the page names
 */
async function tryGui(pages) {
  const index = pages.find((p) => p.key === 'index.html');
  check(index, 'there is no page to serve: no index.html below src/gui');
  const child = spawn(EXE, ['gui', '--no-open'], { cwd: path.join(WORK, 'run'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let said = '';
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`gui --no-open printed no address in ${TIMEOUT / 1000} s:\n${said}`)), TIMEOUT);
      const look = (d) => {
        said += d;
        const m = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/[^\s'"<>]*/.exec(said);
        if (m) {
          clearTimeout(timer);
          resolve(m[0].replace(/[).,;]+$/, ''));
        }
      };
      child.stdout.setEncoding('utf8').on('data', look);
      child.stderr.setEncoding('utf8').on('data', look);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`gui --no-open ended (exit ${code}) before printing an address:\n${said}`));
      });
    });
    const jar = new Map();
    const page = await visit(url, jar);
    check(page.status === 200 && /text\/html/.test(page.type) && page.body.equals(index.bytes),
      `gui: the page served (${page.status}, ${page.type}, ${page.body.length} bytes) is not ${index.file}`);
    // Every page file by its key, as the server serves it below /: the page fetches some of them
    // itself, which it does not name in its HTML.
    for (const p of pages) {
      const at = new URL(p.key.split('/').map(encodeURIComponent).join('/'), page.url.origin + '/');
      const r = await get(at.href, jar);
      check(r.status === 200 && r.body.equals(p.bytes),
        `gui: the page file ${p.key} came back ${r.status}, ${r.body.length} bytes, not the ${p.bytes.length} bytes of ${p.file}`);
    }
    const own = new Set(pages.map((p) => p.key));
    const names = [...new Set([...page.body.toString('utf8').matchAll(/\b(?:src|href)\s*=\s*["']([^"'#?]+)/g)]
      .map((m) => m[1]).filter((ref) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)))];
    for (const ref of names) {
      const at = new URL(ref, page.url);
      check(at.origin === page.url.origin, `gui: the page names ${ref} on another origin`);
      if (own.has(decodeURIComponent(at.pathname.slice(1)))) continue; // came back above, as its own bytes
      const r = await get(at.href, jar);
      check(r.status === 200 && r.body.length > 0, `gui: ${ref} came back ${r.status}, ${r.body.length} bytes`);
    }
    return { pages: pages.length, named: names.length };
  } finally {
    child.kill();
  }
}

/** A Linux trash holding one deleted file, for a search and a restore that read nothing real. */
function makeTrash() {
  const trash = path.join(WORK, 'fixture', 'Trash');
  fs.mkdirSync(path.join(trash, 'files'), { recursive: true });
  fs.mkdirSync(path.join(trash, 'info'), { recursive: true });
  const text = 'Solarljos.exe smoke test\n';
  fs.writeFileSync(path.join(trash, 'files', 'smoke-test.txt'), text);
  fs.writeFileSync(path.join(trash, 'info', 'smoke-test.txt.trashinfo'),
    '[Trash Info]\nPath=/home/solarljos/smoke-test.txt\nDeletionDate=2026-09-01T12:00:00\n');
  return { trash, text };
}

async function tryAll(pkg, pages) {
  const version = tryExe(['--version']);
  check(version.status === 0 && version.stdout.trim() === pkg.version, `--version says "${version.stdout.trim()}", package.json ${pkg.version}`, version);
  const help = tryExe(['--help']);
  check(help.status === 0 && help.stdout.length > 200, '--help', help);
  const sources = tryExe(['sources', '--no-discover']);
  check(sources.status === 0 && !/Could not be loaded/i.test(sources.stdout + sources.stderr), 'every source loads', sources);

  const { trash, text } = makeTrash();
  const where = ['--source', 'trash', '--no-discover', '--location', `trash=${trash}`];
  const find = tryExe(['find', 'smoke-test.txt', ...where, '--json']);
  let results = [];
  try {
    results = JSON.parse(find.stdout).results;
  } catch (_) {
    results = [];
  }
  check(find.status === 0 && results.length === 1 && results[0].path === '/home/solarljos/smoke-test.txt', 'find --json on a trash', find);
  const to = path.join(WORK, 'restored');
  const restore = tryExe(['restore', 'smoke-test.txt', results[0].id, ...where, '--to', to]);
  const back = fs.existsSync(to) ? fs.readdirSync(to) : [];
  check(restore.status === 0 && back.length === 1 && fs.readFileSync(path.join(to, back[0]), 'utf8') === text,
    `restore wrote ${JSON.stringify(back)}`, restore);

  return tryGui(pages);
}

const sha256Of = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function build() {
  const started = Date.now();
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (process.platform !== 'win32') {
    throw stop('Solarljos.exe is built on Windows, from the node.exe that runs this script. '
      + 'Push a v* tag and .github/workflows/release.yml builds it on GitHub.');
  }

  // An exe from an earlier build must not sit beside a newer bundle when this one stops short.
  for (const f of [EXE, `${EXE}.sha256`, `${BUNDLE}.sha256`]) fs.rmSync(f, { force: true });
  const bundled = bundle();
  const { code, modules } = bundled;
  // The page files' bytes as the modules were read: what goes into the exe, and what it must serve.
  const pages = bundled.pages.map((p) => ({ ...p, bytes: fs.readFileSync(p.file) }));
  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(BUNDLE, code);
  console.log(`bundle   ${modules.length} modules, ${pages.length} page file(s), ${Buffer.byteLength(code)} bytes -> ${BUNDLE}`);

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 25 || (major === 25 && minor < 5)) {
    throw stop(`Node ${process.versions.node} has no --build-sea (it came in Node 25.5), so Solarljos.exe was not built.\n`
      + `Run this again with Node 26 from https://nodejs.org, or push a v* tag: .github/workflows/release.yml\n`
      + `builds it on GitHub with the Node version pinned there. The bundle alone runs with any Node 22 or later:\n`
      + `  node "${BUNDLE}" --help`);
  }

  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK, 'run'), { recursive: true });
  for (const p of pages) {
    p.copy = path.join(WORK, 'pages', ...p.key.split('/'));
    fs.mkdirSync(path.dirname(p.copy), { recursive: true });
    fs.writeFileSync(p.copy, p.bytes);
  }
  const node = path.join(WORK, 'node.exe');
  const unsigned = withoutSignature(fs.readFileSync(process.execPath));
  fs.writeFileSync(node, unsigned.data);
  console.log(`node     ${process.execPath}, Node ${process.versions.node}: ${unsigned.removed} signature bytes taken off`);

  // Every path relative to the project, which --build-sea runs in: the blob keeps the name of
  // the main script, and an absolute one would carry the builder's folder -- and user name --
  // into the program, and make builds in two folders differ.
  const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
  const config = {
    main: rel(BUNDLE),
    output: rel(EXE),
    executable: rel(node),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
    execArgv: [],
    execArgvExtension: 'none',
    assets: Object.fromEntries(pages.map((p) => [p.key, rel(p.copy)])),
  };
  const configFile = path.join(WORK, 'sea-config.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  const sea = spawnSync(process.execPath, ['--build-sea', configFile], { cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT });
  if (sea.error || sea.status !== 0 || !fs.existsSync(EXE)) {
    throw new Error(`node --build-sea failed: ${sea.error ? sea.error.message : `exit ${sea.status}`}\n${sea.stdout || ''}${sea.stderr || ''}`);
  }

  const built = fs.readFileSync(EXE);
  const h = peHeader(built);
  const cert = certificate(built, h);
  if (cert.at || cert.size) throw new Error(`Solarljos.exe names a certificate table (${cert.size} bytes at ${cert.at}); it would not verify.`);
  if (h.subsystem !== IMAGE_SUBSYSTEM_WINDOWS_CUI) {
    throw new Error(`--build-sea made a program of PE subsystem ${h.subsystem}, not a copy of node.exe, `
      + `a console program (${IMAGE_SUBSYSTEM_WINDOWS_CUI}).`);
  }
  fs.writeFileSync(EXE, setSubsystem(built, IMAGE_SUBSYSTEM_WINDOWS_GUI));
  // What is on disk, read back: a GUI program, its checksum right.
  const exe = fs.readFileSync(EXE);
  const w = peHeader(exe);
  if (w.subsystem !== IMAGE_SUBSYSTEM_WINDOWS_GUI || exe.readUInt32LE(w.checksumAt) !== peChecksum(exe, w)) {
    throw new Error(`Solarljos.exe was written as PE subsystem ${w.subsystem}, checksum 0x${exe.readUInt32LE(w.checksumAt).toString(16)}; `
      + `a Windows GUI program (${IMAGE_SUBSYSTEM_WINDOWS_GUI}) with checksum 0x${peChecksum(exe, w).toString(16)} was to be.`);
  }
  const sha256 = sha256Of(exe);
  console.log(`exe      ${exe.length} bytes, a Windows GUI program (PE subsystem ${w.subsystem}) -> ${EXE}`);

  const tried = Date.now();
  const gui = await tryAll(pkg, pages);
  console.log(`tried    --version, --help, sources, find, restore, and gui with its ${gui.pages} page file(s) and the `
    + `${gui.named} file(s) its page names (${((Date.now() - tried) / 1000).toFixed(1)} s)`);

  const bundleSha256 = sha256Of(fs.readFileSync(BUNDLE));
  fs.writeFileSync(`${EXE}.sha256`, `${sha256}  ${path.basename(EXE)}\n`);
  fs.writeFileSync(`${BUNDLE}.sha256`, `${bundleSha256}  ${path.basename(BUNDLE)}\n`);
  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`sha256   ${sha256}  ${path.basename(EXE)}`);
  console.log(`sha256   ${bundleSha256}  ${path.basename(BUNDLE)}`);
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

if (require.main === module) {
  build().catch((e) => {
    console.error(e.stop ? e.message : (e.stack || String(e)));
    process.exitCode = 1;
  });
}

module.exports = {
  peHeader, certificate, peChecksum, withoutSignature, setSubsystem, IMAGE_SUBSYSTEM_WINDOWS_GUI, IMAGE_SUBSYSTEM_WINDOWS_CUI,
};
