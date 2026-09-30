'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { displayWidth, pad, padStart, fit, table } = require('../src/format');

// The columns text takes in a terminal, by which the command line lines up its translated
// columns: Hangul, kana and Han take two; Thai vowels and tone marks, Devanagari matras and
// Arabic harakat none. The samples are the kind of words the translations put in those columns.

// WOMAN, ZERO WIDTH JOINER, LAPTOP: one emoji, its joiner written out so that it can be seen.
const CODER = '\u{1F469}\u200d\u{1F4BB}';

test('counts two columns for Korean, Japanese and Chinese, one for halfwidth forms', () => {
  assert.strictEqual(displayWidth('휴지통'), 6);
  assert.strictEqual(displayWidth('찾은 곳'), 7);
  assert.strictEqual(displayWidth('한'.normalize('NFD')), 2, 'an initial jamo takes two, the vowel and final join it');
  assert.strictEqual(displayWidth('ごみ箱'), 6);
  assert.strictEqual(displayWidth('ファイル名'), 10);
  assert.strictEqual(displayWidth('が'.normalize('NFD')), 2, 'the combining voicing mark takes none');
  assert.strictEqual(displayWidth('ｺﾞﾐ'), 3, 'halfwidth katakana and its voicing mark take one each');
  assert.strictEqual(displayWidth('回收站（Linux）'), 15, 'fullwidth parentheses take two');
  assert.strictEqual(displayWidth('ＡＢ　'), 6, 'fullwidth letters and the ideographic space');
});

test('counts no column for a combining mark: Thai, Devanagari, Arabic', () => {
  // ถ ั ง ร ี ไ ซ เ ค ิ ล: three of the eleven are marks above or below a letter.
  assert.deepStrictEqual(['ถังรีไซเคิล'.length, displayWidth('ถังรีไซเคิล')], [11, 8]);
  assert.strictEqual(displayWidth('น้ำ'), 2, 'a tone mark and SARA AM: NO NU and the AM itself');
  // र ी स ा य क ल, a space, ब ि न: the matras take none.
  assert.deepStrictEqual(['रीसायकल बिन'.length, displayWidth('रीसायकल बिन')], [11, 8]);
  assert.strictEqual(displayWidth('क्षि'), 2, 'KA, VIRAMA, SSA, I: the two letters, as wcwidth counts them');
  assert.deepStrictEqual(['مُحَمَّد'.length, displayWidth('مُحَمَّد')], [8, 4]);
  assert.strictEqual(displayWidth('e\u0301'), 1, 'a combining accent');
});

test('counts an emoji as two, and what is never seen as nothing', () => {
  for (const e of ['📷', '❤️', '1️⃣', '🇰🇷', CODER, '🎞️']) assert.strictEqual(displayWidth(e), 2, e);
  assert.strictEqual(displayWidth('❤'), 1, 'a heart without VS16 is text');
  assert.strictEqual(displayWidth('a\u200db\u200cc\u00ad'), 3, 'ZWJ, ZWNJ and a soft hyphen');
  assert.strictEqual(displayWidth('a\u0007b\u001b'), 2, 'control characters');
  assert.strictEqual(displayWidth(''), 0);
  assert.strictEqual(displayWidth(12345), 5);
  assert.strictEqual(displayWidth('plain ASCII, as most of it is'), 29);
});

test('pads by columns, and never cuts', () => {
  assert.strictEqual(pad('휴지통', 10), '휴지통    ');
  assert.strictEqual(pad('ถังรีไซเคิล', 10), 'ถังรีไซเคิล  ');
  assert.strictEqual(pad('रीसायकल बिन', 10), 'रीसायकल बिन  ');
  assert.strictEqual(pad('ごみ箱', 4), 'ごみ箱', 'wider than asked: left as it is');
  assert.strictEqual(padStart('12', 5), '   12');
  assert.strictEqual(padStart('휴지', 5), ' 휴지');
});

test('fits text into columns between grapheme clusters only', () => {
  assert.strictEqual(fit('휴지통', 5), '휴지', 'not half a syllable');
  assert.strictEqual(fit('ถังรีไซเคิล', 2), 'ถัง', 'a letter keeps the marks on it');
  assert.strictEqual(fit('नमस्ते', 2), 'नम');
  assert.strictEqual(fit('क्षिa', 2), 'क्षि', 'a conjunct is one cluster');
  assert.strictEqual(fit('क्षिa', 1), '');
  assert.strictEqual(fit(`${CODER}x`, 1), '', 'not part of a ZWJ sequence');
  assert.strictEqual(fit('🇰🇷🇯🇵', 3), '🇰🇷', 'not half a flag');
  assert.strictEqual(fit('😀'.repeat(3), 5), '😀😀', 'not half a surrogate pair');
  assert.strictEqual(fit('short', 10), 'short');
  for (const s of ['휴지통 ごみ箱', 'ถังรีไซเคิล', 'रीसायकल बिन', 'مُحَمَّد', `${CODER}🇰🇷❤️`]) {
    for (let w = 0; w <= displayWidth(s); w++) {
      const cut = fit(s, w);
      assert.ok(displayWidth(cut) <= w && s.startsWith(cut), `${s} at ${w}`);
      const rest = s.slice(cut.length);
      assert.ok(!/^\p{M}|^[\u200d\ufe0f\u1160-\u11ff]|^[\udc00-\udfff]/u.test(rest), `${s} at ${w}: the rest starts inside a cluster`);
    }
  }
});

test('a table lines its columns up by the columns their text takes', () => {
  const header = ['ID', 'WHEN', '찾은 곳', 'STATE', 'PATH'];
  const rows = [
    ['3f9a1c2e', '2026-09-27 21:14', '휴지통', '삭제됨', 'C:\\a.txt'],
    ['b71e02d4', '2026-09-27 08:37', 'ถังรีไซเคิล', 'ลบแล้ว', 'C:\\b.txt'],
    ['0c1d2e3f', '2026-09-26 10:00', 'रीसायकल बिन', 'हटाया गया', 'C:\\c.txt'],
    ['9a8b7c6d', '2026-09-25 09:00', 'ごみ箱 x2', '削除済み', 'C:\\d.txt'],
  ];
  const lines = table(header, rows).split('\n');
  assert.strictEqual(lines.length, 5);
  // The column each cell starts at: the same on every line.
  const starts = (line, cells) => {
    let from = 0;
    return cells.map((c) => {
      const at = line.indexOf(c, from);
      from = at + c.length;
      return displayWidth(line.slice(0, at));
    });
  };
  const all = [header, ...rows].map((cells, i) => starts(lines[i], cells));
  for (const s of all) assert.deepStrictEqual(s, all[0], JSON.stringify(all));
  // 8 and 16 columns, then 'ごみ箱 x2' (9) and '削除済み' (8) are the widest, each with two spaces after.
  assert.deepStrictEqual(all[0], [0, 10, 28, 39, 49]);
  assert.ok(lines.every((l) => !l.endsWith(' ')), 'the last column is not padded');
});
