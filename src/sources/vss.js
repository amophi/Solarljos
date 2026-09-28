'use strict';

// Placeholder while this source is written: it finds nothing yet.

module.exports = {
  id: 'vss',
  label: 'Volume Shadow Copies',
  followUp: true,
  discover: () => [],
  scan: async () => [],
  describe: () => ['Not implemented yet.'],
  roots: (loc) => loc['vss'] || [],
};
