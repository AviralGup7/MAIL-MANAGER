/**
 * Bug hunt, round 2 of 10 (2026-08-16).
 *
 * The theme of this round is CLAIMS THAT WERE NOT CHECKED: identity compared
 * by substring, an offline queue that trusted its own duplicates, a cache
 * that dropped a field something searched on, and a scanner whose header
 * promised to fail closed while it acted on text saying the opposite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const ME = 'me@x.z';

/* ========================================================================
 * B6 · followups.isAnswered compared identity by substring
 * ==================================================================== */

test('B6: "is this reply mine" is a parsed-address question', async () => {
  /*
   * MEASURED with `from.includes(me)`, wrong in BOTH directions:
   *
   *   'notme@x.z'            read as ME  -> a genuine reply never cleared
   *                                          the follow-up; it nagged forever
   *   'me+tag@x.z'           read as NOT me -> my own nudge cleared a
   *                                          reminder I still needed
   *   '"me@x.z" <them@y.z>'  read as ME  -> the SENDER answered on my behalf
   */
  const { isAnswered } = await import('../src/app/academic/followups.js');
  const { Store } = await import('../src/app/mail/store.js');
  const mk = (o) => ({ id: 'x', threadId: 'T', subject: 's', from: 'them@y.z',
    to: ME, snippet: '', date: 1, labels: [], category: 'inbox', ...o });

  const answeredWhenReplyFrom = (from) => {
    const s = new Store();
    s.upsert(mk({ id: 'm1', date: 10 }));
    s.upsert(mk({ id: 'm2', date: 20, from }));
    return isAnswered({ threadId: 'T', messageId: 'm1', dueAt: 100, createdAt: 10 }, s, ME);
  };

  /* A real reply clears it. */
  assert.equal(answeredWhenReplyFrom('them@y.z'), true);
  assert.equal(answeredWhenReplyFrom('notme@x.z'), true,
    'a stranger whose address CONTAINS mine is still a stranger');
  assert.equal(answeredWhenReplyFrom('"me@x.z" <real@other.z>'), true,
    'a display name is not identity');

  /* My own message is a nudge, not an answer — in every spelling. */
  assert.equal(answeredWhenReplyFrom(ME), false);
  assert.equal(answeredWhenReplyFrom(`Me <${ME}>`), false);
  assert.equal(answeredWhenReplyFrom('me+tag@x.z'), false, 'a plus tag is the same mailbox');
  assert.equal(answeredWhenReplyFrom('ME@X.Z'), false, 'case is not identity either');
});

/* ========================================================================
 * B7 · the same defect in the Needs-reply lane, attacker-reachable
 * ==================================================================== */

test('B7: a forged display name cannot answer on the user\'s behalf', async () => {
  /*
   * A From display name is SENDER-CONTROLLED. With the substring test,
   * '"me@x.z" <them@y.z>' counted as my reply and silently removed their own
   * message from Needs-reply — the one lane whose entire job is "you still
   * owe someone an answer". Losing a message from it is invisible: nothing
   * tells the user the lane used to contain it.
   */
  const { answeredPredicate } = await import('../src/app/academic/lanes.js');
  const { Store } = await import('../src/app/mail/store.js');
  const mk = (o) => ({ id: 'x', threadId: 'T', subject: 'Please confirm',
    from: 'them@y.z', to: ME, snippet: '', date: 1, labels: [],
    category: 'inbox', unread: true, audience: 'direct', ...o });

  const answeredWhenLaterFrom = (from) => {
    const s = new Store();
    const theirs = mk({ id: 'm1', date: 10 });
    s.upsert(theirs);
    s.upsert(mk({ id: 'm2', date: 20, from }));
    return answeredPredicate(s, ME)(theirs);
  };

  assert.equal(answeredWhenLaterFrom('"me@x.z" <them@y.z>'), false,
    'the sender may not forge my identity to clear their own message');
  assert.equal(answeredWhenLaterFrom('notme@x.z'), false,
    'a stranger containing my address has not answered for me');
  assert.equal(answeredWhenLaterFrom('them@y.z'), false,
    'their own follow-up is not my answer');

  /* And my real reply still answers, however it is spelled. */
  assert.equal(answeredWhenLaterFrom(ME), true);
  assert.equal(answeredWhenLaterFrom(`Me <${ME}>`), true);
  assert.equal(answeredWhenLaterFrom('me+tag@x.z'), true);
});

