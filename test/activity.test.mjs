/**
 * Activity log tests.
 *
 * Two guarantees matter more than the rest:
 *   1. The log must never break the action it is logging.
 *   2. The log must never become a second copy of the mailbox on disk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStorage } from './helpers/storage.mjs';

const {
  record, flush, loadLog, clearLog, markUndone, normaliseLog, prune, describe,
  pendingCount, _resetActivity, MAX_ENTRIES, MAX_AGE_MS,
} = await import('../src/app/academic/activity.js');

test.beforeEach(() => _resetActivity());

// ------------------------------------------------------------- durability --

test('an entry round-trips', async () => {
  const s = fakeStorage();
  record({ verb: 'ARCHIVE', ids: ['a', 'b'], actor: 'user' }, { storage: s });
  await flush({ storage: s });
  const log = await loadLog(s);
  assert.equal(log.length, 1);
  assert.equal(log[0].verb, 'ARCHIVE');
  assert.equal(log[0].count, 2);
});

test('writes are batched, not one per action', async () => {
  const s = fakeStorage();
  for (let i = 0; i < 20; i++) record({ verb: 'STAR', ids: [`m${i}`] }, { storage: s });
  assert.equal(s.writes, 0, 'nothing written yet');
  await flush({ storage: s });
  assert.equal(s.writes, 1, 'twenty actions, one storage write');
  assert.equal((await loadLog(s)).length, 20);
});

test('A FAILING STORAGE WRITE NEVER THROWS', async () => {
  // The log must not be able to break the action it is logging.
  const s = fakeStorage()._fail();
  record({ verb: 'ARCHIVE', ids: ['a'] }, { storage: s });
  await assert.doesNotReject(() => flush({ storage: s }));
});

test('record never throws even with no storage at all', () => {
  assert.doesNotThrow(() => record({ verb: 'X', ids: [] }, { storage: null }));
});

test('flush with an empty queue is a no-op', async () => {
  const s = fakeStorage();
  assert.equal(await flush({ storage: s }), 0);
  assert.equal(s.writes, 0);
});

// ------------------------------------------------------------------ caps --

test('the log is capped by count', async () => {
  const s = fakeStorage();
  const many = [];
  for (let i = 0; i < MAX_ENTRIES + 50; i++) many.push({ at: 1000 + i, verb: 'STAR', ids: ['x'], count: 1, outcome: 'ok', actor: 'user' });
  const kept = prune(many, 2000);
  assert.equal(kept.length, MAX_ENTRIES);
});

test('the newest entries are the ones kept', () => {
  const old = { at: 1, verb: 'OLD', ids: [], count: 0, outcome: 'ok', actor: 'user' };
  const fresh = { at: 999, verb: 'FRESH', ids: [], count: 0, outcome: 'ok', actor: 'user' };
  const kept = prune([old, fresh], 1000);
  assert.equal(kept[0].verb, 'FRESH');
});

test('entries older than the age cap are dropped', () => {
  const now = 1_000_000_000_000;
  const stale = { at: now - MAX_AGE_MS - 1, verb: 'STALE', ids: [], count: 0, outcome: 'ok', actor: 'user' };
  const ok = { at: now - 1000, verb: 'OK', ids: [], count: 0, outcome: 'ok', actor: 'user' };
  assert.deepEqual(prune([stale, ok], now).map((e) => e.verb), ['OK']);
});

test('a huge id list is truncated ON DISK, and the true count survives', async () => {
  /*
   * THIS TEST WAS WORTHLESS ON ITS FIRST WRITING and was caught by sabotage.
   *
   * It read the entry back through `loadLog`, which runs `normaliseLog`, which
   * truncates ids itself. So removing the truncation from the WRITE path -- the
   * thing that decides what actually lands in storage -- left the assertion
   * green, because the read path quietly cleaned up after it. The log could
   * have been writing 2000-id arrays to disk and the test would not have
   * noticed.
   *
   * Fixed by asserting against the RAW stored blob.
   */
  const s = fakeStorage();
  const ids = Array.from({ length: 300 }, (_, i) => `m${i}`);
  record({ verb: 'BULK', ids }, { storage: s });
  await flush({ storage: s });

  const stored = s.data.activityLog;
  assert.ok(stored[0].ids.length <= 25, `on disk: ${stored[0].ids.length} ids`);
  assert.equal(stored[0].count, 300, 'the count is still honest');
});

// ------------------------------------------------------------ no leakage --

