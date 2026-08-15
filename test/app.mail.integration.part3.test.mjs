/**
 * End-to-end app tests in a real DOM — part 3 of 4: compose, mailboxes, settings and cross-cutting flows.
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

test('MODE: modeOf aggregates the distributed mode truth (M1)', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Round-62 N-1. Mode truth lives across body classes, state flags and
   * layer state; modeOf is the read-only aggregate so cross-mode features
   * derive instead of inventing another way to ask. Read-only: no writers.
   */
  const { doc, win, settle, restore } = await boot();
  try {
    await settle(6);
    let mode = win.__bmmModeOf();
    assert.equal(mode.searching, false, 'no query, no focus');
    assert.equal(mode.reading, false);
    assert.equal(mode.selecting, false);

    rows(doc)[0].click();
    await settle(6);
    assert.equal(win.__bmmModeOf().reading, true, 'an open message is reading');

    press(doc, win, 'Escape');
    await settle(4);
    assert.equal(win.__bmmModeOf().reading, false, 'Esc ends reading');

    const search = doc.getElementById('search');
    search.focus();
    search.value = 'allotment';
    search.dispatchEvent(new win.Event('input'));
    await settle(4);
    assert.equal(win.__bmmModeOf().searching, true, 'an active query is searching');
  } finally {
    restore();
  }
});

test('IN-FLIGHT: a pending verb marks the row and clears on the outcome (H1)', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Roadmap H1. The optimistic model moved the row instantly, but nothing
   * distinguished "landed" from "still on the wire". The flag verbs keep
   * the row in the list, so the row can carry the truth: an in-flight mark
   * while the verb is pending, gone the moment it settles. This test slows
   * STAR down enough to observe the pending window.
   */
  const { doc, win, settle, restore } = await boot({ slowVerbs: { STAR: 20 } });
  try {
    rows(doc)[0].click();
    await settle(6);
    const id = MESSAGES[0].id;

    press(doc, win, 's');
    await settle(1); // a frame, but not the 20ms STAR reply

    const row = doc.querySelector(`#list .row[data-id="${id}"]`);
    assert.ok(row, 'the starred row stays in the list (flag verb)');
    assert.ok(row.classList.contains('in-flight'),
      'while the verb is pending, the row says so');

    await new Promise((r) => setTimeout(r, 40)); // let the slow STAR land
    await settle(4);

    assert.equal(win.__bmmStore.get(id).starred, true, 'the star landed');
    assert.ok(!row.classList.contains('in-flight'),
      'the mark clears once the verb settles');
  } finally {
    restore();
  }
});

test('IN-FLIGHT: a failed verb still clears the mark (no stuck pending row)', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The failure path rolls the flag back AND clears the mark — a row must
  // never be left wearing "pending" after its verb has already failed.
  const { doc, win, settle, restore } = await boot({ failVerbs: ['STAR'] });
  try {
    rows(doc)[0].click();
    await settle(6);
    const id = MESSAGES[0].id;

    press(doc, win, 's');
    await settle(8);

    assert.equal(win.__bmmStore.get(id).starred, false, 'failed star rolled back');
    const row = doc.querySelector(`#list .row[data-id="${id}"]`);
    assert.ok(row, 'the row is back');
    assert.ok(!row.classList.contains('in-flight'),
      'a settled (failed) verb must not leave the mark up');
  } finally {
    restore();
  }
});

test('UNDO: a failed ARCHIVE leaves no undo entry either', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The same defect as the star case, in `optimistic()` -- which covers
   * archive, trash, spam, restore and unsnooze, so the stakes are higher.
   *
   * The undo was pushed at dispatch time. On failure the message is restored
   * to the list and an error toast shown, but the undo entry survives; Ctrl+Z
   * then sends UNARCHIVE for an archive that never happened. On a message the
   * user had archived earlier, that silently pulls it back into the inbox.
   */
  const { doc, win, calls, settle, restore } = await boot({ failVerbs: ['ARCHIVE'] });
  try {
    const before = rows(doc).length;
    rows(doc)[0].click();
    await settle(6);

    press(doc, win, 'e');
    await settled(doc, settle);

    // The rollback put it back.
    assert.equal(rows(doc).length, before, 'a failed archive must restore the row');

    calls.length = 0;
    press(doc, win, 'z', { ctrlKey: true });
    await settle(8);

    assert.deepEqual(
      calls.filter((c) => c.type === 'UNARCHIVE'), [],
      'undo sent UNARCHIVE for an archive that never happened'
    );
  } finally {
    restore();
  }
});

