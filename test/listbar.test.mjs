/**
 * The morphing list bar (audit 33, concept #1).
 *
 * `#listhead` and `#bulkbar` are two states of one surface and share a
 * fixed-height slot (`#listbar`) so the scroller top never moves when the
 * mode changes. These are the structural half of the contract; the
 * behavioural half (synchronous `hidden` on both bars) is asserted by the
 * existing integration tests, which this work was required to keep passing
 * UNMODIFIED — jsdom never fires animationend, so the outgoing bar must hide
 * at once and only the incoming bar animates.
 *
 * Every test here was sabotage-verified before being trusted: each contract
 * was broken in a scratch copy and the test watched fail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { readBundle } from './helpers/css.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const html = read('app.html');
const css = readBundle();

/** Extract one CSS rule block by selector (first match). */
function block(sel) {
  const i = css.indexOf(sel + ' {');
  assert.ok(i !== -1, `${sel} block not found`);
  let depth = 0;
  for (let j = css.indexOf('{', i); j < css.length; j++) {
    if (css[j] === '{') depth++;
    if (css[j] === '}') { depth--; if (depth === 0) return css.slice(i, j + 1); }
  }
  throw new Error(`unbalanced block for ${sel}`);
}

test('#listbar owns both bars and a fixed height', () => {
  const listbar = html.match(/<div id="listbar">([\s\S]*?)\n            <\/div>\n            <!--\n              The scroller/);
  assert.ok(listbar, '#listbar wrapper must close before #scroller');
  for (const id of ['listhead', 'bulkbar']) {
    assert.ok(listbar[1].includes(`id="${id}"`), `#${id} must live inside #listbar`);
  }
  const rule = block('#listbar');
  assert.match(rule, /position:\s*relative/, 'the slot must position its states');
  // Sabotage-verified: delete this line and the bars stack, the list jumps.
  assert.match(rule, /height:\s*var\(--listbar-h\)/, 'fixed height token, never content-sized');
  assert.match(rule, /flex:\s*none/);
  for (const id of ['listhead', 'bulkbar']) {
    const r = block(`#${id}`);
    assert.match(r, /position:\s*absolute/, `#${id} must fill the slot, not size it`);
    assert.match(r, /inset:\s*0/);
  }
});

test('--listbar-h is remapped per density, like --row-h', () => {
  // One token per density, in the existing blocks — a second declaration of
  // the density selector would be caught by the layer test, but the token
  // itself must sit in all three or one density silently inherits 41px.
  assert.match(block(':root'), /--listbar-h:\s*41px/);
  assert.match(block(":root[data-density='cosy']"), /--listbar-h:\s*37px/);
  assert.match(block(":root[data-density='compact']"), /--listbar-h:\s*33px/);
});

test('the morph animates no forbidden layout property', () => {
  // Static padding is fine; the contract is that no TRANSITION, ANIMATION or
  // keyframe frame moves a layout property (the list must never reflow).
  // Sabotage-verified: add `height` to a transition list, expect fail.
  const FORBIDDEN = /(?:^|[,\s{])(?:width|height|max-height|top|left|right|bottom|margin|padding|font-size)\s*:/;
  const animated = [];
  for (const sel of [
    '#listhead', '#bulkbar',
    '#listhead:not([hidden])',
    '#bulkbar:not([hidden]) #bulk-all-wrap',
    '#bulkbar:not([hidden]) #bulk-actions',
    '#bulk-count',
  ]) {
    for (const line of block(sel).split('\n')) {
      if (/transition\s*:|animation\s*:/.test(line)) animated.push(line);
    }
  }
  for (const kf of ['head-in', 'bar-check-in', 'bar-actions-in']) {
    animated.push(...block(`@keyframes ${kf}`).split('\n'));
  }
  for (const line of animated) {
    assert.ok(!FORBIDDEN.test(line), `forbidden layout property animates: ${line.trim()}`);
  }
});

test('exactly one aria-live region inside #listbar', () => {
  const listbar = html.match(/<div id="listbar">([\s\S]*?)\n            <\/div>\n            <!--\n              The scroller/);
  const live = (listbar[1].match(/aria-live=/g) || []).length;
  assert.equal(live, 1, 'two live regions would announce every selection twice');
});

test('bulk actions are icon buttons, labelled and text-free', () => {
  // Five text verbs needed 423px in a ~318px pane; three were unreachable at
  // every viewport. Icon buttons with aria-label/title are the shipped fix.
  const bar = html.match(/<div id="bulk-actions">([\s\S]*?)<\/div>/);
  const buttons = [...bar[1].matchAll(/<button[^>]*>([^<]*)<\/button>/g)];
  assert.equal(buttons.length, 5);
  for (const [tag, text] of buttons) {
    assert.match(tag, /class="ghost icon/, 'icon-only button');
    assert.match(tag, /aria-label="[^"]+"/, 'an icon button without a label is silent to AT');
    assert.match(tag, /title="[^"]+"/);
    assert.equal(text.trim(), '', 'no text content — the label moved to aria-label');
  }
});

test('the preview bundler output parses (audit 33, three defects)', () => {
  // `$&` expansion, bare `export { x };` and `import * as ns` each used to
  // leave a SyntaxError in preview.html while `npm run preview` exited 0.
  // Build the real bundle and PARSE it; a regression here is a blank preview.
  return import('../tools/make-preview.mjs').then(({ bundle }) => {
    const code = bundle('src/app/app.js');
    // Parsing IS the contract: all three defects manifested as SyntaxError.
    new vm.Script(code);
  });
});
