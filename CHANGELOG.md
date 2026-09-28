# Changelog

## 0.3.0 (unreleased)

Seven new sources, corrections to existing ones that made copies wrong or read the wrong thing,
and a core that a graphical front end can use.

New sources:

- Volume Shadow Copies. Restore-point and other snapshots are read straight from their
  `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyN` devices -- which a standard user can read,
  since only listing them needs administrator rights -- so a file's exact on-disk bytes come
  back from the last snapshot that held it. Snapshots are found by probing device numbers
  (about 6 ms) and tied to their drive by volume serial; no `vssadmin`, WMI or PowerShell is
  run. A whole snapshot is never walked: `rebuild` reads only the target subtree, and a name
  search only the folders the other selected sources point at plus the user's Desktop,
  Documents and Downloads and any `--location vss=walk=<folder>`, so `--source vss` on its own
  finds nothing elsewhere. A link inside a snapshot, which Windows resolves against the live
  drive, is followed only where it stays inside the snapshot. Cloud-only placeholders are
  reparse points and are skipped with the links. On the machine this was written on, two
  snapshots were readable without elevation and one held an older copy of this project's own
  `package.json`.
- Windows Notepad. Text typed into a tab and never saved comes back marked as never saved:
  unsaved edits under the file's name, and untitled tabs for a search by content alone. Notepad
  before 11.2408 also kept the saved file's text, offered when it has the size and SHA-256
  Notepad recorded. Every header and edit-log entry is checked against its CRC32. On the machine
  this was written on, all 13 tab files passed, giving 2 sets of unsaved edits and 4 untitled
  tabs. `--location notepad=<folder>` takes any folder from a user profile down to `TabState`
  (the profile, `AppData`, `AppData\Local`, `Packages`, the package folder, `LocalState`,
  `TabState`) or a folder of tab files; a place that leads to no TabState folder gets a note in
  the search.
- JetBrains IDEs, Android Studio included. Local History gives each file as it was before a
  change and every file of a deleted folder; the IDE's file cache gives the last bytes it saw of
  files since deleted or changed. Every copy matches the SHA-1 and size the IDE stored with it.
  A version whose bytes do not prove they came from disk -- a CR before an LF, a UTF-8 BOM, or
  the same content in the cache -- is `jetbrains history, as text`, and ranks as saved but not
  provably exact. On the machine this was written on, all 5,149 cached contents passed their
  SHA-1, and all 1,478 cached files still on disk unchanged were identical byte for byte.
- Eclipse Local History, including the workspaces the Java language server keeps inside
  VS Code-family editors' storage. An index must read to its last byte, each path must hash to
  its folder, and a state file must still have the modification time recorded for it. On the
  machine this was written on, all 52 versions in 9 indexes passed. Restore and rebuild refuse
  only each workspace's `.metadata`, and the real folders behind its
  `org.eclipse.core.resources`, `.history` and `.projects` when those are links, so a file can be put back into a project in `~/eclipse-workspace` or
  into the workspace itself, and a place given above a workspace no longer keeps restores out
  of everything below it.
- Unsaved editor buffers: the hot-exit backups of VS Code and every editor built on it. A backup
  is offered only when its name and folder are what the editor derives from the URI inside it,
  and it is marked as never saved. The reader agreed with the installed Antigravity IDE's own
  URI and hash code in 43 of 43 checks; there was no real backup on the machine to read.
- Hancom Office: Hwp's autosaves (`<temp>\Hwp<version>\<name>.asv`) and backups (`<name>.bak`
  beside the document). A copy is offered only when it proves whole: an HWP 5 compound file down
  to every sector chain, section record and embedded item, an HWPX zip down to every CRC-32. The
  checks passed on all 71 real documents on the machine, and 425 of 426 copies of them cut short
  failed. Restore refuses Hwp's temp and Recent folders, not the document folders the backups
  sit in.
- The Linux trash (`trash`): the home trash, a snap's own trash, and `.Trash-<uid>` and
  `.Trash/<uid>` on every mounted drive, by the freedesktop.org rules. A drive used on Linux can
  be read on Windows with `--location trash=<drive>`. A `DeletionDate`, which has no zone, is
  read in the zone the `.trashinfo` file's own time shows when that time keeps a fraction of a
  second, and in this machine's zone otherwise. Tested against fixtures built to the rules of
  GLib, KIO, trash-cli, send2trash, npm's `trash` and the Rust `trash` crate.

