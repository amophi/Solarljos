'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Readable } = require('stream');
const { workDir, cleanup, write, only } = require('./helpers');
const { start, _internal } = require('../src/gui/server');
const { openWindow, windowPlan } = require('../src/gui/launch');

const { parseRange, previewOf, driveProber, checkFolder } = _internal;

// The server is driven over HTTP the way the page drives it, without a browser. Most tests give
// start() a stand-in for the library, so that every kind of copy can be made up and every call
// seen; the last one runs the library itself on a trash folder built under test/.work. No window
// is opened (open: false), the process is never ended (exit: false), and nothing on the machine
// is searched or looked at: the stand-in reads nothing, the library is given its places with
// discovery off, the home folder is a fixture, and the drives are made up (fakeDrives): C: and D:
// local, N: a share, V: a volume of its own, which is where the made-up copies were.

const win = process.platform === 'win32';
const dirs = [];
const servers = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
  dirs.forEach(cleanup);
});

function fixture(name) {
  const d = workDir(name);
  dirs.push(d);
  return d;
}

/** The last part of a path, of either kind of system. */
const base = (p) => String(p).split(/[\\/]/).pop();

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(200)]);
const box = (brand) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp' + brand), Buffer.alloc(300, 1)]);
const MP4 = box('isom');
const HEIC = box('heic');

// The made-up copies were on V:, a volume of its own -- /solarljos-test-volume elsewhere.
const V = win ? 'V:\\' : '/solarljos-test-volume';
const onV = (name) => (win ? 'V:\\home\\u\\' + name.replace(/\//g, '\\') : '/solarljos-test-volume/home/u/' + name);

/** Makes up the library: every copy a kind of file, a search that reports as the real one does. */
function stubApi(over = {}) {
  const calls = [];
  const copy = (name, bytes, extra = {}) => ({
    key: 'k\0' + name, id: crypto.createHash('sha1').update(name).digest('hex').slice(0, 8),
    kind: 'trash', source: 'trash', path: onV(name), time: Date.UTC(2026, 8, 1), size: bytes.length,
    state: 'deleted', copies: 1, seen: ['trash'], origin: '/trash/files/' + name, mediaType: null, _bytes: bytes, ...extra,
  });
  const named = {
    png: copy('photo.png', PNG, { mediaType: 'image', width: 640, height: 480 }),
    mp4: copy('clip.mp4', MP4, { mediaType: 'video' }),
    heic: copy('photo.heic', HEIC, { mediaType: 'image' }),
    html: copy('page.html', Buffer.from('<!doctype html><script>alert(1)</script>')),
    svg: copy('draw.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')),
    zip: copy('a.zip', Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(64)])),
    pdf: copy('a.pdf', Buffer.from('%PDF-1.7\n1 0 obj\n<< >>\nendobj\n')),
    utf16: copy('wide.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi there', 'utf16le')])),
    text: copy('note.txt', Buffer.alloc(0), { text: 'text kept by an editor', size: null, _bytes: null }),
    unsized: copy('unsized.txt', Buffer.from('size unknown'), { size: null }),
    short: copy('short.bin', Buffer.from('only ten b'), { size: 1000 }),
    lost: copy('lost.bin', Buffer.from('gone since'), { _lost: true }),
    derived: copy('thumb.jpg', PNG, { kind: 'thumbnail', derived: true, mediaType: 'image', path: null, name: 'thumb.jpg', ext: '.png' }),
    dir: copy('folder', Buffer.alloc(0), { isDir: true, dir: '/trash/files/folder', size: null }),
  };
  const bytesOf = (c) => (c._bytes ? c._bytes : Buffer.from(c.text || '', 'utf8'));
  const many = Array.from({ length: 1200 }, (_, i) => copy(`n${i}.txt`, Buffer.from(`note ${i}`)));
  const api = {
    calls,
    named,
    sources: [
      { id: 'trash', label: 'Trash (Linux)', media: true, needsAdmin: false },
      { id: 'claude', label: 'Claude Code', media: false, needsAdmin: false },
    ],
    TYPES: ['image', 'video', 'audio', 'document', 'archive', 'text'],
    async freeze(o) {
      calls.push(['freeze', o]);
      return [{ id: 'thumbcache', label: 'Thumbnail cache' }];
    },
    isElevated() {
      calls.push(['isElevated']);
      return false;
    },
    async search(o) {
      calls.push(['search', o]);
      const report = o.onProgress;
      report({ type: 'source-start', id: 'trash', label: 'Trash (Linux)' });
      for (let i = 1; i <= 5000; i++) report({ type: 'source-progress', id: 'trash', done: i, total: 5000 });
      report({ type: 'source-done', id: 'trash', label: 'Trash (Linux)', count: 1214 });
      report({ type: 'filtering' });
      const results = [...Object.values(named), ...many];
      report({ type: 'done', count: results.length });
      return {
        results, locations: { tag: 'search places' }, stats: {},
        perSource: [{ id: 'trash', label: 'Trash (Linux)', count: results.length, notes: ['a note'] }],
      };
    },
    async describeSources(o) {
      calls.push(['describe', o]);
      return [{ id: 'trash', label: 'Trash (Linux)', lines: ['1 place'] }];
    },
    async openCopy(c, range = {}) {
      calls.push(['openCopy', c.key, range.start, range.end]);
      if (c._lost) throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
      const b = bytesOf(c);
      // As fs.createReadStream takes it: `end` is the last byte, included.
      return Readable.from([b.subarray(range.start || 0, range.end == null ? b.length : range.end + 1)]);
    },
    sniff(b) {
      if (b.subarray(0, 8).equals(PNG.subarray(0, 8))) return { mediaType: 'image', ext: '.png' };
      if (b.toString('latin1', 4, 8) === 'ftyp') {
        return b.toString('latin1', 8, 12) === 'heic' ? { mediaType: 'image', ext: '.heic' } : { mediaType: 'video', ext: '.mp4' };
      }
      if (b.toString('latin1', 0, 4) === '<svg') return { mediaType: 'image', ext: '.svg' };
      if (b.toString('latin1', 0, 4) === 'PK\x03\x04') return { mediaType: 'archive', ext: '.zip' };
      if (b.toString('latin1', 0, 5) === '%PDF-') return { mediaType: 'document', ext: '.pdf' };
      return { mediaType: null, ext: null };
    },
    // Refuses what lies below a folder named "protected", as the library refuses a source's folder.
    async checkDestination(dir, locations) {
      calls.push(['checkDestination', dir, locations]);
      if (/protected/.test(dir)) throw new Error(`Refusing to write inside ${dir}; that is where copies are searched for.`);
      return dir;
    },
    async restoreCopy(c, dir, locations) {
      calls.push(['restoreCopy', c.key, dir, locations]);
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, base(c.path || c.name));
      fs.writeFileSync(target, bytesOf(c), { flag: 'wx' });
      return target;
    },
    async planFolder(folder, o) {
      calls.push(['plan', folder, o]);
      o.onProgress({ type: 'source-start', id: 'trash', label: 'Trash (Linux)' });
      o.onProgress({ type: 'source-done', id: 'trash', label: 'Trash (Linux)', count: 2 });
      return {
        folder: onV('app'),
        plan: [
          { rel: ['app', 'a.txt'], copy: copy('app/a.txt', Buffer.from('alpha')) },
          { rel: ['app', 'b.txt'], copy: copy('app/b.txt', Buffer.from('beta'), { kind: 'git commit' }) },
        ],
        leftOut: [{ rel: ['app', 'c.jpg'], copy: copy('app/c.jpg', PNG, { kind: 'thumbnail', derived: true }) }],
        locations: { tag: 'plan places' },
        perSource: [{ id: 'trash', label: 'Trash (Linux)', count: 3, notes: [] }],
        notes: ['1 copy(ies) carry no date'],
      };
    },
    async rebuildFolder(plan, folder, dest, locations, options = {}) {
      calls.push(['rebuild', plan.map((p) => p.rel.join('/')), folder, dest, locations]);
      const root = path.join(dest, 'app');
      const written = plan.map((item, i) => {
        const target = write(path.join(root, ...item.rel), bytesOf(item.copy));
        if (options.onProgress) options.onProgress({ done: i + 1, total: plan.length, rel: item.rel });
        return { ...item, target };
      });
      return { root, written, failed: [] };
    },
    ...over,
  };
  return api;
}

/**
 * fs.promises with this machine's drives made up, the rest real: on Windows C: (the system's)
 * and D: local, N: mapped to a share, V: a volume of its own, no other letter; elsewhere / alone,
 * with nothing mounted below /media, /run/media or /mnt. V: is a folder at its root and nothing
 * below it.
 */
