/**
 * Particle consumer wiring (animation overhaul P6c).
 *
 * WHY THESE PINS EXIST
 * --------------------
 * The engine's pins (motion-particles) cannot see the three mistakes that
 * make the effect silently never fire or fire wrongly, because all three
 * live in ORDER, and order is exactly what a reformat or a "simplify" pass
 * scrambles invisibly:
 *
 *   1. The send burst must MEASURE #c-send before closeCompose() — after
 *      the panel leaves there is no button left to measure. (The first
 *      draft of this wiring landed the burst on the draft-DISCARD path
 *      too; celebrating a throwaway is worse than no burst.)
 *   2. The trash dust must MEASURE rows before storeOf().batch() — after
 *      removal there is no row. And the per-selection budget must stay
 *      inside the 240 pool by construction, not luck.
 *   3. The gate assembly fires only on a real hidden→shown edge — an
 *      error-message re-render must not re-fire the one T5 the budget
 *      allows.
 *
 * These are source pins (the palette-recents precedent): the behavioral
 * truth is covered by the P7 live walk; these pins keep the wiring exact
 * in the meantime.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compose = readFileSync(join(ROOT, 'src/app/compose.js'), 'utf8');
const bulk = readFileSync(join(ROOT, 'src/app/bulk.js'), 'utf8');
const app = readFileSync(join(ROOT, 'src/app/app.js'), 'utf8');

test('send burst: measure BEFORE closeCompose, burst AFTER, send path only', () => {
  assert.match(compose, /import \{ burst as fxBurst \} from '\.\/motion\/particles\.js'/);
  const send = compose.match(/saveOutbox\(\[\.\.\.queue, item\]\);([\s\S]*?)const who = draft\.to/);
  assert.ok(send, 'the send path block exists');
  const block = send[1];
  // Match CALLS (with parens), not the words — the comments discuss these
  // very functions, and prose mentions precede code.
  assert.ok(block.indexOf('getBoundingClientRect()') < block.indexOf('closeCompose()'),
    'the rect is read while the button still exists');
  assert.ok(block.indexOf('fxBurst(') > block.indexOf('closeCompose()'),
    'the burst fires after the panel leaves — the energy stays, the chrome goes');
  // The draft-discard path (the OTHER discard();closeCompose() pair) must
  // stay burst-free.
  const [, secondPair] = compose.split(/await ensureDraftSaver\(\)\.discard\(\);\n\s*closeCompose\(\);/);
  assert.ok(secondPair, 'the unadorned discard pair still exists (discard deserves no confetti)');
});

test('trash dust: rects before the batch, bursts after, pool-budget by construction', () => {
  assert.match(bulk, /import \{ burst as fxBurst \} from '\.\/motion\/particles\.js'/);
  const act = bulk.slice(bulk.indexOf('export async function bulkAct'));
  assert.ok(act.indexOf('getBoundingClientRect') < act.indexOf('storeOf().batch('),
    'after storeOf().remove there is no row left to measure');
  assert.ok(act.indexOf('fxBurst') > act.indexOf('storeOf().batch('),
    'dust lands on the post-removal scene');
  assert.match(act, /ids\.slice\(0, 8\)/, 'spots capped at 8');
  const m = act.match(/fxBurst\(x, y, \{ count: (\d+)/);
  assert.ok(m && Number(m[1]) * 8 <= 240, '8 spots × count must fit the 240 pool without sharing');
  assert.match(act, /kind === 'trash'/, 'trash only — archive/spam stay silent (spectacle is a budget)');
});

test('gate assembly: exactly the hidden→shown edge, rect of the card', () => {
  assert.match(app, /import \{ assemble as fxAssemble \} from '\.\/motion\/particles\.js'/);
  const show = app.slice(app.indexOf('function showGate'));
  assert.match(show, /gateWasHidden = el\.gate\.hidden;\s*\n\s*el\.gate\.hidden = false;/,
    'the edge is captured before the state flips');
  assert.match(show, /if \(gateWasHidden\)[\s\S]*?fxAssemble\(/,
    're-rendering an error message must not re-fire the hero');
  assert.match(show, /getElementById\('gate-card'\)\?\.getBoundingClientRect\(\)/,
    'particles converge on the card, not somewhere near it');
});
