/**
 * End-to-end app tests in a real DOM — part 1b of 4: cache-first boot, accessibility and themes.
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
test('clicking a category filters the list', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot();
  try {
    doc.querySelector('#cats .cat[data-cat="augsd"]').click();
    await settle();
    assert.deepEqual(rowText(doc), ['Registration for Semester II']);
    doc.querySelector('#cats .cat[data-cat="all"]').click();
    await settle();
    assert.equal(rows(doc).length, 3);
  } finally {
    restore();
  }
});

test('search filters by subject and by sender, and clears', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const search = doc.getElementById('search');

    search.value = 'allotment';
    search.dispatchEvent(new win.Event('input'));
    await settle();
    assert.deepEqual(rowText(doc), ['PS-II station allotment']);

    // Sender local-part is indexed separately, so this must hit.
    search.value = 'augsd';
    search.dispatchEvent(new win.Event('input'));
    await settle();
    assert.deepEqual(rowText(doc), ['Registration for Semester II']);

    // P-3 (round 62): search mode is a READOUT, not an inference — the bar
    // states the active query while it filters, and drops it on clear.
    const readout = doc.getElementById('listquery');
    assert.equal(readout.hidden, false, 'the query is stated while active');
    assert.match(readout.textContent, /augsd/);

    search.value = '';
    search.dispatchEvent(new win.Event('input'));
    await settle();
    assert.equal(rows(doc).length, 3);
    assert.equal(readout.hidden, true, 'and gone the moment it clears');
  } finally {
    restore();
  }
});

test('search chips edit the query, clear it, and promote it to a view (65/e)', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const search = doc.getElementById('search');
    const strip = () => doc.getElementById('listquery');

    search.value = 'from:augsd registration';
    search.dispatchEvent(new win.Event('input'));
    await settle();
    assert.deepEqual(rowText(doc), ['Registration for Semester II']);
    assert.equal(strip().hidden, false);
    const chips = strip().querySelectorAll('.q-chip');
    assert.equal(chips.length, 2, 'scope and free text are separate chips');
    assert.match(strip().textContent, /^Query/, 'the visual query-console label leads');

    // Removing the scope chip is string surgery on the one query.
    chips[0].querySelector('.q-x').click();
    await settle();
    assert.equal(search.value, 'registration', 'the scope left, the thought stayed');
    assert.equal(strip().querySelectorAll('.q-chip').length, 1);
    assert.equal(doc.activeElement, search, 'focus returns to the field');

    // Save promotes the result state into a view — from the strip itself.
    const saveChip = strip().querySelector('[data-chip-action="save"]');
    assert.ok(saveChip, 'unsaved queries offer save where the results are');
    saveChip.click();
    await settle();
    const dialog = doc.querySelector('.prompt-box');
    assert.ok(dialog, 'the save dialog opens, not a native prompt');
    dialog.querySelector('.prompt-actions .primary').click();
    await settle();
    assert.equal(strip().querySelector('[data-chip-action="save"]'), null,
      'a saved query stops offering save — derived, not toggled');
    assert.equal(doc.getElementById('btn-save-view').hidden, true);
    assert.ok(doc.querySelector('.view-item[data-query="registration"]'),
      'the view joins the saved list');

    // One-click clear returns the whole list.
    strip().querySelector('[data-chip-action="clear"]').click();
    await settle();
    assert.equal(search.value, '');
    assert.equal(strip().hidden, true, 'gone the moment the query clears');
    assert.equal(rows(doc).length, 3);
  } finally {
    restore();
  }
});

test('opening a message shows it and optimistically marks it read', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, calls, settle, restore } = await boot();
  try {
    const first = rows(doc)[0];
    assert.ok(first.classList.contains('unread'));

    first.click();
    await settle();

    assert.equal(doc.getElementById('reader').hidden, false);
    assert.equal(doc.getElementById('r-subject').textContent, 'Registration for Semester II');
    // The BODY is fetched immediately -- reading must never wait.
    assert.ok(calls.some((c) => c.type === 'GET_BODY' && c.id === 'm1'));

    /*
     * Marking read is DELIBERATELY DELAYED (settings.markReadDelayMs).
     *
     * Unread is the one piece of triage state a user cannot reconstruct, so a
     * mis-click must not consume it. This test previously asserted the
     * instant behaviour; it now pins the delay, and the two tests below pin
     * both outcomes of it.
     */
    assert.ok(
      !calls.some((c) => c.type === 'MARK_READ'),
      'must not mark read on the same tick as the click'
    );
    assert.ok(rows(doc)[0].classList.contains('unread'), 'still unread during the grace period');

    // Wait past the default delay and it lands, optimistically.
    await new Promise((r) => setTimeout(r, 1400));
    await settle();
    assert.ok(!rows(doc)[0].classList.contains('unread'), 'read once the delay elapses');
    assert.ok(calls.some((c) => c.type === 'MARK_READ' && c.id === 'm1'));
  } finally {
    restore();
  }
});

