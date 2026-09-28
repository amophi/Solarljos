'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { workDir, cleanup, write, only, snapshot, viewContent } = require('./helpers');
const antigravity = require('../src/sources/antigravity');
const { search, git } = require('../src/search');
const { load } = require('../src/content');
const { restore } = require('../src/restore');

const { parseView, writtenText, ownArtifact, stepType, namesMatch, argText } = antigravity._internal;

const dirs = [];
after(() => dirs.forEach(cleanup));

const P = 'C:\\Users\\alice\\app\\main.py';
const TEXT = 'import os\n\ndef main():\n    print("안녕")\n';
const CONV1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const CONV2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const CONV3 = 'aaaaaaaa-0000-0000-0000-000000000003';
const TASK = `C:\\Users\\alice\\.gemini\\antigravity-ide\\brain\\${CONV1}\\task.md`;
const REPORT = 'C:\\Users\\alice\\app\\보고서 (1).txt';
const MEMO = 'C:\\Users\\alice\\app\\메모 (2).txt';

test('a whole-file read turns back into the text Antigravity read', () => {
  const v = parseView(viewContent(P, TEXT));
  assert.deepStrictEqual(v, { path: P, text: TEXT });
});

test('CRLF line endings survive, since each line keeps its carriage return', () => {
  const crlf = 'a\r\nb\r\n';
  assert.strictEqual(parseView(viewContent(P, crlf)).text, crlf);
});

test('a read that is partial, misnumbered, off by a byte or not said to be complete gives nothing', () => {
  assert.strictEqual(parseView(viewContent(P, TEXT, { from: 2 })), null, 'did not start at line 1');
  assert.strictEqual(parseView(viewContent(P, TEXT, { to: 2 })), null, 'stopped early');
  assert.strictEqual(parseView(viewContent(P, TEXT, { bytes: 3 })), null, 'byte count disagrees');
  assert.strictEqual(parseView(viewContent(P, TEXT).replace('\n2: ', '\n7: ')), null, 'numbering broken');
  assert.strictEqual(parseView(viewContent(P, TEXT).replace('shows the entire, complete', 'does NOT show the entire')), null,
    'not said to be the whole file');
  assert.strictEqual(parseView('Created At: x\nsomething else'), null);
});

test('a final newline is added only where it was measured, in the conversation\'s own folder', () => {
  assert.deepStrictEqual(writtenText('x = 1\n', false), { kind: 'antigravity write', text: 'x = 1\n' });
  assert.deepStrictEqual(writtenText('# Task', true), { kind: 'antigravity write', text: '# Task\n' });
  const elsewhere = writtenText('x = 1', false);
  assert.strictEqual(elsewhere.kind, 'antigravity write, final newline unknown');
  assert.strictEqual(elsewhere.text, 'x = 1', 'kept as the agent wrote it, not guessed');
  assert.ok(elsewhere.note);
  assert.strictEqual(writtenText('', true).kind, 'antigravity write, final newline unknown', 'an empty write was never measured');
});

test('the own folder is brain/<conversation>/, in any case and with either separator', () => {
  assert.strictEqual(ownArtifact(TASK, CONV1), true);
  assert.strictEqual(ownArtifact(`C:/Users/alice/.gemini/antigravity-ide/brain/${CONV1.toUpperCase()}/scratch/a.py`, CONV1), true);
  assert.strictEqual(ownArtifact(`/home/alice/.gemini/antigravity/brain/${CONV1}/task.md`, CONV1), true);
  assert.strictEqual(ownArtifact(TASK, CONV2), false, 'another conversation\'s folder');
  assert.strictEqual(ownArtifact(P, CONV1), false);
  assert.strictEqual(ownArtifact('C:\\x\\brain\\conv\\task.md', 'conv'), false, 'only a conversation id counts');
});

test('the step type comes from the start of a line, or from parsing it when the line is shaped otherwise', () => {
  assert.strictEqual(stepType('{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE"}'), 'PLANNER_RESPONSE');
  assert.strictEqual(stepType('{"type":"VIEW_FILE","step_index":3}'), 'VIEW_FILE');
  assert.strictEqual(stepType('not json'), null);
});