function fakeDrives() {
  const real = fs.promises;
  const err = (code) => Promise.reject(Object.assign(new Error(code), { code }));
  const roots = { 'C:\\': 'C:\\', 'D:\\': 'D:\\', 'N:\\': '\\\\nas\\share\\', 'V:\\': 'V:\\' };
  const isRoot = (p) => (win ? /^[A-Za-z]:\\$/.test(p) : p === '/');
  const onVolume = (p) => String(p).toLowerCase().startsWith(V.toLowerCase());
  return {
    ...real,
    realpath(p, ...a) {
      if (!isRoot(p)) return real.realpath(p, ...a);
      if (!win) return Promise.resolve('/');
      return roots[p.toUpperCase()] ? Promise.resolve(roots[p.toUpperCase()]) : err('ENOENT');
    },
    statfs(p, ...a) {
      if (isRoot(p) || onVolume(p)) return Promise.resolve({ bavail: p[0] === 'D' ? 20 : 10, bsize: 4096, blocks: 100 });
      return real.statfs(p, ...a);
    },
    readdir(p, ...a) {
      if (!win && ['/media', '/run/media', '/mnt'].some((m) => p === m || p.startsWith(m + '/'))) return Promise.resolve([]);
      return real.readdir(p, ...a);
    },
    stat(p, o) {
      if (!onVolume(p)) return real.stat(p, o);
      const top = p.replace(/[\\/]+$/, '').toLowerCase() === V.replace(/[\\/]+$/, '').toLowerCase();
      return top ? Promise.resolve({ isDirectory: () => true, dev: o && o.bigint ? 999n : 999 }) : err('ENOENT');
    },
  };
}

/** One request; a reply cut off after it began comes back with complete: false. */
function request(origin, pathName, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(origin);
    let answer = null;
    const r = http.request({ host: u.hostname, port: u.port, path: pathName, method, headers }, (res) => {
      const parts = [];
      answer = () => ({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts), complete: res.complete });
      res.on('data', (c) => parts.push(c));
      res.on('error', () => {});
      res.on('close', () => resolve(answer()));
    });
    r.on('error', (e) => (answer ? resolve(answer()) : reject(e)));
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

const json = (r) => JSON.parse(r.body.toString());

/** Starts a server on the stand-in, trades its token for the cookie, and gives ways to ask it as the page does. */
async function session(over = {}) {
  const api = over.api || stubApi();
  const lines = [];
  const home = fixture('gui-home');
  const server = await start({
    api, open: false, exit: false, elevated: false, program: false, home, fsp: fakeDrives(),
    log: (s) => lines.push(s), locations: { discover: false },
    assets: (rel) => ({ 'index.html': Buffer.from('<!doctype html><title>t</title>'), 'app.js': Buffer.from('1') })[rel] || null,
    ...over,
  });
  servers.push(server);
  const u = new URL(server.url);
  const r = await request(u.origin, u.pathname + u.search);
  const cookie = (r.headers['set-cookie'] || [''])[0].split(';')[0];
  const get = (p, o = {}) => request(u.origin, p, { ...o, headers: { Cookie: cookie, ...(o.headers || {}) } });
  const post = (p, body, o = {}) => request(u.origin, p, {
    method: 'POST', body,
    headers: { Cookie: cookie, Origin: u.origin, 'Sec-Fetch-Site': 'same-origin', 'X-Solarljos': '1', 'Content-Type': 'application/json', ...(o.headers || {}) },
  });
  return { api, server, lines, cookie, home, origin: u.origin, url: server.url, first: r, get, post };
}

/** Listens to the event stream as a window would. */
function listen(s) {
  const got = [];
  const waiting = [];
  const u = new URL(s.origin);
  const req = http.get({ host: u.hostname, port: u.port, path: '/api/events', headers: { Cookie: s.cookie } }, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block);
        const data = /^data: (.*)$/m.exec(block);
        if (event && data) got.push({ event: event[1], data: JSON.parse(data[1]) });
      }
      for (const w of waiting.slice()) {
        if (got.some(w.pred)) {
          waiting.splice(waiting.indexOf(w), 1);
          w.resolve(got);
        }
      }
    });
  });
  req.on('error', () => {});
  return {
    got,
    until(pred, ms = 5000) {
      if (got.some(pred)) return Promise.resolve(got);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiting.push(w);
        setTimeout(() => reject(new Error('no such event came: ' + JSON.stringify(got.map((g) => g.event)))), ms).unref();
      });
    },
    close() {
      req.destroy();
    },
  };
}

const settled = (p, ms) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function searched(s, body = { pattern: '*' }) {
  const events = listen(s);
  await events.until((e) => e.event === 'hello');
  const r = await s.post('/api/search', body);
  assert.strictEqual(r.status, 202, r.body.toString());
  const job = JSON.parse(r.body).job;
  await events.until((e) => e.event === 'done' && e.data.id === job.id);
  const page = JSON.parse((await s.get(`/api/job/${job.id}/items?limit=2000`)).body);
  const byName = new Map(page.items.map((c) => [base(c.path || c.name), c]));
  return { events, job, items: page.items, byName };
}

test('the token is traded once for a cookie that no script and no other site gets', async () => {
  const s = await session();
  assert.strictEqual(s.first.status, 302);
  assert.strictEqual(s.first.headers.location, '/');
  const port = new URL(s.origin).port;
  const set = s.first.headers['set-cookie'][0];
  assert.match(set, new RegExp(`^solarljos-${port}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict$`));
  assert.ok(!set.includes(new URL(s.url).searchParams.get('k')), 'the cookie is not the token');
  assert.match(new URL(s.url).searchParams.get('k'), /^[A-Za-z0-9_-]{43}$/);

  assert.strictEqual((await request(s.origin, '/?k=' + 'x'.repeat(43))).status, 403);
  // The token works once: whatever reads it later -- from the browser's command line, or its
  // history -- gets no cookie with it. The window that traded it is sent on, by its cookie.
  const again = await request(s.origin, new URL(s.url).pathname + new URL(s.url).search);
  assert.strictEqual(again.status, 403, 'a second trade of the same token');
  assert.strictEqual(again.headers['set-cookie'], undefined);
  assert.match(again.body.toString(), /works once/);
  const mine = await s.get(new URL(s.url).pathname + new URL(s.url).search);
  assert.deepStrictEqual([mine.status, mine.headers.location, mine.headers['set-cookie']], [302, '/', undefined]);
  assert.strictEqual((await request(s.origin, '/')).status, 403, 'no cookie');
  assert.strictEqual((await request(s.origin, '/api/info')).status, 403, 'no cookie');
  assert.strictEqual((await s.get('/api/info', { headers: { Cookie: `solarljos-${port}=nope` } })).status, 403);
  // Another run's cookie, even under this run's name, is not this run's.
  const other = await session();
  assert.notStrictEqual(other.cookie.split('=')[0], s.cookie.split('=')[0], 'each port its own cookie name');
  const theirs = other.cookie.split('=')[1];
  assert.strictEqual((await s.get('/api/info', { headers: { Cookie: `solarljos-${port}=${theirs}` } })).status, 403);
  assert.strictEqual((await s.get('/api/info')).status, 200);
  // The server says where it is, once: the command line leaves that to it.
  assert.strictEqual(s.lines.filter((l) => l.includes(s.url)).length, 1);
});

test('refuses another host, origin or site, other methods, and a POST that is not JSON from the page', async () => {
  const s = await session();
  const port = new URL(s.origin).port;
  for (const host of [`localhost:${port}`, `evil.example:${port}`, `127.0.0.1:${Number(port) + 1}`, '127.0.0.1']) {
    assert.strictEqual((await s.get('/', { headers: { Host: host } })).status, 403, host);
  }
  for (const origin of ['http://evil.example', `http://127.0.0.1:${Number(port) + 1}`, 'null']) {
    assert.strictEqual((await s.get('/api/info', { headers: { Origin: origin } })).status, 403, origin);
    assert.strictEqual((await s.post('/api/search', { pattern: 'x' }, { headers: { Origin: origin, 'Sec-Fetch-Site': 'cross-site' } })).status, 403, origin);
  }
  for (const site of ['cross-site', 'same-site']) {
    assert.strictEqual((await s.get('/api/info', { headers: { 'Sec-Fetch-Site': site } })).status, 403, site);
  }
  assert.strictEqual((await s.get('/api/info', { headers: { 'Sec-Fetch-Site': 'same-origin', Origin: s.origin } })).status, 200);
  assert.strictEqual((await s.get('/', { headers: { 'Sec-Fetch-Site': 'none' } })).status, 200);

  for (const method of ['OPTIONS', 'PUT', 'DELETE']) {
    const r = await s.get('/api/search', { method, headers: { Origin: s.origin, 'Access-Control-Request-Method': 'POST' } });
    assert.strictEqual(r.status, 405, method);
    assert.ok(!Object.keys(r.headers).some((h) => h.startsWith('access-control-')), 'no CORS header');
  }
  const noOrigin = await request(s.origin, '/api/search', {
    method: 'POST', body: { pattern: 'x' }, headers: { Cookie: s.cookie, 'Content-Type': 'application/json', 'X-Solarljos': '1' },
  });
  assert.strictEqual(noOrigin.status, 403);
  assert.strictEqual((await s.post('/api/search', { pattern: 'x' }, { headers: { 'X-Solarljos': '' } })).status, 403, 'not from the page');
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    assert.strictEqual((await s.post('/api/search', { pattern: 'x' }, { headers: { 'Content-Type': type } })).status, 415, type);
  }
  const bad = await s.post('/api/search', '{not json');
  assert.deepStrictEqual([bad.status, typeof json(bad).error], [400, 'string'], 'said as { error }, which the page shows');
  assert.strictEqual(s.api.calls.filter((c) => c[0] === 'search').length, 0, 'nothing refused ever reached the library');
  // The goodbye comes by beacon: without the page's header, and with "null" for its origin under
  // a no-referrer policy, which only the page's own request, marked same-origin, may say.
  const beacon = (origin, site) => request(s.origin, '/api/bye', {
    method: 'POST', headers: { Cookie: s.cookie, Origin: origin, 'Sec-Fetch-Site': site, 'Content-Type': 'text/plain;charset=UTF-8' },
  });
  assert.strictEqual((await beacon(s.origin, 'same-origin')).status, 204);
  assert.strictEqual((await beacon('null', 'same-origin')).status, 204);
  assert.strictEqual((await beacon('null', 'cross-site')).status, 403);
});

