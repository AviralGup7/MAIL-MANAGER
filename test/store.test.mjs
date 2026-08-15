/**
 * Store tests.
 *
 * The performance tests here are the point of the file. The old version's
 * slowness was structural — full index rebuild + full re-render + whole-array
 * write on every batch — so these assert the structure, not just the results.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, MAX_MESSAGES } from '../src/app/mail/store.js';

function msg(i, over = {}) {
  return {
    id: `m${i}`,
    threadId: `t${i}`,
    from: `Sender ${i} <s${i}@pilani.bits-pilani.ac.in>`,
    subject: `Message ${i} about registration`,
    snippet: 'body text',
    date: 1_700_000_000_000 + i * 1000,
    unread: true,
    starred: false,
    category: i % 2 ? 'augsd' : 'clubs',
    confidence: 0.9,
    reason: 'test',
    ...over,
  };
}

// ------------------------------------------------------------ basics -------

test('upsert stores and orders newest-first', () => {
  const s = new Store();
  s.upsertMany([msg(1), msg(3), msg(2)]);
  assert.equal(s.size, 3);
  assert.deepEqual(s.order, ['m3', 'm2', 'm1']);
});

test('upserting the same id updates rather than duplicates', () => {
  const s = new Store();
  s.upsert(msg(1));
  s.upsert(msg(1, { subject: 'changed' }));
  assert.equal(s.size, 1);
  assert.equal(s.get('m1').subject, 'changed');
});

test('remove drops from every index', () => {
  const s = new Store();
  s.upsertMany([msg(1), msg(2)]);
  s.remove('m1');
  assert.equal(s.size, 1);
  assert.ok(!s.order.includes('m1'));
  assert.equal(s.idsFor('augsd').includes('m1'), false);
  assert.equal(s.search('registration').includes('m1'), false);
});

test('patch updates fields and reindexes only when needed', () => {
  const s = new Store();
  s.upsert(msg(1, { category: 'clubs' }));
  s.patch('m1', { unread: false });
  assert.equal(s.get('m1').unread, false);
  assert.ok(s.idsFor('clubs').includes('m1'));

  s.patch('m1', { category: 'augsd' });
  assert.ok(s.idsFor('augsd').includes('m1'));
  assert.ok(!s.idsFor('clubs').includes('m1'));
});

// -------------------------------------------------- notification batching --

test('a batch notifies subscribers EXACTLY ONCE', () => {
  // The core regression. Old version: one full re-render per message.
  const s = new Store();
  let calls = 0;
  s.subscribe(() => calls++);

  s.upsertMany(Array.from({ length: 100 }, (_, i) => msg(i)));

  assert.equal(calls, 1, `subscribers fired ${calls} times for 100 messages`);
});

test('nested batches still notify once', () => {
  const s = new Store();
  let calls = 0;
  s.subscribe(() => calls++);
  s.batch(() => {
    s.upsert(msg(1));
    s.batch(() => {
      s.upsert(msg(2));
      s.upsert(msg(3));
    });
    s.upsert(msg(4));
  });
  assert.equal(calls, 1);
});

test('an unbatched mutation notifies immediately', () => {
  const s = new Store();
  let calls = 0;
  s.subscribe(() => calls++);
  s.upsert(msg(1));
  s.upsert(msg(2));
  assert.equal(calls, 2);
});

test('the notification says what changed', () => {
  const s = new Store();
  let payload = null;
  s.upsert(msg(1));
  s.subscribe((p) => (payload = p));
  s.patch('m1', { starred: true });
  assert.ok(payload.changed.has('m1'));
  // A field patch is not structural: the list order did not change, so the UI
  // can repaint one row instead of the whole list.
  assert.equal(payload.structural, false);
});

test('adding a message IS structural', () => {
  const s = new Store();
  let payload = null;
  s.subscribe((p) => (payload = p));
  s.upsert(msg(1));
  assert.equal(payload.structural, true);
});

// ------------------------------------------------------------- categories --

test('counts and unread counts are per category', () => {
  const s = new Store();
  s.upsertMany([
    msg(1, { category: 'augsd', unread: true }),
    msg(2, { category: 'augsd', unread: false }),
    msg(3, { category: 'clubs', unread: true }),
  ]);
  assert.deepEqual(s.counts(), { augsd: 2, clubs: 1 });
  assert.deepEqual(s.unreadCounts(), { augsd: 1, clubs: 1 });
});

test('removing the last message of a category drops the map entry', () => {
  // A leftover empty Set would keep counts() walking a phantom category
  // forever — byThread got this discipline, byCategory must too.
  const s = new Store();
  s.upsert(msg(1, { category: 'clubs' }));
  assert.equal(s.counts().clubs, 1);
  s.remove('m1');
  assert.deepEqual(s.counts(), {}, 'no phantom category after the last removal');
});

test('idsFor returns newest-first within a category', () => {
  const s = new Store();
  s.upsertMany([
    msg(1, { category: 'augsd' }),
    msg(5, { category: 'augsd' }),
    msg(3, { category: 'augsd' }),
  ]);
  assert.deepEqual(s.idsFor('augsd'), ['m5', 'm3', 'm1']);
});

// ----------------------------------------------------------------- search --

test('search finds by subject word', () => {
  const s = new Store();
  s.upsertMany([msg(1), msg(2, { subject: 'hostel allotment' })]);
  assert.deepEqual(s.search('hostel'), ['m2']);
});

test('search finds by sender local part', () => {
  const s = new Store();
  s.upsert(msg(1, { from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>' }));
  assert.deepEqual(s.search('augsd'), ['m1']);
});

test('search does prefix matching as you type', () => {
  const s = new Store();
  s.upsert(msg(1, { subject: 'course registration open' }));
  assert.deepEqual(s.search('regis'), ['m1']);
});

test('multiple terms are ANDed', () => {
  const s = new Store();
  s.upsertMany([
    msg(1, { subject: 'hostel allotment notice' }),
    msg(2, { subject: 'hostel mess bill' }),
  ]);
  assert.deepEqual(s.search('hostel allotment'), ['m1']);
});

test('search can be scoped to a category', () => {
  const s = new Store();
  s.upsertMany([
    msg(1, { subject: 'meeting', category: 'clubs' }),
    msg(2, { subject: 'meeting', category: 'augsd' }),
  ]);
  assert.deepEqual(s.search('meeting', 'clubs'), ['m1']);
});

test('empty search returns the category listing', () => {
  const s = new Store();
  s.upsertMany([msg(1), msg(2)]);
  assert.equal(s.search('').length, 2);
  assert.equal(s.search('   ').length, 2);
});

test('search results are newest-first', () => {
  const s = new Store();
  s.upsertMany([msg(1), msg(9), msg(5)]);
  assert.deepEqual(s.search('registration'), ['m9', 'm5', 'm1']);
});

// ------------------------------------------------------------- eviction ----

test('the store caps memory and evicts oldest', () => {
  const s = new Store();
  s.upsertMany(Array.from({ length: 2100 }, (_, i) => msg(i)));
  assert.ok(s.size <= 2000, `size ${s.size}`);
  // Newest survived, oldest went.
  assert.ok(s.get('m2099'));
  assert.equal(s.get('m0'), undefined);
});

test('evicted messages leave no index residue', () => {
  const s = new Store();
  s.upsertMany(Array.from({ length: 2100 }, (_, i) => msg(i)));
  const ids = new Set(s.order);
  for (const [, set] of s.byCategory) {
    for (const id of set) assert.ok(ids.has(id), `stale category entry ${id}`);
  }
  for (const [, set] of s.searchIndex) {
    for (const id of set) assert.ok(ids.has(id), `stale search entry ${id}`);
  }
});

// ---------------------------------------------------------- performance ----

test('PERF: inserting 2000 messages is fast (no full re-sort per insert)', () => {
  // Old version re-sorted the whole array on every insert: O(n^2 log n).
  const msgs = Array.from({ length: 2000 }, (_, i) => msg(i));
  const s = new Store();
  const t0 = performance.now();
  s.upsertMany(msgs);
  const ms = performance.now() - t0;
  assert.equal(s.size, 2000);
  assert.ok(ms < 500, `took ${ms.toFixed(1)}ms`);
});

test('PERF: inserting in random order stays fast', () => {
  // Binary insertion is only a win if it holds up on unsorted input, which is
  // what a real Gmail sync delivers.
  const msgs = Array.from({ length: 2000 }, (_, i) => msg(i));
  for (let i = msgs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [msgs[i], msgs[j]] = [msgs[j], msgs[i]];
  }
  const s = new Store();
  const t0 = performance.now();
  s.upsertMany(msgs);
  const ms = performance.now() - t0;
  assert.ok(ms < 800, `took ${ms.toFixed(1)}ms`);
  // Still correctly ordered.
  for (let i = 1; i < s.order.length; i++) {
    assert.ok(s.get(s.order[i - 1]).date >= s.get(s.order[i]).date);
  }
});

test('PERF: search over 2000 messages is instant', () => {
  const s = new Store();
  s.upsertMany(Array.from({ length: 2000 }, (_, i) => msg(i)));
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) s.search('registration');
  const ms = performance.now() - t0;
  // 50 searches, i.e. a fast typist typing a word.
  assert.ok(ms < 300, `50 searches took ${ms.toFixed(1)}ms`);
});

test('PERF: a single patch does not touch the whole store', () => {
  const s = new Store();
  s.upsertMany(Array.from({ length: 2000 }, (_, i) => msg(i)));
  const t0 = performance.now();
  for (let i = 0; i < 500; i++) s.patch(`m${i}`, { unread: false });
  const ms = performance.now() - t0;
  // 500 individual patches. If this reindexed everything it would be seconds.
  assert.ok(ms < 200, `500 patches took ${ms.toFixed(1)}ms`);
});

test('clear() empties every index and notifies once, structurally', () => {
  // Needed when Gmail says our historyId expired: stale archived mail must not
  // survive the resync.
  const s = new Store();
  s.upsertMany([
    msg('a', { category: 'augsd', subject: 'fee registration' }),
    msg('b', { category: 'clubs', subject: 'audition' }),
  ]);
  let calls = 0;
  let last = null;
  s.subscribe((p) => {
    calls++;
    last = p;
  });

  s.clear();

  assert.equal(calls, 1);
  assert.equal(last.structural, true);
  assert.equal(s.size, 0);
  assert.deepEqual(s.idsFor('all'), []);
  assert.deepEqual(s.counts(), {});
  assert.deepEqual(s.search('registration'), []);
});

test('clear() on an empty store does not fire subscribers', () => {
  const s = new Store();
  let calls = 0;
  s.subscribe(() => calls++);
  s.clear();
  assert.equal(calls, 0);
});

test('idsFor returns a copy, not the live order array', () => {
  // A real bug caught by the jsdom integration harness. The app keeps the
  // result as `renderedIds` to diff the NEXT render against. When idsFor
  // returned `this.order` itself, `renderedIds` and `store.order` became the
  // same object, so every subsequent "has the list changed?" check compared
  // the array to itself and said no. Removing a message updated the store and
  // never touched the DOM: archiving looked like it did nothing at all.
  const s = new Store();
  s.upsertMany([msg('a'), msg('b'), msg('c')]);

  const snapshot = s.idsFor('all');
  assert.equal(snapshot.length, 3);
  assert.notEqual(snapshot, s.order, 'must not be the same object reference');

  s.remove(snapshot[0]);

  assert.equal(snapshot.length, 3, 'the caller-held snapshot must not mutate');
  assert.equal(s.idsFor('all').length, 2, 'a fresh call reflects the removal');
});

test('mutating the array idsFor returned cannot corrupt the store', () => {
  const s = new Store();
  s.upsertMany([msg('a'), msg('b')]);
  const ids = s.idsFor('all');
  ids.push('injected');
  ids.length = 0;
  assert.equal(s.size, 2, 'store survives a caller abusing the returned array');
  assert.equal(s.idsFor('all').length, 2);
});

test('a changed date re-positions the message and keeps order sorted', () => {
  // upsert() used to comment "date is immutable for a given message, so the
  // order array stands" and skip re-positioning. It is not immutable: cache.js
  // persists `date`, and a delta re-fetches and re-upserts the same ids, so any
  // drift reorders that message.
  //
  // The damage is not one row out of place. `_insertOrdered` is a BINARY
  // SEARCH, which requires `order` to be sorted -- once it is not, every
  // subsequent insert lands in the wrong slot and the list never repairs
  // itself.
  const s = new Store();
  s.upsertMany([msg(1, { date: 300 }), msg(2, { date: 200 }), msg(3, { date: 100 })]);

  s.upsert(msg(3, { date: 999 })); // same id, now the newest
  s.upsert(msg(4, { date: 250 })); // must still land correctly

  const dates = s.idsFor('all').map((id) => s.get(id).date);
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a), 'order must stay newest-first');
  assert.equal(s.order.length, s.size, 'no duplicate or orphaned entries');
  assert.equal(new Set(s.order).size, s.order.length, 'no id appears twice');
});

test('re-upserting with an unchanged date does not touch the order array', () => {
  // The common case: a delta re-fetches a message we already have. Splicing on
  // every re-upsert would make an idempotent sync O(n) per message.
  const s = new Store();
  s.upsertMany([msg(1), msg(2), msg(3)]);
  const before = s.idsFor('all');
  s.upsert(msg(2, { unread: true }));
  assert.deepEqual(s.idsFor('all'), before);
  assert.equal(s.get('m2').unread, true, 'the field still updated');
});

/* ========================================================================== *
 * ORDERING INVARIANTS UNDER STRESS
 *
 * `order` is kept sorted and `_insertOrdered` BINARY SEARCHES it. That makes
 * sortedness a load-bearing invariant, not a nicety: one out-of-place entry
 * sends every subsequent insert to the wrong slot, and the list silently
 * mis-orders itself for the rest of the session with no way to recover.
 *
 * `upsert` was fixed for a changed date. `patch` was not — the same
 * corruption through a second door, found by stress testing. No caller
 * patched `date` at the time, but "no caller does X" is a coincidence, not an
 * invariant.
 * ========================================================================== */

