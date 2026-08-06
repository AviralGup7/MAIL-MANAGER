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
export const BUILTIN_VIEWS = [
  { id: 'sv-unread', name: 'Unread', query: 'is:unread', icon: 'mail', builtin: true },
  { id: 'sv-overdue', name: 'Overdue', query: 'is:overdue', icon: 'clock', builtin: true },
  { id: 'sv-due', name: 'Has a deadline', query: 'has:deadline', icon: 'clock', builtin: true },
  { id: 'sv-starred', name: 'Starred', query: 'is:starred', icon: 'star', builtin: true },
];

/** Load saved views, built-ins first. Never throws. */
export async function loadViews(storage = chrome.storage.local) {
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
export async function saveView(name, query, storage = chrome.storage.local) {
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
  try {
    await storage.set({ [KEY]: { ...raw, views: [...views, view] } });
  } catch {
    return { ok: false, error: 'Could not save.' };
  }
  return { ok: true, view };
}

/**
 * Remove a view.
 *
 * A built-in is HIDDEN rather than deleted, so a user who removes "Overdue"
 * and later wants it back does not have to remember the syntax.
 */
export async function removeView(id, storage = chrome.storage.local) {
  const raw = await readRaw(storage);
  if (BUILTIN_VIEWS.some((v) => v.id === id)) {
    const hidden = new Set(raw.hidden || []);
    hidden.add(id);
    await storage.set({ [KEY]: { ...raw, hidden: [...hidden] } });
    return;
  }
  await storage.set({
    [KEY]: { ...raw, views: (raw.views || []).filter((v) => v.id !== id) },
  });
}

/** Restore every hidden built-in. */
export async function restoreBuiltins(storage = chrome.storage.local) {
  const raw = await readRaw(storage);
  await storage.set({ [KEY]: { ...raw, hidden: [] } });
}
