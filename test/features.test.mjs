/**
 * Tests for the new feature layer: deadlines, query operators, reply
 * scaffolding, MIME building, and undo.
 *
 * These are the parts a user judges the product on, and every one of them has
 * a failure mode that is invisible until someone is embarrassed by it — a
 * reply that starts a new thread, a deadline that is a day early, a search
 * that quietly returns the wrong set.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { extractDeadline, relativeLabel, urgency } from '../src/app/deadlines.js';
import { parseQuery, describeQuery, buildReply } from '../src/app/query.js';
import { UndoStack } from '../src/app/undo.js';

// Monday 10 November 2025, 09:00 UTC.
const SENT = Date.UTC(2025, 10, 10, 9, 0);
const dl = (subject, snippet = '') =>
  extractDeadline({ subject, snippet, date: SENT }, SENT);

// ---------------------------------------------------------------- deadlines --

test('finds deadlines in the way institutional mail actually writes them', () => {
  const cases = [
    ['Last date for course registration is 14 November', Date.UTC(2025, 10, 14, 23, 59)],
    ['Fee payment deadline 20/11/2025', Date.UTC(2025, 10, 20, 23, 59)],
    ['Submit the PS report by 25th Nov 2025', Date.UTC(2025, 10, 25, 23, 59)],
    ['Registration closes on Friday', Date.UTC(2025, 10, 14, 23, 59)],
    ['Deadline: tomorrow', Date.UTC(2025, 10, 11, 23, 59)],
    ['Pay the hostel fee by 30 November', Date.UTC(2025, 10, 30, 23, 59)],
  ];
  for (const [subject, expected] of cases) {
    const r = dl(subject);
    assert.ok(r, `no deadline found in: ${subject}`);
    assert.equal(r.at, expected, subject);
  }
});

test('a date without a deadline cue is NOT a deadline', () => {
  // The gate that stops the radar filling with every date ever mentioned.
  // Without it the feature is noise and users switch it off.
  for (const s of [
    'Meeting notes from 14 November',
    'Standing by for 14 November updates',
    'Happy Diwali',
    'Your order shipped on 12/11/2025',
  ]) {
    assert.equal(dl(s), null, `should not fire: ${s}`);
  }
});

test('an event is distinguished from a deadline', () => {
  const r = dl('Comprehensive exam will be held on 28 November');
  assert.equal(r.kind, 'event');
  assert.equal(dl('Last date 28 November').kind, 'deadline');
});

test('an explicit time is honoured, and a bare number is NOT read as one', () => {
  // "14 November" must land at end of day. An earlier version matched the
  // first number anywhere in the string, so it parsed "14" as an hour and
  // every such deadline was silently nine hours early.
  assert.equal(dl('Last date 14 November').at, Date.UTC(2025, 10, 14, 23, 59));
  assert.equal(dl('Apply by 1 December, 5 pm').at, Date.UTC(2025, 11, 1, 17, 0));
  assert.equal(dl('Fee deadline 20/11/2025 at 11 am').at, Date.UTC(2025, 10, 20, 11, 0));
});

test('dates are read day-first, because this is an Indian tool', () => {
  // 11/12 is 11 December here, not 12 November. An American reading is a month
  // out, which is the kind of confidently-wrong result that destroys trust.
  assert.equal(dl('Deadline 11/12/2025').at, Date.UTC(2025, 11, 11, 23, 59));
});

test('impossible dates are rejected rather than rolled over', () => {
  // new Date(2025, 1, 31) silently becomes 3 March. Showing that would be
  // worse than showing nothing.
  assert.equal(dl('Last date 31/02/2025'), null);
  assert.equal(dl('Last date 45/13/2025'), null);
});

test('a bare month/day rolls to next year when it is already past', () => {
  // "5 January" in a November mail means the coming January.
  const r = dl('Last date for registration is 5 January');
  assert.equal(new Date(r.at).getUTCFullYear(), 2026);
});

test('relative dates anchor to when the mail was SENT, not to now', () => {
  // Opening a three-day-old mail must not shift its deadline forward.
  const later = SENT + 3 * 86_400_000;
  const r = extractDeadline({ subject: 'Deadline: tomorrow', date: SENT }, later);
  assert.equal(r.at, Date.UTC(2025, 10, 11, 23, 59));
});

test('a parse landing implausibly far out is discarded', () => {
  assert.equal(extractDeadline({ subject: 'Last date 14 November 2019', date: SENT }, SENT), null);
});

test('relativeLabel counts CALENDAR days, not elapsed hours', () => {
  // A deadline at 23:59 tomorrow is 1.9 elapsed days; rounding calls that
  // "in 2d", which is wrong to a human reading it.
  assert.equal(relativeLabel(Date.UTC(2025, 10, 11, 23, 59), SENT), 'due tomorrow');
  assert.equal(relativeLabel(Date.UTC(2025, 10, 10, 23, 59), SENT), 'due today');
  assert.equal(relativeLabel(Date.UTC(2025, 10, 14, 23, 59), SENT), 'due in 4d');
  assert.equal(relativeLabel(Date.UTC(2025, 10, 9, 12, 0), SENT), 'overdue by 1d');
});

test('urgency buckets are ordered', () => {
  const now = SENT;
  assert.equal(urgency(now - 1000, now), 'overdue');
  assert.equal(urgency(now + 3600_000, now), 'today');
  assert.equal(urgency(now + 2 * 86_400_000, now), 'soon');
  assert.equal(urgency(now + 5 * 86_400_000, now), 'week');
  assert.equal(urgency(now + 40 * 86_400_000, now), 'later');
});

// -------------------------------------------------------------------- query --

const NOW = Date.UTC(2025, 10, 20, 12, 0);
const CORPUS = [
  { id: 'a', from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>', subject: 'Course registration',
    snippet: 'x', date: Date.UTC(2025, 10, 19), unread: true, starred: false,
    category: 'augsd', dueAt: Date.UTC(2025, 10, 25), hasAttachment: false },
  { id: 'b', from: 'GitHub <noreply@github.com>', subject: 'Build failed',
    snippet: 'y', date: Date.UTC(2025, 10, 1), unread: false, starred: true,
    category: 'external-services', hasAttachment: true },
  { id: 'c', from: 'PSD <psd@pilani.bits-pilani.ac.in>', subject: 'PS-II allotment',
    snippet: 'z', date: Date.UTC(2025, 10, 18), unread: true, starred: false,
    category: 'ps', dueAt: Date.UTC(2025, 10, 10), hasAttachment: false },
];
const run = (q) => {
  const p = parseQuery(q, NOW);
  return CORPUS.filter((m) => !p.predicate || p.predicate(m)).map((m) => m.id);
};

test('every supported operator filters correctly', () => {
  assert.deepEqual(run('from:augsd'), ['a']);
  assert.deepEqual(run('subject:registration'), ['a']);
  assert.deepEqual(run('category:ps'), ['c']);
  assert.deepEqual(run('is:unread'), ['a', 'c']);
  assert.deepEqual(run('is:read'), ['b']);
  assert.deepEqual(run('is:starred'), ['b']);
  assert.deepEqual(run('has:attachment'), ['b']);
  assert.deepEqual(run('has:deadline'), ['a', 'c']);
  assert.deepEqual(run('is:overdue'), ['c']);
  assert.deepEqual(run('before:2025-11-15'), ['b']);
  assert.deepEqual(run('after:2025-11-15'), ['a', 'c']);
  assert.deepEqual(run('older_than:7d'), ['b']);
  assert.deepEqual(run('newer_than:5d'), ['a', 'c']);
});

test('negation and combination work', () => {
  assert.deepEqual(run('-from:github'), ['a', 'c']);
  assert.deepEqual(run('from:pilani is:unread'), ['a', 'c']);
  assert.deepEqual(run('is:unread -category:ps'), ['a']);
});

test('a quoted phrase matches exactly', () => {
  assert.deepEqual(run('"PS-II allotment"'), ['c']);
  assert.deepEqual(run('"nonexistent phrase"'), []);
});

test('free text is left to the index, not turned into a predicate', () => {
  const p = parseQuery('registration', NOW);
  assert.deepEqual(p.terms, ['registration']);
  assert.equal(p.predicate, null, 'plain words must go through the inverted index');
});

test('an unknown operator becomes free text rather than being dropped', () => {
  // Silently dropping it returns the wrong set with no indication why.
  const p = parseQuery('bogus:x', NOW);
  assert.deepEqual(p.terms, ['bogus:x']);
  assert.equal(p.operators.length, 0);
});

test('describeQuery explains what is being applied', () => {
  assert.equal(describeQuery(parseQuery('from:augsd is:unread', NOW)), 'from:augsd · is:unread');
  assert.match(describeQuery(parseQuery('-from:github', NOW)), /^not from:github/);
});

// -------------------------------------------------------------------- reply --

const BODY = {
  threadId: 'th1',
  messageId: '<abc@mail.gmail.com>',
  references: '<x1@a> <x2@b>',
  from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
  to: 'me@pilani.bits-pilani.ac.in, Friend <f@pilani.bits-pilani.ac.in>',
  cc: 'Dean <dean@pilani.bits-pilani.ac.in>, me@pilani.bits-pilani.ac.in',
  subject: 'Re: Course registration',
  text: 'Please register by Friday.',
};
const ME = 'me@pilani.bits-pilani.ac.in';

/*
 * THE ATTRIBUTION LINE.
 *
 * "On <sender> wrote:" without a date is half an attribution. In a long thread
 * the recipient needs to know WHEN the quoted text was written. This was
 * missing and no test caught it, because nothing asserted on the quote header.
 */
