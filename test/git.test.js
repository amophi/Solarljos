'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { workDir, cleanup, write, only, snapshot } = require('./helpers');
const { search, git } = require('../src/search');
const { load } = require('../src/content');

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch (_) {
  hasGit = false;
}

let root;
let repo;

// The repository is built with the user's and the system's git configuration shut out, so
// no global hook or setting can run, and nothing outside test/.work is touched.
function sh(...args) {
  return execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
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
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  sh('init', '-q', '-b', 'main');

  // Committed, then deleted in a later commit.
  write(path.join(repo, 'keep.txt'), 'keep');
  write(path.join(repo, 'docs', 'deleted.txt'), 'old content');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'first');
  sh('rm', '-q', 'docs/deleted.txt');
  sh('commit', '-q', '-m', 'remove it');

  // Committed, then thrown away by reset --hard: only the reflog remembers it.
  write(path.join(repo, 'lost.txt'), 'lost work');
  sh('add', 'lost.txt');
  sh('commit', '-q', '-m', 'about to be lost');
  sh('reset', '-q', '--hard', 'HEAD~1');

  // Staged, then deleted from disk without a commit.
  write(path.join(repo, 'staged.txt'), 'staged only');
  sh('add', 'staged.txt');
  fs.unlinkSync(path.join(repo, 'staged.txt'));

  // Staged, then staged again with other content: the first version is left unreachable.
  write(path.join(repo, 'draft.txt'), 'first draft, orphaned');
  sh('add', 'draft.txt');
  write(path.join(repo, 'draft.txt'), 'second draft');
  sh('add', 'draft.txt');
});

after(() => {
  if (root) cleanup(root);
});

const find = (o) => search({ sources: ['git'], locations: only({ repos: [repo] }), ...o });

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

test('an orphaned blob is offered to a search by content', { skip: !hasGit }, async () => {
  const { results } = await find({ containing: 'ORPHANED' });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].kind, 'git object, name unknown');
  assert.strictEqual(results[0].path, null);
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
  // test/.work sits inside this project's own checkout, which counts as the enclosing one.
  const enclosing = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root }).toString().trim();
  assert.ok(found.includes(path.resolve(enclosing)), found.join(', '));
});
