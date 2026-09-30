'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { workDir, cleanup, write } = require('./helpers');

// The page's languages: English in strings.js, every other one a file lang/<code>.json beside it
// (the rules are at the top of strings.js). The page's own code runs here in Node, as in
// gui-ui.test.js: tables built under test/.work are taken in and spoken, and every file there is
// in src/gui/ui/lang is held to the rules, so that a translator's mistake -- a key misspelt, a
// placeholder dropped or renamed, a plural form that cannot be right -- fails here, not on screen.

const UI = path.join(__dirname, '..', 'src', 'gui', 'ui');
const LANG = path.join(UI, 'lang');
const ui = require('../src/gui/ui/app.js');
const { en } = require('../src/gui/ui/strings.js');
const { LOCALES } = require('../src/i18n');
const { _internal } = require('../src/gui/server');

const dirs = [];
after(() => dirs.forEach(cleanup));

/** A table as a translator would write it, as a file under test/.work, read back as the page reads it. */
function tableFile(code, table) {
  const dir = workDir('gui-lang');
  dirs.push(dir);
  const file = write(path.join(dir, `${code}.json`), JSON.stringify(table, null, 2));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('a table is taken in and spoken, and a key it leaves out is said in English', () => {
  const raw = tableFile('ko', {
    'meta.lang': 'ko', 'meta.locale': 'ko-KR', 'meta.dir': 'ltr',
    'nav.find': '파일 찾기',
    'results.title.name': '“{name}” 검색 결과',
    'results.files': '파일 {count}개',
  });
  const checked = ui.useTable('ko', raw);
  assert.deepStrictEqual(checked.problems, []);
  assert.strictEqual(ui.setLanguage('ko'), 'ko');
  try {
    assert.strictEqual(ui.tr('nav.find'), '파일 찾기');
    assert.strictEqual(ui.tr('results.title.name', { name: 'budget' }), '“budget” 검색 결과');
    // One text for every count, as Korean has one form.
    assert.strictEqual(ui.tr('results.files', { count: 1 }), '파일 1개');
    assert.strictEqual(ui.tr('results.files', { count: 1284 }), '파일 1,284개');
    assert.strictEqual(ui.tr('nav.media'), en['nav.media'], 'a key left out is English');
    assert.strictEqual(ui.tr('meta.locale'), 'ko-KR');
    assert.strictEqual(ui.textDir(), 'ltr');
  } finally {
    ui.setLanguage('en');
  }
  assert.strictEqual(ui.tr('nav.find'), en['nav.find']);
  // A language with no table is English.
  assert.strictEqual(ui.setLanguage('fr'), 'en');
});

test('plural forms are chosen by the language\'s own rules, "other" standing in for one left out', () => {
  const ru = ui.useTable('ru', tableFile('ru', {
    'meta.lang': 'ru', 'meta.locale': 'ru-RU', 'meta.dir': 'ltr',
    'results.files': { one: '{count} файл', few: '{count} файла', many: '{count} файлов', other: '{count} файла' },
    'results.copies': { one: '{count} копия', other: '{count} копии' },
  }));
  assert.deepStrictEqual(ru.problems, []);
  assert.ok(ru.notes.some((n) => /results\.copies \((few|many)\): missing/.test(n)), ru.notes.join('\n'));
  ui.setLanguage('ru');
  try {
    const files = (n) => ui.tr('results.files', { count: n });
    assert.deepStrictEqual([1, 2, 5, 21, 22, 25, 111].map(files),
      ['1 файл', '2 файла', '5 файлов', '21 файл', '22 файла', '25 файлов', '111 файлов']);
    assert.strictEqual(ui.tr('results.copies', { count: 5 }), '5 копии', 'a form left out is "other"');
  } finally {
    ui.setLanguage('en');
  }

  const forms = { zero: 'لا ملفات', one: 'ملف واحد', two: 'ملفان', few: '{count} ملفات', many: '{count} ملفًا', other: '{count} ملف' };
  const ar = ui.useTable('ar', tableFile('ar', { 'meta.lang': 'ar', 'meta.locale': 'ar-u-nu-latn', 'meta.dir': 'rtl', 'results.files': forms }));
  assert.deepStrictEqual([ar.problems, ar.notes], [[], []]);
  ui.setLanguage('ar');
  try {
    assert.deepStrictEqual([0, 1, 2, 3, 11, 100].map((n) => ui.tr('results.files', { count: n })),
      ['لا ملفات', 'ملف واحد', 'ملفان', '3 ملفات', '11 ملفًا', '100 ملف']);
    assert.strictEqual(ui.textDir(), 'rtl');
    // No count is never taken for 0, whose form Arabic has: "other" stands in.
    assert.strictEqual(ui.tr('results.files'), '{count} ملف');
    // What is put into a sentence keeps its own direction there.
    assert.strictEqual(ui.tr('results.title.name', { name: 'budget' }), 'Results for “\u2068budget\u2069”');
    assert.strictEqual(ui.logicalKey('ArrowRight', 'rtl'), 'ArrowLeft');
    assert.strictEqual(ui.logicalKey('ArrowUp', 'rtl'), 'ArrowUp');
  } finally {
    ui.setLanguage('en');
  }
  assert.strictEqual(ui.logicalKey('ArrowRight', 'ltr'), 'ArrowRight');
  // Which forms stand for one number alone, and may say it in words rather than {count}.
  assert.deepStrictEqual([...ui.pluralForms('en').lone], ['one']);
  assert.deepStrictEqual([...ui.pluralForms('ru-RU').lone], []);
  assert.deepStrictEqual([...ui.pluralForms('ar').lone].sort(), ['one', 'two', 'zero']);
  assert.deepStrictEqual([...ui.pluralForms('fr').lone], [], 'French "one" is 0 and 1');
});

test('a translator\'s mistakes are caught, and each is shown in English rather than wrong', () => {
  const { problems, notes, table } = ui.checkTable('ru', {
    'meta.lang': 'ja', 'meta.locale': 'ru-RU', 'meta.dir': 'rtl',
    'nav.fnd': 'Найти',
    'results.title.name': 'Результаты для «{nmae}»',
    'restore.dest.hint': '',
    'results.nameOnly': '(папка неизвестна)',
    'results.files': { one: 'один файл', few: '{count} файла', many: '{count} файлов', other: '{count} файла' },
    'results.copies': { one: '{count} копия', lots: '{count} копий' },
    'nav.help': { one: 'Справка', other: 'Справка' },
    'grid.selected': ['{count}'],
    'nav.find': 'Найти файл',
  });
  const says = (re) => problems.some((p) => re.test(p));
  assert.ok(says(/^meta\.lang: "ja" does not fit ru$/), problems.join('\n'));
  assert.ok(says(/^meta\.dir: "rtl" does not fit ru$/));
  assert.ok(says(/^nav\.fnd: English has no such key$/));
  assert.ok(says(/^results\.title\.name: \{nmae\} is not one of its placeholders$/));
  assert.ok(says(/^results\.title\.name: \{name\} is left out$/));
  assert.ok(says(/^restore\.dest\.hint: not a text$/));
  assert.ok(says(/^results\.nameOnly: \{name\} is left out$/));
  assert.ok(says(/^results\.files \(one\): \{count\} is left out$/), 'Russian "one" is also 21');
  assert.ok(says(/^results\.copies \(lots\): no such plural form$/));
  assert.ok(says(/^results\.copies: no "other" form$/));
  assert.ok(says(/^nav\.help: plural forms for a text that counts nothing$/));
  assert.ok(says(/^grid\.selected: not a text$/));
  // What broke a rule is left out, to be shown in English; the rest is kept.
  for (const key of ['nav.fnd', 'results.title.name', 'restore.dest.hint', 'results.nameOnly', 'results.files', 'results.copies', 'nav.help', 'grid.selected']) {
    assert.ok(!(key in table), key);
  }
  assert.strictEqual(table['nav.find'], 'Найти файл');
  assert.deepStrictEqual([table['meta.lang'], table['meta.dir']], ['ru', 'ltr'], 'meta that does not fit follows the code');
  assert.deepStrictEqual(notes, []);
  // Not a table at all.
  assert.deepStrictEqual(ui.checkTable('de', ['x']).table, null);
  // meta.* left out follows the code: Arabic is right to left.
  const bare = ui.checkTable('ar', { 'nav.find': 'ابحث عن ملف' });
  assert.deepStrictEqual([bare.table['meta.lang'], bare.table['meta.locale'], bare.table['meta.dir']], ['ar', 'ar', 'rtl']);
  assert.strictEqual(bare.notes.length, 3);
});

test('the English table keeps its own rules', () => {
  const { problems, notes } = ui.checkTable('en', en);
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(notes, []);
});

test('every language file there is has only keys English has, its placeholders, and its plural forms', () => {
  const files = fs.existsSync(LANG) ? fs.readdirSync(LANG).filter((f) => !f.startsWith('.')) : [];
  const codes = new Set(LOCALES.map((l) => l.code).filter((c) => c !== 'en'));
  for (const file of files) {
    const code = file.replace(/\.json$/, '');
    assert.ok(file.endsWith('.json') && codes.has(code), `${file}: not lang/<code>.json for a code of LOCALES (the case counts)`);
    const text = fs.readFileSync(path.join(LANG, file), 'utf8');
    assert.ok(!text.startsWith('\ufeff'), `${file} starts with a byte order mark`);
    let raw;
    assert.doesNotThrow(() => { raw = JSON.parse(text); }, `${file} is not JSON`);
    const { problems, notes } = ui.checkTable(code, raw);
    assert.deepStrictEqual(problems, [], `${file}:\n  ${problems.join('\n  ')}`);
    assert.deepStrictEqual(notes, [], `${file}:\n  ${notes.join('\n  ')}`);
  }
});

test('the rules are written where translators read them, for the codes the page offers', () => {
  const header = fs.readFileSync(path.join(UI, 'strings.js'), 'utf8').split('(function')[0];
  assert.match(header, /lang\/<code>\.json/);
  for (const { code } of LOCALES) if (code !== 'en') assert.ok(header.includes(` ${code}`), code);
  for (const term of ['meta.lang', 'meta.locale', 'meta.dir', 'Intl.PluralRules', 'zero, one, two, few, many, other']) {
    assert.ok(header.includes(term), term);
  }
});

test('the browser\'s languages are matched as src/i18n.js matches them', () => {
  const codes = LOCALES.map((l) => l.code);
  const pick = (wanted) => ui.pickLanguage(wanted, codes);
  assert.strictEqual(pick(['ko-KR', 'en-US']), 'ko');
  assert.strictEqual(pick(['zh-Hant-TW']), 'zh-TW');
  assert.strictEqual(pick(['zh-HK']), 'zh-TW');
  assert.strictEqual(pick(['zh']), 'zh-CN');
  assert.strictEqual(pick(['zh-Hans-HK']), 'zh-CN');
  assert.strictEqual(pick(['pt-PT']), 'pt-BR');
  assert.strictEqual(pick(['sv-SE', 'de-AT']), 'de');
  assert.strictEqual(pick(['sv-SE']), 'en');
  // Only among the languages the page has.
  assert.strictEqual(ui.pickLanguage(['ko-KR', 'ja'], ['en', 'ja']), 'ja');
  const { matchLocale } = require('../src/i18n');
  for (const tag of ['ko-KR', 'zh-Hant-TW', 'zh-HK', 'zh', 'pt-PT', 'de-AT', 'ar-EG', 'hi-IN', 'th']) {
    assert.strictEqual(pick([tag]), matchLocale([tag]), tag);
  }
});

test('a language file goes into the built program under the name the server asks for', () => {
  // A copy of the tree with one language file: the bundler leaves it to the program's assets,
  // keyed as lang/<code>.json, which is what the server asks require('node:sea').getAsset() for.
  const root = workDir('gui-lang-bundle');
  dirs.push(root);
  const top = path.join(__dirname, '..');
  for (const part of ['bin', 'src', 'package.json']) fs.cpSync(path.join(top, part), path.join(root, part), { recursive: true });
  write(path.join(root, 'src', 'gui', 'ui', 'lang', 'ko.json'), JSON.stringify({ 'nav.find': '파일 찾기' }));
  const { bundle } = require('../scripts/bundle');
  const { pages } = bundle({ root });
  const keys = pages.map((p) => p.key);
  assert.ok(keys.includes('lang/ko.json'), keys.join(', '));
  for (const k of ['index.html', 'app.js', 'strings.js', 'style.css']) assert.ok(keys.includes(k), k);
});

test('the server offers the languages the page has a file for, English first', () => {
  const files = {
    'lang/ko.json': Buffer.from(JSON.stringify({ 'nav.find': '파일 찾기' })),
    'lang/de.json': Buffer.from('{ not json'),
    'lang/ar.json': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]),
    'lang/ja.json': Buffer.from('[]'),
  };
  const offered = _internal.pageLanguages((rel) => files[rel] || null);
  assert.deepStrictEqual(offered.map((l) => l.code), ['en', 'ko', 'ar']);
  assert.deepStrictEqual(offered[1], { code: 'ko', name: '한국어' });
  assert.deepStrictEqual(_internal.pageLanguages(() => null), [{ code: 'en', name: 'English' }]);
  assert.strictEqual(_internal.localeOf('ZH-tw'), 'zh-TW');
  assert.strictEqual(_internal.localeOf('ko-KR'), 'ko');
  assert.strictEqual(_internal.localeOf('en-US'), 'en');
  assert.strictEqual(_internal.localeOf('xx'), null);
  assert.strictEqual(_internal.localeOf(''), null);
});
