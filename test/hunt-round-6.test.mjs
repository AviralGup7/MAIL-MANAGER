/**
 * Bug hunt, round 6 (2026-08-17) — PERSISTENCE CONSISTENCY.
 *
 * These came from an external deep-audit report. Every one was reproduced
 * against the real modules with a runtime probe before a line was changed,
 * and the measured numbers are recorded in each test and in the fix comments.
 *
 * The theme is a single sentence that appears, in effect, in every persistent
 * store in this project:
 *
 *     "If storage doesn't answer, pretend it contains nothing."
 *
 * For a cache that is correct. For state the user owns — unsent mail, a
 * snooze schedule — it is silent, permanent data loss, because the very next
 * thing a mutator does is read-modify-write.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as ob from '../src/features/outbox/model.js';
import * as sn from '../src/features/snooze/model.js';
import { read, mutate } from '../src/platform/durable.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(ROOT, p), 'utf8');

/** A storage double that can fail reads, writes, or both. */
function fakeStorage(initial = {}, opts = {}) {
  const db = { ...initial };
  return {
    db,
    async get(k) {
      if (opts.failGet) throw new Error('storage unavailable');
      return typeof k === 'string'
        ? { [k]: db[k] }
        : Object.fromEntries((k || []).map((x) => [x, db[x]]));
    },
    async set(o) {
      if (opts.failSet) throw new Error('QUOTA_BYTES quota exceeded');
      Object.assign(db, o);
    },
    async remove(k) { delete db[k]; },
  };
}

/* ========================================================================
 * P0-1 · the outbox delivered the same email twice
 * ==================================================================== */

test('P0-1: a send whose removal cannot be persisted is never sent again', async () => {
  /*
   * MEASURED BEFORE THE FIX:
   *   queue before : 1        Gmail send : SUCCESS
   *   save queue   : FAILED   flush says : sent = 1
   *   queue after  : 1        second pump: SENDS IT AGAIN  -> 2 deliveries
   *
   * The recipient receives the email twice for one user action.
   */
  const item = ob.enqueue({ to: 'prof@x.z', subject: 'Report', body: 'b' }, { holdMs: 0, now: 1000 });

  // Storage accepts nothing: the removal cannot be written down.
  const s = fakeStorage({ outbox: [item] }, { failSet: true });
  ob._resetOutbox();
  let sends = 0;
  const first = await ob.flushOutbox({
    send: async () => { sends++; return { id: 'gmail-1' }; },
    storage: s, now: 5000, settleMs: 0,
  });
  assert.equal(sends, 1);
  assert.equal(first.sent, 1);
  assert.deepEqual(first.unreconciled, [item.id],
    'a send that could not be recorded must be reported, not called a clean success');

  // Storage recovers with the stale row still queued — the exact trigger.
  const s2 = fakeStorage({ outbox: s.db.outbox });
  const second = await ob.flushOutbox({
    send: async () => { sends++; return { id: 'gmail-2' }; },
    storage: s2, now: 9000, settleMs: 0,
  });

  assert.equal(sends, 1, 'THE BUG: a second Gmail delivery for one user action');
  assert.equal(second.sent, 0);
  assert.deepEqual(second.alreadyDelivered, [item.id]);
});

test('P0-1: dispatchable() itself refuses a delivered id', async () => {
  /*
   * SABOTAGE-DRIVEN. Removing the guard inside `dispatchable` alone still
   * passed, because flushOutbox's own early `delivered.has` check shadowed
   * it. Two guards, one of them untested, is one guard — and `dispatchable`
   * is exported and used elsewhere, so it must hold the line on its own.
   */
  const item = ob.enqueue({ to: 'a@x.z', subject: 's', body: 'b' }, { holdMs: 0, now: 1000 });
  ob._resetOutbox();
  assert.equal(ob.dispatchable(item, undefined), true, 'a fresh item is sendable');

  const s = fakeStorage({ outbox: [item] }, { failSet: true });
  await ob.flushOutbox({ send: async () => ({ id: 'g1' }), storage: s, now: 5000, settleMs: 0 });

  assert.equal(ob.dispatchable(item, undefined), false,
    'once Gmail has accepted it, dispatchable must say no on its own');
  ob._resetOutbox();
  assert.equal(ob.dispatchable(item, undefined), true, 'and the seam must clear it');
});

