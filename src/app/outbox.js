import { STORAGE } from '../platform/storage.js';

/**
 * The outbox: queued sends, undo-send, and retry.  (Features 13 and 14.)
 *
 * WHY THIS IS A CORRECTNESS FIX AND NOT A CONVENIENCE
 * --------------------------------------------------
 * Before this module, a failed send existed only as a transient toast. The
 * composed message was gone -- not saved, not retried, not recoverable. On a
 * campus network that drops several times an hour, that is data loss wearing a
 * feature's clothes, and it is why the elimination audit rated the outbox
 * above undo-send even though undo-send is the more visible of the two.
 *
 * THE STATE MACHINE
 *
 *   held    -> the undo window is open. Nothing has been sent. (Feature 13.)
 *   sending -> dispatched, awaiting the worker's answer.
 *   failed  -> the attempt failed; `nextAttempt` says when to try again.
 *   sent    -> gone. The record is removed.
 *
 * `held` is the whole of undo-send: rather than sending and then trying to
 * recall (which Gmail can only fake, and which the Gmail API cannot do at
 * all), the message simply does not leave for N seconds. Undo is then a local
 * delete, and it is guaranteed rather than best-effort.
 *
 * WHY THE QUEUE LIVES IN THE APP AND NOT IN THE SERVICE WORKER
 *
 * MV3 workers are evicted aggressively -- this project spent ten rounds on a
 * worker that would not even register. A queue that vanishes when Chrome
 * decides to reclaim memory is worse than no queue, because the user believes
 * their mail is pending. Storage is the source of truth; the worker is only a
 * dispatcher.
 *
 * FLUSH IS IDEMPOTENT AND SINGLE-FLIGHT. Two overlapping flushes could dispatch
 * the same record twice, and a duplicate send is not recoverable. The `sending`
 * state plus the in-flight guard make that impossible.
 */

const KEY = 'outbox';

/** How long a held message waits before it is really sent. */
export const DEFAULT_HOLD_MS = 8000;

/** Retry backoff. Bounded: after the last one, the message stays failed. */
export const BACKOFF_MS = [15_000, 60_000, 300_000, 900_000];

/** Beyond this the message stops retrying and waits for the user. */
export const MAX_ATTEMPTS = BACKOFF_MS.length;

/**
 * @typedef {Object} OutboxItem
 * @property {string} id
 * @property {'held'|'sending'|'failed'} state
 * @property {object} draft         to/cc/subject/body/attachments
 * @property {number} queuedAt
 * @property {number} releaseAt     when the hold expires, or 0
 * @property {number} attempts
 * @property {number} nextAttempt
 * @property {string} [error]
 * @property {string} [threadId]    for a reply
 */

