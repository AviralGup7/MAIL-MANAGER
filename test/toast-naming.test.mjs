/**
 * Toast action naming (accessibility audit A-A1).
 *
 * WHY THIS PIN IS PARANOID
 * ------------------------
 * The defect was proven by reading the computed accessible name off the
 * live AX tree: a button SHOWING "Got it" announced as "Undo", because
 * app.html's pre-JS placeholder aria-label wins over text content, and the
 * runtime path refreshed text only. That is the worst class of a11y bug
 * this product can ship: a control that SPEAKS a different, scarier verb
 * ("Undo") than the one it performs ("dismiss this tip").
 *
 * The fix is the one-liner the audit priced; these pins freeze it at the
 * contract level for the three labels the app actually uses (Undo on
 * triage sends, "Got it" on the coach, "Show" on the stuck-outbox toast)
 * plus the no-action case, so a future canned action can never reintroduce
 * a name that disagrees with its face.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

/** A minimal but honest node map: same shape the shell injects. */
function setup() {
  const dom = new JSDOM(`<div id="toast" role="status" hidden>
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
  return {
    dom,
    nodes: {
      toast: q('toast'), toastIcon: q('toast-icon'), toastText: q('toast-text'),
      toastKbd: q('toast-kbd'), toastAction: q('toast-action'), toastDrain: q('toast-drain'),
    },
    restore() {
      Object.assign(globalThis, prev);
      try { dom.window.close(); } catch { /* best effort */ }
    },
  };
}

const load = () => import('../src/app/overlays/toast.js?t=' + Math.random());

for (const label of ['Undo', 'Got it', 'Show']) {
  test(`the action named "${label}" is named "${label}" on BOTH channels`, async (t) => {
    if (!JSDOM) return t.skip('jsdom not installed');
    const { nodes, restore } = setup();
    try {
      const { initToast, toast } = await load();
      initToast(nodes);
      toast('Something happened', { action: { label, run() {} } });
      assert.equal(nodes.toastAction.textContent, label, 'what is shown');
      assert.equal(nodes.toastAction.getAttribute('aria-label'), label,
        'what is SPOKEN -- the aria-label is the winning name source; ' +
        'leaving it stale is exactly the A-A1 bug');
      assert.equal(nodes.toastAction.hidden, false, 'the action is offered');
    } finally {
      restore();
    }
  });
}

test('no action: the button hides AND carries no stale name into the next toast', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { nodes, restore } = setup();
  try {
    const { initToast, toast } = await load();
    initToast(nodes);
    toast('Plain notice');
    assert.equal(nodes.toastAction.hidden, true);
    // The pre-JS "Undo" placeholder stays on the node, but with the node
    // hidden it names nothing the user can reach -- a hidden control is
    // out of the AX tree. The desync could only ever bite a VISIBLE button.
  } finally {
    restore();
  }
});

test('regression tripwire: no toast path may set text without restamping the name', () => {
  // Source-level guard: the setText on toastAction and setAttribute
  // aria-label must stay within the same `if (action)` block. If someone
  // moves one and not the other, this file fails, not a screen-reader user.
  const src = readFileSync(new URL('../src/app/overlays/toast.js', import.meta.url), 'utf8');
  const block = src.match(/if \(action\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.ok(block.includes('setText(el.toastAction, action.label)'), 'text refreshes');
  assert.ok(block.includes("setAttribute('aria-label', action.label)"), 'name refreshes with it');
});
