/**
 * The message list — the Mail workspace's scanning surface.
 *
 * RESPONSIBILITY  Diff-render the visible messages (rows, counts, empty and
 *                 skeleton states, lane headers, departure animation, travel
 *                 ghost), own the scroll-memory machinery (spatial memory,
 *                 pre-search anchor, new-arrival pill), and own the list's
 *                 own wiring: row click/star/pick, touch swipes, scroller
 *                 fade, new-pill dismissal.
 * OWNS            #list rows; renderedIds, nodeById, firstPaint,
 *                 travelGhostEl, scrollMemory, newCount, preQueryScroll,
 *                 pendingScrollRestore, restoreQueued, lastUserScroll.
 * DOES NOT OWN    selection state (bulk.js), the render LOOP (the shell's
 *                 scheduleRender decides WHEN), the reader, triage verbs,
 *                 sidebar, sync.
 * DEPENDS ON      injected ctx (see wireList) + rails.js (lane headers),
 *                 selectors.js, query.js, server-search.js, snippet.js,
 *                 my-courses.js, settings.js, display.js, dom.js, icons.js,
 *                 mailboxes.js, deadline-store.js, store.js.
 *
 * Extracted in the round-52 workspace sequence (map audits/51 §6 step 2).
 * The round-46 map sequenced this AFTER the reader settled because the list
 * shares its row index with bulk and keyboard; those consumers now go
 * through renderedIdsOf()/nodeByIdOf() instead of one shared scope.
 */

import { Store } from './store.js';
import { parseQuery } from './query.js';
import { overlayIds, overlayGet } from './server-search.js';
import * as sel from './selectors.js';
import * as settings from './settings.js';
import * as deadlineStore from './deadline-store.js';
import { rowSnippet } from './snippet.js';
import * as myCourses from './my-courses.js';
import { icon, setIcon } from './icons.js';
import { setAttr, setText } from './dom.js';
import { getMailbox } from './mailboxes.js';
import { CATEGORY_LABELS, MUTED_CATEGORIES } from '../classify/categories.js';
import { CAT_COLOR, LOW_CONFIDENCE, displayName, shortDate } from './display.js';
import { insertLaneHeaders } from './rails.js';
import { registerReset } from './reset-registry.js';

/** Set by wireList at boot. */
let ctx = null;
let el = null;
let state = null;
let storeOf = null;

// ------------------------------------------------------------------ state --

let renderedIds = [];

/** Whether the list has ever been painted with content. */
let firstPaint = false;

const nodeById = new Map();

export const rowDomId = (id) => `bmm-row-${id}`;

/*
 * SPATIAL MEMORY (audit 38, concept #6): returning from any detour drops the
 * eye back where it was. The scroll is the information; the pulse is the
 * confirmation, and reduced motion keeps the former and drops the latter.
 */
const scrollMemory = new Map();
let newCount = 0;
let preQueryScroll = 0;
let pendingScrollRestore = 0;
let restoreQueued = false;
let lastUserScroll = 0;
/** Scroller-fade state, owned by the scroll listener in wireList. */
let scrolledOn = false;
let travelGhostEl = null;

/**
 * Wire the list surface to the shell. Called once, at boot.
 *
 * @param {Object} c
 * @param {()=>import('./store.js').Store} c.store  live store getter
 * @param {Object} c.state           shared app state
 * @param {Object} c.el              cached DOM map
 * @param {()=>Object} c.getRules    category rules, shell-owned
 * @param {(r:Object)=>void} c.setRules
 * @param {()=>Promise<any>} c.saveRules
 * @param {()=>Object} c.overrides   deadline overrides, shell-owned
 * @param {()=>Array} c.getEnrolment my courses, shell-owned
 * @param {(key:string)=>void} c.selectCategory
 * @param {(o?:Object)=>Promise<any>} c.refresh
 * @param {()=>void} c.renderSidebar
 * @param {()=>void} c.renderSelection
 * @param {import('./selection.js').Selection} c.selection
 * @param {(verb:string, id:string)=>void} c.act
 * @param {(o:Object)=>Promise<any>} c.optimistic
 * @param {(id:string)=>Promise<void>} c.openMessage
 * @param {(threadId:string, mailbox?:string)=>string} c.gmailUrl
 */
