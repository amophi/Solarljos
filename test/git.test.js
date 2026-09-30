'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { workDir, cleanup, write, only, snapshot } = require('./helpers');
const { search, git } = require('../src/search');
const { load, blobHash, HASH_LIMIT } = require('../src/content');
const { restore, planRebuild } = require('../src/restore');
const { isInside, pathKey } = require('../src/paths');
const { parsePointer, splitter, parseLog, fitsLine, catObjects, pathspecs, objectDirs, gitPath, discoverRepos, env: gitEnv } =
  require('../src/sources/git')._internal;

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch (_) {
  hasGit = false;
}
// Some cases need a git of a given age; older ones are checked for what they do instead.
const version = (() => {
  const m = hasGit ? /(\d+)\.(\d+)/.exec(execFileSync('git', ['version']).toString()) : null;
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
})();
const atLeast = (major, minor) => version[0] > major || (version[0] === major && version[1] >= minor);

let root;
let repo;
let eolRepo;
let crlfRepo;
let lfsRepo;
const expected = {};

// Repositories are built with the user's and the system's git configuration shut out, so no
// global hook or setting can run, and nothing outside test/.work is touched.
function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

function newRepo(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  return dir;
}

/** Adds everything and commits it. */
function commitAll(dir, message) {
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', message);
}

/** What git itself writes for a committed file: taken out and checked out again. */
function checkedOut(dir, rel) {
  fs.unlinkSync(path.join(dir, rel));
  sh(dir, 'checkout', '--', rel);
  return fs.readFileSync(path.join(dir, rel));
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pointer = (oid, size) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
const lfsObject = (dir, oid) => path.join(dir, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
const fileUrl = (p) => 'file://' + (p.startsWith('/') ? '' : '/') + p.replace(/\\/g, '/');

/** A filter command that leaves a trace had it ever run. git runs it through sh everywhere. */
const leavesTrace = (marker, more) => `echo ran >> "${marker}"${more ? '; ' + more : ''}`;

/**
 * Runs fn with these variables set in this process's environment, then puts back what was there.
 * No git is run by the test itself meanwhile: they would reach it too.
 */
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

before(() => {
  if (!hasGit) return;
  root = workDir('git');
  const emptyConfig = write(path.join(root, 'empty.gitconfig'), '');
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  });
  expected.marker = path.join(root, 'filter-ran.txt').replace(/\\/g, '/');

  repo = newRepo('repo');
  // Committed, then deleted in a later commit.
  write(path.join(repo, 'keep.txt'), 'keep');
  write(path.join(repo, 'docs', 'deleted.txt'), 'old content');
  commitAll(repo, 'first');
  sh(repo, 'rm', '-q', 'docs/deleted.txt');
  sh(repo, 'commit', '-q', '-m', 'remove it');

  // Committed, then thrown away by reset --hard: only the reflog remembers it.
  write(path.join(repo, 'lost.txt'), 'lost work');
  sh(repo, 'add', 'lost.txt');
  sh(repo, 'commit', '-q', '-m', 'about to be lost');
  sh(repo, 'reset', '-q', '--hard', 'HEAD~1');

  // Notes on two commits, in the default notes ref and in one of its own: their blobs sit at
  // paths named after the commits, and are not files.
  sh(repo, 'notes', 'add', '-m', 'a note on a commit', 'HEAD');
  sh(repo, 'notes', '--ref=review', 'add', '-m', 'another note', 'HEAD~1');

  // Staged, then deleted from disk without a commit.
  write(path.join(repo, 'staged.txt'), 'staged only');
  sh(repo, 'add', 'staged.txt');
  fs.unlinkSync(path.join(repo, 'staged.txt'));

  // Staged, then staged again with other content: the first version is left unreachable.
  write(path.join(repo, 'draft.txt'), 'first draft, orphaned\n');
  sh(repo, 'add', 'draft.txt');
  write(path.join(repo, 'draft.txt'), 'second draft');
  sh(repo, 'add', 'draft.txt');

  // Marked with `git add -N`, then deleted: the index holds the empty blob, never the file.
  write(path.join(repo, 'intent.txt'), 'never staged, never kept\n');
  sh(repo, 'add', '-N', 'intent.txt');
  fs.unlinkSync(path.join(repo, 'intent.txt'));

  // Line endings set by .gitattributes. core.eol is pinned, since its default differs between
  // Windows and Linux; the blobs all hold LF.
  eolRepo = newRepo('eol');
  sh(eolRepo, 'config', 'core.autocrlf', 'false');
  sh(eolRepo, 'config', 'core.eol', 'lf');
  write(path.join(eolRepo, '.gitattributes'), '*.txt text=auto eol=crlf\n*.bat text eol=crlf\n*.lf text eol=lf\n*.dat binary\n');
  const eolFiles = {
    'notes.txt': 'one\ntwo\n',
    'with space.txt': 'a b\nc\n',
    // git's batch reader would drop the leading blank, so this one is read on its own.
    ' lead.txt': 'l1\nl2\n',
    'bin.txt': Buffer.from('not\ntext\0at all\n'),
    'run.bat': '@echo off\necho hi\n',
    'keep.lf': 'x\ny\n',
    'blob.dat': Buffer.from('a\nb\0c\n'),
  };
  for (const [rel, data] of Object.entries(eolFiles)) write(path.join(eolRepo, 'src', rel), data);
  commitAll(eolRepo, 'files');
  for (const rel of Object.keys(eolFiles)) expected[rel] = checkedOut(eolRepo, 'src/' + rel);
  sh(eolRepo, 'rm', '-q', '-r', 'src');
  sh(eolRepo, 'commit', '-q', '-m', 'all gone');

  // core.autocrlf=true, no attributes: what this machine's system config does.
  crlfRepo = newRepo('autocrlf');
  sh(crlfRepo, 'config', 'core.autocrlf', 'true');
  write(path.join(crlfRepo, 'a.txt'), 'l1\nl2\n');
  write(path.join(crlfRepo, 'pic.dat'), Buffer.from([0x89, 0x0a, 0x00, 0x0a]));
  commitAll(crlfRepo, 'files');
  expected['a.txt'] = checkedOut(crlfRepo, 'a.txt');
  expected['pic.dat'] = checkedOut(crlfRepo, 'pic.dat');
  sh(crlfRepo, 'rm', '-q', 'a.txt', 'pic.dat');
  sh(crlfRepo, 'commit', '-q', '-m', 'gone');
  write(path.join(crlfRepo, 'staged.txt'), 's1\ns2\n');
  sh(crlfRepo, 'add', 'staged.txt');
  expected['staged.txt'] = checkedOut(crlfRepo, 'staged.txt');
  fs.unlinkSync(path.join(crlfRepo, 'staged.txt'));
  // Written with LF by some other program and committed as it was: git never rewrote it, and
  // the index recorded its LF size. And one with mixed line endings, which git evened out.
  write(path.join(crlfRepo, 'tool.txt'), 't1\nt2\n');
  write(path.join(crlfRepo, 'mixed.txt'), 'm1\r\nm2\n');
  sh(crlfRepo, 'add', 'tool.txt', 'mixed.txt');
  // This commit takes staged.txt too, as the same blob the index holds. The index dates its copy
  // to the millisecond and a commit to the second, so a commit that fell in a later second than
  // the checkout above would be the newer copy of the two, and win, now and then. Dated well
  // before, it never is.
  execFileSync('git', ['commit', '-q', '-m', 'as written'], {
    cwd: crlfRepo, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' },
  });
  fs.unlinkSync(path.join(crlfRepo, 'tool.txt'));
  fs.unlinkSync(path.join(crlfRepo, 'mixed.txt'));

  // Git LFS pointers. Committed while no filter is configured, so the blobs hold the pointers
  // as written. The filters are set afterwards, as required ones, to commands that leave a
  // trace: had git run one, expected.marker would exist.
  lfsRepo = newRepo('lfs');
  write(path.join(lfsRepo, '.gitattributes'), '*.psd filter=lfs diff=lfs merge=lfs -text\n*.enc filter=crypt\n');
  const art = Buffer.from('PSD\r\n\0binary\nbytes\r\n');
  const missing = Buffer.from('never fetched');
  const loose = Buffer.from('pointed to from a path with no lfs attribute\n');
  const sub = Buffer.from('behind a pointer whose folder took its lfs attribute with it\n');
  expected.art = art;
  expected.wrong = Buffer.from(art).fill(0x41, 0, 3); // same size, other bytes
  expected.loose = loose;
  expected.sub = sub;
  write(path.join(lfsRepo, 'art', 'present.psd'), pointer(sha256(art), art.length));
  write(path.join(lfsRepo, 'art', 'absent.psd'), pointer(sha256(missing), missing.length));
  // Its object is there, but it is not the size the pointer says.
  write(path.join(lfsRepo, 'art', 'short.psd'), pointer(sha256(loose), loose.length + 5));
  write(path.join(lfsRepo, 'art', 'ext.psd'), `version https://git-lfs.github.com/spec/v1\next-0-foo sha256:${'b'.repeat(64)}\n` +
    `oid sha256:${sha256(art)}\nsize ${art.length}\n`);
  write(path.join(lfsRepo, 'plain', 'note.txt'), pointer(sha256(loose), loose.length));
  write(path.join(lfsRepo, 'sub', '.gitattributes'), '*.bin filter=lfs -text\n');
  write(path.join(lfsRepo, 'sub', 'x.bin'), pointer(sha256(sub), sub.length));
  write(path.join(lfsRepo, 'secret.enc'), 'stored form\n');
  commitAll(lfsRepo, 'art');
  sh(lfsRepo, 'rm', '-q', '-r', 'art', 'plain', 'sub', 'secret.enc');
  sh(lfsRepo, 'commit', '-q', '-m', 'gone');
  write(lfsObject(lfsRepo, sha256(art)), art);
  write(lfsObject(lfsRepo, sha256(loose)), loose);
  write(lfsObject(lfsRepo, sha256(sub)), sub);
  for (const [k, v] of Object.entries({
    'filter.lfs.smudge': leavesTrace(expected.marker, 'cat'), 'filter.lfs.process': leavesTrace(expected.marker),
    'filter.lfs.required': 'true', 'filter.crypt.smudge': leavesTrace(expected.marker, 'cat'),
    'filter.crypt.process': leavesTrace(expected.marker), 'filter.crypt.required': 'true',
  })) sh(lfsRepo, 'config', k, v);
});

