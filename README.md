# Solarljos

Finds a deleted file by looking everywhere a copy of it may have survived, and gets it back
without writing a single byte anywhere else.

```
$ solarljos find budget.xlsx

  Recycle Bin                 1
  Editor Local History        0
  Claude Code                 3
  Antigravity                 0
  git                         2   (repositories searched: 4)
  Volume Shadow Copies        2
  ...

ID        WHEN              FOUND IN                    SIZE    STATE    PATH
3f9a1c2e  2026-09-27 21:14  claude backup               31 KB   deleted  C:\Users\me\work\budget.xlsx
b71e02d4  2026-09-27 08:37  shadow copy x2              29 KB   deleted  C:\Users\me\work\budget.xlsx
...

To read one:      solarljos show budget.xlsx <id>
To get one back:  solarljos restore budget.xlsx <id> --to <folder>
```

When a whole folder is gone, `rebuild` brings back everything that was below it, taking the
newest surviving copy of each file from whichever source holds it:

```
$ solarljos rebuild C:\work\app --to D:\recovered

Rebuilt 57 of 57 file(s) below C:\work\app
into D:\recovered\app

     30  git commit
     14  claude backup
      9  shadow copy
      4  local history
```

## Why another recovery tool

Classic undelete tools read the disk sector by sector and rebuild files from what the file
system has not overwritten yet. On a hard disk that works. On an SSD it mostly does not:
when a file is deleted, Windows sends TRIM, the drive discards the blocks, and from then on
they read back as zeros. Most machines today boot from an SSD with TRIM on.

What does survive on such a machine is *other copies* -- in the Recycle Bin, in a restore
point's shadow copy, in the history an editor or an IDE keeps, in an AI coding agent's
transcripts and backups, inside a git repository, in a tab Notepad never saved. Each of those
has its own tool, or no tool at all, and nobody looks in all of them at once after the fact.
That is what this does.

It matters more since coding agents started deleting things. An agent's `rm -rf`, a
`git reset --hard`, a rewritten file -- none of those go through the Recycle Bin, but the
agent's own records usually hold what was there.

## What it searches

