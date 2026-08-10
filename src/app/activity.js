/**
 * The activity log.  (Feature 86.)
 *
 * WHY THIS IS A KEEP AND NOT A DEVELOPER LUXURY
 * ---------------------------------------------
 * When the mailbox disagrees with what the user expected, there is currently
 * no way to find out what happened. This project has spent entire sessions on
 * exactly that class of mystery -- a false "background service unavailable"
 * banner, a rail count that disagreed with the header, an undo that reversed
 * an action which never took place. Every one of those would have been a
 * five-second diagnosis against a log.
 *
 * It is also the prerequisite for feature 74's rule audit trail: automation
 * that cannot be reviewed after the fact is automation nobody should enable.
 *
 * WHAT IS AND IS NOT STORED
 *
 *   stored:     verb, target ids (capped), timestamp, actor, outcome, error
 *   NOT stored: message bodies, subjects, sender addresses
 *
 * The exclusion is deliberate. A log that accumulates subjects and addresses
 * is a second copy of the mailbox sitting in local storage with none of the
 * mailbox's protections, and it would be the most sensitive artifact the
 * extension writes to disk. Ids are meaningless on their own and resolve
 * against the store while the message still exists, which is exactly as long
 * as the log entry is useful.
 *
 * THE RING BUFFER IS CAPPED TWICE
 *
 * By COUNT, so it cannot grow without bound, and by AGE, so a log full of
 * last month's noise does not crowd out this morning's. Both are needed: a
 * heavy triage session can produce hundreds of entries in a minute, and a
 * quiet fortnight produces almost none.
 */

const KEY = 'activityLog';

/** Hard cap on entries. */
export const MAX_ENTRIES = 500;

/** Entries older than this are dropped on write. */
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Ids kept per entry. Beyond this the count is kept and the list truncated. */
const MAX_IDS = 25;

/** Who caused this. */
export const ACTORS = /** @type {const} */ (['user', 'rule', 'sync', 'system']);

/**
 * @typedef {Object} Entry
 * @property {number} at
 * @property {string} verb        ARCHIVE, STAR, SEND, RULE_APPLIED...
 * @property {string} actor
 * @property {string[]} ids       truncated
 * @property {number} count       the real number, before truncation
 * @property {'ok'|'failed'|'partial'|'undone'} outcome
 * @property {string} [error]
 * @property {string} [detail]    short, non-sensitive; e.g. a rule name
 */

/** Coerce storage into a usable list. Never throws. */
export function normaliseLog(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.verb !== 'string' || !Number.isFinite(e.at)) continue;
    out.push({
      at: e.at,
      verb: e.verb,
      actor: ACTORS.includes(e.actor) ? e.actor : 'system',
      ids: Array.isArray(e.ids) ? e.ids.filter((x) => typeof x === 'string').slice(0, MAX_IDS) : [],
      count: Number.isFinite(e.count) ? e.count : (Array.isArray(e.ids) ? e.ids.length : 0),
      outcome: ['ok', 'failed', 'partial', 'undone'].includes(e.outcome) ? e.outcome : 'ok',
      ...(typeof e.error === 'string' ? { error: e.error.slice(0, 200) } : {}),
      ...(typeof e.detail === 'string' ? { detail: e.detail.slice(0, 120) } : {}),
    });
  }
  return out;
}

/** Drop what is too old, then what is beyond the count cap. Newest first. */
export function prune(entries, now = Date.now()) {
  return entries
    .filter((e) => now - e.at <= MAX_AGE_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ENTRIES);
}

export async function loadLog(storage = chrome.storage.local) {
  try {
    const got = (await storage.get(KEY)) || {};
    return normaliseLog(got[KEY]);
  } catch {
    return [];
  }
}

/**
 * Append one entry.
 *
 * WRITES ARE BATCHED THROUGH A PENDING QUEUE. Bulk-archiving 300 messages
 * produces one entry, but a keyboard triage run produces one entry per
 * keystroke, and a storage write per keystroke is exactly the kind of thing
 * that makes an app feel heavy. The queue flushes on a timer and on demand.
 */
