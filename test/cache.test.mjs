/**
 * Message cache tests.
 *
 * The cache runs BEFORE first paint, which makes its failure modes unusually
 * nasty: a throw here is a blank inbox, and a stale read is the previous
 * account's mail on screen. So most of these tests are about degrading
 * correctly rather than about the happy path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStorage } from './helpers/storage.mjs';

const {
  loadCache,
  saveCache,
  clearCache,
  createSaver,
  CACHE_MAX,
} = await import('../src/app/system/cache.js');

/** In-memory stand-in for chrome.storage.local. */

const msg = (i, over = {}) => ({
  id: `m${i}`,
  threadId: `t${i}`,
  from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
  subject: `Subject ${i}`,
  snippet: 'snippet',
  date: 1700000000000 - i * 1000,
  unread: false,
  starred: false,
  hasAttachment: false,
  category: 'augsd',
  confidence: 0.95,
  source: 'sender',
  reason: 'because',
  ...over,
});

// ------------------------------------------------------------ round trip --

test('a saved cache reads back identically', async () => {
  const s = fakeStorage();
  const msgs = [msg(0), msg(1), msg(2)];
  await saveCache(msgs, s);

  const got = await loadCache(s);
  assert.equal(got.messages.length, 3);
  assert.deepEqual(got.messages, msgs);
});

test('boolean flags survive the bit-packing', async () => {
  // unread, starred and hasAttachment share one integer; every combination
  // must round-trip or the list lies about read state -- and has:attachment
  // silently matches nothing, which is how the third flag came to be stored.
  const s = fakeStorage();
  await saveCache(
    [
      msg(0, { unread: false, starred: false }),
      msg(1, { unread: true, starred: false }),
      msg(2, { unread: false, starred: true }),
      msg(3, { unread: true, starred: true }),
      msg(4, { unread: false, starred: false, hasAttachment: true }),
      msg(5, { unread: true, starred: true, hasAttachment: true }),
    ],
    s
  );
  const got = await loadCache(s);
  assert.deepEqual(
    got.messages.map((m) => [m.unread, m.starred, m.hasAttachment]),
    [
      [false, false, false],
      [true, false, false],
      [false, true, false],
      [true, true, false],
      [false, false, true],
      [true, true, true],
    ]
  );
});

test('a cache written before hasAttachment existed still loads', async () => {
  /*
   * BACKWARD COMPATIBILITY, deliberately not a version bump.
   *
   * The attachment flag was added to the existing flags byte as bit 4. A blob
   * written by the previous build simply has that bit clear, which unpacks as
   * "no attachment" -- the same answer the bug gave -- and self-corrects on
   * the next sync. Discarding the whole cache for this would cost every
   * existing user one cold start to fix a search operator.
   */
  const s = fakeStorage();
  await s.set({
    msgCache: {
      v: 1,
      t: Date.now(),
      // Eleven fields, flags = 3 (unread + starred), no bit 4 at all.
      m: [['m0', 't0', 'A <a@b.c>', 'Subject', 'snippet', 1700000000000,
        3, 'augsd', 0.9, 'sender', 'because']],
    },
  });

  const got = await loadCache(s);
  assert.equal(got?.messages.length, 1, 'an older blob must still load');
  assert.equal(got.messages[0].unread, true);
  assert.equal(got.messages[0].starred, true);
  assert.equal(
    got.messages[0].hasAttachment, false,
    'a missing bit must read as false, not undefined'
  );
});

test('an empty cache reads as null, not as an empty inbox', async () => {
  assert.equal(await loadCache(fakeStorage()), null);
  const s = fakeStorage();
  await saveCache([], s);
  assert.equal(await loadCache(s), null, 'no messages means no usable cache');
});

test('the cache is capped so it cannot outgrow the storage quota', async () => {
  const s = fakeStorage();
  const many = Array.from({ length: CACHE_MAX + 250 }, (_, i) => msg(i));
  await saveCache(many, s);
  const got = await loadCache(s);
  assert.equal(got.messages.length, CACHE_MAX);
  assert.equal(got.messages[0].id, 'm0', 'keeps the newest, which are first');
});

