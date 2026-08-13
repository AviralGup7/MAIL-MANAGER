/**
 * Round 46 Phase A pins — the cheap/high-value fixes stay fixed.
 *
 * Each pin exists because the fix is small and the regression would be
 * silent: a missing aria-label, a hidden mute state, a coach toast on the
 * gate. These are exactly the changes a future edit could undo without any
 * other test noticing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readBundle } from './helpers/css.mjs';

const app = readFileSync(new URL('../src/app/app.js', import.meta.url), 'utf8');
// The reader cluster moved out of app.js in the round-51 workspace extraction.
const reader = readFileSync(new URL('../src/app/reader.js', import.meta.url), 'utf8');
// The list cluster moved out in round 52 (workspace sequence step 2).
const list = readFileSync(new URL('../src/app/list.js', import.meta.url), 'utf8');
const compose = readFileSync(new URL('../src/app/compose.js', import.meta.url), 'utf8');
const sanitize = readFileSync(new URL('../src/app/sanitize.js', import.meta.url), 'utf8');
const css = readBundle();

test('mute state is visible in the rail (round 46 #28)', () => {
  // The rail moved to sidebar.js (round 52); the rules read goes through ctx.
  const sidebar = readFileSync(new URL('../src/app/sidebar.js', import.meta.url), 'utf8');
  assert.match(sidebar, /dataset\.muted = String\(ctx\.getRules\(\)\.muted\.includes/,
    'the rail marks muted categories');
  assert.match(css, /\.cat\[data-muted='true'\]/, 'and styles them as muted');
});

test('the coach toast waits for a signed-in session (round 46 #44)', () => {
  // The j/k hint must not appear on the sign-in gate where no list exists.
  const bootTheme = app.indexOf('Theme next, before anything paints');
  const coachInStart = app.indexOf('if (!coachShown)');
  assert.ok(coachInStart !== -1, 'coach block exists');
  // The coach now runs AFTER the signedIn gate, i.e. after showGate/hideGate.
  const gate = app.indexOf("if (!signedIn) return showGate('');");
  assert.ok(coachInStart > gate, 'coach fires after the gate, not on it');
  assert.ok(bootTheme > coachInStart || bootTheme !== -1);
});

test('theme changes announce themselves (round 46 #3)', () => {
  assert.match(app, /toast\(theme\.name, \{ ms: 1200 \}\)/,
    'applying a theme speaks, so success and failure share one language');
});

test('selection checkboxes name their message (round 46 #46)', () => {
  assert.match(list, /aria-label', `Select \$\{m\.subject \|\| m\.from\}`/,
    'each tick carries its subject, not a clone label');
});

test('touch gestures own deliberate motion only (round 46 #11)', () => {
  assert.match(list, /touchStart\.moved = true/, 'a pan never triggers a swipe');
  assert.match(list, /Math\.abs\(dx\) > 60 && Math\.abs\(dx\) > 2 \* Math\.abs\(dy\)/,
    'horizontal dominance is required');
  assert.match(css, /touch-action: pan-y/, 'vertical pan stays with the browser');
  assert.match(css, /@media \(pointer: coarse\)/, 'coarse pointers get bigger targets');
});

test('long mail reopens where it was left (round 46 #23)', () => {
  assert.match(reader, /readPosition\.set\(prev, sc\.scrollTop\)/, 'position is saved on close');
  assert.match(reader, /readPosition\.get\(body\.id\)/, 'and restored on open');
});

test('folded quotes offer unfold-all (round 46 #19)', () => {
  assert.match(reader, /querySelectorAll\('details\.quote-fold'\)/, 'folds are counted');
  assert.match(reader, /unfold\.hidden = folds\.length === 0/, 'control only while folds exist');
});

test('blocked and unresolved images say which they are (round 46 #26)', () => {
  assert.match(sanitize, /Image hidden until you trust this sender/, 'blocked is named');
  assert.match(sanitize, /Inline image could not be found/, 'unresolved is named');
});

test('external links name their destination (round 46 #24)', () => {
  assert.match(sanitize, /el\.setAttribute\('title', host\)/, 'the hostname is the title');
});

test('plain-text mail reads as code, not prose (round 46 #25)', () => {
  assert.match(reader, /pre\{[^}]*ui-monospace/, 'pre gets a monospace affordance');
});

test('the minimised compose names parked files (round 46 #40)', () => {
  assert.match(compose, /file\$\{pendingFiles\.length === 1 \? '' : 's'\}/,
    'a parked draft with files does not look text-only');
});

test('compose is a drop target (round 46 #36)', () => {
  assert.match(compose, /addEventListener\('drop'/, 'drop attaches files');
  assert.match(compose, /classList\.add\('dropping'\)/, 'and says so while dragging');
  assert.match(css, /#compose\.dropping/, 'with a visible affordance');
});

test('no wrong-theme frame before the theme lands (round 46 #10)', () => {
  assert.match(css, /html:not\(\[data-theme\]\) body \{\s*visibility: hidden/,
    'the body stays hidden until applyTheme stamps data-theme');
});
