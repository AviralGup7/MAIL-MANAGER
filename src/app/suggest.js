/**
 * Search suggestions.  (Feature 43, absorbing 44 and 47.)
 *
 * WHY THIS OUTRANKED A HELP SHEET
 * -------------------------------
 * The query language is the best hidden asset in the product -- twenty-odd
 * operators, negation, OR groups -- and it is completely undiscoverable.
 * Nobody types `deadline:overdue` unless something tells them it exists.
 *
 * The discovery pass proposed a `?`-reachable reference panel as well. The
 * elimination pass cut it, because a suggestion list teaches the SAME thing at
 * the moment of use, which is strictly better than a reference someone has to
 * decide to go and read. Query history was folded in for the same reason: it
 * is the first section of this list when the field is empty, not a feature.
 *
 * THE RANKING RULE
 *
 * Suggestions are ordered by how likely they are to be what the user meant,
 * not alphabetically and not by category:
 *
 *   1. exact operator prefix     `is:un` -> is:unread
 *   2. recent queries            what they actually search for
 *   3. saved views               what they told us matters
 *   4. concrete values           senders, labels, categories they have
 *   5. operator vocabulary       the rest of the language
 *
 * Concrete values outrank vocabulary because `from:vin` should offer the
 * instructor's actual address before it offers a lecture on syntax.
 *
 * EVERY SUGGESTION IS EXECUTABLE. There is no "did you mean" that produces a
 * query returning nothing -- value suggestions are drawn from data that is
 * actually in the store, so accepting one always shows something.
 */

const HISTORY_KEY = 'queryHistory';

/** How many past queries to keep. */
export const MAX_HISTORY = 40;

/**
 * The operator vocabulary, with a plain-English gloss.
 *
 * THIS IS THE ONLY DEFINITION. `tools/` has a check that every key here exists
 * in `query.js`'s parser and vice versa, so the teaching surface and the
 * implementation cannot drift -- which is the failure mode that made the
 * separate help sheet a bad idea in the first place.
 */
export const OPERATORS = [
  { op: 'from:', hint: 'sender contains', example: 'from:augsd' },
  { op: 'to:', hint: 'addressed to', example: 'to:me' },
  { op: 'subject:', hint: 'subject only', example: 'subject:registration' },
  { op: 'category:', hint: 'a BITS category', example: 'category:academics' },
  { op: 'label:', hint: 'a Gmail label', example: 'label:Thesis' },
  { op: 'is:unread', hint: 'not read yet' },
  { op: 'is:read', hint: 'already read' },
  { op: 'is:starred', hint: 'starred' },
  { op: 'is:direct', hint: 'written to you, not to a list' },
  { op: 'is:broadcast', hint: 'sent to an audience' },
  { op: 'is:due', hint: 'has a deadline' },
  { op: 'is:overdue', hint: 'deadline has passed' },
  { op: 'is:important', hint: 'high classifier confidence' },
  { op: 'has:attachment', hint: 'carries a file' },
  { op: 'has:deadline', hint: 'a date was detected' },
  { op: 'before:', hint: 'before a date', example: 'before:2026-01-31' },
  { op: 'after:', hint: 'after a date', example: 'after:2026-01-01' },
  { op: 'older_than:', hint: 'older than a span', example: 'older_than:7d' },
  { op: 'newer_than:', hint: 'newer than a span', example: 'newer_than:2d' },
  { op: '-', hint: 'exclude — put it before any term', example: '-from:noreply' },
  { op: 'OR', hint: 'either side', example: 'category:clubs OR category:events' },
];

/* -------------------------------------------------------------- history -- */

export function normaliseHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const h of raw) {
    const q = typeof h === 'string' ? h : h?.q;
    if (typeof q !== 'string' || !q.trim()) continue;
    const key = q.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ q: q.trim(), at: Number.isFinite(h?.at) ? h.at : 0 });
    if (out.length >= MAX_HISTORY) break;
  }
  return out;
}

export async function loadHistory(storage = chrome.storage?.local) {
  try {
    return normaliseHistory((await storage.get(HISTORY_KEY))?.[HISTORY_KEY]);
  } catch {
    return [];
  }
}

/**
 * Record a query that was actually run.
 *
 * TRIVIAL QUERIES ARE NOT RECORDED. A history full of `a`, `ab`, `abc` -- the
 * prefixes of one real search -- is a history nobody scrolls. Anything under
 * four characters, and anything that is a strict prefix of the previous entry,
 * is dropped.
 */
