/**
 * End-to-end app tests in a real DOM — part 2 of 3: keyboard, selection, bulk actions and reader.
 *
 * WHY THIS IS THREE FILES AND NOT ONE (audit R3-01)
 * -------------------------------------------------
 * These suites boot the REAL app.html in jsdom with a stubbed `chrome.*` and
 * a fake service worker, then drive it the way a user would. That catches the
 * class of bug unit tests structurally cannot: wiring. It also costs a full
 * DOM, CSSOM, timer set and module graph per test.
 *
 * jsdom retains memory per document even after close() and an explicit gc()
 * — measured, not assumed. At 108 boots in one process the suite crossed the
 * V8 ceiling and aborted with SIGABRT ("Ineffective mark-compacts near heap
 * limit"), which reports as a test FAILURE with no assertion attached and
 * sends you hunting a logic bug that is not there. That made `npm test` red
 * on a clean clone, and it had already survived one round of being answered
 * by raising --max-old-space-size: the file simply grew past the new ceiling.
 *
 * So the bound is structural. `node --test` gives each FILE its own process,
 * and tools/ci-test.mjs deals files round-robin across shards, so splitting
 * caps peak heap per process by construction instead of by budget. Add tests
 * freely — but when a part approaches ~40 boots, split again rather than
 * raising a limit.
 *
 * The harness (boot/restore/DOM helpers) lives in test/helpers/app-harness.mjs
 * so the three parts cannot drift apart.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  JSDOM, ROOT,
  boot, bootSending, drainOutbox,
  MESSAGES,
  rows, rowText, settled, countParts,
  bulk, pick, press,
  NOON_TODAY, DUE_MESSAGES, cacheBlob, seedLabels, openPaletteWith, paletteLabels,
} from './helpers/app-harness.mjs';

test('CACHE: a corrupt cache falls back to a full sync, not a blank inbox', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, calls, restore } = await boot({
    messages: MESSAGES,
    storageSeed: { msgCache: { v: 99, m: 'garbage' } },
  });
  try {
    assert.equal(rows(doc).length, 3, 'must recover with a network sync');
    assert.ok(calls.some((c) => c.type === 'SYNC_PAGE'));
  } finally {
    restore();
  }
});

test('CACHE: the inbox is written to disk after a sync', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { win, storage, restore } = await boot({ messages: MESSAGES });
  try {
    // The saver defers to idle; give it room, then force the write the way
    // closing the takeover does.
    await new Promise((r) => win.setTimeout(r, 120));
    const blob = storage.msgCache;
    assert.ok(blob, 'a cache blob must exist after a sync');
    assert.equal(blob.v, 1);
    assert.equal(blob.m.length, 3);
    assert.equal(blob.m[0][0], 'm1', 'newest first');
  } finally {
    restore();
  }
});

test('CACHE: signing out erases the cached mailbox', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Otherwise the next person to open the extension sees the previous
  // account's inbox painted from cache before the gate appears.
  const { doc, win, storage, settle, restore } = await boot({
    messages: [],
    storageSeed: { msgCache: cacheBlob(bulk(10)) },
  });
  try {
    assert.equal(rows(doc).length, 10);
    doc.getElementById('btn-signout').click();
    await settle();
    await new Promise((r) => win.setTimeout(r, 50));

    assert.equal(storage.msgCache, undefined, 'cache must be gone');
    assert.equal(rows(doc).length, 0, 'and the list cleared');
    assert.equal(doc.getElementById('gate').hidden, false);
  } finally {
    restore();
  }
});

// ------------------------------------------------------------ a11y --------

test('A11Y: the listbox owns its options directly', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // This was `div role="listbox" > ul > li role="option"`. An intervening
  // `list` breaks ARIA ownership, so screen readers announced the message
  // list -- the central UI of the app -- as empty.
  const { doc, restore } = await boot();
  try {
    /*
     * Scoped to #list by id rather than taking the first [role="listbox"] in
     * the document.
     *
     * The search suggestion dropdown is also a listbox -- correctly, it is a
     * combobox popup -- and it appears EARLIER in the DOM, so the unscoped
     * query started matching it and this test failed on a change that was not
     * a regression. The property being protected is about the MESSAGE LIST's
     * ARIA ownership specifically.
     */
    const listbox = doc.getElementById('list');
    assert.ok(listbox, 'a listbox must exist');
    assert.equal(listbox.getAttribute('role'), 'listbox');

    const options = [...listbox.querySelectorAll('[role="option"]')];
    assert.equal(options.length, 3);
    for (const opt of options) {
      assert.equal(
        opt.parentElement,
        listbox,
        'every option must be a DIRECT child of the listbox'
      );
    }
    // Nothing may sit between them.
    assert.equal(doc.querySelector('#list ul'), null, 'no list wrapper');
    assert.equal(doc.querySelector('#list li'), null, 'no list items');
  } finally {
    restore();
  }
});

