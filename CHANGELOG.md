# Changelog

## 0.8.0 (2026-10-01)

Solarljos on Windows is a program of its own: a window in WPF, with no browser.

The Windows program:

- `Solarljos.exe` is a WPF window on .NET 10 ([desktop/Solarljos](desktop/Solarljos)), which
  needs Microsoft's .NET 10 Desktop Runtime and nothing from NuGet. It has every part the page
  has -- *Find a file* with its preview, *Photos and videos* in a grid by month with the
  enlarged view, *Bring back a folder* with its plan to tick, *What is searched*, and *Help* --
  in the same words in all 18 languages, which it takes from the page's tables, and the page's
  icons. Each part keeps what it showed while another is used.
- The rail down the start of the window, as on the page: as wide as its longest words, from 256
  to 320 pixels; in a window narrower than 1,008 pixels only its icons, and its menu button
  shows the words over the parts. It mirrors in Arabic. Up and Down move along it; Ctrl+1 to
  Ctrl+5 switch parts. Dark and light themes in the page's colours, the title bar with them.
- Type in Pretendard, its Regular, SemiBold, Bold and ExtraBold, which the program carries;
  Japanese in Yu Gothic UI, after Segoe UI so that a path's backslash is not drawn as a yen sign,
  and Chinese, Thai, Hindi and Arabic in Windows' own fonts. Korean breaks lines between words,
  not between syllables.
- Dialogs are windows of their own, which Windows and screen readers know as dialogs. Esc and
  the close button answer no.
- Screen readers meet it as they meet the page: headings, lists, tables with their column
  headers, the photo grid as a list whose tiles say whether they are chosen, cards that open as
  expanded or collapsed, and what a check or a search finds said as it is found. The focus goes
  to a part's heading when it is reached from another, and stays on the rail while the arrow
  keys go along it. Dates, lists and numbers are written as the page writes them, and a path or
  a name keeps its own direction in an Arabic sentence.
- A folder's plan draws only the rows in sight, so a plan of tens of thousands of files stays
  quick to open, filter and go through.
- Pictures are previewed by Windows' own decoders and videos by its media player, from the
  engine's memory; what Windows cannot show says so and how to open it once it is restored.
- It opens no browser, no folder picker and no Explorer, all of which would add pictures to the
  thumbnail cache a search for photos reads: a folder is typed or pasted.
- Closing the window while a folder is being written asks first; the window closes at once and
  the engine finishes the folder before it stops. A restore keeps the window open until it is
  written. An error nobody foresaw is said in a dialog, and the window stays.
- If the engine is missing or stops by itself, the window says so, with the last lines it said.
- 17 new strings, the window's own, in all 18 languages.

The engine:

- `solarljos-core.exe` is what `Solarljos.exe` was: the command line, the page and the
  node.exe they run on. The window starts it as `solarljos-core.exe desktop`, a new command:
  the page's server with no browser, which prints one line of JSON -- its port on 127.0.0.1 and
  a random key -- and wants that key on every request (`Authorization: Bearer`, or `?key=` for
  a copy's bytes alone, which Windows' media player asks for by address). Every other check the
  page's server makes stays. It stops when its stdin closes, after what it is writing.
- Double-clicked, or run as `gui`, it still opens the page in a browser window, and
  `node bin/solarljos.js gui` still does so everywhere.

Searches stop at once:

- A search started right after one was stopped no longer sits at "Waiting". The stopped search
  went on until the git program it was waiting for ended, and the new one waited for it: on this
  PC, 6 to 18 seconds when a photo search was stopped while git read the repositories, which
  took 21 of its 25 seconds. Now git's programs are given the search's AbortSignal and ended at
  once, a repository's failure no longer hides the stop (the next repository was read instead),
  and every source stops at the next file it reports. The next search starts 0.8 to 1.0 s after
  the stop.
- A source stopped halfway is no longer counted as failed; the search just ends.

The release:

