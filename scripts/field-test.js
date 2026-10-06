#!/usr/bin/env node
'use strict';
// field-test.js: Solarljos on this computer's own data, through the API its window uses, with a
// report that holds no file's name and no path -- counts, times and states only, and an error's
// words with every path in them replaced by <path> -- so that it can be shared as it is.
//
//   node scripts/field-test.js                         search, stop and search again
//   node scripts/field-test.js --to D:\field-test      also restore some copies there and check them
//   node scripts/field-test.js --to D:\ft --plan C:\work\app   also plan that folder and write it there
//   node scripts/field-test.js --engine C:\...\solarljos-core.exe   that engine, not this repository's
//
// What it does, in order:
//   1. starts the engine as the window does (`desktop`), and reads what it says it can search;
//   2. searches four ways -- a name (*.txt), a kind (documents), a word in Markdown files, and
//      every photo and video -- and reports each place searched: how it went, how long, how many;
//   3. starts a photo search, stops it after 3 s, and times how soon the next search runs;
//   4. with --to: restores up to 25 exact copies of files that are still in their place, and
//      compares each with the file, byte for byte; then a few copies of every other kind, and
//      checks their sizes;
//   5. with --plan: plans that folder and writes it into --to, and counts what was written;
//   6. closes the engine's stdin, as the window does when it closes, and times its stop.
// Nothing is written but what --to receives. Pick a --to on another drive than the one searched.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const engine = opt('--engine');
const to = opt('--to');
const planFolder = opt('--plan');
if (planFolder && !to) {
  console.error('--plan writes the folder it plans: give --to as well.');
  process.exit(2);
}
if (to && fs.existsSync(to) && fs.readdirSync(to).length) {
  console.error('--to must be a folder that does not exist yet, or is empty.');
  process.exit(2);
}