Corrections:

- git: a copy is now what checkout writes, not the raw blob. Each is read through
  `git cat-file --batch --filters` under the repository's own attributes and config, and where
  the index recorded the size of the file on disk, that size decides between the converted and
  the stored form. On the machine this was written on (`core.autocrlf=true`), copies equal to the
  file on disk went from 200 to 1,316 of 1,327; the other 11 had been edited since. No filter
  program runs -- every configured driver, Git LFS and one with an empty name (`[filter ""]`)
  included, is switched off for each call, during search, preload and the read for restore --
  and a Git LFS pointer at a path under `filter=lfs` is followed to its object, offered only when
  its size and sha256 match. New kinds `git, filter not run` (a path under a driver other than
  Git LFS, the empty-named one included), `git, line endings differ`, `git, Git LFS pointer` (a
  pointer at a path not under `filter=lfs`, now or in the commit it comes from, offered as the
  pointer, which is what checkout writes there) and `git lfs object, name unknown`;
  `git object, name unknown` is now `git object, name unknown, as stored`. `git log` never
  starts gpg, and blobs a merge introduced are listed too.
- git: the variables that tie git to one repository are no longer passed to it, in any letter
  case: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_IMPLICIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`,
  `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CONFIG`, `GIT_GRAFT_FILE`,
  `GIT_SHALLOW_FILE`, `GIT_NO_REPLACE_OBJECTS`, `GIT_REPLACE_REF_BASE` and `GIT_PREFIX`, the list
  `git rev-parse --local-env-vars` gives and git clears before it runs a command in a submodule.
  Before, started from a git hook, a script or a dotfiles setup that exports `GIT_DIR`, every
  folder searched read as that one repository: its files were listed as the searched folder's
  deleted files, which `rebuild` would have written, that folder's own history was missed, and
  a plain folder counted as a repository. `GIT_CONFIG` also had the filter drivers looked up in
  that one file only, so a driver in `.git/config` was not switched off and ran. Settings given
  with `-c` (`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`), `GIT_CONFIG_GLOBAL`,
  `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM` and `GIT_CEILING_DIRECTORIES` are still passed, and
  a driver defined only through `-c` settings is switched off like the others. Folders named by
  `GIT_OBJECT_DIRECTORY` or `GIT_ALTERNATE_OBJECT_DIRECTORIES` are no longer read, so they are no
  longer kept from restore; those a repository's `objects/info/alternates` names still are. An
  inherited `GIT_NO_REPLACE_OBJECTS` or `GIT_REPLACE_REF_BASE` no longer applies either.
- Recycle Bin: an item whose `$R` is a symbolic link, a junction or another special file is no
  longer offered. Windows recycles a deleted link as the link itself, and before, a recycled
  junction was read through: the live folder it pointed to, and every file in it, came up as
  deleted, and a recycled file link offered its target's current bytes. Such items, a `$I` that
  is a link, links and junctions inside a deleted folder and, on Windows, any other entry there
  that Node's folder listing reports as a link, such as a cloud placeholder, are counted in one
  note per account folder, which ends in
  `link(s), junction(s) or special file(s) skipped; they hold no file`. `sources` leaves them
  out of its item count. A file inside a
  deleted folder is looked at again, without following links, before it is offered, and an
  account folder that is itself a link is not read.
- Recycle Bin: a deleted folder is read level by level from its top, up to 200,000 entries, and
  a note says when the deepest ones were left unsearched; restoring the folder itself still
  copies all of it. On the machine this was written on, 23 deleted folders held 16,657 entries
  in all, the largest 11,178, the deepest 12 levels, so no real search here is cut. A rebuild
  reads only the part of a deleted folder on the way to or below the folder being rebuilt.
- Antigravity: a write is offered only once Antigravity reported it done. Before, 16 of 184
  writes on the machine this was written on were offered as if written: 12 had failed, such as
  "already exists" where the path held other content, and 4 were never answered. A write into
  the conversation's own folder gets the final newline Antigravity adds there; one elsewhere
  without it is `antigravity write, final newline unknown`. Names that appear only
  percent-encoded are found; `sources` no longer counts `brain/tempmediaStorage` as a
  conversation. Edits are still not rebuilt: of 39 states that could be, none was confirmed for
  a file now missing.
- Claude Code: `--claude-dir` no longer replaces the folder found on this machine. It, every
  `--location claude=<dir>` and the found `~/.claude` (or `CLAUDE_CONFIG_DIR`, unless
  `--no-discover`) are searched together, `sources` prints one line per folder, and restore and
  rebuild refuse to write inside any of them.
- `--since 2026-09-01` is midnight at the start of that day in local time, as every time shown
  is. It was midnight UTC, which east of UTC left out copies from the first hours of the day.
  `--since 2026-09` is midnight on the first of that month, and a day that does not exist, such
  as `2026-02-30`, is a usage error. `7d`, `12h`, `30m` and full timestamps are read as before.
- rebuild: when a path is a file in one copy and a folder in another (`bin`, and later
  `bin/cli.js`), every file under the folder is written and the folder keeps its name; the file
  goes beside it as `bin (recovered 2)`, or `a (recovered 2).txt` for a name with an extension.
  Before, every file below the folder failed with EEXIST. The summary of failures reads
  `Could not read or write N file(s):`.
- restore of a deleted folder: two entries that come out under the same name on the target (on
  Windows `a:b` and `a_b`, names with trailing dots or spaces, `Readme` and `README`, or any
  such pair on a disk that ignores case) both come back, the second as `name (recovered N)`,
  instead of the restore stopping halfway with EEXIST. Links and junctions inside the folder
  are still left out, and so is any folder inside it that holds the copy being written, such as
  a bind mount.
- restore of a deleted folder is refused, with exit code 1, when the folder is itself a link or
  junction or its real path lies outside the searched location it was found in:
  `Refusing to restore <dir>: it leads through a link to <real path>.` It is also refused when
  `--to` is inside the folder being restored:
  `Refusing to write inside <dir>; that is the folder being restored.` In both cases nothing is
  created, not even the `--to` folder.
- The commands printed after `find` (`To read one: ...`, `To get one back: ...`) are quoted for
  the shell of the system they are printed on. On Windows a value made only of letters, digits
  and `. _ - / \ : = ?` is bare, so `trash=E:\` and `vss=\\?\GLOBALROOT\...=C:\` are; a value
  holding `$` or `` ` `` goes in single quotes with an inner `'` doubled, which pastes into
  PowerShell and not into cmd; anything else goes in double quotes, with an inner `"` escaped
  and backslashes doubled before a quote or at the end (`"D:\My Files\\"`). Elsewhere a value of
  letters, digits and `. _ - / : = , @ % +` is bare and anything else, a backslash included, goes
  in POSIX single quotes. Before, a value was bare or in double quotes on every system.

