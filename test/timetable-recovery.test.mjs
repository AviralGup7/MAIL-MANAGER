/**
 * Timetable full-value recovery (round 63 item; responsive-audit §6: at
 * narrow widths information must be CONDENSED, never silently erased).
 *
 * Below 860px the .tt-where/.tt-who columns collapse, and both ellipsize at
 * any width. The pins freeze the two recovery surfaces: hover titles on the
 * clipped spans, and one condensed `.tt-meta` line the narrow grid shows in
 * the middle column's second row.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundle } from './helpers/css.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const ui = read('src/app/academic/timetable-ui.js');
const css = readBundle();

test('clipped timetable cells carry their full value as a title', () => {
  assert.match(ui, /where\.title = where\.textContent;/);
  assert.match(ui, /who\.title = who\.textContent;/,
    'the instructor list ellipsizes at any width, so hover must recover it whole');
});

test('a condensed meta line is rendered and placed in the narrow grid', () => {
  assert.match(ui, /el\('span', 'tt-meta'\)/);
  assert.match(ui, /row\.append\(tag, when, where, who, meta, acts\)/,
    'meta precedes the actions so auto-placement still lands acts in the last column');
  // Wide: hidden. Narrow: one line in the middle column's second row.
  assert.match(css, /\.tt-meta \{ display: none; \}/);
  const block = css.match(/@media \(max-width: 860px\) \{[\s\S]*?\.tt-meta \{([\s\S]*?)\n  \}/);
  assert.ok(block, 'the 860px block owns the meta rule');
  for (const decl of ['display: block', 'grid-column: 2', 'grid-row: 2',
                      'min-width: 0', 'text-overflow: ellipsis', 'white-space: nowrap']) {
    assert.ok(block[1].includes(decl), `.tt-meta missing ${decl} in the narrow rule`);
  }
});

test('placeholder noise does not pad the condensed line', () => {
  // "no room" and "—" are layout fills, not facts; the meta line drops them
  // so a course with neither still shows a calm, honest line.
  assert.match(ui, /\.filter\(\(t\) => t && t !== 'no room' && t !== '—'\)/);
});
