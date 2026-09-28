'use strict';

const { baseName, pathKey } = require('./paths');

// What a search pattern means, kept deliberately small:
//
//   report          file names containing "report", any case
//   *.docx          whole file name matched as a glob; * is any run, ? one character
//   src/app.js      with a separator, the full path is searched instead of the name
//   src/*.js        a glob with a separator matches the end of the path
//
// `literal` is the longest plain run in the pattern. Sources use it to skip data cheaply
// before parsing it: a transcript line that does not contain it cannot be a match.

function escapeRe(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globToRe(glob) {
  let out = '';
  for (const c of glob) out += c === '*' ? '.*' : c === '?' ? '.' : escapeRe(c);
  return out;
}

// NFC, so that a name written in decomposed form (as macOS does, notably with Hangul) matches
// the same name typed in composed form.
const norm = (p) => p.normalize('NFC').replace(/\\/g, '/').toLowerCase();
const nameOf = (p) => baseName(p).normalize('NFC').toLowerCase();

function compile(pattern) {
  const raw = String(pattern == null ? '' : pattern).trim() || '*';
  const lower = norm(raw);
  const onPath = lower.includes('/');
  const wild = /[*?]/.test(lower);

  let test;
  if (!wild) {
    test = onPath ? (p) => norm(p).includes(lower) : (p) => nameOf(p).includes(lower);
  } else if (onPath) {
    const re = new RegExp('(^|/)' + globToRe(lower.replace(/^\/+/, '')) + '$');
    test = (p) => re.test(norm(p));
  } else {
    const re = new RegExp('^' + globToRe(lower) + '$');
    test = (p) => re.test(nameOf(p));
  }

  const literal = lower.split(/[*?/]+/).reduce((a, b) => (b.length > a.length ? b : a), '');
  return {
    pattern: raw,
    everything: /^[*]+$/.test(raw),
    literal,
    test: (p) => typeof p === 'string' && p.length > 0 && test(p),
  };
}

/**
 * Everything below a folder, for rebuilding it. Unlike a pattern this is a true prefix: the
 * folder's own path, then a separator. Its last segment is the literal, since every path below
 * it contains that name.
 */
function under(folder) {
  // pathKey writes both kinds of path with forward slashes.
  const prefix = pathKey(String(folder)).replace(/[\\/]+$/, '');
  return {
    pattern: folder,
    everything: false,
    folder: prefix,
    literal: baseName(prefix).toLowerCase(),
    test: (p) => typeof p === 'string' && p.length > 0 && pathKey(p).startsWith(prefix + '/'),
  };
}

module.exports = { compile, under };