test('A11Y: the listbox is the tab stop and tracks the active option', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // aria-activedescendant is only meaningful on the focused element, so the
  // tab stop must be the listbox itself, not the scroll container.
  const { doc, settle, restore } = await boot();
  try {
    const listbox = doc.getElementById('list');
    assert.equal(listbox.getAttribute('tabindex'), '0');
    assert.equal(doc.getElementById('scroller').hasAttribute('tabindex'), false);
    assert.equal(listbox.hasAttribute('aria-activedescendant'), false, 'nothing selected yet');

    rows(doc)[1].click();
    await settle();

    const active = listbox.getAttribute('aria-activedescendant');
    assert.ok(active, 'must point at the open row');
    const target = doc.getElementById(active);
    assert.ok(target, `aria-activedescendant must reference a real element, got "${active}"`);
    assert.equal(target.getAttribute('aria-selected'), 'true');
    assert.equal(target.dataset.id, 'm2');
  } finally {
    restore();
  }
});

test('A11Y: activedescendant follows j/k and clears on close', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const listbox = doc.getElementById('list');
    const key = (k) => {
      doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }));
      return settle();
    };

    await key('j');
    assert.equal(doc.getElementById(listbox.getAttribute('aria-activedescendant')).dataset.id, 'm1');
    await key('j');
    assert.equal(doc.getElementById(listbox.getAttribute('aria-activedescendant')).dataset.id, 'm2');

    await key('Escape');
    assert.equal(
      listbox.hasAttribute('aria-activedescendant'),
      false,
      'closing the reader must clear the active option'
    );
  } finally {
    restore();
  }
});

test('A11Y: the gate moves focus in and hands it back on hide', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Modal dialog lifecycle (P2-01): focus enters the only action when the
  // gate shows, and returns to where it was when the gate hides.
  const { doc, win, settle, restore } = await boot({ signedIn: false });
  try {
    await settle(4);
    assert.equal(doc.activeElement, doc.getElementById('btn-signin'), 'focus lands on Sign in');
    // Simulate session expiry while the user is in search, then recovery.
    const search = doc.getElementById('search');
    search.focus();
    win.__bmmShowGate?.('Session expired. Sign in again.');
    await settle(2);
    assert.equal(doc.activeElement, doc.getElementById('btn-signin'), 'gate reclaims focus');
    win.__bmmHideGate?.();
    await settle(2);
    assert.equal(doc.activeElement, search, 'focus returns to search after hide');
  } finally {
    restore();
  }
});

test('A11Y: the search field is a combobox owning the suggestion list', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The full combobox contract (40-ENG section 8): the input must announce
  // the popup, name the list it controls, and move aria-activedescendant
  // through it — otherwise the suggestion list reads as an unowned orphan.
  const { doc, win, settle, restore } = await boot();
  try {
    const input = doc.getElementById('search');
    assert.equal(input.getAttribute('role'), 'combobox');
    assert.equal(input.getAttribute('aria-controls'), 'search-suggest');
    assert.equal(input.getAttribute('aria-expanded'), 'false', 'closed by default');

    input.focus();
    input.value = 'is:';
    input.dispatchEvent(new win.Event('input'));
    await settle(4);
    assert.equal(input.getAttribute('aria-expanded'), 'true', 'open once suggestions render');

    const box = doc.getElementById('search-suggest');
    assert.equal(box.hidden, false);
    assert.ok(box.children.length > 0, 'suggestions exist');
    assert.ok(box.children[0].id, 'each option carries an id for activedescendant');

    // Arrow down moves activedescendant to a real option.
    input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();
    const active = input.getAttribute('aria-activedescendant');
    assert.ok(active && doc.getElementById(active), 'activedescendant references a real option');

    // Closing (blur path) must drop the expanded state. The close is
    // deliberately delayed 120ms so a suggestion click can land; wait it out.
    input.blur();
    await new Promise((r) => win.setTimeout(r, 140));
    await settle(2);
    assert.equal(input.getAttribute('aria-expanded'), 'false', 'closed on blur');
  } finally {
    restore();
  }
});

