/**
 * M1 — the body cache: the reader's local-first floor (2026-08-13).
 *
 * WHY THESE PINS
 * --------------
 * Until M1, every reader open went to the worker and a failed GET_BODY
 * rendered a red sentence for mail the user had often already read. The
 * floor (system/body-cache.js) keeps the last BODY_CACHE_MAX opened bodies
 * beside the header cache and the reader falls back to them.
 *
 * The tests split into two kinds, on purpose:
 *
 *   1. UNIT — the cache itself: round trip, the two bounds (count AND
 *      chars, either alone is a lie), the giant refusal, corruption
 *      degradation, prime-before-write (an unprimed write would clobber
 *      the existing blob with a one-entry cache, the cache's single worst
 *      failure), and inlineData never being persisted (one photo can
 *      outweigh the whole budget).
 *
 *   2. WIRING — the reader and shell: the success path remembers, the
 *      catch path consults the floor before showing an error, the offline
 *      fast path exists, the provenance strip is real markup in app.html
 *      with real chrome (the frame document is sender-controlled, so a
 *      marker there could be imitated by the mail), and sign-out — but NOT
 *      resync — drops the floor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeStorage } from './helpers/storage.mjs';

const {
  rememberBody,
  cachedBody,
  clearBodyCache,
  flushBodyCache,
  BODY_CACHE_MAX,
  BODY_CACHE_BUDGET,
  PER_BODY_LIMIT,
  _reset,
} = await import('../src/app/system/body-cache.js');

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

const body = (over = {}) => ({
  id: 'x', // overwritten by caller placement; the cache keys by argument
  threadId: 't1',
  html: '<p>assignment 4 is due monday</p>',
  text: '',
  attachments: [],
  inline: [],
  messageId: '<m@x>', references: '', from: 'AUGSD <augsd@bits-pilani.ac.in>',
  to: 'me@bits', cc: '', replyTo: '', date: 1700000000000,
  subject: 'Due Monday', listUnsubscribe: '',
  ...over,
});

test.afterEach(() => { _reset(); });

// ------------------------------------------------------------------ unit --

test('a remembered body reads back in worker shape, with its provenance', async () => {
  const s = fakeStorage();
  const ok = await rememberBody('m1', body({ html: '<p>hi</p>' }), s);
  assert.equal(ok, true);
  await flushBodyCache();

  _reset(); // force the read to come from STORAGE, not session memory
  const got = await cachedBody('m1', s);
  assert.equal(got.id, 'm1');
  assert.equal(got.html, '<p>hi</p>');
  assert.equal(got.subject, 'Due Monday');
  assert.equal(got.messageId, '<m@x>', 'reply-readiness survives the floor');
  assert.ok(got.offlineAt > 0, 'the marker has a date to show');
  assert.deepEqual(got.attachments, []);
});

test('a miss is null, not an error', async () => {
  assert.equal(await cachedBody('nobody', fakeStorage()), null);
});

test('inlineData never reaches storage', async () => {
  const s = fakeStorage();
  await rememberBody('m1', body({
    inline: [{ contentId: 'c1', filename: '', mimeType: 'image/png', size: 10, attachmentId: 'a1' }],
    inlineData: [{ contentId: 'c1', dataUrl: 'data:image/png;base64,HUGE' }],
  }), s);
  await flushBodyCache();
  const raw = JSON.stringify(s.data.bodyCache);
  assert.ok(!raw.includes('HUGE'), 'the budget is not spent on base64 photos');
  _reset();
  const got = await cachedBody('m1', s);
  assert.equal(got.inline.length, 1, 'the DESCRIPTOR survives — re-fetch stays possible');
});

test('the count bound evicts oldest-first', async () => {
  const s = fakeStorage();
  for (let i = 0; i < BODY_CACHE_MAX + 5; i++) {
    await rememberBody(`m${i}`, body(), s);
  }
  await flushBodyCache();
  _reset(); // read back from STORAGE, proving eviction persisted
  assert.equal(await cachedBody('m0', s), null, 'the oldest five fell off');
  assert.equal(await cachedBody('m4', s), null);
  const newest = await cachedBody(`m${BODY_CACHE_MAX + 4}`, s);
  assert.ok(newest, 'the newest survive');
});

test('the char bound evicts when the count does not', async () => {
  const s = fakeStorage();
  /* Each body is big but under PER_BODY_LIMIT (otherwise the giant refusal,
     a different rule, fires instead). 15 x 150K = 2.25M chars against a 2M
     budget: exactly the first two must go, at a count of 13 — far under the
     count bound, so only the char bound can be doing the evicting. */
  const fat = 'x'.repeat(150_000);
  /* The fixture only tests the char bound if its arithmetic holds; assert
     the premise rather than letting a future budget change quietly move
     the test into giant-refusal or count-bound territory. */
  assert.ok(fat.length < PER_BODY_LIMIT, 'each body is under the giant limit');
  assert.ok(15 * fat.length > BODY_CACHE_BUDGET, 'fifteen of them exceed the budget');
  const ids = 'abcdefghijklmno'.split('');
  for (const id of ids) await rememberBody(id, body({ html: fat }), s);
  await flushBodyCache();
  _reset();
  assert.equal(await cachedBody('a', s), null, 'the oldest fat body fell off');
  assert.equal(await cachedBody('b', s), null, 'and the second');
  assert.ok(await cachedBody('o', s), 'the newest survive');
  assert.ok(await cachedBody('c', s), '13 x 150K is inside the budget — the evictions stop');
});

