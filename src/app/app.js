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
import { THEMES, applyTheme, getTheme, DEFAULT_THEME } from './themes.js';
import { icon, setIcon } from './icons.js';
import { setAttr } from './dom.js';
import { toast, hideToast, initToast } from './toast.js';
import { loadViews, saveView, removeView } from './views.js';
import { extractDeadline } from './deadlines.js';
import { runInPage, probeWorker } from './fallback.js';
import { closeHelp, toggleHelp, helpOpen } from './help.js';
import { openSnoozeMenu, wireSnoozeMenu } from './snooze-menu.js';
import { openCategoryMenu, wireCategoryMenu } from './category-menu.js';
import { renderNotices, wireNotices } from './notices-rail.js';
import { wireBulkbar } from './bulkbar.js';
import { buildReply } from './query.js';
import * as settings from './settings.js';
import { addressOf } from './contacts.js';
import { audienceOf } from './direct.js';
import * as activity from './activity.js';
import * as engine from './rule-engine.js';
import * as followups from './followups.js';
import * as deadlineStore from './deadline-store.js';
import * as myCourses from './my-courses.js';
import { detectNotice, shouldPromote, summarise } from './notices.js';
import {
  wireReader, openMessage as openMessageRaw, closeReader as closeReaderRaw,
  renderThreadStrip, syncReaderActions,
  repaintBody, cancelMarkRead, loadImageAllowList, openPartId, renderReaderTags,
} from './reader.js';
import { wireSuggestUI, renderSuggestions, cancelSuggestBlur } from './suggest-ui.js';
import {
  wireRails, renderSnoozed, renderOutbox, pumpOutbox, cancelOutboxTimer,
} from './rails.js';
import {
  wireList, renderList, patchRow, reorientTo, rowDomId, visibleIds,
  collapseThreads, setCount, setSkeleton, refreshSubjectClip, travelGhost,
  clearRows, resetScrollState, capturePreSearchScroll, applySearchScroll,
  saveScroll, recallScroll, announceNew, renderedIdsOf, nodeByIdOf,
} from './list.js';
import { wireSidebar, buildSidebar, renderSidebar } from './sidebar.js';
import {
  wireBulk, selection, move, renderSelection, bulkAct, reconcileBulk, BULK_ACTIONS,
} from './bulk.js';
import { displayName, fullDate } from './display.js';
import { renderShortcuts } from './shortcuts.js';
import { openLayer, closeTopLayer, hasLayers, closeAllLayers, closeWithMotion, cancelExit } from './layers.js';
import { openMenu, closeMenu, menuIsOpen } from './menu.js';
import { wireRowActions } from './row-actions.js';
import { wireSearchChips } from './search-chips.js';
import {
  wireDeepLinks, navigateHash, mirrorHash, applyHash, checkPendingSelection,
  clearHash,
} from './deep-links.js';
import { promptDialog } from './dialog.js';
import { openActivityLog } from './activity-ui.js';
import {
  scheduleServerSearch, wireServerSearch, _resetServerSearch,
  clearSearchOverlay,
} from './server-search.js';
import {
  renderViews, refreshViews, suggestViewName, updateSaveAffordance, currentViews,
  wireViews, _resetViews,
} from './saved-views.js';
import {
  DEFAULT_MAILBOX, getMailbox, isMailbox, showsCategories,
} from './mailboxes.js';
import {
  emptyRules, loadRules, saveRules, pruneThreadMutes, toggleMute, toggleAutoArchive,
  isAutoArchived, applyCorrection, correctSender, clearCorrection,
  mutedCount,
} from './rules.js';
import { addSnooze, removeSnooze } from './snooze.js';
import {
  undoStack, recordUndo, performUndo,
  renderRadar, wireRadar, renderReaderIdle,
  openPalette, closePalette, wirePalette,
  openCompose, closeCompose, wireCompose, startReply,
  restoreDraftIfAny, flushDraft, refreshLabels, _setLabels, editDraft, labelNames,
  wireAutocomplete, refreshContacts,
} from './features.js';
import {
  initTimetable, openTimetable, closeTimetable, timetableIsOpen,
  scanForUpdates, deepScanMessages, _resetTimetableUI,
} from './timetable-ui.js';
import { classify } from '../classify/index.js';
import {
  CATEGORY_LABELS,
  SIDEBAR_ORDER,
} from '../classify/categories.js';
import { courseNumbersIn, isAcademicSender } from './timetable-mail.js';
import { STORAGE } from '../platform/storage.js';

// ---------------------------------------------------------------- constants --


/** Messages pulled per page. Gmail's batch endpoint caps at 100. */
const PAGE = 100;


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
/*
 * COHERENCE INVARIANT (R-2): `renderedIds` and `nodeById` describe the SAME
 * snapshot. They must be cleared together, SYNCHRONOUSLY, before any queued
 * frame fires — resetView() is the only sanctioned path; bulk operations
 * must resolve through it, never through `store.idsFor('all')`, or a stale
 * frame repopulates the list after a clear (the sign-out render bug).
 */


// ------------------------------------------------------------------- lookup --

const $ = (id) => document.getElementById(id);


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

/*
 * EMBED PROVENANCE (bug-hunt 44 #70). app.html is web-accessible to
 * mail.google.com so the takeover can iframe it -- which means anything on
 * the Gmail page can iframe it too. The legitimate embedder (our content
 * script) mints a one-time nonce into the frame URL; a foreign embedder
 * cannot. When we are embedded WITHOUT a nonce, we refuse to boot: no auth
 * probes, no storage reads, no UI an attacker could costume.
 */
