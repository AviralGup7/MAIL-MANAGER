/**
 * Outbox tests.
 *
 * THE UNFORGIVABLE FAILURE IS A DOUBLE SEND. A message that fails to send can
 * be retried; a message sent twice cannot be recalled. Several tests here
 * exist only to pin that down.
 *
 * The second is silent loss: a queued message that no code path will ever pick
 * up again is worse than an error, because the user believes it is pending.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStorage } from './helpers/storage.mjs';

const {
  enqueue, dueItems, nextWakeIn, canUndo, markFailed, markUncertain, isStuck, statusOf,
  flushOutbox, cancel, retryNow, loadOutbox, saveOutbox, clearOutbox, normaliseOutbox,
  dispatchable,
  _resetOutbox, isDispatching, DEFAULT_HOLD_MS, MAX_ATTEMPTS, BACKOFF_MS,
  prioritizeDue,
} = await import('../src/features/outbox/model.js');

const NOW = 1_700_000_000_000;
const draft = { to: 'prof@bits.ac.in', subject: 'Hi', body: 'text' };

test.beforeEach(() => _resetOutbox());

// ------------------------------------------------------------- undo window --

test('a queued message is HELD, not sent', () => {
  const it = enqueue(draft, { now: NOW });
  assert.equal(it.state, 'held');
  assert.equal(it.releaseAt, NOW + DEFAULT_HOLD_MS);
});

test('a held message is not due until its hold expires', () => {
  const it = enqueue(draft, { now: NOW });
  assert.deepEqual(dueItems([it], NOW + 1000), []);
  assert.equal(dueItems([it], NOW + DEFAULT_HOLD_MS).length, 1);
});

test('undo is possible during the hold and impossible after', () => {
  const it = enqueue(draft, { now: NOW });
  assert.equal(canUndo(it, NOW + 1000), true);
  assert.equal(canUndo(it, NOW + DEFAULT_HOLD_MS + 1), false);
});

test('a zero hold sends immediately, for users who turn undo-send off', () => {
  const it = enqueue(draft, { now: NOW, holdMs: 0 });
  assert.equal(dueItems([it], NOW).length, 1);
  assert.equal(canUndo(it, NOW), false);
});

test('undo removes the message and it is never dispatched', async () => {
  const s = fakeStorage();
  const it = enqueue(draft, { now: NOW });
  await saveOutbox([it], s);
  assert.ok(await cancel(it.id, s));

  let calls = 0;
  await flushOutbox({ send: async () => { calls++; }, storage: s, now: NOW + 60_000 });
  assert.equal(calls, 0, 'a cancelled message must never be sent');
  assert.deepEqual(await loadOutbox(s), []);
});

test('A MESSAGE ON THE WIRE CANNOT BE CANCELLED', async () => {
  /*
   * This test found a real bug rather than confirming a design.
   *
   * The guard was originally written against the PERSISTED state
   * (`item.state === 'sending'`). But `cancel` reloads through
   * `normaliseOutbox`, which demotes a stored `sending` to `failed` so a
   * crashed dispatch is not orphaned -- so the guard could never fire. It was
   * unreachable, and a message could be pulled out of the queue while its
   * request was still in flight.
   *
   * Liveness is now tracked in memory for the current session. This test races
   * a cancel against a slow send to prove it.
   */
  const s = fakeStorage();
  await saveOutbox([enqueue(draft, { now: NOW, holdMs: 0 })], s);
  const [queued] = await loadOutbox(s);

  let released;
  const gate = new Promise((r) => { released = r; });
  const flushing = flushOutbox({
    send: async () => { await gate; },
    storage: s,
    now: NOW,
    // Single-tab test: no cross-tab claimant to settle against, and the wait
    // below is the race under test, not a lock settle.
    settleMs: 0,
  });

  // Let the flush claim the item and reach the await.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(isDispatching(queued.id), true, 'precondition: it is on the wire');
  assert.equal(await cancel(queued.id, s), null, 'cancel refused');

  released();
  await flushing;
  assert.equal(isDispatching(queued.id), false, 'the flag clears afterwards');
});

// ---------------------------------------------------------------- sending --

test('a successful send removes the item from the queue', async () => {
  const s = fakeStorage();
  await saveOutbox([enqueue(draft, { now: NOW, holdMs: 0 })], s);
  const out = await flushOutbox({ send: async () => ({ ok: true }), storage: s, now: NOW });
  assert.equal(out.sent, 1);
  assert.deepEqual(await loadOutbox(s), []);
});