test('RECOVERY: a failed verb\'s toast RETRIES the whole act (65/h)', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /* The array is consulted live by the worker contract: draining it
   * mid-test simulates the service recovering. */
  const failing = ['ARCHIVE'];
  const { doc, win, calls, settle, restore } = await boot({ failVerbs: failing });
  try {
    const before = rows(doc).length;
    rows(doc)[0].click(); // open = select, in the threaded-inbox default
    await settle(6);
    press(doc, win, 'e');
    await settled(doc, settle);
    assert.equal(rows(doc).length, before, 'the rollback restored the row');
    assert.equal(doc.getElementById('toast-text').textContent, 'Could not archive');
    const retryChip = doc.getElementById('toast-action');
    assert.equal(retryChip.hidden, false, 'the failure ends in a way forward');
    assert.equal(retryChip.textContent, 'Retry');

    calls.length = 0;
    failing.length = 0; // the service recovers
    retryChip.click();
    await settled(doc, settle);

    assert.deepEqual(calls.filter((c) => c.type === 'ARCHIVE').length, 1,
      'the chip re-ran the act — not a bare resend, the act');
    assert.equal(rows(doc).length, before - 1, 'and the archive landed this time');
  } finally {
    restore();
  }
});

test('RECOVERY: a failed sync ends in Retry, and the retry resyncs (65/h)', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const failing = ['SYNC_DELTA'];
  const { doc, calls, settle, restore } = await boot({ failVerbs: failing });
  try {
    doc.getElementById('btn-refresh').click();
    await settle(8);
    const retryChip = doc.getElementById('toast-action');
    assert.match(doc.getElementById('toast-text').textContent, /SYNC_DELTA failed/);
    assert.equal(retryChip.hidden, false, 'a sync failure is an invitation, not an epitaph');

    calls.length = 0;
    failing.length = 0;
    retryChip.click();
    await settle(10);
    assert.ok(calls.some((c) => c.type === 'SYNC_DELTA'), 'the retry issued a real delta sync');
    assert.equal(doc.getElementById('toast-text').textContent, 'Up to date',
      'recovery confirms in the same surface that carried the failure');
  } finally {
    restore();
  }
});

test('UNDO: a failed auto-archive leaves no undo entry', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The third instance of the same defect. autoArchive fires BULK without
   * awaiting -- deliberately, it must not block ingest -- and then records
   * the undo unconditionally on the next line.
   *
   * If the request fails the snapshots are restored and an error shown, but
   * the entry remains. Ctrl+Z then sends the inverse BULK, adding INBOX back
   * to mail that was never archived. Because auto-archive runs on ingest,
   * the user may not even have been looking when it failed.
   */
  const { doc, win, calls, settle, restore } = await boot({
    messages: [],
    failVerbs: ['BULK'],
    storageSeed: { categoryRules: { muted: [], autoArchive: ['augsd'], corrections: {} } },
  });
  try {
    win.__bmmIngest(bulk(3, { unread: true }));
    await settled(doc, settle);

    // The rollback put the mail back.
    assert.equal(rows(doc).length, 3, 'a failed auto-archive must restore the mail');

    calls.length = 0;
    press(doc, win, 'z', { ctrlKey: true });
    await settle(8);

    assert.deepEqual(
      calls.filter((c) => c.type === 'BULK'), [],
      'undo sent BULK for an auto-archive that never happened'
    );
  } finally {
    restore();
  }
});

test('FALLBACK: a slow but healthy worker is not declared dead', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * REPORTED FROM A REAL INBOX. The amber "Background service unavailable"
   * banner appeared while mail was loading perfectly -- because the worker
   * was not dead at all, it was merely slow.
   *
   * send() applied ONE 4000ms deadline to EVERY verb. AUTH_STATUS answers
   * instantly, but SYNC_PAGE fetches 100 messages plus batched metadata and
   * then classifies them; on a cold start over campus wifi that passes four
   * seconds easily. The app then declared the worker dead, showed the banner,
   * and routed everything through the in-page fallback FOR THE REST OF THE
   * SESSION, because the switch is deliberately sticky.
   *
   * Nothing appeared broken -- the fallback is real, which is why the
   * screenshot showed a working inbox -- but the banner was a lie, snooze
   * timers were disabled for no reason, and two paths were racing.
   *
   * The deadline must fit the verb.
   */
  const { doc, settle, restore } = await boot({ syncLatency: 4200 });
  try {
    /*
     * WAIT FOR THE CONDITION, NOT A FIXED NUMBER OF TURNS.
     *
     * This polled `for (i < 60) await settle(4)` -- about 240 event-loop turns,
     * which happened to outlast a 4.2s timer on the machine it was written on.
     * That is a race, and it began failing intermittently as soon as boot did
     * more work: measured failing on one run and passing on the next with no
     * code change between them.
     *
     * Waiting on the arrival itself is deterministic however much else boot is
     * doing. The assertions below are unchanged.
     */
    const deadline = Date.now() + 12000;
    while (rows(doc).length === 0 && Date.now() < deadline) {
      await settle(4);
    }
    // Rows paint before the post-persistence cursor commit and the remaining
    // boot continuations settle. Let that bounded tail finish before teardown,
    // otherwise a healthy delayed worker writes into a closed jsdom document.
    await settle(12);

    assert.equal(
      doc.getElementById('sw-warn'), null,
      'a slow sync must not be mistaken for a dead worker'
    );
    assert.ok(rows(doc).length > 0, 'and the mail must still arrive');
  } finally {
    restore();
  }
});