export function wireList(c) {
  ctx = c;
  el = c.el;
  state = c.state;
  // WRAP, DO NOT RESOLVE: live across mailbox switches, like every tenant.
  storeOf = () => c.store;

  /*
   * TOUCH (round 46 #11): swipe left to archive, swipe right to unarchive,
   * long-press to select.
   */
  let touchStart = null;
  let longPressTimer = 0;
  el.list.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    const row = e.target.closest('.row');
    touchStart = { x: t.clientX, y: t.clientY, row, moved: false };
    clearTimeout(longPressTimer);
    if (row) {
      longPressTimer = setTimeout(() => {
        if (touchStart && !touchStart.moved) {
          const id = row.dataset.id;
          ctx.selection.toggle(id);
          ctx.renderSelection();
          renderList();
          touchStart = null;
        }
      }, 500);
    }
  }, { passive: true });
  el.list.addEventListener('touchmove', (e) => {
    if (!touchStart) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - touchStart.x) > 8 || Math.abs(t.clientY - touchStart.y) > 8) {
      touchStart.moved = true;
      clearTimeout(longPressTimer);
    }
  }, { passive: true });
  el.list.addEventListener('touchend', (e) => {
    clearTimeout(longPressTimer);
    if (!touchStart || !touchStart.row) { touchStart = null; return; }
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    const id = touchStart.row.dataset.id;
    touchStart = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy) && id) {
      if (dx < 0) {
        ctx.optimistic({ id, verb: 'ARCHIVE', undoVerb: 'UNARCHIVE', past: 'Archived', failed: 'Could not archive', done: 'Archived' });
      } else {
        ctx.optimistic({ id, verb: 'UNARCHIVE', undoVerb: 'ARCHIVE', past: 'Unarchived', failed: 'Could not unarchive', done: 'Moved back to the inbox' });
      }
    }
  }, { passive: true });

  /*
   * POLISH 12: double-click is the muscle memory for "open the real thing".
   * One row, the exact message, in Gmail's own tab -- the escape hatch a
   * takeover must keep visible, not hidden.
   *
   * Registered ONCE, beside the click handler. It used to be added INSIDE
   * the click handler, so every click stacked another copy and a double
   * click opened one Gmail tab per click so far -- a listener leak that
   * grew with use (round 52, found during the extraction).
   */
  el.list.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (row?.dataset.id) openInGmail(row.dataset.id);
  });

  el.list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id;

    if (e.target.closest('.r-star')) {
      e.stopPropagation();
      ctx.act('star', id);
      return;
    }

    // The checkbox, or its padding. Selecting must never also open the message:
    // ticking twelve boxes would otherwise mark twelve messages read.
    if (e.target.closest('.r-pick')) {
      e.stopPropagation();
      e.preventDefault();
      ctx.selection.toggle(id);
      ctx.renderSelection();
      return;
    }

    // Shift extends a range; Ctrl/Cmd toggles one. Both are what a file manager
    // has trained people to expect, so neither needs explaining.
    if (e.shiftKey && ctx.selection.anchor) {
      e.preventDefault();
      ctx.selection.range(id, renderedIds);
      ctx.renderSelection();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      ctx.selection.toggle(id);
      ctx.renderSelection();
      return;
    }

    ctx.openMessage(id);
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
  function onScrollerScroll() {
    const on = el.scroller.scrollTop > 4;
    // Spatial memory: the user's last real scroll position, captured at
    // the event, because the rebuild task that follows a delta can clamp
    // the live position before renderList gets to read it (measured).
    lastUserScroll = el.scroller.scrollTop;
    if (on !== scrolledOn) {
      scrolledOn = on;
      el.listpane.classList.toggle('scrolled', on);
      document.body.classList.toggle('list-scrolled', on);
      // The rebuild's clamp emits a scrollTop-0 event milliseconds before
      // the deferred restore lands; never treat that as "user went home".
      if (on === false && el.scroller.scrollTop < 80 && !el.newpill.hidden
          && pendingScrollRestore === 0) {
        el.newpill.hidden = true;
        newCount = 0;
      }
    }
  }
  el.scroller.addEventListener('scroll', onScrollerScroll, { passive: true });

  $('newpill').addEventListener('click', () => {
    pendingScrollRestore = 0;
    lastUserScroll = 0;
    el.scroller.scrollTop = 0;
    el.newpill.hidden = true;
    newCount = 0;
  });
}

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------- accessors --

