'use strict';

// Placeholder while this source is written: it finds nothing yet.

module.exports = {
  id: 'notepad',
  label: 'Windows Notepad',
  discover: () => [],
  scan: async () => [],
  describe: () => ['Not implemented yet.'],
  roots: (loc) => loc['notepad'] || [],
};
