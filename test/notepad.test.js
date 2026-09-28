'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { workDir, cleanup, write, only, snapshot } = require('./helpers');
const notepad = require('../src/sources/notepad');
const { parseTab, readLog, coalesce, replay, encode, copiesOf, tabStateDirs, crc32Table, REPLAY_WORK, TOO_LARGE } =
  notepad._internal;
const { search, git } = require('../src/search');
const { planRebuild, restore } = require('../src/restore');
const { load } = require('../src/content');
const { pathKey } = require('../src/paths');

const dirs = [];
after(() => dirs.forEach(cleanup));

// Tab files are built here the way Notepad writes them: unsigned LEB128 numbers, UTF-16LE
// text with a lone CR for each line break, and big-endian CRC32s.

const crc32 = typeof zlib.crc32 === 'function' ? (b) => zlib.crc32(b) >>> 0 : crc32Table;

function uleb(n) {
  let v = BigInt(n);
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

const u16 = (s) => Buffer.from(s, 'utf16le');
const be32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const filetime = (ms) => (BigInt(ms) + 11644473600000n) * 10000n;

/** One edit-log entry: at `pos`, delete `del` characters and insert `text`. */
function entry(pos, del, text = '') {
  const body = Buffer.concat([uleb(pos), uleb(del), uleb(text.length), u16(text)]);
  return Buffer.concat([body, be32(crc32(body))]);
}

/**
 * A tab file. With `path` it is tied to a file, otherwise untitled. `opts` are the option
 * bytes after the first three: none before 11.2408, three in current Notepad. `unsaved` is
 * the byte written, 0 or 1 from Notepad.
 */
function tabFile(o) {
  const parts = [uleb(o.path == null ? 0 : 1)];
  if (o.path != null) {
    parts.push(uleb(o.path.length), u16(o.path), uleb(o.savedSize || 0), Buffer.from([o.encoding || 5, o.eol || 1]),
      uleb(o.filetime || 0n), o.sha256 || Buffer.alloc(32), Buffer.from([0, 1]));
  } else {
    parts.push(Buffer.from([1]));
  }
  const opts = o.opts || [1, 1, 1];
  parts.push(uleb(o.text.length), uleb(o.text.length), Buffer.from([1, 0, 0]), uleb(opts.length), Buffer.from(opts),
    uleb(o.text.length), u16(o.text), Buffer.from([o.unsaved || 0]));
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from('NP'), uleb(0), body, be32(crc32(body)), ...(o.log || []).map((e) => entry(...e))]);
}

/** A <guid>.0.bin: caret and options, no text; the CRC starts at the sequence number. */
function stateFile(binSize, seq = 1) {
  const rest = Buffer.concat([Buffer.from([0]), uleb(binSize), uleb(0), uleb(0), Buffer.from([1, 0, 0]), uleb(3), Buffer.from([1, 1, 1])]);
  const covered = Buffer.concat([uleb(seq), uleb(rest.length), rest]);
  return Buffer.concat([Buffer.from('NP'), covered, be32(crc32(covered))]);
}

const guid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const SAVED_AT = Date.UTC(2024, 5, 1, 9, 0);
const TAB_AT = Date.UTC(2026, 8, 20, 12, 0);
const TODO = 'C:\\Users\\alice\\notes\\todo.txt';
const PLAN = 'C:\\Users\\alice\\notes\\plan.md';
const TODO_TEXT = 'first line\rsecond line\r';
const TODO_ON_DISK = Buffer.concat([Buffer.from([0xff, 0xfe]), u16('first line\r\nsecond line\r\n')]);

test('CRC-32 is the standard one, with or without zlib', () => {
  assert.strictEqual(crc32Table(Buffer.from('123456789')), 0xcbf43926);
  const data = crypto.randomBytes(5000);
  assert.strictEqual(notepad._internal.crc32(data), crc32Table(data));
});

