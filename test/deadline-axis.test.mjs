/**
 * The all-code sweep, finding #3 (2026-08-14): the deadline menu ran on a
 * forked clock.
 *
 * deadlines.js's contract — pinned in feature-contracts.test.mjs as Date.UTC
 * epochs — is that every deadline is an end-of-day on the UTC wall clock.
 * But main.js kept a private endOfDay() that called d.setHours(23, 59) —
 * end-of-day in LOCAL time — under a comment claiming "the same convention
 * deadlines.js uses". Both statements could not be true, and the comment
 * was the false one. For an IST user (UTC+5:30) the menu's "Tomorrow"
 * preset wrote an override half a day west of the extractor's axis, and
 * relativeLabel could greet the saved override with "due today".
 *
 * The fix is structural, so the pins are structural: one axis, one owner,
 * and these tests make a fork expensive to reintroduce.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { endOfDay } from '../src/app/academic/deadlines.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
/* Decision-record comments may NAME the incident ("the local-time fork
   that sat here") — strip comments before scanning, the precedent the
   no-npx check and options-style pin already set. */
const stripped = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('the axis has exactly one definition, exported from deadlines.js', () => {
  const deadlines = stripped(read('src/app/academic/deadlines.js'));
  assert.match(deadlines, /export function endOfDay\(/, 'endOfDay is public, from the module that owns the contract');
});

test('main.js rides the axis and carries no local-time fork', () => {
  const main = stripped(read('src/app/main.js'));
  assert.ok(main.includes(`import { extractDeadline, endOfDay } from './academic/deadlines.js';`),
    'main.js imports the shared endOfDay');
  assert.ok(!/function endOfDay/.test(main), 'no second definition hides in main.js');
  assert.ok(!main.includes('setHours(23, 59'),
    'no local-clock end-of-day math — the fork that disagreed with the extractor by the user\'s UTC offset');
});

test('every deadline-menu preset passes an on-axis value', () => {
  const main = stripped(read('src/app/main.js'));
  const presets = [...main.matchAll(/preset\('([^']+)',\s*([^\n]+?)\)/g)];
  assert.ok(presets.length >= 4, 'the Today/Tomorrow/In-3-days/Next-week presets exist');
  for (const [, label, at] of presets) {
    assert.ok(at.startsWith('endOfDay('), `preset "${label}" must write an endOfDay, not raw arithmetic`);
  }
});

test('the axis itself is UTC end-of-day, idempotent', () => {
  /* 06:15 UTC on 2026-04-01 is 11:45 IST the same day — an instant where
     a local-time fork and the UTC axis pick different calendar days from
     the west of a timezone, and the axis must not move. */
  const t = Date.UTC(2026, 3, 1, 6, 15, 0);
  assert.equal(endOfDay(t), Date.UTC(2026, 3, 1, 23, 59, 0));
  assert.equal(endOfDay(endOfDay(t)), endOfDay(t), 'endOfDay is a fixed point of itself');
});
