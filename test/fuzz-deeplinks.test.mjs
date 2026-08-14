/**
 * Property sweep over the deep-link hash boundary (fuzz campaign round 3,
 * 2026-08-14, defect #9). formatHash runs on the RENDER path -- every
 * view switch mirrors the state into the URL -- and it had no try/catch
 * anywhere above it. One saved view whose query carried a lone surrogate
 * (JSON transmits them intact; a backup import is all it takes) made
 * encodeURIComponent throw URIError and took the render with it.
 *
 *   - totality:     any state query/id in, a hash out; never a throw.
 *   - round-trip:   parseHash(formatHash(s)) returns the same meaning.
 *   - no lossy lies: a clean string passes through byte-identical; only
 *                    lone surrogate halves become U+FFFD. (The scrub
 *                    regex needs the lookarounds -- the bare class ate
 *                    intact surrogate pairs when this fix was first
 *                    measured on V8.)
 *
 * (Lone surrogates are built with String.fromCharCode so this file never
 * carries raw unpaired bytes of its own.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatHash, parseHash } from '../src/app/system/deep-links.js';
import { mulberry32, hostileString, hostileValue } from './helpers/fuzz.mjs';

const validMailbox = (m) => ['inbox', 'sent', 'drafts', 'snoozed'].includes(m);
const LONE_HIGH = String.fromCharCode(0xd83d);
const LONE_LOW = String.fromCharCode(0xdc00);
const REPLACEMENT = String.fromCharCode(0xfffd);

test('formatHash never throws, whatever the query or id', () => {
  const rnd = mulberry32(0xD331);
  for (let i = 0; i < 900; i++) {
    const state = {
      mailbox: 'inbox',
      category: 'all',
      query: i % 2 === 0 ? hostileString(rnd) : String(hostileValue(rnd) ?? ''),
      selected: rnd() < 0.3 ? hostileString(rnd) : undefined,
    };
    let h;
    try {
      h = formatHash(state);
    } catch (err) {
      assert.fail(`formatHash threw on query ${JSON.stringify(state.query)?.slice(0, 40)} (seed 0xD331 draw ${i}): ${err.message}`);
    }
    assert.ok(h.startsWith('#inbox/all'), `hash shape broken (draw ${i})`);
  }
  // The pinned reproducers: lone halves in either position, both sexes.
  assert.doesNotThrow(() => formatHash({ mailbox: 'inbox', category: 'all', query: `ev${LONE_HIGH}` }));
  assert.doesNotThrow(() => formatHash({ mailbox: 'inbox', category: 'all', query: `${LONE_LOW}kay` }));
  assert.doesNotThrow(() => formatHash({ mailbox: 'inbox', category: 'all', query: `x${LONE_HIGH}y${LONE_LOW}z` }));
});

test('lone surrogates become U+FFFD; clean text passes through byte-identical', () => {
  const h1 = formatHash({ mailbox: 'inbox', category: 'all', query: `ev${LONE_LOW}d` });
  assert.ok(h1.includes(encodeURIComponent(REPLACEMENT)), 'lone low surrogate replaced');
  assert.ok(!h1.includes('ev' + LONE_LOW + 'd'), 'the broken half is gone');
  const clean = formatHash({ mailbox: 'inbox', category: 'all', query: 'from:prof deadline tomorrow' });
  assert.equal(
    clean,
    `#inbox/all?q=${encodeURIComponent('from:prof deadline tomorrow')}`,
    'clean queries are byte-identical to the pre-fix encoding',
  );
  // An intact surrogate pair is still text, and stays encodable.
  const pair = formatHash({ mailbox: 'inbox', category: 'all', query: 'notes \u{1F4CC} today' });
  assert.ok(pair.includes(encodeURIComponent('\u{1F4CC}')), 'intact pairs survive');
});

test('a hostile query round-trips to the same meaning', () => {
  const rnd = mulberry32(0xD332);
  for (let i = 0; i < 400; i++) {
    const raw = hostileString(rnd);
    const h = formatHash({ mailbox: 'sent', category: 'all', query: raw });
    const parsed = parseHash(h, { validMailbox });
    assert.ok(parsed, `hash must parse back (seed 0xD332 draw ${i})`);
    const expected = raw.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, REPLACEMENT);
    assert.equal(parsed.q, expected, `round-trip drift (draw ${i})`);
  }
});

test('ordinary state formatting is untouched', () => {
  assert.equal(formatHash({ mailbox: 'inbox', category: 'all' }), '#inbox/all');
  assert.equal(formatHash({ mailbox: 'sent', category: 'academics', query: '', selected: '' }), '#sent/academics');
  assert.equal(
    formatHash({ mailbox: 'inbox', category: 'updates', selected: 'm-123' }),
    '#inbox/updates?m=m-123',
  );
  const parsed = parseHash('#inbox/updates?q=from%3Aprof', { validMailbox });
  assert.equal(parsed.q, 'from:prof');
});
