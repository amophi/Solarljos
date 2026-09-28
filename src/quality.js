'use strict';

// How much a copy can be trusted, used wherever copies of the same file compete: when a search
// merges identical copies into one row, and when rebuild picks one copy per path.
//
// First comes the tier. A saved, exact copy (0) beats one that is saved but not provably the
// bytes on disk (1) -- git could not make it exact, an editor held it as text whose line ends and
// BOM may differ, or its last byte is uncertain -- which beats a draft, text that was never saved
// (2). Within a tier the newest copy wins, and between copies from the same moment the fidelity
// rank decides:
//
//   0  the bytes that were on disk
//   1  exact text as an app held or wrote it (no BOM, line endings as the app kept them)
//   2  text an agent saw, or a write whose final newline is not known
//   3  a file rebuilt by applying an edit to an earlier copy
//
// A kind missing from the table ranks 9, after every kind listed.

const FIDELITY = {
  'recycle bin': 0,
  'recycle bin, inside a deleted folder': 0,
  'local history': 0,
  'claude backup': 0,
  'claude backup, name unknown': 0,
  'git commit': 0,
  'git index': 0,
  'git, deleted in a commit': 0,
  'git, Git LFS pointer': 0,
  'git lfs object, name unknown': 0,
  'shadow copy': 0,
  'jetbrains history': 0,
  'jetbrains cache': 0,
  'eclipse history': 0,
  'eclipse history, name unknown': 0,
  'notepad, as last saved': 0,
  'hancom backup': 0,
  'trash': 0,
  'trash, inside a deleted folder': 0,
  'trash, name unknown': 0,
  'claude write': 1,
  'antigravity write': 1,
  'jetbrains history, as text': 1,
  'jetbrains cache, name unknown': 1,
  'notepad, edits never saved': 1,
  'notepad, untitled, never saved': 1,
  'unsaved editor buffer': 1,
  'hancom autosave': 1,
  'claude read': 2,
  'antigravity read': 2,
  'antigravity write, final newline unknown': 2,
  'claude, before a write': 2,
  'claude, before an edit': 2,
  'claude, after an edit': 3,
};

// Saved, but not provably the bytes that were on disk: git did not run the file's filter, or
// evened out its line endings, or has no path to convert it by; a JetBrains IDE kept the file as
// the editor's text, whose line ends and BOM can differ from the file; or an agent's write may
// lack the final newline the file had.
const INEXACT = new Set([
  'git, filter not run',
  'git, line endings differ',
  'git object, name unknown, as stored',
  'jetbrains history, as text',
  'antigravity write, final newline unknown',
]);

function fidelity(c) {
  return c.kind in FIDELITY ? FIDELITY[c.kind] : 9;
}

function tier(c) {
  if (c.draft) return 2;
  if (c.inexact || INEXACT.has(c.kind)) return 1;
  return 0;
}

/** Whether copy `a` should be preferred over copy `b` of the same file. */
function better(a, b) {
  const ta = tier(a);
  const tb = tier(b);
  if (ta !== tb) return ta < tb;
  const ma = a.time == null ? -Infinity : a.time;
  const mb = b.time == null ? -Infinity : b.time;
  if (ma !== mb) return ma > mb;
  return fidelity(a) < fidelity(b);
}

module.exports = { FIDELITY, INEXACT, fidelity, tier, better };