- `Solarljos-0.8.0-win-x64.zip` holds the window, the engine and the two licences, with its
  SHA-256; `solarljos.cjs` is attached as before. The zip is the same byte for byte when built
  again from the tag with the pinned Node and .NET SDK (`global.json`): `npm run build:desktop`
  builds both, tries the engine as the window starts it and the window on a stand-in engine,
  and zips them in one order, every entry dated 1 January 1980. The release workflow attests the
  zip and each program in it. CI builds and tries it on every push.
- 0.7.2 was not released by itself; its fix is the one above.

## 0.7.1 (2026-10-01)

- The browser no longer offers to translate the page. Edge asked "Translate this page from
  English?" each time the window opened, because the page comes in English until it puts the
  chosen language in. The page has its own 18 languages, and the browser's translation would
  send the words on it, the names and folders of the files found among them, to a translation
  service. `index.html` now says `translate="no"` and carries the `notranslate` meta that Chrome
  and Edge read.

## 0.7.0 (2026-09-30)

The rail is back at the side, in 0.6.0's colours, and the page has a font of its own.

- The parts are a rail down the start of the window again, as in 0.5.0, in SoundVisualizer's
  colours: the cards' shade, each part an icon and its words, the chosen one bold on a blue tint
  with its icon in blue. The language, the theme switch and Quit sit at its foot. It is as wide
  as its longest words, from 256 to 320 pixels, so no language's parts take two lines; in a
  window narrower than 1,008 pixels it shows only its icons, and its menu button shows the words
  over the page (Esc or a click beside them closes them) or, in a wide window, folds them away.
  0.6.0's top bar of text tabs is gone. It mirrors in Arabic.
- The parts are links again, marked as the current page, which every screen reader knows. Tab
  moves along them, and so do Up, Down, Home and End; Ctrl+1 to Ctrl+5 still switch parts.
- The start's heading is the name, Solarljos, large, in place of "What did you lose?". The
  window's title there is just the name. The `home.title` string is gone from every language.
- Type in Pretendard 1.3.9, one variable font file (2,057,688 bytes) that the page carries in
  `src/gui/ui/fonts/`, unchanged from its release, with its SIL Open Font License beside it. It
  draws Latin, Greek, Cyrillic, Vietnamese and every Korean syllable. Its kana and CJK
  punctuation are not used, so Japanese and Chinese stay in their own Windows fonts, as Thai,
  Hindi and Arabic do. The exe is 2 MB larger; nothing is loaded from anywhere else.

## 0.6.0 (2026-09-30)

The page in the look of the author's SoundVisualizer app, made for a PC window.

- Dark by default, in SoundVisualizer's colours: the page #2A2C31, cards #1E2024 and darker than
  it, text #F2F4F6 and #8B95A1, its blue for what is chosen. A switch in the top bar changes to a
  light theme of the same design. The choice is kept by Solarljos for the run (`POST api/theme`),
  never by the browser. Where one of SoundVisualizer's colours fell short of 4.5:1 for text, a
  near one that passes is used: #2171EA under white words, #D32F2F for red buttons. The measured
  values are at the top of `src/gui/ui/style.css`.
- One bar at the top: the name, the parts as bold text tabs with a short bar under the chosen
  one, and the language, the theme switch and Quit. The tabs take a row of their own when the
  window is too narrow for one line, and scroll sideways if they still do not fit. The rail on
  the side is gone.
- The tabs are a real tab list. The arrow keys move along them (mirrored in Arabic), as do Home
  and End, and Ctrl+1 to Ctrl+5 switch parts except while a dialog is open.
- On/off options are switch rows you can click anywhere on. Check boxes stay where several things
  are chosen at once: places, kinds of file, the folder plan, the photo grid.
- "More options" and the sections of Help are cards that open and close with a short animation,
  as do options that only matter when another is on. Motion is dropped when the system asks.
- Form options sit in two columns where they fit. Content is centred at 1,120 pixels; the photo
  grid and results with a preview use up to 1,680. A form's main action is a large button, and
  the rest are regular PC size. Every control shows where the mouse is and has a focus ring.
