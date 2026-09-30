'use strict';

// The page of Solarljos's graphical front end. src/gui/server.js serves it from 127.0.0.1, with
// strings.js and style.css beside it, and answers the api/ requests it makes. Everything shown
// comes from the library through that server, and nothing is decided here that the library
// already decides: which copy stands for identical ones, what a copy is (its tier), where writing
// is refused. The page shows it in words, and does the rest of what a view needs.
//
// What the page asks the server for, all below api/ and all relative, so the page works wherever
// it is mounted:
//
//   GET  info, sources, sources/describe, drives
//   GET  events             one server-sent event stream per window, which is also how the server
//                           knows a window is still open: hello, progress, results, plan, done,
//                           failed, cancelled, restore-progress
//   POST search, plan       a search by name, content or type, or the plan of a folder: { job }
//   POST cancel             { job }
//   GET  job/<id>/items     a job's results again, a page at a time, after a reload
//   GET  copy/<uid>         a copy's bytes, in ranges; copy/<uid>/about says what they are, and
//                           copy/<uid>/thumb gives a JPEG's own small picture, for the grid
//   POST check-folder, restore, rebuild, quit, and bye as a beacon when the page goes away
//   POST lang               { lang }: the language chosen here, which the library then speaks too
//
// and, as one of the page's own files beside this one, lang/<code>.json: a language's table.
//
// Each part of the page -- the start, Find a file, Photos and videos, Bring back a folder, What is
// searched, Help -- keeps its views when another part is shown: hidden, a form as it was typed,
// results as they were filtered, sorted, opened, paged and scrolled, and a search under way still
// taking in its progress. Going back shows the part as it was left, with the focus where it was;
// a video in a view that is hidden is paused. A new search or plan replaces the view of its
// results, as it replaces the results. None of it is kept in the browser: a reload starts again
// from what the server still has.
//
// Languages. English is strings.js; another language is lang/<code>.json beside it, asked for
// when it is chosen -- strings.js says what one holds. The first language is the one the server
// was started with (--lang), else the first of the browser's that has a table here, else
// English; the picker in the frame changes it, and every view is built again in it, with what
// its form and its results held. The server is told (api/lang), so that what the library says --
// a source's notes, why a folder is refused -- comes in that language from the next search on;
// results found before keep the words they were found with, and say so.
//
// A search sends the copies it found once it is done, in batches on the event stream -- the first
// few thousand; the page fetches the rest by page (job/<id>/items) -- and the page keeps them. The
// grouping by file, the filters by date, state and folder, the months of the photo grid, the
// text and bytes of a preview and the folder suggested for a restore are all worked out here, so
// a filter turned on and off asks nothing of the server. Only-deleted and the dates are therefore
// never sent with a search: search() applies them after merging copies anyway, so they save no
// time, and left to the page they can say how many copies they hide. A folder's plan is the
// exception: which copy of each file it takes depends on them, so they go with it.
//
// What the page holds to:
//   - Nothing is fetched from anywhere else: no font, no script, no picture.
//   - It runs under a Content-Security-Policy of script-src 'self' and style-src 'self': no
//     inline script or style and no style attribute. What is set at run time -- the columns of
//     the photo grid, the depth of a tree row -- are custom properties set through the CSSOM,
//     which that allows.
//   - Names, paths, notes and text come from disk, and a file name can hold markup: git and the
//     Linux trash take any name. They are set as textContent or as an attribute's value, never
//     parsed; there is no innerHTML here.
//   - Nothing is kept in the browser: no cookie of its own, no localStorage, no sessionStorage,
//     which Chromium writes to disk. What the page knows lives in this tab and in the server's
//     memory, and a reload asks the server for the searches it still has.
//   - A copy is never downloaded. A download lands in Downloads on the system drive, past every
//     check a restore makes; restoring goes through api/restore and api/rebuild, which refuse a
//     folder a source reads from. So every video player is made without its Download item and
//     picture-in-picture (controlslist, disablepictureinpicture), the browser's own menu is not
//     opened over a picture or a video ("Save image as"), Ctrl+S does not save the page with its
//     pictures, and the server refuses a copy asked for as a page of its own. Pictures cannot be
//     dragged out either: a drop into Explorer writes a file.
//   - Every string is looked up by key with tr(), in the table of the language chosen and else in
//     English. What the library itself says -- a source's notes, why a folder was refused --
//     arrives in the language the server speaks, and is shown as it is.
//   - Right to left, for Arabic: the layout follows the page's dir, keys that move left and right
//     move on screen (logicalKey), and names and paths put into a sentence are isolated so they
//     keep their own direction.
//
// A copy's quality follows src/quality.js, and its label is always in words, never colour alone:
//
//   0 exact        the bytes that were on disk
//   1 inexact      saved, but not provably those bytes: line breaks, a BOM or the last newline;
//                  for a file read back from a card, a later file may have been written there
//   2 draft        never saved: text an editor held
//   3 unverified   read back from free space, or taken to lie in one piece: may be incomplete
//   4 derived      a smaller or re-encoded copy, such as a thumbnail: not the original
//
// The server sends the number. tierOf() also reads the library's flags, and the names the design
// notes used (near, pieced, smaller), and takes the worst it is told, so a copy is never shown as
// better than it is.

