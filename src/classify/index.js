/**
 * The classifier.
 *
 * Three stages. Stages 1 and 2 match the old architecture because it was sound:
 *   0. exact address map — 152 curated BITS addresses, O(1), decisive
 *   1. sender substring rules — if the sender is recognised, we are done
 *   2. weighted keyword scoring across sender / subject / snippet
 *
 * Stage 0 is new. The old repo shipped `email-mappings/*.json` with 152
 * hand-curated address→category pairs and never loaded them (the data pack
 * confirms: "not loaded by the classifier code at runtime"). An exact address
 * is a fact, not a heuristic, so it outranks every substring rule.
 *
 * WHAT CHANGED, and why it matters for speed:
 *
 * The old version made this `async`. Nothing in it awaits anything — it is pure
 * string matching over data already in memory — but because it returned a
 * Promise, every message cost a microtask, and the caller was forced into
 * `processWithConcurrency` with a semaphore to run something that never
 * blocks. Classification here is **synchronous**. 200 messages classify in a
 * single tick with no scheduling overhead at all.
 *
 * There is no I/O in this file, no storage access, no DOM. That is what makes
 * it testable on bare Node and impossible to make slow by accident.
 */

import { FALLBACK_CATEGORY } from './categories.js';
import { classifyBySender, detectBitsSource, extractAddress } from './sender.js';
import { lookupAddress } from './address-map.js';
import { PATTERN_RULES } from './pattern-rules.js';

/*
 * LOCAL course-code detector (round 50). Deliberately NOT imported from
 * timetable-mail.js: that module (via timetable.js) references `document`,
 * and importing it here would pull DOM code into the service-worker graph,
 * which the load-time doctor correctly rejects. The worker needs only the
 * code-shape test, duplicated minimally and kept in sync by a pin.
 */
// `i` because classify() lowercases the subject before this runs; real course
// codes are uppercase but the detector must see the lowercased form too.
// The letter is MANDATORY and sits directly against the digits ("f311"), so
// "day 123" can't false-positive while "che f311"/"chef311" both match.
const COURSE_CODE = /\b([a-z]{2,5})\s?([a-z])(\d{3})\b/i;
const hasCourseCode = (s) => COURSE_CODE.test(String(s || ''));
import {
  FIELD_WEIGHTS,
  SENDER_EXACT_BONUS,
  SENDER_CONTAINS_BONUS,
  normalizeConfidence,
  scoreField,
  resolveConflict,
} from './scoring.js';

/**
 * @typedef {Object} Classification
 * @property {string}  category
 * @property {number}  confidence   0..1
 * @property {'address'|'sender'|'pattern'|'fallback'} source
 * @property {string}  reason       human-readable, shown in the UI
 * @property {string[]} hits        keywords that fired
 */

/**
 * Classify one message. Synchronous and pure.
 *
 * @param {{from?:string, subject?:string, snippet?:string}} msg
 * @returns {Classification}
 */