Core:

- `src/index.js` is a programmatic API -- search, readCopy, restoreCopy, planFolder,
  rebuildFolder, describeSources -- and search reports progress through `onProgress`.
- `--location <id>=<place>` gives any source a place, repeatable. `<id>` is one of `recycle`,
  `history`, `claude`, `antigravity`, `git`, `jetbrains`, `eclipse-history`, `notepad`,
  `editor-backups`, `hancom`, `trash`, `vss`, or the older `repos`, exactly and in lower case.
  Anything else -- a typo such as `jetbrain`, `VSS`, a file name such as `recycle-bin` -- is a
  usage error with exit code 2 (`Unknown source in --location: <ids>. Known: ...`), and so is an
  empty place (`Give a place after notepad= in --location, ...`). search() and describeSources()
  throw an Error with `usage: true` for the same.
- git: `--repo <dir>`, `--location git=<dir>` and `--location repos=<dir>` are the same and add
  to each other, and any of them replaces the default, the current folder. With none of them the
  current folder is searched, and with `--no-discover` as well no repository is.
- A place given twice, or both given and found, is searched once for recycle, history, claude,
  antigravity and git; on Windows also when only the letter case differs.
- Copies are ranked in tiers (`src/quality.js`): saved and exact, then saved but not provably
  exact, then drafts. Rebuild and the merging of identical copies both follow it, so a newer
  unsaved buffer no longer represents, or replaces, the saved bytes it matches, and an older
  exact copy (a shadow copy, the Recycle Bin, a git commit) is taken over a newer
  `jetbrains history, as text`. `git, Git LFS pointer` ranks with the exact copies.
