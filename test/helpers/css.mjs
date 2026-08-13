/**
 * Test seam for the style bundle.
 *
 * Thin cache over tools/css-bundle.mjs: a hundred contract tests read the
 * stylesheet; without the cache that is a hundred walks and hundred
 * concatenations of the same bytes. Same pattern as the _fileCache the
 * package tests already keep.
 */

import { styleFiles as _styleFiles, bundleStyles } from '../../tools/css-bundle.mjs';

export function styleFiles() {
  return _styleFiles();
}

let _bundle = null;

/** The concatenated stylesheet, in cascade order. Cached for the process. */
export function readBundle() {
  if (_bundle === null) _bundle = bundleStyles();
  return _bundle;
}