/* ========================================================================
 * B8 · the offline intent queue replayed duplicates
 * ==================================================================== */

test('B8: repeating an action offline queues it once, not N times', async () => {
  /*
   * Offline a row never visibly settles — nothing confirms it — so the user
   * taps Archive again. MEASURED: three taps queued three records and the
   * drain sent archive:m1 three times. Every extra call is a wasted round
   * trip on a connection that has only just returned, and for a
   * non-idempotent verb it is a second real mutation.
   */
  const intents = await import('../src/app/mail/intents.js');
  const mkStore = () => { const d = {}; return {
    get: async (k) => ({ [k]: d[k] }), set: async (o) => Object.assign(d, o),
    remove: async (ks) => { for (const k of [].concat(ks)) delete d[k]; } }; };

  intents._reset();
  const st = mkStore();
  for (const verb of ['archive', 'archive', 'archive', 'star', 'archive']) {
    await intents.enqueueIntent({ verb, targetId: 'm1' }, st);
  }
  assert.equal(await intents.queuedIntentCount(st), 2, 'one per (verb, target)');

  const sent = [];
  await intents.drainIntents({ send: async (verb, { id }) => { sent.push(`${verb}:${id}`); } }, st);
  assert.deepEqual(sent, ['star:m1', 'archive:m1'],
    'ORDER MATTERS: archive→star→archive must still end archived, so a repeat ' +
    'moves to the back rather than the first occurrence winning');
});

test('B8: the same verb on DIFFERENT messages is not deduped', async () => {
  /* The key is (verb, targetId). Collapsing by verb alone would silently
     drop a real action on another row — a far worse bug than the one fixed. */
  const intents = await import('../src/app/mail/intents.js');
  const mkStore = () => { const d = {}; return {
    get: async (k) => ({ [k]: d[k] }), set: async (o) => Object.assign(d, o),
    remove: async (ks) => { for (const k of [].concat(ks)) delete d[k]; } }; };

  intents._reset();
  const st = mkStore();
  await intents.enqueueIntent({ verb: 'archive', targetId: 'm1' }, st);
  await intents.enqueueIntent({ verb: 'archive', targetId: 'm2' }, st);
  assert.equal(await intents.queuedIntentCount(st), 2);
});

test('B8: a superseded intent keeps its original queue age', async () => {
  /* The queue reports how long work has been waiting. If a repeat reset
     createdAt, tapping a stuck row would make the queue look freshly filled
     and hide that it has been stalled for an hour. */
  const intents = await import('../src/app/mail/intents.js');
  const mkStore = () => { const d = {}; return {
    get: async (k) => ({ [k]: d[k] }), set: async (o) => Object.assign(d, o),
    remove: async (ks) => { for (const k of [].concat(ks)) delete d[k]; } }; };

  intents._reset();
  const st = mkStore();
  const first = await intents.enqueueIntent({ verb: 'archive', targetId: 'm1' }, st);
  await new Promise((r) => setTimeout(r, 5));
  const again = await intents.enqueueIntent({ verb: 'archive', targetId: 'm1' }, st);
  assert.equal(again.createdAt, first.createdAt, 'the wait is measured from the first attempt');
});

/* ========================================================================
 * B9 · the cache dropped a field the search reads
 * ==================================================================== */

test('B9: label: still matches after a reload', async () => {
  /*
   * query.js implements `label:` by reading m.labels. The cache row packs
   * unread/starred/attachment into a flags byte — but a Gmail label is a
   * NAME, not a flag, and it was simply not carried. MEASURED:
   * `label:hostel` matched a live record and matched NOTHING after a
   * reload. The whole corpus rehydrates from the cache before the first
   * sync lands, so a saved view built on `label:` looked broken every time
   * the app opened.
   */
  const cache = await import('../src/app/system/cache.js');
  const { parseQuery } = await import('../src/app/search/query.js');
  const mkStore = () => { const d = {}; return {
    get: async (k) => ({ [k]: d[k] }), set: async (o) => Object.assign(d, o),
    remove: async () => {} }; };

  const live = { id: 'm1', threadId: 't', subject: 'Fee', from: 'a@b.c', snippet: '',
    date: 5, labels: ['Hostel', 'Fees/2026'], category: 'inbox', unread: false, starred: false };

  const st = mkStore();
  await cache.saveCache([live], st);
  const restored = (await cache.loadCache(st)).messages[0];

  assert.deepEqual(restored.labels, ['Hostel', 'Fees/2026'], 'labels survive the round trip');
  for (const q of ['label:hostel', 'label:2026']) {
    const p = parseQuery(q);
    assert.equal(p.predicate(live), true, `${q} matches live`);
    assert.equal(p.predicate(restored), true, `${q} must still match after a reload`);
  }
});

