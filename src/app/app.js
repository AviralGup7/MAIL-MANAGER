/**
 * BITS Mail Manager — the app.
 *
 * ============================================================================
 * THE ONE RULE
 * ============================================================================
 * Data changes go into the Store. The Store notifies ONCE per settled state.
 * Rendering happens ONCE per animation frame, no matter how many notifications
 * arrived. Nothing else is allowed to touch the DOM of the list.
 *
 * The audit's §10 verdict on the old build was that the render cycle was
 * coupled to the data pipeline: `renderEmailList` + `rebuildSearchIndex` +
 * `silentRefresh` ran on every single store mutation, so syncing 200 messages
 * produced dozens of full re-renders inside one synchronous batch. This file
 * is the decoupling.
 *
 * Concretely:
 *   - store.batch()  coalesces N mutations into 1 notification
 *   - scheduleRender() coalesces N notifications into 1 rAF
 *   - renderList() diffs against the previously rendered id list and reuses
 *     existing <li> nodes, so a delta sync of 3 new mails touches 3 nodes
 *   - there is NO MutationObserver, NO setInterval, NO polling loop anywhere
 *     in this file. The old version had a re-entrant undebounced
 *     MutationObserver (observer.js:54) plus a 300ms silentRefresh timer.
 */

import { Store } from './store.js';
import { loadCache, saveCache, clearCache, createSaver, CACHE_MAX } from './cache.js';
import { sanitizeHtml, escapeHtml } from './sanitize.js';
import { THEMES, applyTheme, getTheme, DEFAULT_THEME } from './themes.js';
import { icon, setIcon } from './icons.js';
import { Selection, selectionLabel } from './selection.js';
import { loadViews, saveView, removeView } from './views.js';
import { extractDeadline, relativeLabel, urgency } from './deadlines.js';
import { parseQuery, buildReply } from './query.js';
import * as settings from './settings.js';
import { addressOf } from './contacts.js';
import { renderShortcuts } from './shortcuts.js';
import { openLayer, closeTopLayer, hasLayers, closeAllLayers } from './layers.js';
import { openMenu, closeMenu } from './menu.js';
import {
  MAILBOXES, DEFAULT_MAILBOX, getMailbox, isMailbox, showsCategories, actionsFor,
} from './mailboxes.js';
import {
  emptyRules, loadRules, saveRules, toggleMute, toggleAutoArchive,
  isMuted, isAutoArchived, applyCorrection, correctSender, clearCorrection,
  mutedCount,
} from './rules.js';
import {
  presets as snoozePresets, addSnooze, removeSnooze,
  loadSnoozed, pending as pendingSnoozes, wakeLabel,
} from './snooze.js';
import {
  undoStack, recordUndo, performUndo,
  renderRadar, wireRadar,
  openPalette, closePalette, wirePalette,
  openCompose, closeCompose, wireCompose, startReply,
  restoreDraftIfAny, flushDraft, refreshLabels, _setLabels, editDraft,
} from './features.js';
import {
  initTimetable, openTimetable, scanForUpdates, _resetTimetableUI,
  timetableEffectsOf,
} from './timetable-ui.js';
import { classify } from '../classify/index.js';
import {
  CATEGORY_LABELS,
  SIDEBAR_ORDER,
  MUTED_CATEGORIES,
} from '../classify/categories.js';

// ---------------------------------------------------------------- constants --

/** Stable colours per category. Derived once, never recomputed. */
const CAT_COLOR = {
  augsd: '#e2504a',
  academics: '#2f7bd6',
  admin: '#8b6ad6',
  administration: '#6b7bd6',
  ps: '#1e9e6a',
  internship: '#0f9b8e',
  competitions: '#e08a1e',
  clubs: '#d64a9c',
  events: '#c04ad6',
  library: '#8a7b52',
  technology: '#4a86d6',
  'external-services': '#7a8493',
  'external-promotions': '#98a0ad',
  spam: '#b0313a',
  other: '#98a0ad',
};

/** Messages pulled per page. Gmail's batch endpoint caps at 100. */
const PAGE = 100;

/** Confidence under this shows a dashed tag: "we guessed". */
const LOW_CONFIDENCE = 0.7;

// -------------------------------------------------------------------- state --

/**
 * One Store per mailbox.
 *
 * Sent, Trash and Spam each have their own pagination cursor, sort order and
 * search index. Folding them into the inbox's store would pollute inbox search
 * with 2000 sent messages and make the category counts meaningless.
 *
 * `store` is a live binding onto the ACTIVE mailbox's store, so the ~59
 * existing `store.` call sites keep working unchanged.
 */
const stores = new Map([['inbox', new Store()]]);
/** Per-mailbox pagination + load state, so switching back does not refetch. */
const mailboxState = new Map([['inbox', { nextPageToken: '', loaded: false, loading: false }]]);

let store = stores.get('inbox');

function storeFor(id) {
  if (!stores.has(id)) stores.set(id, new Store());
  return stores.get(id);
}

function mbState(id) {
  if (!mailboxState.has(id)) {
    mailboxState.set(id, { nextPageToken: '', loaded: false, loading: false });
  }
  return mailboxState.get(id);
}

const state = {
  mailbox: DEFAULT_MAILBOX,
  category: 'all',
  query: '',
  selected: null,
  theme: DEFAULT_THEME,
  nextPageToken: '',
  loading: false,
  signedIn: false,
  /*
   * When we last successfully heard from Gmail, as an epoch ms, or 0 for
   * never. Drives the "Updated N min ago" line under the account.
   *
   * Only ever set on SUCCESS. A failed refresh must not advance it, because
   * the whole point of the line is to answer "is what I am looking at
   * current?", and a failure means the answer is still the old timestamp.
   */
  lastSync: 0,
};

/** Ids currently rendered, in order. The diff baseline. */
let renderedIds = [];
/** Whether the list has ever been painted with content. */
let firstPaint = false;

/**
 * Multi-select.
 *
 * Deliberately separate from `state.selected`, which is the OPEN message. A
 * row can be checked without being read, and conflating the two means you
 * cannot select the message you are looking at.
 */
const selection = new Selection();
/** id -> <li>. Lets a delta patch one row without re-rendering the list. */
const nodeById = new Map();

// ------------------------------------------------------------------- lookup --

const $ = (id) => document.getElementById(id);

/** DOM id for a message row. Namespaced so a Gmail id cannot collide. */
const rowDomId = (id) => `bmm-row-${id}`;

/**
 * Which Gmail account this tab is showing, as the `u/N` path segment.
 *
 * Gmail multiplexes accounts by path: /mail/u/0/ is the first signed-in
 * account, /mail/u/1/ the second, and so on. Hardcoding u/0 sent every
 * "Open in Gmail" link to the wrong mailbox for anyone not using their first
 * account -- the same class of bug as the toolbar button opening a fresh tab
 * on the default account.
 *
 * The app runs in an iframe, so the account lives in the PARENT's URL. That is
 * cross-origin and unreadable, so the content script passes it in via the
 * frame's query string.
 */
const ACCOUNT_INDEX = (() => {
  // Read via `window`, not the bare `location` global: this module is also
  // imported by the test harness, where the document is a jsdom window rather
  // than the realm's own global.
  const search = globalThis.window?.location?.search || '';
  const u = new URLSearchParams(search).get('u');
  return u && /^\d+$/.test(u) ? u : '0';
})();
const el = {
  shell: $('shell'),
  cats: $('cats'),
  list: $('list'),
  scroller: $('scroller'),
  listpane: $('listpane'),
  listhead: $('listhead'),
  bulkbar: $('bulkbar'),
  bulkCount: $('bulk-count'),
  bulkAll: $('bulk-all'),
  viewsList: $('views-list'),
  empty: $('empty'),
  emptyTitle: $('empty-title'),
  emptySub: $('empty-sub'),
  emptyAction: $('empty-action'),
  skeleton: $('skeleton'),
  search: $('search'),
  listTitle: $('listtitle'),
  listCount: $('listcount'),
  account: $('account'),
  freshness: $('freshness'),
  gate: $('gate'),
  gateError: $('gate-error'),
  reader: $('reader'),
  rThread: $('r-thread'),
  rTimetable: $('r-timetable'),
  readerEmpty: $('reader-empty'),
  rSubject: $('r-subject'),
  rFrom: $('r-from'),
  rDate: $('r-date'),
  rTags: $('r-tags'),
  rBody: $('r-body'),
  rAttachments: $('r-attachments'),
  help: $('help'),
  helpBody: $('help-body'),
  helpClose: $('help-close'),
  rImages: $('r-images'),
  rImagesText: $('r-images-text'),
  rImagesShow: $('r-images-show'),
  rImagesAlways: $('r-images-always'),
  rLoading: $('r-loading'),
  rOpen: $('r-open'),
  toast: $('toast'),
  toastText: $('toast-text'),
  toastAction: $('toast-action'),
  toastDrain: $('toast-drain'),
  themeMenu: $('thememenu'),
};

// ------------------------------------------------------------------ plumbing --

/** Ask the service worker to do something. It owns the token; we never see it. */
function send(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (res) => {
      const lastErr = chrome.runtime.lastError;
      if (lastErr) return reject(new Error(lastErr.message));
      if (!res) return reject(new Error('No response from background worker'));
      res.ok ? resolve(res.data) : reject(new Error(res.error));
    });
  });
}

let toastTimer = 0;
/**
 * Show a toast.
 *
 * WHY THIS TOOK ON STRUCTURE
 * --------------------------
 * One pill carried 21 different messages in one style. "Message sent",
 * "Could not archive" and "Archived · Ctrl+Z to undo" looked identical, so the
 * user had to READ every toast to learn which kind it was. Feedback that costs
 * attention is not feedback.
 *
 *   - `kind` drives a 2px edge only. Not four background colours — the pill
 *     stays calm, the meaning arrives peripherally.
 *   - Errors linger longer, because reading a failure takes longer than
 *     confirming a success.
 *   - An `action` turns a keyboard hint into a button. Clicking is what people
 *     reach for in the half-second after a mistake.
 *   - The drain line makes the window VISIBLE rather than guessed at. It is
 *     the detail that silently says "you have time".
 *
 * @param {string} text
 * @param {{kind?:'info'|'success'|'error'|'undo', action?:{label:string, run:Function}, ms?:number}} [opts]
 */
function toast(text, opts = {}) {
  const kind = opts.kind || 'info';
  const ms = opts.ms || (kind === 'error' ? 4000 : kind === 'undo' ? 3600 : 2200);

  setText(el.toastText, text);
  el.toast.dataset.kind = kind;

  const action = opts.action;
  el.toastAction.hidden = !action;
  if (action) {
    setText(el.toastAction, action.label);
    el.toastAction.onclick = () => {
      hideToast();
      action.run();
    };
  } else {
    el.toastAction.onclick = null;
  }

  // Restart the drain from zero. Re-assigning the animation alone does not
  // replay it; the reflow between is what does.
  el.toastDrain.style.animation = 'none';
  void el.toastDrain.offsetWidth;
  el.toastDrain.style.animation = `toast-drain ${ms}ms linear forwards`;

  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
  clearTimeout(toastTimer);
  el.toast.hidden = true;
  el.toastAction.hidden = true;
  el.toastAction.onclick = null;
}

// --------------------------------------------------------------- the render --

let frame = 0;
let pendingStructural = false;
/** @type {Set<string>} */
let pendingIds = new Set();

/**
 * Coalesce. Called once per store notification; runs at most once per frame.
 *
 * `structural` means the set or order of messages changed, so the list must be
 * diffed. Otherwise only the touched rows need patching, which is O(changed)
 * rather than O(all).
 */
function scheduleRender({ changed, structural } = { changed: new Set(), structural: true }) {
  if (structural) pendingStructural = true;
  for (const id of changed) pendingIds.add(id);
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const structuralNow = pendingStructural;
    const ids = pendingIds;
    pendingStructural = false;
    pendingIds = new Set();
    if (structuralNow || state.query) {
      renderList();
      renderSidebar();
    } else {
      for (const id of ids) patchRow(id);
      renderSidebar();
    }
    renderRadar(ctx);
    renderViews();
  });
}

/**
 * Subscribe a mailbox's store to rendering.
 *
 * Renders are gated on the store being the ACTIVE one: a background page load
 * in Sent must not repaint the inbox the user is looking at.
 */
function wireStore(id) {
  const s = storeFor(id);
  if (s._bmmWired) return s;
  s._bmmWired = true;
  /*
   * FORWARD THE CHANGE DETAIL.
   *
   * This used to be `() => scheduleRender()`, discarding the `{changed,
   * structural}` payload the store emits. `scheduleRender` then fell back to
   * its `structural: true` default, so EVERY change took the full re-render
   * path and its per-id fast path was unreachable dead code.
   *
   * Measured on 2000 rows: starring one message cost 549ms of render work,
   * because `renderList` walked and re-filled all 2000 rows. `patch()` already
   * marked itself non-structural and `_flush` already carried the id — only
   * this callback threw the information away.
   */
  s.subscribe((detail) => {
    if (stores.get(state.mailbox) === s) scheduleRender(detail);
  });
  // Only the inbox is cached for warm start. Caching Sent as well would
  // multiply the 10MB budget across mailboxes the user rarely opens cold.
  if (id === 'inbox') s.subscribe(() => saver.schedule());
  return s;
}

/**
 * Persist the newest headers so the next takeover paints from disk.
 *
 * Subscribed separately from rendering and deliberately AFTER it, so a write
 * can never delay a frame. The saver defers to idle and coalesces, so a sync
 * touching 200 messages still produces exactly one write.
 */
const saver = createSaver(() => {
  const inbox = stores.get('inbox');
  return inbox.idsFor('all').slice(0, CACHE_MAX).map((id) => inbox.get(id)).filter(Boolean);
});

wireStore('inbox');

/**
 * Drop every message and every rendered node, synchronously.
 *
 * Clearing `renderedIds` and `nodeById` around a `store.clear()` is not enough
 * on its own: the store notification only SCHEDULES a render, so a caller that
 * reset those two immediately would have them repopulated by the queued frame
 * using state from before the wipe. Sign-out did exactly that and left the
 * previous account's rows on screen.
 *
 * Rendering synchronously here is correct rather than wasteful — the list is
 * empty, so it is one `replaceChildren` with nothing in it.
 */
function resetView({ allMailboxes = false } = {}) {
  /*
   * `allMailboxes` distinguishes two genuinely different resets.
   *
   * A RESYNC only invalidates the inbox: the history cursor expired, so inbox
   * deltas are untrustworthy, but Sent and Trash were never driven by that
   * cursor and refetching them would be wasted work.
   *
   * A SIGN-OUT must erase everything. THIS WAS A BUG: `store` is a live
   * binding onto the ACTIVE mailbox, so signing out while viewing the inbox
   * cleared the inbox and left Sent, Trash, Spam and Drafts fully populated in
   * memory. The gate appeared, but clicking Sent afterwards showed the
   * previous account's mail — verified: 5 rows survived a sign-out.
   *
   * The per-mailbox store refactor introduced this: `resetView` was written
   * when there was exactly one store, and "clear the store" silently stopped
   * meaning "clear everything".
   */
  if (allMailboxes) {
    for (const s of stores.values()) s.clear();
    for (const st of mailboxState.values()) {
      st.nextPageToken = '';
      st.loaded = false;
      st.loading = false;
    }
    state.mailbox = DEFAULT_MAILBOX;
    store = wireStore(DEFAULT_MAILBOX);
    // Freshness belongs to a SESSION. Leaving it set would tell the next
    // person to sign in that we had spoken to Gmail on their behalf.
    state.lastSync = 0;
    // So do the label names -- they are the previous account's private data,
    // and leaving them would leak them into the next user's palette.
    _setLabels([]);
    // The timetable belongs to the account too. It stays on disk (it is
    // expensive to rebuild and the same person usually signs back in), but it
    // is dropped from memory and from the screen.
    _resetTimetableUI();
    state.category = 'all';
    state.query = '';
    if (el.search) el.search.value = '';
    state.nextPageToken = '';
    selection.clear();
  } else {
    store.clear();
  }

  closeReader();
  el.list.replaceChildren();
  nodeById.clear();
  renderedIds = [];
  renderList();
  renderSidebar();
  renderSelection();
}

/**
 * Category rules (mute / auto-archive / corrections). Loaded once at boot.
 */
let rules = emptyRules();

/**
 * Muted categories are hidden from the INBOX list only.
 *
 * Not from search, not from a category the user has explicitly opened, and
 * never from the store. Muting is "stop competing for my attention", not
 * "delete" -- so the moment the user asks for the thing directly, it is there.
 */
/** How many messages the current mute rules are hiding right now. */
function mutedHiddenCount() {
  if (!rules.muted.length || state.mailbox !== 'inbox') return 0;
  if (state.category !== 'all' || state.query) return 0;
  const all = store.idsFor('all');
  return all.length - applyMute(all).length;
}

