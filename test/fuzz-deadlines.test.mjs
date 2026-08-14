/**
 * Property sweep over the deadline axis (2026-08-14 fuzz hunt).
 *
 * The extractor contract is UTC end-of-day (pinned literally in features
 * and deadline-axis tests). This file asks the harsher questions: does the
 * axis hold for EVERY instant, and do the human labels stay HUMAN for any
 * number storage can be corrupted into — including NaN and Infinity.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  endOfDay, extractDeadline, relativeLabel, urgency, DAY_MS,
} from '../src/app/academic/deadlines.js';
import { mulberry32, hostileString, hostileEpoch } from './helpers/fuzz.mjs';

const BUCKETS = new Set(['overdue', 'today', 'soon', 'week', 'later']);

test('endOfDay is idempotent and on-axis for any finite instant', () => {
  const rnd = mulberry32(0xE0D);
  for (let i = 0; i < 3000; i++) {
    const ms = hostileEpoch(rnd);
    if (!Number.isFinite(ms)) continue;
    const once = endOfDay(ms);
    assert.equal(endOfDay(once), once, `axis moved for ${new Date(ms).toISOString()}`);
    /* And it is an end-of-DAY: 23:59 UTC, never midnight, never noon. */
    assert.equal(new Date(once).getUTCHours(), 23);
    assert.equal(new Date(once).getUTCMinutes(), 59);
  }
});

test('labels never say NaN and buckets never invent a name', () => {
  const rnd = mulberry32(0x1ABE1);
  const now = Date.now();
  for (let i = 0; i < 2000; i++) {
    const at = hostileEpoch(rnd);
    let label, bucket;
    try {
      label = relativeLabel(at, now);
      bucket = urgency(at, now);
    } catch (err) {
      assert.fail(`threw on at=${at}: ${err.message}`);
    }
    assert.ok(typeof label === 'string', 'label is a string');
    assert.ok(!/NaN|Infinity/.test(label), `label "${label}" is human for at=${at}`);
    assert.ok(BUCKETS.has(bucket), `urgency bucket "${bucket}" for at=${at}`);
  }
});

test('the extractor returns only on-axis epochs or nothing', () => {
  const rnd = mulberry32(0xEC7);
  for (let i = 0; i < 2000; i++) {
    const msg = { subject: hostileString(rnd), snippet: hostileString(rnd) };
    let hit;
    try {
      hit = extractDeadline(msg, 1_700_000_000_000);
    } catch (err) {
      assert.fail(`extract threw on ${JSON.stringify(msg).slice(0, 100)}: ${err.message}`);
    }
    if (hit === null) continue;
    assert.ok(Number.isFinite(hit.at), 'the extracted epoch is finite');
    assert.equal(endOfDay(hit.at), hit.at,
      `extracted ${new Date(hit.at).toISOString()} is not on the UTC end-of-day axis`);
    assert.ok(hit.at <= 1_700_000_000_000 + 400 * DAY_MS,
      'a deadline more than 400 days out is a parse artifact, not a plan');
    assert.ok(['deadline', 'event'].includes(hit.kind));
  }
});
