/**
 * System mailbox tests.
 *
 * The subtle risks here are (a) a non-inbox sync advancing the account-wide
 * history cursor and silently losing inbox mail, and (b) dead controls
 * appearing in mailboxes where they cannot work.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  MAILBOXES, DEFAULT_MAILBOX, getMailbox, isMailbox, showsCategories, actionsFor,
} = await import('../src/app/mailboxes.js');

const app = readFileSync(new URL('../src/app/app.js', import.meta.url), 'utf8');
const sync = readFileSync(new URL('../src/background/sync.js', import.meta.url), 'utf8');
const bg = readFileSync(new URL('../src/background/index.js', import.meta.url), 'utf8');

// ------------------------------------------------------------- definition ---

test('the mailboxes a user actually looks for all exist', () => {
  const ids = MAILBOXES.map((m) => m.id);
  for (const want of ['inbox', 'sent', 'drafts', 'spam', 'trash', 'snoozed', 'starred']) {
    assert.ok(ids.includes(want), `missing mailbox: ${want}`);
  }
});

test('inbox is the default and is the only classified mailbox', () => {
  assert.equal(DEFAULT_MAILBOX, 'inbox');
  assert.ok(showsCategories('inbox'));
  for (const id of ['sent', 'drafts', 'spam', 'trash', 'snoozed', 'starred']) {
    assert.equal(
      showsCategories(id), false,
      `${id} must not run the BITS classifier: bucketing your own sent mail by recipient is noise`
    );
  }
});

test('every mailbox has label ids and empty-state copy', () => {
  for (const mb of MAILBOXES) {
    assert.ok(mb.labelIds?.length, `${mb.id} has no labelIds`);
    assert.ok(mb.empty, `${mb.id} has no empty state`);
    assert.ok(mb.label, `${mb.id} has no display label`);
  }
});

test('the empty state of each mailbox talks about that mailbox', () => {
  // "Inbox empty" while looking at Trash reads as a bug.
  assert.match(getMailbox('trash').empty, /Trash|30 days/i);
  assert.match(getMailbox('sent').empty, /sent/i);
  assert.match(getMailbox('snoozed').empty, /snooz/i);
});

test('an unknown mailbox falls back to the inbox rather than breaking', () => {
  assert.equal(getMailbox('nonsense').id, 'inbox');
  assert.equal(getMailbox(undefined).id, 'inbox');
  assert.equal(isMailbox('nonsense'), false);
});

test('the snoozed mailbox is addressed by NAME, the rest by id', () => {
  // Our own label has no stable Gmail id; Gmail's system labels do.
  assert.ok(getMailbox('snoozed').byLabelName);
  for (const id of ['inbox', 'sent', 'trash', 'spam', 'drafts']) {
    assert.ok(!getMailbox(id).byLabelName, `${id} should use a system label id`);
  }
});

// ----------------------------------------------------------------- actions ---

test('trash offers no archive and no delete', () => {
  // Archiving something already deleted does nothing; deleting it again is a
  // control that lies about what it will do.
  const a = actionsFor('trash');
  assert.equal(a.archive, false);
  assert.equal(a.trash, false);
  assert.ok(a.restore, 'trash needs a way back out');
});

test('spam offers a way to say "not spam"', () => {
  assert.ok(actionsFor('spam').notSpam);
  assert.equal(actionsFor('spam').archive, false);
});

test('sent and drafts cannot be archived', () => {
  assert.equal(actionsFor('sent').archive, false);
  assert.equal(actionsFor('drafts').archive, false);
});

test('only the inbox offers snooze', () => {
  assert.ok(actionsFor('inbox').snooze);
  for (const id of ['sent', 'trash', 'spam', 'drafts', 'snoozed']) {
    assert.equal(actionsFor(id).snooze, false, `${id} should not offer snooze`);
  }
});

test('the snoozed mailbox offers unsnooze', () => {
  assert.ok(actionsFor('snoozed').unsnooze);
});

// ------------------------------------------------------- the cursor hazard ---

/*
 * THE LOAD-BEARING TEST.
 *
 * `historyId` is a single account-wide cursor that the inbox delta sync
 * depends on. If loading a page of Sent advances it, inbox changes that were
 * never fetched are skipped and are unrecoverable until the cursor expires
 * about a week later. This is the same class of bug already fixed once in
 * sync.js, reachable through a different door.
 */
