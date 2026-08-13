/**
 * Failure injection across every persistence module.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `views.js` had three mutators (`removeView` x2 paths, `restoreBuiltins`)
 * that called `storage.set` unguarded while its fourth (`saveView`) returned
 * `{ok:false,error}`. A failing write therefore REJECTED out of them — and
 * both callers are `async` click handlers with no `.catch`, so the rejection
 * disappeared into an unhandled promise. The view stayed on screen, the
 * success toast never fired, and the user was told nothing at all.
 *
 * The root cause was not a missing try/catch. It was that two of three
 * mutators had no channel to report failure through, so there was nowhere for
 * the error to go.
 *
 * These tests drive EVERY persistence entry point against a backend that
 * rejects, because that is what quota exhaustion and revoked storage
 * permissions actually look like at runtime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const R = new URL('../src/app/', import.meta.url);
const load = (m) => import(new URL(m, R).href);

/** Storage that rejects every operation. */
const hostile = () => ({
  async get() { throw new Error('read fail'); },
  async set() { throw new Error('QUOTA_BYTES quota exceeded'); },
  async remove() { throw new Error('remove fail'); },
});

/** Storage that reads fine but cannot write — the commonest real failure. */
const readOnly = (seed = {}) => ({
  async get(k) {
    if (typeof k === 'string') return k in seed ? { [k]: seed[k] } : {};
    if (Array.isArray(k)) {
      const o = {};
      for (const x of k) if (x in seed) o[x] = seed[x];
      return o;
    }
    return { ...seed };
  },
  async set() { throw new Error('QUOTA_BYTES quota exceeded'); },
  async remove() { throw new Error('QUOTA_BYTES quota exceeded'); },
});

const working = () => {
  const d = {};
  return {
    async get(k) {
      if (typeof k === 'string') return k in d ? { [k]: d[k] } : {};
      if (Array.isArray(k)) {
        const o = {};
        for (const x of k) if (x in d) o[x] = d[x];
        return o;
      }
      return { ...d };
    },
    async set(o) { Object.assign(d, o); },
    async remove(k) { for (const x of [].concat(k)) delete d[x]; },
  };
};

/**
 * Every persistence entry point in the app, as callables.
 * Adding a module here is the point: the sweep below is generic.
 */
async function entryPoints(storage) {
  const rules = await load('rules.js');
  const snooze = await load('snooze.js');
  const draft = await load('draft-store.js');
  const settings = await load('settings.js');
  const cache = await load('cache.js');
  const views = await load('views.js');

  return [
    ['rules.loadRules', () => rules.loadRules(storage)],
    ['rules.saveRules', () => rules.saveRules(rules.emptyRules(), storage)],
    ['snooze.loadSnoozed', () => snooze.loadSnoozed(storage)],
    ['snooze.addSnooze', () => snooze.addSnooze('m1', Date.now(), storage)],
    ['snooze.removeSnooze', () => snooze.removeSnooze('m1', storage)],
    ['draft.saveDraft', () => draft.saveDraft({ to: 'a@b.com' }, storage)],
    ['draft.loadDraft', () => draft.loadDraft(storage)],
    ['draft.clearDraft', () => draft.clearDraft(storage)],
    ['settings.loadSettings', () => settings.loadSettings(storage)],
    /*
     * settings.set is NOT in this sweep, deliberately. Bug-hunt 43 #17 made
     * it the ONE persistence call that rejects, because a silently-lost
     * preference reverted at next boot with no channel to say so; options.js
     * wraps every write in persist() and app.js callers use .catch. Its
     * stronger contract — reject loudly, roll the cache back — is pinned in
     * its own test below instead of being averaged away by this list.
     */
    ['cache.loadCache', () => cache.loadCache(storage)],
    ['cache.saveCache', () => cache.saveCache([], storage)],
    ['cache.clearCache', () => cache.clearCache(storage)],
    ['views.loadViews', () => views.loadViews(storage)],
    ['views.saveView', () => views.saveView('N', 'is:unread', storage)],
    ['views.removeView', () => views.removeView('sv-x', storage)],
    ['views.removeView(builtin)', () => views.removeView('unread', storage)],
    ['views.restoreBuiltins', () => views.restoreBuiltins(storage)],
  ];
}

test('no persistence call rejects when storage is entirely hostile', async () => {
  const leaks = [];
  for (const [name, fn] of await entryPoints(hostile())) {
    try {
      await fn();
    } catch (err) {
      leaks.push(`${name}: ${err.message}`);
    }
  }
  assert.deepEqual(
    leaks, [],
    'these reject instead of degrading; their callers are async handlers with no .catch'
  );
});

