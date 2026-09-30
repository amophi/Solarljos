'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { workDir, cleanup, write, infoV2, snapshot } = require('./helpers');
const { start } = require('../src/gui/server');

// The graphical front end from end to end: the server started as `solarljos gui --no-open`
// starts it, on the library itself (no stand-in), driven over HTTP the way the page drives it.
// Its places are a Linux trash and a Recycle Bin built under test/.work, with discovery off, so
// nothing on the machine is searched; the home folder is a fixture too, so no Pictures or Videos
// folder of the user's is walked. It is told it does not run as administrator, and the drives it
// looks at are only the one test/.work is on (oneDrive), so no disk device and no other drive of
// the machine is opened. What it writes goes into test/.work, and the fixtures are shown to be
// untouched. No window is opened and the process is never ended (open: false, exit: false).
//
// The tests share one server and run in order: who may ask, what it says of itself, a search
// with its events, a copy's bytes in ranges, a restore, a folder's plan and its rebuild, and
// quitting.

const T = Date.UTC(2026, 3, 5, 9, 30);
const dirs = [];
let root;
let places; // the fixtures the sources read, which must not change
let untouched;
let server;
let lines;
let u;
let cookie;
after(async () => {
  if (server) await server.close();
  dirs.forEach(cleanup);
});

/** A JPEG whose Exif block holds a small picture of it, as a camera writes one. */
function cameraJpeg(thumb, rest) {
  const tiff = Buffer.alloc(56 + thumb.length);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  // IFD0: no tags of note, then where IFD1 is; IFD1: where the small picture is, and its length.
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(1, 18);
  tiff.writeUInt32LE(26, 22);
  tiff.writeUInt16LE(2, 26);
  tiff.writeUInt16LE(0x0201, 28); tiff.writeUInt16LE(4, 30); tiff.writeUInt32LE(1, 32); tiff.writeUInt32LE(56, 36);
  tiff.writeUInt16LE(0x0202, 40); tiff.writeUInt16LE(4, 42); tiff.writeUInt32LE(1, 44); tiff.writeUInt32LE(thumb.length, 48);
  thumb.copy(tiff, 56);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(app1.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1, Buffer.from([0xff, 0xda, 0, 2]), rest, Buffer.from([0xff, 0xd9])]);
}

const THUMB = Buffer.concat([Buffer.from([0xff, 0xd8]), crypto.randomBytes(400), Buffer.from([0xff, 0xd9])]);
const PHOTO = cameraJpeg(THUMB, crypto.randomBytes(200000));
// An MP4 of 3 MiB and a little: an ftyp box, then bytes a player would read from the middle.
const CLIP = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(12),
  crypto.randomBytes(3 * 1024 * 1024 + 123)]);
const README = Buffer.from('what the album holds\n');
const PAGE = Buffer.from('<!doctype html><script>alert(1)</script>');
const NOTES = Buffer.from('notes kept in the trash\n');

/** One request; the body comes back whole, as a Buffer. */
function request(pathName, { method = 'GET', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    // A header given as undefined is left out: that is how a test says a request lacks it.
    const sent = Object.fromEntries(Object.entries({ ...(host ? { Host: host } : {}), ...headers }).filter(([, v]) => v !== undefined));
    const r = http.request({ host: u.hostname, port: u.port, path: pathName, method, headers: sent }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

const get = (p, headers = {}) => request(p, { headers: { Cookie: cookie, ...headers } });
const post = (p, body, headers = {}) => request(p, {
  method: 'POST', body,
  headers: { Cookie: cookie, Origin: u.origin, 'Sec-Fetch-Site': 'same-origin', 'X-Solarljos': '1', 'Content-Type': 'application/json', ...headers },
});
const json = (r) => JSON.parse(r.body.toString());

/** The event stream, read as a window reads it. */
function listen() {
  const got = [];
  const waiting = [];
  const req = http.get({ host: u.hostname, port: u.port, path: '/api/events', headers: { Cookie: cookie } }, (res) => {
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
          w.resolve(got.find(w.pred));
        }
      }
    });
    res.on('error', () => {});
  });
  req.on('error', () => {});
  return {
    got,
    until(pred, ms = 60000) {
      const found = got.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        waiting.push({ pred, resolve });
        setTimeout(() => reject(new Error('no such event came: ' + JSON.stringify(got.map((g) => g.event)))), ms).unref();
      });
    },
    close: () => req.destroy(),
  };
}