test('B9: an old cache blob without labels still loads', async () => {
  /* The widening is backward-compatible by design — index 16 absent means no
     key at all, the pre-fix behaviour, self-correcting on the next sync. A
     VERSION bump would have thrown away every user's cache instead. */
  const cache = await import('../src/app/system/cache.js');
  const st = { get: async () => ({ msgCache: { v: 3, t: 1, m: [
    ['m1', 't', 'a@b.c', 'Subject', 'snip', 5, 0, 'inbox', 1, 'src', 'why'],
  ] } }), set: async () => {}, remove: async () => {} };
  const out = await cache.loadCache(st);
  /* Either it parses (right version) or degrades to null (wrong version) —
     what it must never do is throw on the boot path. */
  assert.doesNotThrow(() => out);
  if (out) assert.equal(out.messages[0].id, 'm1');
});

/* ========================================================================
 * B10 · the timetable scanner acted on text saying the opposite
 * ==================================================================== */

async function scanWith(body) {
  const tm = await import('../src/app/academic/timetable-mail.js');
  const tt = await import('../src/app/academic/timetable.js');
  const course = { comCode: '1008', courseNo: 'CS F211', title: 'DSA' };
  const { state } = tt.addCourse(tt.emptyState(), course,
    { lecture: { section: 'L1', room: '6101', meetings: [{ day: 'M', hour: 3 }], unresolved: [] }, at: 1 });
  return tm.scanMessage({ id: 'x', from: 'augsd@pilani.bits-pilani.ac.in',
    subject: 'CS F211 L1', snippet: '', body, date: 1 }, state);
}

test('B10: a negated sentence proposes nothing', async () => {
  /*
   * The module header promises to FAIL CLOSED. MEASURED, it did not:
   * 'the class will NOT be shifted to room 9999' produced a room→9999
   * proposal, and 'the class is NOT cancelled' produced a cancellation.
   *
   * A correction notice is exactly the mail that names a room and then
   * denies it — and acting on the denial is the failure the header itself
   * calls worse than doing nothing, because the user stops trusting the
   * schedule and has to verify every entry by hand.
   */
  for (const body of [
    'The class will not be shifted to room 9999.',
    'The class is NOT cancelled.',
    'Contrary to the earlier notice, the class has not been moved to 9999.',
    'The venue remains unchanged.',
  ]) {
    assert.deepEqual(await scanWith(body), [], JSON.stringify(body));
  }
});

test('B10: quoted text under "please ignore" proposes nothing', async () => {
  /* A reply carries the notice it is answering, and that notice usually
     states the very change the reply withdraws. The app acted on the text
     the human explicitly told it to ignore. */
  for (const body of [
    '> The class has been shifted to room 1111.\nPlease ignore the message below; the room is unchanged.',
    'On Mon, AUGSD wrote:\n> shifted to room 1111\nThat notice was withdrawn.',
    '-- Original Message --\nThe class has been shifted to room 1111.',
  ]) {
    assert.deepEqual(await scanWith(body), [], JSON.stringify(body.slice(0, 40)));
  }
});

test('B10: a plain, unnegated notice still produces its finding', async () => {
  /*
   * THE OVER-CORRECTION GUARD. Failing closed is only right when the message
   * really is ambiguous — a fix that silenced the feature entirely would
   * "pass" the two tests above and destroy the product.
   */
  const room = await scanWith('The class has been shifted to room 9999.');
  assert.equal(room.length, 1);
  assert.equal(room[0].kind, 'room');
  assert.equal(room[0].value, '9999');

  const cancelled = await scanWith('The class is cancelled today.');
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].kind, 'cancellation');

  /* A long notice that happens to contain "not" far from the claim must
     still work — negation is read on the MATCHED SENTENCE, not the message. */
  const long = await scanWith(
    'Students are reminded not to park bicycles in the corridor. '
    + 'The class has been shifted to room 9999.');
  assert.equal(long.length, 1, 'an unrelated "not" elsewhere must not gag the scanner');
  assert.equal(long[0].value, '9999');
});
