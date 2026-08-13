/**
 * Focus restoration through the layer/menu seam (accessibility audit A-A2).
 *
 * WHY THIS PIN EXISTS
 * -------------------
 * Measured in the live browser: Shift+F10 a row, Escape, and focus landed
 * on <body>. The menu's anchor is the ROW -- a deliberately non-focusable
 * div (the listbox owns one tab stop via aria-activedescendant, and five
 * stops per row would wreck tab order for exactly the users the roster
 * serves). layers.js's isConnected guard passed (the row exists), then
 * `.focus()` silently no-opped.
 *
 * Rescue rails already measured kept this MODERATE, not critical: the
 * document-level keymap never dies and activedescendant survives. The fix
 * completes the seam: a restore target that is missing OR cannot take
 * focus falls back to #list, the focusable owner of every row surface.
 *
 * These pins freeze three paths: the normal restore (never regressed), the
 * non-focusable-anchor fallback, and the detached-anchor fallback. The
 * fourth path (no #list in the document at all) stays a no-restore no-op,
 * as before.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

/** A page with the roster and one non-focusable row, built like list.js's. */
function setup() {
  const dom = new JSDOM(
    `<div id="list" role="listbox" tabindex="0" aria-label="Messages">
       <div class="row" role="option" id="bmm-row-m1">a row</div>
     </div>
     <button id="invoker">open</button>`);
  const prev = {};
  for (const k of ['window', 'document', 'HTMLElement', 'Node']) prev[k] = globalThis[k];
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  return {
    dom,
    doc: dom.window.document,
    restore() {
      Object.assign(globalThis, prev);
      try { dom.window.close(); } catch { /* best effort */ }
    },
  };
}

const load = async () => {
  const menu = await import('../src/app/menu.js?t=' + Math.random());
  return menu;
};

test('normal path unchanged: a FOCUSABLE anchor gets focus back on Escape', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { dom, doc, restore } = setup();
  try {
    const { openMenu } = await load();
    const invoker = doc.getElementById('invoker');
    invoker.focus();
    openMenu({ name: 't', label: 'Row menu', anchor: invoker,
               items: [{ text: 'Archive', run() {} }] });
    doc.querySelector('.snooze-menu').dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(doc.activeElement, invoker,
      'the guard must never reroute a target that can take focus');
  } finally {
    restore();
  }
});

test('A-A2: a row-anchored menu Escapes back to #list, never to <body>', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { dom, doc, restore } = setup();
  try {
    const { openMenu } = await load();
    const row = doc.getElementById('bmm-row-m1'); // non-focusable by doctrine
    openMenu({ name: 't', label: 'Row menu', anchor: row,
               items: [{ text: 'Archive', run() {} }] });
    // Focus is inside the menu now; Escape is the measured failure path.
    doc.querySelector('.snooze-menu').dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(doc.activeElement.id, 'list',
      'focus belongs to the roster that owns the row');
    assert.equal(doc.body.contains(doc.activeElement), true);
  } finally {
    restore();
  }
});

test('a detached invoker falls back to #list too (was: silent drop to <body>)', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { dom, doc, restore } = setup();
  try {
    const { openMenu } = await load();
    const invoker = doc.getElementById('invoker');
    invoker.focus();
    openMenu({ name: 't', label: 'Menu', anchor: invoker,
               items: [{ text: 'Go', run() {} }] });
    invoker.remove(); // the surface that summoned the menu is gone (re-render)
    doc.querySelector('.snooze-menu').dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(doc.activeElement.id, 'list');
  } finally {
    restore();
  }
});
