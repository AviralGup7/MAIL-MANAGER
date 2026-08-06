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
  classifyBySender,
} from '../src/classify/sender.js';
import { normalizeConfidence, resolveConflict } from '../src/classify/scoring.js';
import { CATEGORIES, SIDEBAR_ORDER } from '../src/classify/categories.js';
import { SENDER_RULES } from '../src/classify/sender-rules.js';
import { PATTERN_RULES } from '../src/classify/pattern-rules.js';
import { ADDRESS_MAP } from '../src/classify/address-map.js';

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
  // `address`, not `sender`: registrar@bits-pilani.ac.in is one of the 152
  // curated exact addresses, so stage 0 claims it before the substring rules
  // are consulted. The category is the same either way.
  assert.equal(r.source, 'address');
});

test('AUGSD is recognised from a bare display name', () => {
  // NOT a bug fixed during the port -- the old list already had bare 'augSD'
  // and 'Academic Section'. See notes/CLASSIFIER_CORRECTION.md.
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
  // `academics`, not `augsd`. Under the ORIGINAL weights (data pack section 6)
  // augsd's subject list contains neither "exam" nor "timetable" and scores
  // zero here, while academics scores exam(60) + timetable(40) with
  // diminishing returns = 115.2.
  //
  // This test previously asserted `augsd`, which only passed because the first
  // hand-written port had invented its own weights. See
  // notes/CLASSIFIER_CORRECTION.md.
  assert.equal(r.category, 'academics');
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

test('a duplicated sender pattern is always won by the earlier rule', () => {
  // This test used to assert that no pattern appears twice, on the belief that
  // 'placement unit' being in both `clubs` and `internship` misfiled Placement
  // Unit mail. That was wrong: `internship` is rule 7 and `clubs` is rule 11,
  // so internship already won and the duplicate is simply unreachable.
  // See notes/CLASSIFIER_CORRECTION.md.
  //
  // What is worth asserting is the property that made the duplicate harmless:
  // first rule wins, so a duplicate can never change a classification.
  const firstOwner = new Map();
  const dupes = [];
  for (const r of SENDER_RULES) {
    for (const p of r.patterns) {
      const key = p.toLowerCase();
      if (firstOwner.has(key)) dupes.push({ pattern: key, first: firstOwner.get(key), also: r.category });
      else firstOwner.set(key, r.category);
    }
  }
  for (const d of dupes) {
    const hit = classifyBySender(`Someone <x@pilani.bits-pilani.ac.in>`.replace('Someone', d.pattern), true);
    assert.equal(
      hit?.category,
      d.first,
      `duplicate "${d.pattern}" must resolve to the earlier rule ${d.first}, not ${d.also}`
    );
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

// ------------------------------------- fidelity to the data pack -----------
//
// These guard the two REAL bugs found by diffing src/classify against
// CLASSIFICATION_DATA_PACK.md, plus the shape of the data itself. Unlike the
// four claims in the first port, each of these was verified against the
// authoritative export before being written. See notes/CLASSIFIER_CORRECTION.md.

test('sender rule order matches the data pack exactly', () => {
  // Order IS behaviour: first match wins. An "improvement" here silently
  // reclassifies mail. A previous pass swapped external-services ahead of
  // external-promotions and moved newsletter@substack.com between categories.
  assert.deepEqual(
    SENDER_RULES.map((r) => r.category),
    [
      'admin', 'library', 'ps', 'augsd', 'academics', 'administration',
      'internship', 'external-promotions', 'external-services',
      'competitions', 'clubs', 'events', 'spam',
    ]
  );
});

test('REAL BUG: senderExact is a substring test, not equality', () => {
  // Data pack section 8: "If rule.senderExact && email includes any exact".
  // The port used `fromLower === e`, which made every senderExact list
  // unreachable -- 4 in internship, 4 in spam, 29 in technology, plus admin,
  // augsd and ps. `technology` is driven entirely by that list, so technology
  // mail scored zero and fell through to whatever matched next.
  // Use a sender that stage 1 does NOT claim, so stage 2 actually runs.
  // (`nvidia.com` is an external-services sender rule and short-circuits.)
  const r = classify({
    from: 'Weekly Digest <hello@some-dev-blog.io>',
    subject: 'Release notes and new feature digest',
    snippet: 'newsletter',
  });
  assert.equal(r.category, 'technology', 'senderExact must match as a substring');

  // Direct proof at the unit level: 'nvidia' is a technology senderExact
  // entry and could never equal a whole From header.
  const tech = PATTERN_RULES.find((x) => x.category === 'technology');
  assert.ok(tech.senderExact.includes('nvidia'));
  assert.ok(
    tech.senderExact.some((e) => 'nvidia developer <news@nvidia.com>'.includes(e)),
    'substring semantics are what make this list reachable'
  );
});

test('REAL BUG: an external sender cannot match an internal BITS rule', () => {
  // Data pack section 8, STEP 2, second half of the filter:
  //   If !isBits && category NOT external- && !== "spam" -> SKIP
  // Without it a stranger sending as "Placement Office <careers@evil.example>"
  // was presented to the student as internal placement mail. That is a
  // phishing shape, in the category a student is most likely to act on.
  assert.equal(
    classifyBySender('Placement Office <careers@evil.example>', false),
    null,
    'stage 1 must not match an internal rule for an external sender'
  );
  // And the same sender still matches genuinely external buckets.
  assert.equal(classifyBySender('newsletter@evil.example', false)?.category, 'external-promotions');

  // The genuine internal one still works.
  const ok = classify({
    from: 'Placement Unit <pu@pilani.bits-pilani.ac.in>',
    subject: 'Campus recruitment drive',
    snippet: 'apply now',
  });
  assert.equal(ok.category, 'internship');
});

test('a BITS sender cannot be classified as an external category', () => {
  // The other half of the same filter. A club mail whose footer says
  // "unsubscribe" must stay a club mail.
  for (const r of SENDER_RULES) {
    if (!r.category.startsWith('external-')) continue;
    for (const p of r.patterns.slice(0, 4)) {
      const hit = classifyBySender(`${p} <x@pilani.bits-pilani.ac.in>`, true);
      assert.ok(
        !hit || !hit.category.startsWith('external-'),
        `BITS sender matched external pattern "${p}"`
      );
    }
  }
});

test('every pattern rule weight is a positive number', () => {
  // Cheap guard against a bad regeneration of the generated file.
  for (const rule of PATTERN_RULES) {
    for (const field of ['subjectWeights', 'snippetWeights']) {
      for (const [k, v] of Object.entries(rule[field] || {})) {
        assert.equal(typeof v, 'number', `${rule.category}.${field}.${k}`);
        assert.ok(v > 0, `${rule.category}.${field}.${k} = ${v}`);
      }
    }
  }
});

test('the pattern rule set survived the port at full size', () => {
  // The first hand-written port shipped 89 keys where the source had 891.
  // It read as deliberate and was documented as a faithful carry-over.
  let keys = 0;
  for (const r of PATTERN_RULES) {
    keys += (r.senderExact || []).length + (r.senderContains || []).length;
    keys += Object.keys(r.subjectWeights || {}).length;
    keys += Object.keys(r.snippetWeights || {}).length;
  }
  assert.ok(keys >= 880, `only ${keys} pattern keys, expected ~891`);
  assert.equal(PATTERN_RULES.length, 14);
});

// ------------------------------------ stage 0: exact address map -----------

test('the 152 curated addresses are loaded and decisive', () => {
  // The old repo shipped these in email-mappings/*.json and never read them.
  // The data pack says so explicitly: "not loaded by the classifier code at
  // runtime". Loading them is the largest accuracy win in the pack.
  assert.ok(ADDRESS_MAP.size >= 150, `only ${ADDRESS_MAP.size} addresses`);

  const cases = [
    ['ad.swd@pilani.bits-pilani.ac.in', 'administration'],
    ['psd@pilani.bits-pilani.ac.in', 'ps'],
    ['registrar@bits-pilani.ac.in', 'admin'],
  ];
  for (const [addr, cat] of cases) {
    const r = classify({ from: `Someone <${addr}>`, subject: 'anything at all' });
    assert.equal(r.category, cat, addr);
    assert.equal(r.source, 'address');
    assert.equal(r.confidence, 0.98);
  }
});

test('an exact address beats a conflicting subject line', () => {
  // The point of stage 0: the address is a fact, the keywords are a guess.
  const r = classify({
    from: '<psd@pilani.bits-pilani.ac.in>',
    subject: 'Hackathon registration and prize money',
    snippet: 'competition contest register',
  });
  assert.equal(r.category, 'ps');
  assert.equal(r.source, 'address');
});

test('address lookup is case-insensitive and tolerates display names', () => {
  for (const from of [
    'PSD@PILANI.BITS-PILANI.AC.IN',
    'Practice School <PSD@Pilani.BITS-Pilani.ac.in>',
    '<psd@pilani.bits-pilani.ac.in>',
  ]) {
    assert.equal(classify({ from, subject: 'x' }).category, 'ps', from);
  }
});

test('every address in the map is lowercase and well-formed', () => {
  for (const [addr, cat] of ADDRESS_MAP) {
    assert.equal(addr, addr.toLowerCase(), addr);
    assert.ok(addr.includes('@'), addr);
    assert.ok(CATEGORIES.includes(cat), `${addr} -> unknown category ${cat}`);
  }
});

test('the address map cannot be poisoned by prototype keys', () => {
  // The address is attacker-controlled. A Map has no prototype chain to walk,
  // which is why this is a Map and not an object literal.
  for (const evil of ['__proto__', 'constructor', 'toString']) {
    assert.equal(classify({ from: `<${evil}>`, subject: 'x' }).source !== 'address', true);
  }
});

/* ========================================================================== *
 * SCORING BOUNDARIES
 *
 * The confidence ladder is a CALIBRATED lookup, not a formula — its comment
 * says so explicitly. That makes every threshold a decision, and a `>=` that
 * drifts to `>` silently reclassifies messages at the edge.
 *
 * Mutation testing found six survivors here: the existing tests checked
 * values exactly AT each boundary, which cannot distinguish `>=` from `>`.
 * These check just below and just above as well.
 * ========================================================================== */

test('every confidence threshold is inclusive at its lower edge', () => {
  for (const [raw, expected] of [[5, 0.4], [25, 0.55], [45, 0.7], [65, 0.82],
    [90, 0.9], [120, 0.95], [150, 0.98]]) {
    assert.equal(normalizeConfidence(raw), expected, `at the ${raw} boundary`);
    assert.notEqual(
      normalizeConfidence(raw - 1), expected,
      `${raw - 1} must fall into the band BELOW ${raw}; >= drifted to >`
    );
  }
});

test('a zero or negative score is the floor, not a computed value', () => {
  // `rawScore <= 0` -> `< 0` would send exactly 0 into the interpolation
  // branch, which returns 0.3 anyway — but only by coincidence. Negative
  // scores would produce a confidence below the floor.
  assert.equal(normalizeConfidence(0), 0.3);
  assert.equal(normalizeConfidence(-1), 0.3);
  assert.equal(normalizeConfidence(-1000), 0.3);
});

test('scores between 0 and 5 interpolate, never exceeding the first band', () => {
  for (const raw of [1, 2, 3, 4]) {
    const c = normalizeConfidence(raw);
    assert.ok(c > 0.3 && c < 0.4, `${raw} produced ${c}, outside the interpolation band`);
  }
  assert.ok(normalizeConfidence(4) > normalizeConfidence(1), 'must increase monotonically');
});

test('confidence never decreases as the score rises', () => {
  // A property, not an example: the ladder must be monotonic or a
  // better-matching message could report lower confidence.
  let previous = -1;
  for (let raw = -5; raw <= 200; raw++) {
    const c = normalizeConfidence(raw);
    assert.ok(c >= previous, `confidence dropped at rawScore ${raw}: ${c} < ${previous}`);
    assert.ok(c >= 0.3 && c <= 0.98, `confidence ${c} out of range at ${raw}`);
    previous = c;
  }
});

test('a conflict is broken by a sender match, in either direction', () => {
  const mk = (category, score, hasSenderMatch) => ({ category, score, hasSenderMatch });

  // Scores close enough to conflict (ratio >= 0.9).
  assert.equal(
    resolveConflict([mk('augsd', 100, true), mk('clubs', 95, false)]).category, 'augsd',
    'the sender match should win'
  );
  assert.equal(
    resolveConflict([mk('clubs', 100, false), mk('augsd', 95, true)]).category, 'augsd',
    'the runner-up wins when only IT has a sender match'
  );
  // Both or neither: the higher score stands.
  assert.equal(resolveConflict([mk('a', 100, true), mk('b', 95, true)]).category, 'a');
  assert.equal(resolveConflict([mk('a', 100, false), mk('b', 95, false)]).category, 'a');
});

test('a clear winner is never overridden by a sender match', () => {
  // Below the overlap ratio there is no conflict to resolve, so a weak
  // sender-matched runner-up must not hijack a decisive score.
  const mk = (category, score, hasSenderMatch) => ({ category, score, hasSenderMatch });
  assert.equal(
    resolveConflict([mk('augsd', 100, false), mk('clubs', 10, true)]).category, 'augsd',
    'a 0.1 ratio is not a conflict'
  );
});

test('conflict resolution handles degenerate input', () => {
  const mk = (category, score, hasSenderMatch) => ({ category, score, hasSenderMatch });
  assert.equal(resolveConflict([mk('only', 50, false)]).category, 'only', 'single candidate');
  assert.equal(
    resolveConflict([mk('a', 50, false), mk('b', 0, true)]).category, 'a',
    'a zero-scoring runner-up is not a conflict, even with a sender match'
  );
  assert.equal(
    resolveConflict([mk('a', 50, false), mk('b', -5, true)]).category, 'a',
    'a negative runner-up is not a conflict'
  );
});

test('the overlap ratio is inclusive at exactly 0.9', () => {
  /*
   * `ratio >= CONFLICT_OVERLAP_RATIO` -> `>` survived mutation testing. It is
   * reachable: 90 against 100 is exactly 0.9, and scores are small integers,
   * so landing precisely on the boundary is common rather than exotic.
   *
   * The other four survivors in this function are EQUIVALENT mutants —
   * verified by hand, not assumed:
   *   - `rawScore >= 5`  vs `>`: at 5 the fallthrough computes 0.3+(5/5)*0.1 = 0.4.
   *   - `rawScore <= 0`  vs `<`: at 0 the fallthrough computes 0.3+(0/5)*0.1 = 0.3.
   *   - `runnerUp.score <= 0` vs `<`: at 0 the ratio is 0, below the overlap
   *     threshold, so the same `best` is returned by a longer route.
   *   - `&&` vs `||` on the first sender-match line: identical for all four
   *     combinations of the two booleans.
   * Chasing those would mean writing tests that cannot fail.
   */
  const mk = (category, score, hasSenderMatch) => ({ category, score, hasSenderMatch });
  assert.equal(
    resolveConflict([mk('clubs', 100, false), mk('augsd', 90, true)]).category,
    'augsd',
    'a ratio of exactly 0.9 must count as a conflict and let the sender match decide'
  );
  // Just below the boundary is NOT a conflict.
  assert.equal(
    resolveConflict([mk('clubs', 100, false), mk('augsd', 89, true)]).category,
    'clubs',
    '0.89 is below the overlap threshold; the higher score stands'
  );
});
