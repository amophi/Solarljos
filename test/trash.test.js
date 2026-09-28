'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { workDir, cleanup, write, only } = require('./helpers');
const trash = require('../src/sources/trash');
const { parseTrashInfo, parseDeletionDate, baseOf, originalPath, mountPoints, discoverOn } = trash._internal;
const { search, git } = require('../src/search');
const { load } = require('../src/content');
const { restore, planRebuild, rebuild } = require('../src/restore');
const { safeName, nameFor } = require('../src/restore')._internal;

const dirs = [];
after(() => dirs.forEach(cleanup));

const info = (p, date) => `[Trash Info]\nPath=${p}\n${date == null ? '' : `DeletionDate=${date}\n`}`;
const local = (...a) => new Date(...a).getTime();
// Windows reports every owner as 0, and has no sticky bit.
const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const POSIX_ONLY = process.platform === 'win32' && 'Windows has no sticky bit';
const NO_WIN = process.platform === 'win32' && 'needs a Unix socket or a file symlink, which Windows does not give without privileges';
// Only Linux file systems take a name that is not UTF-8; macOS refuses one.
const LINUX_ONLY = process.platform !== 'linux' && 'needs a file name that is not UTF-8';
// A link to a folder: a junction on Windows, which needs no privileges there.
const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir';
/** A mount point as /proc/self/mounts writes it: a backslash is \134 and a space \040. */
const esc = (p) => p.replace(/\\/g, '\\134').replace(/ /g, '\\040');

test('reads a .trashinfo as GLib and KIO write it: percent-encoded UTF-8, local time', () => {
  const r = parseTrashInfo(Buffer.from(info('/home/u/%ED%95%9C%EA%B8%80%20%ED%8C%8C%EC%9D%BC.txt', '2026-09-20T12:30:05')));
  assert.deepStrictEqual(r, {
    path: '/home/u/한글 파일.txt', lossy: false, deleted: local(2026, 8, 20, 12, 30, 5), wall: Date.UTC(2026, 8, 20, 12, 30, 5),
  });
  // A date with a zone needs no working out.
  assert.strictEqual(parseTrashInfo(Buffer.from(info('/x', '2020-01-02T03:04:05Z'))).wall, null);
});

test('old npm trash: a bare % and = stay as they are, and the date is UTC', () => {
  const r = parseTrashInfo(Buffer.from(info('/home/u/100%%20a=b.txt', '2020-01-02T03:04:05.678Z')));
  assert.strictEqual(r.path, '/home/u/100% a=b.txt');
  assert.strictEqual(r.deleted, Date.UTC(2020, 0, 2, 3, 4, 5, 678));
});

test('unescaped UTF-8 reads as it is, a name ending in "à" included; bytes that are not UTF-8 are marked', () => {
  // "à" is C3 A0; read as latin1, A0 is a no-break space, which trim() would have cut.
  assert.strictEqual(parseTrashInfo(Buffer.from(info('/home/u/voilà', '2026-01-01T00:00:00'))).path, '/home/u/voilà');
  const r = parseTrashInfo(Buffer.from(info('/home/u/caf%E9.txt', '2026-01-01T00:00:00')));
  assert.strictEqual(r.lossy, true);
  assert.strictEqual(r.path, '/home/u/caf%E9.txt');
});

test('two paths that are not UTF-8 stay two: each byte that is not, and each "%", becomes %XX', () => {
  const p = (raw) => parseTrashInfo(Buffer.from(info(raw, '2026-01-01T00:00:00'))).path;
  assert.notStrictEqual(p('/home/u/proj/caf%E9.txt'), p('/home/u/proj/caf%E8.txt'));
  // The UTF-8 around a bad byte is kept as text; a literal "%" is escaped, so nothing collides.
  assert.strictEqual(p('/home/u/%ED%95%9C%E9'), '/home/u/한%E9');
  assert.strictEqual(p('/home/u/100%25%E9'), '/home/u/100%25%E9');
  assert.notStrictEqual(p('/home/u/%25E9%E8'), p('/home/u/%E9%E8'));
  // A lead byte with no continuation, an overlong form and a surrogate are not UTF-8 either.
  assert.strictEqual(p('/home/u/%C3A'), '/home/u/%C3A');
  assert.strictEqual(p('/home/u/%C0%AF'), '/home/u/%C0%AF');
  assert.strictEqual(p('/home/u/%ED%A0%80'), '/home/u/%ED%A0%80');
});

test('only [Trash Info] counts; the first key wins; comments, blank lines and CRLF are fine', () => {
  assert.strictEqual(parseTrashInfo(Buffer.from('[Desktop Entry]\nPath=/x\n')), null);
  assert.strictEqual(parseTrashInfo(Buffer.from('Path=/x\n')), null);
  assert.strictEqual(parseTrashInfo(Buffer.from('')), null);
  const r = parseTrashInfo(Buffer.from('# c\r\n\r\n[Trash Info]\r\nPath=/first\r\nPath=/second\r\n'
    + 'DeletionDate=2026-01-01T00:00:00\r\n[Other]\r\nDeletionDate=1999-01-01T00:00:00\r\n'));
  assert.deepStrictEqual(r, { path: '/first', lossy: false, deleted: local(2026, 0, 1), wall: Date.UTC(2026, 0, 1) });
  assert.deepStrictEqual(parseTrashInfo(Buffer.from('[Trash Info]\nDeletionDate=2026-01-01T00:00:00\n')).path, null);
});