test('CONSISTENCY: the rail count agrees with the list header', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * SEEN IN A REAL INBOX. The sidebar read "Inbox 32 48" while the list
   * header two inches away read "All mail 44".
   *
   * Both numbers were right and they measured different things. The rail
   * used `store.size` -- raw messages -- and the header used the rendered
   * row count, which with threading on is one row per CONVERSATION. Four
   * messages were replies collapsed into their threads.
   *
   * To a user that is simply arithmetic that does not add up, in the two
   * places they look most often. The rail sits beside the list, so it has to
   * count what the list shows.
   */
  const conv = [
    { id: 'x1', threadId: 'T', from: 'A <a@x.com>', subject: 'Root',
      snippet: 'a', date: Date.now() - 4000, unread: false, starred: false, labels: ['INBOX'] },
    { id: 'x2', threadId: 'T', from: 'B <b@x.com>', subject: 'Re: Root',
      snippet: 'b', date: Date.now() - 3000, unread: false, starred: false, labels: ['INBOX'] },
    { id: 'x3', threadId: 'T', from: 'C <c@x.com>', subject: 'Re: Root',
      snippet: 'c', date: Date.now() - 2000, unread: false, starred: false, labels: ['INBOX'] },
    { id: 'x4', threadId: 'U', from: 'D <d@x.com>', subject: 'Alone',
      snippet: 'd', date: Date.now() - 1000, unread: false, starred: false, labels: ['INBOX'] },
  ];
  const { doc, settle, restore } = await boot({
    messages: conv, storageSeed: { threaded: true },
  });
  try {
    await settle(8);

    const rendered = rows(doc).length;
    assert.equal(rendered, 2, 'precondition: 4 messages collapse to 2 conversations');

    const header = doc.getElementById('listcount').textContent.trim();
    assert.equal(header, String(rendered), 'the header counts rendered rows');

    const inbox = doc.querySelector('.cat[data-mailbox="inbox"]');
    const railTotal = inbox.querySelector('.c-total').textContent.trim();
    assert.equal(
      railTotal, String(rendered),
      `the rail says ${railTotal} while the list shows ${rendered} — same view, two numbers`
    );
  } finally {
    restore();
  }
});

test('CONSISTENCY: the gate takes focus on open, like every other dialog', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Every other dialog in the product moves focus into itself when it opens:
   * help focuses its close button, the palette focuses its input, compose
   * focuses the first empty field. The gate focused nothing -- so a keyboard
   * or screen-reader user arriving at a signed-out app had focus parked on
   * <body>, behind a modal surface, with no way to discover the one button
   * that does anything.
   *
   * It is the FIRST thing a new user meets, which makes it the worst place in
   * the product to drop focus.
   */
  const { doc, restore } = await boot({ signedIn: false });
  try {
    assert.equal(doc.getElementById('gate').hidden, false, 'precondition: the gate shows');
    assert.equal(
      doc.activeElement.id, 'btn-signin',
      'focus must land on the primary action, not on <body>'
    );
  } finally {
    restore();
  }
});

test('CONSISTENCY: star and mark-unread are undoable one at a time, as they are in bulk', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * DRIFT, found by comparing siblings rather than by looking for a bug.
   *
   * Every single-message action routes through `optimistic()` and records an
   * undo -- archive, trash, spam, restore, unsnooze. Two do not: `star` and
   * `unread`. They were written earlier, as plain patch-and-send blocks, and
   * were never migrated when the helper arrived.
   *
   * The result is that the SAME INTENT has different recovery depending on how
   * many messages you picked:
   *
   *   select two rows, press Star  -> "Starred 2 messages", Undo button
   *   open one message, press `s`  -> nothing, no toast, no undo entry
   *
   * `bulkAct` has recorded undo for `star` and `read` all along, so this is
   * not a product decision that starring is too trivial to reverse -- the
   * product already decided it is not, in the other path.
   *
   * These assert the single-message path now matches.
   */
  const { doc, win, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    const id = win.__bmmStore.get(MESSAGES[0].id).id;
    assert.equal(win.__bmmStore.get(id).starred, false, 'precondition: unstarred');

    press(doc, win, 's');
    await settle();
    assert.equal(win.__bmmStore.get(id).starred, true, 'it stars');

    // The same affordance every other action gives.
    const toastEl = doc.getElementById('toast');
    assert.equal(toastEl.hidden, false, 'starring must report itself');
    assert.match(toastEl.textContent, /Undo/, 'and offer the way back');

    press(doc, win, 'z', { ctrlKey: true });
    await settle();
    await settle();
    assert.equal(win.__bmmStore.get(id).starred, false, 'undo unstars');
  } finally {
    restore();
  }
});