- Two new strings, the theme switch's labels, in all 18 languages.

## 0.5.0 (2026-09-30)

No console window, eighteen languages, and a page redesigned in the manner of Windows 11 whose
parts keep their work while another is shown.

The Windows program:

- `Solarljos.exe` is a Windows GUI program. `scripts/build-exe.js` sets its PE header's Subsystem
  from the console's (3), which node.exe has, to the Windows GUI's (2), before it makes the
  checksum right, and reads the file back, which must say 2. Made a console program again, with
  its checksum made right, the exe differs in two bytes, one of the Subsystem and one of the
  CheckSum, and neither depends on the machine or the folder it was built in. A double-click opens
  only the browser window.
- It stops when that window is closed or *Quit* is pressed: 3 s after the page says goodbye, 30 s
  after it went without saying so or while a search runs, and 10 minutes after it started when no
  window connected, as before; a restore or a rebuild being written finishes first. Ctrl+C,
  closing the console and the 8 s wait for a write belong to `node bin/solarljos.js gui` in a
  terminal.
- A GUI program is given no console, even when it is started from one, so what it prints is seen
  only when it goes to a file or a program: Node puts the NUL device in place of each handle it
  was not given (`writesNowhere()` in `src/gui/launch.js`). Where nothing printed would be seen,
  Solarljos says what matters in a console window of its own, titled *Solarljos*: the address,
  when no browser could be started or `gui --no-open` was given; an error that stops it before its
  page opens; and, given arguments, how to use the command line -- send what it prints to a
  program or a file (`Solarljos.exe find budget | more`,
  `Solarljos.exe find budget > found.txt 2>&1`; `> NUL` counts as nowhere), or run
  `node solarljos.cjs ...`. Then it does nothing else, and ends with exit code 2. Piped or
  redirected, it works as before.
- That window is `cmd.exe /d`, which runs no AutoRun command and writes nothing, started detached
  so that it stays after Solarljos has exited. No text is on its command line: each line is in an
  environment variable, which cmd.exe puts in only after it has read the line, so no text can act
  as a command -- tried with `& | < > ^ ( ) % !` and quotes. A line is kept to one, with no control
  characters; text from outside Solarljos, such as an error's message, also loses `& | < > ^ %`
  and `"`; and an address is shown only when it is the server's own.
- Edge that cannot be started falls back to the default browser, through Explorer.
- The tries run the exe with pipes for its output, as a GUI program is handed them like any other,
  and fetch every page file `scripts/bundle.js` lists -- the language tables, which the page asks
  for itself, included -- comparing each with the bytes that went into the exe. Those bytes are
  copied when the tree is bundled, so a file saved in `src/gui` during a build cannot make the two
  differ.
- Each release also attaches `solarljos.cjs`, the script inside the exe, which is the command line
  alone for Node.js 22 or later, with `solarljos.cjs.sha256`; `build-exe.js` writes both SHA-256
  files once every check passed, and the build attestation covers both files.
- With the 17 catalogs, the bundle is 54 modules and 2,769,748 bytes, and the exe holds 21 page
  files, the 17 page tables among them: about 110 MB in all.

The page:

- Each part -- the start, *Find a file*, *Photos and videos*, *Bring back a folder*, *What is
  searched*, *Help* -- keeps its last view while another is shown: what its form held, its results
  with their filters, sort, selection and how many are shown, where it was scrolled to, and the
  preview that was open, with the focus where it was. A search keeps running, and its results
  keep coming in, while its part is hidden; a video in a hidden view is paused. A link in the rail
  goes back to its part's last view; results have *New search*, and a form has *Back to the
  results*, or *Back to the search under way* while it runs. Nothing of it is kept in the browser:
  a reload starts again from what the server still has.
