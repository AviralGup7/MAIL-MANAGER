/**
 * The message store.
 *
 * ============================================================================
 * THIS FILE IS WHERE THE OLD VERSION WAS SLOW
 * ============================================================================
 *
 * The audit's own verdict named it: every `EmailStore` mutation triggered
 * `renderEmailList` + `rebuildSearchIndex` + `silentRefresh`. Concretely, per
 * batch of synced mail the old code did:
 *
 *   upsertBatch()
 *     -> indexes.rebuild()      // CLEARS and re-indexes EVERY email
 *     -> notify()
 *          -> silentRefresh()   // full re-render + full search index rebuild
 *     -> schedulePersist()      // writes the ENTIRE email array to storage
 *
 * With 200 messages arriving in batches, that is dozens of full rebuilds and
 * dozens of whole-array storage writes inside a single sync.
 *
 * Three changes fix it, and they are the reason this file exists:
 *
 *   1. INCREMENTAL INDEXING. Adding a message touches only that message's
 *      index entries. There is no `rebuild()` in the hot path at all.
 *
 *   2. ONE NOTIFICATION PER SETTLED STATE. Mutations inside a `batch()` are
 *      coalesced into a single subscriber notification at the end. The UI
 *      renders once, not once per message.
 *
 *   3. DELTA PERSISTENCE. Only changed message IDs are written, and only after
 *      the batch settles.
 */

/** @typedef {{id:string, threadId:string, from:string, subject:string,
 *   snippet:string, date:number, unread:boolean, starred:boolean,
 *   category:string, confidence:number, reason:string}} Msg */

const MAX_MESSAGES = 2000;

export class Store {
  constructor() {
    /** @type {Map<string, Msg>} */
    this.byId = new Map();

    /** Sorted newest-first. Maintained by insertion, never re-sorted wholesale. */
    /** @type {string[]} */
    this.order = [];

    /** category -> Set<id>. Incrementally maintained. */
    /** @type {Map<string, Set<string>>} */
    this.byCategory = new Map();

    /** token -> Set<id>. Inverted index for search. Incrementally maintained. */
    /** @type {Map<string, Set<string>>} */
    this.searchIndex = new Map();

    this.subscribers = new Set();

    // Batch state.
    this._depth = 0;
    this._dirty = new Set();
    this._structuralChange = false;
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /**
   * Coalesce many mutations into one notification.
   *
   * Nested calls are counted, so a batch inside a batch still produces exactly
   * one render at the outermost boundary.
   */
  batch(fn) {
    this._depth++;
    try {
      return fn();
    } finally {
      this._depth--;
      if (this._depth === 0) this._flush();
    }
  }

  _flush() {
    if (this._dirty.size === 0 && !this._structuralChange) return;
    const changed = this._dirty;
    const structural = this._structuralChange;
    this._dirty = new Set();
    this._structuralChange = false;
    for (const fn of this.subscribers) fn({ changed, structural });
  }

  _touch(id, structural = false) {
    this._dirty.add(id);
    if (structural) this._structuralChange = true;
    if (this._depth === 0) this._flush();
  }

  // ------------------------------------------------------------- indexing --

  /**
   * Tokenise for the search index.
   *
   * Subject and sender only. Snippets would triple index size for very little
   * gain, since a search that matches only a snippet is usually a search the
   * user did not mean.
   */
  static tokenize(msg) {
    const text = `${msg.subject || ''} ${msg.from || ''}`.toLowerCase();
    const out = new Set();
    // Split on anything that is not a letter, digit or @ . -
    for (const raw of text.split(/[^a-z0-9@.\-]+/)) {
      if (raw.length < 2) continue;
      out.add(raw);
      // Also index the local part and domain of an address separately, so
      // "augsd" finds augsd@pilani.bits-pilani.ac.in.
      const at = raw.indexOf('@');
      if (at > 0) {
        out.add(raw.slice(0, at));
        out.add(raw.slice(at + 1));
      }
    }
    return out;
  }

  _index(msg) {
    let set = this.byCategory.get(msg.category);
    if (!set) {
      set = new Set();
      this.byCategory.set(msg.category, set);
    }
    set.add(msg.id);

    for (const tok of Store.tokenize(msg)) {
      let ids = this.searchIndex.get(tok);
      if (!ids) {
        ids = new Set();
        this.searchIndex.set(tok, ids);
      }
      ids.add(msg.id);
    }
  }

  _deindex(msg) {
    this.byCategory.get(msg.category)?.delete(msg.id);
    for (const tok of Store.tokenize(msg)) {
      const ids = this.searchIndex.get(tok);
      if (!ids) continue;
      ids.delete(msg.id);
      if (ids.size === 0) this.searchIndex.delete(tok);
    }
  }

  // -------------------------------------------------------------- ordering --

  /**
   * Insert into the newest-first order via binary search.
   *
   * O(log n) to find the slot. The old version re-sorted the whole array on
   * every insert, which is O(n log n) per message and O(n² log n) per sync.
   */
  _insertOrdered(id, date) {
    let lo = 0;
    let hi = this.order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const midDate = this.byId.get(this.order[mid])?.date ?? 0;
      if (midDate > date) lo = mid + 1;
      else hi = mid;
    }
    this.order.splice(lo, 0, id);
  }

  // -------------------------------------------------------------- mutation --

