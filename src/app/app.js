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
import { icon, setIcon, middleTruncate } from './icons.js';
import { Selection, selectionLabel } from './selection.js';
import { loadViews, saveView, removeView } from './views.js';
import { extractDeadline, relativeLabel, urgency } from './deadlines.js';
import { runInPage } from './fallback.js';
import { parseQuery, buildReply } from './query.js';
import * as settings from './settings.js';
import { addressOf } from './contacts.js';
import { audienceOf } from './direct.js';
import * as activity from './activity.js';
import * as outbox from './outbox.js';
import * as suggest from './suggest.js';
import * as lanes from './lanes.js';
import * as engine from './rule-engine.js';
import * as followups from './followups.js';
import * as deadlineStore from './deadline-store.js';
import * as myCourses from './my-courses.js';
import { detectNotice, shouldPromote, summarise } from './notices.js';
import { rowSnippet } from './snippet.js';
import { renderShortcuts } from './shortcuts.js';
import { openLayer, closeTopLayer, hasLayers, closeAllLayers, closeWithMotion, cancelExit } from './layers.js';
import { openMenu, closeMenu, menuIsOpen } from './menu.js';
import {
  scheduleServerSearch, wireServerSearch, _resetServerSearch,
} from './server-search.js';
import {
  renderViews, refreshViews, suggestViewName, updateSaveAffordance, currentViews,
  wireViews, _resetViews,
} from './saved-views.js';
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
  restoreDraftIfAny, flushDraft, refreshLabels, _setLabels, editDraft, labelNames,
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
import { courseNumbersIn, isAcademicSender } from './timetable-mail.js';

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

  /*
   * The signed-in address, once PROFILE returns.
   *
   * Held in state rather than re-fetched because the ingest path stamps every
   * message with its `audience` (feature 32) and that runs on every synced
   * page. An await there would make classification asynchronous for the sake
   * of a string that never changes during a session.
   *
   * Empty until PROFILE lands, which is the safe direction: `audienceOf`
   * returns 'direct' for an unknown self, so nothing is ever hidden because we
   * did not know who we were yet.
   */
  selfEmail: '',
};

/** Ids currently rendered, in order. The diff baseline. */
let renderedIds = [];
/** When the reader last animated a swap, so rapid j/k can skip it. See openMessage. */
let lastSwapAt = 0;
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
  toastIcon: $('toast-icon'),
  toastKbd: $('toast-kbd'),
  rPrev: $('r-prev'),
  rNext: $('r-next'),
  gate: $('gate'),
  gateError: $('gate-error'),
  reader: $('reader'),
  rThread: $('r-thread'),
  rDue: $('r-due'),
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
};

// ------------------------------------------------------------------ plumbing --

/**
 * Ask the service worker to do something. It owns the token; we never see it.
 *
 * FALLS BACK TO THIS PAGE if the worker is not answering.
 *
 * The extension has been unloadable in Chrome with "Service worker
 * registration failed. Status code: 2", and a mail client that cannot start
 * is worth nothing. `handle()` in the worker uses no chrome.* APIs at all --
 * it is pure dispatch over gmail.js and auth.js -- and this page runs on the
 * extension origin whose CSP already allows the Gmail API. So almost
 * everything the worker does, the page can do.
 *
 * The switch is one-way and sticky: once the worker has failed to answer we
 * stop paying the round-trip cost of asking it again on every verb.
 */
let workerDown = false;

/*
 * HOW LONG A VERB MAY TAKE BEFORE WE CALL THE WORKER DEAD.
 *
 * This used to be a single 4000ms deadline for everything, and it produced a
 * false positive on a real inbox: the amber "Background service unavailable"
 * banner appeared while mail was loading perfectly. The worker was not dead,
 * it was slow.
 *
 * AUTH_STATUS answers in milliseconds. SYNC_PAGE fetches a hundred messages,
 * batches their metadata and classifies them; on a cold start over a busy
 * campus network that passes four seconds without anything being wrong. The
 * app then declared the worker dead and routed the whole session through the
 * in-page fallback -- which works, so nothing looked broken, but the banner
 * was a lie and snooze timers were disabled for no reason.
 *
 * A timeout is a claim about what "too slow" means, and that claim cannot be
 * the same for a status ping and a bulk fetch. These are deliberately
 * generous: the cost of waiting too long is a slow action, and the cost of
 * giving up too early is a session spent in a degraded mode nobody asked for.
 */
const VERB_TIMEOUT_MS = {
  // Bulk network work: many round trips, then classification.
  SYNC_PAGE: 45000,
  SYNC_DELTA: 45000,
  // One message, but a large body or many inline parts.
  GET_BODY: 20000,
  GET_INLINE: 30000,
  GET_ATTACHMENT: 60000,
  // Outbound, possibly with attachments.
  SEND: 60000,
  SAVE_DRAFT: 30000,
  // A batch modify over up to a hundred ids.
  BULK: 30000,
  // Interactive OAuth: the user has to actually sign in.
  SIGN_IN: 120000,
};

/** Everything else is a small request that should answer quickly. */
const DEFAULT_TIMEOUT_MS = 10000;

function send(type, extra = {}) {
  if (workerDown) return runInPage(type, extra);

  return new Promise((resolve, reject) => {
    let settled = false;
    /*
     * A worker that never replies is indistinguishable from one that is not
     * there, and `sendMessage` has no timeout of its own. Without this a dead
     * worker leaves every action hanging forever with no error.
     */
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      degradeToFallback('the background worker stopped responding');
      runInPage(type, extra).then(resolve, reject);
    }, VERB_TIMEOUT_MS[type] ?? DEFAULT_TIMEOUT_MS);

    try {
      chrome.runtime.sendMessage({ type, ...extra }, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Reading lastError is what suppresses Chrome's unchecked-error noise.
        const lastErr = chrome.runtime.lastError;
        if (lastErr || !res) {
          degradeToFallback(lastErr?.message || 'the background worker did not start');
          runInPage(type, extra).then(resolve, reject);
          return;
        }
        res.ok ? resolve(res.data) : reject(new Error(res.error));
      });
    } catch (err) {
      settled = true;
      clearTimeout(timer);
      degradeToFallback(err.message);
      runInPage(type, extra).then(resolve, reject);
    }
  });
}

/**
 * Switch to in-page mode and tell the user once.
 *
 * ONCE is the point. Every verb would otherwise raise its own banner, and a
 * degraded mode that shouts on every keystroke is worse than the degradation.
 */
