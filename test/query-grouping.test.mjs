/**
 * OR / parentheses tests for the query grammar.  (Feature 48.)
 *
 * The first implementation was a flat split on the token `OR`, which ignored
 * nesting: `(a OR b) c` put the literal word "OR" into the term list and ANDed
 * the two alternatives, producing a query that could never match. It was
 * caught by RUNNING it, not by reading it, and several tests here exist purely
 * to keep that specific regression dead.
 *
 * The other risk is a PERFORMANCE one that looks like a correctness one: a
 * grouped query must not hand `terms` to the store, because the store
 * intersects postings lists and an intersection cannot express OR.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { parseQuery } = await import('../src/app/search/query.js');

const M = (o = {}) => ({ subject: '', from: '', snippet: '', labels: [], date: 0, ...o });
const match = (q, m, now) => {
  const p = parseQuery(q, now);
  return p.predicate ? p.predicate(M(m)) : true;
};

// -------------------------------------------------------------------- OR --

test('a bare OR matches either side', () => {
  assert.equal(match('category:clubs OR category:events', { category: 'clubs' }), true);
  assert.equal(match('category:clubs OR category:events', { category: 'events' }), true);
  assert.equal(match('category:clubs OR category:events', { category: 'admin' }), false);
});

test('|| is accepted as OR', () => {
  assert.equal(match('is:unread || is:starred', { starred: true }), true);
});

test('or is case-insensitive', () => {
  assert.equal(match('is:unread or is:starred', { starred: true }), true);
});

test('three alternatives all work', () => {
  const q = 'category:a OR category:b OR category:c';
  for (const c of ['a', 'b', 'c']) assert.equal(match(q, { category: c }), true, c);
  assert.equal(match(q, { category: 'd' }), false);
});

// --------------------------------------------------------- the regression --

test('a group followed by another term ANDs correctly', () => {
  // THE BUG: the flat splitter turned this into an impossible query.
  const q = '(category:clubs OR category:events) is:unread';
  assert.equal(match(q, { category: 'clubs', unread: true }), true);
  assert.equal(match(q, { category: 'events', unread: true }), true);
  assert.equal(match(q, { category: 'clubs', unread: false }), false);
  assert.equal(match(q, { category: 'admin', unread: true }), false);
});

test('a term BEFORE a group also ANDs correctly', () => {
  const q = 'is:unread (category:clubs OR category:events)';
  assert.equal(match(q, { category: 'clubs', unread: true }), true);
  assert.equal(match(q, { category: 'clubs', unread: false }), false);
});

test('the literal word OR never leaks into the term list', () => {
  const p = parseQuery('(category:clubs OR category:events) is:unread');
  assert.deepEqual(p.terms, [], 'a grouped query hands nothing to the index');
  assert.equal(p.grouped, true);
});

test('nesting two levels deep works', () => {
  const q = '(is:unread (category:a OR category:b)) OR is:starred';
  assert.equal(match(q, { category: 'z', starred: true }), true);
  assert.equal(match(q, { category: 'a', unread: true }), true);
  assert.equal(match(q, { category: 'z', unread: true }), false);
});

// -------------------------------------------------------------- negation --

test('a negated group excludes everything inside it', () => {
  const q = '-(category:clubs OR category:events)';
  assert.equal(match(q, { category: 'admin' }), true);
  assert.equal(match(q, { category: 'clubs' }), false);
  assert.equal(match(q, { category: 'events' }), false);
});

test('the shape of every real filter: category except one sender', () => {
  const q = 'category:academics -from:bot';
  assert.equal(match(q, { category: 'academics', from: 'prof@x.com' }), true);
  assert.equal(match(q, { category: 'academics', from: 'bot@x.com' }), false);
});

test('negation inside a group is respected', () => {
  const q = '(category:academics -from:bot) OR is:starred';
  assert.equal(match(q, { category: 'academics', from: 'bot@x.com' }), false);
  assert.equal(match(q, { category: 'academics', from: 'bot@x.com', starred: true }), true);
});

// ------------------------------------------------------------ free text --

test('free text works as an OR alternative', () => {
  assert.equal(match('urgent OR is:starred', { subject: 'URGENT: fees' }), true);
  assert.equal(match('urgent OR is:starred', { subject: 'nothing' }), false);
});

test('a quoted phrase containing a bracket is text, not structure', () => {
  const p = parseQuery('"exam (revised)"');
  assert.equal(p.grouped, undefined, 'quoted brackets do not trigger the grouped parser');
});

// -------------------------------------------------- the flat path is intact --

test('a query with no OR still uses the inverted index', () => {
  const p = parseQuery('from:augsd hello');
  assert.deepEqual(p.terms, ['hello'], 'free text still goes to the index');
  assert.notEqual(p.grouped, true);
});

test('an ordinary flat query is unchanged by this feature', () => {
  const p = parseQuery('is:unread category:academics');
  assert.equal(p.predicate(M({ unread: true, category: 'academics' })), true);
  assert.equal(p.predicate(M({ unread: false, category: 'academics' })), false);
});

// ------------------------------------------------------- malformed input --

test('unbalanced parentheses do not throw', () => {
  for (const q of ['(is:unread', 'is:unread)', '((((a OR b', 'a OR', 'OR b', '()', '-(']) {
    assert.doesNotThrow(() => parseQuery(q), q);
  }
});

test('a trailing OR does not match everything', () => {
  // `a OR` with an empty right side must not become "match anything".
  const p = parseQuery('category:clubs OR');
  assert.equal(p.predicate(M({ category: 'clubs' })), true);
});

test('absurd nesting terminates rather than overflowing the stack', () => {
  const q = '('.repeat(200) + 'is:unread' + ')'.repeat(200);
  assert.doesNotThrow(() => parseQuery(q).predicate(M({ unread: true })));
});

test('operators from inside groups are reported for the query description', () => {
  const p = parseQuery('(category:clubs OR category:events)');
  assert.deepEqual(p.operators.map((o) => o.value).sort(), ['clubs', 'events']);
});
