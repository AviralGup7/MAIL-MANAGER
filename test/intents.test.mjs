/**
 * G3 — verb intents: triage that survives a dead network (2026-08-14).
 *
 * WHY THESE PINS
 * --------------
 * M1's body floor made READING local-first; triage still evaporated — an
 * archive pressed on dead wifi rolled back and demanded a re-say. The
 * intent queue (app/mail/intents.js) records the verb and applies it when
 * the network answers, borrowing the outbox's proven discipline rather
 * than inventing a new one. So the tests copy the outbox's shape too:
 *
 *   1. UNIT — persistence and drain mechanics against a fake storage:
 *      the versioned blob, the malformed refusal, cancel-tells-the-truth,
 *      oldest-first, pause-in-place on failure, give-up at the cap ACROSS
 *      separate drains (never a hot loop), corruption reads empty and
 *      salvages row-by-row, an unprimed write cannot clobber another
 *      context's queue (the body floor's single worst failure, inherited),
 *      the cancel-race guard (the outbox's double-send lesson), and
 *      sign-out disarmament.
 *
 *   2. WIRING — the shell: QUEUEABLE is exactly one verb (widening is a
 *      deliberate commit, the way the outbox earned verbs), the queue
 *      offer precedes rollback and only on the never-lying offline
 *      signal, the queue toast carries its own guarded cancellation, the
 *      drains ride `online` plus one boot pass with honest log
 *      provenance, sign-out — and only sign-out — disarms the queue, and
 *      the key is registered with its backup exclusion explained (the
 *      shard-5 law).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeStorage } from './helpers/storage.mjs';

const {
  enqueueIntent,
  cancelIntent,
  queuedIntentCount,
  drainIntents,
  clearIntents,
  INTENT_MAX_ATTEMPTS,
  _reset,
} = await import('../src/app/mail/intents.js');

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

test.afterEach(() => { _reset(); });

// ------------------------------------------------------------------ unit --

test('enqueue persists a versioned blob; the count reads it back', async () => {
  const s = fakeStorage();
  const rec = await enqueueIntent({ verb: 'ARCHIVE', targetId: 'm1' }, s);
  assert.ok(rec.id, 'the record carries its queue id (the toast cancels by it)');
  assert.equal(await queuedIntentCount(s), 1);
  const blob = s.data.intents;
  assert.equal(blob.v, 1, 'the blob is versioned — a schema entry is a promise');
  assert.deepEqual(
    blob.q.map((r) => [r.verb, r.targetId, r.attempts]),
    [['ARCHIVE', 'm1', 0]],
  );
});

test('a malformed intent is refused with null and writes nothing', async () => {
  const s = fakeStorage();
  assert.equal(await enqueueIntent({ verb: 'ARCHIVE' }, s), null);
  assert.equal(await enqueueIntent({ targetId: 'm1' }, s), null);
  assert.equal(await enqueueIntent(null, s), null);
  assert.equal('intents' in s.data, false, 'a refusal must not create the blob');
});

test('cancel returns true only when it removed something (Undo restores through this)', async () => {
  const s = fakeStorage();
  const rec = await enqueueIntent({ verb: 'ARCHIVE', targetId: 'm1' }, s);
  assert.equal(await cancelIntent('i-nope', s), false);
  assert.equal(await queuedIntentCount(s), 1, 'a miss disturbs nothing');
  assert.equal(await cancelIntent(rec.id, s), true);
  assert.equal(await queuedIntentCount(s), 0);
  assert.deepEqual(s.data.intents.q, [], 'the cancellation persists');
});

test('drain applies oldest first, reports each application, empties the queue', async () => {
  const s = fakeStorage();
  await enqueueIntent({ verb: 'ARCHIVE', targetId: 'm1' }, s);
  await enqueueIntent({ verb: 'ARCHIVE', targetId: 'm2' }, s);
  const order = [];
  const res = await drainIntents({
    send: async (verb, extra) => { order.push(extra.id); },
    onApplied: (rec) => order.push(`applied:${rec.targetId}`),
  }, s);
  assert.deepEqual(res, { applied: 2, gaveUp: 0, remaining: 0 });
  assert.deepEqual(order, ['m1', 'applied:m1', 'm2', 'applied:m2'], 'FIFO, logged per item');
  assert.deepEqual(s.data.intents.q, []);
});

test('one failure pauses the drain IN PLACE and the attempt count persists', async () => {
  const s = fakeStorage();
  await enqueueIntent({ verb: 'ARCHIVE', targetId: 'head' }, s);
  await enqueueIntent({ verb: 'ARCHIVE', targetId: 'tail' }, s);
  const seen = [];
  const res = await drainIntents({
    send: async (verb, { id }) => { seen.push(id); throw new Error('still dead'); },
  }, s);
  assert.deepEqual(seen, ['head'], 'a live network that refused once is not asked twice in one pass');
  assert.deepEqual(res, { applied: 0, gaveUp: 0, remaining: 2 });
  assert.equal(s.data.intents.q[0].attempts, 1, 'the attempt survives on the blob for the next pass');
});

test('a poison intent gives up at the cap, honestly, across SEPARATE drains', async () => {
  const s = fakeStorage();
  await enqueueIntent({ verb: 'ARCHIVE', targetId: 'poison' }, s);
  const mourned = [];
  const io = {
    send: async () => { throw new Error('410 gone'); },
    onGiveUp: (rec, err) => mourned.push([rec.targetId, err.message]),
  };
  for (let n = 1; n < INTENT_MAX_ATTEMPTS; n++) {
    const res = await drainIntents(io, s);
    assert.equal(res.gaveUp, 0, `pass ${n} only banks the attempt — never a hot loop`);
  }
  const last = await drainIntents(io, s);
  assert.equal(last.gaveUp, 1);
  assert.equal(last.remaining, 0, 'the poison leaves the queue so the rest can drain');
  assert.deepEqual(mourned, [['poison', '410 gone']], 'the give-up names the intent and the reason');
});

test('a corrupt blob reads as an empty queue; salvage is row-by-row', async () => {
  const bad = fakeStorage({ intents: { v: 99, q: 'junk' } });
  assert.equal(await queuedIntentCount(bad), 0, 'unreadable version/shape ⇒ empty, never a crash');
  _reset(); // the module holds one session mirror — each scenario primes fresh
  const mixed = fakeStorage({
    intents: { v: 1, q: [
      { id: 'ok', verb: 'ARCHIVE', targetId: 'm1' },
      { nope: true },
      null,
    ] },
  });
  const sent = [];
  const res = await drainIntents({ send: async (v, { id }) => sent.push(id) }, mixed);
  assert.equal(res.applied, 1);
  assert.deepEqual(sent, ['m1'], 'one bad row must not strand the rest of the queue');
});

test('an unprimed enqueue cannot clobber a queue another context wrote', async () => {
  /* The body floor calls this its single worst failure; the queue inherits
     the pin: prime BEFORE write, or the first enqueue in a fresh context
     whole-writes a one-item blob over the other tab's queue. */
  const s = fakeStorage({ intents: { v: 1, q: [{ id: 'a', verb: 'ARCHIVE', targetId: 'first', attempts: 0 }] } });
  await enqueueIntent({ verb: 'ARCHIVE', targetId: 'second' }, s);
  assert.deepEqual(s.data.intents.q.map((r) => r.targetId), ['first', 'second']);
});

