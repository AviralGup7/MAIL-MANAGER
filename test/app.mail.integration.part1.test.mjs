/**
 * End-to-end app tests in a real DOM — part 1 of 3: core rendering, classification, sidebar and boot.
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

test('app boots, signs in and renders the inbox', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, calls, restore } = await boot();
  try {
    assert.equal(doc.getElementById('gate').hidden, true, 'gate should be hidden when signed in');
    assert.equal(rows(doc).length, 3, 'all three messages should render');
    assert.ok(calls.some((c) => c.type === 'AUTH_STATUS'));
    assert.ok(calls.some((c) => c.type === 'SYNC_PAGE'));
  } finally {
    restore();
  }
});

test('messages are classified and tagged, newest first', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, restore } = await boot();
  try {
    // Newest first: m1 (1h) before m2 (2h) before m3 (3h).
    assert.deepEqual(rowText(doc), [
      'Registration for Semester II',
      'PS-II station allotment',
      'Run failed: CI on main',
    ]);
    const tags = rows(doc).map((r) => r.querySelector('.tag').textContent);
    assert.equal(tags[0], 'AUGSD');
    assert.equal(tags[1], 'Practice School');
    // Regression: the bare substring 'unsubscribe' used to send every GitHub
    // notification to Ext Promotions.
    assert.equal(tags[2], 'Ext Services', 'GitHub must not be a promotion');
  } finally {
    restore();
  }
});

test('the sidebar shows BOTH unread and total, never unread alone', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THE USER-REPORTED BUG: "only mail that is not read is appearing".
   *
   * Read mail was always in the list — but the rail rendered `unread || total`,
   * so a category with 1 unread and 40 read displayed "1". The rail is what
   * people scan, so it looked as though read mail had not been fetched.
   *
   * The fixture has 3 messages: 2 unread, 1 already read. The read one is in
   * `external-services`, which is precisely the case that used to be
   * indistinguishable — it showed "1" whether that 1 was read or unread.
   */
  const { doc, restore } = await boot();
  try {
    const byCat = {};
    for (const b of doc.querySelectorAll('#cats .cat')) {
      byCat[b.dataset.cat] = countParts(b);
    }

    assert.deepEqual(byCat.all, { unread: '2', total: '3' }, 'two unread out of three total');
    assert.deepEqual(byCat.augsd, { unread: '1', total: '1' });
    assert.deepEqual(byCat.ps, { unread: '1', total: '1' });
    // The read-only category shows a bare total, with no unread emphasis.
    assert.deepEqual(
      byCat['external-services'], { unread: '', total: '1' },
      'a fully-read category shows its total, not nothing'
    );
  } finally {
    restore();
  }
});

test('a category holding only READ mail still reports its messages', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The regression in its starkest form: mail that is entirely read must
  // never make a populated category look empty.
  const allRead = MESSAGES.map((m) => ({ ...m, unread: false, labels: ['INBOX'] }));
  const { doc, restore } = await boot({ messages: allRead });
  try {
    const all = countParts(
      [...doc.querySelectorAll('#cats .cat')].find((b) => b.dataset.cat === 'all')
    );
    assert.deepEqual(
      all, { unread: '', total: String(allRead.length) },
      'all-read inbox must show its total and no unread figure'
    );
    assert.equal(rows(doc).length, allRead.length, 'and every read message must be listed');
  } finally {
    restore();
  }
});

test('the sidebar count carries an explanatory title', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // "2/3" is compact but not self-describing; the tooltip spells it out.
  const { doc, restore } = await boot();
  try {
    const all = [...doc.querySelectorAll('#cats .cat')]
      .find((b) => b.dataset.cat === 'all').lastElementChild;
    assert.match(all.getAttribute('title') || '', /3 messages, 2 unread/);
  } finally {
    restore();
  }
});

test('RADAR: the heading reports how many and how urgent', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * D-6. The radar is the product's most differentiated feature and was
   * presented as a box titled "Due soon" -- the same weight as any other
   * list, so the intelligence read as a filter.
   */
  const { doc, settle, restore } = await boot({ messages: DUE_MESSAGES });
  try {
    await settle(6);
    assert.equal(doc.getElementById('radar').hidden, false, 'the radar should be showing');
    const title = doc.getElementById('radar-title').textContent;
    assert.match(title, /^Due soon · /, `heading did not carry a summary: ${title}`);
    // Something is due today, and nothing is overdue, so "today" is the worst
    // band present and the one worth naming.
    assert.match(title, /today/, `expected the worst band named: ${title}`);
  } finally {
    restore();
  }
});