test('a realistic cache stays well inside the storage budget', async () => {
  // chrome.storage.local is 10MB and we dropped unlimitedStorage. If a full
  // cache ever approached that, writes would start failing silently.
  const s = fakeStorage();
  await saveCache(
    Array.from({ length: CACHE_MAX }, (_, i) =>
      msg(i, {
        subject: 'A fairly representative BITS subject line about registration',
        snippet: 'A hundred characters of snippet text, which is about what Gmail returns for a message.',
      })
    ),
    s
  );
  const bytes = JSON.stringify(s.data.msgCache).length;
  assert.ok(bytes < 2_000_000, `cache is ${(bytes / 1e6).toFixed(2)}MB, expected < 2MB`);
});

// --------------------------------------------------------- degrading well --

test('a corrupt blob degrades to a cold start rather than throwing', async () => {
  // This runs before first paint. A throw here is a blank inbox.
  for (const bad of [
    { msgCache: 'not an object' },
    { msgCache: { v: 1 } },
    { msgCache: { v: 1, m: 'nope' } },
    { msgCache: null },
    { msgCache: 42 },
  ]) {
    assert.equal(await loadCache(fakeStorage(bad)), null, JSON.stringify(bad));
  }
});

test('a version bump discards the old shape instead of misreading it', async () => {
  const s = fakeStorage({ msgCache: { v: 0, t: 1, m: [['m0', 't0', 'f', 's', 'x', 1, 0, 'augsd', 1, '', '']] } });
  assert.equal(await loadCache(s), null);
});

test('one malformed row does not cost the user the whole cache', async () => {
  const s = fakeStorage();
  await saveCache([msg(0), msg(1)], s);
  s.data.msgCache.m.splice(1, 0, null, 'garbage', []);
  const got = await loadCache(s);
  assert.deepEqual(got.messages.map((m) => m.id), ['m0', 'm1']);
});

test('a storage failure on write is swallowed, not surfaced', async () => {
  // The cache is an optimisation. A quota error must never reach the user.
  const broken = { async get() { return {}; }, async set() { throw new Error('QUOTA_BYTES exceeded'); }, async remove() {} };
  assert.equal(await saveCache([msg(0)], broken), false);
});

test('a storage failure on read is swallowed', async () => {
  const broken = { async get() { throw new Error('unavailable'); } };
  assert.equal(await loadCache(broken), null);
});

test('clearCache removes the blob', async () => {
  const s = fakeStorage();
  await saveCache([msg(0)], s);
  await clearCache(s);
  assert.equal(await loadCache(s), null);
});

// -------------------------------------------------------------- the saver --

test('many schedule() calls collapse into ONE write', async () => {
  // A sync touching 200 messages fires 200 notifications' worth of intent.
  // Writing 200 times would be exactly the v1 mistake this cache avoids.
  const s = fakeStorage();
  let writes = 0;
  const wrapped = { ...s, async set(o) { writes++; return s.set(o); } };

  const saver = createSaver(() => [msg(0)], wrapped, { minIntervalMs: 0 });
  for (let i = 0; i < 200; i++) saver.schedule();
  await saver.flush();

  assert.equal(writes, 1, `expected 1 write, got ${writes}`);
});

test('flush() writes a pending save immediately', async () => {
  const s = fakeStorage();
  const saver = createSaver(() => [msg(0), msg(1)], s, { minIntervalMs: 0 });
  saver.schedule();
  assert.equal(saver.isPending, true);
  await saver.flush();
  assert.equal(saver.isPending, false);
  assert.equal((await loadCache(s)).messages.length, 2);
});

test('flush() with nothing pending does not write', async () => {
  const s = fakeStorage();
  let writes = 0;
  const wrapped = { ...s, async set(o) { writes++; return s.set(o); } };
  const saver = createSaver(() => [msg(0)], wrapped);
  await saver.flush();
  assert.equal(writes, 0);
});

test('a failed deferred write reports through onError, once per failure', async () => {
  // Quota exceeded used to be swallowed silently; the reporter lets the app
  // warn once per session (P-7) without the cache write path ever throwing.
  const s = fakeStorage();
  let errors = 0;
  const wrapped = {
    ...s,
    async set(o) { throw new Error('QuotaExceededError'); },
  };
  const saver = createSaver(() => [msg(0)], wrapped, {
    minIntervalMs: 0,
    onError: () => { errors++; },
  });
  saver.schedule();
  await new Promise((r) => setTimeout(r, 80)); // past the idle fallback
  assert.equal(errors, 1, 'the failure reached the reporter exactly once');
  // And the saver stays usable — a later schedule does not throw.
  saver.schedule();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(errors, 2, 'each failed write reports again (the app throttles)');
});