test('reads a file tab and an untitled tab; a broken header or a state file is not a tab', () => {
  const file = parseTab(tabFile({ path: PLAN, text: 'a\rb', unsaved: 1, encoding: 5, eol: 3, filetime: filetime(SAVED_AT) }));
  assert.strictEqual(file.path, PLAN);
  assert.strictEqual(file.text, 'a\rb');
  assert.strictEqual(file.unsaved, 1);
  assert.strictEqual(file.fileTime, SAVED_AT);
  assert.deepStrictEqual(file.log, []);
  const untitled = parseTab(tabFile({ text: 'x', log: [[1, 0, 'y']] }));
  assert.strictEqual(untitled.path, null);
  assert.deepStrictEqual(untitled.log, [{ pos: 1, del: 0, added: 'y' }]);

  const broken = tabFile({ path: PLAN, text: 'a\rb', unsaved: 1 });
  broken[10] ^= 0x01;
  assert.strictEqual(parseTab(broken), null, 'header CRC fails');
  assert.strictEqual(parseTab(stateFile(120)), null, 'a state file has a length where a tab has its type');
  assert.strictEqual(parseTab(Buffer.from('not a tab file')), null);
  assert.strictEqual(parseTab(tabFile({ text: 'abc' }).subarray(0, 12)), null, 'cut short');
  assert.strictEqual(parseTab(tabFile({ path: PLAN, text: 'a', unsaved: 2 })), null, 'an unsaved byte Notepad never writes');
});

test('a saved copy is taken only when it has the recorded size and SHA-256', () => {
  const cases = [
    [2, 1, TODO_ON_DISK],
    [3, 2, Buffer.concat([Buffer.from([0xfe, 0xff]), u16('first line\rsecond line\r').swap16()])],
    [4, 3, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('first line\nsecond line\n')])],
    [5, 1, Buffer.from('first line\r\nsecond line\r\n')],
    [1, 3, Buffer.from('first line\nsecond line\n')],
  ];
  for (const [encoding, eol, bytes] of cases) {
    assert.deepStrictEqual(encode(TODO_TEXT, encoding, eol), bytes, `encoding ${encoding}`);
    const tab = parseTab(tabFile({
      path: TODO, text: TODO_TEXT, encoding, eol, savedSize: bytes.length, sha256: sha256(bytes), filetime: filetime(SAVED_AT), opts: [],
    }));
    const copies = copiesOf(tab);
    assert.deepStrictEqual(copies.map((c) => c.kind), ['notepad, as last saved'], `encoding ${encoding}`);
    assert.deepStrictEqual(copies[0].buffer, bytes);
    assert.strictEqual(copies[0].time, SAVED_AT);
    assert.ok(!copies[0].draft);
  }
  const skipped = {};
  const wrongHash = tabFile({
    path: TODO, text: TODO_TEXT, encoding: 2, eol: 1, savedSize: TODO_ON_DISK.length, sha256: Buffer.alloc(32, 7), opts: [],
  });
  assert.deepStrictEqual(copiesOf(parseTab(wrongHash), skipped), []);
  const wrongSize = tabFile({ path: TODO, text: TODO_TEXT, encoding: 2, eol: 1, savedSize: 3, sha256: sha256(TODO_ON_DISK), opts: [] });
  assert.deepStrictEqual(copiesOf(parseTab(wrongSize), skipped), []);
  assert.deepStrictEqual(skipped, { unverified: 2 }, 'what was left out is counted');

  // No last-write time recorded: the copy is undated, not dated 1601.
  const undated = copiesOf(parseTab(tabFile({
    path: TODO, text: TODO_TEXT, encoding: 2, eol: 1, savedSize: TODO_ON_DISK.length, sha256: sha256(TODO_ON_DISK), opts: [],
  })));
  assert.deepStrictEqual(undated.map((c) => [c.kind, c.time]), [['notepad, as last saved', null]]);
  const draft = copiesOf(parseTab(tabFile({ path: PLAN, text: 'x', unsaved: 1 })));
  assert.strictEqual(draft[0].note, 'never saved to disk', 'no date to name');
});

test('the edit log is replayed only when every entry is whole, passes its CRC and fits', () => {
  const buf = tabFile({ text: '', log: [[0, 0, 'hello'], [1, 3, ''], [1, 0, 'i']] });
  const tab = parseTab(buf);
  assert.strictEqual(replay(tab.text, tab.log), 'hio');

  const badCrc = Buffer.from(buf);
  badCrc[badCrc.length - 1] ^= 0xff;
  assert.strictEqual(parseTab(badCrc).log, null, 'an entry fails its CRC');
  assert.strictEqual(parseTab(buf.subarray(0, buf.length - 2)).log, null, 'the last entry is cut short');
  assert.strictEqual(readLog(Buffer.concat([buf, Buffer.from([0])]), buf.length), null, 'stray bytes at the end');
  assert.strictEqual(replay('abc', [{ pos: 2, del: 5, added: '' }]), null, 'deletes past the end');
  assert.strictEqual(replay('abc', [{ pos: 9, del: 0, added: 'x' }]), null, 'inserts past the end');
});

