'use strict';

const { parseArgs } = require('util');
const { t } = require('./i18n');
const { search, sourceRoots, describeAll, locate, git } = require('./search');
const { restore, planRebuild, leftOutOf, rebuild } = require('./restore');
const { load, looksBinary } = require('./content');
const { isWindowsPath, absoluteFolder } = require('./paths');
const { tier, isDerived, isUnverified } = require('./quality');
const { parseTypes } = require('./types');
const fmt = require('./format');
const pkg = require('../package.json');

const OPTIONS = {
  source: { type: 'string', multiple: true },
  containing: { type: 'string' },
  type: { type: 'string', multiple: true },
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
  port: { type: 'string' },
  'no-open': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

// Raw, so that the backslashes of the Windows paths in the examples are printed as written.
const HELP = () => t(String.raw`solarljos {0} -- find deleted files in the places copies survive

Usage
  solarljos find <name>                    list every surviving copy, newest first
  solarljos show <name> <id>               print one copy
  solarljos restore <name> <id> --to <dir> write one copy into <dir>
  solarljos rebuild <folder> --to <dir>    bring back everything below a folder, newest copies
  solarljos sources                        show what can be searched on this machine
  solarljos gui                            open the graphical front end in a browser window

  <name> matches file names, any case: "report" finds report-final.docx. With * or ? it is
  a glob over the whole name ("*.docx"); with a slash it is matched against the full path.

Options
  --containing <text>   only copies whose text contains <text>; with no <name>, also copies
                        whose file name was lost
  --type <kinds>        only these kinds of file (comma-separated): image, video, audio,
                        document, archive, text; with no <name>, also copies whose file name
                        was lost, told by their content
  --deleted-only        only copies whose original path no longer exists
  --since <when>        only copies from then on: 2026-09-01, 7d, 12h; copies that carry
                        no date are kept
  --source <ids>        search only these (comma-separated): recycle, history, claude,
                        antigravity, git, jetbrains, eclipse-history, notepad,
                        editor-backups, hancom, trash, thumbcache, snips, removable, vss
  --limit <n>           rows to show (default 30); --all shows every row
  --json                find, rebuild: machine-readable output
  --binary              show: print a copy even when it looks binary
  --to <dir>            restore, rebuild: where to write; not where sources keep records
  --dry-run             rebuild: list what would be written, write nothing
  --port <n>            gui: the port to listen on, on 127.0.0.1 only (default: a free one)
  --no-open             gui: print the address instead of opening a browser window

Locations (added to the ones found on this machine unless --no-discover)
  --recycle-dir <dir>       a $Recycle.Bin folder, or one account's folder inside it
  --history-dir <dir>       an editor's User/History folder
  --claude-dir <dir>        a Claude Code config folder, such as ~/.claude from another machine
  --antigravity-dir <dir>   an Antigravity data folder (normally ~/.gemini/antigravity-ide),
                            its brain folder, or one conversation's folder
  --location <id>=<place>   a place for any source, repeatable, for example
                            jetbrains=D:\old\AndroidStudio2026.1   notepad=D:\old\Users\me
                            vss=walk=C:\Users\me\Projects   trash=E:\   git=D:\code
  --repo <dir>              look for git repositories here instead of the current folder;
                            --location git=<dir> is the same
  --no-discover             search only the locations given

Nothing is ever written except by restore and rebuild, and only under --to. The programs run
while searching only read: git, to read repositories, and mountvol.exe, which lists the drives'
volume names for the thumbnail cache and writes nothing. gui also opens a browser window, unless
--no-open: an Edge InPrivate window where Edge is installed, which keeps no history of the visit
but writes what Edge writes whenever it starts; otherwise, and when run as administrator, the
default browser, which records the visit as it records any other. Its address works once.`, pkg.version);

function usageError(message) {
  const e = new Error(message);
  e.usage = true;
  return e;
}

/**
 * A date alone is midnight where the user is, as every time shown is local. Date.parse reads
 * 2026-09-01 as midnight UTC, which east of Greenwich drops the first hours of the day; a date
 * with a time and no zone it already reads as local.
 */
function parseSince(s) {
  const text = s.trim();
  const rel = /^(\d+)\s*([dhm])$/i.exec(text);
  if (rel) {
    const unit = { d: 86400000, h: 3600000, m: 60000 }[rel[2].toLowerCase()];
    return Date.now() - Number(rel[1]) * unit;
  }
  const bad = () => usageError(t('Could not read --since {0}. Use a date like 2026-09-01, or 7d / 12h.', s));
  const day = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(text);
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3] || 1)];
    const at = new Date(y, m - 1, d);
    // new Date() rolls 2026-02-30 over into March; a day that does not exist is a mistake.
    if (at.getFullYear() !== y || at.getMonth() !== m - 1 || at.getDate() !== d) throw bad();
    return at.getTime();
  }
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw bad();
  return ms;
}

