/**
 * Stage 2: weighted keyword scoring.
 *
 * All constants CARRIED OVER VERBATIM from the old
 * `lib/pattern-classifier/scoring-engine.js`. They were clearly tuned against
 * real mail and I have no better numbers, so they are reproduced exactly.
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
