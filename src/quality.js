'use strict';

// How much a copy can be trusted, used wherever copies of the same file compete: when a search
// merges identical copies into one row, and when rebuild picks one copy per path.
//
// First comes the tier:
//
//   0  exact        the bytes that were on disk
//   1  inexact      saved, but not provably those bytes -- git could not make it exact, an editor
//                   held it as text whose line ends and BOM may differ, its last byte is uncertain,
//                   or a file system's records say where it was but nothing proves it was not
//                   overwritten since
//   2  draft        text that was never saved
//   3  unverified   read from free space, or from clusters assumed to follow each other: it may
//                   be incomplete, or hold pieces of another file
//   4  derived      a smaller or re-encoded copy made from the file, such as a thumbnail: never
//                   the file itself
//
// A copy says which it is with the flags draft, inexact, unverified and derived; some kinds are
// always one of them, whatever their flags say. A copy with more than one flag is in the least
// trusted of their tiers. Within a tier the newest copy wins, and between copies from the same
// moment the fidelity rank decides:
//
//   0  the bytes that were on disk
//   1  exact text as an app held or wrote it (no BOM, line endings as the app kept them)
//   2  text an agent saw, or a write whose final newline is not known
//   3  a file rebuilt by applying an edit to an earlier copy
//   4  bytes a file system's records lead to (exFAT: where the file lay is recorded)
//   5  the same on FAT, where the chain of clusters was cleared and is taken as unbroken
//   6  bytes carved out of free space by their format alone, with no record of the file
//   7  a thumbnail
//
// A kind missing from the table ranks 9, after every kind listed.
//
// Rebuild takes a copy of tier 3 or 4 for no path: it may be wrong, or it is not the file. They
// are listed apart, to be restored one by one, under names that say what they are.

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
  'snipping tool capture': 0,
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
  'exfat undelete': 4,
  'fat undelete': 5,
  'carved': 6,
  'thumbnail': 7,
  'thumbnail, name unknown': 7,
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

// Carved out of free space: nothing but the format says where the file began and ended. An
// undelete can be anything from exact to this, so its source says which with the flags.
const UNVERIFIED = new Set(['carved']);

// Made from the file, never the file.
const DERIVED = new Set(['thumbnail', 'thumbnail, name unknown']);

function fidelity(c) {
  return c.kind in FIDELITY ? FIDELITY[c.kind] : 9;
}

/** Whether a copy is a smaller or re-encoded one made from the file. */
function isDerived(c) {
  return !!(c.derived || DERIVED.has(c.kind));
}

/** Whether a copy may be incomplete: read from free space, or from clusters taken to follow each other. */
function isUnverified(c) {
  return !!(c.unverified || UNVERIFIED.has(c.kind));
}

/** Whether a copy was saved but is not provably the bytes that were on disk. */
function isInexact(c) {
  return !!(c.inexact || INEXACT.has(c.kind));
}

function tier(c) {
  if (isDerived(c)) return 4;
  if (isUnverified(c)) return 3;
  if (c.draft) return 2;
  if (isInexact(c)) return 1;
  return 0;
}

/** Whether rebuild may take a copy for a path: one that is not the file, or may not be whole, it may not. */
function rebuildable(c) {
  return tier(c) <= 2;
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

module.exports = {
  FIDELITY, INEXACT, UNVERIFIED, DERIVED, fidelity, tier, better, isDerived, isUnverified, isInexact, rebuildable,
};
