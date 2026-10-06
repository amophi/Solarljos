'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { breather } = require('../src/breather');

test('a breather lets the event loop run once its time is up, and not before', async () => {
  const soon = breather(60000);
  let ran = false;
  setImmediate(() => (ran = true));
  await soon();
  assert.strictEqual(ran, false, 'it waits on nothing before its time is up');
  const now = breather(0);
  await new Promise((resolve) => setTimeout(resolve, 2));
  await now();
  assert.strictEqual(ran, true, 'what was waiting for the event loop ran');
});
