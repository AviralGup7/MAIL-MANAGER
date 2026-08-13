/**
 * Triage lane tests.
 *
 * The lane that must never be wrong is `needsReply`. A false positive there
 * makes the lane noise; a false negative means the user does not answer
 * someone who wrote to them. Most of these tests are about its boundaries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { laneOf, partition, laneCounts, answeredPredicate, LANES, LANE_LABELS } =
  await import('../src/app/academic/lanes.js');

const ME = 'f20240294@pilani.bits-pilani.ac.in';
const ctx = (over = {}) => ({ self: ME, now: 1_700_000_000_000, ...over });
const msg = (o) => ({ id: 'x', subject: '', snippet: '', from: 'a@b.com', date: 1, ...o });

// -------------------------------------------------------------- the cascade --

test('a deadline outranks needs-reply', () => {
  const m = msg({ to: ME, unread: true, dueAt: 1_700_000_100_000 });
  assert.equal(laneOf(m, ctx()), 'deadlines');
});

test('an OVERDUE deadline stays in the deadline lane, it does not vanish', () => {
  // Dropping an expired deadline is how a system stops mentioning what you missed.
  const m = msg({ to: ME, dueAt: 1_699_999_000_000 });
  assert.equal(laneOf(m, ctx()), 'deadlines');
});

test('a deadline older than a week ages out of the lane', () => {
  const m = msg({ to: 'students@x.com', dueAt: 1_700_000_000_000 - 8 * 24 * 3600 * 1000 });
  assert.notEqual(laneOf(m, ctx()), 'deadlines');
});

test('promotional mail is a newsletter even when addressed to me', () => {
  const m = msg({ to: ME, unread: true, category: 'external-promotions' });
  assert.equal(laneOf(m, ctx()), 'newsletters');
});

test('spam never reaches a working lane', () => {
  assert.equal(laneOf(msg({ to: ME, unread: true, category: 'spam' }), ctx()), 'newsletters');
});

// ----------------------------------------------------------- needs reply --

test('unread mail addressed to me needs a reply', () => {
  assert.equal(laneOf(msg({ to: ME, unread: true }), ctx()), 'needsReply');
});

test('READ mail addressed to me does NOT need a reply unless it asks', () => {
  // Read-and-not-answered is a conscious decision; the lane must not nag.
  assert.equal(laneOf(msg({ to: ME, unread: false }), ctx()), 'announcements');
});

test('read mail that explicitly asks for something still needs a reply', () => {
  const m = msg({ to: ME, unread: false, snippet: 'Kindly confirm your attendance by Friday.' });
  assert.equal(laneOf(m, ctx()), 'needsReply');
});

test('a marketing question mark is NOT a request', () => {
  // The loose "contains ?" heuristic would put this in needsReply. It must not.
  const m = msg({ to: ME, unread: false, subject: 'Ready for your next internship?' });
  assert.equal(laneOf(m, ctx()), 'announcements');
});

test('mail I have already answered leaves the needs-reply lane', () => {
  const m = msg({ to: ME, unread: true });
  assert.equal(laneOf(m, ctx({ isAnswered: () => true })), 'announcements');
});

test('being Cc\'d is not a request', () => {
  assert.equal(laneOf(msg({ to: 'other@x.com', cc: ME, unread: true }), ctx()), 'announcements');
});

test('a list blast is an announcement, not a reply request', () => {
  const m = msg({ to: 'students@pilani.bits-pilani.ac.in', unread: true });
  assert.equal(laneOf(m, ctx()), 'announcements');
});

// ------------------------------------------------------------- partition --

test('every lane is returned even when empty', () => {
  const out = partition([], () => undefined, ctx());
  assert.deepEqual(out.map((g) => g.lane), [...LANES]);
  assert.ok(out.every((g) => g.ids.length === 0));
});

test('a message lands in exactly one lane', () => {
  const msgs = {
    a: msg({ id: 'a', to: ME, unread: true, dueAt: 1_700_000_100_000 }),
    b: msg({ id: 'b', to: ME, unread: true }),
    c: msg({ id: 'c', to: 'students@x.com' }),
    d: msg({ id: 'd', category: 'external-promotions' }),
  };
  const out = partition(['a', 'b', 'c', 'd'], (id) => msgs[id], ctx());
  const total = out.reduce((n, g) => n + g.ids.length, 0);
  assert.equal(total, 4, 'no message counted twice, none dropped');
  const where = Object.fromEntries(out.flatMap((g) => g.ids.map((i) => [i, g.lane])));
  assert.deepEqual(where, { a: 'deadlines', b: 'needsReply', c: 'announcements', d: 'newsletters' });
});

test('input order is preserved within a lane', () => {
  const msgs = {
    a: msg({ id: 'a', to: ME, unread: true }),
    b: msg({ id: 'b', to: ME, unread: true }),
    c: msg({ id: 'c', to: ME, unread: true }),
  };
  const out = partition(['c', 'a', 'b'], (id) => msgs[id], ctx());
  assert.deepEqual(out.find((g) => g.lane === 'needsReply').ids, ['c', 'a', 'b']);
});

test('ids missing from the store are skipped, not crashed on', () => {
  assert.doesNotThrow(() => partition(['ghost'], () => undefined, ctx()));
});

test('every lane has a label', () => {
  for (const l of LANES) assert.equal(typeof LANE_LABELS[l], 'string');
});

// ---------------------------------------------------------------- counts --

test('lane counts count UNREAD only', () => {
  const msgs = {
    a: msg({ id: 'a', to: ME, unread: true }),
    b: msg({ id: 'b', to: ME, unread: false }),
  };
  const counts = laneCounts(['a', 'b'], (id) => msgs[id], ctx());
  assert.equal(counts.needsReply, 1);
  assert.equal(counts.announcements, 0, 'the read one is present but not counted');
});

// ------------------------------------------------------------- answered --

test('answeredPredicate sees a later reply from me', () => {
  const store = {
    threadIds: () => ['m1', 'm2'],
    get: (id) => ({
      m1: { id: 'm1', from: 'prof@x.com', date: 100 },
      m2: { id: 'm2', from: `Aviral <${ME}>`, date: 200 },
    }[id]),
  };
  const answered = answeredPredicate(store, ME);
  assert.equal(answered({ id: 'm1', threadId: 't', date: 100 }), true);
});

test('answeredPredicate ignores an EARLIER message from me', () => {
  // My old message does not answer their new one.
  const store = {
    threadIds: () => ['m1', 'm2'],
    get: (id) => ({
      m1: { id: 'm1', from: `Aviral <${ME}>`, date: 100 },
      m2: { id: 'm2', from: 'prof@x.com', date: 200 },
    }[id]),
  };
  assert.equal(answeredPredicate(store, ME)({ id: 'm2', threadId: 't', date: 200 }), false);
});

test('answeredPredicate is false with no self and never throws on a bare store', () => {
  assert.equal(answeredPredicate({}, '')({ threadId: 't' }), false);
  assert.equal(answeredPredicate({}, ME)({ threadId: 't' }), false);
});