- Redesigned in the manner of a Windows 11 app: a rail of places at the start of the window, each
  with an icon, which keeps only its icons below 1008 pixels and shows its words from a menu
  button; Segoe UI Variable, and each language's own font through `:lang()` where Segoe UI has no
  letters for it, with more room between lines for Korean, Japanese, Chinese, Thai, Hindi and
  Arabic; an 8-pixel rhythm, and one calm blue accent for what is chosen and for the one action
  that matters on each view. The controls, the tier pills -- an icon and the tier in words, never
  a colour alone -- the photo grid, a preview pane beside the results, and messages as bars with
  an icon, as in Windows' InfoBar, were all made again.
- Light and dark follow the system; in a high-contrast theme (forced colors) the system's colours
  are used and every box keeps a border; motion is dropped when the system asks. Every text colour
  was measured against every background it is shown on, light and dark alike, at 4.5:1 or more --
  muted text at 5.8:1 at the least in light and 6.7:1 in dark -- and every mark of where a control
  is and what state it is in at 3:1 or more, the focus ring at 12.8:1; `style.css` has every
  value at its top.

Languages:

- 18 languages: English, Korean, Japanese, Simplified and Traditional Chinese (`zh-CN`, `zh-TW`),
  Spanish, French, German, Brazilian Portuguese (`pt-BR`), Russian, Italian, Polish, Turkish,
  Vietnamese, Indonesian, Thai, Arabic, written right to left, and Hindi.
- The page: a language picker at the bottom of the rail lists each language whose table,
  `src/gui/ui/lang/<code>.json`, is there, by its own name. The first language is the one `--lang`
  gives, else the first of the browser's languages there is a table for, else English. Choosing
  another builds every view again in it, keeping what the forms and results held. Plural forms
  follow the language's rules (Intl.PluralRules), dates and numbers are written as its
  `meta.locale` writes them, and in Arabic the layout runs from the right, names and paths in a
  sentence keeping their own direction. Korean breaks lines between words (`keep-all`). Every
  table has all 679 keys of the English one.
- The library, the command line and the server: `src/i18n.js` has `setLocale()`, `getLocale()`,
  `matchLocale()` and `LOCALES`, which `src/index.js` exports too. Each language's catalog,
  `src/locales/<code>.json`, maps each of the 655 English messages `t()` is given to its
  translation, and all 17 are complete. A language is offered only when its catalog translates
  every message, so nothing comes out half in it and half in English; the language is English
  until it is set, and never taken from the machine.
- `--lang <code>` and the variable `SOLARLJOS_LANG` choose the command line's language, `--lang`
  first. Without either it is English, whatever the system's language, so what scripts read stays
  the same. A code with no complete translation gets a note, and English. `--help` lists the
  codes. `Solarljos.exe` given only `--lang` opens its window in that language.
- The page tells the server the language it is shown in (`POST api/lang`); the library speaks it
  from then on, so notes and reasons come in it from the next search on, and a reload of the page
  starts in it. Results found before a change keep the words they were found with, and the page
  says so. `api/info` gains `lang`, `locale` and `languages`, and each job's snapshot `lang`.
- The mark on a taken name is said in the language spoken, as the tags of a smaller copy and of
  one that may be incomplete are: `photo (복구됨 2).jpg` in Korean.
- The translations were written a language at a time, machine-assisted, and checked by
  translating them back into English. No native speaker has reviewed them yet; corrections from
  native speakers are welcome.
- For translators: `npm run i18n -- extract` (`scripts/i18n.js`) writes
  `src/locales/messages.json`, every message `t()` can be given, read from the sources as
  JavaScript tokens; `npm run i18n -- check` says how far each catalog is, and fails on a message
  missing, left over or empty, or a translation whose `{n}` are not the English's. The page's
  tables follow the rules at the top of `src/gui/ui/strings.js`: named placeholders, plural forms
  by the language's categories, and `meta.lang`, `meta.locale` and `meta.dir`.
  `test/i18n.test.js` and `test/gui-lang.test.js` hold both to them.

The command line:

- Columns line up by the width text takes in a terminal, not by its length (`src/format.js`:
  `displayWidth()`, `pad()`, `padStart()`, `fit()`). Text is taken a grapheme cluster at a time: a
  wide Korean, Japanese or Chinese character counts 2, an emoji 2, and a combining mark -- Thai
  vowels and tone marks, Devanagari matras, Arabic harakat -- 0.

