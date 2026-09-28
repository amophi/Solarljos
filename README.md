# Solarljos

Finds a deleted file by looking everywhere a copy of it may have survived, and gets it back
without writing a single byte anywhere else.

```
$ solarljos find budget.xlsx

  Recycle Bin               1
  Editor Local History      0
  Claude Code               3
  git                       2   (repositories searched: 4)

ID        WHEN              FOUND IN              SIZE    STATE    PATH
3f9a1c2e  2026-09-27 21:14  claude backup         31 KB   deleted  C:\Users\me\work\budget.xlsx
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
      9  antigravity write
      4  local history
```

## Why another recovery tool

Classic undelete tools read the disk sector by sector and rebuild files from what the file
system has not overwritten yet. On a hard disk that works. On an SSD it mostly does not:
when a file is deleted, Windows sends TRIM, the drive discards the blocks, and from then on
they read back as zeros. Most machines today boot from an SSD with TRIM on.

What does survive on such a machine is *other copies* -- in the Recycle Bin, in the history
an editor keeps of every save, in an AI coding agent's transcripts and backups, inside a git
repository. Each of those has its own tool, or no tool at all, and nobody looks in all of
them at once after the fact. That is what this does.

It matters more since coding agents started deleting things. An agent's `rm -rf`, a
`git reset --hard`, a rewritten file -- none of those go through the Recycle Bin, but the
agent's own records usually hold what was there.

## What it searches

