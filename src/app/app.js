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
import { renderShortcuts } from './shortcuts.js';
import {
  MAILBOXES, DEFAULT_MAILBOX, getMailbox, isMailbox, showsCategories, actionsFor,
} from './mailboxes.js';
import {
  emptyRules, loadRules, saveRules, toggleMute, toggleAutoArchive,
  isMuted, isAutoArchived, applyCorrection, correctSender, mutedCount,
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
  restoreDraftIfAny, flushDraft,
} from './features.js';
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
  gate: $('gate'),
  gateError: $('gate-error'),
  reader: $('reader'),
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
function toast(text) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 2200);
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
function visibleIds() {
  if (!state.query) return applyMute(store.idsFor(state.category));

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
  updateEmptyState(next.length);

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
  el.list.replaceChildren(frag);

  for (const [id, node] of nodeById) {
    if (!seen.has(id)) {
      node.remove();
      nodeById.delete(id);
    }
  }

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
function updateEmptyState(count) {
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
    '<span class="r-line1"><span class="r-from"></span></span>' +
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
  const fromEl = q('.r-from');
  setText(fromEl, displayName(m.from));
  setAttr(fromEl, 'title', m.from);

  const subjEl = q('.r-subj');
  setText(subjEl, m.subject);
  setAttr(subjEl, 'title', m.subject);

  setText(q('.r-snip'), m.snippet);
  setText(q('.r-date'), shortDate(m.date));

  const tag = q('.tag');
  setText(tag, CATEGORY_LABELS[m.category] || m.category);
  tag.classList.toggle('low', (m.confidence ?? 1) < LOW_CONFIDENCE);
  if (m.reason && tag.title !== m.reason) tag.title = m.reason;

  li.classList.toggle('unread', !!m.unread);
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

function renderSidebar() {
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
      let text = '';
      if (id === state.mailbox || loaded) {
        const un = s ? sumUnread(s) : 0;
        text = un ? String(un) : s && s.size ? String(s.size) : '';
      }
      setText(countEl, text);
      countEl.classList.toggle('unread', text !== '' && !!sumUnread(stores.get(id)));
      b.setAttribute('aria-current', String(state.mailbox === id));
      continue;
    }

    const key = b.dataset.cat;
    const u = key === 'all' ? totalUnread : unread[key] || 0;
    const t = key === 'all' ? store.size : counts[key] || 0;
    setText(countEl, u ? String(u) : t ? String(t) : '');
    countEl.classList.toggle('unread', u > 0);
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
  el.rTags.replaceChildren(
    tagNode(CATEGORY_LABELS[m.category] || m.category, CAT_COLOR[m.category]),
    ...(confident
      ? []
      : [tagNode(`${Math.round((m.confidence ?? 1) * 100)}% · ${m.source || 'rule'}`)]),
    ...(m.reason && !confident ? [tagNode(m.reason)] : [])
  );

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
    toast(`Downloaded ${filename}`);
  } catch (err) {
    toast(`Could not download: ${err.message}`);
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
function addressOf(from) {
  const m = /<([^>]+)>/.exec(String(from || ''));
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

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
      toast(`Images will load from ${sender}`);
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
async function act(action, id) {
  const m = store.get(id);
  if (!m) return;
  switch (action) {
    case 'star': {
      const on = !m.starred;
      store.patch(id, { starred: on });
      if (id === state.selected) syncContextActions(store.get(id));
      send('STAR', { id, on }).catch(() => {
        store.patch(id, { starred: !on });
        toast('Could not update star');
      });
      break;
    }
    case 'unread': {
      const on = !m.unread;
      store.patch(id, { unread: on });
      send(on ? 'MARK_UNREAD' : 'MARK_READ', { id }).catch(() => {
        store.patch(id, { unread: !on });
        toast('Could not update');
      });
      break;
    }
    case 'archive': {
      const snapshot = { ...m };
      selectNeighbourThen(id);
      store.remove(id);
      send('ARCHIVE', { id }).catch(() => {
        store.upsert(snapshot);
        toast('Could not archive');
      });
      // Gmail cannot undo an archive. We can, because the message is still in
      // memory and re-applying INBOX is one call.
      recordUndo(ctx, 'Archived', async () => {
        store.upsert(snapshot);
        await send('UNARCHIVE', { id });
      });
      break;
    }
    case 'trash': {
      const snapshot = { ...m };
      selectNeighbourThen(id);
      store.remove(id);
      send('TRASH', { id }).catch(() => {
        store.upsert(snapshot);
        toast('Could not delete');
      });
      recordUndo(ctx, 'Deleted', async () => {
        store.upsert(snapshot);
        await send('UNTRASH', { id });
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
  const m = store.get(id);
  if (!m) return;
  const snapshot = { ...m };

  selectNeighbourThen(id);
  store.remove(id);
  await addSnooze(id, wakeAt, chrome.storage.local);
  renderList();

  send('SNOOZE', { id }).catch(async () => {
    await removeSnooze(id, chrome.storage.local);
    store.upsert(snapshot);
    renderList();
    toast('Could not snooze');
  });

  toast(`Snoozed ${label ? label.toLowerCase() : ''}`.trim());
  recordUndo(ctx, 'Snoozed', async () => {
    await removeSnooze(id, chrome.storage.local);
    store.upsert(snapshot);
    await send('UNSNOOZE', { id });
    renderList();
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
    toast('Could not auto-archive');
  });

  toast(`Auto-archived ${ids.length} message${ids.length === 1 ? '' : 's'}`);
  recordUndo(ctx, `Auto-archived ${ids.length}`, async () => {
    for (const s of snapshots) store.upsert(s);
    await send('BULK', { ids, add: ['INBOX'] });
  });
}

/** Fetch and ingest one page. Throws; callers own the error reporting. */
async function fetchPage(pageToken) {
  const { messages, nextPageToken } = await send('SYNC_PAGE', {
    opts: { pageToken, max: PAGE },
  });
  ingest(messages);
  state.nextPageToken = nextPageToken;
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
  chrome.storage.local.set({ theme: theme.id });
  for (const item of el.themeMenu.children) {
    item.setAttribute('aria-checked', String(item.dataset.theme === theme.id));
  }
  // Re-render the open message. The body iframe is a separate document with
  // its own colours baked into srcdoc, so it cannot follow a variable change.
  // Cheap: the body is already in memory, no refetch.
  if (state.selected && lastBody) el.rBody.srcdoc = renderBody(lastBody);
}

function openThemeMenu() {
  buildThemeMenu();
  el.themeMenu.hidden = false;
  $('btn-theme').setAttribute('aria-expanded', 'true');
  const current = el.themeMenu.querySelector('[aria-checked="true"]') || el.themeMenu.firstElementChild;
  current?.focus();
}

function closeThemeMenu({ restoreFocus = false } = {}) {
  if (el.themeMenu.hidden) return;
  el.themeMenu.hidden = true;
  $('btn-theme').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('btn-theme').focus();
}

$('btn-theme').addEventListener('click', (e) => {
  e.stopPropagation();
  el.themeMenu.hidden ? openThemeMenu() : closeThemeMenu({ restoreFocus: true });
});

el.themeMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.theme-item');
  if (!item) return;
  setTheme(item.dataset.theme);
  closeThemeMenu({ restoreFocus: true });
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
    closeThemeMenu({ restoreFocus: true });
  }
});

document.addEventListener('click', () => closeThemeMenu());

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

let catMenu = null;

function closeCategoryMenu() {
  if (!catMenu) return;
  const back = catMenu.returnFocus;
  catMenu.node.remove();
  document.removeEventListener('mousedown', catMenu.onDocDown, true);
  catMenu = null;
  if (back?.isConnected) back.focus?.();
}

/**
 * Per-category triage menu.
 *
 * Mute and auto-archive are presented as a pair with clearly different
 * strengths, and the copy says what each one actually does. "Mute" in most
 * clients is vague; here it means "hide from the inbox list", and saying so
 * is the difference between a feature people use and one they are scared of.
 */
function openCategoryMenu(category, anchor) {
  closeCategoryMenu();
  const label = CATEGORY_LABELS[category] || category;

  const node = document.createElement('div');
  node.className = 'snooze-menu cat-menu';
  node.setAttribute('role', 'menu');
  node.setAttribute('aria-label', `${label} rules`);

  const mk = (text, sub, on, run) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'snooze-opt';
    b.setAttribute('role', 'menuitemcheckbox');
    b.setAttribute('aria-checked', String(on));
    const left = document.createElement('span');
    const name = document.createElement('span');
    name.textContent = text;
    const hint = document.createElement('span');
    hint.className = 'sc-when';
    hint.textContent = sub;
    left.append(name, hint);
    const mark = document.createElement('span');
    mark.className = 'snooze-when';
    mark.textContent = on ? 'On' : '';
    b.append(left, mark);
    b.addEventListener('click', async () => {
      closeCategoryMenu();
      await run();
    });
    node.appendChild(b);
  };

  mk(
    `Mute ${label}`,
    'Hide from the inbox list. Still searchable, nothing deleted.',
    isMuted(rules, category),
    async () => {
      rules = toggleMute(rules, category);
      await saveRules(rules);
      renderList();
      renderSidebar();
      toast(isMuted(rules, category) ? `${label} muted` : `${label} unmuted`);
    }
  );

  mk(
    `Auto-archive ${label}`,
    'Archive new mail in this category as it arrives.',
    isAutoArchived(rules, category),
    async () => {
      rules = toggleAutoArchive(rules, category);
      await saveRules(rules);
      renderSidebar();
      toast(
        isAutoArchived(rules, category)
          ? `New ${label} mail will be archived`
          : `Auto-archive off for ${label}`
      );
    }
  );

  node.addEventListener('keydown', (e) => {
    const items = [...node.querySelectorAll('.snooze-opt')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCategoryMenu(); }
  });

  const onDocDown = (ev) => { if (!node.contains(ev.target)) closeCategoryMenu(); };
  document.addEventListener('mousedown', onDocDown, true);
  catMenu = { node, onDocDown, returnFocus: anchor || document.activeElement };

  anchor.style.position = anchor.style.position || 'relative';
  anchor.appendChild(node);
  node.querySelector('.snooze-opt')?.focus();
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
let snoozeMenu = null;

function closeSnoozeMenu() {
  if (!snoozeMenu) return;
  const returnTo = snoozeMenu.returnFocus;
  snoozeMenu.node.remove();
  document.removeEventListener('mousedown', snoozeMenu.onDocDown, true);
  snoozeMenu = null;
  if (returnTo?.isConnected) returnTo.focus?.();
}

function openSnoozeMenu(id, anchor) {
  closeSnoozeMenu();
  const m = store.get(id);
  if (!m) return;

  // The deadline the radar already parsed feeds an option Gmail cannot offer.
  let deadline;
  try {
    deadline = extractDeadline(m)?.at;
  } catch {
    deadline = undefined;
  }

  const options = snoozePresets(Date.now(), { deadline });
  const node = document.createElement('div');
  node.className = 'snooze-menu';
  node.setAttribute('role', 'menu');
  node.setAttribute('aria-label', 'Snooze until');

  for (const opt of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'snooze-opt';
    b.setAttribute('role', 'menuitem');

    const name = document.createElement('span');
    name.textContent = opt.label;
    const when = document.createElement('span');
    when.className = 'snooze-when';
    when.textContent = new Date(opt.at).toLocaleString(undefined, {
      weekday: 'short', hour: 'numeric', minute: '2-digit',
    });

    b.append(name, when);
    b.addEventListener('click', () => {
      closeSnoozeMenu();
      snoozeMessage(id, opt.at, opt.label);
    });
    node.appendChild(b);
  }

  // Keyboard: arrows move, Escape dismisses. Same contract as the palette.
  node.addEventListener('keydown', (e) => {
    const items = [...node.querySelectorAll('.snooze-opt')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // do not also close the reader
      closeSnoozeMenu();
    }
  });

  const onDocDown = (e) => {
    if (!node.contains(e.target)) closeSnoozeMenu();
  };
  document.addEventListener('mousedown', onDocDown, true);

  snoozeMenu = { node, onDocDown, returnFocus: anchor || document.activeElement };
  (anchor?.closest('#r-actions') || el.reader || document.body).appendChild(node);
  node.querySelector('.snooze-opt')?.focus();
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
let helpReturnFocus = null;

/** Pending `g` prefix for the two-key category jump. Expires; see the handler. */
let goPending = null;

function openHelp() {
  if (!el.help || !el.help.hidden) return;
  renderShortcuts(el.helpBody, document);
  helpReturnFocus = document.activeElement;
  el.help.hidden = false;
  el.helpClose.focus();
}

function closeHelp() {
  if (!el.help || el.help.hidden) return;
  el.help.hidden = true;
  // Restore focus, but only if the old node is still in the document.
  const back = helpReturnFocus;
  helpReturnFocus = null;
  if (back && back.isConnected && typeof back.focus === 'function') back.focus();
  else el.list?.focus?.();
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
    // Layered: innermost surface first. Releasing the takeover while a compose
    // panel is open would discard a half-written message.
    //
    // Help is checked FIRST because it can be opened on top of anything else,
    // including the palette and compose.
    if (el.help && !el.help.hidden) {
      closeHelp();
      return;
    }
    if (snoozeMenu) {
      closeSnoozeMenu();
      return;
    }
    if (catMenu) {
      closeCategoryMenu();
      return;
    }
    if (!$('palette').hidden) {
      closePalette();
      return;
    }
    if (!$('compose').hidden) {
      $('compose-close').click();
      return;
    }
    // Selection is the innermost transient state, so it unwinds first.
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
    if (el.help && el.help.hidden) openHelp();
    else closeHelp();
    return;
  }

  // While help is open, swallow the single-letter shortcuts. Acting on a
  // message the user cannot see is the worst kind of surprise.
  if (el.help && !el.help.hidden) return;

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
function renderSelection() {
  const n = selection.size;
  el.bulkbar.hidden = n === 0;
  el.listhead.hidden = n > 0;

  for (const [id, node] of nodeById) {
    const on = selection.has(id);
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
async function bulkAct(kind) {
  const ids = selection.live(store, renderedIds);
  if (ids.length === 0) return;

  // Snapshot BEFORE mutating, for the undo.
  const snapshots = ids.map((id) => ({ ...store.get(id) }));
  const n = ids.length;
  const noun = n === 1 ? 'message' : 'messages';

  const removal = kind === 'archive' || kind === 'trash';
  if (removal && state.selected && ids.includes(state.selected)) closeReader();

  store.batch(() => {
    for (const id of ids) {
      if (kind === 'archive' || kind === 'trash') store.remove(id);
      else if (kind === 'read') store.patch(id, { unread: false });
      else if (kind === 'star') store.patch(id, { starred: true });
    }
  });
  selection.clear();
  renderSelection();

  const verb = { archive: 'Archived', trash: 'Deleted', read: 'Marked read', star: 'Starred' }[kind];

  try {
    if (kind === 'archive') await send('BULK', { ids, remove: ['INBOX'] });
    else if (kind === 'trash') await send('BULK', { ids, add: ['TRASH'], remove: ['INBOX'] });
    else if (kind === 'read') await send('BULK', { ids, remove: ['UNREAD'] });
    else if (kind === 'star') await send('BULK', { ids, add: ['STARRED'] });
  } catch (err) {
    // Roll the whole batch back. A partial apply would leave the list
    // disagreeing with Gmail with no indication which half won.
    store.batch(() => {
      for (const m of snapshots) store.upsert(m);
    });
    toast(`Could not ${kind}: ${err.message}`);
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
function cancelPendingWork() {
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
  store,
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
};

window.__bmmIngest = ingest;
window.__bmmStore = store;
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
      for (const m of cached.messages) store.upsert(m);
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
}

async function boot() {
  // Theme first, before anything paints, so there is no flash of the wrong
  // palette. `applyTheme` falls back to the default for an unknown id, which
  // covers the old binary 'light'/'dark' values from before the picker.
  const { theme } = await chrome.storage.local.get('theme');
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
    toast(`Saved "${res.view.name}"`);
  });

  wirePalette(ctx);
  wireCompose(ctx);
  wireRadar(ctx);
  $('btn-compose').addEventListener('click', () => openCompose(ctx));
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
    await settings.loadSettings();
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