| Source | Where | What survives there |
| --- | --- | --- |
| Recycle Bin | `<drive>:\$Recycle.Bin\<account>\` | Deleted files and whole deleted folders, with their original paths and deletion times. Files inside a deleted folder are found individually. A recycled link or junction is skipped, never read through |
| Volume Shadow Copies | `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyN` | The whole volume as it stood when a restore point or snapshot was taken: every file that existed then, byte-exact with its own size and time. Read without administrator rights, one folder at a time -- never a whole snapshot |
| Editor Local History | `<app data>/<editor>/User/History/` | A copy of a file on every save. VS Code and every editor built on it -- Cursor, Windsurf, Antigravity, VSCodium -- are found automatically |
| Unsaved editor buffers | `<app data>/<editor>/Backups/` | The text of buffers with unsaved changes, and of untitled ones, that VS Code and every editor built on it keep so that quitting does not lose them. Marked as never saved; a file deleted while it was open is noted |
| Windows Notepad | `%LOCALAPPDATA%\Packages\Microsoft.WindowsNotepad_*\LocalState\TabState\` | Text typed into a tab and never saved: unsaved edits to a file, and untitled tabs for a search by content. With Notepad before 11.2408, the saved file itself, checked against the SHA-256 Notepad recorded |
| JetBrains IDEs | `<caches>/JetBrains/<product><version>/`, `<caches>/Google/AndroidStudio<version>/` (`%LOCALAPPDATA%`, `~/Library/Caches`, `~/.cache`) | Local History: each file as it was before a change, and every file of a deleted folder, for about five days. The IDE's file cache: the last bytes it saw of files since deleted or changed, until its caches are invalidated |
| Eclipse Local History | `.metadata/.plugins/org.eclipse.core.resources/.history/` in an Eclipse workspace. The Java language server's workspaces under `<app data>/<editor>/User/workspaceStorage/*/redhat.java/` are found automatically | Each version a file had before Eclipse replaced it, byte for byte. From the language server, only the `.settings/*.prefs` files it rewrites itself |
| Hancom Office | `<temp>\Hwp<version>\`, `%APPDATA%\HNC\Office\Recent\` and the folders of recent documents | Hwp's autosave of each open document, left behind when Hwp did not exit normally; with backups turned on, the version before each save as `<name>.bak` beside the document. Only copies that pass the format's own checks are offered |
| Claude Code | `~/.claude/`, or `CLAUDE_CONFIG_DIR` | Byte-exact backups taken before Claude changed a file; the full content of files Claude wrote; the file as it was before each edit, and after it; files Claude read in full |
| Antigravity | `~/.gemini/antigravity-ide/` | The full content of files its agent wrote, once Antigravity reported the write done; files it read in full, rebuilt and checked against the size it recorded |
| git | repositories in and up to two levels below the current folder, or `--repo` / `--location git=<folder>` instead | Files deleted from disk but still in the index; every committed version, including commits thrown away by `reset --hard` that only the reflog still names; with `--containing` and no name, staged content that was never committed. Each copy is what checkout writes, line endings included: a file under Git LFS is its object, checked against the pointer, and a pointer at a path not under Git LFS is the pointer, as checkout writes it |
| Trash (Linux) | `~/.local/share/Trash`, `<drive>/.Trash-<uid>` | Deleted files and whole deleted folders from Linux desktops and tools, with their original paths and deletion times. Files inside a deleted folder are found individually. A drive used on Linux can be read on Windows with `--location trash=<drive>` |

`solarljos sources` shows what each source can see on the machine it runs on. How each one is
read, what is checked before a copy is offered, and what was measured is in
[docs/sources.md](docs/sources.md).

## Nothing is written

A recovery tool that writes can destroy what it is trying to recover, so this one does not:

- Sources are only ever read. git runs with `GIT_OPTIONAL_LOCKS=0`, so even `status`-like
  commands do not refresh the index, and `git fsck --lost-found`, which writes into `.git`,
  is never used. No filter program runs -- every filter driver git is configured with, Git
  LFS and one with an empty name included, is switched off for each call -- and no gpg starts.
  `GIT_DIR` and the other variables that tie git to one repository are not passed on, so a
  hook or a script that set them cannot make every folder read as that repository. The tests
  check that a repository's `.git` is byte-for-byte unchanged after a search.
- No database is opened, since opening SQLite even read-only leaves journal files beside it.
  No PowerShell is started, since every start of it rewrites a file in the user's profile.
- `restore` and `rebuild` are the only commands that write, and only under the folder given
  with `--to`. They refuse a folder inside the places sources keep their records in, also when
  a link or a junction leads there: a Recycle Bin, an editor's `User/History` or `Backups`
  folder, an IDE's system folder, an Eclipse workspace's `.metadata`, Notepad's TabState, Hwp's
  temp and Recent folders, a Claude Code or Antigravity folder, a trash folder, a shadow copy,
  and a repository's git folders with the object and Git LFS folders it reads. The folders
  where copies sit among live files stay open, since that is where a file is usually put back:
  a git working tree, an Eclipse workspace outside its `.metadata`, and the document folders
  whose `<name>.bak` backups are read.
- Nothing is replaced: a name that is taken becomes `name (recovered 2).ext`, and a rebuilt
  folder always goes into a new folder of its own. On Windows a name it cannot hold -- `a:b`
  from Linux would be a stream attached to a file `a` -- is written with `_` in its place. Two
  entries of a deleted folder that come out under the same name that way, or as `Readme` and
  `README` on a disk that ignores case, both come back, the second as `name (recovered 2)`.
  `rebuild --dry-run` shows the plan and writes nothing.
- A deleted folder is restored without the links and junctions inside it, since what they
  lead to was not deleted with it, and without any folder inside it that holds the copy being
  written, such as a bind mount of it. A folder that is itself a link or junction, or that
  really lies outside the searched location it was found in, is refused with
  `Refusing to restore <dir>: it leads through a link to <real path>.`, and so is a `--to`
  inside the folder being restored. Then nothing is created, not even the `--to` folder.
- There is no cache, no settings file and no log. IDs are derived from content, so `show` and
  `restore` search again rather than remember anything.

What the operating system does on its own when any program runs -- Prefetch, event logs,
last-access times -- is outside any program's control, this one included.

## Install

Requires Node.js 22 or later. There are no dependencies and nothing to build.

```
git clone https://github.com/amophi/Solarljos.git
cd Solarljos
node bin/solarljos.js --help
```

`npm link` in that folder puts `solarljos` on the `PATH`.

## Usage

```
solarljos find <name>                     list every surviving copy, newest first
solarljos show <name> <id>                print one copy
solarljos restore <name> <id> --to <dir>  write one copy into <dir>
solarljos rebuild <folder> --to <dir>     bring back everything below a folder
solarljos sources                         show what can be searched on this machine
```

`<name>` matches file names in any case: `report` finds `report-final.docx`. With `*` or `?`
it is a glob over the whole name (`*.docx`); with a slash it is matched against the full path
(`src/app.js`, `src/*.js`). Names compare in Unicode NFC, so a name macOS wrote decomposed
matches the same name typed on Windows.

| Option | Meaning |
| --- | --- |
| `--containing <text>` | Only copies whose text contains it. With no `<name>`, copies whose file name was lost are offered too |
| `--deleted-only` | Only copies whose original path no longer exists (STATE `deleted`) |
| `--since <when>` | Only copies from then on: `7d`, `12h` or `30m` ago; `2026-09-01`, midnight at the start of that day where you are, as every time shown is local; `2026-09`, midnight on the first of that month; or a full time such as `2026-09-01T14:30`, local unless it ends in `Z` or an offset. A day that does not exist, such as `2026-02-30`, is refused |
| `--source <ids>` | Search only some sources, comma-separated or repeated: `recycle`, `history`, `claude`, `antigravity`, `git`, `jetbrains`, `eclipse-history`, `notepad`, `editor-backups`, `hancom`, `trash`, `vss` |
| `--limit <n>` / `--all` | Rows to show; 30 by default |
| `--json` | `find` and `rebuild` only: machine-readable output |
| `--binary` | `show` only: print a copy even when it looks binary |
| `--to <dir>` | Where `restore` and `rebuild` write |
| `--dry-run` | `rebuild` only: list what would be written, and write nothing |

A mistake in the command line -- an unknown option or source, a `--since` that cannot be read,
a missing `--to` -- ends with exit code 2 and writes nothing. `find` and `rebuild` end with 1
when they find nothing, and `rebuild` also when a file could not be read or written.

Every location can also be given by hand, which is how a drive taken out of another machine
is searched. `--location <id>=<place>` works for every source and can be repeated. A place
given is added to the ones found on this machine, except for git, where it replaces the current
folder; `--no-discover` searches only what was given. An id not in this table (`repos` is also
taken, as an older name for `git`), or nothing after the `=`, is a usage error. What a place may
be, and what each source finds on its own, is at the end of each source's section in
[docs/sources.md](docs/sources.md).

| Location | Place | Also given as |
| --- | --- | --- |
| `recycle=<dir>` | A `$Recycle.Bin` folder, or one account's folder inside it | `--recycle-dir <dir>` |
| `history=<dir>` | An editor's `User/History` folder | `--history-dir <dir>` |
| `claude=<dir>` | A Claude Code folder such as `~/.claude` from another machine; searched together with the one found here | `--claude-dir <dir>` |
| `antigravity=<dir>` | An Antigravity data folder, normally `~/.gemini/antigravity-ide`; its brain folder or one conversation's folder also work | `--antigravity-dir <dir>` |
| `git=<dir>` | A folder to look for git repositories in, instead of the current folder: the folder and up to two levels below it, and the repository it is in | `--repo <dir>` |
| `vss=<snapshot>=<drive>` | A snapshot and the drive it froze, e.g. `vss=\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy5=C:\`; a shadow-copy device alone is tied to its drive by serial. `vss=walk=<folder>` adds a folder to look through in every snapshot | |
| `jetbrains=<dir>` | An IDE's system folder, e.g. `D:\old\Users\me\AppData\Local\Google\AndroidStudio2026.1`, its `LocalHistory` or `caches`, or a folder of system folders | |
| `eclipse-history=<dir>` | An Eclipse workspace, its `.metadata`, or a folder up to five levels above it | |
| `notepad=<dir>` | Notepad's TabState folder, or any folder above it up to a user profile, e.g. `D:\old\Users\me\AppData\Local` | |
| `editor-backups=<dir>` | An editor's `Backups` folder, or the app folder holding it | |
| `hancom=<dir>` | A folder whose `.asv`, `.bak` and `.lnk` files are read: Hwp's temp folder, Hancom's Recent folder, or a folder of documents | |
| `trash=<place>` | A Linux trash folder, a home or data folder holding one, or a drive used on Linux | |

A place given twice, or given and also found, is searched once; for the first five, on Windows,
also when only the letter case differs.

### Reading the list

- **STATE** is `deleted` when nothing exists at the original path any more, `exists` when
  something does -- then the copy is an older version -- and `no content` when a source still
  lists an item whose contents are gone. It is `-` (an empty string in `--json`) when the path
  cannot be checked here, and `--deleted-only` then leaves the copy out. That is a path from
  another kind of system, or one where a look could wait on the network or on a disk:
  - On Windows, a `\\server\share` path, a path on a drive letter mapped to a share, and a path
    on a drive letter that is not there or does not answer -- an unplugged disk, an empty card
    reader, a disconnected share. Each letter is asked once per search, at its root.
  - On Linux, a path on a network mount, by its type in `/proc/self/mounts`, read once per
    search: NFS, SMB, AFS, Ceph, GlusterFS, Lustre, GPFS, 9p over the network, NBD and RBD
    disks, the FUSE clients of a network (sshfs, rclone, s3fs, gvfs, davfs and others) and a
    FUSE mount that does not name its daemon. Other FUSE mounts (gocryptfs, encfs, mergerfs,
    ntfs-3g), tmpfs and overlay are checked. A path reached through a link onto a network
    mount is not recognised.
  - On macOS every path is checked.
- **(never saved)** marks a draft: text an editor held that was never written to the file.
- The same content under the same name is one row however many places hold it; `x3` after
  the source says how many. The copy that represents the row is chosen as rebuild chooses
  (below): a saved, exact copy first, then one saved but not provably exact, then a draft, and
  the newest among those.
- **(folder unknown)** after a name means a source knows what the file was called but not where
  it was; it is restored under that name.
- An **ID** is derived from the path and the content, so it stays the same between runs. The
  first few characters are enough. `show` prints the copy's note, when it has one.
- The two commands printed under the list, to read a copy and to get one back, repeat the
  options that decide which copies exist, quoted for the shell of the system they are printed
  on. On Windows a value such as `trash=E:\` is left bare; one holding `$` or `` ` ``, such as
  `E:\$Recycle.Bin`, goes in single quotes, which PowerShell takes as they are and cmd does
  not; anything else goes in double quotes, which both take. Elsewhere a value is quoted for a
  POSIX shell.

### Rebuilding a folder

`rebuild <folder>` searches every source for anything whose original path was below that
folder -- the folder as it was, which is usually one that no longer exists -- and takes one copy
of each file. The folder is read the same way on every system: `C:`, `C:\` and `c:/` are the
root of drive C, a trailing separator is dropped, and a relative folder is taken from the
current one.

A saved, exact copy comes first; then one that is saved but not provably exact, such as a file
git could not run its filter on, or the text a JetBrains IDE kept of a file; a draft only when
nothing else exists. So an older shadow copy or commit is taken over a newer copy of those
kinds. Among copies of one rank, the newest wins, and between copies from the same moment the
bytes that were on disk win over text an agent saw, with an edit rebuilt by applying it last. A
file as it was before a change is dated a millisecond before that change, so the state after it
always counts as newer. The same order picks which copy represents a row in `find`. The ranking
is in [src/quality.js](src/quality.js).

The result goes into a new folder named after the old one inside `--to`; a second rebuild
goes beside it as `name (recovered 2)`. A path can be a file in one copy and a folder in
another: a script `bin` that later became `bin/cli.js`, as git history often has. Then every
file below the folder is written and the folder keeps its name, and the file goes beside it as
`bin (recovered 2)`, or `a (recovered 2).txt` for a name with an extension. A copy that cannot be
read or written is reported at the end, under `Could not read or write N file(s):`, and the rest
are still written. `--deleted-only` limits it to files that are missing today, which is how a
folder that was only partly deleted is filled in.

## Using it from code

The command line is a front end on a small API, which a graphical front end can use the same
way:

```js
const solarljos = require('solarljos');

const { results, locations } = await solarljos.search({
  pattern: 'budget.xlsx',
  onProgress: (e) => console.log(e.type, e.id ?? '', e.done ?? '', e.total ?? ''),
});
const bytes = await solarljos.readCopy(results[0]);
await solarljos.restoreCopy(results[0], 'D:\\recovered', locations);

const { folder, plan } = await solarljos.planFolder('C:\\work\\app');
await solarljos.rebuildFolder(plan, folder, 'D:\\recovered', locations);
```

Progress arrives as `source-start`, `source-progress` (`done` of `total`, from sources that go
through many files), `source-done`, `filtering` and `done`. Results are plain objects; the same
rules apply as on the command line.

`search()` and `describeSources()` take `locations` as the command line gives them:
`{ discover, recycleDirs, historyDirs, claudeDir, antigravityDirs, repos, dirs }`, where `dirs`
is `{ <source id>: [places] }` as from `--location`. An unknown id in `dirs`, or an empty place,
throws an Error with `usage: true`. The `locations` a search returns is what came of them, with
`claude` a list of folders; `restoreCopy()` and `rebuildFolder()` take that one. `planFolder()`
and `rebuildFolder()` read a folder the way `rebuild` does (`C:` is the drive's root on any
system, a relative folder is made absolute), and `planFolder()` returns it as `folder`, as it
was understood.

## Speed

Measured on the machine this was written on, a search for `package.json` across all twelve
sources, started in this repository's folder, took 5.3 to 5.5 s. Nearly all of it was two
sources: Claude Code, which went through 1,537 transcripts totalling 918 MB (3.8 to 4.0 s), and
the two shadow copies (0.8 s). The other ten together took 0.7 s, git 0.3 s of it for the one
repository.

`--source` leaves out what is not needed, with one thing to know: in a name search the shadow
copies are looked through only in the folders where the other selected sources found something,
plus the user's Desktop, Documents and Downloads and any `--location vss=walk=<folder>`. So
`--source vss` on its own finds nothing that lies anywhere else.

## Limits

- Raw disk recovery is not part of this; see *Later*.
- File History, OneDrive and Microsoft Office's autosave are not searched yet.
- Shadow copies are listed by probing their device names, since listing them properly needs
  administrator rights. Their own creation time is estimated.
- Antigravity's `conversations/*.db` and `implicit/*.pb` files are not read; its transcripts
  hold the same steps, and the `.pb` files are encrypted.
- The Recycle Bin is found on Windows only, though one from a Windows drive can be given on any
  system with `--recycle-dir`; the Linux trash is read on any system; the macOS Trash is not
  read yet.
- Copies larger than 32 MB are listed but not compared, so they are never merged as duplicates.
- A search by content (`--containing`) reads the bytes as stored, so it does not see into
  compressed formats such as HWP or DOCX.

## Later

- File History, OneDrive, Microsoft Office AutoRecover, the macOS Trash.
- Other coding agents' records -- Codex, Gemini CLI, Cursor, VS Code's chat edits -- once they
  can be checked against real data.
- NTFS: `$UsnJrnl`, to say what was deleted and when even when nothing is left, and small
  files kept inside the MFT itself.
- Raw recovery for USB sticks and SD cards, where TRIM usually does not reach.
- A graphical front end, on the API above.
- Languages other than English. All text already goes through one function for that.

## Tests

```
npm test
```

Everything runs against fixtures built under `test/.work` and removed afterwards; no test reads
the machine's real Recycle Bin, shadow copies, editor or IDE history, Notepad tabs, Hancom
folders, trash, Claude Code or Antigravity folders, or repositories. A few tests run only on
Linux or only on Windows; CI runs both.

## License

MIT