test('invalidate() cancels a scheduled save so it cannot resurrect a cleared cache', async () => {
  // Sign-out clears the cache, then resetView() clears the store, whose
  // notifications schedule one last save. That save must never land after
  // clearCache() — it would write an empty blob back over the removal.
  const s = fakeStorage();
  let writes = 0;
  const wrapped = { ...s, async set(o) { writes++; return s.set(o); } };
  const saver = createSaver(() => [], wrapped, { minIntervalMs: 0 });
  saver.schedule();          // scheduled by the pre-sign-out store
  saver.invalidate();        // sign-out: nothing pending may write
  await new Promise((r) => setTimeout(r, 80)); // long past the idle fallback
  assert.equal(writes, 0, 'no write after invalidate');
  // And a later schedule still works — the next session is a fresh saver era.
  saver.schedule();
  await saver.flush();
  assert.equal(writes, 1, 'schedule() after invalidate() still writes');
});

test('the saver reads the store lazily, so it persists the FINAL state', async () => {
  // It takes a getter, not a snapshot: a save scheduled during a sync must
  // write what the store settled on, not what it held mid-flight.
  const s = fakeStorage();
  let current = [msg(0)];
  const saver = createSaver(() => current, s, { minIntervalMs: 0 });
  saver.schedule();
  current = [msg(0), msg(1), msg(2)]; // sync continues after scheduling
  await saver.flush();
  assert.equal((await loadCache(s)).messages.length, 3);
});

test('flush() reaches storage before returning', async () => {
  // app.js calls saver.flush() from pagehide, which cannot await. What matters
  // is that chrome.storage.local.set is INVOKED before the handler returns;
  // completing the write is then Chrome's business, out of process.
  //
  // Note for anyone tightening this: an `await` chain does NOT break it. An
  // async function body runs synchronously up to its first await, and nothing
  // in write() -> saveCache() awaits before calling set(). I initially wrote
  // this test believing it distinguished the two implementations. It does not,
  // and a test that cannot fail is worse than no test -- so it asserts only
  // the property that is actually true and actually matters.
  const s = fakeStorage();
  let reached = false;
  const wrapped = { ...s, set(o) { reached = true; return s.set(o); } };
  const saver = createSaver(() => [msg(0)], wrapped, { minIntervalMs: 0 });
  saver.schedule();

  saver.flush(); // deliberately NOT awaited, exactly like pagehide
  assert.equal(reached, true, 'storage.set must be invoked before flush() returns');
});

test('no save fires after flush(), even if a throttle timer survives', async () => {
  // schedule() stores either an idle-callback id or a timeout id in the same
  // variable, and in a real browser those are separate id spaces -- so
  // cancelling one with the other's canceller is a silent no-op. The code now
  // tracks which scheduler produced the handle and cancels accordingly.
  //
  // Honest note on what this test does and does not prove: I could not make it
  // fail by reintroducing the mismatched canceller, because a surviving timer
  // re-arms only `if (pending)`, and flush() clears `pending` first. The
  // cancellation is therefore belt-and-braces, not the load-bearing guard.
  // Recorded rather than dressed up as a regression test for a bug that turned
  // out to be unreachable -- but the observable property below is real and
  // worth locking down.
  const realRIC = globalThis.requestIdleCallback;
  const realCIC = globalThis.cancelIdleCallback;
  globalThis.requestIdleCallback = (fn) => setTimeout(fn, 5);
  globalThis.cancelIdleCallback = (id) => clearTimeout(id);
  try {
    const s = fakeStorage();
    let writes = 0;
    const wrapped = { ...s, async set(o) { writes++; return s.set(o); } };
    const saver = createSaver(() => [msg(0)], wrapped, { minIntervalMs: 50 });

    saver.schedule();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(writes, 1);

    saver.schedule();          // throttled
    await saver.flush();       // writes once, clears pending
    const after = writes;

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(writes, after, 'no further write may fire after flush()');
    assert.equal(saver.isPending, false);
  } finally {
    globalThis.requestIdleCallback = realRIC;
    globalThis.cancelIdleCallback = realCIC;
  }
});