test('serves the page under a strict policy, keeps nothing in the browser cache, and only its own files', async () => {
  const s = await session();
  const page = await s.get('/');
  assert.strictEqual(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  const csp = page.headers['content-security-policy'];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /require-trusted-types-for 'script'; trusted-types 'none'/);
  assert.ok(!/unsafe/.test(csp), csp);
  for (const [h, v] of [['cache-control', 'no-store'], ['x-content-type-options', 'nosniff'], ['referrer-policy', 'same-origin'],
    ['x-frame-options', 'DENY'], ['cross-origin-resource-policy', 'same-origin']]) {
    assert.strictEqual(page.headers[h], v, h);
  }
  assert.match((await s.get('/app.js')).headers['content-type'], /^text\/javascript/);
  assert.strictEqual((await s.get('/api/info')).headers['cache-control'], 'no-store');
  for (const p of ['/missing.js', '/..%2fpackage.json', '/.hidden.js', '/app.exe', '/a//b.js']) {
    assert.strictEqual((await s.get(p)).status, 404, p);
  }
  // Without the page's files, it says so rather than failing.
  const bare = await session({ assets: () => null });
  const fallback = await bare.get('/');
  assert.strictEqual(fallback.status, 200);
  assert.match(fallback.body.toString(), /files of its page were not found/);
});

test('serves the page in src/gui/ui itself, and every file it names', async () => {
  const ui = path.join(__dirname, '..', 'src', 'gui', 'ui');
  const s = await session({ assets: undefined });
  // The bytes of a page file as served, and as the file holds them just before and just after:
  // the page is served from the files as they are, so one changed meanwhile may be either.
  const served = async (p, file) => {
    const before = fs.readFileSync(file);
    const r = await s.get(p);
    const now = fs.readFileSync(file);
    assert.strictEqual(r.status, 200, p);
    assert.ok(r.body.equals(before) || r.body.equals(now), `${p} is ${file} as it is`);
    return r;
  };
  const page = await served('/', path.join(ui, 'index.html'));
  assert.match(page.headers['content-type'], /^text\/html/);
  const names = [...page.body.toString('utf8').matchAll(/\b(?:src|href)\s*=\s*["']([^"'#?]+)/g)].map((m) => m[1])
    .filter((ref) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref));
  assert.ok(names.length >= 2, `the page names ${names.join(', ')}`);
  for (const ref of names) {
    const at = new URL(ref, s.origin + '/');
    await served(at.pathname, path.join(ui, ...decodeURIComponent(at.pathname).slice(1).split('/')));
  }
});

test('streams progress, thinned, then the results in batches; the page can fetch them again', async () => {
  const s = await session();
  const { events, job, items } = await searched(s, { pattern: '*', types: ['image'], sources: ['trash'], deletedOnly: true });
  const mine = events.got.filter((e) => e.data.job === job.id || e.data.id === job.id);
  const progress = mine.filter((e) => e.event === 'progress').map((e) => e.data);
  assert.deepStrictEqual([...new Set(progress.map((e) => e.type))], ['source-start', 'source-progress', 'source-done', 'filtering', 'done']);
  const ticks = progress.filter((e) => e.type === 'source-progress');
  assert.ok(ticks.length < 50, `${ticks.length} ticks of 5000 sent`);
  assert.strictEqual(ticks.at(-1).done, 5000, 'the last tick is kept');
  const batches = mine.filter((e) => e.event === 'results').map((e) => e.data);
  assert.deepStrictEqual(batches.map((b) => [b.offset, b.items.length, b.total]), [[0, 500, 1214], [500, 500, 1214], [1000, 214, 1214]]);
  assert.strictEqual(mine.at(-1).event, 'done');
  const done = mine.at(-1).data;
  assert.strictEqual(done.state, 'done');
  assert.strictEqual(done.total, 1214);
  assert.deepStrictEqual(done.perSource[0].notes, ['a note']);
  assert.deepStrictEqual(done.sources.map((x) => [x.id, x.state, x.count]), [['trash', 'done', 1214]]);
  assert.strictEqual(items.length, 1214);

  // What the library was asked, and what the page is never sent.
  const asked = s.api.calls.find((c) => c[0] === 'search')[1];
  assert.deepStrictEqual([asked.pattern, asked.types, asked.sources, asked.deletedOnly], ['*', ['image'], ['trash'], true]);
  assert.strictEqual(asked.locations.discover, false);
  for (const c of items) {
    assert.match(c.uid, /^[0-9a-f]{32}$/);
    for (const k of ['_bytes', 'buffer', 'text', 'file', 'gitBlob', 'key', 'hash']) assert.ok(!(k in c), k);
  }
  const derived = items.find((c) => c.name === 'thumb.jpg');
  assert.strictEqual(derived.tier, 4);
  assert.strictEqual(derived.ext, '.png');
  const png = items.find((c) => c.path === onV('photo.png'));
  assert.deepStrictEqual([png.mediaType, png.width, png.height, png.tier, png.kindLabel], ['image', 640, 480, 0, 'trash']);

  // The same copy has the same uid in the next search; a page that reconnects is told where things are.
  const again = await searched(s);
  assert.strictEqual(again.items.find((c) => c.path === onV('photo.png')).uid, png.uid);
  const late = listen(s);
  const hello = (await late.until((e) => e.event === 'hello')).find((e) => e.event === 'hello').data;
  assert.ok(hello.jobs.some((j) => j.id === again.job.id && j.state === 'done' && j.total === 1214));
  assert.ok(!hello.jobs.some((j) => j.id === job.id), 'an older search of the same kind is let go');
  assert.strictEqual((await s.get(`/api/job/${job.id}`)).status, 404);
  events.close();
  again.events.close();
  late.close();
});

test('a very large search sends its first results on the stream and leaves the rest to be fetched', async () => {
  const api = stubApi();
  const search = api.search;
  api.search = async (o) => {
    const out = await search(o);
    const many = Array.from({ length: 6000 }, (_, i) => ({ ...out.results[0], key: `k\0many${i}`, path: onV(`m${i}.png`) }));
    return { ...out, results: many };
  };
  const s = await session({ api });
  const { events, job, items } = await searched(s);
  const batches = events.got.filter((e) => e.event === 'results' && e.data.job === job.id).map((e) => e.data);
  assert.strictEqual(batches.reduce((n, b) => n + b.items.length, 0), 5000);
  assert.ok(batches.every((b) => b.total === 6000 && b.items.length <= 500));
  // The stream was kept, and done came after the batches.
  assert.strictEqual(events.got.filter((e) => e.data.id === job.id).at(-1).event, 'done');
  assert.strictEqual(items.length, 2000, 'a page of items');
  const last = JSON.parse((await s.get(`/api/job/${job.id}/items?offset=5000&limit=2000`)).body);
  assert.deepStrictEqual([last.total, last.items.length, last.items[999].path], [6000, 1000, onV('m5999.png')]);
  events.close();
});

test('checks what is asked before searching, runs one search at a time, and drops one that is stopped', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const api = stubApi();
  const search = api.search;
  let running = 0;
  let most = 0;
  api.search = async (o) => {
    most = Math.max(most, ++running);
    try {
      await gate;
      return await search(o);
    } finally {
      running--;
    }
  };
  const s = await session({ api });
  const bad = async (body, pattern) => {
    const r = await s.post('/api/search', body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    assert.match(JSON.parse(r.body).error, pattern);
  };
  await bad({}, /Give a name/);
  await bad({ types: ['photos'] }, /Unknown type: photos/);
  await bad({ pattern: 'x', sources: ['nope'] }, /Unknown source: nope/);
  await bad({ pattern: 'x', since: '2026-01-01' }, /milliseconds/);
  await bad({ pattern: 'x', locations: { dirs: { trash: [''] } } }, /Give a place for trash/);
  await bad({ pattern: 'x', locations: [] }, /Give the places/);

  const events = listen(s);
  const first = JSON.parse((await s.post('/api/search', { pattern: 'a', locations: { dirs: { trash: ['/t'] } } })).body).job;
  const busy = await s.post('/api/search', { pattern: 'b' });
  assert.strictEqual(busy.status, 409);
  assert.strictEqual(JSON.parse(busy.body).job, first.id);
  const stopped = await s.post('/api/cancel', { job: first.id });
  assert.strictEqual(JSON.parse(stopped.body).job.state, 'cancelled');
  await events.until((e) => e.event === 'cancelled' && e.data.id === first.id);
  const second = JSON.parse((await s.post('/api/search', { pattern: 'c' })).body).job;
  release();
  await events.until((e) => e.event === 'done' && e.data.id === second.id);
  await sleep(50);
  assert.ok(!events.got.some((e) => e.event === 'results' && e.data.job === first.id), 'a stopped search sends nothing');
  const asked = api.calls.filter((c) => c[0] === 'search').map((c) => c[1]);
  assert.deepStrictEqual(asked[0].locations.dirs.trash, ['/t']);
  assert.ok(asked[0].signal.aborted, 'the library is told, should it listen');
  // The next search started only once the stopped one had settled, not beside it.
  assert.strictEqual(most, 1);
  assert.strictEqual(asked.length, 2);
  // One stopped before its turn came is never run at all.
  let hold;
  api.search = async (o) => {
    await new Promise((r) => { hold = r; });
    return search(o);
  };
  const third = JSON.parse((await s.post('/api/search', { pattern: 'd' })).body).job;
  await sleep(20);
  await s.post('/api/cancel', { job: third.id });
  const fourth = JSON.parse((await s.post('/api/search', { pattern: 'e' })).body).job;
  await s.post('/api/cancel', { job: fourth.id });
  hold();
  await sleep(50);
  assert.deepStrictEqual(api.calls.filter((c) => c[0] === 'search').map((c) => c[1].pattern), ['a', 'c', 'd']);
  events.close();
});

test('keeps the last search of each of the page\'s views, and gives its form back as it came', async () => {
  const s = await session();
  const nameForm = { mode: 'name', name: 'budget', deletedOnly: true, sinceChoice: 'lastYear', types: [] };
  const byName = await searched(s, { pattern: 'budget', view: nameForm });
  const photos = await searched(s, { types: ['image'], view: { mode: 'media', types: ['image'], whenChoice: 'any' } });
  const late = listen(s);
  const hello = (await late.until((e) => e.event === 'hello')).find((e) => e.event === 'hello').data;
  late.close();
  const kept = hello.jobs.map((j) => j.id).sort();
  assert.deepStrictEqual(kept, [byName.job.id, photos.job.id].sort(), 'a search for photos leaves the one by name');
  assert.deepStrictEqual(hello.jobs.find((j) => j.id === byName.job.id).request.view, nameForm);
  // The library is never given the form.
  assert.ok(s.api.calls.filter((c) => c[0] === 'search').every((c) => !('view' in c[1])));
  // A second search by name replaces the first; the one for photos stays.
  const again = await searched(s, { pattern: 'report', view: { mode: 'name', name: 'report' } });
  assert.strictEqual((await s.get(`/api/job/${byName.job.id}`)).status, 404);
  assert.strictEqual((await s.get(`/api/job/${photos.job.id}`)).status, 200);
  const big = await s.post('/api/search', { pattern: 'x', view: { mode: 'name', pad: 'x'.repeat(20000) } });
  assert.deepStrictEqual([big.status, /view must be a small object/.test(big.body)], [400, true]);
  assert.strictEqual((await s.post('/api/search', { pattern: 'x', view: ['name'] })).status, 400);
  for (const x of [byName, photos, again]) x.events.close();
});

/** A JPEG whose Exif block holds a small picture, as a camera writes it. */
function exifJpeg({ orientation = 1, thumb = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]), big = false, rest = 5000 } = {}) {
  const tiff = Buffer.alloc(56 + thumb.length);
  const u16 = (v, o) => (big ? tiff.writeUInt16BE(v, o) : tiff.writeUInt16LE(v, o));
  const u32 = (v, o) => (big ? tiff.writeUInt32BE(v, o) : tiff.writeUInt32LE(v, o));
  tiff.write(big ? 'MM' : 'II', 0, 'latin1');
  u16(42, 2);
  u32(8, 4);
  // IFD0: the orientation, then where IFD1 is.
  u16(1, 8);
  u16(0x0112, 10); u16(3, 12); u32(1, 14); u16(orientation, 18);
  u32(26, 22);
  // IFD1: where the small picture is, and its length.
  u16(2, 26);
  u16(0x0201, 28); u16(4, 30); u32(1, 32); u32(56, 36);
  u16(0x0202, 40); u16(4, 42); u32(1, 44); u32(thumb.length, 48);
  u32(0, 52);
  thumb.copy(tiff, 56);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(app1.length + 2);
  const jfif = Buffer.from([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, Buffer.from([0xff, 0xe1]), len, app1,
    Buffer.from([0xff, 0xda, 0, 2]), crypto.randomBytes(rest), Buffer.from([0xff, 0xd9])]);
}

