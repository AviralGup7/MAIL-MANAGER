/**
 * Live-region & landmark semantics (accessibility audit A-A4 + A-A7).
 *
 * WHY THESE PINS EXIST
 * --------------------
 * The AX census measured a sidebar landmark with no name at all, a bulk
 * strip announced as six loose buttons with no grouping, and a toast whose
 * role hot-swap could be read as a text diff. The fixes are attributes and
 * one deliberate NEGATIVE (no live region on the reader's deadline strip),
 * so the pins keep each decision from quietly drifting:
 *
 *   - named landmarks stay named, named toolbars stay toolbars — a renamed
 *     or dropped attribute fails here, not in a screen-reader session;
 *   - the toast's single-node status/alert policy is behavioural (errors
 *     interrupt, everything else is polite, and a re-fire after an error
 *     must land back on status — urgency must never get STUCK on);
 *   - #r-due stays announcement-free with its reasoning attached, so a
 *     well-meaning "make it accessible" pass cannot add an aria-live that
 *     stacks on the reader-open transition. Silence here is the decision.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'app.html'), 'utf8');
const toastSrc = readFileSync(join(ROOT, 'src/app/overlays/toast.js'), 'utf8');

test('A-A4: the sidebar landmark says WHICH complementary it is', () => {
  const aside = html.match(/<aside id="sidebar"[^>]*>/);
  assert.ok(aside, '#sidebar exists');
  assert.match(aside[0], /aria-label="Mailboxes and compose"/,
    'the right rail announces "For you", the nav "Categories" — this one may not stay anonymous');
});

test('A-A7a: the bulk strip is a named toolbar, not an anonymous div', () => {
  const bar = html.match(/<div id="bulkbar"[^>]*>/);
  assert.ok(bar, '#bulkbar exists');
  assert.match(bar[0], /role="toolbar"/);
  assert.match(bar[0], /aria-label="Bulk actions"/, 'the label names the shared object');
  assert.match(bar[0], /aria-orientation="horizontal"/,
    'default is horizontal; saying it anyway keeps reader hints stable across refactors');
});

test('A-A7b: the toast markup is one atomic whole', () => {
  const node = html.match(/<div id="toast"[^>]*>/);
  assert.ok(node, '#toast exists');
  assert.match(node[0], /role="status"/, 'polite status is the default posture');
  assert.match(node[0], /aria-live="polite"/);
  assert.match(node[0], /aria-atomic="true"/,
    'a re-fire must read whole, never as the changed slice of the previous toast');
});

test('A-A7b: the role swap is behaviour — error interrupts, the next toast lands back on polite', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const dom = new JSDOM(`<div id="toast" role="status" aria-atomic="true" hidden>
    <span id="toast-icon" hidden></span><span id="toast-text"></span>
    <kbd id="toast-kbd" hidden>Ctrl+Z</kbd>
    <button id="toast-action" type="button" aria-label="Undo" hidden></button>
    <span id="toast-drain"></span></div>`);
  const prev = {};
  for (const k of ['window', 'document', 'HTMLElement', 'Node']) prev[k] = globalThis[k];
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  const q = (id) => dom.window.document.getElementById(id);
  try {
    const { initToast, toast } = await import('../src/app/overlays/toast.js?t=' + Math.random());
    initToast({
      toast: q('toast'), toastIcon: q('toast-icon'), toastText: q('toast-text'),
      toastKbd: q('toast-kbd'), toastAction: q('toast-action'), toastDrain: q('toast-drain'),
    });
    toast('Sync failed', { kind: 'error' });
    assert.equal(q('toast').getAttribute('role'), 'alert', 'errors assert');
    toast('Archived', {});
    assert.equal(q('toast').getAttribute('role'), 'status', 'urgency never gets stuck on');
  } finally {
    Object.assign(globalThis, prev);
    try { dom.window.close(); } catch { /* best effort */ }
  }
});

test('A-A7b: the single-node policy stays documented at the swap site', () => {
  assert.match(toastSrc, /kind === 'error' \? 'alert' : 'status'/,
    'the swap itself');
  assert.match(toastSrc, /A-A7/,
    'the comment must cite why one node is deliberate — or the next reader "simplifies" it away');
});

test('A-A7c: #r-due carries NO live region — the negative is the decision', () => {
  const strip = html.match(/<div id="r-due"[^>]*>/);
  assert.ok(strip, '#r-due exists');
  assert.doesNotMatch(strip[0], /role=|aria-live=/,
    'written synchronously with the reader reveal: browse order already meets it; an announcement would stack');
  assert.match(html, /NO LIVE REGION, deliberately \(accessibility audit A-A7\)/,
    'the reasoning must travel with the element');
});
