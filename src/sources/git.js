'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { t } = require('../i18n');
const { HASH_LIMIT, blobHash } = require('../content');
const { pathKey } = require('../paths');

// A file deleted from a git working tree usually still exists inside .git:
//
//   deleted from disk, still in the index    `git ls-files --deleted`, read by the blob id
//                                            `git ls-files -s` lists for it
//   committed, then deleted or changed       every version in `git log --all --reflog`
//   committed, then lost to reset --hard     the reflog still names the commit
//   stashed, staged or not                   a stash is a merge commit; the work is in its
//                                            diff against its first parent
//   staged once, never committed             an unreachable blob; no name survives, so it is
//                                            only offered to a search by content
//
// The log is read with `git log -z --raw --no-abbrev`, which gives every change's modes and blob
// ids, so no version is looked up by <commit>:<path>. A pattern narrows it with a pathspec made
// from the pattern's literal. git then simplifies history and follows only one side of a merge
// that left the path as it was, so --full-history is added: otherwise a version kept only on a
// merged branch would be found by * and not by its name. In a fresh clone of such a branch,
// git 2.55 lists 2 commits for the path without the flag and 4 with it; --diff-merges, below,
// also stops the simplifying there, but git before 2.31 has only --full-history.
//
// The pathspec is left out when the literal is in the repository's own path, since the matcher
// tests the whole path and git only the part inside the repository: rebuilding a repository's
// folder, or one above it, would otherwise find nothing in its history.
//
// Not everything the log names is a file:
//   - git notes (refs/notes/*, walked by --all and again through their reflogs) keep one blob
//     per annotated commit, at a path named after it. Their commits are passed over.
//   - A submodule's entry names a commit, not a blob.
//   - A symbolic link's blob is its target. With core.symlinks=false checkout writes that as a
//     small file, and that file, as stored, is the copy. Otherwise the working tree held a link,
//     which holds no file, and it is skipped.
//   - An entry `git add -N` made holds the empty blob and a flag (0x20000000 in
//     `ls-files --debug`) saying the file was never staged. It is skipped.
// A copy from the index is dated by its entry's mtime: the file's, when git last saw it match the
// blob. The index file's own mtime moves with every add, commit or refresh of any file, so it is
// used only for an entry that has no time recorded (0:0).
//
// A blob is not yet the file. Checkout converts it on the way out -- line endings (core.autocrlf,
// core.eol, the text and eol attributes), ident, working-tree-encoding -- so every copy with a
// path is read through `git cat-file --batch --filters`, which applies the repository's own
// attributes and config the way a checkout would now, and is hashed after that.
//
// That is wrong for a file some other program wrote, with line endings git would not have
// chosen, and committed as it was: git never rewrote it. The index settles it where it can.
// git records the size of a file on disk whenever it sees the file match its blob -- on add,
// checkout, refresh -- and for that blob at that path the size says which form was there. When
// it fits neither (mixed line endings, which git evened out on add), the kind says so.
//
// Measured on this machine, where the system config sets core.autocrlf=true, over the 6
// repositories under Documents\GitHub: of 1,327 files in the index and on disk, the raw blob
// equalled the file byte for byte for 200, the converted one for 1,301, and with the recorded
// size choosing between them, 1,316. The other 11 had been edited since. HEAD gave the same
// counts. Reading every version made a search for * over all six take 4.2 s instead of 1.1 s.
//
// Two things about --batch --filters, as git 2.55 does them: an input line must be
// "<object> <path>" (a bare <rev>:<path> stops it with "missing path"), and the size in each
// header is the blob's, not that of the converted bytes after it. So each request is followed
// by a random name that cannot exist, and the output is cut at the "missing" line git prints
// for that name instead of by size.
//
// No filter program ever runs. Every driver the config names is switched off for the call, one
// with an empty name too ([filter ""], which the attribute filter= selects):
// filter.<name>.smudge= and .process= leave it nothing to run, and .required=false keeps git
// going, since a required driver with nothing to run makes it stop ("smudge filter failed").
// A path under a driver other than Git LFS therefore comes back as git stores it, with line
// endings converted as checkout would, and its kind says so -- whatever its size.
//
// Git LFS leaves only a pointer in the blob, always under 1024 bytes:
//
//   version https://git-lfs.github.com/spec/v1
//   oid sha256:<64 hex>
//   size <bytes>
//
// and keeps the file in <git dir>/lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>, or under lfs.storage.
// A pointer is followed where its path is under filter=lfs, by today's attributes or by those
// of the commit it comes from (`git check-attr --source`, git 2.40 and later), so one whose
// .gitattributes line was deleted with it is still caught. At any other path checkout writes
// the pointer as it is; so does this, under a kind that says so. The object is offered only
// when its size and sha256 are the pointer's; otherwise the copy is listed with nothing to read.
// An object over 32 MB is not read during a search: its size is checked then, its sha256 when
// it is read, and a read that does not match fails rather than return the bytes. None of the
// repositories here has a .git/lfs folder; the tests build one.
//
// An unreachable blob has no path, so nothing says how checkout would convert it: it is offered
// as git stores it, and its kind says so. Blobs over 32 MB are not read during a search; their
// size is git's, before conversion, and they are converted when read.
//
// Nothing here may write, to the repository or anywhere else:
//   - git is run by its absolute path, from the absolute entries of PATH. Given a bare name,
//     Windows looks in the child's working folder before PATH, so a git.exe at the top of a
//     searched repository would run instead. NoDefaultCurrentDirectoryInExePath, which stops
//     that, is read from this process's own environment, is not set on this machine, and does
//     nothing when set for the child only.
//   - GIT_OPTIONAL_LOCKS=0 stops read commands from refreshing the index.
//   - GIT_NO_LAZY_FETCH=1 stops a partial clone (--filter=blob:none) from fetching the versions
//     it lacks, which writes packs into it and reaches its server; they are left out, with a
//     note. git before 2.44 ignores the variable, so there a partial clone is not read at all.
//   - Trace output is switched off through the environment, which overrides trace2.* targets in
//     the system or global config (-c cannot), and inherited GIT_TRACE* variables are dropped.
//   - `git fsck --lost-found`, which writes .git/lost-found, is never run.
// Restore stays out of every folder this reads from: each repository's git folders, its Git LFS
// store, and the object folders it borrows through objects/info/alternates (a clone made with
// --shared or --reference). None of the 6 repositories here is a partial clone or borrows
// objects, none has notes, a stash, a trace2 setting or a .git/lfs folder, and all have
// core.symlinks=false; the tests build each case.

