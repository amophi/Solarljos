# Solarljos

Solarljos finds files you have lost -- deleted, or saved over -- by looking in the places where
Windows and your programs keep copies of files on their own, and brings back the ones you choose.

It can help when:

- a file is gone, even from the Recycle Bin;
- you saved over a file and want the version before;
- a whole folder was deleted;
- photos were deleted long ago -- though often all that is left of one is a smaller copy;
- files were deleted from a memory card or a USB stick, or it was formatted by mistake.

It cannot help when nothing on the computer ever kept a copy of the file. And it does not search
the free space of the computer's own drive: on most computers that is an SSD, which erases the
space a deleted file took soon after the file is deleted, so there is nothing left there to find.
Memory cards and USB sticks usually do not erase it, and those it can search.

It changes nothing on the computer: the only files it writes are the ones you choose to restore,
into the folder you choose. (The browser window it opens is your browser's own, and writes what
that browser writes; see below.)

It is available in 18 languages; see [Languages](#languages).

**On Windows, download [`Solarljos.exe`](https://github.com/amophi/Solarljos/releases/latest)** --
one file, nothing to install -- and double-click it. Do not save it on the drive, the card or the
stick you lost files from.

## Using the program

1. **Download** `Solarljos.exe` from the
   [latest release](https://github.com/amophi/Solarljos/releases/latest). It is one file of about
   110 MB that carries everything it needs, Node.js included: nothing is installed, and nothing is
   written beside it.
2. **Keep it off the drive you lost files from**, and restore onto another drive if you can:
   writing to the drive the files were on can overwrite what is left of them. Never copy it, or
   anything else, onto a memory card or USB stick you want to recover. Slide an SD card's lock
   switch to *Lock* before you put it in, since Windows and other programs may write to a card as
   soon as it is in.
3. **Double-click it.** It is not signed, so Windows SmartScreen asks first: *More info*, then
   *Run anyway*. Where Smart App Control is on, Windows refuses it; *Running it from the source*
   below gives the same program.
4. **Its page opens in a browser window**, and no other window opens. Choose what you lost --
   *Find a file* by its name, a word it contained or its kind, *Photos and videos* in a grid by
   month, or *Bring back a folder* -- and each copy found says where it was found and how far it
   can be trusted: *Exact copy*, *Inexact copy*, *Never saved*, *May be incomplete*, *Smaller
   copy*. A copy can be previewed before anything is written. *Restore* asks for a folder and
   checks it first: it will not write inside a place copies are read from, asks before it writes
   onto the drive a file was on, and suggests another drive when there is one. Each part of the
   page keeps what it showed while you use another, and *Language*, below the list of places on
   the left, changes the language of the page.
5. **Close the window**, or press *Quit*, when you are done. Solarljos stops 3 to 30 seconds after
   its page goes, and by itself 10 minutes after it started if no window ever connected. It does
   not stop in the middle of a restore: one being written finishes first.

What is written:

- **By Solarljos**, nothing but the files you restore, in the folder you choose. It keeps no
  settings, history, log or cache; what it found lives in its memory until it stops. It starts no
  program but the browser window, git and `mountvol.exe` while searching, which only read, and,
  as a last resort, `cmd.exe`: when no browser window could be opened, when an error stopped it
  before its page opened, or when it was given arguments with nowhere to print, nothing it printed
  would be seen, so it says what it has to say in a console window titled *Solarljos*. That
  cmd.exe is started with `/d`, which skips the AutoRun commands the registry may name, and writes
  nothing. It does not open Explorer to show what it restored, since that would make new
  thumbnails in the very cache a search for photos reads.
- **By the window**, what the browser writes. Where Microsoft Edge is installed, the page opens in
  an Edge InPrivate window, which keeps no history, cookies or cache of the visit; if Edge was not
  already running, it still writes what it writes whenever it starts, its settings and start-up
  files in your profile. Without Edge, when Edge cannot be started, and always when Solarljos runs
  as administrator, the page opens in your default browser, which records the visit in its history
  like any other; the address it records works only once.
- **By Windows itself**, the note it keeps of every program that runs, as for any program.

Explorer's thumbnail cache is read into memory before the window opens, so that nothing the
browser or Explorer adds to it afterwards changes what Solarljos finds while it runs. Explorer adds
thumbnails whenever it shows a folder of pictures, and may drop old ones to make room, and Disk
Cleanup can empty the cache. Until you are done looking for photos, do not run Disk Cleanup, and do
not open folders of pictures in Explorer, restored ones included.

A memory card or USB stick is searched only when you add it: under *What is searched*, at
*Memory cards and USB sticks*, choose *Add a place from another disk...*, and give its drive letter,
such as `E:`, or a disk image of it made with another tool. Reading the card itself needs
administrator rights -- quit Solarljos, right-click `Solarljos.exe` and choose *Run as
administrator* -- and an image needs none.

Given arguments, `Solarljos.exe` is the command line described below. It is a Windows program
without a console, though, so what it prints is seen only when it goes to a program or a file:

```
Solarljos.exe find budget.xlsx | more
Solarljos.exe find budget.xlsx > found.txt 2>&1
```

Typed in a console with nothing redirected -- or with `> NUL`, which goes nowhere -- it prints
nothing and does nothing, but shows a window that says so and how to use the command line.
`solarljos.cjs`, attached to the same release, is the command line alone for Node.js 22 or later:
`node solarljos.cjs find budget.xlsx` prints in the console as any program does.

## Old photos and videos: what to expect

On the computer's own SSD, a deleted photo is erased from the drive soon after it is deleted. What
can be left is another copy of it, and Solarljos looks in each place one may be:

- **The Recycle Bin**, until it is emptied: the photo itself.
- **A restore point** -- a shadow copy of the drive -- when one was made while the photo was there:
  the photo itself, as it was then. Solarljos looks through your Desktop, Documents, Downloads,
  Pictures, Videos and Music, the shared ones in `C:\Users\Public`, your OneDrive and Dropbox
  folders and the folder KakaoTalk saves chat photos into.
- **Explorer's thumbnail cache**: a smaller picture Windows made of the photo when Explorer showed
  it -- never the photo, and always marked *(smaller copy)*. Most are 96 pixels or less, and few
  can be named. On the machine this was written on, a search found 306 of them: 36 of 1,024 pixels
  or more on the long side, 67 of 256 to 1,023 and the other 203 smaller; 31 could be named, by a
  shortcut Windows kept of the file.
- **The Snipping Tool's own folder**, for screenshots and screen recordings it took with saving
  turned off.

A whole old video rarely survives on an SSD anywhere but in the Recycle Bin or a restore point:
Windows keeps at most a still picture of it. On that machine, a search for every picture and video
listed 10,922 copies, and one of them was a video.

A memory card or USB stick with FAT or exFAT on it gets no TRIM, so photos and videos deleted from
it stay until something is written over them, and a quick format, which is Windows' default,
leaves them too. Solarljos can often bring them back whole: by their names when the card still
lists them, by their content when it does not, and it says when a copy may be incomplete. Reading
a card directly needs administrator rights; an image of the card, made with another tool, needs
none. Copy nothing onto the card, `Solarljos.exe` included, and set an SD card's lock switch
before you put it in.

A copy is dated by what its source records -- when it was deleted, last changed or stored -- and not
by when the photo was taken, and a thumbnail usually has no date at all. A copy with no date is
always shown, whatever dates you choose.

Look also where Solarljos cannot: the phone or camera the photos came from, whose gallery may keep
deleted ones for a while; your cloud storage's own recycle bin; the chats and emails you sent them
in; other disks you copied them to.

## Why another recovery tool

Classic undelete tools read the disk sector by sector and rebuild files from what the file
system has not overwritten yet. On a hard disk that works. On an SSD it mostly does not:
when a file is deleted, Windows sends TRIM, the drive discards the blocks, and from then on
they read back as zeros. Most machines today boot from an SSD with TRIM on.

What does survive on such a machine is *other copies* -- in the Recycle Bin, in a restore
point's shadow copy, in the history an editor or an IDE keeps, in an AI coding agent's
transcripts and backups, inside a git repository, in a tab Notepad never saved, in the small
pictures Explorer keeps of what it showed. Each of those has its own tool, or no tool at all, and
nobody looks in all of them at once after the fact. That is what this does. Where reading the disk
itself still works -- memory cards and USB sticks, which get no TRIM -- it does that too, when it is
asked to.

It matters more since coding agents started deleting things. An agent's `rm -rf`, a
`git reset --hard`, a rewritten file -- none of those go through the Recycle Bin, but the
agent's own records usually hold what was there.

## What it searches

| Source | Where | What survives there |
| --- | --- | --- |
| Recycle Bin | `<drive>:\$Recycle.Bin\<account>\` | Deleted files and whole deleted folders, with their original paths and deletion times. Files inside a deleted folder are found individually. A recycled link or junction is skipped, never read through |
| Volume Shadow Copies | `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyN` | The whole volume as it stood when a restore point or snapshot was taken: every file that existed then, byte-exact with its own size and time. Read without administrator rights, one folder at a time -- never a whole snapshot: in a search by name or type, the user's Desktop, Documents, Downloads, Pictures, Videos and Music, the shared ones, OneDrive, Dropbox and KakaoTalk's save folder, and where the other sources found something |
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
| Explorer thumbnails | `%LOCALAPPDATA%\Microsoft\Windows\Explorer\thumbcache_*.db`, named through the shortcuts in `%APPDATA%\Microsoft\Windows\Recent\` | The smaller pictures Windows made of the photos, videos and documents Explorer showed, kept long after the files are gone: never the file itself, and always marked so. One whose key a shortcut hashes to gets that file's path and the time of the version it shows; the rest are listed by a search by type. Also read inside each shadow copy |
| Snipping Tool | `%LOCALAPPDATA%\Packages\Microsoft.ScreenSketch_*\TempState\` | With saving turned off, the screenshots and screen recordings the tool keeps in its own folder, exactly as taken, under the names the tool gave them |
| Cards and USB drives | only what is named with `--location removable=<E: or a disk image>` | On FAT and exFAT, which get no TRIM: deleted files still in their folders, with their names, read from where the file system says they lay and checked by their format's own structure; and, in a search by type, files carved out of free space by their format alone. A drive is read directly, which needs administrator rights; an image of it does not |

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
  No PowerShell is started, since every start of it rewrites a file in the user's profile. The
  programs started while searching only read: git, and `mountvol.exe`, which lists the drives'
  volume names for the thumbnail cache and writes nothing. The graphical front end starts one
  more, the browser window, and *Using the program* lists what that writes. `Solarljos.exe`,
  which has no console, starts `cmd.exe /d` for a console window of its own when what it has to
  say would not be seen otherwise; that writes nothing either, and no text it shows is on
  cmd.exe's command line, so none can act as a command.
- A card, a USB stick or a disk image is opened for reading only. Windows and other programs
  write to a card while it is in, which nothing here can stop: take an SD card out, slide its
  lock switch to Lock and put it back, and save nothing onto it until everything is back.
  `restore` and `rebuild` refuse to write onto the drive being recovered however it was given
  -- a letter, a whole disk such as `\\.\PhysicalDrive1`, a volume or a `/dev` link -- by the
  serial number of each volume on it, and whatever the destination is called. A copy read from
  a card is checked as it is written against what the search read; one that changed since
  fails, and nothing is written under its name.
- `restore` and `rebuild` are the only commands that write, and only under the folder given
  with `--to`. They refuse a folder inside the places sources keep their records in: a Recycle
  Bin, an editor's `User/History` or `Backups` folder, an IDE's system folder, an Eclipse
  workspace's `.metadata`, Notepad's TabState, Hwp's temp and Recent folders, a Claude Code or
  Antigravity folder, a trash folder, a shadow copy, Explorer's thumbnail cache and the Recent
  folder, the Snipping Tool's folders, a card being recovered, and a repository's git folders
  with the object and Git LFS folders it reads. They do so also when a link or a junction leads
  there, and when the folder is reached by another name -- `\\localhost\C$\...`, a SUBST letter
  or a mapped one -- which is told by its volume and file ID. The folders where copies sit among
  live files stay open, since that is where a file is usually put back: a git working tree, an
  Eclipse workspace outside its `.metadata`, and the document folders whose `<name>.bak` backups
  are read.
- Every copy is streamed into a temporary file beside where it goes, `.~solarljos-<random>.part`,
  however large it is, and given its name only once all of it is there: by a hard link, which
  fails rather than replace a file, or, on FAT and exFAT, which have no hard links, by a rename
  once the name is seen to be free. When anything fails, the temporary file is removed, so a copy
  never stands short under its own name; a process killed while writing leaves only the `.part`
  file, whose name says what it is.
- Nothing is replaced: a name that is taken becomes `name (recovered 2).ext`, the mark said in
  the language Solarljos speaks (`name (복구됨 2).ext` in Korean), and a rebuilt folder always
  goes into a new folder of its own. On Windows a name it cannot hold -- `a:b` from Linux would
  be a stream attached to a file `a` -- is written with `_` in its place. Two
  entries of a deleted folder that come out under the same name that way, or as `Readme` and
  `README` on a disk that ignores case, both come back, the second as `name (recovered 2)`.
  `rebuild --dry-run` shows the plan and writes nothing.
- A deleted folder is restored without the links and junctions inside it, since what they
  lead to was not deleted with it, and without any folder inside it that holds the copy being
  written, such as a bind mount of it. A folder that is itself a link or junction, or that
  really lies outside the searched location it was found in, is refused with
  `Refusing to restore <dir>: it leads through a link to <real path>.`, and so is a `--to`
  inside the folder being restored. Then nothing is created, not even the `--to` folder.
- Telling whether it runs as administrator, as reading a card directly needs, opens
  `\\.\PhysicalDrive0` for reading and closes it at once; nothing is read from it.
- There is no cache, no settings file and no log. IDs are derived from content, so `show` and
  `restore` search again rather than remember anything. The graphical front end keeps what it
  found in its memory, and nothing in the browser.

What the operating system does on its own when any program runs -- Prefetch, event logs,
last-access times -- is outside any program's control, this one included.

## The command line

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

### Running it from the source

Requires Node.js 22 or later. There are no dependencies and nothing to build.

```
git clone https://github.com/amophi/Solarljos.git
cd Solarljos
node bin/solarljos.js --help
```

`npm link` in that folder puts `solarljos` on the `PATH`. `node bin/solarljos.js gui` opens the
same window as `Solarljos.exe`; run in a terminal, it also stops when that terminal is closed or
Ctrl+C is pressed in it, and Ctrl+C waits up to 8 seconds for a restore being written, and one cut
short then leaves no file behind.

### Usage

```
solarljos find <name>                     list every surviving copy, newest first
solarljos show <name> <id>                print one copy
solarljos restore <name> <id> --to <dir>  write one copy into <dir>
solarljos rebuild <folder> --to <dir>     bring back everything below a folder
solarljos sources                         show what can be searched on this machine
solarljos gui                             open the graphical front end in a browser window
```

`<name>` matches file names in any case: `report` finds `report-final.docx`. With `*` or `?`
it is a glob over the whole name (`*.docx`); with a slash it is matched against the full path
(`src/app.js`, `src/*.js`). Names compare in Unicode NFC, so a name macOS wrote decomposed
matches the same name typed on Windows.

| Option | Meaning |
| --- | --- |
| `--containing <text>` | Only copies whose text contains it. With no `<name>`, copies whose file name was lost are offered too |
| `--type <kinds>` | Only these kinds of file, comma-separated: `image`, `video`, `audio`, `document`, `archive`, `text`. A copy with a name is one by its extension; with no `<name>`, copies whose name was lost are offered too, told by their content. `find` and `rebuild`, and `show` and `restore` to find the same copies again |
| `--deleted-only` | Only copies whose original path no longer exists (STATE `deleted`) |
| `--since <when>` | Only copies from then on: `7d`, `12h` or `30m` ago; `2026-09-01`, midnight at the start of that day where you are, as every time shown is local; `2026-09`, midnight on the first of that month; or a full time such as `2026-09-01T14:30`, local unless it ends in `Z` or an offset. A day that does not exist, such as `2026-02-30`, is refused. A copy that carries no date -- a thumbnail usually has none -- is kept, and counted in a note |
| `--source <ids>` | Search only some sources, comma-separated or repeated: `recycle`, `history`, `claude`, `antigravity`, `git`, `jetbrains`, `eclipse-history`, `notepad`, `editor-backups`, `hancom`, `trash`, `thumbcache`, `snips`, `removable`, `vss` |
| `--limit <n>` / `--all` | Rows to show; 30 by default |
| `--json` | `find` and `rebuild` only: machine-readable output, with each copy's `tier`, `mediaType`, `derived`, `unverified`, `width` and `height`, and the search's `notes` |
| `--binary` | `show` only: print a copy even when it looks binary |
| `--to <dir>` | Where `restore` and `rebuild` write |
| `--dry-run` | `rebuild` only: list what would be written, and write nothing |
| `--port <n>` / `--no-open` | `gui` only: the port on 127.0.0.1 to listen on, and printing the address instead of opening a window |
| `--lang <code>` | The language to speak, by its code: `en`, `ko`, `ja`, `zh-CN`, `zh-TW`, `es`, `fr`, `de`, `pt-BR`, `ru`, `it`, `pl`, `tr`, `vi`, `id`, `th`, `ar`, `hi`. The variable `SOLARLJOS_LANG` does the same when `--lang` is not given. With neither it is English, whatever the system's language. A code with no complete translation gets a note, and English. With `gui`, the page starts in it too |

A mistake in the command line -- an unknown option, source or type, a `--since` that cannot be
read, a missing `--to` -- ends with exit code 2 and writes nothing. `find` and `rebuild` end with
1 when they find nothing, and `rebuild` also when a file could not be read or written.

### Searching by type

```
solarljos find --type image,video                      every picture and video, named or not
solarljos find holiday --type image                    pictures whose name contains "holiday"
solarljos find --type image --location removable=E:    a memory card, run as administrator
solarljos rebuild C:\Users\me\Pictures --type image --to D:\recovered
```

The types are `image`, `video`, `audio`, `document`, `archive` and `text`; `photos`, `pictures`,
`videos`, `music` and `documents` work too. A copy with a name is of a type by its extension:
`holiday.jpg` is a picture whatever its bytes are. With no name to go on, copies whose name was
lost are offered as well -- thumbnails, carved files, git objects -- told by their first 4 KB: a
JPEG by its markers, an MP4 or a HEIC by its brands, a camera's RAW file by the maker its TIFF
header names, and so on ([src/types.js](src/types.js)). An extension of two meanings -- `.mts` is a
camcorder's clip and a TypeScript module, `.mod` a JVC clip and a Go module -- is settled by the
bytes where that decides.

A search by type that asks for neither text nor documents leaves out the six sources that keep
only text: the list shows `-` for them, with a note. With no name, the shadow copies list only
what is gone or changed: a snapshot copy with the same size and time as the file still in its
place is left out, and counted. Carving a card's free space happens only in a search by type
with no name, since a search for a name wants no list of every photo the card ever held.

```
$ solarljos find --type image,video

  Recycle Bin               212
  Editor Local History        -
                          ! Not searched: it keeps only text, and the search is for image, video.
  ...
  Explorer thumbnails       306
  ...

ID        WHEN              FOUND IN                                SIZE    STATE    PATH
9c01d2e3  2026-03-14 10:02  recycle bin                             3.1 MB  deleted  C:\Users\me\Pictures\IMG_0412.JPG
...
5be7a0c4  ?                 thumbnail, name unknown (smaller copy)  14 KB   -        (name unknown, a .jpg file)  256x192

To read one:      solarljos show --type "image,video" <id>
To get one back:  solarljos restore --type "image,video" <id> --to <folder>
```

A copy with no date sorts last, and its WHEN is `?`.

### Places from another disk

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
| `vss=<snapshot>=<drive>` | A snapshot and the drive it froze, e.g. `vss=\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy5=C:\`; a shadow-copy device alone is tied to its drive by serial. `vss=walk=<folder>` adds a folder to look through in every snapshot, in a search by name or type | |
| `jetbrains=<dir>` | An IDE's system folder, e.g. `D:\old\Users\me\AppData\Local\Google\AndroidStudio2026.1`, its `LocalHistory` or `caches`, or a folder of system folders | |
| `eclipse-history=<dir>` | An Eclipse workspace, its `.metadata`, or a folder up to five levels above it | |
| `notepad=<dir>` | Notepad's TabState folder, or any folder above it up to a user profile, e.g. `D:\old\Users\me\AppData\Local` | |
| `editor-backups=<dir>` | An editor's `Backups` folder, or the app folder holding it | |
| `hancom=<dir>` | A folder whose `.asv`, `.bak` and `.lnk` files are read: Hwp's temp folder, Hancom's Recent folder, or a folder of documents | |
| `trash=<place>` | A Linux trash folder, a home or data folder holding one, or a drive used on Linux | |
| `thumbcache=<place>` | Explorer's cache folder or the Recent folder, or any folder above them up to a user profile; `thumbcache=volume={GUID}` names a volume of another machine, for its shortcuts to be matched | |
| `snips=<dir>` | The Snipping Tool's `TempState` folder, any folder above it up to a user profile, or a folder of captures | |
| `removable=<place>` | A card or stick: `E:`, `\\.\PhysicalDrive1` or `/dev/sdb1`, read directly with administrator (root) rights; or a disk image of one (`.img`, `.dd`, `.raw`), which needs none. Only what is named here is read | |

A place given twice, or given and also found, is searched once; for the first five, on Windows,
also when only the letter case differs.

### Reading the list

- **STATE** is `deleted` when nothing exists at the original path any more, `exists` when
  something does -- then the copy is an older version -- and `no content` when a source still
  lists an item whose contents are gone. It is `-` (an empty string in `--json`) when the path
  cannot be checked here, and `--deleted-only` then leaves the copy out. That is a copy with no
  path, a path from another kind of system, or one where a look could wait on the network or on
  a disk:
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
- **FOUND IN** is the kind of copy, and says so when the copy is not simply the file. Every copy is
  in one of five tiers of trust ([src/quality.js](src/quality.js)):

  | Tier | After the kind | What the copy is |
  | --- | --- | --- |
  | 0 | | the bytes that were on disk |
  | 1 | | saved, but not provably those bytes: git could not make it exact, an editor held it as text whose line ends may differ, or a card's records say where it lay but not that nothing was written there since |
  | 2 | (never saved) | text an editor held and never wrote to the file |
  | 3 | (may be incomplete) | read from free space, or from clusters taken to follow each other: it passed the checks its format allows, but parts of it may be missing or belong to another file |
  | 4 | (smaller copy) | made from the file, such as a thumbnail: never the file itself |

  A copy of tier 3 or 4 says what it is in the name it comes back under, too:
  `IMG_0001 (may be incomplete).JPG`, and `holiday (smaller copy 256x192).jpg` in the smaller
  copy's own format, which for a video's thumbnail is a picture. `--json` gives each copy's
  `tier`, with `derived` and `unverified`.
- A copy read back from a card is exact only when its format's checksums cover every byte and
  it ends at the size the card recorded (a PNG, a ZIP); otherwise, where the card recorded every
  piece of it, it is inexact -- a later file may have been written there -- and else it may be
  incomplete. A deleted `.jpg` whose clusters now hold something else is left out, and counted
  in a note.
- The same content under the same name is one row however many places hold it; `x3` after
  the source says how many. The copy that represents the row is chosen as rebuild chooses
  (below): the lowest tier first, and the newest within it. A copy whose name was lost is merged
  into the row of the same bytes under a name, and counts among its copies.
- **PATH** is the path the file had. **(folder unknown)** after a name means a source knows what
  the file was called but not where it was; it is restored under that name. With neither,
  `(name unknown, a .jpg file)` gives the format its bytes show; such a copy is restored as
  `recovered-<id>.jpg`. A picture's width and height follow, as `256x192`, when they are known.
- An **ID** is derived from the path and the content, so it stays the same between runs. The
  first few characters are enough. `show` prints the copy's note, when it has one.
- The two commands printed under the list, to read a copy and to get one back, repeat the
  options that decide which copies exist, quoted for the shell of the system they are printed
  on. On Windows a value such as `trash=E:\` is left bare; one holding `$` or `` ` ``, such as
  `E:\$Recycle.Bin`, goes in single quotes, which PowerShell takes as they are and cmd does
  not; anything else goes in double quotes, which both take. Elsewhere a value is quoted for a
  POSIX shell. After a search by type or by content alone there is no name to repeat:
  `solarljos restore --type image <id> --to <folder>`.

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

A copy that may be incomplete, or a smaller copy, is never taken. A file of which nothing else is
left is listed apart, under `N file(s) are left out: ...`, to be looked at with `find` and
restored one by one, and `--json` gives it as `leftOut`. `--type` rebuilds only the files of
those types: `rebuild C:\Users\me\Pictures --type image --to D:\recovered`.

The result goes into a new folder named after the old one inside `--to`; a second rebuild
goes beside it as `name (recovered 2)`. A path can be a file in one copy and a folder in
another: a script `bin` that later became `bin/cli.js`, as git history often has. Then every
file below the folder is written and the folder keeps its name, and the file goes beside it as
`bin (recovered 2)`, or `a (recovered 2).txt` for a name with an extension. A copy that cannot be
read or written is reported at the end, under `Could not read or write N file(s):`, and the rest
are still written. `--deleted-only` limits it to files that are missing today, which is how a
folder that was only partly deleted is filled in.

## The graphical front end

`solarljos gui` -- or `Solarljos.exe` with no arguments, or none but `--lang` -- starts a small web
server on 127.0.0.1 and opens its page, as *Using the program* describes. Edge that cannot be
started gives way to the default browser. `--no-open` prints the address instead of opening a
window, and `--port <n>` listens on that port instead of a free one. When the address is to be
printed and nothing printed would be seen -- no browser could be started, or `Solarljos.exe gui
--no-open` was typed in a console -- it is shown in a console window of its own instead; closing
that window does not stop Solarljos. On macOS and Linux the page opens in the default browser.

- **The page.** *Find a file* searches by name, by a word the file contained, or by kind of file,
  and shows the copies of one file together, the best one first, chosen as `rebuild` chooses; a
  newer copy that is less certain, such as text that was never saved, is pointed out. *Photos and
  videos* shows a grid by month, with the copies that carry no date in a group of their own at the
  end. *Bring back a folder* lists everything found below a folder as a tree to tick; a file of
  which only a smaller copy, or one that may be incomplete, is left is listed apart and not
  ticked. *What is searched* shows what each source sees, and takes places from another disk for
  as long as the window is open. Filters -- only files that are gone, dates, the folder a file was
  in -- say how many copies they hide, and turning one off does not search again.
- **Each part keeps its work.** The start, *Find a file*, *Photos and videos*, *Bring back a
  folder*, *What is searched* and *Help* each keep their last view while another is shown: what
  a form held, the results with their filters, sort, selection and how many of them are shown,
  where the view was scrolled to, and the preview that was open. A search keeps running, and its
  results keep coming in, while its part is hidden. A tab goes back to its part's last view; results have *New search*, and a form has *Back to the results*. None of it is kept
  in the browser: a reload starts again from what the server still has.
- **How it looks.** Dark by default, in the look of the author's SoundVisualizer app, made for a
  PC window:
  - A rail down the side of the window holds the name and each part as an icon with its words, the
    chosen one on a blue tint. The language, a light/dark switch and Quit sit at its foot. It is
    as wide as its longest words, and in a narrow window it shows only its icons; its menu button
    shows the words over the page, or folds them away in a wide one.
  - The start shows the name, Solarljos, large, over the three things it finds.
  - Cards are rounded and darker than the page. On/off options are switch rows you can click
    anywhere on, and options that only matter when another is on open with a short animation.
    Check boxes are kept where several things are chosen at once.
  - Every control shows where the mouse is and has a focus ring. Ctrl+1 to Ctrl+5 switch parts,
    and the Up and Down keys move along the rail as Tab does.
  - A form's main action is a large button, and the rest are regular PC size. A copy's tier is a
    pill with an icon and its name in words, never a colour alone. A copy is previewed in a pane
    beside its results.
  - The light theme uses the same design on light surfaces. The choice lasts for the run and is
    kept by Solarljos, not by the browser.
  - In a high-contrast theme the system's colours are used and every box keeps a border, and
    motion is dropped when the system asks.
  - Type in [Pretendard](https://github.com/orioncactus/pretendard), which the program carries,
    for Latin, Greek, Cyrillic and Korean letters, and each language's own Windows font for the
    rest (Japanese, Chinese, Thai, Hindi, Arabic).
  - The layout mirrors in Arabic. Every text colour was measured against every background
  it is shown on, light and dark, at 4.5:1 or more, and every mark of where a control is and what
  state it is in at 3:1 or more; the values are at the top of
  [src/gui/ui/style.css](src/gui/ui/style.css).
- **Who can reach it.** Only the window it opened. The address carries a random token that works
  once, traded at once for a cookie that no script can read and no other site is sent, named
  after the port. Every request must name exactly 127.0.0.1 and that port and come from that
  origin, which rules out other sites, DNS rebinding and the other ports of 127.0.0.1; one that
  changes anything must be a JSON POST carrying the page's own header. No reply gives another
  origin leave to read it.
- **How copies are shown.** A copy's type is told from its bytes, never its name. Pictures and
  videos a browser can show are shown; text, and an `.html` or `.svg` copy with it, is shown as
  its text, and nothing in it runs; anything else only as bytes. No reply is cached. The page
  tells the browser not to offer its own translation, which would send the names and folders of
  the files found to a translation service; the page has its own 18 languages. Nothing is
  downloaded: the video player has no Download item, the browser's own menu is not offered over a
  picture, Ctrl+S is blocked, and a copy asked for as a page of its own is refused, since a
  download goes to the Downloads folder on the Windows drive, past every check a restore makes.
- **Where it writes.** Through the same `restoreCopy()` and `rebuildFolder()` as the command line,
  with the same refusals. Before writing, it says how many of the files were on the drive being
  written to, told by the volume, since writing there can overwrite what is still to be found. Run
  as administrator, it also refuses Windows' own folders, Program Files and ProgramData, however
  they are reached.
- **What it keeps.** The last search of each kind -- by name, and for photos and videos -- the
  last folder plan, and the language the page chose, in memory; a reload asks for them again. One
  search runs at a time, and Stop ends it: within about a second, so the next search can start.
- **When it stops.** 3 s after its page is closed; 30 s after, when a search was running or the
  page went without saying goodbye, so that a reload keeps it running; 10 minutes after starting
  when no window connected; and when *Quit* is pressed. Never in the middle of a restore or a
  rebuild: one being written finishes first. `Solarljos.exe` has no console;
  `node bin/solarljos.js gui` run in a terminal also stops on Ctrl+C or when that terminal is
  closed, and then waits up to 8 s for a write, removing the temporary file of one it has to cut.

How it works is at the top of [src/gui/server.js](src/gui/server.js) and
[src/gui/launch.js](src/gui/launch.js).

## Languages

Solarljos is in 18 languages: English (`en`), Korean (`ko`), Japanese (`ja`), Simplified Chinese
(`zh-CN`), Traditional Chinese (`zh-TW`), Spanish (`es`), French (`fr`), German (`de`), Brazilian
Portuguese (`pt-BR`), Russian (`ru`), Italian (`it`), Polish (`pl`), Turkish (`tr`), Vietnamese
(`vi`), Indonesian (`id`), Thai (`th`), Arabic (`ar`), written right to left, and Hindi (`hi`).

- **The page** starts in the language `--lang` gives -- a shortcut to `Solarljos.exe --lang ko`
  opens it in Korean -- else in the first of the browser's languages it has, else in English.
  *Language*, below the list of places, lists the languages whose table,
  `src/gui/ui/lang/<code>.json`, is there, each by its own name. Choosing one builds every view
  again in it, keeping what the forms and results held. Plurals follow the language's own rules
  (Intl.PluralRules), and dates and numbers are written as its locale writes them. In Arabic the
  whole layout runs from the right. Korean breaks lines between words, not inside them.
- **What the library says** -- a source's notes, why a folder is refused, the kinds of copy --
  comes from its language's catalog, `src/locales/<code>.json`, which maps each of the 655
  English messages to its translation. The page tells the server the language it is shown in, and
  notes come in that language from the next search on; results found before a change keep the
  words they were found with, and the page says so. A language is offered only when its catalog
  translates every message, so that nothing comes out half in it and half in English.
- **The command line** speaks English unless `--lang <code>` or the variable `SOLARLJOS_LANG`
  asks for another, whatever the system's language, so that a script reads the same output on
  every machine. Its columns line up by the width text takes in a terminal, not by its length: a
  Korean, Japanese or Chinese character takes two columns, and a combining mark -- a Thai vowel, a
  Devanagari matra, an Arabic haraka -- none.
- **Restored names** carry their marks in the language spoken: a name that was taken comes back
  as `photo (복구됨 2).jpg` in Korean, as the marks of a smaller copy and of one that may be
  incomplete do.

The translations were machine-assisted: each language was written on its own and checked by
translating it back into English. No native speaker has reviewed them yet, and corrections from
native speakers are welcome.

To fix a translation or add a language:

- The library's messages are in `src/locales/<code>.json`: each English message, exactly as
  `src/locales/messages.json` lists it, mapped to its translation, where `{0}`, `{1}`... may move
  but must all stay. `npm run i18n -- check` says how far each catalog is, and fails on a message
  missing, left over or empty, or whose `{n}` are not the English's. When a message is added or
  changed in the code, `npm run i18n -- extract` writes `messages.json` again.
- The page's words are in `src/gui/ui/lang/<code>.json`: keys of the English table in
  [src/gui/ui/strings.js](src/gui/ui/strings.js) mapped to their words. The rules -- named
  placeholders, plural forms by Intl.PluralRules, `meta.lang`, `meta.locale` and `meta.dir` -- are
  at the top of that file. A key left out is shown in English; every table now has all 679.
- A new language also needs its code and its own name in `LOCALES` in [src/i18n.js](src/i18n.js).
- `test/i18n.test.js` fails when `messages.json` is not what `extract` finds or a catalog does not
  pass `check`, and `test/gui-lang.test.js` holds every page table to the rules of `strings.js`.

## The Windows program

`Solarljos.exe`, on each release's page, is all of Solarljos in one file: the command line, the
page and the node.exe they run on. Beside it are `solarljos.cjs`, the script inside it, which is
the command line alone for Node.js 22 or later, and the SHA-256 of each; the release workflow
attests where both were built:

```
sha256sum -c Solarljos.exe.sha256
sha256sum -c solarljos.cjs.sha256
gh attestation verify Solarljos.exe -R amophi/Solarljos
gh attestation verify solarljos.cjs -R amophi/Solarljos
```

In a Windows console without `sha256sum`, `certutil -hashfile Solarljos.exe SHA256` prints the
hash to compare with the one in `Solarljos.exe.sha256`.

It is a Windows GUI program, not a console program as node.exe is: its header's Subsystem is 2,
not 3. So a double-click opens no console window, only the browser's, and Windows gives it no
console even when it is started from one: what it prints is seen only when it goes to a file or a
program. *Using the program* says what it does when it would not be seen.

It is not code-signed. Windows SmartScreen asks before running it (*More info*, then *Run
anyway*), and Smart App Control, where it is on, blocks it; there `node bin/solarljos.js gui`
runs the same thing on Node's own signed node.exe. `NODE_OPTIONS` does not reach it, and it keeps
`NODE_V8_COVERAGE` and `NODE_REDIRECT_WARNINGS` from writing files; only `NODE_COMPILE_CACHE`, if
you have set it yourself, makes Node create an empty folder when it starts.

It can be built again from the same tag, with the Node version `.github/workflows/release.yml`
pins, and comes out the same byte for byte, in any folder:

```
npm run build:exe      # Windows, Node 25.5 or later: dist\Solarljos.exe, tried before it is kept
npm run bundle         # any system, Node 22 or later: dist/solarljos.cjs, the command line alone
```

`scripts/bundle.js` puts the command line and every module it loads, the language catalogs
included, into one script; `scripts/build-exe.js` puts that script and the page's files, its
language tables included, into a copy of the node.exe running it, with that node.exe's signature
taken off first, since it would no longer verify. It then sets the header's Subsystem to the
Windows GUI's before it makes the checksum right, and reads the file back, which must say 2. Made
a console program again, with its checksum made right, the exe differs in two bytes: one of the
Subsystem and one of the CheckSum. It then runs the exe, with pipes for its output -- its version,
its help, every source, a search and a restore on a made-up Linux trash, and the front end serving
its page, started with `--no-open`, where every page file must come back as the bytes that went
in -- and only then writes `dist/Solarljos.exe.sha256` and `dist/solarljos.cjs.sha256`. Built
with Node 26.10.0 in two folders of different names, 0.4.0 came out with the same SHA-256 both
times, and with no part of either folder's path in it; the exe GitHub's Windows runner built from
the same commit in CI had that SHA-256 too. Setting the Subsystem and the checksum adds nothing
that depends on the machine or the folder.

## Using it from code

The command line is a front end on a small API, and so is the graphical one:

```js
const solarljos = require('solarljos');

const { results, locations, notes } = await solarljos.search({
  pattern: 'budget.xlsx',
  onProgress: (e) => console.log(e.type, e.id ?? '', e.done ?? '', e.total ?? ''),
});
const bytes = await solarljos.readCopy(results[0]);     // all at once, up to 2 GiB
const head = await solarljos.openCopy(results[0], { start: 0, end: 1023 }); // a stream, both ends included
await solarljos.restoreCopy(results[0], 'D:\\recovered', locations);

const stop = new AbortController();
const photos = await solarljos.search({
  types: ['image', 'video'],
  since: Date.parse('2025-01-01'),
  signal: stop.signal,
});

const { folder, plan, leftOut } = await solarljos.planFolder('C:\\work\\app');
await solarljos.rebuildFolder(plan, folder, 'D:\\recovered', locations, {
  onProgress: ({ done, total }) => console.log(`${done} of ${total}`),
});
```

Progress arrives as `source-start`, `source-progress` (`done` of `total`, from sources that go
through many files), `source-done` (with `skipped: true` for a source a search by type leaves
out), `filtering` and `done`. Results are plain objects; the same rules apply as on the command
line. Each carries `mediaType`, and a picture its `width` and `height`; `tier(copy)` says how far
it can be trusted, 0 (exact) to 4 (a smaller copy). A search stops, and rejects, once its `signal`
fires. `notes` says what concerns the whole search, such as how many copies with no date were
kept. `leftOut` lists the paths whose only copies are of tier 3 or 4, which the plan does not take
unless they are added to it.

Also exported: `sources`, as `{ id, label, media, needsAdmin }` -- `media` is false for a source
that keeps only text, and `needsAdmin` true for one that reads disks directly; `describeSources()`;
`checkDestination()`, which throws as `restoreCopy()` would, and writes nothing; `freeze()`, which
reads the stores other programs keep rewriting, such as the thumbnail cache, into memory, before
anything can change them; `removeUnfinished()`, for a front end about to end its process in the
middle of a write; `sniff(bytes)`, `{ mediaType, ext }` from a copy's first bytes; `TYPES`; and
`isElevated()`, whether this process may read a drive directly. [src/index.js](src/index.js) has
the whole list.

The library speaks English until told otherwise. `setLocale(code)` sets the language of every
note, reason and label it gives from then on, for the whole process, and returns the code it took:
`'en'` for a code of no language here, or of one whose catalog does not translate every message.
`getLocale()` says which it speaks; `matchLocale(prefs)` gives the code of the language a list
such as `navigator.languages`, or an Accept-Language header, asks for first, and `'en'` when it
names none; `LOCALES` lists the 18 as `{ code, name }`, each name in its own language.

`search()` and `describeSources()` take `locations` as the command line gives them:
`{ discover, recycleDirs, historyDirs, claudeDir, antigravityDirs, repos, dirs }`, where `dirs`
is `{ <source id>: [places] }` as from `--location`. An unknown id in `dirs`, an empty place, or
an unknown type, throws an Error with `usage: true`. The `locations` a search returns is what
came of them, with `claude` a list of folders; `restoreCopy()` and `rebuildFolder()` take that
one. `planFolder()` and `rebuildFolder()` read a folder the way `rebuild` does (`C:` is the
drive's root on any system, a relative folder is made absolute), and `planFolder()` returns it
as `folder`, as it was understood.

## Speed

Measured on the machine this was written on, a search for `package.json` across all fifteen
sources, started in this repository's folder, took 7.0 to 9.5 s once the disk cache was warm.
Nearly all of it was two sources: Claude Code, which went through 1,906 transcripts totalling
1,326 MB (5.0 to 6.4 s), and the two shadow copies (1.1 to 1.4 s). The thumbnail cache, read in
both snapshots as well, took 0.2 to 1.0 s, and the other twelve together 0.7 to 0.8 s, git 0.3 s
of it for the one repository.

A search for every picture and video with no name, `find --type image,video`, took 7.5 to 9.1 s
and listed 10,922 copies: 10,616 pictures in the Recycle Bin, nearly all of them inside deleted
folders, and 306 thumbnails. The six sources that keep only text were left out; the shadow copies
took 3.9 to 4.3 s of it.

`--source` leaves out what is not needed, with one thing to know: in a search by name or type the
shadow copies are looked through only in the folders where the other selected sources found
something, plus the user's own folders ([docs/sources.md](docs/sources.md#volume-shadow-copies)
lists them) and any `--location vss=walk=<folder>`. So `--source vss` on its own finds nothing
that lies anywhere else.

## Limits

- Raw disk recovery is for FAT and exFAT cards, sticks and their images only, and only those
  named with `--location removable=`. NTFS -- a USB hard disk's, say -- and a machine's own SSD are
  not read that way.
- Nothing has been read from a real memory card yet: the machine this was written on has none.
  The card source was checked on public test images and on images the tests build.
- Carving does not cover MKV and WebM, MPEG transport streams (AVCHD `.MTS`), MP3, FLAC, the
  Office formats before 2007 and HWP 5, 7z, RAR or ZIP64. Progressive JPEG scans are followed, not
  decoded, and the frames inside a video are never decoded. After a format, carving finds only the
  files that begin where a cluster of the new file system begins: a card formatted again with
  larger clusters gives back fewer.
- A photo's date is when its source recorded it -- deleted, last changed, stored -- not when it was
  taken, except for a carved one, which is dated by its content. A thumbnail usually has no date.
- Only Windows 10 and 11's thumbnail cache was checked against real files; older ones are read as
  published descriptions have them. The Snipping Tool's own folders were empty on the machine
  this was written on, where saving is on; their layout is from published forensic notes.
- A phone or a camera connected by cable (MTP) has no blocks to read: put its card, when it has
  one, in a reader.
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
- Browser caches: the pictures Edge, Chrome and the apps built on them keep of the pages they
  showed, as smaller copies.
- Phones, through adb: the photos a phone's gallery has moved to its trash, and what KakaoTalk
  keeps on the phone.
- NAS and sync apps: a NAS's recycle bin and snapshots, and the version history Synology Drive
  keeps.
- NTFS: undeleting from USB hard disks and sticks, which usually get no TRIM; `$UsnJrnl`, to say
  what was deleted and when even when nothing is left; and small files kept inside the MFT
  itself.
- A photo's own date, from its EXIF, and a video's, to sort and filter by.
- Other coding agents' records -- Codex, Gemini CLI, Cursor, VS Code's chat edits -- once they
  can be checked against real data.
- Native speakers' review of the translations, which were machine-assisted.

## Tests

```
npm test
```

Everything runs against fixtures built under `test/.work` and removed afterwards; no test reads
the machine's real Recycle Bin, shadow copies, editor or IDE history, Notepad tabs, Hancom
folders, trash, thumbnail cache, Snipping Tool folders, cards, Claude Code or Antigravity
folders, or repositories; cards are disk images the tests build. The tests also bundle the tree
and run the bundle. A few tests run only on Linux or only on Windows; CI runs both, and builds
and tries `Solarljos.exe` on every push.

- `test/i18n.test.js`: `messages.json` is what `npm run i18n -- extract` finds in the code now,
  every catalog passes `check`, and a language is offered only when its catalog is complete.
- `test/gui-lang.test.js`: every table in `src/gui/ui/lang` keeps the rules at the top of
  `strings.js`, and the page speaks it.
- `test/format.test.js`: the columns Korean, Japanese, Chinese, Thai, Hindi and Arabic text and
  emoji take in a terminal.
- `test/build-exe.test.js`: taking the signature off, setting the Subsystem and making the
  checksum right, on made-up PE files, so it runs on any system.
- `test/launch.test.js`: how the window is opened, Edge falling back to Explorer, and the console
  window of its own for what would not be seen. Every program is a stand-in, but for one cmd.exe
  on Windows, run with the command line such a window gets in a console that is hidden.

On Windows 11 with Node 24.20, `npm test` ran 635 tests: 626 passed, and 9 were skipped, which
need Linux or what Windows does not give without privileges.

## License

MIT

The page's font, Pretendard 1.3.9 (`src/gui/ui/fonts/PretendardVariable.woff2`, unchanged from its
release), is © 2021 Kil Hyung-jin and licensed under the SIL Open Font License 1.1, whose text is
beside it in `src/gui/ui/fonts/Pretendard-OFL.txt`.