/** Every entry spliced into the text on its own, the way Notepad applies them. */
function spliceEach(text, log) {
  let s = text;
  for (const e of log) {
    if (e.pos + e.del > s.length) return null;
    s = s.slice(0, e.pos) + e.added + s.slice(e.pos + e.del);
  }
  return s;
}

/** A seeded generator of numbers in [0, 1), the same on every machine. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), a | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `n` entries as a person editing makes them: typing and pasting at the caret, backspacing one
 * character or a word, deleting forward, replacing a selection, moving the caret, and now and
 * then an entry that does not fit, after which nothing more counts.
 */
function editing(rand, length, n) {
  const below = (k) => Math.floor(rand() * k);
  const log = [];
  let len = length;
  let caret = below(len + 1);
  while (log.length < n) {
    const r = rand();
    let e;
    if (r < 0.35) {
      e = { pos: caret, del: 0, added: 'x\uD55C\r'[below(3)] }; // a key
    } else if (r < 0.42) {
      e = { pos: caret, del: 0, added: 'pasted'.slice(0, 1 + below(6)) };
    } else if (r < 0.55) {
      const k = Math.min(caret, 1 + below(4)); // backspace, or a word of it
      e = { pos: caret - k, del: k, added: '' };
    } else if (r < 0.63) {
      e = { pos: caret, del: Math.min(len - caret, 1 + below(3)), added: '' }; // delete
    } else if (r < 0.72) {
      const pos = below(len + 1); // a selection replaced
      e = { pos, del: below(len - pos + 1), added: below(2) ? 'y' : '' };
    } else if (r < 0.98) {
      caret = below(len + 1);
      continue;
    } else {
      log.push({ pos: len + below(3), del: 1 + below(2), added: 'z' });
      break;
    }
    log.push(e);
    len += e.added.length - e.del;
    caret = e.pos + e.added.length;
  }
  return log;
}

test('entries that carry on from the one before are joined, and give what splicing each in would', () => {
  const E = (pos, del, added = '') => ({ pos, del, added });
  const cases = [
    [[E(2, 0, 'a'), E(3, 0, 'b')], [E(2, 0, 'ab')], 'typing on'],
    [[E(2, 0, 'a'), E(3, 2)], [E(2, 2, 'a')], 'deleting forward'],
    [[E(2, 0, 'ab'), E(3, 1)], [E(2, 0, 'a')], 'backspacing into what was typed'],
    [[E(2, 0, 'a'), E(0, 3)], [E(0, 2)], 'backspacing past it'],
    [[E(4, 1), E(3, 1), E(2, 1, 'Z')], [E(2, 3, 'Z')], 'backspacing over the text, then typing'],
    [[E(2, 0, 'a'), E(0, 0, 'b')], [E(2, 0, 'a'), E(0, 0, 'b')], 'a jump starts again'],
  ];
  for (const [log, joined, what] of cases) {
    assert.deepStrictEqual(coalesce(log), joined, what);
    assert.strictEqual(replay('hello', log), spliceEach('hello', log), what);
  }
  assert.deepStrictEqual(coalesce([E(2, 0, 'a'), E(3, 9)]), [E(2, 9, 'a')]);
  assert.strictEqual(replay('hello', [E(2, 0, 'a'), E(3, 9)]), null, 'a join fits only when each entry would');

  const rand = random(20260928);
  let entries = 0;
  let splices = 0;
  for (let i = 0; i < 400; i++) {
    const text = 'ab\rc\uD55Cd'.repeat(Math.floor(rand() * 8));
    const log = editing(rand, text.length, Math.floor(rand() * 80));
    assert.strictEqual(replay(text, log), spliceEach(text, log), `trial ${i}`);
    entries += log.length;
    splices += coalesce(log).length;
  }
  assert.ok(splices < entries / 2, `${entries} entries became ${splices} splices`);
});

test('a keystroke log on a big text is replayed in one splice, well inside the work allowed', () => {
  /** Typing at one place, with a backspace every tenth key; and the text that gives. */
  const typing = (text, at, n) => {
    const log = [];
    const typed = [];
    for (let i = 0; i < n; i++) {
      if (i % 10 === 9) {
        log.push({ pos: at + typed.length - 1, del: 1, added: '' });
        typed.pop();
      } else {
        log.push({ pos: at + typed.length, del: 0, added: '\uD55C' });
        typed.push('\uD55C');
      }
    }
    return { log, expected: text.slice(0, at) + typed.join('') + text.slice(at) };
  };
  const small = 'abcdefghij\r'.repeat(500);
  const few = typing(small, 2750, 5000);
  assert.strictEqual(replay(small, few.log), spliceEach(small, few.log));
  assert.strictEqual(replay(small, few.log), few.expected);

  const big = 'abcdefghij\r'.repeat(100000);
  const many = typing(big, 550000, 20000);
  assert.ok(many.log.length * big.length > REPLAY_WORK, 'spliced in one by one, it would be over the limit');
  assert.strictEqual(coalesce(many.log).length, 1);
  assert.strictEqual(replay(big, many.log), many.expected);
});

