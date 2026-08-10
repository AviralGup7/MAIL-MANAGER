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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const css = read('src/app/app.css');
const js = read('src/app/app.js') + read('src/app/compose.js');

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip below */ }

test('O1: the idle reader hands its column to the list, capped at 640', () => {
  assert.match(css, /#panes:has\(#reader\[hidden\]\) \{\n  grid-template-columns: minmax\(300px, 640px\) 0;/);
  assert.match(css, /#panes \{\n  transition: grid-template-columns var\(--dur-fast\)/);
  // 640, not 1fr: a full-bleed list is unscannable. The cap is the design.
  assert.ok(!/#panes:has\(#reader\[hidden\]\)[^{]*\{[^}]*1fr/.test(css));
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
  // minimise restores the inbox: quieting follows the task
  assert.match(js, /classList\.toggle\('composing', !panel\.classList\.contains\('minimised'\)\)/);
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
  // reduced-motion still wins: the override block must come AFTER the system
  assert.ok(css.indexOf('@media (prefers-reduced-motion: reduce)') > css.indexOf('SPATIAL COMPRESSION'));
});
