/**
 * Spatial memory (audit 38, concept #6). The pulse is paint-only and the
 * scroll is the information: reduced motion keeps the scroll, drops the
 * pulse. Each contract sabotage-verified.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'src/app/app.css'), 'utf8');
const js = readFileSync(join(ROOT, 'src/app/app.js'), 'utf8');
// The reader cluster moved out of app.js in the round-51 workspace extraction.
const reader = readFileSync(join(ROOT, 'src/app/reader.js'), 'utf8');
// The list cluster moved out in round 52 (workspace sequence step 2).
const list = readFileSync(join(ROOT, 'src/app/list.js'), 'utf8');

test('R1: closing the reader reorients to the read row', () => {
  const close = reader.slice(reader.indexOf('function closeReader('), reader.indexOf('function closeReader(') + 1400);
  assert.match(close, /if \(prev\) ctx\.reorientTo\(prev\);/);
});

test('the pulse is paint-only and reduced-motion keeps the scroll', () => {
  const kf = css.slice(css.indexOf('@keyframes reorient-pulse'), css.indexOf('@keyframes reorient-pulse') + 200);
  assert.match(kf, /background-color: var\(--accent-soft\)/);
  assert.ok(!/height|width|transform|top|left/.test(kf), 'the pulse must not move the row');
  const fn = list.slice(list.indexOf('function reorientTo('), list.indexOf('function reorientTo(') + 800);
  assert.ok(fn.indexOf('scrollIntoView') < fn.indexOf('prefers-reduced-motion'),
    'scroll first; the pulse is the part reduced motion drops');
});

test('R4: mailboxes keep their scroll position', () => {
  const sel = js.slice(js.indexOf('function selectCategory('), js.indexOf('function selectCategory(') + 700);
  assert.match(sel, /saveScroll\(state\.category\);/);
  assert.match(sel, /el\.scroller\.scrollTop = recallScroll\(key\);/);
  // and the memory itself lives with the list, set and recalled verbatim
  assert.match(list, /scrollMemory\.set\(key, el\.scroller\.scrollTop\)/);
  assert.match(list, /return scrollMemory\.get\(key\) \|\| 0;/);
});

test('R5: clearing a search restores the pre-search scroll', () => {
  assert.match(js, /if \(!state\.query && el\.search\.value\) capturePreSearchScroll\(\);/);
  assert.match(list, /preQueryScroll = el\.scroller\.scrollTop/);
  assert.match(list, /el\.scroller\.scrollTop = hasQuery \? 0 : preQueryScroll;/);
});

test('R3: arrivals while scrolled surface as a pill, not a silent toast', () => {
  assert.match(list, /el\.scroller\.scrollTop > 200/);
  assert.match(list, /\$\{newCount\} new — jump up/);
  assert.match(list, /\$\('newpill'\)\.addEventListener\('click'/);
  // the shell's refresh only toasts what the pill did not take
  assert.match(js, /const pillShown = announceNew\(n\);/);
});

test('R2: undo restores pulse the row back into view', () => {
  assert.match(js, /requestAnimationFrame\(\(\) => reorientTo\(id\)\);/);
  // The bulk path renamed its snapshot list; the pin tracks the live name.
  assert.match(js, /requestAnimationFrame\(\(\) => reorientTo\(appliedSnapshots\[0\]\?\.id\)\);/);
});