test('only the inbox may advance the history cursor', () => {
  assert.match(sync, /anchorHistory = true/, 'syncPage must accept an opt-out');
  assert.match(
    sync, /if \(anchorHistory && !pageToken\)/,
    'the cursor read must be gated on anchorHistory'
  );
});

test('the app passes anchorHistory=false for non-inbox mailboxes', () => {
  assert.match(app, /anchorHistory: id === 'inbox'/);
});

test('delta refresh never runs while a non-inbox mailbox is showing', () => {
  // The delta handler reconciles against the inbox store; running it while
  // Sent is open would apply inbox changes to the wrong collection.
  const fn = app.slice(app.indexOf('async function refresh('));
  assert.ok(
    fn.slice(0, 900).includes("state.mailbox !== 'inbox'"),
    'refresh must branch on the active mailbox'
  );
});

// ----------------------------------------------------------------- wiring ---

test('each mailbox gets its own store', () => {
  // One store filtered by label would pollute inbox search with sent mail.
  assert.match(app, /const stores = new Map/);
  assert.match(app, /function storeFor\(/);
});

test('only the inbox is written to the warm-start cache', () => {
  // Caching every mailbox would multiply the 10MB budget across views the
  // user rarely opens cold.
  assert.match(app, /if \(id === 'inbox'\) s\.subscribe\(\(\) => saver\.schedule\(\)\)/);
});

test('a background mailbox load does not repaint the active one', () => {
  // The guard is the `stores.get(...) === s` check; the argument now carries
  // the store's change detail so the per-id fast path is reachable.
  assert.match(app, /if \(stores\.get\(state\.mailbox\) === s\) scheduleRender\(detail\)/);
});

test('the category rail is hidden where categories are meaningless', () => {
  assert.match(app, /catGroup\.hidden = !showsCategories\(id\)/);
});

test('switching mailbox clears the search box as well as the query', () => {
  // A stale query silently double-filters and the user cannot see why.
  const fn = app.slice(app.indexOf('async function selectMailbox'));
  const body = fn.slice(0, 1200);
  assert.ok(body.includes("state.query = ''"));
  assert.ok(body.includes("el.search.value = ''"));
});

test('switching mailbox resets category to all', () => {
  const fn = app.slice(app.indexOf('async function selectMailbox'));
  assert.ok(fn.slice(0, 1200).includes("state.category = 'all'"));
});

test('the background resolves a label name before listing', () => {
  assert.match(bg, /opts\.labelName/);
  assert.match(bg, /ensureLabel\(opts\.labelName\)/);
});

test('a missing snoozed label yields an empty page, not an error', () => {
  // The label not existing simply means nothing was ever snoozed.
  const fn = bg.slice(bg.indexOf("case 'SYNC_PAGE'"));
  assert.ok(fn.slice(0, 700).includes('return { messages: [], nextPageToken: \'\' }'));
});

test('the rail is still exactly one tab stop across both groups', () => {
  // Two groups must not mean two tab stops; that was the regression.
  assert.match(app, /const preferred =/);
  assert.match(app, /b\.tabIndex = b === preferred \? 0 : -1/);
});

test('sidebar iteration does not read children directly', () => {
  // The buttons are grandchildren now. Reading `children` returned the two
  // wrapper divs and silently did nothing.
  assert.ok(
    !/for \(const b of el\.cats\.children\)/.test(app),
    'el.cats.children no longer contains the buttons'
  );
});

test('prune runs only when the store holds the WHOLE mailbox (V2 P2-22)', () => {
  // The sweep deletes overrides/mutes/follow-ups for threads the store no
  // longer holds. That is correct ONLY when the store is complete. Against a
  // partial store (first page of a 3000-message inbox) it would delete state
  // for mail that is simply not loaded yet. The guard has four parts and
  // every one is load-bearing.
  const at = app.indexOf('pruneAfterFullSync()');
  assert.notEqual(at, -1, 'the sweep must actually be called');
  const gate = app.slice(Math.max(0, at - 220), at);
  assert.ok(gate.includes("!pageToken"), 'not mid-pagination');
  assert.ok(gate.includes("!nextPageToken"), 'no further pages waiting');
  assert.ok(gate.includes("!store.isFull"), 'store never hit its cap');
  assert.ok(gate.includes("id === 'inbox'"), 'only the classified mailbox');
});

test('leaving the inbox drops the server-search overlay (bug-hunt #26)', () => {
  // The overlay belongs to the query. selectMailbox clears the query but used
  // to leave the overlay alive, so stale INBOX hits merged into the next
  // mailbox's search (scheduleServerSearch returns early outside the inbox and
  // never clears). The clear must sit inside selectMailbox itself.
  const at = app.indexOf('function selectMailbox');
  assert.notEqual(at, -1);
  const body = app.slice(at, app.indexOf('\n}', at));
  assert.ok(body.includes('clearSearchOverlay()'),
    'a mailbox switch must drop the previous query\'s overlay');
});

test('server search never serves Trash or Spam into the inbox (bug-hunt #6)', () => {
  const ss = readFileSync(new URL('../src/app/server-search.js', import.meta.url), 'utf8');
  assert.match(ss, /-in:trash -in:spam/,
    'the supplement query must exclude trash and spam');
});

test('the background sync sweep cannot reject the alarm handler (bug-hunt #27)', () => {
  assert.match(bg, /backgroundSync\(\)\.catch\(\(\) => \{\}\)/,
    'a throw inside the sweep must not surface as an unhandled worker rejection');
});

test('the outbox pump dispatches through the worker, never per-item from the app (bug-hunt P1)', () => {
  // Two tabs flushing for themselves raced a non-atomic storage claim, and the
  // prize was a duplicated email. The contract: the app ASKS the worker to
  // pump; it does not dispatch items itself. A revert to flushOutbox+SEND
  // reintroduces the race, so the wiring is pinned, not implied.
  const at = app.indexOf('function pumpOutbox');
  assert.notEqual(at, -1);
  const body = app.slice(at, at + 1200);
  assert.ok(body.includes("send('OUTBOX_PUMP')"),
    'the pump goes through the single worker owner');
  assert.ok(!body.includes('flushOutbox'),
    'the app must not run the dispatch loop itself on this path');
});

test('worker recovery removes the degradation banner (bug-hunt 43 #25)', () => {
  // The banner is a claim about the present; recovery makes it false. The
  // probe's success path must remove it, or the UI says "unavailable" while
  // the toast says "recovered".
  const at = app.indexOf('function scheduleWorkerProbe');
  assert.notEqual(at, -1);
  const fn = app.slice(at, at + 1200);
  assert.ok(fn.includes("document.getElementById('sw-warn')?.remove()"),
    'recovery must take the banner down with the state it describes');
});

test('a degraded session always arms its own recovery probes (audit 42 B10)', () => {
  // A cold start whose FIRST verb fails is still a degrade event, and every
  // degrade must arm the probe chain -- 5s timer plus an online listener --
  // or the session latches into fallback forever. Pin the wiring so a future
  // cleanup cannot quietly drop either arm.
  const at = app.indexOf('function degradeToFallback');
  assert.notEqual(at, -1);
  const degrade = app.slice(at, at + 800);
  assert.ok(degrade.includes('scheduleWorkerProbe()'),
    'every degrade arms recovery');

  const pt = app.indexOf('function scheduleWorkerProbe');
  const probe = app.slice(pt, pt + 1400);
  assert.match(probe, /addEventListener\('online'/, 'recovery also rides the online event');
  assert.match(probe, /setTimeout\(check, 5000\)/, 'and re-probes on a short timer');
});
