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
 *   category:string, confidence:number, reason:string,
 *   hasAttachment?:boolean, fromSearch?:boolean}} Msg */
/* (Optional above: hydrate-stamped and search-stamped respectively — the
   M5 gate caught both missing; pinned present now.) */

/**
 * The local store cap.
 *
 * Exported so the UI can NAME it (audit R3-08): "as far back as this view
 * goes (2000 messages)" must not hardcode a second copy of this number,
 * because two copies of a limit are how a message becomes wrong.
 */
export const MAX_MESSAGES = 2000;

/**
 * Scripts written without spaces between words (R3-02).
 *
 * Han, Hiragana, Katakana and Hangul do not delimit words, so whitespace
 * tokenisation yields one long run per phrase. `tokenize` indexes those runs
 * by character and bigram instead, and `search` skips the prefix walk for
 * them. One definition, used by both, so the two cannot drift.
 */
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN_G = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

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

    /**
     * threadId -> Set<id>. The conversation index.
     *
     * Maintained INCREMENTALLY, like byCategory and searchIndex. Rebuilding a
     * thread map per render is the obvious implementation and is O(n) on every
     * keystroke; nothing in this store is recomputed wholesale.
     *
     * @type {Map<string, Set<string>>}
     */
    this.byThread = new Map();

    this.subscribers = new Set();

    // Batch state.
    this._depth = 0;
    this._dirty = new Set();
    this._structuralChange = false;

    /*
     * DERIVED-READ MEMO (round 45, arch A7). The sidebar and lanes walk the
     * full order array per render for counts and category slices; at the
     * 2000-message cap that is several O(n) passes per refresh. The reads are
     * pure functions of the current contents, so they are memoised per
     * _version and the flush that changes the contents is the single
     * invalidation.
     */
    this._version = 0;
    this._memo = new Map();
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
    this._version++;
    this._memo.clear();
    for (const fn of this.subscribers) fn({ changed, structural });
  }

  /** One cache slot per (version, key); invalidated wholesale by _flush. */
  _memoGet(key, compute) {
    if (this._memo.has(key)) return this._memo.get(key);
    const v = compute();
    this._memo.set(key, v);
    return v;
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
   *
   * UNICODE IS NOT AN EDGE CASE HERE, AND TREATING IT AS ONE LOST MAIL
   * (audit R3, finding R3-02).
   * ------------------------------------------------------------------
   * This used to split on `[^a-z0-9@.\-]+`, i.e. every character outside
   * ASCII was a SEPARATOR. Measured consequences, not theorised ones:
   *
   *   "Café update"   indexed as `caf`,`update`  -> search "café" = 0 hits
   *                                              -> search "cafe" = 0 hits
   *   "Zürich trip"   indexed as `rich`,`trip`   -> "Zürich" = 0, and
   *                                                 "rich" wrongly HIT
   *   "日本語 メール"  indexed as NOTHING         -> unreachable by any query
   *   "naïve résumé"  indexed as `na`,`ve`,`sum`
   *
   * That is total loss of recall for accented Latin, Devanagari, Cyrillic,
   * Greek and CJK — mainstream input for a BITS mailbox, not hostile input.
   * And because this is deliberately the ONE definition of searchable text
   * (cross-audit B-04), the same defect propagated into lane membership and
   * the rail counts: a message with a fully non-Latin subject occupied a row
   * that no query could ever reach.
   *
   * The fix has three parts, and all three are required:
   *   1. Split on Unicode letter/number classes (\p{L}\p{N}) instead of a-z0-9.
   *   2. Index BOTH the raw token and its diacritic-folded form, so "café"
   *      and "cafe" both find the same message. Folding one side only is a
   *      one-way match and is how this class of bug half-heals.
   *   3. Index scripts that do not use spaces (CJK) by character and bigram,
   *      because whitespace splitting yields one enormous useless token.
   *
   * `search()` MUST apply `Store.foldTerm` to the query or the fold is
   * one-way; the two are pinned together by test.
   */
  static tokenize(msg) {
    // ONE definition of searchable text (cross-audit B-04): the index and
    // the free-text predicate scan the same three fields, so counts, lanes
    // and results cannot disagree about what a term matches.
    const text = `${msg.subject || ''} ${msg.from || ''} ${msg.snippet || ''}`.toLowerCase();
    const out = new Set();

    const add = (tok) => {
      if (!tok) return;
      // Two characters remains the floor for SPACE-DELIMITED scripts: a bare
      // "a" matches most of the mailbox and costs an index entry to say so.
      // CJK is exempt below, where one character is a real word.
      if (tok.length < 2) return;
      out.add(tok);
      const folded = Store.foldTerm(tok);
      if (folded && folded !== tok && folded.length >= 2) out.add(folded);
    };

    // Split on anything that is not a Unicode letter, MARK, digit or @ . -
    //
    // \p{M} is not decoration. In Devanagari the vowel signs (matras) are
    // Mn/Mc marks, not letters, so a class of \p{L}\p{N} alone treated them
    // as SEPARATORS and shattered the word: छात्रावास tokenised to a
    // meaningless 'चन'. Indic, Thai, Arabic and Hebrew all carry meaning in
    // marks; excluding them re-creates R3-02 for half the world's scripts.
    for (const raw of text.split(/[^\p{L}\p{M}\p{N}@.\-]+/u)) {
      if (!raw) continue;
      add(raw);
      // Also index the local part and domain of an address separately, so
      // "augsd" finds augsd@pilani.bits-pilani.ac.in.
      const at = raw.indexOf('@');
      if (at > 0) {
        add(raw.slice(0, at));
        add(raw.slice(at + 1));
      }
      // SCRIPTS WITHOUT WORD SPACING. Han/Hiragana/Katakana/Hangul do not
      // separate words with spaces, so the run above is one long token that
      // only an exact full-string query could ever match. Index each
      // character and each adjacent pair: a 2-char query (the common case
      // for CJK) then hits an exact token, and longer queries hit through
      // the prefix path. Bounded by construction — a run of n characters
      // yields at most 2n-1 entries.
      if (CJK_RUN.test(raw)) {
        for (const run of raw.match(CJK_RUN_G) || []) {
          const chars = [...run];
          for (let i = 0; i < chars.length; i++) {
            out.add(chars[i]);
            if (i + 1 < chars.length) out.add(chars[i] + chars[i + 1]);
          }
        }
      }
    }
    return out;
  }

  /**
   * Canonical form of one search term: lowercase, diacritics removed.
   *
   * NFKD splits "é" into "e" + U+0301 COMBINING ACUTE, which the
   * \p{Diacritic} strip then removes — so "café" and "cafe" fold together.
   * Deliberately NOT applied to CJK (which has no diacritics to strip) and
   * deliberately lossless for the raw form, which is indexed alongside: a
   * user who types the accent gets an exact hit, and one who does not still
   * finds the message.
   */
  static foldTerm(s) {
    const raw = String(s || '').toLowerCase();
    /*
     * FOLD LATIN ACCENTS, NEVER INDIC MATRAS.
     *
     * \p{Diacritic} also matches Devanagari vowel signs, so a blanket strip
     * turned छात्रावास into छातरावास — a different, wrong word that no user
     * will ever type. The fold exists so "cafe" finds "café"; it has no
     * business rewriting scripts where the mark IS the vowel.
     *
     * Decomposed marks are therefore removed only when the base character
     * they attach to is Latin. Everything else keeps its marks and is
     * indexed in its raw (already-normalised) form.
     */
    const nfkd = raw.normalize('NFKD');
    let out = '';
    let lastBaseIsLatin = false;
    for (const ch of nfkd) {
      if (/\p{M}/u.test(ch)) {
        if (!lastBaseIsLatin) out += ch; // Indic/Thai/Arabic: the mark stays
        continue;                        // Latin: drop the accent
      }
      lastBaseIsLatin = /[a-z]/.test(ch);
      out += ch;
    }
    // Re-compose so the result is comparable with NFC text elsewhere.
    return out.normalize('NFC');
  }

  _index(msg) {
    const tid = Store.threadOf(msg);
    let tset = this.byThread.get(tid);
    if (!tset) {
      tset = new Set();
      this.byThread.set(tid, tset);
    }
    tset.add(msg.id);

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
    const tid = Store.threadOf(msg);
    const tset = this.byThread.get(tid);
    if (tset) {
      tset.delete(msg.id);
      // Drop the entry entirely when it empties. A leftover empty Set would
      // render a row for a conversation containing nothing.
      if (tset.size === 0) this.byThread.delete(tid);
    }

    const catSet = this.byCategory.get(msg.category);
    if (catSet) {
      catSet.delete(msg.id);
      // Same discipline as byThread: an empty Set would make counts() walk
      // a phantom category entry forever.
      if (catSet.size === 0) this.byCategory.delete(msg.category);
    }
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
      const merged = { ...existing, ...msg };
      this.byId.set(msg.id, merged);
      this._index(merged);

      // Re-position if the date moved.
      //
      // This used to assume "date is immutable for a given message, so the
      // order array stands". It is not safe. `_insertOrdered` is a binary
      // search, which requires `order` to be sorted; a single changed date
      // leaves it unsorted, and every SUBSEQUENT insert then lands in the
      // wrong slot. One bad record silently corrupts the ordering of the
      // whole list, and it never repairs itself.
      //
      // The real trigger is ordinary: cache.js persists `date`, and a delta
      // sync re-fetches and re-upserts the same ids. Any drift between the
      // cached value and the refetched `internalDate` reorders that message.
      if (merged.date !== existing.date) {
        const i = this.order.indexOf(msg.id);
        if (i !== -1) this.order.splice(i, 1);
        this._insertOrdered(msg.id, merged.date);
        this._structuralChange = true;
      }

      this._touch(msg.id);
      return;
    }
    this.byId.set(msg.id, msg);
    this._insertOrdered(msg.id, msg.date);
    this._index(msg);
    this._touch(msg.id, true);
    this._evictIfNeeded();
  }

  /**
   * Add many. Automatically batched, so subscribers fire once.
   *
   * Returns how many of them actually SURVIVED (audit R3-08). Eviction drops
   * the oldest, so paging backwards into a full store inserts messages that
   * are immediately evicted: the store reports success and the user sees
   * "Load more" do nothing, for ever. Callers that page can compare this
   * against what they sent and say so honestly.
   */
  upsertMany(msgs) {
    this.batch(() => {
      for (const m of msgs) this.upsert(m);
    });
    let kept = 0;
    for (const m of msgs) if (m && this.byId.has(m.id)) kept++;
    return kept;
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

    /*
     * A CHANGED DATE MUST REPOSITION, exactly as in `upsert`.
     *
     * `upsert` was fixed for this and `patch` was not, so the same corruption
     * was reachable through a second door: `order` is kept sorted and
     * `_insertOrdered` binary-searches it, so one out-of-place entry makes
     * every SUBSEQUENT insert land in the wrong slot. The list silently
     * mis-orders and never repairs itself.
     *
     * No caller patches `date` today, so this was latent rather than live —
     * but "no caller does X" is not an invariant, it is a coincidence, and
     * the identical assumption has already cost this project once. Delegating
     * to `upsert` means there is ONE implementation of "a date moved" instead
     * of two that must agree.
     */
    if ('date' in fields && fields.date !== msg.date) {
      this.upsert({ ...msg, ...fields });
      return;
    }

    // Only category and text changes affect the indexes. SNIPPET INCLUDED:
    // tokenize() indexes subject + from + snippet (bug-hunt #19), so a
    // snippet patch that skipped reindexing would leave the search index
    // describing text the message no longer has.
    const reindex =
      ('category' in fields && fields.category !== msg.category) ||
      'subject' in fields ||
      'from' in fields ||
      'snippet' in fields;
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
    this.byThread.clear();
    this._touch('*', true);
  }

  // --------------------------------------------------------------- reading --

  get size() {
    return this.byId.size;
  }

  /** True when the store hit its cap: what it holds is NOT the whole mailbox. */
  get isFull() {
    return this.order.length >= MAX_MESSAGES;
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
    /*
     * THE CATEGORY PATH SLICES TOO (audit EXT2-H3).
     *
     * The 'all' path above has sliced since the renderedIds aliasing bug, and
     * the reason is written out right there — but the category path handed
     * back `_memoGet`'s OWN array, so the memo was the caller's to mutate.
     * Reproduced: `const a = idsFor('augsd'); a.push('POISON')` made every
     * later read of that category return the poisoned list until the next
     * flush; `a.length = 0` made the category read as permanently empty.
     *
     * No shipping caller mutates it today — all 19 call sites were checked —
     * but this file's own history is the argument: "no caller does X" is a
     * coincidence, not an invariant, and the same assumption has already cost
     * this project once. The memo still does the O(n) work once per version;
     * the slice is a few microseconds over a few thousand strings.
     */
    return this._memoGet(`ids:${category}`, () => {
      const set = this.byCategory.get(category);
      if (!set || set.size === 0) return [];
      // Walk `order` so the result stay newest-first without a sort.
      const out = [];
      for (const id of this.order) if (set.has(id)) out.push(id);
      return out;
    }).slice();
  }

  /* ------------------------------------------------------------ threading -- */

  /**
   * Which conversation a message belongs to.
   *
   * Falls back to the message id when Gmail gave us no threadId -- locally
   * built records and older cache entries lack one. Without the fallback every
   * unthreaded message would collapse into a single bogus conversation keyed
   * on `undefined`.
   */
  static threadOf(msg) {
    return msg.threadId || msg.id;
  }

  /** Message ids in a conversation, newest first. */
  threadIds(threadId) {
    const set = this.byThread.get(threadId);
    if (!set || set.size === 0) return [];
    // Walk `order` so the result is newest-first without a sort, the same way
    // idsFor does. Threads are small, so the cost is the Set lookup.
    const out = [];
    for (const id of this.order) if (set.has(id)) out.push(id);
    return out;
  }

  /**
   * A conversation as a first-class object.
   *
   * Computed on demand rather than cached: a thread is a handful of messages,
   * and a cached summary is one more thing that can drift out of step with
   * the messages it describes. The expensive part -- finding the members --
   * is the index, which IS maintained.
   *
   * @returns {{id:string, latestId:string, count:number, unread:number,
   *   subject:string, participants:string[], hasAttachment:boolean,
   *   date:number, ids:string[]} | null}
   */
  thread(threadId) {
    const ids = this.threadIds(threadId);
    if (!ids.length) return null;

    const latest = this.byId.get(ids[0]);
    let unread = 0;
    let hasAttachment = false;
    const seen = new Set();
    const participants = [];

    // Oldest first for participants: a conversation reads as the people who
    // joined it in the order they joined.
    for (let i = ids.length - 1; i >= 0; i--) {
      const m = this.byId.get(ids[i]);
      if (!m) continue;
      if (m.unread) unread++;
      if (m.hasAttachment) hasAttachment = true;
      const who = Store.displayName(m.from);
      if (who && !seen.has(who)) {
        seen.add(who);
        participants.push(who);
      }
    }

    // The ORIGINAL subject. The newest message is usually "Re: ...", and a
    // conversation is named for what it is about, not for the last reply.
    const oldest = this.byId.get(ids[ids.length - 1]);
    const subject = Store.baseSubject(oldest?.subject || latest?.subject || '');

    return {
      id: threadId,
      latestId: ids[0],
      ids,
      count: ids.length,
      unread,
      subject,
      participants,
      hasAttachment,
      date: latest?.date ?? 0,
    };
  }

  /**
   * One id per conversation -- the newest message in each -- newest first.
   *
   * This is what the list renders. Walking `order` once and skipping threads
   * already seen keeps it O(n) with no sort, and preserves the existing
   * ordering rule: a conversation is as recent as its most recent message.
   */
  rootIds(ids = this.order) {
    const seen = new Set();
    const out = [];
    for (const id of ids) {
      const m = this.byId.get(id);
      if (!m) continue;
      const tid = Store.threadOf(m);
      if (seen.has(tid)) continue;
      seen.add(tid);
      out.push(id);
    }
    return out;
  }

  /** "Ann Example <a@b.c>" -> "Ann Example"; a bare address keeps its local part. */
  static displayName(from) {
    const raw = String(from || '').trim();
    if (!raw) return '';
    const named = raw.match(/^\s*"?([^"<]+?)"?\s*</);
    if (named) return named[1].trim();
    const bare = raw.replace(/[<>]/g, '').trim();
    return bare.includes('@') ? bare.split('@')[0] : bare;
  }

  /** Strip any run of Re:/Fwd:/Fw: prefixes. */
  static baseSubject(subject) {
    return String(subject || '').replace(/^\s*((re|fwd|fw)\s*:\s*)+/i, '').trim();
  }

  counts() {
    return this._memoGet('counts', () => {
      // `fromSearch` records are render-only citizens (cross-audit H4): they
      // answer the query on screen and must never move the rail's truth.
      const out = {};
      for (const [cat, set] of this.byCategory) {
        let n = 0;
        for (const id of set) if (!this.byId.get(id)?.fromSearch) n++;
        if (n) out[cat] = n;
      }
      return out;
    });
  }

  unreadCounts() {
    return this._memoGet('unread', () => {
      const out = {};
      for (const [cat, set] of this.byCategory) {
        let n = 0;
        for (const id of set) {
          const m = this.byId.get(id);
          if (m?.unread && !m.fromSearch) n++;
        }
        if (n) out[cat] = n;
      }
      return out;
    });
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

    /*
     * The query is folded with the SAME function the index used
     * (Store.foldTerm, R3-02). Folding one side only is a one-way match:
     * the index would hold "cafe" while the user typed "café" and the two
     * would never meet. Both the raw and the folded term are looked up, so
     * an exact accented query still gets its exact hit.
     *
     * The 2-character floor is lifted for CJK, where a single character is
     * a whole word and tokenize() indexed it as one.
     */
    const terms = q
      .split(/\s+/)
      .filter((t) => t.length >= 2 || CJK_RUN.test(t));
    if (terms.length === 0) return this.idsFor(category);

    /** @type {Set<string>|null} */
    let acc = null;

    for (const term of terms) {
      const hits = new Set();
      const folded = Store.foldTerm(term);
      // Exact token hit, raw and folded.
      for (const variant of folded && folded !== term ? [term, folded] : [term]) {
        const exact = this.searchIndex.get(variant);
        if (exact) for (const id of exact) hits.add(id);
      }
      // Prefix hits, so "regis" finds "registration" as you type.
      // CJK is exempt: its tokens are 1-2 characters by construction, so a
      // prefix walk would match half the index rather than narrow it.
      const prefixable = term.length >= 3 && !CJK_RUN.test(term);
      if (prefixable) {
        for (const [tok, ids] of this.searchIndex) {
          if (tok.length > term.length && (tok.startsWith(term) || (folded && tok.startsWith(folded)))) {
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