test('CONSISTENCY: marking unread is undoable too', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * `markReadOnOpen` is off so the grace-period timer cannot race this. The
   * first draft of this test opened m1 -- which SEEDS UNREAD -- and asserted
   * `u` made it unread; `u` is a toggle, so it correctly made it read and the
   * test failed. The test was wrong, not the product. Starting from a known
   * read state makes the toggle direction unambiguous.
   */
  const { doc, win, settle, restore } = await boot({
    storageSeed: { markReadOnOpen: false },
  });
  try {
    const id = MESSAGES[2].id; // seeded read
    const row = rows(doc).find((r) => r.dataset.id === id) || rows(doc)[2];
    row.click();
    await settle(8);
    assert.equal(win.__bmmStore.get(id).unread, false, 'precondition: read');

    press(doc, win, 'u');
    await settle();
    assert.equal(win.__bmmStore.get(id).unread, true, 'it marks unread');

    const toastEl = doc.getElementById('toast');
    assert.match(toastEl.textContent, /Undo/, 'offers undo like its siblings');

    press(doc, win, 'z', { ctrlKey: true });
    await settle();
    await settle();
    assert.equal(win.__bmmStore.get(id).unread, false, 'undo restores read state');
  } finally {
    restore();
  }
});

test('BULK: every action undoes by exactly reversing its own label delta', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THE BULK LADDER STATES EACH DELTA TWICE.
   *
   * `bulkAct` has a forward chain of five `if (kind === ...)` branches and a
   * second, separate chain inside `recordUndo` that hand-writes the inverse.
   * Nothing ties the two together: the undo for `trash` is correct only
   * because someone typed `add: ['INBOX'], remove: ['TRASH']` correctly, and a
   * sixth action added to one chain and not the other, or an inverse typed
   * with add/remove the right way round but the wrong LABEL, fails silently.
   *
   * The existing coverage could not see this. "archiving many undoes as ONE
   * step" counts ROWS, and rows come back from the local snapshot regardless
   * of what is sent to Gmail -- so a completely wrong inverse payload still
   * restores the list on screen and only diverges on the server, where this
   * test suite cannot look.
   *
   * This asserts the round trip at the wire: for each action, whatever labels
   * the forward call ADDS the undo must REMOVE, and vice versa. Verified
   * against the real payloads rather than against the source text.
   */
  const cases = [
    { button: 'bulk-archive', kind: 'archive' },
    { button: 'bulk-trash', kind: 'trash' },
    { button: 'bulk-read', kind: 'read' },
    { button: 'bulk-star', kind: 'star' },
    { button: 'bulk-spam', kind: 'spam' },
  ];

  for (const { button, kind } of cases) {
    const { doc, win, calls, settle, restore } = await boot({ messages: bulk(6) });
    try {
      pick(rows(doc)[0], win);
      pick(rows(doc)[1], win);
      await settle();

      calls.length = 0;
      doc.getElementById(button).click();
      await settled(doc, settle);

      const forward = calls.filter((c) => c.type === 'BULK');
      assert.equal(forward.length, 1, `${kind}: one BULK call goes out, not N`);

      calls.length = 0;
      doc.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })
      );
      await settle();
      await settle();

      const back = calls.filter((c) => c.type === 'BULK');
      assert.equal(back.length, 1, `${kind}: undo also sends exactly one BULK`);

      const f = forward[0];
      const u = back[0];
      const norm = (v) => [...(v || [])].sort();

      assert.deepEqual(
        norm(u.remove), norm(f.add),
        `${kind}: undo must REMOVE every label the action ADDED`
      );
      assert.deepEqual(
        norm(u.add), norm(f.remove),
        `${kind}: undo must ADD BACK every label the action REMOVED`
      );
      // And it must act on the same messages, not a re-derived selection.
      assert.deepEqual(norm(u.ids), norm(f.ids), `${kind}: same ids both ways`);
    } finally {
      restore();
    }
  }
});

test('BULK: Escape clears the selection before anything else', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Selection is the innermost transient state, so it unwinds first —
  // Escape must not release the takeover while a selection is pending.
  const { doc, win, settle, restore } = await boot();
  try {
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    await settle();
    assert.equal(doc.getElementById('bulkbar').hidden, false, 'x ticks a row');

    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    assert.equal(doc.getElementById('bulkbar').hidden, true);
  } finally {
    restore();
  }
});

