/**
 * Shared-element travel (audit 36, concept #4).
 *
 * The archived row condenses into the Undo toast: one body-level fixed
 * ghost, transform/opacity only, never created under reduced motion, never
 * fired by bulk archive, cleaned up without leaks. The flight itself is
 * verified browser-side (verify4: exactly-one-ghost sampling, bulk and
 * reduced-motion negative cases); these tests pin the code and CSS
 * contracts. Each sabotage-verified.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundle } from './helpers/css.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readBundle();
// The list cluster moved out of app.js in the round-52 workspace extraction:
// the ghost lives in list.js, optimistic() stayed in the shell, and bulkAct
// moved to bulk.js (step 6).
const js = readFileSync(join(ROOT, 'src/app/main.js'), 'utf8');
const list = readFileSync(join(ROOT, 'src/app/mail/list.js'), 'utf8');
const bulkSrc = readFileSync(join(ROOT, 'src/app/mail/bulk.js'), 'utf8');

const fn = list.slice(list.indexOf('function travelGhost('), list.indexOf('function travelGhost(') + 4000);

test('the ghost is fixed, click-transparent and hidden from AT', () => {
  const rule = css.slice(css.indexOf('.travel-ghost {'));
  const block = rule.slice(0, rule.indexOf('}') + 1);
  assert.match(block, /position:\s*fixed/, 'rows are contain: paint; only a body-level fixed node can travel');
  assert.match(block, /pointer-events:\s*none/);
  assert.match(fn, /setAttribute\('aria-hidden', 'true'\)/, 'the toast already announces');
});

test('the flight animates transform and opacity only', () => {
  const frames = fn.slice(fn.indexOf('g.animate('), fn.indexOf('duration:'));
  // offset is a keyframe position, not a property. Anything layout-shaped
  // here would drag the compositor into the scroll path.
  const FORBIDDEN = /\b(left|top|right|bottom|width|height|max-height|margin|padding|font-size)\s*:/;
  assert.ok(!FORBIDDEN.test(frames), `non-composited property in flight: ${frames.match(FORBIDDEN)?.[0]}`);
  assert.ok(/transform:/.test(frames) && /opacity:/.test(frames), 'the flight is transform+opacity');
});

test('reduced motion creates no ghost node at all', () => {
  // Not 1ms, not hidden: never created. Creating motion to hide it is the
  // wrong instinct, and the audit made that the contract.
  assert.ok(
    fn.indexOf("matchMedia('(prefers-reduced-motion: reduce)').matches) return") !== -1,
    'the reduced-motion gate must return before createElement'
  );
  assert.ok(fn.indexOf('document.createElement') > fn.indexOf('prefers-reduced-motion'),
    'createElement must sit after the gate');
});

test('exactly one ghost; bulk archive creates none', () => {
  // Single owner: a second archive cancels and replaces, like closeWithMotion.
  assert.match(fn, /travelGhostEl\.getAnimations/, 'cancel-and-replace ownership');
  assert.match(fn, /travelGhostEl\.remove\(\)/);
  // Bulk never reaches optimistic(), so it cannot fire the travel; and
  // optimistic captures the travel for ARCHIVE only.
  assert.match(js, /if \(verb === 'ARCHIVE'\)/, 'travel captured for archive alone');
  const bulk = bulkSrc.slice(bulkSrc.indexOf('function bulkAct('), bulkSrc.indexOf('function bulkAct(') + 3000);
  assert.ok(!bulk.includes('travelGhost'), 'bulk must not fire the travel');
});

test('cleanup without leaks: finish and a fallback timer both remove', () => {
  assert.match(fn, /const fallback = setTimeout\(finish, 400\)/);
  assert.match(fn, /clearTimeout\(fallback\); finish\(\);/);
  assert.match(fn, /if \(travelGhostEl === g\) travelGhostEl = null;/);
});

test('the destination is the live toast rect, never hardcoded', () => {
  assert.match(fn, /el\.toast\.getBoundingClientRect\(\)/);
  assert.ok(!/bottom:\s*22px|22px/.test(fn), 'no toast coordinate may be copied into the travel');
});