const EMBED_NONCE = (() => {
  const search = globalThis.window?.location?.search || '';
  const n = new URLSearchParams(search).get('embed');
  return n && /^[A-Za-z0-9_-]{8,64}$/.test(n) ? n : '';
})();
const IS_EMBEDDED = (() => {
  const w = globalThis.window;
  return !!w && !!w.parent && w.parent !== w;
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
  listQuery: $('listquery'),
  account: $('account'),
  freshness: $('freshness'),
  toastIcon: $('toast-icon'),
  toastKbd: $('toast-kbd'),
  rPrev: $('r-prev'),
  rNext: $('r-next'),
  newpill: $('newpill'),
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
  // The whole due queue: per item, attachment refetch + a send with its own
  // retries. Generous on purpose -- declaring the worker dead mid-pump would
  // degrade the session over work that is succeeding.
  OUTBOX_PUMP: 300000,
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
  /*
   * DEGRADED IS A STATE, NOT A VERDICT (cross-audit H1). One slow response
   * used to latch the session into fallback forever while probeWorker()
   * sat uncalled. Now the worker is re-probed on every `online` event and
   * on a slow idle interval, and a live worker restores worker mode — the
   * user's snooze alarms and shortcuts come back without a reload.
   */
  scheduleWorkerProbe();
}

let probeTimer = 0;
/*
 * ONE-SHOT CHAINED PROBES, not a permanent interval (V2 stress/UX). A
 * forever-60s timer pinned the MV3 worker awake and hung test teardowns.
 * Invariant: while the worker is healthy, no recovery timer exists at all.
 * Failure schedules exactly one next probe; success stops the chain.
 */
function scheduleWorkerProbe() {
  if (probeTimer) return;
  const check = async () => {
    probeTimer = 0;
    if (!workerDown) return; // recovered elsewhere: chain ends
    let alive = false;
    try { alive = await probeWorker(); } catch { alive = false; }
    if (alive) {
      workerDown = false;
      // The degradation banner is a claim about the present; a recovered
      // worker makes it false, so it goes with the state it describes
      // (bug-hunt 43 #25). Leaving it up made the UI say "unavailable"
      // while the toast said "recovered".
      document.getElementById('sw-warn')?.remove();
      toast('Background worker recovered');
      return; // chain ends
    }
    // Still degraded: one next probe, unref'd where the runtime allows.
    probeTimer = setTimeout(check, 60000);
    probeTimer.unref?.();
  };
  window.addEventListener('online', () => { clearTimeout(probeTimer); probeTimer = 0; check(); }, { once: true });
  probeTimer = setTimeout(check, 5000);
  probeTimer.unref?.();
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
    renderReaderIdle(ctx);
    renderViews();
    renderNotices();
    /*
     * 65/g: the URL mirrors the SETTLED FRAME — whatever is on screen once
     * the frame lands is what the hash says. j/k history pollution is
     * structurally impossible here: the mirror only ever replaceStates.
     * And a deep-linked message whose data arrives with this frame opens now.
     */
    checkPendingSelection();
    mirrorHash();
  });
}

/*
 * 65/g: the hash mirror, coalesced like the renders it describes.
 *
 * scheduleRender's frame covers store-driven change, but typing a query and
 * opening a message render DIRECTLY (responsiveness is the point of those
 * paths) and would otherwise leave the URL describing yesterday's view.
 * Anything that commits view state outside a store notification queues a
 * mirror here — same one-frame discipline, deduplicated inside deep-links.
 */
let mirrorFrame = 0;
function queueHashMirror() {
  if (mirrorFrame) return;
  mirrorFrame = requestAnimationFrame(() => {
    mirrorFrame = 0;
    checkPendingSelection();
    mirrorHash();
  });
}

/*
 * The shell's open/close, wrapped ONCE so every path — row clicks, Enter,
 * j/k's move, the thread strip, notices, the palette — mirrors its
 * selection without each caller learning about URLs. reader.js itself
 * stays ignorant of the address bar: its job is showing a conversation.
 */