test('a photo\'s own small picture is taken from its Exif block for the grid, and nothing else is', async () => {
  const { exifThumbnail } = _internal;
  const thumb = Buffer.concat([Buffer.from([0xff, 0xd8]), crypto.randomBytes(300), Buffer.from([0xff, 0xd9])]);
  for (const big of [false, true]) {
    const got = exifThumbnail(exifJpeg({ orientation: 6, thumb, big }));
    assert.ok(got && got.data.equals(thumb), `byte order ${big ? 'MM' : 'II'}`);
    assert.strictEqual(got.orientation, 6);
  }
  assert.strictEqual(exifThumbnail(exifJpeg({ orientation: 0, thumb })).orientation, 1, 'an orientation not in 1..8 reads as 1');
  // Not a JPEG, no Exif block, a picture that does not start as one, a block cut short: none.
  assert.strictEqual(exifThumbnail(PNG), null);
  assert.strictEqual(exifThumbnail(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 1, 2])), null);
  assert.strictEqual(exifThumbnail(exifJpeg({ thumb: Buffer.from('not a jpeg') })), null);
  assert.strictEqual(exifThumbnail(exifJpeg({ thumb }).subarray(0, 80)), null);

  const photo = exifJpeg({ orientation: 8, thumb, rest: 100000 });
  const plain = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]), crypto.randomBytes(1000)]);
  const api = stubApi();
  const extra = [
    { ...api.named.png, key: 'k\0exif.jpg', path: onV('exif.jpg'), size: photo.length, _bytes: photo },
    { ...api.named.png, key: 'k\0plain.jpg', path: onV('plain.jpg'), size: plain.length, _bytes: plain },
  ];
  const search = api.search;
  api.search = async (o) => {
    const out = await search(o);
    return { ...out, results: [...extra, ...out.results] };
  };
  const sniff = api.sniff;
  api.sniff = (b) => (b[0] === 0xff && b[1] === 0xd8 ? { mediaType: 'image', ext: '.jpg' } : sniff(b));
  const s = await session({ api });
  const { byName, events } = await searched(s);
  const r = await s.get(`/api/copy/${byName.get('exif.jpg').uid}/thumb`);
  assert.deepStrictEqual([r.status, r.headers['content-type'], r.headers['x-solarljos-orientation']], [200, 'image/jpeg', '8']);
  assert.ok(r.body.equals(thumb));
  assert.strictEqual(r.headers['content-security-policy'], "default-src 'none'; sandbox");
  // It reads the start of the photo only.
  const read = api.calls.filter((c) => c[0] === 'openCopy' && c[1] === 'k\0exif.jpg').map((c) => c[3]);
  assert.ok(read.every((end) => end != null && end < 70000), JSON.stringify(read));
  for (const name of ['plain.jpg', 'photo.png', 'page.html']) {
    assert.strictEqual((await s.get(`/api/copy/${byName.get(name).uid}/thumb`)).status, 404, name);
  }
  events.close();
});

test('a search for pictures walks Pictures and Videos in shadow copies; a plan has git look where the folder was', async () => {
  const s = await session({ locations: { discover: true } });
  write(path.join(s.home, 'Pictures', 'keep'), '');
  write(path.join(s.home, 'Videos', 'keep'), '');
  const { events } = await searched(s, { types: ['image', 'video'], locations: { dirs: { vss: ['walk=' + path.join(s.home, 'Work')] } } });
  events.close();
  const asked = s.api.calls.find((c) => c[0] === 'search')[1];
  assert.deepStrictEqual(asked.locations.dirs.vss,
    ['walk=' + path.join(s.home, 'Work'), 'walk=' + path.join(s.home, 'Pictures'), 'walk=' + path.join(s.home, 'Videos')]);
  assert.ok(asked.locations.dirs.git.includes(s.home), 'git looks in the usual homes of repositories');
  // A repository added in the page is searched as well as those, not instead of them.
  const other = win ? 'E:\\repos' : '/mnt/other/repos';
  const added = await searched(s, { pattern: 'y', locations: { dirs: { git: [other] } } });
  added.events.close();
  const withAdded = s.api.calls.filter((c) => c[0] === 'search').at(-1)[1].locations.dirs.git;
  assert.deepStrictEqual([withAdded[0], withAdded.includes(s.home)], [other, true]);
  const byName = await searched(s, { pattern: 'x' });
  byName.events.close();
  assert.strictEqual(s.api.calls.filter((c) => c[0] === 'search').at(-1)[1].locations.dirs.vss, undefined, 'not for a search by name');

  // The folder is gone; git looks from the nearest part of it still there.
  const gone = path.join(s.home, 'projects', 'app', 'src');
  fs.mkdirSync(path.join(s.home, 'projects'));
  const plan = await s.post('/api/plan', { folder: gone });
  assert.strictEqual(plan.status, 202, plan.body.toString());
  const inPlan = s.api.calls.find((c) => c[0] === 'plan')[2];
  assert.ok(inPlan.locations.dirs.git.includes(path.join(s.home, 'projects')), JSON.stringify(inPlan.locations.dirs.git));
});