/** A search or a plan, started and followed to its end: its job, its items, and the events it sent. */
async function run(url, body) {
  const events = listen();
  await events.until((e) => e.event === 'hello');
  const r = await post(url, body);
  assert.strictEqual(r.status, 202, r.body.toString());
  const job = json(r).job;
  const end = await events.until((e) => ['done', 'failed', 'cancelled'].includes(e.event) && e.data.id === job.id);
  events.close();
  assert.strictEqual(end.event, 'done', JSON.stringify(end.data));
  const items = json(await get(`/api/job/${job.id}/items?limit=2000`)).items;
  return { job, end: end.data, items, events: events.got.filter((e) => e.data.job === job.id || e.data.id === job.id) };
}

const nameOf = (c) => String(c.path || c.name).split(/[\\/]/).pop();

/**
 * fs.promises with one drive, the one `at` is on, and nothing mounted below /media, /run/media or
 * /mnt: the server's look at the drives never reaches the machine's own. Everything else is real.
 */
function oneDrive(at) {
  const real = fs.promises;
  const mine = path.parse(path.resolve(at)).root;
  const isRoot = (p) => (process.platform === 'win32' ? /^[A-Za-z]:\\$/.test(p) : p === '/');
  const none = () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  return {
    ...real,
    realpath: (p, ...a) => (!isRoot(p) ? real.realpath(p, ...a) : p.toLowerCase() === mine.toLowerCase() ? Promise.resolve(p) : none()),
    statfs: (p, ...a) => (isRoot(p) && p.toLowerCase() !== mine.toLowerCase() ? none() : real.statfs(p, ...a)),
    readdir: (p, ...a) => (['/media', '/run/media', '/mnt'].some((m) => p === m || p.startsWith(m + '/')) ? Promise.resolve([]) : real.readdir(p, ...a)),
  };
}

before(async () => {
  root = workDir('gui-e2e');
  dirs.push(root);
  const trash = path.join(root, 'Trash');
  const trashed = { 'clip.mp4': CLIP, 'page.html': PAGE, 'notes.txt': NOTES };
  for (const [name, data] of Object.entries(trashed)) {
    write(path.join(trash, 'files', name), data);
    write(path.join(trash, 'info', name + '.trashinfo'), `[Trash Info]\nPath=/home/u/${name}\nDeletionDate=2026-04-05T09:30:00\n`);
  }
  // The album was deleted from a folder under the fixture, which is gone now too.
  const bin = path.join(root, '$Recycle.Bin', 'S-1-5-21-1-2-3-1001');
  const album = path.join(root, 'gone', 'album');
  write(path.join(bin, '$IA1B2C3.jpg'), infoV2(path.join(album, 'photo.jpg'), PHOTO.length, T));
  write(path.join(bin, '$RA1B2C3.jpg'), PHOTO);
  write(path.join(bin, '$ID4E5F6.txt'), infoV2(path.join(album, 'readme.txt'), README.length, T + 1000));
  write(path.join(bin, '$RD4E5F6.txt'), README);
  places = { trash, bin: path.join(root, '$Recycle.Bin') };
  untouched = { trash: snapshot(trash), bin: snapshot(places.bin) };
  const home = path.join(root, 'home');
  fs.mkdirSync(home);

  lines = [];
  server = await start({
    port: 0, open: false, host: '127.0.0.1', exit: false, program: false, home, log: (s) => lines.push(s),
    locations: { discover: false, dirs: { trash: [trash], recycle: [places.bin] } },
    // Not asked of the machine: whether this runs as administrator (which opens its first disk),
    // and which drives it has.
    elevated: false, fsp: oneDrive(root),
  });
  u = new URL(server.url);
});

test('says where it runs and how it stops, having read ahead what changes on its own', () => {
  assert.match(lines[0], /^Reading what changes on its own/);
  const at = lines.findIndex((l) => l.startsWith('Solarljos is running at '));
  assert.ok(at > 0, lines.join('\n'));
  assert.strictEqual(lines[at], `Solarljos is running at ${server.url}`);
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/\?k=[A-Za-z0-9_-]{43}$/);
  assert.match(lines[at + 1], /Open that address in a browser/, 'no window was opened, and it says what to do');
});