test('an edit log that would take too much work is left out, and the search says so', async () => {
  const far = [{ pos: 0, del: 0, added: 'x' }, { pos: 20, del: 0, added: 'y' }];
  assert.strictEqual(replay('abc'.repeat(10), far, 40), TOO_LARGE);
  assert.strictEqual(replay('abc'.repeat(10), far, 100), spliceEach('abc'.repeat(10), far));

  const root = workDir('notepad-large');
  dirs.push(root);
  const dir = path.join(root, 'TabState');
  // Keys pressed far apart in a big text, each its own splice, more of them than are allowed.
  const text = 'abcdefghij\r'.repeat(20000);
  const log = [];
  for (let i = 0; log.length * text.length <= REPLAY_WORK; i++) log.push([i % 2 ? text.length - 1 : 0, 0, 'k']);
  write(path.join(dir, `${guid(1)}.bin`), tabFile({ path: PLAN, text, unsaved: 1, log }));
  write(path.join(dir, `${guid(2)}.bin`), tabFile({ path: TODO, text: 'small', unsaved: 1, log: [[5, 0, '!']] }));
  const locations = only({ dirs: { notepad: [dir] } });
  const { results, perSource } = await search({ pattern: '*', sources: ['notepad'], locations });
  assert.deepStrictEqual(results.map((r) => r.path), [TODO]);
  assert.match(perSource[0].notes.join('\n'), /^1 tab\(s\) have an edit log too large to replay/m);
});

test('text that cannot be written in its own encoding comes back as UTF-8, and says so', () => {
  const tab = parseTab(tabFile({
    path: 'C:\\Users\\alice\\café.txt', text: 'café\rcrème', unsaved: 1, encoding: 1, eol: 1, filetime: filetime(SAVED_AT),
  }));
  const [copy] = copiesOf(tab);
  assert.strictEqual(copy.kind, 'notepad, edits never saved');
  assert.strictEqual(copy.text, 'café\r\ncrème');
  assert.strictEqual(copy.buffer, undefined);
  assert.match(copy.note, /UTF-8/);
  assert.match(copy.note, /ANSI/);
  // Plain ASCII is the same in every ANSI code page, so it keeps its bytes.
  const ascii = copiesOf(parseTab(tabFile({ path: 'C:\\Users\\alice\\a.txt', text: 'plain\r', unsaved: 1, encoding: 1, eol: 1 })));
  assert.deepStrictEqual(ascii[0].buffer, Buffer.from('plain\r\n'));
  // Values no known version writes: the text still comes back, and the note says what changed.
  const eol = copiesOf(parseTab(tabFile({ path: 'C:\\Users\\alice\\b.txt', text: 'x\ry', unsaved: 1, encoding: 5, eol: 9 })));
  assert.deepStrictEqual(eol[0].buffer, Buffer.from('x\r\ny'));
  assert.match(eol[0].note, /CRLF/);
  assert.doesNotMatch(eol[0].note, /UTF-8/);
  const enc = copiesOf(parseTab(tabFile({ path: 'C:\\Users\\alice\\c.txt', text: 'x\ry', unsaved: 1, encoding: 9, eol: 3 })));
  assert.strictEqual(enc[0].text, 'x\ny');
  assert.match(enc[0].note, /encoding not known here/);
  // A saved copy is never offered from values that cannot be checked.
  const unchecked = Buffer.from('x\r\ny');
  assert.deepStrictEqual(copiesOf(parseTab(tabFile({
    path: 'C:\\Users\\alice\\d.txt', text: 'x\ry', encoding: 5, eol: 9, savedSize: unchecked.length, sha256: sha256(unchecked), opts: [],
  }))), []);
});

