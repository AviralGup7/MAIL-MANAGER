/**
 * Store tests.
 *
 * The performance tests here are the point of the file. The old version's
 * slowness was structural — full index rebuild + full re-render + whole-array
 * write on every batch — so these assert the structure, not just the results.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/app/store.js';

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