test('sends a copy as its sniffed type only when a browser shows it, never as HTML, with ranges', async () => {
  const s = await session();
  const { byName, events } = await searched(s);
  const get = (name, o) => s.get(`/api/copy/${byName.get(name).uid}`, o);

  const png = await get('photo.png');
  assert.strictEqual(png.status, 200);
  assert.strictEqual(png.headers['content-type'], 'image/png');
  assert.strictEqual(png.headers['content-disposition'], 'inline');
  assert.strictEqual(png.headers['content-security-policy'], "default-src 'none'; sandbox");
  assert.strictEqual(png.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(png.headers['accept-ranges'], 'bytes');
  assert.ok(png.body.equals(PNG));

  const part = await get('photo.png', { headers: { Range: 'bytes=0-15' } });
  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.headers['content-range'], `bytes 0-15/${PNG.length}`);
  assert.ok(part.body.equals(PNG.subarray(0, 16)));
  const tail = await get('photo.png', { headers: { Range: 'bytes=-10' } });
  assert.ok(tail.body.equals(PNG.subarray(-10)));
  const rest = await get('photo.png', { headers: { Range: 'bytes=100-' } });
  assert.strictEqual(rest.headers['content-range'], `bytes 100-${PNG.length - 1}/${PNG.length}`);
  assert.ok(rest.body.equals(PNG.subarray(100)));
  const beyond = await get('photo.png', { headers: { Range: `bytes=${PNG.length}-` } });
  assert.strictEqual(beyond.status, 416);
  assert.strictEqual(beyond.headers['content-range'], `bytes */${PNG.length}`);
  assert.strictEqual((await get('photo.png', { headers: { Range: 'bytes=0-1,4-5' } })).status, 200, 'several ranges: the whole');
  const head = await get('photo.png', { method: 'HEAD' });
  assert.strictEqual(head.status, 200);
  assert.strictEqual(Number(head.headers['content-length']), PNG.length);
  assert.strictEqual(head.body.length, 0);

  const expect = {
    'clip.mp4': ['video/mp4', 'inline'],
    'page.html': ['text/plain; charset=utf-8', 'inline'],
    'draw.svg': ['text/plain; charset=utf-8', 'inline'],
    'wide.txt': ['text/plain; charset=utf-16le', 'inline'],
    'note.txt': ['text/plain; charset=utf-8', 'inline'],
    'photo.heic': ['application/octet-stream', 'attachment'],
    'a.zip': ['application/octet-stream', 'attachment'],
    'a.pdf': ['application/octet-stream', 'attachment'],
  };
  for (const [name, [type, disposition]] of Object.entries(expect)) {
    const r = await get(name);
    assert.strictEqual(r.status, 200, name);
    assert.deepStrictEqual([r.headers['content-type'], r.headers['content-disposition']], [type, disposition], name);
    assert.strictEqual(r.headers['content-security-policy'], "default-src 'none'; sandbox", name);
  }
  assert.strictEqual((await get('note.txt')).body.toString(), 'text kept by an editor');
  const about = JSON.parse((await s.get(`/api/copy/${byName.get('photo.heic').uid}/about`)).body);
  assert.deepStrictEqual([about.preview, about.inline, about.mediaType, about.ext], [null, false, 'image', '.heic']);

  // A length not known for sure: the whole copy, without ranges. One that ends short is cut off.
  const unsized = await get('unsized.txt', { headers: { Range: 'bytes=0-1' } });
  assert.deepStrictEqual([unsized.status, unsized.headers['accept-ranges'], unsized.body.toString()], [200, 'none', 'size unknown']);
  const short = await get('short.bin');
  assert.ok(!short.complete && short.body.length < 1000, 'a copy shorter than its size is never sent as complete');
  // A copy gone since the search: 410, with the system's code for the page to put in words.
  const lost = await get('lost.bin');
  assert.deepStrictEqual([lost.status, json(lost).code], [410, 'ENOENT']);
  assert.match(json(lost).error, /Could not read this copy/);

  assert.strictEqual((await s.get(`/api/copy/${byName.get('folder').uid}`)).status, 409);
  assert.strictEqual((await s.get(`/api/copy/${'0'.repeat(32)}`)).status, 404);
  assert.strictEqual((await s.get('/api/copy/..%2f..%2fetc')).status, 404);
  // A copy is never a page of its own, where the browser would offer to save it to Downloads.
  const photo = byName.get('photo.png').uid;
  for (const dest of ['document', 'iframe', 'frame', 'embed', 'object']) {
    const r = await s.get(`/api/copy/${photo}`, { headers: { 'Sec-Fetch-Dest': dest } });
    assert.strictEqual(r.status, 403, dest);
    assert.strictEqual((await s.get(`/api/copy/${photo}/thumb`, { headers: { 'Sec-Fetch-Dest': dest } })).status, 403, dest);
  }
  for (const dest of ['image', 'video', 'empty']) {
    assert.strictEqual((await s.get(`/api/copy/${photo}`, { headers: { 'Sec-Fetch-Dest': dest } })).status, 200, dest);
  }
  events.close();
});

test('restores into a folder typed by the user, checking it first, and says where each copy went', async () => {
  const s = await session();
  const { byName, events } = await searched(s);
  const root = fixture('gui-restore');
  const file = write(path.join(root, 'taken.txt'), 'x');
  const uid = byName.get('photo.png').uid;
  const refused = async (to, pattern) => {
    const r = await s.post('/api/restore', { uids: [uid], to });
    assert.strictEqual(r.status, 400, String(to));
    assert.match(JSON.parse(r.body).error, pattern, String(to));
  };
  await refused('', /Type the folder/);
  await refused('relative/out', /whole path/);
  await refused('\\\\.\\PhysicalDrive0', win ? /device path/ : /whole path/);
  await refused(file, /is a file, not a folder/);
  await refused(path.join(file, 'sub'), /is a file, so no folder can be made inside it/);
  await refused(path.join(root, 'protected'), /Refusing to write inside/);
  assert.strictEqual((await s.post('/api/restore', { uids: ['photo.png'], to: root })).status, 400);
  const inside = JSON.parse((await s.post('/api/check-folder', { to: path.join(root, 'protected'), uids: [uid] })).body);
  assert.deepStrictEqual([inside.ok, /Refusing/.test(inside.error)], [false, true]);
  assert.deepStrictEqual(s.api.calls.find((c) => c[0] === 'checkDestination')[2], { tag: 'search places' });
  assert.ok(!s.api.calls.some((c) => c[0] === 'restoreCopy'), 'nothing was written for a refused folder');

  const to = path.join(root, 'out', 'new');
  const check = JSON.parse((await s.post('/api/check-folder', { to, uids: [uid] })).body);
  assert.deepStrictEqual([check.ok, check.path, check.exists, check.root], [true, path.resolve(to), false, path.parse(path.resolve(to)).root]);
  assert.strictEqual(typeof check.free, 'number');
  assert.strictEqual(check.sameDrive, 0, 'the original was on V:, a volume of its own');
  assert.deepStrictEqual(JSON.parse((await s.post('/api/check-folder', { to: 'nowhere' })).body).ok, false);

  const r = await s.post('/api/restore', { uids: [uid, byName.get('a.zip').uid, 'f'.repeat(32)], to });
  assert.strictEqual(r.status, 200);
  const out = JSON.parse(r.body);
  assert.deepStrictEqual([out.to, out.written, out.failed], [path.resolve(to), 2, 1]);
  assert.strictEqual(out.results[0].path, path.join(path.resolve(to), 'photo.png'));
  assert.ok(fs.readFileSync(out.results[0].path).equals(PNG));
  assert.match(out.results[2].error, /no longer kept/);
  const call = s.api.calls.find((c) => c[0] === 'restoreCopy');
  assert.deepStrictEqual(call[3], { tag: 'search places' }, 'restored with the places its search used');
  // A second restore of the same copy: the library refuses to overwrite, and that is reported.
  const twice = JSON.parse((await s.post('/api/restore', { uids: [uid], to })).body);
  assert.deepStrictEqual([twice.written, twice.results[0].code], [0, 'EEXIST']);
  events.close();
});

test('tells how many of the files were on the volume written to, and asks the library once per folder', async () => {
  const api = stubApi();
  const local = fixture('gui-same-volume');
  api.named.png.path = path.join(local, 'photos', 'photo.png'); // gone, in a folder of this volume
  // Read from a whole disk, whose drive letter cannot be told: counted apart, for the page to warn of.
  api.named.heic.extent = { place: win ? '\\\\.\\PhysicalDrive1' : '/dev/sdb', runs: [[0, HEIC.length]] };
  const s = await session({ api });
  const { byName, events } = await searched(s);
  events.close();
  const uids = [byName.get('photo.png').uid, byName.get('clip.mp4').uid, byName.get('thumb.jpg').uid, byName.get('photo.heic').uid];
  const check = async () => JSON.parse((await s.post('/api/check-folder', { to: path.join(local, 'out'), uids })).body);
  const first = await check();
  assert.deepStrictEqual([first.ok, first.sameDrive, first.onDevice], [true, 1, 1],
    'the photo was here; the clip on V:, the thumbnail nowhere known, and the HEIC on a whole disk');
  const asked = () => api.calls.filter((c) => c[0] === 'checkDestination' && c[1] === path.join(local, 'out')).length;
  assert.strictEqual(asked(), 1);
  await check();
  assert.strictEqual(asked(), 1, 'the answer is kept');
  // A folder checked with nothing in view is checked with the places of the last search.
  const bare = JSON.parse((await s.post('/api/check-folder', { to: path.join(local, 'protected') })).body);
  assert.strictEqual(bare.ok, false);
  assert.deepStrictEqual(api.calls.filter((c) => c[0] === 'checkDestination').at(-1)[2], { tag: 'search places' });
});

