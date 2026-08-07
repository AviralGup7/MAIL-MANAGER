/**
 * Search suggestion tests.
 *
 * The failure mode to avoid is a suggestion that produces a query returning
 * nothing. A control that confidently offers a dead end is worse than no
 * control, because the user concludes the search itself is broken.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStorage } from './helpers/storage.mjs';

const {
  suggest, currentToken, isComplete, addToHistory, normaliseHistory,
  loadHistory, saveHistory, OPERATORS, MAX_HISTORY,
} = await import('../src/app/suggest.js');
const { parseQuery } = await import('../src/app/query.js');

const CTX = {
  history: [{ q: 'from:augsd registration', at: 5 }, { q: 'is:overdue', at: 4 }],
  views: [{ name: 'Just for me', query: 'is:direct is:unread' }],
  senders: ['augsd@pilani.bits-pilani.ac.in', 'psd@pilani.bits-pilani.ac.in'],
  labels: ['Thesis', 'Placement'],
  categories: [{ key: 'academics' }, { key: 'clubs' }],
};

// -------------------------------------------------------------- tokenising --

test('the token under the caret is isolated, leaving the rest intact', () => {
  const t = currentToken('is:unread from:aug');
  assert.equal(t.token, 'from:aug');
  assert.equal(t.prefix, 'is:unread ');
});

test('an empty box has an empty token', () => {
  assert.equal(currentToken('').token, '');
});

// ------------------------------------------------------------ empty state --

test('an empty box offers recent searches first', () => {
  const out = suggest('', CTX);
  assert.equal(out[0].type, 'history');
  assert.equal(out[0].value, 'from:augsd registration');
});

test('an empty box also offers saved views and then the vocabulary', () => {
  const out = suggest('', CTX);
  assert.ok(out.some((s) => s.type === 'view'));
  assert.ok(out.some((s) => s.type === 'operator'));
});

// ------------------------------------------------------------- completion --

test('typing an operator prefix suggests the operator', () => {
  const out = suggest('is:un', CTX);
  assert.ok(out.some((s) => s.value === 'is:unread'), JSON.stringify(out));
});

test('typing from: suggests senders THAT ARE ACTUALLY IN THE MAILBOX', () => {
  /*
   * The first version of this test only asserted that the real sender was
   * PRESENT, which stayed green when a fabricated address was added alongside
   * it. Every suggestion must be executable -- one that is not is a dead end
   * the user blames the search for -- so this now asserts the whole list is
   * drawn from the supplied data.
   */
  const out = suggest('from:aug', CTX);
  assert.ok(out.some((s) => s.value === 'from:augsd@pilani.bits-pilani.ac.in'));

  for (const s of out.filter((x) => x.type === 'value')) {
    const address = s.value.slice(s.value.indexOf(':') + 1);
    assert.ok(
      CTX.senders.includes(address),
      `"${address}" is not a sender in the mailbox — the list invented it`
    );
  }
});

test('a value suggestion never invents data the mailbox does not have', () => {
  // The same guarantee for labels and categories.
  for (const [probe, allowed] of [['label:', CTX.labels], ['category:', CTX.categories.map((c) => c.key)]]) {
    for (const s of suggest(probe, CTX).filter((x) => x.type === 'value')) {
      const v = s.value.slice(s.value.indexOf(':') + 1);
      assert.ok(allowed.includes(v), `${probe} suggested "${v}", which does not exist`);
    }
  }
});

test('typing label: suggests real labels', () => {
  assert.ok(suggest('label:the', CTX).some((s) => s.value === 'label:Thesis'));
});

test('typing category: suggests real categories', () => {
  assert.ok(suggest('category:aca', CTX).some((s) => s.value === 'category:academics'));
});

test('a suggestion preserves what was already typed before it', () => {
  /*
   * This test was worthless as first written: it used `every` over a list, and
   * dropping the prefix entirely left it green because the assertion is
   * vacuously true when nothing matches. It now requires the list to be
   * non-empty and checks a specific expected completion.
   */
  const out = suggest('is:unread from:aug', CTX);
  assert.ok(out.length > 0, 'the probe produced suggestions at all');
  assert.ok(
    out.some((s) => s.value === 'is:unread from:augsd@pilani.bits-pilani.ac.in'),
    `prefix was dropped: ${JSON.stringify(out.map((s) => s.value))}`
  );
  for (const s of out) {
    assert.ok(s.value.startsWith('is:unread '), `"${s.value}" lost the earlier term`);
  }

  /*
   * AND SPECIFICALLY THE OPERATOR PATH.
   *
   * The check above passed even with the prefix stripped from operator
   * suggestions, because this probe only produces VALUE suggestions and those
   * build their prefix separately. Two code paths, one of them untested. A
   * probe that lands on the operator branch is needed to cover it.
   */
  const ops = suggest('is:unread has:', CTX).filter((x) => x.type === 'operator');
  assert.ok(ops.length > 0, 'the probe reached the operator branch');
  for (const s of ops) {
    assert.ok(s.value.startsWith('is:unread '), `operator "${s.value}" lost the earlier term`);
  }
});