test('A11Y: exactly one option is aria-selected at a time', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot();
  try {
    const selected = () => [...doc.querySelectorAll('[role="option"][aria-selected="true"]')];
    assert.equal(selected().length, 0);
    rows(doc)[0].click();
    await settle();
    assert.equal(selected().length, 1);
    rows(doc)[2].click();
    await settle();
    assert.equal(selected().length, 1, 'the previous row must be deselected');
    assert.equal(selected()[0].dataset.id, 'm3');
  } finally {
    restore();
  }
});

test('A11Y: the reading pane is not a live region', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // aria-live on the whole pane announced the subject, sender, date, every tag
  // chip and the action buttons on each open.
  const { doc, restore } = await boot();
  try {
    assert.equal(doc.getElementById('readpane').hasAttribute('aria-live'), false);
    const reader = doc.getElementById('reader');
    assert.equal(reader.getAttribute('role'), 'article');
    assert.equal(reader.getAttribute('aria-labelledby'), 'r-subject');
    // The toast IS a live region, and correctly scoped to transient text.
    assert.equal(doc.getElementById('toast').getAttribute('aria-live'), 'polite');
  } finally {
    restore();
  }
});

test('A11Y: every row id is unique and references resolve', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, restore } = await boot({ messages: bulk(50) });
  try {
    const ids = [...doc.querySelectorAll('[role="option"]')].map((n) => n.id);
    assert.equal(ids.length, 50);
    assert.equal(new Set(ids).size, 50, 'row DOM ids must be unique');
    assert.ok(ids.every((i) => i.startsWith('bmm-')), 'namespaced so Gmail ids cannot collide');
  } finally {
    restore();
  }
});

// ------------------------------------------------------------- themes -----

test('THEME: the picker lists every theme and marks the current one', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot();
  try {
    const { THEMES } = await import('../src/app/system/themes.js');
    doc.getElementById('btn-theme').click();
    await settle();

    const items = [...doc.querySelectorAll('.theme-item')];
    assert.equal(items.length, THEMES.length, 'every theme must be offered');
    assert.equal(
      items.filter((i) => i.getAttribute('aria-checked') === 'true').length,
      1,
      'exactly one theme is current'
    );
    assert.equal(doc.getElementById('btn-theme').getAttribute('aria-expanded'), 'true');
  } finally {
    restore();
  }
});

test('THEME: choosing one applies it and persists the choice', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, storage, settle, restore } = await boot();
  try {
    doc.getElementById('btn-theme').click();
    await settle();
    doc.querySelector('.theme-item[data-theme="pilani"]').click();
    await settle();

    const root = doc.documentElement;
    assert.equal(root.dataset.theme, 'pilani');
    assert.equal(root.dataset.scheme, 'dark', 'scheme drives native controls');
    assert.equal(storage.theme, 'pilani', 'the choice must survive a reload');
    assert.ok(root.style.getPropertyValue('--bg'), 'custom properties are written');
    /*
     * The menu is built on open and REMOVED on close, so "closed" is now the
     * absence of the node rather than a hidden shell. Asserting on the node
     * is what catches a menu left attached after the choice was made.
     */
    assert.equal(doc.querySelector('.theme-menu'), null, 'menu closes after choosing');
  } finally {
    restore();
  }
});

test('THEME: a saved theme is applied at boot', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot({ storageSeed: { theme: 'nord' } });
  try {
    assert.equal(doc.documentElement.dataset.theme, 'nord');
    assert.equal(doc.documentElement.dataset.scheme, 'dark');
    await settle(12);
  } finally {
    restore();
  }
});

test('THEME: a stored value from the old binary toggle falls back cleanly', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Before the picker existed, this key held 'light' or 'dark'. Those are not
  // theme ids, and an unknown id must not leave the app unstyled.
  const { doc, settle, restore } = await boot({ storageSeed: { theme: 'dark' } });
  try {
    assert.equal(doc.documentElement.dataset.theme, 'daylight');
    assert.ok(doc.documentElement.style.getPropertyValue('--bg'));
    await settle(12);
  } finally {
    restore();
  }
});