test('dates: the spec\'s basic form, zones, and what is not a date', () => {
  assert.strictEqual(parseDeletionDate('20040831T22:32:08'), local(2004, 7, 31, 22, 32, 8));
  assert.strictEqual(parseDeletionDate('2026-09-20T12:30:05+09:00'), Date.UTC(2026, 8, 20, 3, 30, 5));
  assert.strictEqual(parseDeletionDate('2026-09-20T12:30:05-0500'), Date.UTC(2026, 8, 20, 17, 30, 5));
  assert.strictEqual(parseDeletionDate('9999-12-31T23:59:59'), null, 'GLib with no clock');
  assert.strictEqual(parseDeletionDate('2026-02-31T00:00:00'), null);
  assert.strictEqual(parseDeletionDate('2026-02-31T00:00:00Z'), null);
  assert.strictEqual(parseDeletionDate('2026-09-20 12:30:05'), null);
  assert.strictEqual(parseDeletionDate('0026-09-20T12:30:05'), null);
  assert.strictEqual(parseDeletionDate('yesterday'), null);
});

test('a date with no zone is read in this machine\'s zone, DST edges included', () => {
  // Setting TZ at run time works on Windows too, where setting it in the shell does not.
  // node --test runs each file in its own process, so this stays inside this file.
  const saved = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    assert.strictEqual(parseDeletionDate('2026-09-20T12:30:05'), Date.UTC(2026, 8, 20, 16, 30, 5));
    // 01:30 happens twice on 2026-11-01; the first one, in EDT, is taken.
    assert.strictEqual(parseDeletionDate('2026-11-01T01:30:00'), Date.UTC(2026, 10, 1, 5, 30));
    // 02:30 never happens on 2026-03-08; it reads as 03:30 EDT.
    assert.strictEqual(parseDeletionDate('2026-03-08T02:30:00'), Date.UTC(2026, 2, 8, 7, 30));
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('a relative path starts from the folder the trash is in; one that climbs is refused', () => {
  assert.strictEqual(baseOf('/home/u/.local/share/Trash'), '/home/u/.local/share');
  assert.strictEqual(baseOf('/media/u/STICK/.Trash-1000'), '/media/u/STICK');
  assert.strictEqual(baseOf('/mnt/d/.Trash/1000'), '/mnt/d');
  assert.strictEqual(baseOf('E:\\.Trash-1000'), 'E:\\');
  assert.strictEqual(originalPath('docs/a.txt', '/media/u/STICK'), '/media/u/STICK/docs/a.txt');
  assert.strictEqual(originalPath('docs/a.txt', 'E:\\'), 'E:\\docs\\a.txt');
  assert.strictEqual(originalPath('/home/u/a.txt', 'E:\\'), '/home/u/a.txt');
  assert.strictEqual(originalPath('../etc/passwd', '/mnt/d'), null);
  assert.strictEqual(originalPath('docs\\..\\..\\Windows\\x', 'E:\\'), null);
  assert.strictEqual(originalPath('/home/u/../../etc/x', '/'), null);
  assert.strictEqual(originalPath('/home/u/a\0b', '/'), null);
  assert.strictEqual(originalPath('', '/'), null);
});

test('a relative path separates with "/" only; on a Windows base a name Windows cannot hold gives none', () => {
  // A file named "x\y.txt" (GLib writes %5C) must not become docs\x\y.txt, another file's path.
  assert.strictEqual(originalPath('docs/x\\y.txt', 'E:\\'), null);
  assert.strictEqual(originalPath('docs/x/y.txt', 'E:\\'), 'E:\\docs\\x\\y.txt');
  // ":" would be written as a stream of another file.
  assert.strictEqual(originalPath('a:b', 'E:\\'), null);
  for (const bad of ['a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\x01b', 'trailing.', 'trailing ']) {
    assert.strictEqual(originalPath(`docs/${bad}`, 'E:\\'), null, JSON.stringify(bad));
  }
  assert.strictEqual(originalPath('docs/.hidden', 'E:\\'), 'E:\\docs\\.hidden');
  // On a Linux base every one of them is a name like any other.
  assert.strictEqual(originalPath('docs/x\\y.txt', '/mnt/d'), '/mnt/d/docs/x\\y.txt');
  assert.strictEqual(originalPath('a:b', '/mnt/d'), '/mnt/d/a:b');
});

test('mount points that can hold a trash: local disks only, not system, image or network ones', () => {
  const text = [
    '/dev/nvme0n1p2 / ext4 rw 0 0',
    'proc /proc proc rw 0 0',
    'tmpfs /run/user/1000 tmpfs rw 0 0',
    '/dev/sdb1 /run/media/u/My\\040Stick vfat rw 0 0',
    '/dev/loop3 /snap/core/1 squashfs ro 0 0',
    '/dev/loop7 /var/lib/snapd/snap/core/2 squashfs ro 0 0',
    'server:/home /mnt/nas nfs4 rw 0 0',
    'C:\\134 /mnt/c 9p rw,aname=drvfs;path=C:\\134;uid=1000,trans=fd,rfd=5,wfd=5 0 0',
    'D: /mnt/d drvfs rw 0 0',
    'tank/home /tank zfs rw 0 0',
    '/dev/sdd1 /media/u/Windows fuseblk rw 0 0',
    // The kernel leaves bytes above ASCII as they are; they are read as latin1.
    Buffer.from('/dev/sdc1 /media/u/한글 ext4 rw 0 0').toString('latin1'),
    // Network file systems a list of names would miss; davfs2 shows up as plain "fuse".
    'host:/pub /mnt/ftp fuse.curlftpfs rw 0 0',
    'bucket /mnt/gcs fuse.gcsfuse rw 0 0',
    'redis://x /mnt/jfs fuse.juicefs rw 0 0',
    'bucket /mnt/goofys fuse.goofys rw 0 0',
    'srv:/x /mnt/afp fuse.afpfs rw 0 0',
    'https://dav/ /mnt/dav fuse rw 0 0',
    'host:/x /mnt/coda coda rw 0 0',
    '//srv/share /mnt/smb2 smb2 rw 0 0',
    // A FUSE daemon may name its source /dev/... as well; a network block device is a server's.
    '/dev/fuse /mnt/fused fuse.anything rw 0 0',
    '/dev/nbd0 /mnt/nbd ext4 rw 0 0',
    'srv /mnt/9net 9p rw,trans=tcp,port=564 0 0',
  ].join('\n');
  assert.deepStrictEqual(mountPoints(text), [
    '/', '/run/media/u/My Stick', '/mnt/c', '/mnt/d', '/tank', '/media/u/Windows', '/media/u/한글',
  ]);
});

/** A home trash as GNOME or KDE leaves it, with what other writers and accidents leave in one. */
function makeHome() {
  const root = workDir('trash');
  dirs.push(root);
  const data = path.join(root, 'home', '.local', 'share');
  const tr = path.join(data, 'Trash');
  write(path.join(tr, 'info', 'plan.txt.trashinfo'), info('/home/u/Desktop/plan.txt', '2026-09-20T12:30:05'));
  write(path.join(tr, 'files', 'plan.txt'), 'plan!');
  write(path.join(tr, 'info', 'proj.trashinfo'), info('/home/u/proj', '2026-09-20T12:31:00'));
  write(path.join(tr, 'files', 'proj', 'src', 'plan.js'), 'console.log(1)\n');
  write(path.join(tr, 'files', 'proj', 'README.md'), '# proj\n');
  // The record is left, the contents are not.
  write(path.join(tr, 'info', 'plan.2.txt.trashinfo'), info('/home/u/old/plan.txt', '2026-09-19T08:00:00'));
  // send2trash: relative to XDG_DATA_HOME, even at home.
  write(path.join(tr, 'info', 'plan.3.txt.trashinfo'), info('notes/plan.txt', '2026-09-18T08:00:00'));
  write(path.join(tr, 'files', 'plan.3.txt'), 'relative');
  // npm trash names items by UUID; the Rust crate can leave out the date.
  write(path.join(tr, 'info', '0b1c2d3e.trashinfo'), info('/home/u/Documents/plan%20B.txt', null));
  write(path.join(tr, 'files', '0b1c2d3e'), 'plan B');
  fs.utimesSync(path.join(tr, 'info', '0b1c2d3e.trashinfo'), new Date(Date.UTC(2026, 8, 15)), new Date(Date.UTC(2026, 8, 15)));
  // A record that climbs out of its base, one that is not a record, and an item with none.
  write(path.join(tr, 'info', 'x.txt.trashinfo'), info('../../etc/plan.txt', '2026-09-17T08:00:00'));
  write(path.join(tr, 'files', 'x.txt'), 'climbs');
  write(path.join(tr, 'info', 'y.txt.trashinfo'), '[Desktop Entry]\nPath=/home/u/plan.txt\n');
  write(path.join(tr, 'files', 'y.txt'), 'not a record');
  write(path.join(tr, 'files', 'plan-orphan.txt'), 'orphan');
  return { root, home: path.join(root, 'home'), data, tr };
}

const find = (pattern, places, o = {}) => search({ pattern, sources: ['trash'], locations: only({ dirs: { trash: places } }), ...o });

test('finds deleted files under their original paths, with the time they were deleted', async () => {
  const { data, tr } = makeHome();
  const { results, perSource } = await find('plan', [tr]);
  const by = Object.fromEntries(results.map((r) => [r.path, r]));
  assert.deepStrictEqual(Object.keys(by).sort(), [
    '/home/u/Desktop/plan.txt', '/home/u/Documents/plan B.txt', '/home/u/old/plan.txt',
    '/home/u/proj/src/plan.js', path.join(data, 'notes', 'plan.txt'),
  ].sort());
  const plan = by['/home/u/Desktop/plan.txt'];
  assert.strictEqual(plan.kind, 'trash');
  assert.strictEqual(plan.time, local(2026, 8, 20, 12, 30, 5));
  assert.strictEqual((await load(plan, git)).toString(), 'plan!');
  const inside = by['/home/u/proj/src/plan.js'];
  assert.strictEqual(inside.kind, 'trash, inside a deleted folder');
  assert.strictEqual(inside.time, local(2026, 8, 20, 12, 31));
  assert.strictEqual((await load(inside, git)).toString(), 'console.log(1)\n');
  assert.strictEqual(by['/home/u/old/plan.txt'].state, 'no content');
  assert.strictEqual((await load(by[path.join(data, 'notes', 'plan.txt')], git)).toString(), 'relative');
  const undated = by['/home/u/Documents/plan B.txt'];
  assert.strictEqual(undated.time, Date.UTC(2026, 8, 15));
  assert.match(undated.note, /no deletion date/);
  const notes = perSource[0].notes.join('\n');
  assert.match(notes, /1 \.trashinfo file\(s\) could not be read/);
  assert.match(notes, /1 record\(s\) give no usable original path/);
  assert.match(notes, /1 item\(s\) have no \.trashinfo record/);
});

test('a trashed folder is a result of its own, restored as a folder', async () => {
  const { tr } = makeHome();
  const { results } = await find('proj', [tr]);
  const folder = results.find((r) => r.path === '/home/u/proj');
  assert.ok(folder && folder.isDir && folder.dir === path.join(tr, 'files', 'proj'));
});

test('what has no usable record is offered only to a search by content, with no name', async () => {
  const { tr } = makeHome();
  assert.ok(!(await find('*', [tr])).results.some((r) => r.path === null));
  for (const [text, note] of [['climbs', /no usable original path/], ['not a record', /could not be read/], ['orphan', /no \.trashinfo record; called plan-orphan\.txt/]]) {
    const { results } = await find('', [tr], { containing: text });
    assert.strictEqual(results.length, 1, text);
    assert.strictEqual(results[0].kind, 'trash, name unknown');
    assert.strictEqual(results[0].path, null);
    assert.match(results[0].note, note);
  }
});

test('a trashed link is not read through', async () => {
  const { root, tr } = makeHome();
  write(path.join(root, 'elsewhere', 'secret.txt'), 'not in the trash');
  write(path.join(tr, 'info', 'l.trashinfo'), info('/home/u/l', '2026-01-01T00:00:00'));
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(tr, 'files', 'l'), DIR_LINK);
  const { results, perSource } = await find('*', [tr]);
  assert.ok(!results.some((r) => r.path && r.path.startsWith('/home/u/l')));
  assert.match(perSource[0].notes.join('\n'), /1 trashed link\(s\) or special file\(s\) skipped/);
});

test('a home folder, or the same trash given twice, gives each copy once', async () => {
  const { home, tr } = makeHome();
  const { results } = await find('plan', [tr, home]);
  assert.strictEqual(results.length, 5);
  assert.ok(results.every((r) => r.copies === 1));
});

/** A stick used on Linux by two users, with a shared .Trash that lacks the sticky bit. */
function makeStick() {
  const root = workDir('trash-stick');
  dirs.push(root);
  // GLib: relative to the top of the drive.
  write(path.join(root, '.Trash-1000', 'info', 'a.txt.trashinfo'), info('docs/a%20b.txt', '2026-09-20T10:00:00'));
  write(path.join(root, '.Trash-1000', 'files', 'a.txt'), 'on the stick');
  // npm trash: absolute, as it was mounted.
  write(path.join(root, '.Trash-1001', 'info', 'a.txt.trashinfo'), info('/media/bob/STICK/docs/a.txt', '2026-09-21T10:00:00'));
  write(path.join(root, '.Trash-1001', 'files', 'a.txt'), 'bob\'s');
  const shared = path.join(root, '.Trash', '1002');
  write(path.join(shared, 'info', 'a.txt.trashinfo'), info('docs/c.txt', '2026-09-22T10:00:00'));
  write(path.join(shared, 'files', 'a.txt'), 'shared');
  return { root, shared };
}

test('a drive gives every user\'s .Trash-<uid>, relative paths joined onto where it is now', async () => {
  const { root } = makeStick();
  const { results, perSource } = await find('*.txt', [root]);
  assert.deepStrictEqual(results.map((r) => r.path).sort(), [path.join(root, 'docs', 'a b.txt'), '/media/bob/STICK/docs/a.txt'].sort());
  assert.match(perSource[0].notes.join('\n'), /1002: not read, since \.Trash lacks the sticky bit/);
});

test('a shared .Trash/<uid> that fails the checks is still read when given itself', async () => {
  const { root, shared } = makeStick();
  const { results } = await find('c.txt', [shared]);
  assert.deepStrictEqual(results.map((r) => r.path), [path.join(root, 'docs', 'c.txt')]);
  assert.strictEqual((await load(results[0], git)).toString(), 'shared');
});

test('a shared .Trash/<uid> is read from a drive when it has the sticky bit and the right owner', { skip: POSIX_ONLY }, async () => {
  const top = workDir('trash-sticky');
  dirs.push(top);
  const own = path.join(top, '.Trash', String(UID));
  write(path.join(own, 'info', 'k.txt.trashinfo'), info('k.txt', '2026-09-20T10:00:00'));
  write(path.join(own, 'files', 'k.txt'), 'k');
  fs.chmodSync(path.join(top, '.Trash'), 0o777);
  assert.strictEqual((await find('k.txt', [top])).results.length, 0);
  fs.chmodSync(path.join(top, '.Trash'), 0o1777);
  assert.deepStrictEqual((await find('k.txt', [top])).results.map((r) => r.path), [path.join(top, 'k.txt')]);
  const found = discoverOn({ platform: 'linux', home: path.join(top, 'nohome'), env: {}, uid: UID, mountsText: `/dev/sdb1 ${esc(top)} ext4 rw 0 0` });
  assert.deepStrictEqual(found, [own]);
});

test('rebuild takes the newest copy of each file, from a trashed folder or a trashed folder above it', async () => {
  const { tr } = makeHome();
  // The whole home folder went to the trash earlier, holding an older proj.
  write(path.join(tr, 'info', 'u.trashinfo'), info('/home/u', '2026-09-01T09:00:00'));
  write(path.join(tr, 'files', 'u', 'proj', 'src', 'plan.js'), 'older');
  write(path.join(tr, 'files', 'u', 'proj', 'LICENSE'), 'MIT');
  write(path.join(tr, 'files', 'u', 'elsewhere', 'other.txt'), 'not below proj');
  const { results, locations } = await search({ under: '/home/u/proj', sources: ['trash'], locations: only({ dirs: { trash: [tr] } }) });
  const plan = planRebuild(results, '/home/u/proj');
  assert.deepStrictEqual(plan.map((p) => [p.rel.join('/'), p.copy.origin]), [
    ['LICENSE', path.join(tr, 'files', 'u', 'proj', 'LICENSE')],
    ['README.md', path.join(tr, 'files', 'proj', 'README.md')],
    ['src/plan.js', path.join(tr, 'files', 'proj', 'src', 'plan.js')],
  ]);
  const dest = workDir('trash-out');
  dirs.push(dest);
  const done = await rebuild(plan, '/home/u/proj', dest, trash.roots(locations), git);
  assert.strictEqual(done.failed.length, 0);
  assert.strictEqual(fs.readFileSync(path.join(done.root, 'src', 'plan.js'), 'utf8'), 'console.log(1)\n');
  await assert.rejects(restore(plan[0].copy, path.join(tr, 'files'), trash.roots(locations), git), /Refusing to write inside/);
});

test('a Linux name that holds a backslash stays one name: in a search, a restore and a rebuild', async () => {
  // GLib writes the backslash as %5C, and on a Linux base the name is kept whole.
  assert.strictEqual(originalPath('docs/x\\y.txt', '/mnt/d'), '/mnt/d/docs/x\\y.txt');
  const root = workDir('trash-backslash');
  dirs.push(root);
  const tr = path.join(root, 'Trash');
  // Absolute records, so the paths are these same POSIX ones whatever system the test runs on.
  // The file named x\y.txt is the newer, which once made it take the place of x/y.txt.
  write(path.join(tr, 'info', 'a.trashinfo'), info('/home/u/proj/x%5Cy.txt', '2026-09-21T10:00:00'));
  write(path.join(tr, 'files', 'a'), 'the file named x\\y.txt');
  write(path.join(tr, 'info', 'b.trashinfo'), info('/home/u/proj/x/y.txt', '2026-09-20T10:00:00'));
  write(path.join(tr, 'files', 'b'), 'y.txt in the folder x');
  const named = '/home/u/proj/x\\y.txt';
  const paths = async (pattern) => (await find(pattern, [tr])).results.map((r) => r.path).sort();
  assert.deepStrictEqual(await paths('x*'), [named]);
  assert.deepStrictEqual(await paths('y.*'), ['/home/u/proj/x/y.txt']);
  assert.deepStrictEqual(await paths('x/y.txt'), ['/home/u/proj/x/y.txt']);

  const { results, locations } = await search({ under: '/home/u/proj', sources: ['trash'], locations: only({ dirs: { trash: [tr] } }) });
  const plan = planRebuild(results, '/home/u/proj');
  assert.deepStrictEqual(plan.map((p) => p.rel).sort(), [['x', 'y.txt'], ['x\\y.txt']]);
  // Windows cannot hold a backslash in a name, so there it comes back as x_y.txt.
  const dest = workDir('trash-backslash-out');
  dirs.push(dest);
  const done = await rebuild(plan, '/home/u/proj', dest, trash.roots(locations), git);
  assert.strictEqual(done.failed.length, 0);
  assert.deepStrictEqual(fs.readdirSync(done.root).sort(), ['x', safeName('x\\y.txt')].sort());
  assert.strictEqual(fs.readFileSync(path.join(done.root, 'x', 'y.txt'), 'utf8'), 'y.txt in the folder x');
  assert.strictEqual(fs.readFileSync(path.join(done.root, safeName('x\\y.txt')), 'utf8'), 'the file named x\\y.txt');

  const copy = results.find((r) => r.path === named);
  assert.strictEqual(nameFor(copy), 'x\\y.txt');
  const target = await restore(copy, path.join(dest, 'one'), trash.roots(locations), git);
  assert.strictEqual(path.basename(target), safeName('x\\y.txt'));
});

test('finds this user\'s trash folders on a Linux machine, described from any system', () => {
  const root = workDir('trash-discover');
  dirs.push(root);
  const home = path.join(root, 'home');
  const mk = (...p) => fs.mkdirSync(path.join(root, ...p), { recursive: true });
  mk('home', '.local', 'share', 'Trash', 'info');
  mk('home', 'snap', 'code', '179', '.local', 'share', 'Trash', 'files');
  mk('home', 'snap', 'code', 'common');
  fs.symlinkSync(path.join(home, 'snap', 'code', '179'), path.join(home, 'snap', 'code', 'current'), DIR_LINK);
  mk('media', 'My Stick', `.Trash-${UID}`, 'info');
  mk('media', 'My Stick', `.Trash-${UID + 1}`, 'info');
  mk('nas', `.Trash-${UID}`, 'info');
  mk('data', 'Trash', 'info');
  const mountsText = [
    `/dev/sdb1 ${esc(path.join(root, 'media', 'My Stick'))} vfat rw 0 0`,
    `server:/x ${esc(path.join(root, 'nas'))} nfs4 rw 0 0`,
    'proc /proc proc rw 0 0',
  ].join('\n');
  const rel = (list) => list.map((d) => path.relative(root, d).replace(/\\/g, '/'));
  assert.deepStrictEqual(rel(discoverOn({ platform: 'linux', home, env: {}, uid: UID, mountsText })), [
    'home/.local/share/Trash',
    'home/snap/code/179/.local/share/Trash',
    `media/My Stick/.Trash-${UID}`,
  ]);
  const withData = discoverOn({ platform: 'linux', home, env: { XDG_DATA_HOME: path.join(root, 'data') }, uid: UID });
  // XDG_DATA_HOME may be set here and not in the desktop session: the default is read as well.
  assert.deepStrictEqual(rel(withData), ['data/Trash', 'home/.local/share/Trash', 'home/snap/code/179/.local/share/Trash']);
  const same = discoverOn({ platform: 'linux', home, env: { XDG_DATA_HOME: path.join(home, '.local', 'share') + path.sep }, uid: UID });
  assert.deepStrictEqual(rel(same), ['home/.local/share/Trash', 'home/snap/code/179/.local/share/Trash']);
  const relative = discoverOn({ platform: 'linux', home, env: { XDG_DATA_HOME: 'data' }, uid: UID });
  assert.deepStrictEqual(rel(relative)[0], 'home/.local/share/Trash', 'a relative XDG_DATA_HOME is ignored');
  assert.deepStrictEqual(discoverOn({ platform: 'win32', home, env: {}, uid: null, mountsText }), []);
  assert.deepStrictEqual(discoverOn({ platform: 'darwin', home, env: {}, uid: UID, mountsText }), []);
});

test('sources: items, contents gone and items without a record, per trash folder', () => {
  const { tr } = makeHome();
  const lines = trash.describe({ locations: { trash: [tr] } });
  assert.strictEqual(lines[0], `${tr}: 7 item(s), 1 with contents gone, 1 without a record`);
  assert.ok(lines.includes('The macOS Trash is not read yet.'));
  const none = trash.describe({ locations: { trash: [] } });
  assert.match(none[0], /^No trash folder found/);
});

/** Makes fs[name] throw `code` for one path while `run` runs, as a locked or failing entry would. */
async function failing(name, target, code, run) {
  const real = fs[name];
  fs[name] = function (p, ...rest) {
    if (path.resolve(String(p)) === target) throw Object.assign(new Error(code), { code });
    return real.call(this, p, ...rest);
  };
  try {
    return await run();
  } finally {
    fs[name] = real;
  }
}

test('sources: an item that cannot be looked at is not said to be gone, as a search does not', async () => {
  const { tr } = makeHome();
  await failing('lstatSync', path.join(tr, 'files', 'plan.txt'), 'EACCES', async () => {
    const lines = trash.describe({ locations: { trash: [tr] } });
    assert.strictEqual(lines[0], `${tr}: 7 item(s), 1 with contents gone, 1 without a record`);
    const { results, perSource } = await find('plan.txt', [tr]);
    assert.ok(!results.some((r) => r.path === '/home/u/Desktop/plan.txt'));
    assert.match(perSource[0].notes.join('\n'), /1 item\(s\) could not be opened/);
  });
});

test('a trash whose files/ or info/ is a link is not read through it, and restore keeps out of it', async () => {
  const root = workDir('trash-linked');
  dirs.push(root);
  // files/ leads out of the trash, to a folder holding a file a record claims.
  const outside = path.join(root, 'outside');
  write(path.join(outside, 'sub', 'f.txt'), 'outside data');
  write(path.join(outside, 'loose.txt'), 'outside data');
  const stick = path.join(root, 'stick');
  const t1 = path.join(stick, '.Trash-1000');
  write(path.join(t1, 'info', 'sub.trashinfo'), info('docs/sub', '2026-09-20T12:00:00'));
  fs.symlinkSync(outside, path.join(t1, 'files'), DIR_LINK);
  const named = await find('*', [stick]);
  assert.strictEqual(named.results.length, 0);
  assert.match(named.perSource[0].notes.join('\n'), /[\\/]files: not read, since it is not a real folder/);
  assert.strictEqual((await find('', [t1], { containing: 'outside data' })).results.length, 0);
  const gone = { path: '/x', gone: true };
  await assert.rejects(restore(gone, path.join(outside, 'sub'), trash.roots(named.locations), git), /Refusing to write inside/);
  // info/ leads out of it: its records are not read, and what is in files/ is found only by content.
  const t2 = path.join(root, 'stick2', '.Trash-1000');
  write(path.join(root, 'records', 'a.txt.trashinfo'), info('/home/u/a.txt', '2026-09-20T12:00:00'));
  write(path.join(t2, 'files', 'a.txt'), 'in the trash');
  fs.symlinkSync(path.join(root, 'records'), path.join(t2, 'info'), DIR_LINK);
  const r2 = await find('*', [t2]);
  assert.strictEqual(r2.results.length, 0);
  assert.match(r2.perSource[0].notes.join('\n'), /[\\/]info: not read, since it is not a real folder/);
  const c2 = await find('', [t2], { containing: 'in the trash' });
  assert.deepStrictEqual(c2.results.map((r) => [r.kind, r.path, r.origin]), [['trash, name unknown', null, path.join(t2, 'files', 'a.txt')]]);
  const lines = trash.describe({ locations: { trash: [t1, t2] } });
  assert.strictEqual(lines[0], `${t1}: 0 item(s), 0 with contents gone, 0 without a record`);
  assert.strictEqual(lines[1], `${t2}: 0 item(s), 0 with contents gone, 1 without a record`);
});

test('restore keeps out of a trash reached through a link, under every spelling given', async () => {
  const root = workDir('trash-spelling');
  dirs.push(root);
  const real = path.join(root, 'data', 'Trash');
  write(path.join(real, 'info', 'a.txt.trashinfo'), info('/home/u/a.txt', '2026-09-20T12:00:00'));
  write(path.join(real, 'files', 'a.txt'), 'a');
  const share = path.join(root, 'home', '.local', 'share');
  fs.mkdirSync(share, { recursive: true });
  const link = path.join(share, 'Trash');
  fs.symlinkSync(real, link, DIR_LINK);
  const gone = { path: '/x', gone: true };
  for (const places of [[link], [link, real], [real, link]]) {
    const protect = trash.roots({ trash: places });
    for (const dest of [path.join(real, 'files'), path.join(link, 'files'), path.join(link, 'info', 'x')]) {
      await assert.rejects(restore(gone, dest, protect, git), /Refusing to write inside/, `${places.length} ${dest}`);
    }
  }
  // Read, it is still one trash.
  assert.strictEqual((await find('*', [link, real])).results.length, 1);
});

test('a record called "." or ".." is not one: files/ or the trash itself would be read as the item', async () => {
  const root = workDir('trash-dots');
  dirs.push(root);
  const tr = path.join(root, 'Trash');
  write(path.join(tr, 'info', '...trashinfo'), info('/home/u/dotdot', '2026-09-20T12:00:00'));
  write(path.join(tr, 'info', '..trashinfo'), info('/home/u/dot', '2026-09-20T12:00:00'));
  write(path.join(tr, 'files', 'x.txt'), 'x marks');
  const { results, perSource } = await find('*', [tr]);
  assert.strictEqual(results.length, 0);
  assert.match(perSource[0].notes.join('\n'), /2 \.trashinfo file\(s\) could not be read/);
  // By content only the item with no record comes back, not the trash folder as a nameless one.
  const byContent = await find('', [tr], { containing: 'x marks' });
  assert.deepStrictEqual(byContent.results.map((r) => r.origin), [path.join(tr, 'files', 'x.txt')]);
});

/** One record and its item in a trash, the .trashinfo last written at `mtime` when given. */
function record(tr, name, date, mtime, original = `/home/u/${name}`) {
  const file = write(path.join(tr, 'info', `${name}.trashinfo`), info(original, date));
  write(path.join(tr, 'files', name), name);
  if (mtime != null) fs.utimesSync(file, new Date(mtime), new Date(mtime));
}

async function inZone(tz, run) {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

test('a date with no zone is read in the zone its .trashinfo mtime shows it was written in', async () => {
  const root = workDir('trash-zone');
  dirs.push(root);
  const tr = path.join(root, 'Trash');
  // Written on a machine kept in UTC, and read here in Seoul: the mtime is just past the date.
  record(tr, 'utc.txt', '2026-09-20T03:30:05', Date.UTC(2026, 8, 20, 3, 30, 5, 123));
  // Written in Seoul itself.
  record(tr, 'seoul.txt', '2026-09-20T12:30:05', Date.UTC(2026, 8, 20, 3, 30, 5, 456));
  // Whole seconds, as FAT or a copy by tar leaves them, say nothing: the date is read here.
  record(tr, 'fat.txt', '2026-09-20T03:30:05', Date.UTC(2026, 8, 20, 3, 30, 6));
  // A later copy's mtime, not a quarter-hour away from the date.
  record(tr, 'copied.txt', '2026-09-20T03:30:05', Date.UTC(2026, 8, 20, 5, 37, 40, 500));
  // A date with a zone is kept as it is.
  record(tr, 'zoned.txt', '2026-09-20T03:30:05Z', Date.UTC(2026, 8, 20, 12, 0, 0, 500));
  const by = await inZone('Asia/Seoul', async () => Object.fromEntries((await find('*', [tr])).results.map((r) => [r.path, r.time])));
  assert.deepStrictEqual(by, {
    '/home/u/utc.txt': Date.UTC(2026, 8, 20, 3, 30, 5),
    '/home/u/seoul.txt': Date.UTC(2026, 8, 20, 3, 30, 5),
    '/home/u/fat.txt': Date.UTC(2026, 8, 19, 18, 30, 5),
    '/home/u/copied.txt': Date.UTC(2026, 8, 19, 18, 30, 5),
    '/home/u/zoned.txt': Date.UTC(2026, 8, 20, 3, 30, 5),
  });
  // An hour that happens twice is settled by the mtime too: 01:30 EST, not the earlier EDT one.
  const twice = path.join(root, 'twice', 'Trash');
  record(twice, 'twice.txt', '2025-11-02T01:30:00', Date.UTC(2025, 10, 2, 6, 30, 0, 200));
  const [r] = await inZone('America/New_York', async () => (await find('*', [twice])).results);
  assert.strictEqual(r.time, Date.UTC(2025, 10, 2, 6, 30));
});

test('a deletion date in the future is no date, and cannot win a rebuild', async () => {
  const root = workDir('trash-future');
  dirs.push(root);
  const tr = path.join(root, 'Trash');
  const ahead = Date.UTC(2099, 0, 1);
  // Two deletions of one file: the older one's date is out of range but for GLib's placeholder.
  record(tr, 'old', '9998-01-01T00:00:00', Date.UTC(2026, 8, 1), '/home/u/proj/main.c');
  record(tr, 'new', '2026-09-21T10:00:00', null, '/home/u/proj/main.c');
  // A clock set years ahead leaves the date and the file's time both in the future.
  record(tr, 'ahead', '2099-01-01T00:00:00', ahead);
  record(tr, 'undated', null, ahead);
  const { results } = await find('*', [tr]);
  const by = Object.fromEntries(results.map((r) => [path.basename(r.origin), r]));
  assert.strictEqual(by.old.time, Date.UTC(2026, 8, 1));
  assert.match(by.old.note, /deletion date lies in the future; dated by its \.trashinfo file/);
  assert.strictEqual(by.ahead.time, null);
  assert.match(by.ahead.note, /both lie in the future; undated/);
  assert.strictEqual(by.undated.time, null);
  assert.match(by.undated.note, /no deletion date recorded, and its \.trashinfo file is dated in the future/);
  const plan = planRebuild(results, '/home/u/proj');
  assert.deepStrictEqual(plan.map((p) => [p.rel.join('/'), p.copy.origin]), [['main.c', path.join(tr, 'files', 'new')]]);
});

test('two originals whose paths are not UTF-8 both come back in a rebuild', async () => {
  const root = workDir('trash-lossy');
  dirs.push(root);
  const tr = path.join(root, 'Trash');
  write(path.join(tr, 'info', 'a.trashinfo'), info('/home/u/proj/caf%E9.txt', '2026-09-20T10:00:00'));
  write(path.join(tr, 'files', 'a'), 'latin1');
  write(path.join(tr, 'info', 'b.trashinfo'), info('/home/u/proj/caf%E8.txt', '2026-09-20T11:00:00'));
  write(path.join(tr, 'files', 'b'), 'other');
  const { results } = await search({ under: '/home/u/proj', sources: ['trash'], locations: only({ dirs: { trash: [tr] } }) });
  assert.ok(results.every((r) => /not UTF-8/.test(r.note)));
  const plan = planRebuild(results, '/home/u/proj');
  assert.deepStrictEqual(plan.map((p) => p.rel.join('/')), ['caf%E8.txt', 'caf%E9.txt']);
});

test('a .trashinfo too big to be one is not read, and gives no named result', async () => {
  const { tr } = makeHome();
  write(path.join(tr, 'info', 'big.txt.trashinfo'), info('/home/u/big.txt', '2026-09-20T12:00:00') + '#'.repeat(64 * 1024));
  write(path.join(tr, 'files', 'big.txt'), 'big');
  const { results, perSource } = await find('*', [tr]);
  assert.ok(!results.some((r) => r.path === '/home/u/big.txt'));
  assert.match(perSource[0].notes.join('\n'), /2 \.trashinfo file\(s\) could not be read/);
});

test('a link inside a trashed folder, or inside an item with no record, is not followed', async () => {
  const { root, tr } = makeHome();
  write(path.join(root, 'elsewhere', 'secret.txt'), 'not in the trash');
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(tr, 'files', 'proj', 'linked'), DIR_LINK);
  write(path.join(tr, 'files', 'orphan-dir', 'kept.txt'), 'orphan folder');
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(tr, 'files', 'orphan-dir', 'linked'), DIR_LINK);
  const inTrash = (r) => !r.origin || r.origin === tr || r.origin.startsWith(tr + path.sep);
  const named = await find('*', [tr]);
  assert.ok(named.results.length > 0 && named.results.every(inTrash));
  assert.ok(!named.results.some((r) => r.path && r.path.startsWith('/home/u/proj/linked')));
  assert.strictEqual((await find('', [tr], { containing: 'not in the trash' })).results.length, 0);
  assert.strictEqual((await find('', [tr], { containing: 'orphan folder' })).results.length, 1);
});

