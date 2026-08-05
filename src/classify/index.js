/**
 * The classifier.
 *
 * Two stages, matching the old architecture because it was sound:
 *   1. sender rules — if the sender is known, we are done
 *   2. weighted keyword scoring across sender / subject / snippet
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
import { classifyBySender, detectBitsSource } from './sender.js';
import { PATTERN_RULES } from './pattern-rules.js';
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
 * @property {'sender'|'pattern'|'fallback'} source
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
  const from = msg.from || '';
  const subject = (msg.subject || '').toLowerCase();
  const snippet = (msg.snippet || '').toLowerCase();
  const fromLower = from.toLowerCase();

  const { isBits } = detectBitsSource(from);

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
    if (rule.senderExact) {
      for (const e of rule.senderExact) {
        if (fromLower === e) {
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