test('BULK: selection survives a re-render', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Selection lives outside the store, so a delta arriving mid-triage must not
   * silently drop the ticks the user has already placed.
   *
   * THE ARRIVALS ARE IN NEW CONVERSATIONS. The original version reused
   * `bulk(2)`, whose threadIds collide with the existing rows -- so under
   * threading the "new" messages joined the ticked conversations and became
   * their roots. That is correct product behaviour (see the THREAD: tick
   * tests) but it is not what this test is about: this one is about unrelated
   * mail arriving mid-triage. Distinct threadIds keep the two cases apart.
   */
  const { doc, win, settle, restore } = await boot({ messages: bulk(6) });
  try {
    pick(rows(doc)[0], win);
    pick(rows(doc)[1], win);
    await settle();
    assert.equal(doc.querySelectorAll('.row.picked').length, 2);

    win.__bmmIngest(bulk(2).map((m, i) => ({
      ...m, id: `new${m.id}`, threadId: `newthread${i}`, subject: 'arrived later',
    })));
    await settle();

    assert.equal(doc.querySelectorAll('.row.picked').length, 2, 'ticks must survive');
    assert.equal(doc.getElementById('bulk-count').textContent, '2 selected');
  } finally {
    restore();
  }
});

// -------------------------------------------------------- attachments ----

test('ATT: attachments are actionable chips in the app, not text in the frame', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The body iframe has no allow-scripts by design, so anything rendered
  // inside it can NEVER be clickable. Attachments were a filename printed as
  // text: named, visible, and impossible to open. Moving them into the app
  // chrome is the only way they become actionable without weakening the
  // sandbox that protects against hostile mail.
  const withAtt = [
    { ...MESSAGES[0], id: 'att-msg' },
  ];
  const { doc, settle, restore } = await boot({
    messages: withAtt,
    bodyOverride: {
      attachments: [
        { filename: 'Schedule.pdf', mimeType: 'application/pdf', size: 284112, attachmentId: 'a1' },
      ],
    },
  });
  try {
    rows(doc)[0].click();
    await settle();
    await settle();

    const strip = doc.getElementById('r-attachments');
    assert.equal(strip.hidden, false, 'the strip must appear');

    const chip = doc.querySelector('.att-chip');
    assert.ok(chip, 'an attachment chip must exist');
    assert.equal(chip.tagName, 'BUTTON', 'it must be a real control, not text');
    assert.equal(chip.querySelector('.att-name').textContent, 'Schedule.pdf');
    assert.equal(chip.querySelector('.att-size').textContent, '277 KB', 'bytes are meaningless');
    assert.ok(chip.querySelector('svg'), 'and carries the shared icon');

    // The body frame must no longer print them.
    const srcdoc = doc.getElementById('r-body').getAttribute('srcdoc') || '';
    assert.ok(!srcdoc.includes('Schedule.pdf'), 'the inert copy must be gone');
  } finally {
    restore();
  }
});

test('ATT: the strip hides for a message with no attachments', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    await settle();
    assert.equal(doc.getElementById('r-attachments').hidden, true);
  } finally {
    restore();
  }
});

// ------------------------------------------------------- saved views -----

test('VIEWS: built-ins render with live counts', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // A count is what makes a saved view useful rather than a bookmark.
  const { doc, restore } = await boot();
  try {
    const items = [...doc.querySelectorAll('.view-item')];
    assert.ok(items.length >= 4, 'built-in views must render');
    const unread = items.find((i) => i.querySelector('.view-name').textContent === 'Unread');
    assert.ok(unread, 'Unread view must exist');
    assert.equal(unread.querySelector('.view-count').textContent, '2', 'count reflects the store');
  } finally {
    restore();
  }
});

test('VIEWS: clicking one applies its query and marks it current', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot();
  try {
    const unread = [...doc.querySelectorAll('.view-item')]
      .find((i) => i.querySelector('.view-name').textContent === 'Unread');
    unread.click();
    await settle();

    assert.equal(doc.getElementById('search').value, 'is:unread');
    assert.equal(rows(doc).length, 2, 'the list is filtered');
    assert.ok(doc.querySelector('.view-item[aria-current="true"]'), 'the active view is marked');
  } finally {
    restore();
  }
});

test('VIEWS: switching category clears the active view', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Leaving a view highlighted after its query was cleared claims a filter is
  // applied when it is not.
  const { doc, settle, restore } = await boot();
  try {
    [...doc.querySelectorAll('.view-item')][0].click();
    await settle();
    assert.ok(doc.querySelector('.view-item[aria-current="true"]'));

    doc.querySelector('.cat[data-cat="augsd"]').click();
    await settle();
    assert.equal(doc.querySelector('.view-item[aria-current="true"]'), null);
    assert.equal(doc.getElementById('search').value, '');
  } finally {
    restore();
  }
});

