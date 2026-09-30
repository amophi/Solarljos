'use strict';

const { test, afterEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { workDir, cleanup, write, snapshot } = require('./helpers');
const { t, setLocale, getLocale, matchLocale, LOCALES, _internal } = require('../src/i18n');
const locales = require('../src/locales');
const tool = require('../scripts/i18n');
const { bundle } = require('../scripts/bundle');

// src/i18n.js, src/locales and scripts/i18n.js. messages.json must be what extract finds in the
// sources now, so that a message added to a t() cannot be left out of it; every catalog in
// src/locales must pass check; and setLocale() offers a language only when its catalog translates
// every message. The catalogs made up here are given in memory, or written into a copy of the
// tree under test/.work, never into src/locales. Every test leaves t() speaking English.

const ROOT = path.join(__dirname, '..');
const dirs = [];
after(() => dirs.forEach(cleanup));

afterEach(() => {
  const left = getLocale();
  _internal.readFrom();
  assert.strictEqual(left, 'en', 'a test left t() speaking another language');
});

// The fixtures' JavaScript is written with ~ for each backslash, so that what it holds is plain to
// read here: ~u0041 is the escape \u0041 in the fixture.
const BS = String.fromCharCode(92);
const js = (s) => s.replace(/~/g, BS);
/** A string written out in JavaScript, as Node itself reads it. */
const evaluate = (source) => Function(`'use strict'; return (${source});`)();

/** Catalogs in memory, as src/locales gives them, counting how often each is read. */
function memory(messages, catalogs) {
  const reads = new Map();
  return {
    reads,
    catalog: (code) => {
      reads.set(code, (reads.get(code) || 0) + 1);
      return Object.hasOwn(catalogs, code) ? catalogs[code] : null;
    },
    messages: () => Object.fromEntries(messages.map((m) => [m, ['src/test.js']])),
  };
}

/**
 * A copy of the tree's bin/, src/ and package.json under test/.work, with no catalog, and
 * messages.json as extract writes it there. `already` is what extract says of the tree as it is,
 * which the first test fails on; the tests of a copy look only at what they did to it.
 */
function copyTree(name) {
  const dir = workDir(name);
  dirs.push(dir);
  for (const f of ['bin', 'src']) fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  for (const f of fs.readdirSync(path.join(dir, 'src', 'locales'))) {
    if (f !== 'index.js' && f !== 'messages.json') fs.rmSync(path.join(dir, 'src', 'locales', f));
  }
  const got = tool.extract(dir);
  write(path.join(dir, 'src', 'locales', 'messages.json'), tool.serialize(got.messages));
  return { dir, messages: [...got.messages.keys()], already: got.problems };
}

/** scripts/i18n.js main(), with what it prints kept rather than printed. */
function run(argv, root) {
  const out = [];
  const real = process.stdout.write;
  process.stdout.write = (s) => out.push(String(s)) > 0;
  try {
    return { code: tool.main(argv, root), out: out.join('') };
  } finally {
    process.stdout.write = real;
  }
}

const holes = (m) => (m.match(/\{\d+\}/g) || []).sort().join(' ');

test('messages.json lists every message t() can be given, as extract finds them in the sources now', () => {
  const got = tool.extract();
  assert.deepStrictEqual(got.problems, [], 'extract cannot list every message');
  const written = fs.readFileSync(path.join(ROOT, 'src', 'locales', 'messages.json'), 'utf8');
  if (written !== tool.serialize(got.messages)) {
    const before = new Set(Object.keys(JSON.parse(written)));
    const added = [...got.messages.keys()].filter((m) => !before.has(m));
    const gone = [...before].filter((m) => !got.messages.has(m));
    assert.fail('src/locales/messages.json is not what the sources say now: run node scripts/i18n.js extract. '
      + `Not in it: ${JSON.stringify(added.slice(0, 5))}${added.length > 5 ? ` and ${added.length - 5} more` : ''}; `
      + `in it and no longer given: ${JSON.stringify(gone.slice(0, 5))}${gone.length > 5 ? ` and ${gone.length - 5} more` : ''}.`);
  }
  // No call is made as its module loads: its message would keep the language of that moment.
  assert.deepStrictEqual(got.atLoad.map((c) => `${c.file}:${c.line}`), []);
});

test('every message written out in the sources reads as Node reads it', () => {
  let n = 0;
  for (const file of tool.jsFiles(ROOT)) {
    for (const c of tool.scan(fs.readFileSync(path.join(ROOT, file), 'utf8'), file).calls) {
      if (c.message === undefined) continue;
      assert.strictEqual(c.message, evaluate(c.source), `${file}:${c.line}`);
      n++;
    }
  }
  assert.ok(n > 500, `only ${n} messages written out`);
});

test('the messages a call works out are all listed: every kind, every source\'s label, every state', () => {
  const { messages, computed } = tool.extract();
  const quality = require('../src/quality');
  const kinds = [...Object.keys(quality.FIDELITY), ...quality.INEXACT, ...quality.UNVERIFIED, ...quality.DERIVED];
  // INEXACT has kinds FIDELITY does not rank: git's filter not run, its line endings, its bare objects.
  assert.ok(kinds.length > Object.keys(quality.FIDELITY).length);
  for (const kind of kinds) assert.ok((messages.get(kind) || []).includes('src/quality.js'), kind);
  for (const s of require('../src/search').SOURCES) assert.ok(messages.has(s.label), s.label);
  assert.ok(messages.get('Recycle Bin').includes('src/sources/recycle-bin.js'));
  for (const { message, file } of tool.STATES) assert.ok((messages.get(message) || []).includes(file), message);
  // Every entry of COMPUTED is some call's, and every call's is one of them.
  assert.strictEqual(new Set(computed.map((c) => c.entry)).size, tool.COMPUTED.length);
  assert.ok(computed.some((c) => c.file === 'src/gui/server.js' && c.arg === 'c.kind'));
});

test('every catalog in src/locales passes check, and setLocale offers it', () => {
  const { languages, problems } = tool.check();
  // What check says of messages.json and the sources, the first test says.
  assert.deepStrictEqual(problems.filter((p) => p.startsWith('src/locales/') && !p.startsWith(tool.MESSAGES)), []);
  assert.deepStrictEqual(languages.map((l) => l.code), LOCALES.slice(1).map((l) => l.code));
  for (const l of languages) {
    assert.strictEqual(setLocale(l.code), l.present ? l.code : 'en', l.code);
    assert.strictEqual(setLocale('en'), 'en');
  }
});

test('the languages are the eighteen, in their order, each with a catalog file of its own but English', () => {
  assert.deepStrictEqual(LOCALES.map((l) => l.code),
    ['en', 'ko', 'ja', 'zh-CN', 'zh-TW', 'es', 'fr', 'de', 'pt-BR', 'ru', 'it', 'pl', 'tr', 'vi', 'id', 'th', 'ar', 'hi']);
  assert.deepStrictEqual(LOCALES.map((l) => l.name), ['English', '한국어', '日本語', '简体中文', '繁體中文', 'Español',
    'Français', 'Deutsch', 'Português (Brasil)', 'Русский', 'Italiano', 'Polski', 'Türkçe', 'Tiếng Việt',
    'Bahasa Indonesia', 'ไทย', 'العربية', 'हिन्दी']);
  assert.ok(Object.isFrozen(LOCALES) && LOCALES.every((l) => Object.isFrozen(l)));
  assert.deepStrictEqual(Object.entries(locales.FILES), LOCALES.slice(1).map((l) => [l.code, `./${l.code}.json`]));
  for (const code of ['en', 'xx', 'constructor', '__proto__', '../package']) assert.strictEqual(locales.catalog(code), null, code);
});

test('a language tag is read as one of them, in any case, from any region, and Chinese by its script', () => {
  const cases = {
    'en': 'en', 'EN-us': 'en', 'en_GB.UTF-8': 'en', ' en-GB ': 'en',
    'ko': 'ko', 'ko-KR': 'ko', 'ko_KR.UTF-8': 'ko', 'KO-kr': 'ko', 'ja-JP': 'ja',
    'zh': 'zh-CN', 'zh-CN': 'zh-CN', 'zh-cn': 'zh-CN', 'zh_CN': 'zh-CN', 'zh-SG': 'zh-CN', 'zh-MY': 'zh-CN',
    'zh-Hans': 'zh-CN', 'zh-Hans-CN': 'zh-CN', 'zh-Hans-HK': 'zh-CN',
    'zh-TW': 'zh-TW', 'zh-HK': 'zh-TW', 'zh-MO': 'zh-TW', 'zh-Hant': 'zh-TW', 'zh-Hant-TW': 'zh-TW', 'ZH-HANT-cn': 'zh-TW',
    'pt': 'pt-BR', 'pt-PT': 'pt-BR', 'pt-BR': 'pt-BR', 'PT_br': 'pt-BR', 'pt-AO': 'pt-BR',
    'es': 'es', 'es-ES': 'es', 'es-419': 'es', 'es-MX': 'es', 'ES_ar': 'es',
    'fr-CA': 'fr', 'de-AT': 'de', 'ru-RU': 'ru', 'it-CH': 'it', 'pl-PL': 'pl', 'tr-TR': 'tr', 'vi-VN': 'vi',
    'id-ID': 'id', 'th-TH': 'th', 'ar-EG': 'ar', 'hi-IN': 'hi', 'de-DE@euro': 'de',
  };
  for (const [tag, code] of Object.entries(cases)) {
    assert.strictEqual(_internal.normalize(tag), code, tag);
    assert.strictEqual(matchLocale([tag]), code, tag);
  }
  for (const tag of ['xx', 'nb-NO', 'he-IL', 'zhx', 'x-private', '', ' ', '*', undefined, null, 42, {}]) {
    assert.strictEqual(_internal.normalize(tag), null, String(tag));
    assert.strictEqual(matchLocale([tag]), 'en', String(tag));
  }
});

test('matchLocale takes the first of them asked for, ordered by q= as an Accept-Language header orders them', () => {
  assert.strictEqual(matchLocale(['nb-NO', 'de-CH', 'en']), 'de');
  assert.strictEqual(matchLocale(['en-US', 'ko']), 'en');
  assert.strictEqual(matchLocale('ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'), 'ko');
  assert.strictEqual(matchLocale('fr-CH, fr;q=0.9, en;q=0.8, de;q=0.7, *;q=0.5'), 'fr');
  assert.strictEqual(matchLocale('en;q=0.5, ja'), 'ja');
  assert.strictEqual(matchLocale('ko;q=0, ja;q=0.1'), 'ja');
  assert.strictEqual(matchLocale(['xx', 'zh-HK;q=0.4', 'pt;q=0.4']), 'zh-TW');
  assert.strictEqual(matchLocale(['nb', 42, null, 'it']), 'it');
  for (const none of ['*', '', [], undefined, null, 'xx;q=1, ko;q=0']) assert.strictEqual(matchLocale(none), 'en');
  // It says what was asked for; whether its catalog is complete is setLocale's to say.
  _internal.readFrom(memory(['Nothing found.'], {}));
  try {
    assert.strictEqual(matchLocale(['ko']), 'ko');
    assert.strictEqual(setLocale(matchLocale(['ko'])), 'en');
  } finally {
    _internal.readFrom();
  }
});

test('setLocale offers a language whose catalog translates every message, and t() then speaks it', () => {
  const source = memory(['Restored {0} to {1}', 'Nothing found.'], {
    ko: { 'Restored {0} to {1}': '[{1} <- {0}]', 'Nothing found.': '[nothing]' },
  });
  _internal.readFrom(source);
  try {
    assert.strictEqual(getLocale(), 'en');
    assert.strictEqual(setLocale('ko-KR'), 'ko');
    assert.strictEqual(getLocale(), 'ko');
    // The translation puts the arguments where it wants them.
    assert.strictEqual(t('Restored {0} to {1}', 'a.txt', 'D:\\out'), '[D:\\out <- a.txt]');
    assert.strictEqual(t('Nothing found.'), '[nothing]');
    // What no catalog has -- a source's id standing in for its label -- comes back as it is,
    // and a {n} with no argument for it stays.
    assert.strictEqual(t('recycle'), 'recycle');
    assert.strictEqual(t('{0} of {1}', 1), '1 of {1}');
    // Back to English, and to Korean again, which is not read a second time.
    assert.strictEqual(setLocale('en'), 'en');
    assert.strictEqual(t('Restored {0} to {1}', 'a.txt', 'D:\\out'), 'Restored a.txt to D:\\out');
    assert.strictEqual(setLocale('KO'), 'ko');
    assert.strictEqual(source.reads.get('ko'), 1);
  } finally {
    _internal.readFrom();
  }
  assert.strictEqual(getLocale(), 'en');
  assert.strictEqual(t('Nothing found.'), 'Nothing found.');
});

test('a language with no catalog, or one that leaves a message out or empty, is not offered: t() keeps to English', () => {
  const messages = ['Nothing found.', 'Restored {0} to {1}'];
  _internal.readFrom(memory(messages, {
    ko: { 'Nothing found.': '[nothing]', 'Restored {0} to {1}': '[{1} <- {0}]' },
    ja: { 'Nothing found.': '[nothing]' },
    fr: { 'Nothing found.': '[nothing]', 'Restored {0} to {1}': '  ' },
    de: { 'Nothing found.': '[nothing]', 'Restored {0} to {1}': 7 },
    es: ['Nothing found.', 'Restored {0} to {1}'],
    it: 'not an object',
  }));
  try {
    for (const code of ['ja', 'fr', 'de', 'es', 'it', 'ru', 'xx', '', null, undefined, 42]) {
      assert.strictEqual(setLocale('ko'), 'ko');
      assert.strictEqual(setLocale(code), 'en', String(code));
      assert.strictEqual(getLocale(), 'en');
      assert.strictEqual(t('Nothing found.'), 'Nothing found.');
    }
  } finally {
    _internal.readFrom();
  }
});

test('the language is English until it is set, whatever the machine\'s language is', () => {
  const env = { ...process.env, LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8', LC_MESSAGES: 'ko_KR.UTF-8', LANGUAGE: 'ko' };
  const out = execFileSync(process.execPath, ['-e',
    `const i = require(${JSON.stringify(path.join(ROOT, 'src', 'i18n.js'))});`
    + 'process.stdout.write(i.getLocale() + " " + i.t("Restored {0} to {1}", "a", "b"));'], { encoding: 'utf8', env });
  assert.strictEqual(out, 'en Restored a to b');
});

test('extract reads a message as JavaScript does, and only from calls of t()', () => {
  const written = [
    "t('plain', 1);",
    js('t("double ~"quoted~" and \'single\'");'),
    js("t('escapes ~t ~n ~r ~b ~f ~v ~0 ~~ ~' ~x41 ~u0042 ~u{1F600} ~q ~$');"),
    js("t('a line ~\ncontinued');"),
    js('t(`a template: ~` ~${ $ { } kept`);'),
    't(`two\nlines, CR LF\r\nand CR\rtoo`);',
    js('t(String.raw`C:~users~new~x ~u{ ~` and ~${} a\r\nline`);'),
    js("t('joined ' + \"with \" + `plus` + String.raw`~d`, x);"),
    "t ('spaced');",
    "t(\n  'on its own line');",
    "const q = a / t('after a division') / 2;",
    js("if (/t~(/.test(s)) t('after a regular expression');"),
    'const s = `${t(\'inside a template\')} and ${x}`;',
  ];
  const got = tool.scan(written.join('\n'), 'fixture.js');
  assert.strictEqual(got.calls.length, written.length);
  for (const c of got.calls) assert.strictEqual(c.message, evaluate(c.source), `line ${c.line}: ${c.source}`);
  assert.strictEqual(got.calls[0].message, 'plain');
  assert.strictEqual(got.calls[6].message, js('C:~users~new~x ~u{ ~` and ~${} a\nline'));
  assert.strictEqual(got.calls[7].message, js('joined with plus~d'));

  const worked = tool.scan([
    't(x);', "t('a' + x);", 't(`a${x}`);', 't(String.raw`a${x}`);', "t(c ? 'a' : 'b');",
    't(\n  s.label\n);', "t('a'.trim(), 1);", 't();', 't(`bad ~x`);',
  ].map(js).join('\n'), 'fixture.js');
  assert.deepStrictEqual(worked.calls.map((c) => c.arg),
    ['x', "'a' + x", '`a${x}`', 'String.raw`a${x}`', "c ? 'a' : 'b'", 's.label', "'a'.trim()", '', js('`bad ~x`')]);

  const none = tool.scan([
    "x.t('a member');", "x?.t('an optional member');", 'function t(m) { return m; }', "// t('a comment')",
    "/* t('a block comment') */", "'a string saying t(\"this\")';", "/t('in a regular expression')/.test(s);",
    "`template text t('x')`;", "at('another function');", 'const t2 = 1;', "const other = require('./other'); other.t('not it');",
  ].join('\n'), 'fixture.js');
  assert.deepStrictEqual(none.calls, []);

  // t by the other names it can have: the module's .t, and t renamed.
  const named = tool.scan([
    "const i18n = require('./i18n');",
    "const { t: say } = require('../i18n');",
    'const tell = i18n.t;',
    "const { setLocale, t: speak } = i18n;",
    "i18n.t('through the module');",
    "say('renamed where it is taken');",
    "tell('renamed from the module');",
    "speak('renamed from the module, taken apart');",
    "require('./i18n').t('straight from require');",
    "i18n.setLocale('ko');",
  ].join('\n'), 'fixture.js');
  assert.deepStrictEqual(named.calls.map((c) => c.message),
    ['through the module', 'renamed where it is taken', 'renamed from the module', 'renamed from the module, taken apart', 'straight from require']);
  assert.deepStrictEqual(named.values, []);
  // Passed on as a value, t is called where its messages cannot be read.
  const values = tool.scan("const i18n = require('./i18n');\nlist.map(t);\nfn(a, i18n.t, b);\nconst { t } = i18n;\n", 'fixture.js');
  assert.deepStrictEqual(values.values.map((v) => v.line), [2, 3]);
});

test('extract tells a call made as its module loads from one made later', () => {
  const got = tool.scan([
    "const A = t('at load');",
    "const B = { x: t('in an object at load') };",
    "if (x) { t('in a block at load'); }",
    "function f() { return t('in a function'); }",
    "const g = () => t('in an arrow');",
    "const h = (a) => { return t('in an arrow body'); };",
    "class K { m() { t('in a method'); } }",
    "const o = { m() { return t('in a shorthand method'); }, n: function () { return t('in a function expression'); } };",
    "const c = (x) => (y) => t('curried'), D = t('after the arrow, at load');",
    "for await (const x of y) { t('in a for await at load'); }",
    "const G = function* () { yield t('in a generator'); };",
    "const I = { [Symbol.iterator]() { return t('in a method of a computed name'); } };",
    "switch (x) { case 1: t('in a switch at load'); }",
  ].join('\n'), 'fixture.js');
  assert.deepStrictEqual(got.calls.filter((c) => c.atLoad).map((c) => c.message),
    ['at load', 'in an object at load', 'in a block at load', 'after the arrow, at load', 'in a for await at load',
      'in a switch at load']);
});

test('extract stops at what does not end or close, saying where', () => {
  assert.throws(() => tool.scan("x;\nt('not ended);", 'bad.js'), /^Error: bad\.js:2: a string that does not end/);
  assert.throws(() => tool.scan('t(`not ended);', 'bad.js'), /bad\.js:1: a template literal that does not end/);
  assert.throws(() => tool.scan("t('a'));", 'bad.js'), /bad\.js:1: \) does not close/);
  assert.throws(() => tool.scan('function f() {', 'bad.js'), /bad\.js:1: this does not close/);
  assert.throws(() => tool.scan(js("t('~x4');"), 'bad.js'), /is no escape a string may hold/);
});

test('check passes a complete catalog, says what is wrong with the others, and the program offers the complete one', () => {
  const { dir, messages, already } = copyTree('i18n-check');
  const locDir = path.join(dir, 'src', 'locales');
  const two = messages.find((m) => holes(m) === '{0} {1}');
  const other = messages.find((m) => m !== two && holes(m) === '');
  // A made-up language: every message in brackets, one of them with its {0} and {1} the other way round.
  const pseudo = Object.fromEntries(messages.map((m) => [m, m === two ? '[{1} ... {0}]' : `[${m}]`]));
  const partial = { ...pseudo };
  delete partial[other];
  write(path.join(locDir, 'ko.json'), JSON.stringify(pseudo));
  write(path.join(locDir, 'ja.json'), JSON.stringify(partial));
  write(path.join(locDir, 'fr.json'), JSON.stringify({ ...pseudo, [two]: '[{0} only]', [other]: ' ', 'Not a message of Solarljos': '[x]' }));

  // The bundle holds the catalogs that are there, and the program read from it offers the complete
  // one. The program here is a probe beside bin/ and src/, where extract does not look.
  write(path.join(dir, 'probe.js'), [
    "'use strict';",
    "const i = require('./src/i18n');",
    `const said = [i.setLocale('ko'), i.t(${JSON.stringify(two)}, 'A', 'B'), i.setLocale('ja'), i.setLocale('fr'), i.setLocale('it')];`,
    "process.stdout.write(said.join('|'));",
    '',
  ].join('\n'));
  const built = bundle({ root: dir, entry: 'probe.js' });
  for (const id of ['src/locales/index.js', 'src/locales/messages.json', 'src/locales/ko.json', 'src/locales/ja.json', 'src/locales/fr.json']) {
    assert.ok(built.modules.includes(id), `${id} is not in the bundle`);
  }
  const file = write(path.join(dir, 'probe.cjs'), built.code);
  assert.strictEqual(execFileSync(process.execPath, [file], { encoding: 'utf8' }), 'ko|[B ... A]|en|en|en');

  // And so does the copy of the tree itself, without writing anything.
  const before = snapshot(dir);
  const copy = require(path.join(dir, 'src', 'i18n.js'));
  assert.strictEqual(copy.setLocale('ko'), 'ko');
  assert.strictEqual(copy.t(two, 'A', 'B'), '[B ... A]');
  assert.strictEqual(copy.t(other), `[${other}]`);
  assert.strictEqual(copy.setLocale('ja'), 'en');
  assert.strictEqual(copy.t(other), other);
  assert.strictEqual(copy.setLocale('fr'), 'en');
  assert.deepStrictEqual(snapshot(dir), before);

  // What the bundler would refuse, check says too: a catalog that is not JSON, one named with the
  // wrong case, and one for English.
  write(path.join(locDir, 'de.json'), '{ "Nothing found.": ');
  write(path.join(locDir, 'zh-cn.json'), JSON.stringify(pseudo));
  write(path.join(locDir, 'en.json'), '{}');
  assert.strictEqual(copy.setLocale('de'), 'en');
  const { languages, problems } = tool.check(dir);
  const row = (code) => languages.find((l) => l.code === code);
  assert.deepStrictEqual(row('ko'), {
    code: 'ko', name: '한국어', file: 'src/locales/ko.json', present: true, translated: messages.length, total: messages.length, problems: 0,
  });
  assert.deepStrictEqual([row('ja').translated, row('ja').problems], [messages.length - 1, 1]);
  assert.deepStrictEqual([row('fr').translated, row('fr').problems], [messages.length - 2, 3]);
  assert.deepStrictEqual([row('de').present, row('de').problems, row('zh-CN').present, row('it').present], [true, 1, false, false]);
  const said = problems.filter((p) => !already.includes(p)).join('\n');
  assert.match(said, /src\/locales\/ja\.json: 1 message\(s\) not translated/);
  assert.match(said, /fr\.json: .*: the translation is empty/);
  assert.match(said, /fr\.json: .*: the translation has \{0\} where the English has \{0\} \{1\}/);
  assert.match(said, /fr\.json: "Not a message of Solarljos": no such message/);
  assert.match(said, /de\.json: not JSON/);
  assert.match(said, /src\/locales\/zh-cn\.json: no language/);
  assert.match(said, /src\/locales\/en\.json: no language/);
  assert.strictEqual(problems.length - already.length, 1 + 3 + 1 + 2, said);
  copy.setLocale('en');

  const checked = run(['check'], dir);
  assert.strictEqual(checked.code, 1);
  assert.match(checked.out, new RegExp(`ko +${messages.length}/${messages.length} complete +한국어`));
  assert.match(checked.out, /it +no catalog +Italiano/);
  assert.match(checked.out, new RegExp(`\\n${problems.length} problem\\(s\\):`));
});

test('extract refuses a call it cannot account for, and writes nothing then', () => {
  const { dir, already } = copyTree('i18n-extract');
  const file = path.join(dir, 'src', 'locales', 'messages.json');
  const was = fs.readFileSync(file, 'utf8');
  assert.strictEqual(run(['extract'], dir).code, already.length ? 1 : 0);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), was);

  // A call whose message is worked out and that COMPUTED does not name; an entry of COMPUTED no
  // call has any more; a kind no table of quality.js has; and an empty message.
  write(path.join(dir, 'src', 'extra.js'), "'use strict';\nconst { t } = require('./i18n');\n\nmodule.exports = (x) => [t(x.what), t(''), x.map(t)];\n");
  const entry = tool.COMPUTED.find((e) => e.file === 'src/cli.js');
  const cli = path.join(dir, 'src', 'cli.js');
  fs.writeFileSync(cli, fs.readFileSync(cli, 'utf8').split(`t(${entry.arg})`).join('t(\'-\')'));
  write(path.join(dir, 'src', 'sources', 'zz-probe.js'), "'use strict';\n\nmodule.exports = { made: () => [{ kind: 'probe copy' }] };\n");
  const got = tool.extract(dir);
  assert.deepStrictEqual(got.problems.filter((p) => !already.includes(p)), [
    'src/extra.js:4: t is passed on as a value, so what it will be given cannot be read here; call it with the message',
    'src/extra.js:4: t(x.what) works its message out; say in COMPUTED in scripts/i18n.js which messages it can be given',
    'src/extra.js:4: t() is given an empty message',
    `scripts/i18n.js: COMPUTED has t(${entry.arg}) in src/cli.js, and no call there has it any more`,
    'src/sources/zz-probe.js:3: the kind "probe copy" is in no table of src/quality.js, which ranks every kind a copy can have; '
      + 'add it there, or to INTERNAL_KINDS in scripts/i18n.js if no copy has it',
  ]);
  const refused = run(['extract'], dir);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.out, new RegExp(`^${already.length + 5} problem\\(s\\), so src/locales/messages\\.json was not written:`));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), was);
  assert.strictEqual(run(['translate'], dir).code, 2);
});
