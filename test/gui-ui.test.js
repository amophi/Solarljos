'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The page of the graphical front end is plain files served as they are, so these checks read
// them as text: that nothing is loaded from elsewhere, that nothing runs inline (the server's
// Content-Security-Policy would block it, and an injected name must never run), and that every
// string the page asks for is in the table. The page's own logic -- how it groups, filters,
// decodes and suggests -- is loaded in Node, where it runs without a document. Nothing here
// starts a server or reads anything but these files and the library's tables.

const UI = path.join(__dirname, '..', 'src', 'gui', 'ui');
const read = (name) => fs.readFileSync(path.join(UI, name), 'utf8');
const html = read('index.html');
const app = read('app.js');
const css = read('style.css');
const stringsSource = read('strings.js');
const STRINGS = require('../src/gui/ui/strings.js');
const ui = require('../src/gui/ui/app.js');
const en = STRINGS.en;

// The namespaces of the keys: a quoted word.word in app.js that starts with one of these is a key.
const NAMESPACES = new Set(Object.keys(en).map((k) => k.split('.')[0]));

// The code without its comments, which name some of the things checked for to say they are not used.
const code = app.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

function keysUsed() {
  const used = new Set();
  for (const m of code.matchAll(/'([a-z][a-zA-Z0-9]*(?:\.[A-Za-z0-9-]+)+)'/g)) {
    if (NAMESPACES.has(m[1].split('.')[0])) used.add(m[1]);
  }
  for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) used.add(m[1]);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of m[1].split(';')) used.add(pair.split(':')[1].trim());
  }
  return used;
}

test('every string the page uses is in the English table', () => {
  const used = keysUsed();
  assert.ok(used.size > 400, `only ${used.size} keys found; the scan is broken`);
  const missing = [...used].filter((k) => !Object.prototype.hasOwnProperty.call(en, k));
  assert.deepStrictEqual(missing, []);
  // Keys put together at run time: each family the page builds has its members.
  for (const k of Object.values(ui.TIER_LABEL).concat(Object.values(ui.TIER_HELP), Object.values(ui.STATE_LABEL),
    Object.values(ui.STATE_HELP), Object.values(ui.TIME_LABEL), Object.values(ui.CATEGORIES), Object.values(ui.ERRNO_KEYS))) {
    assert.ok(Object.prototype.hasOwnProperty.call(en, k), k);
  }
});

test('the string table is well formed for a translation', () => {
  // An object literal keeps the last of two equal keys without a word.
  const declared = [...stringsSource.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]);
  assert.deepStrictEqual(declared.filter((k, i) => declared.indexOf(k) !== i), []);
  for (const [key, value] of Object.entries(en)) {
    const forms = typeof value === 'string' ? [value] : [value.one, value.other];
    if (typeof value !== 'string') {
      assert.strictEqual(typeof value.one, 'string', `${key} has no "one" form`);
      assert.strictEqual(typeof value.other, 'string', `${key} has no "other" form`);
    }
    for (const f of forms) assert.ok(!/\{\d+\}/.test(f), `${key} uses a numbered placeholder`);
  }
  for (const k of ['meta.lang', 'meta.locale', 'meta.dir']) assert.ok(en[k], k);
});

test('every kind of copy and every source the library names has its words', () => {
  const { FIDELITY, INEXACT } = require('../src/quality');
  const kinds = new Set([...Object.keys(FIDELITY), ...INEXACT,
    // The kinds the media sources give, fixed by the shared contract.
    'thumbnail', 'thumbnail, name unknown', 'fat undelete', 'exfat undelete', 'carved', 'snipping tool capture']);
  assert.deepStrictEqual([...kinds].filter((k) => !en['kind.' + k] || !en['kindHelp.' + k]), []);
  const { sources } = require('../src/index');
  const gaps = sources.flatMap((s) => ['label', 'keeps', 'howLong'].map((f) => `source.${s.id}.${f}`)).filter((k) => !en[k]);
  assert.deepStrictEqual(gaps, []);
});

