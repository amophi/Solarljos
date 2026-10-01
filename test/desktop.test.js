'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// The Windows program (desktop/Solarljos) shows the page's words and icons, from what
// scripts/desktop-assets.js writes into desktop/Solarljos/Assets, and the page's own tables of the
// other languages. A string or an icon changed for the page and not carried over fails here.

const ROOT = path.join(__dirname, '..');

test('the Windows program has the page\'s English table, icons and languages as they are now', () => {
  const r = (() => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'desktop-assets.js'), '--check'], { encoding: 'utf8' }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout) };
    }
  })();
  assert.strictEqual(r.code, 0, r.out + 'Run node scripts/desktop-assets.js.');
});

test('the Windows program takes its version from package.json, and its tables from the page', () => {
  const csproj = fs.readFileSync(path.join(ROOT, 'desktop', 'Solarljos', 'Solarljos.csproj'), 'utf8');
  const bs = String.fromCharCode(92);
  assert.ok(csproj.includes(`ReadAllText('$(MSBuildThisFileDirectory)..${bs}..${bs}package.json')`), 'the version from package.json');
  assert.ok(csproj.includes(`<EmbeddedResource Include="..${bs}..${bs}src${bs}gui${bs}ui${bs}lang${bs}*.json"`), 'the page\'s tables');
  // Nothing from NuGet: what it runs is .NET's own and this repository's.
  assert.doesNotMatch(csproj, /PackageReference/);
});
