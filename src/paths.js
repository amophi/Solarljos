'use strict';

const path = require('path');

// Original paths come out of Windows-made records (the Recycle Bin, transcripts written on
// Windows), so they stay Windows paths even when this runs somewhere else, such as a Linux CI
// runner. Nothing here asks the running platform how to read them.

const DRIVE = /^[a-zA-Z]:[\\/]/;

function isWindowsPath(p) {
  return DRIVE.test(p) || p.startsWith('\\\\');
}

/**
 * A key for comparing paths: Windows paths ignore case and take either separator, and every
 * path is compared in NFC, since macOS writes names decomposed.
 */
function pathKey(p) {
  if (!p) return '';
  const n = String(p).normalize('NFC');
  return isWindowsPath(n) ? n.replace(/\\/g, '/').toLowerCase() : n;
}

function baseName(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

/** Whether `child` is `parent` itself or somewhere below it. Both are resolved first. */
function isInside(child, parent) {
  const c = pathKey(path.resolve(child));
  const p = pathKey(path.resolve(parent)).replace(/\/+$/, '');
  return c === p || c.startsWith(p + '/');
}

/**
 * Editors record files as URIs. A file URI becomes a plain path; anything else, such as
 * vscode-remote://, is kept as it is -- it still carries the file name, which is what a
 * search matches on.
 */
function fileUriToPath(uri) {
  const m = /^file:\/\/([^/]*)(\/.*)$/.exec(uri);
  if (!m) return uri;
  let p;
  try {
    p = decodeURIComponent(m[2]);
  } catch (_) {
    p = m[2];
  }
  if (m[1]) return '\\\\' + m[1] + p.replace(/\//g, '\\');
  if (/^\/[a-zA-Z]:/.test(p)) return p[1].toUpperCase() + p.slice(2).replace(/\//g, '\\');
  return p;
}

module.exports = { isWindowsPath, pathKey, baseName, isInside, fileUriToPath };
