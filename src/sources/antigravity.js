'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { t } = require('../i18n');
const { fileUriToPath, pathKey, isInside } = require('../paths');

// Antigravity keeps one folder per conversation, named by the conversation's id (a UUID):
//
//   ~/.gemini/antigravity*/brain/<conversation>/.system_generated/logs/transcript_full.jsonl
//
// one JSON step per line. brain/ holds other folders too, such as tempmediaStorage for uploaded
// media; those are not conversations. Two kinds of step carry a whole file:
//
//   PLANNER_RESPONSE  tool_calls[] with name "write_to_file" and args { TargetFile, CodeContent }
//   VIEW_FILE         content: a header -- File Path, Total Lines, Total Bytes,
//                     "Showing lines <a> to <b>" -- then every line as "<n>: <line>"
//
// A write is taken only once its result says it happened: a CODE_ACTION whose content reads
// "Created file <uri> with requested content." for the same path, before the next
// PLANNER_RESPONSE. Measured on 184 writes, 168 were answered that way; 12 got an error instead
// (such as "already exists", when the path held other content) and 4 no answer at all. Those
// 16 are left out, and so are two writes to one path waiting at once, since a result names only
// the path. The result's "Completed At" is when the file was written; in 25 of the 168 it is up
// to 3 seconds later than the step's own created_at, and never earlier.
//
// The file a write leaves is CodeContent, plus a final LF when CodeContent has none -- measured
// only on the conversation's own artifacts, in brain/<conversation>/. Of those whose file had not
// changed since, 12 of 12 without a final LF were one LF longer on disk, and 34 of 34 ending in
// LF were identical. A write anywhere else without a final LF could not be checked (3 here, all
// of files now missing), so it is offered as the agent wrote it, under a kind that says so,
// rather than with a guessed newline.
//
// A read is taken only when it covered the whole file, says so in the line after the last one
// ("The above content shows the entire, complete file contents of the requested file."), and
// the text rebuilt from it has exactly the byte count its header states. Measured on 113
// whole-file reads, 105 passed, and the two checks agreed on every one; the other 8 were cut
// short by Antigravity itself and are left out. What neither check can see is a UTF-8 byte
// order mark: the language server reads files through ReadFileAsUTF8NoBom, so a read drops it
// and Total Bytes does not count it. Of 58 reads whose file had not changed since, 57 equal it
// byte for byte and one is that file without its BOM (5 of 5 reads of BOM files were 3 bytes
// short). Nothing in the step tells the two apart, so every read carries a note that says so.
//
// transcript.jsonl, next to the full one, cuts long fields short; it is read only when the full
// one is missing or is not a regular file, and its cut steps are skipped. It also keeps every
// tool call's arguments as their JSON text inside a string: a path with its quotes and doubled
// backslashes, Overwrite as "false". Of the 83 writes it holds uncut here, TargetFile and
// CodeContent decoded to what the full transcript holds in 83 of 83, and taken as they stand in
// none. A write is taken from it only when both decode that way; results and reads are stored
// as in the full one.
//
// Reads and results name files as URIs, so a name can show only percent-encoded: in 5 of 323
// reads it did. Lines are therefore tested on the decoded paths they name, pulled out of the
// raw line, and parsed only when one matches.
//
// Edits (replace_file_content, multi_replace_file_content) are not used. Their results carry a
// diff, so the file after an edit can be rebuilt from an exact copy before it, but it can rarely
// be confirmed. Of 39 states rebuilt here with every check the diff allows, 2 were confirmed by
// a later whole read, which is offered itself, and 13 only by the file on disk today, which
// proves nothing once that file is gone. None was of a file now missing, and one was
// contradicted by a later read. An unconfirmed rebuild would be a guess, so none is offered.

