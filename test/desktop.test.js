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

test('the release zip holds the files whole, in their order, and is the same bytes every time', () => {
  const zlib = require('zlib');
  const { zip } = require('../scripts/build-desktop.js');
  const files = [
    { name: 'Solarljos.exe', data: Buffer.from('MZ the window') },
    { name: 'LICENSE.txt', data: Buffer.alloc(5000, 'a') },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const a = zip(files);
  assert.ok(a.equals(zip(files)), 'the same files, the same zip');
  // Read back as an unzip reads it: the end record, the central directory, each local entry.
  const end = a.length - 22;
  assert.strictEqual(a.readUInt32LE(end), 0x06054b50);
  assert.strictEqual(a.readUInt16LE(end + 10), files.length);
  let at = a.readUInt32LE(end + 16);
  const got = [];
  for (let i = 0; i < files.length; i++) {
    assert.strictEqual(a.readUInt32LE(at), 0x02014b50);
    const nameLen = a.readUInt16LE(at + 28);
    const name = a.toString('utf8', at + 46, at + 46 + nameLen);
    const local = a.readUInt32LE(at + 42);
    const packed = a.readUInt32LE(at + 20);
    assert.strictEqual(a.readUInt16LE(at + 14), 0x21, 'dated 1980-01-01');
    const dataAt = local + 30 + a.readUInt16LE(local + 26) + a.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(a.subarray(dataAt, dataAt + packed));
    assert.strictEqual(zlib.crc32(data) >>> 0, a.readUInt32LE(at + 16));
    got.push({ name, data });
    at += 46 + nameLen;
  }
  assert.deepStrictEqual(got.map((f) => f.name), files.map((f) => f.name));
  got.forEach((f, i) => assert.ok(f.data.equals(files[i].data), f.name));
});