/**
 * Test seam: drop every piece of per-boot list state. app.js is re-imported
 * per boot with a cache-busting URL, but THIS module is cached, so its row
 * index and scroll memory would otherwise leak rows from a discarded document
 * into the next test's boot.
 */
export function _resetList() {
  renderedIds = [];
  firstPaint = false;
  nodeById.clear();
  scrollMemory.clear();
  newCount = 0;
  preQueryScroll = 0;
  pendingScrollRestore = 0;
  restoreQueued = false;
  lastUserScroll = 0;
  scrolledOn = false;
  travelGhostEl = null;
}

export function renderedIdsOf() {
  return renderedIds;
}

export function nodeByIdOf() {
  return nodeById;
}

/** Drop every row and the index. Mailbox switch and view reset call this. */
export function clearRows() {
  nodeById.clear();
  renderedIds = [];
}

/** Forget the deferred scroll restore. Sign-out and search clearing call this. */
export function resetScrollState() {
  pendingScrollRestore = 0;
  lastUserScroll = 0;
}

/** R4: each category keeps its place; returning is returning, not resetting. */
export function saveScroll(key) {
  scrollMemory.set(key, el.scroller.scrollTop);
}

export function recallScroll(key) {
  return scrollMemory.get(key) || 0;
}

/** R5: capture where the search began, once, before the first keystroke. */
export function capturePreSearchScroll() {
  preQueryScroll = el.scroller.scrollTop;
}

/** R5: clearing a search returns you to where the search began. */
export function applySearchScroll(hasQuery) {
  pendingScrollRestore = 0;
  lastUserScroll = 0;
  el.scroller.scrollTop = hasQuery ? 0 : preQueryScroll;
}

/**
 * R3: arrivals while scrolled deep surface as a pill, not a toast.
 * Returns true when the pill took the announcement, so the shell's refresh
 * toasts only what the pill did not.
 */
export function announceNew(n) {
  if (!n) return false;
  if (el.scroller.scrollTop > 200) {
    // The anchor held, but the arrival must not be invisible. The pill is
    // the toast's spatial cousin: it says how many and takes you to them.
    newCount += n;
    el.newpill.hidden = false;
    el.newpill.textContent = `${newCount} new — jump up`;
    return true;
  }
  return false;
}

// -------------------------------------------------------------- queries --

function selectorsCtx() {
  return {
    mailbox: state.mailbox,
    category: state.category,
    query: state.query,
    threaded: settings.get('threaded'),
    muted: ctx.getRules().muted,
    parse: (q) => parseQuery(q, Date.now(), { dueAtOf: (m) => deadlineStore.dueAtOf(m, ctx.overrides()) }),
    overlay: { ids: overlayIds, get: overlayGet },
  };
}

export function mutedHiddenCount() {
  return sel.mutedHiddenCount(storeOf(), selectorsCtx());
}

export function visibleIds() {
  return sel.visibleIds(storeOf(), selectorsCtx());
}

/** Sidebar total: collapse at the same choke point as the list (see R-6). */
export function collapseThreads(ids) {
  return sel.collapseThreads(ids, storeOf(), selectorsCtx());
}

// --------------------------------------------------------------- render --

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
export function refreshSubjectClip() {
  for (const [, node] of nodeById) {
    const s = node.querySelector('.r-subj');
    if (s) node.classList.toggle('subj-clip', s.scrollWidth > s.clientWidth);
  }
}