test('a reply attributes the quote to a person AND a time', () => {
  const at = Date.UTC(2026, 2, 10, 9, 30);
  const r = buildReply({ ...BODY, date: at }, ME, 'reply');
  assert.match(r.quoted, /^\n\nOn .+, AUGSD <augsd@[^>]+> wrote:\n/);
  assert.ok(/2026/.test(r.quoted), 'the year must appear in the attribution');
  assert.ok(r.quoted.includes('> Please register by Friday.'));
});

test('a reply with no date still produces a sane attribution', () => {
  // A missing internalDate must not render "On , X wrote:".
  const r = buildReply({ ...BODY, date: 0 }, ME, 'reply');
  assert.ok(!r.quoted.includes('On ,'), `malformed attribution: ${r.quoted.slice(0, 60)}`);
  assert.match(r.quoted, /On AUGSD/);
});

test('a forward carries the full original header block', () => {
  // From/Date/Subject/To is what every client includes, and what the reader
  // needs to judge whether the forward is relevant.
  const r = buildReply({ ...BODY, date: Date.UTC(2026, 2, 10) }, ME, 'forward');
  assert.match(r.quoted, /Forwarded message/);
  assert.match(r.quoted, /From: AUGSD/);
  assert.match(r.quoted, /Date: .+2026/);
  assert.match(r.quoted, /Subject: Re: Course registration/);
  assert.match(r.quoted, /To: /);
  assert.ok(!r.quoted.includes('> Please'), 'a forward is not quoted with >');
});

