/**
 * Bug hunt, round 1 of 10 (2026-08-16).
 *
 * Five defects, each found by EXECUTING the module rather than reading it,
 * and each pinned here at the exact shape that reproduced it. The comments
 * carry the measurement, not a description — a pin whose reason is "this was
 * wrong once" teaches the next reader nothing about which direction is wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ========================================================================
 * B1 · store.patch() never reindexed threadId
 * ==================================================================== */

test('B1: patching threadId moves the message between thread indexes', async () => {
  /*
   * MEASURED BEFORE THE FIX: after patch(id, { threadId: 't2' }) the record
   * read 't2' while byThread still held { t1 -> [c] }. So threadIds('t2')
   * was [] — the new conversation could not find its own message — and
   * threadIds('t1') still returned it, a ghost membership in a thread the
   * message had left.
   *
   * The reader renders a conversation from threadIds, and byThread is only
   * rebuilt on reindex, so nothing repaired this short of a reload.
   */
  const { Store } = await import('../src/app/mail/store.js');
  const mk = (o) => ({ id: 'x', threadId: 't', subject: 's', from: 'a@b.c',
    snippet: '', date: 1, labels: [], category: 'inbox', ...o });

  const s = new Store();
  s.upsert(mk({ id: 'c', threadId: 't1' }));
  s.patch('c', { threadId: 't2' });

  assert.equal(s.get('c').threadId, 't2', 'the record moved');
  assert.deepEqual(s.threadIds('t2'), ['c'], 'the new thread must contain it');
  assert.deepEqual(s.threadIds('t1'), [], 'the old thread must not');
  assert.equal(s.byThread.has('t1'), false, 'an emptied thread entry is dropped');

  /* And the summary the reader actually renders agrees. */
  assert.equal(s.thread('t1'), null);
  assert.equal(s.thread('t2').count, 1);
});

test('B1: a threadId patch that changes nothing does not churn the index', async () => {
  /* The guard is `!==`, not `in`: re-patching the same value must not
     deindex/reindex, or every no-op write costs a tokenise. */
  const { Store } = await import('../src/app/mail/store.js');
  const s = new Store();
  s.upsert({ id: 'c', threadId: 't1', subject: 'hello world', from: 'a@b.c',
    snippet: '', date: 1, labels: [], category: 'inbox' });
  s.patch('c', { threadId: 't1' });
  assert.deepEqual(s.threadIds('t1'), ['c']);
  assert.deepEqual(s.search('hello', 'all'), ['c'], 'the text index survived');
});

/* ========================================================================
 * B2 · ISO dates lost, or silently mis-parsed, a deadline
 * ==================================================================== */

test('B2: an ISO date is read as yyyy-mm-dd, not as its tail', async () => {
  /*
   * MEASURED BEFORE THE FIX. The day-first pattern is \b-anchored, so:
   *
   *   'deadline 2026-08-20'  -> matched "08-20" -> day 8, month 20 -> NULL
   *   'deadline 2026-12-01'  -> matched "12-01" -> 12 JANUARY (wrong, plausible)
   *
   * The second is the dangerous one: a confident wrong date, not a gap.
   */
  const { extractDeadline } = await import('../src/app/academic/deadlines.js');
  const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);
  const m = (s) => ({ id: 'x', subject: s, snippet: '', date: NOW });
  const iso = (s) => {
    const g = extractDeadline(m(s), NOW);
    return g ? new Date(g.at).toISOString().slice(0, 10) : null;
  };

  assert.equal(iso('Deadline: 2026-08-20'), '2026-08-20');
  assert.equal(iso('deadline 2026-12-01'), '2026-12-01', 'not 12 January');
  /* A FUTURE date — the plausibility rail rejects one already long past,
     which is correct and is why this reads 2027 rather than March 2026. */
  assert.equal(iso('last date 2027-03-05'), '2027-03-05');
  /* Time of day still rides along. */
  const g = extractDeadline(m('submit by 2026-08-20 5pm'), NOW);
  assert.equal(new Date(g.at).toISOString().slice(0, 16), '2026-08-20T17:00');
});