after(() => {
  if (root) cleanup(root);
});

const find = (o, repos = [repo]) => search({ sources: ['git'], locations: only({ repos }), ...o });
const findUnder = (folder, repos) => search({ under: folder, sources: ['git'], locations: only({ repos }) });
const byName = (results, name) => results.filter((r) => r.path && path.basename(r.path) === name);
const texts = async ({ results }) => (await Promise.all(results.map(async (c) => (await load(c, git)).toString().trim()))).sort();

test('a file deleted in a commit is found with its last content', { skip: !hasGit }, async () => {
  const { results } = await find({ pattern: 'deleted.txt' });
  const del = results.find((r) => r.kind === 'git, deleted in a commit');
  assert.ok(del, results.map((r) => r.kind).join(', '));
  assert.strictEqual(del.path, path.join(repo, 'docs', 'deleted.txt'));
  assert.strictEqual(del.state, 'deleted');
  assert.strictEqual((await load(del, git)).toString(), 'old content');
  // The add and the delete carry the same content: one result, seen twice.
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].copies, 2);
});

test('a commit thrown away by reset --hard is found through the reflog', { skip: !hasGit }, async () => {
  const { results } = await find({ pattern: 'lost.txt' });
  assert.strictEqual(results.length, 1);
  assert.strictEqual((await load(results[0], git)).toString(), 'lost work');
});

test('a staged file deleted from disk is found in the index', { skip: !hasGit }, async () => {
  const { results } = await find({ pattern: 'staged' });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].kind, 'git index');
  assert.strictEqual((await load(results[0], git)).toString(), 'staged only');
});

test('an orphaned blob is offered to a search by content, as git stores it', { skip: !hasGit }, async () => {
  const { results } = await find({ containing: 'ORPHANED' });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].kind, 'git object, name unknown, as stored');
  assert.strictEqual(results[0].path, null);
  assert.strictEqual((await load(results[0], git)).toString(), 'first draft, orphaned\n');
});

test('a file marked with git add -N and then deleted is not offered as an empty copy', { skip: !hasGit }, async () => {
  const { results, perSource } = await find({ pattern: 'intent.txt' });
  assert.deepStrictEqual(results, []);
  assert.match(perSource[0].notes.join('\n'), /git add -N/);
});

test('git notes are not offered as files', { skip: !hasGit }, async () => {
  const { results } = await find({ pattern: '*' });
  assert.ok(results.length);
  for (const r of results) assert.doesNotMatch(path.basename(r.path || ''), /^[0-9a-f]{40,64}$/, r.path);
  const head = sh(repo, 'rev-parse', 'HEAD').toString().trim();
  assert.deepStrictEqual((await find({ pattern: head.slice(0, 8) + '*' })).results, []);
});

test('searching leaves the repository exactly as it was', { skip: !hasGit }, async () => {
  const before = snapshot(path.join(repo, '.git'));
  await find({ pattern: '*' });
  await find({ containing: 'draft' });
  assert.deepStrictEqual(snapshot(path.join(repo, '.git')), before);
});

