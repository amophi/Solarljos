'use strict';

const path = require('path');
const { parseArgs } = require('util');
const { t } = require('./i18n');
const { search, sourceRoots, describeAll, git } = require('./search');
const { restore, planRebuild, rebuild } = require('./restore');
const { load, looksBinary } = require('./content');
const { isWindowsPath } = require('./paths');
const fmt = require('./format');
const pkg = require('../package.json');

const OPTIONS = {
  source: { type: 'string', multiple: true },
  containing: { type: 'string' },
  'deleted-only': { type: 'boolean' },
  since: { type: 'string' },
  limit: { type: 'string' },
  all: { type: 'boolean' },
  json: { type: 'boolean' },
  repo: { type: 'string', multiple: true },
  'claude-dir': { type: 'string' },
  'antigravity-dir': { type: 'string', multiple: true },
  location: { type: 'string', multiple: true },
  'history-dir': { type: 'string', multiple: true },
  'recycle-dir': { type: 'string', multiple: true },
  'no-discover': { type: 'boolean' },
  to: { type: 'string' },
  'dry-run': { type: 'boolean' },
  binary: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const HELP = () => t(`solarljos {0} -- find deleted files in the places copies survive

Usage
  solarljos find <name>                    list every surviving copy, newest first
  solarljos show <name> <id>               print one copy
  solarljos restore <name> <id> --to <dir> write one copy into <dir>
  solarljos rebuild <folder> --to <dir>    bring back everything below a folder, newest copies
  solarljos sources                        show what can be searched on this machine

  <name> matches file names, any case: "report" finds report-final.docx. With * or ? it is
  a glob over the whole name ("*.docx"); with a slash it is matched against the full path.

Options
  --containing <text>   only copies whose text contains <text>; with no <name>, also copies
                        whose file name was lost
  --deleted-only        only copies whose original path no longer exists
  --since <when>        only copies from then on: 2026-09-01, 7d, 12h
  --source <ids>        search only these: recycle, history, claude, antigravity, git
  --limit <n>           rows to show (default 30); --all shows every row
  --json                machine-readable output
  --to <dir>            restore, rebuild: where to write; never inside a searched location
  --dry-run             rebuild: list what would be written, write nothing

Locations (added to the ones found on this machine unless --no-discover)
  --recycle-dir <dir>       a $Recycle.Bin folder, or one account's folder inside it
  --history-dir <dir>       an editor's User/History folder
  --claude-dir <dir>        a Claude Code config folder (normally ~/.claude)
  --antigravity-dir <dir>   an Antigravity data folder (normally ~/.gemini/antigravity-ide)
  --location <id>=<place>   a place for any other source, e.g. jetbrains=D:\old\LocalHistory
  --repo <dir>              look for git repositories here (default: the current folder)
  --no-discover             search only the locations given

Nothing is ever written except by restore and rebuild, and only under --to.`, pkg.version);

function usageError(message) {
  const e = new Error(message);
  e.usage = true;
  return e;
}

function parseSince(s) {
  const rel = /^(\d+)\s*([dhm])$/i.exec(s.trim());
  if (rel) {
    const unit = { d: 86400000, h: 3600000, m: 60000 }[rel[2].toLowerCase()];
    return Date.now() - Number(rel[1]) * unit;
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw usageError(t('Could not read --since {0}. Use a date like 2026-09-01, or 7d / 12h.', s));
  return ms;
}

/** --location <id>=<place>, repeatable, grouped by source id. */
function ownDirs(v) {
  const dirs = {};
  for (const entry of v.location || []) {
    const at = entry.indexOf('=');
    if (at <= 0) throw usageError(t('Write --location as <source>=<place>, for example notepad=D:\\old\\TabState.'));
    const id = entry.slice(0, at).trim();
    (dirs[id] = dirs[id] || []).push(entry.slice(at + 1).trim());
  }
  return dirs;
}

function searchOptions(v, pattern) {
  return {
    pattern,
    containing: v.containing,
    sources: (v.source || []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean),
    deletedOnly: !!v['deleted-only'],
    since: v.since ? parseSince(v.since) : undefined,
    locations: {
      discover: !v['no-discover'],
      recycleDirs: v['recycle-dir'],
      historyDirs: v['history-dir'],
      claudeDir: v['claude-dir'],
      antigravityDirs: v['antigravity-dir'],
      repos: v.repo,
      dirs: ownDirs(v),
    },
  };
}

/** The options that decide which copies exist, repeated in the follow-up commands shown. */
function carryOver(v) {
  const out = [];
  if (v.containing) out.push('--containing', fmt.arg(v.containing));
  for (const s of v.source || []) out.push('--source', fmt.arg(s));
  for (const d of v['recycle-dir'] || []) out.push('--recycle-dir', fmt.arg(d));
  for (const d of v['history-dir'] || []) out.push('--history-dir', fmt.arg(d));
  if (v['claude-dir']) out.push('--claude-dir', fmt.arg(v['claude-dir']));
  for (const d of v['antigravity-dir'] || []) out.push('--antigravity-dir', fmt.arg(d));
  for (const d of v.location || []) out.push('--location', fmt.arg(d));
  for (const d of v.repo || []) out.push('--repo', fmt.arg(d));
  if (v['no-discover']) out.push('--no-discover');
  return out.join(' ');
}

const print = (s = '') => process.stdout.write(s + '\n');
const note = (s = '') => process.stderr.write(s + '\n');

function kindLabel(c) {
  return t(c.kind) + (c.draft ? ' ' + t('(never saved)') : '') + (c.copies > 1 ? ` x${c.copies}` : '');
}

function toJson(c) {
  return {
    id: c.id,
    time: c.time == null ? null : new Date(c.time).toISOString(),
    kind: c.kind,
    seenAs: c.seen,
    copies: c.copies,
    source: c.source,
    path: c.path,
    size: c.size,
    state: c.state,
    draft: !!c.draft,
    origin: c.origin,
    note: c.note || null,
  };
}

async function cmdFind(pattern, v) {
  if (!pattern && !v.containing) throw usageError(t('Give a name to look for, or --containing <text>.'));
  if (!v.json) note(t('Searching for {0}...', pattern ? `"${pattern}"` : t('any file containing "{0}"', v.containing)));
  const { results, perSource, stats } = await search(searchOptions(v, pattern));

  if (v.json) {
    print(JSON.stringify({ results: results.map(toJson), sources: perSource }, null, 2));
    return results.length ? 0 : 1;
  }

  print('');
  const width = Math.max(...perSource.map((s) => t(s.label).length));
  for (const s of perSource) {
    let extra = '';
    if (s.id === 'git' && stats.repos != null) extra = '   ' + t('(repositories searched: {0})', stats.repos);
    if (s.error) extra = '   ' + t('failed: {0}', s.error);
    print(`  ${t(s.label).padEnd(width)}  ${String(s.count).padStart(5)}${extra}`);
    for (const n of s.notes || []) print(`  ${' '.repeat(width)}  ! ${n}`);
  }
  print('');

  if (!results.length) {
    print(t('Nothing found.'));
    return 1;
  }
  const limit = v.all ? Infinity : Math.max(1, Number(v.limit) || 30);
  const shown = results.slice(0, limit);
  const rows = shown.map((c) => [
    c.id, fmt.when(c.time), kindLabel(c), fmt.size(c.size), t(c.state || '-'), c.path || t('(name unknown)'),
  ]);
  print(fmt.table([t('ID'), t('WHEN'), t('FOUND IN'), t('SIZE'), t('STATE'), t('PATH')], rows));
  if (shown.length < results.length) {
    print('');
    print(t('Showing {0} of {1}. Use --all to see every one.', shown.length, results.length));
  }
  const again = [pattern ? fmt.arg(pattern) : '', carryOver(v)].filter(Boolean).join(' ');
  print('');
  print(t('To read one:      solarljos show {0} <id>', again));
  print(t('To get one back:  solarljos restore {0} <id> --to <folder>', again));
  return 0;
}

function pick(results, id) {
  const want = String(id).toLowerCase();
  const hits = results.filter((c) => c.id.startsWith(want));
  if (!hits.length) {
    throw new Error(t('No copy has the ID {0}. Run find again with the same options; an ID follows the content, so a copy that changed has a new one.', id));
  }
  if (hits.length > 1) throw new Error(t('The ID {0} fits more than one copy; give more of it.', id));
  return hits[0];
}

/** show and restore take `<name> <id>`, or just `<id>` when searching by content alone. */
function nameAndId(rest, v) {
  if (rest.length >= 2) return { pattern: rest[0], id: rest[1] };
  if (rest.length === 1 && v.containing) return { pattern: '', id: rest[0] };
  throw usageError(t('Give the same name you searched for, then the ID from the list.'));
}

async function cmdShow(rest, v) {
  const { pattern, id } = nameAndId(rest, v);
  const { results } = await search({ ...searchOptions(v, pattern), deletedOnly: false, since: undefined });
  const c = pick(results, id);
  if (c.isDir) throw new Error(t('That is a folder; restore it instead.'));
  const buf = await load(c, git);
  if (looksBinary(buf) && !v.binary) {
    throw new Error(t('That looks like a binary file ({0}). Restore it, or add --binary to print it anyway.', fmt.size(buf.length)));
  }
  note(`${c.id}  ${t(c.kind)}  ${fmt.when(c.time)}  ${fmt.size(c.size)}`);
  note(t('was   {0}', c.path || t('(name unknown)')));
  note(t('from  {0}', c.origin));
  note('');
  process.stdout.write(buf);
  if (buf.length && buf[buf.length - 1] !== 0x0a) process.stdout.write('\n');
  return 0;
}

async function cmdRestore(rest, v) {
  const { pattern, id } = nameAndId(rest, v);
  if (!v.to) throw usageError(t('Say where to put it with --to <folder>.'));
  const opts = { ...searchOptions(v, pattern), deletedOnly: false, since: undefined };
  const { results, locations } = await search(opts);
  const c = pick(results, id);
  const target = await restore(c, v.to, await sourceRoots(locations), git);
  print(t('Restored {0} to {1}', c.id, target));
  return 0;
}

/** A folder as given, made absolute unless it already is; a Windows path stays one anywhere. */
function absoluteFolder(folder) {
  const trimmed = folder.replace(/[\\/]+$/, '');
  return isWindowsPath(folder) || folder.startsWith('/') ? trimmed : path.resolve(trimmed);
}

function planJson(folder, plan) {
  return {
    folder,
    files: plan.map(({ rel, copy }) => ({
      path: rel.join('/'),
      from: toJson(copy),
    })),
  };
}

async function cmdRebuild(rest, v) {
  if (!rest[0]) throw usageError(t('Give the folder to rebuild, as it was: solarljos rebuild C:\\work\\project --to <dir>'));
  const dryRun = !!v['dry-run'];
  if (!dryRun && !v.to) throw usageError(t('Say where to put it with --to <folder>, or look first with --dry-run.'));
  const folder = absoluteFolder(rest[0]);
  if (!v.json) note(t('Collecting every copy of anything below {0}...', folder));
  const { results, locations } = await search({ ...searchOptions(v, ''), under: folder });
  const plan = planRebuild(results, folder);
  const sep = isWindowsPath(folder) ? '\\' : '/';

  if (dryRun) {
    if (v.json) {
      print(JSON.stringify(planJson(folder, plan), null, 2));
      return plan.length ? 0 : 1;
    }
    if (!plan.length) {
      print(t('Nothing found below {0}.', folder));
      return 1;
    }
    print('');
    print(fmt.table([t('WHEN'), t('FROM'), t('SIZE'), t('FILE')],
      plan.map(({ rel, copy }) => [fmt.when(copy.time), t(copy.kind), fmt.size(copy.size), rel.join(sep)])));
    print('');
    print(t('{0} file(s) would be written. Nothing was written.', plan.length));
    return 0;
  }

  if (!plan.length) {
    if (v.json) print(JSON.stringify({ folder, root: null, written: [], failed: [] }, null, 2));
    else print(t('Nothing found below {0}.', folder));
    return 1;
  }
  const { root, written, failed } = await rebuild(plan, folder, v.to, await sourceRoots(locations), git);
  if (v.json) {
    print(JSON.stringify({
      folder, root,
      written: written.map((w) => ({ path: w.rel.join('/'), target: w.target, from: toJson(w.copy) })),
      failed: failed.map((f) => ({ path: f.rel.join('/'), error: f.error })),
    }, null, 2));
    return failed.length ? 1 : 0;
  }
  const byKind = new Map();
  for (const w of written) byKind.set(w.copy.kind, (byKind.get(w.copy.kind) || 0) + 1);
  print('');
  print(t('Rebuilt {0} of {1} file(s) below {2}', written.length, plan.length, folder));
  print(t('into {0}', root));
  print('');
  for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) print(`  ${String(n).padStart(5)}  ${t(kind)}`);
  if (failed.length) {
    print('');
    print(t('Could not read {0} file(s):', failed.length));
    for (const f of failed) print(`  ${f.rel.join(sep)}  (${f.error})`);
    return 1;
  }
  return 0;
}

async function cmdSources(v) {
  const groups = await describeAll(searchOptions(v, ''));
  for (const g of groups) {
    print(t(g.label));
    for (const line of g.lines) print('  ' + line);
    print('');
  }
  return 0;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    note(e.message);
    note(t('Run solarljos --help for usage.'));
    return 2;
  }
  const v = parsed.values;
  const [command, ...rest] = parsed.positionals;
  if (v.version) {
    print(pkg.version);
    return 0;
  }
  if (v.help || !command || command === 'help') {
    print(HELP());
    return 0;
  }
  try {
    switch (command) {
      case 'find': return await cmdFind(rest[0], v);
      case 'show': return await cmdShow(rest, v);
      case 'restore': return await cmdRestore(rest, v);
      case 'rebuild': return await cmdRebuild(rest, v);
      case 'sources': return await cmdSources(v);
      default: throw usageError(t('Unknown command: {0}', command));
    }
  } catch (e) {
    note(e.message);
    if (e.usage) {
      note(t('Run solarljos --help for usage.'));
      return 2;
    }
    return 1;
  }
}

module.exports = { main };
