/**
 * Stage 2: weighted keyword scoring.
 *
 * ============================================================================
 * PROVENANCE OF EVERY CONSTANT IN THIS FILE — READ BEFORE CHANGING ONE
 * ============================================================================
 *
 * These are **inherited, not measured** (under-engineering audit P6). Every
 * number below was copied verbatim from v1's
 * `lib/pattern-classifier/scoring-engine.js`. The original note said they
 * "were clearly tuned against real mail and I have no better numbers", and
 * that is still the whole basis: nobody in v2 has re-derived them against a
 * labelled corpus.
 *
 * WHY THAT MATTERS. This subsystem decides which category every message lands
 * in — the product's central claim — and it is the thinnest-documented
 * subsystem in a codebase whose defining habit is explaining itself (measured
 * comment density 0.20 against a tree median of ~0.73). "Carried over
 * verbatim" reads like a decision; it is actually an absence of one.
 *
 * WHAT IS AND IS NOT VERIFIED:
 *   - VERIFIED: the scoring ALGORITHM. `test/classify.test.mjs`,
 *     `test/fuzz-classify.test.mjs` and `test/eval-classifier.test.mjs` pin
 *     determinism, idempotence, totality over malformed input, and precedence
 *     (address > sender > pattern > fallback).
 *   - NOT VERIFIED: that these particular WEIGHTS are the right weights.
 *     `tools/eval-classifier.mjs` can measure accuracy against a labelled set;
 *     no such set is committed, so no accuracy figure exists for them.
 *
 * HOW TO CHANGE ONE HONESTLY: build a labelled corpus, run
 * `npm run -s eval-classifier` before and after, and record both numbers in
 * the commit. Changing a weight because a single message filed wrongly is how
 * a tuned system becomes an untuned one.
 *
 * Stage 0 (exact address) and stage 1 (sender substring) are FACTS and
 * outrank all of this, which is why an inherited weight has never yet caused
 * a visible misfiling: the decisive paths do not reach here.
 */

/** Which field a keyword hit was in, and how much that is worth. */
export const FIELD_WEIGHTS = {
  sender: 1.5,
  subject: 1.2,
  snippet: 1.0,
};

export const SENDER_EXACT_BONUS = 80;
export const SENDER_CONTAINS_BONUS = 55;
export const SENDER_PENALTY = 30;

/**
 * The 2nd, 3rd, ... keyword hit in the same field is worth progressively less.
 * Without this, a mail that says "exam" six times outscores a mail that says
 * "exam" once and "timetable" once — but the second is the better signal.
 *
 * DELIBERATELY PER-FIELD, NOT GLOBAL (audit 40-BUSINESS M-01): the same word
 * in subject AND snippet is two genuine observations (two places the sender
 * chose to say it), so it keeps full weight across fields; diminishing only
 * applies to repetition WITHIN one field, where it is noise. The snippet
 * weight (1.0) is already the floor, so a newsletter footer cannot outvote a
 * subject hit of the same keyword. Accepted as designed; documented, not
 * re-tuned, because these constants were calibrated against real mail.
 */
export const DIMINISHING_RETURNS_FACTOR = 0.6;

/** Two categories within this ratio of each other count as a tie. */
export const CONFLICT_OVERLAP_RATIO = 0.9;

/**
 * Map a raw score onto a 0..1 confidence.
 *
 * A step ladder rather than a curve, carried over exactly. It is not
 * principled — it is calibrated — and inventing a smooth function here would
 * silently change every threshold decision in the app.
 *
 * KNOWN CLIFF (audit 40-BUSINESS M-02): 89 -> 0.82, 90 -> 0.9, and
 * `is:important` gates on confidence >= 0.9 — so one raw point flips the
 * badge. Accepted: the ladder was tuned against real mail, and smoothing it
 * would retune every threshold in the app at once. If the cliff ever shows
 * up in user complaints, the documented alternative is
 * `1 - exp(-rawScore / 60)` with the same anchors.
 */
export function normalizeConfidence(rawScore) {
  if (rawScore <= 0) return 0.3;
  if (rawScore >= 150) return 0.98;
  if (rawScore >= 120) return 0.95;
  if (rawScore >= 90) return 0.9;
  if (rawScore >= 65) return 0.82;
  if (rawScore >= 45) return 0.7;
  if (rawScore >= 25) return 0.55;
  if (rawScore >= 5) return 0.4;
  return 0.3 + (rawScore / 5) * 0.1;
}

/**
 * Score one field against a weight map.
 *
 * @param {string} haystack  already lowercased
 * @param {Record<string,number>} weights  keyword -> points
 * @param {number} fieldWeight
 * @returns {{score:number, hits:string[]}}
 */
export function scoreField(haystack, weights, fieldWeight) {
  if (!haystack || !weights) return { score: 0, hits: [] };
  let score = 0;
  let matchIndex = 0;
  const hits = [];

  for (const kw in weights) {
    if (!haystack.includes(kw)) continue;
    // Diminishing returns compound per additional hit in this field.
    const falloff = Math.pow(DIMINISHING_RETURNS_FACTOR, matchIndex);
    score += weights[kw] * fieldWeight * falloff;
    hits.push(kw);
    matchIndex++;
  }

  return { score, hits };
}

/**
 * Resolve a near-tie between the top two categories.
 *
 * Carried over verbatim. When two categories score within 10% of each other,
 * the one with a sender-level match wins — sender is a much stronger signal
 * than a keyword appearing in a snippet.
 */
export function resolveConflict(scored) {
  const best = scored[0];
  if (scored.length < 2) return best;
  const runnerUp = scored[1];
  if (runnerUp.score <= 0) return best;

  const ratio = runnerUp.score / best.score;
  if (ratio >= CONFLICT_OVERLAP_RATIO) {
    if (best.hasSenderMatch && !runnerUp.hasSenderMatch) return best;
    if (!best.hasSenderMatch && runnerUp.hasSenderMatch) return runnerUp;
  }
  return best;
}
