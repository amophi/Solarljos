'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { workDir, cleanup, write, infoV2, snapshot } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'solarljos.js');
const dirs = [];
after(() => dirs.forEach(cleanup));

function fixtures() {
  const root = workDir('cli');
  dirs.push(root);
  const bin = path.join(root, 'sources', '$Recycle.Bin', 'S-1-5-21-9-9-9-1001');
  write(path.join(bin, '$IQ1W2E3.txt'), infoV2('C:\\Users\\alice\\budget.txt', 7, Date.UTC(2026, 8, 1)));
  write(path.join(bin, '$RQ1W2E3.txt'), 'numbers');
  write(path.join(bin, '$IP0O9I8.png'), infoV2('C:\\Users\\alice\\chart.png', 4, Date.UTC(2026, 8, 2)));
  write(path.join(bin, '$RP0O9I8.png'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
  return { root, recycle: path.join(root, 'sources', '$Recycle.Bin') };
}

function cli(args, f) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--no-discover', '--recycle-dir', f.recycle], {
    cwd: f.root, encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('find lists copies with an ID and tells how to get one back', () => {
  const f = fixtures();
  const r = cli(['find', 'budget'], f);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /C:\\Users\\alice\\budget\.txt/);
  assert.match(r.out, /^[0-9a-f]{8} /m);
  assert.match(r.out, /solarljos restore budget .*--to <folder>/);
});

test('find exits 1 when nothing turns up', () => {
  const f = fixtures();
  const r = cli(['find', 'no-such-file'], f);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /Nothing found/);
});

test('--json prints only JSON', () => {
  const f = fixtures();
  const r = cli(['find', '*.txt', '--json'], f);
  const data = JSON.parse(r.out);
  assert.strictEqual(data.results.length, 1);
  assert.strictEqual(data.results[0].path, 'C:\\Users\\alice\\budget.txt');
  assert.strictEqual(data.results[0].kind, 'recycle bin');
});

test('show prints the content; a binary file needs --binary', () => {
  const f = fixtures();
  const id = JSON.parse(cli(['find', 'budget', '--json'], f).out).results[0].id;
  const r = cli(['show', 'budget', id.slice(0, 5)], f);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, 'numbers\n');
  const png = JSON.parse(cli(['find', 'chart', '--json'], f).out).results[0].id;
  const refused = cli(['show', 'chart', png], f);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /binary/);
});

test('restore writes under --to; the sources are left exactly as they were', () => {
  const f = fixtures();
  const before = snapshot(path.join(f.root, 'sources'));
  const id = JSON.parse(cli(['find', 'budget', '--json'], f).out).results[0].id;
  const out = path.join(f.root, 'recovered');
  const r = cli(['restore', 'budget', id, '--to', out], f);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(fs.readFileSync(path.join(out, 'budget.txt'), 'utf8'), 'numbers');
  assert.deepStrictEqual(snapshot(path.join(f.root, 'sources')), before);
});

test('restore refuses to write into a searched location', () => {
  const f = fixtures();
  const id = JSON.parse(cli(['find', 'budget', '--json'], f).out).results[0].id;
  const r = cli(['restore', 'budget', id, '--to', path.join(f.recycle, 'x')], f);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /Refusing to write inside/);
  assert.ok(!fs.existsSync(path.join(f.recycle, 'x')));
});

test('usage mistakes exit 2', () => {
  const f = fixtures();
  assert.strictEqual(cli(['find', 'x', '--bogus'], f).code, 2);
  assert.strictEqual(cli(['restore', 'budget', 'abc'], f).code, 2, 'restore without --to');
  assert.strictEqual(cli(['frobnicate'], f).code, 2);
  assert.strictEqual(cli(['find', 'x', '--since', 'someday'], f).code, 2);
});

test('an unknown ID is an error, not a guess', () => {
  const f = fixtures();
  const r = cli(['show', 'budget', 'ffffffff'], f);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /No copy has the ID/);
});

test('--help and --version', () => {
  const f = fixtures();
  assert.match(cli(['--help'], f).out, /solarljos find <name>/);
  assert.match(cli(['--version'], f).out, /^\d+\.\d+\.\d+/);
});