function degradeToFallback(why) {
  if (workerDown) return;
  workerDown = true;
  console.warn('[BMM] background worker unavailable —', why, '— running in-page.');
  try {
    showWorkerWarning(why);
  } catch {
    // The banner is a courtesy; never let it break the fallback itself.
  }
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

  /*
   * POLISH 7+11: the toast's kind is legible at a glance -- an icon names the
   * event and the undo chip names the recovery key. Both are decoration over
   * the live region, never inside it, so announcements stay clean.
   */
  const KIND_ICON = { success: 'check', error: 'warning', undo: 'back' };
  if (KIND_ICON[kind]) {
    setIcon(el.toastIcon, KIND_ICON[kind], { size: 14 });
    el.toastIcon.hidden = false;
  } else {
    el.toastIcon.hidden = true;
  }
  el.toastKbd.hidden = kind !== 'undo';

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

  // Toasts re-fire constantly -- a second one inside the 140ms exit is normal,
  // not an edge case -- so the cancel matters more here than anywhere else.
  cancelExit(el.toast);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
  clearTimeout(toastTimer);
  closeWithMotion(el.toast);
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
    renderNotices();
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
/**
 * Re-measure which subjects are actually clipped (audit 35 bloom gate).
 *
 * Runs after the rows are attached (a detached element reports scrollWidth
 * 0) and after density changes, where the clip condition changes. Reads
 * are one per row per render -- the same order of cost the ghost rect
 * measurement in audit 36 priced at 0.004ms each.
 */
function refreshSubjectClip() {
  for (const [, node] of nodeById) {
    const s = node.querySelector('.r-subj');
    if (s) node.classList.toggle('subj-clip', s.scrollWidth > s.clientWidth);
  }
}

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

  /*
   * TRIAGE LANES.
   *
   * Section headers are inserted into the fragment AFTER the rows are built,
   * rather than by restructuring the loop above. That loop does the row
   * diffing that keeps a delta sync free -- reusing nodes, skipping unchanged
   * writes -- and threading a grouping concept through it would have meant
   * rewriting the one part of this file that is genuinely performance-critical.
   *
   * Inserting headers is a pure DOM operation on an already-correct fragment,
   * so the diffing is untouched and lanes cost nothing when the setting is off.
   *
   * Off by default: a flat date-ordered list is what a mail client is, and
   * lanes are an opinion the user opts into.
   */
  if (settings.get('lanes') && !state.query) {
    insertLaneHeaders(frag);
  }

  el.list.replaceChildren(frag);

  // Freshly built rows measured their subject's clip while DETACHED, where
  // scrollWidth is 0; now that they are in the document the condition is
  // decidable. One pass per render, not per frame.
  refreshSubjectClip();

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
 * SHARED-ELEMENT TRAVEL (audit 36, concept #4) — the archived row condenses
 * into the Undo toast.
 *
 * One body-level fixed ghost, ~200ms, transform/opacity only, overlapping the
 * existing row-out so it adds no state-transition latency: it occupies the
 * dead gap between "row gone" and "toast appears" that the audit measured at
 * 34ms. The destination is the toast's LIVE rect, measured at flight time by
 * laying it out invisibly -- never a hardcoded coordinate, so a future toast
 * move carries the travel with it.
 *
 * Deliberate limits, each from the audit:
 *   - single archive only; bulkAct never calls optimistic(), so bulk gets no
 *     ghost by construction;
 *   - under prefers-reduced-motion the node is NOT CREATED at all, not run at
 *     1ms -- creating motion to hide it is the wrong instinct;
 *   - exactly one ghost: a second archive cancels and replaces the first, the
 *     same ownership rule closeWithMotion uses;
 *   - pointer-events none and aria-hidden; the toast already announces;
 *   - removed on finish AND by a fallback timer, so no path leaks a node.
 *
 * The arc is restrained: one 24px mid-offset on a 200ms ease-in. A 400x68
 * rectangle flying across the screen is a cartoon; a condensed chip reads as
 * the message being filed.
 */
let travelGhostEl = null;
function travelGhost(fromRect, text) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // Live destination: lay the toast out invisibly, read it, put it back.
  const wasHidden = el.toast.hidden;
  const savedVis = el.toast.style.visibility;
  if (wasHidden) { el.toast.hidden = false; el.toast.style.visibility = 'hidden'; }
  const to = el.toast.getBoundingClientRect();
  if (wasHidden) { el.toast.hidden = true; }
  el.toast.style.visibility = savedVis;

  if (travelGhostEl) { // single owner: cancel-and-replace
    travelGhostEl.getAnimations?.().forEach((a) => a.cancel());
    travelGhostEl.remove();
    travelGhostEl = null;
  }

  const g = document.createElement('div');
  g.className = 'travel-ghost';
  g.setAttribute('aria-hidden', 'true');
  g.textContent = text;
  g.style.left = `${fromRect.left + 8}px`;
  g.style.top = `${fromRect.top + fromRect.height / 2 - 14}px`;
  document.body.appendChild(g);
  travelGhostEl = g;

  const s = g.getBoundingClientRect();
  const dx = to.left + to.width / 2 - (s.left + s.width / 2);
  const dy = to.top + to.height / 2 - (s.top + s.height / 2);

  const finish = () => {
    if (travelGhostEl === g) travelGhostEl = null;
    g.remove(); // idempotent; the fallback timer may race onfinish
  };
  const fallback = setTimeout(finish, 400);

  if (typeof g.animate === 'function') {
    const anim = g.animate([
      { transform: 'translate3d(0,0,0) scale(1)', opacity: 1 },
      { transform: `translate3d(${dx * 0.5}px,${dy * 0.5 - 24}px,0) scale(0.6)`, opacity: 0.9, offset: 0.5 },
      { transform: `translate3d(${dx}px,${dy}px,0) scale(0.32)`, opacity: 0 },
    ], { duration: 200, easing: 'cubic-bezier(0.4, 0, 1, 1)' });
    anim.onfinish = () => { clearTimeout(fallback); finish(); };
    anim.oncancel = () => { if (travelGhostEl === g) finish(); };
  } else {
    // No Web Animations (jsdom): the contract under test is create/cleanup,
    // not the flight.
    setTimeout(finish, 220);
  }
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
    '<span class="r-course" hidden></span>' +
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
  setHighlighted(fromEl, isConv ? conv.participants.join(', ') : displayName(m.from), state.query);
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
  setHighlighted(subjEl, subject, state.query);
  setAttr(subjEl, 'title', subject);

  /*
   * ATTENTION BLOOM gate (audit 35): only a subject that is ACTUALLY clipped
   * may bloom when attended, so the class records the measured condition
   * rather than a blanket rule. jsdom reports zero for both widths, so tests
   * never bloom by accident — the bloom is a browser behaviour, verified in
   * one. Re-measured on density change, where the clip condition changes.
   */
  const clipped = subjEl.scrollWidth > subjEl.clientWidth;
  if (li.classList.contains('subj-clip') !== clipped) {
    li.classList.toggle('subj-clip', clipped);
  }

  /*
   * THE SNIPPET IS CLEANED, NOT PRINTED RAW.  (Feature 29.)
   *
   * Gmail's snippet is the first ~200 characters of the body. On institutional
   * mail those characters are always the same -- "Dear Students, Greetings
   * from AUGSD. This is to inform all students that..." -- so every row said
   * the same thing and the one line of the list that exists to let you decide
   * WITHOUT OPENING told you nothing.
   *
   * `rowSnippet` strips salutations, throat-clearing, disclaimers, quoted
   * replies and signature blocks, and returns '' when what is left merely
   * restates the subject. An empty string is a deliberate outcome: a blank
   * second line is better than a redundant one.
   *
   * This is also why the elimination audit CUT the hover preview card -- with
   * the row saying something useful, a popover repeating it 500ms later is a
   * hover-intent state machine and a positioning engine bought for nothing.
   */
  setText(q('.r-snip'), rowSnippet(m));

  /*
   * THE COURSE CHIP.
   *
   * Shown only for a course the user is actually enrolled in. A chip for one
   * of the other 682 courses is a lie on a row being scanned, and the standing
   * rule for academic detection is that a wrong badge is worse than none --
   * it teaches people to stop reading badges.
   */
  const chipEl = q('.r-course');
  if (chipEl) {
    const chip = myCourses.courseChip(m.courses || [], enrolment);
    setText(chipEl, chip ? chip.label + (chip.more ? ` +${chip.more}` : '') : '');
    setAttr(chipEl, 'title', chip ? chip.title : '');
    chipEl.hidden = !chip;
  }
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
 * POLISH 13: a search hit should SHOW its hit. `mark` chunks are built as
 * text nodes plus mark elements -- never innerHTML -- so a subject that
 * contains literal query text cannot become markup. Operators (:, ") skip
 * highlighting entirely; matching "is:overdue" against prose is a lie.
 */
function setHighlighted(node, text, query) {
  if (!query || /[:"]/.test(query)) { setText(node, text); return; }
  const q = query.trim().toLowerCase();
  const hay = text.toLowerCase();
  let pos = q ? hay.indexOf(q) : -1;
  if (pos === -1) { setText(node, text); return; }
  node.textContent = '';
  let i = 0;
  while (pos !== -1) {
    if (pos > i) node.append(text.slice(i, pos));
    const mk = document.createElement('mark');
    mk.textContent = text.slice(pos, pos + q.length);
    node.append(mk);
    i = pos + q.length;
    pos = hay.indexOf(q, i);
  }
  node.append(text.slice(i));
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

/*
 * POLISH 12: double-click is the muscle memory for "open the real thing".
 * One row, the exact message, in Gmail's own tab -- the escape hatch a
 * takeover must keep visible, not hidden.
 */
function openInGmail(id) {
  window.open(`https://mail.google.com/mail/u/0/#inbox/${id}`, '_blank');
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

  /*
   * POLISH 19: the tab is where a student looks when the app is buried.
   * A parenthesised count is the one glanceable unread convention that
   * survives every mail client, so the tab agrees with the rail instead
   * of staying frozen at the app name.
   */
  document.title = totalUnread
    ? `(${totalUnread}) BITS Mail Manager`
    : 'BITS Mail Manager';

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
        /*
         * COUNT WHAT THE USER CAN SEE, not what the store holds.
         *
         * `s.size` is the raw message count. With threading on, the list
         * shows one row per CONVERSATION -- so a real inbox displayed
         * "Inbox 32 48" in the rail beside "All mail 44" in the list header.
         * Both numbers were correct and they measured different things,
         * which reads as an arithmetic bug in the product.
         *
         * The rail sits next to the list, so it must agree with the list.
         */
        total = s
          ? (settings.get('threaded') ? s.rootIds().length : s.size)
          : 0;
      }
      setCount(countEl, un, total);
      b.setAttribute('aria-current', String(state.mailbox === id));
      continue;
    }

    const key = b.dataset.cat;
    const u = key === 'all' ? totalUnread : unread[key] || 0;
    /*
     * POLISH 14: a deadline view in the red is a different animal from an
     * inbox with unread mail. The count earns the urgency colour; nothing
     * else moves.
     */
    b.classList.toggle('hot-danger', key === 'sv-overdue' && u > 0);
    b.classList.toggle('hot-warm', key === 'sv-week' && u > 0);
    /*
     * Same rule as the mailboxes above: count CONVERSATIONS when the list is
     * showing conversations, or the rail disagrees with the header beside it.
     * `collapseThreads` is the one place that decision is made, so it is the
     * one place to ask.
     */
    const t = collapseThreads(
      key === 'all' ? store.idsFor('all') : store.idsFor(key)
    ).length;
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
/**
 * The open message's own deadline.
 *
 * WHY THIS EXISTS
 * ---------------
 * `extractDeadline` runs on every ingest and writes `dueAt`/`dueKind`/
 * `dueText` onto the message. Until now the ONLY consumer was the sidebar
 * radar, which shows the six most urgent. A message with a deadline outside
 * that top six had one the product knew about, had parsed, had cached -- and
 * never mentioned. Including on the one screen where the user is definitely
 * looking at that exact message.
 *
 * It deliberately reuses `relativeLabel` and `urgency`, the radar's own
 * functions, rather than formatting a date here. Two surfaces describing one
 * date in two different vocabularies is precisely the drift audit 15 was
 * about: "due tomorrow" in the rail and "12 Aug" in the reader would read as
 * two different facts.
 *
 * The quoted phrase is the same trick the radar item plays in its tooltip --
 * it turns "how did it know that?" into "of course, it read the line". Here
 * it is on the surface rather than in a title, because the reader has the
 * width for it and a tooltip is not reachable by touch or keyboard.
 */
function renderMessageDeadline(m) {
  const box = el.rDue;
  if (!box) return;

  if (!m || !m.dueAt) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }

  const now = Date.now();
  const band = urgency(m.dueAt, now);

  const when = document.createElement('span');
  when.className = 'r-due-when';
  // Capitalised because it opens the line: "Due tomorrow", not "due tomorrow".
  const label = relativeLabel(m.dueAt, now);
  when.textContent = label.charAt(0).toUpperCase() + label.slice(1);

  const frag = document.createDocumentFragment();
  frag.appendChild(when);

  /*
   * The evidence. `dueText` is the phrase the parser matched, so quoting it
   * lets the user judge whether the machine read the mail correctly -- which
   * matters, because a wrong deadline is worse than no deadline.
   */
  if (m.dueText) {
    const from = document.createElement('span');
    from.className = 'r-due-from';
    from.textContent = `Read from: “${m.dueText}”`;
    frag.appendChild(from);
  }

  box.className = `r-due r-due-${band}`;
  box.replaceChildren(frag);
  box.hidden = false;
}

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
    setAttr(when, 'title', fullDate(msg.date));

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

  /*
   * SKIP THE SWAP WHEN THE USER IS MOVING FAST.
   *
   * The animation restarts on every open, so holding `j` produced a stack of
   * interrupted 200ms fades that never completed -- the reader flickered
   * instead of settling, which is the opposite of what the motion is for.
   *
   * The fix is not a longer or shorter animation. It is that a transition
   * explains a change the user is watching, and someone pressing `j` five
   * times is not watching -- they are scanning, and they want to ARRIVE. So a
   * step taken within one animation's length of the last one is instant, and a
   * deliberate single step still animates.
   *
   * `--dur-base` is 200ms; the threshold matches it, so the rule is exactly
   * "do not interrupt a swap that is still running".
   */
  const now = Date.now();
  const rapid = now - lastSwapAt < 200;
  lastSwapAt = now;

  el.reader.classList.remove('swap');
  if (!rapid) {
    void el.reader.offsetWidth; // reflow to reset the animation
    el.reader.classList.add('swap');
  }

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

  renderMessageDeadline(m);
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
    // Middle-truncated so the extension survives; the chip's `title` above
    // carries the full name, so nothing is lost.
    name.textContent = middleTruncate(a.filename);

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
  /* SPATIAL COMPRESSION O16 (audit 37): quoted history folds behind a
     native <details>; no script needed inside the sandbox. */
  details.quote-fold>summary{
    cursor:pointer;display:inline-block;margin:10px 0 4px;padding:3px 10px;
    font-size:13px;color:inherit;opacity:.72;border:1px solid currentColor;
    border-radius:6px;list-style:none;
  }
  details.quote-fold>summary::-webkit-details-marker{display:none}
  details.quote-fold>summary::before{content:"+ ";}
  details.quote-fold[open]>summary::before{content:"\\2212  ";}
  details.quote-fold blockquote{margin-top:6px}

  /* POLISH 18b: a link that leaves the message says so before the click. */
  a[target="_blank"]::after{
    content:"";display:inline-block;width:10px;height:10px;margin-inline-start:4px;
    background:currentColor;opacity:.55;
    -webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Cpath fill='none' stroke='black' stroke-width='2' d='M8 5H4v11h11v-4M12 4h4v4M16 4 9 11'/%3E%3C/svg%3E") no-repeat center/contain;
    mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Cpath fill='none' stroke='black' stroke-width='2' d='M8 5H4v11h11v-4M12 4h4v4M16 4 9 11'/%3E%3C/svg%3E") no-repeat center/contain;
  }
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
/**
 * Apply a FLAG change optimistically, with rollback and undo.
 *
 * The sibling of `optimistic()`, for actions that change a property rather
 * than remove the message. `optimistic()` snapshots, moves the selection to a
 * neighbour and calls `store.remove` -- all wrong for starring, where the row
 * must stay exactly where it is and keep its place in the list.
 *
 * What the two DO share, and what this exists to guarantee, is the recovery
 * contract: mutate locally now, tell Gmail after, put it back if the request
 * fails, and record a reversal the user can reach. Star and unread had the
 * first three and not the fourth, which meant the same gesture was undoable in
 * bulk and not one at a time.
 *
 * @param {Object}   o
 * @param {string}   o.id
 * @param {Object}   o.patch       fields to write now
 * @param {Object}   o.undoPatch   fields that restore the previous state
 * @param {string}   o.verb        background verb
 * @param {string}  [o.undoVerb]   its inverse; defaults to `verb`
 * @param {Object}  [o.payload]    extra payload for the verb
 * @param {Object}  [o.undoPayload] extra payload for the inverse
 * @param {string}   o.past        undo label, e.g. "Starred"
 * @param {string}   o.failed      error toast
 */
function flagAction({
  id, patch, undoPatch, verb, undoVerb, payload = {}, undoPayload = {}, past, failed,
}) {
  const m = store.get(id);
  if (!m) return Promise.resolve();

  store.patch(id, patch);
  // The reader's toolbar mirrors these flags, so it has to follow the store.
  if (id === state.selected) syncContextActions(store.get(id));

  /*
   * THE UNDO IS RECORDED ONLY ON SUCCESS.
   *
   * Recording it at dispatch time -- which this did -- means a request that
   * FAILS still leaves an undo entry on the stack. The catch below rolls the
   * local store back, so the user sees the change revert and an error toast;
   * then Ctrl+Z, the natural response to a failure, sends the INVERSE verb to
   * Gmail for a change that never happened. On a message that was already
   * starred server-side, undoing a failed star silently unstarred it.
   *
   * THE TRADEOFF, STATED HONESTLY: the undo toast now appears 200-600ms after
   * the keypress instead of instantly. That is a real cost and it was weighed
   * against the alternative, which is offering an Undo button for something
   * that did not happen and which, when pressed, changes the mailbox the
   * wrong way. A slightly late toast is a smaller harm than a lying one.
   *
   * The part the user actually feels -- the star filling, the row leaving --
   * is unchanged: that is the optimistic store.patch above, which still runs
   * before the request. Only the confirmation waits.
   */
  const sent = send(verb, { id, ...payload }).then(
    () => {
      /*
       * THE ACTIVITY LOG IS WRITTEN HERE, ON THE SETTLED BRANCH.
       *
       * Same reasoning as the undo entry directly below: logging at dispatch
       * time records actions that never happened. The log's whole value is
       * answering "what actually changed", so an optimistic entry would make
       * it lie in exactly the situation it exists to explain.
       */
      activity.record({ verb, ids: [id], actor: 'user' });
      recordUndo(ctx, past, async () => {
        store.patch(id, undoPatch);
        if (id === state.selected) syncContextActions(store.get(id));
        await send(undoVerb || verb, { id, ...undoPayload });
        activity.record({ verb: undoVerb || verb, ids: [id], actor: 'user', detail: 'undo' });
      });
    },
    (err) => {
      store.patch(id, undoPatch);
      if (id === state.selected) syncContextActions(store.get(id));
      activity.record({ verb, ids: [id], actor: 'user', outcome: 'failed', error: err?.message });
      toast(failed, { kind: 'error' });
    }
  );

  return sent;
}

function optimistic({
  id, verb, undoVerb, past, failed, done, before, rollback: undoLocal, undoBefore,
}) {
  const m = store.get(id);
  if (!m) return Promise.resolve();
  const snapshot = { ...m };

  /*
   * Shared-element travel (audit 36): capture the departing row's box BEFORE
   * the removal re-renders, and only for ARCHIVE -- trash and spam depart
   * without a travel because their destination story is different, and bulk
   * never reaches this function at all.
   */
  let travel = null;
  if (verb === 'ARCHIVE') {
    const node = nodeById.get(id);
    if (node) {
      travel = {
        rect: node.getBoundingClientRect(),
        text: node.querySelector('.r-from')?.textContent || m.from,
      };
    }
  }

  selectNeighbourThen(id);
  store.remove(id);
  if (travel) travelGhost(travel.rect, travel.text);

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

  /*
   * UNDO AND THE SUCCESS TOAST BOTH WAIT FOR THE REQUEST TO SETTLE.
   *
   * Recording the undo at dispatch time meant a FAILED request still left an
   * entry on the stack. `rollback` restores the message and shows an error,
   * and then Ctrl+Z -- the natural response to seeing a failure -- sends
   * UNARCHIVE for an archive that never happened. On mail the user had
   * archived earlier that silently pulls it back into the inbox.
   *
   * `done` moves for the same reason: "Moved back to the inbox" printed while
   * the request was still in flight, so a failure showed the success toast
   * first and the error second. The optimistic UI update is what keeps this
   * feeling instant; the toast is a confirmation and can honestly wait.
   */
  const sent = run().then(
    () => {
      activity.record({ verb, ids: [id], actor: 'user' });
      if (undoVerb) {
        recordUndo(ctx, past, async () => {
          if (undoBefore) await undoBefore(id);
          store.upsert(snapshot);
          await send(undoVerb, { id });
          activity.record({ verb: undoVerb, ids: [id], actor: 'user', detail: 'undo' });
          renderList();
        });
      }
      if (done) toast(done);
    },
    (err) => {
      activity.record({ verb, ids: [id], actor: 'user', outcome: 'failed', error: err?.message });
      return rollback(err);
    }
  );

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
    /*
     * STAR AND UNREAD ARE *FLAGS*, NOT REMOVALS.
     *
     * They cannot use `optimistic()`, which is built around taking the message
     * OUT of the list: it snapshots, moves the selection to a neighbour, and
     * calls `store.remove`. A starred message stays exactly where it is.
     *
     * But they must still behave like their siblings in the one way the user
     * can feel, which is RECOVERY. Both were plain patch-and-send blocks with
     * no undo, while `bulkAct` has recorded undo for the same two verbs all
     * along -- so starring two messages was reversible and starring one was
     * not. That is drift, not a decision: the product had already ruled that
     * these are worth undoing.
     *
     * `flagAction` is the flag-shaped counterpart to `optimistic`: patch now,
     * send after, roll back on failure, record the reversal. Stated once so
     * the two cannot drift apart again.
     */
    case 'star': {
      const on = !m.starred;
      flagAction({
        id,
        patch: { starred: on },
        undoPatch: { starred: !on },
        verb: 'STAR',
        payload: { on },
        undoPayload: { on: !on },
        past: on ? 'Starred' : 'Unstarred',
        failed: 'Could not update star',
      });
      break;
    }
    case 'unread': {
      const on = !m.unread;
      flagAction({
        id,
        patch: { unread: on },
        undoPatch: { unread: !on },
        verb: on ? 'MARK_UNREAD' : 'MARK_READ',
        undoVerb: on ? 'MARK_READ' : 'MARK_UNREAD',
        past: on ? 'Marked unread' : 'Marked read',
        failed: 'Could not update',
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
      cc: m.cc,
      /*
       * Stamped ONCE, here, where the recipient headers are in hand and the
       * signed-in address is known. Feature 32.
       *
       * The alternative -- deriving it in the query operator and in the lane
       * assigner and in the list filter -- would parse the same header three
       * times per message per render. This is a pure function of data that
       * never changes after ingest, which is the definition of something that
       * belongs in the record rather than in the render path.
       */
      audience: audienceOf(m, state.selfEmail),
      /*
       * Course numbers mentioned in the message, detected ONCE here rather
       * than re-parsed per render. Narrowed to the user's enrolment at display
       * time -- the raw detection is cheap to keep and lets the enrolment
       * change without a re-sync.
       */
      courses: courseNumbersIn(`${m.subject || ''} ${m.snippet || ''}`),
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
  // User rules run after the category auto-archive, so a hand-written rule can
  // act on anything the category sweep left behind.
  applyRules(records);
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
/**
 * Run the user's rules over newly-arrived mail.
 *
 * At INGEST, so a rule affects what the user sees on arrival rather than after
 * a manual sweep. The plan is batched per verb by `batchPlan`, so twelve
 * matching messages are one request and one undo entry, not twelve.
 *
 * Every application is logged with actor 'rule' and the rule's name, which is
 * what makes the activity log able to answer "why did this get archived".
 */
async function applyRules(records) {
  if (automationRules.length === 0 || records.length === 0) return;

  const { batches, fired } = engine.planFor(automationRules, records);
  if (batches.length === 0) return;

  const named = new Map(automationRules.map((r) => [r.id, r.name]));

  for (const batch of batches) {
    const spec = BULK_ACTIONS[batch.type === 'markRead' ? 'read' : batch.type];
    if (!spec) continue;
    try {
      await send('BULK', { ids: batch.ids, add: spec.add || [], remove: spec.remove || [] });
      store.batch(() => {
        for (const id of batch.ids) {
          if (batch.type === 'archive') store.remove(id);
          else if (batch.type === 'markRead') store.patch(id, { unread: false });
          else if (batch.type === 'star') store.patch(id, { starred: true });
        }
      });
      const who = Object.keys(fired).map((id) => named.get(id)).filter(Boolean)[0];
      activity.record({
        verb: `RULE_${batch.type.toUpperCase()}`,
        ids: batch.ids,
        actor: 'rule',
        detail: who,
      });
    } catch (err) {
      /*
       * A failed rule is reported and then LEFT ALONE. Retrying automation the
       * user cannot see would be the worst kind of surprise, and the log entry
       * is what makes the failure findable.
       */
      activity.record({
        verb: `RULE_${batch.type.toUpperCase()}`,
        ids: batch.ids,
        actor: 'rule',
        outcome: 'failed',
        error: err?.message,
      });
    }
  }
}

function autoArchive(records) {
  if (!rules.autoArchive.length) return;
  const targets = new Set(rules.autoArchive);
  const hits = records.filter((m) => targets.has(m.category) && m.unread);
  if (!hits.length) return;

  const ids = hits.map((m) => m.id);
  const snapshots = hits.map((m) => ({ ...m }));
  for (const id of ids) store.remove(id);

  /*
   * The archive delta comes from BULK_ACTIONS, not from a literal.
   *
   * This function is deliberately NOT routed through `bulkAct` -- it fires
   * without awaiting, it must not clear the user's ticks or close their
   * reader, and it says "Auto-archived" rather than "Archived" because the
   * user did not do it. Those differences are real and forcing them into one
   * function would mean three flags.
   *
   * But "what archiving does to labels" is not one of the differences, and it
   * was written out twice more here -- a third and fourth copy of a delta that
   * now has one home. The inverse is derived the same way it is in `bulkAct`.
   */
  const { add = [], remove = [] } = BULK_ACTIONS.archive;

  /*
   * STILL FIRE-AND-FORGET -- ingest must not block on a network round trip --
   * but the undo and the announcement now wait for it to SUCCEED.
   *
   * Recording the undo on the next line meant a failed request left an entry
   * behind: the catch restores the snapshots and shows an error, and Ctrl+Z
   * then sends the inverse BULK, adding INBOX back to mail that was never
   * archived. Worse here than elsewhere, because auto-archive runs on ingest
   * and the user may not have been watching when it failed.
   */
  send('BULK', { ids, add, remove }).then(
    () => {
      toast(`Auto-archived ${ids.length} message${ids.length === 1 ? '' : 's'}`);
      recordUndo(ctx, `Auto-archived ${ids.length}`, async () => {
        for (const s of snapshots) store.upsert(s);
        await send('BULK', { ids, add: remove, remove: add });
      });
    },
    () => {
      for (const s of snapshots) store.upsert(s);
      toast('Could not auto-archive', { kind: 'error' });
    }
  );
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
  } else if (isOffline() || /failed to fetch|networkerror|load failed|fetch failed/i.test(msg)) {
    /*
     * A NETWORK FAILURE IS NOT AN ERROR MESSAGE, IT IS A STATE.
     *
     * Chrome says "Failed to fetch", Firefox "NetworkError when attempting to
     * fetch resource.", Safari "Load failed" -- three different pieces of
     * jargon for one condition, none of which tells the user anything they can
     * act on. The banner says it once, in one voice, and stays until it is no
     * longer true.
     */
    showOfflineBanner();
  } else {
    toast(msg.slice(0, 140), { kind: 'error' });
  }
}

// -------------------------------------------------------------------- gate --

/**
 * The degraded-mode banner.
 *
 * A persistent strip rather than a toast: a toast is for something that just
 * happened and then stops mattering, and this condition lasts for the whole
 * session. It must also survive the user not being at the screen when the
 * first failure occurred.
 *
 * Deliberately not a modal. The app WORKS in this mode -- reading, searching,
 * archiving, sending all function -- so blocking the UI to announce partial
 * degradation would be a worse outcome than the degradation.
 */
function showWorkerWarning(why) {
  if (document.getElementById('sw-warn')) return;

  const bar = document.createElement('div');
  bar.id = 'sw-warn';
  bar.setAttribute('role', 'status');

  const text = document.createElement('span');
  text.className = 'sw-warn-text';
  text.textContent =
    'Background service unavailable — running in this tab. '
    + 'Mail works; snooze will not wake on a timer and the toolbar shortcut is off.';

  const detail = document.createElement('span');
  detail.className = 'sw-warn-why';
  detail.textContent = why ? `(${why})` : '';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ghost small';
  close.textContent = 'Dismiss';
  close.addEventListener('click', () => bar.remove());

  bar.append(text, detail, close);
  // Above the panes, below the topbar: it describes the whole app, not one pane.
  const main = document.getElementById('main');
  const panes = document.getElementById('panes');
  if (main && panes) main.insertBefore(bar, panes);
  else document.body.prepend(bar);
}


/* ========================================================================== *
 * OFFLINE
 * ========================================================================== *
 *
 * `navigator.onLine` appeared nowhere in this codebase, so a dropped
 * connection fell to the last branch of reportError() and surfaced as
 * `toast("Failed to fetch")` -- browser jargon, styled as INFORMATION rather
 * than a problem, gone in 2200ms.
 *
 * Three things wrong with that, and the third is the one that matters: offline
 * is not an event, it is a CONDITION. It lasts until the network returns, and
 * a transient toast is the wrong shape for something that is still true thirty
 * seconds later.
 *
 * The right idiom already existed. showWorkerWarning() renders a persistent
 * strip for degraded mode, and its own comment explains why: "a toast is for
 * something that just happened and then stops mattering, and this condition
 * lasts for the whole session." Offline is that condition and never got the
 * treatment.
 *
 * WHAT THE BANNER SAYS IS THE POINT. Not "you are offline" -- the user knows.
 * What they do not know is what still works, and on a campus network that
 * drops several times an hour that is the difference between waiting and
 * retrying by hand until they conclude the app is broken.
 */
let offlineBar = null;

function showOfflineBanner() {
  if (offlineBar || document.getElementById('net-warn')) return;

  const bar = document.createElement('div');
  bar.id = 'net-warn';
  // `alert`, not `status`: losing the connection is worth interrupting for.
  bar.setAttribute('role', 'alert');

  const text = document.createElement('span');
  text.className = 'sw-warn-text';
  text.textContent =
    'No connection — showing mail already downloaded. '
    + 'Anything you send is queued and goes out automatically when you are back.';

  bar.append(text);
  const main = document.getElementById('main');
  const panes = document.getElementById('panes');
  if (main && panes) main.insertBefore(bar, panes);
  else document.body.prepend(bar);
  offlineBar = bar;
}

function hideOfflineBanner() {
  offlineBar?.remove();
  offlineBar = null;
}

/*
 * No Dismiss button, deliberately, unlike the worker banner.
 *
 * That one describes a condition the user can do nothing about and may last
 * the whole session, so dismissing it is reasonable. This one clears itself
 * the moment the network returns -- a dismiss control would only let the user
 * hide a fact that is still true.
 */
window.addEventListener('offline', () => {
  showOfflineBanner();
});

window.addEventListener('online', () => {
  hideOfflineBanner();
  // Catch up immediately rather than waiting for the next scheduled poll, and
  // drain anything the outbox has been holding.
  refresh({ silent: true });
  pumpOutbox();
});

/** True when the browser knows it is offline. Feature-detected: jsdom has no navigator.onLine. */
function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function showGate(message) {
  el.gate.hidden = false;
  el.gateError.hidden = !message;
  el.gateError.textContent = message || '';

  /*
   * The explanation appears only for the one error it explains.
   *
   * A returning user whose session expired does not need to be told what an
   * OAuth client ID is -- they already have one. Showing it always would turn
   * a one-time onboarding note into permanent furniture.
   */
  const why = $('gate-why');
  if (why) why.hidden = !/client ID/i.test(message || '');
  /*
   * MOVE FOCUS IN, like every other dialog.
   *
   * Help focuses its close button, the palette its input, compose the first
   * empty field. The gate focused nothing, so a keyboard or screen-reader user
   * met a modal surface with focus still parked on <body> behind it and no
   * way to discover the only button that does anything.
   *
   * It is the first screen a new user sees, which makes it the worst place in
   * the product to drop focus. Guarded because `showGate` is also called for
   * an expired session while the user may be mid-keystroke elsewhere -- but
   * the gate has just covered the app, so taking focus is correct there too.
   */
  $('btn-signin')?.focus();
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
  el.list.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (row?.dataset.id) openInGmail(row.dataset.id);
  });
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
  // Like snooze, these open a picker rather than acting immediately.
  if (b.dataset.act === 'followup') {
    openFollowupMenu(state.selected, b);
    return;
  }
  if (b.dataset.act === 'deadline') {
    openDeadlineMenu(state.selected, b);
    return;
  }
  act(b.dataset.act, state.selected);
});

// Search: debounced by ONE frame, not by a timer. Typing feels instant and
// still costs at most one render per frame.
let searchFrame = 0;
/* O3 guard: the topbar may never yield while the bar owns the search. */
el.search.addEventListener('focus', () => document.body.classList.add('searching'));
el.search.addEventListener('blur', () => document.body.classList.remove('searching'));
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
    renderSuggestions();
  });
});

