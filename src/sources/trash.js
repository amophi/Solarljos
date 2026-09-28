'use strict';

// Placeholder while this source is written: it finds nothing yet.

module.exports = {
  id: 'trash',
  label: 'Trash (Linux)',
  discover: () => [],
  scan: async () => [],
  describe: () => ['Not implemented yet.'],
  roots: (loc) => loc['trash'] || [],
};
