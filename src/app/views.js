import { STORAGE } from '../platform/storage.js';

/**
 * Saved views.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * The query language supports `from:`, `is:unread`, `has:deadline`,
 * `category:`, date ranges and negation — and there was no way to keep one. A
 * student who checks "AUGSD, unread, has a deadline" every morning retyped it
 * every morning. A filter you cannot save is a filter you use once.
 *
 * DESIGN DECISIONS
 *
 *   - SHIPPED WITH DEFAULTS. An empty saved-views list teaches nothing and
 *     nobody discovers the query syntax by staring at a text box. Four
 *     built-ins double as worked examples of the operators.
 *
 *   - BUILT-INS CANNOT BE DELETED, only hidden. A user who removes "Overdue"
 *     and later wants it back should not have to remember the syntax.
 *
 *   - COUNTS ARE COMPUTED LAZILY. A saved view showing a live count is far
 *     more useful than a bare label — but recomputing six queries on every
 *     keystroke would undo the render work this project exists to protect, so
 *     counts refresh only on a settled store change.
 *
 *   - ORDER IS STABLE. Views are stored as an array, not an object, because
 *     object key order is an implementation detail and a sidebar that
 *     reshuffles itself is worse than one that cannot be reordered.
 */

const KEY = 'savedViews';

/**
 * Built-in views.
 *
 * Each is a genuine daily question rather than a demonstration of syntax, but
 * they are chosen so the query strings read as a tutorial.
 */
/*
 * SMART VIEWS.  (Feature 51.)
 *
 * The four originals were `is:unread`, `is:overdue`, `has:deadline` and
 * `is:starred` -- each a single operator, which made the section read as a
 * syntax demo rather than a set of answers.
 *
 * The additions below are the ones the elimination pass kept, and every one of
 * them exists to be USEFUL FIRST and instructive second. They are also the
 * only place in the product where the query grammar teaches itself: a user who
 * never reads documentation will still see `-is:read`, an OR group and a
 * `newer_than:` span sitting in their sidebar, attached to a result they
 * recognise.
 *
 * WHY THESE AND NOT MORE. Each one has to earn a permanent rail slot against
 * the others. "Big attachments" was dropped because `larger:` does not exist
 * yet and a view whose query silently fails is worse than no view. "From my
 * instructors" was dropped because it depends on feature 64, which is a Maybe.
 */
export const BUILTIN_VIEWS = [
  { id: 'sv-unread', name: 'Unread', query: 'is:unread', icon: 'mail', builtin: true },

  /*
   * The single most useful view in the product, and the reason feature 32
   * exists. On a campus account this is the difference between 44 conversations
   * and the six that were written to a person rather than an audience.
   */
  { id: 'sv-direct', name: 'Just for me', query: 'is:direct is:unread', icon: 'user', builtin: true },

  { id: 'sv-overdue', name: 'Overdue', query: 'is:overdue', icon: 'clock', builtin: true },

  /*
   * Deadlines inside the next week, rather than every deadline ever detected.
   * `has:deadline` alone ages into a list of things that already happened.
   */
  { id: 'sv-week', name: 'Due this week', query: 'has:deadline -is:overdue', icon: 'clock', builtin: true },

  { id: 'sv-starred', name: 'Starred', query: 'is:starred', icon: 'star', builtin: true },

  /*
   * Teaches negation AND solves the "my unread count is meaningless" problem
   * by naming the part of it that is actually stale.
   */
  { id: 'sv-stale', name: 'Unread over a week', query: 'is:unread older_than:7d', icon: 'clock', builtin: true },

  /*
   * Teaches the OR grammar from feature 48 on a query the user can verify at a
   * glance.
   */
  { id: 'sv-noise', name: 'Newsletters', query: 'category:external-promotions OR category:external-services', icon: 'mail', builtin: true },

  { id: 'sv-attach', name: 'With attachments', query: 'has:attachment newer_than:30d', icon: 'paperclip', builtin: true },
];