| Source | Where | What survives there |
| --- | --- | --- |
| Recycle Bin | `<drive>:\$Recycle.Bin\<account>\` | Deleted files and whole deleted folders, with their original paths and deletion times. Files inside a deleted folder are found individually |
| Editor Local History | `<app data>/<editor>/User/History/` | A copy of a file on every save. VS Code and every editor built on it -- Cursor, Windsurf, Antigravity, VSCodium -- are found automatically |
| Claude Code | `~/.claude/` | Byte-exact backups taken before Claude changed a file; the full content of files Claude wrote; the file as it was before each edit, and after it; files Claude read in full |
| Antigravity | `~/.gemini/antigravity-ide/` | The full content of files its agent wrote; files it read in full, rebuilt to the byte and checked against the size it recorded |
| git | repositories under the current folder | Files deleted from disk but still in the index; every committed version, including commits thrown away by `reset --hard` that only the reflog still names; with `--containing`, staged content that was never committed |

`solarljos sources` shows what each source can see on the machine it runs on.

## Nothing is written

A recovery tool that writes can destroy what it is trying to recover, so this one does not:

- Sources are only ever read. git runs with `GIT_OPTIONAL_LOCKS=0`, so even `status`-like
  commands do not refresh the index, and `git fsck --lost-found`, which writes into `.git`,
  is never used. The tests check that a repository's `.git` is byte-for-byte unchanged after a
  search.
- `restore` and `rebuild` are the only commands that write, and only under the folder given
  with `--to`. They refuse a folder inside any location they search, and never replace a
  file: a name that is taken becomes `name (recovered 2).ext`, and a rebuilt folder always
  goes into a new folder of its own. `rebuild --dry-run` shows the plan and writes nothing.
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
(`src/app.js`, `src/*.js`).

| Option | Meaning |
| --- | --- |
| `--containing <text>` | Only copies whose text contains it. With no `<name>`, copies whose file name was lost are offered too |
| `--deleted-only` | Only copies whose original path no longer exists |
| `--since <when>` | Only copies from then on: `2026-09-01`, `7d`, `12h` |
| `--source <ids>` | Search only some sources: `recycle`, `history`, `claude`, `antigravity`, `git` |
| `--limit <n>` / `--all` | Rows to show; 30 by default |
| `--json` | Machine-readable output |
| `--to <dir>` | Where `restore` and `rebuild` write |
| `--dry-run` | `rebuild` only: list what would be written, and write nothing |

Every location can also be given by hand, which is how a drive taken out of another machine
is searched:

| Option | Location |
| --- | --- |
| `--recycle-dir <dir>` | A `$Recycle.Bin` folder, or one account's folder inside it |
| `--history-dir <dir>` | An editor's `User/History` folder |
| `--claude-dir <dir>` | A Claude Code folder, normally `~/.claude` |
| `--antigravity-dir <dir>` | An Antigravity data folder, normally `~/.gemini/antigravity-ide` |
| `--repo <dir>` | Where to look for git repositories; the current folder by default |
| `--no-discover` | Search only what was given, not this machine's usual places |

### Reading the list

- **STATE** is `deleted` when nothing exists at the original path any more, `exists` when
  something does -- then the copy is an older version -- and `no content` when the Recycle
  Bin still lists an item whose contents are gone.
- The same content under the same name is one row however many places hold it; `x3` after
  the source says how many. The newest sighting is shown.
- An **ID** is derived from the path and the content, so it stays the same between runs. The
  first few characters are enough.

### Rebuilding a folder

`rebuild <folder>` searches every source for anything whose original path was below that
folder -- the folder as it was, which is usually one that no longer exists -- and takes, for each
file, the newest copy found. Between copies from the same moment, bytes that were on disk win
over text an agent saw, and an edit rebuilt by applying it comes last. A file as it was before
a change is dated a millisecond before that change, so the state after it always counts as
newer.

The result goes into a new folder named after the old one inside `--to`; a second rebuild
goes beside it as `name (recovered 2)`. A copy that cannot be read is reported at the end and
the rest are still written. `--deleted-only` limits it to files that are missing today, which
is how a folder that was only partly deleted is filled in.

## How each source is read

### Recycle Bin

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

### Editor Local History

`User/History/<folder>/entries.json` names the file (`resource`, a URI) and lists each saved
copy (`entries[].id`, `timestamp`), which sits next to it under that id. The folder outlives the
file.

### Claude Code

Two records, both under `~/.claude`:

- `projects/**/*.jsonl`, one transcript per session including subagents. Lines carrying a
  `toolUseResult` can hold a whole file. A Write records what was written, and the file it
  replaced. An Edit records the whole file before it (`originalFile`) along with the old and
  new text, so the file after it can be rebuilt; the replacement is applied as plain text,
  never as a pattern. A Read holds the file when it was read from the first line to the last.
- `file-history/<session>/<hash>@v<n>`, byte-exact copies taken before Claude changed a file.
  The name does not say which file; `file-history-snapshot` and `file-history-delta` lines in
  the transcripts do.

Measured on 1,126 transcripts: an Edit carried the file before it in 309 of 643 cases, and in
every one of those the old text was there to apply. When `originalFile` is missing, no
"after" version is offered at all -- a rebuilt file that might be wrong is worse than none.
Text from transcripts is the file as Claude saw it; backups are the bytes on disk.

A search reads all transcripts, but only lines that can carry a file and contain the plain part
of the name are parsed. On the machine this was written on, 1,126 transcripts totalling
725 MB took about three seconds.

### Antigravity

One folder per conversation, `brain/<conversation>/.system_generated/logs/`, holding
`transcript_full.jsonl` with one step per line. Two kinds of step hold a whole file:

- A `PLANNER_RESPONSE` whose `tool_calls` include `write_to_file`: `TargetFile` and the full
  `CodeContent`.
- A `VIEW_FILE` step: a header with `File Path`, `Total Lines`, `Total Bytes` and
  `Showing lines <a> to <b>`, then every line as `<n>: <line>`.

A read counts only when it covered the whole file, and only when the text rebuilt from it --
numbers stripped, lines joined -- has exactly the byte count in its header. Measured on this
machine: of 113 whole-file reads, 105 rebuilt to the byte and the other 8 are left out; of the
reads whose file has not changed since, all 57 matched the file on disk exactly.

`transcript.jsonl`, beside the full one, cuts long fields short. It is read only when the full
transcript is missing, and steps it marks as cut are skipped. Edits (`replace_file_content`)
carry only the lines they change, so they give no whole file.

### git

- `git ls-files --deleted`: deleted from disk, still in the index; read back as `:<path>`.
- `git log --all --reflog --name-status`: every version of a matching path in every branch,
  stash and reflog entry. For a deletion, the version in the parent commit is offered.
- `git fsck --unreachable`, with `--containing` and no name only: blobs nothing refers to,
  such as a file staged and then staged again with other content. Their names are lost, so
  only content can find them.

Content is identified the way git identifies a blob, so a copy found in a repository and the
same bytes found elsewhere merge into one row.

## Limits

- Raw disk recovery is not part of this; see *Later*.
- Volume Shadow Copies, File History, OneDrive and Office's autosave are not searched yet.
- Antigravity's `conversations/*.db` files are not read; its transcripts hold the same steps.
- The Recycle Bin is read on Windows only; macOS and Linux trash folders are not yet.
- Copies larger than 32 MB are listed but not compared, so they are never merged as duplicates.

## Later

- Volume Shadow Copies and previous versions, File History, OneDrive, Office AutoRecover.
- Other coding agents' records.
- NTFS: `$UsnJrnl`, to say what was deleted and when even when nothing is left, and small
  files kept inside the MFT itself.
- Raw recovery for USB sticks and SD cards, where TRIM usually does not reach.
- Languages other than English. All text already goes through one function for that.

## Tests

```
npm test
```

Everything runs against fixtures built under `test/.work` and removed afterwards; no test reads
the machine's real Recycle Bin, editor history, Claude Code folder or repositories.

## License

MIT
