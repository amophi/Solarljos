'use strict';

// The messages src/i18n.js t() is given, and the catalogs that translate them.
//
//   node scripts/i18n.js extract   writes src/locales/messages.json, and says how big the job is
//   node scripts/i18n.js check     checks every catalog in src/locales, and says how far each is
//
// messages.json is one object: every message t() can be given, exactly as the English is
// written, sorted, each with the files it is written in, one message to a line. A catalog,
// src/locales/<code>.json for a code of i18n.js LOCALES other than 'en', is one object as well,
// from each of those messages to its translation, which may put {0}, {1}... in any order:
//
//   {
//     "Nothing found.": "<the translation>",
//     "Restored {0} to {1}": "<the translation, with {1} and {0} where the language wants them>"
//   }
//
// check fails on a catalog with a message messages.json does not have, or without one it has, or
// with a translation that is empty or whose {n} are not the English's; on a file there that no
// language is named (the case counts: zh-cn.json would open on Windows and not in the bundle);
// and on a messages.json that is not what extract would write now. A catalog that is not there
// is no failure: that language is not offered yet (i18n.js).
//
// How the messages are found. Every .js file below bin/ and src/ is read as JavaScript tokens,
// but the page's, below src/gui/ui, which has string tables of its own (strings.js). So t( in a
// comment, a string or a regular expression is not taken for a call, and a string is read as
// JavaScript reads it: its escapes and line continuations, a template literal's line ends as \n
// whatever the file has, String.raw's backslashes as written. A call is t( -- or t( by a name it
// is given, const { t: say } = require('./i18n'), or i18n.t( of the module required -- where t is
// neither another object's (x.t) nor being declared (function t). Its message is its first
// argument when that is written out: a string, a template literal without ${}, String.raw`...`,
// or several of these joined with +. Any other first argument is looked up in COMPUTED below, by
// its file and its text, which names where the messages it can be given come from; extract stops
// at one that is not there, at an entry that no call has any more, and at t passed on as a value,
// .map(t), whose messages cannot be read where it is; and writes nothing then. Every message
// taken from such a table must still be written in the file it is said to come from.
//
// Kinds. Every kind of copy is in a table of src/quality.js, which ranks it; the kinds are taken
// from there. As a check on that, a string given to a kind below src/sources and src/lib --
// { kind: '...' }, x.kind = '...', a KIND_... constant, either side of a ?: -- must be one of them,
// or one of INTERNAL_KINDS, which name something other than a copy and are never shown.
//
// Calls made as a module loads. A t() that runs when its module is loaded -- one not inside any
// function -- keeps the language of that moment, so a later setLocale() does not reach it.
// extract lists them, and test/i18n.test.js fails on one. A default parameter, and a function
// called as the module loads, are not seen for what they are.
//
// Measured on Windows 11 with Node 22.13 and 24.20, on 0.4.0's tree: 35 files, 900,000
// characters, read as tokens in 60 ms (170 ms the first time), and extract whole in 130 to 290
// ms; 664 calls, 18 of them working their message out, and 643 messages. The message of each of
// the other 646 reads as Node reads it (test/i18n.test.js has Node evaluate every one). With t()
// recording what it was given, the whole test suite gave it 437 of the messages and nothing
// else, but for two labels the tests make up. Loading every module ran no t() at all.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOCALES_DIR = 'src/locales';
const MESSAGES = `${LOCALES_DIR}/messages.json`;
const FOLDERS = ['bin', 'src'];
const PAGE = 'src/gui/ui';
// A message of this many characters or more, or of more than one line, is counted as long: a
// help text or an explanation, which takes a translator longer than its size says.
const LONG = 120;

const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The calls whose message is worked out, by their file and the text of their first argument, and
// the table in FROM the messages come from.
const COMPUTED = [
  // A copy's kind.
  { file: 'src/cli.js', arg: 'c.kind', from: 'kinds' },
  { file: 'src/cli.js', arg: 'kind', from: 'kinds' },
  { file: 'src/gui/server.js', arg: 'c.kind', from: 'kinds' },
  { file: 'src/gui/server.js', arg: 'kind', from: 'kinds' },
  // A source's label, as search.js's perSource, describeAll(), freezeAll() and progress events
  // carry it and index.js's `sources` list it. A source that could not be loaded is labelled with
  // its id (search.js source()), and a label missing is replaced by the id: an id is no message,
  // and t() gives it back as it is.
  { file: 'src/cli.js', arg: 's.label', from: 'labels' },
  { file: 'src/cli.js', arg: 'g.label', from: 'labels' },
  { file: 'src/gui/server.js', arg: 's.label', from: 'labels' },
  { file: 'src/gui/server.js', arg: 'g.label', from: 'labels' },
  { file: 'src/gui/server.js', arg: 'e.label', from: 'labels' },
  { file: 'src/gui/server.js', arg: 'String(e.label || e.id)', from: 'labels' },
  { file: 'src/gui/server.js', arg: 'String(s.label || s.id)', from: 'labels' },
  { file: 'src/gui/server.js', arg: 'labels.get(id) || id', from: 'labels' },
  // A copy's state.
  { file: 'src/cli.js', arg: "c.state || '-'", from: 'states' },
];

