/**
 * Snippet cleaning tests.
 *
 * The risk in this module is OVER-STRIPPING. A snippet that loses real content
 * is worse than one that kept the boilerplate, because the user cannot tell it
 * happened. Roughly half of these tests assert that something was PRESERVED.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { cleanSnippet, addsInformation, rowSnippet } = await import('../src/app/snippet.js');

// ------------------------------------------------------------- salutations --

test('the standard institutional opening is removed entirely', () => {
  const s = cleanSnippet('Dear Students, Greetings from AUGSD. This is to inform you that the deadline is 12 December.');
  assert.equal(s, 'the deadline is 12 December.');
});

test('stacked boilerplate is stripped in one call, not one layer per call', () => {
  const s = cleanSnippet('Dear All, Greetings. This is to inform all the students that registration opens Monday.');
  assert.equal(s, 'registration opens Monday.');
});

test('a named salutation is removed', () => {
  assert.equal(cleanSnippet('Hi Aviral, the lab report is due tonight.'), 'the lab report is due tonight.');
});

test('respected sir is removed', () => {
  assert.equal(cleanSnippet('Respected Sir, I am writing regarding my thesis.'), 'I am writing regarding my thesis.');
});

test('a word that merely STARTS like a salutation is preserved', () => {
  // "Dearness" must not be eaten by the /^dear/ rule.
  const s = cleanSnippet('Dearness allowance revision has been approved.');
  assert.match(s, /^Dearness allowance/);
});

test('"Hillel" is not treated as "Hi"', () => {
  assert.match(cleanSnippet('Hillel House booking confirmed.'), /^Hillel/);
});

// ------------------------------------------------------------------ tails --

test('a confidentiality disclaimer and everything after it is dropped', () => {
  const s = cleanSnippet('Fees are due Friday. This email and any attachments are confidential and intended solely for the addressee.');
  assert.equal(s, 'Fees are due Friday.');
});

test('an auto-generated notice is dropped', () => {
  const s = cleanSnippet('Your request has been approved. This is an auto-generated email, please do not reply.');
  assert.equal(s, 'Your request has been approved.');
});

test('a mobile signature is dropped', () => {
  assert.equal(cleanSnippet('Will confirm tomorrow. Sent from my iPhone'), 'Will confirm tomorrow.');
});

// ----------------------------------------------------------------- quotes --

test('a quoted reply is cut at the "On ... wrote:" line', () => {
  const s = cleanSnippet('Yes that works for me. On Mon, 3 Nov 2025 at 14:02, Vinti Agarwal wrote: > Can we meet');
  assert.equal(s, 'Yes that works for me.');
});

test('a forwarded-message header cuts the snippet', () => {
  const s = cleanSnippet('Please see below. ---------- Forwarded message --------- From: AUGSD');
  assert.equal(s, 'Please see below.');
});

test('quote stripping runs BEFORE salutation stripping', () => {
  // If the order were reversed, the inner "Dear all" would survive as content.
  const s = cleanSnippet('Noted, thanks. On Tue, 4 Nov 2025, AUGSD wrote: Dear all, the form is open.');
  assert.equal(s, 'Noted, thanks.');
  assert.doesNotMatch(s, /form is open/);
});

test('an RFC 3676 signature delimiter cuts the snippet', () => {
  assert.equal(cleanSnippet('See attached.\n--\nVinti Agarwal\nBITS Pilani'), 'See attached.');
});

// ------------------------------------------------------------- whitespace --

test('nbsp entities are decoded rather than shown literally', () => {
  const s = cleanSnippet('Room&nbsp;6117 is booked.');
  assert.equal(s, 'Room 6117 is booked.');
  assert.doesNotMatch(s, /nbsp/);
});

test('zero-width characters are removed', () => {
  assert.equal(cleanSnippet('Fee\u200Bs due'), 'Fees due');
});

// ------------------------------------------------------- pathological input --

test('a snippet that is nothing but boilerplate becomes empty, not garbage', () => {
  assert.equal(cleanSnippet('Dear Students, Greetings from AUGSD.'), '');
});

test('empty and nullish input never throw', () => {
  for (const bad of [null, undefined, '', '   ', 0, {}]) {
    assert.equal(typeof cleanSnippet(bad), 'string');
  }
});

test('a very long repeated salutation terminates (no infinite loop)', () => {
  const s = cleanSnippet('Dear all, '.repeat(400) + 'the end.');
  assert.match(s, /the end/);
});

test('truncation lands on a word boundary and marks itself', () => {
  const long = 'The mid semester examination timetable has been revised and uploaded to the portal for all first year students of the twenty twenty four batch.';
  const s = cleanSnippet(long, { max: 40 });
  assert.ok(s.length <= 41, `got ${s.length}`);
  assert.match(s, /…$/);
  assert.doesNotMatch(s, /\s…$/, 'no dangling space before the ellipsis');
});

// -------------------------------------------------------------- redundancy --

test('a snippet that restates the subject adds nothing', () => {
  assert.equal(
    addsInformation('The mid semester examination schedule is attached', 'Mid-semester exam schedule'),
    false
  );
});

test('a snippet with genuinely new content does add something', () => {
  assert.equal(
    addsInformation('Venue moved to 6117 and the time is now 3pm', 'Mid-semester exam schedule'),
    true
  );
});

test('a too-short snippet adds nothing', () => {
  assert.equal(addsInformation('ok', 'Anything'), false);
});

test('rowSnippet returns empty for a restatement and text otherwise', () => {
  assert.equal(rowSnippet({ subject: 'Fee payment deadline', snippet: 'Dear all, fee payment deadline.' }), '');
  assert.match(
    rowSnippet({ subject: 'Fee payment deadline', snippet: 'Dear all, pay at the SBI counter before 5pm on Friday.' }),
    /SBI counter/
  );
});
