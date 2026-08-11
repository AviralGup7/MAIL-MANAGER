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
import { Store } from '../src/app/store.js';
import {
  visibleIds, mutedHiddenCount, applyMute, collapseThreads, matchesQuery,
} from '../src/app/selectors.js';

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
  // predicate-only query: no terms, so idsFor('all') is the base.
  // msg(2) is the clubs one (see msg(): odd = augsd, even = clubs).
  const ctx = ctxFor(store, { query: 'x', parse: parseWith((m) => m.category === 'clubs') });
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
