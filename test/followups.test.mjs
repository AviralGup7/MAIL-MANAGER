/**
 * Follow-up tests.
 *
 * The feature's whole claim is that it RESOLVES ITSELF when a reply arrives.
 * If that is wrong in either direction the feature is worse than useless: a
 * follow-up that nags after the professor answered gets switched off, and one
 * that clears without an answer defeats the point.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStorage } from './helpers/storage.mjs';

const {
  setFollowup, clearFollowup, hasFollowup, isAnswered, dueFollowups,
  openFollowups, pruneFollowups, normaliseFollowups, loadFollowups,
  saveFollowups, asRadarItem, PRESETS,
} = await import('../src/app/academic/followups.js');

const ME = 'f20240294@pilani.bits-pilani.ac.in';
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

/** A store double with a thread index, like the real one. */
function storeOf(messages) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  return {
    get: (id) => byId.get(id),
    threadIds: (t) => messages.filter((m) => m.threadId === t).map((m) => m.id),
  };
}

// -------------------------------------------------------------- lifecycle --

test('a follow-up can be set and read back', () => {
  const list = setFollowup([], { threadId: 't1', messageId: 'm1', dueAt: NOW + DAY }, NOW);
  assert.equal(hasFollowup(list, 't1'), true);
});

test('setting a second follow-up on a thread REPLACES the first', () => {
  let list = setFollowup([], { threadId: 't1', dueAt: NOW + DAY }, NOW);
  list = setFollowup(list, { threadId: 't1', dueAt: NOW + 5 * DAY }, NOW);
  assert.equal(list.length, 1);
  assert.equal(list[0].dueAt, NOW + 5 * DAY);
});

test('clearing removes it', () => {
  const list = clearFollowup(setFollowup([], { threadId: 't1', dueAt: NOW }, NOW), 't1');
  assert.equal(hasFollowup(list, 't1'), false);
});

test('a follow-up with no thread or no date is refused', () => {
  assert.deepEqual(setFollowup([], { dueAt: NOW }, NOW), []);
  assert.deepEqual(setFollowup([], { threadId: 't1' }, NOW), []);
});

// ------------------------------------------------------------- resolution --

test('a reply FROM SOMEONE ELSE resolves the follow-up', () => {
  const store = storeOf([
    { id: 'm1', threadId: 't1', from: ME, date: NOW - DAY },
    { id: 'm2', threadId: 't1', from: 'prof@bits.ac.in', date: NOW + 1000 },
  ]);
  const [f] = setFollowup([], { threadId: 't1', messageId: 'm1', dueAt: NOW + DAY }, NOW);
  assert.equal(isAnswered(f, store, ME), true);
});

test('MY OWN NUDGE DOES NOT RESOLVE IT', () => {
  // Chasing someone is not the same as being answered.
  const store = storeOf([
    { id: 'm1', threadId: 't1', from: ME, date: NOW - DAY },
    { id: 'm2', threadId: 't1', from: `Aviral <${ME}>`, date: NOW + 1000 },
  ]);
  const [f] = setFollowup([], { threadId: 't1', messageId: 'm1', dueAt: NOW + DAY }, NOW);
  assert.equal(isAnswered(f, store, ME), false);
});

test('A REPLY THAT PREDATES THE FOLLOW-UP DOES NOT RESOLVE IT', () => {
  /*
   * People set follow-ups while reading an old thread. Comparing against the
   * original message date instead of the follow-up's creation would resolve it
   * instantly using a reply that arrived before the user even asked.
   */
  const store = storeOf([
    { id: 'm1', threadId: 't1', from: ME, date: NOW - 10 * DAY },
    { id: 'm2', threadId: 't1', from: 'prof@bits.ac.in', date: NOW - 5 * DAY },
  ]);
  const [f] = setFollowup([], { threadId: 't1', messageId: 'm1', dueAt: NOW + DAY }, NOW);
  assert.equal(isAnswered(f, store, ME), false);
});

