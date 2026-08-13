/**
 * Spatial compression system (audit 37, concept #5) — O1/O3/O7/O16.
 *
 * One system, four moves, keyed on task changes (scan/read/write), never on
 * selection. The doctrine relaxation is scoped: only #panes and the topbar
 * may transition layout, each with a measurement filed in audit 37.
 * Behavioural halves (widths, collapse, dim, fold render) are verified in
 * real Chrome; these pin the contracts. Each sabotage-verified.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundle } from './helpers/css.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const css = readBundle();
const js = read('src/app/app.js') + read('src/app/compose.js')
  // The scroller-fade toggle moved with the list cluster (round 52).
  + read('src/app/list.js')
  // The selecting-class toggle moved with the bulk cluster (step 6).
  + read('src/app/bulk.js');

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip below */ }

test('O1: RETIRED — the idle reader keeps a real, designed column', () => {
  /*
   * V3 (round 64.5, OVERHAUL-V3 R8) repealed "idle reader yields its
   * column": the 0-width column was baseline defect D1 (content painting
   * past a 0px box). The new contract pins the replacement instead:
   * the same two columns whether the reader is hidden or live, a third
   * column only while the rail is open AND has live sections, and the
   * column animation preserved.
   */
  assert.match(css, /#panes:has\(#reader\[hidden\]\) \{\n  grid-template-columns: minmax\(340px, 42%\) minmax\(0, 1fr\);/);
  // The collapse-to-zero column must never come back.
  assert.ok(!/#panes:has\(#reader\[hidden\]\)[^{]*\{[^}]*\b0\s*;/.test(css.replace(/minmax\(0, 1fr\)/g, '')),
    'the 0-width reader column is retired by name');
  assert.match(css, /#panes \{\n  transition: grid-template-columns var\(--dur-fast\)/);
  // The rail column exists only while the rail is actually live.
  assert.match(css, /body\.rail-open #panes:has\(#rail-scroll > :not\(\[hidden\]\)\) \{\n  grid-template-columns: minmax\(340px, 40%\) minmax\(0, 1fr\) var\(--rail-w\);/);
});

test('O3: the topbar yields, and the guards are the design', () => {
  assert.match(css, /body\.list-scrolled:not\(\.searching\):not\(\.selecting\) #topbar \{/);
  // wired: scroll direction, search focus, selection state
  assert.match(js, /document\.body\.classList\.toggle\('list-scrolled', on\)/);
  assert.match(js, /classList\.add\('searching'\)/);
  assert.match(js, /classList\.toggle\('selecting', n > 0\)/);
  // the collapse is a real height, tokenised, not a trick on `auto`
  assert.match(css, /--topbar-h: 61px;/);
});

test('O7: composing quiets sidebar and main with opacity alone', () => {
  const rule = css.slice(css.indexOf('body.composing #sidebar'));
  assert.match(rule, /opacity: 0\.5;/);
  // Quieting is opacity ALONE: no layout, no removal, no input blocking.
  assert.ok(!/height|width|transform|display|pointer-events/.test(rule.split('}')[0]),
    'quieting must not move, remove or lock anything');
  assert.match(js, /classList\.add\('composing'\)/);
  assert.match(js, /classList\.remove\('composing'\)/);
  // minimise restores the inbox: quieting follows the task. The minimise
  // handler recomputes from its own flag; the body class is the contract.
  assert.match(js, /classList\.toggle\('composing', !minimised\)/);
});

test('O16 behaviour: fold wraps only long blockquotes', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const dom = new JSDOM('');
  const { sanitizeHtml } = await import('../src/app/sanitize.js');
  const long = 'quoted reply '.repeat(80); // ~1000 chars
  const shortQ = 'see below';
  const html = `<p>new words</p><blockquote>${long}</blockquote><blockquote>${shortQ}</blockquote>`;
  const out = sanitizeHtml(html, dom.window.document);
  assert.match(out, /<details class="quote-fold"><summary>Show quoted text<\/summary><blockquote>/);
  // the short quote must NOT be folded
  const foldedCount = (out.match(/quote-fold/g) || []).length;
  assert.equal(foldedCount, 1, 'one fold for one long quote');
  assert.ok(out.includes(`<blockquote>${shortQ}</blockquote>`), 'short quote untouched');
  // opt-out exists
  const open = sanitizeHtml(html, dom.window.document, { foldQuotes: false });
  assert.ok(!open.includes('quote-fold'), 'foldQuotes:false must disable');
});

test('doctrine: the relaxation is scoped to the named system', () => {
  // The compression section must cite the audit and the measurements, or a
  // future reader cannot tell a priced decision from a lapse.
  const sec = css.slice(css.indexOf('SPATIAL COMPRESSION'));
  assert.match(sec, /audit 37/);
  assert.match(sec, /0\.2ms/);
  assert.match(sec, /1\.7-2\.2ms/);
  // reduced-motion still wins: AN override block must come AFTER the system.
  // indexOf with a start position: other features have since earned their own
  // reduced-motion blocks EARLIER in the file, so first-occurrence no longer
  // says anything about this system's override.
  const secAt = css.indexOf('SPATIAL COMPRESSION');
  assert.ok(css.indexOf('@media (prefers-reduced-motion: reduce)', secAt) > secAt);
});
