/**
 * Property sweep over the user-rules boundary (fuzz campaign round 3,
 * 2026-08-14, defects #4, #10, #14). Three structural properties, each
 * written against a reproduced verdict:
 *
 *   - own-read (#4):   applyCorrection must never resolve a sender through
 *                      the prototype chain. The sender string is
 *                      attacker-controlled and addressOf needs no '@', so
 *                      'constructor'/'__proto__'/'hasOwnProperty' are all
 *                      "addresses". A chain read once classified a message
 *                      with category = the Object constructor.
 *   - own-write (#10): map normalisers must survive the key '__proto__'.
 *                      Assignment goes through the prototype SETTER: a
 *                      string value is silently dropped (the user's
 *                      correction evaporates), an OBJECT value REPLACES the
 *                      map's prototype (entry lost AND every later miss
 *                      reads poisoned fields). Covered for both
 *                      normaliseRules corrections and the deadline-store
 *                      override maps -- same key, same trap, two modules.
 *   - one-strategy (#14): muted and autoArchive are mutually exclusive by
 *                      design of the toggles; a hostile or stale blob that
 *                      carries both for one category would hide mail
 *                      locally AND archive it upstream -- the traceless
 *                      loss. normaliseRules resolves it: the reversible
 *                      half (local hide) wins.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normaliseRules, applyCorrection, emptyRules } from '../src/app/mail/rules.js';
import { normaliseOverrides, pruneOverrides, isOverridden } from '../src/app/academic/deadline-store.js';
import { mulberry32, hostileString } from './helpers/fuzz.mjs';

/** What the wire and storage actually hand us: own enumerable '__proto__'
    keys. JSON.parse defines them as DATA properties; object literals cannot
    express that shape at all. */
const json = (s) => JSON.parse(s);

const PROTOTYPE_KEYS = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf'];

test('applyCorrection never resolves a sender through the prototype chain', () => {
  const rnd = mulberry32(0xA11E);
  const clean = emptyRules();
  for (let i = 0; i < 600; i++) {
    const key = i % 2 === 0 ? PROTOTYPE_KEYS[i % PROTOTYPE_KEYS.length] : hostileString(rnd);
    const msg = { from: key.includes('@') || rnd() < 0.5 ? `Evil <${key}>` : key, category: 'updates' };
    const out = applyCorrection(clean, msg);
    assert.equal(out.category, 'updates', `chain-read poisoned category via sender ${key.slice(0, 28)} (seed 0xA11E draw ${i})`);
    assert.notEqual(out.source, 'you', `phantom correction claimed a human decision (draw ${i})`);
  }
  // The pinned reproducer:
  const poisoned = applyCorrection(emptyRules(), { from: 'Evil <constructor>', category: 'updates' });
  assert.equal(poisoned.category, 'updates');
  assert.equal(typeof poisoned.category, 'string');
});

test('applyCorrection still honours real corrections', () => {
  const rules = normaliseRules({ corrections: { 'prof@bits.ac.in': 'academics' } });
  const out = applyCorrection(rules, { from: 'Prof X <prof@bits.ac.in>', category: 'updates' });
  assert.equal(out.category, 'academics');
  assert.equal(out.source, 'you');
  assert.equal(out.confidence, 1);
});

test('normaliseRules keeps a __proto__ correction without touching the prototype', () => {
  /* WIRE-FAITHFUL INPUT (amended 2026-08-14, the same day): the first draft
     passed the literal `{ __proto__: 'academics', ... }`, which is a trap —
     object-literal __proto__ with a non-object value is SWALLOWED (no own
     property is ever created), so the entry these assertions guard was
     never in the input and the test could never pass. json() below builds
     exactly what storage and backup imports deliver: an own enumerable
     '__proto__'. The code was innocent; the literal was the defect. */
  const rules = normaliseRules(json('{"corrections":{"__proto__":"academics","ok@bits.ac.in":"updates"}}'));
  assert.equal(Object.getPrototypeOf(rules.corrections), Object.prototype, 'prototype must stay stock');
  assert.equal(Object.hasOwn(rules.corrections, '__proto__'), true, 'the entry must survive as own data');
  assert.equal(rules.corrections['__proto__'], 'academics');
  assert.equal(rules.corrections['ok@bits.ac.in'], 'updates');
  assert.equal(rules.corrections.missing, undefined, 'misses still read undefined');
  // And the round-trip through saveRules' JSON boundary keeps it.
  const again = normaliseRules(JSON.parse(JSON.stringify(rules)));
  assert.equal(again.corrections['__proto__'], 'academics');
});

test('normaliseRules resolves a muted+autoArchive contradiction in favour of muted', () => {
  const rules = normaliseRules({
    muted: ['promotions'],
    autoArchive: ['promotions', 'newsletters'],
    corrections: {},
  });
  assert.deepEqual(rules.muted, ['promotions'], 'local hide stays -- it is the reversible half');
  assert.deepEqual(rules.autoArchive, ['newsletters'], 'the destructive-adjacent half yields');
  // A blob with no contradiction is untouched, order included.
  const plain = normaliseRules({ muted: ['b'], autoArchive: ['a', 'c'], corrections: {} });
  assert.deepEqual(plain.autoArchive, ['a', 'c']);
});

test('normaliseOverrides: __proto__ keeps its entry, poisons nothing', () => {
  // Same literal trap, object-valued branch: `{ __proto__: evil }` would
  // have made evil the PROTOTYPE and left zero own keys.
  const evil = { messageId: '__proto__', at: 1_700_000_000_001, origin: 'manual', setAt: 7 };
  const map = normaliseOverrides(json('{"__proto__":' + JSON.stringify(evil) + ',"real1":{"at":1700000000002,"origin":"corrected","setAt":8}}'));
  assert.equal(Object.getPrototypeOf(map), Object.prototype, 'object value must NOT become the prototype');
  assert.equal(Object.hasOwn(map, '__proto__'), true, 'the entry must survive');
  assert.equal(map['__proto__'].at, 1_700_000_000_001);
  // The historical pollution read: with `out[id] = v`, every miss read
  // through to the override's own fields.
  assert.equal(normaliseOverrides(json('{"__proto__":' + JSON.stringify(evil) + ',"k":{"at":5,"setAt":1}}')).missing, undefined);
  assert.equal(isOverridden(map, '__proto__'), true);
  assert.equal(map.real1.at, 1_700_000_000_002);
});

test('pruneOverrides keeps __proto__ among the living instead of eating it', () => {
  const evil = { messageId: '__proto__', at: 1_700_000_000_001, origin: 'manual', setAt: 7 };
  const map = normaliseOverrides(json('{"__proto__":' + JSON.stringify(evil) + ',"gone":{"at":1700000000002,"origin":"manual","setAt":8}}'));
  const pruned = pruneOverrides(map, new Set(['__proto__'])); // 'gone' drops -> the rebuild path runs
  assert.equal(Object.getPrototypeOf(pruned), Object.prototype);
  assert.equal(Object.hasOwn(pruned, '__proto__'), true, 'the live override must not vanish in a prune');
  assert.equal(pruned['__proto__'].at, 1_700_000_000_001);
});