const stressMsg = (i, extra = {}) => ({
  id: `m${i}`, threadId: `t${i}`, from: `s${i}@x.com`, subject: `Subject ${i}`,
  snippet: 'x', date: 1700000000000 + i * 1000,
  unread: false, starred: false, category: 'other', confidence: 1, ...extra,
});

/** The invariant every test below shares. */
function assertSorted(store, why) {
  const ids = store.idsFor('all');
  assert.equal(new Set(ids).size, ids.length, `${why}: duplicate ids in order`);
  for (let i = 1; i < ids.length; i++) {
    assert.ok(
      store.get(ids[i - 1]).date >= store.get(ids[i]).date,
      `${why}: order is not newest-first at index ${i}`
    );
  }
}

test('patch() repositions a message whose date moved', () => {
  const s = new Store();
  for (let i = 0; i < 50; i++) s.upsert(stressMsg(i));

  s.patch('m10', { date: 1700000000000 + 99999 * 1000 }); // now the newest
  s.patch('m20', { date: 1 });                            // now the oldest

  const ids = s.idsFor('all');
  assert.equal(ids[0], 'm10', 'the newest message must sort first');
  assert.equal(ids[ids.length - 1], 'm20', 'the oldest must sort last');
  assert.equal(s.size, 50, 'repositioning must not add or drop messages');
  assertSorted(s, 'after patching dates');
});