test('THE LOG DOES NOT STORE SUBJECTS OR ADDRESSES', async () => {
  /*
   * A log that accumulates subjects and senders is a second copy of the
   * mailbox in local storage with none of its protections. If a future change
   * starts persisting them, this fails.
   */
  const s = fakeStorage();
  record(
    { verb: 'ARCHIVE', ids: ['a'], subject: 'Fee receipt 2025', from: 'accounts@bits.ac.in' },
    { storage: s }
  );
  await flush({ storage: s });
  const raw = JSON.stringify(s.data);
  assert.doesNotMatch(raw, /Fee receipt/);
  assert.doesNotMatch(raw, /accounts@bits/);
});

test('an over-long detail or error is truncated', async () => {
  const s = fakeStorage();
  record({ verb: 'X', ids: [], detail: 'd'.repeat(500), error: 'e'.repeat(500) }, { storage: s });
  await flush({ storage: s });
  const [e] = await loadLog(s);
  assert.ok(e.detail.length <= 120);
  assert.ok(e.error.length <= 200);
});

// ------------------------------------------------------------ normalising --

test('a corrupt log blob degrades to empty', () => {
  for (const bad of [null, 'x', 7, {}, [null], [{ verb: 5 }], [{ at: 'soon' }]]) {
    assert.deepEqual(normaliseLog(bad), []);
  }
});

test('an unknown actor falls back to system rather than being trusted', () => {
  const [e] = normaliseLog([{ at: 1, verb: 'X', actor: 'hacker', ids: [] }]);
  assert.equal(e.actor, 'system');
});

test('a corrupt stored log loads as empty rather than throwing', async () => {
  assert.deepEqual(await loadLog(fakeStorage({ activityLog: 'nope' })), []);
});

// ----------------------------------------------------------------- undone --

test('a partial outcome (bulk half-applied) survives the round trip', async () => {
  // The app records outcome 'partial' when a chunked BULK partly fails;
  // the log must not coerce it back to 'ok' on reload (cross-audit P7).
  const s = fakeStorage();
  record({ verb: 'ARCHIVE', ids: ['a', 'b'], outcome: 'partial', error: '1 failed' }, { storage: s });
  await flush({ storage: s });
  const [entry] = await loadLog(s);
  assert.equal(entry.outcome, 'partial');
  assert.match(describe(entry), /partial/);
});

test('an entry can be marked undone', async () => {
  const s = fakeStorage();
  record({ verb: 'ARCHIVE', ids: ['a'] }, { storage: s });
  await flush({ storage: s });
  assert.equal(await markUndone('ARCHIVE', ['a'], { storage: s }), true);
  assert.equal((await loadLog(s))[0].outcome, 'undone');
});

test('marking undone finds nothing when the verb does not match', async () => {
  const s = fakeStorage();
  record({ verb: 'ARCHIVE', ids: ['a'] }, { storage: s });
  await flush({ storage: s });
  assert.equal(await markUndone('STAR', ['a'], { storage: s }), false);
});

test('an already-undone entry is not undone twice', async () => {
  const s = fakeStorage();
  record({ verb: 'ARCHIVE', ids: ['a'] }, { storage: s });
  await flush({ storage: s });
  await markUndone('ARCHIVE', ['a'], { storage: s });
  assert.equal(await markUndone('ARCHIVE', ['a'], { storage: s }), false);
});

// ------------------------------------------------------------------ misc --

test('clearing wipes both storage and the pending queue', async () => {
  const s = fakeStorage();
  record({ verb: 'X', ids: ['a'] }, { storage: s });
  await flush({ storage: s });
  record({ verb: 'Y', ids: ['b'] }, { storage: s });
  await clearLog(s);
  assert.equal(pendingCount(), 0);
  assert.deepEqual(await loadLog(s), []);
});

test('the reset seam clears module state between boots', () => {
  record({ verb: 'X', ids: [] }, { storage: null });
  assert.ok(pendingCount() > 0);
  _resetActivity();
  assert.equal(pendingCount(), 0);
});

test('describe reads as a sentence for each outcome', () => {
  assert.match(describe({ verb: 'ARCHIVE', ids: ['a'], count: 1, outcome: 'ok', actor: 'user' }), /1 message/);
  assert.match(describe({ verb: 'ARCHIVE', ids: [], count: 4, outcome: 'ok', actor: 'user' }), /4 messages/);
  assert.match(describe({ verb: 'ARCHIVE', ids: [], count: 1, outcome: 'failed', actor: 'user' }), /failed/);
  assert.match(describe({ verb: 'ARCHIVE', ids: [], count: 1, outcome: 'ok', actor: 'rule', detail: 'Newsletters' }), /by rule "Newsletters"/);
});
