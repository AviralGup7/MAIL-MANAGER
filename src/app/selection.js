/**
 * Multi-select and bulk actions.
 *
 * WHY THIS IS THE HIGHEST-VALUE MISSING FEATURE
 * ---------------------------------------------
 * The `BULK` verb has existed in the service worker since the sync layer was
 * written, and nothing has ever called it. Meanwhile clearing twelve promo
 * emails required twelve open-and-archive cycles. Gmail's most-used control on
 * a triage pass is the checkbox, and this build had no equivalent at all.
 *
 * DESIGN DECISIONS, each with a reason:
 *
 *   - SELECTION IS SEPARATE FROM THE OPEN MESSAGE. A row can be checked
 *     without being read. Conflating them — as some clients do — means you
 *     cannot select the message you are currently looking at, or you
 *     accidentally mark twelve messages read while picking them.
 *
 *   - RANGE SELECT WITH SHIFT. Selecting 30 consecutive promotions one click
 *     at a time is the exact drudgery this feature exists to remove.
 *
 *   - THE ANCHOR IS REMEMBERED. Shift-click extends from the last plain click,
 *     not from the top of the list, which is what every file manager and mail
 *     client has trained people to expect.
 *
 *   - BULK ACTIONS ARE UNDOABLE AS ONE UNIT. Archiving 40 messages must undo
 *     as one step, not forty. That is the whole reason `UndoStack` stores a
 *     thunk rather than a diff.
 *
 *   - IDS ARE VALIDATED AGAINST THE STORE ON USE. A delta sync can remove a
 *     message between selecting it and acting, and sending a dead id to Gmail
 *     fails the whole batch.
 */

/** @typedef {import('./store.js').Store} Store */

export class Selection {
  constructor() {
    /** @type {Set<string>} */
    this.ids = new Set();
    /** Last plainly-clicked row, the anchor for shift-range. */
    this.anchor = null;
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify() {
    for (const fn of this.listeners) fn(this.size);
  }

  get size() {
    return this.ids.size;
  }

  get active() {
    return this.ids.size > 0;
  }

  has(id) {
    return this.ids.has(id);
  }

  toggle(id) {
    if (this.ids.has(id)) this.ids.delete(id);
    else this.ids.add(id);
    this.anchor = id;
    this._notify();
  }

  add(id) {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    this.anchor = id;
    this._notify();
  }

  /**
   * Select every row between the anchor and `id`, inclusive.
   *
   * Operates on the RENDERED order rather than the store's, because the user
   * is selecting what they can see. If a filter is active, shift-select must
   * not silently pick up messages hidden by it.
   */
  range(id, orderedIds) {
    if (!this.anchor || this.anchor === id) {
      this.add(id);
      return;
    }
    const a = orderedIds.indexOf(this.anchor);
    const b = orderedIds.indexOf(id);
    if (a === -1 || b === -1) {
      this.add(id);
      return;
    }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) this.ids.add(orderedIds[i]);
    // The anchor deliberately does NOT move: repeated shift-clicks should keep
    // extending from the same origin, which is how a file manager behaves.
    this._notify();
  }

  selectAll(orderedIds) {
    for (const id of orderedIds) this.ids.add(id);
    this.anchor = orderedIds[orderedIds.length - 1] || null;
    this._notify();
  }

  clear() {
    if (this.ids.size === 0) return;
    this.ids.clear();
    this.anchor = null;
    this._notify();
  }

  /**
   * The selected ids that still exist, newest-first.
   *
   * A delta sync can remove a message between selecting and acting. Sending a
   * dead id to Gmail's batchModify fails the ENTIRE request, so the set is
   * reconciled against the store every time it is used rather than trusted.
   *
   * @param {Store} store
   */
  live(store, orderedIds) {
    const out = [];
    for (const id of orderedIds) {
      if (this.ids.has(id) && store.get(id)) out.push(id);
    }
    return out;
  }
}

/** Human count for the bulk bar: "3 selected". */
export function selectionLabel(n) {
  return n === 1 ? '1 selected' : `${n} selected`;
}