/* ========================================================================== *
 * SEARCH SUGGESTIONS
 * ========================================================================== */

/** The live suggestion list, and which row the arrow keys are on. */
let suggestions = [];
let suggestIndex = -1;
let queryHistory = [];

/**
 * Values are drawn from what is ACTUALLY IN THE MAILBOX.
 *
 * A suggestion that produces no results is worse than no suggestion: it reads
 * as the search being broken rather than the query being wrong. Senders come
 * from the store, labels from the fetched label list, categories from the
 * classifier's own vocabulary.
 */
function suggestContext() {
  const senders = new Set();
  for (const id of store.idsFor('all').slice(0, 400)) {
    const m = store.get(id);
    if (m?.from) senders.add(addressOf(m.from));
  }
  return {
    history: queryHistory,
    views: currentViews(),
    senders: [...senders].filter(Boolean).slice(0, 40),
    labels: labelNames(),
    categories: SIDEBAR_ORDER.map((key) => ({ key })),
    limit: 8,
  };
}

function renderSuggestions() {
  const box = $('search-suggest');
  if (!box) return;

  // Only while the field has focus. A list hanging under an unfocused input is
  // a dropdown nobody opened.
  if (document.activeElement !== el.search) {
    box.hidden = true;
    return;
  }

  suggestions = suggest.suggest(el.search.value, suggestContext());
  suggestIndex = -1;

  if (suggestions.length === 0) {
    box.hidden = true;
    return;
  }

  const frag = document.createDocumentFragment();
  suggestions.forEach((sg, i) => {
    const li = document.createElement('li');
    li.className = 'suggest-item';
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.dataset.index = String(i);

    const label = document.createElement('span');
    label.className = 'suggest-label';
    label.textContent = sg.label;

    const hint = document.createElement('span');
    hint.className = 'suggest-hint';
    hint.textContent = sg.hint || '';

    li.append(label, hint);
    frag.appendChild(li);
  });
  box.replaceChildren(frag);
  box.hidden = false;
}