test('a giant is refused outright', async () => {
  const s = fakeStorage();
  const ok = await rememberBody('big', body({ html: 'x'.repeat(PER_BODY_LIMIT + 1) }), s);
  assert.equal(ok, false);
  assert.equal(await cachedBody('big', s), null);
});

test('a body with neither html nor text is not worth a floor slot', async () => {
  const s = fakeStorage();
  assert.equal(await rememberBody('void', body({ html: '', text: '' }), s), false);
});

test('corrupt blobs degrade to empty, never to a throw', async () => {
  const s = fakeStorage({ bodyCache: 'this is not a blob' });
  assert.equal(await cachedBody('m1', s), null);
  const s2 = fakeStorage({ bodyCache: { v: 999, b: [] } });
  assert.equal(await cachedBody('m1', s2), null, 'a version mismatch discards, not misreads');
});

test('an unprimed REMEMBER cannot clobber the stored floor', async () => {
  /* The worst failure this cache can have: one open wipes fifty bodies.
     Seed storage behind the module's back, then remember WITHOUT priming —
     the write must contain the seeded entry as well. */
  const s = fakeStorage();
  await rememberBody('old', body(), s);
  await flushBodyCache();
  _reset(); // session memory is gone; storage still holds 'old'
  await rememberBody('new', body(), s);
  await flushBodyCache();
  _reset();
  assert.ok(await cachedBody('old', s), 'the seeded body survived a fresh session write');
  assert.ok(await cachedBody('new', s));
});

test('reads bump recency; the read survivor evicts last', async () => {
  const s = fakeStorage();
  await rememberBody('keep', body(), s);
  // Fill exactly to the bound: 'keep' is the oldest and next out.
  for (let i = 0; i < BODY_CACHE_MAX - 1; i++) await rememberBody(`f${i}`, body(), s);
  await cachedBody('keep', s); // re-read: 'keep' jumps to newest
  await rememberBody('one-more', body(), s);
  assert.ok(await cachedBody('keep', s), 'a re-read body is hot again');
  assert.equal(await cachedBody('f0', s), null, 'the untouched oldest went instead');
});

