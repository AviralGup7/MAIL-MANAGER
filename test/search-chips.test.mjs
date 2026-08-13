/**
 * Search chips (round 65/e, docs/UX-AUDIT-V4 F6, brief §15).
 *
 * The strip turns the P-3 mode readout into an editor: the query shows as
 * one removable chip per token, plus Clear and Save-view. Behavioural pins
 * cover the chip model (lexical fidelity — chips EDIT a string, so they
 * must round-trip) and the render; source pins guard the one-path doctrine
 * (chips funnel into the typing path — never a second query application).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { readBundle } from './helpers/css.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const appjs = read('src/app/main.js');
const listjs = read('src/app/mail/list.js');
const css = readBundle();
const html = read('app.html');

// query.js is pure; search-chips touches document only inside render/wire.
const { tokenize } = await import('../src/app/search/query.js');
const { chipModel, queryWithout, renderSearchChips, wireSearchChips } =
  await import('../src/app/search/search-chips.js');

test('the splitter is the parser\'s own — one quote-aware lexer, one truth', () => {
  assert.equal(typeof tokenize, 'function',
    '65/e exported tokenize from query.js rather than growing a second lexer');
  assert.deepEqual(tokenize('from:a "b c" -is:read'), ['from:a', '"b c"', '-is:read']);
});

test('scoped tokens chip by kind; negation is stated as "not"', () => {
  const [f, n] = chipModel('from:augsd -is:read');
  assert.deepEqual({ key: f.key, value: f.value, negated: f.negated },
    { key: 'from', value: 'augsd', negated: false });
  assert.deepEqual({ key: n.key, value: n.value, negated: n.negated },
    { key: 'is', value: 'read', negated: true });
});

test('consecutive free text is ONE chip — merged, not five deletion tariffs', () => {
  const chips = chipModel('registration drive 2026');
  assert.equal(chips.length, 1);
  assert.equal(chips[0].raw, 'registration drive 2026');
  // An unknown operator is free text (the parser treats it likewise).
  const [a, b] = chipModel('from:x foo:bar tail');
  assert.equal(a.key, 'from');
  assert.equal(b.key, null);
  assert.equal(b.raw, 'foo:bar tail');
});

test('queryWithout is string surgery — exact, first-match, rejoined', () => {
  assert.equal(queryWithout('from:a is:unread registration', 'is:unread'),
    'from:a registration');
  assert.equal(queryWithout('"b c" fee', '"b c"'), 'fee',
    'quoted phrases keep their marks until their own chip removes them');
  assert.equal(queryWithout('a a', 'a'), 'a', 'one chip per click');
});

test('the strip renders chips, Save and Clear — all named, none tabbable', () => {
  const dom = new JSDOM('<span id="listquery"></span>');
  const realDoc = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const c = dom.window.document.getElementById('listquery');
    renderSearchChips(c, 'from:augsd is:unread registration drive');
    assert.match(c.textContent, /^Searching/, 'the P-3 readout word leads the strip');
    const chips = c.querySelectorAll('.q-chip');
    assert.equal(chips.length, 3, 'from:augsd, is:unread, and the merged free text');
    assert.match(chips[0].textContent, /from:.*augsd/);
    for (const b of c.querySelectorAll('button')) {
      assert.equal(b.tabIndex, -1,
        'pointer affordance mirroring the keyboard-owned input: never a second tab stop');
    }
    const x = chips[1].querySelector('.q-x');
    assert.equal(x.getAttribute('aria-label'), 'Remove filter: is:unread');
    assert.ok(c.querySelector('[data-chip-action="save"]'), 'save is offered for an unsaved query');
    assert.ok(c.querySelector('[data-chip-action="clear"]'), 'one-click clear always present');
    // The integration pin reads textContent for the query — chips keep it.
    assert.match(c.textContent, /augsd/);
    assert.match(c.textContent, /is:unread/);
  } finally {
    globalThis.document = realDoc;
  }
});

test('clicks reach the shell through the wired callbacks, with focus restored', () => {
  const dom = new JSDOM(
    '<div id="listhead"><span id="listquery"></span></div><input id="search">'
  );
  const realDoc = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const doc = dom.window.document;
    const applied = [];
    let cleared = 0;
    let saved = 0;
    const c = doc.getElementById('listquery');
    wireSearchChips({
      head: doc.getElementById('listhead'),
      search: doc.getElementById('search'),
      applyQuery: (q) => applied.push(q),
      clearQuery: () => cleared++,
      save: () => saved++,
    });
    // The window into the query is the INPUT's string (as in the app).
    doc.getElementById('search').value = 'from:augsd registration';
    renderSearchChips(c, 'from:augsd registration');
    c.querySelector('.q-chip .q-x').click();
    assert.deepEqual(applied, ['registration'], 'removing the scope leaves the thought');
    assert.equal(doc.activeElement.id, 'search', 'focus returns to the field that owns the string');
    c.querySelector('[data-chip-action="clear"]').click();
    assert.equal(cleared, 1);
    c.querySelector('[data-chip-action="save"]').click();
    assert.equal(saved, 1);
  } finally {
    globalThis.document = realDoc;
  }
});

test('the shell keeps ONE query-application path for typing and chips alike', () => {
  // Exactly one search-input listener — the coalescer — and both callers
  // (typing, chip gestures) converge on the extracted frame body.
  assert.equal(appjs.match(/el\.search\.addEventListener\('input'/g).length, 1);
  assert.match(appjs, /function applySearchTyping\(\)/);
  assert.match(appjs, /applyQuery: \(q\) => \{ el\.search\.value = q; applySearchTyping\(\); \}/);
  assert.match(appjs, /clearQuery: \(\) => \{ el\.search\.value = ''; applySearchTyping\(\); \}/);
  // Save delegates to the toolbar button — the dialog exists exactly once.
  assert.match(appjs, /save: \(\) => \$\('btn-save-view'\)\.click\(\)/);
  assert.match(listjs, /renderSearchChips\(el\.listQuery, state\.query\)/,
    'the strip renders from the same updateCounts that owned the readout');
});

test('the strip fits the audit-33 fixed slot: sideways clip, never push', () => {
  assert.match(css, /#listquery \{[\s\S]*?overflow-x: auto;/, 'overflow is horizontal');
  assert.match(css, /#listquery\[hidden\] \{ display: none; \}/,
    'hidden must beat display:inline-flex — the UA rule loses that fight');
  assert.match(html, /id="listquery" role="group" aria-label="Active search filters"/,
    'a group of controls says so to a screen reader');
  // No animation on the strip: it appears with the bar, motion-free.
  const block = css.match(/\.q-chip \{([\s\S]*?)\n\}/)[1];
  assert.ok(!/transition|animation/.test(block));
});