function applyMute(ids) {
  if (!rules.muted.length) return ids;
  if (state.mailbox !== 'inbox') return ids;
  if (state.category !== 'all') return ids; // they asked for it by name
  // Defensive: `visibleIds()` already routes a query down a branch that never
  // calls this function, so this line is redundancy against a future caller
  // rather than the mechanism. Kept because a mute leaking into search would
  // make mail unfindable, and that is worth two guards.
  if (state.query) return ids;
  const muted = new Set(rules.muted);
  return ids.filter((id) => {
    const m = store.get(id);
    return m && !muted.has(m.category);
  });
}

/** The ids the list should currently show. */
/*
 * THREADING IS APPLIED AT ONE PLACE.
 *
 * `visibleIds()` is the single choke point every render path already goes
 * through -- list, counts, bulk actions, j/k navigation all read from it. So
 * collapsing conversations here means every one of those subsystems inherits
 * threading without its own special case, which is the only way a change this
 * broad stays consistent.
 *
 * SEARCH IS DELIBERATELY NOT COLLAPSED. When you search you are looking for a
 * MESSAGE, and hiding the match behind the newest reply in its conversation is
 * exactly the wrong answer -- you would see "Revised schedule" when you
 * searched for a phrase that appears only in the corrigendum. Gmail collapses
 * search results and it is the most complained-about thing it does.
 */
function collapseThreads(ids) {
  if (!settings.get('threaded')) return ids;
  return store.rootIds(ids);
}

function visibleIds() {
  if (!state.query) return collapseThreads(applyMute(store.idsFor(state.category)));

  // Operators are applied as a PREDICATE over what the index returns, not by
  // scanning every message. The index still does the fast token lookup; the
  // parser only narrows it. That keeps `from:augsd registration` as cheap as
  // `registration` was.
  const parsed = parseQuery(state.query);
  const base = parsed.terms.length
    ? store.search(parsed.terms.join(' '), state.category)
    : store.idsFor(state.category);

  if (!parsed.predicate) return base;
  const out = [];
  for (const id of base) {
    const m = store.get(id);
    if (m && parsed.predicate(m)) out.push(id);
  }
  return out;
}

/**
 * Diff-render the list.
 *
 * Not a full innerHTML rewrite. The old version rebuilt every row on every
 * refresh, which threw away scroll position, focus and the selection, and
 * forced a full style+layout pass over the whole list.
 */
function renderList() {
  // EVERY visible message is rendered. There is no cap.
  //
  // This used to be `ids.slice(0, 400)`, which was a render-cost guard that
  // caused a correctness bug: `renderedIds` is what `move()` (j/k) and
  // `selectNeighbourThen()` walk, so messages 401+ were unreachable by
  // scroll, click AND keyboard. The sidebar counted them and nothing could
  // open them, and "Load more" silently grew the hidden set.
  //
  // The guard was also unnecessary. `.row` carries `content-visibility: auto`
  // with `contain-intrinsic-size`, so the browser skips rendering off-screen
  // rows entirely — that is the documented reason this list has no
  // hand-written virtualiser. The cap was defending against a cost the CSS
  // had already removed.
  const next = visibleIds();

  // The empty state is set on BOTH paths.
  //
  // It used to live only after the diff, below the fast-path return. On a
  // genuinely empty inbox `next` and `renderedIds` are both [], so the fast
  // path returned early and "Nothing here." was never revealed — a new user
  // with no mail, or any category with no messages, saw a blank pane and no
  // explanation.
  /*
   * DID THE USER EMPTY THIS, OR WAS IT ALREADY EMPTY?
   *
   * Same distinction the departure loop below draws, but needed BEFORE the
   * empty state is written. A view that just became empty because the last
   * message was archived deserves a different sentence from one that was
   * empty when you arrived — see updateEmptyState.
   *
   * The test is: something we were rendering is gone from `next` AND gone
   * from the store. Gone-but-still-stored is a filter change, which is not an
   * achievement. Computed only when the result is about to be empty, so the
   * common case pays nothing.
   */
  /*
   * The mailbox-switch case is ALREADY SAFE, and not by accident here.
   *
   * I suspected this detector would misfire on a mailbox switch: inbox ids are
   * absent from the Sent store, so "gone from the store" is true of every row.
   * It does not, because `selectMailbox` sets `renderedIds = []` before
   * rendering, so `renderedIds.length > 0` is false on the first render of any
   * new mailbox. I added a view-key guard, then removed it again: sabotaging
   * it changed no test, and sabotaging `renderedIds.length > 0` changed no
   * test either, because the reset makes both vacuous.
   *
   * Recording it because it is a LOAD-BEARING COINCIDENCE. If a future change
   * stops clearing `renderedIds` on mailbox switch — a reasonable-looking
   * optimisation — the empty Sent mailbox starts congratulating you for
   * clearing an inbox you never touched. The test named
   * "switching to an empty mailbox is not an achievement" is the tripwire.
   */
  const achieved = next.length === 0 && renderedIds.length > 0
    && renderedIds.some((id) => !store.get(id));

  updateEmptyState(next.length, achieved);

  // Fast path: identical id list, only content changed.
  if (sameOrder(next, renderedIds)) {
    for (const id of next) patchRow(id);
    updateCounts(next.length);
    return;
  }

  const frag = document.createDocumentFragment();
  const seen = new Set();
  for (const id of next) {
    seen.add(id);
    let node = nodeById.get(id);
    if (!node) {
      node = buildRow(id);
      nodeById.set(id, node);
    } else {
      fillRow(node, store.get(id));
    }
    frag.appendChild(node); // appendChild moves an existing node — no re-create
  }

  /*
   * DEPARTING ROWS ARE CLAIMED BEFORE THE REBUILD, NOT AFTER.
   *
   * `replaceChildren` below detaches every node that is not in `frag` —
   * including the ones being archived. Animating them after that point is
   * invisible, because they are no longer in the document. (Found the hard
   * way: the exit animation ran on orphaned nodes and the user saw nothing.)
   *
   * So each departing row is pulled out of `nodeById` here, appended to the
   * fragment so it survives the swap, and handed to `dismissRow` to leave
   * under its own animation. It is removed from the index immediately, so
   * `move()`, `patchRow()` and the selection can never address a row that is
   * on its way out.
   */
  for (const [id, node] of [...nodeById]) {
    if (seen.has(id)) continue;
    nodeById.delete(id);

    /*
     * ONLY A REAL DEPARTURE ANIMATES.
     *
     * A row disappears for two very different reasons, and they should not
     * look the same:
     *
     *   REMOVED  — archived, deleted, snoozed. The message left the mailbox.
     *              That is an action the user performed, and it earns motion.
     *   FILTERED — a category was clicked, a search was typed, a mailbox was
     *              switched. Nothing happened TO the message; the view simply
     *              shows something else now. Animating these makes changing
     *              filters feel laggy, and it briefly leaves stale rows on
     *              screen next to the new ones.
     *
     * The distinction is whether the store still holds the message. If it
     * does, this is a filter and the row goes immediately.
     */
    if (store.get(id)) {
      node.remove();
      continue;
    }
    frag.appendChild(node);
    dismissRow(node);
  }

  el.list.replaceChildren(frag);

  // Stagger the FIRST populated render only.
  //
  // Replaying it whenever a message is starred would be nausea rather than
  // delight, so the class is added once and removed as soon as the animation
  // has had time to run. Guarded on `firstPaint` rather than on list length,
  // because a cache hydrate followed by a delta must not re-trigger it.
  if (!firstPaint && next.length) {
    firstPaint = true;
    el.list.classList.add('list-enter');
    setTimeout(() => el.list.classList.remove('list-enter'), 600);
  }

  renderedIds = next;
  updateCounts(next.length);

  // Selection lives outside the store, so a re-render must reapply it or the
  // ticks silently vanish the moment a delta arrives mid-triage.
  if (selection.active) renderSelection();
}

/**
 * The empty state has to say WHICH kind of empty this is.
 *
 * "Nothing here." is the same message whether the user filtered too hard,
 * has an empty category, or has genuinely read everything — three different
 * situations needing three different next actions. A generic string makes the
 * user work out which one they are in.
 */
function updateEmptyState(count, achieved = false) {
  const showing = count === 0 && !state.loading;
  el.empty.hidden = !showing;
  if (!showing) return;

  const clear = (label, fn) => {
    el.emptyAction.hidden = false;
    el.emptyAction.textContent = label;
    el.emptyAction.onclick = fn;
  };

  if (state.query) {
    el.emptyTitle.textContent = 'No matches';
    el.emptySub.textContent = `Nothing matches "${state.query}". Try fewer words, or a different filter.`;
    clear('Clear search', () => {
      el.search.value = '';
      state.query = '';
      renderList();
      el.search.focus();
    });
  } else if (state.category !== 'all') {
    const label = CATEGORY_LABELS[state.category] || state.category;
    el.emptyTitle.textContent = `No ${label} mail`;
    el.emptySub.textContent = 'Nothing has been filed here yet.';
    clear('Show all mail', () => ctx.selectCategory('all'));
  } else if (store.size > 0 && mutedHiddenCount() > 0) {
    /*
     * The list is empty ONLY because of a mute rule.
     *
     * Saying "you're all caught up" here would be a lie, and a mute that can
     * make mail vanish with no trace is exactly the kind of feature that
     * loses people's trust. Name the rule and offer the way out.
     */
    const n = mutedHiddenCount();
    el.emptyTitle.textContent = 'Everything here is muted';
    el.emptySub.textContent =
      `${n} message${n === 1 ? '' : 's'} hidden by your category rules.`;
    clear('Show muted mail', () => {
      rules = { ...rules, muted: [] };
      saveRules(rules);
      renderList();
      renderSidebar();
    });
  } else if (achieved) {
    /*
     * THE USER JUST FINISHED. Say so, once, and quietly.
     *
     * This branch sits above the two below because it is about how the view
     * BECAME empty, not about what the view is. Triage is a chore whose only
     * satisfaction is finishing, and the product used to decline to notice —
     * an inbox you cleared read exactly like a category that was never used.
     *
     * Deliberately dry: no confetti, no illustration, no exclamation mark.
     * This product's voice is flat and that is an asset. One sentence, and
     * no action button, because there is nothing left to do here.
     */
    el.emptyTitle.textContent = 'That was the last one';
    el.emptySub.textContent = state.mailbox === 'inbox'
      ? 'Your inbox is clear.'
      : `Nothing left in ${getMailbox(state.mailbox).label}.`;
    el.emptyAction.hidden = true;
  } else if (store.size === 0) {
    // Each mailbox says something true about itself. "Inbox empty" while
    // looking at Trash is the kind of small wrongness that reads as a bug.
    const mb = getMailbox(state.mailbox);
    el.emptyTitle.textContent = state.mailbox === 'inbox' ? 'Inbox empty' : `${mb.label} is empty`;
    el.emptySub.textContent = mb.empty || 'Nothing to show.';
    clear('Refresh', () => refresh());
  } else {
    el.emptyTitle.textContent = "You're all caught up";
    el.emptySub.textContent = 'Nothing left in this view.';
    el.emptyAction.hidden = true;
  }
}

/**
 * Skeleton rows during a COLD start only.
 *
 * With a warm cache there is real content to paint, and showing a skeleton
 * over it would be a step backwards — the user would watch real mail be
 * replaced by grey bars.
 */
function setSkeleton(on) {
  if (!el.skeleton) return;
  if (on && !el.skeleton.childElementCount) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 7; i++) {
      const row = document.createElement('div');
      row.className = 'sk-row';
      row.innerHTML =
        '<span></span><span class="sk-mid">' +
        '<span class="sk-bar" style="width:38%"></span>' +
        '<span class="sk-bar" style="width:76%"></span>' +
        '</span><span class="sk-bar" style="width:34px"></span>';
      frag.appendChild(row);
    }
    el.skeleton.replaceChildren(frag);
  }
  el.skeleton.hidden = !on;
  el.list.hidden = on;
}

/**
 * Let a removed row leave, instead of deleting it mid-frame.
 *
 * CORRECTNESS FIRST: the node is removed on `animationend`, but that event is
 * not guaranteed — reduced motion zeroes the duration, a background tab may
 * not run animations at all, and the row may be detached by a re-render before
 * it finishes. A timeout slightly longer than the animation is therefore the
 * actual removal mechanism, and `animationend` is only an optimisation that
 * removes it sooner.
 *
 * Both paths funnel through one idempotent `done()`, so a row can never be
 * removed twice and can never be left behind.
 */
function dismissRow(node) {
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    node.remove();
  };
  // 220ms: --dur-fast is 140ms, and the margin covers a frame or two of
  // scheduling jitter without leaving a ghost row visible.
  const timer = setTimeout(done, 220);
  node.addEventListener('animationend', done, { once: true });
  node.classList.add('leaving');
}