const EXPLAIN = 'The following code has been modified to include a line number';
const COMPLETE = 'The above content shows the entire, complete file contents of the requested file.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tests on the raw line. Each agreed with full parsing on every line measured: the step type on
// 8,559 of 8,559, every write's TargetFile, every read's File Path and every result's path.
const HEAD = /^\{"step_index":\d+,"source":"[A-Z_]*","type":"([A-Z_]+)"/;
const TARGET_IN_LINE = /"TargetFile"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const VIEW_IN_LINE = /File Path: `([^`]*)`/;
const DONE_IN_LINE = ' with requested content.';

const CREATED = /^Created file (.*) with requested content\.\r?$/m;
const COMPLETED = /^Completed At: (.*?)\r?$/m;

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function toPath(p) {
  if (/^file:\/\//.test(p)) return fileUriToPath(p);
  if (/^[a-zA-Z]:\//.test(p)) return p.replace(/\//g, '\\');
  return p;
}

/** A JSON string's body as it stands in a line, decoded; null when it is not one. */
function unquote(s) {
  if (!s.includes('\\')) return s;
  try {
    return JSON.parse('"' + s + '"');
  } catch (_) {
    return null;
  }
}

/**
 * A tool call's argument as the full transcript holds it: there as it stands, in the cut one
 * decoded from the JSON text it is kept as. Null when it is not a string that way.
 */
function argText(v, cut) {
  if (typeof v !== 'string') return null;
  if (!cut) return v;
  if (!v.startsWith('"')) return null;
  try {
    return JSON.parse(v);
  } catch (_) {
    return null;
  }
}

/** The names a value in a line may stand for: itself, and the JSON text it holds in the cut transcript. */
function namesIn(s) {
  const p = unquote(s);
  if (p === null) return [];
  const inner = argText(p, true);
  return inner === null ? [p] : [p, inner];
}

/** The step type, from the start of the line when it has the usual shape, else by parsing it. */
function stepType(line) {
  const m = HEAD.exec(line);
  if (m) return m[1];
  try {
    return JSON.parse(line).type || null;
  } catch (_) {
    return null;
  }
}

/**
 * Whether a line names a matching file, as a read's File Path or a call's TargetFile. A line
 * that names none this way is let through, to be parsed and tested properly.
 */
function namesMatch(line, matcher) {
  const view = VIEW_IN_LINE.exec(line);
  const named = view ? [view[1]] : [];
  for (const m of line.matchAll(TARGET_IN_LINE)) named.push(m[1]);
  if (!named.length) return true;
  return named.some((s) => namesIn(s).some((p) => matcher.test(toPath(p))));
}

/** The file behind a whole-file VIEW_FILE, or null when it cannot be rebuilt exactly. */
function parseView(content) {
  const file = /^File Path: `([^`]+)`\r?$/m.exec(content);
  const total = /^Total Lines: (\d+)\r?$/m.exec(content);
  const bytes = /^Total Bytes: (\d+)\r?$/m.exec(content);
  const shown = /^Showing lines (\d+) to (\d+)\r?$/m.exec(content);
  if (!file || !total || !bytes || !shown) return null;
  const n = Number(total[1]);
  if (shown[1] !== '1' || Number(shown[2]) !== n) return null;
  const lines = content.split('\n');
  const at = lines.findIndex((l) => l.startsWith(EXPLAIN));
  if (at < 0) return null;
  const body = lines.slice(at + 1, at + 1 + n);
  if (body.length !== n) return null;
  if ((lines[at + 1 + n] || '').replace(/\r$/, '') !== COMPLETE) return null;
  const out = [];
  for (let i = 0; i < n; i++) {
    const m = /^(\d+): ?([\s\S]*)$/.exec(body[i]);
    if (!m || Number(m[1]) !== i + 1) return null;
    out.push(m[2]);
  }
  const text = out.join('\n');
  if (Buffer.byteLength(text, 'utf8') !== Number(bytes[1])) return null;
  return { path: toPath(file[1]), text };
}

/**
 * The write_to_file calls in one step. A call whose path or text cannot be read may be the one a
 * later result answers, so then none of the step's writes is taken.
 */
function writeCalls(o, cut) {
  if (!Array.isArray(o.tool_calls)) return [];
  const time = o.created_at ? Date.parse(o.created_at) || null : null;
  const out = [];
  for (const c of o.tool_calls) {
    if (!c || c.name !== 'write_to_file') continue;
    const a = c.args || {};
    const target = argText(a.TargetFile, cut);
    const code = argText(a.CodeContent, cut);
    if (target === null || code === null) return [];
    out.push({ path: toPath(target), code, time });
  }
  return out;
}

/** The file a CODE_ACTION says a write created, and when; null for any other step. */
function createdBy(o) {
  if (o.type !== 'CODE_ACTION' || typeof o.content !== 'string') return null;
  const m = CREATED.exec(o.content);
  if (!m) return null;
  const done = COMPLETED.exec(o.content);
  const time = (done && Date.parse(done[1])) || (o.created_at && Date.parse(o.created_at)) || null;
  return { path: toPath(m[1]), time };
}

/** Whether a path lies in the conversation's own folder, brain/<conversation>/, where its artifacts go. */
function ownArtifact(p, conversationId) {
  if (!UUID.test(conversationId || '')) return false;
  return String(p).replace(/\\/g, '/').toLowerCase().includes(`/brain/${conversationId.toLowerCase()}/`);
}

/**
 * What a write left on disk, as far as that was measured. Only in the conversation's own folder
 * is a missing final LF known to be added; elsewhere the text stays as written and says so.
 */
function writtenText(code, own) {
  if (code.endsWith('\n')) return { kind: 'antigravity write', text: code };
  if (own && code !== '') return { kind: 'antigravity write', text: code + '\n' };
  return {
    kind: 'antigravity write, final newline unknown',
    text: code,
    note: t('Written without a final newline; whether the file on disk had one is not recorded.'),
  };
}

/**
 * A conversation's transcript: the full one, else the cut one. Only a regular file counts: a
 * folder by that name cannot be read, and opening a named pipe waits for a writer forever.
 */
function transcriptOf(conversation) {
  const logs = path.join(conversation, '.system_generated', 'logs');
  const full = path.join(logs, 'transcript_full.jsonl');
  if (isFile(full)) return { file: full, cut: false };
  const short = path.join(logs, 'transcript.jsonl');
  return isFile(short) ? { file: short, cut: true } : null;
}

/** The conversation folders in a brain folder: named by a UUID, or holding logs. */
function conversationsIn(brain) {
  try {
    return fs.readdirSync(brain, { withFileTypes: true })
      .filter((e) => e.isDirectory() && (UUID.test(e.name) || isDir(path.join(brain, e.name, '.system_generated'))))
      .map((e) => path.join(brain, e.name));
  } catch (_) {
    return [];
  }
}

/** The conversations under a place: normally a data folder, but its brain folder or one conversation's folder do too. */
function conversations(dir) {
  const brain = path.join(dir, 'brain');
  if (isDir(brain)) return conversationsIn(brain);
  if (isDir(path.join(dir, '.system_generated'))) return [dir];
  return conversationsIn(dir);
}

const CARRIERS = ['"write_to_file"', '"VIEW_FILE"'];

/**
 * Reads one transcript into `out`. Returns how many matching writes were left out: never
 * reported done, or waiting on one path together so that their results cannot be told apart.
 */
async function scanTranscript({ file, cut }, conversationId, ctx, out) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let lineNo = 0;
  let waiting = [];
  let unanswered = 0;
  let ambiguous = 0;
  for await (const line of rl) {
    lineNo++;
    const carries = CARRIERS.some((c) => line.includes(c));
    const answers = waiting.length > 0 && line.includes(DONE_IN_LINE);
    if (!carries && !answers && !waiting.length) continue;
    // A write still waiting when the next planner step begins was never reported done.
    if (waiting.length && stepType(line) === 'PLANNER_RESPONSE') {
      unanswered += waiting.length;
      waiting = [];
    }
    if (!answers && !(carries && namesMatch(line, ctx.matcher))) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const created = createdBy(o);
    if (created) {
      // Results come in the order of the calls, but are matched by the path they name. Two
      // writes to one path waiting at once cannot be told apart, so neither is taken.
      const key = pathKey(created.path);
      const hits = waiting.filter((w) => pathKey(w.path) === key);
      waiting = waiting.filter((w) => !hits.includes(w));
      if (hits.length !== 1) {
        ambiguous += hits.length;
        continue;
      }
      const w = hits[0];
      const { kind, text, note } = writtenText(w.code, ownArtifact(w.path, conversationId));
      out.push({
        source: 'antigravity', kind, path: w.path, time: created.time || w.time,
        size: Buffer.byteLength(text, 'utf8'), text, origin: w.origin, ...(note ? { note } : {}),
      });
      continue;
    }
    if (cut && Array.isArray(o.truncated_fields) && o.truncated_fields.length) continue;
    for (const w of writeCalls(o, cut)) {
      if (ctx.matcher.test(w.path)) waiting.push({ ...w, origin: `${file}:${lineNo}` });
    }
    if (o.type === 'VIEW_FILE' && typeof o.content === 'string') {
      const view = parseView(o.content);
      if (view && ctx.matcher.test(view.path)) {
        const time = o.created_at ? Date.parse(o.created_at) || null : null;
        out.push({
          source: 'antigravity', kind: 'antigravity read', path: view.path, time,
          size: Buffer.byteLength(view.text, 'utf8'), text: view.text, origin: `${file}:${lineNo}`,
          note: t('Read as UTF-8 text: a byte order mark, if the file had one, is not recorded.'),
        });
      }
    }
  }
  return { unanswered: unanswered + waiting.length, ambiguous };
}