test('the background actually supplies the date the attribution needs', () => {
  // The attribution silently degrades if extractBody omits `date`, and that
  // degradation is invisible in the app.
  const bg = readFileSync(new URL('../src/background/index.js', import.meta.url), 'utf8');
  const fn = bg.slice(bg.indexOf('function extractBody'));
  assert.ok(
    /date: Number\(full\.internalDate\)/.test(fn.slice(0, 1600)),
    'extractBody must return a date for the reply attribution'
  );
});

test('a reply stays in its thread', () => {
  // Missing In-Reply-To/References is the single most visible way a mail
  // client looks broken -- and it is invisible to the person sending.
  const r = buildReply(BODY, ME, 'reply');
  assert.equal(r.threadId, 'th1');
  assert.equal(r.inReplyTo, '<abc@mail.gmail.com>');
  assert.equal(r.references, '<x1@a> <x2@b> <abc@mail.gmail.com>');
});

test('reply-all excludes me and never duplicates a recipient', () => {
  const r = buildReply(BODY, ME, 'replyAll');
  assert.equal(r.to, 'AUGSD <augsd@pilani.bits-pilani.ac.in>');
  assert.ok(!r.cc.includes(ME), 'must not reply to myself');
  assert.ok(!r.cc.includes('augsd@'), 'must not duplicate the To recipient');
  assert.ok(r.cc.includes('f@pilani'), 'other To recipients move to Cc');
  assert.ok(r.cc.includes('dean@pilani'));
});

