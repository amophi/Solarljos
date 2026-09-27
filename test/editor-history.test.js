'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { workDir, cleanup, write, only } = require('./helpers');
const { search, git } = require('../src/search');
const { load } = require('../src/content');

const dirs = [];
after(() => dirs.forEach(cleanup));

function makeHistory() {
  const root = workDir('history');
  dirs.push(root);
  const history = path.join(root, 'Code', 'User', 'History');
  const f1 = path.join(history, '-7a1b2c');
  write(path.join(f1, 'entries.json'), JSON.stringify({
    version: 1,
    resource: 'file:///c%3A/Users/alice/app/server.js',
    entries: [
      { id: 'Ab12.js', timestamp: 1000 },
      { id: 'Cd34.js', timestamp: 2000, source: 'Workspace Edit' },
      { id: '..\\escape.js', timestamp: 3000 },
      { id: 'missing.js', timestamp: 4000 },
    ],
  }));
  write(path.join(f1, 'Ab12.js'), 'v1');
  write(path.join(f1, 'Cd34.js'), 'v2');
  const f2 = path.join(history, '4d5e6f');
  write(path.join(f2, 'entries.json'), JSON.stringify({
    version: 1, resource: 'file:///c%3A/Users/alice/app/client.js', entries: [{ id: 'Ef56.js', timestamp: 1500 }],
  }));
  write(path.join(f2, 'Ef56.js'), 'client');
  write(path.join(history, 'broken', 'entries.json'), '{ not json');
  return history;
}

test('every saved version of a matching file is a result, newest first', async () => {
  const history = makeHistory();
  const { results } = await search({ pattern: 'server.js', sources: ['history'], locations: only({ historyDirs: [history] }) });
  assert.deepStrictEqual(results.map((r) => r.time), [2000, 1000]);
  assert.ok(results.every((r) => r.path === 'C:\\Users\\alice\\app\\server.js'));
  assert.strictEqual((await load(results[0], git)).toString(), 'v2');
  assert.match(results[0].note, /Workspace Edit/);
});

test('an entry id cannot point outside its folder, and missing copies are skipped', async () => {
  const history = makeHistory();
  const { results } = await search({ pattern: '*', sources: ['history'], locations: only({ historyDirs: [history] }) });
  assert.deepStrictEqual(results.map((r) => r.time).sort(), [1000, 1500, 2000]);
});