export function classify(msg) {
  /*
   * TOTALITY (fuzz catch 2026-08-14, defect #1 of the sweep). `msg.from || ''`
   * tolerates a MISSING field but not a mistyped one: a numeric `from` from a
   * damaged cache threw `from.toLowerCase is not a function`, and because
   * classifyAll is a plain loop, ONE poisoned record aborted classification
   * for the entire inbox. A classifier is only trustworthy if it is total:
   * stray types coerce to text, and a missing message gets the floor verdict
   * with zero confidence rather than an exception.
   */
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return {
      category: FALLBACK_CATEGORY,
      confidence: 0,
      source: 'fallback',
      reason: 'Nothing to read',
      hits: [],
    };
  }
  const from = String(msg.from ?? '');
  const subject = String(msg.subject ?? '').toLowerCase();
  const snippet = String(msg.snippet ?? '').toLowerCase();
  const fromLower = from.toLowerCase();

  const { isBits } = detectBitsSource(from);

  // ---- Stage 0: exact address --------------------------------------------
  // Decisive and O(1). No ambiguity to resolve, so nothing downstream runs.
  const address = extractAddress(from);
  const exact = lookupAddress(address);
  if (exact) {
    return {
      category: exact,
      confidence: 0.98,
      source: 'address',
      reason: `Known address ${address}`,
      hits: [address],
    };
  }

  // ---- Stage 1: sender ---------------------------------------------------
  const senderHit = classifyBySender(from, isBits);
  if (senderHit) {
    return {
      category: senderHit.category,
      confidence: senderHit.confidence,
      source: 'sender',
      reason: `Sender matches "${senderHit.matchedPattern}"`,
      hits: [senderHit.matchedPattern],
    };
  }

  // ---- Stage 2: weighted keywords ---------------------------------------
  const scored = [];

  for (const rule of PATTERN_RULES) {
    // A BITS-internal message is never external promotions or an external
    // service. Without this the "unsubscribe" in a club mail footer wins.
    if (
      isBits &&
      (rule.category === 'external-promotions' ||
        rule.category === 'external-services')
    ) {
      continue;
    }

    let score = 0;
    let hasSenderMatch = false;
    const hits = [];

    // Sender-level keyword hits are worth a large flat bonus, not a weight.
    //
    // NOTE ON `senderExact`: despite the name it is a SUBSTRING test, not an
    // equality test. Data pack section 8 is explicit:
    //   "If rule.senderExact && email includes any exact -> score += 80 * 1.5"
    // and the entries confirm it -- `['placement unit', 'training and
    // placement', 'tpo', 'placement office']` are display-name fragments that
    // could never equal a whole From header.
    //
    // This file previously used `fromLower === e`, which made every
    // senderExact list unreachable: 4 in internship, 4 in spam, 29 in
    // technology, plus admin, augsd and ps. The entire `technology` category
    // is driven by that list, so technology mail scored zero and fell through
    // to whatever matched next.
    if (rule.senderExact) {
      for (const e of rule.senderExact) {
        if (fromLower.includes(e)) {
          score += SENDER_EXACT_BONUS * FIELD_WEIGHTS.sender;
          hasSenderMatch = true;
          hits.push(e);
          break;
        }
      }
    }
    if (!hasSenderMatch && rule.senderContains) {
      for (const c of rule.senderContains) {
        if (fromLower.includes(c)) {
          score += SENDER_CONTAINS_BONUS * FIELD_WEIGHTS.sender;
          hasSenderMatch = true;
          hits.push(c);
          break;
        }
      }
    }

    const sub = scoreField(subject, rule.subjectWeights, FIELD_WEIGHTS.subject);
    const sni = scoreField(snippet, rule.snippetWeights, FIELD_WEIGHTS.snippet);
    score += sub.score + sni.score;
    hits.push(...sub.hits, ...sni.hits);

    if (score > 0) {
      scored.push({ category: rule.category, score, hasSenderMatch, hits });
    }
  }

  /*
   * COURSE-CODE SIGNAL (round 50 rules audit). A subject that names a course
   * ("CHE F311", "KINETICS & REACTOR DESIGN (CHE F311) new content") is, by
   * definition, academic mail. Without this, such mail scored on stray
   * keywords and could land in clubs/events. A course code is the strongest
   * academics signal that exists, so it is added on top of the rule scores.
   */
  if (hasCourseCode(subject)) {
    scored.push({ category: 'academics', score: 90, hasSenderMatch: false, hits: ['course-code'] });
  }

  if (scored.length === 0) {
    return {
      category: FALLBACK_CATEGORY,
      confidence: 0.3,
      source: 'fallback',
      reason: isBits
        ? 'From BITS, but nothing specific matched'
        : 'Nothing matched',
      hits: [],
    };
  }

  scored.sort((a, b) => b.score - a.score);
  const winner = resolveConflict(scored);

  return {
    category: winner.category,
    confidence: normalizeConfidence(winner.score),
    source: 'pattern',
    reason: describe(winner, scored),
    hits: winner.hits,
  };
}

/**
 * Explain the decision in words.
 *
 * Shown in the UI behind a "why?" affordance. A classifier the user cannot
 * interrogate is one they stop trusting the first time it is wrong — and this
 * one WILL sometimes be wrong.
 */
function describe(winner, scored) {
  const top = winner.hits.slice(0, 3).join(', ');
  const runnerUp = scored.find((s) => s.category !== winner.category);
  let reason = top ? `Matched ${top}` : 'Matched keywords';
  if (runnerUp && runnerUp.score / winner.score >= 0.9) {
    reason += ` (close call with ${runnerUp.category})`;
  }
  return reason;
}

/**
 * Classify a batch.
 *
 * A plain loop on purpose. The old version routed this through a concurrency
 * semaphore, which is pure overhead for synchronous work.
 */
export function classifyAll(messages) {
  const out = new Array(messages.length);
  for (let i = 0; i < messages.length; i++) out[i] = classify(messages[i]);
  return out;
}

export { CATEGORIES, CATEGORY_LABELS, SIDEBAR_ORDER } from './categories.js';