test('THEME: the menu is keyboard operable and Escape closes it', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const btn = doc.getElementById('btn-theme');
    btn.click();
    await settle();
    const menu = doc.querySelector('.theme-menu');
    assert.ok(menu, 'the menu is built on open');

    // Focus lands on the current theme, not the top of the list.
    assert.equal(doc.activeElement.getAttribute('aria-checked'), 'true');

    menu.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();
    assert.ok(doc.activeElement.classList.contains('theme-item'));

    // Home and End came from this menu's own hand-rolled handler. Absorbing
    // it into the primitive must not have cost the user two working keys.
    menu.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await settle();
    const items = [...doc.querySelectorAll('.theme-item')];
    /*
     * Round 58: the menu is Appearance now — End reaches the menu's last
     * item, which is a density option; the themes are still one Home away.
     */
    const all = [...menu.querySelectorAll('.snooze-opt')];
    assert.equal(doc.activeElement, all[all.length - 1],
      'End reaches the last appearance option');
    assert.ok(doc.activeElement.classList.contains('density-item'));
    menu.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await settle();
    assert.equal(doc.activeElement, items[0], 'Home reaches the first');

    menu.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    assert.equal(doc.querySelector('.theme-menu'), null);
    assert.equal(btn.getAttribute('aria-expanded'), 'false', 'the trigger is un-expanded');
    assert.equal(doc.activeElement.id, 'btn-theme', 'focus returns to the trigger');
  } finally {
    restore();
  }
});

test('THEME: switching theme re-renders the open message body', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The body iframe is a separate document with its colours baked into
  // srcdoc, so it cannot follow a custom-property change.
  const { doc, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    const before = doc.getElementById('r-body').getAttribute('srcdoc');
    assert.ok(before, 'a body must be rendered');

    doc.getElementById('btn-theme').click();
    await settle();
    doc.querySelector('.theme-item[data-theme="midnight"]').click();
    await settle();

    const after = doc.getElementById('r-body').getAttribute('srcdoc');
    assert.notEqual(after, before, 'the body must be re-rendered for the new palette');
    assert.ok(after.includes('color-scheme:dark'), 'and pick up the dark scheme');
  } finally {
    restore();
  }
});

// ------------------------------------------------ contextual toolbar ------

test('CTX: message actions appear only when a message is open', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Archive/star/delete belong to a MESSAGE. A permanently visible row of
  // disabled buttons teaches nothing and occupies the most valuable strip of
  // the window; actions that arrive with their subject teach themselves.
  const { doc, settle, restore } = await boot();
  try {
    assert.equal(doc.getElementById('ctx-actions').hidden, true, 'hidden with nothing open');

    rows(doc)[0].click();
    await settle();
    assert.equal(doc.getElementById('ctx-actions').hidden, false, 'shown when a message opens');
    assert.equal(
      doc.querySelectorAll('#ctx-actions button svg').length,
      3,
      'archive, star and delete, each a real icon'
    );

    doc.dispatchEvent(new (doc.defaultView.KeyboardEvent)('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    assert.equal(doc.getElementById('ctx-actions').hidden, true, 'hidden again on close');
  } finally {
    restore();
  }
});

test('CTX: the star reflects reality on BOTH surfaces', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The same message is starrable from the row and from the toolbar. If the
  // two disagree the user cannot tell whether pressing will star or unstar.
  const { doc, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();

    doc.getElementById('ctx-star').click();
    await settle();

    const ctxStar = doc.getElementById('ctx-star');
    const rowStar = doc.querySelector('.row[aria-selected="true"] .r-star');
    assert.equal(ctxStar.getAttribute('aria-pressed'), 'true');
    assert.equal(rowStar.getAttribute('aria-pressed'), 'true', 'the row must agree');
    assert.equal(ctxStar.getAttribute('aria-label'), 'Unstar', 'the label must say what it will do');
  } finally {
    restore();
  }
});

test('CTX: archive from the toolbar removes the row', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    const before = rows(doc).length;

    doc.getElementById('ctx-archive').click();
    await settle();

    assert.equal((await settled(doc, settle)).length, before - 1);
  } finally {
    restore();
  }
});

// -------------------------------------------------- keyboard traversal ----

test('A11Y: the tab order is constant, not proportional to message count', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // MEASURED KEYBOARD TRAP: every row's star was a tab stop. With 20 messages
  // that is 44 stops; at the 2000-message cap it is ~2024, so a keyboard user
  // pressing Tab from the sidebar to the reader would press it two thousand
  // times.
  //
  // ARIA authoring practice: a listbox is ONE stop, and movement inside is by
  // arrow keys — which this app already had via j/k and aria-activedescendant.
  const visible = (el, doc) => {
    for (let n = el; n && n !== doc.body; n = n.parentElement) if (n.hidden) return false;
    return true;
  };
  const stops = (doc) =>
    [...doc.querySelectorAll('a[href],button,input,textarea,select,[tabindex]')]
      // Transient chrome (toasts) is not part of the persistent tab order —
      // the coach toast's action button lives for 7s then leaves the DOM.
      .filter((e) => visible(e, doc) && e.tabIndex >= 0 && !e.closest('.toast, #toast'));

  const small = await boot({ messages: MESSAGES });
  const nSmall = stops(small.doc).length;
  small.restore();

  const large = await boot({ messages: bulk(200) });
  const nLarge = stops(large.doc).length;
  try {
    assert.equal(
      stops(large.doc).filter((e) => e.classList.contains('r-star')).length,
      0,
      'row stars must not be tab stops'
    );
    assert.ok(
      Math.abs(nLarge - nSmall) <= 1,
      `tab stops scale with message count: ${nSmall} for 3 vs ${nLarge} for 200`
    );
    // Budget raised 20 -> 22 in round 58: the IA audit added exactly two
    // persistent stops — the topbar Help button and the sidebar Activity
    // button, both previously keyboard-only/undiscoverable. Any further
    // increase must be accounted the same way.
    assert.ok(nLarge < 22, `expected a small constant number of stops, got ${nLarge}`);
  } finally {
    large.restore();
  }
});

