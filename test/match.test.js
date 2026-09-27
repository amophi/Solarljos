'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { compile } = require('../src/match');
const { fileUriToPath, pathKey, isInside } = require('../src/paths');

test('a plain word matches inside the file name, in any case', () => {
  const m = compile('Report');
  assert.ok(m.test('C:\\docs\\final-REPORT.docx'));
  assert.ok(m.test('/home/a/report.txt'));
  assert.ok(!m.test('C:\\report\\notes.txt'), 'a folder name alone is not the file name');
});

test('a glob matches the whole file name', () => {
  const m = compile('*.js');
  assert.ok(m.test('C:\\p\\app.js'));
  assert.ok(!m.test('C:\\p\\app.json'));
  assert.ok(!m.test('C:\\p\\app.js.bak'));
  assert.ok(compile('a?c.txt').test('/x/abc.txt'));
  assert.ok(!compile('a?c.txt').test('/x/abbc.txt'));
});

test('with a separator the full path is searched, either separator', () => {
  const m = compile('src/app');
  assert.ok(m.test('C:\\proj\\src\\app.js'));
  assert.ok(m.test('/proj/src/app.js'));
  assert.ok(!m.test('/proj/lib/app.js'));
  assert.ok(compile('src\\app').test('/proj/src/app.js'));
});

test('a glob with a separator matches the end of the path', () => {
  const m = compile('src/*.js');
  assert.ok(m.test('C:\\proj\\src\\app.js'));
  assert.ok(!m.test('C:\\proj\\src\\app.ts'));
});

test('regular-expression characters in a pattern are plain text', () => {
  assert.ok(compile('a+b(1).txt').test('/x/a+b(1).txt'));
  assert.ok(!compile('a.c').test('/x/abc'));
});

test('the literal is the longest plain run, used to skip data early', () => {
  assert.strictEqual(compile('*.test.js').literal, '.test.js');
  assert.strictEqual(compile('Report').literal, 'report');
  assert.strictEqual(compile('*').literal, '');
});

test('an empty pattern or * matches everything', () => {
  assert.ok(compile('').everything);
  assert.ok(compile('*').everything);
  assert.ok(compile('').test('/any/file'));
  assert.ok(!compile('x').everything);
});

test('file URIs become paths; other schemes are kept', () => {
  assert.strictEqual(fileUriToPath('file:///c%3A/Users/alice/My%20Docs/a.js'), 'C:\\Users\\alice\\My Docs\\a.js');
  assert.strictEqual(fileUriToPath('file:///home/alice/a.js'), '/home/alice/a.js');
  assert.strictEqual(fileUriToPath('file://server/share/a.js'), '\\\\server\\share\\a.js');
  assert.strictEqual(fileUriToPath('vscode-remote://ssh-remote%2Bbox/home/a.js'), 'vscode-remote://ssh-remote%2Bbox/home/a.js');
  assert.strictEqual(fileUriToPath('file:///c%3A/%ED%95%9C%EA%B8%80.txt'), 'C:\\한글.txt');
});

test('Windows paths compare without case; others with it', () => {
  assert.strictEqual(pathKey('C:\\Users\\A.txt'), pathKey('c:/users/a.txt'));
  assert.notStrictEqual(pathKey('/home/A.txt'), pathKey('/home/a.txt'));
  assert.ok(isInside(__filename, __dirname));
  assert.ok(isInside(__dirname, __dirname));
  assert.ok(!isInside(__dirname + '-other', __dirname), 'a sibling with a longer name is not inside');
});
