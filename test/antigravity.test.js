'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { workDir, cleanup, write, only, viewContent } = require('./helpers');
const { parseView, recordsOf } = require('../src/sources/antigravity')._internal;
const { search, git } = require('../src/search');
const { load } = require('../src/content');

const dirs = [];
after(() => dirs.forEach(cleanup));

const P = 'C:\\Users\\alice\\app\\main.py';
const TEXT = 'import os\n\ndef main():\n    print("안녕")\n';

test('a whole-file read turns back into the file, byte for byte', () => {
  const v = parseView(viewContent(P, TEXT));
  assert.deepStrictEqual(v, { path: P, text: TEXT });
});

test('CRLF line endings survive, since each line keeps its carriage return', () => {
  const crlf = 'a\r\nb\r\n';
  assert.strictEqual(parseView(viewContent(P, crlf)).text, crlf);
});

test('a read that is partial, misnumbered or off by a byte gives nothing', () => {
  assert.strictEqual(parseView(viewContent(P, TEXT, { from: 2 })), null, 'did not start at line 1');
  assert.strictEqual(parseView(viewContent(P, TEXT, { to: 2 })), null, 'stopped early');
  assert.strictEqual(parseView(viewContent(P, TEXT, { bytes: 3 })), null, 'byte count disagrees');
  assert.strictEqual(parseView(viewContent(P, TEXT).replace('\n2: ', '\n7: ')), null, 'numbering broken');
  assert.strictEqual(parseView('Created At: x\nsomething else'), null);
});

test('write_to_file gives the whole file; forward-slash Windows paths become Windows paths', () => {
  const recs = [...recordsOf({
    type: 'PLANNER_RESPONSE', created_at: '2026-09-20T02:00:00Z',
    tool_calls: [
      { name: 'write_to_file', args: { TargetFile: 'C:/Users/alice/app/util.py', CodeContent: 'x = 1\n', Overwrite: true } },
      { name: 'run_command', args: { CommandLine: 'dir' } },
    ],
  })];
  assert.deepStrictEqual(recs.map((r) => [r.kind, r.path, r.text]), [['antigravity write', 'C:\\Users\\alice\\app\\util.py', 'x = 1\n']]);
  assert.strictEqual(recs[0].time, Date.parse('2026-09-20T02:00:00Z'));
});

function makeAntigravity() {
  const dir = workDir('antigravity');
  dirs.push(dir);
  const line = (o) => JSON.stringify(o) + '\n';
  const logs = (conv) => path.join(dir, 'brain', conv, '.system_generated', 'logs');
  write(path.join(logs('aaaaaaaa-0000-0000-0000-000000000001'), 'transcript_full.jsonl'),
    line({ step_index: 0, type: 'USER_INPUT', created_at: '2026-09-20T00:00:00Z', content: 'please look at main.py' })
    + line({ step_index: 1, type: 'VIEW_FILE', created_at: '2026-09-20T01:00:00Z', content: viewContent(P, TEXT) })
    + line({
      step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-09-20T02:00:00Z',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: P, CodeContent: 'print("rewritten")\n' } }],
    }));
  // A conversation with only the cut-down transcript: a cut step is skipped, a whole one is used.
  write(path.join(logs('aaaaaaaa-0000-0000-0000-000000000002'), 'transcript.jsonl'),
    line({ step_index: 1, type: 'VIEW_FILE', created_at: '2026-09-21T01:00:00Z', content: viewContent('C:\\Users\\alice\\app\\cut.py', 'cut\n'), truncated_fields: ['content'] })
    + line({ step_index: 2, type: 'VIEW_FILE', created_at: '2026-09-21T02:00:00Z', content: viewContent('C:\\Users\\alice\\app\\whole.py', 'whole\n') }));
  write(path.join(dir, 'brain', 'no-logs-here', 'task.md'), '# not a transcript');
  return dir;
}

test('finds what was written and what was read, newest first', async () => {
  const antigravityDir = makeAntigravity();
  const { results } = await search({ pattern: 'main.py', sources: ['antigravity'], locations: only({ antigravityDirs: [antigravityDir] }) });
  assert.deepStrictEqual(results.map((r) => r.kind), ['antigravity write', 'antigravity read']);
  assert.strictEqual((await load(results[1], git)).toString(), TEXT);
});

test('uses the cut-down transcript only where it is whole', async () => {
  const antigravityDir = makeAntigravity();
  const { results } = await search({ pattern: '*.py', sources: ['antigravity'], locations: only({ antigravityDirs: [antigravityDir] }) });
  const names = results.map((r) => path.win32.basename(r.path)).sort();
  assert.deepStrictEqual(names, ['main.py', 'main.py', 'whole.py']);
});
