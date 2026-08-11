/**
 * Layout & reader-frame contract tests (round 45 H1/H2/H3 + arch A2/A4).
 *
 * jsdom has no layout engine, so these pin the CONTRACT the CSS declares:
 * the breakpoint ladder, the narrow-window invariants, the themed reader
 * frame, the density-aware reader typography, and the motion token rules.
 * A real-browser visual pass (tools/visual-regression.mjs) executes them
 * optically; this file stops them regressing in the meantime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/app/app.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app/app.js', import.meta.url), 'utf8');

test('the responsive ladder is complete from 1080 down to 480', () => {
  for (const w of [1080, 860, 720, 600, 480]) {
    assert.ok(css.includes(`@media (max-width: ${w}px)`),
      `missing the ${w}px breakpoint`);
  }
});

test('below 600px the panes stack and compose spans the window', () => {
  // THE NARROW CONTRACT: the list and the reader must both stay usable when
  // a row cannot hold them -- so they stack, neither is display:none'd, and
  // compose stops pretending to be a 580px card.
  const at = css.indexOf('@media (max-width: 600px)');
  const block = css.slice(at, css.indexOf('}', css.indexOf('#compose', at)) + 1);
  assert.match(block, /grid-template-columns: 1fr/, 'panes go single-column');
  assert.match(block, /grid-template-rows/, 'and split the height instead');
  assert.match(block, /#compose\s*\{[^}]*width: 100%/s, 'compose spans the window');
  assert.ok(!/display: none/.test(css.slice(at, at + 900).split('#listpane')[0] || ''),
    'no pane may be removed to make space');
});

test('the reader frame wears the theme, not hardcoded white (round 45 H3)', () => {
  const at = css.indexOf('#r-body {');
  const block = css.slice(at, css.indexOf('}', at));
  assert.match(block, /background: var\(--bg-raised\)/,
    'the frame behind the srcdoc follows the active theme');
  assert.ok(!/#fff/.test(block), 'no hardcoded white');
});

test('reader typography follows the density setting (round 45 H2)', () => {
  // The table lives in the reader frame contract module (arch A2); the app
  // consumes it. Check both halves of that contract.
  const rf = readFileSync(new URL('../src/app/reader-frame.js', import.meta.url), 'utf8');
  assert.match(rf, /READER_TYPOGRAPHY/, 'the reader has a density table');
  for (const d of ['comfortable', 'cosy', 'compact']) {
    assert.match(rf, new RegExp(`${d}:\\s*\\{ size:`), `${d} has reading metrics`);
  }
  assert.match(app, /READER_TYPOGRAPHY\[settings\.get\('density'\)\]/,
    'and the srcdoc is built from the live setting');
});

test('motion durations ride the token scale (round 45 H4)', () => {
  // Transition/animation SHORTHANDS must use the duration tokens. The two
  // legitimate exceptions are stagger `animation-delay` ramps (arithmetic
  // sequences, not durations) and keyframe-internal steps -- neither is a
  // shorthand, so they are not what this scans. No animation is removed or
  // shortened by this rule: it only forbids bespoke durations.
  const lines = css.split('\n');
  const bad = [];
  for (const l of lines) {
    if (!/\b(transition|animation)\s*:/.test(l)) continue;
    if (/animation-delay/.test(l)) continue;
    if (/[0-9]ms/.test(l) && !/var\(--dur-/.test(l)) bad.push(l.trim());
  }
  assert.deepEqual(bad, [], 'off-token durations in shorthands');
});

test('reduced motion zeroes duration AND delay', () => {
  const at = css.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  const block = css.slice(at);
  assert.match(block, /animation-duration: 1ms !important/);
  assert.match(block, /animation-delay: 0ms !important/,
    'stagger delays are motion too, and get the same treatment');
});

test('every motion duration token is defined and used', () => {
  for (const t of ['--dur-instant', '--dur-fast', '--dur-base', '--dur-slow', '--dur-pulse', '--dur-flash']) {
    assert.ok(css.includes(`${t}:`), `${t} defined`);
    assert.ok(css.includes(`var(${t})`), `${t} used`);
  }
});

test('the focus policy is deliberate: focus-visible everywhere, focus on inputs', () => {
  // Round 45 Phase 2 pins the policy so it stays a decision: keyboard users
  // get rings via the global :focus-visible rule; the bare-:focus rules are
  // reserved for text surfaces where a click-focus ring is the point.
  assert.match(css, /^:focus-visible \{\s*outline: 2px solid var\(--accent\)/m,
    'one global keyboard-focus ring');
  const bareFocusSelectors = [...css.matchAll(/^([^{}\n]*):focus(?![-\w])/gm)]
    .map((m) => m[1].trim());
  for (const sel of bareFocusSelectors) {
    // #list suppresses its own ring so the SELECTED ROW wears it instead
    // (#list:focus-visible .row[aria-selected]) — part of the same policy.
    assert.ok(/#search|#palette-input|#c-text|\.c-row input|prompt-box input|^#list$/.test(sel),
      `bare :focus is reserved for text inputs, found: ${sel}`);
  }
});

test('dialogs trap focus and announce destructive questions (round 45 Phase 2)', () => {
  const layers = readFileSync(new URL('../src/app/layers.js', import.meta.url), 'utf8');
  const dialog = readFileSync(new URL('../src/app/dialog.js', import.meta.url), 'utf8');
  assert.match(layers, /export function trapFocus/, 'the layer module owns the trap');
  // The trap is openLayer's DEFAULT now (round 46 arch #6): call sites inherit
  // it instead of asking, and a dialog must not carry its own Tab handler.
  assert.match(layers, /opts\.trap === false \? null : trapFocus\(opts\.node, doc\)/,
    'openLayer traps by default, opt-out only');
  const dialog2 = dialog;
  assert.ok(!/e\.key !== 'Tab'/.test(dialog2), 'no hand-rolled Tab trap left in dialogs');
  assert.match(dialog, /role', danger \? 'alertdialog' : 'dialog'/,
    'destructive questions announce themselves');
  assert.match(dialog, /cancelBtn\.focus\(\)/, 'and the safe button is the default');
  const toastSrc = readFileSync(new URL('../src/app/toast.js', import.meta.url), 'utf8');
  assert.match(toastSrc, /kind === 'error' \? 'alert' : 'status'/,
    'error toasts are assertive announcements');
  const app2 = readFileSync(new URL('../src/app/app.js', import.meta.url), 'utf8');
  assert.match(app2, /el\.list\.focus\(\{ preventScroll: true \}\)/,
    'bulk actions return focus to the list');
});

test('motion accessibility is complete: nothing animates without a reduced-motion story (round 46 arch #8)', () => {
  // The product decision is that animation STAYS; the only motion debt is
  // accessibility completeness. The global reduced-motion block zeroes
  // duration AND delay for every element, so every declaration has a story.
  // This pin fails if that block is weakened, and if any NEW infinite
  // animation appears that is not the documented skeleton shimmer.
  const rmBlocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{/g)]
    .map((m) => css.slice(m.index, css.indexOf('\n}', m.index)));
  const rm = rmBlocks.find((b) => b.includes('animation-duration: 1ms !important'));
  assert.ok(rm, 'the global reduced-motion block exists');
  assert.match(rm, /animation-duration: 1ms !important/);
  assert.match(rm, /animation-delay: 0ms !important/);
  assert.match(rm, /animation-iteration-count: 1 !important/,
    'infinite work-reporters stop iterating under reduced motion');

  // Two work-reporters may run indefinitely: the skeleton shimmer and the
  // topbar busy sweep -- both stop the moment their work stops, which is
  // the rule. Anything else infinite needs a decision here.
  const infinite = [...css.matchAll(/animation:[^;]*infinite[^;]*;/g)]
    .map((m) => m[0])
    .filter((a) => !a.includes('sk-shimmer') && !a.includes('sweep'));
  assert.deepEqual(infinite, [],
    'only work-reporting animations may run indefinitely');
});