test('a line is tested on the decoded paths it names', () => {
  const m = (p) => ({ test: (x) => x.endsWith(p) });
  const view = JSON.stringify({ type: 'VIEW_FILE', content: 'File Path: `file:///C:/a/%EB%A9%94%EB%AA%A8%20%282%29.txt`' });
  assert.strictEqual(namesMatch(view, m('메모 (2).txt')), true);
  assert.strictEqual(namesMatch(view, m('other.txt')), false);
  const call = JSON.stringify({ tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'C:\\a\\"q".py' } }] });
  assert.strictEqual(namesMatch(call, m('\\"q".py')), true, 'JSON escapes are undone');
  assert.strictEqual(namesMatch('{"type":"VIEW_FILE"}', m('x')), true, 'a line naming nothing is left to parsing');
  const cutCall = JSON.stringify({ tool_calls: [{ name: 'write_to_file', args: { TargetFile: JSON.stringify('C:\\a\\task.md') } }] });
  assert.strictEqual(namesMatch(cutCall, m('\\a\\task.md')), true, 'the cut transcript\'s JSON text is decoded too');
});

test('the cut transcript\'s arguments are taken only as the JSON text of a string', () => {
  assert.strictEqual(argText('C:\\a\\b.py', false), 'C:\\a\\b.py');
  assert.strictEqual(argText(JSON.stringify('C:\\a\\b.py'), true), 'C:\\a\\b.py');
  assert.strictEqual(argText(JSON.stringify('line\n"quoted"\n'), true), 'line\n"quoted"\n');
  assert.strictEqual(argText('C:\\a\\b.py', true), null, 'stored as it stands: a shape not measured there');
  assert.strictEqual(argText('"""docstring"""', true), null, 'not JSON text');
  assert.strictEqual(argText(false, false), null);
});

// Steps shaped as Antigravity writes them: step_index, source, type, status, created_at first.
let index = 0;
const step = (type, at, more = {}) => JSON.stringify({ step_index: index++, source: 'MODEL', type, status: 'DONE', created_at: at, ...more }) + '\n';
// Older-looking steps, with the keys in another order, take the slower way through the parser.
const loose = (o) => JSON.stringify(o) + '\n';

/** A file URI as Antigravity writes one: every path segment percent-encoded, parentheses too. */
const uri = (p) => 'file:///' + p.split('\\').map((s, i) => (i ? encodeURIComponent(s).replace(/\(/g, '%28').replace(/\)/g, '%29') : s)).join('/');
/** Results carry local time with an offset. */
const local = (iso) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().replace(/\.\d+Z$/, '+09:00');

const writeCall = (target, code) => ({ name: 'write_to_file', args: { TargetFile: target, CodeContent: code, Overwrite: false, Description: 'x' } });
/** A call as transcript.jsonl keeps it: every argument as its JSON text, in a string. */
const cutCall = (target, code) => {
  const c = writeCall(target, code);
  return { ...c, args: Object.fromEntries(Object.entries(c.args).map(([k, v]) => [k, JSON.stringify(v)])) };
};
const planner = (at, ...calls) => step('PLANNER_RESPONSE', at, { tool_calls: calls });
/** The step's own created_at comes a little before the write is completed, as measured. */
const later = (iso) => new Date(Date.parse(iso) + 7e3).toISOString();
const created = (target, at) => step('CODE_ACTION', at, {
  content: `Created At: ${local(at)}\nCompleted At: ${local(later(at))}\nCreated file ${uri(target)} with requested content.\nNo errors.`,
});
const refused = (at) => step('ERROR_MESSAGE', at, {
  source: 'SYSTEM', error: 'x', content: 'Error Message: model output error: invalid tool call error (invalid_args): already exists',
});