test('VIEWS: the save affordance appears only for an unsaved query', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // An always-present save button on an empty box is noise, and offering to
  // save something already saved is a small lie about what it will do.
  const { doc, win, settle, restore } = await boot();
  try {
    const btn = doc.getElementById('btn-save-view');
    assert.equal(btn.hidden, true, 'hidden with no query');

    const search = doc.getElementById('search');
    search.value = 'from:augsd';
    search.dispatchEvent(new win.Event('input'));
    await settle();
    assert.equal(btn.hidden, false, 'shown for a new query');

    search.value = 'is:unread';
    search.dispatchEvent(new win.Event('input'));
    await settle();
    assert.equal(btn.hidden, true, 'hidden for an already-saved query');
  } finally {
    restore();
  }
});

/* ========================================================================== *
 * UI POLISH AUDIT — behavioural, not source-scanning
 *
 * The tests below drive the real DOM. Everything they assert was previously
 * covered only by reading source text, which cannot see focus, event ordering
 * or what a keystroke actually does.
 * ========================================================================== */


test('HELP: ? opens the overlay and Escape restores focus to where it was', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const help = doc.getElementById('help');
    assert.equal(help.hidden, true, 'starts hidden');

    // Focus something specific first, so restoration is observable.
    const search = doc.getElementById('search');
    search.focus();
    assert.equal(doc.activeElement, search);

    press(doc, win, '?');
    await settle();
    assert.equal(help.hidden, false, '? must open the overlay');
    assert.ok(help.contains(doc.activeElement), 'focus must move INTO the dialog');
    assert.ok(doc.getElementById('help-body').children.length > 0, 'content is rendered');

    press(doc, win, 'Escape');
    await settle();
    assert.equal(help.hidden, true, 'Escape closes it');
    assert.equal(doc.activeElement, search, 'focus must return to where it came from');
  } finally {
    restore();
  }
});

test('HELP: shortcuts do not fire at the message list while help is open', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Archiving a message the user cannot see is the worst kind of surprise.
  const { doc, win, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    const before = rows(doc).length;

    press(doc, win, '?');
    await settle();
    press(doc, win, 'e');       // archive
    press(doc, win, '#');       // delete
    await settle();

    assert.equal(rows(doc).length, before, 'no message may be triaged behind the overlay');
  } finally {
    restore();
  }
});

test('HELP: renders every documented shortcut exactly once', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    press(doc, win, '?');
    await settle();
    press(doc, win, '?');       // toggle closed
    await settle();
    press(doc, win, '?');       // and open again
    await settle();

    const { allShortcuts } = await import('../src/app/core/shortcuts.js');
    assert.equal(
      doc.querySelectorAll('#help-body dt').length,
      allShortcuts().length,
      'reopening must replace the content, not append to it'
    );
  } finally {
    restore();
  }
});

test('ESCAPE: unwinds one layer at a time, innermost first', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The ordering complaint this prevents is "one Escape too many dumped me
   * back in Gmail". Help sits above the palette; neither may release the
   * takeover while it is open.
   */
  const { doc, win, settle, restore } = await boot();
  try {
    let released = false;
    win.parent = {
      postMessage(m) { if (m?.type === 'BMM_RELEASE') released = true; },
    };

    press(doc, win, 'k', { ctrlKey: true });   // palette
    await settle();
    assert.equal(doc.getElementById('palette').hidden, false);

    press(doc, win, '?');                      // help, on top of it
    await settle();
    assert.equal(doc.getElementById('help').hidden, false);

    press(doc, win, 'Escape');
    await settle();
    assert.equal(doc.getElementById('help').hidden, true, 'help closes first');
    assert.equal(doc.getElementById('palette').hidden, false, 'palette must survive');
    assert.equal(released, false, 'the takeover must not be released');

    press(doc, win, 'Escape');
    await settle();
    assert.equal(doc.getElementById('palette').hidden, true, 'then the palette');
    assert.equal(released, false, 'still not released');
  } finally {
    restore();
  }
});

test('LABELS: the palette offers the user\'s own Gmail labels', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * LIST_LABELS was implemented and called by nothing across three audits,
   * and `label:` was a search operator you could only use if you already
   * knew your labels by heart. The palette is where both become reachable.
   */
  const { doc, win, settle, restore } = await boot({
    labels: [{ id: 'L1', name: 'Thesis' }, { id: 'L2', name: 'Work/CI' }],
  });
  try {
    await settle(8); // the fetch is fire-and-forget
    await openPaletteWith(doc, win, settle, 'label');

    const found = paletteLabels(doc);
    assert.equal(found.length, 2, `expected two label commands, got: ${found}`);
    assert.ok(found.some((t) => t.includes('Thesis')));
    assert.ok(found.some((t) => t.includes('Work/CI')));
  } finally {
    restore();
  }
});