test('a message skimmed past within the grace period stays unread', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The reason the delay exists. Arrowing through the list, or opening the
   * wrong message and leaving immediately, must not silently destroy unread
   * state across every message you touched.
   */
  const { doc, win, calls, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    // Move on well before the delay elapses.
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    await settle();

    await new Promise((r) => setTimeout(r, 1400));
    await settle();

    assert.ok(
      !calls.some((c) => c.type === 'MARK_READ' && c.id === 'm1'),
      'the message that was skimmed past must not be marked read'
    );
    assert.ok(rows(doc)[0].classList.contains('unread'));
  } finally {
    restore();
  }
});

test('closing the reader cancels a pending mark-read', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, calls, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();

    await new Promise((r) => setTimeout(r, 1400));
    await settle();

    assert.ok(
      !calls.some((c) => c.type === 'MARK_READ' && c.id === 'm1'),
      'a message opened and immediately closed stays unread'
    );
  } finally {
    restore();
  }
});

test('the star button toggles without waiting for the network', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, calls, settle, restore } = await boot();
  try {
    const star = rows(doc)[0].querySelector('.r-star');
    assert.equal(star.getAttribute('aria-pressed'), 'false');

    star.click();
    await settle();

    assert.equal(rows(doc)[0].querySelector('.r-star').getAttribute('aria-pressed'), 'true');
    const call = calls.find((c) => c.type === 'STAR');
    assert.deepEqual({ id: call.id, on: call.on }, { id: 'm1', on: true });
  } finally {
    restore();
  }
});

test('archiving removes the row and selects a neighbour', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, calls, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();

    doc.querySelector('#r-actions button[data-act="archive"]').click();
    await settle();

    // The row animates out, so it lingers ~140ms after the store drops it.
    assert.equal((await settled(doc, settle)).length, 2, 'archived row should be gone');
    assert.ok(!rowText(doc).includes('Registration for Semester II'));
    assert.ok(calls.some((c) => c.type === 'ARCHIVE' && c.id === 'm1'));
    // The reading pane should have moved on, not gone blank.
    assert.equal(doc.getElementById('r-subject').textContent, 'PS-II station allotment');
  } finally {
    restore();
  }
});

test('j/k move the selection and Escape closes the reader', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const key = (k) => {
      doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }));
      return settle();
    };

    await key('j');
    assert.equal(doc.getElementById('r-subject').textContent, 'Registration for Semester II');

    await key('j');
    assert.equal(doc.getElementById('r-subject').textContent, 'PS-II station allotment');

    await key('k');
    assert.equal(doc.getElementById('r-subject').textContent, 'Registration for Semester II');

    await key('Escape');
    assert.equal(doc.getElementById('reader').hidden, true, 'Escape should close the reader');
  } finally {
    restore();
  }
});

test('the signed-out gate appears instead of the list', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, calls, restore } = await boot({ signedIn: false });
  try {
    assert.equal(doc.getElementById('gate').hidden, false);
    assert.equal(rows(doc).length, 0);
    assert.ok(!calls.some((c) => c.type === 'SYNC_PAGE'), 'must not sync while signed out');
  } finally {
    restore();
  }
});

test('an empty inbox shows the empty state rather than a blank pane', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, restore } = await boot({ messages: [] });
  try {
    assert.equal(rows(doc).length, 0);
    assert.equal(doc.getElementById('empty').hidden, false);
  } finally {
    restore();
  }
});

