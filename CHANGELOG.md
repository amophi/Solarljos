# Changelog

## 0.2.0 (unreleased)

- `rebuild <folder> --to <dir>` brings back everything that was below a folder, taking the
  newest surviving copy of each file from any source and recreating the tree in a new folder.
  `--dry-run` shows the plan without writing; `--deleted-only` fills in only what is missing.
- Antigravity is a source. Files its agent wrote come back whole; files it read in full are
  rebuilt from its numbered view and kept only when they match the byte count it recorded.
  On the machine this was written on, 105 of 113 whole-file reads rebuilt exactly, and all 57
  whose file was unchanged matched the file on disk.
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
