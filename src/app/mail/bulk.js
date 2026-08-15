/**
 * Selection and bulk — the Mail workspace's multi-message verbs.
 *
 * RESPONSIBILITY  Own the Selection instance; reflect it into the rows and
 *                 the bulkbar; run one action across the whole selection as
 *                 ONE Gmail request, ONE store batch, ONE undo entry; drive
 *                 j/k row navigation (which walks the rendered list).
 * OWNS            the Selection instance; the bulkbar render; BULK_ACTIONS;
 *                 the chunked-bulk protocol (progress toast, cancel,
 *                 per-chunk reconcile).
 * DOES NOT OWN    the rows themselves (list.js), the reader, the undo STACK
 *                 (undo-actions.js), the worker verbs.
 * DEPENDS ON      injected ctx (see wireBulk) + list.js (row index,
 *                 reorientTo), selection.js, settings.js, activity.js,
 *                 toast.js, undo-actions.js.
 *
 * Extracted in the round-52 workspace sequence (map audits/51 §6 step 6),
 * the last move of the sequence: it shares the row index with list.js and
 * the keyboard, which is why the round-46 map sequenced it after both.
 */

import { Selection, selectionLabel } from './selection.js';
import { renderedIdsOf, nodeByIdOf, reorientTo } from './list.js';
import * as settings from '../system/settings.js';
import * as activity from '../academic/activity.js';
import { toast } from '../overlays/toast.js';
import { recordUndo } from './undo-actions.js';
import { registerReset } from '../core/reset-registry.js';
import { burst as fxBurst } from '../motion/particles.js';

/** Set by wireBulk at boot. */
let ctx = null;
let el = null;
let state = null;
let storeOf = null;

/**
 * Multi-select.
 *
 * Deliberately separate from `state.selected`, which is the OPEN message. A
 * row can be checked without being read, and conflating the two means you
 * cannot select the message you are looking at.
 */
export const selection = new Selection();

/**
 * Wire bulk to the shell. Called once, at boot.
 *
 * @param {Object} c
 * @param {()=>import('./store.js').Store} c.store  live store getter
 * @param {Object} c.state        shared app state
 * @param {Object} c.el           cached DOM map
 * @param {Function} c.send       worker bridge
 * @param {(on:boolean)=>void} c.setBusy
 * @param {()=>void} c.closeReader
 * @param {(id:string)=>Promise<void>} c.openMessage
 * @param {Object} c.appCtx       the shell's own ctx, passed through to
 *                                recordUndo/performUndo (they speak that
 *                                contract, not this module's seam)
 */
export function wireBulk(c) {
  ctx = c;
  el = c.el;
  state = c.state;
  // WRAP, DO NOT RESOLVE: live across mailbox switches, like every tenant.
  storeOf = () => c.store;
}

/**
 * Test seam: drop per-boot selection state. main.js is re-imported per boot
 * with a cache-busting URL, but THIS module is cached, so a selection left
 * ticking by one test would otherwise hand the next boot a live bulk mode.
 */
function _resetBulk() {
  selection.clear();
}

export function move(delta) {
  const ids = renderedIdsOf();
  if (ids.length === 0) return;
  const i = state.selected ? ids.indexOf(state.selected) : -1;
  const next = ids[Math.max(0, Math.min(ids.length - 1, i + delta))];
  if (!next || next === state.selected) return;
  ctx.openMessage(next);

  // Feature-detected rather than assumed.
  //
  // scrollIntoView exists in every real browser, so this is not defending
  // against a browser gap -- it is defending against the fact that an
  // exception thrown HERE aborts the whole keydown handler. A missing scroll
  // is cosmetic; a dead j/k key is not, and coupling the two is the bug.
  const node = nodeByIdOf().get(next);
  if (typeof node?.scrollIntoView === 'function') {
    node.scrollIntoView({ block: 'nearest' });
  }
}

/**
 * The messages the current selection stands for.
 *
 * With threading on, a tick on a collapsed row means the whole conversation --
 * archiving one reply and leaving two behind is the most confusing thing a
 * threaded client can do, because the row appears to survive the action.
 */
export function selectedMessageIds() {
  const ids = renderedIdsOf();
  return settings.get('threaded')
    ? selection.liveThreaded(storeOf(), ids)
    : selection.live(storeOf(), ids);
}

/**
 * Reflect selection into the DOM.
 *
 * Touches only the checkbox state and one class per row, so it is cheap enough
 * to call on every selection change without going through the render loop --
 * selection does not alter WHICH rows exist, only how they look.
 */