function sameOrder(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function updateCounts(total) {
  el.listTitle.textContent =
    state.category === 'all' ? 'All mail' : CATEGORY_LABELS[state.category] || state.category;
  // Every message in the list is rendered, so the count is the whole truth.
  // It used to read "400 of 600", which implied the other 200 were merely
  // below the fold rather than unreachable.
  el.listCount.textContent = total === 0 ? '' : String(total);
}

/** Build a row's skeleton once. Text is filled by fillRow. */
function buildRow(id) {
  // A div, not an li: the listbox owns its options directly and nothing may
  // sit between them. The stable DOM id is what aria-activedescendant points
  // at, which is how a screen reader learns which row is current.
  const li = document.createElement('div');
  li.className = 'row';
  li.dataset.id = id;
  li.id = rowDomId(id);
  li.setAttribute('role', 'option');
  li.innerHTML =
    '<span class="r-pick">' +
    '<span class="r-bar"></span>' +
    '<input class="r-check" type="checkbox" tabindex="-1" aria-label="Select message" />' +
    '</span>' +
    '<span class="r-mid">' +
    '<span class="r-line1"><span class="r-from"></span>' +
    // Conversation size. Empty and hidden on a single message, so most rows
    // are shaped exactly as they always were.
    '<span class="r-count" aria-hidden="true"></span></span>' +
    '<div class="r-subj"></div>' +
    '<div class="r-snip"></div>' +
    '</span>' +
    '<span class="r-right">' +
    '<span class="r-date"></span>' +
    '<button class="r-star" type="button" tabindex="-1" aria-label="Star"></button>' +
    '<span class="tag"></span>' +
    '</span>';
  // The star is a real icon, not the `★` glyph. A glyph renders in whatever
  // font the platform picks, so it never optically matches the stroked SVGs
  // beside it and is never quite centred in its button.
  setIcon(li.querySelector('.r-star'), 'star', { size: 15 });

  fillRow(li, store.get(id));
  return li;
}

/**
 * Write a message into an existing row.
 *
 * Every assignment is guarded by a comparison. Writing the same string to
 * textContent still dirties the node and costs a style recalc; skipping the
 * write when nothing changed is most of why a delta sync is free here.
 */
function fillRow(li, m) {
  if (!m) return;
  const q = (s) => li.querySelector(s);
  const bar = q('.r-bar');
  const color = CAT_COLOR[m.category] || CAT_COLOR.other;
  if (bar.style.getPropertyValue('--c') !== color) bar.style.setProperty('--c', color);

  /*
   * Truncated text needs a title, or a clipped subject is simply unreadable.
   *
   * Institutional subject lines are long -- "Notification regarding revised
   * schedule for the comprehensive examination…" clips well before the useful
   * part. The full sender goes on too, because the row shows only the display
   * name and the address is often what the user is checking.
   *
   * Set through the same guarded helper as the text, so an unchanged row still
   * costs zero DOM writes.
   */
  /*
   * A COLLAPSED CONVERSATION MUST SAY IT IS ONE.
   *
   * Without a count and the participants, three messages look exactly like
   * one and collapsing becomes lossy rather than tidy. `thread()` returns null
   * for anything with a single message, so the common case takes the original
   * path unchanged.
   */
  /*
   * A SEARCH HIT IS A MESSAGE, NOT A CONVERSATION.
   *
   * visibleIds() deliberately does not collapse while a query is active -- you
   * searched for a message and hiding it behind a newer sibling is the wrong
   * answer. The ROW has to agree: dressing a search hit in its conversation's
   * subject, participants and count showed "Revised schedule" for a row found
   * by matching the corrigendum, so the result did not contain what was
   * searched for.
   */
  const conv = settings.get('threaded') && !state.query
    ? store.thread(Store.threadOf(m))
    : null;
  const isConv = !!conv && conv.count > 1;

  const fromEl = q('.r-from');
  setText(fromEl, isConv ? conv.participants.join(', ') : displayName(m.from));
  setAttr(fromEl, 'title', isConv
    ? `${conv.count} messages · ${conv.participants.join(', ')}`
    : m.from);

  const countEl = q('.r-count');
  if (countEl) {
    setText(countEl, isConv ? String(conv.count) : '');
    countEl.hidden = !isConv;
  }

  const subjEl = q('.r-subj');
  // The ORIGINAL subject on a conversation: it is named for what it is about,
  // not for the last reply, which is almost always "Re: ...".
  const subject = isConv ? conv.subject : m.subject;
  setText(subjEl, subject);
  setAttr(subjEl, 'title', subject);

  setText(q('.r-snip'), m.snippet);
  setText(q('.r-date'), shortDate(m.date));

  const tag = q('.tag');
  setText(tag, CATEGORY_LABELS[m.category] || m.category);
  tag.classList.toggle('low', (m.confidence ?? 1) < LOW_CONFIDENCE);
  if (m.reason && tag.title !== m.reason) tag.title = m.reason;

  /*
   * A conversation you have not finished reading is unread. Deriving this from
   * the newest message alone would hide an unread reply underneath a read one,
   * which is the exact failure the rail-count bug had.
   */
  li.classList.toggle('unread', isConv ? conv.unread > 0 : !!m.unread);
  li.classList.toggle('muted', MUTED_CATEGORIES.has(m.category));
  const star = q('.r-star');
  const starred = !!m.starred;
  if (star.getAttribute('aria-pressed') !== String(starred)) {
    star.setAttribute('aria-pressed', String(starred));
    // Filled when on, stroked when off. This is the one place a fill carries
    // meaning rather than being decoration.
    setIcon(star, 'star', { size: 15, filled: starred });
    star.setAttribute('aria-label', starred ? 'Unstar' : 'Star');
  }
  li.setAttribute('aria-selected', String(state.selected === m.id));
}

/** Guarded attribute write, matching setText: no write if unchanged. */
function setAttr(node, name, value) {
  const v = value || '';
  if (node.getAttribute(name) !== v) node.setAttribute(name, v);
}

function setText(node, value) {
  const v = value || '';
  if (node.textContent !== v) node.textContent = v;
}

/*
 * THE RAIL COUNT, WRITTEN TO BE SCANNED RATHER THAN READ.
 *
 * This used to render the single string "3/41". That was honest -- it was the
 * fix for read mail looking absent -- but a slash is a *parsing* task, and the
 * rail repeats it across twenty-two entries. The eye has to stop at each one.
 *
 * So the two numbers are now two elements: unread in the accent colour at
 * medium weight, total immediately after in --fg-faint at --t-xs. The eye
 * separates them by weight and colour, which is pre-attentive, instead of by
 * finding a delimiter, which is not. No punctuation, no extra ink.
 *
 * The digits are aria-hidden and a visually-hidden sentence carries the real
 * meaning, because "3 41" read aloud is worse than the slash ever was.
 */
function ensureCountParts(node) {
  let parts = node._parts;
  if (!parts) {
    const un = document.createElement('span');
    un.className = 'c-unread';
    un.setAttribute('aria-hidden', 'true');
    const tot = document.createElement('span');
    tot.className = 'c-total';
    tot.setAttribute('aria-hidden', 'true');
    const sr = document.createElement('span');
    sr.className = 'sr-only';
    node.replaceChildren(un, tot, sr);
    parts = node._parts = { un, tot, sr };
  }
  return parts;
}

/**
 * Render a rail count. `unread` may be 0; `total` may be null to mean "not
 * loaded yet", which renders nothing at all rather than asserting a zero we
 * have not checked.
 */
function setCount(node, unread, total) {
  const { un, tot, sr } = ensureCountParts(node);
  const known = total !== null && total !== undefined;
  const u = known ? unread || 0 : 0;
  const t = known ? total : 0;

  setText(un, u ? String(u) : '');
  // A bare total is the whole story when nothing is unread, so it takes the
  // primary slot's job -- but it keeps the faint styling, because "nothing
  // unread" should not shout.
  setText(tot, known && t ? String(t) : '');
  const label = known && t
    ? `${t} message${t === 1 ? '' : 's'}, ${u} unread`
    : '';
  setText(sr, label);
  setAttr(node, 'title', label);
  node.classList.toggle('unread', u > 0);
  return label;
}

function patchRow(id) {
  const node = nodeById.get(id);
  if (node) fillRow(node, store.get(id));
}

// ---------------------------------------------------------------- sidebar --

/** Built once; afterwards only the count text is touched. */
function buildSidebar() {
  const frag = document.createDocumentFragment();

  /*
   * MAILBOXES FIRST, then the BITS categories.
   *
   * Two distinct kinds of navigation in one rail needs a visible boundary, or
   * "Sent" reads as though it were another category of inbox mail. The
   * mailbox group is where every mail user looks first, so it goes on top.
   */
  const mbGroup = document.createElement('div');
  mbGroup.className = 'rail-group';
  for (const mb of MAILBOXES) {
    mbGroup.appendChild(mailboxButton(mb));
  }
  frag.appendChild(mbGroup);

  const catGroup = document.createElement('div');
  catGroup.className = 'rail-group';
  catGroup.id = 'cat-group';
  const heading = document.createElement('h2');
  heading.className = 'rail-heading';
  heading.textContent = 'Categories';
  catGroup.appendChild(heading);
  catGroup.appendChild(catButton('all', 'All mail', null));
  for (const cat of SIDEBAR_ORDER) {
    catGroup.appendChild(catButton(cat, CATEGORY_LABELS[cat] || cat, CAT_COLOR[cat]));
  }
  frag.appendChild(catGroup);

  el.cats.replaceChildren(frag);
}

function mailboxButton(mb) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cat mailbox';
  b.dataset.mailbox = mb.id;
  b.setAttribute('aria-current', String(state.mailbox === mb.id));
  b.tabIndex = state.mailbox === mb.id ? 0 : -1;

  const ic = document.createElement('span');
  ic.className = 'mb-icon';
  ic.appendChild(icon(MAILBOX_ICON[mb.id] || 'mail'));

  const name = document.createElement('span');
  name.className = 'cat-name';
  name.textContent = mb.label;

  const count = document.createElement('span');
  count.className = 'cat-count';

  b.append(ic, name, count);
  return b;
}

/** Icon per mailbox, from the existing 14-icon set. */
const MAILBOX_ICON = {
  inbox: 'mail',
  snoozed: 'clock',
  sent: 'reply',
  drafts: 'compose',
  starred: 'star',
  spam: 'warning',
  trash: 'trash',
};

function catButton(key, label, color) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cat' + (MUTED_CATEGORIES.has(key) ? ' muted' : '');
  b.dataset.cat = key;
  b.setAttribute('aria-current', String(state.category === key));
  // Roving tabindex: only the CURRENT category is tabbable. Sixteen separate
  // tab stops for one navigation list means a keyboard user traverses the
  // whole sidebar to reach the message list.
  b.tabIndex = state.category === key ? 0 : -1;
  const dot = document.createElement('span');
  dot.className = 'dot';
  if (color) dot.style.setProperty('--c', color);
  const name = document.createElement('span');
  name.className = 'cat-name';
  name.textContent = label;
  const count = document.createElement('span');
  count.className = 'cat-count';
  b.append(dot, name, count);
  return b;
}

/**
 * "Updated 2 min ago", in the product's dry register.
 *
 * Exported shape is a pure function of (then, now) so it can be tested
 * without faking a clock. Deliberately coarse: nobody needs seconds, and a
 * figure that changes every second is a distraction pretending to be
 * information.
 *
 * @param {number} then  epoch ms of the last successful sync, 0 for never
 * @param {number} now   epoch ms
 */
export function freshnessLabel(then, now) {
  if (!then) return '';
  const secs = Math.max(0, Math.round((now - then) / 1000));
  // Under a minute reads as "just now" rather than "0 min ago", which looks
  // like a bug even though it is arithmetically correct.
  if (secs < 45) return 'Updated just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `Updated ${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `Updated ${hrs} hr${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `Updated ${days} day${days === 1 ? '' : 's'} ago`;
}

function renderFreshness() {
  if (!el.freshness) return;
  setText(el.freshness, freshnessLabel(state.lastSync, Date.now()));
}

function renderSidebar() {
  renderFreshness();
  const counts = store.counts();
  const unread = store.unreadCounts();
  let totalUnread = 0;
  for (const n of Object.values(unread)) totalUnread += n;

  // querySelectorAll, not `children`: the rail is grouped now, so the buttons
  // are grandchildren and `children` would iterate two wrapper divs.
  for (const b of el.cats.querySelectorAll('.cat')) {
    const countEl = b.lastElementChild;

    if (b.dataset.mailbox) {
      // A mailbox shows the count of what IT holds, from its own store, and
      // only once loaded -- showing "0" for a mailbox never opened would
      // assert something we have not checked.
      const id = b.dataset.mailbox;
      const s = stores.get(id);
      const loaded = mailboxState.get(id)?.loaded;
      // `null` total means "never opened", which renders nothing -- showing
      // "0" for a mailbox we have not fetched would assert something untrue.
      let un = 0;
      let total = null;
      if (id === state.mailbox || loaded) {
        un = s ? sumUnread(s) : 0;
        total = s ? s.size : 0;
      }
      setCount(countEl, un, total);
      b.setAttribute('aria-current', String(state.mailbox === id));
      continue;
    }

    const key = b.dataset.cat;
    const u = key === 'all' ? totalUnread : unread[key] || 0;
    const t = key === 'all' ? store.size : counts[key] || 0;
    /*
     * SHOW BOTH COUNTS, not just the unread one.
     *
     * This used to render `u ? u : t` — the unread count when non-zero, and
     * the total only when everything was read. A category holding 3 unread
     * and 40 read therefore displayed "3", which reads as "there are three
     * messages here". Read mail was always in the list, but the rail said
     * otherwise, and the rail is what people scan.
     *
     * Now both numbers are always present -- see setCount, which renders them
     * as two differently-weighted spans rather than a slash-joined string.
     */
    setCount(countEl, u, t);
    b.setAttribute('aria-current', String(state.category === key));
    // A muted category is dimmed and says so, so the rule is discoverable
    // from the place it applies rather than only from a settings page.
    const muted = isMuted(rules, key);
    b.classList.toggle('is-muted', muted);
    if (muted) b.title = `${CATEGORY_LABELS[key] || key} is muted — hidden from the inbox list`;
    else if (b.title) b.removeAttribute('title');
  }

  /*
   * ONE tab stop for the WHOLE rail.
   *
   * Setting tabIndex per group gave two stops -- the current mailbox and the
   * current category -- which is the exact bug the roving tabindex was
   * introduced to remove, reintroduced by splitting the rail in two. The
   * single stop is the ACTIVE mailbox, or the active category when the
   * category rail is the meaningful one.
   */
  const buttons = [...el.cats.querySelectorAll('.cat')];
  const preferred =
    (showsCategories(state.mailbox) &&
      buttons.find((b) => b.dataset.cat === state.category)) ||
    buttons.find((b) => b.dataset.mailbox === state.mailbox) ||
    buttons[0];
  for (const b of buttons) b.tabIndex = b === preferred ? 0 : -1;
}

function sumUnread(s) {
  if (!s) return 0;
  let n = 0;
  for (const v of Object.values(s.unreadCounts())) n += v;
  return n;
}

// ----------------------------------------------------------------- reader --

let bodyToken = 0;
/** The last body fetched, kept so a theme change can re-render it. */
let lastBody = null;
/** Pending "mark read" for the open message. Cancelled if the user moves on. */
let markReadTimer = 0;

/**
 * Say what this message did to the timetable, if anything.
 *
 * THE LINK RUNS BOTH WAYS NOW. An entry could always name the message that
 * changed it; this is the direction a user actually asks in -- a room change
 * is open in front of them and the question is "has this already been applied,
 * or am I about to walk to the wrong room?"
 *
 * Hidden unless there is something to say. Almost no message changes the
 * timetable, and a permanently-present "no timetable changes" line would be
 * noise on every single mail to save a glance on one.
 */
function renderTimetableEffects(id) {
  const box = el.rTimetable;
  if (!box) return;

  let effects = [];
  try {
    effects = timetableEffectsOf(id);
  } catch {
    // The timetable is optional; the reader is not. A failure here must cost
    // the banner and nothing else.
    effects = [];
  }

  if (!effects.length) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }

  const frag = document.createDocumentFragment();
  for (const { entry, fields, current, previous } of effects) {
    const line = document.createElement('div');
    line.className = 'r-tt-line';

    const what = document.createElement('strong');
    what.textContent = `${entry.courseNo} ${entry.section}`;

    const detail = document.createElement('span');
    // "room 5105 → 6104" reads as a change; "room 6104" alone does not say
    // that anything moved, which is the only reason the banner exists.
    detail.textContent = previous
      ? ` · ${fields.join(' and ')} ${previous} → ${current}`
      : ` · ${fields.join(' and ')} set to ${current}`;

    line.append(what, detail);
    frag.appendChild(line);
  }

  const head = document.createElement('div');
  head.className = 'r-tt-head';
  head.textContent = 'Applied to your timetable';

  box.replaceChildren(head, frag);
  box.hidden = false;
}



/**
 * Load one message of the open conversation into the reader.
 *
 * Shares the body path with openMessage rather than duplicating it: same
 * token guard against a stale response, same inline-image prefetch, same
 * mark-read grace period. Duplicating that logic is how two readers drift.
 */
/**
 * Fetch and paint ONE message body into the reader frame.
 *
 * Extracted from openMessage so the conversation strip can reuse it verbatim.
 * Both paths need the same stale-response token, the same inline-image
 * prefetch and the same mark-read grace period; two copies of that is how two
 * readers drift apart.
 */
async function loadBody(id) {
  const token = ++bodyToken;
  el.rLoading.hidden = false;
  el.rBody.srcdoc = '';
  try {
    const body = await send('GET_BODY', { id });
    if (token !== bodyToken) return; // user moved on; drop the stale response

    /*
     * Inline images are fetched BEFORE the first paint of the body.
     *
     * Painting without them and substituting afterwards would reflow the
     * message under the reader's eyes, which is worse than a marginally later
     * paint -- and these parts come from the message we have already fetched,
     * so the extra round trip is small and predictable.
     */
    if (body.inline?.length) {
      try {
        const res = await send('GET_INLINE', { messageId: id, parts: body.inline });
        if (token !== bodyToken) return;
        body.inlineData = res.inline || [];
      } catch {
        body.inlineData = []; // placeholders rather than a failed message
      }
    }

    lastBody = body;
    renderAttachments(body);
    renderBodyInto(body);
  } catch (err) {
    if (token !== bodyToken) return;
    el.rBody.srcdoc = escapeDoc(`Could not load this message.\n\n${err.message}`);
  } finally {
    if (token === bodyToken) el.rLoading.hidden = true;
  }
}


async function openThreadPart(id) {
  const m = store.get(id);
  if (!m || openPart === id) return;
  openPart = id;
  renderThreadStrip(state.selected || id);
  await loadBody(id);
}

/* ------------------------------------------------------- conversation strip -- */

/*
 * Which message inside the open conversation is being shown.
 *
 * Separate from `state.selected`, which is the ROW -- the conversation. A row
 * stays selected while you move between the messages inside it, exactly as
 * selection and the open message were kept separate for multi-select.
 */
let openPart = null;

/**
 * Render the strip of messages in the open conversation.
 *
 * Oldest first: a conversation reads in the order it happened. Hidden entirely
 * for a single message, so the overwhelmingly common case keeps the reader it
 * always had.
 *
 * @returns {string[]} the message ids in the conversation, oldest first
 */
function renderThreadStrip(rootId) {
  const box = el.rThread;
  const m = store.get(rootId);
  if (!box || !m) return [rootId];

  const conv = settings.get('threaded') ? store.thread(Store.threadOf(m)) : null;
  if (!conv || conv.count < 2) {
    box.hidden = true;
    box.replaceChildren();
    return [rootId];
  }

  // `thread()` returns newest-first, like every other order in the store.
  const ids = [...conv.ids].reverse();

  const frag = document.createDocumentFragment();
  for (const id of ids) {
    const msg = store.get(id);
    if (!msg) continue;

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'r-msg';
    row.dataset.id = id;
    row.setAttribute('role', 'listitem');
    // The strip is a set of alternatives, so the current one is pressed rather
    // than selected -- selection here would collide with the list's listbox.
    row.setAttribute('aria-pressed', String(id === openPart));
    row.classList.toggle('current', id === openPart);
    row.classList.toggle('unread', !!msg.unread);

    const who = document.createElement('span');
    who.className = 'r-msg-from';
    who.textContent = displayName(msg.from);

    const when = document.createElement('span');
    when.className = 'r-msg-date';
    when.textContent = shortDate(msg.date);

    const peek = document.createElement('span');
    peek.className = 'r-msg-snip';
    peek.textContent = msg.snippet || '';

    row.append(who, when, peek);
    row.title = `${msg.from} · ${fullDate(msg.date)}`;
    frag.appendChild(row);
  }

  box.replaceChildren(frag);
  box.hidden = false;
  return ids;
}