async function scan(ctx) {
  const out = [];
  const all = ctx.locations.antigravity.flatMap((dir) => conversations(dir));
  let unanswered = 0;
  let ambiguous = 0;
  let unreadable = 0;
  for (let i = 0; i < all.length; i++) {
    const tr = transcriptOf(all[i]);
    // A transcript that cannot be read, or not to the end, costs only itself. The copies taken
    // from it before that stand, since each was checked on its own.
    if (tr) {
      try {
        const left = await scanTranscript(tr, path.basename(all[i]), ctx, out);
        unanswered += left.unanswered;
        ambiguous += left.ambiguous;
      } catch (_) {
        unreadable++;
      }
    }
    if (ctx.progress) ctx.progress(i + 1, all.length);
  }
  if (unanswered) ctx.notes.push(t('{0} write(s) left out: Antigravity never reported them done', unanswered));
  if (ambiguous) {
    ctx.notes.push(t('{0} write(s) left out: several waited on one path at once, so their results cannot be told apart', ambiguous));
  }
  if (unreadable) ctx.notes.push(t('{0} transcript(s) could not be read in full', unreadable));
  return out;
}

function describe(ctx) {
  if (!ctx.locations.antigravity.length) return [t('No Antigravity folder found.')];
  return ctx.locations.antigravity.map((dir) => {
    const convs = conversations(dir);
    const withLogs = convs.filter((c) => transcriptOf(c)).length;
    return t('{0}: {1} conversation(s), {2} with a transcript', dir, convs.length, withLogs);
  });
}

