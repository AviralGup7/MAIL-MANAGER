/**
 * Pure display mappings shared by the list and the reader.
 *
 * RESPONSIBILITY  Turn raw message/category data into what a surface SHOWS:
 *                 a sender name, a compact or full date, a category colour,
 *                 the confidence threshold at which a guess must say so.
 * OWNS            nothing mutable. Every export is a pure function or a
 *                 frozen-by-use constant; there is no state to reset.
 * DOES NOT OWN    the Gmail deep link (it depends on the shell's account
 *                 index and stays in app.js), any DOM, any store access.
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
 * owns utilities" slot. Keeping them in app.js would have made reader.js
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
  const lt = from.indexOf('<');
  if (lt > 0) return from.slice(0, lt).trim().replace(/^"|"$/g, '') || from;
  return from.replace(/[<>]/g, '');
}

const DAY = 86400000;
export function shortDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = Date.now();
  /*
   * POLISH 13: under an hour, "14:52" makes the eye do subtraction the
   * interface already did. "12m" is the recency a triaging brain wants;
   * the same-day clock returns after an hour, when wall time matters more.
   */
  if (now - ms < 3600000) {
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
  if (!ms) return '';
  return new Date(ms).toLocaleString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