test('A11Y: the sidebar is one tab stop with arrow-key movement', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Roving tabindex. Sixteen categories were sixteen stops; a nav list should
  // be one. The arrow handler is the other half of the pattern — without it
  // the non-current categories become unreachable by keyboard entirely, which
  // is a worse bug than the stops it replaced.
  const { doc, win, settle, restore } = await boot();
  try {
    // Query the buttons, not `children`. The rail is now grouped into system
    // mailboxes and BITS categories, so the buttons are grandchildren; reading
    // `children` here returned the two wrapper divs and asserted nothing.
    const cats = [...doc.getElementById('cats').querySelectorAll('.cat')];
    assert.ok(cats.length > 8, 'both mailboxes and categories should be present');
    // ONE stop for the whole rail, across both groups. Two groups must not
    // mean two tab stops.
    assert.equal(cats.filter((c) => c.tabIndex === 0).length, 1, 'exactly one tabbable category');

    cats[0].focus();
    const fire = (key) =>
      doc.getElementById('cats').dispatchEvent(
        new win.KeyboardEvent('keydown', { key, bubbles: true })
      );

    fire('ArrowDown');
    await settle();
    assert.equal(doc.activeElement, cats[1], 'ArrowDown moves focus');

    fire('End');
    await settle();
    assert.equal(doc.activeElement, cats[cats.length - 1], 'End jumps to the last');

    fire('Home');
    await settle();
    assert.equal(doc.activeElement, cats[0], 'Home jumps to the first');

    // Focus movement must NOT select — that would render on every keypress and
    // fight the user as they scan.
    assert.equal(cats[0].getAttribute('aria-current'), 'true', 'arrows move focus, not selection');
  } finally {
    restore();
  }
});

test('A11Y: the star is still operable by keyboard after leaving the tab order', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Removing a tab stop is only correct if the action survives another way.
  const { doc, win, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 's', bubbles: true }));
    await settle();
    assert.equal(
      doc.querySelector('.row[aria-selected="true"] .r-star').getAttribute('aria-pressed'),
      'true'
    );
  } finally {
    restore();
  }
});

test('A11Y: truncated row text carries the full value in a title', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Institutional subjects are long and clip well before the useful part.
  // Without a title a clipped subject is simply unreadable, and the row shows
  // only a display name when the address is often what the user is checking.
  const { doc, restore } = await boot();
  try {
    for (const row of rows(doc)) {
      const subj = row.querySelector('.r-subj');
      const from = row.querySelector('.r-from');
      assert.equal(subj.getAttribute('title'), subj.textContent, 'subject title must be the full text');
      assert.ok(from.getAttribute('title')?.includes('@'), 'sender title must carry the address');
    }
  } finally {
    restore();
  }
});

// ------------------------------------------------------- multi-select ----


test('BULK: ticking a row selects without opening it', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Conflating selection with the open message means ticking twelve boxes
  // marks twelve messages read — the opposite of what a triage pass wants.
  const { doc, win, settle, restore } = await boot();
  try {
    assert.equal(doc.getElementById('bulkbar').hidden, true, 'no bar at rest');

    pick(rows(doc)[0], win);
    await settle();

    assert.equal(doc.getElementById('bulkbar').hidden, false);
    assert.equal(doc.getElementById('listhead').hidden, true, 'the bar REPLACES the header');
    assert.equal(doc.getElementById('bulk-count').textContent, '1 selected');
    assert.equal(doc.getElementById('reader').hidden, true, 'must not open the message');
  } finally {
    restore();
  }
});