/* ------------------------------------------------- mutation-testing gaps ----
 *
 * `cancel()` had two lines nothing verified: the `h === null` early return and
 * the `handleKind === 'idle'` branch. Both matter — the module's own comment
 * warns that cancelling a timeout id with `cancelIdleCallback` is a SILENT
 * no-op, so a throttled save could still fire after `flush()` claimed to have
 * cancelled it, producing a second stale write over fresher data.
 */

test('flush() after a throttled schedule does not leave a second write armed', async () => {
  /*
   * Drives the throttled path specifically: a non-zero minInterval forces
   * `schedTimeout`, so `handleKind` is 'timeout'. If cancel() took the idle
   * branch the timer would survive and fire later.
   */
  const s = fakeStorage();
  let writes = 0;
  const wrapped = { ...s, async set(o) { writes++; return s.set(o); } };
  const saver = createSaver(() => [msg(0)], wrapped, { minIntervalMs: 50 });

  saver.schedule();
  await saver.flush();
  const afterFlush = writes;

  // Wait past the throttle window: nothing more may land.
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(writes, afterFlush, 'a cancelled throttled save fired anyway');
});

test('a stale throttled save cannot overwrite fresher data', async () => {
  // The consequence the comment describes, asserted on content rather than
  // on write count.
  const s = fakeStorage();
  let current = [msg(0)];
  const saver = createSaver(() => current, s, { minIntervalMs: 40 });

  saver.schedule();
  await saver.flush();

  // `flush()` is a no-op when nothing is pending, so the newer state must be
  // SCHEDULED before it can be flushed. (The first version of this test
  // flushed without scheduling and asserted against a write that never
  // happened — the test was wrong, not the cache.)
  current = [msg(0), msg(1), msg(2)];
  saver.schedule();
  await saver.flush();
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(
    (await loadCache(s)).messages.length, 3,
    'a late timer resurrected the older snapshot'
  );
});

test('flush() is safe to call repeatedly with nothing armed', async () => {
  // Exercises the `h === null` early return; without it, cancel() would call
  // clearTimeout(null) on every no-op flush.
  const s = fakeStorage();
  const saver = createSaver(() => [msg(0)], s, { minIntervalMs: 0 });
  await saver.flush();
  await saver.flush();
  await saver.flush();
  assert.equal(saver.isPending, false);
});

/*
 * A NOTE ON WHAT THIS SUITE CANNOT COVER.
 *
 * `cancel()` has an idle-callback branch:
 *
 *     if (handleKind === 'idle' && hasIdle) cancelIdleCallback(h);
 *
 * `hasIdle` is `typeof requestIdleCallback === 'function'`, which is FALSE
 * under Node — the API is browser-only. The branch therefore never executes
 * here, and mutation testing confirms it: mutating that comparison cannot be
 * killed by any test in this environment.
 *
 * This is an environmental limitation, not missing coverage, and it is
 * recorded rather than papered over with a test that would assert nothing.
 * The scheduling path IS covered (the throttled/timeout branch above); it is
 * only the idle branch that is unreachable. Verifying it needs the
 * headless-Chrome harness tracked as TODO 13.
 *
 * The test below at least pins the fallback, which is what Node actually runs
 * and what any non-browser context would run.
 */
test('scheduling falls back to a timer when requestIdleCallback is absent', async () => {
  assert.equal(
    typeof globalThis.requestIdleCallback, 'undefined',
    'if Node gains requestIdleCallback, the idle branch becomes testable here'
  );
  // The fallback must still coalesce and still write.
  const s = fakeStorage();
  const saver = createSaver(() => [msg(0), msg(1)], s, { minIntervalMs: 0 });
  saver.schedule();
  saver.schedule();
  await saver.flush();
  assert.equal((await loadCache(s)).messages.length, 2);
});


/* ==========================================================================
 * THE AUDIENCE STAMP MUST SURVIVE THE CACHE
 *
 * Found in the per-file audit. `audience` is computed once at ingest, where
 * the recipient headers and the signed-in address are both available. The
 * cache stored neither the stamp nor the headers, so on a cache-first boot --
 * the common path -- every message came back unstamped, which everything
 * downstream reads as "not broadcast".
 *
 * Consequence: `is:direct` matched everything, the "Just for me" view showed
 * the whole inbox, and a mailing-list blast landed in `needsReply`.
 * ========================================================================== */

