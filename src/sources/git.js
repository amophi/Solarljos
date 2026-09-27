'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { t } = require('../i18n');
const { HASH_LIMIT } = require('../content');

// A file deleted from a git working tree usually still exists inside .git:
//
//   deleted from disk, still in the index    `git ls-files --deleted`, read back as :<path>
//   committed, then deleted or changed       every version in `git log --all --reflog`
//   committed, then lost to reset --hard     the reflog still names the commit
//   staged once, never committed             an unreachable blob; no name survives, so it is
//                                            only offered to a search by content
//
// Nothing here may write to the repository. GIT_OPTIONAL_LOCKS=0 stops read commands from
// refreshing the index; `git fsck --lost-found`, which writes .git/lost-found, is never run.

const env = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
const CONFIG = [
  '-c', 'core.quotePath=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'gc.auto=0',
];
const SKIP_DIRS = new Set(['node_modules', '.git']);

function run(args, { cwd, input, buffer = false, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', [...CONFIG, ...args], { cwd, env: env(), windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
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

/** Repositories at or below the given folders, two levels down, plus the one a folder sits in. */
async function discoverRepos(roots) {
  const found = new Set();
  const visit = (dir, depth) => {
    if (fs.existsSync(path.join(dir, '.git'))) found.add(path.resolve(dir));
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
    try {
      const top = (await run(['rev-parse', '--show-toplevel'], { cwd: root })).trim();
      if (top) found.add(path.resolve(top));
    } catch (e) {
      if (e.code === 'ENOENT') throw e;
    }
    visit(root, 2);
  }
  return [...found];
}

function escapeGlob(s) {
  return s.replace(/[\\[\]*?]/g, '\\$&');
}

/** Narrows `git log` to paths that can match: the literal in a file name or in a folder name. */
function pathspecs(literal) {
  if (!literal) return [];
  const l = escapeGlob(literal);
  return [`:(glob,icase)**/*${l}*`, `:(glob,icase)**/*${l}*/**`];
}

async function batchCheck(repo, revs) {
  const map = new Map();
  if (!revs.length) return map;
  const out = await run(['cat-file', '--batch-check'], { cwd: repo, input: revs.join('\n') + '\n' });
  const lines = out.split('\n');
  revs.forEach((rev, i) => {
    const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(lines[i] || '');
    if (m && m[2] === 'blob') map.set(rev, { sha: m[1], size: Number(m[3]) });
  });
  return map;
}

async function batchRead(repo, shas) {
  const map = new Map();
  if (!shas.length) return map;
  const out = await run(['cat-file', '--batch'], { cwd: repo, input: shas.join('\n') + '\n', buffer: true });
  let pos = 0;
  for (const sha of shas) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) break;
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(out.subarray(pos, nl).toString());
    if (!m) {
      pos = nl + 1;
      continue;
    }
    const start = nl + 1;
    const size = Number(m[3]);
    map.set(sha, out.subarray(start, start + size));
    pos = start + size + 1;
  }
  return map;
}

function mtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch (_) {
    return null;
  }
}

