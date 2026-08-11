/**
 * Contact autocomplete tests.
 *
 * The cases that matter are the multi-recipient ones: a completion that works
 * on the first address and breaks on the second is worse than none, because
 * the user has already learned to trust it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  parseAddress, parseAddressList, buildContacts, matchContacts,
  currentFragment, completeValue, looksLikeAddress, invalidAddresses,
} = await import('../src/app/contacts.js');

// ---------------------------------------------------------------- parsing ---

test('addresses parse out of every header shape mail actually uses', () => {
  assert.deepEqual(parseAddress('AUGSD <augsd@pilani.bits-pilani.ac.in>'), {
    name: 'AUGSD', address: 'augsd@pilani.bits-pilani.ac.in',
  });
  assert.deepEqual(parseAddress('plain@x.com'), { name: '', address: 'plain@x.com' });
  assert.deepEqual(parseAddress('"Gupta, Aviral" <a@x.com>'), {
    name: 'Gupta, Aviral', address: 'a@x.com',
  });
  assert.equal(parseAddress(''), null);
  assert.equal(parseAddress('not an address'), null);
});

test('addresses are lowercased so the same person is one contact', () => {
  assert.equal(parseAddress('A@X.COM').address, 'a@x.com');
});

test('a recipient list splits on commas outside angle brackets', () => {
  // "Gupta, Aviral" contains a comma INSIDE the quoted name.
  const list = parseAddressList('"Gupta, Aviral" <a@x.com>, b@y.com');
  assert.equal(list.length, 2);
  assert.equal(list[0].address, 'a@x.com');
  assert.equal(list[1].address, 'b@y.com');
});

// ----------------------------------------------------------------- ranking ---

test('contacts are ranked by how often you actually mail them', () => {
  const msgs = [
    { from: 'rare@x.com', date: 900 },
    { from: 'often@x.com', date: 100 },
    { from: 'often@x.com', date: 200 },
    { from: 'often@x.com', date: 300 },
  ];
  const c = buildContacts(msgs);
  assert.equal(c[0].address, 'often@x.com');
  assert.equal(c[0].count, 3);
});

test('recency breaks a frequency tie', () => {
  const c = buildContacts([
    { from: 'old@x.com', date: 100 },
    { from: 'new@x.com', date: 900 },
  ]);
  assert.equal(c[0].address, 'new@x.com');
});

test('your own address is never suggested back to you', () => {
  const c = buildContacts(
    [{ from: 'me@x.com', date: 1 }, { from: 'other@x.com', date: 1 }],
    { selfAddress: 'me@x.com' }
  );
  assert.deepEqual(c.map((x) => x.address), ['other@x.com']);
});

test('recipients count as contacts, not just senders', () => {
  // Someone you have only ever written TO must still autocomplete.
  const c = buildContacts([{ from: 'me@x.com', to: 'them@y.com', date: 1 }]);
  assert.ok(c.some((x) => x.address === 'them@y.com'));
});

test('the best display name wins across inconsistent headers', () => {
  const c = buildContacts([
    { from: 'a@x.com', date: 1 },
    { from: 'A Gupta <a@x.com>', date: 2 },
  ]);
  assert.equal(c[0].name, 'A Gupta');
});

test('malformed records do not break the build', () => {
  assert.doesNotThrow(() =>
    buildContacts([null, undefined, {}, { from: 'x' }, { from: 'a@b.com' }])
  );
});

// ---------------------------------------------------------------- matching ---

test('an address prefix outranks a substring match', () => {
  /*
   * The substring contact is given a HIGHER frequency deliberately. Ranking
   * must be decided by match quality first, so a merely-popular substring
   * match cannot displace an exact prefix. Without the weighting this test
   * passes by tie-break accident and proves nothing.
   */
  const contacts = buildContacts([
    { from: 'library-auto@x.com', date: 9 },
    { from: 'library-auto@x.com', date: 8 },
    { from: 'library-auto@x.com', date: 7 },
    { from: 'augsd@x.com', date: 1 },
  ]);
  const m = matchContacts(contacts, 'au');
  assert.equal(m[0].address, 'augsd@x.com', 'prefix must win over a more frequent substring');
});

test('matching works on the display name too', () => {
  const contacts = buildContacts([{ from: 'Registrar Office <reg@x.com>', date: 1 }]);
  assert.equal(matchContacts(contacts, 'regis')[0].address, 'reg@x.com');
});