Tests:

- New: `test/i18n.test.js`, `test/gui-lang.test.js`, `test/format.test.js`,
  `test/build-exe.test.js`, which tries the header work on made-up PE files on any system, and
  `test/launch.test.js`, whose programs are stand-ins but for one cmd.exe on Windows, run with the
  command line a console window gets in a console that is hidden. On Windows 11 with Node 24.20,
  `npm test` ran 631 tests: 622 passed, and 9 were skipped, which need Linux or what Windows does
  not give without privileges.

## 0.4.0 (2026-09-30)

Old photos and videos, and a graphical front end in one Windows program: three new sources, a
search by type, two new tiers for copies that are not simply the file, and restores that stream.

The Windows program and its window:

- `Solarljos.exe`, attached to each release, is all of Solarljos in one file of about 100 MB,
  Node.js included, with nothing to install and nothing written beside it. Started with no
  arguments -- a double-click -- it opens the graphical front end; given any, it is the command
  line. It is not signed: SmartScreen asks before its first run, and Smart App Control, where it
  is on, blocks it. `NODE_OPTIONS` does not reach it, and neither `NODE_V8_COVERAGE` nor
  `NODE_REDIRECT_WARNINGS` can make it write a file.
- `npm run build:exe` (Windows, Node 25.5 or later) builds it from a copy of the node.exe running
  it, with that node.exe's signature taken off, since it would no longer verify, and tries it --
  its version, that every source loads, a search and a restore on a made-up Linux trash, and the
  page served as a browser asks for it -- before it writes `Solarljos.exe.sha256`. `npm run bundle`
  writes the command line as one script, `dist/solarljos.cjs`, which runs on Node 22 or later;
  the page's own files go only into the exe. One commit built with one Node version gives the
  same exe byte for byte in any folder: built with Node 26.10.0 in two folders of different
  names, it came out with the same SHA-256 both times.
  `.github/workflows/release.yml` builds it with that Node on every `v*` tag, runs the tests, and
  attaches the exe, its SHA-256 and a build attestation to the release; CI builds and tries it on
  every push, and `npm test` bundles the tree and runs the bundle.
- `solarljos gui`, with `--no-open` and `--port <n>`, starts a web server on 127.0.0.1 only and
  opens its page: in an Edge InPrivate app window where Edge is installed, which keeps no history
  of the visit but writes what Edge writes whenever it starts; otherwise, and always when run as
  administrator, in the default browser through Explorer, which records the visit like any other.
  `--no-open` only prints the address.
- The page finds a file by name, by a word it contained or by kind of file, with the copies of
  each file together and the best one first; shows photos and videos in a grid by month, the
  undated ones in a group of their own; lists everything below a folder as a tree to tick;
  previews a copy as a picture, a video, text in its encoding, or bytes; and restores or rebuilds
  through the library and its checks, suggesting a folder on another drive and asking before it
  writes onto the drive a file was on. It keeps nothing in the browser and downloads nothing: a
  download would land in Downloads on the Windows drive, past every check a restore makes. It
  starts no program but the browser window, and does not open Explorer to show what it restored,
  which would make new thumbnails in the very cache a search for photos reads.
- Only its own window can use it. The address carries a token that works once, traded for an
  HttpOnly, SameSite=Strict cookie named after the port. Every request must name exactly
  127.0.0.1 and that port, come from that origin and carry the cookie, and one that changes
  anything must be a JSON POST with the page's own header. No reply is cached; a copy is shown
  only as a picture, a video, text -- an `.html` or `.svg` copy as its text -- or its bytes; and
  the page runs under a Content-Security-Policy with Trusted Types. Run as administrator, it
  refuses to write into Windows, Program Files and ProgramData, however they are reached.