export function renderSelection() {
  const threaded = settings.get('threaded');
  const ids = selectedMessageIds();
  const n = ids.length;
  el.bulkbar.hidden = n === 0;
  el.listhead.hidden = n > 0;
  document.body.classList.toggle('selecting', n > 0);

  for (const [id, node] of nodeByIdOf()) {
    /*
     * A row reads as ticked when ANY message in its conversation is. A reply
     * arriving replaces the rendered root, and without this the tick the user
     * placed silently disappears with the row it was attached to.
     */
    const on = threaded ? selection.hasThread(storeOf(), id) : selection.has(id);
    if (node.classList.contains('picked') !== on) node.classList.toggle('picked', on);
    const box = node.querySelector('.r-check');
    if (box && box.checked !== on) box.checked = on;
  }

  if (n === 0) return;
  el.bulkCount.textContent = selectionLabel(n);

  // Tri-state "select all": checked when everything visible is picked,
  // indeterminate when only some is. A plain checkbox that reads "checked"
  // while half the list is selected is a lie.
  const visibleIdsNow = renderedIdsOf();
  const visible = visibleIdsNow.length;
  const picked = visibleIdsNow.filter((id) => selection.has(id)).length;
  el.bulkAll.checked = picked === visible && visible > 0;
  el.bulkAll.indeterminate = picked > 0 && picked < visible;
}

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
 * assumed. The problem was that nothing MADE them correct. Adding a sixth
 * action means remembering to edit two ladders in two places, and getting an
 * inverse wrong is close to invisible: the list on screen is restored from
 * the local snapshot regardless of what goes to the server, so a broken undo looks
 * perfect locally and only diverges in Gmail, where the test suite cannot see.
 * A row-counting test passed happily with `trash`'s undo sabotaged.
 *
 * Now the delta is written once and the undo is `{add: remove, remove: add}`.
 * An inverse cannot drift from its action because it is no longer stored.
 */