test('repositories are found below a folder, and the one a folder sits in', { skip: !hasGit }, async () => {
  const { discoverRepos } = require('../src/sources/git')._internal;
  const found = await discoverRepos([root]);
  assert.ok(found.includes(path.resolve(repo)), found.join(', '));
  // Two levels above the folder given, where the walk down never goes: only git's own answer
  // finds it. The repository is a fixture, not this project's checkout, so the test also holds in
  // a copy of the project with no .git, such as a source archive.
  const outer = newRepo('enclosing');
  const deeper = path.join(outer, 'sub', 'deeper');
  fs.mkdirSync(deeper, { recursive: true });
  const above = await discoverRepos([deeper]);
  // git answers with the folder as it really is, which a link or another letter case can hide.
  const real = (p) => pathKey(fs.realpathSync.native(p));
  assert.ok(above.map(real).includes(real(outer)), above.join(', '));
});

test('a repository reached by two spellings is searched once, under the spelling given', { skip: !hasGit }, async () => {
  const link = path.join(root, 'repo-link');
  fs.symlinkSync(repo, link, 'junction');
  const spellings = [link];
  if (process.platform === 'win32') spellings.push(repo.toLowerCase(), repo[0].toLowerCase() + repo.slice(1));
  for (const s of spellings) {
    const { results, stats } = await find({ pattern: 'deleted.txt' }, [s]);
    assert.strictEqual(stats.repos, 1, s);
    assert.strictEqual(results.length, 1, s);
    assert.strictEqual(results[0].copies, 2, s);
    assert.strictEqual(results[0].path, path.join(s, 'docs', 'deleted.txt'));
  }
});

test('a --repo folder that is not there costs only itself', { skip: !hasGit }, async () => {
  const nowhere = path.join(root, 'no-such-folder');
  const { results, perSource } = await find({ pattern: 'deleted.txt' }, [nowhere, repo]);
  assert.strictEqual(results.length, 1);
  const notes = perSource[0].notes.join('\n');
  assert.match(notes, /is not a folder/);
  assert.doesNotMatch(notes, /not installed/);
  const protect = await git.gitDirs({ repos: [nowhere, repo] });
  assert.ok(protect.some((d) => isInside(path.join(repo, '.git', 'objects'), d)), protect.join(', '));
});

test('git is looked for only in the absolute entries of PATH', () => {
  const base = workDir('git-path');
  const saved = process.env.PATH;
  try {
    const name = process.platform === 'win32' ? 'git.exe' : 'git';
    const near = write(path.join(base, 'near', name), '');
    const far = write(path.join(base, 'far', name), '');
    fs.chmodSync(near, 0o755);
    fs.chmodSync(far, 0o755);
    // A relative entry is where a program in the searched folder could be picked up.
    process.env.PATH = [path.relative(process.cwd(), path.dirname(near)), path.dirname(far)].join(path.delimiter);
    assert.strictEqual(gitPath(), far);
    process.env.PATH = path.relative(process.cwd(), path.dirname(near));
    assert.throws(() => gitPath(), (e) => e.noGit === true && e.code === 'ENOENT');
  } finally {
    process.env.PATH = saved;
    cleanup(base);
  }
});