test('A FAILED SEND KEEPS THE MESSAGE', async () => {
  // The bug this module exists to fix: a failure used to lose the draft.
  const s = fakeStorage();
  await saveOutbox([enqueue(draft, { now: NOW, holdMs: 0 })], s);
  const out = await flushOutbox({ send: async () => { throw new Error('offline'); }, storage: s, now: NOW });
  assert.equal(out.failed, 1);
  const [kept] = await loadOutbox(s);
  assert.equal(kept.state, 'failed');
  assert.deepEqual(kept.draft, draft, 'the composed message survived');
  assert.match(kept.error, /offline/);
});

test('TWO OVERLAPPING FLUSHES CANNOT DOUBLE-SEND', async () => {
  const s = fakeStorage();
  await saveOutbox([enqueue(draft, { now: NOW, holdMs: 0 })], s);
  let calls = 0;
  const send = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
  };
  const [a, b] = await Promise.all([
    flushOutbox({ send, storage: s, now: NOW }),
    flushOutbox({ send, storage: s, now: NOW }),
  ]);
  assert.equal(calls, 1, 'exactly one dispatch');
  assert.ok(a.skipped || b.skipped, 'the second flush stood down');
});

test('flushing an empty queue does nothing and does not write', async () => {
  const s = fakeStorage();
  const out = await flushOutbox({ send: async () => {}, storage: s, now: NOW });
  assert.equal(out.sent, 0);
  assert.equal(s.writes, 0);
});

test('onChange fires so the UI can show the row moving', async () => {
  const s = fakeStorage();
  await saveOutbox([enqueue(draft, { now: NOW, holdMs: 0 })], s);
  const seen = [];
  await flushOutbox({ send: async () => {}, storage: s, now: NOW, onChange: (i) => seen.push(i.length) });
  assert.ok(seen.length >= 2, 'at least: claimed, then removed');
});

// ---------------------------------------------------------------- backoff --

test('each failure waits longer than the last', () => {
  let it = enqueue(draft, { now: NOW, holdMs: 0 });
  const waits = [];
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    // DISTINCT errors: an identical repeat now short-circuits to stuck
    // (bug-hunt #33), which is exactly right -- this test is here for the
    // backoff PROGRESSION, which applies while failures differ.
    it = markFailed(it, `failure ${i}`, NOW);
    waits.push(it.nextAttempt - NOW);
  }
  for (let i = 1; i < waits.length; i++) {
    assert.ok(waits[i] > waits[i - 1], `attempt ${i} waits longer`);
  }
  assert.deepEqual(waits, BACKOFF_MS);
});

test('retries stop after the cap rather than hammering forever', () => {
  let it = enqueue(draft, { now: NOW, holdMs: 0 });
  for (let i = 0; i < MAX_ATTEMPTS; i++) it = markFailed(it, `failure ${i}`, NOW);
  assert.equal(isStuck(it), true);
  assert.deepEqual(dueItems([it], NOW + 10 ** 9), [], 'a stuck item is not retried');
});

test('a stuck item can be retried by hand, which resets the backoff', async () => {
  const s = fakeStorage();
  let it = enqueue(draft, { now: NOW, holdMs: 0 });
  for (let i = 0; i < MAX_ATTEMPTS; i++) it = markFailed(it, 'x', NOW);
  await saveOutbox([it], s);
  const back = await retryNow(it.id, s, NOW);
  assert.equal(back.attempts, 0);
  assert.equal(dueItems([back], NOW).length, 1);
});

// ------------------------------------------------------------- scheduling --

test('nextWakeIn returns null when there is nothing to do', () => {
  assert.equal(nextWakeIn([], NOW), null);
});

test('nextWakeIn returns the soonest pending moment', () => {
  const a = enqueue(draft, { now: NOW, holdMs: 5000 });
  const b = enqueue(draft, { now: NOW, holdMs: 30_000 });
  assert.equal(nextWakeIn([a, b], NOW), 5000);
});

test('nextWakeIn ignores permanently stuck items', () => {
  let it = enqueue(draft, { now: NOW, holdMs: 0 });
  for (let i = 0; i < MAX_ATTEMPTS; i++) it = markFailed(it, 'x', NOW);
  assert.equal(nextWakeIn([it], NOW), null);
});

// ------------------------------------------------------------- durability --