test('subject prefixes do not stack', () => {
  // "Re: Re: Re:" is the mark of a client nobody maintains.
  assert.equal(buildReply(BODY, ME, 'reply').subject, 'Re: Course registration');
  assert.equal(
    buildReply({ ...BODY, subject: 'Fwd: Re: Hello' }, ME, 'reply').subject,
    'Re: Hello'
  );
});

test('Reply-To beats From', () => {
  // Mailing lists and no-reply senders depend on this; ignoring it sends the
  // reply somewhere nobody reads.
  const r = buildReply({ ...BODY, replyTo: 'list@bits.example' }, ME, 'reply');
  assert.equal(r.to, 'list@bits.example');
});

test('a forward starts a NEW thread and carries no reply headers', () => {
  const r = buildReply(BODY, ME, 'forward');
  assert.equal(r.threadId, '');
  assert.equal(r.inReplyTo, '');
  assert.equal(r.references, '');
  assert.equal(r.to, '', 'the user chooses the recipient');
  assert.match(r.subject, /^Fwd: /);
});

test('the quoted original is bounded', () => {
  // A 5000-line newsletter must not become the body of the reply.
  const huge = { ...BODY, text: Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n') };
  const r = buildReply(huge, ME, 'reply');
  assert.ok(r.quoted.split('\n').length < 220, 'quote must be truncated');
});

// --------------------------------------------------------------------- undo --

test('undo restores the most recent action, LIFO', async () => {
  const s = new UndoStack();
  const log = [];
  s.push('archive 1', () => log.push('undo-1'));
  s.push('archive 2', () => log.push('undo-2'));

  assert.equal(await s.undo(), 'archive 2');
  assert.equal(await s.undo(), 'archive 1');
  assert.deepEqual(log, ['undo-2', 'undo-1']);
  assert.equal(await s.undo(), null, 'empty stack returns null, does not throw');
});

test('the stack is bounded', () => {
  // Unbounded, this pins every message the user ever deleted.
  const s = new UndoStack({ max: 3 });
  for (let i = 0; i < 10; i++) s.push(`a${i}`, () => {});
  assert.equal(s.size, 3);
  assert.equal(s.peek().label, 'a9', 'the newest survives');
});

test('entries expire, because a stale undo is a trap', async () => {
  // Replaying a ten-minute-old archive against a mailbox that has moved on can
  // resurrect mail the user archived on another device.
  let clock = 1000;
  const s = new UndoStack({ ttlMs: 5000, now: () => clock });
  s.push('old', () => {});
  clock += 6000;
  assert.equal(s.peek(), null);
  assert.equal(await s.undo(), null);
});

test('subscribers are notified when the top of the stack changes', async () => {
  const s = new UndoStack();
  const seen = [];
  s.subscribe((top) => seen.push(top ? top.label : null));
  s.push('x', () => {});
  await s.undo();
  assert.deepEqual(seen, ['x', null]);
});

test('a failing undo surfaces rather than silently half-applying', async () => {
  const s = new UndoStack();
  s.push('archive', () => {
    throw new Error('network down');
  });
  await assert.rejects(() => s.undo(), /Could not undo: archive/);
});

/* ------------------------------------------------------- undo edge cases ----
 *
 * Undo is the product's recovery mechanism — the thing that makes optimistic
 * mutation safe. These pin the failure paths, which stress testing showed
 * were unverified.
 */

test('a failed undo still advances the stack', () => {
  /*
   * `undo()` pops BEFORE invoking, so a thunk that throws does not wedge the
   * stack: the next undo reaches the entry beneath it. The rethrow is
   * deliberate — the caller surfaces it, because a silently half-applied
   * state is worse than a visible error.
   */
  const u = new UndoStack({ now: () => 0 });
  const ran = [];
  u.push('bad', () => { throw new Error('boom'); });
  u.push('good', () => { ran.push('good'); });

  return u.undo()
    .then((label) => {
      assert.equal(label, 'good');
      assert.equal(u.size, 1);
      return u.undo().then(
        () => assert.fail('a throwing undo must report failure'),
        (err) => assert.match(err.message, /Could not undo: bad/)
      );
    })
    .then(() => {
      assert.equal(u.size, 0, 'the failed entry must still have been popped');
      return u.undo();
    })
    .then((r) => assert.equal(r, null, 'undo on an empty stack returns null, never throws'));
});

test('clear() on an empty stack does not notify', () => {
  // Found by mutation testing: dropping the `!this.entries.length` guard
  // survived, so a no-op clear would repaint the undo affordance.
  const u = new UndoStack({ now: () => 0 });
  let notifications = 0;
  u.subscribe(() => notifications++);

  u.clear();
  assert.equal(notifications, 0, 'clearing nothing must not notify');

  u.push('x', () => {});
  const afterPush = notifications;
  u.clear();
  assert.equal(notifications, afterPush + 1, 'clearing something must notify exactly once');
  assert.equal(u.size, 0);
});

test('the stack stays bounded and expires old entries', () => {
  let now = 0;
  const u = new UndoStack({ max: 20, ttlMs: 1000, now: () => now });
  for (let i = 0; i < 100; i++) u.push(`a${i}`, () => {});
  assert.ok(u.entries.length <= 20, `unbounded: ${u.entries.length}`);

  now = 5000;
  assert.equal(u.size, 0, 'expired entries must not be offered');
  assert.equal(u.peek(), null, 'an undo offered ten minutes late is a trap');
});

/* ========================================================================== *
 * DATE VALIDATION AND QUERY BOUNDARIES
 *
 * `isRealDate` rejects 31 February and friends, which `new Date` silently
 * rolls forward into March. Mutation testing found its three-way `&&`
 * unverified — and a rolled date is worse than no date, because the radar
 * would confidently show a deadline that does not exist.
 * ========================================================================== */

test('an impossible calendar date is rejected, not rolled forward', () => {
  // `new Date(Date.UTC(2026, 1, 31))` silently becomes 3 March.
  for (const subject of [
    'Submit by 31/02/2026', 'Deadline 30 February 2026',
    'submit by 31/04/2026', 'submit by 31/06/2026',
    'submit by 32/01/2026', 'submit by 00/01/2026',
  ]) {
    const d = extractDeadline({ subject, snippet: '', from: 'a@b.c', date: Date.UTC(2026, 0, 1) });
    if (d) {
      const dt = new Date(d.at);
      assert.notEqual(dt.getUTCMonth(), 2, `${subject} rolled into March`);
    }
  }
});

test('a real leap day is accepted, an invented one is not', () => {
  // The counterpart: over-strict validation would drop genuine deadlines.
  // "submit by" is a recognised trigger for a numeric date; bare "due" is not
  // (verified against the parser rather than assumed).
  const base = { snippet: '', from: 'a@b.c', date: Date.UTC(2024, 0, 1) };
  const leap = extractDeadline({ ...base, subject: 'submit by 29/02/2024' });
  assert.ok(leap, '29 Feb 2024 is a real date and must parse');
  assert.equal(new Date(leap.at).toISOString().slice(0, 10), '2024-02-29');

  const notLeap = extractDeadline({
    ...base, subject: 'submit by 29/02/2026', date: Date.UTC(2026, 0, 1),
  });
  if (notLeap) {
    const dt = new Date(notLeap.at);
    assert.notEqual(dt.getUTCDate(), 1, '29 Feb 2026 does not exist and must not roll to 1 Mar');
  }
});

test('relative deadline labels are correct at the week boundary', () => {
  // `weeks === 1` -> `!==` survived: "due in 1w" instead of "due in a week".
  const now = Date.UTC(2026, 0, 1);
  assert.equal(relativeLabel(now + 7 * 86400000, now), 'due in a week');
  assert.match(relativeLabel(now + 14 * 86400000, now), /2w/);
});

test('date operators include the boundary day', () => {
  // `m.date >= t` -> `>` would silently exclude mail sent exactly at the
  // cutoff, which for `after:` is the most likely thing the user meant.
  const t = Date.UTC(2026, 0, 15);
  const parsed = parseQuery('after:2026-01-15');
  assert.ok(parsed.predicate, 'after: should build a predicate');
  assert.equal(parsed.predicate({ date: t, subject: '', from: '', snippet: '' }), true,
    'a message dated exactly at the boundary must match after:');
});

test('to:me is honest about what it can answer', () => {
  // `() => true` -> `false` survived. We only hold the signed-in mailbox, so
  // `to:me` is a tautology; anything else cannot be answered from stored
  // headers and must match nothing rather than pretend.
  const probe = { subject: 'x', from: 'a@b.c', snippet: '', date: Date.now() };
  assert.equal(parseQuery('to:me').predicate(probe), true, 'to:me must match everything held');
  assert.equal(parseQuery('to:someone@else.com').predicate(probe), false,
    'an unanswerable to: must match nothing, not everything');
});

test('a leading colon is treated as free text, not a broken operator', () => {
  // `colon <= 0` -> `< 0`: ":foo" would parse as an operator with an EMPTY
  // key, silently matching nothing instead of searching for ":foo".
  const parsed = parseQuery(':unread');
  assert.deepEqual(parsed.operators, [], 'a leading colon is not an operator');
  assert.ok(parsed.terms.length > 0, 'it must survive as a search term');
});

test('newer_than includes the message at exactly the boundary', () => {
  /*
   * `m.date >= now - span` -> `>`. Reachable only at millisecond precision,
   * but `older_than` uses strict `<` on the same value, so if this drifted to
   * `>` a message sitting exactly on the boundary would match NEITHER
   * operator — it would vanish from both halves of a partition that should be
   * exhaustive.
   *
   * The two remaining survivors in these modules are equivalent mutants,
   * verified rather than assumed:
   *   - `colon <= 0` vs `<`: for ":foo" the key is "" and buildCheck("")
   *     returns undefined, so the token falls back to free text either way.
   *   - `isRealDate`'s first `&&` vs `||`: a rolled date still fails the day
   *     comparison, so the verdict is unchanged.
   */
  /*
   * `now` is INJECTED. The first version called Date.now() in the test and
   * let parseQuery capture its own a moment later, so the boundary moved by a
   * millisecond under load — it passed alone and failed in the full suite.
   * A test that races the clock is a flake, not a test.
   */
  const now = Date.UTC(2026, 2, 10, 9, 0);
  const dayMs = 86400000;
  const parsed = parseQuery('newer_than:1d', now);
  assert.ok(parsed.predicate, 'newer_than should build a predicate');

  const exactlyOnBoundary = { date: now - dayMs, subject: '', from: '', snippet: '' };
  const older = parseQuery('older_than:1d', now);

  const inNewer = parsed.predicate(exactlyOnBoundary);
  const inOlder = older.predicate(exactlyOnBoundary);
  assert.ok(
    inNewer !== inOlder,
    'the boundary message must belong to exactly one of newer_than / older_than'
  );
  assert.equal(inNewer, true, 'the boundary belongs to newer_than');
});