test('a special file in files/ holds no file, and is skipped', { skip: NO_WIN }, async () => {
  const root = workDir('trash-sock');
  dirs.push(root);
  const tr = path.join(root, 'Trash');
  write(path.join(tr, 'info', 's.trashinfo'), info('/home/u/s', '2026-09-20T12:00:00'));
  fs.mkdirSync(path.join(tr, 'files'));
  // A socket path is limited to about 100 bytes; a relative one is shorter.
  const sock = path.join(tr, 'files', 's');
  const rel = path.relative(process.cwd(), sock);
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(rel.length < sock.length ? rel : sock, resolve);
  });
  try {
    const { results, perSource } = await find('*', [tr]);
    assert.strictEqual(results.length, 0);
    assert.match(perSource[0].notes.join('\n'), /1 trashed link\(s\) or special file\(s\) skipped/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a .trashinfo that is a link is not read', { skip: NO_WIN }, async () => {
  const { root, tr } = makeHome();
  write(path.join(root, 'elsewhere', 'real.trashinfo'), info('/home/u/linked.txt', '2026-09-20T12:00:00'));
  fs.symlinkSync(path.join(root, 'elsewhere', 'real.trashinfo'), path.join(tr, 'info', 'linked.txt.trashinfo'));
  write(path.join(tr, 'files', 'linked.txt'), 'linked');
  const { results, perSource } = await find('*', [tr]);
  assert.ok(!results.some((r) => r.path === '/home/u/linked.txt'));
  assert.match(perSource[0].notes.join('\n'), /2 \.trashinfo file\(s\) could not be read/);
});

