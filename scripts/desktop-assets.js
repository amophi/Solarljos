'use strict';

// What the Windows program (desktop/Solarljos) takes from the page, so that the two say the same
// words and draw the same icons. It is written into desktop/Solarljos/Assets, which the program
// embeds, from what the page has:
//
//   en.json         the English table of src/gui/ui/strings.js, the source of every language;
//                   the other languages' tables, src/gui/ui/lang/<code>.json, the program embeds
//                   where they are
//   icons.json      the page's icons (src/gui/ui/app.js's ICONS), the rail's (index.html) and the
//                   program's own, by name: each a list of SVG path data on a 24 by 24 box
//   languages.json  src/i18n.js's LOCALES: each language's code and its own name
//
//   node scripts/desktop-assets.js           write them
//   node scripts/desktop-assets.js --check   say whether they are what would be written, exit 1 if not
//
// test/desktop.test.js runs the check, so that a string or an icon changed for the page and not
// carried over fails the tests.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'desktop', 'Solarljos', 'Assets');

/** app.js's ICONS, read from its source: the page is a script for a browser, not a module. */
function pageIcons() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'gui', 'ui', 'app.js'), 'utf8');
  const circle = /const CIRCLE = '([^']+)';/.exec(src);
  const start = src.indexOf('const ICONS = {');
  const end = src.indexOf('\n  };', start);
  if (!circle || start < 0 || end < 0) throw new Error('app.js: ICONS not found');
  // eslint-disable-next-line no-new-func
  return new Function('CIRCLE', `return ${src.slice(start + 'const ICONS = '.length, end + 4)};`)(circle[1]);
}

/** The icons of the rail, as index.html draws them, and the program's own. */
const OWN = {
  menu: ['M4 6.5h16', 'M4 12h16', 'M4 17.5h16'],
  help: ['M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z', 'M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.5', 'M12 16.6v.1'],
  globe: ['M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z', 'M3.5 12h17',
    'M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5', 'M12 3.5C9.6 5.8 8.4 8.6 8.4 12s1.2 6.2 3.6 8.5'],
  sun: ['M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z', 'M12 2.8v2', 'M12 19.2v2', 'M2.8 12h2', 'M19.2 12h2', 'M5.5 5.5l1.4 1.4',
    'M17.1 17.1l1.4 1.4', 'M5.5 18.5l1.4-1.4', 'M17.1 6.9l1.4-1.4'],
  moon: ['M19.5 14.6A7.8 7.8 0 0 1 9.4 4.5a7.8 7.8 0 1 0 10.1 10.1z'],
  // The mark: a sun, filled, and its rays, drawn as lines.
  logoSun: ['M12 7.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9z'],
  logoRays: ['M12 2.5v2.2', 'M12 19.3v2.2', 'M2.5 12h2.2', 'M19.3 12h2.2', 'M5.3 5.3l1.55 1.55', 'M17.15 17.15l1.55 1.55',
    'M5.3 18.7l1.55-1.55', 'M17.15 6.85l1.55-1.55'],
};

function assets() {
  const { en } = require(path.join(ROOT, 'src', 'gui', 'ui', 'strings.js'));
  const icons = { ...pageIcons(), ...OWN };
  const { LOCALES } = require(path.join(ROOT, 'src', 'i18n.js'));
  const json = (v) => JSON.stringify(v, null, 2) + '\n';
  return {
    'en.json': json(en),
    'icons.json': json(Object.fromEntries(Object.keys(icons).sort().map((k) => [k, icons[k]]))),
    'languages.json': json(LOCALES.map(({ code, name }) => ({ code, name }))),
  };
}

function main(argv) {
  const want = assets();
  if (argv.includes('--check')) {
    const stale = Object.keys(want).filter((name) => {
      try {
        return fs.readFileSync(path.join(OUT, name), 'utf8') !== want[name];
      } catch (_) {
        return true;
      }
    });
    for (const name of stale) process.stdout.write(`desktop/Solarljos/Assets/${name} is not what this script would write now\n`);
    return stale.length ? 1 : 0;
  }
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, text] of Object.entries(want)) fs.writeFileSync(path.join(OUT, name), text);
  process.stdout.write(`wrote ${Object.keys(want).join(', ')} to desktop/Solarljos/Assets\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { assets };
