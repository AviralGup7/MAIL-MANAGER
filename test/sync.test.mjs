/**
 * Delta-sync tests.
 *
 * Every test below is a regression test for a bug that was in the first draft
 * of sync.js. All of them lose mail silently, which is the exact failure class
 * this rewrite exists to eliminate — so each test names its own bug below
 * rather than deferring to a notes file (which no longer exists; the pointer
 * had been dead long enough that nobody noticed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

/* ========================================================================== *
 * THE HISTORY CURSOR GUARD
 *
 * `historyId` is a SINGLE account-wide cursor that the inbox delta sync
 * depends on. Loading a page of Sent or Trash must not advance it, or inbox
 * changes that were never fetched are skipped and are unrecoverable until the
 * cursor expires (~a week).
 *
 * Mutation testing found this guard untested: changing `anchorHistory &&
 * !pageToken` to `||` killed no test. It cannot be driven end-to-end here
 * because `api()` requires a signed-in token before the cursor logic is
 * reached, and stubbing the whole auth module to test one boolean would be a
 * more fragile test than the code it guards. The structure is asserted
 * instead, and the reasoning is recorded so nobody "simplifies" it.
 * ========================================================================== */

const syncSrc = readFileSync(new URL('../src/background/sync.js', import.meta.url), 'utf8');

test('the cursor is read only for an anchoring first page', () => {
  assert.match(
    syncSrc, /if \(anchorHistory && !pageToken\) \{/,
    'both conditions are required: `||` would anchor on Sent, or on page 2'
  );
});

test('anchorHistory defaults to true, so the inbox is never accidentally skipped', () => {
  // Defaulting to false would silently stop the inbox cursor from advancing,
  // which is the opposite failure: endless re-syncs of the same window.
  assert.match(syncSrc, /anchorHistory = true/);
});

test('sync preparation never commits its own cursor', () => {
  const page = syncSrc.slice(
    syncSrc.indexOf('export async function syncPage'),
    syncSrc.indexOf('export async function syncDelta')
  );
  const delta = syncSrc.slice(syncSrc.indexOf('export async function syncDelta'));
  assert.doesNotMatch(page, /await setHistoryId\(/,
    'the page caller must persist before committing its returned anchor');
  assert.doesNotMatch(delta, /await setHistoryId\(res\.historyId\)/,
    'the delta caller must persist before committing nextHistoryId');
  assert.match(syncSrc, /export async function commitHistoryId/,
    'commit is an explicit second phase');
});

test('page 2 and beyond never re-anchor', () => {
  /*
   * The subtle half. The response `historyId` is the mailbox's CURRENT id,
   * not the id of the last record on the page — so anchoring on page 2 would
   * advance the cursor past pages 3..n before they were read.
   */
  const fn = syncSrc.slice(syncSrc.indexOf('export async function syncPage'));
  const guard = fn.slice(0, fn.indexOf('const { ids, nextPageToken }'));
  assert.ok(guard.includes('!pageToken'), 'pagination must suppress anchoring');
});

/* ==========================================================================
 * A SHORT BATCH MUST NOT MOVE THE CURSOR (audit R3-03)
 *
 * The most consequential defect the R3 audit found, and it belongs in this
 * file because it is exactly the class the header names: silent mail loss.
 *
 * parseBatch drops sub-requests whose status is not 2xx, and only the
 * ALL-fail case threw. So 40 failures out of 100 returned 60 messages inside
 * a 200 OK envelope -- indistinguishable from a healthy batch of 60, and
 * invisible to the whole-request retry. syncDelta then advanced historyId
 * past ids that were never fetched, and since the cursor is the only record
 * of what has been seen, that mail was gone until the cursor expired.
 * ========================================================================== */
test('a permanently-failing sub-request withholds the cursor (audit R3-03)', async () => {
  const B = 'bmm_sync_r3';
  const part = (id, status) =>
    `--${B}\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 ${status}\r\n\r\n` +
    (status === 200
      ? JSON.stringify({ id, threadId: `t${id}`, internalDate: '1700000000000',
          labelIds: ['INBOX'], payload: { headers: [{ name: 'Subject', value: id }] } })
      : '{"error":{"code":500}}') + '\r\n';

  const store = { historyId: '1000' };
  const realChrome = globalThis.chrome;
  const realFetch = globalThis.fetch;
  const area = {
    get: async (k) => {
      const keys = [].concat(k === null ? Object.keys(store) : k);
      const out = {};
      for (const key of keys) if (key in store) out[key] = store[key];
      return out;
    },
    set: async (o) => { Object.assign(store, o); },
    remove: async (k) => { for (const key of [].concat(k)) delete store[key]; },
  };
  globalThis.chrome = {
    storage: { local: area, session: { ...area, get: async () => ({ accessToken: 'tok', expiresAt: Date.now() + 9e6 }) } },
    runtime: { id: 'test' },
  };

  let batches = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/history')) {
      return { ok: true, status: 200, json: async () => ({
        historyId: '2000',
        history: [{ messagesAdded: ['m1', 'm2', 'm3'].map((id) => ({ message: { id, labelIds: ['INBOX'] } })) }],
      }) };
    }
    if (u.includes('/batch')) {
      batches++;
      const ids = [...String(init.body).matchAll(/messages\/([^?]+)\?/g)].map((m) => m[1]);
      return { ok: true, status: 200,
        text: async () => ids.map((id) => part(id, id === 'm2' ? 500 : 200)).join('') + `--${B}--\r\n` };
    }
    return { ok: true, status: 200, json: async () => ({ historyId: '2000' }) };
  };

  try {
    const mod = await import('../src/background/sync.js?r3=' + Math.random());
    const res = await mod.syncDelta();

    assert.deepEqual(res.added.map((m) => m.id), ['m1', 'm3'], 'what arrived is still applied');
    assert.equal(res.incomplete, true, 'the shortfall is reported, not hidden');
    assert.deepEqual(res.missingIds, ['m2']);
    assert.equal(res.nextHistoryId, '', 'the cursor must NOT advance past unfetched mail');
    assert.ok(batches >= 2, 'the stragglers get one retry before giving up');

    // And the commit path must honour it: an empty cursor is a no-op.
    await mod.commitHistoryId(res.nextHistoryId);
    assert.equal(store.historyId, '1000', 'the stored cursor is untouched, so the delta replays');
  } finally {
    globalThis.chrome = realChrome;
    globalThis.fetch = realFetch;
  }
});