export const BULK_ACTIONS = {
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
export async function bulkAct(kind, explicitIds = null) {
  const ids = explicitIds || selectedMessageIds();
  if (ids.length === 0) return;

  // Snapshot BEFORE mutating, for the undo.
  const snapshots = ids.map((id) => ({ ...storeOf().get(id) }));
  const n = ids.length;
  const noun = n === 1 ? 'message' : 'messages';

  const removal = kind === 'archive' || kind === 'trash' || kind === 'spam';
  if (removal && state.selected && ids.includes(state.selected)) ctx.closeReader();

  /*
   * P6 DUST: only 'trash' — the one explicitly destructive verb — turns the
   * condemned rows to dust. Archive and spam stay silent: spectacle is a
   * budget, and routine verbs must not spend it.
   * Rects are measured BEFORE the batch: after storeOf().remove there is no
   * row left to measure. The pool caps the total at 240 particles whatever
   * the selection size; 8 spots × 18 stays well inside it by design.
   */
  const dustSpots = [];
  if (kind === 'trash') {
    for (const id of ids.slice(0, 8)) {
      const r = nodeByIdOf().get(id)?.getBoundingClientRect?.();
      if (r?.width) dustSpots.push([r.left + r.width / 2, r.top + r.height / 2]);
    }
  }

  storeOf().batch(() => {
    for (const id of ids) {
      if (kind === 'archive' || kind === 'trash' || kind === 'spam') storeOf().remove(id);
      else if (kind === 'read') storeOf().patch(id, { unread: false });
      else if (kind === 'star') storeOf().patch(id, { starred: true });
    }
  });
  // Only when acting on a selection: a conversation action from the reader
  // has not touched the ticks and must not silently discard them.
  if (!explicitIds) {
    selection.clear();
    renderSelection();
    /*
     * FOCUS MUST NOT BE STRANDED (round 45 Phase 2). The rows the user was
     * standing on just left the list; without this, focus lands on <body>
     * and a keyboard user has to tab back from the top of the page. The
     * listbox is where j/k lives, so that is where focus belongs after a
     * bulk action.
     */
    el.list.focus({ preventScroll: true });
  }

  // The rows are gone; the dust they left settles over the next second.
  for (const [x, y] of dustSpots) fxBurst(x, y, { count: 18, speed: [90, 300] });

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
  if (slow) ctx.setBusy(true);

  /*
   * CHUNKED WITH PROGRESS AND CANCEL (round 45 M2). A 4000-message run is
   * four requests, and a spinner is not an answer to "is it working?" -- so
   * each chunk reports its place in the run and offers a stop. Cancelling
   * between chunks leaves what already landed landed (undo covers it) and
   * restores what was never sent; nothing is half-sent silently. Batches of
   * one chunk behave exactly as before: no progress toast, no cancel.
   */
  const CHUNK = 1000;
  const PROGRESS_VERB = {
    archive: 'Archiving', trash: 'Deleting', spam: 'Reporting spam',
    read: 'Marking read', star: 'Starring',
  };
  const chunked = ids.length > CHUNK;
  let cancelled = false;
  const appliedIds = [];
  const appliedSnapshots = [];
  const failedIds = [];
  try {
    for (let i = 0; i < ids.length && !cancelled; i += CHUNK) {
      const sliceIds = ids.slice(i, i + CHUNK);
      const sliceSnaps = snapshots.slice(i, i + CHUNK);
      if (chunked) {
        const done = Math.min(i + CHUNK, ids.length);
        toast(`${PROGRESS_VERB[kind] || kind} ${done.toLocaleString()} of ${n.toLocaleString()}…`, {
          kind: 'info', ms: 2500,
          action: { label: 'Cancel', run: () => { cancelled = true; } },
        });
      }
      try {
        const res = await ctx.send('BULK', { ids: sliceIds, add, remove });
        const failed = reconcileBulk(res, sliceSnaps);
        const failedSet = new Set(failed);
        failedIds.push(...failed);
        for (let j = 0; j < sliceIds.length; j++) {
          if (!failedSet.has(sliceIds[j])) {
            appliedIds.push(sliceIds[j]);
            appliedSnapshots.push(sliceSnaps[j]);
          }
        }
      } catch {
        // The whole chunk failed: put those rows back on screen and count
        // them failed. The NEXT chunk still gets its chance -- one bad
        // request is not a verdict on the whole run.
        storeOf().batch(() => { for (const m of sliceSnaps) storeOf().upsert(m); });
        failedIds.push(...sliceIds);
      }
    }

    if (cancelled) {
      // Rows never sent come back; rows already applied stay (undo covers
      // them) and rows that failed already came back chunk by chunk.
      const touched = new Set([...appliedIds, ...failedIds]);
      const unsent = snapshots.filter((m) => !touched.has(m.id));
      storeOf().batch(() => { for (const m of unsent) storeOf().upsert(m); });
    }

    if (failedIds.length) {
      activity.record({ verb: `BULK_${kind.toUpperCase()}`, ids: failedIds, actor: 'user', outcome: 'partial', error: `${failedIds.length} failed` });
      toast(`${kind}: ${appliedIds.length} of ${n} applied${cancelled ? ' (cancelled)' : ''}`, { kind: 'error' });
      if (!appliedIds.length) return;
    } else if (cancelled) {
      toast(`${kind} stopped — ${appliedIds.length} of ${n} applied`, { kind: 'info' });
      activity.record({ verb: `BULK_${kind.toUpperCase()}`, ids: appliedIds, actor: 'user', detail: 'cancelled' });
      if (!appliedIds.length) return;
    }
  } finally {
    // `finally`, so an early return on the error path cannot strand the busy
    // state and leave the topbar sweeping forever.
    if (slow) ctx.setBusy(false);
  }

  activity.record({ verb: `BULK_${kind.toUpperCase()}`, ids: appliedIds, actor: 'user' });

  const appliedNoun = appliedIds.length === 1 ? 'message' : 'messages';
  recordUndo(ctx.appCtx, `${verb} ${appliedIds.length} ${appliedNoun}`, async () => {
    storeOf().batch(() => {
      for (const m of appliedSnapshots) storeOf().upsert(m);
    });
    // R2: recovery is a disorienting moment by definition; the first
    // restored row pulses back into view once the render lands.
    requestAnimationFrame(() => reorientTo(appliedSnapshots[0]?.id));
    // The inverse is DERIVED, never typed: swap add and remove.
    await ctx.send('BULK', { ids: appliedIds, add: remove, remove: add });
    activity.record({ verb: `BULK_${kind.toUpperCase()}`, ids: appliedIds, actor: 'user', detail: 'undo' });
  });
}

/**
 * ONE reconciliation contract for partial bulk results (V2 P1-8). Every
 * caller -- user bulkAct, auto-archive, rule batches -- restores exactly the
 * ids Gmail rejected and reports the split; no call site interprets
 * `res.failed` on its own anymore.
 */
export function reconcileBulk(res, snapshots) {
  const failed = res?.failed || [];
  if (!failed.length) return failed;
  const doomed = new Set(failed);
  storeOf().batch(() => {
    for (const m of snapshots) if (doomed.has(m.id)) storeOf().upsert(m);
  });
  return failed;
}

// Self-registered test seam (reset-registry.js, roadmap M-2): cached module
// state must not outlive a cache-busted main.js re-import in the harness.
registerReset('bulk', _resetBulk);