test('AN INTERRUPTED SEND IS RECOVERED, NOT ORPHANED', async () => {
  /*
   * A record left in `sending` by a crashed tab is invisible to the flush loop
   * and would sit in the queue forever. It must be demoted on load.
   */
  const s = fakeStorage({
    outbox: [{ id: 'x', state: 'sending', draft, queuedAt: NOW, releaseAt: NOW, attempts: 0, nextAttempt: 0 }],
  });
  const [it] = await loadOutbox(s);
  assert.equal(it.state, 'failed', 'demoted so the loop can see it again');
  assert.equal(dueItems([it], NOW).length, 1);
});

test('a corrupt queue degrades to empty rather than throwing', async () => {
  for (const bad of [null, 'x', 7, {}, [null], [{ no: 'draft' }]]) {
    assert.deepEqual(normaliseOutbox(bad), []);
  }
  assert.deepEqual(await loadOutbox(fakeStorage({ outbox: 'nope' })), []);
});

test('a failing storage write reports false rather than throwing', async () => {
  assert.equal(await saveOutbox([enqueue(draft)], fakeStorage()._fail()), false);
});

// ----------------------------------------------------------------- status --

test('the status line says something true in every state', () => {
  const held = enqueue(draft, { now: NOW });
  assert.match(statusOf(held, NOW), /Sending in \d+s/);

  let f = markFailed(held, 'offline', NOW);
  assert.match(statusOf(f, NOW), /Retrying in/);

  for (let i = 1; i < MAX_ATTEMPTS; i++) f = markFailed(f, 'offline', NOW);
  assert.match(statusOf(f, NOW), /Could not send/);
  assert.match(statusOf(f, NOW), /offline/, 'the reason is shown, not hidden');
});


test('a failed item with no scheduled retry says "now", not "in 0s"', () => {
  /*
   * Found in the per-file audit. `normaliseOutbox` defaults `nextAttempt` to 0
   * for a corrupt or older blob, and an interrupted `sending` record is demoted
   * to `failed` carrying whatever it had -- so this is reachable on any restart
   * after a crash.
   *
   * "Retrying in 0s" sits there unchanged and makes the queue look stuck, which
   * is exactly the impression the outbox exists to prevent.
   */
  const [it] = normaliseOutbox([{ id: 'x', state: 'failed', draft: { to: 'a' }, attempts: 1 }]);
  const line = statusOf(it, NOW);
  assert.doesNotMatch(line, /in 0s/);
  assert.match(line, /now/i);
});

test('a status line never contains NaN in any reachable state', () => {
  const states = [
    { state: 'held', releaseAt: NOW + 5000, attempts: 0, nextAttempt: 0 },
    { state: 'held', releaseAt: 0, attempts: 0, nextAttempt: 0 },
    { state: 'sending', attempts: 0, nextAttempt: 0 },
    { state: 'failed', attempts: 1, nextAttempt: NOW + 15000 },
    { state: 'failed', attempts: 1, nextAttempt: 0 },
    { state: 'failed', attempts: MAX_ATTEMPTS, nextAttempt: 0, error: 'offline' },
  ];
  for (const s of states) {
    const line = statusOf({ draft: {}, ...s }, NOW);
    assert.doesNotMatch(line, /NaN|undefined/, `${s.state}/${s.attempts}: "${line}"`);
  }
});

test('a held item with a corrupt releaseAt gets its hold back (bug-hunt #17)', () => {
  // releaseAt defaulting to 0 meant "due immediately", so a restart fired the
  // send the moment the app opened -- skipping the undo window entirely.
  const [it] = normaliseOutbox([{
    id: 'ob-1', state: 'held', draft: { to: 'a@b.c', body: 'x' },
    queuedAt: 1000, releaseAt: 'garbage',
  }]);
  assert.equal(it.state, 'held');
  assert.ok(it.releaseAt >= 1000, 'must re-anchor to the queued time, not 0');
  assert.ok(!dueItems([it], 1001).length, 'not due one millisecond after queueing');
  assert.ok(dueItems([it], it.releaseAt).length, 'due exactly when the hold ends');
});

test('the SAME failure twice goes straight to stuck (bug-hunt #33)', () => {
  // Repeating an error verbatim is a diagnosis, not a coincidence: go stuck,
  // and leave the escape hatch (retryNow resets attempts). Comparison runs on
  // the FULL error, so two long errors sharing a prefix are not conflated.
  const first = markFailed(
    { id: 'x', state: 'sending', draft: {}, queuedAt: 0, releaseAt: 0, attempts: 0, nextAttempt: 0 },
    'Gmail 503 on /messages/send (try 3)', 1000
  );
  assert.equal(first.attempts, 1);
  assert.ok(!isStuck(first), 'the first failure still earns retries');

  const second = markFailed(first, 'Gmail 503 on /messages/send (try 3)', 2000);
  assert.ok(isStuck(second), 'the identical second failure must give up');

  // A DIFFERENT error is new information: retries continue.
  const different = markFailed(first, 'Network error', 2000);
  assert.ok(!isStuck(different), 'a new error is not the same diagnosis');
});

