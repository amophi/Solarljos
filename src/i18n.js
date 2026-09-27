'use strict';

// Every user-facing string goes through t(), so a translation table can be added later
// without touching the call sites. English is the source language; {0}, {1}... are filled
// from the arguments.

function t(message, ...args) {
  return message.replace(/\{(\d+)\}/g, (whole, i) => (i < args.length ? String(args[i]) : whole));
}

module.exports = { t };