let pending = [];
let flushTimer = null;

/** How long writes are held before being committed. */
export const FLUSH_MS = 1500;

/**
 * Record an action.
 *
 * Deliberately NOT async from the caller's point of view -- the caller is a
 * mutation path and must not await a log write before updating the UI. Errors
 * are swallowed: a log that can break the action it is logging is worse than
 * no log.
 */
export function record(entry, { storage = chrome.storage?.local, now = Date.now() } = {}) {
  const ids = Array.isArray(entry.ids) ? entry.ids : [];
  pending.push({
    at: Number.isFinite(entry.at) ? entry.at : now,
    verb: String(entry.verb || 'UNKNOWN'),
    actor: ACTORS.includes(entry.actor) ? entry.actor : 'user',
    ids: ids.slice(0, MAX_IDS),
    count: ids.length,
    outcome: entry.outcome || 'ok',
    ...(entry.error ? { error: String(entry.error).slice(0, 200) } : {}),
    ...(entry.detail ? { detail: String(entry.detail).slice(0, 120) } : {}),
  });

  if (!flushTimer && storage) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush({ storage, now: Date.now() });
    }, FLUSH_MS);
    // Do not hold the event loop open for a log write in tests or in a worker.
    if (typeof flushTimer?.unref === 'function') flushTimer.unref();
  }
  return pending.length;
}

/** Commit queued entries. Safe to call at any time. */
export async function flush({ storage = chrome.storage?.local, now = Date.now() } = {}) {
  if (pending.length === 0 || !storage) return 0;
  const batch = pending;
  pending = [];
  try {
    const existing = await loadLog(storage);
    const next = prune([...batch, ...existing], now);
    await storage.set({ [KEY]: next });
    return batch.length;
  } catch {
    // Storage full or unavailable. The entries are dropped rather than
    // retried: an unbounded retry queue for a diagnostic is a memory leak in
    // service of a nice-to-have.
    return 0;
  }
}

/**
 * Mark the most recent entry for a verb as undone.
 *
 * Called from the undo path so the log shows the reversal rather than leaving
 * an action that looks like it stuck. Matches on verb and the id set, because
 * undoing the second-most-recent archive is possible from the history panel.
 */
export async function markUndone(verb, ids, { storage = chrome.storage?.local } = {}) {
  if (!storage) return false;
  try {
    const log = await loadLog(storage);
    const want = new Set(ids || []);
    const hit = log.find(
      (e) => e.verb === verb && e.outcome === 'ok' && e.ids.some((i) => want.has(i))
    );
    if (!hit) return false;
    hit.outcome = 'undone';
    await storage.set({ [KEY]: log });
    return true;
  } catch {
    return false;
  }
}

/** Wipe the log. Offered in options; an activity log nobody can clear is a trap. */
export async function clearLog(storage = chrome.storage?.local) {
  pending = [];
  try {
    await storage?.remove(KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Test seam. Module-level state outlives a jsdom boot, and every module in
 * this project that holds state needs one -- see the recurring-hazards note in
 * the architecture docs.
 */
export function _resetActivity() {
  pending = [];
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}

/** How many entries are waiting to be written. For assertions and the doctor. */
export function pendingCount() {
  return pending.length;
}

/**
 * Human-readable one-liner for the log view.
 *
 * Kept here rather than in the renderer so the phrasing is testable and so the
 * log view and any future export agree.
 */
export function describe(entry) {
  const n = entry.count || entry.ids.length;
  const what = n === 1 ? '1 message' : `${n} messages`;
  const verb = entry.verb.toLowerCase().replace(/_/g, ' ');
  const by = entry.actor === 'rule' ? ` by rule${entry.detail ? ` "${entry.detail}"` : ''}` : '';
  const status =
    entry.outcome === 'failed' ? ' — failed'
    : entry.outcome === 'partial' ? ' — partial'
    : entry.outcome === 'undone' ? ' — undone' : '';
  return `${verb} · ${what}${by}${status}`;
}