test('names that are not UTF-8 are counted, not opened, and not said to be gone', { skip: LINUX_ONLY }, async () => {
  const { tr } = makeHome();
  const bad = Buffer.from([0x63, 0xE9]);
  const at = (...p) => Buffer.concat([Buffer.from(path.join(...p) + path.sep), bad]);
  fs.writeFileSync(Buffer.concat([at(tr, 'info'), Buffer.from('.trashinfo')]), info('/home/u/bad', '2026-09-20T12:00:00'));
  fs.writeFileSync(at(tr, 'files', 'proj'), 'inside');
  const { perSource } = await find('*', [tr]);
  assert.match(perSource[0].notes.join('\n'), /2 name\(s\) are not UTF-8 and could not be opened/);
  const lines = trash.describe({ locations: { trash: [tr] } });
  assert.strictEqual(lines[0], `${tr}: 8 item(s), 1 with contents gone, 1 without a record`);
});

test('a drive\'s macOS .Trashes is reported, not read', async () => {
  const { root } = makeStick();
  write(path.join(root, '.Trashes', '501', 'a.txt'), 'mac');
  const { perSource } = await find('*', [root]);
  assert.match(perSource[0].notes.join('\n'), /\.Trashes: macOS trash folders are not read yet/);
});

test('a rebuild walks a deleted folder only on the way to the folder being rebuilt, and below it', async () => {
  const { tr } = makeHome();
  write(path.join(tr, 'info', 'u.trashinfo'), info('/home/u', '2026-09-01T09:00:00'));
  write(path.join(tr, 'files', 'u', 'proj', 'LICENSE'), 'MIT');
  write(path.join(tr, 'files', 'u', 'elsewhere', 'deep', 'other.txt'), 'not below proj');
  const listed = [];
  const readdir = fs.readdirSync;
  fs.readdirSync = function (p, ...rest) {
    listed.push(path.resolve(String(p)));
    return readdir.call(this, p, ...rest);
  };
  try {
    await search({ under: '/home/u/proj', sources: ['trash'], locations: only({ dirs: { trash: [tr] } }) });
  } finally {
    fs.readdirSync = readdir;
  }
  assert.ok(listed.includes(path.join(tr, 'files', 'u', 'proj')));
  assert.ok(!listed.some((p) => p.startsWith(path.join(tr, 'files', 'u', 'elsewhere'))));
});
