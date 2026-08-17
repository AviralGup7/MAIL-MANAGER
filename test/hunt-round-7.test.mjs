/**
 * Bug hunt, round 7 (2026-08-17) — the SERVICE WORKER, and the stores the
 * last round did not reach.
 *
 * The headline finding came from an external audit and it was right: round
 * 6's duplicate-send fix protected the in-page fallback runner and left the
 * SERVICE WORKER — the normal production path — exposed. The worker has its
 * own pump, reimplementing the same sequence, and it never consulted the
 * ledger.
 *
 * The lesson generalises, and these tests are written to enforce it: when
 * two code paths do one job, fixing one of them is not fixing the bug.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as ob from '../src/features/outbox/model.js';
import { parseQuery } from '../src/app/search/query.js';
import { createSaver } from '../src/app/system/cache.js';
import * as views from '../src/app/system/view-store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = (p) => readFileSync(join(ROOT, p), 'utf8');
/** Source with comments stripped — a gate must read code, not prose. */
const code = (p) => raw(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function fakeStorage(initial = {}, opts = {}) {
  const db = { ...initial };
  return {
    db,
    async get(k) {
      if (opts.failGet) throw new Error('storage unavailable');
      return typeof k === 'string' ? { [k]: db[k] }
        : Object.fromEntries((k || []).map((x) => [x, db[x]]));
    },
    async set(o) { if (opts.failSet) throw new Error('QUOTA_BYTES'); Object.assign(db, o); },
    async remove(k) { delete db[k]; },
  };
}

/* ========================================================================
 * W-1 · the duplicate send survived in the worker
 * ==================================================================== */

test('W-1: the delivery ledger is a shared seam, not a per-pump copy', () => {
  /*
   * THE STRUCTURAL GATE. Round 6 added `delivered` inside the outbox model
   * and wired it into `flushOutbox` only; the worker's OUTBOX_PUMP kept its
   * own send/remove/save loop and re-sent mail Gmail had already accepted.
   *
   * MEASURED by replaying the worker's own sequence with writes failing:
   *   pump 1 sent=1, gmail calls=1, queue still holds 1
   *   pump 2 sent=1  ->  TOTAL GMAIL SENDS: 2
   *
   * So the ledger is exported and BOTH pumps use it. This asserts the
   * worker actually calls it — the thing that was missing.
   */
  assert.equal(typeof ob.markDelivered, 'function');
  assert.equal(typeof ob.wasDelivered, 'function');

  const worker = code('src/background/index.js');
  assert.match(worker, /markDelivered\(item\.id\)/,
    'the worker pump must record a delivery it has made');
  assert.match(worker, /wasDelivered/,
    'and must consult the ledger before dispatching');
  /*
   * SCOPED TO THE SUCCESS BRANCH. My first version compared against the
   * first `items.filter(...)` in the file, which is the CANCEL-RACE guard
   * near the top of the loop — a different statement that legitimately runs
   * before any send. The gate reported a real ordering as broken.
   */
  const success = worker.slice(worker.indexOf('await sendMessage('));
  const mark = success.indexOf('markDelivered(item.id)');
  const remove = success.indexOf('items.filter((x) => x.id !== item.id)');
  assert.ok(mark !== -1 && remove !== -1 && mark < remove,
    'the delivery is recorded BEFORE the removal that may fail to persist');
});

test('W-1: the worker reads the save result instead of discarding it', () => {
  const worker = code('src/background/index.js');
  assert.match(worker, /const persisted = await saveOutbox\(items, chrome\.storage\.local\);/,
    'saveOutbox returns false on failure; ignoring it is what stranded the row');
  assert.match(worker, /if \(!persisted && wasDelivered\(item\.id\)\) unreconciled\.push/,
    'a delivered-but-unrecorded item must be reported, not called a clean success');
});

test('W-1: an already-delivered item is never dispatchable again', async () => {
  const item = ob.enqueue({ to: 'a@x.z', subject: 's', body: 'b' }, { holdMs: 0, now: 1000 });
  ob._resetOutbox();
  assert.equal(ob.dispatchable(item, undefined), true);
  ob.markDelivered(item.id);
  assert.equal(ob.wasDelivered(item.id), true);
  assert.equal(ob.dispatchable(item, undefined), false,
    'the ledger must veto dispatch no matter what the queue still says');
  ob._resetOutbox();
  assert.equal(ob.wasDelivered(item.id), false, 'and the seam must clear it');
});

/* ========================================================================
 * W-2 · the account could change mid-pump
 * ==================================================================== */

test('W-2: the pump re-checks the session epoch before every send', () => {
  /*
   * Ownership was decided once and then up to 8 network sends ran beneath
   * that decision. A switch part-way through leaves getToken() issuing the
   * NEW account's credential while items are dispatched under the OLD
   * account's eligibility check — account A's draft leaving from B.
   */
  const worker = code('src/background/index.js');
  assert.match(worker, /const startEpoch = authEpoch\(\);/, 'the epoch is captured at pump start');
  assert.match(worker, /if \(authEpoch\(\) !== startEpoch\) \{/, 'and re-checked inside the loop');

  const loop = worker.slice(worker.indexOf('for (const item of due)'));
  const recheck = loop.indexOf('authEpoch() !== startEpoch');
  const send = loop.indexOf('await sendMessage(');
  assert.ok(recheck !== -1 && send !== -1 && recheck < send,
    'the re-check must precede the irreversible act, not follow it');
});

test('W-2: auth exposes the epoch rather than the pump inventing its own', () => {
  /*
   * The hazard already had a mechanism — sessionEpoch — which signOut and
   * the ACCOUNT_CHANGED tripwire both bump. It simply was not readable from
   * the worker. A second, parallel notion of "has the account moved" would
   * be a new thing to keep in sync.
   */
  const auth = code('src/background/auth.js');
  assert.match(auth, /export function authEpoch\(\)/);
  assert.match(auth, /return sessionEpoch;/);
  assert.equal((auth.match(/sessionEpoch\+\+/g) || []).length, 2,
    'sign-in and sign-out both bump the generation');
});

/* ========================================================================
 * W-3 · the pump lock expired during its own batch
 * ==================================================================== */

test('W-3: the lock is renewed per dispatch, as its comment always claimed', () => {
  /*
   * CLAIM_TTL is 180s. The worker batches MAX_PUMP_BATCH = 8 items, each
   * with a 30s fetch budget: 8 x 30 = 240s > 180s. A slow batch outlived
   * its own lock and a second tab could acquire it — exactly the state the
   * lock exists to prevent. The comment said "renewed per dispatch"; no
   * renewal existed. The number was never the fix.
   */
  const model = code('src/features/outbox/model.js');
  assert.match(model, /async function renewPumpLock\(/);
  assert.match(model, /async function renewClaim\(/);
  assert.match(model, /if \(!\(await renewPumpLock\(storage, Date\.now\(\)\)\)\) \{/,
    'the renewal result must be acted on, not fired and forgotten');

  const loop = model.slice(model.indexOf('for (const item of due)'));
  const renew = loop.indexOf('renewPumpLock');
  const send = loop.indexOf('await send(item.draft)');
  assert.ok(renew !== -1 && send !== -1 && renew < send,
    'renew before dispatching, so the TTL bounds the gap between sends');

  // Losing the lock must stop the pump, not merely be noted.
  assert.match(loop.slice(renew, renew + 260), /break;/,
    'a tab that has lost the lock must stand down');
});

/* ========================================================================
 * W-4 · my own rollback from last round was dead code
 * ==================================================================== */

test('W-4: loadMailboxPage reports its outcome, so the rollback can run', () => {
  /*
   * I added a try/catch around loadMailboxPage last round to restore a
   * snapshot on a failed non-inbox refresh. It could never fire: the
   * function catches internally and resolves normally. The bug — clear the
   * store, fail the fetch, show an empty Sent under a "Refreshed" toast —
   * was still live behind a fix that merely looked right.
   */
  const main = code('src/app/main.js');
  const fn = main.slice(main.indexOf('async function loadMailboxPage'));
  const body = fn.slice(0, fn.indexOf('async function pruneAfterFullSync'));

  assert.match(body, /return true;/, 'a successful load must say so');
  assert.match(body, /reportError\(err[\s\S]*?return false;/,
    'and a caught error must be reported to the caller, not only to the user');

  const refresh = main.slice(main.indexOf("if (state.mailbox !== 'inbox') {"), main.indexOf("if (state.mailbox !== 'inbox') {") + 1800);
  assert.match(refresh, /const ok = await loadMailboxPage\(id, ''\);/);
  assert.match(refresh, /if \(!ok\) \{/, 'the outcome must gate the restore');
  assert.ok(!/try \{\s*await loadMailboxPage/.test(refresh),
    'the unreachable try/catch must be gone, not left beside the working check');
});

/* ========================================================================
 * W-5 · the cache said "durable" while still writing
 * ==================================================================== */

test('W-5: flush() waits for a write that is already in flight', async () => {
  /*
   * `write()` sets pending=false and THEN awaits saveCache, so in that
   * window flush() returned an already-resolved promise. main.js flushes
   * the cache before committing the history cursor; a cursor committed over
   * an unfinished write means the next delta starts after changes that
   * never reached disk, and Gmail's history is the only copy.
   */
  let release;
  let finished = false;
  const storage = {
    async set() {
      await new Promise((r) => { release = r; });
      finished = true;
      return true;
    },
    async get() { return {}; },
    async remove() {},
  };
  const saver = createSaver(() => [{ id: 'm1', date: 1 }], storage, { idleTimeout: 1, minIntervalMs: 0 });
  saver.schedule();
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(saver.isPending, false, 'the write cleared `pending` before awaiting — that is the trap');
  assert.equal(saver.isWriting, true, 'but a write really is in flight');

  let flushed = false;
  const f = saver.flush().then(() => { flushed = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(flushed, false, 'flush must not resolve over a live write');

  release();
  await f;
  assert.equal(finished, true);
  assert.equal(flushed, true);
});

/* ========================================================================
 * W-6 · saved views could be destroyed by a transient read failure
 * ==================================================================== */

test('W-6: a failed read never lets saved views be overwritten', async () => {
  const existing = {
    savedViews: { views: [{ id: 'sv-1', name: 'Thesis', query: 'label:thesis', icon: 'search' }], hidden: [] },
  };
  const s = fakeStorage(existing, { failGet: true });

  const res = await views.saveView('Another', 'from:prof', s);
  assert.equal(res.ok, false, 'a mutation on an unknown base must refuse');
  assert.match(res.error, /unavailable/i, 'and say why');
  assert.equal(s.db.savedViews.views.length, 1, 'the real view must survive');
});

test('W-6: removing a view is refused when the base cannot be read', async () => {
  const s = fakeStorage({ savedViews: { views: [{ id: 'sv-1', name: 'A', query: 'x', icon: 'search' }], hidden: [] } }, { failGet: true });
  const res = await views.removeView('sv-1', s);
  assert.equal(res.ok, false);
  assert.equal(s.db.savedViews.views.length, 1);
});

test('W-6: the reader still degrades gracefully — only mutation is strict', async () => {
  /*
   * `loadViews` must keep returning the built-ins when storage is down: a
   * sidebar with no views is a worse answer than a sidebar with the
   * defaults, and a reader cannot destroy anything. The strictness belongs
   * on the write path alone.
   */
  const got = await views.loadViews(fakeStorage({}, { failGet: true }));
  assert.ok(Array.isArray(got) && got.length > 0, 'built-ins still render');
});

/* ========================================================================
 * W-7 · the UI reported success over a failed save
 * ==================================================================== */

test('W-7: follow-up and deadline toasts are gated on the save result', () => {
  const main = code('src/app/main.js');

  assert.match(main, /const saved = await followups\.saveFollowups\(followupList\);/,
    'the boolean must be captured');
  assert.match(main, /toast\(saved[\s\S]{0,200}Could not save that reminder/,
    'and a failed write must not say "Will remind you"');

  assert.match(main, /const saved = await deadlineStore\.saveOverrides\(deadlineOverrides\);/);
  assert.match(main, /if \(!saved\) toast\('Could not save that change/,
    'a corrected deadline that did not persist must not report "Deadline set"');

  // The activity log must not record a clean success either.
  assert.match(main, /outcome: 'failed'/,
    'a failed persist is recorded as such, so the log stays trustworthy');
});

/* ========================================================================
 * W-9 · to:me matched every message
 * ==================================================================== */

test('W-9: to:me matches actual recipients, not everything', () => {
  /*
   * `if (value === 'me') return () => true;` was a placeholder, but a
   * predicate that matches everything is a wrong answer, not a deferred
   * feature. This parser also compiles RULES, so `to:me -> archive`
   * validated, previewed, and would have archived the entire mailbox.
   */
  const ME = 'f20240294@pilani.bits-pilani.ac.in';
  const msgs = [
    { id: 'a', to: 'someone@example.com', cc: 'other@example.com', from: 'z@y.z', subject: '', snippet: '' },
    { id: 'b', to: ME, cc: '', from: 'z@y.z', subject: '', snippet: '' },
    { id: 'c', to: 'x@y.z', cc: `Me <${'f20240294+jobs@pilani.bits-pilani.ac.in'}>`, from: 'z@y.z', subject: '', snippet: '' },
  ];
  const p = parseQuery('to:me', Date.now(), { selfEmail: ME });
  const hit = msgs.filter((m) => p.predicate(m)).map((m) => m.id);
  assert.deepEqual(hit, ['b', 'c'], 'plus-addressing folds; strangers do not match');
  assert.ok(!hit.includes('a'), 'THE BUG: every message matched');
});

test('W-9: without a proved identity, to:me fails CLOSED', () => {
  /*
   * The honest answer with no identity is "match nothing" — an empty result
   * the user can see and question. "Match everything" is a silent catch-all
   * that an archive rule would act on.
   */
  const p = parseQuery('to:me', Date.now(), {});
  const m = { id: 'a', to: 'anyone@x.z', cc: '', from: 'z@y.z', subject: '', snippet: '' };
  assert.equal(p.predicate(m), false);
});

test('W-9: the app supplies the identity through the existing ctx seam', () => {
  const list = code('src/app/mail/list.js');
  assert.match(list, /selfEmail: state\.selfEmail/,
    'the search path must pass identity, or to:me silently matches nothing');
});

/* ========================================================================
 * W-14 / W-15 · the snooze alarm and the wake sweep
 * ==================================================================== */

test('W-14: a failed read must not clear the only wake alarm', () => {
  /*
   * loadSnoozed answers {} when storage throws, nextWakeAt({}) is null, and
   * scheduleWake then called alarms.clear(). The snoozes were still on disk
   * and still labelled in Gmail — only the READ had failed. With the alarm
   * cleared nothing re-arms until some other event calls scheduleWake, so
   * the wake can be deferred indefinitely.
   */
  const worker = code('src/background/index.js');
  const fn = worker.slice(worker.indexOf('async function scheduleWake'));
  const body = fn.slice(0, fn.indexOf('\n}'));

  assert.match(body, /readSnoozed\(chrome\.storage\.local\)/, 'the three-state read is used');
  assert.match(body, /reason === 'unavailable'\) return;/,
    'an unreadable schedule must leave the existing alarm alone');
  assert.ok(
    body.indexOf("reason === 'unavailable'") < body.indexOf('alarms.clear'),
    'the guard must come before the clear, or it guards nothing'
  );
});

test('W-15: a wake is counted only when the local entry really went', () => {
  /*
   * Gmail's modify succeeded and removeSnooze failed, yet the sweep counted
   * a success — so the entry stayed due and the same message woke again on
   * every sweep, forever, while the Snoozed view listed something already
   * back in the inbox.
   */
  const worker = code('src/background/index.js');
  const fn = worker.slice(worker.indexOf('async function wakeDue'));
  const body = fn.slice(0, fn.indexOf('async function scheduleWake'));

  assert.match(body, /const after = await removeSnooze\(id, chrome\.storage\.local\);/);
  assert.match(body, /if \(after && id in after\) \{/,
    'the entry\'s absence is the proof the wake completed');
  assert.ok(
    body.indexOf('if (after && id in after)') < body.indexOf('woke++'),
    'the check must gate the counter, not follow it'
  );
});
