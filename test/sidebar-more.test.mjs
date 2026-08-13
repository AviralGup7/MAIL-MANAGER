/**
 * The icon-rail overflow menu (responsive-audit R-A5).
 *
 * WHY THESE PINS EXIST
 * --------------------
 * The <=860px step hides the sidebar's footer verbs. The probe (860px and
 * 480px, palette queried through the real Ctrl+K path, 2026-08-13) measured
 * exactly which actions still had a route:
 *
 *   Activity log    palette row       -> reachable
 *   Back to Gmail   palette + Esc     -> reachable
 *   Timetable       NO route at all   -> LOST
 *   Sign out        NO route at all   -> LOST
 *
 * The fix is deliberately narrow (the roadmap: fix only what truly
 * disappears): one kebab in the footer, visible only inside the icon-rail
 * media step, opening the shared menu primitive with the hidden verbs,
 * each item re-firing the REAL button so there is never a second
 * implementation of sign-out's cache/save/poll teardown to drift.
 *
 * The pins freeze: the button's chrome contract (named, icon-only,
 * menu-announcing), the visibility ladder (hidden globally, revealed by
 * exactly the 860px block), the menu's item set and DOM order, the
 * delegation itself, and the badge mirror. They exist because the audit's
 * table overstated the loss ("Gmail/sign-out: none") where the probe found
 * nuance -- frozen nuance cannot quietly drift back into a gap.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundle } from './helpers/css.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const html = read('app.html');
const css = readBundle();

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

/** Real markup, real module, spied target buttons. */
function setup() {
  const dom = new JSDOM(html);
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

const load = () => import('../src/app/workspace/sidebar-more.js?t=' + Math.random());

test('the kebab is a named, menu-announcing icon in the footer, LAST', () => {
  const dom = new JSDOM(html);
  const foot = dom.window.document.getElementById('side-foot');
  const btn = foot.querySelector('#btn-side-more');
  assert.ok(btn, 'the overflow button exists in the sidebar footer');
  assert.ok(btn.classList.contains('icon'), 'icon-only: the rail has no room for words');
  assert.ok(btn.getAttribute('aria-label'), 'an icon alone must still be named');
  assert.equal(btn.getAttribute('aria-haspopup'), 'menu', 'it opens a menu and says so');
  assert.equal(foot.lastElementChild, btn, 'kebab is the footers terminal convention');
});

test('visibility: hidden in the stylesheet, revealed ONLY by the 860px step', () => {
  // The base rule must sit OUTSIDE any media block: at wider widths the
  // labelled footer is already there, and two routes to one verb is clutter.
  const base = css.match(/^#btn-side-more \{ display: none; \}$/m);
  assert.ok(base, 'hidden by default, outside every media query');
  // The reveal must live in the LADDER's 860px block -- the same block that
  // hides the verbs, so the two halves of the trade cannot separate.
  const ladderAt = css.lastIndexOf('@media (max-width: 860px)');
  assert.ok(ladderAt > 0, 'the ladder 860px block exists');
  const block = css.slice(ladderAt, css.indexOf('\n}', ladderAt));
  assert.match(block, /#btn-side-more \{ display: flex/, 'the icon-rail step reveals the kebab');
  assert.match(block, /#side-foot \{ align-items: center/, 'and centres it in the 64px column');
  // No OTHER breakpoint may reveal it: a mid-width kebab would duplicate
  // the visible footer it summarises.
  for (const w of [1240, 1080, 720, 600]) {
    const at = css.lastIndexOf(`@media (max-width: ${w}px)`);
    if (at < 0) continue;
    const b = css.slice(at, css.indexOf('\n}', at));
    assert.ok(!b.includes('#btn-side-more'), `the ${w}px step must not touch the kebab`);
  }
});

test('the menu restores exactly the hidden verbs, in rail DOM order', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, restore } = setup();
  try {
    const { wireSidebarMore } = await load();
    wireSidebarMore();
    doc.getElementById('btn-side-more').click();
    const items = [...doc.querySelectorAll('.snooze-menu [role="menuitem"]')];
    assert.deepEqual(
      items.map((b) => b.querySelector('.menu-name').textContent),
      ['Activity log', 'Timetable', 'Back to Gmail', 'Sign out'],
      'the whole set the rail hides: brand-row clock, then the footer verbs');
  } finally {
    restore();
  }
});

test('items DELEGATE to the real buttons -- one handler, never two', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, restore } = setup();
  try {
    const { wireSidebarMore } = await load();
    wireSidebarMore();
    const fired = [];
    for (const id of ['btn-activity', 'btn-timetable', 'btn-gmail', 'btn-signout'])
      doc.getElementById(id).addEventListener('click', () => fired.push(id));

    const choose = (name) => {
      doc.getElementById('btn-side-more').click();
      [...doc.querySelectorAll('.snooze-menu [role="menuitem"]')]
        .find((b) => b.querySelector('.menu-name').textContent === name)
        .click();
    };
    choose('Sign out');
    choose('Timetable');
    assert.deepEqual(fired, ['btn-signout', 'btn-timetable'],
      'choosing a row must click the hidden button, not run a copied action');
    // Sign-out's teardown (saver invalidation, cache clear, mailbox reset,
    // polling stop) lives on that one button; delegation is what keeps the
    // menu from ever running a stale duplicate of it.
  } finally {
    restore();
  }
});

test('the timetable badge count crosses into the menu as trailing text', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, restore } = setup();
  try {
    // The badge's home button is display:none at this width: the count the
    // user stops seeing is exactly the number the menu must carry.
    doc.querySelector('#btn-timetable .tt-badge').textContent = '3';
    const { wireSidebarMore } = await load();
    wireSidebarMore();
    doc.getElementById('btn-side-more').click();
    const row = [...doc.querySelectorAll('.snooze-menu [role="menuitem"]')]
      .find((b) => b.querySelector('.menu-name').textContent === 'Timetable');
    assert.equal(row.querySelector('.snooze-when').textContent, '3');
    // And the one hidden action with a keyboard route teaches it.
    const gmail = [...doc.querySelectorAll('.snooze-menu [role="menuitem"]')]
      .find((b) => b.querySelector('.menu-name').textContent === 'Back to Gmail');
    assert.equal(gmail.querySelector('.sc-when').textContent, 'Esc');
  } finally {
    restore();
  }
});

test('the fix stays a route: no sign-out shortcut or palette growth sneaks in here', () => {
  // R-A5's scope was the rail. A key chord for sign-out is a footgun; new
  // palette commands are a separate discoverability decision. These source
  // greps are the tripwire that keeps this small commit small.
  const mod = read('src/app/workspace/sidebar-more.js');
  assert.ok(!/addEventListener\('keydown'|keydown/.test(mod), 'no keyboard chord in the overflow module');
  assert.ok(!/from '\.\/palette\.js'|openPalette/.test(mod), 'the palette is not grown from this module');
});
