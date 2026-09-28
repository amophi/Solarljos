'use strict';

// Placeholder while this source is written: it finds nothing yet.

module.exports = {
  id: 'eclipse-history',
  label: 'Eclipse Local History',
  discover: () => [],
  scan: async () => [],
  describe: () => ['Not implemented yet.'],
  roots: (loc) => loc['eclipse-history'] || [],
};