test('EVERY SUGGESTION PARSES INTO A REAL QUERY', () => {
  const seen = new Set();
  for (const probe of ['', 'is:', 'is:un', 'from:', 'from:aug', 'label:', 'category:', 'over', 'has:']) {
    for (const s of suggest(probe, CTX)) {
      if (seen.has(s.value)) continue;
      seen.add(s.value);
      const p = parseQuery(s.value);
      // Either it resolves to an operator, or it is a partial the user keeps
      // typing (`from:`), or it is free text from history.
      const usable = p.operators.length > 0 || p.terms.length > 0 || !isComplete(s);
      assert.ok(usable, `"${s.value}" suggests nothing usable`);
    }
  }
  assert.ok(seen.size > 10, 'the probe actually exercised the list');
});

test('a partial operator is marked incomplete so the caret stays put', () => {
  assert.equal(isComplete({ value: 'from:' }), false);
  assert.equal(isComplete({ value: 'is:unread' }), true);
});

test('the list is capped', () => {
  assert.ok(suggest('', { ...CTX, limit: 3 }).length <= 3);
});

test('no duplicates appear in one list', () => {
  const values = suggest('is:', CTX).map((s) => s.value);
  assert.equal(new Set(values).size, values.length);
});

test('suggesting against an empty context does not throw', () => {
  for (const probe of ['', 'x', 'from:', 'is:un']) {
    assert.doesNotThrow(() => suggest(probe, {}));
  }
});

// ---------------------------------------------------------------- history --

test('a real query is remembered', () => {
  const h = addToHistory([], 'from:augsd registration', 1);
  assert.equal(h[0].q, 'from:augsd registration');
});

test('TYPING FORWARD THROUGH ONE SEARCH LEAVES ONE ENTRY', () => {
  /*
   * Without this, searching for "registration" writes "regi", "regis",
   * "registr"... and the history is six prefixes of one search.
   */
  let h = [];
  for (const q of ['regi', 'regis', 'registr', 'registration']) h = addToHistory(h, q, 1);
  assert.equal(h.length, 1);
  assert.equal(h[0].q, 'registration');
});

test('trivially short queries are not remembered', () => {
  assert.deepEqual(addToHistory([], 'ab', 1), []);
});

test('re-running an old search moves it to the top rather than duplicating', () => {
  let h = addToHistory([], 'is:overdue', 1);
  h = addToHistory(h, 'from:psd', 2);
  h = addToHistory(h, 'is:overdue', 3);
  assert.equal(h.length, 2);
  assert.equal(h[0].q, 'is:overdue');
});

test('history is capped', () => {
  let h = [];
  for (let i = 0; i < MAX_HISTORY + 20; i++) h = addToHistory(h, `query number ${i}`, i);
  assert.ok(h.length <= MAX_HISTORY);
});

test('a corrupt history blob degrades to empty', () => {
  for (const bad of [null, 'x', 7, {}, [null], [{ q: 5 }]]) {
    assert.deepEqual(normaliseHistory(bad), []);
  }
});

test('history round-trips through storage', async () => {
  const s = fakeStorage();
  await saveHistory(addToHistory([], 'from:augsd', 1), s);
  assert.equal((await loadHistory(s))[0].q, 'from:augsd');
});

test('a failing storage write reports false', async () => {
  assert.equal(await saveHistory([{ q: 'x', at: 1 }], fakeStorage()._fail()), false);
});

// ------------------------------------------------------------- vocabulary --

test('every advertised operator has a hint a human can read', () => {
  for (const o of OPERATORS) {
    assert.ok(o.op, 'has an operator');
    assert.match(o.hint, /\S/, `${o.op} has a hint`);
  }
});

test('the vocabulary advertises the OR grammar, which is otherwise invisible', () => {
  assert.ok(OPERATORS.some((o) => o.op === 'OR'));
  assert.ok(OPERATORS.some((o) => o.op === '-'));
});