async function scanRepo(repo, ctx) {
  const gitDir = (await run(['rev-parse', '--absolute-git-dir'], { cwd: repo })).trim();
  const refs = [];
  const add = (rev, kind, rel, time) => {
    const abs = path.join(repo, rel);
    if (ctx.matcher.test(abs)) refs.push({ rev, kind, path: abs, time });
  };

  const indexTime = mtime(path.join(gitDir, 'index'));
  const deleted = await run(['ls-files', '--deleted', '-z'], { cwd: repo });
  for (const rel of deleted.split('\0').filter(Boolean)) add(':' + rel, 'git index', rel, indexTime);

  let log = '';
  try {
    log = await run(['log', '--all', '--reflog', '--no-renames', '--format=%x01%H%x09%ct', '--name-status', '--',
      ...pathspecs(ctx.matcher.literal)], { cwd: repo });
  } catch (_) {
    log = ''; // a repository with no commits yet
  }
  let commit = null;
  let time = null;
  for (const line of log.split('\n')) {
    if (line.startsWith('\x01')) {
      const [h, ct] = line.slice(1).split('\t');
      commit = h;
      time = Number(ct) * 1000;
      continue;
    }
    const m = /^([AMDT])\t(.+)$/.exec(line);
    if (!m || !commit) continue;
    if (m[1] === 'D') add(`${commit}^:${m[2]}`, 'git, deleted in a commit', m[2], time);
    else add(`${commit}:${m[2]}`, 'git commit', m[2], time);
  }

  const seen = new Set();
  const unique = refs.filter((r) => (seen.has(r.rev) ? false : seen.add(r.rev)));
  const objects = await batchCheck(repo, unique.map((r) => r.rev));
  const out = [];
  for (const r of unique) {
    const obj = objects.get(r.rev);
    if (!obj) continue;
    out.push({
      source: 'git', kind: r.kind, path: r.path, time: r.time, size: obj.size,
      hash: obj.sha.length === 40 ? obj.sha : null,
      gitBlob: { repo, sha: obj.sha }, origin: `${repo} ${r.rev}`,
    });
  }

  if (ctx.unnamed) {
    const fsck = await run(['fsck', '--unreachable', '--no-progress'], { cwd: repo, allowFail: true });
    const shas = [...fsck.matchAll(/^unreachable blob ([0-9a-f]{40,64})$/gm)].map((m) => m[1]);
    const sizes = await batchCheck(repo, shas);
    for (const sha of shas) {
      const obj = sizes.get(sha);
      if (!obj) continue;
      out.push({
        source: 'git', kind: 'git object, name unknown', path: null,
        time: mtime(path.join(gitDir, 'objects', sha.slice(0, 2), sha.slice(2))),
        size: obj.size, hash: sha.length === 40 ? sha : null,
        gitBlob: { repo, sha }, origin: `${repo} ${sha}`,
      });
    }
  }
  return out;
}

async function scan(ctx) {
  let repos;
  try {
    repos = await discoverRepos(ctx.locations.repos);
  } catch (e) {
    if (e.code === 'ENOENT') {
      ctx.notes.push(t('git is not installed, so repositories were not searched.'));
      return [];
    }
    throw e;
  }
  ctx.stats.repos = repos.length;
  const out = [];
  for (const repo of repos) {
    try {
      out.push(...(await scanRepo(repo, ctx)));
    } catch (e) {
      ctx.notes.push(t('Skipped {0}: {1}', repo, e.message.split('\n')[0]));
    }
  }
  return out;
}

function readBlob(repo, sha) {
  return run(['cat-file', 'blob', sha], { cwd: repo, buffer: true });
}

/** Loads many blobs in one git call per repository, for a search by content. */
async function preload(candidates) {
  const byRepo = new Map();
  for (const c of candidates) {
    if (!c.gitBlob || c.buffer || (c.size || 0) > HASH_LIMIT) continue;
    if (!byRepo.has(c.gitBlob.repo)) byRepo.set(c.gitBlob.repo, []);
    byRepo.get(c.gitBlob.repo).push(c);
  }
  for (const [repo, list] of byRepo) {
    const blobs = await batchRead(repo, [...new Set(list.map((c) => c.gitBlob.sha))]);
    for (const c of list) {
      const b = blobs.get(c.gitBlob.sha);
      if (b) c.buffer = b;
    }
  }
}

async function describe(ctx) {
  let repos;
  try {
    repos = await discoverRepos(ctx.locations.repos);
  } catch (e) {
    return [t('git is not installed.')];
  }
  const lines = [t('Repositories under {0}: {1}', ctx.locations.repos.join(', ') || '-', repos.length)];
  for (const r of repos) lines.push('  ' + r);
  return lines;
}

module.exports = {
  id: 'git',
  label: 'git',
  scan,
  describe,
  readBlob,
  preload,
  roots: () => [],
  gitDirs: async (loc) => {
    try {
      return (await discoverRepos(loc.repos)).map((r) => path.join(r, '.git'));
    } catch (_) {
      return [];
    }
  },
  _internal: { pathspecs, discoverRepos },
};