/** A TabState folder holding one of everything, every tab file dated TAB_AT. */
function makeTabState() {
  const root = workDir('notepad');
  dirs.push(root);
  const dir = path.join(root, 'TabState');
  const put = (name, buf) => {
    const file = write(path.join(dir, name), buf);
    fs.utimesSync(file, new Date(TAB_AT), new Date(TAB_AT));
  };
  // Before 11.2408: the saved file's text with its hash, and something typed since.
  put(`${guid(1)}.bin`, tabFile({
    path: TODO, text: TODO_TEXT, encoding: 2, eol: 1, savedSize: TODO_ON_DISK.length, sha256: sha256(TODO_ON_DISK),
    filetime: filetime(SAVED_AT), opts: [], log: [[TODO_TEXT.length, 0, 'third']],
  }));
  put(`${guid(1)}.0.bin`, stateFile(200));
  put(`${guid(1)}.1.bin`, Buffer.alloc(0));
  // From 11.2408: a changed tab holds the edited text; an unchanged one only its path.
  put(`${guid(2)}.bin`, tabFile({
    path: PLAN, text: '# Plan\rstep 1', unsaved: 1, savedSize: 99, encoding: 5, eol: 3, filetime: filetime(SAVED_AT),
  }));
  put(`${guid(3)}.bin`, tabFile({ path: 'C:\\Users\\alice\\notes\\old.txt', text: '', log: [[0, 0, 'on nothing']] }));
  // Untitled tabs, one of them set aside as a .bin.bak.
  put(`${guid(4)}.bin`, tabFile({ text: '', log: [[0, 0, 'hello'], [1, 3, ''], [1, 0, 'i']] }));
  put(`${guid(5)}.bin.bak`, tabFile({ text: 'closed\rtab' }));
  // Damaged: a header that fails its CRC, and a log cut short.
  const broken = tabFile({ path: 'C:\\Users\\alice\\notes\\broken.txt', text: 'x', unsaved: 1 });
  broken[12] ^= 0x01;
  put(`${guid(6)}.bin`, broken);
  const torn = tabFile({ path: 'C:\\Users\\alice\\notes\\torn.txt', text: 'base', unsaved: 1, log: [[4, 0, '!']] });
  put(`${guid(7)}.bin`, torn.subarray(0, torn.length - 1));
  put('not-a-guid.bin', tabFile({ path: 'C:\\Users\\alice\\notes\\stray.txt', text: 'stray', unsaved: 1 }));
  return dir;
}

const locs = (dir) => only({ dirs: { notepad: [dir] } });

test('finds saved copies and unsaved edits by name, dated as Notepad recorded them', async () => {
  const dir = makeTabState();
  const { results, perSource } = await search({ pattern: '*', sources: ['notepad'], locations: locs(dir) });
  const rows = results.map((r) => [r.kind, r.path, r.time, !!r.draft]);
  assert.deepStrictEqual(rows, [
    ['notepad, edits never saved', PLAN, TAB_AT, true],
    ['notepad, edits never saved', TODO, TAB_AT, true],
    ['notepad, as last saved', TODO, SAVED_AT, false],
  ]);
  assert.deepStrictEqual(await load(results[2], git), TODO_ON_DISK);
  assert.deepStrictEqual(await load(results[1], git),
    Buffer.concat([Buffer.from([0xff, 0xfe]), u16('first line\r\nsecond line\r\nthird')]));
  assert.strictEqual((await load(results[0], git)).toString(), '# Plan\nstep 1');
  assert.match(results[0].note, /never saved/);
  assert.strictEqual(results[0].origin, path.join(dir, `${guid(2)}.bin`));
  assert.strictEqual(results[0].size, 13);

  const notes = perSource[0].notes.join('\n');
  assert.match(notes, /^1 tab file\(s\) failed their checksum/m);
  assert.match(notes, /^1 tab\(s\) have a damaged edit log/m);
  assert.match(notes, /^1 tab\(s\) hold edits to a file Notepad kept no copy of/m, 'old.txt: a log over text Notepad did not keep');
});

test('a rebuild takes the saved copy over newer unsaved edits, and edits only where nothing was saved', async () => {
  const dir = makeTabState();
  const folder = 'C:\\Users\\alice\\notes';
  const { results } = await search({ under: folder, sources: ['notepad'], locations: locs(dir) });
  const plan = planRebuild(results, folder);
  assert.deepStrictEqual(plan.map((p) => [p.rel.join('/'), p.copy.kind]), [
    ['plan.md', 'notepad, edits never saved'],
    ['todo.txt', 'notepad, as last saved'],
  ]);
});

