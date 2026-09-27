#!/usr/bin/env node
'use strict';

require('../src/cli')
  .main(process.argv.slice(2))
  .then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.error((err && err.message) || String(err));
      process.exitCode = 2;
    }
  );
