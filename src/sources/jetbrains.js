'use strict';

// Placeholder while this source is written: it finds nothing yet.

module.exports = {
  id: 'jetbrains',
  label: 'JetBrains Local History',
  discover: () => [],
  scan: async () => [],
  describe: () => ['Not implemented yet.'],
  roots: (loc) => loc['jetbrains'] || [],
};