test('untitled tabs, the .bin.bak among them, are offered only to a search by content alone', async () => {
  const dir = makeTabState();
  const byContent = await search({ pattern: '', containing: 'HIO', sources: ['notepad'], locations: locs(dir) });
  assert.deepStrictEqual(byContent.results.map((r) => [r.kind, r.path, r.draft, r.time]),
    [['notepad, untitled, never saved', null, true, TAB_AT]]);
  assert.strictEqual((await load(byContent.results[0], git)).toString(), 'hio');

  const bak = await search({ pattern: '', containing: 'closed', sources: ['notepad'], locations: locs(dir) });
  assert.strictEqual(bak.results.length, 1);
  assert.strictEqual((await load(bak.results[0], git)).toString(), 'closed\r\ntab', 'CRLF and UTF-8, as Notepad saves a new file');
  assert.ok(bak.results[0].origin.endsWith('.bin.bak'));

  const named = await search({ pattern: '*.txt', containing: 'hio', sources: ['notepad'], locations: locs(dir) });
  assert.deepStrictEqual(named.results, [], 'a name was given, and an untitled tab has none');
  const all = await search({ pattern: '*', sources: ['notepad'], locations: locs(dir) });
  assert.ok(all.results.every((r) => r.path), 'no nameless copy without --containing');
});

test('a saved text that cannot be matched to its hash is counted as such, not as a file with no copy', async () => {
  const root = workDir('notepad-unverified');
  dirs.push(root);
  const dir = path.join(root, 'TabState');
  const old = (name, text, disk, o = {}) => write(path.join(dir, name), tabFile({
    text, savedSize: disk.length, sha256: sha256(disk), filetime: filetime(SAVED_AT), opts: [], ...o,
  }));
  // Before 11.2408, each tab holding the file's text and the hash of its bytes on disk.
  // ANSI beyond ASCII: the bytes are right for the saving machine's code page, unknown here.
  old(`${guid(1)}.bin`, 'caf\u00e9\r', Buffer.from('caf\u00e9\r\n', 'latin1'), { path: 'C:\\Users\\alice\\cafe.txt', encoding: 1, eol: 1 });
  old(`${guid(2)}.bin`, 'caf\u00e9\r', Buffer.from('caf\u00e9\r\n', 'latin1'),
    { path: 'C:\\Users\\alice\\menu.txt', encoding: 1, eol: 1, log: [[5, 0, 'x']] });
  // A file whose line breaks were mixed on disk; Notepad writes them all alike.
  old(`${guid(3)}.bin`, 'a\rb\r', Buffer.from('a\r\nb\n'), { path: 'C:\\Users\\alice\\mixed.txt', encoding: 5, eol: 1 });
  // From 11.2408, an unchanged tab with only its path, and edits in its log.
  write(path.join(dir, `${guid(4)}.bin`), tabFile({ path: 'C:\\Users\\alice\\bare.txt', text: '', log: [[0, 0, 'typed']] }));

  const skipped = {};
  for (const n of [1, 2, 3, 4]) {
    assert.deepStrictEqual(copiesOf(parseTab(fs.readFileSync(path.join(dir, `${guid(n)}.bin`))), skipped), []);
  }
  assert.deepStrictEqual(skipped, { unverified: 3, noBase: 1 });

  const { results, perSource } = await search({ pattern: '*', sources: ['notepad'], locations: locs(dir) });
  assert.deepStrictEqual(results, []);
  const notes = perSource[0].notes.join('\n');
  assert.match(notes, /^3 tab\(s\) hold a saved file's text that could not be matched to the size and SHA-256/m);
  assert.match(notes, /^1 tab\(s\) hold edits to a file Notepad kept no copy of/m);
});

test('a draft typed back to a saved copy that another tab file holds is that copy again, and is dropped', async () => {
  const root = workDir('notepad-echo');
  dirs.push(root);
  const dir = path.join(root, 'TabState');
  const put = (name, o) => {
    const file = write(path.join(dir, name), tabFile(o));
    fs.utimesSync(file, new Date(TAB_AT), new Date(TAB_AT));
  };
  // A tab set aside before 11.2408 with the file as saved, and today's tab of the same file:
  // one typed back to that very text, one still changed.
  put(`${guid(1)}.bin.bak`, {
    path: TODO, text: TODO_TEXT, encoding: 2, eol: 1, savedSize: TODO_ON_DISK.length, sha256: sha256(TODO_ON_DISK),
    filetime: filetime(SAVED_AT), opts: [],
  });
  put(`${guid(2)}.bin`, { path: TODO.toUpperCase(), text: TODO_TEXT, unsaved: 1, encoding: 2, eol: 1, savedSize: 70 });
  put(`${guid(3)}.bin`, { path: TODO, text: 'first line\r', unsaved: 1, encoding: 2, eol: 1, savedSize: 70 });

  const { results } = await search({ pattern: '*', sources: ['notepad'], locations: locs(dir) });
  assert.deepStrictEqual(results.map((r) => [r.kind, r.time, !!r.draft, r.seen]), [
    ['notepad, edits never saved', TAB_AT, true, ['notepad, edits never saved']],
    ['notepad, as last saved', SAVED_AT, false, ['notepad, as last saved']],
  ]);
  assert.deepStrictEqual(await load(results[1], git), TODO_ON_DISK);
});

test('a saved copy with no last-write time recorded is undated, not dated by its tab file', async () => {
  const root = workDir('notepad-undated');
  dirs.push(root);
  const dir = path.join(root, 'TabState');
  write(path.join(dir, `${guid(1)}.bin`), tabFile({
    path: TODO, text: TODO_TEXT, encoding: 2, eol: 1, savedSize: TODO_ON_DISK.length, sha256: sha256(TODO_ON_DISK), opts: [],
  }));
  const { results } = await search({ pattern: '*', sources: ['notepad'], locations: locs(dir) });
  assert.deepStrictEqual(results.map((r) => [r.kind, r.time]), [['notepad, as last saved', null]]);
});

test('only plain files are read: a folder, link or pipe under a tab file\'s name is passed over', async () => {
  const root = workDir('notepad-types');
  dirs.push(root);
  const dir = path.join(root, 'TabState');
  write(path.join(dir, `${guid(1)}.bin`), tabFile({ path: PLAN, text: 'kept', unsaved: 1 }));
  fs.mkdirSync(path.join(dir, `${guid(2)}.bin`));
  // Tab files elsewhere, which links in the folder lead to.
  const elsewhere = path.join(root, 'elsewhere');
  const outside = write(path.join(elsewhere, `${guid(9)}.bin`), tabFile({ path: TODO, text: 'outside', unsaved: 1 }));
  fs.symlinkSync(elsewhere, path.join(dir, `${guid(3)}.bin`), 'junction');
  try {
    fs.symlinkSync(outside, path.join(dir, `${guid(4)}.bin`), 'file');
  } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e; // Windows allows file links only in developer mode
  }
  if (process.platform !== 'win32') spawnSync('mkfifo', [path.join(dir, `${guid(5)}.bin`)]);

  const { results, perSource } = await search({ pattern: '*', sources: ['notepad'], locations: locs(dir) });
  assert.deepStrictEqual(results.map((r) => r.path), [PLAN]);
  assert.deepStrictEqual(perSource[0].notes, [], 'nothing to say about entries that are not tab files');
  assert.match(notepad.describe({ locations: { notepad: [dir] } })[0], /: 1 tab file\(s\), 1 readable, 1 with text/);
});

