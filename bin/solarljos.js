#!/usr/bin/env node
'use strict';

const cli = require('../src/cli');

cli
  .main(process.argv.slice(2))
  .then(
    (code) => { process.exitCode = code; },
    (err) => {
      const message = (err && err.message) || String(err);
      console.error(message);
      process.exitCode = 2;
      // Where stderr goes nowhere, as for Solarljos.exe started by a double-click, the error is
      // shown in a console window of its own instead (src/gui/launch.js).
      return cli.unseen(message);
    }
  );