test('a lost attachment goes stuck on the FIRST failure (bug-hunt 43 #33)', () => {
  // The source part is gone; waiting through four backoffs cannot bring it
  // back. retryNow remains the user's explicit override.
  const item = { id: 'x', state: 'sending', draft: {}, queuedAt: 0, releaseAt: 0, attempts: 0, nextAttempt: 0 };
  assert.ok(isStuck(markFailed(item, 'Cannot recover attachment “report.pdf”: no source', 1000)));
  assert.ok(isStuck(markFailed(item, 'Could not read attachment “x.pdf”', 1000)));
  const retried = retryNowSyncHelper(markFailed(item, 'Cannot recover attachment “a”: gone', 1000));
  assert.equal(retried.attempts, 0, 'retryNow is the explicit fresh judgement');
});

function retryNowSyncHelper(item) {
  // Mirrors retryNow's reset without storage, for a pure unit assertion.
  return { ...item, state: 'failed', attempts: 0, nextAttempt: 0, error: '', _fullError: '' };
}

test('flushOutbox reports NAMESPACED ids of what actually left (bug-hunt #27)', async () => {
  const storage = fakeStorage();
  await saveOutbox([
    { id: 'ob-1', state: 'held', draft: { to: 'a@b.c', body: 'x' }, queuedAt: 0, releaseAt: 0, attempts: 0, nextAttempt: 0 },
  ], storage);
  const res = await flushOutbox({
    send: async () => ({ id: 'gmail-123', threadId: 't' }),
    storage,
    now: 1,
  });
  assert.equal(res.sent, 1);
  assert.deepEqual(res.sentIds, ['g:gmail-123'], 'g:-prefixed wire id, never a bare mixed-space value');
});

test('owned rows fail closed without a proved current account', () => {
  assert.equal(dispatchable({ accountEmail: 'a@example.com' }, ''), false);
  assert.equal(dispatchable({ accountEmail: 'a@example.com' }, 'a@example.com'), true);
  assert.equal(dispatchable({}, ''), true, 'legacy unowned rows remain migratable');
});

test('clearOutbox reports a failed removal', async () => {
  const broken = { remove: async () => { throw new Error('denied'); } };
  assert.equal(await clearOutbox(broken), false);
});

test('an unknown delivery outcome never enters automatic retry', () => {
  const item = { id: 'u1', state: 'sending', draft, queuedAt: NOW, releaseAt: 0, attempts: 0, nextAttempt: 0 };
  const uncertain = markUncertain(item, Object.assign(new Error('connection reset'), { code: 'OUTCOME_UNKNOWN' }));
  assert.equal(uncertain.state, 'uncertain');
  assert.deepEqual(dueItems([uncertain], NOW + 1_000_000), [], 'no automatic second send');
  assert.equal(nextWakeIn([uncertain], NOW), null, 'uncertainty does not hot-loop the pump');
  assert.equal(isStuck(uncertain), true, 'the rail offers explicit Retry/Discard');
  assert.match(statusOf(uncertain), /check Sent/i, 'the UI explains the safe recovery action');
  assert.equal(normaliseOutbox([uncertain])[0].state, 'uncertain', 'the state survives restart');
});

test('a fresh send outranks a backlog of retries (bug-hunt 43 #1)', () => {
  // The batch cap takes the FIRST N due items; without priority, eight
  // retrying failures defer the message a human just pressed Send on.
  const retry = (i) => ({ id: `r${i}`, state: 'failed', draft: {}, queuedAt: 0, releaseAt: 0, attempts: 1, nextAttempt: 0 });
  const fresh = { id: 'fresh', state: 'held', draft: {}, queuedAt: 9, releaseAt: 10, attempts: 0, nextAttempt: 0 };
  const ordered = prioritizeDue([...Array.from({ length: 9 }, (_, i) => retry(i)), fresh]);
  assert.equal(ordered[0].id, 'fresh', 'the held item leads the dispatch order');
  assert.deepEqual(ordered.slice(1).map((x) => x.id),
    ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'],
    'retries keep their oldest-first order behind it');
});