test('a date patch does not corrupt LATER inserts', () => {
  // The real damage: an unsorted array makes the binary search unsound, so
  // the next message inserted lands in the wrong slot.
  const s = new Store();
  for (let i = 0; i < 20; i++) s.upsert(stressMsg(i));
  s.patch('m10', { date: 1700000000000 + 99999 * 1000 });
  s.upsert(stressMsg(500, { date: 1700000000000 + 50000 * 1000 }));
  assertSorted(s, 'after inserting into a previously patched store');
});

test('a patch that does not touch the date leaves order untouched', () => {
  const s = new Store();
  for (let i = 0; i < 20; i++) s.upsert(stressMsg(i));
  const before = s.idsFor('all').join(',');
  s.patch('m5', { unread: true, starred: true });
  assert.equal(s.get('m5').unread, true);
  assert.equal(s.idsFor('all').join(','), before, 'a field patch must not reorder');
});

test('patching a date to its current value is a no-op', () => {
  const s = new Store();
  for (let i = 0; i < 10; i++) s.upsert(stressMsg(i));
  const before = s.idsFor('all').join(',');
  s.patch('m5', { date: s.get('m5').date });
  assert.equal(s.idsFor('all').join(','), before);
});

test('a date patch keeps the search index consistent', () => {
  const s = new Store();
  s.upsert(stressMsg(1, { subject: 'Registration deadline' }));
  s.patch('m1', { date: 1 });
  assert.equal(s.search('registration', 'all').length, 1, 'reindexing lost the message');
});