(function (root) {
  const inNode = typeof module === 'object' && !!module && !!module.exports;
  const STRINGS = inNode ? require('./strings.js') : root.SolarljosStrings || { en: {} };

  // ---- strings and formats -------------------------------------------------------------------

  let lang = 'en';
  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const EN = STRINGS.en || {};

  // The languages written right to left, by their language subtag, and the plural forms
  // Intl.PluralRules may choose.
  const RTL = new Set(['ar', 'fa', 'he', 'ur']);
  const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];

  /** The string for a key in the chosen language, else in English; undefined when neither has it. */
  function lookup(key) {
    if (own(STRINGS[lang], key)) return STRINGS[lang][key];
    return own(EN, key) ? EN[key] : undefined;
  }

  function has(key) {
    return lookup(key) !== undefined;
  }

  /**
   * The code among `codes` a language tag stands for, read as src/i18n.js reads one: the case
   * does not count, nor a POSIX tail such as .UTF-8; every Portuguese is pt-BR; Chinese is zh-TW
   * in the Hant script or in Taiwan, Hong Kong or Macau, unless its script is Hans, and zh-CN
   * otherwise; any other tag is its language, so ko-KR is ko. Null when none is.
   */
  function codeOf(tag, codes) {
    if (typeof tag !== 'string' || !tag.trim()) return null;
    const parts = tag.trim().toLowerCase().split(/[.@]/)[0].split(/[-_]/);
    let code = parts[0];
    if (code === 'zh') {
      code = parts.includes('hans') ? 'zh-cn' : parts.some((p) => ['hant', 'tw', 'hk', 'mo'].includes(p)) ? 'zh-tw' : 'zh-cn';
    } else if (code === 'pt') {
      code = 'pt-br';
    }
    return (codes || []).find((c) => String(c).toLowerCase() === code) || null;
  }

  /** The first language the browser asks for that is among `available` (the tables here by default); English otherwise. */
  function pickLanguage(wanted, available) {
    const codes = available || Object.keys(STRINGS);
    for (const w of wanted || []) {
      const c = codeOf(String(w), codes);
      if (c) return c;
    }
    return 'en';
  }

  /** Speaks `code` from now on, when its table is here; English otherwise. Returns the language spoken. */
  function setLanguage(code) {
    lang = own(STRINGS, code) ? code : 'en';
    intlCache.clear();
    return lang;
  }

  function locale() {
    return lookup('meta.locale') || 'en-GB';
  }

  /** 'rtl' for a language written right to left, as its table says; 'ltr' otherwise. */
  function textDir() {
    return lookup('meta.dir') === 'rtl' ? 'rtl' : 'ltr';
  }

  /** The names of the placeholders a string uses, in all its forms. */
  function placeholdersOf(v) {
    const out = new Set();
    for (const s of typeof v === 'string' ? [v] : Object.values(v || {})) {
      for (const m of String(s).matchAll(/\{(\w+)\}/g)) out.add(m[1]);
    }
    return out;
  }

  /**
   * The plural forms a language uses: `used`, every form a count can take; `common`, those the
   * counts 0 to 199 take, which a translation must give; and `lone`, those that stand for one
   * number alone -- English "one" is 1, Arabic "two" is 2 -- which may say that number in words
   * rather than {count}. Russian "one" is 1, 21, 31... and must say {count}. The one form only
   * large counts take is "many" in Spanish, French, Italian and Portuguese, for a million and up
   * (1 000 000 de fichiers): a translation may give it, and "other" stands in where it does not.
   */
  function pluralForms(loc) {
    let rules;
    try {
      rules = new Intl.PluralRules(loc);
    } catch (_) {
      rules = new Intl.PluralRules('en');
    }
    const seen = new Map();
    const common = new Set();
    for (let n = 0; n < 200; n++) {
      const f = rules.select(n);
      common.add(f);
      seen.set(f, (seen.get(f) || 0) + 1);
    }
    for (const n of [1e3, 1e4, 1e5, 1e6, 2e6, 1e7, 1e9]) {
      const f = rules.select(n);
      seen.set(f, (seen.get(f) || 0) + 1);
    }
    return { used: new Set(seen.keys()), common, lone: new Set([...seen].filter(([, k]) => k === 1).map(([f]) => f)) };
  }

  /** A language subtag, "zh" of "zh-CN"; null for a tag that is not one. */
  function languageOf(tag) {
    try {
      return new Intl.Locale(String(tag)).language;
    } catch (_) {
      return null;
    }
  }

  /**
   * A language's table as lang/<code>.json holds it, checked against the English one by the rules
   * at the top of strings.js. What breaks one is left out, so that English shows in its place,
   * and is said in `problems`: a key English does not have, a value that is not a string or a
   * set of plural forms, a placeholder left out or one English does not have, a plural form that
   * is none or no "other". `notes` says what only falls back: a plural form the language uses
   * missing, or given where the language has none; meta.* not given, which then follows the code.
   * @returns {{ table: object|null, problems: string[], notes: string[] }}
   */
  function checkTable(code, raw) {
    const problems = [];
    const notes = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { table: null, problems: ['the file is not one JSON object'], notes };
    const want = languageOf(code);
    const table = {};
    const meta = (key, ok, fallback) => {
      if (!own(raw, key)) {
        notes.push(`${key} is not given; it is taken as ${JSON.stringify(fallback)}`);
        return fallback;
      }
      const v = raw[key];
      if (typeof v === 'string' && ok(v)) return v;
      problems.push(`${key}: ${JSON.stringify(v)} does not fit ${code}`);
      return fallback;
    };
    const dir = RTL.has(want) ? 'rtl' : 'ltr';
    table['meta.lang'] = meta('meta.lang', (v) => languageOf(v) === want, code);
    table['meta.locale'] = meta('meta.locale', (v) => languageOf(v) === want, code);
    table['meta.dir'] = meta('meta.dir', (v) => v === dir, dir);
    const forms = pluralForms(table['meta.locale']);
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'meta.lang' || key === 'meta.locale' || key === 'meta.dir') continue;
      if (!own(EN, key)) {
        problems.push(`${key}: English has no such key`);
        continue;
      }
      const en = EN[key];
      const need = placeholdersOf(en);
      const say = (form, what) => `${key}${form ? ` (${form})` : ''}: ${what}`;
      const bad = [];
      const soft = [];
      const checkText = (form, text, lone) => {
        if (typeof text !== 'string' || !text.trim()) {
          bad.push(say(form, 'not a text'));
          return;
        }
        const got = placeholdersOf(text);
        for (const p of got) if (!need.has(p)) bad.push(say(form, `{${p}} is not one of its placeholders`));
        for (const p of need) if (!got.has(p) && !(p === 'count' && lone)) bad.push(say(form, `{${p}} is left out`));
      };
      if (typeof value === 'string') {
        checkText(null, value, false);
        if (typeof en === 'object' && forms.used.size > 1) soft.push(say(null, `one text for every count, in a language of ${forms.used.size} plural forms`));
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (typeof en !== 'object' && !need.has('count')) {
          bad.push(say(null, 'plural forms for a text that counts nothing'));
        } else {
          for (const f of Object.keys(value)) if (!PLURAL_FORMS.includes(f)) bad.push(say(f, 'no such plural form'));
          if (!own(value, 'other')) bad.push(say(null, 'no "other" form'));
          for (const f of PLURAL_FORMS) if (own(value, f)) checkText(f, value[f], forms.lone.has(f));
          for (const f of forms.common) if (f !== 'other' && !own(value, f)) soft.push(say(f, 'missing; "other" is used'));
          for (const f of Object.keys(value)) if (f !== 'other' && PLURAL_FORMS.includes(f) && !forms.used.has(f)) soft.push(say(f, 'not used by this language'));
        }
      } else {
        bad.push(say(null, 'not a text'));
      }
      if (bad.length) {
        problems.push(...bad);
        continue;
      }
      notes.push(...soft);
      table[key] = typeof value === 'string' ? value
        : Object.fromEntries(Object.entries(value).filter(([f]) => f === 'other' || forms.used.has(f)));
    }
    return { table, problems, notes };
  }

  /** Takes in a language's table, checked; the page can then speak it (setLanguage). */
  function useTable(code, raw) {
    const checked = checkTable(code, raw);
    if (checked.table) STRINGS[code] = checked.table;
    return checked;
  }

  const intlCache = new Map();
  function intl(kind, opts) {
    const key = `${kind} ${locale()} ${JSON.stringify(opts || {})}`;
    if (!intlCache.has(key)) intlCache.set(key, new Intl[kind](locale(), opts));
    return intlCache.get(key);
  }

  const fmtNum = (n) => intl('NumberFormat').format(n);

  /**
   * A string by key, with {name} placeholders filled from `params`; a number is written the way
   * the language writes numbers. A value may be a set of plural forms, { one, other } in English,
   * chosen by the language's plural rules on params.count, "other" for a form it lacks. A key no
   * table has comes back as itself, so that a gap shows rather than hides. In a language written
   * right to left, what is put in is isolated (U+2068 ... U+2069), so that a name or a path in
   * another script keeps its own direction and does not reorder the sentence around it.
   */
  function tr(key, params) {
    const p = params || {};
    let v = lookup(key);
    if (v === undefined) return key;
    if (typeof v === 'object' && v) {
      // Without a count no form is right: 'other', rather than the form of 0 (Arabic has one). The
      // page always gives one (test/gui-ui.test.js).
      const n = p.count === undefined || p.count === null || p.count === '' ? NaN : Number(p.count);
      const form = Number.isFinite(n) ? intl('PluralRules').select(n) : 'other';
      v = own(v, form) ? v[form] : v.other;
    }
    const isolate = textDir() === 'rtl';
    return String(v).replace(/\{(\w+)\}/g, (whole, name) => {
      const x = p[name];
      if (x === undefined || x === null) return whole;
      if (typeof x === 'number') return fmtNum(x);
      return isolate ? `\u2068${x}\u2069` : String(x);
    });
  }

  // Sizes as the command line prints them (src/format.js): whole bytes, then one decimal below
  // 10 of a unit, in steps of 1024.
  const SIZE_KEYS = ['fmt.bytes', 'fmt.kb', 'fmt.mb', 'fmt.gb', 'fmt.tb'];

  function fmtSize(n) {
    const bytes = Number(n);
    if (n === null || n === undefined || n === '' || !Number.isFinite(bytes) || bytes < 0) return tr('fmt.sizeUnknown');
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < SIZE_KEYS.length - 1) {
      v /= 1024;
      i++;
    }
    const digits = i === 0 ? 0 : v < 10 ? 1 : 0;
    const shown = intl('NumberFormat', { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(v);
    return tr(SIZE_KEYS[i], { n: shown });
  }

  /** A time as ms, from the number the server sends or an ISO string; null when there is none. */
  function toMs(t) {
    if (t === null || t === undefined || t === '') return null;
    if (typeof t === 'number') return Number.isFinite(t) ? t : null;
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : ms;
  }

  // Every time is local, as on the command line.
  function fmtWhen(ms) {
    if (ms === null || ms === undefined) return tr('fmt.dateUnknown');
    return intl('DateTimeFormat', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms);
  }

  function fmtDay(ms) {
    if (ms === null || ms === undefined) return tr('fmt.dateUnknown');
    return intl('DateTimeFormat', { day: 'numeric', month: 'short', year: 'numeric' }).format(ms);
  }

  /** "2025-07" as the language names a month. */
  function fmtMonth(ym) {
    const [y, m] = String(ym).split('-').map(Number);
    return intl('DateTimeFormat', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
  }

  function fmtList(items) {
    return intl('ListFormat', { type: 'conjunction' }).format(items.map(String));
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  /** A local date as YYYY-MM-DD, the form a date input holds. */
  function ymd(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  /** A local time as "2026-09-28 14.32", which a folder name can hold on every system. */
  function stamp(ms) {
    const d = new Date(ms);
    return `${ymd(ms)} ${pad2(d.getHours())}.${pad2(d.getMinutes())}`;
  }

  /** The local month a time falls in, as "2025-07"; null for a copy with no time. */
  function monthOf(ms) {
    if (ms === null || ms === undefined) return null;
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  }

  /**
   * Midnight where the user is at the start of a YYYY-MM-DD day, as the command line reads
   * --since 2026-09-01; with `after`, the last millisecond of that day. Null for a day that does
   * not exist, such as 2026-02-30, which new Date() would roll over into March.
   */
  function dayStart(s, after) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const at = new Date(y, mo - 1, d);
    if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d) return null;
    return after ? new Date(y, mo - 1, d + 1).getTime() - 1 : at.getTime();
  }

  /** The first time a "since" choice keeps, in ms: 24 hours, 7 or 30 days back, or a chosen day's midnight. */
  function sinceMs(choice, picked, now = Date.now()) {
    const day = 86400000;
    switch (choice) {
      case 'day': return now - day;
      case 'week': return now - 7 * day;
      case 'month': return now - 30 * day;
      case 'pick': return dayStart(picked);
      default: return null;
    }
  }

  /**
   * The dates a photo search keeps, as { from, to } in ms, either of them null for no limit; a
   * day given as the end is kept whole. Null when a date picked cannot be read, or they are the
   * wrong way round.
   */
  function mediaRange(choice, from, to, now = new Date()) {
    const y = now.getFullYear();
    if (choice === 'thisYear') return { from: new Date(y, 0, 1).getTime(), to: null };
    if (choice === 'lastYear') return { from: new Date(y - 1, 0, 1).getTime(), to: new Date(y, 0, 1).getTime() - 1 };
    if (choice !== 'pick') return { from: null, to: null };
    const f = from ? dayStart(from) : null;
    const t = to ? dayStart(to, true) : null;
    if ((from && f === null) || (to && t === null) || (f === null && t === null)) return null;
    if (f !== null && t !== null && f > t) return null;
    return { from: f, to: t };
  }

  // ---- what a copy is ------------------------------------------------------------------------

  const TIERS = ['exact', 'inexact', 'draft', 'unverified', 'derived'];
  const TIER_ALIASES = {
    exact: 'exact', inexact: 'inexact', near: 'inexact', draft: 'draft', unverified: 'unverified',
    pieced: 'unverified', partial: 'unverified', derived: 'derived', smaller: 'derived', folder: 'folder', gone: 'gone',
  };
  const TIER_LABEL = {
    exact: 'tier.exact', inexact: 'tier.inexact', draft: 'tier.draft', unverified: 'tier.unverified',
    derived: 'tier.derived', folder: 'tier.folder', gone: 'tier.gone',
  };
  const TIER_HELP = {
    exact: 'tier.exact.help', inexact: 'tier.inexact.help', draft: 'tier.draft.help', unverified: 'tier.unverified.help',
    derived: 'tier.derived.help', folder: 'tier.folder.help', gone: 'tier.gone.help',
  };
  // Beside the words, never instead of them.
  const TIER_ICON = { exact: 'check', inexact: 'approx', draft: 'pencil', unverified: 'alert', derived: 'shrink', folder: 'folder', gone: 'slash' };

  const STATE_LABEL = { deleted: 'state.deleted', exists: 'state.exists', 'no content': 'state.noContent', '': 'state.unknown' };
  const STATE_HELP = {
    deleted: 'state.deleted.help', exists: 'state.exists.help', 'no content': 'state.noContent.help', '': 'state.unknown.help',
  };

  // What a copy's date means, which depends on where it was found (timeMeaningOf).
  const TIME_LABEL = {
    deleted: 'time.deleted', modified: 'time.modified', saved: 'time.saved', written: 'time.written', read: 'time.read',
    backedUp: 'time.backedUp', committed: 'time.committed', unknown: 'time.unknown',
  };

  // The categories of src/types.js, for a search by type.
  const CATEGORIES = {
    document: 'type.document', image: 'type.image', video: 'type.video', audio: 'type.audio', archive: 'type.archive', text: 'type.text',
  };

  // The system errors a restore can meet, by the code Node gives them.
  const ERRNO_KEYS = {
    ENOSPC: 'error.io.ENOSPC', EACCES: 'error.io.EACCES', EPERM: 'error.io.EPERM', ENAMETOOLONG: 'error.io.ENAMETOOLONG',
    ENOENT: 'error.io.ENOENT', EIO: 'error.io.EIO', EROFS: 'error.io.EROFS', EBUSY: 'error.io.EBUSY', EEXIST: 'error.io.EEXIST',
  };
  const STATUS_KEYS = {
    400: 'error.usage', 404: 'error.notFound', 409: 'error.busy', 410: 'error.gone', 413: 'error.tooLarge', 415: 'error.format',
  };

  const MODE_ROUTE = { name: 'find', media: 'media', folder: 'folder' };
  const MODE_RESULTS = { name: 'find/results', media: 'media/results', folder: 'folder/plan' };
  const MODE_NAV = { name: 'nav.find', media: 'nav.media', folder: 'nav.folder' };

  const PAGE = 50; // file groups or copies shown at a time
  const GRID_PAGE = 240; // photos shown at a time
  const ITEMS_PAGE = 2000; // results asked for at a time after a reload: the server's most
  const TINY_PX = 64; // "hide tiny pictures" hides those smaller than this on both sides
  const THUMB_PX = 320; // grid thumbnails are drawn at most this wide
  const THUMB_MAX_BYTES = 48 * 1024 * 1024; // a picture larger than this gets no thumbnail, only a preview
  // A JPEG larger than this is shown in the grid by the small picture inside it (about 160 by 120,
  // a little soft on a sharp screen) when it has one, rather than read whole.
  const OWN_THUMB_OVER = 1024 * 1024;
  const THUMBS_AT_ONCE = 4;
  const HEX_PAGE = 2048;
  const TEXT_MAX = 256 * 1024; // the most of a text shown at once
  const TILE_PX = 150; // the narrowest a tile gets before the grid takes a column away
  const GAP_PX = 8;

  const ENCODINGS = [
    ['auto', 'preview.encoding.auto'], ['utf-8', 'preview.encoding.utf8'], ['utf-16le', 'preview.encoding.utf16le'],
    ['utf-16be', 'preview.encoding.utf16be'], ['euc-kr', 'preview.encoding.korean'], ['windows-1252', 'preview.encoding.western'],
  ];

  /**
   * A copy's quality as one of TIERS, or 'folder' / 'gone'. The worst of what the server's `tier`
   * says -- a number, or a name from either vocabulary -- and what the library's flags say.
   */
  function tierOf(c) {
    if (!c) return 'exact';
    if (c.gone || c.state === 'no content') return 'gone';
    if (c.isDir) return 'folder';
    const named = typeof c.tier === 'string' && own(TIER_ALIASES, c.tier) ? TIER_ALIASES[c.tier] : null;
    if (named === 'folder' || named === 'gone') return named;
    let t = typeof c.tier === 'number' && TIERS[c.tier] ? c.tier : named ? TIERS.indexOf(named) : 0;
    if (c.derived || c.smaller) t = Math.max(t, 4);
    if (c.unverified || c.pieced || c.partial) t = Math.max(t, 3);
    if (c.draft) t = Math.max(t, 2);
    if (c.inexact) t = Math.max(t, 1);
    return TIERS[t];
  }

  /** How a copy ranks when copies of one file compete: its tier, a folder with the exact, nothing left last. */
  function rankOf(c) {
    const t = tierOf(c);
    if (t === 'gone') return 9;
    return t === 'folder' ? 0 : TIERS.indexOf(t);
  }

  function tierText(c) {
    const t = tierOf(c);
    if (t === 'derived' && c.width && c.height) return tr('tier.derived.size', { w: c.width, h: c.height });
    return tr(TIER_LABEL[t]);
  }

  // Kinds read back from where a card's file system says a file lay: inexact there means a later
  // file may have been written over it, not that line breaks may differ.
  const FROM_DISK = /^(ex)?fat undelete$/;

  /** What a copy's tier means for this copy: the key of its words, by its kind where that differs. */
  function tierHelpKey(c) {
    const t = tierOf(c);
    if (t === 'inexact') return FROM_DISK.test(String((c && c.kind) || '')) ? 'tier.inexact.help.disk' : 'tier.inexact.help.text';
    return TIER_HELP[t];
  }

  /** 'image', 'video', ... as src/types.js names them; the design notes' 'photo' is an image. */
  function mediaOf(c) {
    const m = c && (c.mediaType || c.media);
    if (m === 'photo') return 'image';
    return m || null;
  }

  const uidOf = (c) => String((c && (c.uid || c.id)) || '');
  const whenOf = (c) => (c && typeof c.time === 'number' && Number.isFinite(c.time) ? c.time : toMs(c && c.time));
  // For comparing: a copy with no time is older than any with one.
  const timeOr = (c) => (whenOf(c) === null ? -Infinity : whenOf(c));

  /**
   * What a copy's date means, by the kind of copy: when it was deleted, saved, backed up, written,
   * read or committed, or when the file last changed. A kind not known here -- or one whose date
   * is only what its source could tell, such as a thumbnail's -- says only the date.
   */
  function timeMeaningOf(kind) {
    const k = String(kind || '');
    if (/^(recycle bin|trash)\b/.test(k)) return 'deleted';
    if (/^(local history|notepad, as last saved|hancom)/.test(k)) return 'saved';
    if (/^claude backup/.test(k)) return 'backedUp';
    if (/^(claude write|antigravity write)/.test(k)) return 'written';
    if (/^(claude read|antigravity read)$/.test(k)) return 'read';
    if (/^(git commit|git, deleted in a commit)$/.test(k)) return 'committed';
    if (/^(git index|shadow copy|jetbrains|eclipse|claude, |unsaved editor buffer|notepad, (edits|untitled)|(ex)?fat undelete$)/.test(k)) {
      return 'modified';
    }
    return 'unknown';
  }

  function timeText(c) {
    const ms = whenOf(c);
    if (ms === null) return tr('time.none');
    return tr(TIME_LABEL[timeMeaningOf(c && c.kind)] || TIME_LABEL.unknown, { date: fmtWhen(ms) });
  }

  // ---- paths ---------------------------------------------------------------------------------

  /** A path's parts: an absolute POSIX path separates with "/" alone, as in src/paths.js. */
  function segmentsOf(p) {
    const s = String(p);
    return (s.startsWith('/') ? s.split('/') : s.split(/[\\/]/)).filter(Boolean);
  }

  function baseName(p) {
    const parts = segmentsOf(p);
    return parts.length ? parts[parts.length - 1] : String(p);
  }

  /** The folder a path is in; the root of a drive stays "C:\", since "C:" alone is another folder. */
  function dirName(p) {
    const s = String(p);
    const cut = s.startsWith('/') ? s.lastIndexOf('/') : Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    if (cut > 0) {
      const up = s.slice(0, cut);
      return /^[A-Za-z]:$/.test(up) ? up + '\\' : up;
    }
    return cut === 0 ? s.slice(0, 1) : '';
  }

  const nameOf = (c) => (c && (c.name || (c.path ? baseName(c.path) : null))) || null;
  const folderOf = (c) => (c && c.path ? dirName(c.path) : null) || null;

  /** A name's extension, dot included and in lower case, as src/types.js takes it; '' for none. */
  function extOfName(name) {
    const base = baseName(String(name || ''));
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot).toLowerCase() : '';
  }

  /** Whether a path is a Windows one: a drive letter, or a \\server\share. */
  const isWindowsPath = (s) => /^[A-Za-z]:([\\/]|$)/.test(String(s)) || /^[\\/]{2}[^\\/]/.test(String(s));

  /** Whether a folder is given whole: a drive letter, a \\server\share, or a POSIX path. */
  function isAbsolute(p) {
    const s = String(p || '').trim();
    return /^[A-Za-z]:([\\/]|$)/.test(s) || s.startsWith('\\\\') || s.startsWith('/');
  }

  /** A path as the library compares them (src/paths.js): in Unicode NFC, and a Windows path in any case with either slash. */
  function pathKey(p) {
    const s = String(p || '').normalize('NFC');
    return isWindowsPath(s) ? s.replace(/\//g, '\\').toLowerCase() : s;
  }

  /** Whether `p` is the folder `dir` or lies below it. */
  function isInside(p, dir) {
    const a = pathKey(p);
    const windows = isWindowsPath(String(dir));
    const b = pathKey(dir).replace(windows ? /[\\/]+$/ : /\/+$/, '');
    return a === b || a.startsWith(b + (windows ? '\\' : '/'));
  }

  /**
   * The root a path lies on, as the server compares them: "C:\", "\\server\share\" or "/"; null for
   * none. A drive given as a device, \\.\E: or \\?\E:, is that drive: "E:\".
   */
  function rootOf(p) {
    const s = String(p || '').trim();
    let m = /^(?:[\\/]{2}[.?][\\/])?([A-Za-z]):/.exec(s);
    if (m) return m[1].toUpperCase() + ':\\';
    m = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(s);
    if (m) return `\\\\${m[1]}\\${m[2]}\\`;
    return s.startsWith('/') ? '/' : null;
  }

  const sameRoot = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

  /** Whether a place to recover from is a whole disk or a device, whose drive letter cannot be told: \\.\PhysicalDrive1, /dev/sdb. */
  function isDevice(p) {
    const s = String(p || '').trim();
    if (/^[\\/]{2}[.?][\\/][A-Za-z]:[\\/]?$/.test(s)) return false;
    return /^[\\/]{2}[.?][\\/]/.test(s) || s.startsWith('/dev/');
  }

  function joinPath(dir, ...names) {
    const d = String(dir);
    const sep = d.startsWith('/') ? '/' : '\\';
    return names.reduce((at, n) => (at.endsWith('/') || at.endsWith('\\') ? at + n : at + sep + n), d);
  }

  // The folders cloud services sync, by the names they give them: "OneDrive - Contoso" and the like.
  const SYNCED = /(^|[\\/])(OneDrive|iCloudDrive|iCloud Drive|Dropbox|Google Drive|SynologyDrive)( - [^\\/]+)?([\\/]|$)/i;

  /** The cloud service a folder looks synced by, from the folder names they make; null when none. */
  function syncedBy(p) {
    const m = SYNCED.exec(String(p || ''));
    return m ? m[2] : null;
  }

  function kindLabel(kind, fallback) {
    if (has('kind.' + kind)) return tr('kind.' + kind);
    return String(fallback || kind || '');
  }

  function kindHelp(kind, source) {
    return has('kindHelp.' + kind) ? tr('kindHelp.' + kind) : tr('kind.unknownHelp', { source: source || kind || '' });
  }

  /** A format as people name it: JPG, HEIC, MP4; from an extension such as '.jpg'. */
  function formatName(ext) {
    const e = String(ext || '').replace(/^\./, '');
    return e ? e.toUpperCase() : tr('common.unknown');
  }

  /**
   * A shorter word to search for when a name found nothing: the longest word of three letters
   * or more in it, "budget" for budget-final-v2.xlsx. Null when there is none, or for a glob.
   */
  function partOfName(name) {
    const s = String(name || '').trim();
    if (!s || /[*?]/.test(s)) return null;
    const stem = s.replace(/\.[^.\\/]*$/, '');
    const words = stem.split(/[\s._\-()[\]{},]+/).filter((w) => w.length >= 3).sort((a, b) => b.length - a.length);
    if (words[0] && words[0].toLowerCase() !== s.toLowerCase()) return words[0];
    return stem && stem !== s ? stem : null;
  }

  /** A plan entry's path inside the folder, as parts; the server sends "a/b.txt", the library an array. */
  function relParts(rel) {
    return Array.isArray(rel) ? rel.map(String) : String(rel || '').split('/').filter(Boolean);
  }

  // ---- results, as the page arranges them -----------------------------------------------------

  /**
   * Whether copy `a` of a file is to be preferred over `b`: src/quality.js's better(), without
   * its table of fidelities, which only decides between copies from the same moment -- there the
   * library's own order stands.
   */
  function better(a, b) {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return ra < rb;
    return timeOr(a) > timeOr(b);
  }

  // Stable, so copies of one moment keep the library's order.
  const newestFirst = (a, b) => (timeOr(b) === timeOr(a) ? 0 : timeOr(b) > timeOr(a) ? 1 : -1);

  /**
   * Copies grouped by the file they are of: by path -- a folder apart from a file of the same
   * name -- or by name alone when the folder is unknown; a copy with neither is a group of its
   * own. Each group has its best copy (better() above), `newer` when a copy newer than that one
   * exists that is less certain, a draft say, and every copy newest first.
   */
  function groupFiles(items) {
    const groups = new Map();
    for (const c of items) {
      const key = c.path ? `${c.isDir ? 'dir' : 'file'}:${pathKey(c.path)}`
        : c.name ? `name:${String(c.name).normalize('NFC').toLowerCase()}` : `uid:${uidOf(c)}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, versions: [] }));
      g.versions.push(c);
    }
    const out = [];
    for (const g of groups.values()) {
      let best = g.versions[0];
      for (const c of g.versions) if (better(c, best)) best = c;
      g.versions.sort(newestFirst);
      const newest = g.versions[0];
      g.best = best;
      g.newer = newest !== best && timeOr(newest) > timeOr(best) ? newest : null;
      g.name = nameOf(best);
      g.folder = folderOf(best);
      g.state = best.state || '';
      g.isDir = !!best.isDir;
      g.time = whenOf(newest);
      out.push(g);
    }
    return out;
  }

  const byName = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });

  /** Sorts file groups, or single copies, as the results' Sort chooses; undated ones go last either way. */
  function sortRows(rows, how) {
    const time = (r) => (r.versions ? r.time : whenOf(r));
    const size = (r) => (r.best ? r.best.size : r.size);
    const name = (r) => (r.versions ? r.name : nameOf(r));
    const folder = (r) => (r.versions ? r.folder : folderOf(r));
    const undatedLast = (a, b, dir) => {
      const ta = time(a);
      const tb = time(b);
      if (ta === null || tb === null) return (ta === null) - (tb === null);
      return dir * (ta - tb);
    };
    const cmp = {
      newest: (a, b) => undatedLast(a, b, -1),
      oldest: (a, b) => undatedLast(a, b, 1),
      name: (a, b) => byName(name(a), name(b)) || byName(folder(a), folder(b)) || undatedLast(a, b, -1),
      size: (a, b) => (size(b) == null ? -1 : size(b)) - (size(a) == null ? -1 : size(a)) || undatedLast(a, b, -1),
    }[how] || ((a, b) => undatedLast(a, b, -1));
    return rows.slice().sort(cmp);
  }

  function matchesText(c, q) {
    const s = String(q || '').toLowerCase();
    return !s || String(c.path || c.name || '').toLowerCase().includes(s);
  }

  /**
   * The copies a search by name keeps under the choices on its page, and how many each choice
   * hides. `since` keeps copies that carry no time, as search() does, and counts them; `where`
   * keeps copies whose folder is unknown, since they may have been there.
   * @param {object} f  { deletedOnly, since, allDates, where, allPlaces, q }
   * @returns {{ kept: object[], hidden: { elsewhere: number, notDeleted: number, outsideDates: number }, undated: number }}
   */
  function filterResults(items, f) {
    const hidden = { elsewhere: 0, notDeleted: 0, outsideDates: 0 };
    const kept = [];
    let undated = 0;
    for (const c of items) {
      if (f.where && !f.allPlaces && c.path && !isInside(c.path, f.where)) {
        hidden.elsewhere++;
        continue;
      }
      if (f.deletedOnly && c.state !== 'deleted') {
        hidden.notDeleted++;
        continue;
      }
      if (f.since != null && !f.allDates) {
        const t = whenOf(c);
        if (t === null) {
          undated++;
        } else if (t < f.since) {
          hidden.outsideDates++;
          continue;
        }
      }
      if (f.q && !matchesText(c, f.q)) continue;
      kept.push(c);
    }
    return { kept, hidden, undated };
  }

  /**
   * The photos and videos the grid keeps under its choices, and how many each hides. Copies that
   * carry no date are always kept, whatever the dates: a thumbnail whose file is unknown has none,
   * and may be the one picture left.
   * @param {object} f  { from, to, allDates, smaller, hideTiny, source, where, allPlaces }
   */
  function filterMedia(items, f) {
    const hidden = { elsewhere: 0, outsideDates: 0, smaller: 0, tiny: 0, source: 0 };
    const kept = [];
    for (const c of items) {
      if (f.where && !f.allPlaces && c.path && !isInside(c.path, f.where)) {
        hidden.elsewhere++;
        continue;
      }
      const t = whenOf(c);
      if (!f.allDates && t !== null && ((f.from != null && t < f.from) || (f.to != null && t > f.to))) {
        hidden.outsideDates++;
        continue;
      }
      if (!f.smaller && tierOf(c) === 'derived') {
        hidden.smaller++;
        continue;
      }
      if (f.hideTiny && c.width && c.height && c.width < TINY_PX && c.height < TINY_PX) {
        hidden.tiny++;
        continue;
      }
      if (f.source && c.source !== f.source) {
        hidden.source++;
        continue;
      }
      kept.push(c);
    }
    return { kept, hidden };
  }

  /** How many photos, videos and smaller copies a list holds. */
  function mediaCounts(items) {
    const n = { photos: 0, videos: 0, smaller: 0 };
    for (const c of items) {
      if (mediaOf(c) === 'video') n.videos++;
      else n.photos++;
      if (tierOf(c) === 'derived') n.smaller++;
    }
    return n;
  }

  /** Copies in the order they come, in runs by the month of their date; the undated in a run of their own. */
  function groupByMonth(items) {
    const out = [];
    for (const it of items) {
      const month = monthOf(whenOf(it));
      const last = out[out.length - 1];
      if (last && last.month === month) last.items.push(it);
      else out.push({ month, items: [it] });
    }
    return out;
  }

  /** How many copies fall in each month, in the order the months first come; the undated as month null. */
  function monthCounts(items) {
    const counts = new Map();
    for (const it of items) {
      const m = monthOf(whenOf(it));
      counts.set(m, (counts.get(m) || 0) + 1);
    }
    return [...counts].map(([month, count]) => ({ month, count }));
  }

  /**
   * The tree of a folder plan. A path can be a file in one copy and a folder in another -- a
   * script "bin" that later became bin/cli.js -- so a folder and a file of the same name live
   * side by side, as rebuild writes them, and the file is marked (`conflict`): it comes back as
   * "bin (recovered 2)". Folders come first, then files, each by name.
   */
  function buildTree(files, rootName) {
    const mk = (name, parent, rel) => ({
      name, rel, dir: true, parent, level: parent ? parent.level + 1 : 1,
      children: [], dirs: new Map(), total: 0, included: 0, expanded: !parent,
    });
    const top = mk(rootName, null, '');
    for (const file of files) {
      const parts = relParts(file.rel);
      if (!parts.length) continue;
      let node = top;
      for (let i = 0; i < parts.length - 1; i++) {
        let next = node.dirs.get(parts[i]);
        if (!next) {
          next = mk(parts[i], node, parts.slice(0, i + 1).join('/'));
          node.dirs.set(parts[i], next);
          node.children.push(next);
        }
        node = next;
      }
      node.children.push({ name: parts[parts.length - 1], rel: parts.join('/'), dir: false, parent: node, level: node.level + 1, file });
    }
    const order = (a, b) => (a.dir === b.dir ? byName(a.name, b.name) : a.dir ? -1 : 1);
    const finish = (node) => {
      node.children.sort(order);
      node.total = 0;
      for (const c of node.children) {
        if (c.dir) node.total += finish(c);
        else {
          node.total++;
          c.conflict = node.dirs.has(c.name);
        }
      }
      return node.total;
    };
    finish(top);
    return top;
  }

  /** How many files below a tree node are ticked, given what is left out; updates every folder. */
  function countIncluded(node, isIncluded) {
    if (!node.dir) return isIncluded(node) ? 1 : 0;
    node.included = 0;
    for (const c of node.children) node.included += countIncluded(c, isIncluded);
    return node.included;
  }

  function checkState(node, isIncluded) {
    if (!node.dir) return isIncluded(node) ? 'true' : 'false';
    if (!node.included) return 'false';
    return node.included === node.total ? 'true' : 'mixed';
  }

  // ---- bytes ---------------------------------------------------------------------------------

  /** Bytes as the rows of a hex view: offset, sixteen bytes in two runs of eight, and those as ASCII. */
  function hexRows(bytes, offset) {
    const rows = [];
    const hex = (part) => [...part].map((x) => x.toString(16).padStart(2, '0')).join(' ');
    for (let i = 0; i < bytes.length; i += 16) {
      const part = bytes.subarray(i, Math.min(i + 16, bytes.length));
      rows.push({
        offset: offset + i,
        hex: part.length > 8 ? `${hex(part.subarray(0, 8))}  ${hex(part.subarray(8))}` : hex(part),
        ascii: [...part].map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join(''),
      });
    }
    return rows;
  }

  /** Whether bytes are there and every one is zero: what a drive gives back for a file it erased. */
  function isAllZero(bytes) {
    if (!bytes || !bytes.length) return false;
    for (const x of bytes) if (x !== 0) return false;
    return true;
  }

  /** The first bytes as hex, "FF D8 FF E0", for saying what a file starts with. */
  function magicOf(bytes, n = 8) {
    return [...bytes.subarray(0, n)].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  }

  /**
   * Text from bytes. Automatic reads a byte order mark first; then UTF-8 if every byte fits it;
   * then Korean (EUC-KR, which a browser reads as CP949), the other encoding a file on a Korean PC
   * is in; the Western code page otherwise. `cut`: the bytes end where the copy does not, so a
   * character cut in two at the end is left out rather than taken for a wrong encoding.
   * @returns {{ text: string, encoding: string, bom: string|null }}
   */
  function decodeText(bytes, encoding, cut) {
    const b = bytes || new Uint8Array(0);
    let bom = null;
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) bom = 'utf-8';
    else if (b[0] === 0xff && b[1] === 0xfe) bom = 'utf-16le';
    else if (b[0] === 0xfe && b[1] === 0xff) bom = 'utf-16be';
    const decode = (label, fatal) => {
      const skip = label === bom ? (bom === 'utf-8' ? 3 : 2) : 0;
      try {
        return new TextDecoder(label, { fatal }).decode(b.subarray(skip), { stream: !!cut });
      } catch (_) {
        return null;
      }
    };
    if (encoding && encoding !== 'auto') {
      const text = decode(encoding, false);
      return { text: text === null ? '' : text, encoding, bom: bom === encoding ? bom : null };
    }
    if (bom) return { text: decode(bom, false) || '', encoding: bom, bom };
    const utf8 = decode('utf-8', true);
    if (utf8 !== null) return { text: utf8, encoding: 'utf-8', bom: null };
    const korean = decode('euc-kr', true);
    if (korean !== null) return { text: korean, encoding: 'euc-kr', bom: null };
    return { text: decode('windows-1252', false) || '', encoding: 'windows-1252', bom: null };
  }

  // ---- where to put things back --------------------------------------------------------------

  /**
   * A folder to restore into, before anything is typed: on a drive none of the copies came from,
   * so that writing cannot overwrite what is still to be found there. In order: the drive this
   * program runs from, when it is not the system's; another drive that answers, is not a network
   * one and has the room, the one with the most free space; otherwise a new folder on the Desktop
   * or in the home folder. Drives given as places to recover from -- a memory card -- are never
   * suggested, nor is one that did not answer. A card given as a whole disk or a device
   * (\\.\PhysicalDrive1, \\?\Volume{...}\, /dev/sdb) has a drive letter that cannot be told here,
   * and may be any drive but the system's: then no drive but the system's is suggested.
   * @param {object} o  { drives, info, originals: paths, avoid: roots, needed: bytes, at: ms, desktop: bool }
   * @returns {{ path: string, reason: 'exeDrive'|'otherDrive'|'desktop'|'home', root: string|null }}
   */
  function suggestDestination(o) {
    const drives = (o.drives || []).filter((d) => d && d.root);
    const info = o.info || {};
    const devices = (o.avoid || []).filter(isDevice);
    const held = [...(o.originals || []).map(rootOf), ...(o.avoid || []).filter((p) => !isDevice(p)).map(rootOf)].filter(Boolean);
    const system = rootOf(info.systemDrive);
    const folder = (at) => joinPath(at, tr('restore.folderName'), stamp(o.at || Date.now()));
    const usable = (d) => !devices.length && d.answering !== false && !d.error && !held.some((r) => sameRoot(r, d.root))
      && (d.free == null || !o.needed || d.free > o.needed);
    if (info.program && info.runsFrom) {
      const d = drives.find((x) => sameRoot(x.root, info.runsFrom));
      if (d && usable(d) && !sameRoot(d.root, system) && !d.network) return { path: folder(d.root), reason: 'exeDrive', root: d.root };
    }
    const others = drives.filter((d) => usable(d) && !d.network && !d.system && !sameRoot(d.root, system) && d.root !== '/')
      .sort((a, b) => (b.free || 0) - (a.free || 0));
    if (others.length) return { path: folder(others[0].root), reason: 'otherDrive', root: others[0].root };
    const home = info.home || '';
    if (!home) return { path: '', reason: 'home', root: null };
    return o.desktop
      ? { path: folder(joinPath(home, 'Desktop')), reason: 'desktop', root: rootOf(home) }
      : { path: folder(home), reason: 'home', root: rootOf(home) };
  }

  /** How many of these copies were on the drive `root`; null when roots cannot tell drives apart (POSIX). */
  function onSameDrive(paths, root) {
    if (!root || root === '/') return null;
    return paths.filter((p) => sameRoot(rootOf(p), root)).length;
  }

  // ---- what is sent ----------------------------------------------------------------------------

  /** An object without the fields that are not set: undefined, null, '', false or an empty list. */
  function compact(o) {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && !v.length)) continue;
      out[k] = v;
    }
    return out;
  }

  /**
   * The places a search starts from: the ones added for this session, as { discover, dirs } --
   * dirs by source id, as --location gives them -- and, for the folder a file was in, that folder
   * looked through in every restore point, which otherwise only walks where something else was
   * found and the usual user folders.
   */
  function placesFor(locations, where) {
    const dirs = {};
    for (const [id, list] of Object.entries((locations && locations.dirs) || {})) {
      if ([].concat(list || []).length) dirs[id] = [].concat(list);
    }
    if (where) dirs.vss = [...(dirs.vss || []), `walk=${where}`];
    return { discover: !locations || locations.discover !== false, dirs };
  }

  /**
   * What a search by name, content or type sends: only what decides which copies are found, and
   * the form as it was (`view`), which the server keeps with the search and gives back as it came:
   * it says which view the results belong to, so a search for photos does not replace one by
   * name, and fills the form in again after a reload. The server never reads the rest of it.
   */
  function searchBody(req, locations) {
    return compact({
      pattern: req.name, containing: req.containing, types: req.types, sources: req.sources,
      locations: placesFor(locations, req.where), view: req,
    });
  }

  /** What a folder's plan sends: its choice of copy per file depends on the dates and on only-deleted. */
  function planBody(req, locations) {
    return compact({
      folder: req.folder, deletedOnly: req.deletedOnly, since: req.since, sources: req.sources, locations: placesFor(locations, null),
    });
  }

  /** Which of the page's views a job the page did not start itself belongs to, after a reload. */
  function modeOf(snap) {
    if (snap.kind === 'plan') return 'folder';
    if (snap.kind === 'rebuild') return 'rebuild';
    const r = snap.request || {};
    if (r.view && (r.view.mode === 'name' || r.view.mode === 'media')) return r.view.mode;
    const types = r.types || [];
    return !r.pattern && !r.containing && types.length && types.every((t) => t === 'image' || t === 'video') ? 'media' : 'name';
  }

  /** What the page's form held for a job, as far as the server kept its request. */
  function requestOf(snap) {
    const r = snap.request || {};
    const mode = modeOf(snap);
    const sources = r.sources && r.sources.length ? r.sources : null;
    if (mode === 'folder') {
      return {
        mode, folder: r.folder || '', deletedOnly: !!r.deletedOnly, since: r.since == null ? null : r.since,
        sinceDate: r.since == null ? '' : ymd(r.since), sources,
      };
    }
    // The form as the page sent it, when it did: every choice in it, the page's own filters too.
    if (r.view && r.view.mode === mode && typeof r.view === 'object') return { ...r.view, mode };
    if (mode === 'media') return { mode, types: r.types.slice(), sources, includeSmaller: true };
    if (mode === 'rebuild') return { mode, folder: r.folder || '', to: r.to || '', files: r.files || 0 };
    return { mode, name: r.pattern || '', containing: r.containing || '', types: r.types || [], sources };
  }

  // ---- talking to the server -----------------------------------------------------------------

  const enc = encodeURIComponent;
  const copyUrl = (uid) => `api/copy/${enc(uid)}`;

  /** The query string of a request, leaving out what is not set. */
  function query(params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
      q.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    return q.toString();
  }

  /** A request that failed: its HTTP status (0 for no answer at all), what the server said, and its reply. */
  class ApiError extends Error {
    constructor(status, message, data) {
      super(message || '');
      this.status = status;
      this.data = data || null;
      // The system's own code behind it, such as ENOSPC, when the server gives one.
      this.code = data && typeof data.code === 'string' ? data.code : null;
    }
  }

  /** A reply that is not a success, as an ApiError: the server says why as { error, code? } or in plain text. */
  async function failure(res) {
    const text = await res.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }
    const message = data && typeof data.error === 'string' ? data.error : text.slice(0, 300);
    return new ApiError(res.status, message, data);
  }

  // A header of its own on every request: the server checks Origin and its cookie, and a page
  // elsewhere cannot send this one without its leave either.
  async function request(method, url, body) {
    const init = { method, headers: { Accept: 'application/json', 'X-Solarljos': '1' }, cache: 'no-store', credentials: 'same-origin' };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      checkServer();
      throw new ApiError(0, e.message);
    }
    if (!res.ok) {
      const err = await failure(res);
      if (err.status === 403) notConnected();
      throw err;
    }
    const text = res.status === 204 ? '' : await res.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch (_) {
      return null;
    }
  }

  const get = (url) => request('GET', url);
  const post = (url, body) => request('POST', url, body === undefined ? {} : body);

  /**
   * What went wrong, for the person using the page. The server's own sentence when it has one --
   * why a folder was refused, that a search is no longer kept -- and for a system error, such as a
   * full disk, what it means.
   */
  function errorText(e) {
    if (!e) return tr('error.unexpected');
    if (e.status === 0) return tr('error.offline');
    if (e.status === 403) return tr('error.forbidden');
    const message = String(e.message || '');
    const errno = e.code || (/\b(E[A-Z][A-Z0-9]+)\b/.exec(message) || [])[1];
    if (errno && own(ERRNO_KEYS, errno)) return tr(ERRNO_KEYS[errno]);
    if (e.status >= 500) return tr('error.io', { message });
    if (message) return message;
    return tr(own(STATUS_KEYS, e.status) ? STATUS_KEYS[e.status] : 'error.unexpected');
  }

  /**
   * Bytes `start` to `start + length - 1` of a copy, fewer where it ends. A copy whose length the
   * server does not know comes whole and without ranges, so only what is wanted of it is read.
   * @returns {Promise<Uint8Array>}
   */
  async function readBytes(uid, start, length) {
    let res;
    try {
      const range = `bytes=${start}-${start + length - 1}`;
      res = await fetch(copyUrl(uid), { headers: { Range: range }, cache: 'no-store', credentials: 'same-origin' });
    } catch (e) {
      checkServer();
      throw new ApiError(0, e.message);
    }
    if (res.status === 416) return new Uint8Array(0);
    if (!res.ok) throw await failure(res);
    if (res.status === 206 || !res.body) return new Uint8Array(await res.arrayBuffer()).subarray(0, length);
    const reader = res.body.getReader();
    const out = new Uint8Array(length);
    let got = 0;
    let pos = 0;
    try {
      while (got < length) {
        const { done, value } = await reader.read();
        if (done) break;
        const from = Math.max(0, start - pos);
        if (from < value.length) {
          const part = value.subarray(from, from + (length - got));
          out.set(part, got);
          got += part.length;
        }
        pos += value.length;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return out.subarray(0, got);
  }

  /** What a copy's first bytes say it is, and how the server sends it; asked once per copy. */
  function aboutOf(uid) {
    if (!state.abouts.has(uid)) {
      state.abouts.set(uid, get(`api/copy/${enc(uid)}/about`).catch((e) => {
        state.abouts.delete(uid);
        throw e;
      }));
    }
    return state.abouts.get(uid);
  }

  // ---- building the page ---------------------------------------------------------------------

  const $ = (sel, from) => (from || document).querySelector(sel);
  const $$ = (sel, from) => [...(from || document).querySelectorAll(sel)];

  // Properties rather than attributes: what a form control holds now, not what it started with.
  const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'indeterminate', 'open', 'required']);

  /**
   * An element, with its children appended as nodes or as text. Nothing given here is ever read
   * as HTML: `text` is textContent, and strings among the children become text nodes.
   */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'on') for (const [type, fn] of Object.entries(v)) el.addEventListener(type, fn);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    return add(el, children);
  }

  function add(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === undefined || c === null || c === false) continue;
      el.append(typeof c === 'object' ? c : String(c));
    }
    return el;
  }

  let idSeq = 0;
  const nextId = (prefix) => `${prefix}-${++idSeq}`;

  const button = (text, onClick, cls) => h('button', { type: 'button', class: cls || 'btn', text, on: { click: onClick } });

  /**
   * Left and Right as they move on screen: in a page written right to left the next tile, tab or
   * a folder's inside lies to the left, so there Left is taken for Right and Right for Left.
   */
  function logicalKey(key, dir) {
    const d = dir || (typeof document !== 'undefined' && document.documentElement ? document.documentElement.dir : 'ltr');
    if (d !== 'rtl') return key;
    return key === 'ArrowLeft' ? 'ArrowRight' : key === 'ArrowRight' ? 'ArrowLeft' : key;
  }

  // The icons, drawn in a 24-pixel box with a line of 1.6 (style.css), each as its paths. They
  // are for the eye only: every one stands beside words that say the same.
  const CIRCLE = 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z';
  const ICONS = {
    check: ['M5 12.5l4.3 4.3L19 7.2'],
    approx: ['M4.5 9.5c2.5-2 5-2 7.5 0s5 2 7.5 0', 'M4.5 14.5c2.5-2 5-2 7.5 0s5 2 7.5 0'],
    pencil: ['M4.5 19.5h3.8L19 8.8a2.7 2.7 0 0 0-3.8-3.8L4.5 15.7z', 'M13.8 6.5l3.7 3.7'],
    alert: ['M10.3 5.1a2 2 0 0 1 3.4 0l7.1 12.3a2 2 0 0 1-1.7 3H4.9a2 2 0 0 1-1.7-3z', 'M12 10v4.2', 'M12 17.2v.1'],
    shrink: ['M4 9V4h5', 'M15 4h5v5', 'M20 15v5h-5', 'M9 20H4v-5', 'M9.5 9.5h5v5h-5z'],
    folder: ['M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z'],
    slash: [CIRCLE, 'M6 6l12 12'],
    info: [CIRCLE, 'M12 11v5.2', 'M12 7.9v.1'],
    error: [CIRCLE, 'M9.2 9.2l5.6 5.6', 'M14.8 9.2l-5.6 5.6'],
    success: [CIRCLE, 'M8.3 12.3l2.6 2.6 5-5.2'],
    circle: [CIRCLE],
    arc: ['M12 3.5a8.5 8.5 0 0 1 8.5 8.5'],
    minus: ['M7 12h10'],
    chevron: ['M9.5 6l6 6-6 6'],
    down: ['M6 9.5l6 6 6-6'],
    close: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
    copy: ['M9 9h10v11H9z', 'M5.5 15.5V4.5h10'],
    play: ['M8.5 5.8v12.4l10-6.2z'],
    search: ['M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z', 'M15.3 15.3l5.2 5.2'],
    photo: ['M6 5h12a2.5 2.5 0 0 1 2.5 2.5v9A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5v-9A2.5 2.5 0 0 1 6 5z',
      'M9 8.4a1.6 1.6 0 1 0 0 3.2a1.6 1.6 0 1 0 0-3.2z', 'M4 17.5l4.8-4.6a1.5 1.5 0 0 1 2.1 0l1.6 1.6 2.6-2.6a1.5 1.5 0 0 1 2.1 0l3.3 3.2'],
    folderBack: ['M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
      'M9.5 13.5h5', 'M12.5 11.2l2.3 2.3-2.3 2.3'],
    places: ['M12 4l8.5 4.5L12 13 3.5 8.5z', 'M3.5 12.5l8.5 4.5 8.5-4.5', 'M3.5 16.2l8.5 4.3 8.5-4.3'],
    power: ['M12 3.8v7.4', 'M7.2 6.6a7.2 7.2 0 1 0 9.6 0'],
    stop: [CIRCLE, 'M9.5 9.5h5v5h-5z'],
    file: ['M7 3.5h6.5L18 8v12.5H7z', 'M13.5 3.5V8H18'],
    clock: [CIRCLE, 'M12 7.5V12l3 2'],
    usb: ['M9 3.5h6v5H9z', 'M7.5 8.5h9V17a3.5 3.5 0 0 1-3.5 3.5h-2A3.5 3.5 0 0 1 7.5 17z', 'M11 5.5v1', 'M13 5.5v1'],
    eraser: ['M13.2 5.3a1.8 1.8 0 0 1 2.5 0l3 3a1.8 1.8 0 0 1 0 2.5L11 18.5H7.3l-3-3a1.8 1.8 0 0 1 0-2.5z', 'M8.8 9.7l5.5 5.5', 'M11 18.5h8.5'],
    video: ['M4.5 6.5h10a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 3 16V8a1.5 1.5 0 0 1 1.5-1.5z', 'M16 10.5l4.5-2.5v8L16 13.5'],
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** An icon by name, hidden from assistive technology. */
  function icon(name, cls) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', `icon icon-${name}${cls ? ` ${cls}` : ''}`);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const d of ICONS[name] || []) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }

  const CALLOUT_ICON = { error: 'error', warn: 'alert', info: 'info', plain: 'info', success: 'success' };

  /** A message in a box of its kind -- error, warn, info, plain, success -- with its icon, a title and what it says. */
  function callout(kind, title, ...body) {
    return h('div', { class: `callout ${kind}` }, icon(CALLOUT_ICON[kind] || 'info', 'callout-icon'),
      h('div', { class: 'callout-body' }, title ? h('p', { class: 'callout-title', text: title }) : null, ...body));
  }

  function badge(cls, iconName, text) {
    return h('span', { class: `badge ${cls}` }, iconName ? icon(iconName) : null, h('span', { class: 'badge-text', text }));
  }

  function tierBadge(c) {
    const t = tierOf(c);
    return badge(`tier-${t}`, TIER_ICON[t], tierText(c));
  }

  /** A file's name, isolated so that one in another script keeps its own direction. */
  const nameText = (name, cls) => h('bdi', { class: cls || null, text: name });
  /** A path, which reads left to right in any language. */
  const pathText = (p, cls) => h('span', { class: cls ? `path ${cls}` : 'path', dir: 'ltr', text: p });

  function stateBadge(s) {
    const key = STATE_LABEL[s || ''] || STATE_LABEL[''];
    return badge(`state state-${String(s || 'unknown').replace(/\s+/g, '-')}`, null, tr(key));
  }

  /** A label with its control, a hint below it, and room for an error that points back at it. */
  function field({ id, label, control, hint, optional, extra }) {
    control.id = id;
    const hintId = hint ? `${id}-hint` : null;
    const errId = `${id}-err`;
    if (hintId) control.setAttribute('aria-describedby', hintId);
    const err = h('p', { class: 'field-error', id: errId, hidden: true });
    const aside = optional ? h('span', { class: 'muted', text: ` ${tr('common.optional')}` }) : null;
    const el = h('div', { class: 'field' },
      h('label', { for: id, class: 'field-label' }, label, aside),
      h('div', { class: 'control-row' }, control, extra || null),
      hint ? h('p', { class: 'hint', id: hintId, text: hint }) : null,
      err);
    return {
      el,
      control,
      setError(msg) {
        err.hidden = !msg;
        err.textContent = msg || '';
        if (msg) {
          control.setAttribute('aria-invalid', 'true');
          control.setAttribute('aria-describedby', [hintId, errId].filter(Boolean).join(' '));
        } else {
          control.removeAttribute('aria-invalid');
          if (hintId) control.setAttribute('aria-describedby', hintId);
          else control.removeAttribute('aria-describedby');
        }
      },
    };
  }

  function checkLine(label, checked, hint) {
    const id = nextId('chk');
    const input = h('input', { type: 'checkbox', id, checked: !!checked });
    const hintId = hint ? `${id}-hint` : null;
    if (hintId) input.setAttribute('aria-describedby', hintId);
    const el = h('div', { class: 'check' }, input, h('label', { for: id, text: label }),
      hint ? h('p', { class: 'hint', id: hintId, text: hint }) : null);
    return { el, input };
  }

  /**
   * An on/off choice as a switch, as SoundVisualizer's settings are: its words and, below them,
   * what it does, with the switch at the end of the row, and the whole row to click. `compact`:
   * one line, in a toolbar.
   */
  function switchLine(label, checked, hint, compact) {
    const id = nextId('sw');
    const input = h('input', { type: 'checkbox', role: 'switch', class: 'switch', id, checked: !!checked });
    const hintId = hint ? `${id}-hint` : null;
    if (hintId) input.setAttribute('aria-describedby', hintId);
    const text = h('div', { class: 'switch-text' }, h('label', { for: id, class: 'switch-label', text: label }),
      hint ? h('p', { class: 'hint', id: hintId, text: hint }) : null);
    const el = h('div', { class: compact ? 'switch-row compact' : 'switch-row' }, text, input);
    return { el, input, text };
  }

  /** A group of radio buttons; `choices` is [[value, label]]. */
  function radioGroup(legend, choices, selected, hint) {
    const name = nextId('radio');
    const inputs = [];
    const fs = h('fieldset', { class: 'radios' }, h('legend', { text: legend }));
    for (const [value, label] of choices) {
      const id = nextId('opt');
      const input = h('input', { type: 'radio', name, id, value, checked: value === selected });
      inputs.push(input);
      fs.append(h('span', { class: 'radio' }, input, h('label', { for: id, text: label })));
    }
    if (hint) fs.append(h('p', { class: 'hint', text: hint }));
    return {
      el: fs,
      inputs,
      value: () => (inputs.find((i) => i.checked) || {}).value,
      onChange: (fn) => inputs.forEach((i) => i.addEventListener('change', fn)),
    };
  }

  function select(label, choices, selected, onChange) {
    const id = nextId('sel');
    const sel = h('select', { id, on: { change: () => onChange(sel.value) } },
      choices.map(([value, text]) => h('option', { value, text, selected: value === selected })));
    return { el: h('span', { class: 'select' }, h('label', { for: id, text: label }), h('span', { class: 'select-box' }, sel)), control: sel };
  }

  /**
   * A box for a folder's whole path. The browser's own folder picker cannot tell a page where a
   * folder is, and the server lists no folders, so it is typed or pasted; Explorer's "Copy as
   * path" puts it in quotes, which the server takes off.
   */
  function pathInput(value) {
    return h('input', { type: 'text', class: 'input path', value: value || '', autocomplete: 'off', spellcheck: 'false', dir: 'ltr' });
  }

  /** A path field's hint, with how to copy a folder's path in Explorer on Windows. */
  function pathHint(key, params) {
    const tip = state.info.platform === 'win32' ? ` ${tr('common.pathTip')}` : '';
    return tr(key, params) + tip;
  }

  /** A button that puts a path on the clipboard: the page opens no folder itself. */
  function copyButton(text) {
    const b = button(tr('common.copyPath'), async () => {
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = tr('common.copied');
        announce(tr('common.copied'));
      } catch (_) {
        alertNow(tr('common.copyFailed'));
      }
    }, 'btn small');
    return b;
  }

  // ---- announcing ----------------------------------------------------------------------------

  // One polite region for how things went and one assertive one for what went wrong. The text is
  // set a moment after clearing, so the same words said twice are still read out.
  function speak(id, msg) {
    const region = document.getElementById(id);
    if (!region) return;
    region.textContent = '';
    setTimeout(() => {
      region.textContent = msg;
    }, 60);
  }
  const announce = (msg) => speak('status', msg);
  const alertNow = (msg) => speak('alert', msg);

  // ---- dialogs -------------------------------------------------------------------------------

  /** Shows a modal dialog; closing it removes it and gives focus back to what opened it. */
  function showModal(dlg, opener, onClose) {
    const back = opener || document.activeElement;
    document.body.append(dlg);
    dlg.addEventListener('close', () => {
      dlg.remove();
      if (onClose) onClose();
      if (back && back.isConnected && typeof back.focus === 'function') back.focus();
    });
    dlg.showModal();
    return dlg;
  }

  function confirmDialog({ title, body, ok, cancel, danger }) {
    return new Promise((resolve) => {
      const titleId = nextId('dlg');
      let result = false;
      const dlg = h('dialog', { class: 'dialog', 'aria-labelledby': titleId });
      const cancelBtn = button(cancel || tr('common.cancel'), () => dlg.close());
      const okBtn = button(ok, () => {
        result = true;
        dlg.close();
      }, danger ? 'btn danger' : 'btn primary');
      dlg.append(
        h('div', { class: 'dialog-body' }, h('h2', { id: titleId, text: title }), body ? h('p', { class: 'dialog-text', text: body }) : null),
        h('div', { class: 'dialog-actions' }, cancelBtn, okBtn));
      showModal(dlg, null, () => resolve(result));
      cancelBtn.focus();
    });
  }

  /** Solarljos has stopped, or this page is not one of its windows: nothing more can be done here, and it says so over everything. */
  function stoppedOverlay(title, body, canRetry) {
    if ($('dialog.overlay')) return;
    const titleId = nextId('dlg');
    const dlg = h('dialog', { class: 'dialog overlay', 'aria-labelledby': titleId, role: 'alertdialog' });
    const status = h('p', { class: 'muted', role: 'status' });
    dlg.append(h('div', { class: 'dialog-body stopped-body' },
      h('div', { class: 'stopped-icon' }, icon('power')),
      h('h2', { id: titleId, text: title }), h('p', { text: body }), status));
    if (canRetry) {
      const retry = button(tr('common.retry'), async () => {
        status.textContent = tr('conn.checking');
        if ((await alive()) === 'yes') {
          dlg.close();
          state.stopped = false;
          reconnect();
          route();
        } else {
          status.textContent = tr('conn.lost.still');
        }
      }, 'btn primary');
      dlg.append(h('div', { class: 'dialog-actions' }, retry));
    }
    // Esc must not leave a page that cannot work any more looking as if it could.
    dlg.addEventListener('cancel', (e) => e.preventDefault());
    document.body.append(dlg);
    dlg.showModal();
  }

  function connectionLost() {
    if (state.stopped) return;
    state.stopped = true;
    if (state.events) state.events.close();
    stoppedOverlay(tr('conn.lost.title'), tr('conn.lost.body'), true);
  }

  function notConnected() {
    if (state.stopped) return;
    state.stopped = true;
    if (state.events) state.events.close();
    stoppedOverlay(tr('conn.forbidden.title'), tr('error.forbidden'), false);
  }

  /** Whether the server still answers: 'yes', 'forbidden' (not with this page's cookie) or 'no'. */
  async function alive() {
    try {
      const res = await fetch('api/info', { cache: 'no-store', credentials: 'same-origin' });
      return res.status === 403 ? 'forbidden' : 'yes';
    } catch (_) {
      return 'no';
    }
  }

  let checking = null;
  /** After a request that got no answer at all: has Solarljos stopped? */
  function checkServer() {
    if (checking || state.stopped) return;
    checking = alive().then((how) => {
      checking = null;
      if (how === 'no') connectionLost();
      else if (how === 'forbidden') notConnected();
    });
  }

  // ---- the page's state ----------------------------------------------------------------------

  const state = {
    info: {}, // api/info
    sources: [], // api/sources
    elevated: false,
    // Places added for this session, sent with every search as search() takes them. Kept in
    // this tab only, so they are gone when it is.
    locations: { discover: true, dirs: {} },
    jobs: new Map(), // server job id -> the page's picture of it
    current: { name: null, media: null, folder: null, rebuild: null }, // the job each view shows
    forms: { name: {}, media: {}, folder: {} }, // what a form starts from when it is made
    abouts: new Map(),
    firstRoute: true,
    events: null,
    helloSeen: false,
    helloWaiters: [],
    onRestoreProgress: null,
    stopped: false,
    // The languages the page has tables for, [{ code, name }], as api/info lists them; the one
    // the library speaks now (api/info, api/lang), which each job also says it was found in.
    languages: [{ code: 'en', name: 'English' }],
    locale: 'en',
  };

  function sourceLabel(id, fallback) {
    if (has(`source.${id}.label`)) return tr(`source.${id}.label`);
    const s = state.sources.find((x) => x.id === id);
    return (s && s.label) || fallback || id;
  }

  function addedCount() {
    return Object.values(state.locations.dirs || {}).reduce((n, list) => n + [].concat(list || []).length, 0);
  }

  // ---- jobs, and what the server says of them ------------------------------------------------

  /** The page's picture of a server job, made the first time either side names it. */
  function jobOf(id) {
    const key = String(id);
    let job = state.jobs.get(key);
    if (!job) {
      job = {
        id: key, kind: null, mode: null, request: {}, state: 'running', rows: new Map(), order: [], filtering: false,
        startedAt: Date.now(), summary: {}, error: null, items: [], received: 0, total: null, complete: false,
        written: 0, writeTotal: 0, rel: '', fetching: null, loadError: null, lang: null,
      };
      state.jobs.set(key, job);
    }
    return job;
  }

  function addRow(job, id, label) {
    if (!job.rows.has(id)) {
      job.rows.set(id, { id, label: label || id, status: 'waiting', done: 0, total: 0, count: 0, error: null });
      job.order.push(id);
    }
    return job.rows.get(id);
  }

  /** Takes in what the server says of a job, as it answers a search, in hello, and when the job ends. */
  function adopt(snap) {
    const job = jobOf(snap.id);
    job.kind = snap.kind || job.kind;
    if (!job.mode) {
      job.mode = modeOf(snap);
      job.request = requestOf(snap);
    }
    job.state = snap.state || job.state;
    if (snap.startedAt) job.startedAt = snap.startedAt;
    job.error = snap.error || null;
    // The language the library spoke when the job was made, which its notes are in.
    if (snap.lang) job.lang = snap.lang;
    for (const s of snap.sources || []) {
      const row = addRow(job, s.id, s.label);
      row.label = s.label || row.label;
      row.status = s.state || row.status;
      if (s.done != null) row.done = s.done;
      if (s.total != null) row.total = s.total;
      if (s.count != null) row.count = s.count;
      row.error = s.error || null;
    }
    const summary = { ...snap };
    for (const k of ['id', 'kind', 'state', 'request', 'startedAt', 'finishedAt', 'error', 'sources', 'total', 'lang']) delete summary[k];
    job.summary = { ...job.summary, ...summary };
    if (typeof snap.total === 'number' && job.kind !== 'rebuild') job.total = snap.total;
    checkComplete(job);
    return job;
  }

  /** One event of a search as search() reports it, or of a folder being written, applied to its job. */
  function applyProgress(job, e) {
    if (e.type === 'writing') {
      job.written = e.done || 0;
      job.writeTotal = e.total || job.writeTotal;
      if (e.rel) job.rel = e.rel;
      return;
    }
    if (e.type === 'filtering') {
      job.filtering = true;
      return;
    }
    if (typeof e.id !== 'string') return;
    const row = addRow(job, e.id, e.label);
    if (e.label) row.label = e.label;
    if (e.type === 'source-start') {
      row.status = 'running';
    } else if (e.type === 'source-progress') {
      row.status = 'running';
      row.done = e.done;
      row.total = e.total;
    } else if (e.type === 'source-done') {
      row.status = e.error ? 'failed' : e.skipped ? 'skipped' : 'done';
      row.count = e.count || 0;
      row.error = e.error || null;
      // Said of the search in sight only; one going on in a part not shown says when it is done.
      if (job.id === state.current[job.mode] && active === MODE_RESULTS[job.mode]) {
        announce(tr('a11y.sourceDone', { source: sourceLabel(row.id, row.label), result: rowResult(row) }));
      }
    }
  }

  /** A batch of a job's results, or of its plan's files, put in its place. */
  function take(job, d) {
    if (typeof d.total === 'number') job.total = d.total;
    const at = Number(d.offset) || 0;
    (d.items || []).forEach((it, i) => {
      if (job.items[at + i] === undefined) job.received++;
      job.items[at + i] = it;
    });
    checkComplete(job);
  }

  function checkComplete(job) {
    job.complete = job.state === 'done' && job.total != null && job.received >= job.total;
  }

  /**
   * Asks for the results the page missed: after a reload, or when the stream dropped some. The
   * server keeps them until a newer job of the same kind ends.
   */
  function fetchItems(job) {
    if (job.fetching) return job.fetching;
    job.fetching = (async () => {
      try {
        let offset = 0;
        while (!job.complete) {
          while (job.items[offset] !== undefined && offset < job.total) offset++;
          const d = await get(`api/job/${enc(job.id)}/items?${query({ offset, limit: ITEMS_PAGE })}`);
          take(job, d);
          if (!(d.items || []).length) break;
          offset += d.items.length;
        }
      } catch (e) {
        job.loadError = e;
        if (e.status === 404) forget(job);
      } finally {
        job.fetching = null;
        jobChanged(job);
      }
    })();
    return job.fetching;
  }

  /** A job the server no longer has: the page lets go of it too. */
  function forget(job) {
    state.jobs.delete(job.id);
    for (const m of Object.keys(state.current)) if (state.current[m] === job.id) state.current[m] = null;
    jobChanged(job);
  }

  /**
   * The server keeps one finished search for each view -- by name, and for photos and videos --
   * and one finished plan: when one ends, however it ends, it lets go of the older ones of its
   * kind and view, and so does the page.
   */
  function dropOlder(job) {
    if (job.kind !== 'search' && job.kind !== 'plan') return;
    for (const other of [...state.jobs.values()]) {
      if (other !== job && other.kind === job.kind && other.mode === job.mode && other.state !== 'running') forget(other);
    }
  }

  function finished(snap) {
    const job = adopt(snap);
    dropOlder(job);
    if (job.state === 'done' && (job.kind === 'search' || job.kind === 'plan')) {
      checkComplete(job);
      if (!job.complete) fetchItems(job);
      if (state.current[job.mode] === job.id) {
        announce(job.kind === 'plan' ? tr('a11y.planDone', { count: job.total || 0 }) : tr('a11y.searchDone', { count: job.total || 0 }));
      }
    } else if (job.kind === 'rebuild' && job.state === 'done') {
      announce(tr('rebuild.done', { written: job.summary.written || 0, count: job.summary.files || 0 }));
    }
    jobChanged(job);
  }

  const EVENTS = {
    /** On every (re)connection: where things are. After a reload, each view shows its newest job. */
    hello(d) {
      state.elevated = !!d.elevated || state.elevated;
      const kept = new Set();
      for (const snap of d.jobs || []) {
        kept.add(String(snap.id));
        const job = adopt(snap);
        if (job.state === 'done' && (job.kind === 'search' || job.kind === 'plan') && !job.complete) fetchItems(job);
      }
      for (const job of [...state.jobs.values()]) if (!kept.has(job.id)) forget(job);
      if (!state.helloSeen) {
        for (const job of [...state.jobs.values()].sort((a, b) => Number(a.id) - Number(b.id))) {
          if (job.mode && own(state.current, job.mode)) {
            state.current[job.mode] = job.id;
            if (MODE_ROUTE[job.mode] && !Object.keys(state.forms[job.mode]).length) state.forms[job.mode] = { ...job.request };
          }
        }
      }
      const waiters = state.helloWaiters.splice(0);
      waiters.forEach((fn) => fn());
      // Back after the stream dropped: what ended meanwhile is shown as ended, the rest goes on.
      if (state.helloSeen) {
        for (const job of state.jobs.values()) {
          jobChanged(job);
          refreshSoon(job);
        }
      }
    },
    progress(d) {
      const job = jobOf(d.job);
      applyProgress(job, d);
      refreshSoon(job);
    },
    results(d) {
      take(jobOf(d.job), d);
    },
    plan(d) {
      take(jobOf(d.job), d);
    },
    done: finished,
    failed: finished,
    cancelled: finished,
    'restore-progress'(d) {
      if (state.onRestoreProgress) state.onRestoreProgress(d);
    },
  };

  /**
   * The one event stream of this window. EventSource connects again by itself (the server asks
   * for 2 s); a stream that keeps failing is checked against the server, and if that does not
   * answer either, Solarljos has stopped, and the page says so.
   */
  function connect() {
    let failures = 0;
    const es = new EventSource('api/events');
    es.addEventListener('open', () => {
      failures = 0;
    });
    es.addEventListener('error', () => {
      failures++;
      if (es.readyState !== EventSource.CLOSED && failures < 3) return;
      es.close();
      alive().then((how) => {
        if (how === 'no') connectionLost();
        else if (how === 'forbidden') notConnected();
        else if (!state.stopped) setTimeout(reconnect, 2000);
      });
    });
    for (const [name, fn] of Object.entries(EVENTS)) {
      es.addEventListener(name, (m) => {
        let data = null;
        try {
          data = m.data ? JSON.parse(m.data) : null;
        } catch (_) {
          return;
        }
        fn(data || {});
      });
    }
    return es;
  }

  function reconnect() {
    if (state.events) state.events.close();
    state.events = connect();
  }

  /**
   * A job has moved on -- ended, its results all here, or let go of -- and every view that shows
   * it follows, shown or not: one whose job now needs another kind of view (the results after the
   * progress) is built again, one whose job is gone goes, and the rest only update. The start
   * page's links to the last results follow too.
   */
  function jobChanged(job) {
    for (const [route, slot] of [...slots]) {
      const r = ROUTES[route];
      if (!r.job) continue;
      if (slot.key === keyOf(route)) {
        if (slot.view && slot.view.job === job && slot.view.update) slot.view.update();
        continue;
      }
      if (route === active) show(route);
      else if (!jobFor(route)) dropSlot(route);
      else build(route);
    }
    const home = slots.get('');
    if (home && home.view && home.view.onShow) home.view.onShow();
  }

  // Progress is drawn once a frame, in every view of the jobs it came for.
  let refreshPending = false;
  const refreshing = new Set();
  function refreshSoon(job) {
    if (job) refreshing.add(job);
    if (refreshPending) return;
    refreshPending = true;
    requestAnimationFrame(() => {
      refreshPending = false;
      const jobs = [...refreshing];
      refreshing.clear();
      for (const slot of slots.values()) {
        if (slot.view && slot.view.update && jobs.includes(slot.view.job)) slot.view.update();
      }
    });
  }

  // ---- starting and stopping -----------------------------------------------------------------

  /**
   * Starts a search (or a folder's plan), stopping the one already running in its place when the
   * person agrees: the server runs one at a time. `request` is what the form held, kept to fill
   * it in again and to show and filter the results. Started from elsewhere than its form -- Try
   * again, a shorter name -- it has the form made again from it, so the form says what was
   * searched for.
   */
  async function startSearch(mode, request, fromForm) {
    state.forms[mode] = { ...request };
    if (!fromForm) dropSlot(MODE_ROUTE[mode]);
    const url = mode === 'folder' ? 'api/plan' : 'api/search';
    const body = mode === 'folder' ? planBody(request, state.locations) : searchBody(request, state.locations);
    let res;
    try {
      res = await post(url, body);
    } catch (e) {
      if (e.status !== 409 || !e.data || !e.data.job) throw e;
      const ok = await confirmDialog({ title: tr('progress.busy.title'), body: tr('progress.busy.body'), ok: tr('progress.busy.ok') });
      if (!ok) return false;
      await post('api/cancel', { job: e.data.job });
      res = await post(url, body);
    }
    const job = adopt(res.job);
    job.mode = mode;
    job.request = { ...request };
    state.current[mode] = job.id;
    go(MODE_RESULTS[mode]);
    return true;
  }

  async function stopJob(job, btn) {
    btn.disabled = true;
    btn.textContent = tr('common.stopping');
    try {
      const res = await post('api/cancel', { job: job.id });
      if (res && res.job) finished(res.job);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = tr('common.stop');
      alertNow(errorText(e));
    }
  }

  // ---- routes --------------------------------------------------------------------------------

  // Each route is a view in a part of the page (its section). A view is kept for each route, so
  // that a form and the results it led to are both there to go back to; `job` names the job a
  // view of results shows, by the mode it was searched in.
  const ROUTES = {
    '': { section: '', render: () => viewHome() },
    find: { section: 'find', render: (saved) => viewFindForm(saved) },
    'find/results': { section: 'find', job: 'name', render: (saved) => viewJob('name', saved) },
    media: { section: 'media', render: (saved) => viewMediaForm(saved) },
    'media/results': { section: 'media', job: 'media', render: (saved) => viewJob('media', saved) },
    folder: { section: 'folder', render: (saved) => viewFolderForm(saved) },
    'folder/plan': { section: 'folder', job: 'folder', render: (saved) => viewJob('folder', saved) },
    'folder/done': { section: 'folder', job: 'rebuild', render: () => viewRebuild() },
    sources: { section: 'sources', render: () => viewSources() },
    help: { section: 'help', render: (saved) => viewHelp(saved) },
  };

  // The views kept, by route: { route, box, view, key, fresh, scroll, inner, focus }. `key` says
  // what a view of results was made for -- its job, and whether it was running, done... -- so
  // that one made for something else is made again; `fresh` is a view not yet shown.
  const slots = new Map();
  let active = null; // the route in sight
  // The view each part of the page was last left on, where its link in the frame goes.
  const lastOf = { '': '', find: 'find', media: 'media', folder: 'folder', sources: 'sources', help: 'help' };
  // What scrolls inside a view, besides the window: kept by hand, as a view out of sight loses it.
  const SCROLLERS = '.preview-pane, .text-view, .table-wrap, .tabpanel';

  // The route is all a URL holds. What was searched for stays in the page, not in the address:
  // an address goes into the browser's history, and a file's name has no business there.
  function currentRoute() {
    const m = /^#\/(.*)$/.exec(location.hash);
    return m ? m[1].replace(/\/+$/, '') : null;
  }

  function go(r) {
    if (currentRoute() === r) route();
    else location.hash = '#/' + r;
  }

  function route() {
    const r = currentRoute();
    // Any other fragment (#main, from the skip link) is not a route.
    if (r === null && location.hash && location.hash !== '#') return;
    closeRail();
    show(own(ROUTES, r || '') ? r || '' : '');
  }

  /** The job a route's view shows; null for a route of no job, or when that job is gone. */
  function jobFor(route) {
    const r = ROUTES[route];
    if (!r || !r.job) return null;
    return state.jobs.get(state.current[r.job] || '') || null;
  }

  /** What kind of view a job needs now. */
  function phaseOf(job) {
    if (job.state !== 'done') return job.state;
    if (job.kind === 'rebuild' || job.complete) return 'ready';
    return job.loadError ? 'unloaded' : 'loading';
  }

  function keyOf(route) {
    const job = jobFor(route);
    return job ? `${job.id}:${phaseOf(job)}` : '';
  }

  const pauseMedia = (root) => {
    for (const v of $$('video, audio', root)) if (!v.paused) v.pause();
  };

  function teardown(slot) {
    if (!slot.view) return;
    pauseMedia(slot.box);
    if (slot.view.destroy) slot.view.destroy();
    slot.view = null;
  }

  /** Makes a route's view, in the box it is kept in, from what it held (`saved`) when it is made again. */
  function build(route, saved) {
    let slot = slots.get(route);
    if (!slot) {
      const box = h('div', { class: 'view', hidden: true });
      box.inert = true;
      slot = { route, box, view: null, key: '', fresh: true, scroll: 0, inner: [], focus: null };
      box.addEventListener('focusin', (e) => {
        slot.focus = e.target;
      });
      document.getElementById('main').append(box);
      slots.set(route, slot);
    } else {
      teardown(slot);
    }
    slot.key = keyOf(route);
    slot.view = ROUTES[route].render(saved) || null;
    slot.box.textContent = '';
    if (slot.view && slot.view.el) slot.box.append(slot.view.el);
    Object.assign(slot, { fresh: true, scroll: 0, inner: [], focus: null });
    return slot;
  }

  /** Lets go of a route's view; its part of the page then goes back to its first view. */
  function dropSlot(route) {
    const slot = slots.get(route);
    if (slot) {
      teardown(slot);
      slot.box.remove();
      slots.delete(route);
    }
    const section = ROUTES[route].section;
    if (lastOf[section] === route) lastOf[section] = section;
    if (active === route) active = null;
  }

  /** Puts a view out of sight as it is: where it was scrolled, and no video playing. */
  function leave(slot) {
    slot.scroll = window.scrollY;
    slot.inner = $$(SCROLLERS, slot.box).map((el) => [el, el.scrollTop, el.scrollLeft]).filter(([, y, x]) => y || x);
    pauseMedia(slot.box);
    for (const d of $$('dialog[open]')) pauseMedia(d);
    if (slot.view && slot.view.onHide) slot.view.onHide();
    slot.box.hidden = true;
    slot.box.inert = true;
  }

  const inSight = (el) => !!el && el.isConnected && el.getClientRects().length > 0;

  function focusHeading(slot) {
    const h1 = $('h1', slot.box);
    if (!h1) return;
    h1.setAttribute('tabindex', '-1');
    h1.focus({ preventScroll: true });
  }

  /**
   * Shows a route's view: the one kept when it is still the one to show, else a new one. One
   * shown for the first time starts at the top, with focus on its heading, so that a screen
   * reader starts there (not on the first view of a fresh page, which leaves focus where the
   * browser put it); one kept comes back where it was left, focus included.
   */
  function show(route) {
    const r = ROUTES[route];
    if (r.job && !jobFor(route)) {
      dropSlot(route);
      location.replace('#/' + (r.job === 'rebuild' ? 'folder' : MODE_ROUTE[r.job]));
      return;
    }
    const before = active !== null && active !== route ? slots.get(active) : null;
    if (before) leave(before);
    let slot = slots.get(route);
    if (!slot || slot.key !== keyOf(route) || !slot.view) slot = build(route);
    else if (slot.view.onShow) slot.view.onShow();
    active = route;
    lastOf[r.section] = route;
    slot.box.hidden = false;
    slot.box.inert = false;
    updateNav();
    setTitle();
    if (slot.fresh) {
      slot.fresh = false;
      window.scrollTo(0, 0);
      if (!state.firstRoute) focusHeading(slot);
    } else {
      for (const [el, y, x] of slot.inner) if (el.isConnected) el.scrollTo(x, y);
      if (inSight(slot.focus) && slot.box.contains(slot.focus)) slot.focus.focus({ preventScroll: true });
      else focusHeading(slot);
      window.scrollTo(0, slot.scroll);
    }
    state.firstRoute = false;
  }

  /**
   * Marks the part of the page in sight in the rail -- its link current, and the start's on the
   * start -- and sends each part's link to the view it was left on.
   */
  function updateNav() {
    const section = active !== null ? ROUTES[active].section : '';
    for (const a of $$('[data-route]')) {
      const s = a.getAttribute('data-route');
      if (s === section) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
      if (own(lastOf, s)) a.setAttribute('href', '#/' + lastOf[s]);
    }
  }

  function setTitle() {
    const slot = active !== null ? slots.get(active) : null;
    const h1 = slot && active !== '' ? $('h1', slot.box) : null;
    document.title = h1 ? tr('app.pageTitle', { page: h1.textContent }) : tr('app.name');
  }

  /**
   * Every view made again in the language now chosen, from what each held: its form, its
   * results' choices. The one in sight stays in sight, about where it was scrolled.
   */
  function rebuildAll() {
    const y = window.scrollY;
    for (const [route, slot] of [...slots]) {
      const saved = slot.view && slot.view.save ? slot.view.save() : undefined;
      const hidden = slot.box.hidden;
      build(route, saved);
      if (!hidden) {
        slot.fresh = false;
        slot.scroll = y;
      }
    }
    if (active !== null) {
      const slot = slots.get(active);
      slot.box.hidden = false;
      slot.box.inert = false;
      focusHeading(slot);
      window.scrollTo(0, y);
    }
    updateNav();
    setTitle();
  }

  function viewJob(mode, saved) {
    const job = state.jobs.get(state.current[mode] || '');
    if (!job) return null;
    if (job.state === 'running') return progressView(job);
    if (job.state === 'failed') return failedView(job);
    if (job.state === 'cancelled') return stoppedView(job);
    if (!job.complete) return loadingView(job);
    if (mode === 'folder') return planView(job, saved);
    if (mode === 'media') return gridView(job, saved);
    return resultsView(job, saved);
  }

  // ---- start ---------------------------------------------------------------------------------

  function viewHome() {
    const card = (href, iconName, title, body) => h('li', {}, h('a', { class: 'card choice', href },
      h('span', { class: 'choice-icon' }, icon(iconName)),
      h('span', { class: 'choice-text' }, h('span', { class: 'card-title', text: title }), h('span', { class: 'card-body', text: body })),
      icon('chevron', 'choice-go')));
    const last = h('ul', { class: 'plain last' });
    // The last results of each kind, which change while this page is kept.
    const showLast = () => {
      last.textContent = '';
      for (const mode of Object.keys(MODE_RESULTS)) {
        const job = state.jobs.get(state.current[mode] || '');
        if (!job || job.state !== 'done') continue;
        const text = tr('home.lastIn', { place: tr(MODE_NAV[mode]), count: job.total || 0 });
        last.append(h('li', {}, h('a', { class: 'link-row', href: '#/' + MODE_RESULTS[mode] },
          h('span', { class: 'status-dot is-done', 'aria-hidden': 'true' }), h('span', { text }), icon('chevron', 'link-go'))));
      }
      last.hidden = !last.childElementCount;
    };
    showLast();
    const tip = (iconName, key) => h('li', {}, icon(iconName), h('span', { text: tr(key) }));
    const el = h('section', { class: 'home' },
      h('header', { class: 'home-head' },
        h('h1', { class: 'wordmark', text: tr('app.name') }),
        h('p', { class: 'home-desc', text: tr('home.good.copies') })),
      h('ul', { class: 'cards choices' },
        card('#/find', 'search', tr('home.file.title'), tr('home.file.body')),
        card('#/media', 'photo', tr('home.media.title'), tr('home.media.body')),
        card('#/folder', 'folderBack', tr('home.folder.title'), tr('home.folder.body'))),
      last,
      h('section', { class: 'good panel', 'aria-labelledby': 'good-title' },
        h('h2', { id: 'good-title', text: tr('home.good.title') }),
        h('ul', { class: 'tips' },
          tip('clock', 'home.good.soon'),
          tip('usb', 'home.good.drive'),
          tip('file', 'home.good.exe'),
          tip('eraser', 'home.good.cleanup'),
          tip('power', 'home.good.window')),
        h('p', { class: 'panel-foot' }, h('a', { class: 'btn outlined', href: '#/sources', text: tr('home.sourcesLink') }))));
    return { el, onShow: showLast };
  }

  // ---- forms ---------------------------------------------------------------------------------

  /**
   * The places to search, one box each, all ticked at first -- except, in a search for photos,
   * the places that keep only text (media: false), which the library would leave out anyway.
   */
  function placesField(mode, preset) {
    const sources = state.sources || [];
    const byDefault = (s) => !(mode === 'media' && s.media === false);
    const boxes = [];
    const list = h('ul', { class: 'places' });
    for (const s of sources) {
      const id = nextId('src');
      const input = h('input', { type: 'checkbox', id, value: s.id, checked: preset ? preset.includes(s.id) : byDefault(s) });
      boxes.push(input);
      const notes = [];
      if (mode === 'media' && s.media === false) notes.push(tr('adv.sources.textOnly'));
      if (s.needsAdmin && !state.elevated) notes.push(tr('adv.sources.needsAdmin'));
      const aside = notes.length ? h('span', { class: 'muted', text: ` (${notes.join('; ')})` }) : null;
      list.append(h('li', { class: notes.length ? 'dim' : null }, input, h('label', { for: id }, sourceLabel(s.id, s.label), aside)));
    }
    const allId = nextId('src');
    const all = h('input', { type: 'checkbox', id: allId });
    const sync = () => {
      const n = boxes.filter((b) => b.checked).length;
      all.checked = n === boxes.length;
      all.indeterminate = n > 0 && n < boxes.length;
    };
    all.addEventListener('change', () => {
      for (const b of boxes) b.checked = all.checked;
      sync();
    });
    boxes.forEach((b) => b.addEventListener('change', sync));
    sync();
    const err = h('p', { class: 'field-error', hidden: true });
    const el = h('fieldset', { class: 'places-field' },
      h('legend', { text: tr('adv.sources.label') }),
      h('div', { class: 'check' }, all, h('label', { for: allId, text: tr('adv.sources.all') })),
      list, err);
    return {
      el,
      /** The ids ticked, or null when every place is, which the server takes as all of them. */
      value() {
        const ids = boxes.filter((b) => b.checked).map((b) => b.value);
        return ids.length === boxes.length ? null : ids;
      },
      validate() {
        const none = boxes.length > 0 && !boxes.some((b) => b.checked);
        err.hidden = !none;
        err.textContent = none ? tr('adv.sources.none') : '';
        return none ? all : null;
      },
    };
  }

  /**
   * Places added from another disk, and whether this PC's own are left out; kept in this tab for
   * the session. update() says them again as they stand: places are added under What is
   * searched, while a form is kept.
   */
  function otherDiskField() {
    const onlyAdded = switchLine(tr('adv.onlyAdded.label'), state.locations.discover === false);
    onlyAdded.input.addEventListener('change', () => {
      state.locations.discover = !onlyAdded.input.checked;
    });
    onlyAdded.el.classList.add('reveal');
    const hint = h('p', { class: 'hint' });
    const el = h('div', { class: 'other-disk' }, h('p', { class: 'field-label', text: tr('adv.otherDisk.label') }), hint, onlyAdded.el);
    const update = () => {
      const n = addedCount();
      hint.textContent = '';
      hint.append(n ? tr('adv.otherDisk.count', { count: n }) : tr('adv.otherDisk.hint'), ' ',
        h('a', { href: '#/sources', text: tr('adv.otherDisk.link') }));
      onlyAdded.input.checked = state.locations.discover === false;
      onlyAdded.el.hidden = !n;
    };
    update();
    return { el, update };
  }

  /** Options side by side, two to a row where the window is wide enough, one above the other where it is not. */
  const pair = (...els) => h('div', { class: 'form-pair' }, ...els);

  /** "More options", closed or open as it was. */
  function moreOptions(open, ...body) {
    return h('details', { class: 'more', open: !!open },
      h('summary', {}, h('span', { class: 'more-title', text: tr('common.advanced') }), icon('down', 'more-chevron')),
      h('div', { class: 'more-body' }, ...body));
  }

  /** A form's heading, with a way back to the results it led to while they are kept. */
  function formHead(mode, titleKey) {
    const back = h('a', { class: 'btn back-link', href: '#/' + MODE_RESULTS[mode] });
    const update = () => {
      const job = state.jobs.get(state.current[mode] || '');
      back.hidden = !job;
      back.textContent = '';
      if (job) back.append(h('span', { text: tr(job.state === 'running' ? 'form.toSearch' : 'form.toResults') }), icon('chevron'));
    };
    update();
    return { el: h('header', { class: 'page-head' }, h('h1', { text: tr(titleKey) }), back), update };
  }

  function formError(form) {
    const box = h('div', { class: 'form-error', hidden: true, tabindex: '-1' });
    form.prepend(box);
    return {
      show(msg) {
        box.textContent = '';
        box.append(callout('error', tr('error.title'), h('p', { text: msg })));
        box.hidden = false;
        box.focus();
        alertNow(msg);
      },
      clear() {
        box.hidden = true;
        box.textContent = '';
      },
    };
  }

  /** Runs a form's search, with the button held down meanwhile and a failure said at the top. */
  async function submitSearch(submit, errors, mode, request) {
    errors.clear();
    submit.disabled = true;
    try {
      await startSearch(mode, request, true);
    } catch (e) {
      errors.show(errorText(e));
    } finally {
      if (submit.isConnected) submit.disabled = false;
    }
  }

  /**
   * Find a file. `saved` is the form as it was, when it is made again in another language; it
   * starts otherwise from what was last searched for here.
   */
  function viewFindForm(saved) {
    const last = saved || state.forms.name || {};
    const name = field({
      id: 'f-name', label: tr('find.name.label'), hint: tr('find.name.hint'),
      control: h('input', { type: 'text', class: 'input wide', value: last.name || '', autocomplete: 'off', spellcheck: 'false' }),
    });
    const where = field({
      id: 'f-where', label: tr('find.where.label'), hint: pathHint('find.where.hint'), optional: true, control: pathInput(last.where),
    });
    const containing = field({
      id: 'f-containing', label: tr('find.containing.label'), hint: tr('find.containing.hint'), optional: true,
      control: h('input', { type: 'text', class: 'input wide', value: last.containing || '', autocomplete: 'off', spellcheck: 'false' }),
    });
    const deletedOnly = switchLine(tr('find.deletedOnly.label'), last.deletedOnly, tr('find.deletedOnly.hint'));

    // The dates, the folder and only-deleted filter what a search found, in this tab; after a
    // reload the server's copy of the search has none of them, and the form starts without them.
    const sinceChoice = last.sinceChoice || 'any';
    const since = radioGroup(tr('find.since.label'), [
      ['any', tr('find.since.any')], ['day', tr('find.since.day')], ['week', tr('find.since.week')],
      ['month', tr('find.since.month')], ['pick', tr('find.since.pick')],
    ], sinceChoice, tr('find.since.hint'));
    const sinceDate = field({
      id: 'f-since', label: tr('find.since.date'), control: h('input', { type: 'date', class: 'input date', value: last.sinceDate || '' }),
    });
    sinceDate.el.classList.add('reveal');
    const syncSince = () => {
      sinceDate.el.hidden = since.value() !== 'pick';
    };
    since.onChange(syncSince);
    syncSince();
    const kinds = [['', tr('find.type.any')], ...Object.entries(CATEGORIES).map(([k, key]) => [k, tr(key)])];
    const type = select(tr('find.type.label'), kinds, (last.types || [])[0] || '', () => {});
    const places = placesField('name', last.sources);
    const disk = otherDiskField();

    const submit = h('button', { type: 'submit', class: 'btn primary', text: tr('find.submit') });
    const more = moreOptions(saved ? saved.more : sinceChoice !== 'any' || !!last.sources || !!(last.types || []).length,
      pair(h('div', {}, since.el, sinceDate.el), h('div', { class: 'field' }, type.el)), places.el, disk.el);
    const form = h('form', { class: 'search-form panel', novalidate: true },
      name.el, pair(where.el, containing.el), pair(deletedOnly.el), more, h('p', { class: 'actions form-actions' }, submit));
    const errors = formError(form);
    /** What the form holds; `raw`, as typed, spaces and all. */
    const values = (raw) => {
      const v = (c) => (raw ? c.value : c.value.trim());
      return {
        mode: 'name', name: v(name.control), containing: v(containing.control), where: v(where.control),
        deletedOnly: deletedOnly.input.checked, sinceChoice: since.value(), sinceDate: sinceDate.control.value,
        types: type.control.value ? [type.control.value] : [], sources: places.value(),
      };
    };
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      for (const f of [name, where, sinceDate]) f.setError(null);
      const request = values(false);
      request.since = sinceMs(request.sinceChoice, request.sinceDate);
      let bad = null;
      if (!request.name && !request.containing && !request.types.length) {
        name.setError(tr('find.name.missing'));
        bad = bad || name.control;
      }
      if (request.where && !isAbsolute(request.where)) {
        where.setError(tr('folder.path.relative'));
        bad = bad || where.control;
      }
      if (request.sinceChoice === 'pick' && request.since === null) {
        sinceDate.setError(tr('find.since.missing'));
        bad = bad || sinceDate.control;
      }
      bad = bad || places.validate();
      if (bad) {
        bad.focus();
        return;
      }
      submitSearch(submit, errors, 'name', request);
    });
    // Sent here to search by content instead: start in that box, once the view has its focus.
    if (last.focus === 'containing') {
      delete last.focus;
      setTimeout(() => containing.control.focus(), 0);
    }
    const head = formHead('name', 'find.title');
    return {
      el: h('section', { class: 'form-view' }, head.el, form),
      save: () => ({ ...values(true), more: more.open }),
      onShow() {
        head.update();
        disk.update();
      },
    };
  }

  function viewMediaForm(saved) {
    const last = saved || state.forms.media || {};
    const wanted = last.types || ['image', 'video'];
    const photos = checkLine(tr('media.what.photos'), wanted.includes('image'));
    const videos = checkLine(tr('media.what.videos'), wanted.includes('video'));
    const whatErr = h('p', { class: 'field-error', hidden: true });
    const what = h('fieldset', { class: 'what' }, h('legend', { text: tr('media.what.label') }),
      h('div', { class: 'check-row' }, photos.el, videos.el), whatErr);

    const whenChoice = last.whenChoice || 'any';
    const when = radioGroup(tr('media.when.label'), [
      ['any', tr('media.when.any')], ['thisYear', tr('media.when.thisYear')], ['lastYear', tr('media.when.lastYear')],
      ['pick', tr('media.when.pick')],
    ], whenChoice, tr('media.when.hint'));
    const dateBox = (value) => h('input', { type: 'date', class: 'input date', value: value || '' });
    const from = field({ id: 'm-from', label: tr('media.when.from'), control: dateBox(last.fromDate) });
    const to = field({ id: 'm-to', label: tr('media.when.to'), control: dateBox(last.toDate) });
    const range = h('div', { class: 'range reveal' }, from.el, to.el);
    const syncWhen = () => {
      range.hidden = when.value() !== 'pick';
    };
    when.onChange(syncWhen);
    syncWhen();

    const where = field({
      id: 'm-where', label: tr('media.where.label'), hint: pathHint('media.where.hint'), optional: true, control: pathInput(last.where),
    });
    const smaller = switchLine(tr('media.smaller.label'), last.includeSmaller !== false, tr('media.smaller.hint'));
    const hasWeb = state.sources.some((s) => s.id === 'browser-cache');
    const web = switchLine(tr('media.web.label'), !!last.includeWeb, tr('media.web.hint'));
    const places = placesField('media', last.sources);
    const disk = otherDiskField();

    const frozen = (state.info.frozen && state.info.frozen.sources) || [];
    const thumbs = frozen.find((s) => s.id === 'thumbcache');
    const submit = h('button', { type: 'submit', class: 'btn primary', text: tr('media.submit') });
    const more = moreOptions(saved ? saved.more : !!last.sources, places.el, disk.el);
    const form = h('form', { class: 'search-form panel', novalidate: true },
      pair(what, h('div', {}, when.el, range)), where.el, pair(smaller.el, hasWeb ? web.el : null), more,
      h('p', { class: 'actions form-actions' }, submit));
    const errors = formError(form);
    const values = (raw) => ({
      mode: 'media', types: [photos.input.checked ? 'image' : null, videos.input.checked ? 'video' : null].filter(Boolean),
      whenChoice: when.value(), fromDate: from.control.value, toDate: to.control.value,
      where: raw ? where.control.value : where.control.value.trim(), includeSmaller: smaller.input.checked,
      includeWeb: hasWeb && web.input.checked, sources: places.value(),
    });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      whatErr.hidden = true;
      for (const f of [from, where]) f.setError(null);
      const request = values(false);
      let bad = null;
      if (!request.types.length) {
        whatErr.hidden = false;
        whatErr.textContent = tr('media.what.missing');
        bad = photos.input;
      }
      const dates = mediaRange(request.whenChoice, request.fromDate, request.toDate);
      if (!dates) {
        const f = request.fromDate;
        const t = request.toDate;
        if (!f && !t) from.setError(tr('media.when.missing'));
        else if ((f && dayStart(f) === null) || (t && dayStart(t) === null)) from.setError(tr('media.when.bad'));
        else from.setError(tr('media.when.badRange'));
        bad = bad || from.control;
      }
      if (request.where && !isAbsolute(request.where)) {
        where.setError(tr('folder.path.relative'));
        bad = bad || where.control;
      }
      bad = bad || places.validate();
      if (bad) {
        bad.focus();
        return;
      }
      submitSearch(submit, errors, 'media', { ...request, from: dates.from, to: dates.to });
    });
    const head = formHead('media', 'media.title');
    return {
      el: h('section', { class: 'form-view' },
        head.el,
        h('div', { class: 'notices' },
          callout('info', null, h('p', { text: tr('media.expect') }), h('p', { text: tr('media.video') })),
          callout(state.elevated ? 'info' : 'plain', tr('media.card.title'),
            h('p', { text: state.elevated ? tr('media.card.admin') : tr('media.card.body') }))),
        thumbs && !thumbs.error ? h('p', { class: 'hint', text: tr('media.frozen') }) : null,
        form),
      save: () => ({ ...values(true), more: more.open }),
      onShow() {
        head.update();
        disk.update();
      },
    };
  }

  function viewFolderForm(saved) {
    const last = saved || state.forms.folder || {};
    const folder = field({
      id: 'r-folder', label: tr('folder.path.label'), hint: pathHint('folder.path.hint'), control: pathInput(last.folder),
    });
    const deletedOnly = switchLine(tr('folder.deletedOnly.label'), last.deletedOnly, tr('folder.deletedOnly.hint'));
    const since = field({
      id: 'r-since', label: tr('folder.since.label'), hint: tr('folder.since.hint'), optional: true,
      control: h('input', { type: 'date', class: 'input date', value: last.sinceDate || '' }),
    });
    const places = placesField('folder', last.sources);
    const disk = otherDiskField();
    folder.control.addEventListener('input', () => {
      const v = folder.control.value.trim();
      folder.setError(v && !isAbsolute(v) ? tr('folder.path.relative') : null);
    });
    const submit = h('button', { type: 'submit', class: 'btn primary', text: tr('folder.submit') });
    const more = moreOptions(saved ? saved.more : !!last.sources, places.el, disk.el);
    const form = h('form', { class: 'search-form panel', novalidate: true },
      folder.el, pair(deletedOnly.el, since.el), more, h('p', { class: 'actions form-actions' }, submit));
    const errors = formError(form);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const v = folder.control.value.trim();
      const sinceDate = since.control.value;
      let bad = null;
      folder.setError(!v ? tr('folder.path.missing') : !isAbsolute(v) ? tr('folder.path.relative') : null);
      if (!v || !isAbsolute(v)) bad = folder.control;
      since.setError(sinceDate && dayStart(sinceDate) === null ? tr('find.since.missing') : null);
      if (sinceDate && dayStart(sinceDate) === null) bad = bad || since.control;
      bad = bad || places.validate();
      if (bad) {
        bad.focus();
        return;
      }
      submitSearch(submit, errors, 'folder', {
        mode: 'folder', folder: v, deletedOnly: deletedOnly.input.checked, sinceDate,
        since: sinceDate ? dayStart(sinceDate) : null, sources: places.value(),
      });
    });
    const head = formHead('folder', 'folder.title');
    return {
      el: h('section', { class: 'form-view' }, head.el, form),
      save: () => ({
        mode: 'folder', folder: folder.control.value, deletedOnly: deletedOnly.input.checked, sinceDate: since.control.value,
        sources: places.value(), more: more.open,
      }),
      onShow() {
        head.update();
        disk.update();
      },
    };
  }

  /**
   * Sends the person to a form, filled in with `patch` over what it holds now, and to one of its
   * boxes (`focus`): a word it contained, a folder to bring back.
   */
  function prefill(mode, patch, focus) {
    const route = MODE_ROUTE[mode];
    const slot = slots.get(route);
    const now = slot && slot.view && slot.view.save ? slot.view.save() : state.forms[mode] || {};
    state.forms[mode] = { ...now, ...patch, ...(focus ? { focus } : {}) };
    dropSlot(route);
    go(route);
  }

  // ---- searching -----------------------------------------------------------------------------

  function jobTitle(job) {
    const r = job.request || {};
    if (job.mode === 'media') return tr('progress.title.media');
    if (job.mode === 'folder') return tr('progress.title.folder', { folder: r.folder || job.summary.folder || '' });
    if (r.name) return tr('progress.title.name', { name: r.name });
    if (r.containing) return tr('progress.title.containing', { text: r.containing });
    return tr('progress.title.type', { type: typeWords(r.types) });
  }

  const typeWords = (types) => fmtList((types || []).map((t) => (CATEGORIES[t] ? tr(CATEGORIES[t]) : t)));

  const ROW_ICON = { waiting: 'circle', running: 'arc', done: 'check', failed: 'alert', skipped: 'minus' };

  function rowResult(row) {
    if (row.status === 'failed') return tr('progress.failed');
    if (row.status === 'skipped') return tr('progress.skipped');
    if (row.count > 0) return tr('progress.found', { count: row.count });
    return tr('progress.nothing');
  }

  /** How a search goes, one row per place, from the event stream: waiting, how far, what it found. */
  function progressView(job) {
    const overall = h('span', { class: 'overall' });
    const elapsed = h('span', { class: 'muted elapsed' });
    const stopBtn = button(tr('common.stop'), () => stopJob(job, stopBtn), 'btn danger');
    const whole = h('progress', { class: 'whole', max: '1', value: '0' });
    const list = h('ul', { class: 'progress-list panel' });
    const filtering = h('p', { class: 'filtering', hidden: true }, icon('arc', 'spin'), h('span', { text: tr('progress.filtering') }));
    const rows = new Map();

    function rowEl() {
      const mark = h('span', { class: 'row-icon' });
      const label = h('span', { class: 'row-label' });
      const status = h('span', { class: 'row-status' });
      const bar = h('progress', { max: '1', hidden: true });
      const detail = h('p', { class: 'row-error', hidden: true });
      const more = button(tr('common.details'), () => {
        detail.hidden = !detail.hidden;
        more.setAttribute('aria-expanded', String(!detail.hidden));
      }, 'btn small quiet');
      more.setAttribute('aria-expanded', 'false');
      more.hidden = true;
      const li = h('li', { class: 'progress-row' }, mark, label, h('span', { class: 'row-state' }, status, bar, more), detail);
      let was = null;
      return {
        li,
        set(r) {
          li.className = `progress-row is-${r.status}`;
          if (was !== r.status) {
            was = r.status;
            mark.textContent = '';
            mark.append(icon(ROW_ICON[r.status] || ROW_ICON.waiting, r.status === 'running' ? 'spin' : null));
          }
          label.textContent = sourceLabel(r.id, r.label);
          if (r.status === 'waiting') status.textContent = r.id === 'vss' ? tr('progress.vssLast') : tr('progress.waiting');
          else if (r.status !== 'running') status.textContent = rowResult(r);
          else if (r.total) status.textContent = tr('progress.files', { done: r.done, total: r.total });
          else status.textContent = tr('progress.running');
          bar.hidden = !(r.status === 'running' && r.total);
          if (!bar.hidden) {
            bar.max = r.total;
            bar.value = r.done;
            bar.setAttribute('aria-label', tr('a11y.progressValue', { source: sourceLabel(r.id, r.label), done: r.done, total: r.total }));
          }
          more.hidden = r.status !== 'failed' || !r.error;
          detail.textContent = r.error || '';
        },
      };
    }

    function update() {
      for (const id of job.order) {
        let r = rows.get(id);
        if (!r) {
          r = rowEl();
          rows.set(id, r);
          list.append(r.li);
        }
        r.set(job.rows.get(id));
      }
      const done = job.order.filter((id) => ['done', 'failed', 'skipped'].includes(job.rows.get(id).status)).length;
      overall.textContent = tr('progress.overall', { done, total: job.order.length });
      whole.max = Math.max(1, job.order.length);
      whole.value = done;
      whole.setAttribute('aria-label', overall.textContent);
      filtering.hidden = !job.filtering;
    }
    const tick = () => {
      elapsed.textContent = tr('fmt.elapsed', { s: Math.max(0, Math.round((Date.now() - job.startedAt) / 1000)) });
    };
    tick();
    const timer = setInterval(tick, 1000);
    update();
    const el = h('section', { class: 'progress', 'aria-busy': 'true' },
      h('header', { class: 'page-head' }, h('h1', { text: jobTitle(job) }), stopBtn),
      h('div', { class: 'progress-head' }, h('span', { class: 'status-dot is-running', 'aria-hidden': 'true' }), overall, elapsed),
      whole,
      list, filtering,
      h('p', { class: 'hint', text: tr('progress.slow') }));
    return { el, job, update, destroy: () => clearInterval(timer) };
  }

  /** A search that is done, while the results it sent before this page was there are asked for again. */
  function loadingView(job) {
    const retry = () => {
      job.loadError = null;
      fetchItems(job);
      jobChanged(job);
    };
    const status = h('p', { class: 'muted loading-line', role: 'status' });
    const update = () => {
      status.textContent = tr('results.loading', { count: job.received, total: job.total || 0 });
    };
    update();
    const failedNow = job.loadError ? [
      callout('error', tr('error.title'), h('p', { text: errorText(job.loadError) })),
      h('p', { class: 'actions' }, button(tr('common.retry'), retry, 'btn primary')),
    ] : null;
    const el = h('section', {}, h('header', { class: 'page-head' }, h('h1', { text: jobTitle(job) })), failedNow || status);
    if (!job.loadError && !job.fetching) fetchItems(job);
    return { el, job, update };
  }

  function backToForm(mode) {
    return button(tr('common.back'), () => go(MODE_ROUTE[mode]));
  }

  const again = (mode, request) => () => startSearch(mode, request).catch((e) => alertNow(errorText(e)));

  /** A view that says one thing: an icon, a heading, what happened, and what can be done. */
  function statePage(kind, title, ...body) {
    const which = { error: 'error', stopped: 'stop', success: 'success', empty: 'search' }[kind] || 'info';
    return h('section', { class: `state-page is-${kind}` },
      h('div', { class: 'state-icon' }, icon(which)),
      h('div', { class: 'state-body' }, h('h1', { text: title }), ...body));
  }

  function failedView(job) {
    const el = statePage('error', tr('error.title'),
      h('p', { class: 'lead', text: job.error ? tr('progress.failedBecause', { message: job.error }) : tr('error.unexpected') }),
      oldLanguage(job, !!job.error),
      h('p', { class: 'actions' },
        button(tr('common.retry'), again(job.mode, job.request), 'btn primary'),
        backToForm(job.mode)));
    return { el, job };
  }

  function stoppedView(job) {
    const el = statePage('stopped', tr('progress.stopped.title'),
      h('p', { class: 'lead', text: tr('progress.stopped.body') }),
      h('p', { class: 'actions' },
        button(tr('common.searchAgain'), again(job.mode, job.request), 'btn primary'),
        backToForm(job.mode)));
    return { el, job };
  }

  /**
   * That what the library said of a job -- its notes, why it failed -- is in the language it spoke
   * when the job was made, when that is not the one it speaks now; null when it is, or when
   * nothing it said is shown (`said`).
   */
  function oldLanguage(job, said) {
    if (!said || !job || !job.lang || !state.locale || job.lang === state.locale) return null;
    return h('p', { class: 'hint old-language', text: tr('results.oldLanguage') });
  }

  /** Places that could not be searched, and what each place and the search had to say, in words and under Details. */
  function searchNotices(summary, job) {
    const per = (summary && summary.perSource) || [];
    const failed = per.filter((s) => s.error);
    const notes = per.filter((s) => (s.notes || []).length);
    const general = (summary && summary.notes) || [];
    const out = h('div', { class: 'notices' });
    if (failed.length) {
      out.append(callout('warn', tr('results.failedPlaces', { count: failed.length }),
        h('ul', {}, failed.map((s) => h('li', {}, h('strong', { text: sourceLabel(s.id, s.label) }), ': ', String(s.error))))));
    }
    if (notes.length || general.length) {
      out.append(h('details', { class: 'notes' }, h('summary', {}, icon('chevron', 'more-chevron'), h('span', { text: tr('results.notes') })),
        h('ul', {},
          general.map((n) => h('li', { text: String(n) })),
          notes.flatMap((s) => s.notes.map((n) => h('li', {}, h('strong', { text: sourceLabel(s.id, s.label) }), ': ', String(n)))))));
    }
    const lang = oldLanguage(job, failed.length || notes.length || general.length);
    if (lang) out.append(lang);
    return out;
  }

  // ---- results: files ------------------------------------------------------------------------

  /** The heading of a view of results, what was found, and a way to a new search in its form. */
  function resultsHead(title, mode, ...below) {
    return h('header', { class: 'page-head' },
      h('div', { class: 'page-title' }, h('h1', { text: title }), ...below),
      button(tr('common.newSearch'), () => go(MODE_ROUTE[mode]), 'btn'));
  }

  /** The icon of a kind of file, for the eye: a folder, a picture, a video, or a page. */
  function fileIcon(c) {
    if (c && c.isDir) return 'folder';
    const m = mediaOf(c);
    return m === 'image' ? 'photo' : m === 'video' ? 'video' : 'file';
  }

  /**
   * What a search by name found, by file or as every copy. The filters -- only what is gone now,
   * the dates, the folder it was in -- work on what the page holds, and say how many copies each
   * hides, with a way to show them. `saved` is what the view held when it is made again in
   * another language: the choices, how many were shown, which files had their other copies
   * open, and the copy in the preview.
   */
  function resultsView(job, saved) {
    const r = job.request || {};
    if (!job.items.length) return emptyResults(job);
    const s = saved || {};
    const ctl = {
      view: s.view === 'copies' ? 'copies' : 'files', sort: s.sort || 'newest', q: s.q || '',
      deletedOnly: s.deletedOnly !== undefined ? !!s.deletedOnly : !!r.deletedOnly, allDates: !!s.allDates, allPlaces: !!s.allPlaces,
      rows: [], shown: 0, opener: null, open: new Set(s.open || []), preview: null,
    };
    const title = r.name ? tr('results.title.name', { name: r.name })
      : r.containing ? tr('results.title.containing', { text: r.containing }) : tr('results.title.type', { type: typeWords(r.types) });
    const summaryEl = h('p', { class: 'summary', role: 'status' });
    const list = h('div', { class: 'result-list' });
    // Its words say how many more, so they are put in with the count, by showMore().
    const more = button('', () => showMore(), 'btn more-button');
    more.hidden = true;
    const hiddenNote = h('div', { class: 'hidden-note' });

    const viewFiles = button(tr('results.view.files'), () => setView('files'), 'btn seg');
    const viewList = button(tr('results.view.list'), () => setView('copies'), 'btn seg');
    const sort = select(tr('results.sort.label'), [
      ['newest', tr('results.sort.newest')], ['oldest', tr('results.sort.oldest')],
      ['name', tr('results.sort.name')], ['size', tr('results.sort.size')],
    ], ctl.sort, (v) => {
      ctl.sort = v;
      render();
    });
    const filterId = nextId('filter');
    const filter = h('input', { type: 'search', id: filterId, class: 'input small', value: ctl.q, autocomplete: 'off', spellcheck: 'false' });
    let filterTimer = null;
    filter.addEventListener('input', () => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        ctl.q = filter.value.trim();
        render();
      }, 200);
    });
    const toggle = (label, key, on) => {
      const line = switchLine(label, on, null, true);
      const count = h('span', { class: 'muted count' });
      line.text.append(count);
      line.input.addEventListener('change', () => {
        ctl[key] = line.input.checked;
        render();
      });
      return { ...line, count };
    };
    const deleted = toggle(tr('results.deletedOnly'), 'deletedOnly', ctl.deletedOnly);
    const dates = toggle(tr('results.allDates'), 'allDates', ctl.allDates);
    const places = toggle(tr('results.allPlaces', { folder: r.where || '' }), 'allPlaces', ctl.allPlaces);
    const toolbar = h('div', { class: 'toolbar' },
      h('div', { class: 'segmented', role: 'group', 'aria-label': tr('results.view.label') }, viewFiles, viewList),
      sort.el,
      h('span', { class: 'select' }, h('label', { for: filterId, text: tr('results.filter.label') }), filter),
      h('div', { class: 'toggles' }, deleted.el, r.since != null ? dates.el : null, r.where ? places.el : null));

    const pane = h('aside', { class: 'preview-pane', hidden: true, 'aria-label': tr('preview.title') });
    const mainCol = h('section', { class: 'results-main' },
      resultsHead(title, 'name', summaryEl), searchNotices(job.summary, job), toolbar, hiddenNote, list, h('p', { class: 'more-row' }, more));
    const el = h('div', { class: 'results-layout' }, mainCol, pane);
    pane.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePreview();
    });

    function setView(v) {
      ctl.view = v;
      viewFiles.setAttribute('aria-pressed', String(v === 'files'));
      viewList.setAttribute('aria-pressed', String(v === 'copies'));
      render();
    }

    function openPreview(copy, opener, tab, focus = true) {
      ctl.opener = opener;
      if (ctl.preview) ctl.preview.panel.destroy();
      pane.textContent = '';
      const p = previewPanel(copy, { onClose: closePreview, tab });
      ctl.preview = { uid: uidOf(copy), panel: p };
      pane.append(p.el);
      pane.hidden = false;
      el.classList.add('with-preview');
      if (focus) p.focus();
    }

    function closePreview() {
      if (ctl.preview) ctl.preview.panel.destroy();
      ctl.preview = null;
      pane.hidden = true;
      pane.textContent = '';
      el.classList.remove('with-preview');
      if (ctl.opener && ctl.opener.isConnected) ctl.opener.focus();
    }

    const actions = (c) => h('span', { class: 'row-actions' },
      c.isDir || tierOf(c) === 'gone' ? null : button(tr('results.preview'), (e) => openPreview(c, e.currentTarget), 'btn small'),
      c.isDir ? button(tr('results.about'), (e) => openPreview(c, e.currentTarget), 'btn small') : null,
      restoreButton(c));

    /** Where a file was, in words, when its folder, or its name too, is not known. */
    function whereText(g) {
      if (g.folder) return pathText(g.folder);
      if (g.name) return tr('results.folderUnknown');
      return g.best.ext ? tr('results.nameUnknownLong', { ext: formatName(g.best.ext) }) : tr('results.nameUnknown');
    }

    function fileCard(g) {
      const best = g.best;
      const others = g.versions.filter((c) => c !== best);
      const titleId = nextId('file');
      const card = h('article', { class: 'file-card', 'aria-labelledby': titleId },
        h('div', { class: 'file-head' },
          h('span', { class: 'file-icon' }, icon(fileIcon(best))),
          h('div', { class: 'file-title' },
            h('h2', { id: titleId, class: 'file-name' }, nameText(g.name || tr('results.nameUnknown'))),
            h('p', { class: 'file-where' }, whereText(g))),
          h('p', { class: 'badges file-badges' },
            g.isDir ? badge('tier-folder', TIER_ICON.folder, tr('tier.folder')) : null, stateBadge(g.state))),
        h('div', { class: 'best' },
          h('p', { class: 'best-line' },
            h('span', { class: 'best-label', text: tr('results.best') }), tierBadge(best), h('span', { class: 'found', text: foundIn(best) })),
          h('p', { class: 'meta', text: metaLine(best) }),
          h('p', { class: 'actions' }, actions(best), g.isDir ? rebuildFromHere(best) : null)));
      if (g.newer) {
        const when = fmtWhen(whenOf(g.newer));
        const said = tierOf(g.newer) === 'draft'
          ? tr('results.newerDraft', { when }) : tr('results.newerOther', { when, tier: tierText(g.newer) });
        card.append(callout('warn', null, h('p', { text: said }), h('p', { class: 'actions' }, actions(g.newer))));
      }
      if (others.length) card.append(versions(others, g.key));
      return card;
    }

    function versions(others, key) {
      const tableId = nextId('ver');
      const open = ctl.open.has(key);
      const table = h('div', { class: 'table-wrap', id: tableId, hidden: !open }, copyTable(others, false));
      const btn = h('button', { type: 'button', class: 'btn quiet disclosure', 'aria-expanded': String(open), 'aria-controls': tableId },
        icon('chevron', 'disclosure-chevron'), h('span', { text: tr('results.versions', { count: others.length }) }));
      btn.addEventListener('click', () => {
        const now = table.hidden;
        table.hidden = !now;
        btn.setAttribute('aria-expanded', String(now));
        if (now) ctl.open.add(key);
        else ctl.open.delete(key);
      });
      return h('div', { class: 'versions' }, btn, table);
    }

    function copyRow(c, full) {
      const was = c.path ? pathText(c.path) : nameOf(c) ? tr('results.nameOnly', { name: nameOf(c) }) : tr('results.nameUnknown');
      return h('tr', {},
        full ? h('td', { class: 'mono', text: c.id || uidOf(c).slice(0, 8) }) : null,
        h('td', { class: 'when-cell', text: fmtWhen(whenOf(c)) }),
        h('td', { class: 'found-cell', text: foundIn(c) }),
        h('td', {}, tierBadge(c)),
        h('td', { class: 'num', text: c.isDir ? '' : fmtSize(c.size) }),
        full ? h('td', {}, stateBadge(c.state)) : null,
        full ? h('td', { class: 'path-cell' }, was) : null,
        h('td', { class: 'actions-cell' }, actions(c)));
    }

    function copyTable(copies, full) {
      const th = (key, cls) => h('th', { scope: 'col', class: cls || null, text: tr(key) });
      const head = h('tr', {}, full ? th('results.id') : null, th('results.when'), th('results.foundIn'), th('results.quality'),
        th('results.size', 'num'), full ? th('results.state') : null, full ? th('results.path') : null,
        h('th', { scope: 'col' }, h('span', { class: 'sr-only', text: tr('results.actions') })));
      return h('table', { class: full ? 'copies full' : 'copies' }, h('thead', {}, head), h('tbody', {}, copies.map((c) => copyRow(c, full))));
    }

    function showHidden(f) {
      hiddenNote.textContent = '';
      const hidden = f.hidden;
      const say = (n) => (n ? ` ${tr('results.hiddenCount', { count: n })}` : '');
      deleted.count.textContent = ctl.deletedOnly ? say(hidden.notDeleted) : '';
      dates.count.textContent = ctl.allDates ? '' : say(hidden.outsideDates);
      places.count.textContent = ctl.allPlaces ? '' : say(hidden.elsewhere);
      const total = hidden.notDeleted + hidden.outsideDates + hidden.elsewhere;
      if (!f.kept.length && total && !ctl.q) {
        hiddenNote.append(callout('info', null, h('p', { text: tr('results.allHidden', { count: total }) }),
          h('p', { class: 'actions' },
            hidden.notDeleted ? button(tr('results.showNotDeleted'), () => deleted.input.click()) : null,
            hidden.outsideDates ? button(tr('results.allDates'), () => dates.input.click()) : null,
            hidden.elsewhere ? button(tr('results.allPlaces', { folder: r.where || '' }), () => places.input.click()) : null)));
      }
      if (r.since != null && !ctl.allDates && f.undated) {
        hiddenNote.append(h('p', { class: 'hint', text: tr('results.undatedKept', { count: f.undated }) }));
      }
    }

    function render() {
      const f = filterResults(job.items, {
        deletedOnly: ctl.deletedOnly, since: r.since, allDates: ctl.allDates, where: r.where, allPlaces: ctl.allPlaces, q: ctl.q,
      });
      const groups = groupFiles(f.kept);
      ctl.rows = ctl.view === 'files' ? sortRows(groups, ctl.sort) : sortRows(f.kept, ctl.sort);
      const files = tr('results.files', { count: groups.length });
      summaryEl.textContent = tr('results.summary', { files, copies: tr('results.copies', { count: f.kept.length }) });
      showHidden(f);
      list.textContent = '';
      if (!f.kept.length && ctl.q) list.append(h('p', { class: 'muted no-match', text: tr('results.noMatch') }));
      if (ctl.view === 'copies' && ctl.rows.length) list.append(h('div', { class: 'table-wrap' }, copyTable([], true)));
      ctl.shown = 0;
      showMore();
    }

    function showMore() {
      const next = ctl.rows.slice(ctl.shown, ctl.shown + PAGE);
      if (ctl.view === 'files') add(list, next.map(fileCard));
      else {
        const tbody = $('table.copies tbody', list);
        if (tbody) add(tbody, next.map((c) => copyRow(c, true)));
      }
      ctl.shown += next.length;
      const left = ctl.rows.length - ctl.shown;
      more.hidden = left <= 0;
      more.textContent = tr('results.showMore', { count: Math.min(PAGE, Math.max(0, left)) });
    }

    viewFiles.setAttribute('aria-pressed', String(ctl.view === 'files'));
    viewList.setAttribute('aria-pressed', String(ctl.view === 'copies'));
    render();
    while (ctl.shown < (s.shown || 0) && ctl.shown < ctl.rows.length) showMore();
    if (s.preview) {
      const c = job.items.find((x) => uidOf(x) === s.preview.uid);
      if (c) openPreview(c, null, s.preview.tab, false);
    }
    return {
      el,
      job,
      save: () => ({
        view: ctl.view, sort: ctl.sort, q: filter.value.trim(), deletedOnly: ctl.deletedOnly, allDates: ctl.allDates,
        allPlaces: ctl.allPlaces, shown: ctl.shown, open: [...ctl.open],
        preview: ctl.preview ? { uid: ctl.preview.uid, tab: ctl.preview.panel.tab() } : null,
      }),
      destroy() {
        clearTimeout(filterTimer);
        if (ctl.preview) ctl.preview.panel.destroy();
      },
    };
  }

  function foundIn(c) {
    const kind = kindLabel(c.kind, c.kindLabel);
    return c.copies > 1 ? tr('results.foundInMany', { kind, count: c.copies - 1 }) : kind;
  }

  function metaLine(c) {
    const parts = [timeText(c)];
    if (!c.isDir) parts.push(fmtSize(c.size));
    if (c.width && c.height) parts.push(tr('fmt.dimensions', { w: c.width, h: c.height }));
    return parts.join(' · ');
  }

  function restoreButton(c) {
    if (tierOf(c) === 'gone') return null;
    return button(tr('results.restore'), (e) => openRestoreDialog({ copies: [c], opener: e.currentTarget }), 'btn small');
  }

  /** A deleted folder's copy: bring back everything that was ever below it, from every place. */
  function rebuildFromHere(c) {
    if (!c.path) return null;
    return button(tr('results.rebuildFolder'), () => prefill('folder', { folder: c.path }), 'btn small quiet');
  }

  // ---- nothing found -------------------------------------------------------------------------

  function emptyResults(job) {
    return { el: emptyView(job), job };
  }

  /** Why a search found nothing, what to try next, and where else a copy may be. */
  function emptyView(job) {
    const r = job.request || {};
    const per = (job.summary && job.summary.perSource) || [];
    const failed = per.filter((s) => s.error);
    const mode = job.mode;
    let title;
    if (mode === 'folder') title = tr('empty.folder.title', { folder: job.summary.folder || r.folder || '' });
    else if (mode === 'media') title = tr('empty.media.title');
    else if (r.name) title = tr('empty.name.title', { name: r.name });
    else if (r.containing) title = tr('empty.containing.title', { text: r.containing });
    else title = tr('empty.type.title', { type: typeWords(r.types) });

    // Only what limited the search itself: the filters on the results page hide, they never make a search come back empty.
    const limited = r.sources && r.sources.length && r.sources.length < state.sources.length;
    const filters = [];
    if (mode === 'folder' && r.deletedOnly) filters.push(tr('empty.filter.deletedOnly'));
    if (mode === 'folder' && r.since != null) filters.push(tr('empty.filter.dates'));
    if (limited) filters.push(tr('empty.filter.sources', { count: r.sources.length }));
    if (mode === 'name' && r.types && r.types.length && (r.name || r.containing)) filters.push(tr('empty.filter.type'));
    if (state.locations.discover === false) filters.push(tr('empty.filter.onlyAdded'));

    const why = [tr('empty.why.nowhere', { count: per.length || state.sources.length })];
    if (failed.length) {
      why.push(tr('empty.why.failed', { count: failed.length, names: fmtList(failed.map((s) => sourceLabel(s.id, s.label))) }));
    }
    if (filters.length) why.push(tr('empty.why.filters', { filters: fmtList(filters) }));
    if (mode === 'media') why.push(tr('empty.why.ssd'), tr('empty.why.video'));
    else why.push(tr('empty.why.old'), tr('empty.why.neverOpened'));

    const tries = [];
    if (mode === 'name') {
      const part = partOfName(r.name);
      if (part) tries.push(button(tr('empty.try.shorter', { part }), again(mode, { ...r, name: part }), 'btn primary'));
      if (!r.containing) tries.push(button(tr('empty.try.containing'), () => prefill('name', {}, 'containing')));
    }
    if (filters.length) {
      const wider = { ...r, sources: null, types: mode === 'name' && (r.name || r.containing) ? [] : r.types };
      if (mode === 'folder') Object.assign(wider, { deletedOnly: false, since: null, sinceDate: '' });
      tries.push(button(tr('empty.try.noFilters'), () => {
        state.locations.discover = true;
        again(mode, wider)();
      }));
    }
    if (mode === 'name') tries.push(button(tr('empty.try.where'), () => go('folder')));
    tries.push(button(tr('empty.try.otherDisk'), () => go('sources')));

    const tryText = [];
    if (mode === 'folder') tryText.push(tr('empty.try.spelling'));
    if (mode === 'media') tryText.push(tr('empty.try.card'));

    const elsewhere = [tr('empty.else.cloud')];
    if (mode === 'media') elsewhere.push(tr('empty.else.phone'), tr('empty.else.chat'));
    elsewhere.push(tr('empty.else.email'), tr('empty.else.copies'));
    if (mode !== 'media') elsewhere.push(tr('empty.else.app'));

    const part = (key, ...body) => {
      const id = nextId('empty');
      return h('section', { class: 'panel empty-part', 'aria-labelledby': id }, h('h2', { id, text: tr(key) }), ...body);
    };
    return statePage('empty', title,
      part('empty.why', h('ul', {}, why.map((t) => h('li', { text: t })))),
      part('empty.try', tryText.map((t) => h('p', { text: t })), h('p', { class: 'actions wrap' }, tries)),
      part('empty.elsewhere', h('ul', {}, elsewhere.map((t) => h('li', { text: t })))),
      per.length ? h('details', { class: 'notes' }, h('summary', {}, icon('chevron', 'more-chevron'), h('span', { text: tr('empty.details') })),
        h('ul', {}, per.map((s) => h('li', {},
          h('strong', { text: sourceLabel(s.id, s.label) }), ': ',
          s.error ? tr('progress.failed') : s.skipped ? tr('progress.skipped') : tr('progress.found', { count: s.count || 0 }),
          s.error ? h('span', { class: 'muted', text: ` (${s.error})` }) : null,
          (s.notes || []).length ? h('ul', {}, s.notes.map((n) => h('li', { text: String(n) }))) : null)))) : null,
      oldLanguage(job, per.some((s) => s.error || (s.notes || []).length)),
      h('p', { class: 'actions' }, backToForm(mode)));
  }
  // ---- preview -------------------------------------------------------------------------------

  /**
   * Tabs in the ARIA pattern: arrow keys move between them, and each panel is built the first
   * time its tab is chosen, then kept as it was left -- where its text was scrolled, the encoding
   * chosen -- while another is shown; a video in one that is left is paused. `tabs` is
   * [{ label, render }]; `first` the tab to start on.
   */
  function tabsWidget(tabs, first) {
    const list = h('div', { class: 'tablist', role: 'tablist' });
    const panels = h('div', { class: 'tabpanels' });
    const made = new Map();
    const scrolled = new Map(); // panel -> [[element, top, left]], while it is out of sight
    let current = -1;
    const btns = tabs.map((t, i) => {
      const id = nextId('tab');
      const b = h('button', { type: 'button', role: 'tab', id, class: 'tab', 'aria-selected': 'false', tabindex: '-1', text: t.label });
      b.addEventListener('click', () => choose(i, false));
      list.append(b);
      return b;
    });
    list.addEventListener('keydown', (e) => {
      const at = btns.indexOf(document.activeElement);
      if (at < 0) return;
      const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: btns.length - 1 }[logicalKey(e.key)];
      if (to === undefined) return;
      e.preventDefault();
      choose((to + btns.length) % btns.length, true);
    });
    function choose(i, focus) {
      btns.forEach((b, j) => {
        b.setAttribute('aria-selected', String(i === j));
        b.setAttribute('tabindex', i === j ? '0' : '-1');
      });
      for (const [j, p] of made) {
        if (j === i || p.hidden) continue;
        scrolled.set(p, [p, ...$$('.text-view, .table-wrap', p)].map((x) => [x, x.scrollTop, x.scrollLeft]));
        pauseMedia(p);
        p.hidden = true;
      }
      if (!made.has(i)) {
        const panel = h('div', { role: 'tabpanel', id: nextId('panel'), class: 'tabpanel', tabindex: '0', 'aria-labelledby': btns[i].id });
        btns[i].setAttribute('aria-controls', panel.id);
        add(panel, [tabs[i].render()]);
        made.set(i, panel);
        panels.append(panel);
      }
      const shown = made.get(i);
      shown.hidden = false;
      for (const [x, y, left] of scrolled.get(shown) || []) x.scrollTo(left, y);
      scrolled.delete(shown);
      current = i;
      if (focus) btns[i].focus();
    }
    if (tabs.length) choose(Number.isInteger(first) && first >= 0 && first < tabs.length ? first : 0, false);
    return {
      el: h('div', { class: 'tabs' }, tabs.length > 1 ? list : null, panels),
      current: () => Math.max(0, current),
      destroy: () => pauseMedia(panels),
    };
  }

  // The formats whose first bytes sniff() always recognises, by what they are and, for those
  // several names stand for, which (a .mov and an .m4a are both MP4 inside, whatever sniff() calls
  // them): for these a name that disagrees with the bytes, or bytes that are nothing known, say
  // something about the copy.
  const WELL_KNOWN = new Map([
    ['.jpg', ['image', 'jpg']], ['.jpeg', ['image', 'jpg']], ['.png', ['image']], ['.gif', ['image']], ['.bmp', ['image']],
    ['.webp', ['image']], ['.heic', ['image', 'heic']], ['.heif', ['image', 'heic']], ['.avif', ['image']],
    ['.tif', ['image', 'tif']], ['.tiff', ['image', 'tif']], ['.mp4', ['video', 'mp4']], ['.m4v', ['video', 'mp4']],
    ['.mov', ['video', 'mp4']], ['.3gp', ['video', 'mp4']], ['.avi', ['video']], ['.mkv', ['video', 'mkv']],
    ['.webm', ['video', 'mkv']], ['.mp3', ['audio']], ['.wav', ['audio']], ['.flac', ['audio']], ['.m4a', ['audio', 'mp4']],
  ]);
  const familyOf = (ext) => (WELL_KNOWN.has(ext) ? WELL_KNOWN.get(ext)[1] || ext : ext);

  /**
   * What to say when a copy's name and its bytes disagree: a ".jpg" that holds a PDF or a PNG, or
   * bytes in no format known. Not for a smaller copy, whose own format is not its file's -- a
   * thumbnail of a video is a picture.
   */
  function mismatch(copy, a) {
    const name = nameOf(copy);
    const ext = extOfName(name);
    if (!name || !WELL_KNOWN.has(ext) || tierOf(copy) === 'derived') return null;
    if (!a.mediaType) return tr('preview.unknownContent', { ext });
    const is = String(a.ext || '').toLowerCase();
    if (a.mediaType !== WELL_KNOWN.get(ext)[0] || (is && familyOf(is) !== familyOf(ext))) {
      return tr('preview.extMismatch', { ext, format: formatName(a.ext || a.mediaType) });
    }
    return null;
  }

  const ENCODING_KEYS = Object.fromEntries(ENCODINGS);
  const encodingName = (label) => (own(ENCODING_KEYS, label) ? tr(ENCODING_KEYS[label]) : label);

  /**
   * One copy, shown the way its bytes allow -- a picture, a video, text, the bytes themselves --
   * with everything known about it. What the bytes are is asked of the server (copy/<uid>/about,
   * from their first 4 KB); the first page of them is read at once, for a copy that is nothing
   * but zeros says so before anything else: its data was erased.
   */
  /** A button that shows only an icon, named for assistive technology and in its tooltip. */
  function iconButton(iconName, label, onClick, cls) {
    return h('button', { type: 'button', class: `btn icon-only${cls ? ` ${cls}` : ''}`, 'aria-label': label, title: label, on: { click: onClick } },
      icon(iconName));
  }

  function previewPanel(copy, opts) {
    const o = opts || {};
    const uid = uidOf(copy);
    const t = tierOf(copy);
    const titleId = nextId('pv');
    const heading = h('h2', { id: titleId, class: 'preview-title', tabindex: '-1' }, nameText(nameOf(copy) || tr('results.nameUnknown')));
    const body = h('div', { class: 'preview-body' }, h('p', { class: 'muted', text: tr('preview.loading') }));
    const el = h('div', { class: 'preview', 'aria-labelledby': titleId },
      h('div', { class: 'preview-head' }, heading, o.onClose ? iconButton('close', tr('common.close'), o.onClose, 'small') : null),
      h('p', { class: 'badges' }, tierBadge(copy), stateBadge(copy.state)),
      t !== 'exact' ? h('p', { class: 'hint', text: tr(tierHelpKey(copy)) }) : null,
      body,
      o.noRestore ? null : h('p', { class: 'actions preview-actions' }, restoreButton(copy)));
    let tabs = null;
    const done = {
      el,
      focus: () => heading.focus(),
      /** The tab chosen, to open again on; the one asked for until the tabs are there. */
      tab: () => (tabs ? tabs.current() : o.tab || 0),
      destroy() {
        if (tabs) tabs.destroy();
        pauseMedia(el);
      },
    };
    const say = (kind, text) => callout(kind, null, h('p', { text }));
    if (copy.isDir || t === 'gone') {
      body.textContent = '';
      body.append(say('info', copy.isDir ? tr('preview.folder') : tr('preview.none.gone')), infoList(copy, null));
      return done;
    }
    (async () => {
      let a;
      let head;
      try {
        [a, head] = await Promise.all([aboutOf(uid), readBytes(uid, 0, HEX_PAGE)]);
      } catch (e) {
        body.textContent = '';
        body.append(say('error', e.status === 410 ? tr('empty.noLongerThere') : errorText(e)), infoList(copy, null));
        return;
      }
      body.textContent = '';
      const zero = isAllZero(head);
      if (zero) {
        const whole = a.size != null && a.size <= head.length;
        body.append(say('error', whole ? tr('preview.allZero') : tr('preview.startsZero', { size: fmtSize(head.length) })));
      } else if (a.size === 0 || (!head.length && a.size == null)) {
        body.append(say('info', tr('preview.empty')));
      }
      const said = zero ? null : mismatch(copy, a);
      if (said) body.append(say('warn', said));
      const list = [];
      if (a.preview === 'image') list.push({ label: tr('preview.tab.picture'), render: () => picturePanel(uid, copy, a) });
      if (a.preview === 'video') list.push({ label: tr('preview.tab.video'), render: () => videoPanel(uid, a) });
      if (a.preview === 'text') list.push({ label: tr('preview.tab.text'), render: () => textPanel(uid, a, head) });
      if (!a.preview && !zero && head.length) {
        body.append(say('info', tr('preview.none.format', { format: formatName(a.ext || copy.ext || extOfName(nameOf(copy))) })));
      }
      if (head.length) list.push({ label: tr('preview.tab.hex'), render: () => hexPanel(uid, a, head) });
      list.push({ label: tr('preview.tab.info'), render: () => infoList(copy, a) });
      tabs = tabsWidget(list, o.tab);
      body.append(tabs.el);
    })();
    return done;
  }

  function picturePanel(uid, copy, a) {
    const msg = h('p', { class: 'callout info', hidden: true });
    // Never draggable: dropping a picture into Explorer writes a file, past every check.
    const alt = tr('preview.imageAlt', { name: nameOf(copy) || tr('results.nameUnknown') });
    const img = h('img', { src: copyUrl(uid), alt, draggable: 'false', decoding: 'async' });
    img.addEventListener('error', () => {
      img.hidden = true;
      msg.hidden = false;
      msg.textContent = tr('preview.image.cannot', { format: formatName(a.ext) });
    });
    const dims = copy.width && copy.height ? tr('fmt.dimensions', { w: copy.width, h: copy.height }) : null;
    return h('div', {}, h('div', { class: 'media-frame' }, img), msg, dims ? h('p', { class: 'muted', text: dims }) : null);
  }

  /**
   * A player for a copy: without the Download item Chromium's controls have, remote playback or
   * picture-in-picture, and never draggable, so that the only way a copy leaves is Restore.
   */
  function player(uid) {
    return h('video', {
      src: copyUrl(uid), controls: true, preload: 'metadata', draggable: 'false',
      controlslist: 'nodownload noremoteplayback', disablepictureinpicture: true, disableremoteplayback: true,
    });
  }

  function videoPanel(uid, a) {
    const msg = h('p', { class: 'callout info', hidden: true });
    const video = player(uid);
    video.addEventListener('error', () => {
      video.hidden = true;
      msg.hidden = false;
      msg.textContent = tr('preview.video.cannot', { format: formatName(a.ext) });
    });
    return h('div', {}, h('div', { class: 'media-frame' }, video), msg);
  }

  /** A copy's text: its first TEXT_MAX bytes, decoded here in the encoding chosen, never parsed. */
  function textPanel(uid, a, head) {
    const pre = h('pre', { class: 'text-view', tabindex: '0', text: tr('preview.loading') });
    const notes = h('div');
    let bytes = null;
    let encoding = 'auto';
    const encSel = select(tr('preview.encoding.label'), ENCODINGS.map(([v, key]) => [v, tr(key)]), 'auto', (v) => {
      encoding = v;
      if (bytes) show();
    });
    const wrap = switchLine(tr('preview.wrap'), false, null, true);
    wrap.input.addEventListener('change', () => pre.classList.toggle('wrap', wrap.input.checked));
    function show() {
      const cut = a.size == null ? bytes.length >= TEXT_MAX : bytes.length < a.size;
      const d = decodeText(bytes, encoding, cut);
      pre.textContent = d.text;
      notes.textContent = '';
      const lines = [tr('preview.encoding', { encoding: encodingName(d.encoding) })];
      if (cut) lines.push(tr('preview.textTruncated', { shown: fmtSize(bytes.length), size: fmtSize(a.size) }));
      if (a.ext === '.svg') lines.push(tr('preview.svgAsText'));
      notes.append(h('p', { class: 'muted', text: lines.join(' · ') }));
    }
    (async () => {
      try {
        bytes = a.size != null && a.size <= head.length ? head : await readBytes(uid, 0, TEXT_MAX);
        show();
      } catch (e) {
        pre.textContent = '';
        notes.append(callout('error', null, h('p', { text: errorText(e) })));
      }
    })();
    return h('div', {}, h('div', { class: 'toolbar text-tools' }, encSel.el, wrap.el), notes, pre);
  }

  /** The bytes, a page at a time: first a sentence on what they start with, then the table. */
  function hexPanel(uid, a, head) {
    const size = a.size;
    let offset = 0;
    const magic = magicOf(head);
    const summary = h('p', {
      text: a.ext ? tr('preview.hexSummary', { magic, format: formatName(a.ext) }) : tr('preview.hexUnknown', { magic }),
    });
    const table = h('table', { class: 'hex' });
    const page = h('span', { class: 'muted', role: 'status' });
    const prev = button(tr('preview.hexPrev'), () => turn(-1), 'btn small');
    const next = button(tr('preview.hexNext'), () => turn(1), 'btn small');
    function render(bytes, at) {
      offset = at;
      table.textContent = '';
      const th = (key) => h('th', { scope: 'col', text: tr(key) });
      table.append(
        h('caption', { class: 'sr-only', text: tr('preview.hex.caption') }),
        h('thead', {}, h('tr', {}, th('preview.hex.offset'), th('preview.hex.bytes'), th('preview.hex.text'))),
        h('tbody', {}, hexRows(bytes, at).map((r) => h('tr', {},
          h('td', { class: 'mono', text: r.offset.toString(16).padStart(8, '0') }),
          h('td', { class: 'mono', text: r.hex }),
          h('td', { class: 'mono', text: r.ascii })))));
      const end = at + bytes.length;
      page.textContent = tr('preview.hexPage', { from: fmtNum(at), to: fmtNum(Math.max(at, end - 1)), size: fmtSize(size) });
      prev.disabled = at <= 0;
      next.disabled = bytes.length < HEX_PAGE || (size != null && end >= size);
    }
    async function turn(dir) {
      const at = Math.max(0, offset + dir * HEX_PAGE);
      try {
        render(await readBytes(uid, at, HEX_PAGE), at);
      } catch (e) {
        alertNow(errorText(e));
      }
    }
    render(head, 0);
    return h('div', {}, summary, h('div', { class: 'table-wrap' }, table), h('p', { class: 'actions' }, prev, page, next));
  }

  /** Everything known about a copy, as a list of terms. */
  function infoList(copy, a) {
    const dl = h('dl', { class: 'info' });
    const row = (key, ...value) => {
      if (!value.length || value.every((v) => v === null || v === undefined || v === '')) return;
      dl.append(h('dt', { text: tr(key) }), h('dd', {}, ...value));
    };
    const name = nameOf(copy);
    row('preview.info.path', copy.path ? pathText(copy.path)
      : name ? tr('results.nameOnly', { name }) : tr('results.nameUnknown'));
    row('preview.info.when', timeText(copy));
    if (!copy.isDir) row('preview.info.size', fmtSize(copy.size != null ? copy.size : a && a.size));
    if (copy.width && copy.height) row('preview.info.dimensions', tr('fmt.dimensions', { w: copy.width, h: copy.height }));
    if (a && a.ext) row('preview.info.format', tr('preview.info.formatIs', { format: formatName(a.ext) }));
    row('preview.info.quality', h('span', {}, tierBadge(copy)), h('span', { class: 'block', text: tr(tierHelpKey(copy)) }));
    const s = own(STATE_LABEL, copy.state || '') ? copy.state || '' : '';
    row('preview.info.state', h('span', { text: tr(STATE_LABEL[s]) }), h('span', { class: 'block muted', text: tr(STATE_HELP[s]) }));
    row('preview.info.foundIn', h('span', { text: kindLabel(copy.kind, copy.kindLabel) }),
      h('span', { class: 'block muted', text: kindHelp(copy.kind, sourceLabel(copy.source, copy.source)) }));
    const seen = (copy.seen || []).filter((k) => k !== copy.kind);
    if (seen.length) row('preview.info.alsoIn', fmtList(seen.map((k) => kindLabel(k))));
    row('preview.info.keptAt', copy.origin ? pathText(copy.origin) : null);
    row('preview.info.note', copy.note || null);
    row('preview.info.id', h('span', { class: 'mono', text: copy.id || uidOf(copy).slice(0, 8) }),
      h('span', { class: 'block muted', text: tr('preview.info.idHint') }));
    return dl;
  }

  /** A copy's preview in a dialog of its own, for the folder plan. */
  function previewDialog(copy, opener) {
    const dlg = h('dialog', { class: 'dialog wide preview-dialog' });
    const p = previewPanel(copy, { onClose: () => dlg.close(), noRestore: true });
    dlg.setAttribute('aria-labelledby', $('.preview-title', p.el).id);
    dlg.append(h('div', { class: 'dialog-body' }, p.el));
    showModal(dlg, opener, () => p.destroy());
    p.focus();
  }

  // ---- restore -------------------------------------------------------------------------------

  const SUGGEST_KEYS = {
    exeDrive: 'restore.suggest.exeDrive', otherDrive: 'restore.suggest.otherDrive',
    desktop: 'restore.suggest.desktop', home: 'restore.suggest.home',
  };

  /** The name the library gives a copy it writes, where that is simply its own: restore.js nameFor(). */
  const plainName = (c) => nameOf(c) || `recovered-${c.id || uidOf(c).slice(0, 8)}${c.ext || ''}`;

  /**
   * Where to put copies back, checked before anything is written. A folder a source reads from is
   * refused by the server, and said so here; the drive a lost file was on needs the person's word,
   * since writing there can overwrite what is still to be found. A folder on another drive is
   * suggested when there is one. For a folder plan (`rebuild`), the same, then the rebuild.
   */
  function openRestoreDialog({ copies = [], rebuild = null, opener = null }) {
    const titleId = nextId('dlg');
    const dlg = h('dialog', { class: 'dialog restore', 'aria-labelledby': titleId });
    let title;
    if (rebuild) title = tr('rebuild.dialogTitle', { folder: rebuild.folderName });
    else if (copies.length === 1) title = tr('restore.title.one', { name: nameOf(copies[0]) || tr('results.nameUnknown') });
    else title = tr('restore.title.many', { count: copies.length });
    const uids = copies.map(uidOf);
    const originals = rebuild ? [rebuild.folder] : copies.map((c) => c.path).filter(Boolean);
    const sizes = rebuild ? rebuild.sizes : copies.map((c) => (c.isDir ? null : c.size));
    const needed = sizes.reduce((n, s) => n + (Number(s) || 0), 0);
    const unknownSizes = sizes.some((s) => s == null);

    const input = pathInput('');
    const dest = field({ id: nextId('dest'), label: tr('restore.dest.label'), hint: pathHint('restore.dest.hint'), control: input });
    const drivesEl = h('div', { class: 'drives', role: 'group', 'aria-label': tr('restore.drives') });
    const suggestLine = h('div', { class: 'suggest' });
    const checks = h('div', { class: 'checks', role: 'status' });
    const confirm = checkLine(tr('dest.sameDrive.confirm'), false);
    confirm.el.hidden = true;
    const tierLines = h('div', { class: 'tier-lines' }, restoreTierLines(copies, rebuild));
    const progress = h('p', { class: 'muted', role: 'status', hidden: true });
    const cancelBtn = button(tr('common.cancel'), () => dlg.close());
    let submitLabel = tr('restore.submitMany', { count: copies.length });
    if (rebuild) submitLabel = tr('rebuild.submit', { count: rebuild.count });
    else if (copies.length === 1) submitLabel = tr('restore.submit');
    const submit = h('button', { type: 'submit', class: 'btn primary', text: submitLabel, disabled: true });
    const form = h('form', { class: 'dialog-form', novalidate: true },
      h('div', { class: 'dialog-body' },
        h('h2', { id: titleId, text: title }), dest.el, drivesEl, suggestLine, checks, confirm.el, tierLines, progress),
      h('div', { class: 'dialog-actions' }, cancelBtn, submit));
    dlg.append(form);

    let suggestion = null;
    let check = null;
    let checkSeq = 0;
    let timer = null;
    let writing = false;
    let drives = [];

    // Every change of folder is checked anew, and a word given for one folder is not taken for
    // another: the same-drive box is unticked again.
    function scheduleCheck(ms) {
      clearTimeout(timer);
      check = null;
      confirm.input.checked = false;
      gate();
      timer = setTimeout(runCheck, ms);
    }

    /**
     * How many of the items were on the drive of the folder checked: the server's count, by the
     * volume a folder is on, where it gives one; else by the drive letter of their paths; null
     * where neither can tell -- POSIX paths all start at "/".
     */
    function sameCount(c) {
      if (typeof c.sameDrive === 'number') return c.sameDrive;
      if (!c.root || c.root === '/') return null;
      if (rebuild) return sameRoot(rootOf(rebuild.folder), c.root) ? rebuild.count : 0;
      return onSameDrive(originals, c.root);
    }

    function gate() {
      const same = !!(check && check.ok && (check.same > 0 || check.device > 0));
      confirm.el.hidden = !same;
      const blocked = !check || !check.ok || check.full || (same && !confirm.input.checked);
      submit.disabled = writing || !input.value.trim() || !!blocked;
    }

    async function runCheck() {
      const to = input.value.trim();
      const seq = ++checkSeq;
      checks.textContent = '';
      dest.setError(null);
      if (!to) return gate();
      if (!isAbsolute(to)) {
        dest.setError(tr('dest.relative'));
        return gate();
      }
      checks.append(h('p', { class: 'muted', text: tr('dest.checking') }));
      let c;
      try {
        c = await post('api/check-folder', rebuild ? { to, plan: rebuild.job.id } : { to, uids });
      } catch (e) {
        if (seq !== checkSeq) return undefined;
        checks.textContent = '';
        checks.append(callout('error', null, h('p', { text: errorText(e) })));
        check = { ok: false };
        return gate();
      }
      if (seq !== checkSeq) return undefined;
      c.same = c.ok ? sameCount(c) : null;
      // Items read from a whole disk, whose letter cannot be told: any drive but Windows' and the
      // network's may be it.
      const shared = /^\\\\/.test(c.root || '') || drives.some((x) => sameRoot(x.root, c.root) && x.network);
      c.device = c.ok && !shared && Number(c.onDevice) > 0 && !sameRoot(c.root, rootOf(state.info.systemDrive)) ? Number(c.onDevice) : 0;
      c.full = !!(c.ok && c.free != null && needed > c.free);
      check = c;
      renderCheck(c);
      return gate();
    }

    function renderCheck(c) {
      checks.textContent = '';
      if (!c.ok) {
        checks.append(callout('error', tr('dest.refused.title'), h('p', { text: String(c.error || '') })));
        return;
      }
      if (c.same > 0) {
        const other = suggestion && suggestion.path && suggestion.root && !sameRoot(suggestion.root, c.root) ? suggestion : null;
        checks.append(callout('warn', tr('dest.sameDrive.title', { drive: c.root }),
          h('p', { text: tr('dest.sameDrive.body') }),
          copies.length > 1 || rebuild ? h('p', { text: tr('dest.sameDrive.many', { count: c.same }) }) : null,
          other ? h('p', {}, button(tr('restore.useSuggested', { path: other.path }), () => {
            input.value = other.path;
            scheduleCheck(0);
          })) : null));
      } else if (c.device > 0) {
        checks.append(callout('warn', tr('dest.onDevice.title'), h('p', { text: tr('dest.onDevice.body', { count: c.device }) })));
      } else if (c.same === null) {
        checks.append(callout('info', null, h('p', { text: tr('dest.sameDrive.unknown') })));
      } else if (sameRoot(c.root, rootOf(state.info.systemDrive))) {
        checks.append(callout('info', null, h('p', { text: tr('dest.systemDrive') })));
      }
      const d = drives.find((x) => sameRoot(x.root, c.root));
      if ((d && d.network) || /^\\\\/.test(c.root || '')) checks.append(callout('info', null, h('p', { text: tr('dest.network') })));
      const service = syncedBy(c.path);
      if (service) checks.append(callout('info', null, h('p', { text: tr('dest.cloud', { service }) })));
      const space = { needed: fmtSize(needed), free: fmtSize(c.free) };
      if (c.full) checks.append(callout('error', null, h('p', { text: tr('dest.noSpace', space) })));
      else if (c.free != null && needed) {
        checks.append(h('p', { class: 'muted', text: tr(unknownSizes ? 'dest.spaceAtLeast' : 'dest.space', space) }));
      }
      if (!c.exists) checks.append(h('p', { class: 'muted', text: tr('dest.newFolder') }));
      if (!rebuild && copies.length === 1 && ['exact', 'inexact', 'draft'].includes(tierOf(copies[0]))) {
        checks.append(h('p', { text: tr('restore.name', { name: plainName(copies[0]) }) }));
      }
    }

    function renderDrives() {
      drivesEl.textContent = '';
      const usable = drives.filter((d) => d.root && d.answering !== false && !d.error);
      if (usable.length < 2) return;
      drivesEl.append(h('span', { class: 'muted', text: `${tr('restore.drives')}:` }));
      for (const d of usable) {
        const marks = [];
        if (d.system) marks.push(tr('restore.drive.system'));
        if (originals.some((p) => sameRoot(rootOf(p), d.root))) marks.push(tr('restore.drive.original'));
        drivesEl.append(h('button', {
          type: 'button', class: 'btn small',
          on: {
            click: () => {
              input.value = joinPath(d.root, tr('restore.folderName'), stamp(Date.now()));
              scheduleCheck(0);
              input.focus();
            },
          },
        }, d.letter ? `${d.letter}:` : d.root,
        d.free != null ? h('span', { class: 'muted', text: ` ${tr('restore.driveFree', { free: fmtSize(d.free) })}` }) : null,
        marks.length ? h('span', { class: 'muted', text: ` (${marks.join(', ')})` }) : null));
      }
    }

    input.addEventListener('input', () => scheduleCheck(350));
    confirm.input.addEventListener('change', gate);

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (submit.disabled) return;
      writing = true;
      gate();
      submit.textContent = tr('restore.working');
      const to = input.value.trim();
      try {
        if (rebuild) {
          const res = await post('api/rebuild', { plan: rebuild.job.id, to, exclude: rebuild.exclude, include: rebuild.include });
          const job = adopt(res.job);
          job.mode = 'rebuild';
          job.request = { mode: 'rebuild', folder: rebuild.folder, to, files: rebuild.count };
          state.current.rebuild = job.id;
          writing = false;
          dlg.close();
          go('folder/done');
          return;
        }
        if (copies.length > 1) {
          progress.hidden = false;
          state.onRestoreProgress = (d) => {
            progress.textContent = tr('restore.progress', { done: d.done || 0, total: d.total || copies.length });
          };
        }
        const res = await post('api/restore', { uids, to });
        showDone(res, to);
      } catch (e) {
        writing = false;
        submit.textContent = submitLabel;
        checks.prepend(callout('error', tr('error.title'), h('p', { text: errorText(e) })));
        alertNow(errorText(e));
        gate();
      } finally {
        state.onRestoreProgress = null;
      }
    });

    function showDone(res, to) {
      writing = false;
      const results = res.results || [];
      const ok = results.filter((x) => x.ok);
      const bad = results.filter((x) => !x.ok);
      const byUid = new Map(copies.map((c) => [uidOf(c), c]));
      const doneTitleId = nextId('dlg');
      const doneBtn = button(tr('common.done'), () => dlg.close(), 'btn primary');
      const where = ok.length === 1 ? ok[0].path : res.to || to;
      let heading = tr('restore.done.none');
      if (ok.length === 1) heading = tr('restore.done.one');
      else if (ok.length) heading = tr('restore.done.many', { count: ok.length });
      const failure = (b) => h('li', {}, nameText(nameOf(byUid.get(b.uid)) || b.uid), ': ', errorText({ message: b.error, code: b.code }));
      const body = h('div', { class: 'dialog-body' },
        h('div', { class: `done-head${ok.length ? ' is-ok' : ' is-none'}` }, icon(ok.length ? 'success' : 'error'),
          h('h2', { id: doneTitleId, text: heading })),
        ok.length ? h('p', { class: 'done-path' }, pathText(where)) : null,
        ok.length ? h('p', { class: 'actions' }, copyButton(where)) : null,
        bad.length ? callout('warn', tr('restore.done.failed', { count: bad.length }), h('ul', {}, bad.map(failure))) : null,
        ok.length ? h('p', { class: 'hint', text: tr('restore.openWarning') }) : null);
      dlg.setAttribute('aria-labelledby', doneTitleId);
      form.replaceWith(h('div', { class: 'dialog-form' }, body, h('div', { class: 'dialog-actions' }, doneBtn)));
      doneBtn.focus();
      announce(heading);
    }

    dlg.addEventListener('cancel', (e) => {
      if (writing) e.preventDefault();
    });
    showModal(dlg, opener, () => {
      clearTimeout(timer);
      state.onRestoreProgress = null;
    });
    input.focus();
    (async () => {
      try {
        drives = ((await get('api/drives')) || {}).drives || [];
      } catch (_) {
        drives = [];
      }
      const avoid = [].concat((state.locations.dirs || {}).removable || []);
      const pick = (desktop) => suggestDestination({ drives, info: state.info, originals, avoid, needed, at: Date.now(), desktop });
      suggestion = pick(false);
      if (suggestion.reason === 'home' && state.info.home) {
        try {
          const c = await post('api/check-folder', { to: joinPath(state.info.home, 'Desktop') });
          if (c && c.ok && c.exists) suggestion = pick(true);
        } catch (_) {
          /* the home folder, then */
        }
      }
      if (!dlg.isConnected) return;
      renderDrives();
      if (suggestion.path) {
        suggestLine.append(h('p', { class: 'hint', text: tr(SUGGEST_KEYS[suggestion.reason], { drive: suggestion.root || '' }) }));
        if (!input.value.trim()) {
          input.value = suggestion.path;
          input.select();
        }
      }
      scheduleCheck(0);
    })();
  }

  /** What each kind of copy becomes when written, said before it is. */
  function restoreTierLines(copies, rebuild) {
    if (rebuild) {
      return rebuild.leftOutIn ? h('p', { class: 'hint', text: tr('restore.many.leftOut', { count: rebuild.leftOutIn }) }) : null;
    }
    if (copies.length === 1) {
      const c = copies[0];
      const t = tierOf(c);
      if (t === 'derived') {
        const size = c.width && c.height ? `${c.width}x${c.height}` : null;
        return h('p', { class: 'hint', text: size ? tr('restore.nameSmaller', { size }) : tr('restore.nameSmallerNoSize') });
      }
      if (t === 'draft') return h('p', { class: 'hint', text: tr('restore.nameDraft') });
      if (t === 'inexact') return h('p', { class: 'hint', text: tr(FROM_DISK.test(String(c.kind || '')) ? 'restore.nameNearDisk' : 'restore.nameNear') });
      if (t === 'unverified') return h('p', { class: 'hint', text: tr('restore.nameIncomplete') });
      if (t === 'folder') return h('p', { class: 'hint', text: tr('restore.folder', { name: nameOf(c) || tr('results.nameUnknown') }) });
      return null;
    }
    const n = (t) => copies.filter((c) => tierOf(c) === t).length;
    return [
      n('derived') ? h('p', { class: 'hint', text: tr('restore.many.derived', { count: n('derived') }) }) : null,
      n('unverified') ? h('p', { class: 'hint', text: tr('restore.many.unverified', { count: n('unverified') }) }) : null,
      n('draft') ? h('p', { class: 'hint', text: tr('restore.many.draft', { count: n('draft') }) }) : null,
    ];
  }

  // ---- photos and videos ---------------------------------------------------------------------

  function tileLabel(it) {
    const t = whenOf(it);
    const params = {
      type: tr(mediaOf(it) === 'video' ? 'grid.type.video' : 'grid.type.photo'),
      name: nameOf(it), when: t === null ? tr('grid.noDate') : fmtDay(t), tier: tierText(it), size: fmtSize(it.size),
    };
    return params.name ? tr('grid.tileLabelNamed', params) : tr('grid.tileLabel', params);
  }

  /**
   * Thumbnails for the grid: loaded only as tiles come near the screen, at most four at a time,
   * and kept small. A picture is decoded at no more than THUMB_PX wide and kept as a small
   * compressed image, so a grid of thousands does not hold thousands of full-size bitmaps; a
   * video is shown by its frame at 0.1 s. What the browser cannot show -- HEIC, a camera's RAW,
   * AVI -- says "No preview" with its format, from what the server made of its first bytes.
   */
  function thumbLoader(itemOf) {
    const queue = [];
    const urls = [];
    let active = 0;
    let dead = false;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        queue.push(e.target);
      }
      pump();
    }, { rootMargin: '600px 0px' });

    function pump() {
      while (!dead && active < THUMBS_AT_ONCE && queue.length) {
        const tile = queue.shift();
        active++;
        load(tile).catch(() => noThumb(tile, null)).finally(() => {
          active--;
          pump();
        });
      }
    }

    function show(tile, blob) {
      if (dead || !tile.isConnected) return;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const box = $('.thumb', tile);
      box.textContent = '';
      box.append(h('img', { src: url, alt: '', draggable: 'false' }));
    }

    function noThumb(tile, a) {
      if (dead || !tile.isConnected) return;
      const it = itemOf(tile);
      const ext = (a && a.ext) || (it && (it.ext || extOfName(nameOf(it))));
      const box = $('.thumb', tile);
      box.textContent = '';
      box.append(h('span', { class: 'nothumb' }, tr('grid.noThumb'), ext ? h('span', { class: 'fmt', text: formatName(ext) }) : null));
    }

    /**
     * A bitmap drawn on a canvas at no more than THUMB_PX wide, turned as an Exif orientation
     * (1 to 8) says: 2, 4, 5 and 7 are mirrored, and 5 to 8 are a quarter turn, which swaps its sides.
     */
    function oriented(bitmap, orientation) {
      const o = orientation >= 1 && orientation <= 8 ? orientation : 1;
      const turned = o >= 5;
      const scale = Math.min(1, THUMB_PX / (turned ? bitmap.height : bitmap.width));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const ht = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = turned ? ht : w;
      canvas.height = turned ? w : ht;
      const ctx = canvas.getContext('2d');
      const MATRIX = {
        1: [1, 0, 0, 1, 0, 0], 2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, ht], 4: [1, 0, 0, -1, 0, ht],
        5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, ht, 0], 7: [0, -1, -1, 0, ht, w], 8: [0, -1, 1, 0, 0, w],
      };
      ctx.transform(...MATRIX[o]);
      ctx.drawImage(bitmap, 0, 0, w, ht);
      if (bitmap.close) bitmap.close();
      return canvas;
    }

    // Small and compressed: WebP where the browser writes it, PNG where not.
    const toBlob = (canvas) => new Promise((res) => {
      canvas.toBlob((b) => (b ? res(b) : canvas.toBlob(res, 'image/png')), 'image/webp', 0.85);
    });

    async function decode(blob, it) {
      const small = (it.width && it.width <= THUMB_PX) || blob.size < 256 * 1024;
      if (!small) {
        try {
          return await createImageBitmap(blob, { resizeWidth: THUMB_PX, resizeQuality: 'medium' });
        } catch (_) {
          /* a browser without resizing: decode whole, and scale while drawing */
        }
      }
      return createImageBitmap(blob);
    }

    async function load(tile) {
      const it = itemOf(tile);
      if (!it) return undefined;
      const uid = uidOf(it);
      const a = await aboutOf(uid);
      if (dead) return undefined;
      if (a.preview === 'video') return videoFrame(tile, uid, a);
      if (a.preview !== 'image') return noThumb(tile, a);
      // A photo from a camera or a phone carries a small picture of itself, which the server
      // takes from its first 64 KiB: far less to read than the photo, off a card or a shadow copy.
      if (a.ext === '.jpg' && (a.size == null || a.size > OWN_THUMB_OVER)) {
        const own = await fetch(`${copyUrl(uid)}/thumb`, { cache: 'no-store', credentials: 'same-origin' }).catch(() => null);
        if (dead) return undefined;
        if (own && own.ok) {
          try {
            const bitmap = await createImageBitmap(await own.blob());
            return show(tile, await toBlob(oriented(bitmap, Number(own.headers.get('X-Solarljos-Orientation')) || 1)));
          } catch (_) {
            /* not a picture after all: the photo itself */
          }
        }
      }
      if (a.size != null && a.size > THUMB_MAX_BYTES) return noThumb(tile, a);
      const res = await fetch(copyUrl(uid), { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) return noThumb(tile, a);
      const bitmap = await decode(await res.blob(), it);
      const scale = Math.min(1, THUMB_PX / bitmap.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (bitmap.close) bitmap.close();
      return show(tile, await toBlob(canvas));
    }

    function videoFrame(tile, uid, a) {
      return new Promise((resolve) => {
        const v = document.createElement('video');
        v.muted = true;
        v.preload = 'metadata';
        let finished = false;
        const end = async (ok) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          try {
            if (ok && v.videoWidth) {
              const scale = Math.min(1, THUMB_PX / v.videoWidth);
              const canvas = document.createElement('canvas');
              canvas.width = Math.round(v.videoWidth * scale);
              canvas.height = Math.round(v.videoHeight * scale);
              canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
              show(tile, await toBlob(canvas));
            } else {
              noThumb(tile, a);
            }
          } catch (_) {
            noThumb(tile, a);
          }
          v.removeAttribute('src');
          v.load();
          resolve();
        };
        const timer = setTimeout(() => end(false), 10000);
        v.addEventListener('loadedmetadata', () => {
          try {
            v.currentTime = Math.min(0.1, (v.duration || 1) / 2);
          } catch (_) {
            end(false);
          }
        });
        v.addEventListener('seeked', () => end(true));
        v.addEventListener('error', () => end(false));
        v.src = copyUrl(uid);
      });
    }

    return {
      observe: (tile) => io.observe(tile),
      /** Lets go of every tile so far, for a grid drawn anew; loads under way find their tile gone. */
      reset() {
        queue.length = 0;
        io.disconnect();
        urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
      },
      destroy() {
        dead = true;
        io.disconnect();
        urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
      },
    };
  }

  /**
   * The photo and video grid. Tiles are grouped by the month of their date, newest first, with
   * copies that carry no date in a group of their own at the end -- never hidden, whatever the
   * dates chosen, since a thumbnail whose file is unknown has no date and may be the one photo
   * left. The grid is one composite control (the ARIA grid pattern): Tab enters it once, arrow
   * keys move, Space selects, Shift+Space selects a range, Enter opens. `saved` is what the view
   * held when it is made again in another language: its choices, how many tiles were shown, what
   * was selected.
   */
  function gridView(job, saved) {
    const r = job.request || {};
    if (!job.items.length) return emptyResults(job);
    const s = saved || {};
    const ctl = {
      smaller: s.smaller !== undefined ? !!s.smaller : r.includeSmaller !== false, hideTiny: s.hideTiny !== undefined ? !!s.hideTiny : true,
      source: s.source || '', allDates: !!s.allDates, allPlaces: !!s.allPlaces,
      list: [], shown: 0, cols: 4, selected: new Map(), anchor: null, focus: null,
    };
    const byUid = new Map(job.items.map((it) => [uidOf(it), it]));
    for (const uid of s.selected || []) if (byUid.has(uid)) ctl.selected.set(uid, byUid.get(uid));
    const tileOf = new Map(); // uid -> tile
    const itemOfTile = new WeakMap();
    const groups = new Map(); // month|'none' -> { section, grid, rows, tiles }
    const thumbs = thumbLoader((tile) => itemOfTile.get(tile));

    const summaryEl = h('p', { class: 'summary', role: 'status' });
    const hiddenNote = h('div', { class: 'hidden-note' });
    const groupsEl = h('div', { class: 'grid-groups' });
    // Its words say how many more, so they are put in with the count, by showMore().
    const more = button('', () => showMore(), 'btn more-button');
    more.hidden = true;
    const sentinel = h('div', { class: 'sentinel', 'aria-hidden': 'true' });

    const sizes = [['full', tr('grid.filter.full')], ['smaller', tr('grid.filter.smaller')]];
    const size = radioGroup(tr('grid.filter.size'), sizes, ctl.smaller ? 'smaller' : 'full');
    size.el.classList.add('inline');
    size.onChange(() => {
      ctl.smaller = size.value() === 'smaller';
      render();
    });
    const tiny = switchLine(tr('grid.filter.minSize', { px: TINY_PX }), ctl.hideTiny, null, true);
    tiny.input.addEventListener('change', () => {
      ctl.hideTiny = tiny.input.checked;
      render();
    });
    const hasDates = r.from != null || r.to != null;
    const dates = switchLine(tr('results.allDates'), ctl.allDates, null, true);
    dates.input.addEventListener('change', () => {
      ctl.allDates = dates.input.checked;
      render();
    });
    const places = switchLine(tr('results.allPlaces', { folder: r.where || '' }), ctl.allPlaces, null, true);
    places.input.addEventListener('change', () => {
      ctl.allPlaces = places.input.checked;
      render();
    });
    const found = ((job.summary && job.summary.perSource) || []).filter((x) => x.count > 0);
    const froms = [['', tr('grid.filter.allSources')], ...found.map((x) => [x.id, sourceLabel(x.id, x.label)])];
    const sourceSel = select(tr('grid.filter.from'), froms, ctl.source, (v) => {
      ctl.source = v;
      render();
    });
    const jump = select(tr('grid.jump'), [['', tr('grid.jumpPick')]], '', (v) => {
      if (v) jumpTo(v === 'none' ? null : v);
    });
    const toolbar = h('div', { class: 'toolbar' }, size.el, found.length > 1 ? sourceSel.el : null, jump.el,
      h('div', { class: 'toggles' }, tiny.el, hasDates ? dates.el : null, r.where ? places.el : null));

    const selCount = h('span', { class: 'sel-count', role: 'status' });
    const restoreSelected = (e) => openRestoreDialog({ copies: [...ctl.selected.values()], opener: e.currentTarget });
    const bar = h('div', { class: 'selection-bar', hidden: true }, selCount,
      button(tr('common.clearSelection'), () => clearSelection()),
      button(tr('grid.restoreSelected'), restoreSelected, 'btn primary'));

    const el = h('section', { class: 'grid-view' },
      resultsHead(tr('grid.title'), 'media', summaryEl), searchNotices(job.summary, job), hiddenNote, toolbar,
      h('p', { class: 'hint keys', text: tr('grid.keys') }),
      groupsEl, sentinel, h('p', { class: 'more-row' }, more), bar);

    // More tiles as the end comes near, and a button for doing the same by keyboard.
    const endWatch = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !more.hidden) showMore();
    }, { rootMargin: '800px 0px' });
    endWatch.observe(sentinel);

    // Columns follow the width; a grid out of sight has none, and keeps the ones it had.
    const columnsFor = (width) => Math.max(1, Math.floor((width + GAP_PX) / (TILE_PX + GAP_PX)));
    const resize = new ResizeObserver(() => {
      if (!groupsEl.clientWidth) return;
      const cols = columnsFor(groupsEl.clientWidth);
      if (cols !== ctl.cols) {
        const had = document.activeElement;
        ctl.cols = cols;
        for (const g of groups.values()) rechunk(g);
        if (had && had.classList && had.classList.contains('tile') && had.isConnected) had.focus({ preventScroll: true });
      }
    });
    resize.observe(groupsEl);

    let months = [];
    const monthCount = (month) => {
      const m = months.find((x) => x.month === (month || null));
      return m ? m.count : null;
    };

    function group(month) {
      const key = month || 'none';
      if (groups.has(key)) return groups.get(key);
      const titleId = nextId('month');
      const n = monthCount(month);
      const named = month ? fmtMonth(month) : tr('grid.noDate');
      const titleEl = h('h2', { id: titleId, class: 'month-title', text: n != null ? tr('grid.month', { month: named, count: n }) : named });
      const section = h('section', { class: 'month', 'aria-labelledby': titleId }, titleEl,
        month ? null : h('p', { class: 'hint', text: tr('grid.noDate.body') }));
      const grid = h('div', { role: 'grid', class: 'grid', 'aria-labelledby': titleId, 'aria-multiselectable': 'true' });
      section.append(grid);
      groupsEl.append(section);
      const g = { key, month, section, grid, rows: [], tiles: [] };
      groups.set(key, g);
      return g;
    }

    function place(g, tile) {
      let row = g.rows[g.rows.length - 1];
      if (!row || row.childElementCount >= ctl.cols) {
        row = h('div', { role: 'row', class: 'grid-row' });
        row.style.setProperty('--cols', String(ctl.cols));
        g.grid.append(row);
        g.rows.push(row);
      }
      row.append(tile);
    }

    function rechunk(g) {
      g.grid.textContent = '';
      g.rows = [];
      for (const t of g.tiles) place(g, t);
    }

    function tile(it) {
      const t = tierOf(it);
      const video = mediaOf(it) === 'video';
      const when = whenOf(it);
      // What the tile says is in its label; what it shows is for the eye only.
      const shown = { 'aria-hidden': 'true' };
      const caption = `${when === null ? tr('grid.noDate') : fmtDay(when)} · ${fmtSize(it.size)}`;
      const cell = { role: 'gridcell', class: `tile tier-${t}`, tabindex: '-1', 'aria-selected': 'false', 'aria-label': tileLabel(it) };
      const node = h('div', cell,
        h('div', { class: 'frame', ...shown },
          h('div', { class: 'thumb' }, h('span', { class: 'loading', text: tr('grid.loadingThumb') })),
          // The kind of copy alone: its size in pixels is said in its label, and when it is opened.
          h('span', { class: `badge tile-badge tier-${t}` }, icon(TIER_ICON[t]), h('span', { class: 'badge-text', text: tr(TIER_LABEL[t]) })),
          video ? h('span', { class: 'play' }, icon('play')) : null,
          h('span', { class: 'pick', title: tr('grid.select') }, icon('check'))),
        h('span', { class: 'caption', ...shown, text: caption }));
      itemOfTile.set(node, it);
      tileOf.set(uidOf(it), node);
      return node;
    }

    const allTiles = () => [...groups.values()].flatMap((g) => g.tiles);

    function showHidden(f) {
      hiddenNote.textContent = '';
      const hd = f.hidden;
      const total = hd.elsewhere + hd.outsideDates + hd.smaller + hd.tiny + hd.source;
      const undated = monthCount(null);
      if (!f.kept.length && total) {
        hiddenNote.append(callout('info', null, h('p', { text: tr('results.allHidden', { count: total }) }),
          h('p', { class: 'actions' },
            hd.smaller ? button(tr('grid.showSmaller', { count: hd.smaller }), () => size.inputs[1].click()) : null,
            hd.outsideDates ? button(tr('results.allDates'), () => dates.input.click()) : null,
            hd.elsewhere ? button(tr('results.allPlaces', { folder: r.where || '' }), () => places.input.click()) : null,
            hd.tiny ? button(tr('grid.showTiny', { count: hd.tiny }), () => tiny.input.click()) : null,
            hd.source ? button(tr('grid.filter.allSources'), () => {
              sourceSel.control.value = '';
              ctl.source = '';
              render();
            }) : null)));
        return;
      }
      const said = [];
      if (hd.smaller) said.push(tr('grid.hidden.smaller', { count: hd.smaller }));
      if (hd.outsideDates) said.push(tr('grid.hidden.dates', { count: hd.outsideDates }));
      if (hd.elsewhere) said.push(tr('grid.hidden.elsewhere', { count: hd.elsewhere }));
      if (hd.tiny) said.push(tr('grid.hidden.tiny', { count: hd.tiny }));
      if (said.length) hiddenNote.append(h('p', { class: 'hint', text: tr('grid.hidden', { list: fmtList(said) }) }));
      if (undated) {
        hiddenNote.append(callout('info', null, h('p', { text: tr('grid.undatedNote', { count: undated }) }),
          h('p', {}, button(tr('grid.showUndated'), () => jumpTo(null)))));
      }
      const counts = mediaCounts(job.items);
      if (!counts.videos && (r.types || []).includes('video')) {
        hiddenNote.append(callout('info', null, h('p', { text: tr('grid.noVideos') })));
      }
    }

    function renderJump() {
      const sel = jump.control;
      sel.textContent = '';
      sel.append(h('option', { value: '', text: tr('grid.jumpPick') }));
      for (const m of months) {
        const month = m.month ? fmtMonth(m.month) : tr('grid.noDate');
        sel.append(h('option', { value: m.month || 'none', text: tr('grid.month', { month, count: m.count }) }));
      }
    }

    function render() {
      let f = filterMedia(job.items, { ...ctl, from: r.from, to: r.to, where: r.where });
      // Tiny pictures are hidden at first; when nothing else would show, they are shown after all.
      if (!f.kept.length && f.hidden.tiny && ctl.hideTiny) {
        ctl.hideTiny = false;
        tiny.input.checked = false;
        f = filterMedia(job.items, { ...ctl, from: r.from, to: r.to, where: r.where });
      }
      ctl.list = f.kept;
      // What a filter hides is no longer selected: nothing is restored that is not in sight.
      const inList = new Set(ctl.list.map(uidOf));
      for (const uid of [...ctl.selected.keys()]) if (!inList.has(uid)) ctl.selected.delete(uid);
      updateBar();
      months = monthCounts(ctl.list);
      const n = mediaCounts(ctl.list);
      summaryEl.textContent = ctl.list.length
        ? [tr('grid.count.photos', { count: n.photos }), tr('grid.count.videos', { count: n.videos }),
          n.smaller ? tr('grid.count.smaller', { count: n.smaller }) : null].filter(Boolean).join(' · ')
        : tr('results.noMatch');
      showHidden(f);
      renderJump();
      thumbs.reset();
      groupsEl.textContent = '';
      groups.clear();
      tileOf.clear();
      ctl.focus = null;
      ctl.shown = 0;
      showMore();
    }

    function showMore() {
      const next = ctl.list.slice(ctl.shown, ctl.shown + GRID_PAGE);
      for (const it of next) {
        const g = group(monthOf(whenOf(it)));
        const t = tile(it);
        g.tiles.push(t);
        place(g, t);
        thumbs.observe(t);
        if (ctl.selected.has(uidOf(it))) t.setAttribute('aria-selected', 'true');
      }
      ctl.shown += next.length;
      const left = ctl.list.length - ctl.shown;
      more.hidden = left <= 0;
      more.textContent = tr('results.showMore', { count: Math.min(GRID_PAGE, Math.max(0, left)) });
      if (!ctl.focus) {
        const first = allTiles()[0];
        if (first) setFocus(first, false);
      }
    }

    /** Shows tiles until a month's are there, then moves to it. */
    function jumpTo(month) {
      const at = ctl.list.findIndex((it) => monthOf(whenOf(it)) === (month || null));
      jump.control.value = '';
      if (at < 0) return;
      while (ctl.shown <= at) showMore();
      const g = groups.get(month || 'none');
      if (!g) return;
      g.section.scrollIntoView({ block: 'start' });
      if (g.tiles[0]) setFocus(g.tiles[0], true);
    }

    function setFocus(t, move) {
      if (ctl.focus && ctl.focus !== t) ctl.focus.setAttribute('tabindex', '-1');
      ctl.focus = t;
      t.setAttribute('tabindex', '0');
      if (move) t.focus();
    }

    function updateBar() {
      const n = ctl.selected.size;
      bar.hidden = !n;
      let bytes = 0;
      for (const it of ctl.selected.values()) bytes += Number(it.size) || 0;
      selCount.textContent = tr('grid.selected', { count: n, size: fmtSize(bytes) });
    }

    function setSelected(t, on) {
      const it = itemOfTile.get(t);
      if (!it) return;
      if (on) ctl.selected.set(uidOf(it), it);
      else ctl.selected.delete(uidOf(it));
      t.setAttribute('aria-selected', String(!!on));
    }

    function toggle(t) {
      const it = itemOfTile.get(t);
      setSelected(t, !ctl.selected.has(uidOf(it)));
      ctl.anchor = t;
      updateBar();
    }

    function selectRange(t) {
      const tiles = allTiles();
      const [a, b] = [tiles.indexOf(ctl.anchor), tiles.indexOf(t)].sort((x, y) => x - y);
      for (const x of tiles.slice(Math.max(0, a), b + 1)) setSelected(x, true);
      updateBar();
    }

    function clearSelection() {
      for (const uid of ctl.selected.keys()) {
        const t = tileOf.get(uid);
        if (t) t.setAttribute('aria-selected', 'false');
      }
      ctl.selected.clear();
      updateBar();
    }

    /** The tile a key moves to: along the row, or to the same column of the row above or below, across months. */
    function neighbour(t, key, ctrl) {
      const tiles = allTiles();
      const at = tiles.indexOf(t);
      const rows = [...groups.values()].flatMap((g) => g.rows);
      const ri = rows.indexOf(t.parentElement);
      const col = [...t.parentElement.children].indexOf(t);
      switch (key) {
        case 'ArrowRight': return tiles[at + 1];
        case 'ArrowLeft': return tiles[at - 1];
        case 'ArrowDown': {
          const row = rows[ri + 1];
          return row ? row.children[Math.min(col, row.children.length - 1)] : null;
        }
        case 'ArrowUp': {
          const row = rows[ri - 1];
          return row ? row.children[Math.min(col, row.children.length - 1)] : null;
        }
        case 'Home': return ctrl ? tiles[0] : t.parentElement.firstElementChild;
        case 'End': return ctrl ? tiles[tiles.length - 1] : t.parentElement.lastElementChild;
        case 'PageDown': return (rows[Math.min(rows.length - 1, ri + 3)] || {}).firstElementChild;
        case 'PageUp': return (rows[Math.max(0, ri - 3)] || {}).firstElementChild;
        default: return undefined;
      }
    }

    groupsEl.addEventListener('keydown', (e) => {
      const t = e.target.closest && e.target.closest('.tile');
      if (!t) return;
      if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        if (e.shiftKey && ctl.anchor) selectRange(t);
        else toggle(t);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        openLightbox(ctl.list.indexOf(itemOfTile.get(t)));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        for (const x of allTiles()) setSelected(x, true);
        updateBar();
        return;
      }
      const to = neighbour(t, logicalKey(e.key), e.ctrlKey || e.metaKey);
      if (to === undefined) return;
      e.preventDefault();
      if (to) {
        setFocus(to, true);
        to.scrollIntoView({ block: 'nearest' });
        const tiles = allTiles();
        if (to === tiles[tiles.length - 1] && !more.hidden) showMore();
      }
    });

    groupsEl.addEventListener('click', (e) => {
      const t = e.target.closest && e.target.closest('.tile');
      if (!t) return;
      setFocus(t, true);
      if (e.target.closest('.pick') || e.ctrlKey || e.metaKey) toggle(t);
      else if (e.shiftKey && ctl.anchor) selectRange(t);
      else openLightbox(ctl.list.indexOf(itemOfTile.get(t)));
    });

    /** One photo or video at a time, as large as the window allows, with what is known of it. */
    function openLightbox(index) {
      if (index < 0) return;
      const titleId = nextId('dlg');
      const dlg = h('dialog', { class: 'dialog lightbox', 'aria-labelledby': titleId });
      const heading = h('h2', { id: titleId, class: 'lb-title' });
      const frame = h('div', { class: 'lb-frame' });
      const facts = h('div', { class: 'lb-facts' });
      const prev = iconButton('chevron', tr('preview.prevItem'), () => show(at - 1), 'lb-step back');
      const next = iconButton('chevron', tr('preview.nextItem'), () => show(at + 1), 'lb-step');
      const tools = h('div', { class: 'lb-tools' });
      dlg.append(h('div', { class: 'lb-head' }, heading, tools, iconButton('close', tr('common.close'), () => dlg.close())),
        h('div', { class: 'lb-main' }, prev, frame, next), facts);
      let at = index;
      let seq = 0;
      function show(i) {
        if (i < 0 || i >= ctl.list.length) return;
        at = i;
        const mine = ++seq;
        const it = ctl.list[i];
        const uid = uidOf(it);
        heading.textContent = '';
        heading.append(nameText(nameOf(it) || tileLabel(it)));
        pauseMedia(frame);
        frame.textContent = '';
        const msg = h('p', { class: 'callout info', hidden: true });
        frame.append(h('p', { class: 'muted', text: tr('preview.loading') }));
        aboutOf(uid).then((a) => {
          if (mine !== seq) return;
          frame.textContent = '';
          const cannot = () => {
            msg.hidden = false;
            msg.textContent = tr(mediaOf(it) === 'video' ? 'preview.video.cannot' : 'preview.image.cannot', { format: formatName(a.ext) });
          };
          if (a.preview === 'video') {
            const v = player(uid);
            v.addEventListener('error', () => {
              v.hidden = true;
              cannot();
            });
            frame.append(v, msg);
          } else if (a.preview === 'image') {
            const img = h('img', { src: copyUrl(uid), alt: tileLabel(it), draggable: 'false' });
            img.addEventListener('error', () => {
              img.hidden = true;
              cannot();
            });
            frame.append(img, msg);
          } else {
            frame.append(msg);
            cannot();
          }
        }, (e) => {
          if (mine !== seq) return;
          frame.textContent = '';
          frame.append(callout('error', null, h('p', { text: e.status === 410 ? tr('empty.noLongerThere') : errorText(e) })));
        });
        const selId = nextId('chk');
        const sel = h('input', { type: 'checkbox', id: selId, checked: ctl.selected.has(uid) });
        sel.addEventListener('change', () => {
          const t = tileOf.get(uid);
          if (t) setSelected(t, sel.checked);
          else if (sel.checked) ctl.selected.set(uid, it);
          else ctl.selected.delete(uid);
          updateBar();
        });
        tools.textContent = '';
        tools.append(h('span', { class: 'check' }, sel, h('label', { for: selId, text: tr('grid.select') })), restoreButton(it));
        facts.textContent = '';
        facts.append(
          h('p', { class: 'badges' }, tierBadge(it), h('span', { class: 'meta', text: metaLine(it) })),
          h('p', { class: 'hint', text: tr(tierHelpKey(it)) }),
          h('p', {}, h('span', { class: 'muted', text: `${tr('preview.info.foundIn')}: ` }), foundIn(it)),
          h('details', { class: 'notes' }, h('summary', {}, icon('chevron', 'more-chevron'), h('span', { text: tr('preview.technical') })),
            infoList(it, null)));
        prev.disabled = i === 0;
        next.disabled = i >= ctl.list.length - 1;
        if (i >= ctl.shown - 3 && !more.hidden) showMore();
      }
      dlg.addEventListener('keydown', (e) => {
        if (e.target.closest('input, select, textarea, video, summary')) return;
        const key = logicalKey(e.key);
        if (key === 'ArrowRight') show(at + 1);
        else if (key === 'ArrowLeft') show(at - 1);
        else return;
        e.preventDefault();
      });
      showModal(dlg, null, () => {
        const t = tileOf.get(uidOf(ctl.list[at] || {}));
        if (t) {
          setFocus(t, true);
          t.scrollIntoView({ block: 'nearest' });
        }
      });
      show(index);
      $('.lb-head > .icon-only', dlg).focus();
    }

    render();
    while (ctl.shown < (s.shown || 0) && ctl.shown < ctl.list.length) showMore();
    return {
      el,
      job,
      save: () => ({
        smaller: ctl.smaller, hideTiny: ctl.hideTiny, source: ctl.source, allDates: ctl.allDates, allPlaces: ctl.allPlaces,
        shown: ctl.shown, selected: [...ctl.selected.keys()],
      }),
      destroy() {
        thumbs.destroy();
        endWatch.disconnect();
        resize.disconnect();
      },
    };
  }

  // ---- bringing back a folder ----------------------------------------------------------------

  const PLAN_FILTERS = {
    all: () => true,
    draft: (f) => tierOf(f.copy) === 'draft',
    inexact: (f) => tierOf(f.copy) === 'inexact',
    exists: (f) => f.copy.state === 'exists',
  };

  function planView(job, saved) {
    if (!job.items.length) return emptyResults(job);
    const plan = renderPlan(job, saved);
    return { el: plan.el, job, save: plan.save };
  }

  /**
   * What a rebuild would write, as a tree to tick and untick. Every file ever found below the
   * folder is in it, also ones deleted long ago on purpose, so the person decides. A file whose
   * only copies are smaller ones or may be incomplete (the plan's leftOut) is listed apart and
   * left unticked: it is not the file, or may not be all of it. `saved` is what the view held when
   * it is made again in another language: what is unticked or added, which folders are open, and
   * what is shown.
   */
  function renderPlan(job, saved) {
    const s = saved || {};
    const folder = job.summary.folder || job.request.folder || '';
    const all = job.items;
    const normal = all.filter((f) => !f.leftOut);
    const leftOut = all.filter((f) => f.leftOut);
    const excluded = new Set(s.excluded || []);
    const leftIn = new Set(s.leftIn || []);
    const opened = new Set(s.opened || []); // the folders open, by their path inside
    const isIncluded = (node) => !excluded.has(node.rel);
    let filter = PLAN_FILTERS[s.filter] ? s.filter : 'all';
    let top = null;
    const nodeOf = new WeakMap();

    const tierCounts = {};
    const kindCounts = new Map();
    for (const f of normal) {
      const t = tierOf(f.copy);
      tierCounts[t] = (tierCounts[t] || 0) + 1;
      kindCounts.set(f.copy.kind, (kindCounts.get(f.copy.kind) || 0) + 1);
    }
    const TIER_COUNT = { exact: 'plan.n.exact', inexact: 'plan.n.inexact', draft: 'plan.n.draft' };
    const tierLine = Object.keys(TIER_COUNT).filter((t) => tierCounts[t])
      .map((t) => tr(TIER_COUNT[t], { count: tierCounts[t] })).join(' · ');
    const kindLine = [...kindCounts].sort((a, b) => b[1] - a[1])
      .map(([k, n]) => tr('plan.fromKind', { kind: kindLabel(k), count: n })).join(' · ');

    const tree = h('ul', { role: 'tree', class: 'tree', 'aria-label': tr('plan.treeLabel', { folder }) });
    const barText = h('span', { role: 'status' });
    const write = h('button', { type: 'button', class: 'btn primary' });

    const filterChoices = [['all', tr('plan.filter.all')]];
    if (tierCounts.draft) filterChoices.push(['draft', tr('plan.filter.draft')]);
    if (tierCounts.inexact) filterChoices.push(['inexact', tr('plan.filter.inexact')]);
    if (normal.some((f) => f.copy.state === 'exists')) filterChoices.push(['exists', tr('plan.filter.exists')]);
    const filterSel = select(tr('plan.filter.label'), filterChoices, filter, (v) => {
      filter = v;
      build();
    });

    function build() {
      top = buildTree(normal.filter(PLAN_FILTERS[filter]), baseName(folder) || folder);
      if (filter !== 'all') expandAll(top, true);
      else reopen(top);
      tree.textContent = '';
      recount();
      tree.append(item(top));
      const first = $('[role=treeitem]', tree);
      if (first) first.setAttribute('tabindex', '0');
    }

    /** Opens again the folders that were open. */
    function reopen(node) {
      if (!node.dir) return;
      if (opened.has(node.rel)) node.expanded = true;
      node.children.forEach(reopen);
    }

    function expandAll(node, on) {
      if (!node.dir) return;
      node.expanded = on || !node.parent;
      if (node.parent && on) opened.add(node.rel);
      else if (node.parent) opened.delete(node.rel);
      node.children.forEach((c) => expandAll(c, on));
    }

    function recount() {
      if (top) countIncluded(top, isIncluded);
      let n = 0;
      let bytes = 0;
      for (const f of normal) {
        if (excluded.has(relParts(f.rel).join('/'))) continue;
        n++;
        bytes += Number(f.copy.size) || 0;
      }
      for (const f of leftOut) {
        if (!leftIn.has(relParts(f.rel).join('/'))) continue;
        n++;
        bytes += Number(f.copy.size) || 0;
      }
      barText.textContent = n ? tr('plan.selected', { count: n, size: fmtSize(bytes) }) : tr('plan.none');
      write.textContent = tr('plan.write', { count: n });
      write.disabled = !n;
      return n;
    }

    function refreshChecks(node) {
      if (node.el) node.el.setAttribute('aria-checked', checkState(node, isIncluded));
      if (node.dir && node.expanded) node.children.forEach(refreshChecks);
    }

    function item(node) {
      const li = h('li', {
        role: 'treeitem', 'aria-level': node.level, tabindex: '-1', 'aria-checked': checkState(node, isIncluded), 'aria-selected': 'false',
      });
      const row = h('div', { class: 'tree-row' });
      row.style.setProperty('--level', String(node.level - 1));
      const twisty = h('span', { class: 'twisty', 'aria-hidden': 'true' }, node.dir ? icon('chevron') : null);
      const box = h('span', { class: 'box', 'aria-hidden': 'true' }, icon('check', 'box-check'), icon('minus', 'box-mixed'));
      row.append(twisty, box, h('span', { class: 'tree-icon', 'aria-hidden': 'true' }, icon(node.dir ? 'folder' : fileIcon(node.file.copy))),
        h('bdi', { class: 'tree-name', text: node.name }));
      if (node.dir) {
        row.append(h('span', { class: 'muted tree-count', text: tr('plan.folderCount', { count: node.total }) }));
        li.setAttribute('aria-expanded', String(!!node.expanded));
      } else {
        const c = node.file.copy;
        row.append(h('span', { class: 'tree-meta' },
          h('span', { text: fmtDay(whenOf(c)) }), h('span', { text: kindLabel(c.kind, c.kindLabel) }), tierBadge(c),
          h('span', { class: 'num', text: fmtSize(c.size) }),
          c.state === 'exists' ? badge('state state-exists', null, tr('plan.stillThere')) : null));
        if (node.conflict) row.append(h('span', { class: 'hint block', text: tr('plan.conflict') }));
      }
      li.append(row);
      node.el = li;
      nodeOf.set(li, node);
      if (node.dir) {
        const groupEl = h('ul', { role: 'group', hidden: !node.expanded });
        li.append(groupEl);
        node.groupEl = groupEl;
        if (node.expanded) add(groupEl, node.children.map(item));
      }
      return li;
    }

    function setExpanded(node, on) {
      if (!node.dir || (!node.parent && !on)) return;
      node.expanded = on;
      if (on) opened.add(node.rel);
      else opened.delete(node.rel);
      node.el.setAttribute('aria-expanded', String(on));
      node.groupEl.hidden = !on;
      if (on && !node.groupEl.childElementCount) add(node.groupEl, node.children.map(item));
      if (on) refreshChecks(node);
    }

    function toggleCheck(node) {
      const on = checkState(node, isIncluded) !== 'true';
      const walk = (n) => {
        if (n.dir) n.children.forEach(walk);
        else if (on) excluded.delete(n.rel);
        else excluded.add(n.rel);
      };
      walk(node);
      recount();
      refreshChecks(top);
    }

    /** The tree items in the order they show, as far as folders are open. */
    function visible() {
      const out = [];
      const walk = (n) => {
        out.push(n);
        if (n.dir && n.expanded) n.children.forEach(walk);
      };
      if (top) walk(top);
      return out;
    }

    function focusNode(node) {
      for (const x of $$('[role=treeitem][tabindex="0"]', tree)) x.setAttribute('tabindex', '-1');
      node.el.setAttribute('tabindex', '0');
      node.el.focus();
    }

    tree.addEventListener('keydown', (e) => {
      const li = e.target.closest('[role=treeitem]');
      const node = li && nodeOf.get(li);
      if (!node) return;
      const list = visible();
      const at = list.indexOf(node);
      let to = null;
      switch (logicalKey(e.key)) {
        case 'ArrowDown': to = list[at + 1]; break;
        case 'ArrowUp': to = list[at - 1]; break;
        case 'Home': to = list[0]; break;
        case 'End': to = list[list.length - 1]; break;
        case 'ArrowRight':
          if (node.dir && !node.expanded) setExpanded(node, true);
          else if (node.dir) to = node.children[0];
          break;
        case 'ArrowLeft':
          if (node.dir && node.expanded && node.parent) setExpanded(node, false);
          else to = node.parent;
          break;
        case ' ':
        case 'Spacebar':
          toggleCheck(node);
          break;
        case 'Enter':
          if (node.dir) setExpanded(node, !node.expanded);
          else previewDialog(node.file.copy, li);
          break;
        default: return;
      }
      e.preventDefault();
      if (to && to.el) focusNode(to);
    });

    tree.addEventListener('click', (e) => {
      const li = e.target.closest('[role=treeitem]');
      const node = li && nodeOf.get(li);
      if (!node) return;
      e.stopPropagation();
      focusNode(node);
      if (e.target.closest('.box')) toggleCheck(node);
      else if (node.dir && e.target.closest('.twisty, .tree-name')) setExpanded(node, !node.expanded);
      else if (!node.dir && e.target.closest('.tree-name')) previewDialog(node.file.copy, li);
    });

    const leftOutList = leftOut.length ? h('section', { class: 'smaller-only panel', 'aria-labelledby': 'left-out-title' },
      h('h2', { id: 'left-out-title', text: tr('plan.leftOut.title', { count: leftOut.length }) }),
      h('p', { class: 'hint', text: tr('plan.leftOut.body') }),
      h('ul', { class: 'plain left-out' }, leftOut.map((f) => {
        const rel = relParts(f.rel).join('/');
        const line = checkLine(rel, leftIn.has(rel));
        line.input.addEventListener('change', () => {
          if (line.input.checked) leftIn.add(rel);
          else leftIn.delete(rel);
          recount();
        });
        line.el.append(h('span', { class: 'left-out-meta' }, tierBadge(f.copy), h('span', { class: 'muted', text: fmtSize(f.copy.size) })),
          button(tr('results.preview'), (e) => previewDialog(f.copy, e.currentTarget), 'btn small'));
        return h('li', {}, line.el);
      }))) : null;

    write.addEventListener('click', (e) => {
      const count = recount();
      if (!count) return;
      const relOf = (f) => relParts(f.rel).join('/');
      const chosen = [...normal.filter((f) => !excluded.has(relOf(f))), ...leftOut.filter((f) => leftIn.has(relOf(f)))];
      openRestoreDialog({
        opener: e.currentTarget,
        rebuild: {
          job, folder, folderName: baseName(folder) || folder, count,
          exclude: normal.map((f) => relParts(f.rel).join('/')).filter((rel) => excluded.has(rel)),
          include: [...leftIn],
          leftOutIn: leftIn.size,
          sizes: chosen.map((f) => f.copy.size),
        },
      });
    });

    build();
    const el = h('div', { class: 'plan' },
      resultsHead(tr('plan.title', { count: all.length, folder }), 'folder',
        tierLine ? h('p', { class: 'summary', text: tierLine }) : null,
        kindLine ? h('p', { class: 'muted', text: tr('plan.from', { list: kindLine }) }) : null),
      h('p', { class: 'lead', text: tr('plan.explain') }),
      callout('warn', null, h('p', { text: tr('plan.oldFiles') })),
      searchNotices(job.summary, job),
      normal.length ? [
        h('div', { class: 'toolbar' }, filterSel.el,
          button(tr('common.expandAll'), () => {
            expandAll(top, true);
            tree.textContent = '';
            tree.append(item(top));
            focusNode(top);
          }, 'btn small'),
          button(tr('common.collapseAll'), () => {
            expandAll(top, false);
            tree.textContent = '';
            tree.append(item(top));
            focusNode(top);
          }, 'btn small')),
        h('p', { class: 'hint keys', text: tr('plan.keys') }),
        tree,
      ] : null,
      leftOutList,
      h('div', { class: 'selection-bar' }, barText, write));
    return {
      el,
      save: () => ({ filter, excluded: [...excluded], leftIn: [...leftIn], opened: [...opened] }),
    };
  }

  /** A folder being written, and then what came of it. */
  function viewRebuild() {
    const job = state.jobs.get(state.current.rebuild || '');
    if (!job) return null;
    const back = () => (state.current.folder ? go('folder/plan') : go('folder'));
    if (job.state === 'failed' || job.state === 'cancelled') {
      return {
        job,
        el: statePage('error', tr('error.title'),
          h('p', { class: 'lead', text: job.error ? tr('rebuild.failedBecause', { message: job.error }) : tr('error.unexpected') }),
          h('p', { class: 'actions' }, button(tr('rebuild.back'), back, 'btn primary'))),
      };
    }
    if (job.state === 'running') {
      const bar = h('progress', { class: 'whole', max: '1' });
      const line = h('p', { class: 'muted writing-now', dir: 'ltr' });
      const status = h('p', { class: 'overall', role: 'status' });
      const update = () => {
        const total = job.writeTotal || job.request.files || 0;
        if (total) {
          bar.max = total;
          bar.value = job.written;
          status.textContent = tr('rebuild.progress', { done: job.written, total });
        } else {
          bar.removeAttribute('value');
          status.textContent = tr('rebuild.progressUnknown');
        }
        bar.setAttribute('aria-label', status.textContent);
        line.textContent = job.rel || '';
      };
      update();
      return {
        job, update,
        el: h('section', { class: 'progress', 'aria-busy': 'true' },
          h('header', { class: 'page-head' }, h('h1', { text: tr('rebuild.writing') })), status, bar, line),
      };
    }
    const d = job.summary;
    const failed = d.failed || [];
    const from = (k) => h('li', {}, h('span', { text: kindLabel(k.kind, k.label) }), h('span', { class: 'num', text: fmtNum(k.count) }));
    const failure = (f) => h('li', {}, pathText(relParts(f.rel || f.path).join('/')), ': ', errorText({ message: f.error }));
    return {
      job,
      el: statePage(failed.length && !d.written ? 'error' : 'success', tr('rebuild.done', { written: d.written || 0, count: d.files || 0 }),
        d.root ? h('div', { class: 'done-where' },
          h('p', { class: 'field-label', text: tr('rebuild.into') }),
          h('p', { class: 'done-path' }, pathText(d.root), copyButton(d.root))) : null,
        d.root ? h('p', { class: 'hint', text: tr('restore.openWarning') }) : null,
        failed.length ? callout('warn', tr('rebuild.failed', { count: failed.length }), h('ul', {}, failed.map(failure))) : null,
        (d.byKind || []).length ? h('section', { class: 'panel by-kind' }, h('h2', { text: tr('rebuild.byKind') }),
          h('ul', { class: 'plain counts' }, d.byKind.map(from))) : null,
        h('p', { class: 'actions' }, button(tr('common.newSearch'), () => go('folder'), 'btn primary'), button(tr('rebuild.back'), back))),
    };
  }

  // ---- what is searched ----------------------------------------------------------------------

  /**
   * One card per source: what it keeps and for how long, what it sees on this machine (its
   * describe() lines), and the places added to it for this session -- from another disk, a
   * memory card's image, a folder for every restore point to be looked through.
   */
  function viewSources() {
    const cards = new Map();
    const onlyAdded = switchLine(tr('sources.onlyAdded'), state.locations.discover === false);
    onlyAdded.input.addEventListener('change', () => {
      state.locations.discover = !onlyAdded.input.checked;
    });
    const list = h('div', { class: 'source-cards' });
    const frozen = state.info.frozen || null;
    const el = h('section', { class: 'sources' },
      h('header', { class: 'page-head' }, h('div', { class: 'page-title' }, h('h1', { text: tr('sources.title') }),
        h('p', { class: 'lead', text: tr('sources.intro') }))),
      state.elevated ? callout('info', null, h('p', { text: tr('sources.elevated') })) : null,
      h('div', { class: 'panel only-added' }, onlyAdded.el), list);

    for (const s of state.sources) {
      const titleId = nextId('source');
      const lines = h('div', {}, h('p', { class: 'muted', text: tr('sources.checking') }));
      const added = h('ul', { class: 'plain added' });
      const addBtn = button(tr('sources.add'), (e) => addPlace(s, e.currentTarget), 'btn small');
      const read = frozen && (frozen.sources || []).find((x) => x.id === s.id);
      const readAhead = read
        && (read.error ? tr('sources.frozenFailed', { error: read.error }) : tr('sources.frozen', { when: fmtWhen(frozen.at) }));
      const term = (key, value) => (has(value) ? [h('dt', { text: tr(key) }), h('dd', { text: tr(value) })] : null);
      const card = h('section', { class: 'source-card panel', 'aria-labelledby': titleId },
        h('h2', { id: titleId, text: sourceLabel(s.id, s.label) }),
        has(`source.${s.id}.keeps`)
          ? h('dl', { class: 'info' }, term('sources.keeps', `source.${s.id}.keeps`), term('sources.howLong', `source.${s.id}.howLong`)) : null,
        s.needsAdmin && !state.elevated ? h('p', { class: 'note-line' }, icon('alert'), h('span', { text: tr('sources.needsAdmin') })) : null,
        s.media === false ? h('p', { class: 'note-line' }, icon('info'), h('span', { text: tr('sources.textOnly') })) : null,
        readAhead ? h('p', { class: 'note-line' }, icon(read.error ? 'alert' : 'info'), h('span', { text: readAhead })) : null,
        h('details', { class: 'notes' }, h('summary', {}, icon('chevron', 'more-chevron'), h('span', { text: tr('sources.technical') })), lines),
        added, h('p', { class: 'card-actions' }, addBtn));
      cards.set(s.id, { lines, added, s });
      list.append(card);
    }
    renderAdded();

    /** A place as given, in words: a folder for every restore point is shown as that folder. */
    function placeText(id, p) {
      if (id === 'vss' && /^walk=/.test(p)) return tr('sources.walkPlace', { folder: p.slice(5) });
      return p;
    }

    function renderAdded() {
      for (const [id, c] of cards) {
        c.added.textContent = '';
        for (const p of [].concat((state.locations.dirs || {})[id] || [])) {
          c.added.append(h('li', {},
            h('span', { class: 'muted', text: `${tr('sources.added')}: ` }),
            id === 'vss' && /^walk=/.test(p) ? h('span', { text: placeText(id, p) }) : pathText(p), ' ',
            button(tr('sources.remove'), () => removePlace(id, p), 'btn small quiet')));
        }
      }
    }

    function removePlace(id, place) {
      const dirs = { ...(state.locations.dirs || {}) };
      dirs[id] = [].concat(dirs[id] || []).filter((p) => p !== place);
      if (!dirs[id].length) delete dirs[id];
      state.locations.dirs = dirs;
      renderAdded();
      announce(tr('sources.removedNow', { source: sourceLabel(id) }));
    }

    function addPlace(s, opener) {
      const titleId = nextId('dlg');
      const dlg = h('dialog', { class: 'dialog', 'aria-labelledby': titleId });
      // A source can have words of its own for what a place of it is: a restore point's folder, a card's image.
      const ownOr = (key, fallback) => (has(key) ? key : fallback);
      const f = field({
        id: nextId('place'), label: tr(ownOr(`sources.addLabel.${s.id}`, 'sources.addPlace.label')),
        hint: pathHint(ownOr(`sources.addHint.${s.id}`, 'sources.addHint')), control: pathInput(''),
      });
      const submit = h('button', { type: 'submit', class: 'btn primary', text: tr('sources.addSubmit') });
      const form = h('form', { class: 'dialog-form', novalidate: true },
        h('div', { class: 'dialog-body' },
          h('h2', { id: titleId, text: tr('sources.addTitle', { source: sourceLabel(s.id, s.label) }) }), f.el),
        h('div', { class: 'dialog-actions' }, button(tr('common.cancel'), () => dlg.close()), submit));
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const typed = f.control.value.trim().replace(/^"([^"]*)"$/, '$1').trim();
        if (!typed || !isAbsolute(typed)) {
          f.setError(typed ? tr('dest.relative') : tr('dest.missing'));
          f.control.focus();
          return;
        }
        const place = s.id === 'vss' ? `walk=${typed}` : typed;
        const dirs = { ...(state.locations.dirs || {}) };
        dirs[s.id] = [...new Set([...[].concat(dirs[s.id] || []), place])];
        state.locations.dirs = dirs;
        dlg.close();
        renderAdded();
        announce(tr('sources.addedNow', { source: sourceLabel(s.id, s.label) }));
      });
      dlg.append(form);
      showModal(dlg, opener);
      f.control.focus();
    }

    // What each source sees here: its describe() lines, which may take a moment for restore points.
    get('api/sources/describe').then((d) => {
      for (const g of (d && d.sources) || []) {
        const c = cards.get(g.id);
        if (!c) continue;
        c.lines.textContent = '';
        const ls = g.lines || [];
        if (!ls.length) c.lines.append(h('p', { class: 'muted', text: tr('sources.noLines') }));
        else c.lines.append(h('ul', { class: 'lines' }, ls.map((l) => h('li', { text: String(l) }))));
      }
    }, (e) => {
      for (const c of cards.values()) {
        c.lines.textContent = '';
        c.lines.append(h('p', { class: 'muted', text: tr('sources.describeFailed', { message: errorText(e) }) }));
      }
    });
    return {
      el,
      onShow() {
        onlyAdded.input.checked = state.locations.discover === false;
      },
    };
  }

  // ---- help ----------------------------------------------------------------------------------

  /** Help. `saved`: which of its parts were open, when it is made again in another language. */
  function viewHelp(saved) {
    const info = state.info || {};
    // How launch.js opened this window, as api/info says it.
    const launchKey = {
      edge: 'help.browser.inprivate', explorer: 'help.browser.default', open: 'help.browser.default',
      'xdg-open': 'help.browser.default', none: 'help.browser.none',
    }[info.window] || 'help.browser.unknown';
    // Each part a card that opens when its title is clicked, as SoundVisualizer's help is; at
    // first only the first is open.
    let n = 0;
    const section = (titleKey, ...body) => {
      const open = saved && Array.isArray(saved.open) ? saved.open.includes(n) : n === 0;
      n++;
      return h('details', { class: 'expander help-part', open },
        h('summary', {}, h('h2', { text: tr(titleKey) }), icon('down', 'more-chevron')),
        h('div', { class: 'expander-body' }, ...body));
    };
    const tiers = h('dl', { class: 'info legend' });
    for (const t of [...TIERS, 'folder', 'gone']) {
      tiers.append(h('dt', {}, badge(`tier-${t}`, TIER_ICON[t], tr(TIER_LABEL[t]))), h('dd', { text: tr(TIER_HELP[t]) }));
    }
    const states = h('dl', { class: 'info legend' });
    for (const s of Object.keys(STATE_LABEL)) states.append(h('dt', {}, stateBadge(s)), h('dd', { text: tr(STATE_HELP[s]) }));
    const el = h('section', { class: 'help' },
      h('header', { class: 'page-head' }, h('h1', { text: tr('help.title') })),
      section('help.what.title', h('p', { text: tr('help.what.body') })),
      section('help.tiers.title', tiers),
      section('help.states.title', states),
      section('help.media.title', ['help.media.ssd', 'help.media.video', 'help.media.card'].map((k) => h('p', { text: tr(k) }))),
      section('help.cant.title',
        h('ul', {}, ['help.cant.formatted', 'help.cant.nocopy', 'help.cant.original'].map((k) => h('li', { text: tr(k) })))),
      section('help.writes.title', h('p', { text: tr('help.writes.body') })),
      section('help.stop.title', h('p', { text: tr('help.stop.body') })),
      section('help.browser.title', h('p', { text: tr(launchKey) }), h('p', { text: tr('help.browser.save') })),
      section('help.keys.title', h('p', { text: tr('help.keys.body') })),
      info.version ? h('p', { class: 'muted version', text: tr('help.version', { version: info.version }) }) : null);
    const save = () => ({ open: $$('details.help-part', el).map((d, i) => (d.open ? i : -1)).filter((i) => i >= 0) });
    return { el, save };
  }

  // ---- quitting ------------------------------------------------------------------------------

  async function quit() {
    const ok = await confirmDialog({ title: tr('quit.confirmTitle'), body: tr('quit.confirmBody'), ok: tr('nav.quit'), danger: true });
    if (!ok) return;
    // Stopped from here on: the stream ending and the requests failing are what quitting does.
    state.stopped = true;
    let writing = 0;
    try {
      const res = await post('api/quit');
      writing = (res && res.writing) || 0;
    } catch (_) {
      /* it may be gone before it answers */
    }
    if (state.events) state.events.close();
    stoppedOverlay(tr('quit.done.title'), writing ? tr('quit.done.writing') : tr('quit.done.body'), false);
  }

  // ---- the frame: the rail, the theme and the language --------------------------------------

  // The rail shows its words in a window this wide or more, and only its icons in a narrower one,
  // where its button shows the words over the page; in a wide window the button takes them away.
  const WIDE_RAIL = '(min-width: 1008px)';
  let railWish = null; // null: as the width says; 'compact' in a wide window, 'open' in a narrow one

  function syncRail() {
    const app = document.getElementById('app');
    if (!app) return;
    const wide = window.matchMedia(WIDE_RAIL).matches;
    const mode = wide ? (railWish === 'compact' ? 'compact' : 'expanded') : railWish === 'open' ? 'overlay' : 'compact';
    app.setAttribute('data-rail', mode);
    const toggle = document.getElementById('rail-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', String(mode !== 'compact'));
    // A rail of icons says what each is when it is pointed at.
    for (const el of $$('.rail [data-route], .rail .quit')) {
      const label = $('.label', el);
      if (mode === 'compact' && label) el.setAttribute('title', label.textContent);
      else el.removeAttribute('title');
    }
  }

  function closeRail() {
    if (railWish !== 'open') return;
    railWish = null;
    syncRail();
  }

  function toggleRail() {
    if (window.matchMedia(WIDE_RAIL).matches) railWish = railWish === 'compact' ? null : 'compact';
    else railWish = railWish === 'open' ? null : 'open';
    syncRail();
  }

  /**
   * The rail's keys: Up and Down, Home and End move between its parts, as down a list, where
   * Tab moves too; Ctrl+1 to Ctrl+5 open each part from anywhere but a dialog, in the view it was
   * left on, focus included.
   */
  function railKeys() {
    const links = () => $$('.rail-nav a[data-route]');
    const nav = document.getElementById('rail-nav');
    if (nav) {
      nav.addEventListener('keydown', (e) => {
        const all = links();
        const at = all.indexOf(document.activeElement);
        if (at < 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        all[(to + all.length) % all.length].focus();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
      const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || '');
      const all = links();
      if (!m || Number(m[1]) > all.length || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      const link = all[Number(m[1]) - 1];
      if (link.getAttribute('aria-current') !== 'page') link.click();
    });
  }

  // The theme: dark, as SoundVisualizer is, unless light was chosen. The server keeps the choice
  // for this run (api/theme), so a reload keeps it; nothing is kept in the browser.
  let theme = 'dark';

  function applyTheme(next) {
    theme = next === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('theme');
    if (btn) {
      const label = tr(theme === 'dark' ? 'theme.toLight' : 'theme.toDark');
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    }
  }

  async function toggleTheme() {
    applyTheme(theme === 'dark' ? 'light' : 'dark');
    if (state.stopped) return;
    try {
      await post('api/theme', { theme });
    } catch (_) {
      /* the page shows it all the same */
    }
  }

  /** Puts the strings into what index.html holds: data-i18n for text, data-i18n-attr="attr:key;..." for attributes. */
  function applyI18n(rootEl) {
    for (const el of $$('[data-i18n]', rootEl)) el.textContent = tr(el.getAttribute('data-i18n'));
    for (const el of $$('[data-i18n-attr]', rootEl)) {
      for (const pair of el.getAttribute('data-i18n-attr').split(';')) {
        const [attr, key] = pair.split(':').map((s) => s.trim());
        if (attr && key) el.setAttribute(attr, tr(key));
      }
    }
  }

  /** The frame in the language spoken: <html lang dir>, its words, the language chosen in the picker. */
  function applyFrame() {
    document.documentElement.lang = String(lookup('meta.lang') || 'en');
    document.documentElement.dir = textDir();
    applyI18n(document);
    const sel = document.getElementById('lang');
    if (sel) sel.value = lang;
    applyTheme(theme);
    setTitle();
    syncRail();
  }

  /** The picker: each language the page has a table for, in its own name. None with only English. */
  function renderPicker() {
    const box = document.getElementById('lang-pick');
    const sel = document.getElementById('lang');
    if (!box || !sel) return;
    sel.textContent = '';
    for (const l of state.languages) sel.append(h('option', { value: l.code, lang: l.code, text: l.name }));
    sel.value = lang;
    box.hidden = state.languages.length < 2;
  }

  const languageName = (code) => (state.languages.find((l) => l.code === code) || { name: code }).name;

  /** Asks for a language's table, lang/<code>.json beside this page, and takes it in; false when it cannot be had. */
  async function loadLanguage(code) {
    if (code === 'en' || own(STRINGS, code)) return true;
    try {
      const res = await fetch(`lang/${enc(code)}.json`, { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) return false;
      return !!useTable(code, await res.json()).table;
    } catch (_) {
      return false;
    }
  }

  let languageSeq = 0;
  /**
   * Speaks a language from now on: its table asked for, the frame and every view made again in
   * it, and the server told, so that the library speaks it from the next search on. `first`: the
   * language the page starts in, before any view is made; then a language the server was started
   * in (--lang) that the page has no table for is left to the library, not changed.
   */
  async function chooseLanguage(code, first) {
    const mine = ++languageSeq;
    const wanted = state.languages.some((l) => l.code === code) ? code : 'en';
    const ok = await loadLanguage(wanted);
    if (mine !== languageSeq) return;
    if (!ok) {
      if (!first) alertNow(tr('lang.failed', { language: languageName(lang) }));
      applyFrame();
      return;
    }
    setLanguage(wanted);
    applyFrame();
    if (!state.stopped && wanted !== state.info.lang && !(first && state.info.lang)) {
      try {
        const r = await post('api/lang', { lang: wanted });
        state.info.lang = (r && r.lang) || wanted;
        if (r && r.locale) state.locale = r.locale;
      } catch (_) {
        /* the page speaks it all the same */
      }
      if (mine !== languageSeq) return;
    }
    if (!first) {
      rebuildAll();
      announce(tr('lang.changed', { language: languageName(wanted) }));
    }
  }

  // ---- starting up ---------------------------------------------------------------------------

  async function boot() {
    applyFrame();
    const skip = $('.skip');
    if (skip) {
      skip.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('main').focus();
      });
    }
    const quitBtn = document.getElementById('quit');
    if (quitBtn) quitBtn.addEventListener('click', quit);
    const themeBtn = document.getElementById('theme');
    if (themeBtn) themeBtn.addEventListener('click', toggleTheme);
    const pick = document.getElementById('lang');
    if (pick) pick.addEventListener('change', () => chooseLanguage(pick.value, false));
    const toggle = document.getElementById('rail-toggle');
    if (toggle) toggle.addEventListener('click', toggleRail);
    window.matchMedia(WIDE_RAIL).addEventListener('change', () => {
      railWish = null;
      syncRail();
    });
    // The words shown over the page go at Esc, or at a click beside them.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && railWish === 'open') {
        closeRail();
        if (toggle) toggle.focus();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (railWish === 'open' && !e.target.closest('.rail')) closeRail();
    });
    railKeys();
    window.addEventListener('hashchange', () => route());
    // The browser's own menu over a picture or a video offers "Save image as" and "Save video as",
    // which write to Downloads past every check (see the top of this file).
    document.addEventListener('contextmenu', (e) => {
      if (e.target && e.target.closest && e.target.closest('img, video, canvas, .media-frame')) e.preventDefault();
    });
    // Nor Ctrl+S, which saves the page with every picture on it into Downloads the same way.
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 's') e.preventDefault();
    });
    // The window going away tells the server, which then stops soon after the last one is gone
    // rather than waiting; a reload says it too, and is back before that wait is over.
    window.addEventListener('pagehide', () => {
      if (!state.stopped && navigator.sendBeacon) navigator.sendBeacon('api/bye');
    });
    try {
      const [info, sources] = await Promise.all([get('api/info'), get('api/sources')]);
      state.info = info || {};
      state.sources = (sources && sources.sources) || [];
      state.elevated = !!((sources && sources.elevated) || state.info.elevated);
      applyTheme(state.info.theme);
    } catch (_) {
      /* said by the overlay the failed request put up */
    }
    // The languages the page has, English always among them; the first is the server's, when it
    // was started in one of them, else the browser's first that is one, else English.
    const offered = (Array.isArray(state.info.languages) ? state.info.languages : [])
      .filter((l) => l && typeof l.code === 'string' && typeof l.name === 'string');
    state.languages = offered.some((l) => l.code === 'en') ? offered : [{ code: 'en', name: 'English' }, ...offered];
    state.locale = state.info.locale || 'en';
    const codes = state.languages.map((l) => l.code);
    const first = state.info.lang && codes.includes(state.info.lang)
      ? state.info.lang : pickLanguage(navigator.languages || [navigator.language], codes);
    renderPicker();
    await chooseLanguage(first, true);
    if (!state.stopped) {
      const hello = new Promise((resolve) => state.helloWaiters.push(resolve));
      state.events = connect();
      await Promise.race([hello, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    state.helloSeen = true;
    route();
  }

  // The page's own logic, for the tests, which run it in Node without a document.
  const internals = {
    STRINGS, TIERS, TIER_LABEL, TIER_HELP, STATE_LABEL, STATE_HELP, TIME_LABEL, CATEGORIES, ERRNO_KEYS, PLURAL_FORMS,
    tr, has, pickLanguage, setLanguage, codeOf, checkTable, useTable, placeholdersOf, pluralForms, textDir, logicalKey,
    fmtSize, fmtWhen, toMs, ymd, stamp, monthOf, dayStart, sinceMs, mediaRange,
    tierOf, tierText, mediaOf, nameOf, folderOf, extOfName, timeMeaningOf, baseName, dirName, isAbsolute, pathKey, isInside,
    rootOf, joinPath, syncedBy, kindLabel, formatName, partOfName, relParts, better, groupFiles, sortRows, filterResults,
    filterMedia, mediaCounts, groupByMonth, monthCounts, buildTree, countIncluded, checkState, hexRows, isAllZero, magicOf,
    decodeText, suggestDestination, onSameDrive, compact, placesFor, searchBody, planBody, modeOf, requestOf, query,
    errorText, ApiError, mismatch, isDevice, tierHelpKey,
  };

  if (inNode) module.exports = internals;
  else if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