test('LABELS: choosing one runs a label: search', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The command must produce a query the parser actually understands --
  // otherwise it is a menu entry that quietly does nothing.
  const { doc, win, settle, restore } = await boot({
    labels: [{ id: 'L1', name: 'Thesis' }],
  });
  try {
    await settle(8);
    await seedLabels([{ id: 'L1', name: 'Thesis' }]);
    await openPaletteWith(doc, win, settle, 'Thesis');

    const item = [...doc.querySelectorAll('#palette-list .palette-item')]
      .find((li) => li.textContent.includes('Thesis'));
    assert.ok(item, 'the label command must be present');
    item.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await settle(8);

    assert.equal(doc.getElementById('search').value, 'label:Thesis');
  } finally {
    restore();
  }
});

test('LABELS: a failing LIST_LABELS degrades silently', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The label cache lives in features.js module state, and only app.js is
   * re-imported with a cache-busting URL per boot -- so labels from an
   * earlier test survive into this one. Clear it, or this test passes on
   * the PREVIOUS case's data and proves nothing about failure handling.
   */

  // Labels are a convenience. A network failure must not raise a toast or
  // block boot -- the palette simply carries fewer commands.
  const { doc, win, settle, restore } = await boot({ labels: null });
  try {
    await settle(8);
    await openPaletteWith(doc, win, settle, 'label');

    assert.equal(paletteLabels(doc).length, 0);
    assert.equal(
      doc.getElementById('palette').hidden, false,
      'the palette must still work'
    );
  } finally {
    restore();
  }
});

test('LABELS: signing out drops the previous account\'s label names', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Label names are private data belonging to the account that was signed in.
  // Leaving them cached would leak them into the next user's palette.
  const { doc, win, settle, restore } = await boot({
    labels: [{ id: 'L1', name: 'Confidential-Project' }],
  });
  try {
    await settle(8);
    await seedLabels([{ id: 'L1', name: 'Confidential-Project' }]);
    await openPaletteWith(doc, win, settle, 'Confidential');
    assert.equal(paletteLabels(doc).length, 1, 'precondition: the label is offered');
    press(doc, win, 'Escape');
    await settle(4);

    doc.getElementById('btn-signout').click();
    await settle(12);

    await openPaletteWith(doc, win, settle, 'Confidential');
    const leaked = paletteLabels(doc);
    assert.equal(leaked.length, 0, `label names survived sign-out: ${leaked}`);
  } finally {
    restore();
  }
});

test('PALETTE: recents lead the untyped list; Undo explains why it cannot run (65/f)', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const paletteItems = () => [...doc.querySelectorAll('#palette-list .palette-item')];
    const openPalette = async () => { press(doc, win, 'k', { ctrlKey: true }); await settle(4); };

    // First open with nothing recorded: no section labels, canonical order.
    await openPalette();
    assert.equal(doc.querySelectorAll('.palette-sep').length, 0, 'no recents → no sections');

    // Undo with an empty stack stays visible but cannot run — the reason
    // sits where the shortcut would.
    const undoRow = paletteItems().find((li) => li.textContent.includes('Undo last action'));
    assert.ok(undoRow, 'undo is listed');
    assert.ok(undoRow.classList.contains('disabled'), 'an inert command is stated, not silently clickable');
    assert.equal(undoRow.getAttribute('aria-disabled'), 'true');
    assert.match(undoRow.querySelector('.palette-hint-key').textContent, /Nothing to undo/);
    undoRow.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await settle(4);
    assert.equal(doc.getElementById('palette').hidden, false,
      'clicking a disabled row leaves the palette open, reason still on screen');

    // Run a real command; it must lead the next untyped open.
    paletteItems().find((li) => li.textContent.includes('Search mail'))
      .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await settle(4);
    assert.equal(doc.getElementById('palette').hidden, true, 'a real command closes the palette');

    await openPalette();
    const seps = [...doc.querySelectorAll('.palette-sep')].map((li) => li.textContent);
    assert.deepEqual(seps, ['Recent', 'Everything'], 'recents form a labelled group ahead of the rest');
    assert.ok(paletteItems()[0].textContent.includes('Search mail'),
      'the most recently used command leads the untyped list');

    // A typed query is an explicit act: no habit reorders it.
    const input = doc.getElementById('palette-input');
    input.value = 'ref';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    await settle(4);
    assert.equal(doc.querySelectorAll('.palette-sep').length, 0, 'typed intent outranks habit');
    press(doc, win, 'Escape');
    await settle(4);
  } finally {
    restore();
  }
});