test('P0-1: an already-delivered skip is not misreported as a wrong-account skip', async () => {
  /*
   * These two are different sentences to the user: "queued for another
   * account" says the mail has NOT gone, when in fact it has. Folding the
   * ledger into the ownership counter would have been a fix that lied.
   */
  const item = ob.enqueue({ to: 'a@x.z', subject: 's', body: 'b' }, { holdMs: 0, now: 1000 });
  const s = fakeStorage({ outbox: [item] }, { failSet: true });
  ob._resetOutbox();
  await ob.flushOutbox({ send: async () => ({ id: 'g1' }), storage: s, now: 5000, settleMs: 0 });

  const s2 = fakeStorage({ outbox: s.db.outbox });
  const res = await ob.flushOutbox({ send: async () => ({ id: 'g2' }), storage: s2, now: 9000, settleMs: 0 });
  assert.ok(res.alreadyDelivered, 'must be counted as delivered');
  assert.equal(res.wrongAccount, undefined, 'must NOT be blamed on account ownership');
});

test('P0-1: the delivered ledger is cleared by the test seam', () => {
  /*
   * MY OWN BUG, caught by a flaky shard. `delivered` is module state that
   * outlives a jsdom boot exactly as `dispatching` does; leaving it populated
   * makes a LATER test's send silently skip as a duplicate. That manifests as
   * an unrelated suite going flaky, which is the worst way to find it.
   */
  const reset = src('src/features/outbox/model.js')
    .slice(src('src/features/outbox/model.js').indexOf('export function _resetOutbox'));
  assert.match(reset.slice(0, 400), /delivered\.clear\(\)/,
    '_resetOutbox must clear the delivery ledger or it leaks across tests');
});

/* ========================================================================
 * P0-2 / P0-3 · a failed READ destroyed user-owned state
 * ==================================================================== */

test('P0-2: a failed read never lets the outbox be overwritten', async () => {
  // MEASURED BEFORE THE FIX: 5 queued messages -> 0.
  const queue = [1, 2, 3, 4, 5].map((i) =>
    ob.enqueue({ to: `p${i}@x.z`, subject: `s${i}`, body: 'b' }, { holdMs: 0, now: 1000 }));
  const s = fakeStorage({ outbox: queue }, { failGet: true });

  const out = await ob.retryNow(queue[0].id, s, 2000);
  assert.equal(out, null, 'a mutation on an unknown base must report failure');
  assert.equal(s.db.outbox.length, 5, 'THE BUG: four real unsent messages destroyed');
});

test('P0-2: retryNow reports failure when the WRITE fails too', async () => {
  /*
   * PINS THE BEHAVIOUR, NOT THE IMPLEMENTATION — and I checked which.
   *
   * I added this expecting it to catch `return res.value` written without
   * the `if (!res.ok)` guard. It does not, and I verified that by probe
   * rather than assuming: on a failed write `durableMutate` returns no
   * `value` at all, so both spellings evaluate to null. The guard is
   * therefore belt-and-braces today, not load-bearing.
   *
   * The test stays because the CONTRACT is what matters — "an unpersisted
   * retry reports null" must remain true if durable.mutate ever starts
   * returning the attempted value on a write failure, which would be a
   * reasonable change to make. Recorded rather than dressed up as a gate it
   * is not.
   */
  const queue = [ob.enqueue({ to: 'a@x.z', subject: 's', body: 'b' }, { holdMs: 0, now: 1000 })];
  const s = fakeStorage({ outbox: queue }, { failSet: true });
  const out = await ob.retryNow(queue[0].id, s, 2000);
  assert.equal(out, null, 'an unpersisted retry must not be reported as armed');
});

test('P0-2: cancel refuses to write when the queue cannot be read', async () => {
  const queue = [ob.enqueue({ to: 'a@x.z', subject: 's', body: 'b' }, { holdMs: 0, now: 1000 })];
  const s = fakeStorage({ outbox: queue }, { failGet: true });
  const out = await ob.cancel(queue[0].id, s);
  assert.equal(out, null);
  assert.equal(s.db.outbox.length, 1, 'the queue must survive an unreadable cancel');
});