/**
 * The folders read from, which restore will not write into: each place as given, and by its real
 * path wherever a link leads elsewhere -- the place itself, its brain folder, or the folder a
 * conversation's transcript is in. Big app data is often moved to another drive with a junction
 * (brain -> D:\AG\brain); the scan follows it, and a comparison of path names alone would leave
 * D:\AG\brain open to a restore naming it directly.
 */
function roots(loc) {
  const out = [];
  const add = (p) => {
    if (!out.some((r) => isInside(p, r))) out.push(p);
  };
  const real = (p) => {
    try {
      add(fs.realpathSync.native(p));
    } catch (_) {
      /* not there: nothing is read from it */
    }
  };
  for (const place of loc.antigravity || []) {
    const dir = path.resolve(String(place));
    add(dir);
    real(dir);
    real(path.join(dir, 'brain'));
    for (const c of conversations(dir)) {
      const tr = transcriptOf(c);
      if (!tr) continue;
      try {
        add(path.dirname(fs.realpathSync.native(tr.file)));
      } catch (_) {
        /* gone since: nothing is read from it */
      }
    }
  }
  return out;
}

module.exports = {
  id: 'antigravity',
  label: 'Antigravity',
  // Text only: a search for pictures or videos leaves it out.
  media: false,
  scan,
  describe,
  roots,
  _internal: { parseView, toPath, writtenText, ownArtifact, conversations, stepType, namesMatch, argText },
};
