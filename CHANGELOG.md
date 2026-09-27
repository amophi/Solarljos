# Changelog

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