const openMessage = (id) => { openMessageRaw(id); queueHashMirror(); };
const closeReader = () => { closeReaderRaw(); queueHashMirror(); };

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
let cacheQuotaWarned = false;
const saver = createSaver(() => {
  const inbox = stores.get('inbox');
  return inbox.idsFor('all').slice(0, CACHE_MAX).map((id) => inbox.get(id)).filter((m) => m && !m.fromSearch);
}, STORAGE, {
  // P-7: a full local-storage quota used to fail silently — the cache is an
  // optimisation, but the user should know offline paint is degraded. Once
  // per session; every failed write is not worth a toast each.
  onError: () => {
    if (cacheQuotaWarned) return;
    cacheQuotaWarned = true;
    toast('Local storage is full — offline painting is limited', { kind: 'error' });
  },
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
    resetScrollState();
    el.scroller.scrollTop = 0;
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
  clearRows();
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
/*
 * Server-search results live in the store ONLY while a query is active, so
 * they can render and open like anything else. The moment the query clears
 * they are purged (cross-audit H4): they were never inbox mail, and leaving
 * them behind is how archived mail ended up in unread counts and lanes.
 */

/*
 * SELECTORS (audit 39/40 ARCH R-6). All derived-state logic — mute, threading,
 * the query predicate, the server-search overlay merge — lives in
 * src/app/selectors.js as pure functions. The shell only builds the ctx: the
 * LIVE state values (read at call time, so a mutation between renders is
 * impossible), the threaded setting, the muted list, the query parser with
 * its deadline overrides, and the ephemeral overlay. `visibleIds()` remains
 * the single choke point every render path goes through.
 */


/**
 * Build a Gmail URL for the CURRENT account index.
 * The old code hardcoded u/0, sending every "Open in Gmail" to the first
 * signed-in account (cross-audit P0-01). Every escape hatch must share this.
 */
function gmailUrl(threadId, mailbox = 'inbox') {
  return `https://mail.google.com/mail/u/${ACCOUNT_INDEX}/#${mailbox}/${threadId}`;
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
/*
 * 65/h (F9): one failure surface for every verb. The rollback already put
 * the message back as if nothing happened, so what the user lost is not
 * data but INTENT — they still want the thing archived/starred/reported.
 * An error toast that only announces makes them reconstruct that intent;
 * the Retry chip carries it: re-run the very act that failed. `retry` is a
 * closure over the act, not the wire call, so undo entries, thread spans
 * and optimistic motion all replay exactly as the first attempt did.
 */
function toastFailure(text, retry) {
  toast(text, retry
    ? { kind: 'error', action: { label: 'Retry', run: retry } }
    : { kind: 'error' });
}

function flagAction({
  id, patch, undoPatch, verb, undoVerb, payload = {}, undoPayload = {}, past, failed, retry,
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
  setInFlight(id, verb);
  const sent = send(verb, { id, ...payload }).then(
    () => {
      clearInFlight(id);
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
      clearInFlight(id);
      store.patch(id, undoPatch);
      if (id === state.selected) syncContextActions(store.get(id));
      activity.record({ verb, ids: [id], actor: 'user', outcome: 'failed', error: err?.message });
      toastFailure(failed, retry); // 65/h
    }
  );

  return sent;
}

/*
 * IN-FLIGHT REGISTRY (roadmap H1 / round-62 N-2).
 *
 * The optimistic model is right, but until now the UI could not distinguish
 * "the action landed" from "the UI moved and we are still waiting". For the
 * flag verbs the row STAYS, so it can carry the truth: while the verb is on
 * the wire the row wears a subtle in-flight mark, cleared the moment the
 * request settles either way. Remove-verbs vanish from the list, so the mark
 * is set but never seen -- harmless, and the rollback path still clears it.
 *
 * Purely additive: the optimistic mutation, rollback, undo and batch
 * machinery are untouched. This only projects in-flightness onto the row.
 */
const inFlight = new Map(); // messageId -> verb, while the request is live

function isInFlight(id) {
  return inFlight.has(id);
}

function setInFlight(id, verb) {
  inFlight.set(id, verb);
  patchRow(id);
}

function clearInFlight(id) {
  if (inFlight.delete(id)) patchRow(id);
}

function optimistic({
  id, verb, undoVerb, past, failed, done, before, rollback: undoLocal, undoBefore, retry,
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
    const node = nodeByIdOf().get(id);
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
    toastFailure(failed, retry); // 65/h
  };

  const run = async () => {
    if (before) await before(id);
    setInFlight(id, verb);
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
      clearInFlight(id);
      activity.record({ verb, ids: [id], actor: 'user' });
      if (undoVerb) {
        recordUndo(ctx, past, async () => {
          if (undoBefore) await undoBefore(id);
          store.upsert(snapshot);
          await send(undoVerb, { id });
          activity.record({ verb: undoVerb, ids: [id], actor: 'user', detail: 'undo' });
          renderList();
          requestAnimationFrame(() => reorientTo(id));
        });
      }
      if (done) toast(done);
    },
    (err) => {
      clearInFlight(id);
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

  /*
   * 65/h: every failure path below offers Retry, and Retry is this whole
   * act again — not a bare wire resend — so the re-attempt replays
   * thread-spanning, undo recording and the optimistic travel exactly as
   * the first attempt did. One closure stated once, passed everywhere.
   */
  const retryAct = () => act(action, id);

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
        retry: retryAct,
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
        retry: retryAct,
      });
      break;
    }
    // Gmail cannot undo an archive. We can, because the message is still in
    // memory and re-applying INBOX is one call.
    case 'archive':
      optimistic({
        id, verb: 'ARCHIVE', undoVerb: 'UNARCHIVE',
        past: 'Archived', failed: 'Could not archive',
        retry: retryAct,
      });
      break;
    case 'trash':
      optimistic({
        id, verb: 'TRASH', undoVerb: 'UNTRASH',
        past: 'Deleted', failed: 'Could not delete',
        retry: retryAct,
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
        retry: retryAct,
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
        before: (mid) => removeSnooze(mid, STORAGE),
        retry: retryAct,
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
        retry: retryAct,
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
    before: () => addSnooze(id, wakeAt, STORAGE),
    rollback: () => removeSnooze(id, STORAGE),
    undoBefore: () => removeSnooze(id, STORAGE),
  });
}

/** Keep the reading pane useful after a destructive action. */
function selectNeighbourThen(id) {
  if (state.selected !== id) return;
  const ids = renderedIdsOf();
  const i = ids.indexOf(id);
  const nextId = ids[i + 1] || ids[i - 1];
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
/**
 * THE canonical record shaper (audit 40 / cross-audit B-01).
 *
 * One pipeline shapes every ingested message, whichever mailbox or caller it
 * arrives through: recipient headers, audience and courses are stamped HERE,
 * once, where the headers and the signed-in address are in hand. The legacy
 * second shaper dropped exactly those fields, which made `is:direct`, lanes
 * and course chips disagree depending on which path loaded the mail -- the
 * root pattern behind findings B-01/B-02/B-07. There is now no second truth
 * to drift.
 */
function shapeRecords(messages, classified) {
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
      headers: m.headers,
      audience: audienceOf(m, state.selfEmail),
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
        // working -- see the deadline tag -- rather than asserting a date it
        // has to take on faith.
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
  return records;
}

function ingestInto(mailboxId, messages, classified) {
  storeFor(mailboxId).upsertMany(shapeRecords(messages, classified));
}

function ingest(messages) {
  if (!messages.length) return;
  // The inbox arrival pipeline: same canonical shaper as every other path,
  // then the arrival-only consequences (auto-archive, user rules).
  const records = shapeRecords(messages, true);
  store.upsertMany(records); // one batch -> one notification -> one frame
  /*
   * ACADEMIC INTELLIGENCE SCANS AT INGEST (bug-hunt 44 #46/#47), BEFORE
   * auto-archive and rules can move a message out of sight. The contract:
   * eligibility is "academic sender naming one of your courses", NOT inbox
   * presence -- and bodies are fetched only for the few candidates the cheap
   * scan cannot settle. Fire-and-forget: the findings surface via the
   * timetable badge, and a scan failure must never touch the mail pipeline.
   */
  deepScanMessages(records, async (id) => {
    const body = await send('GET_BODY', { id });
    return body?.text || '';
  }).catch(() => {});
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
  // Search results never trigger automation (cross-audit H4).
  records = records.filter((m) => !m.fromSearch);
  if (records.length === 0) return;

  const { batches, fired } = engine.planFor(automationRules, records);
  if (batches.length === 0) return;

  const named = new Map(automationRules.map((r) => [r.id, r.name]));

  for (const batch of batches) {
    const spec = BULK_ACTIONS[batch.type === 'markRead' ? 'read' : batch.type];
    if (!spec) continue;
    try {
      const res = await send('BULK', { ids: batch.ids, add: spec.add || [], remove: spec.remove || [] });
      const failed = new Set(res?.failed || []);
      const applied = batch.ids.filter((id) => !failed.has(id));
      // Local state mirrors exactly what Gmail accepted (V2 P1-8); rejected
      // ids were never touched locally, so there is nothing to roll back.
      store.batch(() => {
        for (const id of applied) {
          if (batch.type === 'archive') store.remove(id);
          else if (batch.type === 'markRead') store.patch(id, { unread: false });
          else if (batch.type === 'star') store.patch(id, { starred: true });
        }
      });
      if (failed.size) {
        activity.record({ verb: `RULE_${batch.type.toUpperCase()}`, ids: [...failed], actor: 'rule', outcome: 'partial' });
      }
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
  const hits = records.filter((m) => targets.has(m.category) && m.unread && !m.fromSearch);
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
    (res) => {
      const failed = reconcileBulk(res, records);
      if (failed.length) {
        activity.record({ verb: 'BULK_ARCHIVE', ids: failed, actor: 'auto', outcome: 'partial' });
        toast(`Auto-archived ${ids.length - failed.length} of ${ids.length}`, { kind: 'error' });
        return;
      }
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
  const epoch = opEpoch;
  const { messages, nextPageToken } = await send('SYNC_PAGE', {
    opts: { pageToken, max: PAGE },
  });
  if (epoch !== opEpoch) return; // signed out / switched while in flight
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
    reportError(err, { retry: () => loadPage(pageToken) }); // 65/h
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
  const epoch = opEpoch;
  try {
    const res = await send('SYNC_DELTA');
    if (epoch !== opEpoch) return 'stale';

    if (res.kind === 'resync' || res.kind === 'none') {
      // The history cursor expired (Gmail keeps about a week) or we never had
      // one. Everything we hold may be stale, including messages archived
      // elsewhere, so start clean rather than merge.
      // Same hazard as sign-out: the store notification only schedules a
      // render, so the view must be reset synchronously before refilling.
      resetView();
      saver.invalidate();
      // The cache is stale in the same way the store was; drop it so a failed
      // reload cannot resurrect archived mail on the next open.
      await clearCache();
      saver.invalidate();
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
    if (state.selected && !store.get(state.selected)) {
      closeReader();
    } else if (state.selected) {
      /*
       * LIVE THREAD STRIP (round 45 M6). A reply that lands while you are
       * reading changes the conversation; the strip must say so without a
       * reopen. Cheap: it hides itself for single-message threads, so the
       * common case costs one lookup.
       */
      renderThreadStrip(state.selected);
    }

    state.lastSync = Date.now();
    const n = res.added.length;
    // R3: the pill takes the announcement when the user is scrolled deep;
    // the toast covers what the pill did not (list extraction, round 52).
    const pillShown = announceNew(n);
    if (n && !pillShown) toast(`${n} new message${n > 1 ? 's' : ''}`);
    else if (!n && !silent) toast('Up to date');
    return 'delta';
  } catch (err) {
    reportError(err, { retry: () => refresh() }); // 65/h
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

function reportError(err, { retry } = {}) {
  const msg = String(err?.message || err);
  if (/client ID/i.test(msg)) {
    showGate(msg);
  } else if (/AUTH_RENEW_TRANSIENT/.test(msg)) {
    toast('Sign-in renewal paused — it will retry when your connection returns.');
  } else if (/401|invalid_grant|No refresh token/i.test(msg)) {
    state.signedIn = false;
  opEpoch++; // late responses from this session are now stale
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
    /*
     * 65/h (F9): an error toast that names no way forward is an epitaph.
     * Sync call sites hand in the operation that failed, so the toast ends
     * in Retry; a retry that fails re-enters through this same funnel and
     * earns the same button, which is the honest loop.
     */
    toast(msg.slice(0, 140), {
      kind: 'error',
      ...(retry ? { action: { label: 'Retry', run: retry } } : {}),
    });
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

let gateFocusFrom = null;
function showGate(message) {
  // Remember where focus was so hideGate() can hand it back (modal dialog
  // lifecycle: focus in on show, focus out on hide).
  gateFocusFrom = document.activeElement;
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
  // Hand focus back to wherever it was before the gate covered the app.
  // Only when the gate was actually SHOWN: at first boot nothing was
  // covered, so grabbing the search field would steal focus for no reason.
  const back = gateFocusFrom && gateFocusFrom.isConnected ? gateFocusFrom : null;
  if (back && typeof back.focus === 'function') back.focus();
  gateFocusFrom = null;
}

// ------------------------------------------------------------------ events --

// One delegated listener for the whole list. The old version attached three
// listeners per row; at 200 rows that is 600 listeners to create and tear down
// on every refresh.

/*
 * TOUCH (round 46 #11): swipe left to archive, swipe right to unarchive,
 * long-press to select. Horizontal dominance is required first, so a
 * vertical pan never triggers -- CSS hands the pan back to the browser via
 * touch-action, and these own only the deliberate gestures.
 */



/**
 * Switch category, clearing any active search.
 *
 * Leaving the search box populated while switching category silently
 * double-filters: the user clicks "Library", sees nothing, and has no
 * indication that a stale query from two minutes ago is still applied. The
 * visible control must match the applied state.
 */
function selectCategory(key) {
  // Clicking a category while the timetable workspace is open is a
  // request to be back in mail first (round 54).
  if (timetableIsOpen()) closeTimetable();
  // R4: each mailbox keeps its place; returning is returning, not resetting.
  saveScroll(state.category);
  state.category = key;
  if (state.query) {
    state.query = '';
    el.search.value = '';
    clearSearchOverlay(); // V2 P0-4: search citizens leave with the query
  }
  renderList();
  // After the render: restoring before it would be overwritten by the
  // rebuild's own scroll preservation.
  resetScrollState();
  el.scroller.scrollTop = recallScroll(key);
  renderSidebar();
  // Clearing the query also clears whichever saved view was active. Leaving it
  // highlighted would claim a filter is applied when it is not.
  renderViews();
  updateSaveAffordance();
  // 65/g: a category switch is a deliberate VIEW navigation — one Back step.
  navigateHash();
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
  if (timetableIsOpen()) closeTimetable();

  const mb = getMailbox(id);
  state.mailbox = id;
  opEpoch++; // in-flight loads belong to the previous mailbox
  store = wireStore(id);
  // Category is an inbox-only concept; entering Sent with `category:library`
  // still applied would show an empty list for no visible reason.
  state.category = 'all';
  state.query = '';
  el.search.value = '';
  // The overlay belongs to the query (bug-hunt #26): leaving it alive let
  // stale INBOX search hits merge into the next mailbox's results, because
  // scheduleServerSearch returns early outside the inbox and never clears.
  clearSearchOverlay();
  state.selected = null;
  selection.clear();

  closeReader();
  clearRows();
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
  // 65/g: mailbox switches are deliberate view navigations — one Back step.
  navigateHash();
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
  const epoch = opEpoch;
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
    if (epoch !== opEpoch) return; // stale generation
    ingestInto(id, messages, mb.classified);
    mbState(id).nextPageToken = nextPageToken || '';
    mbState(id).loaded = true;
    // PRUNE after a full sync — but ONLY when the store now holds the whole
    // mailbox: the first page of a fresh sync with no further pages and a
    // store that never hit its cap. Pruning against a partial store would
    // silently delete overrides/mutes/follow-ups for messages that are simply
    // not loaded yet (e.g. a 3000-message inbox where only 100 are in memory).
    if (id === 'inbox' && !pageToken && !nextPageToken && !store.isFull) {
      pruneAfterFullSync();
    }
    if (state.mailbox === id) {
      state.nextPageToken = mbState(id).nextPageToken;
      $('btn-more').disabled = !mbState(id).nextPageToken;
      renderList();
      renderSidebar();
    }
  } catch (err) {
    reportError(err, { retry: () => loadMailboxPage(id, pageToken) }); // 65/h
  } finally {
    ms.loading = false;
    syncBusy();
  }
}

/**
 * Sweep storage blobs that grow with every muted/overridden/followed-up
 * thread after the threads leave the mailbox. These were written but never
 * called (cross-audit P4); the sweep is only safe when the store is complete.
 */
async function pruneAfterFullSync() {
  const liveIds = new Set(store.idsFor('all'));
  const liveThreads = new Set(
    [...liveIds].map((id) => store.get(id)?.threadId).filter(Boolean)
  );
  try {
    const o = deadlineStore.pruneOverrides(deadlineOverrides, liveIds);
    if (o !== deadlineOverrides) {
      deadlineOverrides = o;
      await deadlineStore.saveOverrides(deadlineOverrides);
    }
  } catch { /* a failed sweep must never break the sync that just succeeded */ }
  try {
    const r = pruneThreadMutes(rules, liveThreads);
    if (r !== rules) {
      rules = r;
      await saveRules(rules);
    }
  } catch { /* best-effort, like every persistence call in this file */ }
  try {
    const f = followups.pruneFollowups(followupList, store, state.selfEmail);
    if (f !== followupList) {
      followupList = f;
      await followups.saveFollowups(followupList);
    }
  } catch { /* best-effort */ }
}


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
    applySearchTyping();
  });
});

/*
 * The ONE query-application path.
 *
 * Extracted at 65/e so the search chips share it instead of growing a
 * second route to the same state. Typing reaches it through the rAF
 * coalescer (keystrokes arrive in bursts; one render per frame is the
 * doctrine). A chip gesture calls it directly after syncing the input,
 * because the click is already a single deliberate event — and every
 * consequence below still runs exactly once, in the same order.
 */
function applySearchTyping() {
  if (!state.query && el.search.value) capturePreSearchScroll();
  const hadQuery = !!state.query;
  state.query = el.search.value;
  if (hadQuery && !state.query) clearSearchOverlay();
  // R5: clearing a search returns you to where the search began.
  applySearchScroll(state.query);
  renderList();
  renderViews();
  updateSaveAffordance();
  scheduleServerSearch();
  renderSuggestions();
  queueHashMirror(); // 65/g: typing renders directly; the URL must keep up.
}


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
  // The saver defers writes to idle; a save scheduled by the store
  // notifications below would otherwise resurrect an (empty) cache blob
  // AFTER clearCache() removed it. Invalidate before AND after resetView —
  // clearing the stores schedules one last save that must never land.
  saver.invalidate();
  await clearCache();
  resetView({ allMailboxes: true });
  saver.invalidate();
  state.signedIn = false;
  opEpoch++; // late responses from this session are now stale
  // A signed-out app that keeps polling is a privacy problem, not just a bug.
  stopAutoRefresh();
  clearHash(); // 65/g: the gate has no view state worth a URL.
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






/**
 * The class-change cards.
 *
 * Only PROMOTED notices appear -- confidence >= 0.7, which requires the
 * message to name a course the user actually takes, or come from an academic
 * sender, or carry the phrase in its subject. A bare pattern match scores 0.4
 * and never pins itself, because a false pin teaches people to ignore the pin
 * and that is the whole delivery mechanism.
 */
/* ========================================================================== *
 * FOLLOW-UPS AND DEADLINE OVERRIDES
 * ========================================================================== */

/** In-memory mirrors, loaded at boot and written through on every change. */
let followupList = [];
let deadlineOverrides = {};
/** Coach toast: once per page load, regardless of setting writes. */
let coachShown = false;
/** The user's courses. Empty until they pick, which means no chips -- correct. */
let enrolment = [];

/*
 * OPERATION EPOCH (V2 P1-13/P1-7). Async sync results carry the generation
 * they were requested in; sign-out and mailbox switches advance the epoch so
 * a late response from account A can never land in account B's Store, and a
 * mailbox A page load cannot paint over mailbox B. One primitive for every
 * async boundary instead of a guard per call site.
 */
let opEpoch = 0;
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
    renderReaderIdle(ctx);
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
    renderReaderIdle(ctx);
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
    renderReaderIdle(ctx);
    renderList();
    toast(origin === 'dismiss' ? 'Not a deadline' : 'Deadline set');
  };

  /*
   * P-2 (round 61): the menu OPENS BY SAYING WHAT IS CURRENTLY IN EFFECT.
   * Extraction and correction are deliberately separate stores — the
   * separation is load-bearing — so the menu must do the reconciliation the
   * user otherwise does in their head: name the effective value and who
   * decided it. Each preset previews its absolute date, so "Next week" can
   * never mean a day the user did not expect.
   */
  const stateDesc = eff.at === null
    ? 'none set'
    : eff.source === 'user'
      ? `your correction — ${fullDate(eff.at)}`
      : `extracted — ${fullDate(eff.at)}`;
  const preset = (text, at) => ({ text, hint: fullDate(at), run: () => set(at) });

  const items = [
    preset('Today', endOfDay(Date.now())),
    preset('Tomorrow', endOfDay(Date.now() + DAY)),
    preset('In 3 days', endOfDay(Date.now() + 3 * DAY)),
    preset('Next week', endOfDay(Date.now() + 7 * DAY)),
  ];

  // Only offer to remove what is actually there.
  if (eff.at !== null) {
    items.push({
      text: eff.source === 'extracted' ? 'Not a deadline' : 'Clear',
      hint: eff.source === 'user' ? `Removes your correction` : `Keeps the text, drops the date`,
      run: () => set(null, 'dismiss'),
    });
  }

  openMenu({ anchor, name: 'deadline', label: `Deadline — currently: ${stateDesc}`, items });
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
  // The success half of the settings-failure toast (round 46 #3): applying
  // a theme now speaks, so success and failure share one language.
  toast(theme.name, { ms: 1200 });
  settings.set('theme', theme.id).catch(() => {
    // A theme that cannot persist reverts at next boot; say so once, here,
    // instead of letting the failure disappear (bug-hunt 43 #17).
    toast('Could not save the theme choice', { kind: 'error' });
  });
  /*
   * No loop over menu children to re-tick. The menu is rebuilt from
   * `state.theme` on every open and destroyed on every close, so there is no
   * stale DOM to keep in sync -- one of the four things the hand-rolled
   * version had to remember and this one cannot forget.
   */
  // Re-render the open message. The body iframe is a separate document with
  // its own colours baked into srcdoc, so it cannot follow a variable change.
  // Cheap: the body is already in memory, no refetch. The repaint lives with
  // the reader now (round 51 workspace extraction).
  repaintBody();
}

function openThemeMenu() {
  const btn = $('btn-theme');
  btn.setAttribute('aria-expanded', 'true');
  /*
   * APPEARANCE, NOT JUST THEME (round 58 IA audit, H10). Density is an
   * appearance preference too, but it lived only on the options page, so
   * changing how the app LOOKS required leaving the app for one of its two
   * halves. Both groups now share one menu; each group stays one-of-many
   * (radio semantics), and the divider is the only thing between them.
   * settings.set fires the subscriber that applies density + re-measures
   * subject clipping — the same path the options page uses.
   */
  const density = settings.get('density');
  const DENSITIES = [
    ['comfortable', 'Comfortable'],
    ['cosy', 'Cosy'],
    ['compact', 'Compact'],
  ];
  openMenu({
    name: 'theme',
    label: 'Appearance',
    anchor: btn,
    className: 'theme-menu',
    // The header wrapper is the positioning context, so the menu hangs under
    // the button rather than being clipped by it.
    mountTo: $('themewrap'),
    items: [
      ...THEMES.map((t) => ({
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
      ...DENSITIES.map(([id, name], i) => ({
        text: name,
        selected: density === id,
        className: 'density-item' + (i === 0 ? ' menu-sep' : ''),
        suffix: themeTick(),
        run: () => settings.set('density', id),
      })),
    ],
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

$('btn-help').addEventListener('click', () => toggleHelp());
$('btn-activity').addEventListener('click', () => openActivityLog(ctx));

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
/** How many loaded messages from this sender currently sit in a category. */
function countFromSenderIn(sender, cat) {
  let n = 0;
  for (const id of store.idsFor('all')) {
    const m = store.get(id);
    if (m && m.category === cat && addressOf(m.from) === sender) n++;
  }
  return n;
}

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
        const sender = addressOf(msg.from);
        const moved = countFromSenderIn(sender, msg.category);
        rules = clearCorrection(rules, msg.from);
        await saveRules(rules);
        reclassifyAll();
        toast(`Back to the automatic category${moved ? ` — ${moved} re-filed` : ''}`);
      },
    });
  }

  for (const cat of SIDEBAR_ORDER) {
    if (cat === current) continue;
    items.push({
      text: CATEGORY_LABELS[cat] || cat,
      hint: `File mail from ${displayName(msg.from)} here.`,
      run: async () => {
        const sender = addressOf(msg.from);
        // Count BEFORE the re-file: the effect must be reported with its
        // scope, not discovered by hunting the list (round 61, P-1).
        const moved = countFromSenderIn(sender, msg.category);
        rules = correctSender(rules, msg.from, cat);
        await saveRules(rules);
        reclassifyAll();
        toast(`${displayName(msg.from)} now files under ${CATEGORY_LABELS[cat] || cat} — ${moved} re-filed`);
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
  if (open) {
    syncContextActions(open);
    // P-1: the OPEN message re-files itself visibly — its tag row shows the
    // new category immediately, so the effect of the correction is seen in
    // the place the user is looking, not inferred from the list behind them.
    renderReaderTags(open);
  }
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
// ------------------------------------------------------------------- help --

/**
 * Keyboard help overlay.
 *
 * Focus is moved INTO the dialog and restored to wherever it came from on
 * close. Skipping the restore is the classic modal bug: the user presses `?`,
 * reads, presses Escape, and their next `j` goes nowhere because focus is on
 * `<body>`.
 */

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
/** Hand the page back to Gmail. The content script does the actual unwind. */
function release() {
  // Flush before the frame is destroyed, so triage done in this session is on
  // disk for the next one.
  saver.flush();
  flushDraft();
  cancelPendingWork();
  parent.postMessage(
    { type: 'BMM_RELEASE', ...(EMBED_NONCE ? { nonce: EMBED_NONCE } : {}) },
    'https://mail.google.com'
  );
}

// Keyboard. Gmail-compatible where it makes sense, so muscle memory survives.
/*
 * MODE AGGREGATOR (roadmap M1 / round-62 N-1).
 *
 * READ-ONLY. Mode truth is distributed across body classes, state flags, the
 * layer state and worker health; every existing consumer reads the one signal
 * it needs and that stays true. This adds the one read nobody had: the
 * aggregate answer to "what mode is the application in right now", so future
 * cross-mode features derive instead of inventing a sixth way to ask.
 * No writers change. No state moves. Consumers opt in.
 */
function modeOf() {
  return {
    searching: state.query !== '' || document.activeElement === el.search,
    selecting: selection.active,
    composing: !$('compose')?.hidden,
    reading: state.selected !== null,
    scrolled: document.body.classList.contains('list-scrolled'),
    workspace: timetableIsOpen(),
    degraded: workerDown,
    offline: isOffline(),
  };
}

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
    // The timetable workspace hides the mail surfaces; leaving it is one
    // step, before any mail-level state unwinds (round 54).
    if (timetableIsOpen()) {
      closeTimetable();
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
    selection.selectAll(renderedIdsOf());
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
    toggleHelp();
    return;
  }

  // While help is open, swallow the single-letter shortcuts. Acting on a
  // message the user cannot see is the worst kind of surprise.
  if (helpOpen()) return;

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
      const target = state.selected || renderedIdsOf()[0];
      if (target) {
        selection.toggle(target);
        renderSelection();
      }
      break;
    }
  }
});



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
  cancelMarkRead();
  // The outbox pump re-arms itself after every dispatch; a test that sends
  // (or cancels a send) must not leave that timer firing into a torn-down
  // document after restore.
  cancelOutboxTimer();
  cancelSuggestBlur();
  // The cache saver defers writes to idle/50ms. If the page is being torn
  // down, a pending write must be cancelled — otherwise it fires into
  // whatever context comes next (a test's next mock storage, or a closed
  // extension page) and writes a stale blob over fresh state.
  saver.invalidate();
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
  toggleHelp,
  openActivityLog: () => openActivityLog(ctx),
  // R-4: the compose->autocomplete sibling edge becomes a ctx dependency.
  wireAutocomplete: (inputId, listId) => wireAutocomplete(inputId, listId),
  refreshContacts: (c) => refreshContacts(c),
  setTheme: (id) => setTheme(id),
  themes: () => THEMES,
  categoryList: () => [['all', 'All mail'], ...SIDEBAR_ORDER.map((c) => [c, CATEGORY_LABELS[c] || c])],
  selectCategory,
  /*
   * Which MESSAGE the reader is showing. With threading the selected row is a
   * conversation, and the user may have stepped to an earlier message inside
   * it -- a reply must answer that one.
   */
  openMessageId: () => openPartId() || state.selected,
  // Saved views render into the rail and count against the inbox store.
  viewsList: () => el.viewsList,
  // Server search needs to know what is already on screen (so it only reports
  // genuinely new hits) and how to merge what Gmail returns.
  visibleIds: () => visibleIds(),
  ingest: (msgs) => ingest(msgs),
  shape: (msgs) => shapeRecords(msgs, true),
  renderList: () => renderList(),
  runQuery: (q) => {
    el.search.value = q;
    state.query = q;
    el.scroller.scrollTop = 0;
    renderList();
    // The saved-view list must show WHICH view is active, and the save
    // affordance must not offer to save something already saved.
    renderViews();
    updateSaveAffordance();
    /*
     * 65/g: choosing a saved view or palette filter is a SETTLED query —
     * typed into existence at once, so it earns one history entry, unlike
     * keystrokes which only ever mirror.
     */
    navigateHash();
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
window.__bmmModeOf = modeOf;
window.__bmmHideGate = () => hideGate();
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

/*
 * THE INVISIBLE-FAILURE HOLE (bug-hunt 44 #67 / improvements #32).
 * reportError only covers the paths that remember to call it; a rejected
 * promise inside a feature module (palette, menus, timetable) used to
 * vanish with no trace -- the user saw mysterious missing behaviour and the
 * logs saw nothing. Every unhandled rejection now lands in the activity
 * ring, which is exactly the record that exists to answer "what actually
 * happened".
 */
window.addEventListener('unhandledrejection', (e) => {
  const reason = e?.reason;
  const message = String(reason?.message || reason || 'unknown rejection').slice(0, 200);
  console.warn('[BMM] unhandled rejection:', message);
  try {
    activity.record({ verb: 'REJECTION', ids: [], actor: 'system', outcome: 'failed', error: message });
  } catch { /* the observer must never become the failure */ }
});

window.__bmmTeardown = cancelPendingWork;

// ------------------------------------------------------------------- start --

/* ======================================================================== *
 * VIEWS POPOVER + CONTEXT RAIL (V3 — docs/OVERHAUL-V3.md R2/R5)
 * ======================================================================== */

/*
 * The context rail's visibility is CSS's job: `body.rail-open` + the rail's
 * own "hide when every section is empty" :has() rule. All JS owns is the
 * toggle — flip the class, mark the button, remember the choice.
 */
function wireRail() {
  const btn = $('btn-rail');
  const close = $('btn-rail-close');
  if (!btn) return;
  /* At <=1240px the rail stops being a column and becomes a drawer: it
     floats over the reader. Drawer manners apply there -- a pointer outside
     it or Escape puts it away -- while at desktop widths it is a sibling
     column and stays put until toggled. The persisted setting still decides
     the initial state either way. */
  const drawerMq = window.matchMedia('(max-width: 1240px)');
  let onOutside = null;

  const detachOutside = () => {
    if (onOutside) {
      document.removeEventListener('pointerdown', onOutside, true);
      onOutside = null;
    }
  };
  const apply = (on) => {
    document.body.classList.toggle('rail-open', on);
    btn.setAttribute('aria-pressed', String(on));
    detachOutside();
    if (on && drawerMq.matches) {
      onOutside = (e) => {
        if (e.target.closest('#rail') || e.target.closest('#btn-rail')) return;
        apply(false);
      };
      document.addEventListener('pointerdown', onOutside, true);
    }
  };
  apply(settings.get('railOpen') !== false);
  btn.addEventListener('click', () => {
    const on = !document.body.classList.contains('rail-open');
    settings.set('railOpen', on).catch(() => {});
    apply(on);
  });
  close?.addEventListener('click', () => {
    settings.set('railOpen', false).catch(() => {});
    apply(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerMq.matches && document.body.classList.contains('rail-open')) {
      apply(false);
    }
  });
}

/*
 * Saved views moved out of the sidebar into a topbar popover. The panel is
 * plain markup under #overlay-root; saved-views.js keeps owning everything
 * inside it. This wire owns only open/close — button, outside pointer,
 * Escape — and the fixed placement measured from the button, the same way
 * menu.js anchors. A popover is dismissed by its own actions too: choosing
 * a view applies it and the panel leaves.
 */
function wireViewsPop() {
  const btn = $('btn-views');
  const pop = $('views-pop');
  if (!btn || !pop) return;

  let onOutside = null;
  const close = () => {
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (onOutside) {
      document.removeEventListener('pointerdown', onOutside, true);
      onOutside = null;
    }
  };
  const open = () => {
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth || 260;
    const left = Math.max(8, Math.min(r.left, (window.innerWidth || 1024) - w - 8));
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(r.bottom + 8)}px`;
    pop.style.right = 'auto';
    onOutside = (e) => {
      if (pop.contains(e.target) || btn.contains(e.target)) return;
      close();
    };
    document.addEventListener('pointerdown', onOutside, true);
    pop.querySelector('a, button')?.focus();
  };

  btn.addEventListener('click', () => (pop.hidden ? open() : close()));
  $('views-list')?.addEventListener('click', () => close());
  document.addEventListener('keydown', (e) => {
    // Capture + stop: one Escape must not also close the reader behind.
    if (e.key === 'Escape' && !pop.hidden) {
      e.stopPropagation();
      close();
      btn.focus();
    }
  }, true);
  // Rendered into a torn-down document would throw after release; the app's
  // own teardown closes layers, and this popover is chrome, not a layer.
  window.addEventListener('pagehide', close);
}

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
    renderReaderIdle(ctx);
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

      // The bloom's clip condition depends on line width; a density change
      // re-decides every row rather than leaving stale classes behind.
      refreshSubjectClip();
    }
    if (key === 'lanes') renderList();
  });

  /*
   * POLISH 17 (coach mark): one-time per SESSION, dismissible, never again.
   * Deliberately NOT inside settings.subscribe above — that handler runs on
   * every setting change, so a write triggered by sign-out/reset re-fired the
   * toast for a user who had already dismissed it (cross-audit 6.1). Boot
   * runs once per page load, which is the only moment it may appear.
   */
  // The coach toast moved to start(), AFTER the gate: a j/k hint on a
  // sign-in screen where no list exists is first-run noise (round 46 #44).

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

  initToast({
    toast: el.toast, toastText: el.toastText, toastAction: el.toastAction,
    toastDrain: el.toastDrain, toastIcon: el.toastIcon, toastKbd: el.toastKbd,
  });
  wireList({
    get store() { return store; },
    state, el,
    getRules: () => rules,
    setRules: (r) => { rules = r; },
    saveRules: () => saveRules(rules),
    overrides: () => deadlineOverrides,
    getEnrolment: () => enrolment,
    selectCategory,
    refresh: (o) => refresh(o),
    renderSidebar,
    renderSelection,
    selection,
    act,
    optimistic,
    openMessage,
    gmailUrl,
    isInFlight,
    modeOf,
  });
  wireRails({
    get store() { return store; },
    send, state,
    refresh: (o) => refresh(o),
    overrides: () => deadlineOverrides,
  });

  wireSidebar({
    get store() { return store; },
    state, el,
    stores, mailboxState,
    getRules: () => rules,
    selectMailbox,
    selectCategory,
    openCategoryMenu,
  });
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
  setIcon($('btn-activity'), 'clock', { size: 15 });
  decorate('compose-min', 'minimise');
  decorate('compose-close', 'close');

  // Contextual actions. Icon-only is acceptable HERE, unlike the toolbar
  // labels, because each carries a title, an aria-label and a keyboard hint,
  // and they mirror actions the user already met in the reader.
  setIcon($('ctx-archive'), 'archive', { size: 15 });
  setIcon($('ctx-star'), 'star', { size: 15 });
  setIcon($('ctx-trash'), 'trash', { size: 15 });
  // The reader's overflow kebab (round 65/d) — icon-only by the same rule
  // as the contextual cluster above.
  setIcon($('r-more'), 'more', { size: 15 });
  $('ctx-actions').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !state.selected) return;
    act({ 'ctx-archive': 'archive', 'ctx-star': 'star', 'ctx-trash': 'trash' }[b.id], state.selected);
  });


  // Extracted tenants (architecture audit phase 9): wiring only; state
  // ownership stays with the shell.
  wireSuggestUI({
    get store() { return store; },
    el,
    runQuery: (q) => ctx.runQuery(q),
  });
  wireReader({
    // GETTER: `store` is rebound on every mailbox switch (see ctx below).
    get store() { return store; },
    state, el, send,
    patchRow, reorientTo, rowDomId,
    syncContextActions,
    openRecategoriseMenu,
    act,
    followupMenu: openFollowupMenu,
    deadlineMenu: openDeadlineMenu,
    gmailUrl,
  });
  wireSnoozeMenu({ getMessage: (id) => store.get(id), snoozeMessage });
  wireCategoryMenu({
    getRules: () => rules,
    setRules: (r) => { rules = r; },
    saveRules: () => saveRules(rules),
    renderList, renderSidebar, toast,
  });
  wireNotices({
    visibleIds,
    getMessage: (id) => store.get(id),
    openMessage,
    getEnrolment: () => enrolment,
  });
  wireBulk({
    get store() { return store; },
    state, el, send,
    setBusy,
    closeReader,
    openMessage,
    appCtx: ctx,
  });
  wireBulkbar({
    move, bulkAct, renderSelection,
    clearSelection: () => { selection.clear(); renderSelection(); },
    selectAll: () => selection.selectAll(renderedIdsOf()),
    getBulkAll: () => el.bulkAll,
  });

  // Saved views.
  el.viewsList.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-remove-view]');
    if (rm) {
      e.stopPropagation();
      // Report a failed write. This used to assume success, so a rejected
      // storage call left the view on screen with no toast and no error.
      const res = await removeView(rm.dataset.removeView);
      await refreshViews();
      // 65/e: the chip strip's Save affordance derives from the saved set,
      // so a removal must re-render it — otherwise Save stays hidden for a
      // query that is no longer backed by a view.
      renderList();
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
    // In-app dialog, not prompt() (audit 39 P1): shows the query, validates
    // inline, and keeps duplicate-name errors INSIDE the dialog.
    const name = await promptDialog({
      title: 'Save this view',
      label: 'Name',
      value: suggestViewName(q),
      hint: `Saves the current search: ${q}`,
      submit: async (n) => {
        const res = await saveView(n, q);
        return res.ok ? { ok: true } : { ok: false, error: res.error };
      },
    });
    if (name === null) return;
    await refreshViews();
    updateSaveAffordance();
    // 65/e: re-render the chip strip too, so its Save control disappears the
    // moment the query becomes a view — derived from the same saved set, not
    // toggled independently (two affordance states would diverge).
    renderList();
    toast(`Saved "${name}"`, { kind: 'success' });
  });

  /*
   * Search chips (round 65/e, F6). The chips render inside list.js's
   * readout slot; the BEHAVIOUR lives here because the consequences are the
   * shell's: the input element, the one query path, the save dialog.
   * Every gesture funnels into applySearchTyping — chips never get a
   * second, subtly-different route to the filtered state.
   */
  wireSearchChips({
    head: el.listhead,
    search: el.search,
    applyQuery: (q) => { el.search.value = q; applySearchTyping(); },
    clearQuery: () => { el.search.value = ''; applySearchTyping(); },
    // Delegating to the toolbar button, not duplicating its guts: the
    // dialog, validation and storage error handling exist exactly once.
    save: () => $('btn-save-view').click(),
  });

  /*
   * Deep links (65/g). Applies run through the shell's OWN navigation
   * functions — selectMailbox/selectCategory/applySearchTyping — with the
   * module suppressing the history echo, so Back landing on a hash is
   * indistinguishable from the user clicking their way to the same view.
   */
  wireDeepLinks({
    snapshot: () => ({
      mailbox: state.mailbox,
      category: state.category,
      query: state.query,
      selected: state.selected,
    }),
    validMailbox: isMailbox,
    applyMailbox: (mb) => { if (mb !== state.mailbox) void selectMailbox(mb); },
    applyCategory: (cat) => {
      // A deep-linked category the install does not know would render an
      // empty list under a foreign name; unknown means 'all'.
      const known = cat === 'all' || ctx.categoryList().some(([k]) => k === cat);
      const target = known ? cat : 'all';
      if (target !== state.category) selectCategory(target);
    },
    applyQuery: (q) => {
      if (el.search.value === q && state.query === q) return;
      el.search.value = q;
      applySearchTyping();
    },
    trySelect: (id) => {
      if (!store.get(id)) return false;
      openMessage(id);
      return true;
    },
    hasSelection: () => Boolean(state.selected),
    closeMessage: () => closeReader(),
  });

  wirePalette(ctx);
  wireCompose(ctx);
  wireRadar(ctx);
  wireRail();
  // Row hover-verbs + the row's right-click menu (round 65/b). Same verbs
  // the keyboard already had; now visible from the object itself.
  wireRowActions(ctx);
  wireViewsPop();
  const idle = document.getElementById('reader-idle');
  if (idle) idle.addEventListener('click', (e) => {
    const row = e.target.closest('.reader-idle-item');
    if (row) ctx.openMessage(row.dataset.id);
  });
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
  requestAnimationFrame(() => parent.postMessage(
    { type: 'BMM_READY', ...(EMBED_NONCE ? { nonce: EMBED_NONCE } : {}) },
    'https://mail.google.com'
  ));

  try {
  const { signedIn } = await send('AUTH_STATUS');
  state.signedIn = signedIn;
  if (!signedIn) return showGate('');
  hideGate();

  if (!coachShown) {
    coachShown = true;
    if (!settings.get('coachDone')) {
      // A failed write only costs a repeated coach mark; silent is right.
      settings.set('coachDone', true).catch(() => {});
      toast('Press j to move between messages — ? for every key', {
        ms: 7000,
        action: { label: 'Got it', run: () => {} },
      });
    }
  }
    // Rules must be loaded BEFORE the first ingest, or the first page is
    // classified without the user's corrections and auto-archive silently
    // does not run on it.
    // Settings and rules must both be loaded before the first ingest and the
    // first reader open: a preference read after the fact is a preference the
    // user watched not apply.
    rules = await loadRules();
    await loadImageAllowList();
    await start();
    /*
     * 65/g: the boot deep link is applied only once the app can honour
     * every part of it — stores exist, rules are loaded, the first sync is
     * underway. A selection whose message has not landed yet stays latched
     * in deep-links and opens when its data does.
     */
    applyHash(window.location.hash);
    // Only after the inbox is up: an unsent message from a previous session
    // is offered back rather than silently lost.
    restoreDraftIfAny(ctx).catch(() => {});
  } catch (err) {
    showGate(String(err.message || err));
  }
}


if (IS_EMBEDDED && !EMBED_NONCE) {
  /*
   * Foreign embed: refuse visibly and boot nothing. The message names the
   * chord, which is the honest way back to the legitimate surface.
   */
  console.warn('[BMM] refusing to boot inside an unrecognised embed.');
  try {
    document.body.replaceChildren();
    const note = document.createElement('div');
    note.setAttribute('role', 'alert');
    note.style.cssText = 'padding:24px;font-family:system-ui;color:#8a2f2f';
    note.textContent =
      'BITS Mail Manager will not run inside this page. ' +
      'Open it from Gmail with Alt+Shift+M.';
    document.body.appendChild(note);
  } catch { /* refusing is the point; the notice is a courtesy */ }
} else {
  boot();
}
