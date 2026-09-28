'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { t } = require('../i18n');
const { fileUriToPath } = require('../paths');

// Antigravity keeps one folder per conversation:
//
//   ~/.gemini/antigravity*/brain/<conversation>/.system_generated/logs/transcript_full.jsonl
//
// one JSON step per line. Two kinds of step carry a whole file:
//
//   PLANNER_RESPONSE  tool_calls[] with name "write_to_file" and args { TargetFile, CodeContent }
//   VIEW_FILE         content: a header -- File Path, Total Lines, Total Bytes,
//                     "Showing lines <a> to <b>" -- then every line as "<n>: <line>"
//
// A read is taken only when it covered the whole file and the text rebuilt from it has exactly
// the byte count its header states. Measured on 113 whole-file reads, 105 rebuilt to the byte;
// the rest are left out rather than offered as a guess. transcript.jsonl, next to the full one,
// cuts long fields short; it is read only when the full one is missing, and its cut steps are
// skipped.
//
// Edits (replace_file_content) carry only the changed lines, so they give no whole file.

const EXPLAIN = 'The following code has been modified to include a line number';

function toPath(p) {
  if (/^file:\/\//.test(p)) return fileUriToPath(p);
  if (/^[a-zA-Z]:\//.test(p)) return p.replace(/\//g, '\\');
  return p;
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

/** Pulls every file-carrying record out of one transcript step. */
function* recordsOf(o) {
  const time = o.created_at ? Date.parse(o.created_at) || null : null;
  if (Array.isArray(o.tool_calls)) {
    for (const c of o.tool_calls) {
      const a = c && c.args;
      if (c && c.name === 'write_to_file' && a && typeof a.TargetFile === 'string' && typeof a.CodeContent === 'string') {
        yield { kind: 'antigravity write', path: toPath(a.TargetFile), text: a.CodeContent, time };
      }
    }
  }
  if (o.type === 'VIEW_FILE' && typeof o.content === 'string') {
    const view = parseView(o.content);
    if (view) yield { kind: 'antigravity read', path: view.path, text: view.text, time };
  }
}

function transcriptOf(conversation) {
  const logs = path.join(conversation, '.system_generated', 'logs');
  const full = path.join(logs, 'transcript_full.jsonl');
  if (fs.existsSync(full)) return { file: full, cut: false };
  const short = path.join(logs, 'transcript.jsonl');
  return fs.existsSync(short) ? { file: short, cut: true } : null;
}

function conversations(dir) {
  const brain = path.join(dir, 'brain');
  try {
    return fs.readdirSync(brain, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(brain, e.name));
  } catch (_) {
    return [];
  }
}

const CARRIERS = ['"write_to_file"', '"VIEW_FILE"'];

async function scanTranscript({ file, cut }, ctx, out) {
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
    if (cut && Array.isArray(o.truncated_fields) && o.truncated_fields.length) continue;
    for (const rec of recordsOf(o)) {
      if (!ctx.matcher.test(rec.path)) continue;
      out.push({
        source: 'antigravity', kind: rec.kind, path: rec.path, time: rec.time,
        size: Buffer.byteLength(rec.text, 'utf8'), text: rec.text, origin: `${file}:${lineNo}`,
      });
    }
  }
}

async function scan(ctx) {
  const out = [];
  const all = ctx.locations.antigravity.flatMap((dir) => conversations(dir));
  for (let i = 0; i < all.length; i++) {
    const tr = transcriptOf(all[i]);
    if (tr) await scanTranscript(tr, ctx, out);
    if (ctx.progress) ctx.progress(i + 1, all.length);
  }
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

module.exports = {
  id: 'antigravity',
  label: 'Antigravity',
  scan,
  describe,
  roots: (loc) => loc.antigravity,
  _internal: { parseView, recordsOf, toPath },
};