test('BULK: shift-click selects a contiguous range', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Selecting 30 consecutive promotions one click at a time is the exact
  // drudgery this feature exists to remove.
  const { doc, win, settle, restore } = await boot({ messages: bulk(10) });
  try {
    pick(rows(doc)[1], win);
    await settle();
    pick(rows(doc)[5], win, { shiftKey: true });
    await settle();

    assert.equal(doc.getElementById('bulk-count').textContent, '5 selected');
    assert.equal(doc.querySelectorAll('.row.picked').length, 5);
  } finally {
    restore();
  }
});

test('BULK: select-all is tri-state and honest', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // A checkbox reading "checked" while half the list is selected is a lie.
  const { doc, win, settle, restore } = await boot({ messages: bulk(6) });
  try {
    pick(rows(doc)[0], win);
    await settle();
    const all = doc.getElementById('bulk-all');
    assert.equal(all.indeterminate, true, 'partial selection must be indeterminate');
    assert.equal(all.checked, false);

    all.checked = true;
    all.dispatchEvent(new win.Event('change'));
    await settle();
    assert.equal(doc.getElementById('bulk-count').textContent, '6 selected');
    assert.equal(doc.getElementById('bulk-all').indeterminate, false);
  } finally {
    restore();
  }
});

test('BULK: archiving many undoes as ONE step', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Forty separate undos would be unusable. This is the whole reason
  // UndoStack stores a thunk rather than a diff.
  const { doc, win, settle, restore } = await boot({ messages: bulk(8) });
  try {
    for (const i of [0, 1, 2]) pick(rows(doc)[i], win);
    await settle();

    doc.getElementById('bulk-archive').click();
    await settle();
    assert.equal((await settled(doc, settle)).length, 5, 'three removed');
    assert.match(doc.getElementById('toast').textContent, /Archived 3 messages/);

    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await settle();
    await settle();
    assert.equal(rows(doc).length, 8, 'one undo restores all three');
  } finally {
    restore();
  }
});

test('AUTO-ARCHIVE: files new mail, says so, and undoes to the inbox', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THIS BEHAVIOUR HAD NO INTEGRATION COVERAGE AT ALL.
   *
   * `rules.js` is well tested -- toggling, persistence, the mute/auto-archive
   * contradiction. But `autoArchive()` in app.js, the function that actually
   * removes a user's mail from their inbox on arrival, was never exercised
   * end to end. The rule engine was proven; the thing acting on it was not.
   *
   * It is also the most destructive-adjacent thing the app does without being
   * asked, which is exactly why the product reports it and offers an undo
   * rather than acting silently: mail that vanishes with no announcement is
   * indistinguishable from mail going missing.
   */
  const { doc, win, calls, settle, restore } = await boot({
    messages: [],
    storageSeed: { categoryRules: { muted: [], autoArchive: ['augsd'], corrections: {} } },
  });
  try {
    calls.length = 0;
    // Arriving mail, unread, in the auto-archived category.
    win.__bmmIngest(bulk(3, { unread: true }));
    await settled(doc, settle);

    // It leaves the inbox locally...
    assert.equal(rows(doc).length, 0, 'auto-archived mail does not sit in the inbox');

    // ...and exactly one BULK call carries the archive delta.
    const forward = calls.filter((c) => c.type === 'BULK');
    assert.equal(forward.length, 1, 'one request for the batch, not three');
    assert.deepEqual([...(forward[0].remove || [])], ['INBOX'], 'archiving removes INBOX');
    assert.deepEqual([...(forward[0].add || [])], [], 'and adds nothing');

    // It ANNOUNCES itself. A silent rule is a bug report waiting to happen.
    const toastEl = doc.getElementById('toast');
    assert.equal(toastEl.hidden, false, 'the toast must actually be showing');
    assert.match(
      toastEl.textContent, /Auto-archived 3/,
      'the user must be told what the rule did'
    );
    assert.match(toastEl.textContent, /Undo/, 'and offered a way back');

    // And it is reversible, by the derived inverse.
    calls.length = 0;
    doc.dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })
    );
    await settle();
    await settle();

    const back = calls.filter((c) => c.type === 'BULK');
    assert.equal(back.length, 1, 'undo sends one BULK');
    assert.deepEqual([...(back[0].add || [])], ['INBOX'], 'undo puts INBOX back');
    assert.deepEqual([...(back[0].remove || [])], [], 'and removes nothing');
    assert.equal(rows(doc).length, 3, 'the mail returns to the list');
  } finally {
    restore();
  }
});