test('only this run\'s page may ask: Host, Origin, Sec-Fetch-Site, the cookie and the header', async () => {
  // Without the cookie, and with a token from another run: refused.
  assert.strictEqual((await request('/')).status, 403);
  assert.strictEqual((await request('/?k=' + 'A'.repeat(43))).status, 403);
  // The token is traded once for a cookie no script and no other site gets, and leaves the address bar.
  const first = await request(u.pathname + u.search);
  assert.deepStrictEqual([first.status, first.headers.location], [302, '/']);
  const set = first.headers['set-cookie'][0];
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  cookie = set.split(';')[0];
  assert.strictEqual(cookie.split('=')[0], `solarljos-${u.port}`);

  const page = await get('/');
  assert.deepStrictEqual([page.status, page.headers['content-type']], [200, 'text/html; charset=utf-8']);
  const ui = path.join(__dirname, '..', 'src', 'gui', 'ui');
  assert.ok(page.body.equals(fs.readFileSync(path.join(ui, 'index.html'))), 'the page as it is on disk');
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.strictEqual(page.headers['cache-control'], 'no-store');
  for (const m of page.body.toString().matchAll(/(?:src|href)="([^"#][^"]*)"/g)) {
    if (m[1].startsWith('data:')) continue;
    const r = await get('/' + m[1]);
    assert.strictEqual(r.status, 200, m[1]);
    assert.ok(r.body.equals(fs.readFileSync(path.join(ui, m[1]))), m[1]);
  }

  // Another name for this computer (DNS rebinding arrives with its own name in Host), another
  // site, another origin: refused before anything else is read.
  for (const host of [`localhost:${u.port}`, 'attacker.example', `127.0.0.1:${Number(u.port) + 1}`]) {
    assert.strictEqual((await request('/api/info', { host, headers: { Cookie: cookie } })).status, 403, host);
  }
  assert.strictEqual((await get('/api/info', { Origin: 'http://attacker.example' })).status, 403);
  assert.strictEqual((await get('/api/info', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.strictEqual((await get('/api/info', { 'Sec-Fetch-Site': 'same-site' })).status, 403, 'another port of 127.0.0.1');
  assert.strictEqual((await get('/api/info', { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.strictEqual((await get('/api/info')).status, 200);

  // A POST: from this origin, with the page's header, as JSON, with the cookie -- or refused.
  const body = { pattern: 'x' };
  assert.strictEqual((await post('/api/search', body, { Origin: undefined })).status, 403, 'no Origin');
  assert.strictEqual((await post('/api/search', body, { Origin: 'http://attacker.example' })).status, 403);
  assert.strictEqual((await post('/api/search', body, { 'X-Solarljos': undefined })).status, 403, 'no X-Solarljos');
  assert.strictEqual((await post('/api/search', body, { Cookie: undefined })).status, 403, 'no cookie');
  assert.strictEqual((await post('/api/search', 'pattern=x', { 'Content-Type': 'text/plain' })).status, 415, 'a form');
  const options = await request('/api/search', { method: 'OPTIONS', headers: { Cookie: cookie, Origin: u.origin } });
  assert.strictEqual(options.status, 405);
  assert.ok(!Object.keys(options.headers).some((h) => h.startsWith('access-control-')), 'no CORS header, ever');
  // Nothing of those started a search.
  assert.deepStrictEqual(json(await get('/api/info')).writing, 0);
});

test('says what it is and what it reads, from the library', async () => {
  const info = json(await get('/api/info'));
  assert.strictEqual(info.version, require('../package.json').version);
  assert.strictEqual(typeof info.elevated, 'boolean');
  assert.strictEqual(info.window, 'none');
  assert.deepStrictEqual(info.types, require('../src/index').TYPES);
  assert.ok(info.frozen && Array.isArray(info.frozen.sources) && info.frozen.error === null, JSON.stringify(info.frozen));
  // The languages the page has a table for in src/gui/ui/lang, English first; none asked for yet.
  const { LOCALES } = require('../src/i18n');
  const tables = LOCALES.filter((l) => l.code === 'en'
    || fs.existsSync(path.join(__dirname, '..', 'src', 'gui', 'ui', 'lang', `${l.code}.json`)));
  assert.deepStrictEqual(info.languages, tables.map((l) => ({ code: l.code, name: l.name })));
  assert.deepStrictEqual([info.lang, typeof info.locale], [null, 'string']);
  const { sources } = json(await get('/api/sources'));
  const lib = require('../src/index').sources;
  assert.deepStrictEqual(sources.map((s) => [s.id, s.media, s.needsAdmin]), lib.map((s) => [s.id, s.media, s.needsAdmin]));
  const described = json(await get('/api/sources/describe?ids=trash,recycle')).sources;
  assert.deepStrictEqual(described.map((s) => s.id), ['recycle', 'trash']);
  assert.ok(described.every((s) => Array.isArray(s.lines) && s.lines.length));
});

let found; // the photo search's items, by name
test('a search for photos and videos streams its progress, then its results; text-only sources are left out', async () => {
  const textOnly = require('../src/index').sources.find((s) => !s.media);
  const { job, end, items, events } = await run('/api/search', {
    types: ['image', 'video'], sources: ['trash', 'recycle', textOnly.id], view: { mode: 'media', types: ['image', 'video'] },
  });
  const types = new Set(events.filter((e) => e.event === 'progress').map((e) => e.data.type));
  for (const type of ['source-start', 'source-done', 'filtering']) assert.ok(types.has(type), type);
  assert.ok(events.some((e) => e.event === 'results' && e.data.total === 2));
  assert.deepStrictEqual(end.sources.map((s) => [s.id, s.state]).sort(),
    [[textOnly.id, 'skipped'], ['recycle', 'done'], ['trash', 'done']].sort());
  assert.ok(end.perSource.find((s) => s.id === textOnly.id).skipped);
  assert.deepStrictEqual(end.request.view, { mode: 'media', types: ['image', 'video'] });
  found = new Map(items.map((c) => [nameOf(c), c]));
  assert.deepStrictEqual([...found.keys()].sort(), ['clip.mp4', 'photo.jpg']);
  const photo = found.get('photo.jpg');
  assert.deepStrictEqual([photo.kind, photo.source, photo.mediaType, photo.tier, photo.time, photo.state, photo.size],
    ['recycle bin', 'recycle', 'image', 0, T, 'deleted', PHOTO.length]);
  assert.strictEqual(found.get('clip.mp4').mediaType, 'video');
  for (const c of items) for (const k of ['buffer', 'file', 'key', 'hash', 'text']) assert.ok(!(k in c), k);
  assert.strictEqual(json(await get(`/api/job/${job.id}`)).state, 'done');
});

test('a copy is sent in ranges, as the type its bytes say when a browser shows it, and never as a page', async () => {
  const clip = found.get('clip.mp4').uid;
  const about = json(await get(`/api/copy/${clip}/about`));
  assert.deepStrictEqual([about.size, about.preview, about.mediaType, about.inline], [CLIP.length, 'video', 'video', true]);
  const head = await request(`/api/copy/${clip}`, { method: 'HEAD', headers: { Cookie: cookie } });
  assert.deepStrictEqual([head.status, head.headers['content-length'], head.headers['accept-ranges'], head.headers['content-type']],
    [200, String(CLIP.length), 'bytes', 'video/mp4']);
  assert.strictEqual(head.body.length, 0);
  // From the middle, as a player seeks; the end; past the end.
  const mid = await get(`/api/copy/${clip}`, { Range: 'bytes=2097152-2101247' });
  assert.deepStrictEqual([mid.status, mid.headers['content-range']], [206, `bytes 2097152-2101247/${CLIP.length}`]);
  assert.ok(mid.body.equals(CLIP.subarray(2097152, 2101248)));
  const tail = await get(`/api/copy/${clip}`, { Range: 'bytes=-100' });
  assert.ok(tail.body.equals(CLIP.subarray(CLIP.length - 100)));
  const past = await get(`/api/copy/${clip}`, { Range: `bytes=${CLIP.length}-` });
  assert.deepStrictEqual([past.status, past.headers['content-range']], [416, `bytes */${CLIP.length}`]);
  const whole = await get(`/api/copy/${clip}`);
  assert.ok(whole.body.equals(CLIP));
  assert.strictEqual(whole.headers['content-security-policy'], "default-src 'none'; sandbox");

  // The photo, and the small picture inside it for the grid.
  const photo = found.get('photo.jpg').uid;
  const jpeg = await get(`/api/copy/${photo}`);
  assert.deepStrictEqual([jpeg.headers['content-type'], jpeg.body.equals(PHOTO)], ['image/jpeg', true]);
  const thumb = await get(`/api/copy/${photo}/thumb`);
  assert.deepStrictEqual([thumb.status, thumb.headers['content-type'], thumb.headers['x-solarljos-orientation']], [200, 'image/jpeg', '1']);
  assert.ok(thumb.body.equals(THUMB));

  // A web page found by name comes as its text.
  const byName = await run('/api/search', { pattern: 'page.html', sources: ['trash'], view: { mode: 'name', name: 'page.html' } });
  const html = await get(`/api/copy/${byName.items[0].uid}`);
  assert.deepStrictEqual([html.headers['content-type'], html.headers['content-disposition'], html.body.equals(PAGE)],
    ['text/plain; charset=utf-8', 'inline', true]);
  // The photo search is still kept beside the one by name, and its copies still answer.
  assert.strictEqual((await get(`/api/copy/${photo}/about`)).status, 200);
  assert.strictEqual((await get(`/api/copy/${'0'.repeat(32)}`)).status, 404);
});

test('restores into a typed folder, never into a place it reads from, and leaves nothing else behind', async () => {
  const uids = [found.get('photo.jpg').uid, found.get('clip.mp4').uid];
  const inside = json(await post('/api/check-folder', { to: path.join(places.trash, 'files', 'back'), uids }));
  assert.strictEqual(inside.ok, false);
  assert.match(inside.error, /Refusing to write inside/);
  const refused = await post('/api/restore', { uids, to: path.join(places.bin, 'back') });
  assert.strictEqual(refused.status, 400);
  assert.ok(!fs.existsSync(path.join(places.bin, 'back')), 'nothing was made there');
  const relative = json(await post('/api/check-folder', { to: 'back', uids }));
  assert.strictEqual(relative.ok, false);

  const out = path.join(root, 'restored');
  const check = json(await post('/api/check-folder', { to: out, uids }));
  assert.deepStrictEqual([check.ok, check.path, check.exists], [true, out, false]);
  const events = listen();
  await events.until((e) => e.event === 'hello');
  const done = json(await post('/api/restore', { uids, to: `"${out}"` }));
  assert.deepStrictEqual([done.to, done.written, done.failed], [out, 2, 0], JSON.stringify(done));
  await events.until((e) => e.event === 'restore-progress' && e.data.done === 2);
  events.close();
  assert.deepStrictEqual(fs.readdirSync(out).sort(), ['clip.mp4', 'photo.jpg'], 'no temporary file left beside them');
  assert.ok(fs.readFileSync(path.join(out, 'photo.jpg')).equals(PHOTO));
  assert.ok(fs.readFileSync(path.join(out, 'clip.mp4')).equals(CLIP));
  // Again: nothing is written over; the second copy gets a name of its own.
  const again = json(await post('/api/restore', { uids: [uids[0]], to: out }));
  assert.strictEqual(again.written, 1);
  assert.ok(fs.readFileSync(path.join(out, 'photo.jpg')).equals(PHOTO));
  assert.strictEqual(fs.readdirSync(out).length, 3);
  assert.deepStrictEqual({ trash: snapshot(places.trash), bin: snapshot(places.bin) }, untouched, 'the places read from are untouched');
});

test('plans a folder that is gone, then rebuilds it into a new folder', async () => {
  const album = path.join(root, 'gone', 'album');
  const plan = await run('/api/plan', { folder: album, sources: ['recycle', 'trash'] });
  assert.deepStrictEqual([plan.end.folder, plan.end.files, plan.end.leftOut], [album, 2, 0]);
  assert.ok(plan.events.some((e) => e.event === 'plan' && e.data.total === 2));
  assert.deepStrictEqual(plan.items.map((i) => i.rel).sort(), ['photo.jpg', 'readme.txt']);
  const to = path.join(root, 'rebuilt');
  const check = json(await post('/api/check-folder', { to, plan: plan.job.id }));
  assert.strictEqual(check.ok, true);
  const events = listen();
  await events.until((e) => e.event === 'hello');
  const r = await post('/api/rebuild', { plan: plan.job.id, to, exclude: [], include: [] });
  assert.strictEqual(r.status, 202, r.body.toString());
  const job = json(r).job;
  const end = await events.until((e) => (e.event === 'done' || e.event === 'failed') && e.data.id === job.id);
  assert.ok(events.got.some((e) => e.event === 'progress' && e.data.type === 'writing' && e.data.job === job.id));
  events.close();
  assert.strictEqual(end.event, 'done', JSON.stringify(end.data));
  assert.deepStrictEqual([end.data.written, end.data.failed], [2, []]);
  assert.ok(end.data.root.startsWith(to), end.data.root);
  assert.ok(fs.readFileSync(path.join(end.data.root, 'photo.jpg')).equals(PHOTO));
  assert.ok(fs.readFileSync(path.join(end.data.root, 'readme.txt')).equals(README));
  assert.deepStrictEqual(end.data.byKind.map((k) => [k.kind, k.count]), [['recycle bin', 2]]);
  assert.deepStrictEqual({ trash: snapshot(places.trash), bin: snapshot(places.bin) }, untouched, 'the places read from are untouched');
});

test('quits when asked, and nothing answers after', async () => {
  const r = json(await post('/api/quit', {}));
  assert.strictEqual(r.writing, 0);
  await server.closed;
  assert.ok(lines.some((l) => /^Solarljos stopped: asked to quit\.$/.test(l)), lines.join('\n'));
  await assert.rejects(get('/api/info'), (e) => e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET');
  // What it wrote: the two folders it was told to write in, and nothing else.
  const made = fs.readdirSync(root).sort();
  assert.deepStrictEqual(made, ['$Recycle.Bin', 'Trash', 'home', 'restored', 'rebuilt'].sort());
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'home')), []);
});