test('an unthreaded or unknown store never resolves and never throws', () => {
  const [f] = setFollowup([], { threadId: 't1', dueAt: NOW }, NOW);
  assert.equal(isAnswered(f, {}, ME), false);
  assert.equal(isAnswered(f, null, ME), false);
});

// -------------------------------------------------------------------- due --

test('only follow-ups past their date are due', () => {
  const store = storeOf([{ id: 'm1', threadId: 't1', from: ME, date: NOW }]);
  let list = setFollowup([], { threadId: 't1', messageId: 'm1', dueAt: NOW + DAY }, NOW);
  assert.deepEqual(dueFollowups(list, store, ME, NOW), []);
  assert.equal(dueFollowups(list, store, ME, NOW + 2 * DAY).length, 1);
});

test('an answered follow-up is never due, even past its date', () => {
  const store = storeOf([
    { id: 'm1', threadId: 't1', from: ME, date: NOW },
    { id: 'm2', threadId: 't1', from: 'prof@x', date: NOW + 100 },
  ]);
  const list = setFollowup([], { threadId: 't1', messageId: 'm1', dueAt: NOW + DAY }, NOW);
  assert.deepEqual(dueFollowups(list, store, ME, NOW + 5 * DAY), []);
});

test('due follow-ups come back oldest first', () => {
  const store = storeOf([
    { id: 'a', threadId: 't1', from: ME, date: NOW },
    { id: 'b', threadId: 't2', from: ME, date: NOW },
  ]);
  let list = setFollowup([], { threadId: 't1', messageId: 'a', dueAt: NOW + 2 * DAY }, NOW);
  list = setFollowup(list, { threadId: 't2', messageId: 'b', dueAt: NOW + DAY }, NOW);
  const due = dueFollowups(list, store, ME, NOW + 5 * DAY);
  assert.deepEqual(due.map((f) => f.threadId), ['t2', 't1']);
});

test('openFollowups shows outstanding items that are not yet due', () => {
  const store = storeOf([{ id: 'm1', threadId: 't1', from: ME, date: NOW }]);
  const list = setFollowup([], { threadId: 't1', messageId: 'm1', dueAt: NOW + 5 * DAY }, NOW);
  assert.equal(openFollowups(list, store, ME).length, 1);
});

// ---------------------------------------------------------------- pruning --

test('pruning drops answered follow-ups', () => {
  const store = storeOf([
    { id: 'm1', threadId: 't1', from: ME, date: NOW },
    { id: 'm2', threadId: 't1', from: 'prof@x', date: NOW + 100 },
  ]);
  const list = setFollowup([], { threadId: 't1', messageId: 'm1', dueAt: NOW + DAY }, NOW);
  assert.deepEqual(pruneFollowups(list, store, ME), []);
});

test('pruning drops follow-ups whose thread has left the mailbox', () => {
  const list = setFollowup([], { threadId: 'gone', messageId: 'm', dueAt: NOW }, NOW);
  assert.deepEqual(pruneFollowups(list, storeOf([]), ME), []);
});

test('pruning keeps a live, unanswered follow-up', () => {
  const store = storeOf([{ id: 'm1', threadId: 't1', from: ME, date: NOW }]);
  const list = setFollowup([], { threadId: 't1', messageId: 'm1', dueAt: NOW + DAY }, NOW);
  assert.equal(pruneFollowups(list, store, ME).length, 1);
});

// --------------------------------------------------------------- storage --

test('a corrupt blob degrades to empty', () => {
  for (const bad of [null, 'x', 7, {}, [null], [{ threadId: 5 }], [{ threadId: 't', dueAt: 'soon' }]]) {
    assert.deepEqual(normaliseFollowups(bad), []);
  }
});

test('duplicate threads are collapsed on load', () => {
  const out = normaliseFollowups([
    { threadId: 't1', dueAt: 1 },
    { threadId: 't1', dueAt: 2 },
  ]);
  assert.equal(out.length, 1);
});

test('follow-ups round-trip through storage', async () => {
  const s = fakeStorage();
  await saveFollowups(setFollowup([], { threadId: 't1', messageId: 'm', dueAt: NOW }, NOW), s);
  const back = await loadFollowups(s);
  assert.equal(back[0].threadId, 't1');
});

