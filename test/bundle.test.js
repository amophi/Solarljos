'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { workDir, cleanup, write } = require('./helpers');
const { bundle } = require('../scripts/bundle');

// The bundle scripts/build-exe.js makes the program from, built from this tree and run with the
// Node running the tests. What would break the program -- a require() the bundler cannot follow,
// a module that does not compile, a source that cannot be loaded, two page files of one name --
// then shows on every run of the tests, and not only when a release is tagged and built. The
// bundle is written under test/.work and run from there, with every place given and discovery
// off: it reads nothing of this machine's.

const dirs = [];
after(() => dirs.forEach(cleanup));

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');

test('the tree bundles into one script that runs as the command line does', () => {
  const dir = workDir('bundle');
  dirs.push(dir);
  const { code, modules, pages } = bundle();
  const file = write(path.join(dir, 'solarljos.cjs'), code);
  // Every source and every library module is in it, although search.js names the sources only
  // through source(file, id).
  for (const folder of ['src/sources', 'src/lib']) {
    for (const name of fs.readdirSync(path.join(ROOT, folder)).filter((n) => n.endsWith('.js'))) {
      assert.ok(modules.includes(`${folder}/${name}`), `${folder}/${name} is not in the bundle: ${modules.join(', ')}`);
    }
  }
  assert.ok(modules.includes('src/gui/server.js'));
  // The page's four files, its font and the font's licence, and a table for every language the page has one for.
  const tables = fs.readdirSync(path.join(ROOT, 'src/gui/ui/lang')).filter((n) => n.endsWith('.json')).map((n) => `lang/${n}`);
  assert.ok(tables.includes('lang/ko.json'), 'the Korean table is there');
  assert.deepStrictEqual(pages.map((p) => p.key).sort(),
    ['app.js', 'index.html', 'strings.js', 'style.css', 'fonts/Pretendard-OFL.txt', 'fonts/PretendardVariable.woff2', ...tables].sort());
  assert.strictEqual(bundle().code, code, 'the same tree bundles to the same bytes');

  const run = (...args) => execFileSync(process.execPath, [file, ...args], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(run('--version').trim(), pkg.version);
  // Every source loads: one that did not would say so here, and find nothing in the program.
  const sources = run('sources', '--no-discover');
  assert.doesNotMatch(sources, /Could not be loaded/i);
  assert.match(sources, /Cards and USB drives/);

  // A search and a restore, on a Linux trash made here.
  const trash = path.join(dir, 'Trash');
  write(path.join(trash, 'files', 'smoke-test.txt'), 'bundled\n');
  write(path.join(trash, 'info', 'smoke-test.txt.trashinfo'), '[Trash Info]\nPath=/home/u/smoke-test.txt\nDeletionDate=2026-09-01T12:00:00\n');
  const where = ['--source', 'trash', '--no-discover', '--location', `trash=${trash}`];
  const { results } = JSON.parse(run('find', 'smoke-test.txt', ...where, '--json'));
  assert.deepStrictEqual(results.map((c) => c.path), ['/home/u/smoke-test.txt']);
  const to = path.join(dir, 'restored');
  run('restore', 'smoke-test.txt', results[0].id, ...where, '--to', to);
  assert.strictEqual(fs.readFileSync(path.join(to, 'smoke-test.txt'), 'utf8'), 'bundled\n');
});
