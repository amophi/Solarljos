'use strict';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function size(n) {
  if (n == null) return '';
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(v < 10 ? 1 : 0)} ${UNITS[i]}`;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Local time, to the minute. */
function when(ms) {
  if (ms == null || Number.isNaN(ms)) return '?';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// How many columns of a terminal text takes, which is not its String length once it is not
// ASCII: what the command line prints is translated, and a column of Korean labels padded by
// length came out shorter than one of English. Text is taken a grapheme cluster at a time
// (Intl.Segmenter), as a terminal lays it out:
//   2  an emoji, shown as one: a pictograph with emoji presentation, or with VS16 (U+FE0F), a
//      keycap, a flag of two regional indicators, or a ZWJ sequence of any of them;
//   0  a combining mark (\p{M}: Thai vowels and tone marks, Devanagari matras and viramas, Arabic
//      harakat, the voicing marks of kana), a default-ignorable code point (ZWJ, ZWNJ, variation
//      selectors, the soft hyphen, the Hangul fillers), a Hangul medial or final jamo, which joins
//      the initial before it, and a control character, which is never printed;
//   2  a character East Asian Width (UAX #11) calls Wide or Fullwidth: Han, kana, Hangul
//      syllables and initial jamo, the CJK symbols and punctuation, the fullwidth forms. The
//      Wide emoji are those with emoji presentation (so since Unicode 9), counted above;
//   1  anything else.
// Each code point of a cluster is counted as that, so KA, VIRAMA, SSA is 2, as the wcwidth() of
// most terminals makes it; one that draws a conjunct into fewer cells lines it up a little
// shorter. Ambiguous-width characters count 1, as outside East Asian locales.

const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4], [0x17000, 0x18cff], [0x1b000, 0x1b2ff], [0x1f200, 0x1f2ff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];
const ZERO = /[\p{M}\p{Default_Ignorable_Code_Point}\u1160-\u11FF\uD7B0-\uD7FF\u0000-\u001f\u007f-\u009f]/u;
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|\uFE0F\u20E3|\p{Regional_Indicator}{2}/u;
const segmenter = typeof Intl === 'object' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;

/** The grapheme clusters of `s`; code points, a mark kept with the one before it, without Intl.Segmenter. */
function graphemes(s) {
  if (segmenter) return Array.from(segmenter.segment(s), (x) => x.segment);
  const out = [];
  for (const ch of s) {
    if (out.length && /^\p{M}/u.test(ch)) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

function codePointWidth(ch) {
  if (ZERO.test(ch)) return 0;
  const cp = ch.codePointAt(0);
  for (const [from, to] of WIDE) {
    if (cp < from) break;
    if (cp <= to) return 2;
  }
  return 1;
}

function clusterWidth(g) {
  if (EMOJI.test(g)) return 2;
  let w = 0;
  for (const ch of g) w += codePointWidth(ch);
  return w;
}

/** The columns `s` takes in a terminal (see above). */
function displayWidth(s) {
  const text = String(s);
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  let w = 0;
  for (const g of graphemes(text)) w += clusterWidth(g);
  return w;
}

/** `s` with spaces after it to take `width` columns; as it is when it takes more. */
function pad(s, width) {
  const text = String(s);
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** `s` with spaces before it to take `width` columns, as a number is lined up; as it is when it takes more. */
function padStart(s, width) {
  const text = String(s);
  return ' '.repeat(Math.max(0, width - displayWidth(text))) + text;
}

/** The start of `s` that takes at most `width` columns, cut between grapheme clusters only. */
function fit(s, width) {
  const text = String(s);
  if (displayWidth(text) <= width) return text;
  let out = '';
  let w = 0;
  for (const g of graphemes(text)) {
    const gw = clusterWidth(g);
    if (w + gw > width) break;
    out += g;
    w += gw;
  }
  return out;
}

/** Columns padded to fit, by the columns each cell takes; the last one is left as it is, since paths are long. */
function table(header, rows) {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => displayWidth(r[i]))));
  return all
    .map((r) => r.map((cell, i) => (i === r.length - 1 ? String(cell) : pad(cell, widths[i]))).join('  '))
    .join('\n');
}

/**
 * Quotes an argument for a command line the user can paste back, in the shells usual where this
 * runs. On Windows, PowerShell and cmd both take a path such as trash=E:\ or \\?\GLOBALROOT\...
 * as it is, so it is left bare. Anything else goes in double quotes, with a run of backslashes
 * doubled where it ends at a quote, the closing one included: a program on Windows reads \" as a
 * quote character, so "D:\My Files\" would run on into the next argument. PowerShell expands $
 * and ` inside double quotes ("E:\$Recycle.Bin" becomes "E:\.Bin"), so a value holding either
 * goes in single quotes instead, which PowerShell takes as they are and cmd, alas, does not.
 * Elsewhere a value goes in single quotes, which a POSIX shell takes as they are, backslashes too.
 */
function arg(s, platform = process.platform) {
  const v = String(s);
  if (platform === 'win32') {
    if (/^[A-Za-z0-9._\-/\\:=?]+$/.test(v)) return v;
    if (/[$`]/.test(v)) return "'" + v.replace(/'/g, "''") + "'";
    return '"' + v.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, (m) => m + m) + '"';
  }
  if (/^[A-Za-z0-9._\-/:=,@%+]+$/.test(v)) return v;
  return "'" + v.replace(/'/g, "'\\''") + "'";
}

module.exports = { size, when, table, arg, displayWidth, pad, padStart, fit };
