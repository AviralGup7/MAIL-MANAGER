/**
 * Property sweep over the contact parsing boundary (fuzz campaign round 3,
 * 2026-08-14, defects #12 and #15). Address parsers run at INGEST over
 * attacker-controlled From/To headers and again at compose-open over the
 * user's own fields, so they carry two properties:
 *
 *   - totality:        any value in, a parse out; never a throw.
 *   - linear time:     the three header regexes used to be quadratic --
 *                      measured 535ms for a 60k To header, ~500ms for 20k
 *                      of '<', 229ms for addressOf over the same. Mail
 *                      sizes are attacker-chosen; the freeze was real.
 *   - RFC 5322 sanity: `addr (Name)` is a legal recipient. It used to trip
 *                      the pre-send "invalid address" warning every time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addressOf, parseAddress, parseAddressList, invalidAddresses, looksLikeAddress,
} from '../src/app/core/contacts.js';
import { mulberry32, hostileValue, hostileString } from './helpers/fuzz.mjs';

test('parsers are total over any header-shaped value', () => {
  const rnd = mulberry32(0xC047);
  for (let i = 0; i < 1200; i++) {
    const v = i % 2 === 0 ? hostileValue(rnd) : hostileString(rnd);
    for (const [name, fn] of [
      ['addressOf', addressOf],
      ['parseAddress', parseAddress],
      ['parseAddressList', parseAddressList],
      ['invalidAddresses', invalidAddresses],
      ['looksLikeAddress', looksLikeAddress],
    ]) {
      try {
        fn(v);
      } catch (err) {
        assert.fail(`${name} threw on ${JSON.stringify(v)?.slice(0, 50)} (seed 0xC047 draw ${i}): ${err.message}`);
      }
    }
  }
});

test('hostile headers parse in linear time -- the quadratic wall stays down', () => {
  // Generous ceilings: ~20x the measured fixed cost, ~1/4 of the old cost.
  const scale = (fn, arg, budgetMs, label) => {
    const t0 = performance.now();
    fn(arg);
    const took = performance.now() - t0;
    assert.ok(took < budgetMs, `${label} took ${took.toFixed(1)}ms, budget ${budgetMs}ms`);
  };
  scale(parseAddressList, 'a@b.c,'.repeat(10000), 150, 'parseAddressList 60k-char header');
  scale(parseAddress, '<'.repeat(20000), 60, 'parseAddress 20k angle brackets');
  scale(addressOf, '<'.repeat(20000), 60, 'addressOf 20k angle brackets');
  scale(parseAddress, `n <${'x'.repeat(20000)}`, 60, 'parseAddress 20k unterminated bracket');
});

test('name/address extraction is byte-identical for well-formed headers', () => {
  assert.deepEqual(parseAddress('Aviral Gupta <f2024@pilani.bits-pilani.ac.in>'), {
    name: 'Aviral Gupta', address: 'f2024@pilani.bits-pilani.ac.in',
  });
  assert.deepEqual(parseAddress('"Quoted, Name" <q@x.in>'), { name: 'Quoted, Name', address: 'q@x.in' });
  assert.deepEqual(parseAddress('<c@d.in>'), { name: '', address: 'c@d.in' });
  assert.deepEqual(parseAddress('plain@x.in'), { name: '', address: 'plain@x.in' });
  assert.deepEqual(parseAddress('a <x> b <c@d.in>'), { name: 'a <x> b', address: 'c@d.in' });
  assert.equal(parseAddress('no-at-here'), null);
  assert.equal(parseAddress('weird <notanaddr>'), null, 'angle form without @ still vetoes');
  assert.deepEqual(
    parseAddressList('A <a@x.in>, b@y.in'),
    [{ name: 'A', address: 'a@x.in' }, { name: '', address: 'b@y.in' }],
  );
  // The documented divergence: a doubled bracket no longer yields '<a@b'.
  assert.equal(addressOf('<<a@b>>'), 'a@b');
});

test('RFC 5322 comment-form recipients are addresses, not warnings', () => {
  // The defect-#15 reproducer: this exact string drew a pre-send warning.
  assert.deepEqual(invalidAddresses('a@b.c (Rajesh)'), []);
  assert.deepEqual(parseAddress('a@b.c (Rajesh)'), { name: 'Rajesh', address: 'a@b.c' });
  assert.deepEqual(
    parseAddressList('a@b.c (Rajesh), d@e.f').map((a) => a.address),
    ['a@b.c', 'd@e.f'],
  );
  // And the warning still fires for genuinely broken recipients.
  assert.deepEqual(invalidAddresses('not-an-address'), ['not-an-address']);
  assert.deepEqual(invalidAddresses('ok@x.in, nope'), ['nope']);
});
