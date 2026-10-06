# Trying a release on your own computer

The tests in `test/` run on files they make. What they cannot show is how Solarljos does on a
real computer, a real card and a real screen reader, and that it writes nothing there. Before a
release is called 1.0, each of these is tried on the release itself, as downloaded.

Use the release's zip, unzipped into a folder of its own on another drive than the one searched.
Write down what you see; a report that names no file can be shared as it is.

## 1. The engine, with a script

From a clone of the repository, with Node.js 22 or later:

```
node scripts/field-test.js --engine <folder>\solarljos-core.exe --to E:\field-test
```

`--to` must be a new or empty folder, best on another drive. Add `--plan <folder>` to plan a
folder you once had, or still have, and write it into `--to` as well. The report gives, for each
search, how each place went, how long it took and how many copies it found; a stopped search
and how soon the next one ran; whether restored copies are byte for byte what the engine reads
for them, and of those of files still in their place, how many are that file and how many an
earlier or later version of it; and how many connections the engine reset.

What to look for: a place that failed (`failed`, with its error), a search slower than a minute,
a restored copy `different` from the copy as the engine reads it, a restore that failed, a
connection the engine reset, or an engine that does not stop at the end.

## 2. The window

Start `Solarljos.exe` and go through every part:

- [ ] *Find a file*: a name you know was deleted; the preview of a picture, a text and the bytes
      of a binary file; *Restore* one copy into a new folder on another drive; open the file.
- [ ] *Photos and videos*: a search of every place; scroll a long grid; open the enlarged view,
      step through it, play a video; choose several and restore them.
- [ ] *Bring back a folder*: a folder that had files deleted from it; untick some; write it;
      close the window while it is written, and check that the folder is complete afterwards.
- [ ] *What is searched*: the notes of each place; add a place from another disk and remove it.
- [ ] Stop a search halfway, and start another at once: it should run within a few seconds.
- [ ] Change the language twice, and the theme; make the window narrow, then wide again.
- [ ] Quit with the button, and once with the window's own close button.

Note anything that looks wrong, stops, or takes longer than it seems it should, with which part
and what was being done.

## 3. A real memory card or USB stick

Use a spare card, never one whose files you still need.

1. Copy twenty or so photos and a video onto it, then delete them there (in a camera, or with
   `del` in a console: Explorer would add their pictures to the thumbnail cache).
2. Take the card out, slide its lock switch to *Lock*, and put it back.
3. Quit Solarljos if it runs, start it again with *Run as administrator*, and under *What is
   searched* at *Memory cards and USB sticks* add the card's drive letter, such as `E:`.
4. Search *Photos and videos*. The deleted photos should be there, from the card.
5. Restore them to another drive, and open them. Compare them with the originals if you kept
   them.
6. Try restoring onto the card itself: Solarljos must refuse.

Repeat with a card formatted FAT32 and one formatted exFAT if you can, and once with an image of
the card made by another tool, added the same way.

## 4. A screen reader

With Narrator (Ctrl+Windows+Enter) or NVDA:

- [ ] The rail: Up and Down move along the parts and each is read with its name; Ctrl+1 to
      Ctrl+5 change part and the new part's heading is read.
- [ ] A search: the form's fields and choices are read with their labels; the search's end is
      said; the results are read as a list, and the copies' table with its column headings.
- [ ] The photo grid: each picture is read with its date and whether it is chosen.
- [ ] *Restore*: the dialog is read as a dialog; what its check of the folder found is said.
- [ ] A folder's plan: the tree is read with each row's tick and whether it is open.

## 5. What Solarljos writes

Solarljos says it writes nothing but what you restore. [Process Monitor](https://learn.microsoft.com/sysinternals/downloads/procmon)
from Microsoft can show every file and registry change a program makes. It needs
administrator rights, and loads a driver of its own while it runs.

1. Start Process Monitor, and set its filter (Ctrl+L) to show only:
   - *Process Name* is `Solarljos.exe`, `solarljos-core.exe`, `git.exe` or `mountvol.exe`;
   - *Operation* is `WriteFile`, `SetRenameInformationFile`, `SetDispositionInformationFile`,
     `SetEndOfFileInformationFile`, `RegSetValue`, `RegCreateKey` or `RegDeleteValue`.
2. Clear the list (Ctrl+X), then start Solarljos, search in every part, preview a few copies
   (a video too), restore one into a new folder, and quit.
3. Every line left should be inside the folder you restored into. Note any other path -- folder
   and kind of file are enough, never a file's own name -- with the operation and the process.

Windows itself notes every program that runs, and keeps a cache of the fonts drawn on the screen;
those are done by Windows' own processes, not Solarljos's, and do not show with this filter.