test('the page loads nothing from anywhere else, and asks its own server by relative names', () => {
  // SVG's namespace, which app.js makes its icons in, names no place: nothing is fetched from it.
  const SVG_NS = "'http://www.w3.org/2000/svg'";
  assert.strictEqual(app.split(SVG_NS).length, 2, 'app.js names the SVG namespace once');
  for (const [name, text] of [['index.html', html], ['app.js', app.replace(SVG_NS, "''")], ['style.css', css], ['strings.js', stringsSource]]) {
    assert.ok(!/\b(?:https?|wss?|ftp):\/\//i.test(text), `${name} names a URL`);
    assert.ok(!/(?:src|href|action)\s*=\s*["']?\/\//i.test(text), `${name} has a protocol-relative reference`);
  }
  assert.ok(!/@import/i.test(css), 'style.css imports');
  // Besides what is written into it, style.css loads one file: the font beside it, by a relative name.
  const cssRefs = [...css.matchAll(/url\(\s*([^)]*)\)/gi)].map((m) => m[1].trim().replace(/^["']|["']$/g, '')).filter((r) => !r.startsWith('data:'));
  assert.deepStrictEqual(cssRefs, ['fonts/PretendardVariable.woff2']);
  for (const r of cssRefs) assert.ok(fs.existsSync(path.join(UI, ...r.split('/'))), r);
  // What index.html loads is the files beside it, by the names the built program keeps them under.
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((r) => !r.startsWith('#') && !r.startsWith('data:'));
  assert.deepStrictEqual(refs.sort(), ['app.js', 'strings.js', 'style.css']);
  for (const r of refs) assert.ok(fs.existsSync(path.join(UI, r)), r);
  // Requests to the server are relative, so the page works wherever it is mounted.
  assert.ok(!/['`"]\/api\//.test(app), 'app.js asks for /api/ from the root');
  // The endpoints the page relies on, as its header says: a change here is a change of contract.
  const called = new Set([...code.matchAll(/['`](api\/[a-z-]+(?:\/[a-z-]+)?)/g)].map((m) => m[1]));
  assert.deepStrictEqual([...called].sort(), [
    'api/bye', 'api/cancel', 'api/check-folder', 'api/copy', 'api/drives', 'api/events', 'api/info', 'api/job', 'api/lang',
    'api/plan', 'api/quit', 'api/rebuild', 'api/restore', 'api/search', 'api/sources', 'api/sources/describe', 'api/theme',
  ]);
  // A language's table is one of the page's own files, asked for by a name relative to the page.
  assert.match(code, /fetch\(`lang\/\$\{enc\(code\)\}\.json`/);
});

test('the browser is told not to translate the page, which would send its words away', () => {
  assert.match(html, /<html\b[^>]*\stranslate="no"/);
  assert.match(html, /<meta name="google" content="notranslate">/);
  // app.js changes the language and the direction of <html>, and leaves the rest of it alone.
  assert.ok(!/documentElement\.(?:removeAttribute|setAttribute)\(\s*['"]translate/.test(app));
});

test('nothing runs inline, and recovered content is never parsed as HTML', () => {
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(m[1], /\bsrc="/, 'a script without src');
    assert.strictEqual(m[2].trim(), '', 'a script with a body');
  }
  assert.ok(!/<style\b/i.test(html), 'an inline <style>');
  assert.ok(!/\sstyle\s*=/i.test(html), 'a style attribute');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'an inline event handler');
  assert.ok(!/javascript:/i.test(html + app), 'a javascript: URL');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', "setAttribute('style'",
    'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', '.style.cssText']) {
    assert.ok(!code.includes(bad), `app.js uses ${bad}`);
  }
  // Nothing is downloaded: no download attribute, and "nodownload" in every player's controls.
  assert.ok(!/(?<!no)download/.test(code), 'app.js uses download');
  const players = [...code.matchAll(/h\('video', \{([^}]*)\}/g)].map((m) => m[1]);
  assert.strictEqual(players.length, 1, 'every video shown is made by player()');
  assert.match(players[0], /controlslist: 'nodownload noremoteplayback'/);
  assert.match(players[0], /disablepictureinpicture: true/);
  // The one made another way lends the grid a frame and is never shown: it has no controls.
  assert.ok(!/\.controls\s*=|setAttribute\('controls'/.test(code), 'a video given controls by hand');
  // Nor is the browser's own menu, with "Save image as", opened over a picture or a video, nor
  // does Ctrl+S save the page with its pictures.
  assert.match(code, /addEventListener\('contextmenu', \(e\) => \{\s*if \(e\.target && e\.target\.closest && e\.target\.closest\('img, video, canvas, \.media-frame'\)\) e\.preventDefault\(\);/);
  assert.match(code, /addEventListener\('keydown', \(e\) => \{\s*if \(\(e\.ctrlKey \|\| e\.metaKey\) && !e\.altKey && String\(e\.key\)\.toLowerCase\(\) === 's'\) e\.preventDefault\(\);/);
  // What sets an element's content from a string does it as text: h() takes `text`, and strings among children are text nodes.
  assert.match(code, /else if \(k === 'text'\) el\.textContent = String\(v\);/);
  assert.match(code, /el\.append\(typeof c === 'object' \? c : String\(c\)\)/);
});

test('strings are filled in by name, in the plural the count needs', () => {
  ui.setLanguage('en');
  assert.strictEqual(ui.tr('results.title.name', { name: 'budget' }), 'Results for “budget”');
  assert.strictEqual(ui.tr('results.files', { count: 1 }), '1 file');
  assert.strictEqual(ui.tr('results.files', { count: 1284 }), '1,284 files');
  assert.strictEqual(ui.tr('no.such.key'), 'no.such.key');
  // A placeholder with nothing to fill it stays visible rather than turning into "undefined".
  assert.strictEqual(ui.tr('restore.done.many', {}), '{count} items restored into');
  // Markup in a name is only ever text.
  assert.strictEqual(ui.tr('results.nameOnly', { name: '<img src=x onerror=alert(1)>' }), '<img src=x onerror=alert(1)> (folder unknown)');
  assert.strictEqual(ui.pickLanguage(['ko-KR', 'en-US']), 'en');
  assert.strictEqual(ui.pickLanguage([]), 'en');
});

test('a string that counts is always given its count', () => {
  // A plural form, or {count}, with no count to go by would show "{count}", or the form of 0 --
  // Arabic has one of its own -- if only for a moment: so every such key is asked for with one.
  const counting = new Set(Object.keys(en).filter((k) => typeof en[k] === 'object' || String(en[k]).includes('{count}')));
  const missing = [];
  let calls = 0;
  for (const m of code.matchAll(/\btr\(\s*'([^']+)'\s*([,)])/g)) {
    if (!counting.has(m[1])) continue;
    calls++;
    let args = '';
    if (m[2] === ',') {
      let depth = 1;
      for (let i = m.index + m[0].length; i < code.length && depth; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')') depth--;
        if (depth) args += code[i];
      }
    }
    if (!/\bcount\b/.test(args)) missing.push(`${m[1]} at line ${code.slice(0, m.index).split('\n').length}`);
  }
  assert.ok(calls > 40, `only ${calls} calls found; the scan is broken`);
  assert.deepStrictEqual(missing, []);
  // And were one to be asked for without, it is the "other" form, not the one for 0.
  ui.setLanguage('en');
  assert.strictEqual(ui.tr('results.showMore'), 'Show {count} more');
});

test('sizes read as the command line prints them', () => {
  const fmt = require('../src/format');
  for (const n of [0, 1, 1023, 1024, 1536, 10 * 1024, 31 * 1024, 5.25 * 1024 * 1024, 12.3 * 1024 * 1024, 3.4 * 1024 ** 3]) {
    assert.strictEqual(ui.fmtSize(n), fmt.size(n), String(n));
  }
  assert.strictEqual(ui.fmtSize(null), 'size unknown');
});

test('a copy is labelled by the worst of what its tier and its flags say', () => {
  const cases = [
    [{ tier: 0 }, 'exact'], [{ tier: 1 }, 'inexact'], [{ tier: 2 }, 'draft'], [{ tier: 3 }, 'unverified'], [{ tier: 4 }, 'derived'],
    [{ tier: 'near' }, 'inexact'], [{ tier: 'smaller' }, 'derived'], [{ tier: 'pieced' }, 'unverified'],
    [{ tier: 0, derived: true }, 'derived'], [{ tier: 1, unverified: true }, 'unverified'], [{ unverified: true, draft: true }, 'unverified'],
    [{ draft: true }, 'draft'], [{ inexact: true }, 'inexact'], [{}, 'exact'], [{ isDir: true, tier: 0 }, 'folder'],
    [{ gone: true, tier: 0 }, 'gone'], [{ state: 'no content' }, 'gone'],
  ];
  for (const [c, want] of cases) assert.strictEqual(ui.tierOf(c), want, JSON.stringify(c));
  assert.strictEqual(ui.tierText({ tier: 4, width: 256, height: 192 }), 'Smaller copy, 256 × 192');
  assert.strictEqual(ui.tierText({ tier: 3 }), 'May be incomplete');
  assert.strictEqual(ui.tierText({ draft: true }), 'Never saved');
  assert.strictEqual(ui.mediaOf({ media: 'photo' }), 'image');
  assert.strictEqual(ui.mediaOf({ mediaType: 'video' }), 'video');
  assert.strictEqual(ui.kindLabel('shadow copy'), 'Restore point');
  assert.strictEqual(ui.kindLabel('some future kind', 'Its own label'), 'Its own label');
  assert.strictEqual(ui.kindLabel('some future kind'), 'some future kind');
  assert.strictEqual(ui.timeMeaningOf('recycle bin, inside a deleted folder'), 'deleted');
  assert.strictEqual(ui.timeMeaningOf('git, deleted in a commit'), 'committed');
  assert.strictEqual(ui.timeMeaningOf('claude, after an edit'), 'modified');
  // A thumbnail's date is only what its source could tell; it is shown bare.
  assert.strictEqual(ui.timeMeaningOf('thumbnail'), 'unknown');
});

test('names, folders and drives come apart as src/paths.js reads them', () => {
  assert.strictEqual(ui.baseName('C:\\work\\a.txt'), 'a.txt');
  assert.strictEqual(ui.dirName('C:\\work\\a.txt'), 'C:\\work');
  assert.strictEqual(ui.dirName('C:\\a.txt'), 'C:\\');
  // On an absolute POSIX path a backslash is part of the name.
  assert.strictEqual(ui.baseName('/d/x\\y.txt'), 'x\\y.txt');
  assert.strictEqual(ui.nameOf({ name: 'IMG_1.jpg' }), 'IMG_1.jpg');
  assert.strictEqual(ui.nameOf({ path: 'C:\\p\\q.png' }), 'q.png');
  assert.strictEqual(ui.nameOf({}), null);
  for (const p of ['C:\\x', 'c:/x', 'D:', '\\\\server\\share', '/home/me']) assert.ok(ui.isAbsolute(p), p);
  for (const p of ['work\\app', 'app', '', '.\\x']) assert.ok(!ui.isAbsolute(p), p);
  assert.ok(ui.isInside('C:\\Work\\App\\src\\a.js', 'c:/work/app'));
  assert.ok(ui.isInside('C:\\work\\app', 'C:\\work\\app\\'));
  assert.ok(!ui.isInside('C:\\work\\apple\\a.js', 'C:\\work\\app'));
  assert.ok(ui.isInside('C:\\x\\y', 'C:\\'));
  assert.ok(!ui.isInside('/home/U/a', '/home/u'));
  assert.strictEqual(ui.rootOf('d:\\x\\y'), 'D:\\');
  assert.strictEqual(ui.rootOf('\\\\nas\\photos\\2024'), '\\\\nas\\photos\\');
  assert.strictEqual(ui.rootOf('/media/me/card'), '/');
  assert.strictEqual(ui.rootOf('relative'), null);
  // A drive given as a device is that drive.
  assert.strictEqual(ui.rootOf('\\\\.\\e:'), 'E:\\');
  assert.strictEqual(ui.rootOf('\\\\?\\E:\\DCIM'), 'E:\\');
  assert.strictEqual(ui.joinPath('E:\\', 'Solarljos recovered', '2026-09-29 08.30'), 'E:\\Solarljos recovered\\2026-09-29 08.30');
  assert.strictEqual(ui.joinPath('/home/me', 'x'), '/home/me/x');
  assert.strictEqual(ui.syncedBy('C:\\Users\\me\\OneDrive - Contoso\\Pictures'), 'OneDrive');
  assert.strictEqual(ui.syncedBy('D:\\Recovered'), null);
  assert.strictEqual(ui.partOfName('budget-final-v2.xlsx'), 'budget');
  assert.strictEqual(ui.partOfName('*.hwp'), null);
  assert.strictEqual(ui.partOfName('report.docx'), 'report');
});

test('copies group by file, the best by tier then time, with a newer draft pointed out', () => {
  const c = (uid, o) => ({ uid, path: 'C:\\work\\budget.xlsx', state: 'deleted', ...o });
  const groups = ui.groupFiles([
    c('a', { tier: 0, time: 100, kind: 'recycle bin' }),
    c('b', { tier: 2, draft: true, time: 300, kind: 'unsaved editor buffer' }),
    c('c', { tier: 0, time: 200, kind: 'shadow copy', path: 'c:/WORK/budget.xlsx' }),
    c('d', { tier: 0, time: 50, path: 'C:\\work\\budget.xlsx', isDir: true }),
    { uid: 'e', name: 'IMG_1.jpg', tier: 4, time: null },
    { uid: 'f', tier: 3, time: null, ext: '.png' },
  ]);
  assert.strictEqual(groups.length, 4);
  const file = groups.find((g) => g.key.startsWith('file:'));
  assert.strictEqual(file.best.uid, 'c');
  assert.strictEqual(file.newer.uid, 'b');
  assert.deepStrictEqual(file.versions.map((x) => x.uid), ['b', 'c', 'a']);
  assert.ok(groups.find((g) => g.key.startsWith('dir:')).isDir);
  assert.strictEqual(groups.find((g) => g.key.startsWith('name:')).folder, null);
  // Newest first, undated last, whichever way time runs.
  assert.deepStrictEqual(ui.sortRows(groups, 'newest').map((g) => g.best.uid), ['c', 'd', 'e', 'f']);
  assert.deepStrictEqual(ui.sortRows(groups, 'oldest').map((g) => g.best.uid), ['d', 'c', 'e', 'f']);
});

test('the filters on the results hide copies, and say how many; the undated are kept', () => {
  const day = (y, m, d) => new Date(y, m - 1, d, 12).getTime();
  const items = [
    { uid: '1', path: 'C:\\work\\a.txt', state: 'deleted', time: day(2026, 9, 20) },
    { uid: '2', path: 'C:\\work\\a.txt', state: 'exists', time: day(2026, 9, 21) },
    { uid: '3', path: 'C:\\other\\b.txt', state: 'deleted', time: day(2026, 1, 1) },
    { uid: '4', name: 'c.txt', state: '', time: null },
  ];
  const since = ui.dayStart('2026-09-01');
  let f = ui.filterResults(items, { deletedOnly: true, since, where: 'C:\\work' });
  assert.deepStrictEqual(f.kept.map((x) => x.uid), ['1']);
  assert.deepStrictEqual(f.hidden, { elsewhere: 1, notDeleted: 2, outsideDates: 0 });
  f = ui.filterResults(items, { since, where: 'C:\\work', allPlaces: true });
  assert.deepStrictEqual(f.kept.map((x) => x.uid), ['1', '2', '4']);
  assert.strictEqual(f.hidden.outsideDates, 1);
  assert.strictEqual(f.undated, 1);
  assert.deepStrictEqual(ui.filterResults(items, { q: 'OTHER' }).kept.map((x) => x.uid), ['3']);

  const media = [
    { uid: 'p', mediaType: 'image', tier: 0, time: day(2025, 7, 3), source: 'recycle' },
    { uid: 't', mediaType: 'image', tier: 4, derived: true, width: 256, height: 192, time: null, source: 'thumbcache' },
    { uid: 'x', mediaType: 'image', tier: 4, width: 32, height: 24, time: day(2025, 7, 9), source: 'thumbcache' },
    { uid: 'v', mediaType: 'video', tier: 0, time: day(2023, 5, 1), source: 'vss' },
  ];
  const lastYear = ui.mediaRange('pick', '2025-01-01', '2025-12-31');
  const m = ui.filterMedia(media, { ...lastYear, smaller: true, hideTiny: true });
  assert.deepStrictEqual(m.kept.map((x) => x.uid), ['p', 't']);
  assert.deepStrictEqual(m.hidden, { elsewhere: 0, outsideDates: 1, smaller: 0, tiny: 1, source: 0 });
  assert.deepStrictEqual(ui.filterMedia(media, { ...lastYear, smaller: false }).kept.map((x) => x.uid), ['p']);
  assert.deepStrictEqual(ui.mediaCounts(media), { photos: 3, videos: 1, smaller: 2 });
});

test('dates are days where the user is, and a day that does not exist is refused', () => {
  const d = new Date(ui.dayStart('2026-09-01'));
  assert.deepStrictEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2026, 8, 1, 0, 0]);
  assert.strictEqual(ui.dayStart('2026-02-30'), null);
  assert.strictEqual(ui.dayStart('2026-09-01', true) + 1, new Date(2026, 8, 2).getTime());
  assert.strictEqual(ui.sinceMs('any'), null);
  assert.strictEqual(ui.sinceMs('day', '', 1000 * 86400000), 999 * 86400000);
  assert.strictEqual(ui.sinceMs('pick', '2026-02-30'), null);
  assert.strictEqual(ui.mediaRange('pick', '2026-09-02', '2026-09-01'), null);
  assert.strictEqual(ui.mediaRange('pick', '', ''), null);
  assert.deepStrictEqual(ui.mediaRange('any'), { from: null, to: null });
  const last = ui.mediaRange('lastYear', '', '', new Date(2026, 5, 1));
  assert.strictEqual(new Date(last.from).getFullYear(), 2025);
  assert.strictEqual(new Date(last.to).getFullYear(), 2025);
  assert.strictEqual(new Date(last.to + 1).getFullYear(), 2026);
  assert.match(ui.stamp(new Date(2026, 8, 29, 8, 5).getTime()), /^2026-09-29 08\.05$/);
});

test('photos group by month, and undated ones keep a group of their own', () => {
  const at = (y, m, d) => new Date(y, m - 1, d, 12).getTime();
  const items = [{ time: at(2025, 7, 9) }, { time: at(2025, 7, 1) }, { time: at(2025, 6, 30) }, { time: null }, { time: null }];
  assert.deepStrictEqual(ui.groupByMonth(items).map((g) => [g.month, g.items.length]), [['2025-07', 2], ['2025-06', 1], [null, 2]]);
  assert.deepStrictEqual(ui.monthCounts(items), [{ month: '2025-07', count: 2 }, { month: '2025-06', count: 1 }, { month: null, count: 2 }]);
});

test('a folder plan becomes a tree, with a file and a folder of one name side by side', () => {
  const f = (rel) => ({ rel, copy: { size: 1 } });
  const top = ui.buildTree([f('bin'), f('bin/cli.js'), f('src/a.js'), f('src/lib/b.js'), f(['README.md']), f('src/Z10.js'), f('src/Z9.js')], 'app');
  assert.strictEqual(top.total, 7);
  assert.deepStrictEqual(top.children.map((c) => [c.name, c.dir]), [['bin', true], ['src', true], ['bin', false], ['README.md', false]]);
  assert.strictEqual(top.children[2].conflict, true);
  assert.strictEqual(top.children[3].conflict, false);
  const src = top.children[1];
  assert.deepStrictEqual(src.children.map((c) => c.name), ['lib', 'a.js', 'Z9.js', 'Z10.js']);
  assert.strictEqual(src.children[0].children[0].rel, 'src/lib/b.js');
  assert.strictEqual(src.children[0].level, 3);
  const excluded = new Set(['src/a.js']);
  const isIn = (n) => !excluded.has(n.rel);
  ui.countIncluded(top, isIn);
  assert.strictEqual(ui.checkState(top, isIn), 'mixed');
  assert.strictEqual(ui.checkState(top.children[0], isIn), 'true');
  excluded.add('src/lib/b.js').add('src/Z10.js').add('src/Z9.js');
  ui.countIncluded(top, isIn);
  assert.strictEqual(ui.checkState(src, isIn), 'false');
});

test('text is read in the encoding it is in: a BOM, UTF-8, then Korean', () => {
  const utf8 = Buffer.from('한글 text', 'utf8');
  assert.deepStrictEqual(ui.decodeText(utf8, 'auto', false), { text: '한글 text', encoding: 'utf-8', bom: null });
  const cp949 = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x20, 0x61]);
  assert.deepStrictEqual(ui.decodeText(cp949, 'auto', false), { text: '한글 a', encoding: 'euc-kr', bom: null });
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')]);
  assert.deepStrictEqual(ui.decodeText(le, 'auto', false), { text: 'hi', encoding: 'utf-16le', bom: 'utf-16le' });
  // Cut in the middle of a character, UTF-8 is still UTF-8: the half is left out, not taken for Korean.
  const cut = utf8.subarray(0, 4);
  assert.deepStrictEqual(ui.decodeText(cut, 'auto', true), { text: '한', encoding: 'utf-8', bom: null });
  assert.strictEqual(ui.decodeText(Buffer.from([0xe9]), 'windows-1252', false).text, 'é');
});

test('bytes are shown as hex, and a copy of nothing but zeros is told', () => {
  const rows = ui.hexRows(Buffer.from('0123456789abcdefXY'), 32);
  assert.deepStrictEqual(rows.map((r) => r.offset), [32, 48]);
  assert.strictEqual(rows[0].hex, '30 31 32 33 34 35 36 37  38 39 61 62 63 64 65 66');
  assert.strictEqual(rows[0].ascii, '0123456789abcdef');
  assert.strictEqual(ui.hexRows(Buffer.from([0, 0x7f, 0x41]), 0)[0].ascii, '..A');
  assert.ok(ui.isAllZero(Buffer.alloc(4096)));
  assert.ok(!ui.isAllZero(Buffer.from([0, 0, 1])));
  assert.ok(!ui.isAllZero(Buffer.alloc(0)));
  assert.strictEqual(ui.magicOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'FF D8 FF E0');
});

test('a name and bytes that disagree are said, but not for a smaller copy', () => {
  const pdf = { mediaType: 'document', ext: '.pdf' };
  assert.match(ui.mismatch({ path: 'C:\\p\\photo.jpg' }, pdf), /\.jpg, but the bytes are PDF/);
  assert.match(ui.mismatch({ path: 'C:\\p\\photo.png' }, { mediaType: 'image', ext: '.jpg' }), /\.png, but the bytes are JPG/);
  assert.strictEqual(ui.mismatch({ path: 'C:\\p\\photo.jpeg' }, { mediaType: 'image', ext: '.jpg' }), null);
  assert.strictEqual(ui.mismatch({ path: 'C:\\v\\clip.mov' }, { mediaType: 'video', ext: '.mp4' }), null);
  assert.match(ui.mismatch({ path: 'C:\\p\\photo.jpg' }, { mediaType: null, ext: null }), /not in any format/);
  assert.strictEqual(ui.mismatch({ path: 'C:\\v\\clip.mp4', tier: 4 }, { mediaType: 'image', ext: '.jpg' }), null);
  assert.strictEqual(ui.mismatch({ path: 'C:\\d\\notes.txt' }, pdf), null);
});

test('an inexact copy read back from a card says a later file may lie there, not that line breaks may differ', () => {
  assert.strictEqual(ui.tierHelpKey({ kind: 'exfat undelete', inexact: true }), 'tier.inexact.help.disk');
  assert.strictEqual(ui.tierHelpKey({ kind: 'fat undelete', tier: 1 }), 'tier.inexact.help.disk');
  assert.strictEqual(ui.tierHelpKey({ kind: 'jetbrains history, as text', tier: 1 }), 'tier.inexact.help.text');
  assert.strictEqual(ui.tierHelpKey({ kind: 'fat undelete', unverified: true }), 'tier.unverified.help');
  assert.strictEqual(ui.tierHelpKey({ kind: 'trash' }), 'tier.exact.help');
  for (const k of ['tier.inexact.help.disk', 'tier.inexact.help.text', 'restore.nameNearDisk']) assert.ok(en[k], k);
  assert.match(en['tier.inexact.help.disk'], /written there since/);
});

test('a folder on another drive is suggested for a restore, never the card being recovered', () => {
  const info = { systemDrive: 'C:\\', home: 'C:\\Users\\me', program: true, runsFrom: 'E:\\' };
  const drives = [
    { root: 'C:\\', letter: 'C', system: true, answering: true, free: 5e11 },
    { root: 'D:\\', letter: 'D', answering: true, free: 2e11 },
    { root: 'E:\\', letter: 'E', answering: true, free: 3e10 },
    { root: 'F:\\', letter: 'F', answering: true, free: 9e11, network: true },
    { root: 'G:\\', letter: 'G', answering: false },
  ];
  const at = new Date(2026, 8, 29, 8, 30).getTime();
  const pick = (o) => ui.suggestDestination({ drives, info, originals: ['C:\\work\\a.txt'], at, ...o });
  assert.deepStrictEqual(pick({}), { path: 'E:\\Solarljos recovered\\2026-09-29 08.30', reason: 'exeDrive', root: 'E:\\' });
  // The program runs from the card being recovered: another drive, the one with the most room.
  assert.strictEqual(pick({ avoid: ['E:'] }).path, 'D:\\Solarljos recovered\\2026-09-29 08.30');
  assert.strictEqual(pick({ originals: ['E:\\DCIM\\1.jpg', 'D:\\x'] }).reason, 'home');
  assert.strictEqual(pick({ originals: ['E:\\DCIM\\1.jpg', 'D:\\x'], desktop: true }).path, 'C:\\Users\\me\\Desktop\\Solarljos recovered\\2026-09-29 08.30');
  // Not enough room there.
  assert.strictEqual(pick({ avoid: ['E:\\'], needed: 3e11 }).reason, 'home');
  // The card given as a device of its drive is that drive.
  assert.strictEqual(pick({ avoid: ['\\\\.\\E:'] }).path, 'D:\\Solarljos recovered\\2026-09-29 08.30');
  assert.strictEqual(pick({ avoid: ['\\\\?\\E:\\'] }).root, 'D:\\');
  // Given as a whole disk or a volume, its letter cannot be told: it may be D: or E:, so no drive
  // but the system's is suggested.
  for (const card of ['\\\\.\\PhysicalDrive1', '\\\\?\\Volume{0b1c2d3e-0000-0000-0000-100000000000}\\', '/dev/sdb']) {
    assert.deepStrictEqual([pick({ avoid: [card] }).reason, pick({ avoid: [card] }).root], ['home', 'C:\\'], card);
  }
  assert.strictEqual(ui.isDevice('\\\\.\\E:'), false);
  assert.strictEqual(ui.isDevice('E:\\'), false);
  assert.strictEqual(ui.isDevice('D:\\card.img'), false);
  assert.strictEqual(ui.onSameDrive(['C:\\a', 'c:/b', 'D:\\c', '/x'], 'C:\\'), 2);
  assert.strictEqual(ui.onSameDrive(['/home/me/a'], '/'), null);
});

test('a search sends only what decides which copies are found', () => {
  const locations = { discover: true, dirs: { trash: ['E:\\'] } };
  const req = {
    mode: 'name', name: 'budget', containing: '', where: 'C:\\work', deletedOnly: true, since: 123, sinceChoice: 'pick', types: [], sources: null,
  };
  // Only-deleted and the date are not sent to be searched by; they travel in `view`, the form as
  // it was, which the server keeps without reading it.
  assert.deepStrictEqual(ui.searchBody(req, locations), {
    pattern: 'budget', locations: { discover: true, dirs: { trash: ['E:\\'], vss: ['walk=C:\\work'] } }, view: req,
  });
  // After a reload the form comes back from it whole, and a search for pictures from the name
  // form stays in that view.
  const kept = { kind: 'search', request: { pattern: 'budget', types: null, view: req } };
  assert.strictEqual(ui.modeOf(kept), 'name');
  assert.deepStrictEqual(ui.requestOf(kept), req);
  assert.strictEqual(ui.modeOf({ kind: 'search', request: { types: ['image'], view: { mode: 'name', types: ['image'] } } }), 'name');
  const media = { mode: 'media', types: ['image'], whenChoice: 'lastYear', includeSmaller: false, where: '' };
  assert.deepStrictEqual(ui.requestOf({ kind: 'search', request: { types: ['image'], view: media } }), media);
  assert.deepStrictEqual(ui.planBody({ mode: 'folder', folder: 'C:\\app', deletedOnly: false, since: null, sources: ['git'] }, { discover: false, dirs: {} }), {
    folder: 'C:\\app', sources: ['git'], locations: { discover: false, dirs: {} },
  });
  assert.strictEqual(ui.query({ offset: 0, limit: 2000, q: '', none: [] }), 'offset=0&limit=2000');
  // After a reload, what the server kept says which view a job belongs to.
  assert.strictEqual(ui.modeOf({ kind: 'search', request: { types: ['image', 'video'] } }), 'media');
  assert.strictEqual(ui.modeOf({ kind: 'search', request: { pattern: 'x', types: ['image'] } }), 'name');
  assert.strictEqual(ui.modeOf({ kind: 'plan', request: {} }), 'folder');
  assert.deepStrictEqual(ui.requestOf({ kind: 'search', request: { pattern: 'a', containing: null, types: null, sources: null } }),
    { mode: 'name', name: 'a', containing: '', types: [], sources: null });
});

test('errors are said in words: the server\'s own sentence, or what a system error means', () => {
  const E = ui.ApiError;
  assert.strictEqual(ui.errorText(new E(404, 'That copy is no longer kept; search again.')), 'That copy is no longer kept; search again.');
  assert.strictEqual(ui.errorText(new E(500, 'Could not read this copy: EACCES: permission denied')), en['error.io.EACCES']);
  assert.strictEqual(ui.errorText({ message: 'no space', code: 'ENOSPC' }), 'The drive is full.');
  assert.strictEqual(ui.errorText(new E(0, 'fetch failed')), en['error.offline']);
  assert.strictEqual(ui.errorText(new E(403, 'Open Solarljos from the window it opened')), en['error.forbidden']);
  assert.strictEqual(ui.errorText(new E(410, '')), en['error.gone']);
  assert.strictEqual(ui.errorText(new E(500, 'disk on fire')), 'Could not read or write: disk on fire');
});
