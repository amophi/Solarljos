'use strict';

// Where each language's catalog is, for src/i18n.js: <code>.json beside this file, a flat object
// from the exact English message to its translation. English has none; it is what the call sites
// say. messages.json, also here, lists every message t() can be given; scripts/i18n.js makes it.
//
// The names are written out below and read with a require() of a name worked out, as search.js
// loads the sources, so scripts/bundle.js bundles each of these files that is there. A language
// whose file is not there yet is then not an error, only a language with no translation: a
// require() written out in full would stop the bundle until all seventeen were written.

const FILES = {
  'ko': './ko.json',
  'ja': './ja.json',
  'zh-CN': './zh-CN.json',
  'zh-TW': './zh-TW.json',
  'es': './es.json',
  'fr': './fr.json',
  'de': './de.json',
  'pt-BR': './pt-BR.json',
  'ru': './ru.json',
  'it': './it.json',
  'pl': './pl.json',
  'tr': './tr.json',
  'vi': './vi.json',
  'id': './id.json',
  'th': './th.json',
  'ar': './ar.json',
  'hi': './hi.json',
};

/**
 * A language's catalog as its file has it, or null when there is none, or none that can be read:
 * a language setting is no reason to stop, and scripts/i18n.js check says what is wrong with the
 * file. The bundle has no such file, since scripts/bundle.js refuses JSON it cannot read.
 */
function catalog(code) {
  if (!Object.hasOwn(FILES, code)) return null;
  try {
    return require(FILES[code]);
  } catch (_) {
    return null;
  }
}

/** Every message t() can be given, each with the files it is in. */
function messages() {
  return require('./messages.json');
}

module.exports = { FILES, catalog, messages };