function moveSuggestion(delta) {
  if (suggestions.length === 0) return;
  suggestIndex = (suggestIndex + delta + suggestions.length) % suggestions.length;
  const box = $('search-suggest');
  [...box.children].forEach((li, i) => {
    li.classList.toggle('active', i === suggestIndex);
    li.setAttribute('aria-selected', String(i === suggestIndex));
  });
}

/**
 * Accept a suggestion.
 *
 * An INCOMPLETE one -- `from:` with no value yet -- leaves the caret in the
 * field and re-runs the list against the new prefix, because the user is
 * mid-thought. A complete one runs the query. Getting this backwards makes the
 * control feel broken in a way people cannot articulate.
 */
function acceptSuggestion(i) {
  const sg = suggestions[i];
  if (!sg) return;
  el.search.value = sg.value;
  if (suggest.isComplete(sg)) {
    ctx.runQuery(sg.value);
    rememberQuery(sg.value);
    $('search-suggest').hidden = true;
  } else {
    el.search.focus();
    renderSuggestions();
  }
}

/** Keep the query history, so the empty box can offer what was searched before. */
function rememberQuery(q) {
  queryHistory = suggest.addToHistory(queryHistory, q);
  suggest.saveHistory(queryHistory);
}

el.search.addEventListener('focus', () => renderSuggestions());