export function addToHistory(history, query, now = Date.now()) {
  const q = String(query || '').trim();
  if (q.length < 4) return history;
  const lower = q.toLowerCase();

  /*
   * DROP ANY ENTRY THAT IS A PREFIX OF THIS ONE.
   *
   * Searching for "registration" writes regi, regis, registr, registration --
   * six prefixes of one search, and a history nobody scrolls. Each keystroke
   * that extends the previous entry REPLACES it.
   *
   * The first attempt at this was a tangle of three conditions that did not
   * work and was caught by the test rather than by reading it. This version is
   * one filter and one rule: keep an entry only if the new query is not an
   * extension of it.
   */
  const kept = history.filter((h) => {
    const hl = h.q.toLowerCase();
    if (hl === lower) return false;          // exact repeat: move to the top
    if (lower.startsWith(hl)) return false;  // this extends it: replace it
    return true;
  });

  return [{ q, at: now }, ...kept].slice(0, MAX_HISTORY);
}

export async function saveHistory(history, storage = chrome.storage?.local) {
  try {
    await storage.set({ [HISTORY_KEY]: normaliseHistory(history) });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ suggesting -- */

/** Split off the token the caret is in; everything before it is kept intact. */
export function currentToken(text, caret = null) {
  const s = String(text || '');
  const pos = caret === null ? s.length : Math.max(0, Math.min(caret, s.length));
  const before = s.slice(0, pos);
  const start = before.lastIndexOf(' ') + 1;
  return { prefix: s.slice(0, start), token: before.slice(start), rest: s.slice(pos) };
}

/**
 * Build the suggestion list.
 *
 * @param {string} text        the whole query box contents
 * @param {object} ctx
 * @param {Array} [ctx.history]
 * @param {Array} [ctx.views]        saved views
 * @param {string[]} [ctx.senders]   addresses present in the store
 * @param {string[]} [ctx.labels]
 * @param {Array<{key:string,label:string}>} [ctx.categories]
 * @param {number} [ctx.limit]
 * @returns {Array<{type:string, value:string, label:string, hint?:string}>}
 */
export function suggest(text, ctx = {}) {
  const { history = [], views = [], senders = [], labels = [], categories = [], limit = 8 } = ctx;
  const { prefix, token } = currentToken(text);
  const lower = token.toLowerCase();
  const out = [];
  const push = (s) => {
    if (out.length < limit && !out.some((x) => x.value === s.value)) out.push(s);
  };

  /*
   * EMPTY BOX: show what they have done and what they saved. This is where
   * query history earns its place -- it is the answer to "I searched for this
   * yesterday", which is the most common reason the box is focused at all.
   */
  if (!token && !text.trim()) {
    for (const h of history.slice(0, 4)) {
      push({ type: 'history', value: h.q, label: h.q, hint: 'recent' });
    }
    for (const v of views.slice(0, 3)) {
      push({ type: 'view', value: v.query, label: v.name, hint: v.query });
    }
    for (const o of OPERATORS.slice(0, limit)) {
      push({ type: 'operator', value: prefix + o.op, label: o.op, hint: o.hint });
    }
    return out;
  }

  // A value is being typed after an operator: `from:vin`, `category:aca`.
  const colon = token.indexOf(':');
  if (colon > 0) {
    const key = token.slice(0, colon).toLowerCase();
    const partial = token.slice(colon + 1).toLowerCase();

    const values =
      key === 'from' || key === 'to' ? senders
        : key === 'label' ? labels
        : key === 'category' ? categories.map((c) => c.key)
        : [];

    for (const v of values) {
      if (!String(v).toLowerCase().includes(partial)) continue;
      push({ type: 'value', value: `${prefix}${key}:${v}`, label: `${key}:${v}`, hint: 'in your mail' });
    }

    // `is:` and `has:` have a fixed vocabulary rather than data-driven values.
    for (const o of OPERATORS) {
      if (!o.op.startsWith(`${key}:`)) continue;
      if (!o.op.toLowerCase().includes(partial)) continue;
      push({ type: 'operator', value: prefix + o.op, label: o.op, hint: o.hint });
    }
    return out;
  }

  // A bare word: match history, views, then the operator vocabulary.
  for (const h of history) {
    if (h.q.toLowerCase().includes(lower) && h.q.toLowerCase() !== lower) {
      push({ type: 'history', value: h.q, label: h.q, hint: 'recent' });
    }
  }
  for (const v of views) {
    if (v.name.toLowerCase().includes(lower)) {
      push({ type: 'view', value: v.query, label: v.name, hint: v.query });
    }
  }
  for (const o of OPERATORS) {
    if (o.op.toLowerCase().startsWith(lower)) {
      push({ type: 'operator', value: prefix + o.op, label: o.op, hint: o.hint });
    }
  }
  for (const s of senders) {
    if (String(s).toLowerCase().includes(lower)) {
      push({ type: 'value', value: `${prefix}from:${s}`, label: `from:${s}`, hint: 'sender' });
    }
  }
  return out;
}

/**
 * Does accepting this suggestion finish the query, or is more typing expected?
 *
 * `is:unread` is complete. `from:` is not -- the caret should stay put and the
 * list should re-run against the new prefix. Getting this wrong makes the
 * control feel broken in a way users cannot articulate.
 */
export function isComplete(suggestion) {
  return !String(suggestion?.value || '').endsWith(':') && suggestion?.value !== '-';
}
