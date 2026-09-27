'use strict';

const fs = require('fs');
const path = require('path');
const { t } = require('../i18n');
const { fileUriToPath } = require('../paths');

// VS Code, and every editor built on it, saves a copy of a file each time it is saved:
//
//   <app data>/User/History/<folder>/entries.json
//     { "version": 1, "resource": "file:///c%3A/...", "entries": [ { "id": "AbCd.js", "timestamp": ms, "source"?: "..." } ] }
//   <app data>/User/History/<folder>/AbCd.js   one copy per entry, named by its id
//
// The folder survives the file being deleted, which is what makes it a recovery source.

function readFolder(folder) {
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(folder, 'entries.json'), 'utf8'));
  } catch (_) {
    return null;
  }
  if (!meta || typeof meta.resource !== 'string' || !Array.isArray(meta.entries)) return null;
  return { original: fileUriToPath(meta.resource), entries: meta.entries };
}

function folders(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch (_) {
    return [];
  }
}

async function scan(ctx) {
  const out = [];
  for (const { label, dir } of ctx.locations.history) {
    for (const folder of folders(dir)) {
      const rec = readFolder(folder);
      if (!rec || !ctx.matcher.test(rec.original)) continue;
      for (const e of rec.entries) {
        // The id names a file in this folder and nothing else.
        if (!e || typeof e.id !== 'string' || e.id !== path.basename(e.id)) continue;
        const file = path.join(folder, e.id);
        let st;
        try {
          st = fs.statSync(file);
        } catch (_) {
          continue;
        }
        out.push({
          source: 'history', kind: 'local history',
          path: rec.original,
          time: typeof e.timestamp === 'number' ? e.timestamp : st.mtimeMs,
          size: st.size, file, origin: file,
          note: [label, e.source].filter(Boolean).join(', '),
        });
      }
    }
  }
  return out;
}

function describe(ctx) {
  const lines = [];
  for (const { label, dir } of ctx.locations.history) {
    let files = 0;
    let versions = 0;
    for (const folder of folders(dir)) {
      const rec = readFolder(folder);
      if (!rec) continue;
      files++;
      versions += rec.entries.length;
    }
    lines.push(t('{0}: {1} file(s), {2} saved version(s)  ({3})', label, files, versions, dir));
  }
  if (!lines.length) lines.push(t('No editor Local History found.'));
  return lines;
}

module.exports = {
  id: 'history',
  label: 'Editor Local History',
  scan,
  describe,
  roots: (loc) => loc.history.map((h) => h.dir),
};