// A copy's state as search.js's stateChecker() gives it: its path exists, is gone, or the copy
// kept no content; '' when that cannot be told, which cli.js shows as '-'.
const STATES = [
  { message: 'exists', file: 'src/search.js' },
  { message: 'deleted', file: 'src/search.js' },
  { message: 'no content', file: 'src/search.js' },
  { message: '-', file: 'src/cli.js' },
];

const FROM = {
  /** Every kind src/quality.js ranks or flags. */
  kinds: (root) => {
    const q = require(path.join(root, 'src', 'quality.js'));
    return [...Object.keys(q.FIDELITY), ...q.INEXACT, ...q.UNVERIFIED, ...q.DERIVED]
      .map((message) => ({ message, file: 'src/quality.js' }));
  },
  /** Every source's label, from the source's own file. */
  labels: (root) => {
    const byId = new Map();
    for (const name of fs.readdirSync(path.join(root, 'src', 'sources')).filter((n) => n.endsWith('.js')).sort(ordinal)) {
      const s = require(path.join(root, 'src', 'sources', name));
      if (s && typeof s.id === 'string') byId.set(s.id, `src/sources/${name}`);
    }
    return require(path.join(root, 'src', 'search.js')).SOURCES.map((s) => {
      if (s.broken) throw new Error(`the source ${s.id} could not be loaded, so its label is not known: ${s.broken}`);
      if (!byId.has(s.id) || typeof s.label !== 'string') throw new Error(`the source ${s.id} has no label in a file of src/sources`);
      return { message: s.label, file: byId.get(s.id) };
    });
  },
  states: () => STATES,
};

// The kinds below src/sources and src/lib that are no copy's, each with where it is from: they
// name something else, and are never shown.
const INTERNAL_KINDS = new Set([
  'drive', 'device', 'image', // removable.js: what a place given is, a drive, a device or a disk image
  'file', 'root', 'other', // lib/shelllink.js: what a shortcut's target is
  'file id', 'hash', 'none', 'shell', // lib/thumbcache.js: what a cache entry is keyed by
  'cache', 'custom list', 'jump list', 'recent', 'shortcut', // thumbcache.js: where a link to a picture was read
  'big', 'changed', // hancom.js: why an autosave was not taken
]);

// ---- reading JavaScript ----

// After these words a / begins a regular expression; after any other word, a number, a string,
// or ) ] ++ --, it divides. After } it is taken to begin one, as after a block it does.
const BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await']);
const PUNCTUATORS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=',
  '<=', '>=', '&&', '||', '??', '++', '--', '+=', '-=', '*=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
const WORD = /(?:[\p{ID_Start}$_]|\\u[\da-fA-F]{4})(?:[\p{ID_Continue}$\p{Join_Control}]|\\u[\da-fA-F]{4})*/uy;
const PRIVATE = /#[\p{ID_Start}$_][\p{ID_Continue}$\p{Join_Control}]*/uy;
// The line ends of JavaScript besides \n and \r, which a line comment ends at and a backslash in a
// string may continue.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NUMBER = /(?:0[xXoObB][\da-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/y;
const SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' };

/**
 * The tokens of a script: { type, value, start, end, line }, where type is 'word', 'punct',
 * 'number', 'string' (value: the string), 'regex', or, for a template literal, 'template' when it
 * has no ${} and otherwise 'template-head', 'template-middle' and 'template-tail' around the
 * tokens of each ${}; each has `cooked`, its text as a string, and `raw`, as String.raw gives it.
 * Comments and white space are left out. Throws on what does not end.
 */
