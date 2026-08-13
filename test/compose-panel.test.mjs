/**
 * Compose panel geometry contract (2026-08-13).
 *
 * The corner dock (`right: 22px; bottom: 0`) was measured floating 278px
 * over the pinned context rail at a plain 1440px window -- no text covered,
 * which is precisely what made it read as a bug. The panel is now
 * bottom-centre with a width cap chosen so the rail can never be reached:
 * while the rail is a pinned column (>1240px) it owns 300px of the right
 * edge, and (1241 - 300) / 2 = 470px of free half-window beats the card's
 * 340px half-width at every such width.
 *
 * These pins bite if either half of that bargain regresses: the centring
 * (left/right pair + auto margins, no transform -- transform is the
 * entrance animation's channel) or the 680px cap.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readBundle } from './helpers/css.mjs';

const css = readBundle();

/** The first #compose rule's declaration block. */
function composeBlock() {
  const at = css.indexOf('\n#compose {');
  assert.ok(at > -1, 'the base #compose rule exists');
  return css.slice(at, css.indexOf('}', at));
}

test('compose hangs from the window midpoint, not a corner', () => {
  const block = composeBlock();
  assert.match(block, /left: 0;/, 'left anchor');
  assert.match(block, /right: 0;/, 'right anchor');
  assert.match(block, /margin-inline: auto;/, 'auto margins do the centring');
  assert.match(block, /bottom: 22px;/, 'docked a step off the glass, not welded to it');
  assert.match(block, /width: min\(680px, calc\(100vw - 48px\)\);/,
    'the 680px cap is the rail-clearance guarantee (half-width 340 < 470 free at >1240px)');
  assert.doesNotMatch(block, /transform/, 'geometry must not sit on the animation channel');
  assert.match(block, /border-radius: var\(--r-xl\);/,
    'all four corners rounded -- a floating window, not a docked sheet');
});

test('a minimised draft slims to a strip rather than holding the lane open', () => {
  const at = css.indexOf('#compose.minimised {');
  assert.ok(at > -1, 'the minimised rule exists');
  const block = css.slice(at, css.indexOf('}', at));
  assert.match(block, /width: min\(440px/, 'the strip is narrower than the composer');
});

test('the toast still out-ranks the composer', () => {
  // Both now live at bottom-centre. The collision is resolved by the z tokens,
  // and only that way round: an undo window is time-critical, compose waits.
  const tokens = readBundle();
  assert.match(tokens, /--z-compose: 60;/);
  assert.match(tokens, /--z-toast: 80;/);
});

test('the narrow ladder still welds compose to the bottom edge (600px contract)', () => {
  // layout-contract.test pins width: 100% in this block; this pins the other
  // half of the mobile regime -- the centring margin must come OFF, or a
  // full-width card with auto margins contradicts itself.
  const at = css.indexOf('@media (max-width: 600px)');
  const block = css.slice(at, css.indexOf('}', css.indexOf('#compose', at)) + 1);
  assert.match(block, /margin-inline: 0;/, 'no auto-margins when spanning');
  assert.match(block, /bottom: 0;/, 'welded to the glass on a phone');
});
