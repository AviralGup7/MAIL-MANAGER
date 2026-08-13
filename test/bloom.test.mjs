/**
 * Attention bloom (audit 35, concept #3; mechanism v2 from round 64.5).
 *
 * The attended row gives the rest of a clipped subject the snippet's share
 * of the line: the snippet leaves the flex row and the subject's width cap
 * lifts. v1 clamped the subject to two lines and faded the snippet; that
 * only fitted inside the old 68px row and struck the separator at 62px.
 * v2 re-prioritises width instead of height, keeping the fixed geometry the
 * list contract depends on. Comfortable density only, selection-driven,
 * gated on the subject actually being clipped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundle } from './helpers/css.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readBundle();
const js = readFileSync(join(ROOT, 'src/app/main.js'), 'utf8');
// The list cluster moved out of app.js in the round-52 workspace extraction.
const list = readFileSync(join(ROOT, 'src/app/mail/list.js'), 'utf8');

const BLOOM_SUBJ = ":root[data-density='comfortable'] .row[aria-selected='true'].subj-clip .r-subj {";
const BLOOM_SNIP = ":root[data-density='comfortable'] .row[aria-selected='true'].subj-clip .r-snip {";

function block(sel) {
  const i = css.indexOf(sel);
  assert.ok(i !== -1, `missing rule: ${sel}`);
  let depth = 0;
  for (let j = css.indexOf('{', i); j < css.length; j++) {
    if (css[j] === '{') depth++;
    if (css[j] === '}') { depth--; if (depth === 0) return css.slice(i, j + 1); }
  }
  throw new Error('unbalanced');
}

test('the bloom completes the subject across the full line, on selection', () => {
  const subj = block(BLOOM_SUBJ);
  // v2: the 58% cap lifts so the clipped subject runs to the category tag.
  assert.match(subj, /max-width:\s*none/, 'subject cap lifts when attended');
  const snip = block(BLOOM_SNIP);
  // Replaced, not stacked: the snippet leaves the flex line entirely, which
  // is what frees the width. A fade (v1) would leave it occupying space.
  assert.match(snip, /display:\s*none/);
  assert.ok(!/opacity/.test(snip), 'display, not opacity — the space must actually transfer');
});

test('the bloom is comfortable-density only, by selector, not by accident', () => {
  // cosy and compact stay intentionally unchanged; if a bloom rule ever
  // appears for them it must be a new, argued decision.
  assert.ok(!css.includes("data-density='cosy'] .row[aria-selected"), 'cosy must not bloom');
  assert.ok(!css.includes("data-density='compact'] .row[aria-selected"), 'compact must not bloom');
});

test('selection drives the bloom; hover does not', () => {
  // Two attended rows at once read as a broken list. A :hover bloom would
  // put the pointer and the keyboard in competition; selection wins outright.
  assert.ok(!/\.row:hover[^{]*subj-clip/.test(css), 'no hover-driven bloom');
  assert.ok(!/\.row:hover[^{]*line-clamp/.test(css), 'no hover-driven clamp change');
  assert.ok(css.includes(".row[aria-selected='true'].subj-clip"), 'keyboard path guaranteed');
});

test('the bloom touches nothing that changes row geometry', () => {
  // v2 lifts the subject's width CAP (max-width) — legal because the row's
  // height never moves: the subject was already on this line, it simply
  // runs further along it. Anything else layout-flavoured — an explicit
  // width, height, margin, padding — would move the row box, which is the
  // one thing the bloom may never do.
  const FORBIDDEN = /(?:^|[,\s{])(?:width|height|max-height|top|left|right|bottom|margin|padding|font-size)\s*:/;
  const ALLOWED = /^(white-space|display|-webkit-line-clamp|-webkit-box-orient|text-overflow|opacity|transition|max-width)\s*:/;
  for (const sel of [BLOOM_SUBJ, BLOOM_SNIP]) {
    for (const raw of block(sel).split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('/*') || line.startsWith('*') || /[{}]/.test(line) && !line.includes(':')) continue;
      if (!line.includes(':') || line.endsWith('{')) continue;
      assert.ok(ALLOWED.test(line), `unexpected property in bloom: ${line}`);
      assert.ok(!FORBIDDEN.test(line), `layout property in bloom: ${line}`);
    }
  }
});

test('row geometry is fixed in both states', () => {
  // The bloom re-prioritises existing pixels; if the row could grow, the
  // list contract (fixed --row-h, paint containment, 60fps) is broken.
  const at = css.search(/^\.row \{/m);
  assert.ok(at !== -1, '.row rule exists at line start (not in prose)');
  const row = css.slice(at, at + 600);
  assert.match(row, /height:\s*var\(--row-h\)/);
  assert.match(row, /contain:\s*layout paint style/);
});

test('the JS gate blooms only subjects that are actually clipped', () => {
  // A fitting subject must never cost its row the snippet. The class is the
  // measurement (scrollWidth > clientWidth), written in fillRow and
  // refreshed on density change.
  assert.match(list, /subjEl\.scrollWidth > subjEl\.clientWidth/);
  assert.match(list, /classList\.toggle\('subj-clip', clipped\)/);
  assert.ok(list.includes("node.classList.toggle('subj-clip', s.scrollWidth > s.clientWidth)"),
    'density change must re-decide the clip condition');
});