- On Windows a restored name that Windows cannot hold is written with `_`: `a:b` from a Linux
  trash would otherwise have been a stream attached to an existing file `a`.
- `restore` and `rebuild` refuse the folders sources keep their records in, also when a link or
  a junction leads there. A git working tree, an Eclipse workspace outside its `.metadata`, and
  the document folders whose `.bak` backups are read stay open to them.
- A path whose state cannot be told is no longer looked up, and shows `-` under STATE, which
  `--deleted-only` leaves out. That is a path from another kind of system (on Windows `/home/a`
  was read as `C:\home\a` and shown as deleted) and, on Windows, a `\\server\share` path, a path
  on a drive letter mapped to a share, and a path on a drive letter that is not there or does
  not answer, which before showed as deleted; each letter is asked once per search, at its
  root, with no program run. On Linux it is a path on a network mount, by its type in
  `/proc/self/mounts`, read once per search: NFS, SMB, AFS, Ceph, GlusterFS, Lustre, GPFS, 9p
  over TCP or RDMA, NBD and RBD disks, the FUSE clients of a network (sshfs, rclone, s3fs,
  gcsfuse, goofys, juicefs, ceph-fuse, gvfs, davfs, blobfuse, onedriver, curlftpfs) and a FUSE
  mount that does not name its daemon. Other FUSE mounts, tmpfs and overlay are still looked
  up, and so is every path on macOS.
- Names and paths compare in Unicode NFC.
- `rebuild C:\` no longer matches nothing. `rebuild <folder>` and the API read a bare drive the
  same way on every system: `C:`, `C:\` and `c:/` are that drive's root, a trailing separator is
  dropped, and a relative folder is made absolute against the current one. On Linux and macOS
  `C:` used to become `<cwd>/C:\`. planFolder() returns `folder`, the folder as it understood
  it. A name without a folder is shown as `<name> (folder unknown)` and restored under that
  name; `show` prints a copy's note.
- A source module that fails to load keeps its own id, so `--source recycle` still works: the
  source is listed as failed (`could not be loaded: ...`) instead of the whole command failing
  with `Unknown source`, and its places are still kept from restore.
- An absolute POSIX path, one starting with `/`, separates on `/` only: a backslash in it is part
  of a file name, as on Linux and macOS, whichever system this runs on. A Linux file named
  `x\y.txt` is restored under that whole name (`x_y.txt` on Windows), rebuild no longer makes a
  folder of it, and a name search treats it as one name. A backslash typed in a pattern is still
  a separator, and Windows and UNC paths take either.
- `rebuild` prints what the sources noted -- a part they could not read, a whole drive a shadow
  copy is not walked for -- and its `--json` output carries them as `sources`. A mistyped
  `--location` is refused before anything is searched.
- `--help` lists `--binary`, says that `--json` applies to `find` and `rebuild`, and gives
  examples of `--location` for several sources.
- The detailed description of each source moved to `docs/sources.md`, which the package now
  includes; each source's section ends with the places `--location` takes for it.

## 0.2.0 (unreleased)

- `rebuild <folder> --to <dir>` brings back everything that was below a folder, taking the
  newest surviving copy of each file from any source and recreating the tree in a new folder.
  `--dry-run` shows the plan without writing; `--deleted-only` fills in only what is missing.
- Antigravity is a source. Files its agent wrote come back whole; files it read in full are
  rebuilt from its numbered view and kept only when they match the byte count it recorded.
  On the machine this was written on, 105 of 113 whole-file reads rebuilt exactly, and 57 of
  the 58 whose file was unchanged matched the file on disk; the other was that file without its
  UTF-8 byte order mark, which the view drops.
- A file as it was before a Claude Code write or edit is dated a millisecond before that
  change, so the state after the change is the newer one wherever copies are compared.

## 0.1.0 (unreleased)

First version.

- `find`, `show`, `restore` and `sources` commands.
- Four sources: the Windows Recycle Bin (including files inside deleted folders), editor Local
  History for VS Code and every editor built on it, Claude Code transcripts and backups, and
  git (index, every committed version including reflog-only commits, and unreachable blobs
  for a search by content).
- The same content under the same name is one result; IDs are derived from content, so they
  stay the same between runs.
- Nothing is written except by `restore`, only under `--to`, never inside a searched
  location, and never over an existing file.