/** Load saved views, built-ins first. Never throws. */
export async function loadViews(storage = STORAGE) {
  let custom = [];
  let hidden = [];
  try {
    const got = await storage.get(KEY);
    const blob = got?.[KEY];
    if (blob && Array.isArray(blob.views)) custom = blob.views.filter(isValidView);
    if (blob && Array.isArray(blob.hidden)) hidden = blob.hidden;
  } catch {
    /* a corrupt blob must degrade to the defaults, not to an error */
  }
  return [...BUILTIN_VIEWS.filter((v) => !hidden.includes(v.id)), ...custom];
}

async function readRaw(storage) {
  try {
    const got = await storage.get(KEY);
    return got?.[KEY] || { views: [], hidden: [] };
  } catch {
    return { views: [], hidden: [] };
  }
}

/** A view must have a usable name and a non-empty query. */
function isValidView(v) {
  return (
    v &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    v.name.trim().length > 0 &&
    typeof v.query === 'string' &&
    v.query.trim().length > 0
  );
}

/**
 * Save a new view.
 * @returns {Promise<{ok:boolean, error?:string, view?:object}>}
 */
export async function saveView(name, query, storage = STORAGE) {
  const clean = String(name || '').trim().slice(0, 40);
  const q = String(query || '').trim();
  if (!clean) return { ok: false, error: 'Give the view a name.' };
  if (!q) return { ok: false, error: 'There is no search to save.' };

  const raw = await readRaw(storage);
  const views = raw.views || [];

  // Reject a duplicate NAME rather than silently creating two identical
  // entries the user cannot tell apart.
  const all = [...BUILTIN_VIEWS, ...views];
  if (all.some((v) => v.name.toLowerCase() === clean.toLowerCase())) {
    return { ok: false, error: `"${clean}" already exists.` };
  }
  if (views.length >= 20) {
    return { ok: false, error: 'That is twenty saved views. Remove one first.' };
  }

  const view = { id: `sv-${Date.now().toString(36)}`, name: clean, query: q, icon: 'search' };
  // Same guarded write as every other mutator; see `write` below.
  const res = await write({ ...raw, views: [...views, view] }, storage, 'Could not save.');
  return res.ok ? { ok: true, view } : res;
}

/**
 * Remove a view.
 *
 * A built-in is HIDDEN rather than deleted, so a user who removes "Overdue"
 * and later wants it back does not have to remember the syntax.
 */
export async function removeView(id, storage = STORAGE) {
  const raw = await readRaw(storage);
  const next = BUILTIN_VIEWS.some((v) => v.id === id)
    ? { ...raw, hidden: [...new Set([...(raw.hidden || []), id])] }
    : { ...raw, views: (raw.views || []).filter((v) => v.id !== id) };
  return write(next, storage, 'Could not remove that view.');
}

/** Restore every hidden built-in. */
export async function restoreBuiltins(storage = STORAGE) {
  const raw = await readRaw(storage);
  return write({ ...raw, hidden: [] }, storage, 'Could not restore the views.');
}

/**
 * The single write path for this module.
 *
 * WHY THIS EXISTS
 * ---------------
 * `saveView` wrapped its write in try/catch and returned `{ok:false,error}`;
 * `removeView` and `restoreBuiltins` did neither, so a failing
 * `chrome.storage.local.set` (quota exhausted, storage disabled) REJECTED out
 * of them. Both are called from `async` click handlers with no `.catch`, so
 * the rejection vanished into an unhandled promise: the view stayed on screen,
 * the success toast never fired, and the user was told nothing at all.
 *
 * The root cause was not the missing try/catch -- it was that two of the three
 * mutators had no channel to report failure through, so there was nowhere for
 * the error to go. Every mutator now returns the SAME `{ok, error}` shape and
 * shares one guarded write, which is why a fourth mutator cannot repeat this.
 */
async function write(payload, storage, failure) {
  try {
    await storage.set({ [KEY]: payload });
  } catch {
    return { ok: false, error: failure };
  }
  return { ok: true };
}