test('plans a folder, then rebuilds it into a typed folder, leaving out what was unticked', async () => {
  const s = await session();
  const events = listen(s);
  await events.until((e) => e.event === 'hello');
  assert.strictEqual((await s.post('/api/plan', { folder: 'app' })).status, 400, 'a folder without its whole path');
  const plan = JSON.parse((await s.post('/api/plan', { folder: onV('app'), sources: ['trash'] })).body).job;
  const done = (await events.until((e) => e.event === 'done' && e.data.id === plan.id)).find((e) => e.event === 'done' && e.data.id === plan.id);
  assert.deepStrictEqual([done.data.folder, done.data.files, done.data.leftOut, done.data.notes], [onV('app'), 2, 1, ['1 copy(ies) carry no date']]);
  const batch = events.got.find((e) => e.event === 'plan').data;
  assert.deepStrictEqual(batch.items.map((i) => [i.rel, i.copy.kind, i.leftOut, i.copy.tier]),
    [['app/a.txt', 'trash', false, 0], ['app/b.txt', 'git commit', false, 0], ['app/c.jpg', 'thumbnail', true, 4]]);
  assert.strictEqual(s.api.calls.find((c) => c[0] === 'plan')[1], onV('app'));
  // The folder was on V:, whose root still answers: git looks from there.
  assert.deepStrictEqual(s.api.calls.find((c) => c[0] === 'plan')[2].locations.dirs.git, [V]);

  const root = fixture('gui-rebuild');
  const planCheck = JSON.parse((await s.post('/api/check-folder', { to: root, plan: plan.id })).body);
  assert.deepStrictEqual([planCheck.ok, planCheck.sameDrive], [true, 0]);
  const rebuild = (body) => s.post('/api/rebuild', { plan: plan.id, to: root, ...body });
  assert.strictEqual((await rebuild({ exclude: ['app/a.txt', 'app/b.txt'] })).status, 400, 'nothing left');
  assert.strictEqual((await rebuild({ plan: '999' })).status, 404);
  const inside = await rebuild({ to: path.join(root, 'protected') });
  assert.strictEqual(inside.status, 400);
  assert.match(JSON.parse(inside.body).error, /Refusing to write inside/);
  assert.ok(!fs.existsSync(path.join(root, 'protected')), 'nothing made for a refused folder');
  const r = await rebuild({ exclude: ['app/b.txt'], include: ['app/c.jpg'] });
  assert.strictEqual(r.status, 202);
  const job = JSON.parse(r.body).job;
  assert.strictEqual((await s.post('/api/cancel', { job: job.id })).status, 409, 'a rebuild is not stopped halfway');
  const end = (await events.until((e) => e.event === 'done' && e.data.id === job.id)).find((e) => e.event === 'done' && e.data.id === job.id).data;
  assert.deepStrictEqual([end.root, end.files, end.written, end.failed], [path.join(root, 'app'), 2, 2, []]);
  assert.deepStrictEqual(end.byKind, [{ kind: 'trash', label: 'trash', count: 1 }, { kind: 'thumbnail', label: 'thumbnail', count: 1 }]);
  const call = s.api.calls.find((c) => c[0] === 'rebuild');
  assert.deepStrictEqual([call[1], call[2], call[3], call[4]], [['app/a.txt', 'app/c.jpg'], onV('app'), path.resolve(root), { tag: 'plan places' }]);
  assert.strictEqual(fs.readFileSync(path.join(root, 'app', 'app', 'a.txt'), 'utf8'), 'alpha');
  const writing = events.got.filter((e) => e.event === 'progress' && e.data.job === job.id).map((e) => e.data);
  assert.deepStrictEqual(writing.at(-1), { job: job.id, type: 'writing', done: 2, total: 2, rel: 'app/c.jpg' });
  events.close();
});

test('reads what changes on its own before the window opens, and opens it as the machine allows', async () => {
  const order = [];
  const api = stubApi({
    async freeze(o) {
      order.push(['freeze', o.locations.discover, o.locations.dirs.trash]);
      return [{ id: 'thumbcache', label: 'Thumbnail cache' }, { id: 'edge', label: 'Edge cache', error: 'busy' }];
    },
    isElevated: async () => true,
  });
  const s = await session({
    api, open: true, elevated: undefined, locations: { discover: false, dirs: { trash: ['/t'] } },
    launch: (url, o) => {
      order.push(['launch', url, o.open, o.elevated]);
      return { how: 'explorer' };
    },
  });
  assert.deepStrictEqual(order, [['freeze', false, ['/t']], ['launch', s.url, true, true]]);
  const info = JSON.parse((await s.get('/api/info')).body);
  assert.deepStrictEqual([info.window, info.elevated, info.types, info.frozen.error, info.home, info.program], ['explorer', true, api.TYPES, null, s.home, false]);
  assert.deepStrictEqual(info.frozen.sources.map((x) => [x.id, x.error]), [['thumbcache', null], ['edge', 'busy']]);
  assert.ok(s.lines.some((l) => /Edge cache could not be read ahead: busy/.test(l)));
  const sources = JSON.parse((await s.get('/api/sources')).body);
  assert.deepStrictEqual(sources.sources.map((x) => [x.id, x.media]), [['trash', true], ['claude', false]]);
  const described = JSON.parse((await s.get('/api/sources/describe?ids=trash')).body);
  assert.deepStrictEqual(described.sources, [{ id: 'trash', label: 'Trash (Linux)', lines: ['1 place'] }]);
  assert.deepStrictEqual(api.calls.find((c) => c[0] === 'describe')[1].sources, ['trash']);
  // The drives, as the made-up machine has them; looked at once the server started.
  const { drives } = JSON.parse((await s.get('/api/drives')).body);
  if (win) {
    assert.deepStrictEqual(drives.map((d) => [d.letter, d.network, d.system, d.answering]),
      [['C', false, true, true], ['D', false, false, true], ['N', true, false, true], ['V', false, false, true]]);
  } else {
    assert.deepStrictEqual(drives.map((d) => [d.root, d.system, d.answering]), [['/', true, true]]);
  }

  // A freeze that fails costs nothing but what it would have read.
  const broken = await session({ api: stubApi({ freeze: async () => { throw new Error('locked'); } }) });
  assert.strictEqual(JSON.parse((await broken.get('/api/info')).body).frozen.error, 'locked');
});

test('stops once its window is gone, sooner after a goodbye, and never in the middle of a write', async () => {
  // No window at all.
  const lonely = await session({ idle: { first: 100 } });
  assert.ok(await settled(lonely.server.closed, 3000), 'stops when no window connects');
  assert.ok(lonely.lines.some((l) => /no window connected/.test(l)));

  // A window that goes away; a reload that comes back in time does not stop it.
  const s = await session({ idle: { grace: 1500, bye: 50, first: 60000 } });
  const one = listen(s);
  await one.until((e) => e.event === 'hello');
  one.close();
  await sleep(100);
  const two = listen(s);
  await two.until((e) => e.event === 'hello');
  await sleep(1600);
  assert.ok(!(await settled(s.server.closed, 10)), 'still running with a window');
  const bye = await request(s.origin, '/api/bye', {
    method: 'POST', headers: { Cookie: s.cookie, Origin: s.origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'text/plain;charset=UTF-8' },
  });
  assert.strictEqual(bye.status, 204);
  const closedAt = Date.now();
  two.close();
  assert.ok(await settled(s.server.closed, 3000), 'stops after the window is gone');
  assert.ok(Date.now() - closedAt < 1000, `sooner after a goodbye: ${Date.now() - closedAt} ms`);

  // A restore in progress is finished first.
  let release;
  const gate = new Promise((r) => { release = r; });
  const api = stubApi();
  const restoreCopy = api.restoreCopy;
  api.restoreCopy = async (...a) => {
    await gate;
    return restoreCopy(...a);
  };
  const w = await session({ api, idle: { grace: 50, bye: 50, first: 60000 } });
  const { byName, events } = await searched(w);
  const root = fixture('gui-busy');
  const pending = w.post('/api/restore', { uids: [byName.get('photo.png').uid], to: root });
  await sleep(100);
  events.close();
  await sleep(300);
  assert.ok(!(await settled(w.server.closed, 10)), 'waits for the write');
  release();
  assert.strictEqual((await pending).status, 200);
  assert.ok(await settled(w.server.closed, 3000), 'and stops once it is done');
  assert.ok(fs.existsSync(path.join(root, 'photo.png')));

  // Quit answers, then stops.
  const q = await session();
  assert.strictEqual((await q.post('/api/quit', {})).status, 200);
  assert.ok(await settled(q.server.closed, 3000));
});

