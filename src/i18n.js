'use strict';

// Every user-facing string goes through t(): a source's notes, a refusal's reason, errors, kind
// labels, the command line's and the server's texts. English is the source language, written out
// at the call site; t() looks it up in the catalog of the language setLocale() chose and falls
// back to the English itself. {0}, {1}... are filled from the arguments after the lookup, so a
// translation may put them in another order.
//
// The language is 'en' until setLocale() says otherwise. It is never taken from the machine --
// LANG, the system's language, Intl -- so the command line prints the same everywhere unless it
// is asked for another.
//
// A catalog is src/locales/<code>.json, a flat object from the exact English message to its
// translation, read when its language is first asked for and kept. src/locales/messages.json
// lists every message t() can be given (scripts/i18n.js extract writes it). A language is offered
// when its catalog translates every one of those messages: for any other, setLocale() keeps to
// English, so that nothing comes out half in one language and half in another because a message
// was added and not yet translated. scripts/i18n.js check says how far each catalog is, and also
// fails on a translation whose {n} are not the English's; test/i18n.test.js runs it. Nothing here
// is ever written.

const locales = require('./locales');

/** The languages, in the order they are offered: each by its code, and by its own name for itself. */
const LOCALES = Object.freeze([
  { code: 'en', name: 'English' },
  { code: 'ko', name: '한국어' },
  { code: 'ja', name: '日本語' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'ru', name: 'Русский' },
  { code: 'it', name: 'Italiano' },
  { code: 'pl', name: 'Polski' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'th', name: 'ไทย' },
  { code: 'ar', name: 'العربية' },
  { code: 'hi', name: 'हिन्दी' },
].map((l) => Object.freeze(l)));

const CODES = new Map(LOCALES.map((l) => [l.code.toLowerCase(), l.code]));

let current = 'en';
let table = null;
let from = locales;
const loaded = new Map();

/**
 * The code in LOCALES a language tag stands for, or null. The case does not count, _ is taken
 * for -, and a POSIX tail such as .UTF-8 or @euro is dropped. Then:
 *
 *   zh with Hans, whatever its region                      zh-CN
 *   zh with Hant, or of TW, HK or MO                       zh-TW
 *   any other zh: zh, zh-CN, zh-SG, ...                    zh-CN
 *   pt, pt-PT, pt-BR, any pt                               pt-BR
 *   any other tag: its language, es-419 es, ko-KR ko ...   that code, when LOCALES has it
 */
function normalize(tag) {
  if (typeof tag !== 'string') return null;
  const parts = tag.trim().toLowerCase().split(/[.@]/)[0].split(/[-_]/);
  const lang = parts[0];
  if (lang === 'zh') {
    if (parts.includes('hans')) return 'zh-CN';
    if (parts.some((p) => p === 'hant' || p === 'tw' || p === 'hk' || p === 'mo')) return 'zh-TW';
    return 'zh-CN';
  }
  if (lang === 'pt') return 'pt-BR';
  return CODES.get(lang) || null;
}

/** A language's translations when its catalog has every message, null when not. Read once. */
function catalog(code) {
  if (!loaded.has(code)) {
    const found = from.catalog(code);
    const complete = !!found && typeof found === 'object' && Object.keys(from.messages())
      .every((m) => Object.hasOwn(found, m) && typeof found[m] === 'string' && found[m].trim() !== '');
    loaded.set(code, complete ? new Map(Object.entries(found)) : null);
  }
  return loaded.get(code);
}

/**
 * Sets the language t() speaks, and returns the code it now speaks: the one asked for as
 * normalize() reads it, or 'en' when that is no language of LOCALES, or its catalog is not there
 * or does not translate every message.
 */
function setLocale(code) {
  const wanted = normalize(code);
  const messages = wanted && wanted !== 'en' ? catalog(wanted) : null;
  current = messages ? wanted : 'en';
  table = messages;
  return current;
}

/** The code t() speaks now. */
function getLocale() {
  return current;
}

/**
 * The language of LOCALES a list of preferences asks for first: navigator.languages, or the
 * entries of an Accept-Language header, which may also be given whole as its text. An entry's
 * q= weight orders it, as in the header, and q=0 rules it out; '*' and tags of no language here
 * are passed over. 'en' when none is left. It says what was asked for, whether that language's
 * catalog is complete or not: setLocale() then says whether it is offered.
 */
function matchLocale(prefs) {
  const list = typeof prefs === 'string' ? prefs.split(',') : Array.isArray(prefs) ? prefs : [];
  const ranked = [];
  list.forEach((entry, i) => {
    if (typeof entry !== 'string') return;
    const [tag, ...params] = entry.split(';');
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(p);
      if (m && Number.isFinite(Number(m[1]))) q = Number(m[1]);
    }
    if (q > 0) ranked.push({ tag, q, i });
  });
  ranked.sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of ranked) {
    const code = normalize(tag);
    if (code) return code;
  }
  return 'en';
}

function t(message, ...args) {
  const text = (table && table.get(message)) || message;
  return text.replace(/\{(\d+)\}/g, (whole, i) => (i < args.length ? String(args[i]) : whole));
}

/**
 * For tests: reads catalogs through `source`, { catalog(code), messages() } as src/locales has
 * them, from now on -- src/locales itself when left out -- forgets those read so far, and goes
 * back to English.
 */
function readFrom(source = locales) {
  from = source;
  loaded.clear();
  setLocale('en');
}

module.exports = { t, setLocale, getLocale, matchLocale, LOCALES, _internal: { normalize, readFrom } };