test('ordering survives 2500 upserts past the cap', () => {
  const s = new Store();
  for (let i = 0; i < 2500; i++) s.upsert(stressMsg(i));
  assert.ok(s.size <= 2000, `cap not enforced: ${s.size}`);
  assert.equal(s.idsFor('all').length, s.size, 'order and byId disagree');
  assertSorted(s, 'after exceeding the cap');
});

test('ordering survives heavy remove/re-add churn', () => {
  const s = new Store();
  for (let i = 0; i < 200; i++) s.upsert(stressMsg(i));
  for (let i = 0; i < 200; i += 2) s.remove(`m${i}`);
  for (let i = 0; i < 200; i += 2) s.upsert(stressMsg(i));
  assert.equal(s.size, 200, 'churn lost or duplicated messages');
  assertSorted(s, 'after churn');
});

test('messages sharing an identical date are all retained', () => {
  // A tie-break bug here silently drops mail that arrived in the same second.
  const s = new Store();
  for (let i = 0; i < 100; i++) s.upsert(stressMsg(i, { date: 1700000000000 }));
  assert.equal(s.size, 100);
  assert.equal(new Set(s.idsFor('all')).size, 100, 'identical dates produced duplicates');
});

test('remove and patch of an unknown id are safe no-ops', () => {
  const s = new Store();
  s.upsert(stressMsg(1));
  assert.doesNotThrow(() => s.remove('nope'));
  assert.doesNotThrow(() => s.patch('nope', { unread: true }));
  assert.doesNotThrow(() => s.patch('nope', { date: 123 }));
  assert.equal(s.size, 1);
});

