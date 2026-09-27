'use strict';

const { parseArgs } = require('util');
const { t } = require('./i18n');
const { search, sourceRoots, describeAll, git } = require('./search');
const { restore } = require('./restore');
const { load, looksBinary } = require('./content');
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
  'history-dir': { type: 'string', multiple: true },
  'recycle-dir': { type: 'string', multiple: true },
  'no-discover': { type: 'boolean' },
  to: { type: 'string' },
  binary: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const HELP = () => t(`solarljos {0} -- find deleted files in the places copies survive

Usage
  solarljos find <name>                    list every surviving copy, newest first
  solarljos show <name> <id>               print one copy
  solarljos restore <name> <id> --to <dir> write one copy into <dir>
  solarljos sources                        show what can be searched on this machine

  <name> matches file names, any case: "report" finds report-final.docx. With * or ? it is
  a glob over the whole name ("*.docx"); with a slash it is matched against the full path.

Options
  --containing <text>   only copies whose text contains <text>; with no <name>, also copies
                        whose file name was lost
  --deleted-only        only copies whose original path no longer exists
  --since <when>        only copies from then on: 2026-09-01, 7d, 12h
  --source <ids>        search only these: recycle, history, claude, git (comma-separated)
  --limit <n>           rows to show (default 30); --all shows every row
  --json                machine-readable output
  --to <dir>            restore: where to write; never inside a searched location

Locations (added to the ones found on this machine unless --no-discover)
  --recycle-dir <dir>   a $Recycle.Bin folder, or one account's folder inside it
  --history-dir <dir>   an editor's User/History folder
  --claude-dir <dir>    a Claude Code config folder (normally ~/.claude)
  --repo <dir>          look for git repositories here (default: the current folder)
  --no-discover         search only the locations given

Nothing is ever written except by restore, and only under --to.`, pkg.version);

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
      repos: v.repo,
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
  for (const d of v.repo || []) out.push('--repo', fmt.arg(d));
  if (v['no-discover']) out.push('--no-discover');
  return out.join(' ');
}

const print = (s = '') => process.stdout.write(s + '\n');
const note = (s = '') => process.stderr.write(s + '\n');

function kindLabel(c) {
  return t(c.kind) + (c.copies > 1 ? ` x${c.copies}` : '');
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