function lex(text, file = '<text>') {
  const tokens = [];
  const len = text.length;
  const lineStarts = [0];
  for (let j = 0; j < len; j++) if (text[j] === '\n') lineStarts.push(j + 1);
  const lineOf = (at) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const fail = (at, why) => {
    throw new Error(`${file}:${lineOf(at)}: ${why}`);
  };
  const push = (type, start, end, more) => tokens.push({ type, start, end, line: lineOf(start), ...more });
  // For each ${ being read, how many { are open inside it.
  const open = [];

  // A backslash and what follows: what it stands for, or null for no escape at all -- \x or \u
  // without their digits, an octal one -- which only a tagged template, such as String.raw's,
  // may hold, and then only its raw text counts. C:\users in String.raw`` is one.
  const escape = (at) => {
    const n = text[at + 1];
    const none = { cooked: null, end: at + 2 };
    if (n === undefined) fail(at, 'a string that does not end');
    if (Object.hasOwn(SIMPLE_ESCAPES, n)) return { cooked: SIMPLE_ESCAPES[n], end: at + 2 };
    if (n === '\r') return { cooked: '', end: text[at + 2] === '\n' ? at + 3 : at + 2 };
    if (n === '\n' || n === LS || n === PS) return { cooked: '', end: at + 2 };
    if (n === 'x') {
      const hex = text.slice(at + 2, at + 4);
      return /^[\da-fA-F]{2}$/.test(hex) ? { cooked: String.fromCharCode(parseInt(hex, 16)), end: at + 4 } : none;
    }
    if (n === 'u' && text[at + 2] === '{') {
      const close = text.indexOf('}', at + 3);
      const hex = close < 0 ? '' : text.slice(at + 3, close);
      if (!/^[\da-fA-F]+$/.test(hex) || parseInt(hex, 16) > 0x10ffff) return none;
      return { cooked: String.fromCodePoint(parseInt(hex, 16)), end: close + 1 };
    }
    if (n === 'u') {
      const hex = text.slice(at + 2, at + 6);
      return /^[\da-fA-F]{4}$/.test(hex) ? { cooked: String.fromCharCode(parseInt(hex, 16)), end: at + 6 } : none;
    }
    if (n === '0' && !/\d/.test(text[at + 2] || '')) return { cooked: '\0', end: at + 2 };
    if (/\d/.test(n)) return none;
    const ch = String.fromCodePoint(text.codePointAt(at + 1));
    return { cooked: ch, end: at + 1 + ch.length };
  };

  const string = (start) => {
    const quote = text[start];
    let value = '';
    for (let j = start + 1; ;) {
      const ch = text[j];
      if (ch === undefined || ch === '\n' || ch === '\r') fail(start, 'a string that does not end on its line');
      if (ch === quote) {
        push('string', start, j + 1, { value });
        return j + 1;
      }
      if (ch === '\\') {
        const e = escape(j);
        if (e.cooked === null) fail(j, `${text.slice(j, j + 2)} is no escape a string may hold`);
        value += e.cooked;
        j = e.end;
      } else {
        value += ch;
        j++;
      }
    }
  };

  // From just after ` or the } that ends a ${, to the ` or ${ that ends this part. `cooked` is
  // null when it holds what is no escape.
  const template = (start, from, first) => {
    let cooked = '';
    let raw = '';
    let escapes = true;
    for (let j = from; ;) {
      const ch = text[j];
      if (ch === undefined) fail(start, 'a template literal that does not end');
      if (ch === '`') {
        push(first ? 'template' : 'template-tail', start, j + 1, { cooked: escapes ? cooked : null, raw });
        return j + 1;
      }
      if (ch === '$' && text[j + 1] === '{') {
        push(first ? 'template-head' : 'template-middle', start, j + 2, { cooked: escapes ? cooked : null, raw });
        open.push(0);
        return j + 2;
      }
      if (ch === '\\') {
        const e = escape(j);
        if (e.cooked === null) escapes = false;
        else cooked += e.cooked;
        raw += text.slice(j, e.end).replace(/\r\n?/g, '\n');
        j = e.end;
      } else if (ch === '\r') {
        cooked += '\n';
        raw += '\n';
        j += text[j + 1] === '\n' ? 2 : 1;
      } else {
        cooked += ch;
        raw += ch;
        j++;
      }
    }
  };

  const regexAllowed = () => {
    const p = tokens[tokens.length - 1];
    if (!p) return true;
    if (p.type === 'word') return BEFORE_REGEX.has(p.value);
    if (p.type === 'punct') return ![')', ']', '++', '--'].includes(p.value);
    return p.type === 'template-head' || p.type === 'template-middle';
  };

  const regex = (start) => {
    let inClass = false;
    let j = start + 1;
    for (; ; j++) {
      const ch = text[j];
      if (ch === undefined || ch === '\n' || ch === '\r') fail(start, 'a regular expression that does not end on its line');
      if (ch === '\\') j++;
      else if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) break;
    }
    j++;
    while (j < len && /[A-Za-z]/.test(text[j])) j++;
    push('regex', start, j, { value: text.slice(start, j) });
    return j;
  };

  const sticky = (re, at) => {
    re.lastIndex = at;
    const m = re.exec(text);
    return m ? m[0] : null;
  };

  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (text.startsWith('#!', i)) {
    const nl = text.indexOf('\n', i);
    i = nl < 0 ? len : nl;
  }
  while (i < len) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < len && !['\n', '\r', LS, PS].includes(text[i])) i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) fail(i, 'a comment that does not end');
      i = end + 2;
    } else if (c === '\'' || c === '"') {
      i = string(i);
    } else if (c === '`') {
      i = template(i, i + 1, true);
    } else if (c === '}' && open.length && open[open.length - 1] === 0) {
      open.pop();
      i = template(i, i + 1, false);
    } else if (c === '/' && regexAllowed()) {
      i = regex(i);
    } else if (/\d/.test(c) || (c === '.' && /\d/.test(text[i + 1] || ''))) {
      const n = sticky(NUMBER, i);
      push('number', i, i + n.length, { value: n });
      i += n.length;
    } else if (sticky(WORD, i) !== null) {
      const w = sticky(WORD, i);
      push('word', i, i + w.length, { value: w });
      i += w.length;
    } else if (c === '#' && sticky(PRIVATE, i) !== null) {
      const w = sticky(PRIVATE, i);
      push('word', i, i + w.length, { value: w });
      i += w.length;
    } else {
      let p = PUNCTUATORS.find((q) => text.startsWith(q, i)) || c;
      if (c === '?' && text[i + 1] === '.' && !/\d/.test(text[i + 2] || '')) p = '?.';
      if (c === '/' && text[i + 1] === '=') p = '/=';
      if (open.length && p === '{') open[open.length - 1]++;
      if (open.length && p === '}') open[open.length - 1]--;
      push('punct', i, i + p.length, { value: p });
      i += p.length;
    }
  }
  if (open.length) fail(len, 'a template literal that does not end');
  return tokens;
}

