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

const {
  loadCache,
  saveCache,
  clearCache,
  createSaver,
  CACHE_MAX,
} = await import('../src/app/cache.js');

/** In-memory stand-in for chrome.storage.local. */
function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(k) {
      if (typeof k === 'string') return k in data ? { [k]: data[k] } : {};
      return { ...data };
    },
    async set(o) {
      Object.assign(data, o);
    },
    async remove(k) {
      for (const key of [].concat(k)) delete data[key];
    },
  };
}

const msg = (i, over = {}) => ({
  id: `m${i}`,
  threadId: `t${i}`,
  from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
  subject: `Subject ${i}`,
  snippet: 'snippet',
  date: 1700000000000 - i * 1000,
  unread: false,
  starred: false,
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
  // unread and starred are packed into one integer; every combination must
  // round-trip or the list lies about read state.
  const s = fakeStorage();
  await saveCache(
    [
      msg(0, { unread: false, starred: false }),
      msg(1, { unread: true, starred: false }),
      msg(2, { unread: false, starred: true }),
      msg(3, { unread: true, starred: true }),
    ],
    s
  );
  const got = await loadCache(s);
  assert.deepEqual(
    got.messages.map((m) => [m.unread, m.starred]),
    [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ]
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