test('a git.exe at the top of a searched repository is never run', { skip: !hasGit || process.platform !== 'win32' }, async () => {
  const dir = newRepo('planted');
  write(path.join(dir, 'a.txt'), 'committed');
  commitAll(dir, 'a');
  sh(dir, 'rm', '-q', 'a.txt');
  sh(dir, 'commit', '-q', '-m', 'gone');
  // Not a program at all: had Windows been handed it, every git call there would have failed.
  const planted = write(path.join(dir, 'git.exe'), 'not a program\n');
  // Without this variable Windows looks in the working folder before PATH; it is not set on
  // the machines this runs on, only in some shells.
  const saved = process.env.NoDefaultCurrentDirectoryInExePath;
  delete process.env.NoDefaultCurrentDirectoryInExePath;
  try {
    const { results, perSource } = await find({ pattern: 'a.txt' }, [dir]);
    assert.deepStrictEqual(perSource[0].notes, []);
    assert.strictEqual(results.length, 1);
    assert.strictEqual((await load(results[0], git)).toString(), 'committed');
    assert.ok((await git.gitDirs({ repos: [dir] })).includes(path.join(dir, '.git')));
  } finally {
    if (saved !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = saved;
    fs.unlinkSync(planted);
  }
});

test('trace settings in the git config or the environment make no git call write a log', { skip: !hasGit }, async () => {
  const logs = path.join(root, 'traces');
  fs.mkdirSync(logs);
  const target = (n) => path.join(logs, n).replace(/\\/g, '/');
  const config = write(path.join(root, 'trace.gitconfig'),
    `[trace2]\n\teventTarget = ${target('event')}\n\tnormalTarget = ${target('normal')}\n\tperfTarget = ${target('perf')}\n`);
  const vars = { GIT_CONFIG_GLOBAL: config, GIT_TRACE: target('trace'), GIT_TRACE_PERFORMANCE: target('performance'),
    GIT_TRACE_SETUP: target('setup'), GIT_TRACE_PACK_ACCESS: target('pack'), GIT_TRACE_REFS: target('refs') };
  await withEnv(vars, async () => {
    const { results } = await find({ pattern: '*' }, [repo, lfsRepo]);
    assert.ok(results.length);
    await git.preload(results.map((r) => ({ ...r })));
    await load(byName(results, 'secret.enc')[0], git);
    assert.deepStrictEqual(fs.readdirSync(logs), []);
  });
});

// What `git rev-parse --local-env-vars` lists, as of git 2.55, but for the two that carry -c settings.
const TIED = ['GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR'];

test('variables that tie git to one repository are not passed on to it; settings given with -c are', async () => {
  const kept = { GIT_CONFIG_PARAMETERS: "'core.bigfilethreshold'='1m'", GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.bigfilethreshold', GIT_CONFIG_VALUE_0: '1m' };
  // Windows, and git there, take a variable's name in any case.
  const spelled = process.platform === 'win32' ? TIED.map((n, i) => (i % 2 ? n.toLowerCase() : n)) : TIED;
  await withEnv({ ...Object.fromEntries(spelled.map((n) => [n, 'x'])), ...kept }, () => {
    const e = gitEnv();
    const names = new Set(Object.keys(e).map((k) => k.toUpperCase()));
    for (const n of TIED) assert.ok(!names.has(n), n);
    for (const [k, v] of Object.entries(kept)) assert.strictEqual(e[k], v, k);
  });
  // Every one the installed git counts as such; an older git lists fewer.
  if (hasGit) {
    for (const n of execFileSync('git', ['rev-parse', '--local-env-vars']).toString().split('\n').filter(Boolean)) {
      assert.ok(TIED.includes(n) || n in kept, n);
    }
  }
});

test('an inherited GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE or the like does not make one repository read as another', { skip: !hasGit }, async () => {
  const a = newRepo('inherited-a');
  write(path.join(a, 'only-in-a.txt'), 'kept by a\n');
  write(path.join(a, 'a-present.txt'), 'on disk in a\n');
  commitAll(a, 'a');
  sh(a, 'rm', '-q', 'only-in-a.txt');
  sh(a, 'commit', '-q', '-m', 'gone');
  write(path.join(a, 'a-staged.txt'), 'staged in a\n');
  sh(a, 'add', 'a-staged.txt');
  fs.unlinkSync(path.join(a, 'a-staged.txt'));

  const b = newRepo('inherited-b');
  write(path.join(b, '.gitattributes'), '*.enc filter=crypt\n*.env filter=fromenv\n');
  write(path.join(b, 'b.txt'), 'kept by b\n');
  write(path.join(b, 'b-present.txt'), 'on disk in b\n');
  write(path.join(b, 'secret.enc'), 'stored form\n');
  write(path.join(b, 'conf.env'), 'under a driver named with -c\n');
  commitAll(b, 'b');
  sh(b, 'rm', '-q', 'b.txt', 'secret.enc', 'conf.env');
  sh(b, 'commit', '-q', '-m', 'gone');
  write(path.join(b, 'b-staged.txt'), 'staged in b\n');
  sh(b, 'add', 'b-staged.txt');
  fs.unlinkSync(path.join(b, 'b-staged.txt'));
  for (const [k, v] of Object.entries({ 'filter.crypt.smudge': leavesTrace(expected.marker, 'cat'),
    'filter.crypt.process': leavesTrace(expected.marker), 'filter.crypt.required': 'true' })) sh(b, 'config', k, v);
  const plain = path.join(root, 'inherited-plain');
  fs.mkdirSync(plain);

  // Every copy of b as [kind, path in b, bytes], each read back as restore reads it, and as
  // preload does.
  const seen = async () => {
    const { results, perSource } = await find({ pattern: '*' }, [b]);
    const copies = results.map((r) => ({ ...r }));
    await git.preload(copies);
    const rows = await Promise.all(results.map(async (r, i) => {
      const bytes = await load(r, git);
      assert.deepStrictEqual(copies[i].buffer, bytes, r.path);
      return JSON.stringify([r.kind, path.relative(b, r.path), bytes.toString()]);
    }));
    return { rows: rows.sort(), notes: perSource[0].notes };
  };
  const want = await seen();
  assert.deepStrictEqual(want.notes, []);
  const rows = want.rows.map((r) => JSON.parse(r));
  for (const n of ['b.txt', 'b-staged.txt', 'secret.enc']) assert.ok(rows.some((r) => r[1] === n), `${n} in ${want.rows}`);
  assert.ok(!rows.some((r) => ['only-in-a.txt', 'a-present.txt', 'a-staged.txt'].includes(r[1])), want.rows.join('\n'));
  assert.ok(rows.some(([kind, rel]) => kind === 'git, filter not run' && rel === 'secret.enc'), want.rows.join('\n'));

  const aGit = path.join(a, '.git');
  for (const vars of [
    { GIT_DIR: aGit },
    { GIT_WORK_TREE: a },
    { GIT_INDEX_FILE: path.join(aGit, 'index') },
    { GIT_OBJECT_DIRECTORY: path.join(aGit, 'objects') },
    { GIT_COMMON_DIR: aGit },
    // `git config` would read only this file, and find no filter driver to switch off.
    { GIT_CONFIG: path.join(root, 'empty.gitconfig') },
  ]) {
    await withEnv(vars, async () => {
      const label = Object.keys(vars).join(' ');
      assert.deepStrictEqual(await seen(), want, label);
      // A plain folder is no repository, and restore is kept out of b's own folders, not a's.
      assert.ok(!(await discoverRepos([plain])).includes(plain), label);
      const protect = await git.gitDirs({ repos: [b] });
      assert.ok(protect.some((d) => isInside(path.join(b, '.git', 'objects'), d)), `${label}: ${protect.join(', ')}`);
      assert.ok(!protect.some((d) => isInside(d, a)), `${label}: ${protect.join(', ')}`);
    });
  }

  // Settings given with -c are the user's, as git keeps them for a submodule: a driver named
  // there is switched off like any other.
  await withEnv({ GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'filter.fromenv.smudge', GIT_CONFIG_VALUE_0: leavesTrace(expected.marker, 'cat'),
    GIT_CONFIG_KEY_1: 'filter.fromenv.process', GIT_CONFIG_VALUE_1: leavesTrace(expected.marker),
    GIT_CONFIG_KEY_2: 'filter.fromenv.required', GIT_CONFIG_VALUE_2: 'true' }, async () => {
    const { results } = await find({ pattern: 'conf.env' }, [b]);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].kind, 'git, filter not run');
    assert.match(results[0].note, /"fromenv"/);
    assert.strictEqual((await load(results[0], git)).toString(), 'under a driver named with -c\n');
  });
  assert.strictEqual(fs.existsSync(expected.marker), false, 'no filter program ran');
});

test('a partial clone is read without fetching what it lacks', { skip: !hasGit }, async () => {
  const src = newRepo('promisor');
  sh(src, 'config', 'uploadpack.allowFilter', 'true');
  write(path.join(src, 'old.txt'), 'first version\n');
  commitAll(src, 'one');
  write(path.join(src, 'old.txt'), 'second version\n');
  write(path.join(src, 'gone.txt'), 'deleted later\n');
  commitAll(src, 'two');
  sh(src, 'rm', '-q', 'gone.txt');
  sh(src, 'commit', '-q', '-m', 'three');
  const clone = path.join(root, 'partial');
  sh(root, 'clone', '-q', '--filter=blob:none', fileUrl(src), clone);

  const before = snapshot(path.join(clone, '.git'));
  const { results, perSource } = await find({ pattern: '*.txt' }, [clone]);
  await find({ containing: 'version' }, [clone]);
  await git.preload(results.map((r) => ({ ...r })));
  for (const r of results) await load(r, git);
  assert.deepStrictEqual(snapshot(path.join(clone, '.git')), before);
  if (atLeast(2, 44)) {
    // The clone holds only what it checked out; the rest stayed on its server, and it says so.
    assert.deepStrictEqual(await texts({ results }), ['second version']);
    assert.match(perSource[0].notes.join('\n'), /2 version\(s\) are not in this partial clone/);
  } else {
    assert.deepStrictEqual(results, []);
    assert.match(perSource[0].notes.join('\n'), /partial clone/);
  }
});