test('settings.set rejects loudly and rolls the cache back (bug-hunt 43 #17)', async () => {
  /*
   * The exception to the sweep is the strictest contract in the file, not a
   * hole in it: the write must REJECT with a typed error the callers surface
   * (options.js persist(), app.js .catch), and the in-memory value must go
   * back to what it was, so a failed write never masquerades as a saved one.
   */
  const settings = await load('settings.js');
  const storage = readOnly({ theme: 'midnight' });
  await settings.loadSettings(storage);
  assert.equal(settings.get('theme'), 'midnight');

  await assert.rejects(
    settings.set('theme', 'nord', storage),
    /SETTINGS_PERSIST_FAILED: theme/,
    'the failure must reach the caller so it can be shown'
  );
  assert.equal(settings.get('theme'), 'midnight', 'the cache must roll back');
});

test('no persistence call rejects when writes fail but reads work', async () => {
  // Quota exhaustion is exactly this shape, and it is the likeliest of the
  // two in practice: the data is readable, the write is refused.
  const leaks = [];
  for (const [name, fn] of await entryPoints(readOnly())) {
    try {
      await fn();
    } catch (err) {
      leaks.push(`${name}: ${err.message}`);
    }
  }
  assert.deepEqual(leaks, [], 'a full disk must not produce unhandled rejections');
});

/*
 * Degrading silently is only half correct. A mutator that swallows a failure
 * and reports success is worse than one that throws, because the UI then shows
 * a confirmation for something that did not happen.
 */
test('every views mutator reports failure rather than claiming success', async () => {
  const views = await load('views.js');
  const s = readOnly();

  for (const [name, fn] of [
    ['saveView', () => views.saveView('N', 'is:unread', s)],
    ['removeView', () => views.removeView('sv-x', s)],
    ['removeView(builtin)', () => views.removeView('unread', s)],
    ['restoreBuiltins', () => views.restoreBuiltins(s)],
  ]) {
    const res = await fn();
    assert.equal(res?.ok, false, `${name} must report ok:false when the write fails`);
    assert.ok(res.error && typeof res.error === 'string', `${name} must explain itself`);
  }
});

test('every views mutator reports success when the write lands', async () => {
  // The negative test above passes trivially if everything always fails.
  const views = await load('views.js');
  const s = working();
  assert.equal((await views.saveView('N', 'is:unread', s)).ok, true);
  assert.equal((await views.removeView('unread', s)).ok, true);
  assert.equal((await views.restoreBuiltins(s)).ok, true);
});

test('the caller surfaces a failed view removal instead of assuming success', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/app/main.js', import.meta.url), 'utf8');
  const at = app.indexOf('data-remove-view');
  assert.ok(at > 0);
  const block = app.slice(at, at + 600);
  assert.ok(
    /res\?\.ok === false/.test(block),
    'the click handler must check the result, not toast unconditionally'
  );
});

/*
 * Storage that returns GARBAGE rather than failing. A previous extension
 * version, a corrupted profile or a partially-written blob all produce this,
 * and it must never reach a render path as `undefined`.
 */
test('corrupt stored values never crash a loader', async () => {
  const junk = [null, 0, 'string', [], { nested: { deep: true } }, true, NaN];
  const rules = await load('rules.js');
  const snooze = await load('snooze.js');
  const draft = await load('draft-store.js');
  const views = await load('views.js');
  const cache = await load('cache.js');

  /*
   * Keys must match the real ones, or this test seeds nothing and passes
   * vacuously. Discovered the hard way: the first version wrote `bmmCache`
   * while cache.js reads `msgCache`, so the "corrupt cache" case was never
   * actually exercised.
   */
  const KEYS = {
    rules: 'categoryRules',
    snooze: 'snoozed',
    draft: 'composeDraft',
    views: 'savedViews',
    cache: 'msgCache',
  };

  for (const bad of junk) {
    const s = working();
    await s.set({
      [KEYS.rules]: bad, [KEYS.snooze]: bad, [KEYS.draft]: bad,
      [KEYS.views]: bad, [KEYS.cache]: bad,
    });

    const r = await rules.loadRules(s);
    assert.ok(Array.isArray(r.muted), `rules.muted not an array for ${JSON.stringify(bad)}`);
    assert.ok(Array.isArray(r.autoArchive));

    const sn = await snooze.loadSnoozed(s);
    assert.equal(typeof sn, 'object');
    assert.doesNotThrow(() => snooze.due(sn, Date.now()));
    assert.doesNotThrow(() => snooze.pending(sn, Date.now()));

    const d = await draft.loadDraft(s);
    assert.ok(d === null || typeof d === 'object');

    const v = await views.loadViews(s);
    assert.ok(Array.isArray(v), 'views must always be an array');

    /*
     * `loadCache` returns `{messages, savedAt}` or NULL, not an array — the
     * caller guards with `cached?.messages.length`. An earlier version of this
     * test asserted "always an array" and failed; that was the test being
     * wrong about the contract, not the product. What actually matters is that
     * corrupt input never yields a shape the caller would dereference.
     */
    const c = await cache.loadCache(s);
    assert.ok(
      c === null || Array.isArray(c.messages),
      `cache returned an undereferenceable shape for ${JSON.stringify(bad)}`
    );
  }
});

