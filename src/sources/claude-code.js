'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { t } = require('../i18n');

// Claude Code leaves two kinds of record behind, both under ~/.claude:
//
// projects/**/*.jsonl -- one transcript per session, subagents included, one JSON event per
// line. The events that matter carry a `toolUseResult`, and several of them hold a whole file:
//
//   Write   { type: "create" | "update", filePath, content, originalFile }
//           content is what was written; originalFile is the file before, on an update.
//   Edit    { filePath, oldString, newString, replaceAll, originalFile }
//           originalFile is the whole file before the edit. It is null on roughly half of
//           the edits measured (334 of 643); the rest always contained oldString, so the
//           file after the edit can be rebuilt by applying it.
//   Read    { type: "text", file: { filePath, content, startLine, numLines, totalLines } }
//           a whole file only when it was read from line 1 to the end.
//
// file-history/<session>/<hash>@v<n> -- a byte-exact copy of a file taken before Claude
// changed it. The name does not say which file; transcripts do, in two event types:
//
//   file-history-snapshot  snapshot.trackedFileBackups: { <path>: { backupFileName, backupTime } }
//   file-history-delta     trackingPath, backup: { backupFileName, backupTime }
//
// backupFileName is null for a file that did not exist before Claude created it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function walk(dir, ext, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.isFile() && (!ext || e.name.endsWith(ext))) out.push(p);
  }
  return out;
}

/** The session a transcript belongs to: its own name, or the session folder a subagent's sits in. */
function sessionOf(file, projectsDir) {
  const base = path.basename(file, '.jsonl');
  if (UUID.test(base)) return base;
  const seg = path.relative(projectsDir, file).split(path.sep).find((s) => UUID.test(s));
  return seg || null;
}

/**
 * Applies one Edit to the file it started from. A plain string replacement, never a regular
 * expression: `$&` in the new text is text. Returns null when the old text is not there, in
 * which case the rebuilt file would be a guess.
 */
function applyEdit(original, oldString, newString, all) {
  if (!oldString) return null;
  const at = original.indexOf(oldString);
  if (at < 0) return null;
  if (all) return original.split(oldString).join(newString);
  return original.slice(0, at) + newString + original.slice(at + oldString.length);
}

/**
 * Pulls every file-carrying record out of one transcript event. A file as it was before a change
 * is stamped a millisecond before the event, so that "newest" means the state after it.
 */
function* recordsOf(o) {
  const time = o.timestamp ? Date.parse(o.timestamp) || null : null;
  const before = time == null ? null : time - 1;
  const r = o.toolUseResult;
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    if ((r.type === 'create' || r.type === 'update') && typeof r.filePath === 'string' && typeof r.content === 'string') {
      yield { kind: 'claude write', path: r.filePath, text: r.content, time };
      if (typeof r.originalFile === 'string') {
        yield { kind: 'claude, before a write', path: r.filePath, text: r.originalFile, time: before };
      }
    } else if (typeof r.filePath === 'string' && typeof r.oldString === 'string' && typeof r.newString === 'string') {
      if (typeof r.originalFile === 'string') {
        yield { kind: 'claude, before an edit', path: r.filePath, text: r.originalFile, time: before };
        const after = applyEdit(r.originalFile, r.oldString, r.newString, r.replaceAll === true);
        if (after !== null) yield { kind: 'claude, after an edit', path: r.filePath, text: after, time };
      }
    } else if (typeof r.filePath === 'string' && Array.isArray(r.edits) && typeof r.originalFile === 'string') {
      // MultiEdit, from older versions: several edits applied in order.
      yield { kind: 'claude, before an edit', path: r.filePath, text: r.originalFile, time: before };
      let after = r.originalFile;
      for (const e of r.edits) {
        after = e ? applyEdit(after, e.old_string, e.new_string, e.replace_all === true) : null;
        if (after === null) break;
      }
      if (after !== null) yield { kind: 'claude, after an edit', path: r.filePath, text: after, time };
    } else if (r.type === 'text' && r.file && typeof r.file.filePath === 'string' && typeof r.file.content === 'string'
      && r.file.startLine === 1 && r.file.numLines === r.file.totalLines) {
      yield { kind: 'claude read', path: r.file.filePath, text: r.file.content, time };
    }
  }
  if (o.type === 'file-history-snapshot' && o.snapshot && o.snapshot.trackedFileBackups) {
    for (const [p, b] of Object.entries(o.snapshot.trackedFileBackups)) {
      if (b && typeof b.backupFileName === 'string') {
        yield { kind: 'claude backup', path: p, backupFileName: b.backupFileName, time: Date.parse(b.backupTime) || time };
      }
    }
  }
  if (o.type === 'file-history-delta' && typeof o.trackingPath === 'string' && o.backup
    && typeof o.backup.backupFileName === 'string') {
    yield {
      kind: 'claude backup', path: o.trackingPath, backupFileName: o.backup.backupFileName,
      time: Date.parse(o.backup.backupTime) || time,
    };
  }
}