test('a clone that borrows objects: the lender\'s object folder is read, and restore stays out of it', { skip: !hasGit }, async () => {
  const lender = newRepo('lender');
  write(path.join(lender, 'doc.txt'), 'kept only by the lender\n');
  commitAll(lender, 'doc');
  const borrower = path.join(root, 'borrower');
  sh(root, 'clone', '-q', '--shared', lender, borrower);
  sh(borrower, 'rm', '-q', 'doc.txt');
  sh(borrower, 'commit', '-q', '-m', 'gone');
  const { results } = await find({ pattern: 'doc.txt' }, [borrower]);
  assert.strictEqual(results.length, 1);
  assert.strictEqual((await load(results[0], git)).toString(), 'kept only by the lender\n');
  const protect = await git.gitDirs({ repos: [borrower] });
  const objects = path.join(lender, '.git', 'objects');
  assert.ok(protect.some((d) => isInside(objects, d)), protect.join(', '));
  await assert.rejects(restore(results[0], path.join(objects, 'restored-here'), protect, git), /Refusing/);
});

test('alternates are read as git reads them: comments, quotes, relative entries, depth', { skip: !hasGit }, async () => {
  const base = path.join(root, 'alternates');
  const at = (...p) => path.join(base, ...p);
  // objects -> c1 -> c2 ... -> c7: git reads alternates files five levels down from the first.
  write(at('objects', 'info', 'alternates'), '# ../ignored\n\n"../quo\\164ed"\n../c1\r\n');
  for (let i = 1; i <= 7; i++) write(at(`c${i}`, 'info', 'alternates'), `../c${i + 1}\n`);
  // git is not handed these, so what they name is not read, and not among the folders.
  await withEnv({ GIT_ALTERNATE_OBJECT_DIRECTORIES: at('env1'), GIT_OBJECT_DIRECTORY: at('env2') }, () => {
    const got = new Set(objectDirs(base).map((d) => path.resolve(d)));
    for (const d of ['quoted', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']) assert.ok(got.has(at(d)), d);
    for (const d of ['ignored', 'c7', 'c8', 'env1', 'env2']) assert.ok(!got.has(at(d)), d);
  });
});

test('rebuilding a repository\'s folder, or one above it, finds its history', { skip: !hasGit }, async () => {
  const { results } = await findUnder(repo, [repo]);
  assert.ok(byName(results, 'deleted.txt').some((r) => r.kind === 'git, deleted in a commit'), results.map((r) => r.path).join(', '));
  assert.strictEqual(byName(results, 'lost.txt').length, 1);
  assert.ok(planRebuild(results, repo).some((p) => p.rel.join('/') === 'docs/deleted.txt'));
  const { results: above } = await findUnder(root, [repo]);
  assert.strictEqual(byName(above, 'deleted.txt').length, 1);
  // A pattern whose literal is the repository's own name.
  const { results: named } = await find({ pattern: 'repo/docs/*.txt' });
  assert.strictEqual(byName(named, 'deleted.txt').length, 1);
});

test('names with a capital outside ASCII, or kept decomposed, are found by name', { skip: !hasGit }, async () => {
  const dir = newRepo('intl');
  const files = ['Übersicht.txt', path.join('École', 'plan.txt'), 'café.txt', 'MAXİ.txt', 'Kelvin.txt'];
  for (const f of files) write(path.join(dir, f), f + '\n');
  commitAll(dir, 'names');
  sh(dir, 'rm', '-q', '-r', '.');
  sh(dir, 'commit', '-q', '-m', 'gone');
  assert.strictEqual((await find({ pattern: '*' }, [dir])).results.length, files.length);
  for (const [pattern, name] of [['Übersicht', 'Übersicht.txt'], ['übersicht.txt', 'Übersicht.txt'],
    ['École/*', 'plan.txt'], ['café', 'café.txt'], ['maxi', 'MAXİ.txt'], ['kelvin', 'Kelvin.txt']]) {
    const { results } = await find({ pattern }, [dir]);
    assert.deepStrictEqual(results.map((r) => path.basename(r.path)), [name], pattern);
    assert.strictEqual(results[0].kind, 'git, deleted in a commit', pattern);
  }
  const { results } = await findUnder(path.join(dir, 'École'), [dir]);
  assert.deepStrictEqual(results.map((r) => path.basename(r.path)), ['plan.txt']);
});

test('the pathspec leaves to the matcher what git cannot fold', () => {
  const both = (g) => [`:(glob,icase)**/*${g}*`, `:(glob,icase)**/*${g}*/**`];
  assert.deepStrictEqual(pathspecs(''), []);
  assert.deepStrictEqual(pathspecs('report'), both('report'));
  assert.deepStrictEqual(pathspecs('übersicht'), both('bers*cht'));
  assert.deepStrictEqual(pathspecs('invoice'), both('nvo*ce'));
  assert.deepStrictEqual(pathspecs('a[1]'), both('a\\[1\\]'));
  assert.deepStrictEqual(pathspecs('é'), []);
});

test('a version kept only on a merged branch is found by name and by folder, as by *', { skip: !hasGit }, async () => {
  const origin = newRepo('merged');
  write(path.join(origin, 'app', 'f.txt'), 'A\n');
  commitAll(origin, 'A');
  sh(origin, 'checkout', '-q', '-b', 'side');
  write(path.join(origin, 'app', 'f.txt'), 'B side\n');
  commitAll(origin, 'B');
  write(path.join(origin, 'app', 'f.txt'), 'A\n');
  commitAll(origin, 'back to A');
  sh(origin, 'checkout', '-q', 'main');
  write(path.join(origin, 'other.txt'), 'o\n');
  commitAll(origin, 'o');
  sh(origin, 'merge', '-q', '--no-ff', '--no-edit', 'side');
  sh(origin, 'rm', '-q', 'app/f.txt');
  sh(origin, 'commit', '-q', '-m', 'rm');
  sh(origin, 'branch', '-q', '-D', 'side');
  // A fresh clone: no reflog names the side branch's commits there.
  const clone = path.join(root, 'merged-clone');
  sh(root, 'clone', '-q', '--no-local', origin, clone);
  assert.deepStrictEqual(await texts(await find({ pattern: '*' }, [clone])), ['A', 'B side', 'o']);
  assert.deepStrictEqual(await texts(await find({ pattern: 'f.txt' }, [clone])), ['A', 'B side']);
  assert.deepStrictEqual(await texts(await findUnder(path.join(clone, 'app'), [clone])), ['A', 'B side']);
});

test('work kept only in a stash is found: changes never staged, and untracked files with -u', { skip: !hasGit || !atLeast(2, 31) }, async () => {
  const dir = newRepo('stash');
  write(path.join(dir, 'w.txt'), 'v1\n');
  commitAll(dir, 'v1');
  write(path.join(dir, 'w.txt'), 'v2, only in the stash\n');
  write(path.join(dir, 'untracked.txt'), 'untracked, only in the stash\n');
  sh(dir, 'stash', '-q', '-u');
  sh(dir, 'rm', '-q', 'w.txt');
  sh(dir, 'commit', '-q', '-m', 'gone');
  assert.deepStrictEqual(await texts(await find({ pattern: 'w.txt' }, [dir])), ['v1', 'v2, only in the stash']);
  assert.deepStrictEqual(await texts(await find({ pattern: 'untracked.txt' }, [dir])), ['untracked, only in the stash']);
});

// ":0:readme" is git's name for stage 0 of readme; Windows refuses such a file name.
test('an index entry named like a stage number is read as itself', { skip: !hasGit || process.platform === 'win32' }, async () => {
  const dir = newRepo('stage-name');
  write(path.join(dir, 'readme'), 'the other file\n');
  write(path.join(dir, '0:readme'), 'this one\n');
  sh(dir, 'add', '-A');
  fs.unlinkSync(path.join(dir, '0:readme'));
  const { results } = await find({ pattern: '0:readme' }, [dir]);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].kind, 'git index');
  assert.strictEqual((await load(results[0], git)).toString(), 'this one\n');
});

