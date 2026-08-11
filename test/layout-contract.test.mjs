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
  assert.match(app, /READER_TYPOGRAPHY/, 'the reader has a density table');
  for (const d of ['comfortable', 'cosy', 'compact']) {
    assert.match(app, new RegExp(`${d}:\\s*\\{ size:`), `${d} has reading metrics`);
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
