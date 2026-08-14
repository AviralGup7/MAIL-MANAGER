/**
 * Fuzz sweep, round 4 (3/3 — 2026-08-14, defect #21): the sanitiser's walk
 * is depth-bounded; nesting is a strip, never a stack overflow.
 *
 * THE ACCUSATION, CONFIRMED BEFORE THE FIX. `walk` recursed once per element
 * level with no limit. Measured on the pre-fix code (jsdom, same harness as
 * sanitize.test.mjs): 2000 nested <div>s cleaned fine, 8000 threw
 * "RangeError: Maximum call stack size exceeded". Eight thousand divs is
 * one line of Python for a sender and a plausible accident for a broken
 * mail-merge template. renderBody has no catch above sanitizeHtml, so the
 * mail failed as a generic load error FOREVER — every retry re-crashed, and
 * the theme-repaint call site (reader.js:1095) has no catch at all. The
 * same "unbounded attacker depth" lesson mime.js learned at 64; the HTML
 * walker now holds its own line at 256 (~4x the deepest real marketing mail
 * measured during the fix, ~30x under the measured overflow).
 *
 * Properties pinned:
 *   - sanitizeHtml NEVER throws across the depth boundary, including the
 *     exact 8000 that overflowed before;
 *   - content at legal depth is preserved VERBATIM — the bound refuses
 *     subtrees, not mail;
 *   - past the bound the subtree is stripped while siblings survive — a
 *     bounded mail keeps its readable shallows;
 *   - hostile attribute soup and hostile text never throw either (the fuzz
 *     half: throws are the defect class, substrings are not).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  test('fuzz-sanitize-depth (skipped: jsdom not installed)', { skip: true }, () => {});
}

const { sanitizeHtml, escapeHtml } = await import('../src/app/core/sanitize.js');
const { mulberry32, hostileString } = await import('./helpers/fuzz.mjs');

function clean(html, opts) {
  const dom = new JSDOM('<!doctype html><body></body>');
  return sanitizeHtml(html, dom.window.document, opts);
}

const nest = (depth, leaf) => '<div>'.repeat(depth) + leaf + '</div>'.repeat(depth);

test('the walk never overflows, at and far past the boundary', () => {
  if (!JSDOM) return;
  for (const depth of [100, 255, 256, 257, 2000, 8000]) {
    let out;
    assert.doesNotThrow(() => { out = clean(nest(depth, 'leaf')); }, `depth ${depth}`);
    assert.equal(typeof out, 'string');
  }
});

test('legal depth is preserved; past the bound the subtree strips, siblings survive', () => {
  if (!JSDOM) return;
  const shallow = clean(nest(60, 'keep-me'));
  assert.match(shallow, /keep-me/);
  // A leaf at depth 4000 is past the bound: it strips. A sibling at the
  // surface lives at its own depth and must not be punished for it.
  const mixed = clean(nest(4000, 'deep-leaf') + '<p>surface-sibling</p>');
  assert.match(mixed, /surface-sibling/);
  assert.doesNotMatch(mixed, /deep-leaf/);
});

test('fuzz: hostile bodies and attribute soup never throw the walker', () => {
  if (!JSDOM) return;
  const rnd = mulberry32(0x5a11ce);
  for (let i = 0; i < 400; i++) {
    const tag = ['div', 'span', 'table', 'font', 'marquee', 'x-bmm', 'a'][Math.floor(rnd() * 7)];
    const attr = ['style', 'href', 'src', 'onload', 'bgcolor', 'title'][Math.floor(rnd() * 6)];
    const html = `<${tag} ${attr}="${hostileString(rnd).replace(/"/g, "'")}">${hostileString(rnd)}</${tag}>`;
    let out;
    assert.doesNotThrow(() => { out = clean(html); }, `seed 0x5a11ce draw ${i}: ${html.slice(0, 120)}`);
    assert.equal(typeof out, 'string');
  }
  // escapeHtml stays a pure total escape over the same pool. ACQUITTAL
  // (recorded per doctrine): the first property here — "no [&<>\"] in the
  // output" — accused escapeHtml at seed 0x5a11ce draw 47, but "&lt;"
  // CONTAINS an ampersand by definition; the entity IS the fix, not the
  // leak. The honest property: no raw angle brackets survive, and every
  // surviving ampersand heads one of the five issued entities.
  for (let i = 0; i < 200; i++) {
    const out = escapeHtml(hostileString(rnd));
    assert.doesNotMatch(out, /[<>]/, `seed 0x5a11ce text draw ${i}`);
    const entities = out.replace(/&(amp|lt|gt|quot|#39);/g, '');
    assert.ok(
      !entities.includes('&'),
      `seed 0x5a11ce text draw ${i}: stray & in ${JSON.stringify(out.slice(0, 80))}`
    );
  }
});