test('P0-2: readOutbox distinguishes unavailable from genuinely empty', async () => {
  const broken = await ob.readOutbox(fakeStorage({}, { failGet: true }));
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, 'unavailable');
  assert.deepEqual(broken.value, [], 'a renderer still gets something safe to draw');

  const empty = await ob.readOutbox(fakeStorage({}));
  assert.equal(empty.ok, true, 'storage answered "nothing", which is a FACT');
  assert.equal(empty.present, false);

  const full = await ob.readOutbox(fakeStorage({
    outbox: [ob.enqueue({ to: 'a@x.z', subject: 's', body: 'b' }, { holdMs: 0, now: 1 })],
  }));
  assert.equal(full.ok, true);
  assert.equal(full.value.length, 1);
});

test('P0-3: a failed read never lets the snooze schedule be overwritten', async () => {
  // MEASURED BEFORE THE FIX: {m-a, m-b} -> {m-c}.
  const NOW = 1_000_000;
  const base = {
    'm-a': { at: NOW + 10_000_000, snoozedAt: NOW },
    'm-b': { at: NOW + 20_000_000, snoozedAt: NOW },
  };
  const s = fakeStorage({ snoozed: { ...base } }, { failGet: true });

  const out = await sn.addSnooze('m-c', NOW + 30_000_000, s, NOW);
  assert.equal(out, null, 'the caller must learn the snooze was not recorded');
  assert.deepEqual(Object.keys(s.db.snoozed).sort(), ['m-a', 'm-b'],
    'THE BUG: two deferred messages lost their wake time');
});

test('P0-3: removeSnooze no longer depends on luck', async () => {
  /*
   * This one was saved only by `if (!(id in all)) return all` happening to
   * bail out on the empty object a failed read produced. A coincidence is not
   * a defence: the same failure with a PRESENT id would have written the
   * truncated map. Now explicit.
   */
  const NOW = 1_000_000;
  const base = { 'm-a': { at: NOW + 10_000_000, snoozedAt: NOW }, 'm-b': { at: NOW + 20_000_000, snoozedAt: NOW } };
  const s = fakeStorage({ snoozed: { ...base } }, { failGet: true });
  await sn.removeSnooze('m-a', s);
  assert.deepEqual(Object.keys(s.db.snoozed).sort(), ['m-a', 'm-b']);

  const model = src('src/features/snooze/model.js');
  assert.ok(/readSnoozed\(storage\)/.test(model) && /reason === 'unavailable'/.test(model),
    'the guard must be explicit, not incidental');
});

/* ========================================================================
 * The durable primitive itself
 * ==================================================================== */

test('durable.mutate refuses to write on an unreadable base, and says why', async () => {
  const s = fakeStorage({ k: [1, 2, 3] }, { failGet: true });
  const res = await mutate('k', (cur) => [...cur, 4], { storage: s, empty: [] });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unavailable');
  assert.deepEqual(s.db.k, [1, 2, 3], 'nothing may be written');
});

test('durable distinguishes CORRUPT from UNAVAILABLE, because only one is permanent', async () => {
  /*
   * A corrupt blob is a previous version's mistake and retrying reads it
   * again forever, so a mutation MAY proceed from empty — that is how a user
   * recovers. An unavailable read is transient and must never be written
   * over. Collapsing the two would either strand the user on a bad blob or
   * resurrect the data-loss bug.
   */
  const s = fakeStorage({ k: 'not an array' });
  const got = await read('k', { storage: s, empty: [], isValid: Array.isArray });
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'corrupt');

  const res = await mutate('k', (cur) => [...cur, 'fresh'], {
    storage: s, empty: [], isValid: Array.isArray,
  });
  assert.equal(res.ok, true, 'a corrupt store must be recoverable by writing over it');
  assert.deepEqual(s.db.k, ['fresh']);
});