test('a TabState folder is found from every folder on the way down from a profile', () => {
  const root = workDir('notepad-places');
  dirs.push(root);
  const profile = path.join(root, 'Users', 'bob');
  const appData = path.join(profile, 'AppData');
  const local = path.join(appData, 'Local');
  const packages = path.join(local, 'Packages');
  const pkg = path.join(packages, 'Microsoft.WindowsNotepad_8wekyb3d8bbwe');
  const tabState = path.join(pkg, 'LocalState', 'TabState');
  write(path.join(tabState, `${guid(1)}.bin`), tabFile({ text: 'x' }));
  const loose = path.join(root, 'copied');
  write(path.join(loose, `${guid(2)}.bin`), tabFile({ text: 'y' }));

  for (const place of [profile, appData, local, packages, pkg, path.join(pkg, 'LocalState'), tabState]) {
    assert.deepStrictEqual(tabStateDirs(place), [tabState], place);
    assert.deepStrictEqual(tabStateDirs(`${place}${path.sep}`), [tabState], `${place} with a trailing separator`);
  }
  assert.deepStrictEqual(tabStateDirs(loose), [loose], 'a folder of tab files under any name');
  assert.deepStrictEqual(tabStateDirs(path.join(root, 'nowhere')), []);
  assert.deepStrictEqual(tabStateDirs(path.join(root, 'Users')), [], 'above the profile is not looked into');

  const keys = (list) => new Set(list.map(pathKey));
  for (const place of [profile, appData, local]) {
    assert.deepStrictEqual(keys(notepad.roots({ notepad: [place] })), keys([tabState, fs.realpathSync.native(tabState)]), place);
  }
  assert.deepStrictEqual(notepad.roots({ notepad: [path.join(root, 'nowhere')] }), [path.join(root, 'nowhere')]);

  const lines = notepad.describe({ locations: { notepad: [profile, path.join(root, 'nowhere')] } });
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /no Notepad TabState folder there/);
  assert.match(lines[1], /1 tab file\(s\), 1 readable, 1 with text to offer; 0 state file\(s\)/);
  assert.deepStrictEqual(notepad.describe({ locations: { notepad: [] } }), ['No Notepad tab folder found.']);
});