- Before any window opens, it reads Explorer's thumbnail cache into memory, so that what the
  browser or Explorer writes afterwards cannot change what is found. It stops a few seconds after
  its page is closed, 30 s after the page went without saying goodbye, and 10 minutes after it
  started when no window connected, but never in the middle of a restore or a rebuild; Ctrl+C,
  or closing its console, waits up to 8 s for a write, and removes the temporary file of one it
  has to cut.

New sources:

- Explorer thumbnails (`thumbcache`): the smaller pictures Windows made of the files Explorer
  showed, from `thumbcache_*.db` in every format from Vista to 11, each entry checked by both of
  its CRC-64s and by its picture's own structure. Each is a smaller copy (tier 4), restored as
  `<name> (smaller copy WxH)<ext>` in its own format. The shortcuts and jump lists in `Recent`
  name the pictures whose key they hash to, with the path and the time of the version shown; the
  rest are listed only by a search by type for pictures with no name. The same folders in each
  shadow copy are read too. The key has the file's time rounded up to the next two seconds, and
  from Windows 8.1 on how far: rounded down, as the algorithm is usually read, only 16 of the 260
  files on disk here whose key is in the cache matched. On the machine this was written on, all
  1,775 entries of the live cache passed both checksums and all 810 pictures their own checks; a
  search for pictures offered 306, and 31 of them were named.
- Snipping Tool (`snips`): with saving turned off, the screenshots and screen recordings Windows
  11's Snipping Tool keeps in its own `TempState`, and those of Windows 10's Snip & Sketch in
  `ScreenClip`, exactly as taken, under the name the tool gave them. Each is dated by its file, or
  by the time in its name when the two are further apart than any two time zones. Nothing was
  there to read on the machine this was written on, where saving is on; of the 309 screenshots
  the tool had saved, every name's time was the file's to within five seconds.
- Cards and USB drives (`removable`): memory cards, USB sticks and disk images of them with
  FAT12, FAT16, FAT32 or exFAT, read only when named with `--location removable=<place>` -- a
  drive letter, `\\.\PhysicalDriveN`, a `/dev` node, or an image. Deleted files still in their
  folders come back with their names, sizes and times (`fat undelete`, `exfat undelete`), checked
  by their format's own structure; one whose clusters hold another format now is left out, and
  its clusters are left to carving. A search by type with no name carves free space (`carved`):
  pictures from JPEG to camera RAW, MP4, MOV, AVI and WMV video, WAV and WMA sound, PDF and
  ZIP-based documents, each followed through its own structure. A drive is read directly only
  when Solarljos runs as administrator; otherwise a note says to, or to give an image of it.
  Nothing is written to it, and restore and rebuild refuse to write onto it however it, or the
  destination, is named. On the public DFTT #11 image, all 7 photos and videos, both PDFs and the
  ZIP were carved with their published MD5s; on test images built here and formatted again with
  the same layout, 20 of 20 pictures came back byte for byte. It has not been tried on a real
  card.

Photos and videos:

- `--type image,video,audio,document,archive,text` -- `photos`, `pictures`, `videos`, `music`,
  `documents` and a few more words work too -- for `find` and `rebuild`, and for `show` and
  `restore` to find the same copies. A copy with a name is of a type by its extension; with no
  name, copies whose name was lost are offered too, told by their first 4 KB (`src/types.js`). An
  extension of two meanings -- `.ts` and `.mts`, `.mod`, `.key` -- is settled by the bytes where
  that decides. An unknown type is a usage error, exit code 2. Over the first 4 KB of 60,000 of
  the user's files here, the bytes agreed with the extension for every picture and video, and
  none of the 19,496 files whose extension says nothing was taken for a picture, a video or sound.
- A search by type that asks for neither text nor documents leaves out the six sources that keep
  only text: Editor Local History, Unsaved editor buffers, Claude Code, Antigravity, Eclipse Local
  History and Windows Notepad. The list shows `-` for them, with a note, and `--json` has
  `skipped: true`.