function makeId() {
  return `ob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Coerce storage into a usable queue. Never throws. */
export function normaliseOutbox(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object' || !it.draft || typeof it.draft !== 'object') continue;
    // B-10: a record persisted as `sent` must never re-enter the queue
    // (resurrection = duplicate send), and an unrecognised state degrades to
    // `failed` -- visible and cancellable -- never to `held`.
    if (it.state === 'sent') continue;
    const unknownState = typeof it.state === 'string'
      ? !['held', 'sending', 'failed'].includes(it.state)
      : !!it.state;
    out.push({
      id: typeof it.id === 'string' && it.id ? it.id : makeId(),
      /*
       * A record found in `sending` state at load time was interrupted -- the
       * tab closed, or the browser was killed, mid-dispatch. It is demoted to
       * `failed` rather than left as `sending`, because a `sending` record is
       * invisible to the flush loop and would sit in the queue forever.
       *
       * The risk is a double send if the request actually succeeded before the
       * crash. Judged the lesser harm: a duplicate is embarrassing, a mail
       * that silently never went is worse, and the user can see and cancel a
       * failed record.
       */
      state: it.state === 'held' ? 'held' : 'failed',
      draft: it.draft,
      queuedAt: Number.isFinite(it.queuedAt) ? it.queuedAt : Date.now(),
      // A held item with a corrupt or missing releaseAt used to default to 0
      // -- i.e. DUE IMMEDIATELY -- and a restart would fire the send the
      // moment the app opened, skipping the undo window the user was still
      // entitled to (bug-hunt #17). Re-anchor to the hold instead.
      releaseAt: Number.isFinite(it.releaseAt)
        ? it.releaseAt
        : (Number.isFinite(it.queuedAt) ? it.queuedAt : Date.now()) + DEFAULT_HOLD_MS,
      attempts: Number.isFinite(it.attempts) ? it.attempts : 0,
      nextAttempt: Number.isFinite(it.nextAttempt) ? it.nextAttempt : 0,
      ...(typeof it.error === 'string' ? { error: it.error.slice(0, 200) } : {}),
      ...(typeof it.threadId === 'string' ? { threadId: it.threadId } : {}),
      ...(unknownState ? { error: 'unrecognised persisted state; held back from sending' } : {}),
    });
  }
  return out;
}

export async function loadOutbox(storage = STORAGE) {
  try {
    const got = (await storage.get(KEY)) || {};
    return normaliseOutbox(got[KEY]);
  } catch {
    return [];
  }
}

export async function saveOutbox(items, storage = STORAGE) {
  try {
    await storage.set({ [KEY]: normaliseOutbox(items) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Queue a message.
 *
 * @param {object} draft
 * @param {{holdMs?:number, now?:number, threadId?:string}} [opts]
 * @returns {OutboxItem}
 */
export function enqueue(draft, { holdMs = DEFAULT_HOLD_MS, now = Date.now(), threadId } = {}) {
  return {
    id: makeId(),
    state: 'held',
    draft,
    queuedAt: now,
    // holdMs of 0 means "send immediately" -- the user turned undo-send off.
    releaseAt: now + Math.max(0, holdMs),
    attempts: 0,
    nextAttempt: 0,
    ...(threadId ? { threadId } : {}),
  };
}

/**
 * Which items are ready to be dispatched right now?
 *
 * A `held` item is ready once its hold expires. A `failed` item is ready once
 * its backoff expires and it has attempts left.
 */
export function dueItems(items, now = Date.now()) {
  return items.filter((it) => {
    if (it.state === 'held') return it.releaseAt <= now;
    if (it.state === 'failed') return it.attempts < MAX_ATTEMPTS && it.nextAttempt <= now;
    return false;
  });
}

/**
 * Dispatch order for a due set (bug-hunt 43 #1): HELD FIRST.
 *
 * A held item is a human who pressed Send seconds ago; a failed item is an
 * automatic retry that has already waited its backoff. A batch cap of N
 * items must never let a backlog of retries defer a fresh send to a later
 * pump -- the user's newest action outranks the queue's oldest business.
 * Within each class the existing order stands (stable sort), so retries
 * still run oldest-first.
 */
export function prioritizeDue(items) {
  return [...items].sort((a, b) => {
    const pa = a.state === 'held' ? 0 : 1;
    const pb = b.state === 'held' ? 0 : 1;
    return pa - pb;
  });
}

/**
 * When should the next flush happen?
 *
 * Returns ms from now, or null when nothing is pending. Used to schedule one
 * timer rather than polling. A queue that polls every second to discover it
 * has nothing to do is a battery bug.
 */
export function nextWakeIn(items, now = Date.now()) {
  let soonest = Infinity;
  for (const it of items) {
    if (it.state === 'held') soonest = Math.min(soonest, it.releaseAt - now);
    else if (it.state === 'failed' && it.attempts < MAX_ATTEMPTS) {
      soonest = Math.min(soonest, it.nextAttempt - now);
    }
  }
  if (soonest === Infinity) return null;
  return Math.max(0, soonest);
}

/** Can this message still be recalled? Feature 13's precondition. */
export function canUndo(item, now = Date.now()) {
  return !!item && item.state === 'held' && item.releaseAt > now;
}

/** Record a failure and schedule the retry. Returns a NEW item. */
export function markFailed(item, error, now = Date.now()) {
  const message = String(error || 'Send failed').slice(0, 200);
  let attempts = item.attempts + 1;
  /*
   * THE SAME FAILURE TWICE IS A DIAGNOSIS, NOT A COINCIDENCE (bug-hunt #33).
   * A permanently-lost draft attachment used to burn all four retries --
   * ~16 minutes of identical failures -- before going stuck. If the error
   * repeats verbatim, retrying on the same backoff schedule will produce
   * the same result; go straight to stuck. The user can still force a retry
   * (retryNow resets the count), which is exactly the right place for a
   * human judgement call.
   */
  if (item.error && item.error === message) attempts = MAX_ATTEMPTS;
  const wait = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
  return {
    ...item,
    state: 'failed',
    attempts,
    nextAttempt: now + wait,
    error: message,
  };
}

/** Has this message given up retrying and started waiting for the user? */
export function isStuck(item) {
  return item.state === 'failed' && item.attempts >= MAX_ATTEMPTS;
}

/**
 * A human status line for the outbox row.
 *
 * Kept here so the phrasing is testable, and so the row and any notification
 * cannot drift.
 */
export function statusOf(item, now = Date.now()) {
  if (item.state === 'held') {
    const left = Math.max(0, Math.ceil((item.releaseAt - now) / 1000));
    return left > 0 ? `Sending in ${left}s` : 'Sending…';
  }
  if (item.state === 'sending') return 'Sending…';
  if (isStuck(item)) return `Could not send — ${item.error || 'unknown error'}`;

  /*
   * A `failed` record whose `nextAttempt` is absent or in the past is due NOW,
   * not "in 0s". `normaliseOutbox` defaults `nextAttempt` to 0 for a corrupt or
   * older blob, and an interrupted `sending` record is demoted to `failed` with
   * whatever it had -- so this is reachable on any restart after a crash, not
   * just from hand-built input.
   *
   * "Retrying in 0s" is the kind of string that sits there unchanged and makes
   * the queue look stuck, which is precisely the impression the outbox exists
   * to prevent.
   */
  const wait = Math.ceil(((Number.isFinite(item.nextAttempt) ? item.nextAttempt : 0) - now) / 1000);
  if (wait <= 0) return `Retrying now (attempt ${item.attempts + 1} of ${MAX_ATTEMPTS})`;
  return `Retrying in ${wait}s (attempt ${item.attempts + 1} of ${MAX_ATTEMPTS})`;
}

/* ========================================================================== *
 * THE RUNNER
 * ========================================================================== */

/** Guards against two overlapping flushes dispatching the same record twice. */
let inFlight = false;

/**
 * Ids being dispatched RIGHT NOW, in this session.
 *
 * WHY THE PERSISTED `sending` STATE CANNOT ANSWER THIS
 *
 * `normaliseOutbox` demotes a stored `sending` record to `failed` on load,
 * because a record left in `sending` by a crashed tab is otherwise invisible to
 * the flush loop forever. That demotion is correct -- and it meant `cancel`,
 * which reloads from storage, could never observe a `sending` record. The
 * in-flight guard was unreachable dead code, and a message could be cancelled
 * out of the queue while its request was still on the wire.
 *
 * Caught by a test that expected the guard to hold and found it did not.
 *
 * Liveness is a property of THIS PROCESS, so it is tracked in memory. If the
 * tab dies the set dies with it, which is exactly right: after a restart
 * nothing is in flight, and the demoted record is fair game again.
 */
const dispatching = new Set();

/**
 * Attempt every due item once.
 *
 * @param {object} deps
 * @param {(draft:object)=>Promise<any>} deps.send   dispatches one message
 * @param {object} [deps.storage]
 * @param {number} [deps.now]
 * @param {(items:OutboxItem[])=>void} [deps.onChange]  render hook
 * @returns {Promise<{sent:number, failed:number, skipped:boolean}>}
 */
const TAB_ID = Math.random().toString(36).slice(2);
const CLAIM_KEY = 'outboxClaims';
// Longer than the worst-case send (60s budget + retries); a claim that
// expires mid-send is what let two tabs both believe they owned it (V2 P1-9).
const CLAIM_TTL = 180000;

/*
 * CROSS-TAB DOUBLE-SEND GUARD (cross-audit M3). Two Gmail tabs used to both
 * release the same undo-send hold and send the mail twice: `inFlight` is
 * per-tab, so nothing coordinated them. A claim in shared storage, renewed
 * per dispatch and respected while fresh, makes the second tab stand down.
 */
async function releaseClaim(storage, id) {
  try {
    const got = (await storage.get(CLAIM_KEY)) || {};
    const claims = got[CLAIM_KEY] || {};
    if (claims[id]?.tab === TAB_ID) {
      delete claims[id];
      await storage.set({ [CLAIM_KEY]: claims });
    }
  } catch { /* best-effort; the TTL is the backstop */ }
}

async function claim(storage, id, now) {
  try {
    const got = (await storage.get(CLAIM_KEY)) || {};
    const claims = got[CLAIM_KEY] || {};
    const c = claims[id];
    if (c && c.tab !== TAB_ID && now - c.at < CLAIM_TTL) return false;
    claims[id] = { tab: TAB_ID, at: now };
    await storage.set({ [CLAIM_KEY]: claims });
    return true;
  } catch {
    return true; // storage broken: fall back to per-tab behaviour
  }
}

export async function flushOutbox({ send, storage = STORAGE, now = Date.now(), onChange } = {}) {
  if (inFlight) return { sent: 0, failed: 0, skipped: true };
  inFlight = true;
  try {
    let items = await loadOutbox(storage);
    const due = prioritizeDue(dueItems(items, now));
    if (due.length === 0) return { sent: 0, failed: 0, skipped: false };

    let sent = 0;
    let failed = 0;
    // The ids of what actually left, for the activity log (bug-hunt #27).
    // `send` returns the wire response when it can; the fallback path has
    // no Gmail id to offer and pushes the queue id instead -- something is
    // better than the empty array this used to record.
    const sentIds = [];

    for (const item of due) {
      // Claim it before awaiting, so a concurrent load cannot pick it up.
      dispatching.add(item.id);
      if (!(await claim(storage, item.id, now))) {
        dispatching.delete(item.id); // denied claims must not leak (V2 P1-9)
        continue; // another tab owns it
      }
      items = items.map((x) => (x.id === item.id ? { ...x, state: 'sending' } : x));
      await saveOutbox(items, storage);
      onChange?.(items);

      try {
        const res = await send(item.draft);
        sentIds.push(res?.id || item.id);
        items = items.filter((x) => x.id !== item.id);
        await releaseClaim(storage, item.id);
        sent++;
      } catch (err) {
        items = items.map((x) => (x.id === item.id ? markFailed(x, err?.message || err, now) : x));
        failed++;
      } finally {
        dispatching.delete(item.id);
      }
      await saveOutbox(items, storage);
      onChange?.(items);
    }

    return { sent, failed, skipped: false, sentIds };
  } finally {
    inFlight = false;
  }
}

/** Remove one item -- the undo path, and the "cancel" button on a stuck item. */
export async function cancel(id, storage = STORAGE) {
  const items = await loadOutbox(storage);
  const item = items.find((x) => x.id === id);
  if (!item) return null;
  /*
   * A message being dispatched right now cannot be cancelled: the request is
   * on the wire and we cannot know whether it landed. Returning null rather
   * than pretending is the honest answer, and the UI disables the button.
   *
   * Checked against the live set, NOT against the stored state -- see the note
   * on `dispatching`.
   */
  if (dispatching.has(id) || item.state === 'sending') return null;
  await saveOutbox(items.filter((x) => x.id !== id), storage);
  return item;
}

/** Retry a stuck item now, resetting its backoff. */
export async function retryNow(id, storage = STORAGE, now = Date.now()) {
  const items = await loadOutbox(storage);
  const next = items.map((x) =>
    x.id === id ? { ...x, state: 'failed', attempts: 0, nextAttempt: now } : x
  );
  await saveOutbox(next, storage);
  return next.find((x) => x.id === id) || null;
}

/** Test seam. Module state outlives a jsdom boot. */
export function _resetOutbox() {
  inFlight = false;
  dispatching.clear();
}

/** Is this item on the wire right now? For the UI's disabled state. */
export function isDispatching(id) {
  return dispatching.has(id);
}