test('READER: a message with a deadline says so, in the message', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THE DEADLINE WAS EXTRACTED, STORED, CACHED -- AND ONLY EVER SHOWN IN THE
   * SIDEBAR, capped at six items.
   *
   * `extractDeadline` runs on every ingest and writes dueAt/dueKind/dueText
   * onto the message. The radar renders the top six. Message seven has a
   * deadline the product knows about and never mentions -- and the one place
   * the user is certainly looking at that message, the reader, said nothing.
   *
   * This is the product's most differentiated feature being hidden from the
   * surface where it matters most. It must use the SAME vocabulary as the
   * radar (`relativeLabel`, `urgency`), or the same date acquires two
   * different names depending on where you read it.
   */
  const { doc, settle, restore } = await boot({ messages: DUE_MESSAGES });
  try {
    await settle(6);
    rows(doc)[0].click();
    await settle(6);

    const due = doc.getElementById('r-due');
    assert.ok(due, 'the reader needs a deadline surface');
    assert.equal(due.hidden, false, 'this message has a deadline; show it');

    // The same phrasing the radar uses, not a second vocabulary.
    assert.match(
      due.textContent, /due (today|tomorrow|in \d)|overdue/i,
      `expected radar-style wording, got: ${due.textContent}`
    );

    // And it must explain itself, exactly as the radar item does.
    assert.match(
      due.textContent, /Read from|read from/,
      'the deadline must quote the phrase it came from'
    );
  } finally {
    restore();
  }
});

test('DEADLINE: the correction menu opens by stating what is in effect (P-2)', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Round 61 P-2. Extraction and correction stay separate stores — the
   * separation is load-bearing — so the MENU does the reconciliation: it
   * names the effective value, who decided it, and every choice previews its
   * absolute date. The user never infers state; the menu states it.
   */
  const { doc, settle, restore } = await boot({ messages: DUE_MESSAGES });
  try {
    await settle(6);
    rows(doc)[0].click();
    await settle(8);

    const btn = doc.querySelector('#r-actions button[data-act="deadline"]');
    assert.ok(btn, 'the reader offers deadline correction');
    btn.click();
    await settle(4);

    const menu = doc.querySelector('[role="menu"]');
    assert.ok(menu, 'the deadline menu opens');
    assert.match(
      menu.getAttribute('aria-label'),
      /Deadline — currently: extracted — /,
      'the menu states the effective value AND that the extractor decided it'
    );
    const hints = [...menu.querySelectorAll('.sc-when')].map((n) => n.textContent);
    assert.ok(hints.length >= 4, 'every preset previews its outcome');
    assert.ok(hints.slice(0, 4).every((h) => /\d/.test(h)),
      'and every preset preview carries a real date');
  } finally {
    restore();
  }
});

test('READER: a message with no deadline shows no deadline strip', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The counterpart. An always-present empty strip is chrome, and it would
  // push the body down on every message for the benefit of a minority.
  const { doc, settle, restore } = await boot();
  try {
    rows(doc)[0].click();
    await settle(6);
    assert.equal(
      doc.getElementById('r-due').hidden, true,
      'no deadline, no strip'
    );
  } finally {
    restore();
  }
});

test('RADAR: an item shows which phrase the date was read from', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Converts "how did it know that?" into "of course, it read the line".
   * In the title rather than on the surface: the item is already two columns
   * in a narrow rail, and this is the one delight change the audit flagged as
   * at risk of reading as noise.
   */
  const { doc, settle, restore } = await boot({ messages: DUE_MESSAGES });
  try {
    await settle(6);
    const titles = [...doc.querySelectorAll('#radar-list .radar-what')]
      .map((n) => n.getAttribute('title') || '');
    assert.ok(titles.length > 0, 'the radar should have items');
    assert.ok(
      titles.some((t) => /Deadline read from: ".+"/.test(t)),
      `no item explained its deadline: ${JSON.stringify(titles)}`
    );
    // And the phrase quoted must be one that actually appears in the mail,
    // not a restatement of the parsed date.
    const withSource = titles.find((t) => t.includes('Deadline read from'));
    const quoted = withSource.match(/Deadline read from: "(.+)"/)[1];
    const bodies = DUE_MESSAGES.map((m) => m.snippet.toLowerCase()).join(' ');
    assert.ok(
      bodies.includes(quoted.toLowerCase()),
      `quoted "${quoted}" does not appear in the mail it came from`
    );
  } finally {
    restore();
  }
});

test('RADAR: a warm cache start still finds the deadlines', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The cache stores eleven positional fields and `dueAt` is not one of them,
   * so cached messages go into the store via `store.upsert` WITHOUT passing
   * through `ingest` -- which is the only place `extractDeadline` runs.
   *
   * The radar therefore reads whatever the cache path left behind. This test
   * pins the behaviour that matters to the user: open the app with a warm
   * cache, and the deadlines you could see yesterday are still there.
   */
  const { doc, settle, restore } = await boot({
    messages: DUE_MESSAGES,
    storageSeed: { msgCache: cacheBlob(DUE_MESSAGES), historyId: '12345' },
  });
  try {
    await settle(10);
    assert.equal(
      doc.getElementById('radar').hidden, false,
      'a warm start lost every deadline'
    );
    assert.ok(
      doc.querySelectorAll('#radar-list .radar-item').length > 0,
      'the radar is visible but empty'
    );
  } finally {
    restore();
  }
});