test('AUTO-ARCHIVE: leaves already-read mail alone', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The rule fires on ARRIVAL, so it must only touch unread mail. Re-archiving
   * something the user has already opened and chosen to keep in the inbox
   * would be the app fighting them -- and it would do so on every sync.
   */
  const { doc, win, calls, settle, restore } = await boot({
    messages: [],
    storageSeed: { categoryRules: { muted: [], autoArchive: ['augsd'], corrections: {} } },
  });
  try {
    calls.length = 0;
    win.__bmmIngest(bulk(3, { unread: false }));
    await settled(doc, settle);

    assert.equal(
      calls.filter((c) => c.type === 'BULK').length, 0,
      'read mail must not be auto-archived'
    );
    assert.equal(rows(doc).length, 3, 'and it stays in the list');
  } finally {
    restore();
  }
});

test('CONSISTENCY: a setting changed in Options reaches the running app', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * `settings.subscribe()` was exported, documented, and called by NOTHING.
   *
   * That is the same shape as the dead schema keys the suite already guards
   * against: an exported API is a promise that the thing works, and the next
   * reader believes it. Here the promise was doubly empty, because a subscriber
   * could not have helped even if someone had registered one -- the options
   * page is a SEPARATE EXTENSION PAGE with its own module instances, so an
   * in-process listener can never see its writes.
   *
   * The user-visible effect: `settings.get()` reads an in-memory cache filled
   * once at boot. Turn off "mark read on open" in Options, come back to the
   * still-open mail tab, and it keeps marking mail read -- silently, until the
   * tab is reloaded. Every other piece of cross-surface state in this product
   * updates live.
   *
   * `chrome.storage.onChanged` is the only channel that crosses pages, so that
   * is what the app must listen to.
   */
  const { win, changeSetting, restore } = await boot({
    storageSeed: { markReadOnOpen: true },
  });
  try {
    const settings = await import('../src/app/system/settings.js');
    assert.equal(settings.get('markReadOnOpen'), true, 'precondition: on at boot');

    // The options page writes it. Chrome broadcasts the change.
    await changeSetting('markReadOnOpen', false);

    assert.equal(
      settings.get('markReadOnOpen'), false,
      'the running app must see a setting changed in Options, without a reload'
    );

    // And an unrelated key must not be disturbed by the refresh.
    assert.equal(settings.get('threaded'), settings.get('threaded'));
    void win;
  } finally {
    restore();
  }
});

test('CONSISTENCY: turning off mark-read-on-open in Options takes effect immediately', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The behavioural half of the cross-page settings fix. Asserting the cache
   * updated proves the plumbing; this proves the PRODUCT changed, which is
   * what the user actually experiences.
   *
   * With mark-read-on-open enabled, opening an unread message marks it read.
   * Turn it off in Options and the very next message you open must stay
   * unread -- no reload.
   */
  const { doc, win, settle, changeSetting, restore } = await boot({
    storageSeed: { markReadOnOpen: true, markReadDelayMs: 0 },
  });
  try {
    // Baseline: the setting is honoured.
    assert.equal(win.__bmmStore.get('m1').unread, true, 'precondition: m1 unread');
    rows(doc).find((r) => r.dataset.id === 'm1').click();
    await settle(6);
    assert.equal(win.__bmmStore.get('m1').unread, false, 'opening marks it read');

    // The user turns it off in the options page.
    await changeSetting('markReadOnOpen', false);

    // The next unread message they open must stay unread.
    assert.equal(win.__bmmStore.get('m2').unread, true, 'precondition: m2 unread');
    rows(doc).find((r) => r.dataset.id === 'm2').click();
    await settle(6);
    assert.equal(
      win.__bmmStore.get('m2').unread, true,
      'the new setting must apply without reloading the tab'
    );
  } finally {
    restore();
  }
});

test('CONSISTENCY: toggling threading in Options redraws the list at once', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * `threaded` is read in six render paths, so unlike mark-read-on-open it is
   * not enough for the CACHE to be current -- the list on screen was drawn
   * from the old value and nothing asks it to redraw.
   *
   * Without a repaint the user turns conversation view on in Options, returns
   * to a list still showing every message separately, and reasonably concludes
   * the setting does nothing.
   */
  const conv = [
    { id: 'c1', threadId: 'T', from: 'A <a@x.com>', subject: 'Root',
      snippet: 'first', date: Date.now() - 3000, unread: false, starred: false, labels: ['INBOX'] },
    { id: 'c2', threadId: 'T', from: 'B <b@x.com>', subject: 'Re: Root',
      snippet: 'second', date: Date.now() - 2000, unread: false, starred: false, labels: ['INBOX'] },
    { id: 'c3', threadId: 'U', from: 'C <c@x.com>', subject: 'Other',
      snippet: 'alone', date: Date.now() - 1000, unread: false, starred: false, labels: ['INBOX'] },
  ];
  const { doc, settle, changeSetting, restore } = await boot({
    messages: conv, storageSeed: { threaded: false },
  });
  try {
    assert.equal(rows(doc).length, 3, 'unthreaded: every message is its own row');

    await changeSetting('threaded', true);
    await settle(4);

    assert.equal(
      rows(doc).length, 2,
      'the list must redraw as conversations without waiting for another event'
    );
  } finally {
    restore();
  }
});

