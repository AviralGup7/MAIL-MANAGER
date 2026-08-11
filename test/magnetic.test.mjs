/**
 * Magnetic alignment (audit 34, concept #2).
 *
 * The selected row settles one row inside the viewport edge instead of
 * flush against it, via `scroll-padding-block: var(--row-h)` on #scroller.
 * Purely positional: no motion, no snap, no smooth scroll. The lookahead is
 * the feature; these tests pin the contract and record the rejected
 * alternatives so they cannot creep back in. Each was sabotage-verified.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'src/app/app.css'), 'utf8');
const js = readFileSync(join(ROOT, 'src/app/app.js'), 'utf8');
// move() left app.js with the bulk cluster (round 52 step 6).
const bulk = readFileSync(join(ROOT, 'src/app/bulk.js'), 'utf8');

function scrollerBlock() {
  const i = css.indexOf('#scroller {');
  assert.ok(i !== -1);
  let depth = 0;
  for (let j = css.indexOf('{', i); j < css.length; j++) {
    if (css[j] === '{') depth++;
    if (css[j] === '}') { depth--; if (depth === 0) return css.slice(i, j + 1); }
  }
  throw new Error('unbalanced #scroller block');
}

test('#scroller pads the viewport by exactly one row, via the token', () => {
  const rule = scrollerBlock();
  // Sabotage-verified: hardcode 68px and this fails — the value must track
  // --row-h or cosy/compact silently get comfortable's lookahead.
  assert.match(rule, /scroll-padding-block:\s*var\(--row-h\)/);
});

test('move() still lands rows with block: nearest', () => {
  // The padding is what does the work. A future switch to 'center' would
  // silently double the scrolled distance per step, so pin the call.
  const move = bulk.slice(bulk.indexOf('function move('), bulk.indexOf('function move(') + 1500);
  assert.match(move, /scrollIntoView\(\{\s*block:\s*'nearest'\s*\}\)/);
});

test('move() keeps its feature check on scrollIntoView', () => {
  // A dead `j` key is worse than a missing scroll; the typeof guard is the
  // contract. Sabotage: delete the guard, expect fail.
  assert.match(bulk, /typeof node\?\.scrollIntoView === 'function'/);
});

test('no scroll-snap and no smooth scrolling on #scroller', () => {
  // Both rejected in the audit: snap hijacks free scanning and computes
  // against content-visibility-skipped layout; smooth has the held-`j`
  // failure mode. Recorded here so neither creeps back.
  const rule = scrollerBlock();
  assert.ok(!/scroll-snap-type/.test(rule), 'scroll-snap was rejected, deliberately');
  assert.ok(!/scroll-behavior:\s*smooth/.test(rule), 'smooth scrolling is deferred, not bundled');
});

test('overflow-anchor stays enabled on #scroller', () => {
  // Delta sync inserts above the selection; anchoring is what keeps the
  // viewport from sliding. The padding must not have cost it.
  assert.match(scrollerBlock(), /overflow-anchor:\s*auto/);
});
