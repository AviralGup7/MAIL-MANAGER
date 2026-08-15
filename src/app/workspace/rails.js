/**
 * The sidebar's live rails: Snoozed, Outbox, and the triage lane headers.
 *
 * RESPONSIBILITY  Render the snoozed rail (with wake), the outbox rail (with
 *                 retry/discard), drive the outbox pump loop, and insert lane
 *                 headers into a built list fragment.
 * OWNS            #snoozed/#outbox rendering; outboxTimer, pumpFailedNotified,
 *                 newlyStuck.
 * DOES NOT OWN    the message list itself (it receives a fragment for lane
 *                 headers), the deadline overrides (shell state, read via
 *                 ctx), snooze scheduling, sending.
 * DEPENDS ON      injected ctx (store getter, send, state, refresh,
 *                 overrides getter) + snooze.js, outbox.js, lanes.js,
 *                 deadline-store.js, activity.js, toast.js, display.js.
 *
 * Extracted in the round-52 workspace sequence (map §6 step 4), following the
 * notices-rail tenant pattern. insertLaneHeaders lives here — not in the list
 * module — because it is rail furniture: a pure fragment transform the list
 * asks for when the lanes setting is on.
 */

import { loadSnoozed, pending as pendingSnoozes, wakeLabel } from '../system/snooze.js';
import * as outbox from '../compose/outbox.js';
import * as lanes from '../academic/lanes.js';
import * as deadlineStore from '../academic/deadline-store.js';
import * as activity from '../academic/activity.js';
import { toast } from '../overlays/toast.js';
import { displayName } from '../core/display.js';

const $ = (id) => document.getElementById(id);

/** Set by wireRails at boot. */
let ctx = null;
let storeOf = null;

let outboxTimer = 0;
/*
 * The countdown repaint, distinct from outboxTimer (the pump). The pump's
 * wakes are scheduled by the QUEUE's needs (next due item); this one's are
 * scheduled by the TEXT's needs (a shown "Sending in 4s" going stale).
 * Measured gap the browser demonstrated (roadmap Phase-5 probe,
 * 2026-08-13): per-transition repaint was already immediate (~140ms after
 * the worker's answer), but between enqueue and due the rail showed one
 * frozen "Sending in 5s" for the whole hold -- outbox.js's own doctrine
 * says a number that does not move reads as a queue that is stuck.
 */
let outboxTick = 0;
/** One toast per pump-failure episode; see pumpOutbox. */
let pumpFailedNotified = false;
/** How many sends had already given up, so only NEW failures are announced. */
let newlyStuck = 0;
/** Rows owned by another account, reported by the last pump receipt. */
let blockedOutboxIds = new Set();

/**
 * Wire the rails to the shell. Called once, at boot.
 *
 * @param {Object} c
 * @param {()=>import('../mail/store.js').Store} c.store  live store getter
 * @param {Function} c.send       worker bridge
 * @param {Object} c.state        shared app state (selfEmail)
 * @param {(o?:Object)=>Promise<void>} c.refresh
 * @param {()=>Object} c.overrides  deadline overrides, owned by the shell
 */
export function wireRails(c) {
  ctx = c;
  // WRAP, DO NOT RESOLVE: live across mailbox switches, like every tenant.
  storeOf = () => c.store;
}

/** Drop the pump's re-arm timer. Called when the shell cancels all work. */
export function cancelOutboxTimer() {
  clearTimeout(outboxTimer);
  outboxTimer = 0;
  clearTimeout(outboxTick);
  outboxTick = 0;
}

/**
 * Does any row's status text derive from the clock? Exported for tests.
 *
 * Deliberately FALSE for a held item past its releaseAt and a failed item
 * due for retry: those texts ("Sending…", "Retrying now") are static until
 * the pump's own wake lands one render later -- a tick there would only
 * duplicate the pump's work one second early. Stuck rows never tick: their
 * text is an error, not a countdown.
 */
export function needsTick(items, now = Date.now()) {
  return items.some((it) =>
    (it.state === 'held' && it.releaseAt > now) ||
    (it.state === 'failed' && !outbox.isStuck(it) &&
      (Number.isFinite(it.nextAttempt) ? it.nextAttempt : 0) > now));
}

