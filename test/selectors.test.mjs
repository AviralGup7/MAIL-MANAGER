/**
 * Selector tests (audit 39/40 ARCH R-6).
 *
 * The derived-state choke point used to live inside app.js, exercisable only
 * by booting the whole app. Now it is pure functions of (store, ctx), so the
 * exact rules every render path depends on are pinned here directly: mute
 * scoping, threading collapse, query predicates, and the server-search
 * overlay merge.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/app/mail/store.js';
import {
  visibleIds, mutedHiddenCount, applyMute, collapseThreads, matchesQuery,
} from '../src/app/core/selectors.js';

function msg(i, over = {}) {
  return {
    id: `m${i}`,
    threadId: `t${Math.floor(i / 2)}`, // pairs share a thread
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

const inbox = (msgs) => {
  const s = new Store();
  s.upsertMany(msgs);
  return s;
};

/** A no-op parse: terms only, no predicate. */
const plainParse = (q) => ({ terms: q.split(/\s+/).filter(Boolean), predicate: null });

/** A parse that adds a predicate (e.g. from the real operator language). */
const parseWith = (predicate) => (q) => ({ terms: q.split(/\s+/).filter(Boolean), predicate });

const ctxFor = (store, over = {}) => ({
  mailbox: 'inbox',
  category: 'all',
  query: '',
  threaded: false,
  muted: [],
  parse: plainParse,
  overlay: { ids: () => [], get: () => undefined },
  ...over,
});

// ------------------------------------------------------------- mute scope --

test('mute hides muted categories in All mail, and only there', () => {
  const store = inbox([msg(1, { category: 'clubs' }), msg(2, { category: 'augsd' })]);
  const ctx = ctxFor(store, { muted: ['clubs'] });
  assert.deepEqual(visibleIds(store, ctx), ['m2'], 'clubs hidden from All mail');
  assert.equal(mutedHiddenCount(store, ctx), 1);
});

test('a named category ignores mutes — the user asked for it by name', () => {
  const store = inbox([msg(1, { category: 'clubs' }), msg(2, { category: 'augsd' })]);
  const ctx = ctxFor(store, { category: 'clubs', muted: ['clubs'] });
  assert.deepEqual(visibleIds(store, ctx), ['m1'], 'named category still shows');
  assert.equal(mutedHiddenCount(store, ctx), 0);
});

test('a search ignores mutes — mail must stay findable', () => {
  const store = inbox([msg(1, { category: 'clubs' }), msg(2, { category: 'augsd' })]);
  const ctx = ctxFor(store, { query: 'registration', muted: ['clubs'] });
  const ids = visibleIds(store, ctx);
  assert.ok(ids.includes('m1'), 'muted mail is findable in search');
  assert.equal(mutedHiddenCount(store, ctx), 0, 'and the counter knows search is active');
});

test('mutes only apply to the inbox mailbox', () => {
  const store = inbox([msg(1, { category: 'clubs' }), msg(2, { category: 'augsd' })]);
  const ctx = ctxFor(store, { mailbox: 'sent', muted: ['clubs'] });
  assert.deepEqual(visibleIds(store, ctx), ['m2', 'm1'], 'no mute outside inbox');
});

// ---------------------------------------------------------------- threading --

test('threading collapses to one row per conversation', () => {
  const store = inbox([msg(0), msg(1), msg(2), msg(3)]); // t0,t0,t1,t1
  const ctx = ctxFor(store, { threaded: true });
  const ids = visibleIds(store, ctx);
  assert.deepEqual(ids, ['m3', 'm1'], 'newest message per thread');
});

test('search is deliberately NOT collapsed', () => {
  const store = inbox([msg(0), msg(1)]); // same thread
  const ctx = ctxFor(store, { query: 'registration', threaded: true });
  const ids = visibleIds(store, ctx);
  assert.equal(ids.length, 2, 'both messages of the thread match search');
});

// ------------------------------------------------------------- query + pred --

test('a query narrows through the store index and the predicate', () => {
  const store = inbox([
    msg(1, { subject: 'Fee payment deadline' }),
    msg(2, { subject: 'Hackathon invite' }),
  ]);
  const ctx = ctxFor(store, { query: 'fee', parse: parseWith((m) => m.subject.includes('payment')) });
  assert.deepEqual(visibleIds(store, ctx), ['m1']);
});

test('the predicate still applies when the index returns nothing', () => {
  const store = inbox([msg(1), msg(2)]);
  /*
   * A PREDICATE-ONLY query: `is:unread`-shaped, so the real parser yields NO
   * terms and the base is idsFor('all'). The stub used to be handed 'x',
   * which produced terms:['x'] and only looked predicate-only because the
   * store happened to return everything for an unusable single character.
   * Round 8's M-2 fixed that (a term nothing can match now matches nothing),
   * which exposed the stub as the thing that was wrong: it was testing the
   * old bug, not the intended behaviour. Terms are empty here, which is what
   * "predicate-only" actually means.
   */
  const ctx = ctxFor(store, {
    query: 'is:clubs',
    parse: () => ({ terms: [], predicate: (m) => m.category === 'clubs' }),
  });
  assert.deepEqual(visibleIds(store, ctx), ['m2']);
});

