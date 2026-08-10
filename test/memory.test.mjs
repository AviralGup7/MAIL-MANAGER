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

test('R1: closing the reader reorients to the read row', () => {
  const close = js.slice(js.indexOf('function closeReader('), js.indexOf('function closeReader(') + 1200);
  assert.match(close, /if \(prev\) reorientTo\(prev\);/);
});

test('the pulse is paint-only and reduced-motion keeps the scroll', () => {
  const kf = css.slice(css.indexOf('@keyframes reorient-pulse'), css.indexOf('@keyframes reorient-pulse') + 200);
  assert.match(kf, /background-color: var\(--accent-soft\)/);
  assert.ok(!/height|width|transform|top|left/.test(kf), 'the pulse must not move the row');
  const fn = js.slice(js.indexOf('function reorientTo('), js.indexOf('function reorientTo(') + 800);
  assert.ok(fn.indexOf('scrollIntoView') < fn.indexOf('prefers-reduced-motion'),
    'scroll first; the pulse is the part reduced motion drops');
});

test('R4: mailboxes keep their scroll position', () => {
  const sel = js.slice(js.indexOf('function selectCategory('), js.indexOf('function selectCategory(') + 700);
  assert.match(sel, /scrollMemory\.set\(state\.category, el\.scroller\.scrollTop\)/);
  assert.match(sel, /el\.scroller\.scrollTop = scrollMemory\.get\(key\) \|\| 0;/);
});

test('R5: clearing a search restores the pre-search scroll', () => {
  assert.match(js, /if \(!state\.query && el\.search\.value\) preQueryScroll = el\.scroller\.scrollTop;/);
  assert.match(js, /el\.scroller\.scrollTop = state\.query \? 0 : preQueryScroll;/);
});

test('R3: arrivals while scrolled surface as a pill, not a silent toast', () => {
  assert.match(js, /if \(n && el\.scroller\.scrollTop > 200\)/);
  assert.match(js, /\$\{newCount\} new — jump up/);
  assert.match(js, /\$\('newpill'\)\.addEventListener\('click'/);
});

test('R2: undo restores pulse the row back into view', () => {
  assert.match(js, /requestAnimationFrame\(\(\) => reorientTo\(id\)\);/);
  assert.match(js, /requestAnimationFrame\(\(\) => reorientTo\(snapshots\[0\]\?\.id\)\);/);
});
