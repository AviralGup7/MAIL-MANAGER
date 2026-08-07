/**
 * "Addressed to me" tests.
 *
 * THE ASYMMETRY IS THE WHOLE POINT. A false 'broadcast' hides mail the user
 * needed; a false 'direct' merely fails to hide one. So the tests that matter
 * most here are the ones asserting that ambiguous input resolves to direct.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { audienceOf, isDirect, filterDirect, splitRecipients, looksLikeListAddress } =
  await import('../src/app/direct.js');

const ME = 'f20240294@pilani.bits-pilani.ac.in';

// ------------------------------------------------------------------ basics --

test('my address in To is direct', () => {
  assert.equal(audienceOf({ to: ME }, ME), 'direct');
});

test('my address in Cc is cc, not direct and not broadcast', () => {
  assert.equal(audienceOf({ to: 'someone@x.com', cc: ME }, ME), 'cc');
});

test('a list I am not named on is broadcast', () => {
  assert.equal(audienceOf({ to: 'students@pilani.bits-pilani.ac.in' }, ME), 'broadcast');
});

test('display names do not defeat the match', () => {
  assert.equal(audienceOf({ to: `"Gupta, Aviral" <${ME}>` }, ME), 'direct');
});

test('a comma inside a quoted display name does not split the address', () => {
  const parts = splitRecipients(`"Gupta, Aviral" <${ME}>, other@x.com`);
  assert.deepEqual(parts, [ME, 'other@x.com']);
});

test('case differences do not defeat the match', () => {
  assert.equal(audienceOf({ to: ME.toUpperCase() }, ME), 'direct');
});

// ------------------------------------------------------------ list headers --

test('a List-Id header with me not named is broadcast', () => {
  const m = { to: 'announce@bits.ac.in', headers: { 'List-Id': '<announce.bits.ac.in>' } };
  assert.equal(audienceOf(m, ME), 'broadcast');
});

test('header name casing does not matter', () => {
  const m = { to: 'announce@bits.ac.in', headers: { 'LIST-UNSUBSCRIBE': '<https://x>' } };
  assert.equal(audienceOf(m, ME), 'broadcast');
});

test('an EMPTY list header is not a list header', () => {
  /*
   * THIS TEST WAS WORTHLESS ON ITS FIRST WRITING and was caught by sabotage.
   *
   * It used `{ to: ME, headers: {'List-Id': '   '} }`, which returns 'direct'
   * whether or not the blank header is honoured -- the large-list demotion
   * needs more than 12 recipients, and there was one. Removing the emptiness
   * check entirely left the suite green.
   *
   * The fix is to put the case on the branch that actually reads the flag: me
   * in To alongside 40 others. With a REAL list header that is 'broadcast';
   * with a blank one it must stay 'direct'.
   */
  const many = Array.from({ length: 40 }, (_, i) => `s${i}@x.com`).join(', ');
  const blank = { to: `${ME}, ${many}`, headers: { 'List-Id': '   ' } };
  assert.equal(audienceOf(blank, ME), 'direct');

  const real = { to: `${ME}, ${many}`, headers: { 'List-Id': '<x.bits.ac.in>' } };
  assert.equal(audienceOf(real, ME), 'broadcast', 'control: a real header does demote');
});

test('named individually on a SMALL list thread stays direct', () => {
  // Reply-all on a list where I am explicitly named: this is for me.
  const m = { to: `${ME}, other@x.com`, headers: { 'List-Id': '<x>' } };
  assert.equal(audienceOf(m, ME), 'direct');
});

test('named on a HUGE list blast is broadcast even though I am in To', () => {
  const many = Array.from({ length: 40 }, (_, i) => `s${i}@x.com`).join(', ');
  const m = { to: `${ME}, ${many}`, headers: { 'List-Id': '<x>' } };
  assert.equal(audienceOf(m, ME), 'broadcast');
});

// ---------------------------------------------------- the asymmetry itself --

test('a message with NO recipient data is direct, never broadcast', () => {
  // The sync layer does not always carry `to`. Absent data must not hide mail.
  assert.equal(audienceOf({ subject: 'x' }, ME), 'direct');
  assert.equal(audienceOf({ to: '', cc: '' }, ME), 'direct');
});

test('when not signed in, everything is direct', () => {
  assert.equal(audienceOf({ to: 'students@x.com' }, ''), 'direct');
  assert.equal(audienceOf({ to: 'students@x.com' }, null), 'direct');
});

test('a malformed To header does not throw and does not hide', () => {
  for (const bad of [null, undefined, 42, {}, '<<<>>>']) {
    assert.doesNotThrow(() => audienceOf({ to: bad }, ME));
  }
});

// -------------------------------------------------------- list-ish addresses --

test('obvious audience local-parts are recognised', () => {
  for (const a of ['students@x.com', 'all-students@x.com', 'noreply@x.com', 'announce@x.com', '2024batch-all@x.com']) {
    assert.equal(looksLikeListAddress(a), true, a);
  }
});

test('a person is not mistaken for a list', () => {
  for (const a of ['vinti.agarwal@pilani.bits-pilani.ac.in', 'f20240294@pilani.bits-pilani.ac.in', 'alice@x.com']) {
    assert.equal(looksLikeListAddress(a), false, a);
  }
});

// ---------------------------------------------------------------- filtering --

test('filterDirect keeps direct and cc, drops broadcast', () => {
  const msgs = {
    a: { to: ME },
    b: { to: 'x@y.com', cc: ME },
    c: { to: 'students@x.com' },
  };
  assert.deepEqual(filterDirect(['a', 'b', 'c'], (id) => msgs[id], ME), ['a', 'b']);
});

test('filterDirect can exclude cc', () => {
  const msgs = { a: { to: ME }, b: { to: 'x@y.com', cc: ME } };
  assert.deepEqual(
    filterDirect(['a', 'b'], (id) => msgs[id], ME, { includeCc: false }),
    ['a']
  );
});

test('filterDirect skips ids the store does not have', () => {
  assert.deepEqual(filterDirect(['gone'], () => undefined, ME), []);
});

test('isDirect agrees with audienceOf', () => {
  assert.equal(isDirect({ to: ME }, ME), true);
  assert.equal(isDirect({ to: 'x@y.com', cc: ME }, ME), true);
  assert.equal(isDirect({ to: 'students@x.com' }, ME), false);
});