/** Finds a backup file: in its own session's folder first, then anywhere under file-history. */
function backupResolver(fileHistoryDir) {
  let index = null;
  return (session, name) => {
    if (name !== path.basename(name)) return null;
    if (session) {
      const direct = path.join(fileHistoryDir, session, name);
      if (fs.existsSync(direct)) return direct;
    }
    if (!index) {
      index = new Map();
      for (const f of walk(fileHistoryDir)) {
        const n = path.basename(f);
        if (!index.has(n)) index.set(n, f);
      }
    }
    return index.get(name) || null;
  };
}

// Only lines that can carry a file are parsed; the rest are skipped on a substring test.
const CARRIERS = ['"toolUseResult"', '"file-history-'];

async function scanTranscript(file, session, ctx, resolve, out, seenBackups) {
  const literal = ctx.matcher.literal;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!CARRIERS.some((c) => line.includes(c))) continue;
    if (literal && !line.toLowerCase().includes(literal)) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (_) {
      continue;
    }
    for (const rec of recordsOf(o)) {
      if (!ctx.matcher.test(rec.path)) continue;
      if (rec.backupFileName) {
        const phys = resolve(session, rec.backupFileName);
        if (!phys) continue;
        // Every snapshot repeats the backups taken so far; one entry per file is enough.
        const key = phys + '\0' + rec.path;
        if (seenBackups.has(key)) continue;
        seenBackups.add(key);
        let st;
        try {
          st = fs.statSync(phys);
        } catch (_) {
          continue;
        }
        out.push({
          source: 'claude', kind: rec.kind, path: rec.path, time: rec.time,
          size: st.size, file: phys, origin: phys,
        });
      } else {
        out.push({
          source: 'claude', kind: rec.kind, path: rec.path, time: rec.time,
          size: Buffer.byteLength(rec.text, 'utf8'), text: rec.text, origin: `${file}:${lineNo}`,
        });
      }
    }
  }
}

/** The Claude Code folders to read: ~/.claude, one from another machine, or several. */
const foldersOf = (loc) => [].concat(loc.claude || []);

async function scan(ctx) {
  const out = [];
  const seenBackups = new Set();
  // Each folder's transcripts name the backups in that folder's file-history, and no other.
  const transcripts = [];
  for (const dir of foldersOf(ctx.locations)) {
    const projectsDir = path.join(dir, 'projects');
    const resolve = backupResolver(path.join(dir, 'file-history'));
    for (const file of walk(projectsDir, '.jsonl')) transcripts.push({ file, projectsDir, resolve });
  }
  for (let i = 0; i < transcripts.length; i++) {
    const { file, projectsDir, resolve } = transcripts[i];
    await scanTranscript(file, sessionOf(file, projectsDir), ctx, resolve, out, seenBackups);
    if (ctx.progress) ctx.progress(i + 1, transcripts.length);
  }
  // A search by content alone also offers backups no transcript names any more. Those that
  // match a named copy are merged away later, by content.
  if (ctx.unnamed) {
    for (const dir of foldersOf(ctx.locations)) {
      for (const f of walk(path.join(dir, 'file-history'))) {
        let st;
        try {
          st = fs.statSync(f);
        } catch (_) {
          continue;
        }
        out.push({
          source: 'claude', kind: 'claude backup, name unknown', path: null,
          time: st.mtimeMs, size: st.size, file: f, origin: f,
        });
      }
    }
  }
  return out;
}

function describe(ctx) {
  const dirs = foldersOf(ctx.locations);
  if (!dirs.length) return [t('No Claude Code folder found.')];
  return dirs.map((dir) => {
    const transcripts = walk(path.join(dir, 'projects'), '.jsonl').length;
    const backups = walk(path.join(dir, 'file-history')).length;
    return t('{0}: {1} transcript(s), {2} backup(s)', dir, transcripts, backups);
  });
}

module.exports = {
  id: 'claude',
  label: 'Claude Code',
  // Text only: a search for pictures or videos leaves it out.
  media: false,
  scan,
  describe,
  roots: foldersOf,
  _internal: { recordsOf, applyEdit, sessionOf },
};