const isPunct = (tok, value) => !!tok && tok.type === 'punct' && tok.value === value;
const isWord = (tok, value) => !!tok && tok.type === 'word' && tok.value === value;
const opens = (tok) => tok.type === 'template-head' || (tok.type === 'punct' && '([{'.includes(tok.value));
const closes = (tok) => tok.type === 'template-tail' || (tok.type === 'punct' && ')]}'.includes(tok.value));
const PAIRS = { '(': ')', '[': ']', '{': '}' };
// ) { opens a function's body when a word came before its ( -- function, a function's name, a
// method's -- but these; or the * of function* (), or the ] of a method named [like.this]().
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'await']);
const opensBody = (before) => !!before && ((before.type === 'word' && !CONTROL.has(before.value))
  || isPunct(before, '*') || isPunct(before, ']'));
const KIND_NAME = /^(kind|KIND(_[A-Z]+)*)$/;

/**
 * Where the expression starting at token `from` ends: the index of the first , ; ) ] or } outside
 * any bracket it opens, or of the end.
 */
function expressionEnd(tokens, from, stops = [',', ';', ')', ']', '}']) {
  let depth = 0;
  let j = from;
  for (; j < tokens.length; j++) {
    const tok = tokens[j];
    if (depth === 0 && tok.type === 'punct' && stops.includes(tok.value)) break;
    if (depth === 0 && tok.type === 'template-tail') break;
    if (opens(tok)) depth++;
    else if (closes(tok)) depth--;
  }
  return j;
}

/**
 * What a call's first argument writes out, { message, source } with the source text it is read
 * from; or, when it writes out no message, { arg }, the text of the argument with its white space
 * made one space.
 */
function firstArgument(tokens, from, text) {
  let message = '';
  for (let j = from; ;) {
    const tok = tokens[j];
    if (tok && tok.type === 'string') {
      message += tok.value;
      j++;
    } else if (tok && tok.type === 'template' && tok.cooked !== null) {
      message += tok.cooked;
      j++;
    } else if (isWord(tok, 'String') && isPunct(tokens[j + 1], '.') && isWord(tokens[j + 2], 'raw')
      && tokens[j + 3] && tokens[j + 3].type === 'template') {
      message += tokens[j + 3].raw;
      j += 4;
    } else {
      break;
    }
    if (isPunct(tokens[j], '+')) {
      j++;
      continue;
    }
    if (isPunct(tokens[j], ',') || isPunct(tokens[j], ')')) return { message, source: text.slice(tokens[from].start, tokens[j - 1].end) };
    break;
  }
  const end = expressionEnd(tokens, from, [',', ')']);
  return { arg: end > from ? text.slice(tokens[from].start, tokens[end - 1].end).replace(/\s+/g, ' ') : '' };
}

