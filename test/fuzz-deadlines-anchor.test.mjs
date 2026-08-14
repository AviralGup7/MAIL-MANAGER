/**
 * Property sweep over the deadline extractor's anchor (fuzz campaign
 * round 3, 2026-08-14, defect #13). msg.date is wire data: shapeMessage's
 * `Number(g.internalDate) || ...` cascade passes '1e999' through as
 * Infinity, and restored/legacy rows can carry worse. The old
 * `msg.date || now` anchor accepted any truthy value, with two measured
 * outcomes:
 *
 *   - "Meeting on Friday" under an Infinity/'abc' anchor returned
 *     {at: NaN} -- a deadline row that renders forever as garbage.
 *   - the 400-day plausibility rail compares `found.at - anchor`; with a
 *     NaN delta every comparison is false, so "Report due by 15 March
 *     2099" sailed straight through a rail built to stop exactly that.
 *
 * The fix treats a non-finite anchor as `now` (the documented || fallback,
 * made type-safe) and refuses non-finite results. The property pins,
 * written against the verdicts:
 *
 *   - at is ALWAYS a finite epoch when a row comes out, for any anchor.
 *   - the 400-day rail is never stood down, for any anchor.
 *   - honest anchors extract exactly as before.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractDeadline } from '../src/app/academic/deadlines.js';
import { mulberry32, hostileValue, hostileEpoch } from './helpers/fuzz.mjs';

const NOW = 1723700000000; // fixed instant for determinism
const DAY = 86400000;
const BODIES = [
  'Please submit the report by 15/03.',
  'Please submit the report by 15/03/2026.',
  'Report due by 15 December 2024',
  'Meeting on Friday, attendance deadline.',
  'Report due by 15 March 2099',
  'No dates anywhere in this one, just deadline chatter about the deadline.',
];

test('every admitted row carries a finite, plausibility-railed epoch', () => {
  const rnd = mulberry32(0xDEA1);
  for (let i = 0; i < 1200; i++) {
    const date = i % 2 === 0 ? hostileValue(rnd) : hostileEpoch(rnd);
    const body = BODIES[i % BODIES.length];
    let out;
    try {
      out = extractDeadline({ subject: 'x', snippet: body, date }, NOW);
    } catch (err) {
      assert.fail(`extractDeadline threw on date=${String(date).slice(0, 24)} (seed 0xDEA1 draw ${i}): ${err.message}`);
    }
    if (!out) continue;
    assert.ok(
      Number.isFinite(out.at),
      `non-finite deadline admitted for date=${String(date).slice(0, 24)} body=${body.slice(0, 30)} (seed 0xDEA1 draw ${i})`,
    );
    // Whatever the anchor, the rail may only excuse what IS plausible from
    // some honest reading -- never a four-year-out fabrication. (0 is
    // "unknown date" per shapeMessage and reads as `now`, matching the
    // function's documented falsy fallback.)
    const worstCaseAnchor = (Number.isFinite(date) && date) || NOW;
    const delta = out.at - worstCaseAnchor;
    assert.ok(
      delta > -31 * DAY && delta <= 400 * DAY,
      `rail stood down for date=${String(date).slice(0, 24)}: at is ${(delta / DAY).toFixed(0)}d out (draw ${i})`,
    );
  }
  // The two pinned reproducers from the verdict -- once NaN factories:
  for (const d of [Infinity, -Infinity, NaN, 'abc', '1e999', '2099-01-01', true, [], {}]) {
    const out = extractDeadline({ subject: 'x', snippet: 'Meeting on Friday, attendance deadline.', date: d }, NOW);
    if (out) assert.ok(Number.isFinite(out.at), `${String(d)} must produce a finite instant or nothing`);
  }
});

test('a hostile anchor cannot admit a four-year-out fabrication', () => {
  const far = 'Report due by 15 March 2099';
  assert.equal(extractDeadline({ subject: 'x', snippet: far, date: NOW }, NOW), null, 'honest rail rejects');
  for (const d of ['abc', '1e999', Infinity, -Infinity, {}, [], true, NaN]) {
    assert.equal(
      extractDeadline({ subject: 'x', snippet: far, date: d }, NOW),
      null,
      `hostile anchor ${String(d)} stood the rail down`,
    );
  }
});

test('honest anchors extract exactly as before', () => {
  const ok = extractDeadline({ subject: 'x', snippet: 'Please submit the report by 15/03.', date: NOW }, NOW);
  assert.ok(ok && Number.isFinite(ok.at) && ok.at > NOW, 'in-range numeric date extracted');
  const textual = extractDeadline({ subject: 'x', snippet: 'Report due by 15 December 2024', date: NOW }, NOW);
  assert.ok(textual && textual.at > NOW, 'textual date extracted');
  // A falsy date still anchors on now, as the old || documented.
  const falsy = extractDeadline({ subject: 'x', snippet: 'Please submit the report by 15/03.', date: 0 }, NOW);
  assert.ok(falsy && falsy.at > NOW, 'date 0 falls back to now');
});