export function renderList() {
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
   * It does not, because `selectMailbox` clears the rows before rendering, so
   * `renderedIds.length > 0` is false on the first render of any new mailbox.
   * I added a view-key guard, then removed it again: sabotaging it changed no
   * test, and sabotaging `renderedIds.length > 0` changed no test either,
   * because the reset makes both vacuous.
   *
   * Recording it because it is a LOAD-BEARING COINCIDENCE. If a future change
   * stops clearing the rows on mailbox switch — a reasonable-looking
   * optimisation — the empty Sent mailbox starts congratulating you for
   * clearing an inbox you never touched. The test named
   * "switching to an empty mailbox is not an achievement" is the tripwire.
   */
  const achieved = next.length === 0 && renderedIds.length > 0
    && renderedIds.some((id) => !storeOf().get(id));

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
      fillRow(node, storeOf().get(id));
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
    if (storeOf().get(id)) {
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

  // SPATIAL MEMORY (audit 38): a structural render must not yank the
  // viewport. Without this, every delta sync snapped a scrolled user back
  // to the top -- the anchor held at the store level and died at the DOM
  // level. Explicit resets (category switch, resync, search) assign
  // scrollTop themselves after this runs.
  el.list.replaceChildren(frag);
  /*
   * Restore on the NEXT frame from the position captured at the last real
   * scroll event: the rebuild task clamps the live position before a
   * same-task read can see it (measured). One deferred restore, cancellable
   * by every explicit reset, is the whole mechanism.
   */
  if (lastUserScroll > 40) pendingScrollRestore = lastUserScroll;
  if (pendingScrollRestore > 0 && !restoreQueued) {
    restoreQueued = true;
    requestAnimationFrame(() => {
      restoreQueued = false;
      if (pendingScrollRestore > 0 && el.scroller.scrollTop < 40) {
        el.scroller.scrollTop = pendingScrollRestore;
      }
      pendingScrollRestore = 0;
    });
  }

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
  if (ctx.selection.active) ctx.renderSelection();
}

/**
 * The empty state has to say WHICH kind of empty this is.
 *
 * "Nothing here." is the same message whether the user filtered too hard,
 * has an empty category, or has genuinely read everything — three different
 * situations needing three different next actions. A generic string makes
 * the user work out which one they are in.
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
  } else if (storeOf().size > 0 && mutedHiddenCount() > 0) {
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
      ctx.setRules({ ...ctx.getRules(), muted: [] });
      ctx.saveRules();
      renderList();
      ctx.renderSidebar();
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
  } else if (storeOf().size === 0) {
    // Each mailbox says something true about itself. "Inbox empty" while
    // looking at Trash is the kind of small wrongness that reads as a bug.
    const mb = getMailbox(state.mailbox);
    el.emptyTitle.textContent = state.mailbox === 'inbox' ? 'Inbox empty' : `${mb.label} is empty`;
    el.emptySub.textContent = mb.empty || 'Nothing to show.';
    clear('Refresh', () => ctx.refresh());
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
export function setSkeleton(on) {
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
export function travelGhost(fromRect, text) {
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

  fillRow(li, storeOf().get(id));
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
  // Forty identical "Select message" names made the accessibility tree a
  // list of clones; the subject gives each tick its own name (46 #46).
  q('.r-check')?.setAttribute('aria-label', `Select ${m.subject || m.from}`);
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
    ? storeOf().thread(Store.threadOf(m))
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
    const chip = myCourses.courseChip(m.courses || [], ctx.getEnrolment());
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
export function setCount(node, unread, total) {
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

function openInGmail(id) {
  window.open(ctx.gmailUrl(id), '_blank');
}

/*
 * SPATIAL MEMORY (audit 38, concept #6): returning from any detour drops the
 * eye back where it was. The scroll is the information; the pulse is the
 * confirmation, and reduced motion keeps the former and drops the latter.
 */
export function reorientTo(id) {
  const node = nodeById.get(id);
  if (!node) return;
  if (typeof node.scrollIntoView === 'function') {
    node.scrollIntoView({ block: 'nearest' });
  }
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  node.classList.remove('reorient');
  void node.offsetWidth;
  node.classList.add('reorient');
  setTimeout(() => node.classList.remove('reorient'), 800);
}

export function patchRow(id) {
  const node = nodeById.get(id);
  if (node) fillRow(node, storeOf().get(id));
}

// Self-registered test seam (reset-registry.js, roadmap M-2): cached module
// state must not outlive a cache-busted app.js re-import in the harness.
registerReset('list', _resetList);