const redact = (s) => String(s == null ? '' : s).replace(/(?:[A-Za-z]:)?[\\/][^\s'"<>|]*/g, '<path>').slice(0, 300);
const sec = (ms) => (ms / 1000).toFixed(1) + ' s';
const tally = (list, f) => {
  const m = {};
  for (const x of list) {
    const k = f(x);
    m[k] = (m[k] || 0) + 1;
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
};
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// The tiers as src/quality.js numbers them, by the words the window gives them.
const TIERS = ['exact', 'inexact', 'never saved', 'may be incomplete', 'smaller copy'];
const tierOf = (c) => (c.isDir ? 'folder' : TIERS[c.tier] || 'tier ' + c.tier);
// A search's results hold their copies; a plan's items, the copy each file is written from.
const copiesOf = (list) => list.flatMap((it) => (Array.isArray(it.copies) ? it.copies : it.copy ? [it.copy] : [it]));

let base;
let key;
let resets = 0;
// The engine and what it said, for the report if the test fails.
let core = null;
let said = '';
let exited = null;
async function call(method, p, body) {
  const headers = { Authorization: 'Bearer ' + key };
  if (method === 'POST') Object.assign(headers, { 'Content-Type': 'application/json', 'X-Solarljos': '1', Origin: base });
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    if (process.env.FIELD_TEST_DEBUG) console.error(`   [${method} ${p.replace(/\?.*$/, '')} failed after ${Date.now() - t0} ms]`);
    // A connection kept for the next request and closed by the engine meanwhile: tried once more
    // on a new one, as .NET's client does for the window, and counted for the report.
    if (!(e.cause && e.cause.code === 'ECONNRESET')) throw e;
    resets++;
    res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  }
  const text = await res.text();
  if (process.env.FIELD_TEST_DEBUG) console.error(`   [${method} ${p.replace(/\?.*$/, '')} ${res.status} ${text.length} B ${Date.now() - t0} ms]`);
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {}
  return { status: res.status, json };
}

async function waitJob(id) {
  for (;;) {
    const r = await call('GET', `/api/job/${id}`);
    if (r.json && r.json.state !== 'running') return r.json;
    await new Promise((s) => setTimeout(s, 500));
  }
}

async function itemsOf(id) {
  const all = [];
  for (let offset = 0; ;) {
    const r = await call('GET', `/api/job/${id}/items?offset=${offset}&limit=2000`);
    const got = (r.json && r.json.items) || [];
    all.push(...got);
    offset += got.length;
    if (!got.length || r.json.total == null || offset >= r.json.total) return all;
  }
}

function report(name, job, list, ms) {
  console.log(`\n== ${name}: ${job.state} in ${sec(ms)}, ${job.total ?? 'no'} result(s)${job.error ? '; error: ' + redact(job.error) : ''}`);
  for (const s of job.sources || []) {
    const nums = Object.entries(s).filter(([k, v]) => typeof v === 'number').map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`   ${String(s.id).padEnd(12)} ${String(s.state).padEnd(9)} ${nums}${s.error ? '  error: ' + redact(s.error) : ''}`);
  }
  if (list.length) {
    const copies = copiesOf(list);
    console.log(`   ${copies.length} copies. tiers: ${tally(copies, tierOf)}`);
    console.log(`   states: ${tally(copies, (c) => c.state || 'not known')}`);
    console.log(`   from: ${tally(copies, (c) => c.source)}`);
  }
}

async function search(name, body) {
  const t0 = Date.now();
  const r = await call('POST', '/api/search', body);
  if (r.status !== 202) {
    console.log(`\n== ${name}: refused (${r.status}) ${redact(r.json && r.json.error)}`);
    return [];
  }
  const job = await waitJob(r.json.job.id);
  const list = job.state === 'done' ? await itemsOf(job.id) : [];
  report(name, job, list, Date.now() - t0);
  return list;
}

/**
 * Restores some of a search's copies into --to/<dir>: up to 25 exact copies of files still in
 * their place, compared with the file byte for byte, and two of every other kind from each place,
 * whose size is checked. Right after the search: the engine keeps the last search of a view only.
 */
async function restoreSome(found, dir) {
  const exact = copiesOf(found).filter((c) => tierOf(c) === 'exact' && c.state === 'exists' && c.size > 0 && c.size < 20e6 && c.path);
  // One from each place first, then more, up to 25.
  const pick = [];
  for (const c of exact) if (!pick.some((p) => p.source === c.source)) pick.push(c);
  for (const c of exact) if (pick.length < 25 && !pick.includes(c)) pick.push(c);
  if (pick.length) {
    const dest = path.join(to, dir, 'exact');
    const check = (await call('POST', '/api/check-folder', { to: dest, uids: pick.map((c) => c.uid) })).json || {};
    const t1 = Date.now();
    const res = (await call('POST', '/api/restore', { uids: pick.map((c) => c.uid), to: dest })).json || {};
    const took = Date.now() - t1;
    const results = res.results || [];
    const ok = results.filter((x) => x.ok);
    // Written as read: the file restored has the bytes the engine reads for the copy. Then, for
    // the eye, whether it is the file now in its place or an earlier or later version of it.
    const asRead = [];
    const verdict = [];
    for (const x of ok) {
      const c = pick.find((p) => p.uid === x.uid);
      try {
        const res = await fetch(`${base}/api/copy/${c.uid}`, { headers: { Authorization: 'Bearer ' + key } });
        const read = crypto.createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
        asRead.push(read === sha(x.path) ? 'the same' : `different (${c.source})`);
      } catch (_) {
        asRead.push('not readable');
      }
      try {
        verdict.push(sha(x.path) === sha(c.path) ? 'the file in its place' : `an earlier or later version (${c.source})`);
      } catch (_) {
        verdict.push('not readable');
      }
    }
    console.log(`\n== restore ${pick.length} exact copies of ${dir} (from ${new Set(pick.map((c) => c.source)).size} kind(s) of place): ${sec(took)}`);
    console.log(`   folder check: ${check.ok ? 'ok' : 'refused'}, on the drive of ${check.sameDrive ?? '?'} of them`);
    console.log(`   written ${ok.length}, failed ${results.length - ok.length}${results.length > ok.length ? ' (' + tally(results.filter((x) => !x.ok), (x) => x.code || redact(x.error)) + ')' : ''}`);
    console.log(`   against the copy as the engine reads it: ${tally(asRead, (v) => v)}`);
    console.log(`   what they are: ${tally(verdict, (v) => v)}`);
  } else console.log(`\n== restore exact copies of ${dir}: none of a file still in its place to try`);
  // Every other kind of copy: a few of each, written, at the size recorded.
  const others = [];
  for (const c of copiesOf(found)) {
    if (tierOf(c) === 'exact' || tierOf(c) === 'folder' || !(c.size > 0 && c.size < 20e6)) continue;
    if (others.filter((o) => tierOf(o) === tierOf(c) && o.source === c.source).length < 2) others.push(c);
  }
  if (others.length) {
    const some = others.slice(0, 40);
    const res = (await call('POST', '/api/restore', { uids: some.map((c) => c.uid), to: path.join(to, dir, 'other') })).json || {};
    const results = res.results || [];
    const sizes = results.filter((x) => x.ok).map((x) => {
      try {
        return fs.statSync(x.path).size === some.find((c) => c.uid === x.uid).size ? 'size as recorded' : 'other size';
      } catch (_) {
        return 'not readable';
      }
    });
    console.log(`\n== restore ${some.length} other copies of ${dir} (${tally(some, tierOf)})`);
    console.log(`   written ${results.filter((x) => x.ok).length}, failed ${results.filter((x) => !x.ok).length}; ${tally(sizes, (s) => s)}`);
  }
}

function filesUnder(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? filesUnder(path.join(dir, e.name)) : 1;
  return n;
}

async function main() {
  const t0 = Date.now();
  // An engine given as a script runs on this node.exe, as this repository's does.
  const script = engine ? /\.c?js$/i.test(engine) : true;
  const file = engine || path.join(__dirname, '..', 'bin', 'solarljos.js');
  const [cmd, cmdArgs] = script ? [process.execPath, [file, 'desktop']] : [file, ['desktop']];
  core = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  core.stderr.on('data', (d) => (said += d));
  core.on('exit', (code, signal) => (exited = { code, signal, at: Date.now() }));
  const first = await new Promise((resolve, reject) => {
    let buf = '';
    core.stdout.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) resolve(JSON.parse(buf.slice(0, i)));
    });
    core.on('exit', (c) => reject(new Error(`the engine stopped (${c}): ${redact(said)}`)));
  });
  base = `http://127.0.0.1:${first.port}`;
  key = first.key;
  const info = (await call('GET', '/api/info')).json;
  const sources = (await call('GET', '/api/sources')).json.sources;
  const drives = (await call('GET', '/api/drives')).json.drives || [];
  console.log(`Solarljos ${info.version} field test, ${new Date().toISOString().slice(0, 10)}`);
  console.log(`engine ready in ${sec(Date.now() - t0)}; administrator: ${info.elevated ? 'yes' : 'no'}; ${sources.length} kinds of place`);
  console.log(`drives: ${drives.map((d) => `${d.letter || '?'}:${d.network ? ' network' : ''}${d.system ? ' system' : ''}${d.answering === false ? ' not answering' : ''}`).join(', ') || 'none'}`);

  await search('name "*.txt"', { pattern: '*.txt', view: { mode: 'find' } });
  await search('"TODO" in *.md', { pattern: '*.md', containing: 'TODO', view: { mode: 'find' } });
  const docs = await search('kind: documents', { types: ['document'], view: { mode: 'find' } });
  if (to) await restoreSome(docs, 'documents');
  const media = await search('photos and videos', { types: ['image', 'video'], view: { mode: 'media' } });
  if (to) await restoreSome(media, 'photos');

  // A search stopped, and another started at once (0.7.2: it waited for git to end).
  const r = await call('POST', '/api/search', { types: ['image', 'video'], view: { mode: 'media' } });
  if (r.status === 202) {
    await new Promise((s) => setTimeout(s, 3000));
    const ts = Date.now();
    await call('POST', '/api/cancel', { job: r.json.job.id });
    let again;
    do {
      again = await call('POST', '/api/search', { pattern: '*.txt', view: { mode: 'find' } });
      if (again.status !== 202) await new Promise((s) => setTimeout(s, 100));
    } while (again.status !== 202 && Date.now() - ts < 60000);
    const taken = Date.now() - ts;
    // Running: a place of it no longer waiting, which the stopped search held up before 0.7.2.
    let ran = null;
    if (again.status === 202) {
      for (;;) {
        const j = (await call('GET', `/api/job/${again.json.job.id}`)).json;
        if (j.state !== 'running' || (j.sources || []).some((x) => x.state !== 'waiting')) break;
        await new Promise((s) => setTimeout(s, 50));
      }
      ran = Date.now() - ts;
    }
    const job = again.status === 202 ? await waitJob(again.json.job.id) : { state: 'never started' };
    console.log(`\n== stop, then search: taken ${sec(taken)} after the stop, running at ${ran == null ? 'never' : sec(ran)}, ${job.state} at ${sec(Date.now() - ts)}`);
  }

  if (planFolder) {
    const t1 = Date.now();
    const r2 = await call('POST', '/api/plan', { folder: planFolder });
    if (r2.status !== 202) console.log(`\n== plan: refused (${r2.status}) ${redact(r2.json && r2.json.error)}`);
    else {
      const job = await waitJob(r2.json.job.id);
      const list = job.state === 'done' ? await itemsOf(job.id) : [];
      report('plan of the folder', job, list, Date.now() - t1);
      if (job.state === 'done' && list.length) {
        const t2 = Date.now();
        const dest = path.join(to, 'folder');
        const rb = await call('POST', '/api/rebuild', { plan: job.id, to: dest, exclude: [], include: [] });
        if (rb.status !== 202) console.log(`== write the folder: refused (${rb.status}) ${redact(rb.json && rb.json.error)}`);
        else {
          const done = await waitJob(rb.json.job.id);
          let n = 0;
          try {
            n = filesUnder(dest);
          } catch (_) {}
          console.log(`== write the folder: ${done.state} in ${sec(Date.now() - t2)}; ${n} file(s) written${done.error ? '; error: ' + redact(done.error) : ''}`);
        }
      }
    }
  }

  const ts = Date.now();
  core.stdin.end();
  const code = await new Promise((resolve) => core.on('exit', resolve));
  console.log(`\nengine stopped ${sec(Date.now() - ts)} after its input closed (exit ${code}); it said ${said.split('\n').filter(Boolean).length} line(s)`);
  if (said.trim()) console.log('   last: ' + redact(said.trim().split('\n').slice(-3).join(' | ')));
  console.log(`connections the engine reset, tried again: ${resets}`);
  console.log(`\nall in ${sec(Date.now() - t0)}. This report names no file and no folder: it can be shared as it is.`);
}

main().catch((e) => {
  const cause = e && e.cause ? ` (cause: ${e.cause.code || ''} ${redact(e.cause.message || e.cause)})` : '';
  console.error('field test failed: ' + redact(e.stack || e) + cause);
  console.error(exited ? `the engine had stopped: exit ${exited.code}${exited.signal ? ', ' + exited.signal : ''}` : 'the engine was still running');
  const last = said.trim().split('\n').filter(Boolean).slice(-8);
  if (last.length) console.error('it said last:\n   ' + last.map(redact).join('\n   '));
  if (core && !exited) core.kill();
  process.exit(1);
});