test('matching finds a word boundary inside the local part', () => {
  // Typing "smith" should find "j.smith@".
  const contacts = buildContacts([{ from: 'j.smith@x.com', date: 1 }]);
  assert.equal(matchContacts(contacts, 'smith').length, 1);
});

test('an empty query suggests nothing', () => {
  const contacts = buildContacts([{ from: 'a@x.com', date: 1 }]);
  assert.deepEqual(matchContacts(contacts, ''), []);
  assert.deepEqual(matchContacts(contacts, '   '), []);
});

test('results are capped', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ from: `user${i}@x.com`, date: i }));
  assert.equal(matchContacts(buildContacts(many), 'user', 6).length, 6);
});

test('a regex metacharacter in the query does not throw', () => {
  const contacts = buildContacts([{ from: 'a+b@x.com', date: 1 }]);
  assert.doesNotThrow(() => matchContacts(contacts, 'a+b'));
  assert.doesNotThrow(() => matchContacts(contacts, '('));
});

// ------------------------------------------------------- multi-recipient ----

/*
 * THE CASE THAT BREAKS NAIVE IMPLEMENTATIONS.
 *
 * Once a second recipient is being typed, the field value is
 * "a@x.com, bo" -- completing against the whole string finds nothing and the
 * suggestions silently stop appearing.
 */
test('the fragment is the recipient being typed, not the whole field', () => {
  assert.equal(currentFragment('a@x.com, bo'), 'bo');
  assert.equal(currentFragment('a@x.com; bo'), 'bo');
  assert.equal(currentFragment('bo'), 'bo');
  assert.equal(currentFragment(''), '');
});

test('the fragment respects the caret, not the end of the string', () => {
  // Caret after "bo" in "a@x.com, bo, c@y.com".
  assert.equal(currentFragment('a@x.com, bo, c@y.com', 11), 'bo');
});

test('completing keeps the recipients already entered', () => {
  const out = completeValue('a@x.com, bo', 'bob@y.com');
  assert.ok(out.includes('a@x.com'), 'must not destroy the first recipient');
  assert.ok(out.includes('bob@y.com'));
});

test('completing the only recipient does not leave a leading comma', () => {
  const out = completeValue('bo', 'bob@y.com');
  assert.ok(!out.trimStart().startsWith(','), `leading comma in ${JSON.stringify(out)}`);
  assert.ok(out.includes('bob@y.com'));
});

test('completing leaves a trailing separator ready for the next recipient', () => {
  assert.match(completeValue('bo', 'bob@y.com'), /,\s*$/);
});

// -------------------------------------------------------------- validation ---

test('obvious typos are caught', () => {
  assert.equal(looksLikeAddress('a@x.com'), true);
  assert.equal(looksLikeAddress('a@x'), false, 'no TLD');
  assert.equal(looksLikeAddress('ax.com'), false, 'no @');
  assert.equal(looksLikeAddress('a b@x.com'), false, 'space');
  assert.equal(looksLikeAddress(''), false);
});

test('invalidAddresses reports only the bad ones', () => {
  const bad = invalidAddresses('good@x.com, broken@, also.good@y.co.in');
  assert.deepEqual(bad, ['broken@']);
});

test('a well-formed list reports nothing', () => {
  assert.deepEqual(invalidAddresses('a@x.com, b@y.com'), []);
  assert.deepEqual(invalidAddresses(''), []);
});

test('a display-name recipient is not reported as invalid', () => {
  assert.deepEqual(invalidAddresses('AUGSD <augsd@pilani.bits-pilani.ac.in>'), []);
});

// ------------------------------------------------------------------ wiring ---

/*
 * The autocomplete wiring moved out of features.js into its own module when
 * the complexity audit found features.js was five unrelated things sharing a
 * file. Both are read here: the wiring lives in autocomplete.js, and compose
 * (which calls it) still lives in features.js.
 */
/*
 * features.js is now a BARREL. The five things it used to hold live in their
 * own modules, so a scan for wiring must read them all -- reading only the
 * barrel would find nothing and pass vacuously.
 */
const feat = ['features.js','undo-actions.js','radar.js','palette.js','compose.js','autocomplete.js']
  .map((f) => readFileSync(new URL(`../src/app/${f}`, import.meta.url), 'utf8')).join('\n');
const html = readFileSync(new URL('../app.html', import.meta.url), 'utf8');