test('matchesQuery checks terms against subject + from + snippet', () => {
  assert.equal(matchesQuery({ subject: 'Reg', from: 'x', snippet: 'y' }, { terms: ['reg'], predicate: null }), true);
  assert.equal(matchesQuery({ subject: 'Hi', from: 'x', snippet: 'y' }, { terms: ['reg'], predicate: null }), false);
  assert.equal(matchesQuery({ subject: 'Hi', from: 'x', snippet: 'reg here' }, { terms: ['reg'], predicate: null }), true);
});

// ------------------------------------------------------- server-search merge --

test('server-search overlay ids merge in under a query, deduped and filtered', () => {
  const store = inbox([msg(1, { subject: 'Real result' }), msg(2)]);
  const overlay = {
    ids: () => ['s1', 's2', 'm1'],           // m1 duplicates a local hit
    get: (id) => ({ id, subject: id === 's1' ? 'Remote result hit' : 'other', from: '', snippet: '' }),
  };
  const ctx = ctxFor(store, {
    query: 'result',
    parse: parseWith((m) => /result|Remote/.test(m.subject || '')),
    overlay,
  });
  const ids = visibleIds(store, ctx);
  assert.deepEqual(ids, ['m1', 's1'], 'local first, overlay appended, deduped, filtered');
});

test('the overlay is inert without a query', () => {
  const store = inbox([msg(1)]);
  const overlay = { ids: () => ['s1'], get: () => ({ id: 's1', subject: 'x' }) };
  const ctx = ctxFor(store, { overlay });
  assert.deepEqual(visibleIds(store, ctx), ['m1'], 'no query, no overlay merge');
});

// ------------------------------------------------------------------- guard --

test('applyMute is a no-op when the muted list is empty', () => {
  const store = inbox([msg(1)]);
  assert.deepEqual(applyMute(store.idsFor('all'), store, ctxFor(store)), ['m1']);
});

test('collapseThreads is a pass-through when threading is off', () => {
  const store = inbox([msg(0), msg(1)]);
  assert.deepEqual(collapseThreads(store.idsFor('all'), store, { threaded: false }), ['m1', 'm0']);
});

/*
 * Contract extensions on top of the R-6 commit. The original suite pins each
 * mechanism alone; these pin their INTERACTIONS, which is where an extraction
 * like this most plausibly reorders work.
 */

test('mutes apply BEFORE threading collapse, and hide whole threads', () => {
  // The contract being pinned: a thread whose messages are all muted
  // disappears ENTIRELY (no phantom row), and the hidden-count counts
  // messages, not threads. Removing the mute step from visibleIds, or
  // making the counter count threads, fails this.
  const store = inbox([
    msg(0, { category: 'clubs', subject: 'Thread root about registration' }),
    msg(1, { category: 'clubs', subject: 'Reply about registration' }), // same thread, muted
    msg(2, { category: 'augsd', subject: 'Other thread about registration' }),
  ]);
  const ctx = ctxFor(store, { muted: ['clubs'], threaded: true });
  assert.deepEqual(
    visibleIds(store, ctx), ['m2'],
    'a fully-muted thread disappears entirely; the unmuted thread collapses to its root'
  );
  assert.equal(mutedHiddenCount(store, ctx), 2, 'counter counts messages, not threads');
});

test('an overlay hit that misses the TERMS is refused, not just the predicate', () => {
  // matchesQuery guards both halves. A server hit for a different word must
  // not ride the query into the list just because it passes the predicate.
  const store = inbox([msg(1, { subject: 'Real result' })]);
  const overlay = {
    ids: () => ['s1'],
    // passes the predicate, does NOT contain the term 'result':
    get: () => ({ id: 's1', subject: 'unrelated', from: '', snippet: '' }),
  };
  const ctx = ctxFor(store, {
    query: 'result',
    parse: parseWith(() => true),
    overlay,
  });
  assert.deepEqual(visibleIds(store, ctx), ['m1']);
});

test('an overlay id whose record vanished is skipped, not fatal', () => {
  // The overlay is ephemeral by design; a record can be gone by merge time.
  const store = inbox([msg(1, { subject: 'result' })]);
  const overlay = { ids: () => ['ghost', 'm1'], get: () => undefined };
  const ctx = ctxFor(store, { query: 'result', overlay });
  assert.deepEqual(visibleIds(store, ctx), ['m1']);
});

test('a predicate-null parse leaves the index result untouched', () => {
  // applyPredicate with no predicate must return the SAME array semantics:
  // nothing dropped, nothing reordered.
  const store = inbox([msg(1, { subject: 'fee notice' }), msg(2, { subject: 'fee reminder' })]);
  const ctx = ctxFor(store, { query: 'fee' }); // plainParse: terms, no predicate
  assert.deepEqual(visibleIds(store, ctx), ['m2', 'm1']);
});

test('a query that parsed to nothing matches nothing (round 8, M-1)', () => {
  /*
   * parseQuery('a OR') and parseQuery('((') yield no terms, no operators and
   * a null predicate: the struct claimed to be a real filter while carrying
   * nothing to filter with, so visibleIds fell through to idsFor(category)
   * and returned the whole inbox. The user typed a filter, saw everything,
   * and had no signal it was not understood -- while '"unclosed' correctly
   * returned zero, so the behaviour was not even self-consistent.
   */
  const store = inbox([msg(1), msg(2), msg(3)]);
  const ctx = ctxFor(store, {
    query: 'a OR',
    parse: () => ({ terms: [], operators: [], isEmpty: true, unparsed: true, predicate: null }),
  });
  assert.deepEqual(visibleIds(store, ctx), [],
    'showing nothing says "that matched nothing" instead of "that matched everything"');
});