test('a copy from the index is dated by its entry, not by the last write to the index', { skip: !hasGit }, async () => {
  const dir = newRepo('index-time');
  const file = write(path.join(dir, 'a.txt'), 'v1 staged\n');
  const then = new Date(Date.UTC(2020, 0, 2, 3, 4, 5));
  fs.utimesSync(file, then, then);
  sh(dir, 'add', 'a.txt');
  fs.unlinkSync(file);
  // Any later write to the index moves its mtime, and says nothing about a.txt.
  write(path.join(dir, 'other.txt'), 'o');
  sh(dir, 'add', 'other.txt');
  const { results } = await find({ pattern: 'a.txt' }, [dir]);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].kind, 'git index');
  assert.strictEqual(Math.floor(results[0].time / 1000), then.getTime() / 1000);
});

test('a symbolic link is a small file only where core.symlinks is false; otherwise it is skipped', { skip: !hasGit }, async () => {
  const dir = newRepo('links');
  write(path.join(dir, 'target.txt'), 'the real content\n');
  sh(dir, 'add', 'target.txt');
  const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'target.txt' }).toString().trim();
  sh(dir, 'update-index', '--add', '--cacheinfo', `120000,${sha},link.txt`);
  sh(dir, 'commit', '-q', '-m', 'link');
  sh(dir, 'rm', '-q', '--cached', 'link.txt');
  sh(dir, 'commit', '-q', '-m', 'no link');
  // In the index only, never on disk.
  sh(dir, 'update-index', '--add', '--cacheinfo', `120000,${sha},staged-link.txt`);

  sh(dir, 'config', 'core.symlinks', 'true');
  const real = await find({ pattern: '*link.txt' }, [dir]);
  assert.deepStrictEqual(real.results, []);
  assert.match(real.perSource[0].notes.join('\n'), /3 version\(s\) of symbolic links were skipped/);

  sh(dir, 'config', 'core.symlinks', 'false');
  const { results } = await find({ pattern: '*link.txt' }, [dir]);
  assert.deepStrictEqual(results.map((r) => `${path.basename(r.path)} ${r.kind}`).sort(),
    ['link.txt git, deleted in a commit', 'staged-link.txt git index']);
  for (const r of results) {
    assert.strictEqual((await load(r, git)).toString(), 'target.txt');
    assert.match(r.note, /symbolic link/);
  }
});

test('.gitattributes line endings: each copy is what checkout writes, and is hashed as such', { skip: !hasGit }, async () => {
  const { results } = await find({ pattern: 'src/*' }, [eolRepo]);
  assert.strictEqual(expected['notes.txt'].toString(), 'one\r\ntwo\r\n', 'the fixture converts');
  assert.strictEqual(expected['run.bat'].toString(), '@echo off\r\necho hi\r\n');
  assert.strictEqual(expected[' lead.txt'].toString(), 'l1\r\nl2\r\n');
  for (const name of ['notes.txt', 'with space.txt', ' lead.txt', 'bin.txt', 'run.bat', 'keep.lf', 'blob.dat']) {
    const hits = byName(results, name);
    assert.strictEqual(hits.length, 1, name);
    const c = hits[0];
    assert.strictEqual(c.kind === 'git commit' || c.kind === 'git, deleted in a commit', true, c.kind);
    assert.deepStrictEqual(await load(c, git), expected[name], name);
    assert.strictEqual(c.size, expected[name].length, name);
    assert.strictEqual(c.hash, blobHash(expected[name]), name);
    assert.strictEqual(c.copies, 2, name);
  }
});

test('core.autocrlf=true: committed and staged copies come back with CRLF', { skip: !hasGit }, async () => {
  const { results } = await find({ pattern: '*' }, [crlfRepo]);
  assert.strictEqual(expected['a.txt'].toString(), 'l1\r\nl2\r\n', 'the fixture converts');
  for (const name of ['a.txt', 'pic.dat', 'staged.txt']) {
    const [c] = byName(results, name);
    assert.ok(c, name);
    assert.deepStrictEqual(await load(c, git), expected[name], name);
    assert.strictEqual(c.hash, blobHash(expected[name]), name);
  }
  assert.strictEqual(byName(results, 'staged.txt')[0].kind, 'git index');
});

test('the size the index recorded decides between the stored and the converted form', { skip: !hasGit }, async () => {
  const { results } = await find({ pattern: '*.txt' }, [crlfRepo]);
  // The index copy and the commit hold one blob: one result, as it was on disk, with LF.
  const tool = byName(results, 'tool.txt');
  assert.strictEqual(tool.length, 1);
  assert.strictEqual(tool[0].copies, 2);
  assert.strictEqual((await load(tool[0], git)).toString(), 't1\nt2\n');
  assert.strictEqual(tool[0].hash, blobHash(Buffer.from('t1\nt2\n')));
  assert.match(tool[0].note, /index recorded/);
  // Neither form is what was on disk, and the kind says so.
  const mixed = byName(results, 'mixed.txt');
  assert.strictEqual(mixed.length, 1);
  assert.strictEqual(mixed[0].kind, 'git, line endings differ');
  assert.match(mixed[0].note, /7 bytes/);
  assert.strictEqual((await load(mixed[0], git)).toString(), 'm1\r\nm2\r\n');
  // A file git checked out itself was recorded converted.
  assert.strictEqual((await load(byName(results, 'staged.txt')[0], git)).toString(), 's1\r\ns2\r\n');
});

test('a search by content reads converted text, and preload gives the same bytes', { skip: !hasGit }, async () => {
  const { results } = await find({ containing: 'l1\r\nl2' }, [crlfRepo]);
  assert.deepStrictEqual(results.map((r) => path.basename(r.path)), ['a.txt']);
  const { results: all } = await find({ pattern: '*' }, [eolRepo, crlfRepo]);
  const copies = all.map((r) => ({ ...r }));
  await git.preload(copies);
  for (const c of copies) {
    assert.ok(c.buffer, c.path);
    assert.deepStrictEqual(c.buffer, await load({ ...c, buffer: undefined }, git), c.path);
    assert.strictEqual(blobHash(c.buffer), c.hash, c.path);
  }
});