test('B2: an impossible ISO date is refused, not rounded', async () => {
  const { extractDeadline } = await import('../src/app/academic/deadlines.js');
  const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);
  const m = (s) => ({ id: 'x', subject: s, snippet: '', date: NOW });
  for (const bad of ['deadline 2026-02-29', 'deadline 2026-13-01', 'deadline 2026-08-32']) {
    assert.equal(extractDeadline(m(bad), NOW), null, bad);
  }
});

test('B2: an ISO date no longer shadows a real date later in the text', async () => {
  /* extractDeadline returns on its FIRST match, so a leading ISO date that
     parsed to null used to take the whole message down with it — the
     dd/mm date after it was never reached. */
  const { extractDeadline } = await import('../src/app/academic/deadlines.js');
  const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);
  const g = extractDeadline(
    { id: 'x', subject: 'deadline 2026-08-20, hostel 25/08/2026', snippet: '', date: NOW }, NOW);
  assert.ok(g, 'a deadline is found at all');
  assert.equal(new Date(g.at).toISOString().slice(0, 10), '2026-08-20');
});

test('B2: the day-first reading is untouched', async () => {
  /* India writes dd/mm and this is a BITS tool — the ISO branch must not
     have stolen the ambiguous case. */
  const { extractDeadline } = await import('../src/app/academic/deadlines.js');
  const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);
  const at = (s) => {
    const g = extractDeadline({ id: 'x', subject: s, snippet: '', date: NOW }, NOW);
    return g ? new Date(g.at).toISOString().slice(0, 10) : null;
  };
  assert.equal(at('deadline 25/08/2026'), '2026-08-25', '25 August, not month 25');
  assert.equal(at('deadline 11/12/2026'), '2026-12-11', 'dd/mm, not mm/dd');
});

/* ========================================================================
 * B3 · two snooze presets naming the same instant
 * ==================================================================== */

test('B3: no two snooze presets resolve to the same time', async () => {
  /*
   * MEASURED: on a SUNDAY, ((8-day)%7||7) is 1, so "Next week" was the very
   * next morning — identical to "Tomorrow morning". On a FRIDAY, "Tomorrow"
   * and "This weekend" were both Saturday 08:00. Two rows, one outcome; the
   * user picks the more specific label and gets the other's behaviour.
   *
   * Swept across a whole week so a future arithmetic change cannot
   * reintroduce it on some other day.
   */
  const { presets } = await import('../src/features/snooze/model.js');
  const base = new Date(2026, 7, 16, 12, 0, 0).getTime(); // a Sunday, local
  for (let off = 0; off < 7; off++) {
    const now = base + off * 86_400_000;
    const list = presets(now);
    const times = list.map((p) => p.at);
    assert.equal(new Set(times).size, times.length,
      `duplicate preset instant on day ${new Date(now).getDay()}: ` +
      JSON.stringify(list.map((p) => [p.id, new Date(p.at).toString().slice(0, 15)])));
    for (const p of list) assert.ok(p.at > now, `${p.id} must be in the future`);
  }
});

test('B3: "next week" is the following Monday, on every day including Sunday', async () => {
  const { presets } = await import('../src/features/snooze/model.js');
  const base = new Date(2026, 7, 16, 12, 0, 0).getTime(); // Sunday
  for (let off = 0; off < 7; off++) {
    const now = base + off * 86_400_000;
    const nw = presets(now).find((p) => p.id === 'nextweek');
    assert.ok(nw, 'the preset exists every day');
    const d = new Date(nw.at);
    assert.equal(d.getDay(), 1, 'it lands on a Monday');
    /* And it never coincides with tomorrow. On a Saturday the next Monday is
       genuinely under two days away, so the invariant is DISTINCTNESS from
       the tomorrow preset — not an arbitrary minimum distance. My first
       version asserted >= 2 days and failed honestly on Saturday. */
    const tom = presets(now).find((p) => p.id === 'tomorrow');
    if (tom) {
      assert.notEqual(nw.at, tom.at,
        '"next week" and "tomorrow" must never be the same instant');
    }
  }
});

