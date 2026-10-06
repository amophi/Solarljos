'use strict';

/**
 * A pause for the event loop once in a while, for a long stretch of work that waits on nothing:
 * a walk of a snapshot's folders with readdirSync, every result of a search looked up and hashed.
 * An `await` of what is ready lets nothing else run, so what serves the page -- and a stop -- was
 * held for seconds: 4.3 s in a photo search on the machine this was written on, long enough for a
 * connection left waiting to be reset. Each breather gives the loop a turn when `every` ms have
 * passed since its last.
 */
function breather(every = 25) {
  let at = Date.now();
  return async () => {
    if (Date.now() - at < every) return;
    await new Promise((resolve) => setImmediate(resolve));
    at = Date.now();
  };
}

module.exports = { breather };