test('--location git=<folder> is taken like --repo', { skip: !hasGit }, async () => {
  const { results } = await search({ pattern: 'notes.txt', sources: ['git'], locations: only({ dirs: { git: [eolRepo] } }) });
  assert.strictEqual(results.length, 1);
});

test('a SHA-256 repository is read the same way', { skip: !hasGit }, async (t) => {
  const dir = path.join(root, 'sha256');
  fs.mkdirSync(dir);
  try {
    sh(dir, 'init', '-q', '-b', 'main', '--object-format=sha256');
  } catch (_) {
    t.skip('this git makes no SHA-256 repositories');
    return;
  }
  write(path.join(dir, 'a.txt'), 'sha-256 content\n');
  commitAll(dir, 'a');
  sh(dir, 'rm', '-q', 'a.txt');
  sh(dir, 'commit', '-q', '-m', 'gone');
  const { results } = await find({ pattern: 'a.txt' }, [dir]);
  assert.strictEqual(results.length, 1);
  assert.strictEqual((await load(results[0], git)).toString(), 'sha-256 content\n');
  assert.strictEqual(results[0].hash, blobHash(Buffer.from('sha-256 content\n')));
});

test('Git LFS: the checked object is the file; a missing or damaged one leaves nothing to read', { skip: !hasGit }, async () => {
  const { results, perSource } = await find({ pattern: '*' }, [lfsRepo]);
  assert.deepStrictEqual(perSource[0].notes, [], 'no filter program ran, so git did not stop');

  const [present] = byName(results, 'present.psd');
  assert.strictEqual(present.gone, undefined);
  assert.deepStrictEqual(await load(present, git), expected.art);
  assert.strictEqual(present.hash, blobHash(expected.art));
  assert.strictEqual(present.size, expected.art.length);
  assert.match(present.note, /Git LFS/);

  // A pointer at a path no attributes put under Git LFS, now or in its commit: checkout writes
  // the pointer, and so does this, under a kind that says what it is.
  const [loose] = byName(results, 'note.txt');
  assert.strictEqual(loose.kind, 'git, Git LFS pointer');
  assert.deepStrictEqual(await load(loose, git), Buffer.from(pointer(sha256(expected.loose), expected.loose.length)));
  assert.match(loose.note, /not under filter=lfs/);

  // One whose .gitattributes went with it is still followed, by the commit's own attributes.
  const inSub = byName(results, 'x.bin');
  assert.strictEqual(inSub.length, 1);
  if (atLeast(2, 40)) {
    assert.deepStrictEqual(await load(inSub[0], git), expected.sub);
    assert.match(inSub[0].note, /sha256 match/);
  } else {
    assert.strictEqual(inSub[0].kind, 'git, Git LFS pointer');
  }

  for (const name of ['absent.psd', 'short.psd', 'ext.psd']) {
    const [c] = byName(results, name);
    assert.strictEqual(c.gone, true, name);
    assert.strictEqual(c.state, 'no content', name);
    assert.strictEqual(c.hash, null, name);
    await assert.rejects(load(c, git), name);
  }
  assert.match(byName(results, 'absent.psd')[0].note, /not in/);
  assert.match(byName(results, 'short.psd')[0].note, /bytes/);
  assert.match(byName(results, 'ext.psd')[0].note, /extensions \(foo\)/);

  const [secret] = byName(results, 'secret.enc');
  assert.strictEqual(secret.kind, 'git, filter not run');
  assert.match(secret.note, /"crypt"/);
  assert.strictEqual((await load(secret, git)).toString(), 'stored form\n');

  for (const c of results.filter((r) => !r.gone && r.kind !== 'git, Git LFS pointer')) {
    assert.ok(!(await load(c, git)).toString().startsWith('version https://git-lfs'), c.path);
  }
  assert.strictEqual(fs.existsSync(expected.marker), false, 'no filter program ran');
});

test('Git LFS: an object whose sha256 is not its pointer\'s is not offered', { skip: !hasGit }, async () => {
  const file = lfsObject(lfsRepo, sha256(expected.art));
  const good = fs.readFileSync(file);
  fs.writeFileSync(file, expected.wrong);
  try {
    const { results } = await find({ pattern: 'present.psd' }, [lfsRepo]);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].gone, true);
    assert.match(results[0].note, /sha256/);
  } finally {
    fs.writeFileSync(file, good);
  }
});

test('Git LFS: an object over 32 MB is only measured by a search, and checked when it is read', { skip: !hasGit }, async () => {
  const dir = newRepo('lfs-big');
  write(path.join(dir, '.gitattributes'), '*.psd filter=lfs -text\n');
  const big = Buffer.alloc(HASH_LIMIT + 1, 0x42);
  write(path.join(dir, 'big.psd'), pointer(sha256(big), big.length));
  commitAll(dir, 'big');
  sh(dir, 'rm', '-q', 'big.psd');
  sh(dir, 'commit', '-q', '-m', 'gone');
  const file = write(lfsObject(dir, sha256(big)), big);

  const { results } = await find({ pattern: 'big.psd' }, [dir]);
  assert.strictEqual(results.length, 1);
  const [c] = results;
  assert.strictEqual(c.gone, undefined);
  assert.strictEqual(c.hash, null);
  assert.strictEqual(c.size, big.length);
  assert.match(c.note, /checked when it is read/);
  assert.ok((await load(c, git)).equals(big));

  // Same size, other bytes: still listed, since a search does not read it, but never read back.
  big[0] = 0x43;
  fs.writeFileSync(file, big);
  const { results: again } = await find({ pattern: 'big.psd' }, [dir]);
  assert.strictEqual(again.length, 1);
  await assert.rejects(load(again[0], git), /sha256/);
});

test('a blob over 32 MB under a switched-off filter says so, as a small one does', { skip: !hasGit }, async () => {
  const dir = newRepo('big-filtered');
  write(path.join(dir, '.gitattributes'), '*.enc filter=crypt\n');
  write(path.join(dir, 'big.enc'), Buffer.alloc(HASH_LIMIT + 1, 0x41));
  commitAll(dir, 'big');
  sh(dir, 'rm', '-q', 'big.enc');
  sh(dir, 'commit', '-q', '-m', 'gone');
  sh(dir, 'config', 'filter.crypt.smudge', leavesTrace(expected.marker, 'cat'));
  sh(dir, 'config', 'filter.crypt.required', 'true');
  // Too big to hash, so the commit that added it and the one that deleted it stay two results.
  const { results } = await find({ pattern: 'big.enc' }, [dir]);
  assert.strictEqual(results.length, 2);
  for (const r of results) {
    assert.strictEqual(r.kind, 'git, filter not run');
    assert.match(r.note, /"crypt"/);
  }
  assert.strictEqual(fs.existsSync(expected.marker), false);
});

