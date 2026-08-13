/**
 * Undo.
 *
 * WHY THIS BEATS GMAIL
 * --------------------
 * Gmail's "Undo" is only for send, and only inside a fixed window it holds the
 * message hostage for. You cannot undo an archive, a delete, a star, or a bulk
 * action — once clicked, your only recourse is to go find the message again.
 *
 * Here every mutating action pushes an inverse onto a stack. Ctrl+Z walks it
 * back. Because each action already applies optimistically to the local store,
 * the undo is instant on screen and the network call is the slow part nobody
 * waits for.
 *
 * DESIGN
 *
 *   - An entry stores a LABEL and an `undo` thunk, not a diff. Diffs are
 *     tempting but wrong here: the inverse of "archive" is not "restore these
 *     fields", it is "put the message back AND tell Gmail to re-apply INBOX",
 *     and only the caller knows both halves.
 *
 *   - BOUNDED. Twenty entries. An unbounded stack pins every message the user
 *     has ever deleted in memory, which is exactly the kind of quiet leak this
 *     project keeps finding.
 *
 *   - Entries EXPIRE. An undo offered ten minutes after the fact is a trap:
 *     the mailbox has moved on, and replaying against it can resurrect mail
 *     the user archived elsewhere. Five minutes.
 *
 *   - Undo is itself NOT undoable. A redo stack sounds symmetric but doubles
 *     the state to reason about for a feature nobody asks for in a mail client.
 */

const MAX_ENTRIES = 20;
const TTL_MS = 5 * 60 * 1000;

export class UndoStack {
  constructor({ max = MAX_ENTRIES, ttlMs = TTL_MS, now = () => Date.now() } = {}) {
    /** @type {Array<{label:string, undo:Function, at:number}>} */
    this.entries = [];
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify() {
    for (const fn of this.listeners) fn(this.peek());
  }

  /**
   * Record an action.
   * @param {string} label shown in the toast: "Archived 3 messages"
   * @param {() => void|Promise<void>} undo restores the prior state
   */
  push(label, undo) {
    if (typeof undo !== 'function') return;
    // EXPIRE BEFORE TRIM (cross-audit B-12): stale heads used to count
    // toward the cap, evicting the newest valid entry instead of themselves.
    this._expire();
    this.entries.push({ label, undo, at: this.now() });
    // Trim from the front: the oldest entry is the least likely to be wanted
    // and the most likely to be stale.
    while (this.entries.length > this.max) this.entries.shift();
    this._notify();
  }

  /** The most recent entry that has not expired, or null. */
  peek() {
    this._expire();
    return this.entries.length ? this.entries[this.entries.length - 1] : null;
  }

  _expire() {
    const cutoff = this.now() - this.ttlMs;
    // Expiry is checked lazily rather than on a timer, because a timer here
    // would be a permanent interval for something the user touches rarely --
    // and no-polling is a standing rule in this codebase.
    while (this.entries.length && this.entries[0].at < cutoff) this.entries.shift();
  }

  /**
   * Undo the most recent action.
   * @returns {Promise<string|null>} the label undone, or null if nothing to do
   */
  async undo() {
    const entry = this.peek();
    if (!entry) return null;
    this.entries.pop();
    this._notify();
    try {
      await entry.undo();
      return entry.label;
    } catch {
      // A failed undo must not leave a half-applied state silently. The caller
      // surfaces this; swallowing it here would be the worse of the two.
      throw new Error(`Could not undo: ${entry.label}`);
    }
  }

  clear() {
    if (!this.entries.length) return;
    this.entries.length = 0;
    this._notify();
  }

  get size() {
    this._expire();
    return this.entries.length;
  }
}
