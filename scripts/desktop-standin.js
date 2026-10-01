'use strict';

// A stand-in for solarljos-core.exe, for trying the Windows program (scripts/build-desktop.js):
// the engine's own server in desktop mode, over a library that has one place to search and finds
// nothing, so that the window starts, connects and shows itself without anything of this machine
// being searched. It says where it is on stdout as the engine does, and stops when its stdin closes.
//
//   SOLARLJOS_CORE="node scripts/desktop-standin.js" Solarljos.exe

const path = require('path');
const { start } = require(path.join(__dirname, '..', 'src', 'gui', 'server.js'));

const api = {
  sources: [{ id: 'recycle', label: 'Recycle Bin', media: true, needsAdmin: false }],
  TYPES: ['image', 'video', 'audio', 'document', 'archive', 'text'],
  async search() {
    return { results: [], perSource: [], locations: {}, stats: {}, notes: [] };
  },
};

(async () => {
  const server = await start({
    desktop: true, api, open: false, exit: false, elevated: false, program: false,
    log: (s) => process.stderr.write(s + '\n'), locations: { discover: false },
  });
  process.stdout.write(JSON.stringify({ solarljos: 'stand-in', port: server.port, key: server.key }) + '\n');
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
})().catch((e) => {
  process.stderr.write(String((e && e.stack) || e) + '\n');
  process.exit(1);
});