  upsert(msg) {
    const existing = this.byId.get(msg.id);
    if (existing) {
      this._deindex(existing);
      // Date is immutable for a given message, so the order array stands.
      this.byId.set(msg.id, { ...existing, ...msg });
      this._index(this.byId.get(msg.id));
      this._touch(msg.id);
      return;
    }
    this.byId.set(msg.id, msg);
    this._insertOrdered(msg.id, msg.date);
    this._index(msg);
    this._touch(msg.id, true);
    this._evictIfNeeded();
  }

  /** Add many. Automatically batched, so subscribers fire once. */
  upsertMany(msgs) {
    this.batch(() => {
      for (const m of msgs) this.upsert(m);
    });
  }

  remove(id) {
    const msg = this.byId.get(id);
    if (!msg) return;
    this._deindex(msg);
    this.byId.delete(id);
    const i = this.order.indexOf(id);
    if (i !== -1) this.order.splice(i, 1);
    this._touch(id, true);
  }

  /** Patch fields on one message without reindexing the world. */
  patch(id, fields) {
    const msg = this.byId.get(id);
    if (!msg) return;
    // Only category and text changes affect the indexes.
    const reindex =
      ('category' in fields && fields.category !== msg.category) ||
      'subject' in fields ||
      'from' in fields;
    if (reindex) this._deindex(msg);
    Object.assign(msg, fields);
    if (reindex) this._index(msg);
    this._touch(id);
  }

  /**
   * Cap memory. Oldest messages go first.
   *
   * The old version capped at 200, which is small enough that a busy inbox
   * loses recent mail. 2000 message headers is roughly 1.5MB — fine.
   */
  _evictIfNeeded() {
    while (this.order.length > MAX_MESSAGES) {
      const id = this.order[this.order.length - 1];
      const msg = this.byId.get(id);
      if (msg) this._deindex(msg);
      this.byId.delete(id);
      this.order.pop();
      this._structuralChange = true;
    }
  }

  /**
   * Drop everything.
   *
   * Needed for exactly one case: Gmail says our historyId is too old, so the
   * delta cursor is gone and we must resync from scratch. Keeping stale
   * messages around in that case would leave archived mail visible forever.
   */
  clear() {
    if (this.byId.size === 0) return;
    this.byId.clear();
    this.order.length = 0;
    this.byCategory.clear();
    this.searchIndex.clear();
    this._touch('*', true);
  }

  // --------------------------------------------------------------- reading --

  get size() {
    return this.byId.size;
  }

  get(id) {
    return this.byId.get(id);
  }

  /** Ids for a category, newest first. `null` category means everything. */
  idsFor(category) {
    // A COPY, never the live array.
    //
    // Returning `this.order` itself was a real bug: the app keeps the result
    // as `renderedIds` to diff the next render against, so `renderedIds` and
    // `store.order` became the same object. Every subsequent comparison of
    // "what is on screen" against "what should be on screen" compared the
    // array to itself and reported no change — so removing a message updated
    // the store and never updated the DOM. Archiving appeared to do nothing.
    //
    // slice() of at most a few thousand strings is a few microseconds and is
    // not worth the aliasing hazard.
    if (!category || category === 'all') return this.order.slice();
    const set = this.byCategory.get(category);
    if (!set || set.size === 0) return [];
    // Walk `order` so the result stays newest-first without a sort.
    const out = [];
    for (const id of this.order) if (set.has(id)) out.push(id);
    return out;
  }

  counts() {
    const out = {};
    for (const [cat, set] of this.byCategory) {
      if (set.size) out[cat] = set.size;
    }
    return out;
  }

  unreadCounts() {
    const out = {};
    for (const [cat, set] of this.byCategory) {
      let n = 0;
      for (const id of set) if (this.byId.get(id)?.unread) n++;
      if (n) out[cat] = n;
    }
    return out;
  }

  /**
   * Search.
   *
   * Prefix-matched against the inverted index, intersected across terms. No
   * scan over the message list — the old version's search was O(n) per
   * keystroke over every message.
   */
  search(query, category = null) {
    const q = query.trim().toLowerCase();
    if (!q) return this.idsFor(category);

    const terms = q.split(/\s+/).filter((t) => t.length >= 2);
    if (terms.length === 0) return this.idsFor(category);

    /** @type {Set<string>|null} */
    let acc = null;

    for (const term of terms) {
      const hits = new Set();
      // Exact token hit.
      const exact = this.searchIndex.get(term);
      if (exact) for (const id of exact) hits.add(id);
      // Prefix hits, so "regis" finds "registration" as you type.
      if (term.length >= 3) {
        for (const [tok, ids] of this.searchIndex) {
          if (tok.length > term.length && tok.startsWith(term)) {
            for (const id of ids) hits.add(id);
          }
        }
      }
      acc = acc === null ? hits : intersect(acc, hits);
      if (acc.size === 0) break;
    }

    const catSet = category && category !== 'all' ? this.byCategory.get(category) : null;
    const out = [];
    for (const id of this.order) {
      if (!acc.has(id)) continue;
      if (catSet && !catSet.has(id)) continue;
      out.push(id);
    }
    return out;
  }
}

function intersect(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const out = new Set();
  for (const v of small) if (large.has(v)) out.add(v);
  return out;
}
