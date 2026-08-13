/**
 * Reader overflow menu + archive-label honesty (round 65/d, docs/UX-AUDIT-V4
 * F1/F8).
 *
 * Two pins:
 *
 *   1. F1 was a HALF-finding: selectNeighbourThen already advanced the
 *      selection after archive/trash, but the button said only "Archive".
 *      A control whose label understates its effect is a lie of omission —
 *      the pin fixes the label ("Archive & next") and the title that says
 *      what "next" means.
 *
 *   2. The reader had eight verbs for FILING and no way to take anything
 *      OUT of the pane. The kebab menu carries exactly three copy commands;
 *      the pins freeze the set, the order, the shared menu primitive, and
 *      the clipboard fallback (a copy that failed silently would announce
 *      success through the toast — the failure path shows the text instead).
 *
 * Behavioural where cheap (the button row parses), source-level where the
 * mechanics matter (menu items, fallback, no per-mailbox hiding).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const html = read('app.html');
const readerjs = read('src/app/mail/reader.js');
const iconsjs = read('src/app/core/icons.js');
const appjs = read('src/app/main.js');

test('the archive button admits it advances (F1)', () => {
  assert.match(html, /data-act="archive"[^>]*>\s*Archive &amp; next</,
    'the label says what the verb does: archive AND open the next message');
  const btn = html.match(/<button data-act="archive"[^>]*>/)[0];
  assert.match(btn, /title="Archive and open the next message \(e\)"/,
    'the title names the same behaviour the keyboard shortcut has');
});

test('the reader bar ends in a named, icon-only kebab', () => {
  const dom = new JSDOM(html);
  const bar = dom.window.document.getElementById('r-actions');
  assert.ok(bar, 'reader action bar exists');
  const more = bar.querySelector('button[data-act="more"]');
  assert.ok(more, 'the overflow button exists');
  assert.equal(more.id, 'r-more');
  assert.ok(more.classList.contains('icon'), 'icon-only styling, not another word in the bar');
  assert.ok(more.getAttribute('aria-label'), 'an icon alone must still be named');
  assert.equal(more.getAttribute('aria-haspopup'), 'menu', 'it opens a menu and says so');
  // It is the LAST control: destructive stays inside the bar, the kebab is
  // the terminal convention.
  assert.equal(bar.lastElementChild, more, 'kebab is the final control');
});

test('the menu is the shared primitive with exactly the three copies, in order', () => {
  assert.match(readerjs, /import \{ openMenu \} from '\.\.\/overlays\/menu\.js';/,
    'a fourth hand-rolled menu would be the drift menu.js was extracted to kill');
  assert.match(readerjs, /b\.dataset\.act === 'more'/);
  const items = [...readerjs.matchAll(/text: '(Copy [^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(items, ['Copy link', 'Copy subject', 'Copy sender address'],
    'link (paste into chat), subject (quote in reply), sender (rules/contacts) — nothing else belongs behind the kebab');
  assert.match(readerjs, /ctx\.gmailUrl\(m\.threadId, state\.mailbox\)/,
    'the link is the Gmail URL the Open-in-Gmail anchor already proves correct');
});

test('a failed copy can never toast success', () => {
  const fn = readerjs.match(/async function copyOrShow\(text, label\) \{([\s\S]*?)\n\}/)[1];
  assert.match(fn, /await navigator\.clipboard\.writeText\(text\)/);
  assert.match(fn, /catch \{[\s\S]*?toast\(text\)/,
    'clipboard-less contexts show the text itself instead of lying');
});

test('syncReaderActions never hides the kebab by mailbox', () => {
  // `more` is not an actionsFor verb; the sync leaves unknown acts visible.
  assert.match(readerjs, /btn\.hidden = act in allowed \? !allowed\[act\] : false/,
    'unknown acts default to visible — the kebab is mailbox-independent');
});

test('the kebab icon exists and is mounted at boot', () => {
  assert.match(iconsjs, /\n  more: '/, 'the filled-dot kebab is in the icon set');
  assert.match(appjs, /setIcon\(\$\('r-more'\), 'more', \{ size: 15 \}\)/,
    'static buttons get their icon at boot like the contextual cluster');
});