test('a randomised sequence of operations never breaks the invariant', () => {
  /*
   * Property-based: the specific sequences above were chosen by a human and
   * therefore reflect what a human thought to try. This one does not.
   */
  const s = new Store();
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

  for (let step = 0; step < 3000; step++) {
    const id = rnd(300);
    switch (rnd(4)) {
      case 0: s.upsert(stressMsg(id)); break;
      case 1: s.remove(`m${id}`); break;
      case 2: s.patch(`m${id}`, { unread: rnd(2) === 0 }); break;
      case 3: s.patch(`m${id}`, { date: 1700000000000 + rnd(100000) * 1000 }); break;
    }
  }
  assertSorted(s, 'after 3000 random operations');
  assert.equal(s.idsFor('all').length, s.size, 'order and byId diverged');
  for (const id of s.idsFor('all')) {
    assert.ok(s.get(id), `order references ${id}, which byId does not have`);
  }
});

/* ================================================================ threading == */

test('THREAD: messages sharing a threadId form one conversation', () => {
  /*
   * The index is maintained INCREMENTALLY, like byCategory and searchIndex.
   * Rebuilding a thread map on every render was the obvious implementation and
   * is O(n) per keystroke; this store's whole design is that nothing is
   * recomputed wholesale.
   */
  const s = new Store();
  s.upsertMany([
    { id: 'a', threadId: 'T1', from: 'X <x@b.c>', subject: 'Schedule', snippet: '1', date: 30, unread: true, category: 'augsd' },
    { id: 'b', threadId: 'T1', from: 'Y <y@b.c>', subject: 'Re: Schedule', snippet: '2', date: 20, unread: false, category: 'augsd' },
    { id: 'c', threadId: 'T2', from: 'Z <z@b.c>', subject: 'Other', snippet: '3', date: 10, unread: false, category: 'other' },
  ]);

  assert.deepEqual(s.threadIds('T1'), ['a', 'b'], 'newest first, like every other order here');
  assert.deepEqual(s.threadIds('T2'), ['c']);
  assert.deepEqual(s.threadIds('nope'), [], 'an unknown thread is empty, not undefined');
});

test('THREAD: the roots list collapses a conversation to one entry', () => {
  // What the list renders. Three messages in one conversation must occupy one
  // row, and that row must sit at the position of the NEWEST message -- a
  // conversation is as recent as its latest reply.
  const s = new Store();
  s.upsertMany([
    { id: 'old', threadId: 'T1', from: 'X <x@b.c>', subject: 'S', snippet: '', date: 5, unread: false, category: 'augsd' },
    { id: 'mid', threadId: 'T2', from: 'Y <y@b.c>', subject: 'Other', snippet: '', date: 50, unread: false, category: 'other' },
    { id: 'new', threadId: 'T1', from: 'Z <z@b.c>', subject: 'Re: S', snippet: '', date: 90, unread: false, category: 'augsd' },
  ]);

  assert.deepEqual(
    s.rootIds(), ['new', 'mid'],
    'one row per conversation, ordered by its most recent message'
  );
});