test('clear drops the blob and the session memory', async () => {
  const s = fakeStorage();
  await rememberBody('m1', body(), s);
  await flushBodyCache();
  assert.ok(s.data.bodyCache, 'blob written');
  await clearBodyCache(s);
  assert.equal(s.data.bodyCache, undefined);
  assert.equal(await cachedBody('m1', s), null, 'memory cleared with it');
});

test('writes coalesce: a reading sitting is one write, not many', async () => {
  const s = fakeStorage();
  for (let i = 0; i < 10; i++) await rememberBody(`m${i}`, body(), s);
  await flushBodyCache();
  assert.equal(s.writes, 1, 'the whole sitting collapsed into one set()');
});

// ---------------------------------------------------------------- wiring --

test('the live success path remembers; the failure path consults the floor first', () => {
  const src = read('src/app/mail/reader.js');
  assert.match(src, /void rememberBody\(id, body\);/, 'paint first, persist second, unawaited');
  assert.match(src, /const cached = await cachedBody\(id\);/, 'the catch path asks the floor');
  /* The error text may only render AFTER the floor declined — the call
     above appears before the error write in the same catch. */
  const ask = src.indexOf('const cached = await cachedBody(id);');
  const err = src.indexOf('Could not load this message.');
  assert.ok(ask !== -1 && err !== -1 && ask < err, 'the floor is consulted before the error is shown');
});

test('the known-offline fast path skips the doomed fetch, but a miss falls through', () => {
  const src = read('src/app/mail/reader.js');
  assert.match(src, /navigator\.onLine === false/, 'certain-offline short-circuits');
  const fast = src.indexOf('navigator.onLine === false');
  const live = src.indexOf("await send('GET_BODY', { id })");
  assert.ok(fast < live, 'the fast path sits BEFORE the live attempt');
  /* And the fallback catch is still there for when onLine lies hopeful.
     The call appears twice (fast path AND catch); the catch is the LAST. */
  assert.ok(src.lastIndexOf('const cached = await cachedBody(id);') > live);
});

test('the provenance strip is app chrome, dated, and styled', () => {
  const html = read('app.html');
  assert.match(html, /id="r-offline" hidden/, 'the strip ships hidden');
  assert.match(html, /id="r-offline-text"/, 'its text node is a named element');

  const reader = read('src/app/mail/reader.js');
  assert.match(reader, /Offline copy — saved \$\{fullDate\(cached\.offlineAt\)\}/, 'the strip dates the copy');
  assert.match(reader, /el\.rOffline\.hidden = false;/, 'the fallback reveals it');
  assert.match(reader, /el\.rOffline\.hidden = true;/, 'a new open clears it');

  const css = read('src/styles/68-depth.css');
  assert.match(css, /#r-offline \{/, 'it is styled, or the marker is invisible');
});

test('the shell resolves the strip and drops the floor on sign-out', () => {
  const src = read('src/app/main.js');
  assert.match(src, /rOffline: \$\('r-offline'\)/);
  assert.match(src, /rOfflineText: \$\('r-offline-text'\)/);
  /* 2026-08-15 (AUD-C1): the teardown moved into endAccountSession so the
     account-change tripwire runs the same drop — sign-out included. The
     floor dies with an account session, by either exit. */
  assert.ok(src.indexOf("$('btn-signout')") !== -1);
  assert.match(src, /async function endAccountSession\(gateMessage\) \{[^]*?await clearBodyCache\(\);/,
    'the session teardown drops the floor with the cache');
});

test('resync keeps bodies (a body is immutable; only sign-out changes the account)', () => {
  const src = read('src/app/main.js');
  /* Every clearBodyCache() lives in the account-session teardown (button
     and tripwire share it since 2026-08-15) — exactly one call site, so a
     resync can never drop the floor. */
  assert.equal(src.split('clearBodyCache()').length - 1, 1,
    'exactly one drop site in the shell');
  assert.match(src, /async function endAccountSession\(gateMessage\) \{[^]*?await clearBodyCache\(\);/);
});