- Two new tiers: *may be incomplete* (3), read from free space or from clusters taken to follow
  each other, and *smaller copy* (4), made from the file, such as a thumbnail. `rebuild` never
  takes either. It lists those paths apart, `N file(s) are left out: ...`, to be restored one by
  one, and `--json` and planFolder() give them as `leftOut`. The kind in the list adds
  `(smaller copy)` or `(may be incomplete)`, and `rebuild --dry-run` shows `(never saved)` too.
- Restored names say what a copy is: `<stem> (smaller copy WxH)<ext>` in the smaller copy's own
  format, `<stem> (may be incomplete)<ext>`, the name a source knows for a copy with no folder,
  or `recovered-<id><ext>` with the extension of its format.
- `--since` keeps the copies that carry no date -- a thumbnail usually has none -- and says how
  many: `! N copy(ies) carry no date; they were kept, since how old they are cannot be told`.
- Every result carries `mediaType`, and one with no name, or in a format of its own, the
  extension of its format. The PATH column adds a picture's width and height, and shows
  `(name unknown, a .jpg file)` for a copy with neither a name nor a path. `--json` adds `tier`,
  `mediaType`, `derived`, `unverified`, `width`, `height` and the search's `notes`.
- Shadow copies: a search by name or type walks the user's Pictures, Videos and Music, those in
  `C:\Users\Public`, the OneDrive folders, `Dropbox` and the folder KakaoTalk saves chat photos
  into, as well as Desktop, Documents and Downloads, and with `--type` the folders that mostly
  hold those types first. With no name to go on, a snapshot copy of the same size and time as the
  file still in its place is left out, and counted. Measured here, a search for pictures from
  this source alone read about 4,750 folders in each of two snapshots in 1.1 s in all, left out
  2,986 unchanged copies, and offered 4 pictures, all four gone from disk.

Corrections:

- Restore and rebuild stream every copy, so one over 2 GiB comes back; before, a copy was read
  whole into memory, which fails there. A copy is written into `.~solarljos-<random>.part` beside
  where it goes and given its name -- by a hard link, or on FAT and exFAT by a rename -- only once
  all of it is there, and a failure removes the temporary file. Before, it was written under its
  own name from the first byte, so a restore cut short by a full disk or a killed process left a
  short file that looked like the copy.
- A destination that is a protected folder under another name -- `\\localhost\C$\...`, a SUBST or
  a mapped letter -- is refused, told by the folder's volume and file ID; before, only paths and
  the links on the way were compared.
- Shadow copies: in a search by name, a file in a folder that was both walked and read for
  another source's hit was offered twice, so its row counted it as two copies. A search for
  `package.json` here got 22 copies from the snapshots with 0.3.0 and 18 now, the other 4 being
  such doubles. The one-level reads of folders where the other sources found something stop after
  5,000, with a note; before, they had no limit.
- In a search by content alone, shadow copies no longer offer a copy that is the same size and
  time as the file still in its place.
- A copy whose name was lost is restored with the extension of its format; before, it had none.
- `--help` names the programs a search starts, git and `mountvol.exe`, and says what the browser
  window writes.

Core:

- `src/index.js` adds `openCopy()`, any part of any copy as a stream; `checkDestination()`;
  `freeze()`; `removeUnfinished()`; `sniff()`; `TYPES`; `tier()`; and `isElevated()`. `sources`
  entries gain `media` and `needsAdmin`. `search()` takes `types`, and `signal`, an AbortSignal
  that stops it at its next step, and returns `notes`; a source it leaves out reports
  `source-done` with `skipped: true`. `planFolder()` returns `leftOut` and `notes`, and
  `rebuildFolder()` takes `{ onProgress }`.
- When identical copies merge, each flag -- never saved, inexact, may be incomplete, smaller copy
  -- holds only when every copy has it, counting what its kind implies, and a copy whose name was
  lost adds to the row of the same bytes under a name.
- A copy read from a card is checked as it is written against what the search read: its whole
  hash for one of 32 MB or less, its first 4 KiB otherwise. One that changed fails, and nothing
  is left under its name.
- Telling whether it runs as administrator opens `\\.\PhysicalDrive0` for reading and closes it
  at once; nothing is read from it.

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