test('the recipient fields are real comboboxes', () => {
  assert.match(html, /id="c-to"[\s\S]{0,200}role="combobox"/);
  assert.match(html, /id="c-to-list"[\s\S]{0,120}role="listbox"/);
  assert.ok(html.includes('aria-autocomplete="list"'));
});

test('Cc gets autocomplete too, not just To', () => {
  assert.match(html, /id="c-cc-list"/);
  // compose calls through its ctx seam now (round-46 refactor), with the
  // optional-chain the barrel wiring uses.
  assert.ok(feat.includes("wireAutocomplete?.('c-cc', 'c-cc-list')"));
});

test('the contact book is built per open, not per keystroke', () => {
  // Walking 2000 messages on every keypress is the one genuinely expensive
  // thing in the compose path.
  /*
   * Bounded by the END OF THE FUNCTION, not by a character count. The original
   * `slice(0, 900)` broke when an unrelated comment was added inside
   * openCompose -- the call had not moved, the window had. A test that fails
   * when a comment is added is measuring the wrong thing.
   */
  const start = feat.indexOf('export function openCompose');
  const next = feat.indexOf('\nexport ', start + 1);
  const open = feat.slice(start, next === -1 ? undefined : next);
  assert.ok(open.includes('refreshContacts?.(ctx)'), 'openCompose must rebuild the address book');
  const wire = feat.slice(feat.indexOf('input.addEventListener(\'input\''));
  assert.ok(!wire.slice(0, 300).includes('refreshContacts'));
});

test('selection uses mousedown, because click fires after blur', () => {
  assert.match(feat, /li\.addEventListener\('mousedown'/);
});

test('choosing a suggestion notifies the draft autosave', () => {
  // Setting .value programmatically does not fire `input`.
  const fn = feat.slice(feat.indexOf('const choose ='));
  assert.ok(fn.slice(0, 700).includes("dispatchEvent(new Event('input'"));
});

/**
 * Anchor to the AUTOCOMPLETE keydown handler.
 *
 * The palette has its own `input.addEventListener('keydown'` earlier in the
 * file; matching that one made these tests assert things about unrelated code.
 */
function acKeydown() {
  const start = feat.indexOf('function wireAutocomplete');
  assert.ok(start > 0, 'wireAutocomplete not found');
  const at = feat.indexOf("input.addEventListener('keydown'", start);
  assert.ok(at > 0, 'autocomplete keydown handler not found');
  return feat.slice(at, at + 1400);
}

test('Escape closes the suggestion list without closing compose', () => {
  const body = acKeydown();
  assert.ok(body.includes("e.key === 'Escape'"));
  assert.ok(body.includes('stopPropagation()'), 'must not bubble to the compose handler');
});

test('Enter only intercepts when an option is highlighted', () => {
  // Otherwise Enter stops doing what it normally does.
  assert.ok(acKeydown().includes('active >= 0'));
});

test('a bad address warns but does not block the send', () => {
  const fn = feat.slice(feat.indexOf('async function doSend'));
  const body = fn.slice(0, 1500);
  assert.ok(body.includes('invalidAddresses'));
  // The dialog refactor dropped the question mark; the contract is the offer.
  assert.ok(body.includes('Send anyway'), 'must offer to proceed');
});

/*
 * Mutation-testing gap: `name && name.length > hit.name.length` -> `||`
 * survived, so nothing verified that a LATER header with an empty display
 * name cannot wipe a real one.
 *
 * This is reachable constantly: the same person appears as
 * "AUGSD <augsd@...>" on one message and bare "augsd@..." on the next, and
 * whichever is seen last would win. The autocomplete would then show a raw
 * address for someone whose name we already know.
 */
test('an empty display name never overwrites a real one', () => {
  const withNameLast = buildContacts([
    { from: 'a@x.com', date: 1 },
    { from: 'A Gupta <a@x.com>', date: 2 },
  ]);
  assert.equal(withNameLast[0].name, 'A Gupta');

  const withNameFirst = buildContacts([
    { from: 'A Gupta <a@x.com>', date: 1 },
    { from: 'a@x.com', date: 2 },
  ]);
  assert.equal(
    withNameFirst[0].name, 'A Gupta',
    'a later bare address must not erase the name we already had'
  );
});

test('a longer display name wins over an abbreviation', () => {
  const c = buildContacts([
    { from: 'AG <a@x.com>', date: 1 },
    { from: 'Aviral Gupta <a@x.com>', date: 2 },
  ]);
  assert.equal(c[0].name, 'Aviral Gupta');
});
