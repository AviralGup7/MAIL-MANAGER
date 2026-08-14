/**
 * Fuzz sweep, round 4 (1/3 — 2026-08-14, defect #19): the ingest boundary
 * must never emit a non-finite instant.
 *
 * THE ACCUSATION, CONFIRMED BEFORE THE FIX. `normalise` shaped the canonical
 * record with `Number(g.internalDate) || Date.parse(h.date) || 0`, and
 * `extractBody` repeated the same cascade on the GET_BODY path. A wire
 * internalDate of '1e999' parses to Infinity -- TRUTHY -- so the fallback
 * never ran. Measured pre-fix: `normalise({internalDate:'1e999'})` returned
 * date: Infinity through BOTH producers. That row then sorted above every
 * message in the mailbox (sorts compare date), persisted across restarts,
 * and forced every consumer to learn to abstain one by one (#2's
 * relativeLabel, #6's fullDate, #13's deadline anchor). Doctrine says the
 * non-finite dies where data enters, not in each reader.
 *
 * Properties pinned:
 *   - normalise's date is ALWAYS a finite number, over fuzzed internalDate
 *     values and Date headers (the wire sends internalDate as a string of
 *     millis; the fuzz leans on '1e999', '-1e999', 'NaN', scrap, and honest
 *     values alike);
 *   - the semantic contract is unchanged for every value the old code
 *     handled correctly — finite numbers pass through (pre-1970 mail is
 *     negative and stays negative), missing dates floor at 0;
 *   - a non-finite internalDate now FALLS BACK to the Date header, so
 *     '1e999' + a real Date header keeps the real instant;
 *   - extractBody's date obeys the same contract (same helper, one rule).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { normalise, toEpoch } = await import('../src/background/gmail.js');
const { extractBody } = await import('../src/background/mime.js');
const { mulberry32, hostileString, hostileEpoch } = await import('./helpers/fuzz.mjs');

/** Wire-shaped internalDate: usually a millis string, often hostile. */
function hostileInternalDate(rnd) {
  const r = rnd();
  if (r < 0.25) return String(Math.floor(hostileEpoch(rnd)));
  if (r < 0.35) return '1e999';
  if (r < 0.42) return '-1e999';
  if (r < 0.5) return 'NaN';
  if (r < 0.62) return '';
  if (r < 0.72) return hostileString(rnd);
  if (r < 0.85) return Math.floor(hostileEpoch(rnd)); // numbers ride the wire too
  return null;
}

function wireMessage(internalDate, dateHeader) {
  return {
    id: 'm1',
    threadId: 't1',
    internalDate,
    labelIds: [],
    payload: { headers: dateHeader == null ? [] : [{ name: 'Date', value: dateHeader }] },
  };
}

test('fuzz: normalise never emits a non-finite date, whatever the wire carries', () => {
  const rnd = mulberry32(0xb011dcae);
  for (let i = 0; i < 1000; i++) {
    const internalDate = hostileInternalDate(rnd);
    const dateHeader = rnd() < 0.5 ? hostileString(rnd) : null;
    const msg = normalise(wireMessage(internalDate, dateHeader));
    assert.ok(
      Number.isFinite(msg.date),
      `seed 0xb011dcae draw ${i}: date ${msg.date} from internalDate=${JSON.stringify(internalDate)} dateHeader=${JSON.stringify(dateHeader)}`
    );
    assert.equal(typeof msg.date, 'number');
  }
});

test('the old falsy contract is kept, MINUS the non-finite ones (reproducers)', () => {
  // The defect-#19 reproducer: this exact record shipped Infinity pre-fix
  // and sat on top of the mailbox until the data was cleared.
  assert.equal(normalise(wireMessage('1e999', null)).date, 0);
  assert.equal(normalise(wireMessage('-1e999', null)).date, 0);
  assert.equal(normalise(wireMessage('NaN', null)).date, 0);
  // The bug-hunt-#41 fallback the original cascade promised: bad
  // internalDate + honest Date header keeps the honest instant.
  const honest = 'Wed, 01 Jan 2020 00:00:00 GMT';
  assert.equal(normalise(wireMessage('1e999', honest)).date, Date.parse(honest));
  assert.equal(normalise(wireMessage('', honest)).date, Date.parse(honest));
  // Honest data is identical to before: millis pass through, including
  // pre-1970 (negative) and epoch-adjacent values.
  assert.equal(normalise(wireMessage('1577836800001', null)).date, 1577836800001);
  assert.equal(normalise(wireMessage('-31536000000', null)).date, -31536000000);
  // toEpoch is the one rule both producers share.
  assert.equal(toEpoch('1e999', honest), Date.parse(honest));
  assert.equal(toEpoch(null, null), 0);
});

test('extractBody obeys the same boundary (GET_BODY is the second producer)', () => {
  const rnd = mulberry32(0xdeb19);
  for (let i = 0; i < 400; i++) {
    const full = {
      id: 'm1',
      threadId: 't1',
      internalDate: hostileInternalDate(rnd),
      payload: { headers: [] },
    };
    const out = extractBody(full);
    assert.ok(
      Number.isFinite(out.date),
      `seed 0xdeb19 draw ${i}: body date ${out.date} from ${JSON.stringify(full.internalDate)}`
    );
  }
  // The reply attribution line reads this date; Infinity used to reach it.
  assert.equal(
    extractBody({ id: 'm1', threadId: 't1', internalDate: '1e999', payload: { headers: [] } }).date,
    0
  );
});