test('a reload held up by a long synchronous read does not stop it, nor does a goodbye while a search runs', async () => {
  // The wait after a goodbye ends well inside the stretch held below, and well after it begins.
  const s = await session({ idle: { grace: 60000, bye: 300, first: 60000 } });
  const beacon = () => request(s.origin, '/api/bye', {
    method: 'POST', headers: { Cookie: s.cookie, Origin: s.origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'text/plain;charset=UTF-8' },
  });
  const one = listen(s);
  await one.until((e) => e.event === 'hello');
  assert.strictEqual((await beacon()).status, 204);
  one.close();
  await sleep(40);
  // The reloaded page connects; before it can be let in, the process is held longer than the
  // wait after a goodbye, as a source reading synchronously holds it, and the wait ends late.
  const two = listen(s);
  await new Promise((resolve) => setImmediate(() => {
    const until = Date.now() + 500;
    while (Date.now() < until) { /* held */ }
    resolve();
  }));
  await two.until((e) => e.event === 'hello');
  assert.ok(!(await settled(s.server.closed, 300)), 'still running: the page came back');
  assert.ok(!s.lines.some((l) => /stopped/.test(l)), s.lines.join('\n'));

  // A goodbye while a search runs waits the longer wait: the page is reloading, or will say so.
  let release;
  const gate = new Promise((r) => { release = r; });
  const api = stubApi();
  const search = api.search;
  api.search = async (o) => {
    await gate;
    return search(o);
  };
  const w = await session({ api, idle: { grace: 60000, bye: 50, first: 60000 } });
  const events = listen(w);
  await events.until((e) => e.event === 'hello');
  assert.strictEqual((await w.post('/api/search', { pattern: 'x' })).status, 202);
  await request(w.origin, '/api/bye', {
    method: 'POST', headers: { Cookie: w.cookie, Origin: w.origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'text/plain;charset=UTF-8' },
  });
  events.close();
  assert.ok(!(await settled(w.server.closed, 400)), 'not stopped 50 ms after a goodbye while searching');
  release();
  two.close();
});

test('a reloaded page still loading when the wait after its goodbye ends does not stop it', async () => {
  const s = await session({ idle: { grace: 60000, bye: 1000, first: 60000 } });
  const one = listen(s);
  await one.until((e) => e.event === 'hello');
  const bye = await request(s.origin, '/api/bye', {
    method: 'POST', headers: { Cookie: s.cookie, Origin: s.origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'text/plain;charset=UTF-8' },
  });
  assert.strictEqual(bye.status, 204);
  one.close();
  // The page is fetched again soon after; its scripts, held up -- by a server that was busy, or a
  // slow machine -- connect only after the wait would have ended.
  await sleep(300);
  assert.strictEqual((await s.get('/')).status, 200);
  await sleep(1300);
  const two = listen(s);
  await two.until((e) => e.event === 'hello');
  assert.ok(!s.lines.some((l) => /stopped/.test(l)), s.lines.join('\n'));
  two.close();
});

test('the folders git looks in are told apart by case where the system tells them apart', async () => {
  const home = fixture('gui-case-home');
  fs.mkdirSync(path.join(home, 'Projects'), { recursive: true });
  const api = stubApi();
  const s = await session({ api, home, locations: { discover: true } });
  const events = listen(s);
  await events.until((e) => e.event === 'hello');
  const lower = path.join(home, 'projects');
  assert.strictEqual((await s.post('/api/search', { pattern: 'x', locations: { dirs: { git: [lower] } } })).status, 202);
  await events.until((e) => e.event === 'done');
  const git = api.calls.find((c) => c[0] === 'search')[1].locations.dirs.git;
  // On Windows Projects and projects are one folder; elsewhere two.
  assert.strictEqual(git.filter((p) => p.toLowerCase() === lower.toLowerCase()).length, win ? 1 : 2, JSON.stringify(git));
  events.close();
});

test('refuses to listen anywhere but on this computer', async () => {
  await assert.rejects(start({ api: stubApi(), host: '0.0.0.0', open: false, exit: false, log: () => {} }), (e) => e.usage && /this computer only/.test(e.message));
  await assert.rejects(start({ api: stubApi(), port: 70000, open: false, exit: false, log: () => {} }), (e) => e.usage);
});

test('reads a Range header as RFC 9110 does, and sends only what a browser shows as itself', () => {
  assert.deepStrictEqual(parseRange('bytes=0-0', 10), { start: 0, end: 0 });
  assert.deepStrictEqual(parseRange('bytes=5-100', 10), { start: 5, end: 9 });
  assert.deepStrictEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepStrictEqual(parseRange('bytes=-30', 10), { start: 0, end: 9 });
  assert.strictEqual(parseRange('bytes=10-', 10), 'unsatisfiable');
  assert.strictEqual(parseRange('bytes=-0', 10), 'unsatisfiable');
  assert.strictEqual(parseRange('bytes=0-', 0), 'unsatisfiable');
  assert.strictEqual(parseRange('bytes=5-2', 10), null);
  assert.strictEqual(parseRange('bytes=0-1,3-4', 10), null);
  assert.strictEqual(parseRange('items=0-1', 10), null);
  assert.strictEqual(parseRange('bytes=0-1', null), null);
  assert.strictEqual(parseRange('bytes=99999999999999999999-', 10), 'unsatisfiable');

  const text = Buffer.from('plain');
  assert.deepStrictEqual(previewOf({ mediaType: 'image', ext: '.JPG' }, text), { type: 'image/jpeg', preview: 'image', inline: true });
  assert.deepStrictEqual(previewOf({ mediaType: 'video', ext: '.mov' }, text), { type: 'video/mp4', preview: 'video', inline: true });
  // An extension that does not fit the kind, or a kind a browser cannot show, is not trusted.
  assert.strictEqual(previewOf({ mediaType: 'audio', ext: '.mp4' }, text).inline, false);
  assert.strictEqual(previewOf({ mediaType: 'image', ext: '.tif' }, Buffer.from([0x49, 0x49, 0x2a, 0])).inline, false);
  assert.strictEqual(previewOf({ mediaType: 'image', ext: '.svg' }, text).type, 'text/plain; charset=utf-8');
  assert.strictEqual(previewOf({ mediaType: 'text', ext: '.html' }, text).type, 'text/plain; charset=utf-8');
  assert.strictEqual(previewOf(null, Buffer.from([1, 0, 2])).type, 'application/octet-stream');
  assert.strictEqual(previewOf(null, Buffer.from([0xfe, 0xff, 0, 0x41])).type, 'text/plain; charset=utf-16be');
});

/** fs.promises as a Windows machine with a local disk, a dead share, a live share and an empty card reader would answer. */
function fakeWindows(ms = 40) {
  const never = () => new Promise(() => {});
  const err = (code) => Promise.reject(Object.assign(new Error(code), { code }));
  const looked = [];
  const fsp = {
    realpath(p) {
      looked.push(p);
      const letter = p[0];
      if (letter === 'C') return Promise.resolve('C:\\');
      if (letter === 'D' || letter === 'G') return never();
      if (letter === 'E') return Promise.resolve('\\\\nas\\photos\\');
      if (letter === 'F') return err('EBUSY');
      return err('ENOENT');
    },
    statfs: async () => ({ bavail: 10, bsize: 4096, blocks: 100 }),
    stat(p) {
      looked.push(p);
      if (/^Q:/i.test(p)) return never();
      if (/^C:\\(Users)?$/i.test(p) || p === 'C:\\') return Promise.resolve({ isDirectory: () => true, dev: 7n });
      if (/^C:\\file\.txt$/i.test(p)) return Promise.resolve({ isDirectory: () => false });
      return err('ENOENT');
    },
  };
  return { fsp, looked, prober: driveProber({ fsp, platform: 'win32', env: { SystemDrive: 'C:' }, ms }) };
}

test('lists drives without waiting on one that does not answer, and stops looking once two hang', async () => {
  const { prober, looked } = fakeWindows();
  const at = Date.now();
  const { drives, skipped } = await prober.drives();
  assert.ok(Date.now() - at < 1000, `took ${Date.now() - at} ms`);
  const by = Object.fromEntries(drives.map((d) => [d.letter, d]));
  assert.deepStrictEqual([by.C.answering, by.C.network, by.C.free, by.C.total, by.C.system], [true, false, 40960, 409600, true]);
  assert.deepStrictEqual([by.D.answering, by.E.network, by.F.answering, by.F.error], [false, true, false, 'EBUSY']);
  assert.strictEqual(by.G.answering, false);
  assert.ok(!('H' in by) && !('Z' in by), 'letters after two hung looks are not looked at, and not listed');
  assert.strictEqual(skipped, 'ZYXWVUTSRQPONMLKJIH'.length);
  assert.ok(!looked.some((p) => /^[H-Z]:/.test(p)));
  // A drive that hung is not asked again until it answers; the one the user typed still is.
  const again = await prober.look('D:\\', () => assert.fail('asked again'));
  assert.deepStrictEqual(again, { timedOut: true });
  const folder = await checkFolder('C:\\Users\\me\\out', prober);
  assert.deepStrictEqual(folder, { path: 'C:\\Users\\me\\out', root: 'C:\\', exists: false, free: 40960, at: 'C:\\Users', dev: '7' });
});

test('a destination is a whole path to a folder on a drive that answers', async () => {
  const { prober } = fakeWindows();
  const refused = async (to, pattern) => assert.rejects(checkFolder(to, prober), (e) => e.status === 400 && pattern.test(e.message), to);
  await refused('out', /whole path/);
  await refused('\\\\?\\C:\\out', /device path/);
  await refused('\\\\.\\PhysicalDrive0', /device path/);
  await refused('C:\\file.txt\\sub', /is a file, so no folder/);
  await refused('C:\\file.txt', /is a file, not a folder/);
  await refused('M:\\photos', /There is no drive M:\\/);
  await refused('Q:\\photos', /Q:\\ does not answer/);
  assert.strictEqual((await checkFolder('c:/Users', prober)).path, 'c:\\Users');
  assert.strictEqual((await checkFolder('C:\\', prober)).exists, true);
  // As Explorer's "Copy as path" gives it.
  assert.strictEqual((await checkFolder(' "C:\\Users" ', prober)).path, 'C:\\Users');
  await refused('""', /Type the folder/);
  // Run as administrator, the folders of Windows and of programs are refused: a program running
  // as the user could otherwise have this one put a file there.
  const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramData: 'C:\\ProgramData' };
  const admin = (to) => checkFolder(to, prober, { elevated: true, env });
  for (const to of ['C:\\Windows\\System32', 'c:/windows', 'C:\\Program Files\\App', 'C:\\Program Files (x86)', 'C:\\ProgramData\\x']) {
    await assert.rejects(admin(to), (e) => e.status === 400 && /runs as administrator/.test(e.message), to);
  }
  assert.strictEqual((await admin('C:\\Users\\me\\out')).path, 'C:\\Users\\me\\out');
  assert.strictEqual((await admin('C:\\Windowsill')).path, 'C:\\Windowsill', 'a folder whose name only starts the same');
  assert.strictEqual((await checkFolder('C:\\Windows\\x', prober)).path, 'C:\\Windows\\x', 'not refused when not elevated');
});

