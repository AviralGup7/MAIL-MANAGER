/**
 * Property sweep over the classifier (2026-08-14 fuzz hunt).
 *
 * These are PROPERTIES, not examples: whatever a hostile From header or a
 * 5000-char subject contains, classify owes the UI a well-formed verdict.
 * Written BEFORE knowing whether they pass — that is the point of the
 * exercise. Seeded: a failure replays exactly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { classify, classifyAll, CATEGORIES, SIDEBAR_ORDER } from '../src/classify/index.js';
import { mulberry32, hostileString, hostileValue } from './helpers/fuzz.mjs';

const VALID = new Set([...(CATEGORIES ? Object.keys(CATEGORIES) : []), ...(SIDEBAR_ORDER || [])]);

function randomMsg(rnd) {
  const m = {
    from: hostileString(rnd),
    subject: hostileString(rnd),
    snippet: hostileString(rnd),
  };
  /* Sometimes a field is the wrong TYPE entirely — imports, storage damage
     and future features all write stranger things than bad text. */
  if (rnd() < 0.15) m.subject = hostileValue(rnd);
  if (rnd() < 0.15) m.from = hostileValue(rnd);
  if (rnd() < 0.1) m.snippet = hostileValue(rnd);
  return m;
}

test('classify returns a well-formed verdict for anything', () => {
  const rnd = mulberry32(0xC1A55);
  for (let i = 0; i < 2000; i++) {
    const msg = randomMsg(rnd);
    let v;
    try {
      v = classify(msg);
    } catch (err) {
      assert.fail(`classify threw on ${JSON.stringify(msg)?.slice(0, 120)}: ${err.message}`);
    }
    assert.ok(v && typeof v === 'object', 'verdict is an object');
    assert.ok(VALID.has(v.category), `category "${v.category}" is one the sidebar can render`);
    assert.ok(Number.isFinite(v.confidence) && v.confidence >= 0 && v.confidence <= 1,
      `confidence ${v.confidence} is a probability`);
    assert.ok(Array.isArray(v.hits), 'hits is an array');
    assert.ok(typeof v.reason === 'string' && v.reason.length > 0, 'there is always a stated reason');
  }
});

test('classify is deterministic', () => {
  const rnd = mulberry32(0xDE7E12);
  for (let i = 0; i < 300; i++) {
    const msg = randomMsg(rnd);
    assert.deepEqual(classify(msg), classify(msg), 'same mail, two different verdicts');
  }
});

test('classifyAll is elementwise-consistent with classify', () => {
  const rnd = mulberry32(0xBA7C4);
  for (let i = 0; i < 50; i++) {
    const batch = Array.from({ length: Math.floor(rnd() * 20) }, () => randomMsg(rnd));
    let out;
    try {
      out = classifyAll(batch);
    } catch (err) {
      assert.fail(`classifyAll threw: ${err.message}`);
    }
    assert.equal(out.length, batch.length);
    batch.forEach((msg, j) => assert.deepEqual(out[j], classify(msg)));
  }
});