test('CACHE: has:attachment still works after a warm start', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THE SAME ROOT CAUSE AS THE RADAR BUG, second victim.
   *
   * `pack()` does not store `hasAttachment` either, so on a warm start every
   * cached message looks attachment-less and `has:attachment` returns nothing
   * -- a search operator that silently answers "no" for the entire cache.
   *
   * Unlike the deadline this CANNOT be re-derived: the flag comes from the
   * Gmail payload, not from the subject or snippet. So the honest fix is to
   * cache it, which is what the packed flags byte now carries.
   */
  const withAtt = MESSAGES.map((m, i) => ({ ...m, hasAttachment: i === 0 }));
  const { doc, win, settle, restore } = await boot({
    messages: withAtt,
    storageSeed: { msgCache: cacheBlob(withAtt), historyId: '12345' },
  });
  try {
    await settle(10);
    const search = doc.getElementById('search');
    search.value = 'has:attachment';
    search.dispatchEvent(new win.Event('input'));
    await settle(8);

    assert.equal(
      rows(doc).length, 1,
      'a warm start lost the attachment flag, so has:attachment found nothing'
    );
  } finally {
    restore();
  }
});

test('EMPTY: clearing the last message reads differently from arriving empty', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * D-10. Archiving the last message and opening a mailbox that was already
   * empty produced the identical screen. The first is an achievement; the
   * second is a description. They must not share a sentence.
   */
  const one = [MESSAGES[0]];
  const { doc, win, settle, restore } = await boot({ messages: one });
  try {
    assert.equal(rows(doc).length, 1);
    // Archive it with the keyboard, the way the shortcut users do.
    doc.querySelector('#list .row').click();
    await settle(4);
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    // The row animates out, so it lingers in the DOM after the store drops it.
    assert.equal((await settled(doc, settle)).length, 0, 'the row should be gone');
    const title = doc.getElementById('empty-title').textContent;
    assert.equal(title, 'That was the last one', `achieved-empty said: ${title}`);
    assert.ok(
      doc.getElementById('empty-action').hidden,
      'there is nothing left to do, so offer no button'
    );
  } finally {
    restore();
  }
});

test('EMPTY: a mailbox that was always empty is merely described', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The control for the test above: with no action taken, the wording must
  // stay descriptive. Without this, "That was the last one" could greet a
  // brand-new user who has never archived anything.
  const { doc, restore } = await boot({ messages: [] });
  try {
    const title = doc.getElementById('empty-title').textContent;
    assert.notEqual(title, 'That was the last one', 'nothing was achieved here');
    assert.equal(title, 'Inbox empty');
  } finally {
    restore();
  }
});

test('EMPTY: switching to an empty mailbox is not an achievement', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * THE CASE THAT BROKE THE FIRST IMPLEMENTATION.
   *
   * "Achieved" was detected as "an id we were rendering is no longer in the
   * store". On a mailbox switch that is trivially true for every row -- the
   * inbox ids are absent from the Sent store because they were never in it.
   * So opening an empty Sent congratulated you for clearing an inbox you had
   * not touched. The detector must be scoped to one view.
   */
  // Inbox has mail; the sync stub returns nothing for any other label, so
  // Sent is genuinely empty and the switch crosses from populated to empty.
  const { doc, settle, restore } = await boot({
    perLabel: true,
    messages: MESSAGES,
    emptyLabels: ['SENT'],
  });
  try {
    doc.querySelector('.cat[data-mailbox="sent"]').click();
    await settled(doc, settle);

    assert.equal(rows(doc).length, 0);
    assert.notEqual(
      doc.getElementById('empty-title').textContent, 'That was the last one',
      'switching mailboxes is not clearing one'
    );
  } finally {
    restore();
  }
});

test('FRESHNESS: the app says when it last heard from Gmail', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * D-9. Nothing is wrong when the line is absent -- the user simply has no
   * way to know it is right. After a successful boot the sync is seconds old,
   * so the line must read "just now" rather than "0 min ago".
   */
  const { doc, restore } = await boot();
  try {
    const f = doc.getElementById('freshness');
    assert.ok(f, 'the freshness line must exist');
    assert.match(f.textContent, /^Updated just now$/, 'a fresh boot is "just now"');
    assert.equal(f.getAttribute('aria-live'), 'polite');
  } finally {
    restore();
  }
});

test('FRESHNESS: a signed-out app claims no freshness at all', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // An empty line, not "Updated ... ago": we have never spoken to Gmail, and
  // saying otherwise is the one thing this feature must never do.
  const { doc, restore } = await boot({ signedIn: false });
  try {
    assert.equal(doc.getElementById('freshness').textContent, '');
  } finally {
    restore();
  }
});

test('FRESHNESS: signing out clears the timestamp', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Freshness belongs to a session. Carrying it across sign-out would tell
  // the next account that we had already synced on their behalf.
  const { doc, settle, restore } = await boot();
  try {
    assert.notEqual(doc.getElementById('freshness').textContent, '');
    doc.getElementById('btn-signout').click();
    await settle(12);
    assert.equal(
      doc.getElementById('freshness').textContent, '',
      'the previous session\'s freshness survived sign-out'
    );
  } finally {
    restore();
  }
});

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