test('a failing storage write reports false', async () => {
  assert.equal(await saveFollowups([{ threadId: 't', dueAt: 1 }], fakeStorage()._fail()), false);
});

// ----------------------------------------------------------------- radar --

test('a follow-up renders as a radar item without the radar knowing what it is', () => {
  // The "radar wants to be multi-source" refactor, done for its first consumer.
  const store = storeOf([{ id: 'm1', threadId: 't1', from: ME, to: 'prof@x', subject: 'Extension request', date: NOW }]);
  const [f] = setFollowup([], { threadId: 't1', messageId: 'm1', dueAt: NOW + DAY }, NOW);
  const item = asRadarItem(f, store);
  assert.equal(item.kind, 'followup');
  assert.equal(item.at, NOW + DAY);
  assert.match(item.title, /Extension request/);
});

test('a radar item survives a missing message', () => {
  const [f] = setFollowup([], { threadId: 't1', messageId: 'gone', dueAt: NOW }, NOW);
  assert.doesNotThrow(() => asRadarItem(f, storeOf([])));
});

test('the presets are ordered and distinct', () => {
  const ms = PRESETS.map((p) => p.ms);
  assert.deepEqual(ms, [...ms].sort((a, b) => a - b));
  assert.equal(new Set(ms).size, ms.length);
});


/* ==========================================================================
 * STORE-SHAPE ROBUSTNESS
 *
 * Both found in the per-file audit. `dueFollowups` runs on the radar render
 * path, so a TypeError here is a render crash rather than a wrong answer.
 * ========================================================================== */

test('a store with threadIds but no get does not crash the radar', () => {
  const list = setFollowup([], { threadId: 't1', messageId: 'm1', dueAt: NOW }, NOW - 1000);
  assert.doesNotThrow(() => dueFollowups(list, { threadIds: () => ['m1'] }, ME, NOW + 1000));
});

test('threadIds returning null is tolerated', () => {
  const list = setFollowup([], { threadId: 't1', messageId: 'm1', dueAt: NOW }, NOW - 1000);
  assert.doesNotThrow(() => dueFollowups(list, { threadIds: () => null, get: () => undefined }, ME, NOW + 1000));
});

test('A STORE THAT CANNOT ANSWER DOES NOT CAUSE MASS DELETION', () => {
  /*
   * `pruneFollowups` drops entries whose thread has left the mailbox. The
   * original code turned "I could not ask" into an empty array, which is
   * indistinguishable from "the thread is gone" -- so running a prune against
   * a store that was not ready would have silently deleted EVERY follow-up.
   *
   * Silent permanent data loss, for the one feature whose entire value is
   * remembering something on the user's behalf.
   */
  let list = setFollowup([], { threadId: 't1', messageId: 'm1', dueAt: NOW }, NOW);
  list = setFollowup(list, { threadId: 't2', messageId: 'm2', dueAt: NOW }, NOW);

  assert.equal(pruneFollowups(list, {}, ME).length, 2, 'no store: keep everything');
  assert.equal(pruneFollowups(list, null, ME).length, 2, 'null store: keep everything');

  // And the real behaviour is unchanged: a genuinely absent thread is dropped.
  const realStore = { threadIds: (t) => (t === 't1' ? ['m1'] : []), get: () => ({ id: 'm1', from: ME, date: NOW - 1 }) };
  assert.deepEqual(pruneFollowups(list, realStore, ME).map((f) => f.threadId), ['t1']);
});

test('the readers are total, like the loader (round 10, I-1 / M-4)', () => {
  /* `normaliseFollowups(null)` returned []; `dueFollowups(null, ...)` threw
     "Cannot read properties of null (reading 'filter')". An absent list means
     nothing is due, which is an answer, not a crash. */
  const store = { byId: () => null };
  for (const bad of [undefined, null, {}, 'nope', 7]) {
    assert.deepEqual(dueFollowups(bad, store, ME, NOW), []);
    assert.deepEqual(openFollowups(bad, store, ME), []);
  }
});