test('THREAD: a conversation summarises its own state', () => {
  /*
   * A thread is a first-class object, not a bag of ids. The row needs to show
   * unread state, participant count and attachment presence without the
   * renderer walking the messages itself on every paint.
   */
  const s = new Store();
  s.upsertMany([
    { id: 'a', threadId: 'T1', from: 'Ann <a@b.c>', subject: 'Schedule', snippet: 'first', date: 10, unread: false, category: 'augsd' },
    { id: 'b', threadId: 'T1', from: 'Bob <b@b.c>', subject: 'Re: Schedule', snippet: 'second', date: 20, unread: true, category: 'augsd', hasAttachment: true },
    { id: 'c', threadId: 'T1', from: 'Ann <a@b.c>', subject: 'Re: Schedule', snippet: 'third', date: 30, unread: true, category: 'augsd' },
  ]);

  const t = s.thread('T1');
  assert.equal(t.count, 3);
  assert.equal(t.unread, 2, 'unread is a COUNT, not a boolean');
  assert.equal(t.latestId, 'c', 'the newest message drives the row');
  assert.equal(t.hasAttachment, true, 'true if ANY message carries one');
  assert.deepEqual(t.participants, ['Ann', 'Bob'], 'deduplicated, in first-seen order');
  assert.equal(t.subject, 'Schedule', 'the ORIGINAL subject, without the Re:');
});

test('THREAD: removing the last message removes the conversation', () => {
  // The index must not leak empty threads. An empty Set left behind would
  // render a row for a conversation with nothing in it.
  const s = new Store();
  s.upsertMany([
    { id: 'a', threadId: 'T1', from: 'X <x@b.c>', subject: 'S', snippet: '', date: 10, unread: false, category: 'augsd' },
    { id: 'b', threadId: 'T1', from: 'Y <y@b.c>', subject: 'S', snippet: '', date: 20, unread: false, category: 'augsd' },
  ]);
  s.remove('b');
  assert.deepEqual(s.threadIds('T1'), ['a'], 'the survivor remains');
  assert.equal(s.thread('T1').count, 1);

  s.remove('a');
  assert.deepEqual(s.threadIds('T1'), [], 'and the thread is gone entirely');
  assert.equal(s.thread('T1'), null);
  assert.deepEqual(s.rootIds(), [], 'with no phantom row left behind');
});

test('THREAD: a message that changes thread moves between conversations', () => {
  /*
   * THE MERGE/SPLIT CASE. Gmail reassigns threadId when it decides two
   * conversations are one -- a delta sync then re-upserts the same id with a
   * different threadId. Without handling it, the message appears in BOTH
   * threads forever, because the old Set was never cleaned.
   */
  const s = new Store();
  s.upsert({ id: 'a', threadId: 'T1', from: 'X <x@b.c>', subject: 'S', snippet: '', date: 10, unread: false, category: 'augsd' });
  s.upsert({ id: 'b', threadId: 'T2', from: 'Y <y@b.c>', subject: 'S', snippet: '', date: 20, unread: false, category: 'augsd' });

  // Gmail merges them: 'a' now belongs to T2.
  s.upsert({ id: 'a', threadId: 'T2', from: 'X <x@b.c>', subject: 'S', snippet: '', date: 10, unread: false, category: 'augsd' });

  assert.deepEqual(s.threadIds('T1'), [], 'the old conversation must not keep it');
  assert.deepEqual(s.threadIds('T2'), ['b', 'a'], 'the new one gains it, in date order');
  assert.equal(s.thread('T1'), null, 'and the emptied thread disappears');
});

test('THREAD: a message with no threadId is its own conversation', () => {
  // Locally-built records and older cache entries may lack one. Falling back
  // to the message id keeps them renderable rather than collapsing every
  // unthreaded message into one giant bogus conversation.
  const s = new Store();
  s.upsertMany([
    { id: 'a', from: 'X <x@b.c>', subject: 'One', snippet: '', date: 10, unread: false, category: 'augsd' },
    { id: 'b', from: 'Y <y@b.c>', subject: 'Two', snippet: '', date: 20, unread: false, category: 'augsd' },
  ]);
  assert.deepEqual(s.rootIds(), ['b', 'a'], 'two separate rows, not one');
  assert.equal(s.thread('a').count, 1);
});