/*
 * Close on blur, but on a delay: a click on a suggestion blurs the input
 * BEFORE the click lands, so hiding synchronously eats the selection. This is
 * the standard combobox hazard and the reason the delay is not a smell.
 */
el.search.addEventListener('blur', () => {
  setTimeout(() => {
    const box = $('search-suggest');
    if (box && !box.contains(document.activeElement)) box.hidden = true;
  }, 120);
});

el.search.addEventListener('keydown', (e) => {
  const box = $('search-suggest');
  const open = box && !box.hidden && suggestions.length > 0;

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!open) return;
    e.preventDefault();
    moveSuggestion(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Enter') {
    if (open && suggestIndex >= 0) {
      e.preventDefault();
      acceptSuggestion(suggestIndex);
    } else {
      // A plain Enter with nothing highlighted runs what was typed, which is
      // what a search field is expected to do.
      rememberQuery(el.search.value);
      if (box) box.hidden = true;
    }
  } else if (e.key === 'Escape') {
    /*
     * Escape closes the SUGGESTIONS first and the takeover second. Without
     * stopping propagation here, dismissing a dropdown would throw the user
     * back to Gmail -- the same layered-Escape hazard the palette hit.
     */
    if (open) {
      e.stopPropagation();
      box.hidden = true;
      suggestIndex = -1;
    }
  }
});

$('search-suggest')?.addEventListener('mousedown', (e) => {
  // mousedown, not click: the input's blur fires first otherwise.
  const li = e.target.closest('.suggest-item');
  if (!li) return;
  e.preventDefault();
  acceptSuggestion(Number(li.dataset.index));
});

/* ========================================================================== *
 * SERVER SEARCH FALLBACK
 * ========================================================================== */

/*
 * Server search lives in server-search.js -- it was the least-coupled tenant
 * in this file: three functions, one entry point, and the only shell state it
 * needs is the current query and mailbox.
 */

/**
 * Offer to keep the current search.
 *
 * Shown only when a query is active and is not already saved. An always-
 * present "save" button on an empty search box is noise, and offering to save
 * something already saved is a small lie about what the button will do.
 */




