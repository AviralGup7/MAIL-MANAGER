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
import { extractDeadline, relativeLabel, urgency } from './deadlines.js';
import { parseQuery, buildReply } from './query.js';
import {
  undoStack, recordUndo, performUndo,
  renderRadar, wireRadar,
  openPalette, closePalette, wirePalette,
  openCompose, closeCompose, wireCompose, startReply,
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

const store = new Store();

const state = {
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
  });
}

store.subscribe(scheduleRender);

/**
 * Persist the newest headers so the next takeover paints from disk.
 *
 * Subscribed separately from rendering and deliberately AFTER it, so a write
 * can never delay a frame. The saver defers to idle and coalesces, so a sync
 * touching 200 messages still produces exactly one write.
 */
const saver = createSaver(() =>
  store.idsFor('all').slice(0, CACHE_MAX).map((id) => store.get(id)).filter(Boolean)
);
store.subscribe(() => saver.schedule());

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
function resetView() {
  store.clear();
  closeReader();
  el.list.replaceChildren();
  nodeById.clear();
  renderedIds = [];
  renderList();
  renderSidebar();
}

/** The ids the list should currently show. */
function visibleIds() {
  if (!state.query) return store.idsFor(state.category);

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
  } else if (store.size === 0) {
    el.emptyTitle.textContent = 'Inbox empty';
    el.emptySub.textContent = 'Nothing to show. Refresh to check for new mail.';
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
    '<span class="r-bar"></span>' +
    '<span class="r-mid">' +
    '<span class="r-line1"><span class="r-from"></span></span>' +
    '<div class="r-subj"></div>' +
    '<div class="r-snip"></div>' +
    '</span>' +
    '<span class="r-right">' +
    '<span class="r-date"></span>' +
    '<button class="r-star" type="button" aria-label="Star"></button>' +
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

  setText(q('.r-from'), displayName(m.from));
  setText(q('.r-subj'), m.subject);
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
  frag.appendChild(catButton('all', 'All mail', null));
  for (const cat of SIDEBAR_ORDER) {
    frag.appendChild(catButton(cat, CATEGORY_LABELS[cat] || cat, CAT_COLOR[cat]));
  }
  el.cats.replaceChildren(frag);
}

function catButton(key, label, color) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cat' + (MUTED_CATEGORIES.has(key) ? ' muted' : '');
  b.dataset.cat = key;
  b.setAttribute('aria-current', String(state.category === key));
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

  for (const b of el.cats.children) {
    const key = b.dataset.cat;
    const countEl = b.lastElementChild;
    const u = key === 'all' ? totalUnread : unread[key] || 0;
    const t = key === 'all' ? store.size : counts[key] || 0;
    setText(countEl, u ? String(u) : t ? String(t) : '');
    countEl.classList.toggle('unread', u > 0);
    b.setAttribute('aria-current', String(state.category === key));
  }
}

// ----------------------------------------------------------------- reader --

let bodyToken = 0;
/** The last body fetched, kept so a theme change can re-render it. */
let lastBody = null;

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

  el.rTags.replaceChildren(
    tagNode(CATEGORY_LABELS[m.category] || m.category, CAT_COLOR[m.category]),
    tagNode(`${Math.round((m.confidence ?? 1) * 100)}% · ${m.source || 'rule'}`),
    ...(m.reason ? [tagNode(m.reason)] : [])
  );

  // Optimistic read. Gmail is told after, and the UI never waits for it.
  if (m.unread) {
    store.patch(id, { unread: false });
    send('MARK_READ', { id }).catch(() => store.patch(id, { unread: true }));
  }

  const token = ++bodyToken;
  el.rLoading.hidden = false;
  el.rBody.srcdoc = '';
  try {
    const body = await send('GET_BODY', { id });
    if (token !== bodyToken) return; // user moved on; drop the stale response
    lastBody = body;
    el.rBody.srcdoc = renderBody(body);
  } catch (err) {
    if (token !== bodyToken) return;
    el.rBody.srcdoc = escapeDoc(`Could not load this message.\n\n${err.message}`);
  } finally {
    if (token === bodyToken) el.rLoading.hidden = true;
  }
}

el.reader.addEventListener('animationend', () => el.reader.classList.remove('swap'));

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
function renderBody(body) {
  const html = body.html
    ? sanitizeHtml(body.html)
    : `<pre>${escapeHtml(body.text || '(no content)')}</pre>`;

  const attachments = (body.attachments || []).length
    ? `<div class="att">&#128206; ${body.attachments
        .map((a) => escapeHtml(a.filename))
        .join(', ')} — open in Gmail to download</div>`
    : '';

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

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;">
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
</style></head><body>${attachments}${html}</body></html>`;
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
  if (prev) patchRow(prev);
  el.list.removeAttribute('aria-activedescendant');
  syncContextActions(null);
  el.reader.hidden = true;
  el.readerEmpty.hidden = false;
  el.rBody.srcdoc = '';
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
    records[i] = {
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
    };
  }
  store.upsertMany(records); // one batch -> one notification -> one frame
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
  if (state.loading) return;
  state.loading = true;
  setBusy(true);
  try {
    await fetchPage(pageToken);
  } catch (err) {
    reportError(err);
  } finally {
    state.loading = false;
    setBusy(false);
  }
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
  if (state.loading) return;
  state.loading = true;
  setBusy(true);
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
    state.loading = false;
    setBusy(false);
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
  openMessage(id);
});

el.cats.addEventListener('click', (e) => {
  const b = e.target.closest('.cat');
  if (!b) return;
  selectCategory(b.dataset.cat);
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
}

$('r-actions').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || !state.selected) return;
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
  });
});

$('btn-refresh').addEventListener('click', () => refresh());
$('btn-more').addEventListener('click', () => loadPage(state.nextPageToken));
$('btn-gmail').addEventListener('click', release);
$('btn-signout').addEventListener('click', async () => {
  await send('SIGN_OUT').catch(() => {});
  // Signing out must leave nothing of this mailbox behind. Without this the
  // next person to open the extension would see the previous account's inbox
  // painted from cache before the sign-in gate appeared.
  await clearCache();
  resetView();
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

/** Hand the page back to Gmail. The content script does the actual unwind. */
function release() {
  // Flush before the frame is destroyed, so triage done in this session is on
  // disk for the next one.
  saver.flush();
  parent.postMessage({ type: 'BMM_RELEASE' }, '*');
}

// Keyboard. Gmail-compatible where it makes sense, so muscle memory survives.
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);

  if (e.key === 'Escape') {
    // Layered: innermost surface first. Releasing the takeover while a compose
    // panel is open would discard a half-written message.
    if (!$('palette').hidden) {
      closePalette();
      return;
    }
    if (!$('compose').hidden) {
      $('compose-close').click();
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
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    performUndo(ctx);
    return;
  }

  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

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
    case 'c':
      e.preventDefault();
      openCompose(ctx);
      break;
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
  const wrap = $('ctx-actions');
  if (!wrap) return;
  wrap.hidden = !m;
  if (!m) return;
  const star = $('ctx-star');
  setIcon(star, 'star', { size: 15, filled: !!m.starred });
  star.setAttribute('aria-label', m.starred ? 'Unstar' : 'Star');
  star.setAttribute('aria-pressed', String(!!m.starred));
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
});

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
  },
};

window.__bmmIngest = ingest;
window.__bmmStore = store;

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
    await start();
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
