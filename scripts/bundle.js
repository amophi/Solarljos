'use strict';

// Bundles the command line, with every module it loads, into one CommonJS script:
// dist/solarljos.cjs. It is the main script of the single executable scripts/build-exe.js makes,
// where require() loads Node's own modules only, and it runs with plain Node too. This is the
// whole bundler; it needs nothing but Node.
//
//   node scripts/bundle.js [<out file>]
//
// What goes in. From bin/solarljos.js on, every require() of a './' or '../' name written out in
// full is followed. A module that also calls require() with a name it works out -- search.js
// loads each source through source(file, id) -- has every './' and '../' string in it followed
// as well, when it names a module of the project, so each source is bundled although no
// require() names it. A name written out that names no file of the project, or with its case
// wrong, or a bare name that is not one of Node's own modules, stops the build: in the
// executable it could not be loaded, and search.js would turn that into a source that quietly
// finds nothing. Every module is compiled here once as well, so a syntax error stops it too.
//
// How they run. Each module is kept as its text and compiled when it is first required, with
// vm.compileFunction and the wrapper Node itself uses, so a stack trace names the module's own
// file and line; a #! line is emptied, not removed. Its require() resolves './' and '../' against
// the module's own path as Node does -- the name, then .js, .json, /index.js, /index.json -- with
// the same resolveIn() that picked the modules here, and hands any other name to the real
// require, which may load Node's own modules only, as in the executable. A module is cached
// before it runs, so a cycle sees the exports as they stand, and one that throws is taken out of
// the cache again, as in Node. __filename is where the file would be if the project's folders
// lay beside the bundle, or beside the executable; nothing is there.
//
// Page files. The files below src/gui that no module loads -- the page, its scripts and styles,
// which the browser runs and Node never does -- are not in the bundle. build-exe.js puts them
// into the executable as assets, each keyed by its path below the folder in src/gui that holds
// it: src/gui/ui/app.js is "app.js", and a file in a folder below, src/gui/ui/views/find.js, would
// be "views/find.js". So the server, which reads path.join(__dirname, 'ui', key) from the source,
// gets the same file from require('node:sea').getAsset(key) in the executable. Two files that
// would have the same key stop the build. The bundle run with plain node has no page files, only
// the executable does. A module Node runs other than through require() -- a worker started from
// its file -- would be taken for a page file here, and would need a bundle of its own.
//
// In the executable only, two variables could still make Node write a file, where Solarljos
// writes nothing outside --to: NODE_V8_COVERAGE, a coverage report at exit, so collecting it is
// stopped before any module runs -- Node then says on stderr, at exit, that it has none to write
// -- and NODE_REDIRECT_WARNINGS, which appends every warning to a file, so warnings go to stderr
// instead. NODE_OPTIONS is not read there at all (build-exe.js). Tried with all three set on a
// program that emits a warning: plain node wrote the warning file and a coverage file and ran
// the --require; the executable did none of it. NODE_COMPILE_CACHE makes Node create its folder
// before the bundle starts, which nothing in it can prevent.
//
// The output depends on the files alone: modules go in by path, and nothing of the machine or
// the time is written, so one commit bundles to the same bytes everywhere.
//
// Measured on Windows 11 with Node 22.23, 24.20 and 26.10: 0.3.0's tree is 24 modules, 380,404
// bytes, bundled in under 30 ms, and `sources` and `--help` print the same as from the source;
// with the front end and the media sources, 35 modules and 920,017 bytes, and 4 page files.
// test/bundle.test.js bundles the tree and runs the bundle on every run of the tests, so that
// what would break the executable shows before a release is tagged, not after.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { isBuiltin } = require('module');

const ROOT = path.join(__dirname, '..');
const ENTRY = 'bin/solarljos.js';
const GUI = 'src/gui';
const OUT = path.join(ROOT, 'dist', 'solarljos.cjs');
const PARAMS = ['exports', 'require', 'module', '__filename', '__dirname'];

