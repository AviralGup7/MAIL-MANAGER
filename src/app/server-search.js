/**
 * Server search: the fallback that makes a body search work.
 *
 * The local index covers SUBJECT AND SENDER ONLY (`store.js` tokenize).
 * 
 * That is a deliberate size trade, but it means a search for a phrase the user
 * remembers from the BODY returns nothing and they conclude the mail is gone.
 * A confidently wrong answer is worse than a slow one.
 * 
 * So: local results appear instantly, and if the query looks under-served we
 * ask Gmail the same question and merge what comes back, labelled as such.
 * This is FASTER than Gmail on the common path and equal on the rare one.
 * 
 * The debounce is a timer rather than a frame: this one costs a network round
 * trip, so it waits until the user has actually stopped typing.
 *
 * Extracted from app.js as the first and least-coupled tenant identified by
 * the complexity audit: three functions, one entry point, and the only shell
 * state it needs is the current query and mailbox. It talks through an
 * explicit `ctx` rather than reaching into the shell, like every other
 * feature module.
 */

const $ = (id) => document.getElementById(id);

/** Set by wireServerSearch at boot. */
let ctx = null;

/** Wire the module to the shell. Called once. */
export function wireServerSearch(appCtx) {
  ctx = appCtx;
}

/**
 * Test seam: module state outlives a jsdom boot, and a timer left armed fires
 * into a torn-down document.
 */
export function _resetServerSearch() {
  clearTimeout(serverSearchTimer);
  serverSearchTimer = 0;
  serverSearchToken++;
  ctx = null;
}

const SERVER_SEARCH_MS = 420;
const SERVER_SEARCH_MIN = 3;
let serverSearchTimer = 0;
let serverSearchToken = 0;

/*
 * THE EPHEMERAL SEARCH BOUNDARY (V2 P0-4). Server results used to be
 * ingested into the mailbox Store with a `fromSearch` flag, which is a
 * boolean trying to act like a data model: every consumer had to remember
 * the flag, and several didn't. Now the results live in a module-owned
 * overlay the Store never sees; the list merges them while a query is
 * active, and clearing the query simply drops the overlay. There is
 * nothing to purge because nothing ever entered the mailbox state.
 */
const overlay = new Map();
export function overlayIds() { return [...overlay.keys()]; }
export function overlayGet(id) { return overlay.get(id); }
export function clearSearchOverlay() {
  if (overlay.size) { overlay.clear(); return true; }
  return false;
}

export function scheduleServerSearch() {
  clearTimeout(serverSearchTimer);
  const q = ctx.state.query.trim();

  // Nothing typed, or too short to be worth a round trip.
  if (q.length < SERVER_SEARCH_MIN) {
    serverSearchToken++; // cancel anything in flight
    if (clearSearchOverlay()) ctx.renderList();
    setSearchNote('');
    return;
  }
  // Only the inbox has a local index worth supplementing; other mailboxes are
  // already fetched in full.
  if (ctx.state.mailbox !== 'inbox') return;

  serverSearchTimer = setTimeout(runServerSearch, SERVER_SEARCH_MS);
}

async function runServerSearch() {
  const q = ctx.state.query.trim();
  const token = ++serverSearchToken;
  const before = new Set(ctx.visibleIds());

  setSearchNote('Searching all mail…');
  try {
    const { messages } = await ctx.send('SYNC_PAGE', {
      // `q` goes to Gmail verbatim: its operator syntax is a superset of ours,
      // so `from:x report` means the same thing on both sides.
      opts: { q, max: 40, anchorHistory: false },
    });

    // A newer keystroke has superseded this request. Dropping the response is
    // what stops results from an old query flashing over a newer one.
    if (token !== serverSearchToken) return;

    // Replace, don't append: a newer query's results supersede the old
    // overlay wholesale.
    overlay.clear();
    for (const m of ctx.shape(messages)) overlay.set(m.id, m);
    const fresh = messages.filter((m) => !before.has(m.id));
    if (!fresh.length) {
      setSearchNote(before.size ? '' : 'No matches in your mail.');
      ctx.renderList();
      return;
    }

    // The overlay is merged by visibleIds(); the Store never sees these
    // records, so counts, lanes, rules and cache cannot be polluted.
    ctx.renderList();
    setSearchNote(
      `${fresh.length} more found by searching message bodies in Gmail.`
    );
  } catch (err) {
    if (token !== serverSearchToken) return;
    // A failed fallback must never look like "no results": the local results
    // are still valid and still on screen.
    setSearchNote('Could not search Gmail. Showing local results only.');
  }
}

/** The one-line note under the search box. */
function setSearchNote(text) {
  const note = $('search-note');
  if (!note) return;
  // Guarded write, matching the shell's setText: no DOM write when unchanged.
  if (note.textContent !== text) note.textContent = text;
  note.hidden = !text;
}