/* ========================================================================== *
 * THE NETWORK TRUST BOUNDARY
 *
 * `normalise()` is the single place remote data enters the app. It used to
 * copy header values verbatim, which broke two ways: a header with no `name`
 * (or a null entry) threw and killed an entire page of messages, and a
 * non-string `value` passed straight through so `subject` could be a number.
 * Downstream, `classify()` calls `.toLowerCase()` and `buildReply()` calls
 * `.replace()` — both throw on a non-string. Fuzzing found all three.
 * ========================================================================== */

test('normalise survives every malformed header shape', async () => {
  const { normalise } = await import('../src/background/gmail.js');

  const cases = [
    ['header with no name', { id: '1', payload: { headers: [{ value: 'x' }] } }],
    ['null header entry', { id: '1', payload: { headers: [null] } }],
    ['undefined header entry', { id: '1', payload: { headers: [undefined] } }],
    ['numeric header value', { id: '1', payload: { headers: [{ name: 'Subject', value: 7 }] } }],
    ['object header value', { id: '1', payload: { headers: [{ name: 'From', value: { a: 1 } }] } }],
    ['array header value', { id: '1', payload: { headers: [{ name: 'Subject', value: ['a'] }] } }],
    ['headers not an array', { id: '1', payload: { headers: 'nope' } }],
    ['labelIds not an array', { id: '1', labelIds: 'INBOX' }],
    ['numeric snippet', { id: '1', snippet: 42 }],
    ['numeric id', { id: 7 }],
    ['no payload at all', { id: '1' }],
  ];

  for (const [name, raw] of cases) {
    let out;
    assert.doesNotThrow(() => { out = normalise(raw); }, `${name} threw`);
    assert.ok(out, `${name} returned nothing`);
    for (const field of ['id', 'threadId', 'from', 'subject', 'snippet']) {
      assert.equal(typeof out[field], 'string', `${name}: ${field} is ${typeof out[field]}`);
    }
    assert.equal(typeof out.date, 'number');
    assert.ok(Array.isArray(out.labels), `${name}: labels must be an array`);
  }
});

test('an object header value does not become the text "[object Object]"', async () => {
  // Coercing with String() would make that string searchable and displayable.
  const { normalise } = await import('../src/background/gmail.js');
  const out = normalise({ id: '1', payload: { headers: [{ name: 'Subject', value: { a: 1 } }] } });
  assert.ok(!/object Object/.test(out.subject), `leaked: ${out.subject}`);
});

test('normalised output never crashes the consumers downstream of it', async () => {
  /*
   * The end-to-end property: whatever the network returns, the pipeline that
   * consumes it must not throw. This is the test that would have caught the
   * original bug, because it exercises the real chain rather than one link.
   */
  const { normalise } = await import('../src/background/gmail.js');
  const { classify } = await import('../src/classify/index.js');
  const { extractDeadline } = await import('../src/app/academic/deadlines.js');
  const { buildReply } = await import('../src/app/search/query.js');

  const hostile = [
    { id: '1', payload: { headers: [{ name: 'Subject', value: 123 }] } },
    { id: '2', payload: { headers: [{ name: 'From', value: {} }] } },
    { id: '3', payload: { headers: [{ value: 'nameless' }] } },
    { id: '4', snippet: 999, labelIds: 'INBOX' },
    { id: '5', payload: { headers: [{ name: 'Subject', value: 'due 32/13/2026' }] } },
    { id: '6', payload: { headers: [{ name: 'Subject', value: 'x'.repeat(20000) }] } },
    { id: '7', payload: { headers: [{ name: 'From', value: '\u0000\uD800' }] } },
  ];

  for (const raw of hostile) {
    const m = normalise(raw);
    assert.doesNotThrow(() => classify(m), `classify threw on ${raw.id}`);
    assert.doesNotThrow(() => extractDeadline(m), `extractDeadline threw on ${raw.id}`);
    assert.doesNotThrow(() => buildReply(m, 'me@x.com', 'reply'), `buildReply threw on ${raw.id}`);
  }
});