test("a head cancelled mid-flight is not applied by this drain (the outbox's lesson)", async () => {
  const s = fakeStorage();
  const a = await enqueueIntent({ verb: 'ARCHIVE', targetId: 'A' }, s);
  await enqueueIntent({ verb: 'ARCHIVE', targetId: 'B' }, s);
  const applied = [];
  const res = await drainIntents({
    send: async (verb, { id }) => {
      if (id === 'A') await cancelIntent(a.id, s); // the queue toast's Undo wins the race
    },
    onApplied: (rec) => applied.push(rec.targetId),
  }, s);
  assert.deepEqual(applied, ['B'], 'the cancelled head is re-checked by id, never shifted blind');
  assert.equal(res.applied, 1);
  assert.equal(res.remaining, 0);
});

test('clearIntents empties memory AND storage — a fresh prime inherits nothing', async () => {
  const s = fakeStorage();
  await enqueueIntent({ verb: 'ARCHIVE', targetId: 'm1' }, s);
  await clearIntents(s);
  assert.equal('intents' in s.data, false, 'the blob is removed, not just emptied');
  _reset(); // the next session
  assert.equal(await queuedIntentCount(s), 0, 'an account that left leaves no armed verbs');
});

test('a failing storage write degrades to silence, never a triage crash', async () => {
  const s = fakeStorage()._fail();
  const rec = await enqueueIntent({ verb: 'ARCHIVE', targetId: 'm1' }, s);
  assert.ok(rec, 'the record exists in memory even when persistence refused');
});

