/**
 * Classifier tests. Plain Node, no framework, no build step:
 *   node --test test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classify, classifyAll } from '../src/classify/index.js';
import {
  detectBitsSource,
  extractAddress,
  extractDomain,
  ruleCount,
} from '../src/classify/sender.js';
import { normalizeConfidence } from '../src/classify/scoring.js';
import { CATEGORIES, SIDEBAR_ORDER } from '../src/classify/categories.js';
import { SENDER_RULES } from '../src/classify/sender-rules.js';
import { PATTERN_RULES } from '../src/classify/pattern-rules.js';

// ---------------------------------------------------------------- parsing --

test('extractAddress handles the shapes a From header actually takes', () => {
  assert.equal(extractAddress('AUGSD <augsd@pilani.bits-pilani.ac.in>'),
    'augsd@pilani.bits-pilani.ac.in');
  assert.equal(extractAddress('<a@b.com>'), 'a@b.com');
  assert.equal(extractAddress('a@b.com'), 'a@b.com');
  assert.equal(extractAddress(''), '');
  // A display name containing an @ must not confuse the parser.
  assert.equal(extractAddress('"me@work" <real@x.com>'), 'real@x.com');
});

test('extractDomain', () => {
  assert.equal(extractDomain('X <a@pilani.bits-pilani.ac.in>'),
    'pilani.bits-pilani.ac.in');
  assert.equal(extractDomain('no-at-sign'), '');
});

// ------------------------------------------------------------ BITS source --

test('recognises every campus domain', () => {
  for (const d of ['pilani', 'goa', 'hyderabad', 'dubai']) {
    const r = detectBitsSource(`X <a@${d}.bits-pilani.ac.in>`);
    assert.equal(r.isBits, true, d);
  }
  assert.equal(detectBitsSource('X <a@bits-pilani.ac.in>').isBits, true);
});

test('recognises a subdomain of a campus domain', () => {
  assert.equal(
    detectBitsSource('X <a@cs.pilani.bits-pilani.ac.in>').isBits, true);
});

test('REJECTS a lookalike phishing domain', () => {
  // The critical case: a substring check would call this internal.
  // A university is a prime target for exactly this shape.
  assert.equal(
    detectBitsSource('Registrar <admin@bits-pilani.ac.in.evil.com>').isBits,
    false);
  assert.equal(detectBitsSource('X <a@notbits-pilani.ac.in>').isBits, false);
});

// ------------------------------------------------------- sender stage ------

test('Registrar mail is admin regardless of subject', () => {
  const r = classify({
    from: 'Office of the Registrar <registrar@bits-pilani.ac.in>',
    subject: 'Hackathon prize pool announced',   // deliberately misleading
    snippet: 'club recruitment inductions',
  });
  assert.equal(r.category, 'admin');
  assert.equal(r.source, 'sender');
});

test('AUGSD is recognised from a bare display name', () => {
  // Bug fixed during the port: old list only had augsd WITH @bits-pilani.
  const r = classify({
    from: 'AUGSD <noreply@somehost.in>',
    subject: 'Course registration opens Monday',
  });
  assert.equal(r.category, 'augsd');
});

test('Practice School division mail lands in ps', () => {
  const r = classify({
    from: 'PS Division <psd@pilani.bits-pilani.ac.in>',
    subject: 'PS-2 station allotment list',
  });
  assert.equal(r.category, 'ps');
});

test('a hand-curated club matches', () => {
  for (const club of ['ARBITS', 'Nirmaan', 'CRAC', 'SARC', 'Radioaktiv']) {
    const r = classify({
      from: `${club} <contact@example.com>`,
      subject: 'inductions are open',
    });
    assert.equal(r.category, 'clubs', club);
  }
});

// -------------------------------------------- regressions found in the port --

test('REGRESSION: Placement Unit mail is internship, not clubs', () => {
  // "placement unit" appeared in BOTH the clubs and internship sender lists in
  // the old version. clubs is evaluated first, so every Placement Unit mail
  // was filed under Clubs.
  const r = classify({
    from: 'Placement Unit <placement@pilani.bits-pilani.ac.in>',
    subject: 'Campus drive: shortlist released',
  });
  assert.equal(r.category, 'internship');
});

test('REGRESSION: a GitHub notification is a service, not a promotion', () => {
  // Old rule order put external-promotions first, and it matched the bare
  // substring "unsubscribe" — which is in the footer of nearly every
  // legitimate notification email.
  const r = classify({
    from: 'GitHub <noreply@github.com>',
    subject: 'Your pull request was merged',
    snippet: 'You are receiving this because you are subscribed. unsubscribe',
  });
  assert.ok(['external-services', 'technology'].includes(r.category),
    `got ${r.category}`);
  assert.notEqual(r.category, 'external-promotions');
});

test('REGRESSION: tedxpilani matches (was dead code as tedxPilani)', () => {
  const r = classify({ from: 'TEDxPilani <team@tedx.example>', subject: 'hi' });
  assert.equal(r.category, 'clubs');
});

test('REGRESSION: internal mail never lands in external buckets', () => {
  // A club newsletter with an unsubscribe footer, from a BITS address.
  const r = classify({
    from: 'Music Club <musicclub@pilani.bits-pilani.ac.in>',
    subject: 'Newsletter: auditions this Friday',
    snippet: 'click unsubscribe to stop receiving these',
  });
  assert.equal(r.category, 'clubs');
});

// ----------------------------------------------------- pattern stage -------

test('an unknown BITS sender is classified on keywords', () => {
  const r = classify({
    from: 'Some Person <sp@pilani.bits-pilani.ac.in>',
    subject: 'Mid semester exam schedule and timetable',
  });
  assert.equal(r.source, 'pattern');
  assert.equal(r.category, 'augsd');
});

test('placement keywords beat generic ones', () => {
  const r = classify({
    from: 'HR <hr@company.com>',
    subject: 'Internship offer letter and stipend details',
  });
  assert.equal(r.category, 'internship');
});

test('obvious spam is caught', () => {
  const r = classify({
    from: 'Winner <no@reply.xyz>',
    subject: 'You have won! Claim your prize now',
    snippet: 'send your bank account number',
  });
  assert.equal(r.category, 'spam');
});

test('nothing matching falls back to other', () => {
  const r = classify({ from: 'A <a@b.com>', subject: 'lunch?' });
  assert.equal(r.category, 'other');
  assert.equal(r.source, 'fallback');
});

test('an empty message does not throw', () => {
  const r = classify({});
  assert.equal(r.category, 'other');
});

// ------------------------------------------------------------ confidence ---

test('confidence ladder matches the old calibration exactly', () => {
  assert.equal(normalizeConfidence(0), 0.3);
  assert.equal(normalizeConfidence(5), 0.4);
  assert.equal(normalizeConfidence(25), 0.55);
  assert.equal(normalizeConfidence(45), 0.7);
  assert.equal(normalizeConfidence(65), 0.82);
  assert.equal(normalizeConfidence(90), 0.9);
  assert.equal(normalizeConfidence(120), 0.95);
  assert.equal(normalizeConfidence(150), 0.98);
});

test('confidence is always a probability', () => {
  for (const s of [-10, 0, 3, 40, 200, 9999]) {
    const c = normalizeConfidence(s);
    assert.ok(c >= 0 && c <= 1, `${s} -> ${c}`);
  }
});

test('every classification carries a usable reason', () => {
  const samples = [
    { from: 'registrar@bits-pilani.ac.in', subject: 'fee payment' },
    { from: 'x@y.com', subject: 'internship offer letter' },
    { from: 'x@y.com', subject: 'nothing here' },
  ];
  for (const s of samples) {
    const r = classify(s);
    assert.ok(r.reason.length > 5, JSON.stringify(r));
  }
});

// ----------------------------------------------------------- data health ---

test('every category in the sidebar order is a real category', () => {
  for (const c of SIDEBAR_ORDER) assert.ok(CATEGORIES.includes(c), c);
  assert.equal(SIDEBAR_ORDER.length, CATEGORIES.length);
});

test('every sender rule targets a real category', () => {
  for (const r of SENDER_RULES) assert.ok(CATEGORIES.includes(r.category), r.category);
});

test('every pattern rule targets a real category', () => {
  for (const r of PATTERN_RULES) assert.ok(CATEGORIES.includes(r.category), r.category);
});

test('all patterns are lowercase (matching is case-folded)', () => {
  // This is what made tedxPilani dead code in the old version.
  for (const r of SENDER_RULES) {
    for (const p of r.patterns) {
      assert.equal(p, p.toLowerCase(), `SENDER_RULES ${r.category}: "${p}"`);
    }
  }
  for (const r of PATTERN_RULES) {
    for (const k of Object.keys(r.subjectWeights || {})) {
      assert.equal(k, k.toLowerCase(), `${r.category} subject: "${k}"`);
    }
    for (const k of Object.keys(r.snippetWeights || {})) {
      assert.equal(k, k.toLowerCase(), `${r.category} snippet: "${k}"`);
    }
    for (const s of r.senderContains || []) {
      assert.equal(s, s.toLowerCase(), `${r.category} sender: "${s}"`);
    }
  }
});

test('no sender pattern appears under two categories', () => {
  // This is the class of bug that sent Placement Unit mail to Clubs.
  const seen = new Map();
  for (const r of SENDER_RULES) {
    for (const p of r.patterns) {
      if (seen.has(p)) {
        assert.fail(`"${p}" is in both ${seen.get(p)} and ${r.category}`);
      }
      seen.set(p, r.category);
    }
  }
});

test('the curated rule set survived the port', () => {
  // A bad merge that halves this list should fail loudly, not silently
  // degrade classification quality.
  assert.ok(ruleCount() >= 190, `only ${ruleCount()} sender patterns`);
});

// ------------------------------------------------------------ performance --

test('classifying 500 messages is fast enough to be synchronous', () => {
  const msgs = [];
  for (let i = 0; i < 500; i++) {
    msgs.push({
      from: `Sender ${i} <s${i}@pilani.bits-pilani.ac.in>`,
      subject: `Course registration ${i} internship placement hackathon`,
      snippet: 'deadline semester club meeting library book return',
    });
  }
  const t0 = performance.now();
  const out = classifyAll(msgs);
  const ms = performance.now() - t0;

  assert.equal(out.length, 500);
  // The whole point of dropping async: 500 messages in one tick. Generous
  // bound so this is not flaky on a loaded CI box, but 200ms would still
  // catch a regression to per-message Promises.
  assert.ok(ms < 200, `took ${ms.toFixed(1)}ms`);
});