$('btn-refresh').addEventListener('click', () => refresh());
  $('freshness').addEventListener('click', () => refresh());
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
 * WHY THIS IS NOW SIX LINES OF DATA
 * ---------------------------------
 * This was the FOURTH hand-rolled menu. The first cleanup pass unified three
 * -- category rules, recategorise, snooze -- and missed this one, because it
 * lives in the header section rather than beside the others. By the time it
 * was found the two implementations had already drifted: this menu supported
 * Home/End and the shared primitive did not. That is the copy-paste failure
 * the primitive exists to prevent, caught in its own codebase, one pass late.
 *
 * So the container, the role wiring, the arrow/Home/End/Escape handler, the
 * layer registration, the outside-click dismissal and the focus restore are
 * all gone from here. What is left is the only part that was ever about
 * themes: which items exist, what each looks like, and what choosing one does.
 */

/** The swatch dot that makes a theme name mean something. */
function themeDot(swatch) {
  const dot = document.createElement('span');
  dot.className = 'theme-dot';
  dot.style.background = swatch;
  return dot;
}

/** The tick on the current theme. CSS reveals it via [aria-checked='true']. */
function themeTick() {
  const tick = document.createElement('span');
  tick.className = 'theme-tick';
  tick.setAttribute('aria-hidden', 'true');
  tick.appendChild(icon('check', { size: 14 }));
  return tick;
}




/**
 * The snoozed rail section.
 *
 * Hidden when nothing is pending, like #radar and #outbox. Each row answers
 * the two questions a snooze creates -- what did I hide, and when does it come
 * back -- and offers the one action that was previously impossible: get it
 * back NOW, without waiting for the alarm.
 */
async function renderSnoozed() {
  const wrap = $('snoozed');
  const list = $('snoozed-list');
  if (!wrap || !list) return;

  const all = await loadSnoozed();
  const items = pendingSnoozes(all);
  wrap.hidden = items.length === 0;
  if (items.length === 0) return;

  const frag = document.createDocumentFragment();
  for (const it of items.slice(0, 8)) {
    const li = document.createElement('li');
    li.className = 'snoozed-item';

    const what = document.createElement('span');
    what.className = 'snoozed-what';
    // The message may not be in the store -- it was removed from the inbox
    // when snoozed -- so fall back to the stored subject rather than blank.
    const m = store.get(it.id);
    what.textContent = m?.subject || all[it.id]?.subject || 'Snoozed message';

    const when = document.createElement('span');
    when.className = 'snoozed-when';
    when.textContent = wakeLabel(it.at);

    const now = document.createElement('button');
    now.type = 'button';
    now.className = 'ghost small';
    now.textContent = 'Wake';
    now.onclick = async () => {
      try {
        await send('UNSNOOZE', { id: it.id });
        activity.record({ verb: 'UNSNOOZE', ids: [it.id], actor: 'user' });
        toast('Back in your inbox');
        await renderSnoozed();
        refresh({ silent: true });
      } catch (err) {
        toast(`Could not wake: ${err.message}`, { kind: 'error' });
      }
    };

    li.append(what, when, now);
    frag.appendChild(li);
  }
  list.replaceChildren(frag);
}



/**
 * Insert lane headers into a built fragment.
 *
 * Walks the rows in order, asks which lane each belongs to, and inserts a
 * header before the first row of each new lane. Order follows the lane
 * cascade, not the fragment, so a message that sorts late still appears under
 * the right heading -- rows are moved into lane order first.
 */
function insertLaneHeaders(frag) {
  const rows = [...frag.children].filter((n) => n.classList?.contains('row'));
  if (rows.length === 0) return;

  const answered = lanes.answeredPredicate(store, state.selfEmail);
  const ctxArgs = { self: state.selfEmail, isAnswered: answered };

  const byLane = new Map();
  for (const node of rows) {
    const m = store.get(node.dataset.id);
    if (!m) continue;
    const lane = lanes.laneOf(m, ctxArgs);
    if (!byLane.has(lane)) byLane.set(lane, []);
    byLane.get(lane).push(node);
  }

  // Rebuild in lane order. Empty lanes are skipped entirely -- a heading over
  // nothing is the problem the completeness audit found in Views.
  for (const lane of lanes.LANES) {
    const group = byLane.get(lane);
    if (!group || group.length === 0) continue;

    const head = document.createElement('div');
    head.className = 'lane-head';
    head.setAttribute('role', 'presentation');

    const label = document.createElement('span');
    label.textContent = lanes.LANE_LABELS[lane];

    const count = document.createElement('span');
    count.className = 'lane-count';
    count.textContent = String(group.length);

    head.append(label, count);
    frag.appendChild(head);
    for (const node of group) frag.appendChild(node);
  }
}

/**
 * The class-change cards.
 *
 * Only PROMOTED notices appear -- confidence >= 0.7, which requires the
 * message to name a course the user actually takes, or come from an academic
 * sender, or carry the phrase in its subject. A bare pattern match scores 0.4
 * and never pins itself, because a false pin teaches people to ignore the pin
 * and that is the whole delivery mechanism.
 */
function renderNotices() {
  const wrap = $('notices');
  if (!wrap) return;

  const found = [];
  for (const id of visibleIds().slice(0, 60)) {
    const m = store.get(id);
    if (!m) continue;
    const mine = myCourses.mineAmong(m.courses || [], enrolment);
    const notice = detectNotice(m, {
      courses: mine,
      isAcademicSender: isAcademicSender(m.from),
    });
    if (shouldPromote(notice)) found.push({ m, notice });
    if (found.length >= 3) break;
  }

  wrap.hidden = found.length === 0;
  if (found.length === 0) return;

  const frag = document.createDocumentFragment();
  for (const { m, notice } of found) {
    const li = document.createElement('li');
    li.className = `notice notice-${notice.kind}`;

    const what = document.createElement('span');
    what.className = 'notice-what';
    what.textContent = summarise(notice);

    const why = document.createElement('span');
    why.className = 'notice-why';
    // Quote the sentence it read, so a wrong card can be judged at a glance
    // rather than taken on faith.
    why.textContent = notice.evidence;

    li.append(what, why);
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.onclick = () => openMessage(m.id);
    li.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMessage(m.id); }
    };
    frag.appendChild(li);
  }
  wrap.replaceChildren(frag);
}

/* ========================================================================== *
 * FOLLOW-UPS AND DEADLINE OVERRIDES
 * ========================================================================== */

/** In-memory mirrors, loaded at boot and written through on every change. */
let followupList = [];
let deadlineOverrides = {};
/** The user's courses. Empty until they pick, which means no chips -- correct. */
let enrolment = [];
/** User-authored automation. Empty until the options page writes some. */
let automationRules = [];

/**
 * "Remind me if nobody replies."
 *
 * Distinct from snooze, which hides and returns regardless, and from a
 * deadline, which is imposed from outside. A follow-up is the only one of the
 * three that RESOLVES ITSELF -- if a reply arrives, it disappears without the
 * user doing anything. That is the whole feature.
 */
function openFollowupMenu(id, anchor) {
  const m = store.get(id);
  if (!m) return;
  const existing = followups.hasFollowup(followupList, m.threadId);

  const items = followups.PRESETS.map((p) => ({
    text: p.label,
    run: async () => {
      followupList = followups.setFollowup(followupList, {
        threadId: m.threadId,
        messageId: id,
        dueAt: Date.now() + p.ms,
      });
      await followups.saveFollowups(followupList);
      activity.record({ verb: 'FOLLOWUP_SET', ids: [id], actor: 'user' });
      renderRadar(ctx);
      toast(`Will remind you ${p.label.toLowerCase()}`);
    },
  }));

  if (existing) {
    items.push({
      text: 'Clear follow-up',
      run: async () => {
        followupList = followups.clearFollowup(followupList, m.threadId);
        await followups.saveFollowups(followupList);
        renderRadar(ctx);
        toast('Follow-up cleared');
      },
    });
  }

  openMenu({ anchor, name: 'followup', label: 'Remind me', items });
}

/**
 * Set, correct or dismiss a deadline.
 *
 * The dismissal is the important one. It is stored as an override with a null
 * date rather than by deleting, because deleting would let the extractor
 * re-add the same false deadline on the next ingest and the user would have to
 * dismiss it forever.
 */
function openDeadlineMenu(id, anchor) {
  const m = store.get(id);
  if (!m) return;
  const DAY = 86_400_000;
  const eff = deadlineStore.effectiveDeadline(m, deadlineOverrides);

  const set = async (at, origin) => {
    deadlineOverrides = origin === 'dismiss'
      ? deadlineStore.dismiss(deadlineOverrides, id, { wasText: m.dueText, wasAt: m.dueAt })
      : deadlineStore.setManual(deadlineOverrides, id, at);
    await deadlineStore.saveOverrides(deadlineOverrides);
    activity.record({ verb: 'DEADLINE_SET', ids: [id], actor: 'user' });
    renderRadar(ctx);
    renderList();
    toast(origin === 'dismiss' ? 'Not a deadline' : 'Deadline set');
  };

  const items = [
    { text: 'Today', run: () => set(endOfDay(Date.now())) },
    { text: 'Tomorrow', run: () => set(endOfDay(Date.now() + DAY)) },
    { text: 'In 3 days', run: () => set(endOfDay(Date.now() + 3 * DAY)) },
    { text: 'Next week', run: () => set(endOfDay(Date.now() + 7 * DAY)) },
  ];

  // Only offer to remove what is actually there.
  if (eff.at !== null) {
    items.push({
      text: eff.source === 'extracted' ? 'Not a deadline' : 'Clear',
      run: () => set(null, 'dismiss'),
    });
  }

  openMenu({ anchor, name: 'deadline', label: 'Deadline', items });
}