test('durable reports a failed WRITE distinctly from a failed read', async () => {
  const s = fakeStorage({ k: [1] }, { failSet: true });
  const res = await mutate('k', (cur) => [...cur, 2], { storage: s, empty: [], isValid: Array.isArray });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'write-failed',
    'the change is real but not durable — the caller may have already done the external half');
});

/* ========================================================================
 * P1-4 / P1-5 / P1-6 / P1-9 / P1-12
 * ==================================================================== */

test('P1-4: a snooze that committed in Gmail is never reported as failed', () => {
  const worker = src('src/background/index.js');
  const at = worker.indexOf("case 'SNOOZE':");
  assert.notEqual(at, -1);
  const branch = worker.slice(at, worker.indexOf("case 'UNSNOOZE':"));

  assert.match(branch, /try \{\s*await scheduleWake\(\);/,
    'scheduleWake must not be able to reject the whole request');
  assert.match(branch, /wakeScheduled: false/,
    'the degraded outcome must be nameable by the caller');
  assert.ok(
    branch.indexOf('await modify(') < branch.indexOf('scheduleWake'),
    'the Gmail mutation commits first; that is what makes rollback a lie'
  );
});

test('P1-5: the cached-start path arms the auto-refresh timer', () => {
  /*
   * scheduleAutoRefresh() sits at the END of start(), after the cold path.
   * The cached branch returned above it, and the only other call site is the
   * timer's own re-arm — which cannot run because it was never armed once.
   * So every returning user ran with no auto-refresh at all.
   */
  const main = src('src/app/main.js');
  const at = main.indexOf('const delta = await refresh({ silent: true });');
  assert.notEqual(at, -1);
  const branch = main.slice(at, at + 1400);

  const armAt = branch.indexOf('scheduleAutoRefresh();');
  const retAt = branch.indexOf('return;');
  assert.ok(armAt !== -1, 'the cached path must arm the timer');
  assert.ok(armAt < retAt, 'and it must do so BEFORE returning');
});

test('P1-6: a failed non-inbox refresh restores the page it cleared', () => {
  const main = src('src/app/main.js');
  const at = main.indexOf("if (state.mailbox !== 'inbox') {");
  assert.notEqual(at, -1);
  const branch = main.slice(at, at + 2200);

  assert.match(branch, /const snapshot = /, 'the old page must be captured before clear()');
  assert.ok(branch.indexOf('const snapshot') < branch.indexOf('st.clear()'),
    'snapshotting after the clear would capture nothing');
  /*
   * UPDATED BY W-4, AND THE UPDATE IS THE POINT.
   *
   * This used to assert `catch {`, and it PASSED while the rollback was dead
   * code: `loadMailboxPage` catches internally and resolves normally, so the
   * catch could never fire. A test that pins the SHAPE of a fix rather than
   * its EFFECT will happily certify a no-op. It now asserts the mechanism
   * that actually works — the returned outcome being read.
   */
  assert.match(branch, /const ok = await loadMailboxPage\(id, ''\);/,
    'the outcome must be captured, not assumed from the absence of a throw');
  assert.match(branch, /if \(!ok\) \{/, 'and acted on');
  assert.match(branch, /for \(const m of snapshot\) st\.upsert\(m\)/, 'restoring the snapshot');
  assert.ok(!/throw err;/.test(branch),
    'must not rethrow: callers neither await nor catch, so a throw becomes an unhandled rejection');

  // And the callee must actually report failure, or `ok` is always truthy.
  const fn = main.slice(main.indexOf('async function loadMailboxPage'));
  const body = fn.slice(0, fn.indexOf('\nasync function pruneAfterFullSync'));
  assert.match(body, /return false;/, 'loadMailboxPage must report a failed load');
  assert.match(body, /return true;/, 'and a successful one');
});

test('P1-9: the history cursor cannot be talked backwards in-process', async () => {
  const db = {};
  globalThis.chrome = { storage: { local: {
    async get(k) { return typeof k === 'string' ? { [k]: db[k] } : Object.fromEntries((k || []).map((x) => [x, db[x]])); },
    async set(o) { Object.assign(db, o); },
    async remove(k) { delete db[k]; },
  } } };
  const { commitHistoryId, _resetCursorFloor } = await import('../src/background/sync.js');
  _resetCursorFloor();

  assert.equal(await commitHistoryId('200'), '200');
  assert.equal(await commitHistoryId('150'), '200', 'a late commit must not regress the cursor');
  assert.equal(await commitHistoryId('300'), '300');
  assert.equal(await commitHistoryId('1'), '300');

  /*
   * THE SEQUENTIAL CASE IS NOT ENOUGH — MY FIRST VERSION STOPPED HERE.
   *
   * Sabotage-testing caught it: deleting the in-process floor entirely still
   * passed, because with no concurrency the post-write re-read observes our
   * own value and the compare-on-read alone is sufficient. The floor only
   * earns its keep when a STALE READ is in flight, so the test has to create
   * one.
   *
   * Here tab-A's commit(300) lands while a commit(150) is suspended between
   * its read and its write — the exact interleaving that regressed the
   * cursor in production.
   */
  _resetCursorFloor();
  db.historyId = '100';

  let release;
  const gate = new Promise((r) => { release = r; });
  const realGet = globalThis.chrome.storage.local.get;
  let stalled = false;
  globalThis.chrome.storage.local.get = async function (k) {
    const out = await realGet.call(this, k);
    if (!stalled) { stalled = true; await gate; }   // suspend the FIRST reader
    return out;
  };

  const slow = commitHistoryId('150');   // reads 100, then suspends
  globalThis.chrome.storage.local.get = realGet;
  await commitHistoryId('300');          // completes fully
  release();
  await slow;

  const final = (await realGet.call(globalThis.chrome.storage.local, 'historyId')).historyId;
  assert.equal(final, '300',
    'a commit that read a stale value must not drag the cursor back to 150');
  _resetCursorFloor();
});

test('P1-9: the comment no longer claims an atomicity the platform cannot give', () => {
  /*
   * The original asserted "a late commit from an older concurrent prepare
   * must not move the shared cursor backwards" over a read-compare-write
   * across two awaits. chrome.storage has no CAS; the honest thing is to
   * write down what IS enforced and why the residual window is safe.
   */
  const sync = src('src/background/sync.js');
  const at = sync.indexOf('export async function commitHistoryId');
  const doc = sync.slice(Math.max(0, at - 2600), at);
  assert.match(doc, /no compare-and-swap|no CAS|not available/i,
    'the platform limitation must be stated, not glossed');
  assert.match(doc, /idempotent|errs toward stale|only ever errs/i,
    'and the residual race must be argued safe rather than ignored');
});

test('P1-12: the wake alarm cannot reject, and re-aims even when the sweep throws', () => {
  const worker = src('src/background/index.js');
  const at = worker.indexOf('if (alarm.name === WAKE_ALARM) {');
  assert.notEqual(at, -1);
  const branch = worker.slice(at, worker.indexOf("} else if (alarm.name === SYNC_ALARM)"));

  assert.match(branch, /try \{\s*await wakeDue\(\);\s*\} catch/,
    'wakeDue must not escape into the service worker as an unhandled rejection');
  assert.match(branch, /try \{\s*await scheduleWake\(\);[\s\S]*?\} catch/,
    'the re-aim must be guarded too');
  /*
   * MY FIRST VERSION OF THIS ASSERTION WAS WRONG. It compared
   * indexOf('catch') against indexOf('scheduleWake') — but the explanatory
   * comment above the code MENTIONS scheduleWake, so the comparison measured
   * prose position, not structure. The same comment-vs-code trap as round 5.
   *
   * What actually matters is that the two awaits sit in SEPARATE try blocks,
   * so a throw in the first cannot skip the second.
   */
  const stripped = branch.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const wakeTry = stripped.indexOf('await wakeDue()');
  const wakeCatch = stripped.indexOf('catch', wakeTry);
  const reaim = stripped.indexOf('await scheduleWake()');
  assert.ok(wakeTry !== -1 && wakeCatch !== -1 && reaim !== -1);
  assert.ok(
    wakeCatch < reaim,
    'the re-aim must sit AFTER the sweep\'s catch, in its own block — otherwise '
    + 'one bad wake disarms the alarm chain permanently and nothing ever wakes again'
  );
});
