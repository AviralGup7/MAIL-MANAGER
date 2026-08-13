/**
 * Escape on the search field (accessibility audit A-A6).
 *
 * WHY THIS PIN EXISTS
 * -------------------
 * Measured live, then isolated on a PLAIN page with CDP key events and zero
 * app code: Blink natively CLEARS an <input type="search"> on Escape and
 * fires native `input` + `search` events. No app setter ran, no app dispatch
 * existed — the browser owned the whole effect. In the app that invisible
 * default chained into a full defect: one Escape closed the suggestion box
 * (suggest-ui), the native clear emptied the field, the shell's debounced
 * input listener re-rendered suggestions against the now-empty query, and the
 * box "reopened" inside 600 ms showing the history defaults — while the
 * ladder's blur rung went unreached and the typed query silently died.
 *
 * The fix is one line of ownership: the combobox's keydown listener
 * preventDefaults Escape ALWAYS, open or closed, so the keystroke means
 * "walk the layer stack" and never "browser, delete my query". stopPropagation
 * stays conditional (open box = consumed here; closed box = the document
 * ladder must still see the key and walk its rungs).
 *
 * These pins freeze: the open-box consume (preventDefault + hide + no climb),
 * the closed-box guard (preventDefault only, ladder still receives the key),
 * and a source tripwire so a cleanup cannot quietly hand the query back to
 * the browser's default.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { JSDOM } = await import('jsdom');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'src/app/search/suggest-ui.js'), 'utf8');

function setup() {
  const dom = new JSDOM(
    `<input id="search" type="search" role="combobox" aria-expanded="false">
     <ul id="search-suggest" hidden></ul>`);
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

const load = () => import('../src/app/search/suggest-ui.js?t=' + Math.random());

/** jsdom KeyboardEvent with the browser's cancelable contract. */
const escapeKey = (win) => new win.KeyboardEvent('keydown', {
  key: 'Escape', cancelable: true, bubbles: true,
});

test('open suggestion box: one Escape consumes fully — box hidden, key cancelled, no climb', async () => {
  const { dom, doc, restore } = setup();
  try {
    const ui = await load();
    ui.wireSuggestUI({
      store: { idsFor: () => [], get: () => null },
      el: { search: doc.getElementById('search') },
      runQuery() {},
    });
    const search = doc.getElementById('search');
    const box = doc.getElementById('search-suggest');
    search.focus();
    ui.renderSuggestions(); // empty query → the operator defaults fill the box
    assert.equal(box.hidden, false, 'precondition: the box is open');
    assert.equal(search.getAttribute('aria-expanded'), 'true');

    let ladderSawIt = false;
    doc.addEventListener('keydown', () => { ladderSawIt = true; });
    const ev = escapeKey(dom.window);
    search.dispatchEvent(ev);

    assert.equal(box.hidden, true, 'the open box closes on the spot');
    assert.equal(ev.defaultPrevented, true,
      'cancelled: Blink never gets to run its native search-clear (A-A6)');
    assert.equal(ladderSawIt, false,
      'stopPropagation kept: the ladder must not also blur the field this keystroke');
    assert.equal(search.getAttribute('aria-expanded'), 'false',
      'combobox honesty: focus is still inside, so only the attribute can announce the close');
    assert.equal(search.getAttribute('aria-activedescendant'), null);
  } finally {
    restore();
  }
});

test('closed box: Escape is still cancelled (query kept) but the ladder receives it', async () => {
  const { dom, doc, restore } = setup();
  try {
    const ui = await load();
    ui.wireSuggestUI({
      store: { idsFor: () => [], get: () => null },
      el: { search: doc.getElementById('search') },
      runQuery() {},
    });
    const search = doc.getElementById('search');
    assert.equal(doc.getElementById('search-suggest').hidden, true,
      'precondition: box closed');

    let ladderSawIt = false;
    doc.addEventListener('keydown', () => { ladderSawIt = true; });
    const ev = escapeKey(dom.window);
    search.dispatchEvent(ev);

    assert.equal(ev.defaultPrevented, true,
      'guard holds without a box: a ladder-consumed Escape must not wipe the query as a side effect');
    assert.equal(ladderSawIt, true,
      'propagation kept: the layer stack still walks (blur rung, overlay rungs, …)');
    assert.equal(doc.getElementById('search-suggest').hidden, true,
      'nothing reopens — suggestions return only on genuine input/focus intent');
  } finally {
    restore();
  }
});

test('typed text survives the whole gesture (the defect that started A-A6)', async () => {
  const { dom, doc, restore } = setup();
  try {
    const ui = await load();
    ui.wireSuggestUI({
      store: { idsFor: () => [], get: () => null },
      el: { search: doc.getElementById('search') },
      runQuery() {},
    });
    const search = doc.getElementById('search');
    search.focus();
    // `is:u` rides the operator-completion path, so the box opens even with
    // an empty mailbox (a bare word like the probe's "plan" deliberately
    // yields ZERO suggestions: a no-result suggestion reads as broken search).
    search.value = 'is:u';
    ui.renderSuggestions();
    assert.equal(doc.getElementById('search-suggest').hidden, false);
    search.dispatchEvent(escapeKey(dom.window));
    assert.equal(search.value, 'is:u', 'the query is state — Escape never authors its deletion');
  } finally {
    restore();
  }
});

test('source tripwire: the Escape branch owns preventDefault, not just propagation', () => {
  const branch = src.match(/e\.key === 'Escape'([\s\S]*?)\n    \}/);
  assert.ok(branch, 'the Escape branch exists in the combobox wiring');
  assert.match(branch[1], /e\.preventDefault\(\);\s*\n\s*if \(open\)/,
    'preventDefault runs BEFORE the open check — closed-box Escapes are guarded too');
  assert.match(branch[1], /e\.stopPropagation\(\)/,
    'the open-box consume still stops the climb');
});