function makeAntigravity() {
  const dir = workDir('antigravity');
  dirs.push(dir);
  const logs = (conv) => path.join(dir, 'brain', conv, '.system_generated', 'logs');
  write(path.join(logs(CONV1), 'transcript_full.jsonl'), [
    step('USER_INPUT', '2026-09-20T00:00:00Z', { content: 'please look at main.py' }),
    step('VIEW_FILE', '2026-09-20T01:00:00Z', { content: viewContent(P, TEXT) }),
    // Written without a final newline outside the conversation's folder: kept as written.
    planner('2026-09-20T02:00:00Z', writeCall(P, 'print("rewritten")')),
    step('EPHEMERAL_MESSAGE', '2026-09-20T02:00:01Z', { content: 'working' }),
    created(P, '2026-09-20T02:00:03Z'),
    planner('2026-09-20T03:00:00Z', writeCall('C:/Users/alice/app/util.py', 'x = 1\n')),
    created('C:\\Users\\alice\\app\\util.py', '2026-09-20T03:00:01Z'),
    // Refused: the path held other content.
    planner('2026-09-20T04:00:00Z', writeCall('C:\\Users\\alice\\app\\clash.py', 'clash\n')),
    refused('2026-09-20T04:00:01Z'),
    // Never answered before the next planner step.
    planner('2026-09-20T05:00:00Z', writeCall('C:\\Users\\alice\\app\\lost.py', 'lost\n')),
    planner('2026-09-20T05:01:00Z', { name: 'run_command', args: { CommandLine: 'dir' } }),
    // The artifact in the conversation's own folder gets its final newline.
    planner('2026-09-20T06:00:00Z', writeCall(TASK, '# Task')),
    created(TASK, '2026-09-20T06:00:01Z'),
    // A result for another path answers nothing.
    planner('2026-09-20T07:00:00Z', writeCall('C:\\Users\\alice\\app\\other.py', 'other\n')),
    created('C:\\Users\\alice\\app\\another.py', '2026-09-20T07:00:01Z'),
    // Two writes to one path at once cannot be told apart.
    planner('2026-09-20T08:00:00Z', writeCall('C:\\Users\\alice\\app\\twice.py', 'one\n'), writeCall('C:\\Users\\alice\\app\\twice.py', 'two\n')),
    created('C:\\Users\\alice\\app\\twice.py', '2026-09-20T08:00:01Z'),
    created('C:\\Users\\alice\\app\\twice.py', '2026-09-20T08:00:02Z'),
    // An edit and its diff: not used.
    planner('2026-09-20T09:00:00Z', {
      name: 'replace_file_content',
      args: { TargetFile: 'C:\\Users\\alice\\app\\util.py', TargetContent: 'x = 1', ReplacementContent: 'x = 2', StartLine: 1, EndLine: 1 },
    }),
    step('CODE_ACTION', '2026-09-20T09:00:01Z', {
      content: 'Created At: x\nCompleted At: x\nThe following changes were made by the replace_file_content tool to: C:\\Users\\alice\\app\\util.py. If relevant, proactively run terminal commands.\n[diff_block_start]\n@@ -1,1 +1,1 @@\n-x = 1\n+x = 2\n[diff_block_end]',
    }),
    // Names that show only percent-encoded in the line.
    planner('2026-09-20T10:00:00Z', writeCall('C:/Users/alice/app/보고서 (1).txt', 'hello\n')),
    created(REPORT, '2026-09-20T10:00:01Z'),
    step('VIEW_FILE', '2026-09-20T11:00:00Z', { content: viewContent(MEMO, 'memo\n').replace(/^File Path: `[^`]*`/m, 'File Path: `' + uri(MEMO) + '`') }),
  ].join(''));
  // Only the cut-down transcript, with its arguments kept as JSON text: a cut step is skipped,
  // a whole one is used.
  write(path.join(logs(CONV2), 'transcript.jsonl'), [
    loose({ step_index: 1, type: 'VIEW_FILE', created_at: '2026-09-21T01:00:00Z', content: viewContent('C:\\Users\\alice\\app\\cut.py', 'cut\n'), truncated_fields: ['content'] }),
    loose({ step_index: 2, type: 'VIEW_FILE', created_at: '2026-09-21T02:00:00Z', content: viewContent('C:\\Users\\alice\\app\\whole.py', 'whole\n') }),
    loose({ step_index: 3, type: 'PLANNER_RESPONSE', created_at: '2026-09-21T03:00:00Z', tool_calls: [cutCall('C:\\Users\\alice\\app\\cutwrite.py', 'cu')], truncated_fields: ['tool_calls'] }),
    loose({ step_index: 4, type: 'CODE_ACTION', created_at: '2026-09-21T03:00:01Z', content: `Created file ${uri('C:\\Users\\alice\\app\\cutwrite.py')} with requested content.` }),
    loose({ step_index: 5, type: 'PLANNER_RESPONSE', created_at: '2026-09-21T04:00:00Z', tool_calls: [cutCall('C:\\Users\\alice\\app\\whole2.py', 'w2 "quoted"\r\n')] }),
    loose({ step_index: 6, type: 'CODE_ACTION', created_at: '2026-09-21T04:00:01Z', content: `Created file ${uri('C:\\Users\\alice\\app\\whole2.py')} with requested content.` }),
    loose({ step_index: 7, type: 'PLANNER_RESPONSE', created_at: '2026-09-21T05:00:00Z', tool_calls: [cutCall('C:\\Users\\alice\\app\\gone.py', 'gone\n')] }),
    loose({ step_index: 8, type: 'PLANNER_RESPONSE', created_at: '2026-09-21T05:01:00Z', tool_calls: [] }),
  ].join(''));
  // A conversation that has artifacts but no logs, and two folders that are not conversations.
  write(path.join(dir, 'brain', CONV3, 'task.md'), '# no transcript');
  write(path.join(dir, 'brain', 'tempmediaStorage', 'media_1.pdf'), '%PDF');
  write(path.join(dir, 'brain', 'no-logs-here', 'task.md'), '# not a conversation');
  return dir;
}

const find = (pattern, dir, more = {}) => search({ pattern, sources: ['antigravity'], locations: only({ antigravityDirs: [dir] }), ...more });

test('offers only the writes Antigravity reported done, dated by their result', async () => {
  const dir = makeAntigravity();
  const { results, perSource } = await find('*.py', dir);
  const got = results.map((r) => [path.win32.basename(r.path), r.kind]).sort();
  assert.deepStrictEqual(got, [
    ['main.py', 'antigravity read'],
    ['main.py', 'antigravity write, final newline unknown'],
    ['util.py', 'antigravity write'],
    ['whole.py', 'antigravity read'],
    ['whole2.py', 'antigravity write'],
  ]);
  const main = results.find((r) => r.kind === 'antigravity write, final newline unknown');
  assert.strictEqual(main.time, Date.parse('2026-09-20T02:00:10Z'), 'the time the result says it was completed');
  assert.strictEqual((await load(main, git)).toString(), 'print("rewritten")');
  assert.ok(main.note);
  assert.strictEqual((await load(results.find((r) => r.kind === 'antigravity read' && r.path === P), git)).toString(), TEXT);
  // A read cannot show whether the file had a byte order mark, so every one says so.
  for (const r of results.filter((x) => x.kind === 'antigravity read')) assert.match(r.note, /byte order mark/, r.path);
  // The cut transcript's write, decoded from its JSON text.
  const w2 = results.find((r) => r.path.endsWith('whole2.py'));
  assert.deepStrictEqual([w2.path, w2.text], ['C:\\Users\\alice\\app\\whole2.py', 'w2 "quoted"\r\n']);
  // clash (an error), lost and gone (no answer), other (answered for another path); twice (two at once).
  assert.deepStrictEqual(perSource[0].notes, [
    '4 write(s) left out: Antigravity never reported them done',
    '2 write(s) left out: several waited on one path at once, so their results cannot be told apart',
  ]);
});

test('a result answers a write only until the next planner step', async () => {
  const dir = workDir('antigravity-window');
  dirs.push(dir);
  const RETRY = 'C:\\Users\\alice\\app\\retry.py';
  const LATE = 'C:\\Users\\alice\\app\\late.py';
  const AGAIN = 'C:\\Users\\alice\\app\\again.py';
  const PAIR = 'C:\\Users\\alice\\app\\pair.py';
  write(path.join(dir, 'brain', CONV1, '.system_generated', 'logs', 'transcript_full.jsonl'), [
    // Refused, then written again: the result answers the retry alone.
    planner('2026-09-22T01:00:00Z', writeCall(RETRY, 'v1\n')),
    refused('2026-09-22T01:00:01Z'),
    planner('2026-09-22T01:01:00Z', writeCall(RETRY, 'v2\n')),
    created(RETRY, '2026-09-22T01:01:01Z'),
    // A result that comes only after another planner step answers nothing.
    planner('2026-09-22T02:00:00Z', writeCall(LATE, 'late\n')),
    planner('2026-09-22T02:01:00Z', { name: 'run_command', args: { CommandLine: 'dir' } }),
    created(LATE, '2026-09-22T02:01:01Z'),
    // A write beside one that cannot be read: the result may be that one's.
    planner('2026-09-22T02:30:00Z', writeCall(PAIR, 'maybe\n'), { name: 'write_to_file', args: { TargetFile: PAIR } }),
    created(PAIR, '2026-09-22T02:30:01Z'),
  ].join(''));
  // Refused, then written again in a step the cut transcript cut short: its result must not be
  // taken for the refused write.
  write(path.join(dir, 'brain', CONV2, '.system_generated', 'logs', 'transcript.jsonl'), [
    loose({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-09-22T03:00:00Z', tool_calls: [cutCall(AGAIN, 'refused\n')] }),
    loose({ step_index: 2, type: 'ERROR_MESSAGE', created_at: '2026-09-22T03:00:01Z', content: 'Error Message: already exists' }),
    loose({ step_index: 3, type: 'PLANNER_RESPONSE', created_at: '2026-09-22T03:01:00Z', tool_calls: [cutCall(AGAIN, 'wri')], truncated_fields: ['tool_calls'] }),
    loose({ step_index: 4, type: 'CODE_ACTION', created_at: '2026-09-22T03:01:01Z', content: `Created file ${uri(AGAIN)} with requested content.` }),
  ].join(''));
  const { results, perSource } = await find('*.py', dir);
  assert.deepStrictEqual(results.map((r) => [path.win32.basename(r.path), r.text]), [['retry.py', 'v2\n']]);
  assert.deepStrictEqual(perSource[0].notes, ['3 write(s) left out: Antigravity never reported them done']);
});

test('the conversation\'s own artifact gets the final newline its file had', async () => {
  const dir = makeAntigravity();
  const { results } = await find('task.md', dir);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].kind, 'antigravity write');
  assert.strictEqual((await load(results[0], git)).toString(), '# Task\n');
  assert.strictEqual(results[0].size, 7);
});

test('an edit gives nothing of its own', async () => {
  const dir = makeAntigravity();
  const { results } = await find('util.py', dir);
  assert.deepStrictEqual(results.map((r) => r.text), ['x = 1\n']);
});

test('names that show only percent-encoded are found by name, and when rebuilding their folder', async () => {
  const dir = makeAntigravity();
  const report = await find('보고서 (1).txt', dir);
  assert.deepStrictEqual(report.results.map((r) => [r.path, r.kind]), [[REPORT, 'antigravity write']]);
  const memo = await find('메모 (2).txt', dir);
  assert.deepStrictEqual(memo.results.map((r) => [r.path, r.kind, r.text]), [[MEMO, 'antigravity read', 'memo\n']]);
  const below = await find('', dir, { under: 'C:\\Users\\alice\\app' });
  const names = below.results.map((r) => path.win32.basename(r.path));
  assert.ok(names.includes('보고서 (1).txt') && names.includes('메모 (2).txt'));
});

test('describe counts conversations, not the other folders in brain', () => {
  const dir = makeAntigravity();
  assert.deepStrictEqual(antigravity.describe({ locations: { antigravity: [dir] } }),
    [`${dir}: 3 conversation(s), 2 with a transcript`]);
});

test('a brain folder or one conversation\'s folder can be given as the place, as --location does', async () => {
  const dir = makeAntigravity();
  const viaBrain = await search({ pattern: 'util.py', sources: ['antigravity'], locations: only({ dirs: { antigravity: [path.join(dir, 'brain')] } }) });
  assert.strictEqual(viaBrain.results.length, 1);
  const one = await search({ pattern: '*.py', sources: ['antigravity'], locations: only({ dirs: { antigravity: [path.join(dir, 'brain', CONV2)] } }) });
  assert.deepStrictEqual(one.results.map((r) => path.win32.basename(r.path)).sort(), ['whole.py', 'whole2.py']);
});

test('a transcript that is not a file, or cannot be read, costs only itself', async () => {
  const dir = makeAntigravity();
  const logs = (conv) => path.join(dir, 'brain', conv, '.system_generated', 'logs');
  // A folder by the full transcript's name: the cut one beside it is read instead.
  const CONV4 = 'aaaaaaaa-0000-0000-0000-000000000004';
  fs.mkdirSync(path.join(logs(CONV4), 'transcript_full.jsonl'), { recursive: true });
  write(path.join(logs(CONV4), 'transcript.jsonl'),
    loose({ step_index: 1, type: 'VIEW_FILE', created_at: '2026-09-24T01:00:00Z', content: viewContent('C:\\Users\\alice\\app\\beside.py', 'beside\n') }));
  // One with folders by both names has no transcript.
  const CONV5 = 'aaaaaaaa-0000-0000-0000-000000000005';
  fs.mkdirSync(path.join(logs(CONV5), 'transcript_full.jsonl'), { recursive: true });
  fs.mkdirSync(path.join(logs(CONV5), 'transcript.jsonl'));
  const r = await find('beside.py', dir);
  assert.deepStrictEqual([r.results.map((c) => c.text), r.perSource[0].error], [['beside\n'], undefined]);
  assert.deepStrictEqual(antigravity.describe({ locations: { antigravity: [dir] } }),
    [`${dir}: 5 conversation(s), 3 with a transcript`]);
  // A transcript gone between the look and the read.
  const vanishing = path.join(logs(CONV1), 'transcript_full.jsonl');
  const { createReadStream } = fs;
  fs.createReadStream = (p, ...rest) => createReadStream.call(fs, p === vanishing ? p + '.gone' : p, ...rest);
  let gone;
  try {
    gone = await find('*.py', dir);
  } finally {
    fs.createReadStream = createReadStream;
  }
  assert.strictEqual(gone.perSource[0].error, undefined);
  assert.deepStrictEqual(gone.results.map((c) => path.win32.basename(c.path)).sort(), ['beside.py', 'whole.py', 'whole2.py']);
  assert.deepStrictEqual(gone.perSource[0].notes, [
    '1 write(s) left out: Antigravity never reported them done',
    '1 transcript(s) could not be read in full',
  ]);
});

test('restore refuses the real folder read, also when brain or a conversation\'s logs are a junction', async () => {
  const root = workDir('antigravity-junction');
  dirs.push(root);
  const transcript = [planner('2026-09-23T01:00:00Z', writeCall(P, TEXT)), created(P, '2026-09-23T01:00:01Z')].join('');
  // brain is a junction to a folder on another drive.
  const realBrain = path.join(root, 'D', 'AG', 'brain');
  write(path.join(realBrain, CONV1, '.system_generated', 'logs', 'transcript_full.jsonl'), transcript);
  const dataA = path.join(root, 'A', 'antigravity-ide');
  fs.mkdirSync(dataA, { recursive: true });
  fs.symlinkSync(realBrain, path.join(dataA, 'brain'), 'junction');
  // One conversation's .system_generated is.
  const realGen = path.join(root, 'D', 'generated');
  write(path.join(realGen, 'logs', 'transcript_full.jsonl'), transcript);
  const dataB = path.join(root, 'B', 'antigravity-ide');
  fs.mkdirSync(path.join(dataB, 'brain', CONV2), { recursive: true });
  fs.symlinkSync(realGen, path.join(dataB, 'brain', CONV2, '.system_generated'), 'junction');
  for (const [place, real] of [[dataA, path.join(realBrain, CONV1)], [dataB, path.join(realGen, 'logs')]]) {
    const { results } = await find('main.py', place);
    assert.strictEqual(results.length, 1, place);
    const protect = antigravity.roots({ antigravity: [place] });
    for (const into of [path.join(place, 'brain', 'restored'), path.join(fs.realpathSync.native(real), 'restored')]) {
      await assert.rejects(restore(results[0], into, protect, git), /^Error: Refusing to write inside /, into);
    }
  }
  // Without links, the place alone.
  const plain = makeAntigravity();
  assert.deepStrictEqual(antigravity.roots({ antigravity: [plain] }), [path.resolve(plain)]);
});

test('a search writes nothing into the Antigravity folder', async () => {
  const dir = makeAntigravity();
  const before = snapshot(dir);
  await find('*', dir);
  await find('', dir, { containing: 'rewritten' });
  assert.deepStrictEqual(snapshot(dir), before);
});
