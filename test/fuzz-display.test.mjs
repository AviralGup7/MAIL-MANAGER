/**
 * Property sweep over the display boundary (fuzz campaign round 3,
 * 2026-08-14). displayName/shortDate/fullDate run per row per render over
 * CORPUS data, and corpus data is only as clean as the weakest cache row
 * that hydrated it. The properties, written against the verdicts:
 *
 *   - totality: any JSON-shaped `from` yields a string, never a throw
 *   - honesty:  no epoch ever renders the "1m" recency claim unless the
 *               message is actually under an hour old, and no peer of the
 *               "Invalid Date"/"NaNm" strings ever ships in this slot
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { displayName, shortDate, fullDate } from '../src/app/core/display.js';
import { mulberry32, hostileString, hostileValue, hostileEpoch } from './helpers/fuzz.mjs';

test('displayName is total: any corpus-shaped from in, a string out', () => {
  const rnd = mulberry32(0xD15C); // 'disc'
  for (let i = 0; i < 1500; i++) {
    const from = i % 3 === 0 ? hostileString(rnd) : hostileValue(rnd);
    let out;
    try {
      out = displayName(from);
    } catch (err) {
      assert.fail(`displayName threw on ${JSON.stringify(from)?.slice(0, 60)} (seed 0xD15C draw ${i}): ${err.message}`);
    }
    assert.equal(typeof out, 'string', `non-string display for draw ${i}`);
    assert.ok(!out.includes('function '), 'prototype junk must not become a name');
  }
});

test('displayName keeps the honest extractions it always had', () => {
  assert.equal(displayName('Aviral Gupta <f2024@pilani.bits-pilani.ac.in>'), 'Aviral Gupta');
  assert.equal(displayName('f2024@pilani.bits-pilani.ac.in'), 'f2024@pilani.bits-pilani.ac.in');
  assert.equal(displayName(null), '');
  assert.equal(displayName(undefined), '');
  assert.equal(displayName(42), '42');
});

test('shortDate never claims "1m" for a message that is not under an hour old', () => {
  const now = Date.now();
  // The lies this slot used to tell: a future stamp (clock skew, damaged
  // cache) and +Infinity both printed "1m" -- the strongest recency claim
  // the UI can make, for mail that is provably not a minute old.
  assert.notEqual(shortDate(now + 2 * 3600_000), '1m', 'two hours in the future');
  assert.notEqual(shortDate(now + 30 * 86400_000), '1m', 'a month in the future');
  assert.notEqual(shortDate(Infinity), '1m', 'the divergent stamp');
  assert.equal(shortDate(now - 60_000), '1m', 'the honest recent case still wins');
});

test('non-finite epochs render nothing, never "Invalid Date" or "NaNm"', () => {
  const rnd = mulberry32(0xE0C4);
  for (let i = 0; i < 400; i++) {
    const ms = rnd() < 0.5 ? hostileEpoch(rnd) : hostileValue(rnd);
    const s = shortDate(ms);
    const f = fullDate(ms);
    for (const out of [s, f]) {
      assert.ok(!out.includes('NaN'), `NaN shipped in a label for ${String(ms).slice(0, 30)} (seed 0xE0C4 draw ${i})`);
      assert.ok(!out.includes('Invalid Date'), `"Invalid Date" shipped for ${String(ms).slice(0, 30)} (draw ${i})`);
    }
    if (!Number.isFinite(ms) || !ms) {
      assert.equal(s, '', `shortDate must abstain for ${String(ms)}`);
      assert.equal(f, '', `fullDate must abstain for ${String(ms)}`);
    }
  }
});