test('reading LFS objects and switched-off filters leaves those repositories as they were', { skip: !hasGit }, async () => {
  const dirs = [lfsRepo, eolRepo, crlfRepo];
  const before = dirs.map((d) => snapshot(path.join(d, '.git')));
  await find({ pattern: '*' }, dirs);
  const { results } = await find({ pattern: '*' }, dirs);
  await git.preload(results.map((r) => ({ ...r })));
  await find({ containing: 'stored' }, dirs);
  assert.deepStrictEqual(dirs.map((d) => snapshot(path.join(d, '.git'))), before);
  assert.strictEqual(fs.existsSync(expected.marker), false, 'no filter program ran');
});

test('a filter driver whose name cannot be switched off makes the repository be skipped, with a note', { skip: !hasGit }, async () => {
  const dir = newRepo('odd-driver');
  write(path.join(dir, 'a.txt'), 'x');
  commitAll(dir, 'a');
  sh(dir, 'rm', '-q', 'a.txt');
  sh(dir, 'commit', '-q', '-m', 'gone');
  sh(dir, 'config', 'filter.a=b.smudge', leavesTrace(expected.marker, 'cat'));
  const { results, perSource } = await find({ pattern: 'a.txt' }, [dir]);
  assert.deepStrictEqual(results, []);
  assert.match(perSource[0].notes.join('\n'), /cannot be switched off/);
  assert.strictEqual(fs.existsSync(expected.marker), false);
});

test('a filter driver with an empty name is switched off like any other', { skip: !hasGit }, async () => {
  const dir = newRepo('empty-driver');
  // The attribute filter= selects the driver [filter ""], which config lists as filter..smudge.
  write(path.join(dir, '.gitattributes'), '*.txt filter=\n');
  write(path.join(dir, 'a.txt'), 'committed form\n');
  commitAll(dir, 'a');
  sh(dir, 'rm', '-q', 'a.txt');
  sh(dir, 'commit', '-q', '-m', 'gone');
  write(path.join(dir, 'staged.txt'), 'staged form\n');
  sh(dir, 'add', 'staged.txt');
  fs.unlinkSync(path.join(dir, 'staged.txt'));
  for (const [k, v] of Object.entries({ 'filter..smudge': leavesTrace(expected.marker, 'cat'),
    'filter..process': leavesTrace(expected.marker), 'filter..required': 'true' })) sh(dir, 'config', k, v);

  const { results, perSource } = await find({ pattern: '*.txt' }, [dir]);
  assert.deepStrictEqual(perSource[0].notes, [], 'no filter program ran, so git did not stop');
  assert.deepStrictEqual(results.map((r) => path.basename(r.path)).sort(), ['a.txt', 'staged.txt']);
  for (const r of results) {
    assert.strictEqual(r.kind, 'git, filter not run', r.path);
    assert.match(r.note, /its "" filter was not run/, r.path);
  }
  assert.deepStrictEqual(await texts({ results }), ['committed form', 'staged form']);
  await git.preload(results.map((r) => ({ ...r })));
  await find({ containing: 'form' }, [dir]);
  assert.strictEqual(fs.existsSync(expected.marker), false, 'no filter program ran');
});

test('a batch answer that names another object than the one asked for is not taken', { skip: !hasGit }, async () => {
  const oid = sh(repo, 'rev-parse', 'HEAD:keep.txt').toString().trim();
  const got = [];
  await catObjects(repo, ['HEAD:keep.txt', oid, oid.slice(0, 12)], {}, (i, body) => got.push([i, body && body.toString()]));
  assert.deepStrictEqual(got, [[0, null], [1, 'keep'], [2, null]]);
});

test('a pointer is recognised strictly, and one that only looks like it is not read', () => {
  const oid = 'a'.repeat(64);
  assert.deepStrictEqual(parsePointer(Buffer.from(pointer(oid, 12))), { oid, size: 12, extensions: [] });
  assert.deepStrictEqual(parsePointer(Buffer.from(`version https://hawser.github.com/spec/v1\noid sha256:${oid}\nsize 3\n`)),
    { oid, size: 3, extensions: [] });
  const ext = `version https://git-lfs.github.com/spec/v1\next-0-foo sha256:${'b'.repeat(64)}\noid sha256:${oid}\nsize 5\n`;
  assert.deepStrictEqual(parsePointer(Buffer.from(ext)).extensions, ['foo']);
  assert.deepStrictEqual(parsePointer(Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\n`)), { unreadable: true });
  assert.deepStrictEqual(parsePointer(Buffer.from(pointer(oid, 12).replace(/\n/g, '\r\n'))), { unreadable: true });
  assert.strictEqual(parsePointer(Buffer.from('hello\n')), null);
  assert.strictEqual(parsePointer(Buffer.from(pointer(oid, 12) + ' '.repeat(1024))), null);
});

test('batch output is cut at the marker, however the chunks fall', () => {
  const cut = Buffer.from('\nMARK missing\n');
  const stream = Buffer.from('h1 blob 3\nabc\nMARK missing\nx missing\nMARK missing\nh2 blob 0\n\nMARK missing\n');
  const want = ['h1 blob 3\nabc', 'x missing', 'h2 blob 0\n'];
  for (const size of [1, 2, 5, 13, stream.length]) {
    const got = [];
    const feed = splitter(cut, (b) => got.push(b.toString()));
    for (let i = 0; i < stream.length; i += size) feed(stream.subarray(i, i + size));
    assert.deepStrictEqual(got, want, `chunks of ${size}`);
  }
});

test('git log -z --raw is read without quoting, odd names stay whole, and skipped commits give nothing', () => {
  const seen = [];
  const [a, b, z] = ['1', '2', '0'].map((c) => c.repeat(40));
  const log = `\x01aaa\t10\0\n:100644 100644 ${a} ${b} M\0D\0:000000 100755 ${z} ${b} A\0with space.txt\0` +
    `:100644 100644 ${a} ${b} R100\0old\0new\0\x01bbb\t20\0\n:120000 000000 ${a} ${z} D\0a"b.txt\0` +
    `\x01ccc\t30\0\n:000000 100644 ${z} ${a} A\0${'e'.repeat(40)}\0`;
  parseLog(log, (r) => seen.push([r.rev, r.kind, r.rel, r.time, r.oid, r.mode, r.tree]), new Set(['ccc']));
  assert.deepStrictEqual(seen, [
    ['aaa:D', 'git commit', 'D', 10000, b, '100644', 'aaa'],
    ['aaa:with space.txt', 'git commit', 'with space.txt', 10000, b, '100755', 'aaa'],
    ['bbb^:a"b.txt', 'git, deleted in a commit', 'a"b.txt', 20000, a, '120000', 'bbb^'],
  ]);
  assert.strictEqual(fitsLine('a b.txt'), true);
  assert.strictEqual(fitsLine(' lead.txt'), false);
  assert.strictEqual(fitsLine('cr\r'), false);
});
