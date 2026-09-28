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

/** Columns padded to fit; the last one is left as it is, since paths are long. */
function table(header, rows) {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  return all
    .map((r) => r.map((cell, i) => (i === r.length - 1 ? String(cell) : String(cell).padEnd(widths[i]))).join('  '))
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

module.exports = { size, when, table, arg };
