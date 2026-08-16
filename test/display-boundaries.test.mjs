/**
 * Boundary values for the display helpers (round 10, I-5).
 *
 * WHY A SEPARATE FILE FROM fuzz-display.test.mjs. The fuzz sweep proves
 * TOTALITY over random hostile input: nothing throws, nothing leaks prototype
 * junk. It cannot prove CORRECTNESS at a named edge, because it does not know
 * what the right answer at that edge is. Every finding in rounds 9 and 10
 * against these helpers was an edge with a specific wrong answer —
 * `fmtTime(1440)` reading as noon, `entryId({})` colliding, a 7,525-character
 * conflict sentence — and none of them is a shape a fuzzer would flag.
 *
 * So: the exact boundary, the exact expected string, and the reason.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { displayName, shortDate, fullDate, joinCapped } from '../src/app/core/display.js';
import { fmtTime } from '../src/app/academic/timetable.js';

// ------------------------------------------------------------- fmtTime ----

test('fmtTime: the two ends of the day, and everything outside it', () => {
  /*
   * Round 9's M-1..M-4 measured `fmtTime(NaN) -> "NaN:NaN AM"`,
   * `fmtTime(-1) -> "-1:-1 AM"`, `fmtTime(1e9) -> "10:40 PM"` and — the one
   * that reads as a plausible time and is therefore the dangerous one —
   * `fmtTime(1440) -> "12:00 PM"`, midnight shown as noon.
   */
  assert.equal(fmtTime(0), '12:00 AM', 'midnight is 12 AM, not 0 AM');
  assert.equal(fmtTime(1), '12:01 AM');
  assert.equal(fmtTime(719), '11:59 AM', 'the last minute before noon');
  assert.equal(fmtTime(720), '12:00 PM', 'noon is 12 PM, not 0 PM');
  assert.equal(fmtTime(721), '12:01 PM');
  assert.equal(fmtTime(1439), '11:59 PM', 'the last minute of the day');
  assert.equal(fmtTime(1440), '12:00 AM', 'the exclusive bound wraps to midnight, NOT noon');

  /* `null`, `''`, `[]` and `false` coerce to 0 in JavaScript, so before
     round 10 a MISSING time rendered as a confident '12:00 AM'. */
  for (const bad of [NaN, Infinity, -Infinity, -1, 1441, 1e9, undefined, null,
    'noon', {}, [], false, '', '  ']) {
    assert.equal(fmtTime(bad), '', `fmtTime(${JSON.stringify(bad)}) must render nothing`);
  }
});

// ----------------------------------------------------------- joinCapped ----

test('joinCapped: every list length across the cap', () => {
  const n = (k) => Array.from({ length: k }, (_, i) => `CS F${200 + i}`);
  assert.equal(joinCapped(n(0)), '');
  assert.equal(joinCapped(n(1)), 'CS F200');
  assert.equal(joinCapped(n(2)), 'CS F200 and CS F201', 'two items read as a pair, no comma');
  assert.equal(joinCapped(n(3)), 'CS F200, CS F201 and CS F202');
  assert.equal(joinCapped(n(4)), 'CS F200, CS F201, CS F202 and CS F203', 'at the cap, nothing is hidden');
  assert.equal(joinCapped(n(5)), 'CS F200, CS F201, CS F202, CS F203 and 1 other', 'singular');
  assert.equal(joinCapped(n(6)), 'CS F200, CS F201, CS F202, CS F203 and 2 others', 'plural');
});

test('joinCapped: the sentence is bounded even when the list is not', () => {
  /*
   * Round 9's M-6: a 500-way slot clash from a corrupt import joined every
   * course into one sentence — measured at 7,525 characters — and rendered it
   * into the conflict panel as an unreadable wall.
   */
  const out = joinCapped(Array.from({ length: 500 }, (_, i) => `CS F${200 + i} L1`));
  assert.ok(out.length < 120, `the sentence must stay readable, got ${out.length} characters`);
  assert.match(out, /and 496 others$/);
});

test('joinCapped is total and drops nothing meaningful', () => {
  for (const bad of [undefined, null, 'not a list', 7, {}]) {
    assert.equal(joinCapped(bad), '', JSON.stringify(bad));
  }
  /* Empty and nullish members are dropped rather than rendered as a gap:
     "A,  and B" is the shape that makes a message look broken. */
  assert.equal(joinCapped(['a', null, '', undefined, 'b']), 'a and b');
  /* 0 and false stringify to real text, so they are NOT dropped -- only
     nullish and empty members are. Asserted so the distinction is a
     decision on record rather than an accident. */
  assert.equal(joinCapped([0, false]), '0 and false');
  assert.equal(joinCapped(['room', 'instructor'], { conjunction: 'or' }), 'room or instructor');
  assert.equal(joinCapped(['a', 'b', 'c'], { cap: 2 }), 'a, b and 1 other');
});

// ----------------------------------------------------------- displayName ----

test('displayName: the shapes a From header actually takes', () => {
  assert.equal(displayName('AUGSD <augsd@pilani.bits-pilani.ac.in>'), 'AUGSD');
  /* With no display name there is nothing to show but the address, and
     truncating it at the @ would hide which mailbox actually wrote. */
  assert.equal(displayName('<a@b.com>'), 'a@b.com');
  assert.equal(displayName('a@b.com'), 'a@b.com');
  assert.equal(displayName('"Doe, J" <j@x.z>'), 'Doe, J', 'a quoted comma is part of the name');
  assert.equal(displayName(''), '');
  assert.equal(displayName(undefined), '');
  assert.equal(displayName(null), '');
});

// -------------------------------------------------------------- dates ----

test('shortDate / fullDate: the boundaries between their branches', () => {
  /* shortDate reads the clock itself rather than taking a `now`, so these
     are expressed relative to the real one. */
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const now = Date.now();

  /* Under an hour is the only branch that CLAIMS RECENCY, so both of its
     edges are pinned: at 59 minutes it says so, at 60 it must stop. */
  assert.equal(shortDate(now - MIN), '1m');
  assert.equal(shortDate(now - 59 * MIN), '59m');
  assert.doesNotMatch(shortDate(now - HOUR - MIN), /^\d+m$/, 'an hour old is no longer "m"');

  /* A stamp from the future must never read as recent. */
  assert.doesNotMatch(shortDate(now + 10 * HOUR), /^\d+m$/);

  for (const bad of [NaN, Infinity, -Infinity, undefined, null, 0, '']) {
    assert.equal(fullDate(bad), '', `fullDate(${JSON.stringify(bad)})`);
    assert.equal(shortDate(bad), '',
      'a missing stamp renders as nothing, never "Invalid Date" or "NaNm"');
  }
});