// ---------------------------------------------------------------- wiring --

test('the queueable set is exactly ARCHIVE — widening lands with its own tests', () => {
  const src = read('src/app/main.js');
  const m = src.match(/const QUEUEABLE = new Set\(\[([^\]]*)\]\);/);
  assert.ok(m, 'the allow-list exists and is greppable');
  const verbs = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.deepEqual(verbs, ['ARCHIVE'], 'bulkAct, flags and thread archives keep rollback+Retry for now');
});

test('a certainly-dead network queues BEFORE rollback; every other failure keeps it', () => {
  const src = read('src/app/main.js');
  const queued = src.indexOf('await maybeQueueIntent({ verb, id, snapshot, err })');
  const rolled = src.indexOf('return rollback(err);', queued);
  assert.ok(queued !== -1 && rolled !== -1 && queued < rolled,
    'the queue offer runs before the rollback path, in the same rejection branch');
  assert.match(src, /outcome: 'queued'/, 'the activity log tells a queued verb from a failed one');
  const fn = src.slice(src.indexOf('async function maybeQueueIntent'));
  assert.match(fn, /typeof navigator === 'undefined' \|\| navigator\.onLine !== false/,
    'only the never-lying direction queues — and the no-navigator test harness stays safe');
});

test("the queue toast's Undo restores the snapshot only through a real cancel", () => {
  const src = read('src/app/main.js');
  const toastAt = src.indexOf('Offline — will archive when you reconnect.');
  assert.ok(toastAt !== -1, 'queueing says so at queue time, with the cancellation right there');
  const guard = src.indexOf('if (await cancelIntent(rec.id)) {', toastAt);
  const upsert = src.indexOf('store.upsert(snapshot);', guard);
  assert.ok(guard !== -1 && upsert !== -1 && guard < upsert,
    'if the drain already applied it, Undo must NOT resurrect the row — the undo stack owns that');
});

test('drains ride the online event plus one boot pass, with honest provenance', () => {
  const src = read('src/app/main.js');
  assert.match(src, /window\.addEventListener\('online', \(\) => \{ void drainQueuedIntents\(\); \}\);/);
  assert.match(src, /setTimeout\(\(\) => \{ void drainQueuedIntents\(\); \}, 4000\);/,
    'the boot catch-up: alarms are nudges, catch-up is the guarantee');
  assert.match(src, /actor: 'intent', detail: 'queued while offline'/,
    'the log can answer "who changed this mail while I was offline"');
  assert.match(src, /onGiveUp:/, 'the give-up surfaces (activity + toast), never silent');
});

test('sign-out disarms the queue; nothing else touches it', () => {
  const src = read('src/app/main.js');
  /* 2026-08-15 (AUD-C1): the teardown moved into endAccountSession(), which
     the account-change tripwire shares — the disarm had to move with it. The
     LAW is unchanged and now pinned against the extraction: exactly ONE
     disarm call in the shell, inside the shared teardown, whose only callers
     are the two ways an account session ends (the button, the tripwire). A
     resync must still never touch armed verbs. */
  assert.equal(src.split('clearIntents()').length - 1, 1,
    'exactly one disarm site — a resync keeps verbs armed');
  assert.match(src, /async function endAccountSession\(gateMessage\) \{[^]*?await clearIntents\(\);/,
    'the one disarm lives in the account-session teardown');
  const btn = src.indexOf("$('btn-signout')");
  assert.ok(btn !== -1);
  assert.ok(src.slice(btn).includes('endAccountSession('),
    'an account that signs out leaves no armed verbs for the next account');
  assert.ok(src.includes('.includes(\'ACCOUNT_CHANGED\')'),
    'the tripwire exists — the teardown is reachable without the button');
});

test('the key is registered, excluded from backups, and the exclusion says why', () => {
  const registry = read('src/app/system/storage-registry.js');
  const line = registry.split('\n').find((l) => l.includes("key: 'intents'"));
  assert.ok(line, 'registered — the shard-5 law (shards are the ONLY test run)');
  assert.match(line, /backup: false/);
  assert.match(line, /reason: '[^']+'/, 'a schema entry is a promise: the exclusion explains itself');
  const backup = read('src/app/system/backup.js');
  assert.match(backup, /'intents'/, 'belt-and-braces: NEVER_EXPORT names it too');
});