test('the app tells the content script it has painted', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // If BMM_READY never fires, the takeover animation waits out its 2s timeout
  // and the handover looks broken.
  const html = readFileSync(join(ROOT, 'app.html'), 'utf8');
  const src = readFileSync(join(ROOT, 'src/app/main.js'), 'utf8');
  assert.ok(
    src.includes("type: 'BMM_READY'") && src.includes("'https://mail.google.com'"),
    'app.js must post BMM_READY to its parent'
  );
  // The readiness handshake carries the embed nonce when embedded
  // (bug-hunt 44 #70); the contract is asserted, not just the call.
  assert.match(src, /\{ type: 'BMM_READY', \.\.\.\(EMBED_NONCE/,
    'readiness echoes the embed nonce');
  assert.ok(html.includes('app.js'));
});

// -------------------------------------------- no cap on rendered rows ------


test('REGRESSION: every message renders — there is no 400-row cap', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // renderedIds is what j/k and archive-neighbour walk, so a truncated render
  // made rows 401+ unreachable by scroll, click AND keyboard, while the
  // sidebar still counted them.
  const { doc, restore } = await boot({ messages: bulk(600) });
  try {
    assert.equal(rows(doc).length, 600, 'all 600 rows must be in the DOM');
    // The last row is real and openable, not a placeholder.
    const last = rows(doc)[599];
    assert.equal(last.dataset.id, 'b599');
    assert.equal(last.querySelector('.r-subj').textContent, 'Bulk message 599');
  } finally {
    restore();
  }
});

test('REGRESSION: the count reads the whole truth, not "400 of 600"', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, restore } = await boot({ messages: bulk(600) });
  try {
    assert.equal(doc.getElementById('listcount').textContent, '600');
  } finally {
    restore();
  }
});

test('REGRESSION: a message past row 400 is reachable by keyboard', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot({ messages: bulk(450) });
  try {
    // Select the row that the old cap made unreachable, then confirm j/k can
    // actually move onto and off it.
    rows(doc)[430].click();
    await settle();
    assert.equal(doc.getElementById('r-subject').textContent, 'Bulk message 430');

    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    await settle();
    assert.equal(doc.getElementById('r-subject').textContent, 'Bulk message 431');

    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    await settle();
    assert.equal(doc.getElementById('r-subject').textContent, 'Bulk message 430');
  } finally {
    restore();
  }
});

// ------------------------------------------- the core render invariant -----

test('INVARIANT: one store notification and one render per sync', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The single most important property in the codebase, previously enforced by
  // convention only. bench.mjs PRINTED "renders triggered: 1" but did not
  // assert it, so a regression to per-mutation rendering -- the exact defect
  // that made v1 unusable -- would have passed green.
  //
  // BOTH halves are asserted, because each hides the other:
  //   - DOM writes alone pass even when the store is mutated unbatched,
  //     because the rAF coalescer collapses the notifications anyway. Verified
  //     by sabotaging upsertMany into a per-message loop: the DOM assertion
  //     still passed.
  //   - Notifications alone would not catch a render loop that writes twice
  //     for one notification.
  const { win, doc, restore } = await boot({ messages: [] });
  try {
    const list = doc.getElementById('list');
    let domWrites = 0;
    const obs = new win.MutationObserver(() => domWrites++);
    obs.observe(list, { childList: true });

    let notifications = 0;
    const unsub = win.__bmmStore.subscribe(() => notifications++);

    win.__bmmIngest(bulk(200));
    await new Promise((r) => win.requestAnimationFrame(() => r()));
    await new Promise((r) => setTimeout(r, 0));
    obs.disconnect();
    unsub();

    assert.equal(rows(doc).length, 200, 'all 200 must be rendered');
    assert.equal(notifications, 1, `store must notify once, got ${notifications}`);
    assert.equal(domWrites, 1, `list must be written once, got ${domWrites}`);
  } finally {
    restore();
  }
});

// ------------------------------------------------------ cache-first boot ---

test('CACHE: a warm start paints from disk and asks only for a delta', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Before this, every takeover cold-fetched ~100 messages and the historyId
  // cursor had no local state to be a delta against, which made the whole
  // History API integration decorative.
  const cached = bulk(40).map((m) => ({ ...m, category: 'augsd', confidence: 0.9 }));
  const { doc, calls, restore } = await boot({
    messages: [],
    storageSeed: { msgCache: cacheBlob(cached), historyId: '12345' },
  });
  try {
    assert.equal(rows(doc).length, 40, 'cached rows must be on screen');
    assert.ok(calls.some((c) => c.type === 'SYNC_DELTA'), 'must ask for a delta');
    assert.ok(
      !calls.some((c) => c.type === 'SYNC_PAGE'),
      'must NOT cold-fetch a full page when the cache served'
    );
  } finally {
    restore();
  }
});

test('CACHE: a cold start with no cache still full-syncs', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, calls, restore } = await boot({ messages: MESSAGES });
  try {
    assert.equal(rows(doc).length, 3);
    assert.ok(calls.some((c) => c.type === 'SYNC_PAGE'), 'no cache means a full page');
  } finally {
    restore();
  }
});