test('FALLBACK: a dead service worker degrades instead of bricking the app', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THE REAL FAILURE THIS EXISTS FOR.
   *
   * Chrome has been refusing to register the worker with "Status code: 2",
   * and every static check passes, so the cause is still unknown. A mail
   * client that cannot start is worth nothing; one running with degraded
   * background features is worth almost everything.
   *
   * The mock reproduces Chrome's ACTUAL shape for an absent worker: the
   * callback fires with `undefined` and `lastError` is set. It does not
   * throw. A mock that threw would exercise a path the browser never takes,
   * and the fallback would be tested against a fiction.
   */
  const { doc, settle, restore } = await boot({ deadWorker: true });
  try {
    await settle(8);

    // The user is told, once, in a persistent place.
    const warn = doc.getElementById('sw-warn');
    assert.ok(warn, 'a dead worker must be announced, not silently absorbed');
    assert.match(
      warn.textContent, /Background service unavailable/,
      'the banner must say what is wrong'
    );
    assert.match(
      warn.textContent, /snooze/i,
      'and name the capability that is actually lost'
    );

    // It is a status region, so assistive tech hears it too.
    assert.equal(warn.getAttribute('role'), 'status');

    // And it is dismissable: the app works, so the notice must not be a wall.
    const dismiss = warn.querySelector('button');
    assert.ok(dismiss, 'the banner needs a way out');
    dismiss.click();
    await settle();
    assert.equal(doc.getElementById('sw-warn'), null, 'dismiss must remove it');
  } finally {
    restore();
  }
});

test('FALLBACK: the warning appears exactly once, not per verb', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Boot alone fires several verbs (AUTH_STATUS, PROFILE, SYNC_PAGE...). If
   * each raised its own banner the screen would fill with identical strips,
   * which is a worse experience than the degradation being announced.
   */
  const { doc, settle, restore } = await boot({ deadWorker: true });
  try {
    await settle(8);
    assert.equal(
      doc.querySelectorAll('#sw-warn').length, 1,
      'one banner for the session, however many verbs failed'
    );
  } finally {
    restore();
  }
});

test('UNDO: a FAILED action must not leave an undo entry behind', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * A REAL BUG, found by reading flagAction() and optimistic() side by side.
   *
   * Both push the undo entry unconditionally, at dispatch time, while the
   * network request is still in flight. If the request then FAILS, the catch
   * rolls the local store back -- but the undo entry is still on the stack.
   *
   *   press `s`            -> patch(starred:true), send STAR, push undo
   *   network fails        -> patch(starred:false), error toast
   *   press Ctrl+Z         -> patch(starred:false)  [local no-op]
   *                           send STAR {on:false}  [TELLS GMAIL TO UNSTAR]
   *
   * So undoing a visibly-failed action mutates the mailbox in the opposite
   * direction. If the message had been starred server-side beforehand, the
   * undo silently unstars it.
   *
   * The user-visible symptom is worse than the mechanism: an action reports
   * "Could not update star", and then Ctrl+Z -- the natural response to a
   * failure -- makes a change nobody asked for.
   *
   * The fix is to record the undo only once the request has SUCCEEDED.
   */
  const { doc, win, calls, settle, restore } = await boot({ failVerbs: ['STAR'] });
  try {
    rows(doc)[0].click();
    await settle(6);
    const id = MESSAGES[0].id;
    assert.equal(win.__bmmStore.get(id).starred, false, 'precondition: unstarred');

    press(doc, win, 's');
    await settle(8);

    // The failure rolled the optimistic change back.
    assert.equal(
      win.__bmmStore.get(id).starred, false,
      'a failed star must not stay applied locally'
    );

    // Now the part that matters: undo must have nothing to do.
    calls.length = 0;
    press(doc, win, 'z', { ctrlKey: true });
    await settle(8);

    const starCalls = calls.filter((c) => c.type === 'STAR');
    assert.deepEqual(
      starCalls, [],
      'undo sent a STAR for an action that never succeeded — this mutates the '
      + 'mailbox in the opposite direction'
    );
  } finally {
    restore();
  }
});