test('run as administrator, the folders of Windows are refused by any other name too', async () => {
  const w = path.win32;
  const key = (p) => w.resolve(p).toLowerCase();
  // Folders as they really are, each with its file ID on volume 7, and a junction the user made
  // to System32 in a folder of their own. \\localhost\C$ is this machine's C:, by another name
  // that realpath leaves as it is.
  const ids = new Map([['c:\\', 1n], ['c:\\windows', 2n], ['c:\\windows\\system32', 3n], ['c:\\program files', 4n],
    ['c:\\users', 5n], ['c:\\users\\me', 6n]]);
  const links = new Map([['c:\\users\\me\\link', 'C:\\Windows\\System32']]);
  const onC = (k) => k.replace(/^\\\\localhost\\c\$(\\|$)/, 'c:\\');
  const err = (code) => Promise.reject(Object.assign(new Error(code), { code }));
  const fsp = {
    realpath: async (p) => links.get(key(p)) || w.resolve(p),
    stat(p) {
      const k = onC(links.has(key(p)) ? key(links.get(key(p))) : key(p));
      return ids.has(k) ? Promise.resolve({ isDirectory: () => true, dev: 7n, ino: ids.get(k) }) : err('ENOENT');
    },
    statfs: async () => ({ bavail: 10, bsize: 4096, blocks: 100 }),
  };
  const prober = driveProber({ fsp, platform: 'win32', env: { SystemDrive: 'C:' }, ms: 2000 });
  const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
  const admin = (to) => checkFolder(to, prober, { elevated: true, env });
  for (const to of ['C:\\Users\\me\\link\\sub', '\\\\localhost\\C$\\Windows\\Temp\\x', '\\\\LOCALHOST\\c$\\windows']) {
    await assert.rejects(admin(to), (e) => e.status === 400 && /runs as administrator, so it does not write inside C:\\Windows/.test(e.message), to);
  }
  assert.strictEqual((await admin('\\\\localhost\\C$\\Users\\me\\out')).at, '\\\\localhost\\C$\\Users\\me');
  assert.strictEqual((await admin('C:\\Users\\me\\out')).exists, false);
  assert.strictEqual((await checkFolder('C:\\Users\\me\\link\\sub', prober)).at, 'C:\\Users\\me\\link', 'not refused when not elevated');
});

test('opens Edge InPrivate as an app window, or the default browser through Explorer, never elevated', async () => {
  const url = 'http://127.0.0.1:5000/?k=abc';
  const env = { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\U\\AppData\\Local', SystemRoot: 'C:\\WINDOWS' };
  const edgeAt = 'C:\\PF\\Microsoft\\Edge\\Application\\msedge.exe';
  const exists = (p) => p === edgeAt;
  // A child as spawn() gives one, which says soon after whether it started: 'spawn', or 'error'.
  const child = (error) => {
    const c = new EventEmitter();
    c.unref = () => {};
    setImmediate(() => (error ? c.emit('error', error) : c.emit('spawn')));
    return c;
  };
  const run = async (o) => {
    const lines = [];
    const spawned = [];
    const spawn = (command, args, options) => {
      spawned.push({ command, args, options });
      return child(null);
    };
    const plan = await openWindow(url, { platform: 'win32', env, exists, spawn, log: (s) => lines.push(s), ...o });
    return { plan, lines, spawned };
  };
  const edge = await run({});
  assert.deepStrictEqual(edge.spawned.map((x) => [x.command, x.args]), [[edgeAt, ['--inprivate', `--app=${url}`]]]);
  assert.deepStrictEqual([edge.spawned[0].options.detached, edge.spawned[0].options.stdio], [true, 'ignore']);
  assert.match(edge.lines.join('\n'), /InPrivate/);
  const elevated = await run({ elevated: true });
  assert.deepStrictEqual(elevated.spawned.map((x) => [x.command, x.args]), [['C:\\WINDOWS\\explorer.exe', [url]]]);
  assert.match(elevated.lines.join('\n'), /administrator/);
  assert.strictEqual((await run({ exists: () => false })).plan.how, 'explorer');
  assert.strictEqual((await run({ open: 'browser' })).plan.how, 'explorer');
  const none = await run({ open: false });
  assert.deepStrictEqual([none.plan.how, none.spawned.length], ['none', 0]);
  assert.match(none.lines.join('\n'), /Open that address/);
  assert.deepStrictEqual(windowPlan(url, { platform: 'darwin' }), { how: 'open', command: 'open', args: [url] });
  assert.deepStrictEqual(windowPlan(url, { platform: 'linux' }), { how: 'xdg-open', command: 'xdg-open', args: [url] });
  // A browser that cannot be started is reported, not thrown.
  const failed = await run({ spawn: () => { throw new Error('EACCES'); } });
  assert.deepStrictEqual([failed.plan.how, failed.plan.error], ['none', 'EACCES']);
  assert.match(failed.lines.join('\n'), /Could not open a window \(EACCES\)/);
  // One the system could not start, as xdg-open where there is none, is said so, and only so:
  // not first as opened.
  const missing = await run({ platform: 'linux', spawn: () => child(Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' })) });
  assert.deepStrictEqual([missing.plan.how, missing.plan.error], ['none', 'spawn xdg-open ENOENT']);
  assert.match(missing.lines.join('\n'), /Could not open a window/);
  assert.doesNotMatch(missing.lines.join('\n'), /It opened/);
});

// The library itself: a trash folder with a picture, a web page and a drawing in it.
test('works with the library itself', async () => {
  const root = fixture('gui-real');
  const trash = path.join(root, 'Trash');
  const files = {
    'photo.png': PNG,
    'page.html': '<!doctype html><script>alert(1)</script>',
    'draw.svg': '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
  };
  for (const [name, data] of Object.entries(files)) {
    write(path.join(trash, 'files', name), data);
    write(path.join(trash, 'info', name + '.trashinfo'), `[Trash Info]\nPath=/home/u/${name}\nDeletionDate=2026-09-01T10:00:00\n`);
  }
  const lines = [];
  const server = await start({
    open: false, exit: false, elevated: false, program: false, home: fixture('gui-real-home'), fsp: fakeDrives(),
    log: (s) => lines.push(s), locations: only({ dirs: { trash: [trash] } }),
  });
  servers.push(server);
  const u = new URL(server.url);
  const first = await request(u.origin, u.pathname + u.search);
  const s = {
    origin: u.origin,
    cookie: first.headers['set-cookie'][0].split(';')[0],
  };
  s.get = (p, o = {}) => request(u.origin, p, { ...o, headers: { Cookie: s.cookie, ...(o.headers || {}) } });
  s.post = (p, body) => request(u.origin, p, {
    method: 'POST', body, headers: { Cookie: s.cookie, Origin: u.origin, 'X-Solarljos': '1', 'Content-Type': 'application/json' },
  });
  const all = await searched(s, { pattern: '*', sources: ['trash'] });
  for (const name of ['page.html', 'draw.svg']) {
    const r = await s.get(`/api/copy/${all.byName.get(name).uid}`);
    assert.deepStrictEqual([r.headers['content-type'], r.headers['content-disposition']], ['text/plain; charset=utf-8', 'inline'], name);
    assert.strictEqual(r.body.toString(), files[name]);
  }
  all.events.close();
  const { items, events } = await searched(s, { pattern: 'photo.png', sources: ['trash'] });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].mediaType, 'image');
  const bytes = await s.get(`/api/copy/${items[0].uid}`);
  assert.deepStrictEqual([bytes.status, bytes.headers['content-type']], [200, 'image/png']);
  assert.ok(bytes.body.equals(PNG));
  const part = await s.get(`/api/copy/${items[0].uid}`, { headers: { Range: 'bytes=8-23' } });
  assert.deepStrictEqual([part.status, part.headers['content-range']], [206, `bytes 8-23/${PNG.length}`]);
  assert.ok(part.body.equals(PNG.subarray(8, 24)));
  const refused = JSON.parse((await s.post('/api/check-folder', { to: path.join(trash, 'files', 'x'), uids: [items[0].uid] })).body);
  assert.deepStrictEqual([refused.ok, /Refusing to write inside/.test(refused.error)], [false, true], 'the library refuses the trash it reads');
  const out = JSON.parse((await s.post('/api/restore', { uids: [items[0].uid], to: path.join(root, 'out') })).body);
  assert.strictEqual(out.written, 1, JSON.stringify(out));
  assert.ok(fs.readFileSync(out.results[0].path).equals(PNG));
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'out')), ['photo.png'], 'no temporary file left beside it');
  events.close();
});