/** The strings an expression gives when it is one, or the arms of a ?: that are: 'a', c ? 'a' : 'b'. */
function givenStrings(tokens, from, end) {
  if (end === from + 1 && tokens[from].type === 'string') return [tokens[from]];
  const out = [];
  let depth = 0;
  for (let j = from; j < end; j++) {
    const tok = tokens[j];
    if (opens(tok)) depth++;
    else if (closes(tok)) depth--;
    else if (depth === 0 && tok.type === 'string' && (isPunct(tokens[j - 1], '?') || isPunct(tokens[j - 1], ':'))
      && (j + 1 === end || isPunct(tokens[j + 1], ':'))) out.push(tok);
  }
  return out;
}

const I18N = /(^|\/)i18n(\.js)?$/;
/** Whether the tokens from `j` are require('./i18n'), from any folder. */
const requiresI18n = (tokens, j) => isWord(tokens[j], 'require') && isPunct(tokens[j + 1], '(')
  && !!tokens[j + 2] && tokens[j + 2].type === 'string' && I18N.test(tokens[j + 2].value) && isPunct(tokens[j + 3], ')');

/**
 * The names t() goes by in a file: t, and what it is renamed to -- const { t: say } =
 * require('./i18n'), const say = i18n.t -- as `names`; and in `modules`, those the module itself
 * is given, const i18n = require('./i18n'), whose .t( is a call as well.
 */
function namesOfT(tokens) {
  const modules = new Set();
  const names = new Set(['t']);
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].type === 'word' && isPunct(tokens[k + 1], '=') && requiresI18n(tokens, k + 2)
      && !isPunct(tokens[k + 6], '.')) modules.add(tokens[k].value);
  }
  const isModule = (j) => (requiresI18n(tokens, j) ? j + 4 : tokens[j] && tokens[j].type === 'word' && modules.has(tokens[j].value) ? j + 1 : -1);
  for (let k = 0; k < tokens.length; k++) {
    if (!isPunct(tokens[k + 1], '=')) continue;
    const after = isModule(k + 2);
    if (after < 0) continue;
    if (tokens[k].type === 'word' && isPunct(tokens[after], '.') && isWord(tokens[after + 1], 't') && !isPunct(tokens[after + 2], '(')) {
      names.add(tokens[k].value);
    } else if (isPunct(tokens[k], '}') && !isPunct(tokens[after], '.')) {
      let depth = 0;
      for (let j = k; j >= 0; j--) {
        if (closes(tokens[j])) depth++;
        else if (opens(tokens[j]) && --depth === 0) break;
        else if (depth === 1 && isWord(tokens[j], 't') && isPunct(tokens[j + 1], ':') && tokens[j + 2].type === 'word') names.add(tokens[j + 2].value);
      }
    }
  }
  return { names, modules };
}

/**
 * What one file gives t(): { calls, kinds, strings, values }. Each call is { line, atLoad } with
 * either `message`, written out, or `arg`, the text of a first argument that is not; `atLoad` when
 * no function holds it. A call is t( by any of its names (namesOfT), or i18n.t( of the module.
 * `kinds` are the strings given to a kind, { line, value }; `strings`, the value of every string
 * and template literal in the file; `values`, the lines where t is passed on as a value, .map(t),
 * to be called with messages no one can read here.
 */