// Variables that tie git to one repository -- those `git rev-parse --local-env-vars` lists, as of
// git 2.55 -- are not passed on. Inherited from a hook, a script or a dotfiles setup, GIT_DIR
// alone makes every folder searched read as that one repository, a plain folder included: with it
// set to one test repository, a search of another listed the first one's files as its own
// deleted files, which a rebuild would write, and none of its own history. The others swap in
// that repository's index, object store or refs. GIT_CONFIG has `git config`, the call
// that finds the filter drivers to switch off, read that one file instead of the repository's
// config, so a driver in .git/config would have run. git drops the same list before it runs a
// command in another repository, a submodule, and keeps, as this does, GIT_CONFIG_PARAMETERS and
// GIT_CONFIG_COUNT: settings given with -c, which hold in every repository and which `git config`
// lists with the rest, so a driver named there is switched off too. Names are matched in any
// case, since git for Windows takes Git_Dir for GIT_DIR.
const TIED = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE',
  'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX']);

// GIT_LFS_SKIP_SMUDGE is a second lock on a door already shut: git-lfs is switched off below
// with every other driver.
function env() {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_TRACE/i.test(k) && !TIED.has(k.toUpperCase())) e[k] = v;
  return Object.assign(e, {
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_TRACE: '0', GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0', GIT_TRACE_PACKET: '0',
    GIT_TRACE_PERFORMANCE: '0', GIT_TRACE_SETUP: '0', GIT_TRACE_PACK_ACCESS: '0',
  });
}
// log.showSignature would have `git log` run gpg, which keeps files of its own up to date.
const CONFIG = [
  '-c', 'core.quotePath=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'gc.auto=0',
  '-c', 'log.showSignature=false',
];
const SKIP_DIRS = new Set(['node_modules', '.git']);

// Git LFS never takes a blob of 1024 bytes or more for a pointer.
const POINTER_MAX = 1024;
// The version line git-lfs accepts: the spec's, and the two names it had before release.
const POINTER_START = new RegExp('^version (?:' + [
  'https://git-lfs.github.com/spec/v1', 'https://hawser.github.com/spec/v1', 'http://git-media.io/v/2',
].map((v) => v.replace(/[./]/g, '\\$&')).join('|') + ')\\r?\\n');
const POINTER = /^version \S+\n((?:ext-\d+-\S+ sha256:[0-9a-f]{64}\n)*)oid sha256:([0-9a-f]{64})\nsize (\d+)\n$/;

