'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { compile } = require('../src/match');
const { pathKey } = require('../src/paths');
const { planRebuild } = require('../src/restore');
const { dedupe } = require('../src/search')._internal;

test('a decomposed name (as macOS writes Hangul) matches the composed one', () => {
  const composed = '보고서.txt';
  const decomposed = composed.normalize('NFD');
  assert.notStrictEqual(composed, decomposed);
  assert.ok(compile('보고서').test('/Users/a/' + decomposed));
  assert.ok(compile(decomposed.slice(0, 6)).test('C:\\docs\\' + composed));
  assert.strictEqual(pathKey('/a/' + decomposed), pathKey('/a/' + composed));
});

test('a merged result is a draft only when every copy of it was never saved', () => {
  const base = { path: 'C:\\a.txt', hash: 'h', kind: 'k' };
  const [mixed] = dedupe([{ ...base, draft: true, time: 2 }, { ...base, kind: 'j', time: 1 }]);
  assert.strictEqual(mixed.draft, false, 'the same bytes were found saved somewhere');
  const [both] = dedupe([{ ...base, draft: true, time: 2 }, { ...base, kind: 'j', draft: true, time: 1 }]);
  assert.strictEqual(both.draft, true);
});

test('rebuild takes a draft only for a path with no saved copy, however new it is', () => {
  const plan = planRebuild([
    { path: 'C:\\p\\a.txt', time: 99, kind: 'unsaved', draft: true, text: 'draft' },
    { path: 'C:\\p\\a.txt', time: 1, kind: 'local history', text: 'saved' },
    { path: 'C:\\p\\b.txt', time: 5, kind: 'unsaved', draft: true, text: 'only' },
  ], 'C:\\p');
  assert.deepStrictEqual(plan.map((p) => [p.rel[0], p.copy.text]), [['a.txt', 'saved'], ['b.txt', 'only']]);
});