const LITERAL_REQUIRE = /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
const COMPUTED_REQUIRE = /\brequire\s*\(\s*[^\s)'"]/;
const RELATIVE_STRING = /(['"`])(\.\.?\/[^'"`\n]*)\1/g;

const posix = path.posix;

/**
 * The module a './' or '../' name stands for, seen from the module `from`, looked for as Node
 * looks for it; null when there is none. `has` says whether an id is a module. The same text
 * runs inside the bundle, so both ends resolve alike.
 */
function resolveIn(has, from, spec) {
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  for (const id of [base, base + '.js', base + '.json', base + '/index.js', base + '/index.json']) {
    if (has(id)) return id;
  }
  return null;
}

/**
 * The loader inside the bundle. Its text is copied in, so it uses nothing from this file but
 * resolveIn and `posix`, which the bundle defines beside it.
 */
function run(modules, nodeRequire, bundleFile, entry) {
  const path = nodeRequire('path');
  const vm = nodeRequire('vm');
  const { isBuiltin } = nodeRequire('module');
  const has = (id) => Object.prototype.hasOwnProperty.call(modules, id);
  const cache = Object.create(null);
  const dir = path.dirname(bundleFile);
  let main = null;

  let sea = false;
  try {
    sea = nodeRequire('node:sea').isSea();
  } catch (_) {
    sea = false;
  }
  if (sea && process.env.NODE_V8_COVERAGE) {
    try {
      nodeRequire('v8').stopCoverage();
    } catch (_) {
      /* not collecting after all */
    }
  }
  if (sea && process.env.NODE_REDIRECT_WARNINGS) {
    process.removeAllListeners('warning');
    process.on('warning', (w) => process.stderr.write(`${w.name}: ${w.message}\n`));
  }

  function requireFrom(from) {
    const require = (spec) => {
      if (typeof spec !== 'string' || !spec) throw new TypeError(`require() needs a module name, not ${String(spec)}`);
      const relative = spec.startsWith('./') || spec.startsWith('../');
      const id = relative ? resolveIn(has, from, spec) : null;
      if (id !== null) return load(id);
      if (!relative && isBuiltin(spec)) return nodeRequire(spec);
      const e = new Error(`Cannot find module '${spec}' from '${from}': it is not in this bundle`);
      e.code = 'MODULE_NOT_FOUND';
      throw e;
    };
    require.main = main;
    return require;
  }

  function load(id) {
    if (cache[id]) return cache[id].exports;
    const filename = path.join(dir, ...id.split('/'));
    const module = { id: main ? filename : '.', filename, path: path.dirname(filename), exports: {}, loaded: false };
    if (!main) main = module;
    cache[id] = module;
    try {
      if (id.endsWith('.json')) {
        module.exports = JSON.parse(modules[id]);
      } else {
        const loader = vm.constants && vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER;
        const fn = vm.compileFunction(modules[id], ['exports', 'require', 'module', '__filename', '__dirname'],
          { filename, ...(loader ? { importModuleDynamically: loader } : {}) });
        fn.call(module.exports, module.exports, requireFrom(id), module, filename, module.path);
      }
    } catch (e) {
      delete cache[id];
      throw e;
    }
    module.loaded = true;
    return module.exports;
  }

  return load(entry);
}

/**
 * Whether an id names a .js or .json file inside the project, spelled with the case it has there:
 * Windows would open src/Paths.js as src/paths.js, and the bundle, like Linux, would not.
 */
function onDisk(root, realRoot, id) {
  if (id.startsWith('../') || posix.isAbsolute(id) || !/\.(js|json)$/.test(id)) return false;
  const file = path.join(root, ...id.split('/'));
  try {
    if (!fs.statSync(file).isFile()) return false;
    return path.relative(realRoot, fs.realpathSync.native(file)).split(path.sep).join('/') === id;
  } catch (_) {
    return false;
  }
}

/** The text of every module reached from `entry`, by id, and what stops them being bundled. */
function collect(root, entry) {
  const modules = new Map();
  const problems = [];
  const realRoot = fs.realpathSync.native(root);
  const has = (id) => onDisk(root, realRoot, id);
  const queue = [entry];
  while (queue.length) {
    const id = queue.shift();
    if (modules.has(id)) continue;
    const text = fs.readFileSync(path.join(root, ...id.split('/')), 'utf8').replace(/^\uFEFF/, '');
    if (id.endsWith('.json')) {
      try {
        modules.set(id, JSON.stringify(JSON.parse(text)));
      } catch (e) {
        modules.set(id, 'null');
        problems.push(`${id}: ${e.message}`);
      }
      continue;
    }
    const code = text.replace(/^#!.*/, '');
    modules.set(id, code);
    try {
      vm.compileFunction(code, PARAMS, { filename: id });
    } catch (e) {
      problems.push(`${e.stack.split('\n')[0]}: ${e.message}`);
    }
    for (const [, , spec] of code.matchAll(LITERAL_REQUIRE)) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) {
        if (!isBuiltin(spec)) problems.push(`${id}: require('${spec}') is not one of Node's own modules`);
        continue;
      }
      const found = resolveIn(has, id, spec);
      if (found) queue.push(found);
      else problems.push(`${id}: require('${spec}') names no file of the project (the case counts)`);
    }
    if (COMPUTED_REQUIRE.test(code)) {
      for (const [, , spec] of code.matchAll(RELATIVE_STRING)) {
        const found = resolveIn(has, id, spec);
        if (found) queue.push(found);
      }
    }
  }
  return { modules, problems };
}

const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The files below src/gui that no module loads, keyed as build-exe.js stores them: by the path
 * below the folder in src/gui that holds them, or by the name of one that lies in src/gui itself.
 */
function pageFiles(root, modules, gui = GUI) {
  const top = path.join(root, ...gui.split('/'));
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(top, ...rel), { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries.sort((a, b) => ordinal(a.name, b.name))) {
      const at = [...rel, e.name];
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(at);
      else if (e.isFile() && !modules.has(`${gui}/${at.join('/')}`)) {
        out.push({ key: (at.length > 1 ? at.slice(1) : at).join('/'), file: path.join(top, ...at) });
      }
    }
  };
  walk([]);
  const seen = new Map();
  for (const p of out) {
    if (seen.has(p.key)) throw new Error(`Two page files would both be the asset "${p.key}": ${seen.get(p.key)} and ${p.file}`);
    seen.set(p.key, p.file);
  }
  return out;
}

/**
 * @param {object} [o]
 * @param {string} [o.root]   the project's folder
 * @param {string} [o.entry]  the first module, as a path relative to root
 * @param {string} [o.gui]    the folder below root whose files no module loads are page files
 * @returns {{ code: string, modules: string[], pages: { key: string, file: string }[] }}
 */
function bundle(o = {}) {
  const root = o.root || ROOT;
  const entry = o.entry || ENTRY;
  const { modules, problems } = collect(root, entry);
  if (problems.length) throw new Error(`Cannot bundle ${entry}:\n  ${problems.join('\n  ')}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const ids = [...modules.keys()].sort(ordinal);
  const code = [
    `// ${pkg.name} ${pkg.version}, bundled by scripts/bundle.js from ${ids.length} modules. Do not edit: the`,
    '// sources are in src/ and bin/. Each module is compiled when first required; see run().',
    '\'use strict\';',
    '',
    'const posix = require(\'path\').posix;',
    '',
    resolveIn.toString(),
    '',
    run.toString(),
    '',
    'run({',
    ...ids.map((id) => `${JSON.stringify(id)}: ${JSON.stringify(modules.get(id))},`),
    `}, require, __filename, ${JSON.stringify(entry)});`,
    '',
  ].join('\n');
  return { code, modules: ids, pages: pageFiles(root, modules, o.gui || GUI) };
}

function main() {
  const out = process.argv[2] ? path.resolve(process.argv[2]) : OUT;
  const started = Date.now();
  const { code, modules, pages } = bundle();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, code);
  console.log(`${modules.length} modules, ${Buffer.byteLength(code)} bytes -> ${out} (${Date.now() - started} ms); `
    + `${pages.length} page file(s) left for the executable's assets`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

module.exports = { bundle, resolveIn, ROOT, OUT };