/** Test seam: is the countdown tick armed? (The module state is a timer id.) */
export function _outboxTickArmed() { return outboxTick !== 0; }

export async function renderSnoozed() {
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
    const m = storeOf().get(it.id);
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
        await ctx.send('UNSNOOZE', { id: it.id });
        activity.record({ verb: 'UNSNOOZE', ids: [it.id], actor: 'user' });
        toast('Back in your inbox');
        await renderSnoozed();
        ctx.refresh({ silent: true });
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
export function insertLaneHeaders(frag) {
  const rows = [...frag.children].filter((n) => n.classList?.contains('row'));
  if (rows.length === 0) return;

  const answered = lanes.answeredPredicate(storeOf(), ctx.state.selfEmail);
  const ctxArgs = { self: ctx.state.selfEmail, isAnswered: answered, dueAtOf: (m) => deadlineStore.dueAtOf(m, ctx.overrides()) };

  const byLane = new Map();
  for (const node of rows) {
    const m = storeOf().get(node.dataset.id);
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

export async function pumpOutbox() {
  clearTimeout(outboxTimer);
  outboxTimer = 0;

  /*
   * DISPATCH GOES THROUGH THE WORKER (bug-hunt P1): one owner for the send
   * loop across every tab, instead of a storage claim whose get-check-set
   * two tabs could win at once. In fallback mode send() routes this same
   * verb to the in-page runner, claim-guarded. Either way the answer shape
   * is { sent, failed, skipped }.
   */
  let result;
  try {
    result = await ctx.send('OUTBOX_PUMP');
    blockedOutboxIds = new Set(result?.blockedIds || []);
    pumpFailedNotified = false;
  } catch {
    /*
     * OBSERVABLE, NOT SILENT (bug-hunt #26). A broken pump used to map
     * every error to {skipped:true} and say nothing; the user believed
     * mail was queued while nothing could dispatch. One toast per failure
     * episode -- the retry itself stays quiet.
     */
    if (!pumpFailedNotified) {
      pumpFailedNotified = true;
      toast('Outbox paused — sending will retry', { kind: 'error' });
    }
    result = { sent: 0, failed: 0, skipped: true };
  }

  if (result.sent) {
    // WITH ids (bug-hunt #27): the log must be able to say WHICH message
    // left, not just that something did.
    activity.record({ verb: 'SEND', ids: result.sentIds || [], actor: 'user' });
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

  // The pump batches (worker cap of 8); leftover due items come back on a
  // short re-arm rather than waiting for the next natural wake (bug-hunt #32).
  if (result?.more) {
    outboxTimer = setTimeout(pumpOutbox, 250);
    return;
  }
  const wake = outbox.nextWakeIn(items.filter((it) => !blockedOutboxIds.has(it.id)));
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
export async function renderOutbox(known) {
  const wrap = $('outbox');
  const list = $('outbox-list');
  if (!wrap || !list) return;

  const items = known || (await outbox.loadOutbox());

  /*
   * THE 1s COUNTDOWN TICK (see outboxTick above). Rearmed per render while
   * any shown text is time-derived; cleared otherwise, so the rail is never
   * repainted on a timer it cannot change. The re-render reloads LOCAL
   * storage only -- the worker is never woken to move a label one second.
   *
   * Focus safety: ticking rows are held/retrying rows, whose only children
   * are two plain spans (Retry/Discard exist only on stuck rows, which by
   * definition do not tick) -- replaceChildren here cannot steal focus.
   */
  clearTimeout(outboxTick);
  outboxTick = 0;
  if (needsTick(items.filter((it) => !blockedOutboxIds.has(it.id)))) {
    outboxTick = setTimeout(() => renderOutbox(), 1000);
  }

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
    status.textContent = blockedOutboxIds.has(it.id)
      ? 'Waiting for the account that queued this message'
      : outbox.statusOf(it);

    const track = document.createElement('span');
    track.className = 'outbox-track';
    track.dataset.state = it.state;
    track.setAttribute('aria-hidden', 'true');
    for (const phase of ['queued', 'held', 'dispatch', 'settled']) {
      const mark = document.createElement('i');
      mark.dataset.phase = phase;
      track.appendChild(mark);
    }

    li.append(who, status, track);

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
