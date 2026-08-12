/**
 * Row quick actions + row context menu (round 65/b, docs/UX-AUDIT-V4 F3/F12).
 *
 * The pins are behavioural where behaviour can be faked cheaply, and
 * source-level where the mechanics matter (delegation, not per-row
 * listeners;; the overlay-root menu primitive;; never opening the message).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const src = read('src/app/row-actions.js');
const css = read('src/app/app.css');
const appjs = read('src/app/app.js');
const listjs = read('src/app/list.js');

test('rows carry a hover-verb cluster with the four frequent verbs', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const mod = awaitImportHack(dom);
  // build from source against the harness DOM: the module is ESM; pull it in.
  return mod.then(async ({ buildRowActions }) => {
    const li = dom.window.document.createElement('div');
    li.appendChild(buildRowActions(li));
    const verbs = [...li.querySelectorAll('.r-act')].map((b) => b.dataset.verb);
    assert.deepEqual(verbs, ['archive', 'unread', 'snooze', 'trash'],
      'archive, read toggle, snooze, delete -- in that order, destructive last');
    for (const b of li.querySelectorAll('.r-act')) {
      assert.equal(b.tabIndex, -1, 'the keyboard path is e/u/z/#; these never enter tab order');
      assert.ok(b.getAttribute('aria-label'), 'each is named');
      assert.ok(b.querySelector('svg'), 'each is an icon, not a glyph');
    }
  });
});

// Dynamic import against a foreign DOM needs a shimmed document lookup; run
// the module in the harness realm instead.
async function awaitImportHack(dom) {
  const { buildRowActions } = await import('../src/app/row-actions.js');
  // buildRowActions touches only its argument + document.createElement --
  // rebind its document by running under the JSDOM window globally is not
  // needed: it uses `document.createElement`. Provide that.
  const realDoc = globalThis.document;
  globalThis.document = dom.window.document;
  const wrapped = {
    buildRowActions: (li) => {
      globalThis.document = dom.window.document;
      try { return buildRowActions(li); } finally { globalThis.document = realDoc; }
    },
  };
  globalThis.document = realDoc;
  return wrapped;
}

test('hover verbs are delegated, contextual, and never open the message', () => {
  assert.match(src, /list\.addEventListener\('contextmenu'/);
  assert.match(src, /e\.stopPropagation\(\)/, 'a verb click must not bubble to the row open handler');
  assert.match(src, /e\.preventDefault\(\)/);
  // One delegated click listener per list -- not one per row.
  const clickListeners = src.match(/list\.addEventListener\('click'/g) || [];
  assert.equal(clickListeners.length, 1, 'click handling is delegated once');
});

test('the reveal is hover/focus/selected-gated, touch-safe, and finite-motion', () => {
  assert.match(css, /@media \(hover: hover\) \{[\s\S]*\.row:hover \.r-actions/);
  assert.match(css, /\.row\[aria-selected='true'\] \.r-actions/, 'keyboard selection reveals too');
  assert.match(css, /\.row:hover \.r-date/, 'the date yields its slot to the verbs');
  // No infinite motion, no layout-shifting properties on the cluster.
  const block = css.match(/\.r-actions \{([\s\S]*?)\n\}/)[1];
  assert.ok(!/animation/.test(block), 'the cluster fades; it does not loop');
  assert.ok(!/left:|width:/.test(block.replace(/right: var\(--s-2\)/, '')),
    'positioned by tokens, never by layout-affecting guesses');
});

test('the menu uses the shared primitive and the existing verb layer', () => {
  assert.match(src, /openMenu\(\{/);
  assert.match(src, /name: 'row-menu'/);
  assert.match(src, /ctx\.act\(verb, m\.id\)/, 'quick verbs route through act()');
  assert.match(src, /openSnoozeMenu\(m\.id/, 'snooze stays the shared menu codepath');
  assert.match(appjs, /wireRowActions\(ctx\)/, 'wired from the shell');
  assert.match(listjs, /buildRowActions\(li\)/, 'built per row');
  assert.match(listjs, /syncRowActions\(li, m\)/, 'kept honest per fill');
});

test('the context menu is mailbox-aware', () => {
  assert.match(src, /state\.mailbox === 'trash'/, 'trash offers restore, not delete');
  assert.match(src, /state\.mailbox === 'spam'/, 'spam rescues instead of reporting');
  assert.match(src, /Report spam/, 'and reporting exists where it means something');
});

test('selection v2 is wired: range, additive, and taught on the help sheet', () => {
  // The model (selection.js) has anchor + pre-range snapshot semantics; the
  // list handler is where the pointer meets it. Pin the wiring so neither
  // side can silently regress to "checkbox only".
  assert.match(listjs, /if \(e\.shiftKey && ctx\.selection\.anchor\)/, 'shift-click extends a range');
  assert.match(listjs, /ctx\.selection\.range\(id, renderedIds\)/, 'ranges track the RENDERED order');
  assert.match(listjs, /if \(e\.ctrlKey \|\| e\.metaKey\)/, 'ctrl/cmd toggles additively');
  const shortcuts = read('src/app/shortcuts.js');
  assert.match(shortcuts, /title: 'Pointer'/, 'the pointer half is documented');
  assert.match(shortcuts, /Shift', 'Click'/, 'range selection is taught');
  assert.match(shortcuts, /Ctrl', 'Click'/, 'additive selection is taught');
  assert.match(shortcuts, /Right-click.*row you aimed at/s, 'the row menu is taught');
});