async function openMessage(id) {
  const m = store.get(id);
  if (!m) return;

  const prev = state.selected;
  state.selected = id;
  if (prev) patchRow(prev);
  patchRow(id);
  // Tell assistive tech which option is current. aria-selected on the row is
  // not enough on its own -- without this the listbox has no notion of a
  // focused child, so selection was written to the DOM and never announced.
  el.list.setAttribute('aria-activedescendant', rowDomId(id));
  syncContextActions(m);

  el.readerEmpty.hidden = true;
  el.reader.hidden = false;
  // Restart the 180ms swap animation. Runs once, then the class is removed
  // on animationend so it never accumulates.
  el.reader.classList.remove('swap');
  void el.reader.offsetWidth; // reflow to reset the animation
  el.reader.classList.add('swap');

  el.rSubject.textContent = m.subject;
  el.rFrom.textContent = m.from;
  el.rDate.textContent = fullDate(m.date);
  el.rOpen.href = `https://mail.google.com/mail/u/${ACCOUNT_INDEX}/#inbox/${m.threadId}`;

  /*
   * The classifier's own confidence is DIAGNOSTIC, not something a reader
   * needs on every message. It is shown only when the classifier is unsure,
   * or when a human overrode it -- the two cases where "why is this here?" is
   * a real question. On a confident rule match it is noise competing with the
   * subject line.
   */
  const confident = (m.confidence ?? 1) >= LOW_CONFIDENCE && m.source !== 'you';
  /*
   * The category tag doubles as the correction affordance.
   *
   * Putting "wrong category?" next to the category itself is the only place a
   * user looks when the category is wrong. A separate control elsewhere in the
   * toolbar would be a second thing to find.
   */
  const recat = document.createElement('button');
  recat.id = 'r-recat';
  recat.type = 'button';
  recat.className = 'ghost small';
  recat.textContent = 'Wrong category?';
  recat.title = `File mail from ${displayName(m.from)} somewhere else`;
  recat.addEventListener('click', () => {
    const msg = store.get(state.selected);
    if (msg) openRecategoriseMenu(msg, recat);
  });

  el.rTags.replaceChildren(
    tagNode(CATEGORY_LABELS[m.category] || m.category, CAT_COLOR[m.category]),
    ...(confident
      ? []
      : [tagNode(`${Math.round((m.confidence ?? 1) * 100)}% · ${m.source || 'rule'}`)]),
    ...(m.reason && !confident ? [tagNode(m.reason)] : []),
    recat
  );

  renderTimetableEffects(id);

  /*
   * MARK READ, ON A DELAY.
   *
   * Unread is the one piece of triage state the user cannot reconstruct, and
   * a mis-click previously consumed it instantly. Waiting about a second means
   * arrowing past a message, or opening the wrong one and immediately leaving,
   * costs nothing. Gmail marks read almost immediately and is worse for it.
   *
   * The timer is cancelled by the same token that cancels the body fetch, so
   * moving on before it fires leaves the message unread.
   */
  clearTimeout(markReadTimer);
  if (m.unread && settings.get('markReadOnOpen')) {
    const delay = settings.get('markReadDelayMs');
    const markRead = () => {
      // Still looking at it?
      if (state.selected !== id) return;
      store.patch(id, { unread: false });
      send('MARK_READ', { id }).catch(() => store.patch(id, { unread: true }));
    };
    if (delay > 0) markReadTimer = setTimeout(markRead, delay);
    else markRead();
  }

  /*
   * The row is a conversation; the BODY shown is one message inside it.
   * Opening a conversation lands on its newest message, which is the one you
   * came to read -- the strip gives access to the rest.
   */
  openPart = id;
  renderThreadStrip(id);

  await loadBody(id);
}

el.reader.addEventListener('animationend', () => el.reader.classList.remove('swap'));

/**
 * Attachment chips, rendered in the APP rather than the body iframe.
 *
 * The frame has no `allow-scripts`, so anything inside it can never respond to
 * a click. Attachments were a filename printed as text: named, visible, and
 * impossible to open. This is the only way they become actionable without
 * weakening the sandbox that protects against hostile mail.
 */
function renderAttachments(body) {
  const list = body.attachments || [];
  el.rAttachments.replaceChildren();
  el.rAttachments.hidden = list.length === 0;
  if (!list.length) return;

  for (const a of list) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'att-chip';
    chip.dataset.attachmentId = a.attachmentId;
    chip.dataset.filename = a.filename;
    chip.dataset.mime = a.mimeType || '';
    chip.title = `${a.filename} — ${formatBytes(a.size)}`;

    const name = document.createElement('span');
    name.className = 'att-name';
    name.textContent = a.filename;

    const size = document.createElement('span');
    size.className = 'att-size';
    size.textContent = formatBytes(a.size);

    chip.append(icon('attachment', { size: 14 }), name, size);
    el.rAttachments.appendChild(chip);
  }
}

