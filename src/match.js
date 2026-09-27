'use strict';

const { baseName } = require('./paths');

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

const norm = (p) => p.replace(/\\/g, '/').toLowerCase();

function compile(pattern) {
  const raw = String(pattern == null ? '' : pattern).trim() || '*';
  const lower = norm(raw);
  const onPath = lower.includes('/');
  const wild = /[*?]/.test(lower);

  let test;
  if (!wild) {
    test = onPath ? (p) => norm(p).includes(lower) : (p) => baseName(p).toLowerCase().includes(lower);
  } else if (onPath) {
    const re = new RegExp('(^|/)' + globToRe(lower.replace(/^\/+/, '')) + '$');
    test = (p) => re.test(norm(p));
  } else {
    const re = new RegExp('^' + globToRe(lower) + '$');
    test = (p) => re.test(baseName(p).toLowerCase());
  }

  const literal = lower.split(/[*?/]+/).reduce((a, b) => (b.length > a.length ? b : a), '');
  return {
    pattern: raw,
    everything: /^[*]+$/.test(raw),
    literal,
    test: (p) => typeof p === 'string' && p.length > 0 && test(p),
  };
}

module.exports = { compile };
