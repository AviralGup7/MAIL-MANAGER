/**
 * Drawer-regime rail manners (2026-08-13).
 *
 * THE BUG THIS PINS
 * -----------------
 * Below 1240px the For-you rail stops being a reserved grid column and
 * becomes a 320px fixed drawer floating OVER the mail (`position: fixed` in
 * the 1240 media block — deliberate, like Gmail's slide-ins). But wireRail
 * applied the persisted `railOpen` setting unconditionally at BOOT, and the
 * rail self-hides while its sections are empty. So the sequence the user
 * lived through was: load (no rail, nothing overlaps) → data lands ~1s later
 * → the self-hiding :has() flips → a fixed drawer springs open across the
 * list: "the whole mail page slides under it."
 *
 * A drawer must never open ITSELF. The fix keeps the setting's meaning where
 * it makes sense — the DESKTOP column preference — and starts the drawer
 * regime shut: the button summons it, Escape/outside-press dismiss it, and
 * crossing the seam in either direction re-derives visibility from the
 * regime plus the preference instead of letting one boolean mean two kinds
 * of open.
 *
 * These pins guard the rule, not the pixels: boot is regime-gated, the seam
 * crossing is handled, and the drawer stays a deliberate overlay (the fixed
 * positioning is the reason the manners exist — do not "fix" that away).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const shell = read('src/app/main.js');
const skin = read('src/styles/86-v3-skin.css');

test('boot applies the saved preference only at column widths', () => {
  assert.match(shell,
    /apply\(settings\.get\('railOpen'\) !== false && !drawerMq\.matches\)/,
    'the drawer regime starts shut — an overlay may not spring open unasked');
});

test('crossing the 1240 seam re-derives visibility from regime + preference', () => {
  assert.match(shell,
    /const onSeam = \(mq\) => apply\(mq\.matches \? false : settings\.get\('railOpen'\) !== false\)/,
    'folding into drawer widths puts the overlay away; unfolding restores the preference');
  assert.match(shell, /addEventListener\('change', onSeam\)/, 'seam changes are heard');
  assert.match(shell, /addListener\?\.\(onSeam\)/, 'legacy/test-double fallback kept');
});

test('explicit summons still work in the drawer regime', () => {
  /* The button writes the setting AND applies locally — no path was removed,
     only the unprompted one. */
  assert.match(shell, /btn\.addEventListener\('click', \(\) => \{[\s\S]{0,200}?settings\.set\('railOpen', on\)/);
});

test('the drawer stays a deliberate overlay', () => {
  const seam = skin.indexOf('@media (max-width: 1240px)');
  const next = skin.indexOf('@media (max-width: 1080px)');
  assert.ok(seam !== -1 && next > seam, 'the seam block exists before the next rung');
  const block = skin.slice(seam, next);
  assert.match(block, /body\.rail-open #rail \{[\s\S]*?position: fixed;/,
    'the overlay posture is why the manners exist — pinning it keeps the two in sync');
  assert.match(block, /width: min\(320px, 88vw\);/, 'drawer width unchanged');
});