function scan(text, file = '<text>') {
  const tokens = lex(text, file);
  const { names, modules } = namesOfT(tokens);
  const calls = [];
  const kinds = [];
  const strings = new Set();
  const values = [];
  const frames = [];
  // The depth of frames at which each arrow function whose body is an expression began.
  const arrows = [];
  let bodies = 0;
  let closed = null;
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.type === 'string') strings.add(tok.value);
    if (tok.type === 'template') strings.add(tok.cooked);
    if (opens(tok)) {
      let body = false;
      if (isPunct(tok, '{')) {
        const before = tokens[k - 1];
        body = isPunct(before, '=>') || (isPunct(before, ')') && !!closed && closed.at === k - 1 && opensBody(closed.before));
      }
      frames.push({ tok, before: tokens[k - 1], body });
      if (body) bodies++;
    } else if (closes(tok)) {
      const f = frames.pop();
      const want = f && (f.tok.type === 'template-head' ? 'template-tail' : PAIRS[f.tok.value]);
      if (!f || (tok.type === 'template-tail' ? want !== 'template-tail' : want !== tok.value)) {
        throw new Error(`${file}:${tok.line}: ${tok.type === 'template-tail' ? '}' : tok.value} does not close what is open there`);
      }
      if (f.body) bodies--;
      if (isPunct(tok, ')')) closed = { at: k, before: f.before };
      while (arrows.length && arrows[arrows.length - 1] > frames.length) arrows.pop();
    } else if (isPunct(tok, '=>') && !isPunct(tokens[k + 1], '{')) {
      arrows.push(frames.length);
    } else if (isPunct(tok, ',') || isPunct(tok, ';')) {
      while (arrows.length && arrows[arrows.length - 1] === frames.length) arrows.pop();
    }

    const member = isPunct(tokens[k - 1], '.') || isPunct(tokens[k - 1], '?.');
    const atLoad = bodies === 0 && arrows.length === 0;
    if (tok.type === 'word' && names.has(tok.value) && !member && !isWord(tokens[k - 1], 'function')) {
      if (isPunct(tokens[k + 1], '(')) calls.push({ line: tok.line, atLoad, ...firstArgument(tokens, k + 2, text) });
      else if (inArguments(frames, tokens, k)) values.push({ line: tok.line });
    }
    if (tok.type === 'word' && !member && (modules.has(tok.value) || requiresI18n(tokens, k))) {
      const at = modules.has(tok.value) ? k + 1 : k + 4;
      if (isPunct(tokens[at], '.') && isWord(tokens[at + 1], 't')) {
        if (isPunct(tokens[at + 2], '(')) calls.push({ line: tok.line, atLoad, ...firstArgument(tokens, at + 3, text) });
        else if (inArguments(frames, tokens, at + 1)) values.push({ line: tok.line });
      }
    }
    // kind: as a property, after { or , -- not the : of a ?: -- and kind = as anything assigned.
    const property = isPunct(tokens[k + 1], ':') && (isPunct(tokens[k - 1], '{') || isPunct(tokens[k - 1], ','));
    if (tok.type === 'word' && KIND_NAME.test(tok.value) && (property || isPunct(tokens[k + 1], '='))) {
      const end = expressionEnd(tokens, k + 2);
      for (const s of givenStrings(tokens, k + 2, end)) kinds.push({ line: s.line, value: s.value });
    }
  }
  if (frames.length) throw new Error(`${file}:${frames[frames.length - 1].tok.line}: this does not close`);
  return { calls, kinds, strings, values };
}

/** Whether token `k` is a whole argument of a call, or a parameter, as the innermost ( holds it. */
function inArguments(frames, tokens, k) {
  const f = frames[frames.length - 1];
  const end = (j) => isPunct(tokens[j], ',') || isPunct(tokens[j], ')');
  const start = isPunct(tokens[k - 1], '(') || isPunct(tokens[k - 1], ',')
    || (isPunct(tokens[k - 1], '.') && (isPunct(tokens[k - 3], '(') || isPunct(tokens[k - 3], ',')));
  return !!f && isPunct(f.tok, '(') && start && end(k + 1);
}

// ---- the messages ----

/** Every .js file below bin/ and src/ but the page's, by its path from the root, with /. */
function jsFiles(root) {
  const out = [];
  const walk = (rel) => {
    const entries = fs.readdirSync(path.join(root, ...rel.split('/')), { withFileTypes: true });
    for (const e of entries.sort((a, b) => ordinal(a.name, b.name))) {
      const at = `${rel}/${e.name}`;
      if (e.isDirectory() && at !== PAGE) walk(at);
      else if (e.isFile() && e.name.endsWith('.js')) out.push(at);
    }
  };
  for (const f of FOLDERS) if (fs.existsSync(path.join(root, f))) walk(f);
  return out;
}

/**
 * Every message t() can be given, with where it is written, and what says so.
 * @returns {{ messages: Map<string, string[]>, files: string[], computed: object[], atLoad: object[],
 *   problems: string[] }} `messages` in order, each with its files in order; `computed`, each call
 *   whose message is worked out, with its COMPUTED entry; `atLoad`, the calls made as a module loads
 */