test('THREAD: emptied conversations do not accumulate in the index', () => {
  /*
   * SABOTAGE EXPOSED THIS TEST AS MISSING.
   *
   * Deleting the `byThread.delete(tid)` line changed NO observable behaviour:
   * threadIds() and thread() both guard on `size === 0`, so an empty Set reads
   * exactly like an absent one. Every behavioural test still passed.
   *
   * The cost is memory, not correctness. A long-lived tab archives thousands
   * of conversations, and each one would leave a permanent empty Set keyed by
   * a threadId that no longer exists -- an unbounded leak in the one structure
   * that is never rebuilt. The store's whole design is incremental indexes, so
   * an index that only ever grows is a real defect.
   *
   * This asserts on the index itself, which is the only place it is visible.
   */
  const s = new Store();
  for (let i = 0; i < 50; i++) {
    s.upsert({
      id: `m${i}`, threadId: `T${i}`, from: 'X <x@b.c>',
      subject: 'S', snippet: '', date: i, unread: false, category: 'augsd',
    });
  }
  assert.equal(s.byThread.size, 50, 'precondition: fifty conversations');

  for (let i = 0; i < 50; i++) s.remove(`m${i}`);

  assert.equal(
    s.byThread.size, 0,
    'archiving every conversation must not leave 50 empty Sets behind'
  );
});

test('patching snippet reindexes the search terms (bug-hunt #19)', () => {
  // tokenize() indexes subject + from + SNIPPET, so a snippet patch that
  // skipped reindexing would leave the index describing text the message no
  // longer has: searchable after it was edited away, unsearchable after it
  // was edited in.
  const s = new Store();
  s.upsert({ id: 'a', threadId: 'a', from: 'x@y.com', subject: 'hi',
    snippet: 'the original body words', date: 1, unread: true, starred: false,
    category: 'augsd', confidence: 0.9, reason: 'r' });

  assert.deepEqual(s.search('original'), ['a']);
  s.patch('a', { snippet: 'a completely replaced text' });
  assert.deepEqual(s.search('original'), [], 'old snippet text must leave the index');
  assert.deepEqual(s.search('replaced'), ['a'], 'new snippet text must enter it');
});

test('derived reads are memoised per version and invalidated by mutation (arch A7)', () => {
  const s = new Store();
  s.upsert({ id: 'a', threadId: 'a', from: 'x@y.com', subject: 'hi', snippet: '',
    date: 5, unread: true, starred: false, category: 'augsd', confidence: 0.9, reason: 'r' });
  const c1 = s.counts();
  assert.equal(s.counts(), c1, 'same version, same object');
  s.upsert({ id: 'b', threadId: 'b', from: 'x@y.com', subject: 'yo', snippet: '',
    date: 6, unread: false, starred: false, category: 'augsd', confidence: 0.9, reason: 'r' });
  const c2 = s.counts();
  assert.notEqual(c2, c1, 'a mutation bumps the version and busts the memo');
  assert.equal(c2.augsd, 2);
  /*
   * Category slices memoise too — but the CALLER never receives the memo
   * itself (audit EXT2-H3). This assertion used to be reference-equality,
   * which pinned exactly the aliasing hazard the 'all' path had already been
   * fixed for: `idsFor('augsd').push(x)` corrupted every later read of that
   * category until the next flush, and `.length = 0` made it read empty.
   *
   * So the contract under test is now the right one: equal CONTENTS from the
   * memo, a fresh array each call, and mutation of a handed-out copy leaving
   * the store untouched. The memo is still proven to exist by the version
   * cache below — a recompute would have to walk `order` again.
   */
  const ids1 = s.idsFor('augsd');
  const ids2 = s.idsFor('augsd');
  assert.deepEqual(ids2, ids1, 'same version, same contents');
  assert.notEqual(ids2, ids1, 'but never the same array — the memo is not the callers');
  assert.ok(s._memo.has('ids:augsd'), 'the slice is genuinely memoised, not recomputed blind');
  ids1.push('POISON');
  ids1.sort();
  assert.deepEqual(s.idsFor('augsd'), ['b', 'a'], 'mutating a handed-out copy cannot reach the store');
  s.remove('b');
  assert.deepEqual(s.idsFor('augsd'), ['a'], 'removal busts the slice memo');
});

