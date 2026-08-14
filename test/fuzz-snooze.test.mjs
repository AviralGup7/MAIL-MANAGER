/**
 * Property sweep over the snooze ledger (fuzz campaign round 3,
 * 2026-08-14, defect #5). The `snoozed` blob is storage data: rows are
 * only as clean as the weakest writer that ever touched the profile.
 * loadSnoozed deliberately does not deep-normalise (the map can arrive
 * from an older build), so the three readers must be total on their own.
 *
 *   - due()/pending():  a non-finite `at` matches NEITHER set. -Infinity
 *                       used to report due instantly (silent unsnooze --
 *                       the "lost mail" failure this module exists to
 *                       prevent); +Infinity used to list in the Snoozed
 *                       view forever with a broken label.
 *   - wakeLabel():      always a string, never one built from NaN/
 *                       Infinity ("Invalid Date", "in Infinity hours").
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { due, pending, wakeLabel } from '../src/app/system/snooze.js';
import { mulberry32, hostileValue, hostileEpoch } from './helpers/fuzz.mjs';

test('due/pending abstain on every non-finite wake time', () => {
  const rnd = mulberry32(0x5B00); // 'snoo'
  for (let i = 0; i < 800; i++) {
    const at = rnd() < 0.5 ? hostileEpoch(rnd) : hostileValue(rnd);
    const all = { m1: { at, snoozedAt: 0 } };
    const dueNow = due(all, 1_700_000_000_000);
    const pend = pending(all, 1_700_000_000_000);
    if (!Number.isFinite(at)) {
      assert.equal(dueNow.length, 0, `due() matched at=${String(at).slice(0, 24)} (seed 0x5B00 draw ${i})`);
      assert.equal(pend.length, 0, `pending() matched at=${String(at).slice(0, 24)} (draw ${i})`);
    }
  }
  // The specific historical lies, pinned outright:
  assert.deepEqual(due({ m: { at: -Infinity, snoozedAt: 0 } }), [], '-Infinity must not unsnooze instantly');
  assert.deepEqual(pending({ m: { at: Infinity, snoozedAt: 0 } }), [], 'Infinity must not list forever');
  assert.deepEqual(due({ m: { at: NaN, snoozedAt: 0 } }), [], 'NaN matches neither set');
  assert.deepEqual(pending({ m: { at: NaN, snoozedAt: 0 } }), [], 'NaN matches neither set');
});

test('the honest ledger still reads exactly as before', () => {
  const now = 1_700_000_000_000;
  const all = {
    past: { at: now - 1000, snoozedAt: now - 5000 },
    soon: { at: now + 3_600_000, snoozedAt: now },
    later: { at: now + 86_400_000, snoozedAt: now },
    junk: 'not-a-row',
  };
  assert.deepEqual(due(all, now), ['past']);
  assert.deepEqual(
    pending(all, now).map((p) => p.id),
    ['soon', 'later'],
    'pending stays soonest-first',
  );
});

test('wakeLabel is total: always a string, never NaN/Infinity flavoured', () => {
  const rnd = mulberry32(0x5C1E);
  const now = 1_700_000_000_000;
  for (let i = 0; i < 600; i++) {
    const at = rnd() < 0.5 ? hostileEpoch(rnd) : hostileValue(rnd);
    const out = wakeLabel(at, now);
    assert.equal(typeof out, 'string', `wakeLabel broke its string contract (draw ${i})`);
    assert.ok(!out.includes('NaN'), `NaN shipped for at=${String(at).slice(0, 24)} (seed 0x5C1E draw ${i})`);
    assert.ok(!out.toLowerCase().includes('infinity'), `Infinity shipped for at=${String(at).slice(0, 24)} (draw ${i})`);
    assert.ok(!out.includes('Invalid Date'), `"Invalid Date" shipped for at=${String(at).slice(0, 24)} (draw ${i})`);
    if (!Number.isFinite(at)) assert.equal(out, '', `wakeLabel must abstain for ${String(at).slice(0, 24)}`);
  }
  // The finite voice is untouched.
  assert.equal(wakeLabel(now - 1000, now), 'now');
  assert.equal(wakeLabel(now + 45 * 60_000, now), 'in 45 min');
  assert.equal(wakeLabel(now + 30 * 3_600_000, now), 'tomorrow');
});