/** Human file size. Attachments are meaningless as a raw byte count. */
function formatBytes(n) {
  if (!n || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Download one attachment.
 *
 * The worker returns a data: URL because it has no DOM and therefore no
 * `URL.createObjectURL`. A synthetic anchor click is the only way to trigger a
 * download with a chosen filename from an extension page.
 */
async function downloadAttachment(chip) {
  const { attachmentId, filename, mime } = chip.dataset;
  if (!attachmentId || !state.selected) return;

  chip.disabled = true;
  chip.classList.add('loading');
  try {
    const { dataUrl } = await send('GET_ATTACHMENT', {
      messageId: state.selected,
      attachmentId,
      mimeType: mime,
    });
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename || 'attachment';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(`Downloaded ${filename}`, { kind: 'success' });
  } catch (err) {
    toast(`Could not download: ${err.message}`, { kind: 'error' });
  } finally {
    chip.disabled = false;
    chip.classList.remove('loading');
  }
}

function tagNode(text, color) {
  const s = document.createElement('span');
  s.className = 'tag';
  s.textContent = text;
  if (color) s.style.borderColor = color;
  return s;
}

/**
 * Build the srcdoc for the body iframe.
 *
 * SECURITY: the iframe has no allow-scripts and no allow-same-origin, so this
 * content is inert by construction — that, not the string munging below, is
 * the actual defence. The sanitisation is defence in depth and, unlike the old
 * version's, it does not pretend a regex is a parser: we strip the tags that
 * can execute or exfiltrate, and we block remote images by default so opening
 * a mail does not confirm your address to a spammer.
 */
/**
 * Remote-image allow-list, keyed by sender address.
 *
 * Kept out of `settings.js` because it is unbounded user data rather than a
 * preference, and it is written from the reader rather than the options page.
 */
let imageAllowList = new Set();

export async function loadImageAllowList(storage = chrome.storage?.local) {
  try {
    const { imageAllow } = (await storage.get('imageAllow')) || {};
    imageAllowList = new Set(Array.isArray(imageAllow) ? imageAllow : []);
  } catch {
    imageAllowList = new Set();
  }
  return imageAllowList;
}

async function allowSenderImages(address, storage = chrome.storage?.local) {
  if (!address) return;
  imageAllowList.add(address);
  try {
    await storage.set({ imageAllow: [...imageAllowList] });
  } catch {
    // Session-only; the user can click again next time.
  }
}

/** The bare address out of a `Name <a@b>` header. */
// addressOf now lives in contacts.js; imported above.

/**
 * Decide whether this message may load remote images, and render it.
 *
 * Kept as one function because the CSP and the sanitiser MUST agree: if the
 * sanitiser emits an `https:` src, the CSP has to permit `https:` or we are
 * back to the invisible-blank-box defect. Both read `allowRemote` here.
 */
function renderBodyInto(body, forceRemote = false) {
  const policy = settings.get('remoteImages');
  const sender = addressOf(body.from);
  const allowRemote =
    forceRemote ||
    policy === 'always' ||
    (policy !== 'never' && imageAllowList.has(sender));

  const stats = {};
  el.rBody.srcdoc = renderBody(body, { allowRemote, stats });

  // The bar only appears when there is something to unblock.
  const blocked = stats.blockedRemote || 0;
  el.rImages.hidden = blocked === 0;
  if (blocked > 0) {
    el.rImagesText.textContent =
      blocked === 1 ? '1 image was not loaded, to protect your privacy.'
        : `${blocked} images were not loaded, to protect your privacy.`;
    el.rImagesAlways.hidden = !sender;
    el.rImagesShow.onclick = () => {
      renderBodyInto(body, true);
      el.rBody.focus?.();
    };
    el.rImagesAlways.onclick = async () => {
      await allowSenderImages(sender);
      renderBodyInto(body, true);
      toast(`Images will load from ${sender}`, { kind: 'success' });
    };
  }
}

function renderBody(body, { allowRemote = false, stats = {} } = {}) {
  // cid -> data: URL, from the parts we just fetched.
  const cid = new Map();
  for (const p of body.inlineData || []) {
    if (p.contentId) cid.set(p.contentId, p.dataUrl);
    if (p.filename) cid.set(p.filename, p.dataUrl);
  }

  const html = body.html
    ? sanitizeHtml(body.html, document, { allowRemote, cid, stats })
    : `<pre>${escapeHtml(body.text || '(no content)')}</pre>`;


  // The body iframe is a separate document and inherits nothing from us, so
  // the palette is interpolated in.
  //
  // Mail authors hard-code black-on-white constantly, and a dark chrome with a
  // blinding white body is worse than no dark theme at all. So on a dark theme
  // the body gets a dark surface and only UNSTYLED text follows our foreground
  // colour -- anything the sender coloured deliberately is left alone, because
  // overriding it would wreck legitimate design and can itself destroy
  // contrast.
  const t = getTheme(state.theme);
  const dark = t.scheme === 'dark';
  const surface = dark ? t.bgRaised : '#ffffff';
  const ink = dark ? t.fg : '#16181d';

  /*
   * The CSP is derived from the SAME decision the sanitiser made.
   *
   * `https:` is added only when remote images were actually emitted. This is
   * the fix for the defect where the sanitiser allowed an https src that the
   * CSP then silently refused: there is now exactly one source of truth.
   *
   * Note this stays `img-src` only -- no script, no frame, no connect. An
   * image request leaks the read to the sender, which is why it is opt-in,
   * but it cannot execute anything.
   */
  const imgSrc = allowRemote ? 'data: https:' : 'data:';

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data:;">
<style>
  html{color-scheme:${t.scheme}}
  /*
   * READING TYPOGRAPHY.
   *
   * 15px/1.65 with a 68ch measure. The list is scanned, so it is dense; the
   * body is READ, so it gets the line-height and measure that long-form text
   * needs. Beyond ~70 characters the eye loses its place returning to the
   * next line, which is the single most common failure in mail rendering.
   */
  body{
    font:15px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
    color:${ink};background:${surface};
    margin:0;padding:26px 28px 44px;
    word-wrap:break-word;
    -webkit-font-smoothing:antialiased;
  }
  /* Only unstyled top-level text is constrained; a sender's own table layout
     is left exactly as they designed it. */
  body > p, body > div:not([style]), body > span, body > pre, body > ul, body > ol {
    max-width:68ch;
  }
  img{max-width:100%;height:auto;border-radius:6px}
  /*
   * BLOCKED AND UNRESOLVED IMAGES.
   *
   * An image with no usable src collapses to a 0x0 box in every browser, so
   * without this the user cannot tell the difference between "this mail has
   * no images" and "this mail's images were withheld". Giving the placeholder
   * a visible frame and the alt text room to show is what makes the reader
   * bar's offer make sense.
   */
  img[data-bmm-src], img[data-bmm-missing]{
    min-width:120px;min-height:44px;
    border:1px dashed ${t.line};border-radius:8px;
    background:${t.accentSoft};
    padding:8px 12px;box-sizing:border-box;
    font-size:12px;color:${t.fgDim};
  }
  pre{white-space:pre-wrap;font:inherit;margin:0}
  table{max-width:100%!important}
  a{color:${t.accent};text-underline-offset:2px}
  a:hover{text-decoration-thickness:2px}
  p{margin:0 0 1em}
  h1,h2,h3{line-height:1.3;margin:1.4em 0 .5em;font-weight:600}
  blockquote{
    margin:1em 0 1em 2px;padding:2px 0 2px 14px;
    border-left:2px solid ${t.line};color:${t.fgDim};
  }
  hr{border:0;border-top:1px solid ${t.line};margin:1.6em 0}
  .att{
    margin-bottom:18px;padding:10px 13px;background:${t.accentSoft};
    color:${t.fgDim};border-radius:10px;font-size:13px;
  }
</style></head><body>${html}</body></html>`;
}

function escapeDoc(text) {
  return `<!doctype html><meta charset="utf-8"><body style="font:13px system-ui;padding:20px;color:#5b6270"><pre style="white-space:pre-wrap">${escapeHtml(
    text
  )}</pre>`;
}

function closeReader() {
  const prev = state.selected;
  state.selected = null;
  bodyToken++;
  lastBody = null;
  // Closing before the delay elapses leaves the message unread, which is the
  // whole point of the delay.
  clearTimeout(markReadTimer);
  markReadTimer = 0;
  if (prev) patchRow(prev);
  el.list.removeAttribute('aria-activedescendant');
  syncContextActions(null);
  el.reader.hidden = true;
  el.readerEmpty.hidden = false;
  el.rBody.srcdoc = '';
  el.rAttachments.hidden = true;
  el.rAttachments.replaceChildren();
  el.rImages.hidden = true;
}

// ------------------------------------------------------------------ triage --

/**
 * Every action is optimistic: mutate the store now, tell Gmail after, roll
 * back on failure. A click must never wait on a 300ms network round trip.
 */
/**
 * Apply a removal action optimistically, with rollback and undo.
 *
 * SIX NEAR-IDENTICAL COPIES OF THIS LIVED IN `act()`. Archive, trash, spam,
 * restore, unsnooze and snooze each wrote the same five steps — snapshot,
 * move the selection, remove locally, fire the verb with a rollback, record
 * the undo — varying only in the verb, its inverse and the wording. That is
 * why `act()` was 164 lines, and it meant a fix to the rollback discipline had
 * six places to miss.
 *
 * The order matters and is the reason this is one function rather than a
 * convention:
 *
 *   1. Snapshot BEFORE mutating, or the rollback restores the post-change
 *      value and silently does nothing.
 *   2. Move the selection BEFORE removing, so the reader lands on a neighbour
 *      instead of emptying.
 *   3. Remove locally BEFORE the network call. Waiting for a 200–600ms round
 *      trip is what made v1 feel slow; the rollback is what makes it safe.
 *   4. `before` runs between the local removal and the request — snooze and
 *      unsnooze need to touch the local schedule at exactly that point, so a
 *      failed request cannot leave a message scheduled locally and not
 *      remotely.
 *
 * @param {Object}   o
 * @param {string}   o.id
 * @param {string}   o.verb      background verb to apply
 * @param {string}  [o.undoVerb] its inverse; omit for actions that cannot be undone
 * @param {string}   o.past      undo label, e.g. "Archived"
 * @param {string}   o.failed    error toast, e.g. "Could not archive"
 * @param {string}  [o.done]     success toast, when the action needs one
 * @param {(id:string)=>Promise<void>} [o.before] local work before the request
 * @param {(id:string)=>Promise<void>} [o.rollback] undo `before` when the request fails
 * @param {(id:string)=>Promise<void>} [o.undoBefore] undo `before` on user undo
 */
function optimistic({
  id, verb, undoVerb, past, failed, done, before, rollback: undoLocal, undoBefore,
}) {
  const m = store.get(id);
  if (!m) return Promise.resolve();
  const snapshot = { ...m };

  selectNeighbourThen(id);
  store.remove(id);

  const rollback = async () => {
    /*
     * Undo the LOCAL write first, then restore the message. An action that
     * wrote local state before the request (snooze writes the schedule) would
     * otherwise leave that write behind after a failure -- the message is back
     * in the list but still scheduled to disappear.
     */
    if (undoLocal) await undoLocal(id);
    store.upsert(snapshot);
    renderList();
    toast(failed, { kind: 'error' });
  };

  const run = async () => {
    if (before) await before(id);
    return send(verb, { id });
  };

  const sent = run().catch(rollback);

  if (undoVerb) {
    recordUndo(ctx, past, async () => {
      if (undoBefore) await undoBefore(id);
      store.upsert(snapshot);
      await send(undoVerb, { id });
      renderList();
    });
  }
  if (done) toast(done);
  return sent;
}

async function act(action, id) {
  const m = store.get(id);
  if (!m) return;

  /*
   * AN ACTION ON A COLLAPSED ROW APPLIES TO THE CONVERSATION.
   *
   * Archiving only the newest message leaves the row on screen showing the
   * next message down, which reads as the action having failed. Same rule the
   * tick already follows.
   *
   * Routed through bulkAct rather than reimplemented: that path already does
   * one batched request, one rollback on failure and one undo entry for the
   * whole set. A second implementation of that is how two paths drift.
   *
   * `star` and `unread` are excluded on purpose -- both are per-message
   * judgements. Starring a conversation because you starred one reply, or
   * marking three messages unread because you un-read one, throws away
   * information the user deliberately created.
   */
  const SPANS_THREAD = new Set(['archive', 'trash', 'spam']);
  if (settings.get('threaded') && SPANS_THREAD.has(action) && !state.query) {
    const ids = store.threadIds(Store.threadOf(m));
    if (ids.length > 1) {
      await bulkAct(action, ids);
      return;
    }
  }

  switch (action) {
    case 'star': {
      const on = !m.starred;
      store.patch(id, { starred: on });
      if (id === state.selected) syncContextActions(store.get(id));
      send('STAR', { id, on }).catch(() => {
        store.patch(id, { starred: !on });
        toast('Could not update star', { kind: 'error' });
      });
      break;
    }
    case 'unread': {
      const on = !m.unread;
      store.patch(id, { unread: on });
      send(on ? 'MARK_UNREAD' : 'MARK_READ', { id }).catch(() => {
        store.patch(id, { unread: !on });
        toast('Could not update', { kind: 'error' });
      });
      break;
    }
    // Gmail cannot undo an archive. We can, because the message is still in
    // memory and re-applying INBOX is one call.
    case 'archive':
      optimistic({
        id, verb: 'ARCHIVE', undoVerb: 'UNARCHIVE',
        past: 'Archived', failed: 'Could not archive',
      });
      break;
    case 'trash':
      optimistic({
        id, verb: 'TRASH', undoVerb: 'UNTRASH',
        past: 'Deleted', failed: 'Could not delete',
      });
      break;
    /*
     * SPAM, both directions, decided by WHERE YOU ARE.
     *
     * "Report spam" is meaningless on a message already sitting in Spam, so
     * in that mailbox the same action rescues instead. One verb the user
     * thinks of as "this is / is not junk", resolved from context rather than
     * from two buttons they have to choose between.
     *
     * Undo matters more here than for archive: reporting the wrong sender
     * trains Gmail against a correspondent you actually want.
     */
    /*
     * RESTORE FROM TRASH. UNTRASH existed and was reachable only from the undo
     * stack, so "I deleted the wrong thing" was recoverable for five minutes
     * and never again. Gmail's Trash is a recovery surface; this one was a
     * viewing gallery.
     */
    /*
     * Continue writing a draft. Delegated to features.js, which owns compose
     * and therefore owns what "open this into compose" means.
     */
    case 'edit':
      await editDraft(ctx, id);
      break;
    case 'restore':
      optimistic({
        id, verb: 'UNTRASH', undoVerb: 'TRASH',
        past: 'Restored', failed: 'Could not restore',
        done: 'Moved back to the inbox',
      });
      break;
    /*
     * WAKE A SNOOZED MESSAGE NOW. Snooze is a promise about the future, and a
     * promise you cannot change your mind about is worse than none. The local
     * schedule and the Gmail label are both cleared, in that order, so a
     * failed network call cannot leave a message snoozed locally but not
     * remotely.
     */
    case 'unsnooze':
      await optimistic({
        id, verb: 'UNSNOOZE',
        // No undo: re-snoozing needs a wake time the user never chose here.
        past: 'Woken', failed: 'Could not wake this message',
        done: 'Back in your inbox',
        // Clear the local schedule before the request, so a failure cannot
        // leave a message scheduled locally but not remotely.
        before: (mid) => removeSnooze(mid, chrome.storage.local),
      });
      break;
    case 'spam': {
      const rescuing = state.mailbox === 'spam';
      optimistic({
        id,
        verb: rescuing ? 'NOT_SPAM' : 'SPAM',
        undoVerb: rescuing ? 'SPAM' : 'NOT_SPAM',
        past: rescuing ? 'Moved out of spam' : 'Reported spam',
        failed: rescuing ? 'Could not rescue' : 'Could not report spam',
      });
      break;
    }
  }
}

/**
 * Snooze one message until `wakeAt`.
 *
 * Local state is written BEFORE the network call, and rolled back if the call
 * fails. Doing it the other way round leaves the row on screen for the length
 * of a round trip after the user has already moved on.
 */
async function snoozeMessage(id, wakeAt, label) {
  await optimistic({
    id, verb: 'SNOOZE', undoVerb: 'UNSNOOZE',
    past: 'Snoozed', failed: 'Could not snooze',
    done: `Snoozed ${label ? label.toLowerCase() : ''}`.trim(),
    // The local schedule is written before the request and unwound on either
    // failure or undo -- a message must never be scheduled locally without
    // Gmail agreeing, nor left scheduled after the user takes it back.
    before: () => addSnooze(id, wakeAt, chrome.storage.local),
    rollback: () => removeSnooze(id, chrome.storage.local),
    undoBefore: () => removeSnooze(id, chrome.storage.local),
  });
}

/** Keep the reading pane useful after a destructive action. */
function selectNeighbourThen(id) {
  if (state.selected !== id) return;
  const i = renderedIds.indexOf(id);
  const nextId = renderedIds[i + 1] || renderedIds[i - 1];
  if (nextId) {
    // Defer: let the removal settle first so the row exists to be selected.
    queueMicrotask(() => openMessage(nextId));
  } else {
    closeReader();
  }
}

// -------------------------------------------------------------------- sync --

/**
 * Ingest raw Gmail records: classify, then commit in ONE batch.
 *
 * Classification is synchronous (500 messages in ~19ms measured), so it can
 * run inline. Doing it before the batch means the store is mutated exactly
 * once per page and the UI renders exactly once per page.
 */
/**
 * Ingest into a specific mailbox's store.
 *
 * `classified: false` mailboxes skip the BITS classifier entirely. Bucketing
 * your own Sent mail by whichever rule matched the recipient is noise, and
 * running the classifier over Trash wastes work on messages that are leaving.
 * Those views get a flat, date-ordered list, which is what they are for.
 */
function ingestInto(mailboxId, messages, classified) {
  const target = storeFor(mailboxId);
  const records = new Array(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const base = {
      id: m.id,
      threadId: m.threadId,
      from: m.from,
      to: m.to,
      subject: m.subject,
      snippet: m.snippet,
      date: m.date,
      unread: m.unread,
      starred: m.starred,
      hasAttachment: !!m.hasAttachment,
    };
    if (classified) {
      const c = classify(m);
      const d = extractDeadline(m);
      // A user correction outranks the generated rules. Someone who has said
      // where a sender belongs should not have to say it twice.
      records[i] = applyCorrection(rules, {
        ...base,
        dueAt: d ? d.at : undefined,
        dueKind: d ? d.kind : undefined,
        // The phrase the date was read FROM. Kept so the reader can show its
        // working -- see the deadline tag -- rather than asserting a date the
        // user has to take on faith.
        dueText: d ? d.text : undefined,
        category: c.category,
        confidence: c.confidence,
        source: c.source,
        reason: c.reason,
      });
    } else {
      records[i] = { ...base, category: 'other', confidence: 1, source: 'mailbox' };
    }
  }
  target.upsertMany(records);
}

function ingest(messages) {
  if (!messages.length) return;
  const records = new Array(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const c = classify(m);
    // Deadline extraction rides along with classification: same pass, same
    // data, measured at a few microseconds per message. Doing it here rather
    // than at render time means search operators (is:due, is:overdue) can use
    // it without re-parsing on every keystroke.
    const d = extractDeadline(m);
    records[i] = applyCorrection(rules, {
      dueAt: d ? d.at : undefined,
      dueKind: d ? d.kind : undefined,
      dueText: d ? d.text : undefined,
      hasAttachment: !!m.hasAttachment,
      id: m.id,
      threadId: m.threadId,
      from: m.from,
      subject: m.subject,
      snippet: m.snippet,
      date: m.date,
      unread: m.unread,
      starred: m.starred,
      category: c.category,
      confidence: c.confidence,
      source: c.source,
      reason: c.reason,
    });
  }
  store.upsertMany(records); // one batch -> one notification -> one frame
  autoArchive(records);
}

/**
 * Auto-archive whole categories on arrival.
 *
 * Deliberately NOT silent. It reports what it did and offers an undo, because
 * a rule that removes mail without saying so is indistinguishable from mail
 * going missing -- and the user cannot debug what they never saw.
 *
 * Only ever touches UNREAD, newly-arrived mail: re-archiving something the
 * user has already dealt with would fight them.
 */
function autoArchive(records) {
  if (!rules.autoArchive.length) return;
  const targets = new Set(rules.autoArchive);
  const hits = records.filter((m) => targets.has(m.category) && m.unread);
  if (!hits.length) return;

  const ids = hits.map((m) => m.id);
  const snapshots = hits.map((m) => ({ ...m }));
  for (const id of ids) store.remove(id);

  send('BULK', { ids, remove: ['INBOX'] }).catch(() => {
    for (const s of snapshots) store.upsert(s);
    toast('Could not auto-archive', { kind: 'error' });
  });

  toast(`Auto-archived ${ids.length} message${ids.length === 1 ? '' : 's'}`);
  recordUndo(ctx, `Auto-archived ${ids.length}`, async () => {
    for (const s of snapshots) store.upsert(s);
    await send('BULK', { ids, add: ['INBOX'] });
  });
}

/**
 * Re-derive a message's deadline fields.
 *
 * THE CACHE DOES NOT STORE THE DEADLINE. `pack()` writes eleven positional
 * fields and `dueAt` is not among them, so a cached message goes into the
 * store through `store.upsert` directly, never through `ingest` -- and
 * `ingest` is the only place `extractDeadline` runs.
 *
 * The visible effect was that opening the app on a warm cache showed NO
 * deadline radar at all, for as long as the delta took to come back. The
 * product's most differentiated feature was missing from precisely the start
 * that is supposed to be the fast one.
 *
 * Re-deriving is the right fix rather than widening the cache format: the
 * deadline is a pure function of the snippet and subject, both of which ARE
 * cached, and urgency is relative to now, so a stored `dueAt` would be
 * correct while the band computed from it drifted. Parsing ~500 cached
 * snippets is a few milliseconds, and it happens inside the existing batch.
 */
function withDeadline(m) {
  if (m.dueAt) return m;
  let d;
  try {
    d = extractDeadline(m);
  } catch {
    // A malformed cached record must degrade to "no deadline", never to a
    // failed hydrate -- this runs before first paint.
    return m;
  }
  return d ? { ...m, dueAt: d.at, dueKind: d.kind, dueText: d.text } : m;
}

/** Fetch and ingest one page. Throws; callers own the error reporting. */
async function fetchPage(pageToken) {
  const { messages, nextPageToken } = await send('SYNC_PAGE', {
    opts: { pageToken, max: PAGE },
  });
  ingest(messages);
  state.nextPageToken = nextPageToken;
  // Reached only if send() resolved, so this genuinely means "Gmail answered".
  state.lastSync = Date.now();
  $('btn-more').disabled = !nextPageToken;
}

async function loadPage(pageToken = '') {
  // Inbox-only path. Uses the same per-mailbox flag as loadMailboxPage so the
  // two cannot deadlock each other; see the note there.
  const ms = mbState('inbox');
  if (!state.signedIn) return;
  if (ms.loading) return;
  ms.loading = true;
  syncBusy();
  try {
    await fetchPage(pageToken);
  } catch (err) {
    reportError(err);
  } finally {
    ms.loading = false;
    syncBusy();
  }
}

/**
 * The busy indicator is a property of the WINDOW, not of any one mailbox.
 *
 * Derived from every mailbox's flag rather than assigned, so a fast mailbox
 * finishing cannot switch off the spinner belonging to a slow one that is
 * still in flight.
 */
function syncBusy() {
  state.loading = [...mailboxState.values()].some((v) => v.loading);
  setBusy(state.loading);
}

/** Delta refresh. Cheap; safe to call on demand. Never on a timer. */
/**
 * Delta refresh.
 *
 * @param {{silent?:boolean}} opts  `silent` suppresses the "Up to date" toast,
 *   used on the automatic refresh after a cache hydrate where the user did not
 *   ask for anything and should not be told about it.
 * @returns {Promise<'delta'|'resync'|'none'|'error'|undefined>}
 */
async function refresh({ silent = false } = {}) {
  /*
   * Delta sync is INBOX-ONLY. The History API cursor tracks the account, but
   * our delta handler reconciles against the inbox's store; running it while
   * Sent is showing would apply inbox changes to the wrong collection. Other
   * mailboxes refresh by refetching their first page, which is cheap because
   * they are small and rarely open.
   */
  if (state.mailbox !== 'inbox') {
    const id = state.mailbox;
    storeFor(id).clear();
    mbState(id).nextPageToken = '';
    mbState(id).loaded = false;
    await loadMailboxPage(id, '');
    if (!silent) toast('Refreshed');
    return 'delta';
  }
  // Delta refresh is an INBOX operation, so it shares the inbox's flag. Using
  // the global one meant a slow Sent page load could block a refresh, and a
  // refresh could block a mailbox load -- two unrelated operations
  // deadlocking each other through one boolean.
  const ims = mbState('inbox');
  if (!state.signedIn) return;
  if (ims.loading) return;
  ims.loading = true;
  syncBusy();
  try {
    const res = await send('SYNC_DELTA');

    if (res.kind === 'resync' || res.kind === 'none') {
      // The history cursor expired (Gmail keeps about a week) or we never had
      // one. Everything we hold may be stale, including messages archived
      // elsewhere, so start clean rather than merge.
      // Same hazard as sign-out: the store notification only schedules a
      // render, so the view must be reset synchronously before refilling.
      resetView();
      // The cache is stale in the same way the store was; drop it so a failed
      // reload cannot resurrect archived mail on the next open.
      await clearCache();
      if (res.kind === 'none') return 'none';
      await fetchPage('');
      return 'resync';
    }

    // ONE batch for the whole delta: adds, removes and patches together
    // produce a single notification and therefore a single render.
    //
    // `added` and `removed` are guaranteed disjoint by reduceHistory(), so
    // the order of these three loops does not affect the result. The first
    // draft did not guarantee that, and an archive-then-unarchive silently
    // lost the message. See notes/SYNC_BUGS.md.
    store.batch(() => {
      ingest(res.added);
      for (const id of res.removed) store.remove(id);
      for (const { id, ...fields } of res.patched) store.patch(id, fields);
    });

    // If the open message was archived or deleted elsewhere, the reading pane
    // is now showing something that is no longer in the list.
    if (state.selected && !store.get(state.selected)) closeReader();

    state.lastSync = Date.now();
    const n = res.added.length;
    if (n) toast(`${n} new message${n > 1 ? 's' : ''}`);
    else if (!silent) toast('Up to date');
    return 'delta';
  } catch (err) {
    reportError(err);
    return 'error';
  } finally {
    ims.loading = false;
    syncBusy();
  }
}

function setBusy(on) {
  el.shell.setAttribute('aria-busy', String(on));
  $('btn-refresh').disabled = on;
}

function reportError(err) {
  const msg = String(err?.message || err);
  if (/client ID/i.test(msg)) {
    showGate(msg);
  } else if (/401|invalid_grant|No refresh token/i.test(msg)) {
    state.signedIn = false;
    showGate('Session expired. Sign in again.');
  } else {
    toast(msg.slice(0, 140));
  }
}

// -------------------------------------------------------------------- gate --

function showGate(message) {
  el.gate.hidden = false;
  el.gateError.hidden = !message;
  el.gateError.textContent = message || '';
}

function hideGate() {
  el.gate.hidden = true;
}

// ------------------------------------------------------------------ events --

// One delegated listener for the whole list. The old version attached three
// listeners per row; at 200 rows that is 600 listeners to create and tear down
// on every refresh.
/*
 * The conversation strip. Delegated, because the strip is rebuilt whenever the
 * open message changes and per-button listeners would leak with it.
 */
el.rThread?.addEventListener('click', (e) => {
  const part = e.target.closest('.r-msg');
  if (part?.dataset.id) openThreadPart(part.dataset.id);
});

el.list.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const id = row.dataset.id;

  if (e.target.closest('.r-star')) {
    e.stopPropagation();
    act('star', id);
    return;
  }

  // The checkbox, or its padding. Selecting must never also open the message:
  // ticking twelve boxes would otherwise mark twelve messages read.
  if (e.target.closest('.r-pick')) {
    e.stopPropagation();
    e.preventDefault();
    selection.toggle(id);
    renderSelection();
    return;
  }

  // Shift extends a range; Ctrl/Cmd toggles one. Both are what a file manager
  // has trained people to expect, so neither needs explaining.
  if (e.shiftKey && selection.anchor) {
    e.preventDefault();
    selection.range(id, renderedIds);
    renderSelection();
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    selection.toggle(id);
    renderSelection();
    return;
  }

  openMessage(id);
});

/*
 * Arrow-key navigation inside the sidebar.
 *
 * The counterpart to the roving tabindex: Tab reaches the nav as a single
 * stop, arrows move within it, Home and End jump to the ends. Without this
 * half the pattern is missing and the non-current categories become
 * unreachable by keyboard entirely -- a worse bug than the sixteen tab stops
 * it replaced.
 */
el.cats.addEventListener('keydown', (e) => {
  // Query for the buttons rather than reading `children`: the rail is now
  // grouped into mailboxes and categories, so the buttons are grandchildren.
  // Reading `children` here silently returned two wrapper divs and killed
  // arrow navigation entirely.
  const items = [...el.cats.querySelectorAll('.cat')];
  const i = items.indexOf(document.activeElement);
  if (i === -1) return;
  let next = -1;
  if (e.key === 'ArrowDown') next = (i + 1) % items.length;
  else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else return;
  e.preventDefault();
  // Move focus without selecting. Selecting on arrow would fire a render per
  // keypress and fight the user as they scan for the category they want.
  items[i].tabIndex = -1;
  items[next].tabIndex = 0;
  items[next].focus();
});

el.cats.addEventListener('click', (e) => {
  const b = e.target.closest('.cat');
  if (!b) return;
  if (b.dataset.mailbox) selectMailbox(b.dataset.mailbox);
  else selectCategory(b.dataset.cat);
});

/*
 * Right-click a category to mute or auto-archive it.
 *
 * This is the feature Gmail structurally cannot offer: it does not know what
 * "Ext Promotions" or "Clubs" means. Reached by context menu because it is a
 * per-category setting, and the category button is the obvious place to look
 * for it -- but it is also in the command palette, so it is not mouse-only.
 */
el.cats.addEventListener('contextmenu', (e) => {
  const b = e.target.closest('.cat[data-cat]');
  if (!b || b.dataset.cat === 'all') return;
  e.preventDefault();
  openCategoryMenu(b.dataset.cat, b);
});

/**
 * Switch category, clearing any active search.
 *
 * Leaving the search box populated while switching category silently
 * double-filters: the user clicks "Library", sees nothing, and has no
 * indication that a stale query from two minutes ago is still applied. The
 * visible control must match the applied state.
 */
function selectCategory(key) {
  state.category = key;
  if (state.query) {
    state.query = '';
    el.search.value = '';
  }
  el.scroller.scrollTop = 0;
  renderList();
  renderSidebar();
  // Clearing the query also clears whichever saved view was active. Leaving it
  // highlighted would claim a filter is applied when it is not.
  renderViews();
  updateSaveAffordance();
}

/**
 * Switch mailbox.
 *
 * Each mailbox keeps its own store, so coming back to the inbox is instant and
 * does not refetch. A mailbox is loaded lazily the first time it is opened;
 * after that it is refreshed only on demand, because Sent and Trash do not
 * change behind your back the way an inbox does.
 */
async function selectMailbox(id) {
  if (!isMailbox(id) || id === state.mailbox) return;

  const mb = getMailbox(id);
  state.mailbox = id;
  store = wireStore(id);
  // Category is an inbox-only concept; entering Sent with `category:library`
  // still applied would show an empty list for no visible reason.
  state.category = 'all';
  state.query = '';
  el.search.value = '';
  state.selected = null;
  selection.clear();

  closeReader();
  nodeById.clear();
  renderedIds = [];
  el.list.replaceChildren();

  // The category rail only makes sense where messages are classified.
  const catGroup = $('cat-group');
  if (catGroup) catGroup.hidden = !showsCategories(id);

  el.scroller.scrollTop = 0;
  state.nextPageToken = mbState(id).nextPageToken;
  renderList();
  renderSidebar();
  renderSelection();
  syncContextActions(null);

  // Signed-out means no fetching. `state.signedIn` was written in three
  // places and READ NOWHERE, so clicking a mailbox behind the sign-in gate
  // still issued a SYNC_PAGE and repainted the previous account's mail.
  if (state.signedIn && !mbState(id).loaded) await loadMailboxPage(id, '');
}

/** Fetch one page of a non-inbox mailbox. */
async function loadMailboxPage(id, pageToken = '') {
  const mb = getMailbox(id);

  /*
   * LOADING IS PER-MAILBOX, NOT GLOBAL.
   *
   * THIS WAS A BUG, and a permanent one. The guard used to be the global
   * `state.loading`, so switching to Sent and then immediately to Trash while
   * Sent was still in flight made Trash's load return early. Nothing retried
   * it, and because `selectMailbox` only loads `if (!mbState(id).loaded)`,
   * re-clicking Trash later did nothing either: the mailbox stayed
   * permanently empty for the rest of the session, with no error and no
   * spinner. Reproduced with a 120ms response delay.
   *
   * The invariant that failed: "only one request may be in flight" was
   * enforced with a flag whose scope did not match the thing being loaded.
   * The flag is now per-mailbox, so two different mailboxes can load
   * concurrently while the same mailbox still cannot be double-fetched.
   */
  const ms = mbState(id);
  if (!state.signedIn) return; // never fetch for a session that has ended
  if (ms.loading) return;
  ms.loading = true;
  syncBusy();
  try {
    const opts = { pageToken, max: PAGE, anchorHistory: id === 'inbox' };
    // Our snoozed label is addressed by name; Gmail's own labels by id.
    if (mb.byLabelName) opts.labelName = mb.labelIds[0];
    else opts.labelIds = mb.labelIds;

    const { messages, nextPageToken } = await send('SYNC_PAGE', { opts });
    ingestInto(id, messages, mb.classified);
    mbState(id).nextPageToken = nextPageToken || '';
    mbState(id).loaded = true;
    if (state.mailbox === id) {
      state.nextPageToken = mbState(id).nextPageToken;
      $('btn-more').disabled = !mbState(id).nextPageToken;
      renderList();
      renderSidebar();
    }
  } catch (err) {
    reportError(err);
  } finally {
    ms.loading = false;
    syncBusy();
  }
}

el.rAttachments.addEventListener('click', (e) => {
  const chip = e.target.closest('.att-chip');
  if (chip) downloadAttachment(chip);
});

$('r-actions').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || !state.selected) return;
  // Snooze opens a picker instead of acting immediately, so it is not an
  // `act()` verb.
  if (b.dataset.act === 'snooze') {
    openSnoozeMenu(state.selected, b);
    return;
  }
  act(b.dataset.act, state.selected);
});

// Search: debounced by ONE frame, not by a timer. Typing feels instant and
// still costs at most one render per frame.
let searchFrame = 0;
el.search.addEventListener('input', () => {
  if (searchFrame) return;
  searchFrame = requestAnimationFrame(() => {
    searchFrame = 0;
    state.query = el.search.value;
    el.scroller.scrollTop = 0;
    renderList();
    renderViews();
    updateSaveAffordance();
    scheduleServerSearch();
  });
});

/* ========================================================================== *
 * SERVER SEARCH FALLBACK
 * ========================================================================== */

/**
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
 */
const SERVER_SEARCH_MS = 420;
const SERVER_SEARCH_MIN = 3;
let serverSearchTimer = 0;
let serverSearchToken = 0;

function scheduleServerSearch() {
  clearTimeout(serverSearchTimer);
  const q = state.query.trim();

  // Nothing typed, or too short to be worth a round trip.
  if (q.length < SERVER_SEARCH_MIN) {
    serverSearchToken++; // cancel anything in flight
    setSearchNote('');
    return;
  }
  // Only the inbox has a local index worth supplementing; other mailboxes are
  // already fetched in full.
  if (state.mailbox !== 'inbox') return;

  serverSearchTimer = setTimeout(runServerSearch, SERVER_SEARCH_MS);
}

async function runServerSearch() {
  const q = state.query.trim();
  const token = ++serverSearchToken;
  const before = new Set(visibleIds());

  setSearchNote('Searching all mail…');
  try {
    const { messages } = await send('SYNC_PAGE', {
      // `q` goes to Gmail verbatim: its operator syntax is a superset of ours,
      // so `from:x report` means the same thing on both sides.
      opts: { q, max: 40, anchorHistory: false },
    });

    // A newer keystroke has superseded this request. Dropping the response is
    // what stops results from an old query flashing over a newer one.
    if (token !== serverSearchToken) return;

    const fresh = messages.filter((m) => !before.has(m.id));
    if (!fresh.length) {
      setSearchNote(before.size ? '' : 'No matches in your mail.');
      return;
    }

    // Merged into the inbox store so they render, sort and open exactly like
    // any other message. They carry `fromSearch` so a later refresh can tell
    // them apart from genuine inbox mail.
    ingest(fresh.map((m) => ({ ...m, fromSearch: true })));
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
  setText(note, text);
  note.hidden = !text;
}

/**
 * Offer to keep the current search.
 *
 * Shown only when a query is active and is not already saved. An always-
 * present "save" button on an empty search box is noise, and offering to save
 * something already saved is a small lie about what the button will do.
 */
/**
 * A sensible default name, so the user is confirming rather than composing.
 *
 * `is:unread category:augsd` becomes "Unread AUGSD" — a blank prompt makes the
 * user do work the query has already described.
 */
function suggestViewName(q) {
  const parsed = parseQuery(q);
  const bits = [];
  for (const o of parsed.operators) {
    if (o.key === 'is' || o.key === 'has') bits.push(cap(o.value));
    else if (o.key === 'category') bits.push(CATEGORY_LABELS[o.value] || cap(o.value));
    else if (o.key === 'from') bits.push(`From ${o.value}`);
  }
  if (parsed.terms.length) bits.push(`"${parsed.terms.join(' ')}"`);
  return bits.join(' ').slice(0, 40) || q.slice(0, 40);
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function updateSaveAffordance() {
  const btn = $('btn-save-view');
  if (!btn) return;
  const q = state.query.trim();
  const known = savedViews.some((v) => v.query === q);
  btn.hidden = !q || known;
}

$('btn-refresh').addEventListener('click', () => refresh());
el.helpClose?.addEventListener('click', closeHelp);
// Clicking the backdrop closes, clicking the panel does not.
el.help?.addEventListener('mousedown', (e) => {
  if (e.target === el.help) closeHelp();
});
$('btn-more').addEventListener('click', () => {
  // Route to whichever mailbox is showing; loadPage() is inbox-specific.
  if (state.mailbox === 'inbox') loadPage(state.nextPageToken);
  else loadMailboxPage(state.mailbox, mbState(state.mailbox).nextPageToken);
});
$('btn-gmail').addEventListener('click', release);
$('btn-signout').addEventListener('click', async () => {
  await send('SIGN_OUT').catch(() => {});
  // Signing out must leave nothing of this ACCOUNT behind — not just the
  // mailbox on screen. `allMailboxes` clears every store, because Sent, Trash
  // and the rest stayed fully populated in memory and were one click away
  // after the gate appeared.
  await clearCache();
  resetView({ allMailboxes: true });
  state.signedIn = false;
  // A signed-out app that keeps polling is a privacy problem, not just a bug.
  stopAutoRefresh();
  showGate('Signed out.');
});
$('btn-signin').addEventListener('click', doSignIn);
$('btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
// ------------------------------------------------------------------ theme --

/**
 * Theme picker.
 *
 * Was a binary light/dark toggle. Six themes need a menu, and a menu needs to
 * show the swatch beside the name -- which is why this is a real menu and not
 * a <select>, which cannot render one.
 *
 * Built once, on first open, rather than at boot: most sessions never touch it.
 */
let themeMenuBuilt = false;

function buildThemeMenu() {
  if (themeMenuBuilt) return;
  themeMenuBuilt = true;
  const frag = document.createDocumentFragment();
  for (const t of THEMES) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'theme-item';
    item.dataset.theme = t.id;
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(state.theme === t.id));

    const dot = document.createElement('span');
    dot.className = 'theme-dot';
    dot.style.background = t.swatch;

    const name = document.createElement('span');
    name.className = 'theme-name';
    name.textContent = t.name;

    const tick = document.createElement('span');
    tick.className = 'theme-tick';
    tick.setAttribute('aria-hidden', 'true');
    tick.appendChild(icon('check', { size: 14 }));

    item.append(dot, name, tick);
    frag.appendChild(item);
  }
  el.themeMenu.replaceChildren(frag);
}

function setTheme(id) {
  const theme = applyTheme(id);
  state.theme = theme.id;
  /*
   * Through the settings module, not straight to storage.
   *
   * `theme` is declared in the settings schema, but this wrote it directly
   * and `start()` read it directly — so the schema entry was decorative and
   * there were two writers for one concept. Coercion, defaults and the
   * subscriber notification all lived in a module nothing was calling for
   * this key.
   */
  settings.set('theme', theme.id);
  for (const item of el.themeMenu.children) {
    item.setAttribute('aria-checked', String(item.dataset.theme === theme.id));
  }
  // Re-render the open message. The body iframe is a separate document with
  // its own colours baked into srcdoc, so it cannot follow a variable change.
  // Cheap: the body is already in memory, no refetch.
  if (state.selected && lastBody) el.rBody.srcdoc = renderBody(lastBody);
}

/** The open theme-menu layer, or null. */
let themeLayer = null;

function openThemeMenu() {
  if (themeLayer) return;
  buildThemeMenu();
  el.themeMenu.hidden = false;
  $('btn-theme').setAttribute('aria-expanded', 'true');
  themeLayer = openLayer({
    name: 'theme',
    node: el.themeMenu,
    dismissOnOutsideClick: true,
    // Focus returns to the button that opened it, which is what a menu should
    // do and what the old `restoreFocus` flag did by hand at each call site.
    restoreFocusTo: $('btn-theme'),
    onClose: () => {
      el.themeMenu.hidden = true;
      $('btn-theme').setAttribute('aria-expanded', 'false');
      themeLayer = null;
    },
  });
  const current =
    el.themeMenu.querySelector('[aria-checked="true"]') || el.themeMenu.firstElementChild;
  current?.focus();
}

/*
 * `restoreFocus` is gone: the layer always restores to the trigger. The flag
 * existed because focus handling was the caller's job; now it is not, and
 * every call site wanted `true` anyway except the outside-click path, which
 * the primitive handles.
 */
function closeThemeMenu() {
  themeLayer?.close();
}

$('btn-theme').addEventListener('click', (e) => {
  e.stopPropagation();
  themeLayer ? closeThemeMenu() : openThemeMenu();
});

el.themeMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.theme-item');
  if (!item) return;
  setTheme(item.dataset.theme);
  closeThemeMenu();
});

// Arrow keys inside the menu, as a menu is expected to behave.
el.themeMenu.addEventListener('keydown', (e) => {
  const items = [...el.themeMenu.children];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    items[e.key === 'Home' ? 0 : items.length - 1].focus();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeThemeMenu();
  }
});

/*
 * Outside-click dismissal is the layer primitive's job now.
 *
 * This document-level `click` listener was the theme menu's own copy of a
 * mechanism two other overlays also hand-rolled. Keeping it would mean two
 * dismissal paths for one menu, firing on different events (`click` here,
 * `mousedown` in the primitive) — which is how a menu ends up closing before
 * the click that was meant to land inside it.
 */

async function doSignIn() {
  const btn = $('btn-signin');
  btn.disabled = true;
  btn.textContent = 'Opening Google…';
  try {
    await send('SIGN_IN');
    state.signedIn = true;
    hideGate();
    await start();
  } catch (err) {
    showGate(String(err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in with Google';
  }
}

// ------------------------------------------------------------ category rules --

/*
 * The category and snooze menus now share one primitive, which owns the single
 * open handle. These remain as named closers so the call sites (and the
 * Escape ladder's expectations) read the same as before.
 */
function closeCategoryMenu() {
  closeMenu();
}

/**
 * Per-category triage menu.
 *
 * Mute and auto-archive are presented as a pair with clearly different
 * strengths, and the copy says what each one actually does. "Mute" in most
 * clients is vague; here it means "hide from the inbox list", and saying so
 * is the difference between a feature people use and one they are scared of.
 */

/**
 * "This is in the wrong category."
 *
 * THE WRITE SIDE OF THE CLASSIFIER, which did not exist. `correctSender` and
 * `clearCorrection` were both implemented, both tested, and called from
 * nowhere -- while `applyCorrection` ran on every ingest. The product
 * faithfully applied a correction store no user could write to.
 *
 * The correction is keyed by SENDER, not by message. One wrong bucket is
 * almost always a whole mailing list in the wrong bucket, and asking the user
 * to fix each message individually is asking them to do the classifier's job.
 * That is also why the rest of the product picks it up immediately: the
 * corrections map is consulted on ingest, so re-ingesting what is in memory
 * re-files everything from that sender at once.
 */
function openRecategoriseMenu(msg, anchor) {
  const current = msg.category;
  const taught = Object.prototype.hasOwnProperty.call(
    rules.corrections || {}, addressOf(msg.from)
  );

  const items = [];

  /*
   * Offered FIRST when a correction exists, because undoing a mistake is more
   * urgent than making another one. clearCorrection was referenced nowhere in
   * the app before this menu existed -- teaching a classifier something wrong
   * and being unable to un-teach it is worse than not teaching it at all.
   */
  if (taught) {
    items.push({
      text: 'Use the automatic category',
      hint: 'Forget what I taught you about this sender.',
      run: async () => {
        rules = clearCorrection(rules, msg.from);
        await saveRules(rules);
        reclassifyAll();
        toast('Back to the automatic category');
      },
    });
  }

  for (const cat of SIDEBAR_ORDER) {
    if (cat === current) continue;
    items.push({
      text: CATEGORY_LABELS[cat] || cat,
      hint: `File mail from ${displayName(msg.from)} here.`,
      run: async () => {
        rules = correctSender(rules, msg.from, cat);
        await saveRules(rules);
        reclassifyAll();
        toast(`${displayName(msg.from)} now files under ${CATEGORY_LABELS[cat] || cat}`);
      },
    });
  }

  openMenu({
    name: 'category-menu',
    label: 'Move to a different category',
    anchor,
    className: 'cat-menu',
    items,
  });
}

/**
 * Re-file everything already in memory against the current corrections.
 *
 * A correction is about a SENDER, so it must apply to the mail already on
 * screen -- not only to whatever arrives next. Re-ingesting is cheap (the
 * classifier is 10.7ms for 2000 messages) and it reuses the one code path
 * that knows how corrections, categories and deadlines fit together.
 */
function reclassifyAll() {
  const all = store.idsFor('all').map((id) => store.get(id)).filter(Boolean);
  if (all.length) ingest(all);
  renderList();
  renderSidebar();
  const open = state.selected && store.get(state.selected);
  if (open) syncContextActions(open);
}

function openCategoryMenu(category, anchor) {
  const label = CATEGORY_LABELS[category] || category;

  openMenu({
    name: 'category-menu',
    label: `${label} rules`,
    anchor,
    className: 'cat-menu',
    items: [
      {
        text: `Mute ${label}`,
        hint: 'Hide from the inbox list. Still searchable, nothing deleted.',
        checked: isMuted(rules, category),
        trailing: isMuted(rules, category) ? 'On' : '',
        run: async () => {
          rules = toggleMute(rules, category);
          await saveRules(rules);
          renderList();
          renderSidebar();
          toast(isMuted(rules, category) ? `${label} muted` : `${label} unmuted`);
        },
      },
      {
        text: `Auto-archive ${label}`,
        hint: 'Archive new mail in this category as it arrives.',
        checked: isAutoArchived(rules, category),
        trailing: isAutoArchived(rules, category) ? 'On' : '',
        run: async () => {
          rules = toggleAutoArchive(rules, category);
          await saveRules(rules);
          renderSidebar();
          toast(
            isAutoArchived(rules, category)
              ? `New ${label} mail will be archived`
              : `Auto-archive off for ${label}`
          );
        },
      },
    ],
  });
}

// ----------------------------------------------------------------- snooze --

/**
 * The snooze picker.
 *
 * A small menu rather than a date-time control. Snoozing is a fast, frequent,
 * low-precision decision -- "not now, later" -- and a calendar widget turns a
 * one-keystroke action into a form. Gmail reached the same conclusion.
 *
 * Rendered on demand and torn down on dismiss, so there is no persistent menu
 * in the DOM listening for clicks.
 */
function closeSnoozeMenu() {
  closeMenu();
}

function openSnoozeMenu(id, anchor) {
  const m = store.get(id);
  if (!m) return;

  // The deadline the radar already parsed feeds an option Gmail cannot offer.
  let deadline;
  try {
    deadline = extractDeadline(m)?.at;
  } catch {
    deadline = undefined;
  }

  openMenu({
    name: 'snooze-menu',
    label: 'Snooze until',
    anchor,
    // Hangs off the reader's action bar rather than the row, so the menu is
    // not clipped by the list's overflow.
    mountTo: anchor?.closest('#r-actions') || el.reader || document.body,
    items: snoozePresets(Date.now(), { deadline }).map((opt) => ({
      text: opt.label,
      trailing: new Date(opt.at).toLocaleString(undefined, {
        weekday: 'short', hour: 'numeric', minute: '2-digit',
      }),
      run: () => snoozeMessage(id, opt.at, opt.label),
    })),
  });
}

// ------------------------------------------------------------------- help --

/**
 * Keyboard help overlay.
 *
 * Focus is moved INTO the dialog and restored to wherever it came from on
 * close. Skipping the restore is the classic modal bug: the user presses `?`,
 * reads, presses Escape, and their next `j` goes nowhere because focus is on
 * `<body>`.
 */
/** The open help layer, or null. Lifecycle belongs to layers.js. */
let helpLayer = null;

/** Pending `g` prefix for the two-key category jump. Expires; see the handler. */
let goPending = null;

/*
 * The first overlay migrated onto the layer stack.
 *
 * Focus capture and restoration used to be hand-rolled here (and separately in
 * three other overlays). The primitive owns both now, so this function is
 * reduced to what is actually specific to help: render the shortcut table,
 * reveal the node, move focus in.
 */
function openHelp() {
  if (!el.help || helpLayer) return;
  renderShortcuts(el.helpBody, document);
  el.help.hidden = false;
  helpLayer = openLayer({
    name: 'help',
    node: el.help,
    onClose: () => {
      el.help.hidden = true;
      helpLayer = null;
    },
  });
  el.helpClose.focus();
}

function closeHelp() {
  helpLayer?.close();
}

/** Hand the page back to Gmail. The content script does the actual unwind. */
function release() {
  // Flush before the frame is destroyed, so triage done in this session is on
  // disk for the next one.
  saver.flush();
  flushDraft();
  cancelPendingWork();
  parent.postMessage({ type: 'BMM_RELEASE' }, '*');
}

// Keyboard. Gmail-compatible where it makes sense, so muscle memory survives.
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);

  if (e.key === 'Escape') {
    /*
     * UNWIND THE LAYER STACK, then the fixed surfaces beneath it.
     *
     * This used to be a nine-branch ladder whose correctness depended on the
     * ORDER THE `if`s WERE WRITTEN IN. Every new overlay had to be inserted at
     * the right depth, and nothing enforced it — the ordering was prose in a
     * comment. It was the only place in this codebase where behaviour hinged
     * on statement order rather than on data.
     *
     * `closeTopLayer()` pops whatever was opened last, which is exactly what
     * "innermost first" means. Overlays no longer need to know about each
     * other, and a fifth one needs no change here at all.
     *
     * Below the stack sit surfaces that are not layers because they are not
     * dismissable overlays: the palette and compose own their own visibility,
     * selection is transient state, and the reader and the takeover are the
     * app itself.
     */
    if (closeTopLayer()) return;

    if (!$('palette').hidden) {
      closePalette();
      return;
    }
    if (!$('compose').hidden) {
      $('compose-close').click();
      return;
    }
    // Selection is transient state, so it unwinds before the reader.
    if (selection.active) {
      selection.clear();
      renderSelection();
      return;
    }
    if (typing) {
      el.search.blur();
      return;
    }
    if (state.selected) return closeReader();
    return release();
  }
  // Ctrl/Cmd combinations are handled BEFORE the modifier guard below, which
  // exists to let browser shortcuts through. These two are ours.
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openPalette(ctx);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'a' && !typing) {
    // Select-all inside the list only. Outside it, the browser's own
    // select-all is what the user meant.
    e.preventDefault();
    selection.selectAll(renderedIds);
    renderSelection();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    performUndo(ctx);
    return;
  }

  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

  /*
   * `?` is Shift+/ on most layouts, so it must be handled BEFORE the shift
   * block below returns early. Checking `e.key` rather than the physical key
   * means it also works on layouts where ? is unshifted.
   */
  if (e.key === '?') {
    e.preventDefault();
    if (helpLayer) closeHelp();
    else openHelp();
    return;
  }

  // While help is open, swallow the single-letter shortcuts. Acting on a
  // message the user cannot see is the worst kind of surprise.
  if (helpLayer) return;

  /*
   * `g` then a digit jumps to a category — Gmail's two-key "go to" idiom.
   *
   * The pending state EXPIRES. Without a timeout, a `g` pressed and abandoned
   * turns the next unrelated keystroke into a navigation, which feels like
   * the app acting on its own. Gmail uses roughly a second; so do we.
   */
  if (goPending) {
    clearTimeout(goPending.timer);
    goPending = null;
    const n = Number(e.key);
    if (Number.isInteger(n)) {
      e.preventDefault();
      // 0 is "all", then the sidebar order as displayed.
      const key = n === 0 ? 'all' : SIDEBAR_ORDER[n - 1];
      if (key) {
        selectCategory(key);
        toast(`${key === 'all' ? 'All mail' : CATEGORY_LABELS[key] || key}`);
      }
      return;
    }
    // Not a digit: fall through and treat it as a normal shortcut.
  }
  if (e.key === 'g') {
    e.preventDefault();
    goPending = { timer: setTimeout(() => { goPending = null; }, 1200) };
    return;
  }

  // Shift shortcuts for reply. Checked before the plain-key switch so that
  // Shift+R is not swallowed by the `r` = refresh case.
  if (e.shiftKey) {
    const k = e.key.toLowerCase();
    if (k === 'r' && state.selected) { e.preventDefault(); startReply(ctx, 'reply'); return; }
    if (k === 'a' && state.selected) { e.preventDefault(); startReply(ctx, 'replyAll'); return; }
    if (k === 'f' && state.selected) { e.preventDefault(); startReply(ctx, 'forward'); return; }
    return;
  }

  switch (e.key) {
    case '/':
      e.preventDefault();
      el.search.focus();
      el.search.select();
      break;
    case 'j':
      move(1);
      break;
    case 'k':
      move(-1);
      break;
    case 'Enter':
      if (state.selected) openMessage(state.selected);
      break;
    case 'e':
      if (state.selected) act('archive', state.selected);
      break;
    case 's':
      if (state.selected) act('star', state.selected);
      break;
    case 'u':
      if (state.selected) act('unread', state.selected);
      break;
    case '#':
      if (state.selected) act('trash', state.selected);
      break;
    // Gmail's own binding for report-spam, so the muscle memory carries over.
    // In the Spam mailbox it rescues instead -- see act('spam').
    case '!':
      if (state.selected) act('spam', state.selected);
      break;
    case 'r':
      refresh();
      break;
    case 'z':
      // Gmail's snooze key. Opens the picker rather than choosing for you.
      if (state.selected) {
        e.preventDefault();
        openSnoozeMenu(state.selected, document.querySelector('[data-act="snooze"]'));
      }
      break;
    case 'c':
      e.preventDefault();
      openCompose(ctx);
      break;
    case 'x': {
      // Gmail's shortcut for "tick this row", and the keyboard path into bulk
      // mode. Operates on the row under the cursor keys, not the mouse.
      e.preventDefault();
      const target = state.selected || renderedIds[0];
      if (target) {
        selection.toggle(target);
        renderSelection();
      }
      break;
    }
  }
});

function move(delta) {
  if (renderedIds.length === 0) return;
  const i = state.selected ? renderedIds.indexOf(state.selected) : -1;
  const next = renderedIds[Math.max(0, Math.min(renderedIds.length - 1, i + delta))];
  if (!next || next === state.selected) return;
  openMessage(next);

  // Feature-detected rather than assumed.
  //
  // scrollIntoView exists in every real browser, so this is not defending
  // against a browser gap -- it is defending against the fact that an
  // exception thrown HERE aborts the whole keydown handler. A missing scroll
  // is cosmetic; a dead j/k key is not, and coupling the two is the bug.
  const node = nodeById.get(next);
  if (typeof node?.scrollIntoView === 'function') {
    node.scrollIntoView({ block: 'nearest' });
  }
}

// The content script pings us when the takeover is fully visible. Focus lands
// here so keyboard shortcuts work without a click.
window.addEventListener('message', (e) => {
  // Source-checked, like the content script's two listeners. Without this any
  // frame holding a handle to this window could post BMM_SHOWN and pull focus
  // into the message list. Low impact on its own -- but two of the three
  // listeners in this extension were hardened and this one was missed, which
  // means the pattern was not actually enforced anywhere.
  if (e.source !== parent) return;
  if (e.data?.type === 'BMM_SHOWN') el.list.focus({ preventScroll: true });
});

/**
 * Reveal the contextual actions, and keep the star reflecting reality.
 *
 * The star has to show the CURRENT state of the open message, or the user
 * cannot tell whether pressing it will star or unstar.
 */
function syncContextActions(m) {
  /*
   * The action bar depends on the MAILBOX, not only on the message, so it is
   * refreshed before the early return below.
   *
   * This was a real bug: `syncReaderActions()` sat after `if (!m) return`, so
   * switching to Trash -- which deselects -- never re-evaluated which actions
   * apply. "Archive" stayed visible on a deleted message until something else
   * happened to select a row.
   */
  syncReaderActions();

  const wrap = $('ctx-actions');
  if (!wrap) return;
  wrap.hidden = !m;
  if (!m) return;
  const star = $('ctx-star');
  setIcon(star, 'star', { size: 15, filled: !!m.starred });
  star.setAttribute('aria-label', m.starred ? 'Unstar' : 'Star');
  star.setAttribute('aria-pressed', String(!!m.starred));
}

/**
 * Show only the actions that mean something in this mailbox.
 *
 * "Archive" in Trash does nothing useful, and "Delete" on an already-deleted
 * message is a control that lies about what it will do. Dead controls are how
 * a UI teaches people not to trust it.
 */
function syncReaderActions() {
  const allowed = actionsFor(state.mailbox);
  const bar = $('r-actions');
  if (!bar) return;
  for (const btn of bar.querySelectorAll('button[data-act]')) {
    const act = btn.dataset.act;
    // `unread` is always available; the rest are mailbox-dependent.
    btn.hidden = act in allowed ? !allowed[act] : false;
  }

  /*
   * The spam control is one button with two meanings, resolved by mailbox.
   * "Report spam" on something already in Spam is a control that lies about
   * what it will do, and a second button for the inverse would make the user
   * choose between two things they think of as one.
   */
  const spamBtn = bar.querySelector('button[data-act="spam"]');
  if (spamBtn) {
    const rescuing = Boolean(allowed.notSpam);
    spamBtn.textContent = rescuing ? 'Not spam' : 'Report spam';
    spamBtn.title = rescuing ? 'Move back to the inbox (!)' : 'Report spam (!)';
  }
}

/* ======================================================================== *
 * SAVED VIEWS
 * ======================================================================== */

let savedViews = [];

/**
 * Render the saved-view list with live counts.
 *
 * Counts make a saved view genuinely useful rather than a bookmark — but each
 * one is a full query, so this runs only on a SETTLED store change, never per
 * keystroke. That is the same discipline the render loop follows.
 */
function renderViews() {
  if (!el.viewsList) return;
  const frag = document.createDocumentFragment();

  for (const v of savedViews) {
    const li = document.createElement('li');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'view-item';
    btn.dataset.viewId = v.id;
    btn.dataset.query = v.query;
    btn.title = v.query;
    btn.setAttribute('aria-current', String(state.query === v.query));

    const ico = document.createElement('span');
    ico.className = 'view-icon';
    ico.appendChild(icon(v.icon || 'search', { size: 14 }));

    const name = document.createElement('span');
    name.className = 'view-name';
    name.textContent = v.name;

    const count = document.createElement('span');
    count.className = 'view-count';
    const n = countFor(v.query);
    count.textContent = n ? String(n) : '';

    const del = document.createElement('span');
    del.className = 'view-remove';
    del.dataset.removeView = v.id;
    del.setAttribute('role', 'button');
    del.setAttribute('tabindex', '-1');
    del.setAttribute('aria-label', `Remove view ${v.name}`);
    del.appendChild(icon('close', { size: 12 }));

    btn.append(ico, name, count, del);
    li.appendChild(btn);
    frag.appendChild(li);
  }
  el.viewsList.replaceChildren(frag);
}

/** How many messages a saved query currently matches. */
function countFor(query) {
  try {
    const parsed = parseQuery(query);
    const base = parsed.terms.length
      ? store.search(parsed.terms.join(' '), 'all')
      : store.idsFor('all');
    if (!parsed.predicate) return base.length;
    let n = 0;
    for (const id of base) {
      const m = store.get(id);
      if (m && parsed.predicate(m)) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

async function refreshViews() {
  savedViews = await loadViews();
  renderViews();
}

/* ======================================================================== *
 * BULK SELECTION
 * ======================================================================== */

/**
 * Reflect selection into the DOM.
 *
 * Touches only the checkbox state and one class per row, so it is cheap enough
 * to call on every selection change without going through the render loop --
 * selection does not alter WHICH rows exist, only how they look.
 */
/**
 * The messages the current selection stands for.
 *
 * With threading on, a tick on a collapsed row means the whole conversation --
 * archiving one reply and leaving two behind is the most confusing thing a
 * threaded client can do, because the row appears to survive the action.
 */
function selectedMessageIds() {
  return settings.get('threaded')
    ? selection.liveThreaded(store, renderedIds)
    : selection.live(store, renderedIds);
}

function renderSelection() {
  const threaded = settings.get('threaded');
  const ids = selectedMessageIds();
  const n = ids.length;
  el.bulkbar.hidden = n === 0;
  el.listhead.hidden = n > 0;

  for (const [id, node] of nodeById) {
    /*
     * A row reads as ticked when ANY message in its conversation is. A reply
     * arriving replaces the rendered root, and without this the tick the user
     * placed silently disappears with the row it was attached to.
     */
    const on = threaded ? selection.hasThread(store, id) : selection.has(id);
    if (node.classList.contains('picked') !== on) node.classList.toggle('picked', on);
    const box = node.querySelector('.r-check');
    if (box && box.checked !== on) box.checked = on;
  }

  if (n === 0) return;
  el.bulkCount.textContent = selectionLabel(n);

  // Tri-state "select all": checked when everything visible is picked,
  // indeterminate when only some is. A plain checkbox that reads "checked"
  // while half the list is selected is a lie.
  const visible = renderedIds.length;
  const picked = renderedIds.filter((id) => selection.has(id)).length;
  el.bulkAll.checked = picked === visible && visible > 0;
  el.bulkAll.indeterminate = picked > 0 && picked < visible;
}

/**
 * Run one action across the whole selection.
 *
 * ONE Gmail request, ONE store batch, ONE undo entry. Archiving forty messages
 * must undo as a single step -- forty separate undos would be unusable, and it
 * is precisely why UndoStack stores a thunk rather than a diff.
 */
/**
 * Apply one action to many messages.
 *
 * `explicitIds` lets a single-row action on a collapsed conversation reuse
 * this path rather than reimplementing batching, rollback and undo. Defaults
 * to the current selection, which is every other caller.
 */
async function bulkAct(kind, explicitIds = null) {
  const ids = explicitIds || selectedMessageIds();
  if (ids.length === 0) return;

  // Snapshot BEFORE mutating, for the undo.
  const snapshots = ids.map((id) => ({ ...store.get(id) }));
  const n = ids.length;
  const noun = n === 1 ? 'message' : 'messages';

  const removal = kind === 'archive' || kind === 'trash' || kind === 'spam';
  if (removal && state.selected && ids.includes(state.selected)) closeReader();

  store.batch(() => {
    for (const id of ids) {
      if (kind === 'archive' || kind === 'trash' || kind === 'spam') store.remove(id);
      else if (kind === 'read') store.patch(id, { unread: false });
      else if (kind === 'star') store.patch(id, { starred: true });
    }
  });
  // Only when acting on a selection: a conversation action from the reader
  // has not touched the ticks and must not silently discard them.
  if (!explicitIds) {
    selection.clear();
    renderSelection();
  }

  const verb = {
    archive: 'Archived', trash: 'Deleted', read: 'Marked read',
    star: 'Starred', spam: 'Reported',
  }[kind];

  try {
    if (kind === 'archive') await send('BULK', { ids, remove: ['INBOX'] });
    else if (kind === 'trash') await send('BULK', { ids, add: ['TRASH'], remove: ['INBOX'] });
    else if (kind === 'read') await send('BULK', { ids, remove: ['UNREAD'] });
    else if (kind === 'star') await send('BULK', { ids, add: ['STARRED'] });
    // Junk arrives in batches, so reporting it one message at a time is
    // exactly the friction this product exists to remove.
    else if (kind === 'spam') await send('BULK', { ids, add: ['SPAM'], remove: ['INBOX'] });
  } catch (err) {
    // Roll the whole batch back. A partial apply would leave the list
    // disagreeing with Gmail with no indication which half won.
    store.batch(() => {
      for (const m of snapshots) store.upsert(m);
    });
    toast(`Could not ${kind}: ${err.message}`, { kind: 'error' });
    return;
  }

  recordUndo(ctx, `${verb} ${n} ${noun}`, async () => {
    store.batch(() => {
      for (const m of snapshots) store.upsert(m);
    });
    if (kind === 'archive') await send('BULK', { ids, add: ['INBOX'] });
    else if (kind === 'trash') await send('BULK', { ids, add: ['INBOX'], remove: ['TRASH'] });
    else if (kind === 'read') await send('BULK', { ids, add: ['UNREAD'] });
    else if (kind === 'star') await send('BULK', { ids, remove: ['STARRED'] });
    else if (kind === 'spam') await send('BULK', { ids, add: ['INBOX'], remove: ['SPAM'] });
  });
}

/** Prepend an icon to a labelled button, preserving its text. */
function decorate(id, name) {
  const el = $(id);
  if (!el) return;
  el.prepend(icon(name, { size: 15 }));
}

/**
 * A pending cache write must not be lost when the takeover closes.
 *
 * `pagehide` covers tab close and navigation; `release()` covers Esc and the
 * Back-to-Gmail button, which tear the iframe down without either firing
 * reliably.
 */
window.addEventListener('pagehide', () => {
  saver.flush();
  // A half-written message must survive the tab closing. The debounce timer
  // will never fire here, so it is flushed explicitly.
  flushDraft();
  // Cancel work that would otherwise land after the document is gone. The
  // server-search debounce is a real timer, so without this it fires into a
  // torn-down DOM and throws from a context nothing can catch.
  cancelPendingWork();
});

/**
 * Stop every pending timer and in-flight response handler.
 *
 * Called on pagehide and on release. Bumping the token is what makes an
 * already-dispatched fetch a no-op when it resolves: clearing the timer alone
 * only stops requests that have not started yet.
 */

/* ------------------------------------------------------------ auto-refresh -- */

/*
 * MAIL HAS TO ARRIVE ON ITS OWN.
 *
 * This file used to say "Delta refresh. Never on a timer." That made the
 * product a mail VIEWER: new mail appeared only when the user pressed `r` or
 * reopened the app. Audit 12 called it the single most disqualifying gap
 * against Gmail, and it is.
 *
 * A repeating timeout rather than setInterval, re-armed only AFTER each
 * refresh settles. setInterval on a network call stacks requests when the
 * network is slow -- exactly when you least want a queue of them.
 *
 * `silent: true` because the user did not ask: a toast saying "Up to date"
 * every two minutes is worse than no refresh at all. New mail announces
 * itself by appearing, and the "Updated N min ago" line already says when we
 * last spoke to Gmail.
 */
let autoRefreshTimer = 0;

function stopAutoRefresh() {
  clearTimeout(autoRefreshTimer);
  autoRefreshTimer = 0;
}

function scheduleAutoRefresh() {
  stopAutoRefresh();
  const every = settings.get('autoRefreshMs');
  // 0 disables it entirely, for anyone who wants manual control.
  if (!every || !state.signedIn) return;
  autoRefreshTimer = setTimeout(async () => {
    /*
     * Re-check BOTH conditions at fire time, not only at schedule time. A
     * sign-out between the two would otherwise leave one last request in
     * flight on behalf of an account that has left -- the same class of bug
     * as the token renewal that used to undo a sign-out.
     */
    if (!state.signedIn) return;
    if (document.hidden) {
      // Nothing to paint into. Re-arm and try later rather than spend the
      // request on a tab nobody is looking at.
      scheduleAutoRefresh();
      return;
    }
    try {
      await refresh({ silent: true });
    } catch {
      // A failed poll is not worth reporting; the next one may well work and
      // the freshness line already shows we have not heard from Gmail.
    }
    scheduleAutoRefresh();
  }, every);
}

function cancelPendingWork() {
  stopAutoRefresh();
  clearTimeout(serverSearchTimer);
  serverSearchTimer = 0;
  serverSearchToken++;
  clearTimeout(markReadTimer);
  markReadTimer = 0;
  if (searchFrame) {
    cancelAnimationFrame(searchFrame);
    searchFrame = 0;
  }
}

/**
 * Test seam.
 *
 * The render invariant -- one render per settled state, no matter how many
 * messages arrived -- is the property this whole architecture exists to
 * guarantee, and it can only be verified by driving a real ingest against a
 * real DOM. Exposing exactly one function is cheaper than exporting the module
 * graph, and it cannot be reached from a web page: this document is an
 * extension origin and is framed only by our own content script.
 */
/**
 * The surface features.js is allowed to use.
 *
 * Explicit rather than letting that module reach into this one: the render
 * invariant is only enforceable if every path into the store goes through a
 * known set of functions.
 */
const ctx = {
  /*
   * A GETTER, NOT A CAPTURED VALUE.
   *
   * THIS WAS A REAL BUG. `store` is a `let` rebound on every mailbox switch
   * (`store = wireStore(id)`), but `ctx` was built once at module load with
   * `store,` — capturing the INBOX store by value, permanently. Every consumer
   * in features.js then read the inbox no matter what the user was looking at:
   * the deadline radar scanned inbox mail while Trash was open, and contact
   * autocomplete suggested inbox senders while composing from Sent. Verified
   * by driving the real app.
   *
   * The class of error is publishing a live binding through a frozen object.
   * `state` and `el` beside it are safe because they are `const` objects
   * mutated in place — only `store` is ever REASSIGNED, and only it needs the
   * indirection. A test pins this.
   */
  get store() {
    return store;
  },
  state,
  send,
  toast,
  act,
  openMessage,
  refresh: () => refresh(),
  release: () => release(),
  setTheme: (id) => setTheme(id),
  themes: () => THEMES,
  categoryList: () => [['all', 'All mail'], ...SIDEBAR_ORDER.map((c) => [c, CATEGORY_LABELS[c] || c])],
  selectCategory,
  /*
   * Which MESSAGE the reader is showing. With threading the selected row is a
   * conversation, and the user may have stepped to an earlier message inside
   * it -- a reply must answer that one.
   */
  openMessageId: () => openPart || state.selected,
  runQuery: (q) => {
    el.search.value = q;
    state.query = q;
    el.scroller.scrollTop = 0;
    renderList();
    // The saved-view list must show WHICH view is active, and the save
    // affordance must not offer to save something already saved.
    renderViews();
    updateSaveAffordance();
  },
  // The timetable panel quotes email and offers to open it, and needs a
  // failure channel for a storage write.
  toast,
  openMessage,
};

/*
 * Test seam: is a poll actually scheduled? Needed because refresh() guards on
 * signedIn too, so request counts alone cannot tell a cancelled timer from a
 * live one that is being ignored -- and a live one is a wakeup every interval
 * for the life of the tab.
 */
window.__bmmAutoRefreshPending = () => autoRefreshTimer !== 0;
window.__bmmIngest = ingest;
// Same live-binding hazard as ctx.store: defined as a getter so a harness
// inspecting it after a mailbox switch sees the ACTIVE store, not the inbox.
Object.defineProperty(window, '__bmmStore', { get: () => store, configurable: true });
/*
 * Teardown seam.
 *
 * A harness that swaps the globals back out from under this module leaves any
 * armed timer pointing at a dead document, where it throws from a context
 * nothing can catch. Real browsers get the same cleanup via `pagehide`; tests
 * need to be able to ask for it directly.
 */
window.__bmmTeardown = cancelPendingWork;

// ------------------------------------------------------------------- start --

async function start() {
  try {
    const p = await send('PROFILE');
    el.account.textContent = p.emailAddress || '';
  } catch {
    /* not fatal; the list is what matters */
  }

  // Fire-and-forget: the palette gains the user's Gmail labels once this
  // lands, and behaves exactly as before until it does. Not awaited, because
  // nothing on screen depends on it.
  refreshLabels(ctx);

  /*
   * The timetable loads from storage and then looks at the mail we already
   * hold. Not awaited: a stored timetable is not needed to paint the inbox,
   * and a slow read must not delay first paint. Failures inside degrade to an
   * empty timetable rather than propagating.
   */
  initTimetable(ctx)
    .then(() => scanForUpdates(store.idsFor('all').map((id) => store.get(id)).filter(Boolean)))
    .catch(() => { /* the timetable is optional; the inbox is not */ });

  // Cache-first.
  //
  // If we have headers on disk, show them immediately and then ask only for
  // what changed. This is what makes the historyId cursor worth keeping: a
  // delta is meaningless without local state to apply it to, and before this
  // every open threw the messages away and full-synced regardless.
  //
  // The cache is populated inside a single store.batch(), so hydrating 500
  // messages is one notification and one render.
  const cached = await loadCache();
  if (!cached?.messages.length) setSkeleton(true);
  if (cached?.messages.length) {
    store.batch(() => {
      for (const m of cached.messages) store.upsert(withDeadline(m));
    });
    // Paint the cached list before touching the network.
    renderList();
    renderSidebar();

    const delta = await refresh({ silent: true });
    // `refresh` falls back to a full page load when the cursor has expired, so
    // there is nothing more to do unless it reported no cursor at all.
    if (delta !== 'none') return;
  }

  await loadPage('');
  setSkeleton(false);
  // Only after the inbox is on screen do we spend a request on a delta check.
  if (store.size) refresh({ silent: true });
  // From here on, mail arrives on its own.
  scheduleAutoRefresh();
}

async function boot() {
  /*
   * Settings are loaded FIRST, before anything reads one.
   *
   * `settings.get()` is synchronous by design — the render path must not
   * await a preference to decide how to draw — which means the cache has to
   * be warm before the first read. This used to load much later, so routing
   * the theme through the module would have silently returned the default on
   * every launch.
   */
  await settings.loadSettings();

  // Theme next, before anything paints, so there is no flash of the wrong
  // palette. `applyTheme` falls back to the default for an unknown id, which
  // covers the old binary 'light'/'dark' values from before the picker.
  const theme = settings.get('theme');
  state.theme = applyTheme(theme || DEFAULT_THEME).id;

  buildSidebar();
  renderSidebar();

  // Icons on the chrome.
  //
  // Text-only buttons read as a form; an icon paired with a label reads as a
  // tool. The label STAYS -- an icon alone is a guessing game, and the toolbar
  // is the first thing a new user has to understand.
  decorate('btn-compose', 'compose');
  decorate('btn-refresh', 'refresh');
  decorate('btn-gmail', 'back');
  decorate('compose-min', 'minimise');
  decorate('compose-close', 'close');

  // Contextual actions. Icon-only is acceptable HERE, unlike the toolbar
  // labels, because each carries a title, an aria-label and a keyboard hint,
  // and they mirror actions the user already met in the reader.
  setIcon($('ctx-archive'), 'archive', { size: 15 });
  setIcon($('ctx-star'), 'star', { size: 15 });
  setIcon($('ctx-trash'), 'trash', { size: 15 });
  $('ctx-actions').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !state.selected) return;
    act({ 'ctx-archive': 'archive', 'ctx-star': 'star', 'ctx-trash': 'trash' }[b.id], state.selected);
  });

  /*
   * Scroll-edge fade.
   *
   * `passive: true` matters: a non-passive scroll listener forces the browser
   * to wait and see whether the handler calls preventDefault before it can
   * scroll, which is a classic source of scroll jank. We only read a number.
   *
   * The class is toggled only when it actually changes, so a fast scroll does
   * not write to the DOM on every one of its hundred events.
   */
  let scrolledOn = false;
  el.scroller.addEventListener(
    'scroll',
    () => {
      const on = el.scroller.scrollTop > 4;
      if (on !== scrolledOn) {
        scrolledOn = on;
        el.listpane.classList.toggle('scrolled', on);
      }
    },
    { passive: true }
  );

  // Bulk bar.
  setIcon($('bulk-cancel'), 'close', { size: 14 });
  $('bulk-cancel').addEventListener('click', () => {
    selection.clear();
    renderSelection();
  });
  el.bulkAll.addEventListener('change', () => {
    if (el.bulkAll.checked) selection.selectAll(renderedIds);
    else selection.clear();
    renderSelection();
  });
  for (const [id, kind] of [
    ['bulk-read', 'read'],
    ['bulk-star', 'star'],
    ['bulk-archive', 'archive'],
    ['bulk-spam', 'spam'],
    ['bulk-trash', 'trash'],
  ]) {
    $(id).addEventListener('click', () => bulkAct(kind));
  }

  // Saved views.
  el.viewsList.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-remove-view]');
    if (rm) {
      e.stopPropagation();
      // Report a failed write. This used to assume success, so a rejected
      // storage call left the view on screen with no toast and no error.
      const res = await removeView(rm.dataset.removeView);
      await refreshViews();
      toast(res?.ok === false ? res.error : 'View removed');
      return;
    }
    const item = e.target.closest('.view-item');
    if (item) ctx.runQuery(item.dataset.query);
  });
  refreshViews();

  $('btn-save-view').addEventListener('click', async () => {
    const q = state.query.trim();
    if (!q) return;
    const name = prompt('Name this view:', suggestViewName(q));
    if (name === null) return;
    const res = await saveView(name, q);
    if (!res.ok) {
      toast(res.error);
      return;
    }
    await refreshViews();
    updateSaveAffordance();
    toast(`Saved "${res.view.name}"`, { kind: 'success' });
  });

  wirePalette(ctx);
  wireCompose(ctx);
  wireRadar(ctx);
  $('btn-compose').addEventListener('click', () => openCompose(ctx));
  $('btn-timetable')?.addEventListener('click', () => openTimetable(ctx));
  // Render the (empty) list once up front. The store only notifies when it
  // actually changes, so an inbox that syncs zero messages never triggers a
  // render at all — and the "Nothing here." state stayed hidden behind a
  // blank pane with no explanation.
  renderList();

  // Tell the content script we have painted. It waits for this before it
  // reveals the takeover, which is what prevents the white flash the old
  // separate-tab approach had.
  requestAnimationFrame(() => parent.postMessage({ type: 'BMM_READY' }, '*'));

  try {
    const { signedIn } = await send('AUTH_STATUS');
    state.signedIn = signedIn;
    if (!signedIn) return showGate('');
    hideGate();
    // Rules must be loaded BEFORE the first ingest, or the first page is
    // classified without the user's corrections and auto-archive silently
    // does not run on it.
    // Settings and rules must both be loaded before the first ingest and the
    // first reader open: a preference read after the fact is a preference the
    // user watched not apply.
    rules = await loadRules();
    await loadImageAllowList();
    await start();
    // Only after the inbox is up: an unsent message from a previous session
    // is offered back rather than silently lost.
    restoreDraftIfAny(ctx).catch(() => {});
  } catch (err) {
    showGate(String(err.message || err));
  }
}

// ------------------------------------------------------------------ format --

function displayName(from) {
  // "Aviral Gupta <f2024@pilani...>" -> "Aviral Gupta"
  const lt = from.indexOf('<');
  if (lt > 0) return from.slice(0, lt).trim().replace(/^"|"$/g, '') || from;
  return from.replace(/[<>]/g, '');
}

const DAY = 86400000;
function shortDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = Date.now();
  if (now - ms < DAY && d.getDate() === new Date(now).getDate()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (now - ms < 300 * DAY) {
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  return d.toLocaleDateString([], { year: 'numeric', month: 'short' });
}

function fullDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

boot();