/* ==========================================================================
 * UNICODE SEARCH RECALL (audit R3-02)
 *
 * The tokeniser split on [^a-z0-9@.-], so every non-ASCII character was a
 * SEPARATOR: "Café" indexed as `caf` and matched neither "café" nor "cafe",
 * and a fully non-Latin subject indexed to NOTHING at all. Because tokenize
 * is deliberately the one definition of searchable text, lane membership and
 * the rail counts inherited the same blindness.
 *
 * The existing fuzz suite fed Unicode in and asserted TOTALITY -- that
 * nothing threw. These assert RECALL, which is the property that was
 * actually broken. That distinction is the lesson: a property test only
 * defends the property it states.
 * ========================================================================== */
test('search recalls non-ASCII subjects (audit R3-02)', () => {
  const s = new Store();
  const rows = [
    ['Café update', 'café'],
    ['naïve résumé', 'naïve'],
    ['Zürich trip', 'Zürich'],
    ['señor garcía', 'señor'],
    ['ÅÄÖ nordic', 'ÅÄÖ'],
    ['Ελληνικά νέα', 'Ελληνικά'],
    ['Привет мир', 'Привет'],
    ['छात्रावास सूचना', 'छात्रावास'],
    ['日本語 メール', '日本語'],
  ];
  rows.forEach(([subject], i) => s.upsert({
    id: `u${i}`, threadId: `t${i}`, from: 'a@b.c',
    subject, snippet: '', date: i, category: 'academics',
  }));

  for (const [subject, query] of rows) {
    assert.equal(s.search(query).length, 1, `"${query}" must find "${subject}"`);
  }
});

test('accent folding works in BOTH directions (audit R3-02)', () => {
  const s = new Store();
  s.upsert({ id: 'a', threadId: 't', from: 'Zoë <z@x.com>',
    subject: 'Café résumé deadline', snippet: '', date: 1, category: 'academics' });

  // Typed without the accent, stored with it -- and the reverse.
  for (const q of ['cafe', 'café', 'resume', 'résumé', 'zoe', 'zoë']) {
    assert.equal(s.search(q).length, 1, `"${q}" must fold to a hit`);
  }
});

test('folding never rewrites Indic vowel signs (audit R3-02)', () => {
  // A blanket \p{Diacritic} strip turned छात्रावास into छातरावास -- a
  // different word nobody will ever type. Marks are dropped only when the
  // base character is Latin.
  assert.equal(Store.foldTerm('छात्रावास'), 'छात्रावास');
  assert.equal(Store.foldTerm('Café'), 'cafe');
});

test('CJK is reachable by a two-character query (audit R3-02)', () => {
  const s = new Store();
  s.upsert({ id: 'j', threadId: 'tj', from: 'a@b.c',
    subject: '日本語のメール', snippet: '', date: 1, category: 'academics' });
  assert.equal(s.search('日本').length, 1, 'a bigram must hit a space-less script');
});

test('a partial token does not produce a spurious hit (audit R3-02)', () => {
  // "Zürich" used to index as `rich`, so searching "rich" wrongly matched.
  const s = new Store();
  s.upsert({ id: 'z', threadId: 'tz', from: 'a@b.c',
    subject: 'Zürich trip', snippet: '', date: 1, category: 'academics' });
  assert.equal(s.search('rich').length, 0, 'the umlaut must not shatter the word');
});

test('upsertMany reports what survived eviction (audit R3-08)', () => {
  const s = new Store();
  // Fill to the cap with recent mail.
  const recent = Array.from({ length: MAX_MESSAGES }, (_, i) => ({
    id: `r${i}`, threadId: `tr${i}`, from: 'a@b.c', subject: 's', snippet: '',
    date: 1_000_000 + i, category: 'academics',
  }));
  assert.equal(s.upsertMany(recent), MAX_MESSAGES);
  assert.equal(s.isFull, true);

  // Paging backwards appends OLDER mail, which eviction drops immediately.
  // Reporting 0 is what lets the pager stop lying about "Load more".
  const older = [{ id: 'ancient', threadId: 'ta', from: 'a@b.c', subject: 'old',
    snippet: '', date: 1, category: 'academics' }];
  assert.equal(s.upsertMany(older), 0, 'an evicted insert must not count as kept');
  assert.equal(s.get('ancient'), undefined);
});
