/**
 * Pure display mappings shared by the list and the reader.
 *
 * RESPONSIBILITY  Turn raw message/category data into what a surface SHOWS:
 *                 a sender name, a compact or full date, a category colour,
 *                 the confidence threshold at which a guess must say so.
 * OWNS            nothing mutable. Every export is a pure function or a
 *                 frozen-by-use constant; there is no state to reset.
 * DOES NOT OWN    the Gmail deep link (it depends on the shell's account
 *                 index and stays in main.js), any DOM, any store access.
 * DEPENDS ON      nothing. Deliberately import-free: both the shell and
 *                 reader.js need these, so this module must never grow an
 *                 edge back into either of them.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The reader extraction (round 51, workspace architecture map) needed these
 * six bindings and the alternative was injecting them one by one through
 * ctx. They are not the shell's contract with a tenant -- they are shared
 * primitives with zero dependencies, which is exactly the "shared layer
 * owns utilities" slot. Keeping them in main.js would have made reader.js
 * depend on the shell for pure functions, the wrong direction for a leaf.
 */

/** Stable colours per category. Derived once, never recomputed. */
export const CAT_COLOR = {
  augsd: '#e2504a',
  academics: '#2f7bd6',
  admin: '#8b6ad6',
  administration: '#6b7bd6',
  ps: '#1e9e6a',
  internship: '#0f9b8e',
  competitions: '#e08a1e',
  clubs: '#d64a9c',
  events: '#c04ad6',
  library: '#8a7b52',
  technology: '#4a86d6',
  'external-services': '#7a8493',
  'external-promotions': '#98a0ad',
  spam: '#b0313a',
  other: '#98a0ad',
};

/** Confidence under this shows a dashed tag: "we guessed". */
export const LOW_CONFIDENCE = 0.7;

export function displayName(from) {
  // "Aviral Gupta <f2024@pilani...>" -> "Aviral Gupta"
  /*
   * TOTALITY (fuzz campaign round 3, defect, 2026-08-14). The corpus is not
   * guaranteed string-shaped beyond the cache's id/date row guards: a damaged
   * or legacy msgCache row can hydrate a numeric `from` straight into the
   * store, and fillRow calls this function per row on every render. The old
   * bare `from.indexOf` was a TypeError, and because renderList is one plain
   * loop, ONE such record aborted the paint of the entire inbox -- the same
   * abortion class as the classifyAll totality fix, one surface deeper.
   * Stray types flatten to text; a missing sender renders as an empty name.
   */
  const s = String(from ?? '');
  const lt = s.indexOf('<');
  if (lt > 0) return s.slice(0, lt).trim().replace(/^"|"$/g, '') || s;
  return s.replace(/[<>]/g, '');
}

const DAY = 86400000;
export function shortDate(ms) {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const now = Date.now();
  /*
   * POLISH 13: under an hour, "14:52" makes the eye do subtraction the
   * interface already did. "12m" is the recency a triaging brain wants;
   * the same-day clock returns after an hour, when wall time matters more.
   *
   * TWO GUARDS, ONE LAW (fuzz campaign round 3, 2026-08-14): a row's date is
   * corpus data, and corpus data is corruptible, so this label must never be
   * a LIE. `!Number.isFinite` refuses NaN/Infinity/garbage one level up
   * (before, `Infinity` hit the sub-hour branch and rendered "1m" -- the
   * single most recency-asserting string the slot has -- for a stamp that is
   * meaninglessly huge). `ms <= now` refuses the FUTURE the same way: a
   * skewed or damaged record two hours ahead used to hit the same branch
   * and claim "1m"; now it falls through to the calendar labels, which are
   * truthful no matter how far out the date is. Slightly-future stamps still
   * land in the same-day clock branch below, which reads honestly ("7:41
   * PM") because it never claims recency.
   */
  if (ms <= now && now - ms < 3600000) {
    return `${Math.max(1, Math.floor((now - ms) / 60000))}m`;
  }
  if (now - ms < DAY && d.getDate() === new Date(now).getDate()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (now - ms < 300 * DAY) {
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  return d.toLocaleDateString([], { year: 'numeric', month: 'short' });
}

export function fullDate(ms) {
  // Same law as shortDate (fuzz round 3): non-finite renders the literal
  // string "Invalid Date" in the reader's header, which reads as a crash
  // rather than a missing stamp. An absent stamp renders as nothing.
  if (!ms || !Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