/** End of the given day, local time -- the same convention deadlines.js uses. */
function endOfDay(ms) {
  const d = new Date(ms);
  d.setHours(23, 59, 0, 0);
  return d.getTime();
}

/* ========================================================================== *
 * THE OUTBOX RUNNER
 * ========================================================================== *
 *
 * The queue is the source of truth and lives in storage; this is only the
 * thing that pokes it. It runs in the PAGE rather than the worker because MV3
 * workers are evicted aggressively -- this project spent ten rounds on one
 * that would not even register -- and a queue that stops draining when Chrome
 * reclaims memory is worse than no queue, since the user believes their mail
 * is pending.
 *
 * One timer, rescheduled from `nextWakeIn`, rather than a poll: a queue that
 * wakes every second to discover it has nothing to do is a battery bug.
 */
let outboxTimer = 0;
/** How many sends had already given up, so only NEW failures are announced. */
let newlyStuck = 0;

async function pumpOutbox() {
  clearTimeout(outboxTimer);
  outboxTimer = 0;

  const result = await outbox.flushOutbox({
    send: (draft) => send('SEND', { draft }),
    onChange: () => renderOutbox(),
  });

  if (result.sent) {
    activity.record({ verb: 'SEND', ids: [], actor: 'user' });
    toast(result.sent === 1 ? 'Message sent' : `${result.sent} messages sent`, { kind: 'success' });
  }
  if (result.failed) {
    activity.record({ verb: 'SEND', ids: [], actor: 'user', outcome: 'failed' });
  }

  /*
   * A SEND THAT HAS GIVEN UP MUST SAY SO, ONCE.
   *
   * The outbox row already reports "Retrying in 15s (attempt 2 of 4)" and turns
   * red when it is stuck -- but that section only exists while the queue is
   * non-empty, and the user has no reason to be looking at it. Their model is
   * "I sent it"; the app's model is "attempt 4 failed". Nothing bridged those,
   * so the worst outcome in the product -- a message the user believes they
   * sent -- was recorded and never announced.
   *
   * Only on the FINAL failure. A toast per retry would train the user to
   * ignore it, and the retries usually succeed.
   */
  const stuck = (await outbox.loadOutbox()).filter(outbox.isStuck);
  if (stuck.length > newlyStuck) {
    const who = displayName(stuck[0].draft?.to || '');
    toast(
      stuck.length === 1
        ? `Could not send to ${who}`
        : `${stuck.length} messages could not be sent`,
      {
        kind: 'error',
        action: { label: 'Show', run: () => $('outbox')?.scrollIntoView({ block: 'nearest' }) },
      }
    );
  }
  newlyStuck = stuck.length;

  const items = await outbox.loadOutbox();
  renderOutbox(items);

  const wake = outbox.nextWakeIn(items);
  if (wake !== null) {
    outboxTimer = setTimeout(pumpOutbox, Math.max(250, wake));
  }
}

/**
 * The outbox rail row.
 *
 * Appears only when the queue is non-empty, the same rule #radar follows --
 * a permanent empty section is the "heading over dead whitespace" problem the
 * completeness audit found in the saved-views list.
 */
async function renderOutbox(known) {
  const wrap = $('outbox');
  const list = $('outbox-list');
  if (!wrap || !list) return;

  const items = known || (await outbox.loadOutbox());
  wrap.hidden = items.length === 0;
  if (items.length === 0) return;

  const frag = document.createDocumentFragment();
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'outbox-item' + (outbox.isStuck(it) ? ' outbox-stuck' : '');

    const who = document.createElement('span');
    who.className = 'outbox-to';
    who.textContent = displayName(it.draft?.to || '(no recipient)');

    const status = document.createElement('span');
    status.className = 'outbox-status';
    status.textContent = outbox.statusOf(it);

    li.append(who, status);

    /*
     * A stuck message needs a way out that is not "wait". Both actions are
     * offered because they answer different questions: retry now for a network
     * that has come back, discard for a message that is no longer wanted.
     */
    if (outbox.isStuck(it)) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'ghost small';
      retry.textContent = 'Retry';
      retry.onclick = async () => { await outbox.retryNow(it.id); pumpOutbox(); };

      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'ghost small';
      drop.textContent = 'Discard';
      drop.onclick = async () => { await outbox.cancel(it.id); renderOutbox(); };

      li.append(retry, drop);
    }
    frag.appendChild(li);
  }
  list.replaceChildren(frag);
}

/**
 * Push the density setting onto the root element.  (Feature 28.)
 *
 * One attribute. `app.css` redefines four spacing tokens and the row height
 * under `:root[data-density=...]`, so every surface follows without a single
 * component knowing the setting exists.
 *
 * `comfortable` writes the attribute too rather than removing it, so the DOM
 * always states the current density -- a missing attribute and the default
 * value would be indistinguishable when debugging a screenshot.
 */
function applyDensity() {
  const d = settings.get('density') || 'comfortable';
  document.documentElement.setAttribute('data-density', d);
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
  /*
   * No loop over menu children to re-tick. The menu is rebuilt from
   * `state.theme` on every open and destroyed on every close, so there is no
   * stale DOM to keep in sync -- one of the four things the hand-rolled
   * version had to remember and this one cannot forget.
   */
  // Re-render the open message. The body iframe is a separate document with
  // its own colours baked into srcdoc, so it cannot follow a variable change.
  // Cheap: the body is already in memory, no refetch.
  if (state.selected && lastBody) el.rBody.srcdoc = renderBody(lastBody);
}

function openThemeMenu() {
  const btn = $('btn-theme');
  btn.setAttribute('aria-expanded', 'true');
  openMenu({
    name: 'theme',
    label: 'Theme',
    anchor: btn,
    className: 'theme-menu',
    // The header wrapper is the positioning context, so the menu hangs under
    // the button rather than being clipped by it.
    mountTo: $('themewrap'),
    items: THEMES.map((t) => ({
      text: t.name,
      // `selected`, not `checked`: six themes are one-of-many, and a screen
      // reader should say so.
      selected: state.theme === t.id,
      className: 'theme-item',
      data: { theme: t.id },
      prefix: themeDot(t.swatch),
      suffix: themeTick(),
      run: () => setTheme(t.id),
    })),
    // One place unsets aria-expanded, whichever way the menu went away.
    onClose: () => btn.setAttribute('aria-expanded', 'false'),
  });
}

function closeThemeMenu() {
  closeMenu();
}