test('the audience stamp survives a cache round trip', async () => {
  const s = fakeStorage();
  await saveCache([
    { id: 'b', threadId: 't1', from: 'a@b', subject: 's', snippet: 'x', date: 3, category: 'admin', confidence: 1, audience: 'broadcast' },
    { id: 'd', threadId: 't2', from: 'a@b', subject: 's', snippet: 'x', date: 2, category: 'admin', confidence: 1, audience: 'direct' },
    { id: 'c', threadId: 't3', from: 'a@b', subject: 's', snippet: 'x', date: 1, category: 'admin', confidence: 1, audience: 'cc' },
  ], s);

  const back = await loadCache(s);
  const by = Object.fromEntries(back.messages.map((m) => [m.id, m.audience]));
  assert.equal(by.b, 'broadcast', 'a list blast must not come back as direct');
  assert.equal(by.d, 'direct');
  assert.equal(by.c, 'cc');
});

test('a message cached before the stamp existed degrades, it does not corrupt', async () => {
  // An old blob has nothing at index 11. That must read as "unknown", which
  // self-corrects on the next sync -- not as a wrong concrete value.
  const s = fakeStorage();
  await saveCache([
    { id: 'old', threadId: 't', from: 'a@b', subject: 's', snippet: 'x', date: 1, category: 'admin', confidence: 1 },
  ], s);
  const [m] = (await loadCache(s)).messages;
  assert.equal(m.audience, undefined);
  assert.equal(m.id, 'old', 'the rest of the record is intact');
});

test('an unknown audience code does not survive as garbage', async () => {
  const s = fakeStorage();
  await saveCache([
    { id: 'x', threadId: 't', from: 'a@b', subject: 's', snippet: 'x', date: 1, category: 'admin', confidence: 1, audience: 'nonsense' },
  ], s);
  const [m] = (await loadCache(s)).messages;
  assert.equal(m.audience, undefined, 'an unmappable value is dropped, not stored');
});

// ------------------------------------------------------------ bug-hunt pins --

test('a row with a corrupt date is skipped, not hydrated (bug-hunt #16)', async () => {
  // A string date passes the old row check and then breaks the store's
  // ordered-insert comparisons. One bad row must cost one message, never the
  // whole cache.
  const s = fakeStorage();
  await saveCache([msg(0), msg(1)], s);
  const blob = (await s.get('msgCache')).msgCache;
  blob.m[1][5] = 'not-a-number'; // corrupt the second row's date
  await s.set({ msgCache: blob });

  const got = await loadCache(s);
  assert.equal(got.messages.length, 1, 'the corrupt row is dropped');
  assert.equal(got.messages[0].id, 'm0', 'the healthy row survives');
});

test('flush reports a failed write through onError (bug-hunt #53)', async () => {
  // A quota error during pagehide must not be invisible just because the write
  // path changed from scheduled to immediate.
  let reported = 0;
  const failing = {
    get: async () => ({}),
    set: async () => { throw new Error('QUOTA'); },
    remove: async () => {},
  };
  const saver = createSaver(() => [msg(0)], failing, { onError: () => { reported++; } });
  saver.schedule();
  await saver.flush();
  assert.equal(reported, 1, 'the immediate write path must surface the failure');
});

test('schedule survives being destructured off the saver (bug-hunt #54)', async () => {
  // The throttle re-arm used `this.schedule()`, which only resolves while the
  // saver is called as an object. A destructured schedule() threw.
  const s = fakeStorage();
  const saver = createSaver(() => [msg(0)], s, { minIntervalMs: 5, idleTimeout: 10 });
  const { schedule } = saver;
  schedule();                                   // first write (idle fallback ~50ms)
  await new Promise((r) => setTimeout(r, 80));  // let it land; lastWrite is set
  schedule();                                   // inside minInterval -> throttle re-arm
  schedule();                                   // coalesces onto the re-armed timer
  await new Promise((r) => setTimeout(r, 120)); // re-arm (5ms) + idle write (50ms)
  const got = await loadCache(s);
  assert.ok(got && got.messages.length === 1, 'the re-armed save still lands');
});