/** --location <id>=<place>, repeatable, grouped by source id. Which ids exist, search.js knows. */
function ownDirs(v) {
  // No prototype: an id such as "constructor" is a key like any other, and is refused as unknown.
  const dirs = Object.create(null);
  for (const entry of v.location || []) {
    const at = entry.indexOf('=');
    if (at <= 0) throw usageError(t('Write --location as <source>=<place>, for example notepad=D:\\old\\TabState.'));
    const id = entry.slice(0, at).trim();
    const place = entry.slice(at + 1).trim();
    if (!place) throw usageError(t('Give a place after {0}= in --location, for example notepad=D:\\old\\TabState.', id));
    (dirs[id] = dirs[id] || []).push(place);
  }
  return dirs;
}

function searchOptions(v, pattern) {
  return {
    pattern,
    containing: v.containing,
    types: parseTypes(v.type),
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
  for (const s of v.type || []) out.push('--type', fmt.arg(s));
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

/** The kind, and what the copy is when it is not simply the file: never saved, smaller, perhaps incomplete. */
function kindLabel(c) {
  const said = [t(c.kind)];
  // Most draft kinds already say so; the rest get it spelled out.
  if (c.draft && !/never saved|unsaved/i.test(c.kind)) said.push(t('(never saved)'));
  if (isDerived(c)) said.push(t('(smaller copy)'));
  if (isUnverified(c)) said.push(t('(may be incomplete)'));
  return said.join(' ') + (c.copies > 1 ? ` x${c.copies}` : '');
}

/** The original path, or the name alone when that is all a source knows; a picture's size after it. */
function shownPath(c) {
  const size = c.width && c.height ? `  ${c.width}x${c.height}` : '';
  if (c.path) return c.path + size;
  if (c.name) return t('{0} (folder unknown)', c.name) + size;
  return (c.ext ? t('(name unknown, a {0} file)', c.ext) : t('(name unknown)')) + size;
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
    name: c.name || null,
    size: c.size,
    state: c.state,
    draft: !!c.draft,
    derived: isDerived(c),
    unverified: isUnverified(c),
    tier: tier(c),
    mediaType: c.mediaType == null ? null : c.mediaType,
    width: c.width || null,
    height: c.height || null,
    origin: c.origin,
    note: c.note || null,
  };
}

/** Notes that concern the whole search, such as copies kept for carrying no date. */
function printNotes(notes) {
  for (const n of notes || []) print(`  ! ${n}`);
}

async function cmdFind(pattern, v) {
  if (!pattern && !v.containing && !v.type) throw usageError(t('Give a name to look for, --containing <text>, or --type <kinds>.'));
  const opts = searchOptions(v, pattern);
  if (!v.json) {
    let what = `"${pattern}"`;
    if (!pattern) what = v.containing ? t('any file containing "{0}"', v.containing) : t('any file of type {0}', opts.types.join(', '));
    note(t('Searching for {0}...', what));
  }
  const { results, perSource, stats, notes } = await search(opts);

  if (v.json) {
    print(JSON.stringify({ results: results.map(toJson), sources: perSource, notes }, null, 2));
    return results.length ? 0 : 1;
  }

  print('');
  const width = Math.max(...perSource.map((s) => t(s.label).length));
  for (const s of perSource) {
    let extra = '';
    if (s.id === 'git' && stats.repos != null) extra = '   ' + t('(repositories searched: {0})', stats.repos);
    if (s.error) extra = '   ' + t('failed: {0}', s.error);
    print(`  ${t(s.label).padEnd(width)}  ${(s.skipped ? '-' : String(s.count)).padStart(5)}${extra}`);
    for (const n of s.notes || []) print(`  ${' '.repeat(width)}  ! ${n}`);
  }
  printNotes(notes);
  print('');

  if (!results.length) {
    print(t('Nothing found.'));
    return 1;
  }
  const limit = v.all ? Infinity : Math.max(1, Number(v.limit) || 30);
  const shown = results.slice(0, limit);
  const rows = shown.map((c) => [
    c.id, fmt.when(c.time), kindLabel(c), fmt.size(c.size), t(c.state || '-'), shownPath(c),
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

/** show and restore take `<name> <id>`, or just `<id>` when searching by content or type alone. */
function nameAndId(rest, v) {
  if (rest.length >= 2) return { pattern: rest[0], id: rest[1] };
  if (rest.length === 1 && (v.containing || v.type)) return { pattern: '', id: rest[0] };
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
  note(t('was   {0}', shownPath(c)));
  note(t('from  {0}', c.origin));
  if (c.note) note(t('note  {0}', c.note));
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

function planJson(folder, plan, leftOut) {
  const entry = ({ rel, copy }) => ({ path: rel.join('/'), from: toJson(copy) });
  return { folder, files: plan.map(entry), leftOut: leftOut.map(entry) };
}

/** The paths rebuild leaves out, as only smaller or perhaps incomplete copies of them are left. */
function printLeftOut(leftOut, sep) {
  if (!leftOut.length) return;
  print('');
  print(t('{0} file(s) are left out: all that is left of them is a smaller copy, or one that may be incomplete. '
    + 'Look at them with find, and restore the ones you want one by one:', leftOut.length));
  for (const { rel, copy } of leftOut) print(`  ${rel.join(sep)}  (${kindLabel(copy)})`);
}

async function cmdRebuild(rest, v) {
  if (!rest[0]) throw usageError(t('Give the folder to rebuild, as it was: solarljos rebuild C:\\work\\project --to <dir>'));
  const dryRun = !!v['dry-run'];
  if (!dryRun && !v.to) throw usageError(t('Say where to put it with --to <folder>, or look first with --dry-run.'));
  const folder = absoluteFolder(rest[0]);
  if (!v.json) note(t('Collecting every copy of anything below {0}...', folder));
  const { results, locations, perSource, notes } = await search({ ...searchOptions(v, ''), under: folder });
  const plan = planRebuild(results, folder);
  const leftOut = leftOutOf(results, folder);
  const sep = isWindowsPath(folder) ? '\\' : '/';

  // What the sources had to say -- a part they could not read, a folder they would not walk --
  // matters most when little or nothing turned up.
  if (!v.json) {
    for (const s of perSource) {
      if (s.error) print(`  ! ${t(s.label)}: ${t('failed: {0}', s.error)}`);
      for (const n of s.notes || []) print(`  ! ${t(s.label)}: ${n}`);
    }
    printNotes(notes);
  }

  if (dryRun) {
    if (v.json) {
      print(JSON.stringify({ ...planJson(folder, plan, leftOut), sources: perSource, notes }, null, 2));
      return plan.length ? 0 : 1;
    }
    if (!plan.length) {
      printLeftOut(leftOut, sep);
      print(t('Nothing found below {0}.', folder));
      return 1;
    }
    print('');
    print(fmt.table([t('WHEN'), t('FROM'), t('SIZE'), t('FILE')],
      plan.map(({ rel, copy }) => [fmt.when(copy.time), kindLabel({ ...copy, copies: 1 }), fmt.size(copy.size), rel.join(sep)])));
    printLeftOut(leftOut, sep);
    print('');
    print(t('{0} file(s) would be written. Nothing was written.', plan.length));
    return 0;
  }

  if (!plan.length) {
    if (v.json) {
      print(JSON.stringify({ folder, root: null, written: [], failed: [], leftOut: planJson(folder, [], leftOut).leftOut, sources: perSource, notes }, null, 2));
    } else {
      printLeftOut(leftOut, sep);
      print(t('Nothing found below {0}.', folder));
    }
    return 1;
  }
  const { root, written, failed } = await rebuild(plan, folder, v.to, await sourceRoots(locations), git);
  if (v.json) {
    print(JSON.stringify({
      folder, root,
      written: written.map((w) => ({ path: w.rel.join('/'), target: w.target, from: toJson(w.copy) })),
      failed: failed.map((f) => ({ path: f.rel.join('/'), error: f.error })),
      leftOut: planJson(folder, [], leftOut).leftOut,
      sources: perSource,
      notes,
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
  printLeftOut(leftOut, sep);
  if (failed.length) {
    print('');
    print(t('Could not read or write {0} file(s):', failed.length));
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

/**
 * Starts the graphical front end: a web server on 127.0.0.1 and, unless --no-open, a browser
 * window on it. The server is loaded only here, so the rest of the command line never loads it.
 * It says itself where it can be reached, how its window was opened -- with --no-open none is,
 * and the address is only printed -- and how it stops; the process keeps running while it does.
 */
async function cmdGui(v, deps) {
  let port = 0;
  if (v.port !== undefined) {
    port = /^\d{1,5}$/.test(v.port.trim()) ? Number(v.port) : NaN;
    if (!(port >= 0 && port <= 65535)) throw usageError(t('Give --port as a number from 0 to 65535.'));
  }
  await deps.gui().start({ port, open: !v['no-open'], host: '127.0.0.1' });
  return 0;
}

// What main() reaches outside this file, replaceable for tests: the GUI server, and whether this
// runs as the single Solarljos executable, where no arguments at all -- a double-click -- means
// the GUI rather than the help.
const DEPS = {
  gui: () => require('./gui/server'),
  isSea: () => {
    try {
      return require('node:sea').isSea();
    } catch (_) {
      return false;
    }
  },
};

async function main(argv, deps = {}) {
  const d = { ...DEPS, ...deps };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    note(e.message);
    note(t('Run solarljos --help for usage.'));
    return 2;
  }
  const v = parsed.values;
  const [first, ...rest] = parsed.positionals;
  if (v.version) {
    print(pkg.version);
    return 0;
  }
  const command = !argv.length && d.isSea() ? 'gui' : first;
  if (v.help || !command || command === 'help') {
    print(HELP());
    return 0;
  }
  try {
    // A mistyped --location or --type is refused before anything is announced or searched.
    if (v.location) locate({ discover: false, dirs: ownDirs(v) });
    if (v.type) parseTypes(v.type);
    switch (command) {
      case 'find': return await cmdFind(rest[0], v);
      case 'show': return await cmdShow(rest, v);
      case 'restore': return await cmdRestore(rest, v);
      case 'rebuild': return await cmdRebuild(rest, v);
      case 'sources': return await cmdSources(v);
      case 'gui': return await cmdGui(v, d);
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

module.exports = { main, _internal: { parseSince, ownDirs, kindLabel, shownPath, toJson } };