test('pure modules survive adversarial query and address input', async () => {
  const { parseQuery } = await import('../src/app/search/query.js');
  const contacts = await import('../src/app/core/contacts.js');

  const NASTY = [
    '', ' ', '\n', 'a'.repeat(10000), '"unterminated', 'from:', ':', '::',
    'is:::x', '((()))', 'a OR b', '\u0000', '\uD800', '👍'.repeat(100),
    '<script>alert(1)</script>', "'; DROP TABLE--", 'before:notadate',
    'after:9999-99-99', '-'.repeat(500),
  ];
  const probe = { subject: 'x', from: 'a@b.c', snippet: 'z', date: Date.now() };

  for (const q of NASTY) {
    assert.doesNotThrow(() => {
      const parsed = parseQuery(q);
      if (parsed.predicate) parsed.predicate(probe);
    }, `parseQuery threw on ${JSON.stringify(q.slice(0, 40))}`);
  }

  for (const a of ['', '<>', 'a@', '@b', 'a@b@c', '"'.repeat(50), 'x'.repeat(5000)]) {
    assert.doesNotThrow(() => {
      contacts.parseAddress(a);
      contacts.parseAddressList(a);
      contacts.currentFragment(a);
      contacts.completeValue(a, 'x@y.z');
    }, `contacts threw on ${JSON.stringify(a)}`);
  }

  // A regex metacharacter in the query must not blow up the matcher.
  const book = contacts.buildContacts([null, undefined, {}, { from: 1 }, { to: {} }]);
  for (const q of ['(', '\\', '[', '*', '+?']) {
    assert.doesNotThrow(() => contacts.matchContacts(book, q), `matchContacts threw on ${q}`);
  }
});

/* ========================================================================== *
 * ONE HEADER PARSER, NOT THREE
 *
 * `for (const { name, value } of headers)` appeared in THREE places:
 * `normalise` in gmail.js, and both the message and part loops in
 * `extractBody`. All three destructure without checking, so a header with no
 * `name` — or a null entry — threw.
 *
 * The blast radius differed per site (a whole page of mail vs one unreadable
 * message), but the assumption was identical, which is why the fix was to
 * extract `headerMap` rather than to add three guards.
 * ========================================================================== */

test('headerMap tolerates every malformed header array', async () => {
  const { headerMap } = await import('../src/background/gmail.js');

  for (const input of [
    undefined, null, 'not an array', 42, {},
    [null], [undefined], [{ value: 'no name' }], [{ name: 123, value: 'x' }],
    [{ name: 'A', value: null }], [{ name: 'B', value: { o: 1 } }],
  ]) {
    let out;
    assert.doesNotThrow(() => { out = headerMap(input); }, `threw on ${JSON.stringify(input)}`);
    assert.equal(typeof out, 'object');
    for (const v of Object.values(out)) {
      assert.equal(typeof v, 'string', 'every value must be coerced to a string');
    }
  }
});

test('headerMap lowercases names and keeps real values', async () => {
  // The negative tests above pass if it always returns {}.
  const { headerMap } = await import('../src/background/gmail.js');
  const out = headerMap([
    { name: 'Subject', value: 'Hello' },
    { name: 'FROM', value: 'a@b.com' },
    { name: 'Message-ID', value: '<x@y>' },
  ]);
  assert.equal(out.subject, 'Hello');
  assert.equal(out.from, 'a@b.com');
  assert.equal(out['message-id'], '<x@y>');
});

test('every header loop goes through the shared parser', async () => {
  // The regression guard: a fourth hand-rolled loop would reintroduce this.
  const { readFileSync } = await import('node:fs');
  for (const f of ['../src/background/gmail.js', '../src/background/index.js']) {
    // Blank out comments first: this rule is about CODE, and the doc comment
    // on headerMap quotes the very pattern it replaced. Matching prose made
    // this test fail on its own explanation.
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    assert.ok(
      !/for \(const \{ name, value \} of/.test(src),
      `${f} still destructures headers by hand instead of using headerMap`
    );
  }
});