// Index and tree modes that are not a regular file, and the flag `git add -N` leaves.
const LINK = '120000';
const GITLINK = '160000';
const INTENT_TO_ADD = 0x20000000;
// git follows alternates files this many levels down, and refuses anything deeper.
const ALT_DEPTH = 5;

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function canRun(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/** The error for no git at all, told apart from a spawn that failed for another reason. */
function noGit() {
  const e = new Error(t('git is not installed'));
  e.code = 'ENOENT';
  e.noGit = true;
  return e;
}

let located = null;

/**
 * The git program, as an absolute path, found once per PATH. Only absolute entries of PATH are
 * looked in, in order, as the system would: git.com, then git.exe, on Windows.
 */
function gitPath() {
  const PATH = process.env.PATH || '';
  if (!located || located.PATH !== PATH) {
    const win = process.platform === 'win32';
    let file = null;
    for (const entry of PATH.split(win ? ';' : ':')) {
      const dir = win ? entry.replace(/^"(.*)"$/, '$1') : entry;
      if (!(win ? /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(dir) : dir.startsWith('/'))) continue;
      file = (win ? ['git.com', 'git.exe'] : ['git']).map((n) => path.join(dir, n))
        .find((p) => isFile(p) && (win || canRun(p))) || null;
      if (file) break;
    }
    located = { PATH, file };
  }
  if (!located.file) throw noGit();
  return located.file;
}

/** Runs git. With `onData` the output is handed over as it comes instead of being kept. */
function run(args, { cwd, input, buffer = false, allowFail = false, onData } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(gitPath(), [...CONFIG, ...args], { cwd, env: env(), windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => (onData ? onData(d) : out.push(d)));
    child.stderr.on('data', (d) => err.push(d));
    // A folder that is gone makes the spawn fail as a missing program would.
    child.on('error', (e) => reject(e.code === 'ENOENT' && cwd && !isDir(cwd) ? new Error(t('{0} is not a folder', cwd)) : e));
    child.on('close', (code) => {
      const data = Buffer.concat(out);
      if (code !== 0 && !allowFail) {
        const e = new Error(Buffer.concat(err).toString().trim() || `git exited with code ${code}`);
        e.exitCode = code;
        reject(e);
        return;
      }
      resolve(buffer ? data : data.toString('utf8'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input === undefined ? '' : input);
  });
}

let version = null;

/** git's version as [major, minor], asked once per program; [0, 0], which counts as old, when it cannot be told. */
function gitVersion() {
  const file = gitPath();
  if (!version || version.file !== file) {
    version = {
      file,
      v: run(['version']).then((out) => {
        const m = /(\d+)\.(\d+)/.exec(out);
        return m ? [Number(m[1]), Number(m[2])] : [0, 0];
      }, () => [0, 0]),
    };
  }
  return version.v;
}

const atLeast = (v, major, minor) => v[0] > major || (v[0] === major && v[1] >= minor);

/**
 * Repositories at or below the given folders, two levels down, plus the one a folder sits in.
 * One reached by two spellings -- another letter case, a link -- is kept once, as first
 * reached, and a folder as given comes before git's own answer, so paths keep its spelling.
 * A place that is not a folder is skipped, with a note in `notes`.
 */
async function discoverRepos(roots, notes) {
  const found = new Map();
  const add = (dir) => {
    const p = path.resolve(dir);
    let real;
    try {
      real = fs.realpathSync.native(p);
    } catch (_) {
      real = p;
    }
    if (!found.has(pathKey(real))) found.set(pathKey(real), p);
  };
  const visit = (dir, depth) => {
    if (fs.existsSync(path.join(dir, '.git'))) add(dir);
    if (depth === 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) visit(path.join(dir, e.name), depth - 1);
    }
  };
  for (const root of roots) {
    if (!isDir(root)) {
      if (notes) notes.push(t('{0} is not a folder, so no repository was looked for there', root));
      continue;
    }
    visit(root, 2);
    try {
      const top = (await run(['rev-parse', '--show-toplevel'], { cwd: root })).trim();
      if (top) add(top);
    } catch (e) {
      if (e.noGit) throw e;
    }
  }
  return [...found.values()];
}

/** Where to look for repositories: --repo, and --location git=<folder>, which means the same. */
function repoRoots(loc) {
  return [...new Set([...(loc.repos || []), ...(loc.git || []).map((p) => path.resolve(p))])];
}

function escapeGlob(s) {
  return s.replace(/[\\[\]*?]/g, '\\$&');
}

/**
 * Narrows `git log` to paths that can match: the literal in a file name or in a folder name.
 * git's icase folds ASCII letters only and compares names byte for byte as stored, while the
 * matcher folds all of Unicode after NFC: 'Übersicht' is 'übersicht' to it and never to git, and
 * a name git keeps decomposed is not its composed form. So every character outside printable
 * ASCII stands for any run, and so do the four ASCII ones something else turns into on that way:
 * i (from İ), k (from the Kelvin sign), ; and ` (from Greek look-alikes). Checked over every
 * code point.
 */
function pathspecs(literal) {
  const pieces = String(literal || '').split(/[^\x20-\x7e]|[ik;`]/).filter(Boolean);
  if (!pieces.length) return [];
  const l = pieces.map(escapeGlob).join('*');
  return [`:(glob,icase)**/*${l}*`, `:(glob,icase)**/*${l}*/**`];
}

/** A git boolean as config lists it: a key with no value is true, an empty one false. */
function isTrue(v) {
  if (v === null) return true;
  if (/^(?:true|yes|on)$/i.test(v)) return true;
  if (/^(?:false|no|off|)$/i.test(v)) return false;
  return Number(v) !== 0;
}

/** A C-quoted string at text[at], as git writes one ("a\tb", "\303\251"): { text, end }, or null if it is not one. */
function unquoteC(text, at) {
  const ESC = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };
  const bytes = [];
  for (let i = at + 1; i < text.length;) {
    const c = String.fromCodePoint(text.codePointAt(i));
    i += c.length;
    if (c === '"') return { text: Buffer.from(bytes).toString('utf8'), end: i };
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
    } else if (text[i] in ESC) {
      bytes.push(ESC[text[i++]]);
    } else if (/^[0-3][0-7]{2}/.test(text.slice(i, i + 3))) {
      bytes.push(parseInt(text.slice(i, i + 3), 8));
      i += 3;
    } else {
      return null;
    }
  }
  return null;
}

/**
 * The entries of an alternates file, read as git reads one: one per line, a leading # for a
 * comment, and a C-quoted entry where it starts with a quote (one that does not unquote is taken
 * as it is). git steps over one character after an entry, the line break.
 */
function altEntries(text) {
  const out = [];
  for (let i = 0; i < text.length;) {
    let entry = '';
    let end;
    const q = text[i] === '"' ? unquoteC(text, i) : null;
    if (q) {
      entry = q.text;
      end = q.end;
    } else {
      end = text.indexOf('\n', i);
      if (end < 0) end = text.length;
      if (text[i] !== '#') entry = text.slice(i, end);
    }
    i = end + 1;
    // A line a Windows editor ended with CR: git would look for a name ending in it.
    entry = entry.replace(/\r$/, '');
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * The object folders a repository reads from besides its own: every one its
 * objects/info/alternates names, a relative one taken from the objects folder that names it, and
 * those theirs name, as deep as git follows them. GIT_OBJECT_DIRECTORY and
 * GIT_ALTERNATE_OBJECT_DIRECTORIES are not passed on to git (see env), so they add none.
 */
function objectDirs(commonDir) {
  const out = [];
  const seen = new Set();
  const follow = (dir, depth) => {
    if (depth > ALT_DEPTH) return;
    let text;
    try {
      text = fs.readFileSync(path.join(dir, 'info', 'alternates'), 'utf8');
    } catch (_) {
      return;
    }
    for (const entry of altEntries(text)) take(path.resolve(dir, entry), depth + 1);
  };
  const take = (dir, depth) => {
    if (seen.has(pathKey(dir))) return;
    seen.add(pathKey(dir));
    out.push(dir);
    follow(dir, depth);
  };
  const objects = path.join(commonDir, 'objects');
  seen.add(pathKey(objects));
  follow(objects, 0);
  return out;
}

/**
 * What reading a repository needs: its git folders, where Git LFS keeps objects, the object
 * folders it borrows, the filter drivers its config names, and the -c settings that switch all
 * of them off. `off` is null when a driver's name cannot be written as -c <key>=<value>; nothing
 * is converted then. `promisor` marks a partial clone; `linksAsText` says core.symlinks is false.
 */
async function openRepo(repo) {
  const [gitDir, common] = (await run(['rev-parse', '--absolute-git-dir', '--git-common-dir'], { cwd: repo })).split('\n');
  const commonDir = path.resolve(repo, (common || gitDir).trim());
  const cfg = await run(['config', '-z', '--get-regexp',
    '^(filter\\..+|lfs\\.storage|core\\.symlinks|extensions\\.partialclone|remote\\..+\\.promisor)$'],
  { cwd: repo, allowFail: true });
  const drivers = new Set();
  let storage = null;
  let links = null;
  let promisor = false;
  for (const entry of cfg.split('\0')) {
    if (!entry) continue;
    const nl = entry.indexOf('\n');
    const key = nl < 0 ? entry : entry.slice(0, nl);
    const value = nl < 0 ? null : entry.slice(nl + 1);
    if (key === 'lfs.storage' && value !== null) storage = value;
    // The last one set wins, as it does for git.
    if (key === 'core.symlinks') links = isTrue(value);
    if (key === 'extensions.partialclone' || (/^remote\..+\.promisor$/.test(key) && isTrue(value))) promisor = true;
    // Section and variable are lowercase in this listing; the driver's name keeps its case. It
    // can be empty: [filter ""] is listed as filter..smudge, and the attribute filter= selects it.
    const m = /^filter\.([\s\S]*)\.[a-z0-9-]+$/.exec(key);
    if (m) drivers.add(m[1]);
  }
  let off = [];
  for (const d of drivers) {
    if (/[=\n]/.test(d)) {
      off = null;
      break;
    }
    off.push('-c', `filter.${d}.smudge=`, '-c', `filter.${d}.process=`, '-c', `filter.${d}.required=false`);
  }
  // git-lfs reads a relative lfs.storage from the repository's (common) git folder.
  const lfsDir = storage ? path.resolve(commonDir, storage) : path.join(commonDir, 'lfs');
  // git's default is true: without the setting, a link was checked out as a link.
  return { gitDir: gitDir.trim(), commonDir, lfsDir, drivers, off, promisor, linksAsText: links === false,
    objectDirs: objectDirs(commonDir) };
}

/** Why a partial clone is not read with a git that cannot be kept from fetching into it. */
async function refusePartial(info) {
  if (info.promisor && !atLeast(await gitVersion(), 2, 44)) {
    throw new Error(t('it is a partial clone, and git before 2.44 cannot be kept from fetching into it what it lacks'));
  }
}

/**
 * Cuts a stream at every `cut` and hands over what came before it, one piece per object.
 * The last cut.length - 1 bytes are held back until the next chunk shows whether a cut
 * starts in them.
 */
function splitter(cut, onPiece) {
  let parts = [];
  let carry = Buffer.alloc(0);
  return (chunk) => {
    let data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    for (let at = data.indexOf(cut); at >= 0; at = data.indexOf(cut)) {
      parts.push(data.subarray(0, at));
      onPiece(parts.length === 1 ? parts[0] : Buffer.concat(parts));
      parts = [];
      data = data.subarray(at + cut.length);
    }
    const hold = Math.min(data.length, cut.length - 1);
    if (data.length > hold) parts.push(data.subarray(0, data.length - hold));
    carry = data.subarray(data.length - hold);
  };
}

/**
 * Reads many blobs in one `git cat-file --batch` call; onObject(i, bytes) is called for each
 * request in order, with null for one that is missing or not a blob. With `filters`, each
 * request is "<object id> <path>" and the bytes are what checkout would write at that path.
 * `config` is put before the command, to switch filter drivers off.
 */
async function catObjects(repo, requests, { filters = false, config = [] }, onObject) {
  if (!requests.length) return;
  const marker = 'solarljos-' + crypto.randomBytes(16).toString('hex');
  let next = 0;
  const piece = (buf) => {
    if (next >= requests.length) return;
    const i = next++;
    // A piece is "<id> blob <size>\n<bytes>", or a single line such as "<name> missing".
    const nl = buf.indexOf(0x0a);
    const m = nl < 0 ? null : /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(buf.subarray(0, nl).toString());
    // The header names the object it answers, and it must be the one asked for.
    if (!m || m[2] !== 'blob' || m[1] !== requests[i].split(' ')[0]) return onObject(i, null);
    const body = buf.subarray(nl + 1);
    // As stored, the header's size is the body's: anything else means the output was misread.
    if (!filters && body.length !== Number(m[3])) return onObject(i, null);
    return onObject(i, body);
  };
  const input = requests.map((r) => `${r}\n${marker}\n`).join('');
  await run([...config, 'cat-file', '--batch', '--buffer', ...(filters ? ['--filters'] : [])],
    { cwd: repo, input, allowFail: true, onData: splitter(Buffer.from(`\n${marker} missing\n`), piece) });
  // git stopped early: what it did not answer is not readable.
  while (next < requests.length) onObject(next++, null);
}

/** Whether git's batch reader gets a path back unchanged: no line break, no leading blank, no final CR. */
function fitsLine(rel) {
  return /^[^ \t\n][^\n]*$/.test(rel) && !rel.endsWith('\r');
}

/**
 * Reads { oid, rel } requests as checkout would write them; onObject(i, bytes or null). A path
 * that does not fit on a batch line is read on its own, with --path.
 */
async function readConverted(repo, off, requests, onObject) {
  const inBatch = [];
  const alone = [];
  requests.forEach((r, i) => (fitsLine(r.rel) ? inBatch : alone).push(i));
  await catObjects(repo, inBatch.map((i) => `${requests[i].oid} ${requests[i].rel}`), { filters: true, config: off },
    (j, body) => onObject(inBatch[j], body));
  for (const i of alone) {
    const { oid, rel } = requests[i];
    let body = null;
    try {
      body = await run([...off, 'cat-file', '--filters', `--path=${rel}`, oid], { cwd: repo, buffer: true });
    } catch (e) {
      if (e.noGit) throw e;
    }
    onObject(i, body);
  }
}

/**
 * The size of each of these objects that is a blob: { objects: Map by id to { sha, size },
 * missing: how many git does not have }. A partial clone lacks some on purpose.
 */
async function batchCheck(repo, ids) {
  const objects = new Map();
  let missing = 0;
  if (!ids.length) return { objects, missing };
  const out = await run(['cat-file', '--batch-check'], { cwd: repo, input: ids.join('\n') + '\n' });
  const lines = out.split('\n');
  ids.forEach((id, i) => {
    const line = lines[i] || '';
    const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(line);
    if (m && m[2] === 'blob' && m[1] === id) objects.set(id, { sha: m[1], size: Number(m[3]) });
    else if (line === `${id} missing`) missing++;
  });
  return { objects, missing };
}

/**
 * A Git LFS pointer: { oid, size, extensions }. { unreadable: true } for a blob that starts
 * like a pointer but is not one this can follow; null for anything else.
 */
function parsePointer(buf) {
  if (!buf || buf.length >= POINTER_MAX) return null;
  const s = buf.toString('utf8');
  if (!POINTER_START.test(s)) return null;
  const m = POINTER.exec(s);
  if (!m) return { unreadable: true };
  const extensions = m[1].split('\n').filter(Boolean).map((l) => l.split(' ')[0].replace(/^ext-\d+-/, ''));
  return { oid: m[2], size: Number(m[3]), extensions };
}

/** Which of these blobs are Git LFS pointers. Only small blobs are read: a pointer is under 1 KB. */
async function pointersOf(repo, objects) {
  const map = new Map();
  const small = [...new Set(objects.filter((o) => o.size < POINTER_MAX).map((o) => o.sha))];
  await catObjects(repo, small, {}, (i, body) => {
    const p = parsePointer(body);
    if (p) map.set(small[i], p);
  });
  return map;
}

function lfsPath(lfsDir, oid) {
  return path.join(lfsDir, 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
}

/**
 * The object behind a pointer: { file, size, hash } when its size and sha256 match, else { why }.
 * One over 32 MB is only measured, { deferred, size }: its sha256 is checked when it is read.
 */
async function checkLfsObject(lfsDir, pointer) {
  const file = lfsPath(lfsDir, pointer.oid);
  let st;
  try {
    st = fs.statSync(file);
  } catch (_) {
    st = null;
  }
  if (!st || !st.isFile()) return { why: t('its Git LFS object is not in {0}', lfsDir) };
  if (st.size !== pointer.size) {
    return { why: t('its Git LFS object has {0} bytes, not the {1} its pointer says', st.size, pointer.size) };
  }
  if (st.size > HASH_LIMIT) return { deferred: true, size: st.size };
  const sha256 = crypto.createHash('sha256');
  const sha1 = crypto.createHash('sha1').update(`blob ${st.size}\0`);
  try {
    for await (const chunk of fs.createReadStream(file)) {
      sha256.update(chunk);
      sha1.update(chunk);
    }
  } catch (e) {
    return { why: t('its Git LFS object could not be read ({0})', e.code || e.message) };
  }
  if (sha256.digest('hex') !== pointer.oid) return { why: t('its Git LFS object does not match the sha256 in its pointer') };
  return { file, size: st.size, hash: sha1.digest('hex') };
}

/** A Git LFS object's bytes, only when they are the size and sha256 its pointer gives. */
async function readLfs(lfsDir, { oid, size }) {
  const file = lfsPath(lfsDir, oid);
  const data = await fs.promises.readFile(file);
  if (data.length !== size) throw new Error(t('The Git LFS object {0} has {1} bytes, not the {2} its pointer says', file, data.length, size));
  if (crypto.createHash('sha256').update(data).digest('hex') !== oid) {
    throw new Error(t('The Git LFS object {0} does not match the sha256 in its pointer', file));
  }
  return data;
}

/** A copy whose blob is a Git LFS pointer: the checked object, or a copy with nothing to read. */
async function lfsCopy(base, pointer, lfsDir, checked, repo) {
  if (pointer.unreadable) {
    return { ...base, size: null, gone: true, note: t('a Git LFS pointer this cannot follow; the pointer is not the file') };
  }
  const origin = lfsPath(lfsDir, pointer.oid);
  if (pointer.extensions.length) {
    return { ...base, size: pointer.size, gone: true, origin,
      note: t('stored through Git LFS extensions ({0}), which are not applied', pointer.extensions.join(', ')) };
  }
  // Two pointers can name one object and still disagree on its size.
  const key = `${origin}\0${pointer.size}`;
  if (!checked.has(key)) checked.set(key, checkLfsObject(lfsDir, pointer));
  const obj = await checked.get(key);
  if (obj.deferred) {
    return { ...base, size: obj.size, hash: null, origin, gitBlob: { repo, sha: `lfs:${pointer.oid}:${pointer.size}` },
      note: t('Git LFS object; its size matches its pointer, and its sha256 is checked when it is read') };
  }
  if (!obj.file) return { ...base, size: pointer.size, gone: true, origin, note: obj.why };
  return { ...base, size: obj.size, hash: obj.hash, file: obj.file, origin,
    note: t('Git LFS object; size and sha256 match its pointer') };
}

/**
 * The filter attribute of each path: by today's attributes, or with `how` by those of the index
 * (['--cached']) or of a tree (['--source=<tree>'], git 2.40 and later; older git lists nothing).
 */
async function filterAttrs(repo, rels, how = []) {
  const map = new Map();
  if (!rels.length) return map;
  const out = await run(['check-attr', ...how, '-z', '--stdin', 'filter'],
    { cwd: repo, input: rels.join('\0') + '\0', allowFail: how.length > 0 });
  const f = out.split('\0');
  for (let i = 0; i + 2 < f.length; i += 3) map.set(f[i], f[i + 2]);
  return map;
}

/**
 * The index's entries at stage 0, by path: { mode, oid, size, mtime, flags }, from
 * `git ls-files -s --debug`. `size` is that of the file on disk when git last saw it match the
 * blob -- on add, on checkout, on a refresh -- so it tells which form the disk had. `mtime` is
 * the file's then, in ms, or null where git recorded none (0:0).
 */
async function indexEntries(repo) {
  const map = new Map();
  const out = await run(['ls-files', '-s', '--debug', '-z'], { cwd: repo });
  // "<mode> <oid> <stage>\t<path>\0", then indented lines: "  mtime: <s>:<ns>", "  size: <n>\tflags: <hex>".
  for (const m of out.matchAll(/(\d{6}) ([0-9a-f]{40,64}) (\d)\t([^\0]*)\0((?: {2}[^\n]*\n)*)/g)) {
    if (m[3] !== '0') continue;
    const time = /^ {2}mtime: (\d+):(\d+)$/m.exec(m[5]);
    const sf = /^ {2}size: (\d+)\tflags: ([0-9a-f]+)$/m.exec(m[5]);
    map.set(m[4], {
      mode: m[1],
      oid: m[2],
      size: sf ? Number(sf[1]) : null,
      mtime: time && (time[1] !== '0' || time[2] !== '0') ? Number(time[1]) * 1000 + Math.floor(Number(time[2]) / 1e6) : null,
      flags: sf ? parseInt(sf[2], 16) : 0,
    });
  }
  return map;
}

/**
 * Which form of a blob the file on disk had, from the size the index recorded: 'converted',
 * 'stored' (a file some other program wrote, with line endings git would not have chosen), or
 * 'neither' (say, mixed line endings, which git evened out when staging it). null when the
 * index says nothing: 0 is also what git writes to make itself look again.
 */
function formOnDisk(convertedSize, storedSize, recorded) {
  if (!recorded) return null;
  // The index keeps the low 32 bits of the size.
  const fits = (n) => n % 2 ** 32 === recorded;
  if (fits(convertedSize)) return 'converted';
  if (fits(storedSize)) return 'stored';
  return 'neither';
}

/**
 * Every version of a matching path that `git log -z --raw --no-abbrev` names. A change is
 * ":<old mode> <new mode> <old id> <new id> <status>", then its path: a deletion's version is the
 * old one, from the first parent, and any other the new one. Commits in `skip` are passed over.
 * add() gets { rev, kind, rel, time, oid, mode, tree }, `tree` being where that version's
 * attributes are.
 */
function parseLog(log, add, skip = new Set()) {
  const fields = log.split('\0');
  let commit = null;
  let time = null;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i].replace(/^\n/, '');
    if (f.startsWith('\x01')) {
      const [h, ct] = f.slice(1).split('\t');
      commit = skip.has(h) ? null : h;
      time = Number(ct) * 1000;
      continue;
    }
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])\d*$/.exec(f);
    if (!m) continue;
    // A rename or copy names two paths; --no-renames keeps them out, but they are stepped over.
    if (m[5] === 'R' || m[5] === 'C') {
      i += 2;
      continue;
    }
    const rel = fields[++i];
    if (!commit || !rel || !/^[AMDT]$/.test(m[5])) continue;
    if (m[5] === 'D') {
      add({ rev: `${commit}^:${rel}`, kind: 'git, deleted in a commit', rel, time, oid: m[3], mode: m[1], tree: `${commit}^` });
    } else {
      add({ rev: `${commit}:${rel}`, kind: 'git commit', rel, time, oid: m[4], mode: m[2], tree: commit });
    }
  }
}

/** The commits of git notes -- every refs/notes/* ref and its reflog -- whose trees name commits, not files. */
async function notesCommits(repo) {
  const refs = (await run(['for-each-ref', '--format=%(refname)', 'refs/notes/'], { cwd: repo })).split('\n').filter(Boolean);
  if (!refs.length) return new Set();
  const starts = [...refs];
  for (const ref of refs) {
    const reflog = await run(['log', '-g', '--format=%H', ref, '--'], { cwd: repo, allowFail: true });
    starts.push(...reflog.split('\n').filter(Boolean));
  }
  const list = await run(['rev-list', '--ignore-missing', '--stdin'], { cwd: repo, input: starts.join('\n') + '\n' });
  return new Set(list.split('\n').filter(Boolean));
}

function mtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch (_) {
    return null;
  }
}

async function scanRepo(repo, ctx, checked) {
  const info = await openRepo(repo);
  if (!info.off) throw new Error(t('a filter driver here has a name that cannot be switched off, so nothing was read'));
  await refusePartial(info);
  const v = await gitVersion();
  const refs = [];
  const left = { links: 0, intent: 0 };
  const add = (r) => {
    const abs = path.join(repo, r.rel);
    if (!ctx.matcher.test(abs)) return;
    // A submodule's entry names a commit, not a file.
    if (r.mode === GITLINK) return;
    if (r.mode === LINK && !info.linksAsText) left.links++;
    else refs.push({ ...r, path: abs, link: r.mode === LINK });
  };

  const index = await indexEntries(repo);
  const indexTime = mtime(path.join(info.gitDir, 'index'));
  const deleted = await run(['ls-files', '--deleted', '-z'], { cwd: repo });
  for (const rel of new Set(deleted.split('\0').filter(Boolean))) {
    const e = index.get(rel);
    // A path in the middle of a merge has no entry at stage 0, and no one version to offer.
    if (!e) continue;
    if (e.flags & INTENT_TO_ADD) {
      if (ctx.matcher.test(path.join(repo, rel))) left.intent++;
      continue;
    }
    add({ rev: `:0:${rel}`, kind: 'git index', rel, time: e.mtime != null ? e.mtime : indexTime, oid: e.oid, mode: e.mode, tree: null });
  }

  const literal = ctx.matcher.literal;
  const own = repo.normalize('NFC').replace(/\\/g, '/').toLowerCase();
  const specs = literal && !own.includes(literal) ? pathspecs(literal) : [];
  const args = ['log', '-z', '--all', '--reflog', '--no-renames', '--raw', '--no-abbrev', '--format=%x01%H%x09%ct'];
  // A stash's work sits in a merge commit, which shows no change unless asked for its first parent's.
  if (atLeast(v, 2, 31)) args.push('--diff-merges=first-parent');
  if (specs.length) args.push('--full-history');
  let log = '';
  try {
    log = await run([...args, '--', ...specs], { cwd: repo });
  } catch (e) {
    if (e.noGit) throw e;
    ctx.notes.push(t('{0}: its history could not be read ({1})', repo, e.message.split('\n')[0]));
  }
  parseLog(log, add, await notesCommits(repo));

  const seen = new Set();
  const unique = refs.filter((r) => (seen.has(r.rev) ? false : seen.add(r.rev)));
  const { objects, missing } = await batchCheck(repo, [...new Set(unique.map((r) => r.oid))]);
  const found = unique.filter((r) => objects.has(r.oid)).map((r) => ({ ...r, obj: objects.get(r.oid) }));
  const pointers = await pointersOf(repo, found.filter((r) => !r.link).map((r) => r.obj));

  // Filter attributes: today's for every path, when a pointer or a driver other than Git LFS
  // makes them matter; and for a pointer not under Git LFS today, those where it comes from.
  const others = new Set([...info.drivers].filter((d) => d !== 'lfs'));
  const today = pointers.size || others.size ? await filterAttrs(repo, [...new Set(found.map((r) => r.rel))]) : new Map();
  const howOf = (r) => (r.tree ? [`--source=${r.tree}`] : ['--cached']);
  const then = new Map();
  for (const r of found) {
    if (!pointers.has(r.obj.sha) || today.get(r.rel) === 'lfs') continue;
    const key = howOf(r).join(' ');
    if (!then.has(key)) then.set(key, { how: howOf(r), rels: new Set() });
    then.get(key).rels.add(r.rel);
  }
  for (const entry of then.values()) entry.attrs = await filterAttrs(repo, [...entry.rels], entry.how);
  const follows = (r) => today.get(r.rel) === 'lfs' || then.get(howOf(r).join(' ')).attrs.get(r.rel) === 'lfs';

  // Each blob is converted once per path it had; the same bytes at another path may convert
  // differently.
  const requests = new Map();
  for (const r of found) {
    if (r.link || r.obj.size > HASH_LIMIT || (pointers.has(r.obj.sha) && follows(r))) continue;
    const key = `${r.obj.sha} ${r.rel}`;
    if (!requests.has(key)) requests.set(key, { oid: r.obj.sha, rel: r.rel });
  }
  const list = [...requests.values()];
  const converted = new Map();
  await readConverted(repo, info.off, list, (i, body) => {
    const key = `${list[i].oid} ${list[i].rel}`;
    if (!body) {
      converted.set(key, null);
      return;
    }
    const small = body.length <= HASH_LIMIT;
    converted.set(key, {
      size: body.length,
      hash: small ? blobHash(body) : null,
      // A search by content reads them all anyway; keeping them spares a second read.
      buffer: small && ctx.containing ? body : null,
    });
  });

  const out = [];
  let unconverted = 0;
  for (const r of found) {
    const base = { source: 'git', kind: r.kind, path: r.path, time: r.time, origin: `${repo} ${r.rev}` };
    const pointer = pointers.get(r.obj.sha);
    if (pointer && follows(r)) {
      out.push(await lfsCopy(base, pointer, info.lfsDir, checked, repo));
      continue;
    }
    if (r.link) {
      // Checkout writes the target as it is stored: no conversion applies to a link.
      out.push({ ...base, size: r.obj.size, hash: r.obj.sha.length === 40 ? r.obj.sha : null, gitBlob: { repo, sha: r.obj.sha },
        note: t('a symbolic link, which checkout writes as a file holding its target, since core.symlinks is false') });
      continue;
    }
    const conv = converted.get(`${r.obj.sha} ${r.rel}`);
    if (conv === null) {
      unconverted++;
      continue;
    }
    const c = { ...base, size: conv ? conv.size : r.obj.size, hash: conv ? conv.hash : null,
      gitBlob: { repo, sha: `${r.obj.sha} ${r.rel}` } };
    if (conv && conv.buffer) c.buffer = conv.buffer;
    // A driver's name can be '', so it is told from none by null.
    const driver = others.has(today.get(r.rel)) ? today.get(r.rel) : null;
    // What the index recorded speaks only for the blob it recorded, at its own path.
    const entry = index.get(r.rel);
    const form = conv && driver === null && entry && entry.oid === r.obj.sha ? formOnDisk(conv.size, r.obj.size, entry.size) : null;
    if (driver !== null) {
      c.kind = 'git, filter not run';
      c.note = t('its "{0}" filter was not run: this is git\'s stored content, with line endings converted as checkout would', driver);
    } else if (form === 'stored') {
      // The blob id is the stored bytes' hash, when it is SHA-1 like the rest.
      c.size = r.obj.size;
      c.hash = r.obj.sha.length === 40 ? r.obj.sha : null;
      c.gitBlob = { repo, sha: r.obj.sha };
      delete c.buffer;
      c.note = t('as git stores it: the index recorded this size for the file on disk');
    } else if (form === 'neither') {
      c.kind = 'git, line endings differ';
      c.note = t('the index recorded {0} bytes for the file on disk, which neither form of it has', entry.size);
    }
    if (pointer && driver === null) {
      // Whether it was ever under Git LFS some other way -- attributes kept outside the
      // repository and since removed -- cannot be told, so the kind says what it is.
      c.kind = 'git, Git LFS pointer';
      c.note = pointer.oid
        ? t('a Git LFS pointer at a path not under filter=lfs, now or where it comes from: checkout writes the pointer itself, which is this copy; the object it names would be {0}', lfsPath(info.lfsDir, pointer.oid))
        : t('a Git LFS pointer at a path not under filter=lfs, now or where it comes from: checkout writes the pointer itself, which is this copy');
    }
    out.push(c);
  }
  if (missing) {
    ctx.notes.push(info.promisor
      ? t('{0}: {1} version(s) are not in this partial clone and were left on its server', repo, missing)
      : t('{0}: {1} version(s) its history names are missing from it; they were left out', repo, missing));
  }
  if (left.links) ctx.notes.push(t('{0}: {1} version(s) of symbolic links were skipped; a link holds no file', repo, left.links));
  if (left.intent) {
    ctx.notes.push(t('{0}: {1} file(s) marked with git add -N were deleted before being staged; git holds nothing of them', repo, left.intent));
  }
  if (unconverted) ctx.notes.push(t('{0}: git could not convert {1} blob(s); they were left out', repo, unconverted));

  if (ctx.unnamed) {
    const fsck = await run(['fsck', '--unreachable', '--no-progress'], { cwd: repo, allowFail: true });
    const shas = [...fsck.matchAll(/^unreachable blob ([0-9a-f]{40,64})$/gm)].map((m) => m[1]);
    const { objects: sizes } = await batchCheck(repo, shas);
    const loose = await pointersOf(repo, [...sizes.values()]);
    for (const sha of shas) {
      const obj = sizes.get(sha);
      if (!obj) continue;
      const time = mtime(path.join(info.commonDir, 'objects', sha.slice(0, 2), sha.slice(2)));
      const pointer = loose.get(sha);
      if (pointer) {
        // Without a name, a pointer whose object is not here has nothing to offer.
        const base = { source: 'git', kind: 'git lfs object, name unknown', path: null, time };
        const c = await lfsCopy(base, pointer, info.lfsDir, checked, repo);
        if (!c.gone) out.push(c);
        continue;
      }
      out.push({
        source: 'git', kind: 'git object, name unknown, as stored', path: null, time,
        size: obj.size, hash: sha.length === 40 ? sha : null,
        gitBlob: { repo, sha }, origin: `${repo} ${sha}`,
        note: t('no path, so no line-ending conversion: this is the content as git stores it'),
      });
    }
  }
  return out;
}

async function scan(ctx) {
  let repos;
  try {
    repos = await discoverRepos(repoRoots(ctx.locations), ctx.notes);
  } catch (e) {
    if (e.noGit) {
      ctx.notes.push(t('git is not installed, so repositories were not searched.'));
      return [];
    }
    throw e;
  }
  ctx.stats.repos = repos.length;
  const out = [];
  // Git LFS objects checked in this search, so one kept by many commits is hashed once.
  const checked = new Map();
  for (let i = 0; i < repos.length; i++) {
    try {
      out.push(...(await scanRepo(repos[i], ctx, checked)));
    } catch (e) {
      ctx.notes.push(t('Skipped {0}: {1}', repos[i], e.message.split('\n')[0]));
    }
    if (ctx.progress) ctx.progress(i + 1, repos.length);
  }
  return out;
}

/**
 * What a copy's `gitBlob.sha` asks for: an object id, read as git stores it; "<object id> <path>",
 * read as checkout would write that path; or "lfs:<sha256>:<size>", a Git LFS object checked
 * as it is read.
 */
function parseRequest(sha) {
  const lfs = /^lfs:([0-9a-f]{64}):(\d+)$/.exec(sha);
  if (lfs) return { lfs: { oid: lfs[1], size: Number(lfs[2]) } };
  const m = /^([0-9a-f]{40,64})(?: ([\s\S]+))?$/.exec(sha);
  if (!m) throw new Error(t('Not a git object: {0}', sha));
  return { oid: m[1], rel: m[2] === undefined ? null : m[2] };
}

/** One copy's bytes, as `gitBlob` describes them; see parseRequest. */
async function readBlob(repo, sha) {
  const req = parseRequest(sha);
  const info = await openRepo(repo);
  await refusePartial(info);
  if (req.lfs) return readLfs(info.lfsDir, req.lfs);
  if (req.rel === null) return run(['cat-file', 'blob', req.oid], { cwd: repo, buffer: true });
  if (!info.off) throw new Error(t('a filter driver here has a name that cannot be switched off, so nothing was read'));
  return run([...info.off, 'cat-file', '--filters', `--path=${req.rel}`, req.oid], { cwd: repo, buffer: true });
}

/** Loads many blobs in one or two git calls per repository, for a search by content or a rebuild. */
async function preload(candidates) {
  const byRepo = new Map();
  for (const c of candidates) {
    if (!c.gitBlob || c.buffer || (c.size || 0) > HASH_LIMIT || c.gitBlob.sha.startsWith('lfs:')) continue;
    if (!byRepo.has(c.gitBlob.repo)) byRepo.set(c.gitBlob.repo, []);
    byRepo.get(c.gitBlob.repo).push(c);
  }
  for (const [repo, list] of byRepo) {
    let info;
    try {
      info = await openRepo(repo);
      await refusePartial(info);
    } catch (_) {
      continue; // each copy is then read on its own, and fails on its own
    }
    const shas = [...new Set(list.map((c) => c.gitBlob.sha))];
    const got = new Map();
    const raw = shas.filter((s) => parseRequest(s).rel === null);
    await catObjects(repo, raw, {}, (i, body) => body && got.set(raw[i], body));
    if (info.off) {
      const named = shas.filter((s) => parseRequest(s).rel !== null);
      await readConverted(repo, info.off, named.map(parseRequest), (i, body) => body && got.set(named[i], body));
    }
    for (const c of list) {
      const b = got.get(c.gitBlob.sha);
      if (b) c.buffer = b;
    }
  }
}

async function describe(ctx) {
  const roots = repoRoots(ctx.locations);
  const notes = [];
  let repos;
  try {
    repos = await discoverRepos(roots, notes);
  } catch (e) {
    return [e.noGit ? t('git is not installed.') : t('Could not look for repositories: {0}', e.message.split('\n')[0])];
  }
  const lines = [t('Repositories under {0}: {1}', roots.join(', ') || '-', repos.length)];
  for (const r of repos) lines.push('  ' + r);
  for (const n of notes) lines.push('  ' + n);
  return lines;
}

/**
 * Every folder a search reads from -- git folders, Git LFS storage, borrowed object folders --
 * so that restore stays out of them.
 */
async function gitDirs(loc) {
  let repos;
  try {
    repos = await discoverRepos(repoRoots(loc));
  } catch (_) {
    return [];
  }
  const dirs = [];
  for (const r of repos) {
    dirs.push(path.join(r, '.git'));
    try {
      const info = await openRepo(r);
      dirs.push(info.gitDir, info.commonDir, info.lfsDir, ...info.objectDirs);
    } catch (_) {
      /* the plain .git folder is still protected */
    }
  }
  return [...new Set(dirs)];
}

module.exports = {
  id: 'git',
  label: 'git',
  scan,
  describe,
  readBlob,
  preload,
  roots: () => [],
  gitDirs,
  _internal: { pathspecs, discoverRepos, parsePointer, splitter, catObjects, parseLog, fitsLine, openRepo, objectDirs, gitPath, env },
};