test('a fully successful batch still advances the cursor (audit R3-03)', async () => {
  const B = 'bmm_sync_ok';
  const okPart = (id) =>
    `--${B}\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\n\r\n` +
    JSON.stringify({ id, threadId: `t${id}`, internalDate: '1700000000000',
      labelIds: ['INBOX'], payload: { headers: [{ name: 'Subject', value: id }] } }) + '\r\n';

  const store = { historyId: '1000' };
  const realChrome = globalThis.chrome;
  const realFetch = globalThis.fetch;
  const area = {
    get: async (k) => {
      const keys = [].concat(k === null ? Object.keys(store) : k);
      const out = {};
      for (const key of keys) if (key in store) out[key] = store[key];
      return out;
    },
    set: async (o) => { Object.assign(store, o); },
    remove: async (k) => { for (const key of [].concat(k)) delete store[key]; },
  };
  globalThis.chrome = {
    storage: { local: area, session: { ...area, get: async () => ({ accessToken: 'tok', expiresAt: Date.now() + 9e6 }) } },
    runtime: { id: 'test' },
  };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/history')) {
      return { ok: true, status: 200, json: async () => ({
        historyId: '2000',
        history: [{ messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX'] } }] }],
      }) };
    }
    if (u.includes('/batch')) {
      const ids = [...String(init.body).matchAll(/messages\/([^?]+)\?/g)].map((m) => m[1]);
      return { ok: true, status: 200, text: async () => ids.map(okPart).join('') + `--${B}--\r\n` };
    }
    return { ok: true, status: 200, json: async () => ({ historyId: '2000' }) };
  };

  try {
    const mod = await import('../src/background/sync.js?ok=' + Math.random());
    const res = await mod.syncDelta();
    assert.equal(res.incomplete, undefined, 'a healthy delta carries no shortfall');
    assert.equal(res.nextHistoryId, '2000', 'the happy path is unchanged');
    await mod.commitHistoryId(res.nextHistoryId);
    assert.equal(store.historyId, '2000');
  } finally {
    globalThis.chrome = realChrome;
    globalThis.fetch = realFetch;
  }
});