/* ========================================================================
 * B4 · theme accepted any string
 * ==================================================================== */

test('B4: an unknown theme is coerced, not persisted', async () => {
  /*
   * MEASURED: set('theme','nonexistent') was accepted and written to
   * storage. applyTheme falls back for the DOM, so the app rendered
   * daylight while the settings panel — whose radios check
   * `get('theme') === tile.id` — showed NOTHING selected. The interface and
   * the stored truth disagreed, with no way for the user to tell which was
   * authoritative.
   */
  const settings = await import('../src/app/system/settings.js');
  const { THEMES } = await import('../src/app/system/themes.js');
  const mk = () => { const d = {}; return {
    get: async (k) => ({ [k]: d[k] }), set: async (o) => Object.assign(d, o),
    remove: async () => {}, _d: d }; };

  const st = mk();
  await settings.loadSettings(st);
  await settings.set('theme', 'nonexistent', st);

  assert.equal(settings.get('theme'), 'daylight', 'coerced to the default');
  /* Exactly one theme tile matches what the panel will read. */
  const matching = THEMES.filter((t) => t.id === settings.get('theme'));
  assert.equal(matching.length, 1, 'a real tile is selected');

  /* A REAL theme still round-trips. */
  await settings.set('theme', 'cyberpunk', st);
  assert.equal(settings.get('theme'), 'cyberpunk');
});

test('B4: the theme enum is derived from THEMES, so it cannot drift', async () => {
  /* A hand-written list would go stale the day a theme is added or removed.
     Every shipped theme must be settable, and nothing else may be. */
  const { SCHEMA } = await import('../src/app/system/settings.js');
  const { THEMES } = await import('../src/app/system/themes.js');
  assert.equal(SCHEMA.theme.type, 'enum');
  assert.deepEqual([...SCHEMA.theme.values].sort(), THEMES.map((t) => t.id).sort());
});

/* ========================================================================
 * B5 · plus-tagged self survived contact self-exclusion
 * ==================================================================== */

test('B5: every plus-tagged form of the user is excluded from their contacts', async () => {
  /*
   * MEASURED: self-exclusion compared raw strings, so `me+tag@x.z` appeared
   * in the user's OWN recipient autocomplete. A plus tag is how people file
   * mail, so the variants accumulate — the user ends up autocompleting
   * three versions of themselves.
   *
   * mailboxOf() is the function this codebase already added for exactly
   * this question (round 8, H-1).
   */
  const { buildContacts, mailboxOf } = await import('../src/app/core/contacts.js');
  const ME = 'me@x.z';
  const out = buildContacts([
    { id: '1', from: 'Prof Rao <rao@pilani.bits-pilani.ac.in>', to: ME, date: 5 },
    { id: '2', from: 'x@y.z', to: 'me+tag@x.z', date: 2 },
    { id: '3', from: 'me+newsletter@x.z', to: 'other@z.z', date: 3 },
    { id: '4', from: 'y@y.z', to: 'ME@X.Z', date: 4 },
  ], { selfAddress: ME });

  const selves = out.filter((c) => mailboxOf(c.address) === mailboxOf(ME));
  assert.deepEqual(selves, [], 'no form of the user may appear in their own contacts');
  /* Real correspondents are untouched. */
  assert.ok(out.some((c) => c.address === 'rao@pilani.bits-pilani.ac.in'));
  assert.ok(out.some((c) => c.address === 'other@z.z'));
});

test('B5: a genuinely different mailbox that merely starts with the same letters stays', async () => {
  /* The fold is on the mailbox, not a prefix: `member@x.z` is not `me@x.z`,
     and an over-eager exclusion would silently drop real people. */
  const { buildContacts } = await import('../src/app/core/contacts.js');
  const out = buildContacts([
    { id: '1', from: 'member@x.z', to: 'me@x.z', date: 1 },
    { id: '2', from: 'me@other.z', to: 'me@x.z', date: 2 },
  ], { selfAddress: 'me@x.z' });
  const addrs = out.map((c) => c.address).sort();
  assert.deepEqual(addrs, ['me@other.z', 'member@x.z']);
});