function extract(root = ROOT) {
  const found = new Map();
  const add = (message, file) => {
    if (!found.has(message)) found.set(message, new Set());
    found.get(message).add(file);
  };
  const problems = [];
  const computed = [];
  const atLoad = [];
  const kinds = [];
  const strings = new Map();
  const files = jsFiles(root);
  for (const file of files) {
    let got;
    try {
      got = scan(fs.readFileSync(path.join(root, ...file.split('/')), 'utf8'), file);
    } catch (e) {
      problems.push(e.message);
      continue;
    }
    strings.set(file, got.strings);
    if (file.startsWith('src/sources/') || file.startsWith('src/lib/')) kinds.push(...got.kinds.map((k) => ({ file, ...k })));
    for (const v of got.values) {
      problems.push(`${file}:${v.line}: t is passed on as a value, so what it will be given cannot be read here; call it with the message`);
    }
    for (const c of got.calls) {
      if (c.atLoad) atLoad.push({ file, ...c });
      if (c.message !== undefined) {
        if (c.message.trim() === '') problems.push(`${file}:${c.line}: t() is given an empty message`);
        else add(c.message, file);
        continue;
      }
      const entry = COMPUTED.find((e) => e.file === file && e.arg === c.arg);
      if (entry) computed.push({ file, line: c.line, arg: c.arg, entry });
      else problems.push(`${file}:${c.line}: t(${c.arg}) works its message out; say in COMPUTED in scripts/i18n.js which messages it can be given`);
    }
  }
  for (const e of COMPUTED) {
    if (!computed.some((c) => c.entry === e)) {
      problems.push(`scripts/i18n.js: COMPUTED has t(${e.arg}) in ${e.file}, and no call there has it any more`);
    }
  }
  const taken = new Map();
  for (const name of Object.keys(FROM)) {
    try {
      taken.set(name, FROM[name](root));
    } catch (e) {
      problems.push(`scripts/i18n.js: the ${name} cannot be listed: ${e.message}`);
      taken.set(name, []);
    }
  }
  for (const name of new Set(computed.map((c) => c.entry.from))) {
    for (const { message, file } of taken.get(name)) {
      if (!strings.has(file) || !strings.get(file).has(message)) {
        problems.push(`scripts/i18n.js: the ${name} have ${JSON.stringify(message)}, which ${file} no longer says`);
      }
      add(message, file);
    }
  }
  const known = new Set(taken.get('kinds').map((k) => k.message));
  for (const k of kinds) {
    if (!known.has(k.value) && !INTERNAL_KINDS.has(k.value)) {
      problems.push(`${k.file}:${k.line}: the kind ${JSON.stringify(k.value)} is in no table of src/quality.js, `
        + 'which ranks every kind a copy can have; add it there, or to INTERNAL_KINDS in scripts/i18n.js if no copy has it');
    }
  }
  const messages = new Map([...found.keys()].sort(ordinal).map((m) => [m, [...found.get(m)].sort(ordinal)]));
  return { messages, files, computed, atLoad, problems };
}

/** messages.json's text: one message to a line. */
function serialize(messages) {
  const lines = [...messages].map(([m, files]) => `  ${JSON.stringify(m)}: ${JSON.stringify(files)}`);
  return lines.length ? `{\n${lines.join(',\n')}\n}\n` : '{}\n';
}

/** How big the translation is, by the file each message is written in, and in all. */
function measure(messages) {
  const count = (list) => ({
    messages: list.length,
    characters: list.reduce((n, m) => n + [...m].length, 0),
    words: list.reduce((n, m) => n + (m.match(/\S+/g) || []).length, 0),
    long: list.filter((m) => [...m].length >= LONG || m.includes('\n')).length,
  });
  const byFile = new Map();
  for (const [m, files] of messages) {
    for (const f of files) {
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push(m);
    }
  }
  return {
    files: [...byFile.keys()].sort(ordinal).map((file) => ({ file, ...count(byFile.get(file)) })),
    all: count([...messages.keys()]),
  };
}

// ---- the catalogs ----

const holes = (s) => [...new Set(s.match(/\{\d+\}/g) || [])].sort().join(' ');

/**
 * Every catalog in src/locales against the messages.
 * @returns {{ languages: { code: string, name: string, file: string, present: boolean, translated: number,
 *   total: number, problems: number }[], problems: string[] }}
 */
