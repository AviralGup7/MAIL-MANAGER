/**
 * Selectors — derived state, pure and unit-testable (audit 39/40 ARCH R-6).
 *
 * The shell's render paths (list, counts, bulk, j/k) all read from ONE choke
 * point: "what should the list show right now". That logic lived inline in
 * app.js, where it could only be exercised by booting the whole app — which
 * is how a slightly-different predicate gets inlined into a new view and
 * silently diverges. Moved here as pure functions of (store, ctx) with every
 * impure dependency injected:
 *
 *   ctx.mailbox / ctx.category / ctx.query   live UI state (the shell reads
 *                                            them at call time, so a mutation
 *                                            between renders is impossible)
 *   ctx.threaded                              the setting (settings.get)
 *   ctx.muted                                 the muted-category list
 *   ctx.parse(q)                              query parsing, injected because
 *                                            it needs deadline overrides and
 *                                            a clock (parseQuery)
 *   ctx.overlay                               the server-search ephemeral
 *                                            overlay, injected because it is
 *                                            module state in server-search.js
 *
 * Nothing in this file touches the DOM, chrome.*, storage or Date.now.
 */

/**
 * How many messages the current mute rules are hiding right now.
 *
 * Mutes hide ONLY from the All-mail view of the inbox, and never while a
 * search is active: a mute that made mail unfindable would be worse than the
 * noise it removes.
 */
export function mutedHiddenCount(store, { mailbox, category, query, muted }) {
  if (!muted?.length || mailbox !== 'inbox') return 0;
  if (category !== 'all' || query) return 0;
  const all = store.idsFor('all');
  return all.length - applyMute(all, store, { mailbox, category, query, muted }).length;
}

/** Filter ids whose category is muted — under the same guards as above. */
export function applyMute(ids, store, { mailbox, category, query, muted }) {
  if (!muted?.length) return ids;
  if (mailbox !== 'inbox') return ids;
  if (category !== 'all') return ids; // they asked for it by name
  // Defensive: visibleIds routes a query down a branch that never calls this;
  // kept because a mute leaking into search would make mail unfindable.
  if (query) return ids;
  const hidden = new Set(muted);
  return ids.filter((id) => {
    const m = store.get(id);
    return m && !hidden.has(m.category);
  });
}

/** Collapse a conversation to its root row, when threading is on. */
export function collapseThreads(ids, store, { threaded }) {
  if (!threaded) return ids;
  return store.rootIds(ids);
}

/**
 * The ids the list should currently show — the single choke point.
 *
 * THREADING IS APPLIED HERE AND ONLY HERE. Every render path (list, counts,
 * bulk, j/k) reads from this function, so conversations collapse once for all
 * of them. Search is deliberately NOT collapsed: a search targets a MESSAGE,
 * and hiding the match behind its thread's newest reply is exactly the wrong
 * answer.
 */
export function visibleIds(store, ctx) {
  const { mailbox, category, query, threaded, muted, parse, overlay } = ctx;
  if (!query) {
    const muted = applyMute(store.idsFor(category), store, ctx);
    return collapseThreads(muted, store, { threaded });
  }

  // Operators are a PREDICATE over what the index returns, not a scan of
  // every message: the index does the fast token lookup, the parser narrows.
  const parsed = parse(query);
  const base = parsed.terms.length
    ? store.search(parsed.terms.join(' '), category)
    : store.idsFor(category);

  const local = applyPredicate(base, store, parsed);
  // Server-search hits live OUTSIDE the store (V2 P0-4) and are merged here
  // under the same predicate/terms, only while querying.
  const seen = new Set(local);
  const out = [...local];
  for (const id of overlay.ids()) {
    if (seen.has(id)) continue;
    const m = overlay.get(id);
    if (m && matchesQuery(m, parsed)) out.push(id);
  }
  return out;
}

/** Narrow a base id list with the parsed query's predicate. */
export function applyPredicate(base, store, parsed) {
  if (!parsed.predicate) return base;
  const out = [];
  for (const id of base) {
    const m = store.get(id);
    if (m && parsed.predicate(m)) out.push(id);
  }
  return out;
}

/** Same term semantics as the Store index: subject + from + snippet. */
export function matchesQuery(m, parsed) {
  if (parsed.predicate && !parsed.predicate(m)) return false;
  if (!parsed.terms.length) return true;
  const hay = `${m.subject || ''} ${m.from || ''} ${m.snippet || ''}`.toLowerCase();
  return parsed.terms.every((t) => hay.includes(String(t).toLowerCase()));
}
