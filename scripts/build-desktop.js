'use strict';

// Builds the Windows program as a release ships it: dist/Solarljos-<version>-win-x64.zip, which
// holds
//
//   Solarljos.exe        the window (desktop/Solarljos), WPF on .NET 10, which needs the .NET 10
//   Solarljos.dll        Desktop Runtime: the program that starts, and the program itself, with
//   Solarljos.*.json     what .NET reads to run it. A plain build, not one file: a single-file
//                        publish has the SDK fetch runtime packs from NuGet, and this needs nothing
//                        but the SDK
//   solarljos-core.exe   the engine: the program scripts/build-exe.js makes (dist/Solarljos.exe),
//                        which the window starts beside itself as "desktop"
//   LICENSE.txt          Solarljos's licence, and those of what it carries: Node.js 26.10's, which
//   Node.js-LICENSE.txt  the engine is built on, with the licences of what Node.js itself carries;
//   dotnet-LICENSE.txt   .NET's, whose program starts the window (the runtime itself is not in it);
//   Pretendard-OFL.txt   and the font's (desktop/licenses, as each project publishes it)
//
// and its SHA-256 beside it. Each step is tried before the next: build-exe.js tries the engine its
// own way; then the engine is started as the window starts it, and must say where it is and stop
// when its stdin closes; then the window is started on a stand-in engine that searches nothing
// (desktop-standin.js), off the screen, and must draw itself and stop by itself.
//
// The same commit gives the same zip: the window is built deterministically, with every path in it
// named from the project (PathMap), and the zip's entries go in one order, all dated 1 January 1980.
//
//   node scripts/build-desktop.js               with Node 26 (scripts/build-exe.js needs it), and dotnet 10
//   node scripts/build-desktop.js --skip-core   keeps the dist/Solarljos.exe already built

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'desktop');
const CORE = path.join(DIST, 'Solarljos.exe');
const PROJECT = path.join(ROOT, 'desktop', 'Solarljos', 'Solarljos.csproj');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(' ')} exited ${r.status}`);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---- a zip, the same bytes every time --------------------------------------------------------

/**
 * A zip of these files, in this order, each deflated and dated 1980-01-01 00:00 (DOS time 0, date
 * 0x21), with no extra fields: what any unzip reads, and what depends on the files alone.
 * @param {{ name: string, data: Buffer }[]} files
 */
function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const packed = zlib.deflateRawSync(f.data, { level: 9 });
    const crc = zlib.crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4); // made by
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

// ---- trying what was built -------------------------------------------------------------------

/** Starts the engine as the window does, and waits for its line; then closes its stdin, which must stop it. */
function tryCore(exe) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['desktop'], { cwd: OUT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let said = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`solarljos-core.exe desktop said nothing in 120 s:\n${said}`));
    }, 120000);
    child.stderr.setEncoding('utf8').on('data', (d) => (said += d));
    child.stdout.setEncoding('utf8').on('data', (d) => {
      out += d;
      const nl = out.indexOf('\n');
      if (nl < 0) return;
      let line;
      try {
        line = JSON.parse(out.slice(0, nl));
      } catch (e) {
        reject(new Error(`solarljos-core.exe desktop printed ${JSON.stringify(out.slice(0, nl))}`));
        return;
      }
      if (!Number.isInteger(line.port) || typeof line.key !== 'string' || line.key.length < 32) {
        reject(new Error(`solarljos-core.exe desktop said ${JSON.stringify(line)}`));
        return;
      }
      child.stdin.end();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!out.includes('\n')) reject(new Error(`solarljos-core.exe desktop ended (${code}) before saying where it is:\n${said}`));
      else resolve();
    });
  });
}

/** Starts the window on the stand-in engine, off the screen, and waits for its picture of itself. */
function tryWindow(exe) {
  const picture = path.join(DIST, 'build', 'desktop-smoke.png');
  fs.mkdirSync(path.dirname(picture), { recursive: true });
  fs.rmSync(picture, { force: true });
  const core = `"${process.execPath}" "${path.join(__dirname, 'desktop-standin.js')}"`;
  const r = spawnSync(exe, [], {
    cwd: OUT, timeout: 120000, windowsHide: true,
    env: { ...process.env, SOLARLJOS_CORE: core, SOLARLJOS_SHOT: `out=${picture};route=;lang=en;w=1024;h=700` },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`Solarljos.exe exited ${r.status} on the stand-in engine`);
  const png = fs.existsSync(picture) ? fs.readFileSync(picture) : null;
  if (!png || png.length < 10000 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('Solarljos.exe drew no picture of itself');
  return png.length;
}

// ---- the build ---------------------------------------------------------------------------------

async function main(argv) {
  const t0 = Date.now();
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!argv.includes('--skip-core')) run(process.execPath, [path.join(__dirname, 'build-exe.js')]);
  if (!fs.existsSync(CORE)) throw new Error(`${CORE} is not there: run scripts/build-exe.js first`);

  fs.rmSync(OUT, { recursive: true, force: true });
  // From nothing, every time: an incremental build keeps the window's compiled XAML from the last
  // one, which names the version that one had.
  run('dotnet', ['build', PROJECT, '-c', 'Release', '--no-incremental', '-p:ContinuousIntegrationBuild=true', '-p:DebugType=none', '-o', OUT, '-nologo', '-v', 'q'],
  { env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } });
  const windowExe = path.join(OUT, 'Solarljos.exe');
  const coreExe = path.join(OUT, 'solarljos-core.exe');
  fs.copyFileSync(CORE, coreExe);
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(OUT, 'LICENSE.txt'));
  const licences = ['Node.js-LICENSE.txt', 'dotnet-LICENSE.txt'];
  for (const n of licences) fs.copyFileSync(path.join(ROOT, 'desktop', 'licenses', n), path.join(OUT, n));
  const names = ['Solarljos.exe', 'Solarljos.dll', 'Solarljos.deps.json', 'Solarljos.runtimeconfig.json', 'solarljos-core.exe',
    'LICENSE.txt', ...licences, 'Pretendard-OFL.txt'];
  for (const n of names) if (!fs.existsSync(path.join(OUT, n))) throw new Error(`${n} is not in ${OUT}`);
  const extra = fs.readdirSync(OUT).filter((n) => !names.includes(n));
  if (extra.length) throw new Error(`the build left more than the program: ${extra.join(', ')}`);

  await tryCore(coreExe);
  const drawn = tryWindow(windowExe);

  const files = names.map((name) => ({ name, data: fs.readFileSync(path.join(OUT, name)) }));
  const archive = zip(files);
  const zipName = `Solarljos-${pkg.version}-win-x64.zip`;
  fs.writeFileSync(path.join(DIST, zipName), archive);
  fs.writeFileSync(path.join(DIST, zipName + '.sha256'), `${sha256(archive)} *${zipName}\n`);
  for (const f of files) console.log(`${String(f.data.length).padStart(10)}  ${sha256(f.data)}  ${f.name}`);
  console.log(`window   drew itself on the stand-in engine (${drawn} bytes of PNG); the engine stopped when its stdin closed`);
  console.log(`zip      ${archive.length} bytes  ${sha256(archive)}  ${zipName}`);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}

module.exports = { zip };