function check(root = ROOT) {
  const { LOCALES } = require(path.join(root, 'src', 'i18n.js'));
  const fresh = extract(root);
  const problems = [...fresh.problems];
  let written = null;
  try {
    written = fs.readFileSync(path.join(root, ...MESSAGES.split('/')), 'utf8');
  } catch (_) {
    written = null;
  }
  if (written !== serialize(fresh.messages)) {
    problems.push(`${MESSAGES} is not what extract would write now: run node scripts/i18n.js extract`);
  }
  const english = fresh.messages;
  const named = new Set(LOCALES.filter((l) => l.code !== 'en').map((l) => `${l.code}.json`));
  let present = [];
  try {
    present = fs.readdirSync(path.join(root, ...LOCALES_DIR.split('/')));
  } catch (_) {
    present = [];
  }
  for (const name of present.sort(ordinal)) {
    if (name.endsWith('.json') && name !== 'messages.json' && !named.has(name)) {
      problems.push(`${LOCALES_DIR}/${name}: no language of src/i18n.js LOCALES has this name (the case counts); `
        + 'English, the language written at the calls, has no catalog');
    }
  }
  const languages = [];
  for (const { code, name } of LOCALES) {
    if (code === 'en') continue;
    const file = `${LOCALES_DIR}/${code}.json`;
    const row = { code, name, file, present: present.includes(`${code}.json`), translated: 0, total: english.size, problems: 0 };
    languages.push(row);
    if (!row.present) continue;
    const said = [];
    let catalog;
    try {
      const text = fs.readFileSync(path.join(root, ...file.split('/')), 'utf8');
      // As require() reads it: a byte order mark first is not part of it.
      catalog = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (e) {
      said.push(`${file}: not JSON: ${e.message}`);
    }
    if (catalog !== undefined && (catalog === null || typeof catalog !== 'object' || Array.isArray(catalog))) {
      said.push(`${file}: not an object of messages`);
      catalog = undefined;
    }
    if (catalog !== undefined) {
      for (const [m, text] of Object.entries(catalog)) {
        const at = `${file}: ${JSON.stringify(m)}`;
        if (!english.has(m)) said.push(`${at}: no such message (${MESSAGES})`);
        else if (typeof text !== 'string') said.push(`${at}: the translation is not a string`);
        else if (text.trim() === '') said.push(`${at}: the translation is empty`);
        else if (holes(text) !== holes(m)) said.push(`${at}: the translation has ${holes(text) || 'no {n}'} where the English has ${holes(m) || 'none'}`);
        else row.translated++;
      }
      const missing = [...english.keys()].filter((m) => !Object.hasOwn(catalog, m));
      if (missing.length) said.push(`${file}: ${missing.length} message(s) not translated, the first ${JSON.stringify(missing[0])}`);
    }
    row.problems = said.length;
    problems.push(...said);
  }
  return { languages, problems };
}

// ---- the command ----

const group = (n) => String(n).replace(/\B(?=(\d{3})+$)/g, ',');

function main(argv, root = ROOT) {
  const print = (s = '') => process.stdout.write(s + '\n');
  const [command] = argv;
  if (command === 'extract') {
    const started = Date.now();
    const got = extract(root);
    if (got.problems.length) {
      print(`${got.problems.length} problem(s), so ${MESSAGES} was not written:`);
      for (const p of got.problems) print(`  ${p}`);
      return 1;
    }
    const out = path.join(root, ...MESSAGES.split('/'));
    const text = serialize(got.messages);
    let before = null;
    try {
      before = fs.readFileSync(out, 'utf8');
    } catch (_) {
      before = null;
    }
    if (before !== text) fs.writeFileSync(out, text);
    const size = measure(got.messages);
    print(`${got.messages.size} messages from ${got.files.length} files -> ${MESSAGES}`
      + ` (${before === text ? 'unchanged' : 'written'}, ${Date.now() - started} ms)`);
    print('');
    const width = Math.max(...size.files.map((f) => f.file.length), 5);
    print(`  ${'file'.padEnd(width)}  messages  characters   words  long`);
    for (const f of [...size.files, { file: '(all)', ...size.all }]) {
      print(`  ${f.file.padEnd(width)}  ${String(f.messages).padStart(8)}  ${group(f.characters).padStart(10)}  `
        + `${group(f.words).padStart(6)}  ${String(f.long).padStart(4)}`);
    }
    print(`  A message is long at ${LONG} characters or more, or on more than one line; one written in`);
    print('  several files counts in each, and once in (all).');
    print('');
    print(`${got.computed.length} call(s) work their message out:`);
    for (const c of got.computed) print(`  ${c.file}:${c.line}  t(${c.arg})  -> the ${c.entry.from}`);
    if (got.atLoad.length) {
      print('');
      print(`${got.atLoad.length} call(s) run as their module loads, and keep the language of that moment:`);
      for (const c of got.atLoad) print(`  ${c.file}:${c.line}  ${c.message !== undefined ? JSON.stringify(c.message.slice(0, 70)) : `t(${c.arg})`}`);
    }
    return 0;
  }
  if (command === 'check') {
    const { languages, problems } = check(root);
    const total = languages.length ? languages[0].total : 0;
    print(`${total} messages in ${MESSAGES}`);
    print('');
    for (const l of languages) {
      const state = !l.present ? 'no catalog' : `${l.translated}/${l.total}${l.problems ? `, ${l.problems} problem(s)` : ' complete'}`;
      print(`  ${l.code.padEnd(6)} ${state.padEnd(28)} ${l.name}`);
    }
    print('');
    if (!problems.length) {
      print(languages.some((l) => l.present) ? 'Every catalog there is complete.' : 'No language has a catalog yet.');
      return 0;
    }
    print(`${problems.length} problem(s):`);
    for (const p of problems) print(`  ${p}`);
    return 1;
  }
  print('node scripts/i18n.js extract | check');
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { extract, check, scan, lex, jsFiles, serialize, measure, main, COMPUTED, STATES, INTERNAL_KINDS, MESSAGES, LONG };