test('DEEP LINKS: views push entries, keystrokes never do, Back walks views (65/g)', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    // Boot canonicalizes the URL to the default view.
    await settle(4);
    assert.equal(win.location.hash, '#inbox/all', 'the settled frame mirrors into the URL');
    const len0 = win.history.length;

    // A category click is a deliberate view: one history entry appears.
    doc.querySelector('#cats .cat[data-cat="augsd"]').click();
    await settle();
    assert.equal(win.location.hash, '#inbox/augsd');
    assert.equal(win.history.length, len0 + 1, 'one push per view, not per frame');

    // Typing a query and j/k-ing through results only mirror — zero entries.
    const search = doc.getElementById('search');
    search.value = 'regis';
    search.dispatchEvent(new win.Event('input'));
    await settle();
    assert.match(win.location.hash, /^#inbox\/augsd\?q=regis(&m=|$)/);
    press(doc, win, 'j');
    await settle();
    const withM = win.location.hash;
    const selId = doc.querySelector(".row[aria-selected='true']")?.dataset.id;
    assert.ok(selId, 'j opened a message');
    assert.equal(withM, `#inbox/augsd?q=regis&m=${selId}`, 'the open message is in the URL');
    press(doc, win, 'j');
    await settle();
    press(doc, win, 'k');
    await settle();
    assert.equal(win.history.length, len0 + 1,
      'j/k moved the selection twice and history did not grow — pollution is impossible');

    // Back walks the VIEW: category, query and reader all return to default.
    win.history.back();
    await settle(6);
    assert.equal(win.location.hash, '#inbox/all');
    assert.equal(search.value, '', 'the query left with its entry');
    assert.equal(doc.querySelector('#listquery').hidden, true);
    assert.equal(doc.querySelector(".row[aria-selected='true']"), null, 'the reader closed with its entry');
    assert.deepEqual(rowText(doc), ['Registration for Semester II', 'PS-II station allotment', 'Run failed: CI on main']);

    // Forward re-applies the whole deep link, selection included.
    win.history.forward();
    await settle(8);
    assert.equal(win.location.hash, withM, 'the entry remembered the open message');
    assert.equal(doc.querySelector(".row[aria-selected='true']")?.dataset.id, selId,
      'forward restored the message, not just the view');
    assert.equal(search.value, 'regis');
  } finally {
    restore();
  }
});

test('MAILBOX: the rail exposes the system mailboxes and switching works', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const ids = [...doc.querySelectorAll('.cat[data-mailbox]')].map((b) => b.dataset.mailbox);
    for (const want of ['inbox', 'sent', 'drafts', 'trash', 'spam', 'snoozed']) {
      assert.ok(ids.includes(want), `rail is missing ${want}`);
    }

    const sent = doc.querySelector('.cat[data-mailbox="sent"]');
    sent.click();
    await settle();
    assert.equal(sent.getAttribute('aria-current'), 'true', 'Sent becomes current');
    // Categories are an inbox concept and must not be shown in Sent.
    assert.equal(doc.getElementById('cat-group').hidden, true);
  } finally {
    restore();
  }
});

test('MAILBOX: switching clears a stale search rather than double-filtering', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    const search = doc.getElementById('search');
    search.value = 'registration';
    search.dispatchEvent(new win.Event('input'));
    await settle();
    assert.equal(search.value, 'registration');

    doc.querySelector('.cat[data-mailbox="trash"]').click();
    await settle();
    assert.equal(search.value, '', 'the visible control must match the applied state');
  } finally {
    restore();
  }
});

test('MAILBOX: the rail stays a single tab stop after switching', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Two groups must not become two tab stops.
  const { doc, settle, restore } = await boot();
  try {
    doc.querySelector('.cat[data-mailbox="sent"]').click();
    await settle();
    const tabbable = [...doc.querySelectorAll('#cats .cat')].filter((c) => c.tabIndex === 0);
    assert.equal(tabbable.length, 1, `expected 1 tab stop, found ${tabbable.length}`);
  } finally {
    restore();
  }
});

test('SNOOZE: z opens a picker with only future options', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle();
    press(doc, win, 'z');
    await settle();

    const menu = doc.querySelector('.snooze-menu');
    assert.ok(menu, 'z must open the snooze picker');
    const opts = menu.querySelectorAll('.snooze-opt');
    assert.ok(opts.length >= 2, 'expected several wake times');
    assert.ok(menu.contains(doc.activeElement), 'focus moves into the menu');

    press(doc, win, 'Escape');
    await settle();
    assert.equal(doc.querySelector('.snooze-menu'), null, 'Escape dismisses it');
    // And must NOT also have closed the reader.
    assert.equal(doc.getElementById('reader').hidden, false, 'the reader must stay open');
  } finally {
    restore();
  }
});

test('IMAGES: a blocked remote image is announced with a way to load it', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, settle, restore } = await boot({
    bodyOverride: { html: '<p>hi</p><img src="https://tracker.example/pixel.png">' },
  });
  try {
    rows(doc)[0].click();
    await settle();

    const bar = doc.getElementById('r-images');
    assert.equal(bar.hidden, false, 'the bar must appear when something was blocked');
    assert.match(doc.getElementById('r-images-text').textContent, /1 image/);
    assert.ok(!doc.getElementById('r-images-show').hidden, 'an override must be offered');
  } finally {
    restore();
  }
});


