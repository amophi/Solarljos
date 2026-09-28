# How each source is read

What Solarljos reads in each place, what it checks before it offers a copy, and what was measured
on the machine it was written on. The short version is in the [README](../README.md#what-it-searches).

Every copy carries a *kind*, shown under FOUND IN. The kinds, and how rebuild ranks copies of the
same file against each other, are listed in [src/quality.js](../src/quality.js).

Each section ends with what the source finds on its own and, after "Given by hand:", the places
it takes from `--location <id>=<place>` and its own options. Places given are added to the ones
found, except for git; `--no-discover` leaves out what would be found. `--location` with an id
that is not one of the twelve below (or `repos`, an older name for `git`), or with nothing after
the `=`, is a usage error, exit code 2.

## Recycle Bin

Every deleted item is a pair: `$I<id>` holds the original path, size and deletion time, and
`$R<id>` holds the item -- a file, or a folder with everything in it.

```
$I, version 2 (Windows 10 and later)     $I, version 1 (Vista to 8.1)
  0  int64    version = 2                  0  int64    version = 1
  8  int64    size                         8  int64    size
 16  FILETIME deleted at                  16  FILETIME deleted at
 24  uint32   path length, in characters  24  UTF-16   path, 520 bytes, NUL-padded
 28  UTF-16   path
```

On the machine this was written on, all 138 items in the Recycle Bin were version 2. Other
accounts' folders cannot be read without administrator rights; they are reported, not
skipped silently.

A deleted junction or symbolic link goes into the bin as the link itself, so its `$R` still
points wherever the link did: a folder that was never deleted, or a drive's root. Nothing is read
through one, since what lies there would be offered as deleted. Such an item is skipped, and so
is a `$I` that is a link, a link or junction inside a deleted folder, and, on Windows, any other
entry there that the folder listing reports as a link, such as a cloud placeholder. Each account
folder that has any gets one note, which ends in
`link(s), junction(s) or special file(s) skipped; they hold no file`, and `solarljos sources`
leaves them out of its count. A file inside a deleted folder is looked at again, without
following links, just before it is offered. An account folder that is itself a link is not
read, and the notes say so.

A deleted folder is read level by level from its top, up to 200,000 entries. When it holds more,
what lies deepest is left unsearched and a note says so; restoring the folder itself still copies
all of it. On the machine this was written on, 23 deleted folders held 16,657 entries in all, the
largest 11,178, the deepest 12 levels down. In a rebuild only the part of a deleted folder on the
way to or below the folder being rebuilt is read.

Found on its own, on Windows: `<drive>:\$Recycle.Bin` on every drive from C: to Z:.

Given by hand: `--recycle-dir <dir>` or `--location recycle=<dir>`, either one repeatable. The
place is a `$Recycle.Bin` folder, whose account folders are each read, or one account's folder,
which is any folder holding `$I` files. It is read the same way on any system, so a Windows drive
can be searched from Linux.

## Editor Local History

`User/History/<folder>/entries.json` names the file (`resource`, a URI) and lists each saved
copy (`entries[].id`, `timestamp`), which sits next to it under that id. The folder outlives the
file.

Found on its own: `User/History` in every app folder under `%APPDATA%` on Windows,
`~/Library/Application Support` on macOS, and `$XDG_CONFIG_HOME` (normally `~/.config`) on Linux.

Given by hand: `--history-dir <dir>` or `--location history=<dir>`, either one repeatable. The
place is the `History` folder itself, the one whose subfolders each hold an `entries.json`.

## Unsaved editor buffers

VS Code, and every editor built on it, keeps the text of each buffer with unsaved changes in
`<app data>/<editor>/Backups/<window>/<scheme>/<name>`, so that quitting does not lose it. Every
app folder with that layout and a `User` folder beside it is searched; HeidiSQL's `Backups`,
which has none, is not.

```
<uri> {"mtime":...,"ctime":...,"size":...,"etag":"...","orphaned":false,"typeId":""}
<the buffer's text, UTF-8 with no BOM>
```

- `<scheme>` is the URI's scheme (`file`, `untitled`, `vscode-userdata`, ...). `<name>` is VS Code's
  32-bit hash of the file's path, or of the URI for other schemes. A backup is offered only when
  both are what the editor would make from the URI inside it. It must also belong to a text buffer
  (`typeId` empty; notebooks and custom editors store their own data, and a custom editor's backup,
  known by its scheme and header, holds the header alone) and its text must be valid UTF-8. What
  fails is left out, and the search says how many and why.
- `orphaned: true` means the file was deleted while it was open, and the copy's note says so. The
  other fields describe the file on disk when the editor last read it, not the backup.
- A plain untitled buffer (`Untitled-1`) has no path. It is offered only to a search by content
  alone, like git's unreachable blobs. One opened for a file that does not exist yet carries
  that path.

A backup records no length or checksum, and the editor truncates it before writing, so a crash
mid-write can leave one cut short. The one sign such a cut can leave is an end that reads as zero
bytes, as NTFS gives when a crash comes after the new size reached the disk and before the data
did; a backup that ends in a NUL byte is left out. Each backup is read whole through one handle,
and left out when its size or time moved while it was read. Every copy here is marked as never
saved and dated by the backup's own time. `rebuild` takes one only for a file no saved copy exists
of. The text is UTF-8 even when the file was in another encoding. The editor deletes a backup
outright, not to the Recycle Bin, when the buffer is saved, reverted or closed.

On the machine this was written on, Antigravity IDE 1.107.0 is the only editor of this kind, and
its `Backups` folder was empty, so no real backup has been read. The reader was checked against
that install's own code: the same header and name hash, all 11 hash values VS Code pins in its
own tests, and 43 of 43 agreements with the bundle's URI and hash functions run in a sandbox.

Found on its own: every `<app>/Backups` that has `<app>/User` beside it, under the same app data
folders as Editor Local History.

Given by hand: `--location editor-backups=<dir>`, repeatable. The place is a `Backups` folder, or
the app folder holding one, such as a portable install's `data/user-data`. A place laid out
otherwise is not walked, and the search says so.

## Claude Code

Two records, both under `~/.claude`:

- `projects/**/*.jsonl`, one transcript per session including subagents. Lines carrying a
  `toolUseResult` can hold a whole file. A Write records what was written, and the file it
  replaced. An Edit records the whole file before it (`originalFile`) along with the old and
  new text, so the file after it can be rebuilt; the replacement is applied as plain text,
  never as a pattern. A Read holds the file when it was read from the first line to the last.
- `file-history/<session>/<hash>@v<n>`, byte-exact copies taken before Claude changed a file.
  The name does not say which file; `file-history-snapshot` and `file-history-delta` lines in
  the transcripts do. A search by content alone also offers the backups no transcript names any
  more, as `claude backup, name unknown`.

Measured on 1,126 transcripts: an Edit carried the file before it in 309 of 643 cases, and in
every one of those the old text was there to apply. When `originalFile` is missing, no
"after" version is offered at all -- a rebuilt file that might be wrong is worse than none.
Text from transcripts is the file as Claude saw it; backups are the bytes on disk.

A search reads all transcripts, but only lines that can carry a file and contain the plain part
of the name are parsed. On the machine this was written on, a search for `package.json` went
through 1,537 transcripts totalling 918 MB in 3.8 to 4.0 seconds.

Found on its own: `CLAUDE_CONFIG_DIR`, or `~/.claude` when that is not set.

Given by hand: `--claude-dir <dir>` once, and `--location claude=<dir>` as often as needed. The
place is a folder laid out like `~/.claude`, holding `projects/` and `file-history/`, such as one
copied from another machine. Every place given is searched together with the one found, unless
`--no-discover`; a place given twice, or given and also found, is searched once. A transcript's
backups are looked for only in its own folder's `file-history`. `solarljos sources` prints one
line per folder.

## Antigravity

Each conversation has its own folder, `brain/<conversation>/`, named by the conversation's id. Inside, `.system_generated/logs/transcript_full.jsonl` holds one step per line. Other folders in `brain/`, such as `tempmediaStorage`, are not conversations. Two kinds of step hold a whole file:

- A `PLANNER_RESPONSE` whose `tool_calls` include `write_to_file`: `TargetFile` and the full `CodeContent`.
- A `VIEW_FILE` step: a header with `File Path`, `Total Lines`, `Total Bytes` and `Showing lines <a> to <b>`, then every line as `<n>: <line>`.

A write counts only once Antigravity reported it done: a `CODE_ACTION` reading `Created file <uri> with requested content.` for the same path, before the next planner step. Measured on this machine, 168 of 184 writes were answered that way. 12 got an error instead, such as "already exists" where the path held other content, and 4 got no answer. Those 16 are left out, and a note says how many. The result's `Completed At` dates the copy.

The file a write leaves is `CodeContent` plus a final newline when it has none. That is measured only for files in the conversation's own folder, where Antigravity keeps its plans and notes. There, 12 of 12 writes without a final newline were one byte longer on disk, and 34 of 34 that ended in one were identical. No write elsewhere without a final newline could be checked. The 3 found here are offered as the agent wrote them, as `antigravity write, final newline unknown`. Every write whose file has not changed since matches it byte for byte: 47 of 47.

A read counts only when it covered the whole file, says so ("The above content shows the entire, complete file contents"), and the text rebuilt from it (numbers stripped, lines joined) has exactly the byte count in its header. Of 113 whole-file reads, 105 pass. The other 8 were cut short by Antigravity itself, and the two checks agree on every read. Neither check can see a UTF-8 byte order mark, which a read drops and does not count. Of the 58 reads whose file has not changed since, 57 match it byte for byte, and the other is that file without its BOM.

Reads and results name files as URIs, where spaces, parentheses and non-ASCII letters show only percent-encoded. Lines are therefore matched on the decoded path: 5 of the 105 reads here cannot be found by the name as typed any other way. A search through all 21 MB of transcripts here takes under 0.1 seconds.

`transcript.jsonl`, beside the full one, cuts long fields short. It is read only when the full transcript is missing, and steps it marks as cut are skipped.

Edits (`replace_file_content`, `multi_replace_file_content`) are not used. Their results carry a diff, so the file after an edit can be rebuilt from an exact copy before it, but it can rarely be confirmed. Of 39 states rebuilt here with every check the diff allows:

- 2 were confirmed by a later whole read, which is offered anyway.
- 13 were confirmed only by the file on disk today.
- None belonged to a file that is now missing.
- One was contradicted by a later read.

Found on its own: every folder in `~/.gemini` whose name starts with `antigravity` and that holds a `brain` folder.

Given by hand: `--antigravity-dir <dir>` or `--location antigravity=<dir>`, either one repeatable. The place is a data folder holding `brain/`, the `brain` folder itself, or one conversation's folder, the one holding `.system_generated`.

## git

- `git ls-files --deleted`: deleted from disk, still in the index. The copy is the blob the index names.
- `git log -z --all --reflog --no-renames --raw --no-abbrev`: every version of a matching path in every branch, stash and reflog entry. `--diff-merges=first-parent` (git 2.31 and later) makes a stash's work show, and `--full-history` is added when a name narrows the log, so that a version kept only on a merged branch is found by its name as it is by `*`. For a deletion, the version in the parent commit is offered.
- `git fsck --unreachable`, only with `--containing` and no name: blobs nothing refers to, such as a file staged and then staged again with other content. Their names are lost, so only content can find them.

Not everything the log names is a file. The commits of git notes are passed over, a submodule's entry names a commit, and an entry `git add -N` made holds nothing; those are skipped. A symbolic link's blob is its target: with `core.symlinks=false` checkout writes that as a small file, which is the copy, and otherwise the working tree held a link, which holds no file, so it is skipped with a count.

A blob is not yet the file. Checkout converts it on the way out: line endings (`core.autocrlf`, `core.eol`, the `text` and `eol` attributes), `ident` and `working-tree-encoding`. So every copy with a path is read through `git cat-file --batch --filters`, which applies the repository's own attributes and config the way a checkout would now. The copy is identified by the converted bytes.

That is wrong for one kind of file: one that another program wrote, with line endings git would not have chosen, and that was committed as it was. git never rewrote it. The index settles this where it can. git records the size of a file on disk whenever it sees the file match its blob (on add, checkout and refresh), and for that blob at that path the size says which form was on disk. When the size fits neither form (mixed line endings, which git evened out on add), the copy is listed as `git, line endings differ`.

Measured on the machine this was written on, where the system config sets `core.autocrlf=true`, over 6 repositories. The raw blobs differed from the files on disk in 5 of them; the sixth sets `eol=lf`. Of 1,327 files in the index and on disk:

- the raw blob equalled the file byte for byte for 200;
- the converted blob equalled it for 1,301;
- with the recorded size choosing between the two, 1,316 matched;
- the other 11 had been edited since.

HEAD gave the same counts. Reading every version made a search for `*` over all six take 4.2 s instead of 1.1 s.

Two things about `--batch --filters` shape how it is read. Each input line must be `<object> <path>`; a bare `<rev>:<path>` stops it with "missing path". The size in each header is the blob's, not that of the converted bytes after it. So each request is followed by a random name that cannot exist, and the output is cut at the `missing` line git prints for that name.

No filter program ever runs. Every driver the config defines is switched off for the call with `filter.<name>.smudge=`, `filter.<name>.process=` and `filter.<name>.required=false`. That includes a driver with an empty name (`[filter ""]`, listed as `filter..smudge`, which the attribute `filter=` selects) and one defined only by `-c` settings in the environment. A required driver that is only emptied makes git stop. `GIT_LFS_SKIP_SMUDGE=1` is set as well. A path under a driver other than Git LFS comes back as git stores it, with line endings converted as checkout would, and is listed as `git, filter not run`; the size the index recorded is not used to choose a form for it. A repository with a driver whose name cannot be written as `-c <key>=<value>` (one holding `=` or a line break) is skipped, with a note.

Git LFS keeps only a pointer in the blob, under 1024 bytes:

```
version https://git-lfs.github.com/spec/v1
oid sha256:<64 hex>
size <bytes>
```

The file itself is in `.git/lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>`, or under `lfs.storage`. A pointer is followed only where its path is under `filter=lfs`, by today's attributes or by those of the commit it comes from (`git check-attr --source`, git 2.40 and later), so one whose `.gitattributes` line was deleted with it is still caught. The object is offered only when its size and sha256 match the pointer; an object over 32 MB has its size checked during a search and its sha256 when it is read. Otherwise, and for a pointer that uses Git LFS extensions or cannot be parsed, the copy is listed as `no content`. At any other path checkout writes the pointer itself, and so the pointer is the copy: it is listed as `git, Git LFS pointer`, with a note naming the object it would be. None of the repositories here had a `.git/lfs` folder; the tests build one.

An unreachable blob has no path, so nothing says how checkout would convert it. It is offered as git stores it, as `git object, name unknown, as stored`; one that is a Git LFS pointer is offered as `git lfs object, name unknown` when its object checks out, and left out otherwise. Blobs over 32 MB are not read during a search; the size shown is git's, before conversion.

Content is identified the way git identifies a blob, taken over the bytes as checkout writes them. A copy found in a repository and the same bytes found elsewhere merge into one row.

git is run by its absolute path, found in the absolute entries of `PATH`, since Windows would otherwise run a `git.exe` at the top of the repository being searched. It runs with `GIT_OPTIONAL_LOCKS=0`, so reading does not refresh the index, and `GIT_NO_LAZY_FETCH=1`, so a partial clone does not fetch what it lacks from its server; those versions are left out, with a note, and with git before 2.44, which ignores the variable, a partial clone is not read at all. Trace output is switched off, and inherited `GIT_TRACE*` variables are dropped.

Variables that tie git to one repository are not passed on, in any letter case. They are the ones `git rev-parse --local-env-vars` lists, which git itself drops before it runs a command in a submodule: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_IMPLICIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CONFIG`, `GIT_GRAFT_FILE`, `GIT_SHALLOW_FILE`, `GIT_NO_REPLACE_OBJECTS`, `GIT_REPLACE_REF_BASE` and `GIT_PREFIX`. Inherited from a hook, a script or a dotfiles setup, `GIT_DIR` alone makes every folder read as that one repository: with it set to one test repository, a search of another listed the first one's files as its own deleted files, which a rebuild would write, and none of its own history. `GIT_CONFIG` would have the lookup of filter drivers read only that one file, so a driver in `.git/config` would not be switched off and would run. Settings given with `-c` (`GIT_CONFIG_PARAMETERS`, and `GIT_CONFIG_COUNT` with `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`), `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_CEILING_DIRECTORIES` and the rest are still passed on. Since `GIT_NO_REPLACE_OBJECTS` and `GIT_REPLACE_REF_BASE` are dropped too, git's default handling of `refs/replace/*` applies in every repository.

Restore and rebuild stay out of each repository's git folders, its Git LFS store, and the object folders it borrows through `objects/info/alternates` (a clone made with `--shared` or `--reference`). The working tree is not protected: that is where a file is usually put back. Object folders named by `GIT_OBJECT_DIRECTORY` or `GIT_ALTERNATE_OBJECT_DIRECTORIES` in the environment are not read, so they are not protected either.

Found on its own: nothing. With no place given, the current folder is searched, unless `--no-discover`, in which case no repository is.

Given by hand: `--repo <dir>`, `--location git=<dir>` and `--location repos=<dir>` are the same, and all of them are repeatable and add to each other. Any of them replaces the current folder. Each place is searched for repositories: the place itself, every folder up to two levels below it (not `node_modules`, nor a folder whose name starts with a dot), and the repository the place is inside. A place that is not a folder is skipped, with a note. A repository reached twice, by another letter case or through a link, is searched once.

## Volume Shadow Copies

A shadow copy is a read-only, point-in-time image of a whole volume, kept by the same mechanism
as System Restore. Windows exposes each one as a device:

```
\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyN
```

Inside it the volume looks exactly as it did when the snapshot was taken: `C:\a\b.txt` is at
`<device>\a\b.txt`, with that file's own size and time, and its bytes are the bytes that were on
disk. A copy from here is exact by construction -- there is nothing to rebuild.

Listing snapshots the documented way (`vssadmin`, or WMI's `Win32_ShadowCopy`) needs an
administrator prompt, and its text is localized. But *reading* one is not gated by elevation --
it is governed by each file's own ACL. So this source never shells out, which also keeps it from
writing anything: every start of `powershell.exe` rewrites a file in the user's profile. Instead
it probes device numbers 1 to 1024 with `readdirSync(<device>\)` -- a present device lists, an
absent one is `ENOENT`, and a present device root answers `statSync` with `EISDIR`, so `readdir`
is used, not `stat`. Numbers keep climbing as snapshots are made and pruned and are not reused
promptly, so a fixed ceiling is needed; 1024 sits far above the handful a client keeps, and
probing to it took about 6 ms here (to 4096, about 23 ms). Each snapshot is tied to its live
drive by volume serial: `stat(<snapshot>\<top folder>, {bigint}).dev` equals the drive's. When
several drive letters share the serial (a `subst` drive, a cloned disk), the one whose folder of
the same name has the same file ID as one of the snapshot's top folders is taken; a snapshot that
matches no letter, or more than one, is skipped rather than guessed at.

A whole snapshot is never walked. For `rebuild <folder>` the folder is mapped into each snapshot
on the matching drive and only that subtree is read; a drive's root is not walked at all, and
the notes say so. A name search runs after the other sources
and looks only where they point: at the files directly in each folder where they found something,
and at everything below the current user's Desktop, Documents and Downloads and any
`--location vss=walk=<folder>`, skipping `AppData`, `node_modules` and `.git`. So `--source vss`
on its own, or with sources that found nothing, looks through those folders only, and a file
elsewhere is not found in any snapshot. Walking the three user folders inside one snapshot here
(25,820 files under them) took about 0.3 to 0.7 seconds; a walk stops after 50,000 folders, with
a note saying so. `Windows`, `System Volume Information` and any `System32\config` are
never read.

Windows resolves a junction or an absolute symbolic link inside a snapshot against the live
drive, so reading through one gives today's files: measured here, `Users\<user>\My Documents`, the
old junction to `Documents`, led to the live `package.json` in both snapshots, one of which never
had the file. So each step of a folder's path below the snapshot's root is checked before the
folder is read. A link that is relative, or points to the snapshot's own drive, is followed by
hand inside the same snapshot; any other one, or a `..` in the path, gets the folder skipped with
a note. Links among a folder's entries are never followed.

The snapshot's own creation time cannot be read without administrator rights, so each copy's time
is the file's own mtime; an approximate snapshot time (the newest mtime seen) is kept for notes
only. A cloud placeholder (OneDrive Files-On-Demand) is a reparse point, and a folder listing
reports every reparse point as a link (29 of 29 AppExecLink files in `WindowsApps` here), so
placeholders are skipped with the links and never offered; no cloud file was tried on this
machine. Every file offered must also open and give its last byte. That catches a file whose data
cannot be read, such as one whose ACL allows reading only its attributes, but not bytes that are
missing, since the size `stat` gives is where the file ends; files that fail are skipped and
counted.

Measured on this machine: two snapshots were readable without elevation, both mapping to C:. In
one of them an older `package.json` of this project was found -- 809 bytes against 854 live, a
different blob -- read back at its full length; it was absent from the other. A `rebuild`-style
search over the project folder returned 22 rows across the two snapshots in 33 ms.

Found on its own, on Windows: every shadow-copy device from 1 to 1024 that lists.

Given by hand: `--location vss=<entry>`, repeatable, in one of three forms.

- `vss=<device>`: a shadow-copy device root, `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyN` (or
  the same with `\\.\`), tied to its drive by volume serial like the ones found.
- `vss=<snapshot>=<drive>`: a folder that holds a volume as it stood, and the drive root it stands
  for, `C:\`, `C:` or `C:/`; for example
  `vss=\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy5=C:\`. A folder that is not a device root
  has to be given this way, since every folder on C: reports C:'s serial.
- `vss=walk=<folder>`: a folder, written as a Windows path, to walk in every snapshot of its drive
  during a name search, as the user's Desktop, Documents and Downloads are.

## Windows Notepad

Windows 11 Notepad keeps every open tab, saved or not, in
`%LOCALAPPDATA%\Packages\Microsoft.WindowsNotepad_8wekyb3d8bbwe\LocalState\TabState\`, one
`<guid>.bin` per tab. Numbers are LEB128 and text is UTF-16 with a lone CR for each line break. A
big-endian CRC32 covers the header, and one covers each entry of the edit log that follows it:

```
"NP", sequence number
type          1 = tied to a file, 0 = untitled
if a file     path, size on disk, encoding, line ending, last-write FILETIME, SHA-256
then          selection, options, the text, "unsaved" flag, CRC32
edit log      position, characters deleted, characters added, added text, CRC32 -- to the end
```

- Before Notepad 11.2408 a file tab holds the file's text even when nothing changed. It is written
  out with the tab's line ending and encoding, and offered only when it has exactly the recorded
  size and SHA-256. Then it is the file as last saved, dated by the recorded time.
- From 11.2408 an unchanged file tab holds only its path. A changed one holds the edited text,
  which was never on disk. It is offered as unsaved edits, marked as never saved and dated when
  the tab file was last written, in the tab's own encoding and line ending. `rebuild` takes it
  only for a file with no saved copy anywhere.
- An untitled tab has no name, so only `--containing` with no name finds it.
- The edit log is replayed only onto text known to be the whole buffer. Every entry must pass its
  CRC, and the last one must end exactly at the end of the file. A tab that fails any check gives
  nothing, and the list says how many were left out.
- `<guid>.0.bin` and `<guid>.1.bin` hold only the caret and options, and are not used.
  `<guid>.bin.bak` is read like any tab.
- ANSI means the code page of the machine that saved the file. So unsaved ANSI text beyond ASCII
  comes back as UTF-8, and its note says so.

Measured on this machine (Notepad 11.2607), all 22 non-empty files parsed and every checksum passed:
13 tab headers, 4 log entries and 9 state files. 9 tabs were tied to a file. 7 of those held only
the path, and the 2 with unsaved edits recorded the size and last-write time of the file on disk
exactly. The other 4 were untitled. One of them was a tab no longer open, whose text was left only
in the edit log of a `.bin.bak`. A search by name finds the 2 unsaved edits, and a search by
content alone reaches the 4 untitled tabs too. Reading all 31 files takes a few milliseconds.
On 23 public sample tab files from older versions, all 13 saved copies hashed to the SHA-256
Notepad recorded, and all 80 log entries passed their CRC.

Found on its own, on Windows: `%LOCALAPPDATA%\Packages\Microsoft.WindowsNotepad_*\LocalState\TabState`.

Given by hand: `--location notepad=<dir>`, repeatable, which is how another machine's tabs are
searched. The place can be any folder on the way down from a user profile to the tab files,
`<profile>\AppData\Local\Packages\Microsoft.WindowsNotepad_<id>\LocalState\TabState`: the profile,
`AppData`, `AppData\Local`, `Packages`, the `Microsoft.WindowsNotepad_*` package folder,
`LocalState` or `TabState`, for example `notepad=D:\old\Users\me\AppData\Local`. So can any folder
that holds `<guid>.bin` tab files directly, whatever its name. A folder above the profile, such as
`Users` or a drive's root, finds nothing. A place that leads to no TabState folder gets a note in
the search, `<place>: no Notepad TabState folder there`; a TabState folder with no tab files in it
gets none.

## JetBrains IDEs

Every JetBrains IDE keeps one system folder per version, and so does Android Studio. On Windows it is `%LOCALAPPDATA%\JetBrains\<product><version>` or `%LOCALAPPDATA%\Google\AndroidStudio<version>`. macOS uses the same names under `~/Library/Caches`, and Linux under `~/.cache`. Two things in it hold whole files:

- `caches/`, the IDE's cache of every file it has read or written. `records.dat` has one 40-byte record per file: parent, name, flags, content id, mtime and length. `names.dat` holds the names. `content.dat` holds the bytes, each stored with a SHA-1 of them, and anything over 8,000 bytes is compressed as LZ4. A file deleted in the IDE only has its flags overwritten, so its name, parent and content stay until the caches are invalidated.
- `LocalHistory/`, about five days of changes. For every change it holds the file as it was before, and for every deletion the whole deleted tree. Both point by id into `content.dat`.

A copy is offered only when its record is committed, decompresses to exactly its stated size and matches its SHA-1. A cached file must also have the length its record states and no flag saying the cache is out of date. It is offered only when the file is gone from disk or no longer the same. Local History is read only while it belongs to the cache beside it, which is the same test the IDE itself applies.

Local History can hold an editor's text of a file instead of its bytes: LF line ends and no BOM. A version is therefore listed as `jetbrains history, as text` unless its bytes prove they came from disk. The proof is a CR before an LF, a UTF-8 BOM, or the same content recorded in the cache for that path. A CR on its own proves nothing, and neither do bytes with a NUL in them and no BOM: UTF-16 without a BOM, which is how the text of a UTF-16 file is kept, can hold a 0x0D byte inside another character. Bytes that start with a UTF-16 BOM, and bytes of a file the cache holds as UTF-16 with a BOM, are read as UTF-16 before the CR is looked for. An `as text` copy counts as saved but not provably exact, so rebuild takes an exact copy of the same file from any source over it, even an older one. Text dated after the newest mtime the cache saw of that file on disk, or a deleted file's text stamped once its change set had begun, came from an editor whose changes were never saved: it is a draft, which rebuild takes only when no saved copy is left.

A content id can go stale: when the IDE sees a file change on disk without reading it, it records the new mtime and length and keeps the old content. A record flagged to be reloaded is not read. A copy whose bytes Local History had already recorded at that path, with nothing else recorded there in between, is dated by that first sighting, and its note says so.

Some paths are never looked at: `\\wsl$` and `\\wsl.localhost` (a look starts a stopped WSL distro, which then writes to its disk image), WebDAV shares, and A: and B:, which can stall. Their copies are left out, with a count. Any other file share is asked once whether it can be reached, and when it cannot, its cached files are offered without being compared with the files there. A file with less space on disk than its size may be a cloud placeholder that reading would download, so it counts as changed rather than being read to compare.

Layouts from platform 241 (2024.1) on are read. Anything else is reported by `solarljos sources` and left alone.

Measured on the machine this was written on (Android Studio, platform 261):

- All 5,149 content records matched their SHA-1, 732 of them LZ4.
- All 285 Local History change sets read to the byte.
- All 1,612 cached local files matched their SHA-1 and recorded length, and none was marked out of date.
- All 1,478 files still on disk with the recorded size and mtime were the same byte for byte.
- 99 cached files are gone from disk, all of them compiled `.class` files: 53 deleted in the IDE and 46 after it last looked. 34 cached files were older than the file there now.
- Local History had 12 versions with content. 10 hold a CR before an LF; the other 2 are empty. None was a draft.
- A search for everything took about 0.15 seconds.

Found on its own: every system folder under `<caches>/JetBrains`, and every `AndroidStudio*` one under `<caches>/Google`, where `<caches>` is `%LOCALAPPDATA%`, `~/Library/Caches`, or `$XDG_CACHE_HOME` (normally `~/.cache`).

Given by hand: `--location jetbrains=<dir>`, repeatable. The place is a system folder (one holding `LocalHistory/changes.storageRecordIndex` or `caches/records.dat`), its `LocalHistory` or `caches` folder, or a folder holding system folders, such as a `JetBrains` or `Google` folder copied from another machine. For example `jetbrains=D:\old\Users\me\AppData\Local\Google\AndroidStudio2026.1`.

## Eclipse Local History

Eclipse keeps each version a file had before Eclipse replaced it through its workspace. The Java language server (redhat.java) that VS Code and its forks run is Eclipse underneath and does the same. It keeps one workspace per folder opened, at `<app data>/<editor>/User/workspaceStorage/<hash>/redhat.java/jdt_ws`, plus `ss_ws` for its syntax server.

Under `.metadata/.plugins/org.eclipse.core.resources/`:

- `.history/<bucket>/<uuid>` is one version, a plain copy of the file's bytes.
- `.projects/<project>/.indexes/**/history.index` covers the files of one folder. For each version it gives the uuid and the modification time the file had then.
- `.projects/<project>/.location` says where the project is. Without it, the project is `<workspace>/<project>`. Linked folders and files in the project's `.project` are followed when their location is a path, or is relative to the project or the workspace; a link through any other path variable, `PARENT_LOC` included, is not, and its versions count as having no name.

```
history.index
  byte     version = 2
  int32    number of files
  per file:  uint16 + modified UTF-8   path below the project, /src/A.java
             uint16                   number of versions
             per version: 16 bytes    uuid, the state file's name
                          int64 LE    modification time, ms
```

There is no size and no checksum. Three checks stand in for one:

- An index must read to its last byte.
- Each path must hash to the folder its index sits in.
- A state file must still have the modification time the index recorded. Eclipse copies that time onto it.

A version whose state file is missing or fails the time check is left out. A version whose path fails its check, or whose link cannot be followed, is offered only in a search by content, with no name. So are state files that no index names, and versions of a project or link on a network path outside the workspace, which is not looked at, since one look at a server that is gone can hang for minutes.

Measured on the machine this was written on:

- 30 language-server workspaces, 13 with any history.
- 9 index files, all version 2 and read to the last byte.
- All 17 paths sat in the folder their hash gives.
- All 52 versions named were present, each with exactly the recorded modification time.
- All 52 are `.settings/*.prefs` files the server rewrote itself. It hands source edits to the editor, and the `.classpath` and `.project` it writes have no history. So from the language server this brings back settings, not code.
- Eclipse itself keeps a version on every save, but that was not measured here: there is no Eclipse workspace on this machine.
- 22 of the 74 state files are named by no index, all of them in the 4 workspaces that have no index file.

The server keeps a project's `.project`, `.classpath` and `.factorypath` in its own `.projects/<project>/` when the project folder does not have that file, and a `.settings/<name>.prefs` there when the project folder has no `.settings` folder at all (`JLSFsUtils.shouldStoreInMetadataArea` in org.eclipse.jdt.ls.filesystem). Such a path is taken as the server's copy when that rule sends it there and the server's copy was written after the newest version was kept, since a copy last written before cannot be where that history came from. Otherwise it is taken as the project folder's file. Of the 17 paths here, 7 were only in the project folder, 4 only in the server's copy, and 6 in both; in one of those 6 the server's copy is older than the newest version. All 52 versions come out at the same place by this rule as by the looser one of taking the server's copy whenever the project folder lacks the file. A whole search of all 30 workspaces took about 25 ms.

Restore and rebuild refuse only each workspace's `.metadata`, and the real folders behind its `org.eclipse.core.resources`, `.history` and `.projects` when any of those is a link or junction to another place. Nothing else below a workspace is read from -- a project's own `.project` is read only to place its paths -- so a file can be put back into a project in `~/eclipse-workspace`, or into the workspace itself. A place given above a workspace protects only the `.metadata` of each workspace found under it, and a place with no workspace under it protects nothing.

Found on its own: every language-server workspace with a `.history` folder, under the same app data folders as Editor Local History, and `~/eclipse-workspace` when it has one.

Given by hand: `--location eclipse-history=<dir>`, repeatable. The place is a workspace, its `.metadata`, its `.metadata/.plugins/org.eclipse.core.resources`, or a folder up to five levels above a workspace, such as an editor's data folder or a user profile on another drive; folders whose names start with a dot, and `node_modules`, are not gone into. Every workspace found is searched. A place with none gets a note, `<place>: no Eclipse workspace there`.

## Hancom Office

Hwp (한/글) keeps two kinds of whole copy of a document:

- `<temp>\Hwp<version>\<name>.asv`, an autosave. Hwp rewrites it every few minutes while the document is open (every 10 on the machine this was written on) and deletes it when it exits normally, so one is left behind by a crash, a forced shutdown or a killed process. `<version>` is 80 for Hwp 2010, which names `${Temp}\Hwp80\` itself. Hancom's developer forum gives 120 for 2022 and 130 for 2024. Every `Hwp<digits>` folder in the temp folder is read. Hwp 2010 writes an autosave with its ordinary save routine, in its own format, so an `.asv` is a complete HWP document. It carries the document's name, but nothing in it records the folder.
- `<name>.bak` beside the document, when backups are turned on. Saving `<name>.hwp` first turns the version on disk into `<name>.bak`, so a backup holds the bytes that were on disk before the last save.

`%APPDATA%\HNC\Office\Recent` holds a shortcut for every document and folder opened lately. Those folders are searched for backups, and they are where an autosave gets its folder. When exactly one recent document of the same user profile has the autosave's name and format, the autosave is listed under that document's path, and its note says where the folder came from. Otherwise its path is left empty rather than guessed. A shortcut's absolute path is in the ANSI code page, which the shortcut does not name, so its Unicode relative path is used instead unless the absolute one is plain ASCII. On the machine this was written on, the two named the same file in all 62 shortcuts.

A copy is offered only when it proves whole:

- HWP 5, a compound file (`D0 CF 11 E0`), must pass all of these:
  - the file is whole sectors;
  - every sector chain stays inside the file, is exactly as long as its stream, and shares no sector with another;
  - a `FileHeader` stream says `HWP Document File`, version 5;
  - `DocInfo` and every `BodyText/Section<n>` inflate and split into records that end exactly where the stream ends, with as many sections as `DocInfo` counts;
  - every embedded item `DocInfo` lists is present, and inflates where `DocInfo` says it is compressed.

  Encrypted and distribution-only documents cannot be read inside, so they get the compound-file checks only.
- HWPX, a zip: every entry inflates to its recorded size and CRC-32, and `mimetype` reads `application/hwp+zip` beside `Contents/header.xml` and `Contents/section0.xml`.

A `.bak` holding anything else belongs to another program and is passed over. One in the HWP 3 format is left out and counted in the source's notes, since nothing in that format can check it.

Each file is opened once, read-only, and only what the folder listing reports as a plain file, so a cloud placeholder is not opened. The bytes offered are the bytes that passed the checks, and a file whose size or time moved while it was read is left out.

Restore and rebuild refuse the places themselves -- the temp and `Recent` folders, or a folder given -- but not the document folders the shortcuts lead to, since that is where a document is put back beside the others.

Measured on the machine this was written on, which runs Hwp 2010 with backups off:

- `Temp\Hwp80` existed and was empty, and there was no `.asv` and no HWP `.bak` anywhere in the user profile. No real autosave or backup has been read yet.
- The checks passed on all 71 documents on the Desktop and in Downloads: 65 `.hwp` and 6 `.hwpx`, 151 MB, read and checked in 0.6 seconds.
- Of 426 copies of those documents cut short at six points each, 425 failed. The one that passed had lost only a free sector at its end, with every stream still whole.
- HWP 5 carries no checksum, so a changed byte is caught only when it breaks the structure: 119 of 1,300 were. In `.hwpx` files, 120 of 120 were.

Found on its own, on Windows: every `Hwp<digits>` folder in the temp folder, and every folder named `Recent` up to three levels below `%APPDATA%\HNC`.

Given by hand: `--location hancom=<dir>`, repeatable. The files in the place itself are read, not those in folders below it: `.asv` autosaves, `.bak` backups, and `.lnk` shortcuts, whose documents' folders are then searched for backups too. So a place is Hwp's temp folder, a `Recent` folder, or a folder of documents. An autosave is matched only with shortcuts of the same user profile, the part of the path before `\AppData\`, so for a drive from another machine give both its `AppData\Local\Temp\Hwp<version>` and its `AppData\Roaming\HNC\Office\Recent`. The Windows paths in shortcuts are looked up only on Windows.

## Trash (Linux)

Linux desktops follow the freedesktop.org Trash specification. Each deleted item is a pair inside a trash folder. `files/<name>` holds the item itself: a file, or a folder with everything in it. `info/<name>.trashinfo` says where it was and when it went:

```
[Trash Info]
Path=/home/me/work/plan%20B.txt      percent-encoded bytes; absolute, or relative to the drive
DeletionDate=2026-09-20T12:30:05     local time, no zone
```

These trash folders are searched:

- `$XDG_DATA_HOME/Trash`, normally `~/.local/share/Trash`.
- A snap's own trash, `~/snap/<app>/<revision>/.local/share/Trash`. This is where VS Code's snap puts what it deletes.
- On every drive listed in `/proc/self/mounts`: `.Trash-<uid>`, and also `.Trash/<uid>` when `.Trash` is a real folder with the sticky bit and `<uid>` belongs to the user, as the spec requires. System, image and network file systems are skipped, because one stat of a server that is gone can hang. A network drive can be given with `--location trash=<mount point>`.
- On Windows, nothing unless given. A drive used on Linux is read with `--location trash=E:\`, and paths recorded relative to the drive come out as `E:\docs\a.txt`. The macOS Trash is not read yet.

Files inside a trashed folder are found one by one, dated when the folder was deleted. The name in `files/` is never taken for the original name. The spec forbids it, and npm's `trash` names items with a UUID. Some items have no usable name: no record at all, a record that cannot be read, or a path that climbs with `..`. Those are offered only to a search by content, with no name. A trashed link is skipped, not followed. A record whose item is gone shows as `no content`. A trash whose `files` folder is a link is not read at all, and one whose `info` folder is a link offers what is in `files` to a search by content only; the notes say so.

The format has no size and no checksum to check a copy against. What is in `files/` is the file itself. GLib only ever renames into the trash. The tools that copy across drives (KIO, send2trash, npm's `trash`, the Rust `trash` crate) delete the original only after the copy is complete. Only a machine that stopped in the middle of such a copy could leave a short file, and nothing would show it.

`DeletionDate` has no zone. It is read in this machine's time zone, the way Nautilus and KDE read it, unless the `.trashinfo` file's modification time shows the zone it was written in. Every writer writes that file within a second after the date it puts in it, so when its time keeps a fraction of a second and lies a whole number of quarter-hours, up to 14 hours, from the date, the date is read in that zone, and an hour that happened twice is settled too. A time in whole seconds shows nothing, since FAT keeps local times in two-second steps and a copy by tar or zip drops the fraction; a drive from another time zone that went through such a copy is off by the difference. A date more than 26 hours ahead of now is taken for no date. Sometimes there is no usable date: the Rust crate can leave the line out, and GLib writes the placeholder `9999-12-31T23:59:59` when there is no clock. The time the `.trashinfo` was last written is then used instead, and the copy's note says so.

The machine this was written on has no trash folder of this kind: one NTFS drive, no WSL. The source is therefore tested against fixtures built to the rules of six writers, read from their source code: GLib, KIO, trash-cli, send2trash, npm's `trash` and the Rust `trash` crate. On a synthetic trash of 2,000 items plus a trashed folder of 10,000 files, a name search took 0.18 s.

Found on its own, on Linux: the trash folders listed above.

Given by hand: `--location trash=<place>`, repeatable. The place is a trash folder itself -- one named `Trash`, `.Trash-<uid>` or `.Trash/<uid>` holding `info/` or `files/`, or any folder holding both -- or a folder that holds some: a data folder (`<place>/Trash`), a home folder (`.local/share/Trash` and every snap's), or a drive or mount point (`.Trash-<uid>` and `.Trash/<uid>`, for any user). A shared `.Trash/<uid>` that fails the spec's checks is reported instead of read, and is read when it is given itself.
