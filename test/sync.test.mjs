/**
 * Delta-sync tests.
 *
 * Every test below is a regression test for a bug that was in the first draft
 * of sync.js. See notes/SYNC_BUGS.md. All of them lose mail silently, which is
 * the exact failure class this rewrite exists to eliminate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = {
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  runtime: { id: 'test' },
};

const { reduceHistory } = await import('../src/background/sync.js');

// Builders that mirror Gmail's wire shape.
const added = (id, labelIds = ['INBOX', 'UNREAD']) => ({ messagesAdded: [{ message: { id, labelIds } }] });
const deleted = (id) => ({ messagesDeleted: [{ message: { id } }] });
const labelAdd = (id, labelIds) => ({ labelsAdded: [{ message: { id }, labelIds }] });
const labelDel = (id, labelIds) => ({ labelsRemoved: [{ message: { id }, labelIds }] });

// ---------------------------------------------------------------- basics --

test('a new inbox message is an add', () => {
  const r = reduceHistory([added('a')]);
  assert.deepEqual(r.addIds, ['a']);
  assert.deepEqual(r.removeIds, []);
});

test('a new message that never touched the inbox is ignored', () => {
  // Sent mail, drafts, and anything auto-filtered straight to a label.
  const r = reduceHistory([added('a', ['SENT'])]);
  assert.deepEqual(r.addIds, []);
  assert.deepEqual(r.removeIds, []);
});

test('losing the INBOX label is an archive', () => {
  const r = reduceHistory([labelDel('a', ['INBOX'])]);
  assert.deepEqual(r.removeIds, ['a']);
});

test('a permanently deleted message is removed', () => {
  const r = reduceHistory([deleted('a')]);
  assert.deepEqual(r.removeIds, ['a']);
});

test('moving to trash or spam removes it from our view', () => {
  assert.deepEqual(reduceHistory([labelAdd('a', ['TRASH'])]).removeIds, ['a']);
  assert.deepEqual(reduceHistory([labelAdd('b', ['SPAM'])]).removeIds, ['b']);
});

// ------------------------------------------------------------------ BUG 2 --

test('BUG 2: gaining the INBOX label brings an un-archived message back', () => {
  // Un-archiving produces labelsAdded, NEVER messagesAdded — that only fires
  // when a message first enters the mailbox. The first draft read only UNREAD
  // and STARRED from labelsAdded, so un-archived mail stayed invisible until a
  // full resync.
  const r = reduceHistory([labelAdd('a', ['INBOX'])]);
  assert.deepEqual(r.addIds, ['a'], 'un-archived message must be re-fetched');
  assert.deepEqual(r.removeIds, []);
});

test('BUG 2: a thread pulled back by a reply is an add', () => {
  const r = reduceHistory([labelAdd('a', ['INBOX', 'UNREAD'])]);
  assert.deepEqual(r.addIds, ['a']);
  // No patch: we are re-fetching, so the fetched metadata is authoritative.
  assert.deepEqual(r.patched, []);
});

// ------------------------------------------------------------------ BUG 3 --

test('BUG 3: archive then un-archive ends as an add, not both', () => {
  // The two-set version put this id in `added` AND `removed`, and the app
  // applied adds first, so the message vanished despite being in the inbox.
  const r = reduceHistory([labelDel('a', ['INBOX']), labelAdd('a', ['INBOX'])]);
  assert.deepEqual(r.addIds, ['a']);
  assert.deepEqual(r.removeIds, []);
});

test('BUG 3: un-archive then archive ends as a remove, not both', () => {
  const r = reduceHistory([labelAdd('a', ['INBOX']), labelDel('a', ['INBOX'])]);
  assert.deepEqual(r.addIds, []);
  assert.deepEqual(r.removeIds, ['a']);
});

test('BUG 3: arrive then archive ends as a remove', () => {
  const r = reduceHistory([added('a'), labelDel('a', ['INBOX'])]);
  assert.deepEqual(r.addIds, []);
  assert.deepEqual(r.removeIds, ['a']);
});

test('BUG 3: adds and removes are always disjoint', () => {
  // The property that makes the caller's apply order irrelevant.
  const r = reduceHistory([
    added('a'),
    added('b'),
    labelDel('a', ['INBOX']),
    labelAdd('a', ['INBOX']),
    deleted('b'),
    labelDel('c', ['INBOX']),
  ]);
  const overlap = r.addIds.filter((id) => r.removeIds.includes(id));
  assert.deepEqual(overlap, [], 'an id must never be in both lists');
  assert.deepEqual(r.addIds, ['a']);
  assert.deepEqual(r.removeIds.sort(), ['b', 'c']);
});

test('BUG 3: last event wins over a long churn', () => {
  const r = reduceHistory([
    added('a'),
    labelDel('a', ['INBOX']),
    labelAdd('a', ['INBOX']),
    labelDel('a', ['INBOX']),
    labelAdd('a', ['INBOX']),
  ]);
  assert.deepEqual(r.addIds, ['a']);
  assert.deepEqual(r.removeIds, []);
});

// ----------------------------------------------------------------- patches --

test('read and star changes become patches', () => {
  const r = reduceHistory([labelDel('a', ['UNREAD']), labelAdd('b', ['STARRED'])]);
  assert.deepEqual(r.patched.sort((x, y) => x.id < y.id ? -1 : 1), [
    { id: 'a', unread: false },
    { id: 'b', starred: true },
  ]);
});

test('later patch events overwrite earlier ones for the same message', () => {
  const r = reduceHistory([labelAdd('a', ['STARRED']), labelDel('a', ['STARRED'])]);
  assert.deepEqual(r.patched, [{ id: 'a', starred: false }]);
});

test('BUG 5: a removed message carries no patch', () => {
  // Harmless before only because Store.patch() no-ops on an unknown id. That
  // is luck, not design.
  const r = reduceHistory([labelAdd('a', ['STARRED']), deleted('a')]);
  assert.deepEqual(r.removeIds, ['a']);
  assert.deepEqual(r.patched, [], 'no patch for a message we are removing');
});

test('an added message carries no patch — the fetch is newer', () => {
  const r = reduceHistory([added('a'), labelDel('a', ['UNREAD'])]);
  assert.deepEqual(r.addIds, ['a']);
  assert.deepEqual(r.patched, []);
});

// ------------------------------------------------------------------- shape --

test('empty and malformed input does not throw', () => {
  for (const input of [[], null, undefined, [{}], [{ labelsAdded: [] }]]) {
    const r = reduceHistory(input);
    assert.deepEqual(r.addIds, []);
    assert.deepEqual(r.removeIds, []);
    assert.deepEqual(r.patched, []);
  }
});

test('a history record with a missing labelIds array does not throw', () => {
  const r = reduceHistory([{ labelsAdded: [{ message: { id: 'a' } }] }]);
  assert.deepEqual(r.addIds, []);
  assert.deepEqual(r.patched, []);
});

test('a realistic mixed batch resolves correctly', () => {
  const r = reduceHistory([
    added('new1'),
    added('new2'),
    labelDel('old1', ['UNREAD']),      // read elsewhere
    labelAdd('old2', ['STARRED']),     // starred on phone
    labelDel('old3', ['INBOX']),       // archived on phone
    labelAdd('old4', ['INBOX']),       // un-archived on phone
    deleted('old5'),                   // deleted
  ]);
  assert.deepEqual(r.addIds.sort(), ['new1', 'new2', 'old4']);
  assert.deepEqual(r.removeIds.sort(), ['old3', 'old5']);
  assert.deepEqual(r.patched.map((p) => p.id).sort(), ['old1', 'old2']);
});