test('a search given AppData\\Local of another drive finds its tabs, and says so of a place that has none', async () => {
  const root = workDir('notepad-given');
  dirs.push(root);
  const local = path.join(root, 'old', 'Users', 'me', 'AppData', 'Local');
  const tabState = path.join(local, 'Packages', 'Microsoft.WindowsNotepad_8wekyb3d8bbwe', 'LocalState', 'TabState');
  write(path.join(tabState, `${guid(1)}.bin`), tabFile({ path: PLAN, text: 'typed', unsaved: 1 }));
  // A TabState folder with no tabs left in it is Notepad's, and has nothing to say.
  const empty = path.join(root, 'empty', 'TabState');
  fs.mkdirSync(empty, { recursive: true });
  const missing = path.join(root, 'old', 'Users', 'me', 'AppDta');
  const elsewhere = path.join(root, 'old', 'Users');

  const locations = only({ dirs: { notepad: [local, empty, missing, elsewhere] } });
  const { results, perSource } = await search({ pattern: '*', sources: ['notepad'], locations });
  assert.deepStrictEqual(results.map((r) => [r.path, r.origin]), [[PLAN, path.join(tabState, `${guid(1)}.bin`)]]);
  assert.deepStrictEqual(perSource[0].notes, [
    `${missing}: no Notepad TabState folder there`,
    `${elsewhere}: no Notepad TabState folder there`,
  ]);

  const lines = notepad.describe({ locations: { notepad: [local, missing] } });
  assert.strictEqual(lines[0], `${missing}: no Notepad TabState folder there`);
  assert.match(lines[1], /: 1 tab file\(s\), 1 readable, 1 with text to offer/);
  assert.strictEqual(lines.length, 2);
});

test('a TabState folder reached through a junction is kept from restores by its real path too', async () => {
  const root = workDir('notepad-alias');
  dirs.push(root);
  const pkg = 'Microsoft.WindowsNotepad_8wekyb3d8bbwe';
  const packages = path.join(root, 'D', 'Packages');
  const tabState = path.join(packages, pkg, 'LocalState', 'TabState');
  write(path.join(tabState, `${guid(1)}.bin`), tabFile({ path: PLAN, text: 'x', unsaved: 1 }));
  // The Packages folder moved to another drive, with a junction left where it was.
  const alias = path.join(root, 'profile', 'AppData', 'Local', 'Packages');
  fs.mkdirSync(path.dirname(alias), { recursive: true });
  fs.symlinkSync(packages, alias, 'junction');

  const roots = notepad.roots({ notepad: [alias] });
  assert.deepStrictEqual(roots.map(pathKey),
    [path.join(alias, pkg, 'LocalState', 'TabState'), fs.realpathSync.native(tabState)].map(pathKey));
  const before = snapshot(tabState);
  const copy = { path: PLAN, kind: 'notepad, edits never saved', text: 'x', size: 1, id: '00000000' };
  for (const to of [...roots, tabState, path.join(tabState, 'sub')]) {
    await assert.rejects(restore(copy, to, roots, git), /Refusing to write inside/, to);
  }
  assert.deepStrictEqual(snapshot(tabState), before);
});

test('discovery looks only in this account\'s LOCALAPPDATA, on Windows', () => {
  const root = workDir('notepad-discover');
  dirs.push(root);
  const tabState = path.join(root, 'Packages', 'Microsoft.WindowsNotepad_8wekyb3d8bbwe', 'LocalState', 'TabState');
  fs.mkdirSync(tabState, { recursive: true });
  const saved = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  try {
    assert.deepStrictEqual(notepad.discover(), process.platform === 'win32' ? [tabState] : []);
    process.env.LOCALAPPDATA = path.join(root, 'missing');
    assert.deepStrictEqual(notepad.discover(), []);
  } finally {
    if (saved === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved;
  }
});

test('searching and describing write nothing', async () => {
  const dir = makeTabState();
  const before = snapshot(dir);
  await search({ pattern: '*', sources: ['notepad'], locations: locs(dir) });
  await search({ pattern: '', containing: 'a', sources: ['notepad'], locations: locs(dir) });
  notepad.describe({ locations: { notepad: [dir] } });
  assert.deepStrictEqual(snapshot(dir), before);
});
