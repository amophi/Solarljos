'use strict';

// Placeholder while this source is written: it finds nothing yet.

module.exports = {
  id: 'editor-backups',
  label: 'Unsaved editor buffers',
  discover: () => [],
  scan: async () => [],
  describe: () => ['Not implemented yet.'],
  roots: (loc) => loc['editor-backups'] || [],
};