$('btn-theme').addEventListener('click', (e) => {
  e.stopPropagation();
  menuIsOpen() ? closeMenu() : openThemeMenu();
});

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
  cancelExit(el.help);
  el.help.hidden = false;
  helpLayer = openLayer({
    name: 'help',
    node: el.help,
    onClose: () => {
      closeWithMotion(el.help);
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

/*
 * Saved views live in saved-views.js. renderViews() is still called from the
 * render loop below -- the module owns the rendering, not the scheduling.
 */





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
  document.body.classList.toggle('selecting', n > 0);

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
 * What each bulk action does to Gmail's labels, stated ONCE.
 *
 * WHY THIS IS A TABLE
 * -------------------
 * `bulkAct` used to carry TWO five-branch ladders: a forward chain of
 * `if (kind === 'archive') send({remove: ['INBOX']}) else if ...`, and a
 * second chain inside `recordUndo` that hand-wrote each inverse. Ten
 * statements for five actions, with nothing connecting a delta to its
 * reversal except that someone typed both correctly.
 *
 * Every inverse was in fact correct when this was written -- checked, not
 * assumed. The problem is that nothing MADE them correct. Adding a sixth
 * action means remembering to edit two ladders in two places, and getting an
 * inverse wrong is close to invisible: the list on screen is restored from the
 * local snapshot regardless of what goes to the server, so a broken undo looks
 * perfect locally and only diverges in Gmail, where the test suite cannot see.
 * A row-counting test passed happily with `trash`'s undo sabotaged.
 *
 * Now the delta is written once and the undo is `{add: remove, remove: add}`.
 * An inverse cannot drift from its action because it is no longer stored.
 */
const BULK_ACTIONS = {
  archive: { verb: 'Archived', remove: ['INBOX'] },
  trash: { verb: 'Deleted', add: ['TRASH'], remove: ['INBOX'] },
  read: { verb: 'Marked read', remove: ['UNREAD'] },
  star: { verb: 'Starred', add: ['STARRED'] },
  // Junk arrives in batches, so reporting it one message at a time is
  // exactly the friction this product exists to remove.
  spam: { verb: 'Reported', add: ['SPAM'], remove: ['INBOX'] },
};

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

  const { verb, add = [], remove = [] } = BULK_ACTIONS[kind];

  /*
   * A LONG BULK OPERATION HAS TO LOOK LIKE WORK.
   *
   * The optimistic update is so effective that it hides the request: the rows
   * leave instantly, and then for a second or more over campus wifi nothing
   * happens and nothing says anything is outstanding. A user who closes the
   * tab in that window loses the operation.
   *
   * `aria-busy` already drives the topbar sweep used for sync, so this is the
   * existing idiom applied to the operation with the largest blast radius --
   * not a new indicator. Only for batches big enough to be slow: raising it
   * for a two-message archive would be a flicker.
   */
  const slow = ids.length >= 10;
  if (slow) setBusy(true);

  try {
    await send('BULK', { ids, add, remove });
  } catch (err) {
    // Roll the whole batch back. A partial apply would leave the list
    // disagreeing with Gmail with no indication which half won.
    store.batch(() => {
      for (const m of snapshots) store.upsert(m);
    });
    activity.record({ verb: `BULK_${kind.toUpperCase()}`, ids, actor: 'user', outcome: 'failed', error: err?.message });
    toast(`Could not ${kind}: ${err.message}`, { kind: 'error' });
    return;
  } finally {
    // `finally`, so an early return on the error path cannot strand the busy
    // state and leave the topbar sweeping forever.
    if (slow) setBusy(false);
  }

  activity.record({ verb: `BULK_${kind.toUpperCase()}`, ids, actor: 'user' });

  recordUndo(ctx, `${verb} ${n} ${noun}`, async () => {
    store.batch(() => {
      for (const m of snapshots) store.upsert(m);
    });
    // The inverse is DERIVED, never typed: swap add and remove.
    await send('BULK', { ids, add: remove, remove: add });
    activity.record({ verb: `BULK_${kind.toUpperCase()}`, ids, actor: 'user', detail: 'undo' });
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

/**
 * Unhook the cross-page settings listener.
 *
 * Registered at boot, so it must be released on teardown: a listener left
 * attached outlives the document it was created for, and in tests the next
 * boot inherits a handler writing into a settings cache from a closed window.
 */
let stopFollowingSettings = null;

function cancelPendingWork() {
  stopFollowingSettings?.();
  stopFollowingSettings = null;
  stopAutoRefresh();
  // Server search owns its own timer and token, and resets them itself.
  _resetServerSearch();
  _resetViews();
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
  // Saved views render into the rail and count against the inbox store.
  viewsList: () => el.viewsList,
  // Server search needs to know what is already on screen (so it only reports
  // genuinely new hits) and how to merge what Gmail returns.
  visibleIds: () => visibleIds(),
  ingest: (msgs) => ingest(msgs),
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
  // Compose hands a queued send back to the runner so the hold starts ticking
  // immediately rather than on the next scheduled wake.
  flushOutbox: () => pumpOutbox(),
  // Templates fill {{name}} from the signed-in account.
  profileName: () => (state.selfEmail || '').split('@')[0].replace(/[._]/g, ' '),
  /*
   * The radar reads deadlines through here rather than off `m.dueAt`, so a
   * user correction or dismissal is honoured everywhere the panel looks.
   */
  dueAtOf: (m) => deadlineStore.dueAtOf(m, deadlineOverrides),
  dueFollowups: () => followups.dueFollowups(followupList, store, state.selfEmail),
  undoSendMs: () => settings.get('undoSendSeconds') * 1000,
};

/*
 * Test seam: is a poll actually scheduled? Needed because refresh() guards on
 * signedIn too, so request counts alone cannot tell a cancelled timer from a
 * live one that is being ignored -- and a live one is a wakeup every interval
 * for the life of the tab.
 */
window.__bmmAutoRefreshPending = () => autoRefreshTimer !== 0;
window.__bmmIngest = ingest;
/*
 * Test seam. Sending is queued behind an undo-send hold, so a harness cannot
 * observe SEND on the wire without either waiting out a real timer or driving
 * the runner. Driving it is deterministic.
 */
window.__bmmPumpOutbox = () => pumpOutbox();
/* Test seam: the gate is reached through several error paths; driving it
   directly is what lets a test assert which explanation each one shows. */
window.__bmmShowGate = (m) => showGate(m);
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
/*
 * The activity log batches its writes on a 1.5s timer. A tab closed inside
 * that window would lose the tail of a triage session, which is exactly the
 * stretch someone would be trying to reconstruct.
 */
window.addEventListener('pagehide', () => { activity.flush(); });

window.__bmmTeardown = cancelPendingWork;

// ------------------------------------------------------------------- start --

async function start() {
  try {
    const p = await send('PROFILE');
    el.account.textContent = p.emailAddress || '';
    state.selfEmail = p.emailAddress || '';
  } catch {
    /* not fatal; the list is what matters */
  }

  // Fire-and-forget: the palette gains the user's Gmail labels once this
  // lands, and behaves exactly as before until it does. Not awaited, because
  // nothing on screen depends on it.
  refreshLabels(ctx);

  /*
   * Drain anything the last session left queued -- a send that was still held
   * when the tab closed, or one that failed and is due a retry.
   */
  pumpOutbox();

  // The empty search box offers what was searched before, so the history has
  // to be in memory before the field is first focused.
  suggest.loadHistory().then((h) => { queryHistory = h; });
  renderSnoozed();
  engine.loadRuleList().then((r) => { automationRules = r; });
  myCourses.loadEnrolment().then((list) => {
    enrolment = list;
    if (list.length) renderList();
  });

  // The radar merges these, so they must be in memory before it first paints.
  Promise.all([followups.loadFollowups(), deadlineStore.loadOverrides()])
    .then(([f, d]) => {
      followupList = f;
      deadlineOverrides = d;
      renderRadar(ctx);
    })
    .catch(() => { /* the radar degrades to extracted deadlines only */ });

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

  /*
   * Then follow anything the OPTIONS PAGE changes while this tab stays open.
   *
   * Options is a separate extension page, so its writes cannot reach an
   * in-process subscriber -- `chrome.storage.onChanged` is the only channel
   * that crosses pages. Without this the cache above is a boot-time snapshot:
   * turning off "mark read on open" changed nothing here until the tab was
   * reloaded, which reads as the setting being broken.
   */
  stopFollowingSettings = settings.followExternalChanges();

  /*
   * ...and repaint for the ones that change how mail is DRAWN.
   *
   * A current cache is enough for `markReadOnOpen`, which is read at the
   * moment a message opens. It is not enough for `threaded`, read in six
   * render paths: the list on screen was built from the old value and nothing
   * would ask it to redraw, so conversation view appeared to do nothing until
   * some unrelated event forced a render.
   *
   * `subscribe()` is what makes this possible and, until now, had no callers
   * at all -- it could only ever have fired for writes from THIS page, and the
   * only such write is the theme picker, which repaints itself.
   */
  settings.subscribe((key) => {
    if (key === 'threaded') {
      renderList();
      renderSidebar();
    }
    /*
     * Density is a pure CSS token remap, so it needs no re-render at all --
     * the attribute change repaints every surface at once. Handled here rather
     * than in the options page so the two stay in step through the same
     * channel `threaded` already uses.
     */
    if (key === 'density') {
      applyDensity();

  /*
   * POLISH 17 (coach mark): one-time, dismissible, never again. A toast is
   * the right surface because it is the surface every other transient
   * already uses -- a coach mark widget of its own would be a second
   * transient system.
   */
  if (!settings.get('coachDone')) {
    settings.set('coachDone', true);
    toast('Every verb has a key -- press ? to see them all', {
      ms: 7000,
      action: { label: 'Got it', run: () => {} },
    });
  }
      // The bloom's clip condition depends on line width; a density change
      // re-decides every row rather than leaving stale classes behind.
      refreshSubjectClip();
    }
    if (key === 'lanes') renderList();
  });

  // Theme next, before anything paints, so there is no flash of the wrong
  // palette. `applyTheme` falls back to the default for an unknown id, which
  // covers the old binary 'light'/'dark' values from before the picker.
  const theme = settings.get('theme');
  /*
   * POLISH 18: first run honours the OS. A student whose machine is dark
   * gets midnight instead of a flashbang; an explicit saved choice always
   * wins, so this only ever decides the FIRST impression.
   */
  const osDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  state.theme = applyTheme(theme || (osDark ? 'midnight' : DEFAULT_THEME)).id;
  applyDensity();

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
        document.body.classList.toggle('list-scrolled', on);
      }
    },
    { passive: true }
  );

  // Bulk bar.
  setIcon($('bulk-cancel'), 'close', { size: 14 });
  setIcon($('r-prev'), 'back', { size: 15 });
  setIcon($('r-next'), 'forward', { size: 15 });
  $('r-prev').addEventListener('click', () => move(-1));
  $('r-next').addEventListener('click', () => move(1));
  /*
   * Icon-only action buttons (audit 33). Five text verbs needed 423px in a
   * ~318px pane and left three of themselves unreachable; the icons reuse the
   * glyphs the context bar already uses for the same verbs, and the labels
   * live on aria-label/title in app.html. `warning` IS the spam glyph — the
   * triangle, deliberately, because spam is a place you visit, not an action
   * you take.
   */
  setIcon($('bulk-read'), 'mail', { size: 15 });
  setIcon($('bulk-star'), 'star', { size: 15 });
  setIcon($('bulk-archive'), 'archive', { size: 15 });
  setIcon($('bulk-spam'), 'warning', { size: 15 });
  setIcon($('bulk-trash'), 'trash', { size: 15 });
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
  wireServerSearch(ctx);
  wireViews(ctx);
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
  /*
   * POLISH 13: under an hour, "14:52" makes the eye do subtraction the
   * interface already did. "12m" is the recency a triaging brain wants;
   * the same-day clock returns after an hour, when wall time matters more.
   */
  if (now - ms < 3600000) {
    return `${Math.max(1, Math.floor((now - ms) / 60000))}m`;
  }
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
