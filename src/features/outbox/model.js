import { STORAGE } from '../../platform/storage.js';
import { read as durableRead, mutate as durableMutate } from '../../platform/durable.js';

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
 * THE CANONICAL OUTBOX_PUMP ANSWER (roadmap Phase 3 / bug-hunt 43 #50).
 *
 * Four producers speak this shape -- the worker verb, this module's in-page
 * runner, and both integration emulators -- and this typedef is the single
 * definition they are pinned against. Any new producer imports the contract
 * from here rather than inventing a fifth dialect.
 *
 * @typedef {Object} PumpResult
 * @property {number}   sent      messages that left
 * @property {number}   failed    messages that did not
 * @property {boolean}  skipped   the pump was already running; nothing was done
 * @property {string[]} sentIds   NAMESPACED ids of what left: `g:` for Gmail
 *                                message ids (worker path), `q:` for outbox
 *                                queue ids (fallback path, which has no Gmail
 *                                id to offer). The prefix keeps the activity
 *                                log from mixing two id spaces in one field.
 * @property {boolean}  [more]    due items remain beyond this batch; the
 *                                caller re-arms promptly
 * @property {number}   [wrongAccount] rows the pump REFUSED for the session's
 *                                account (AUD-C2, 2026-08-15): they stay
 *                                queued, armed for their owner, and the count
 *                                is the honest receipt. Absent when zero —
 *                                a silent field is a door nobody walks through.
 */

/**
 * @typedef {Object} OutboxItem
 * @property {string} id
 * @property {'held'|'sending'|'failed'|'uncertain'} state
 * @property {object} draft         to/cc/subject/body/attachments
 * @property {number} queuedAt
 * @property {number} releaseAt     when the hold expires, or 0
 * @property {number} attempts
 * @property {number} nextAttempt
 * @property {string} [error]
 * @property {string} [threadId]    for a reply
 * @property {string} [accountEmail] the account that queued it (AUD-C2):
 *                                the pump refuses a record whose owner is
 *                                not the current session. Absent on legacy
 *                                rows, which pass (they predate identity).
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
      ? !['held', 'sending', 'failed', 'uncertain'].includes(it.state)
      : !!it.state;
    out.push({
      id: typeof it.id === 'string' && it.id ? it.id : makeId(),
      /*
       * A record found in `sending` at load time was interrupted -- the tab
       * closed, or (far more likely under MV3) the service worker was killed
       * mid-dispatch. It must not stay `sending`, because that state is
       * invisible to the flush loop and would sit in the queue forever.
       *
       * IT MUST NOT BECOME `failed` EITHER (audit EXT2-H5).
       *
       * `failed` with attempts:0 and nextAttempt:0 is IMMEDIATELY DUE, so the
       * very next pump re-sent it -- and the request may well have reached
       * Gmail before the worker died. That is the duplicate-mail failure the
       * rest of this module is built to prevent: the cross-tab claim, the
       * pump lock and the settle-and-verify all exist for it, and the crash
       * path walked straight past them. The old comment reasoned the trade
       * as "a duplicate is embarrassing, a lost mail is worse" and then took
       * the automatic option, silently, with no third choice.
       *
       * The third choice already exists. `uncertain` is precisely "we do not
       * know whether this was delivered": it is NOT due (dueItems ignores
       * it), it renders as "Delivery status unknown -- check Sent before
       * retrying", and `retryNow` lets the user send it deliberately once
       * they have looked. Nothing is lost, nothing is auto-duplicated, and
       * the judgement lands with the only party who can actually check.
       *
       * This is the same conclusion `markUncertain` reached for
       * OUTCOME_UNKNOWN on the live path; a worker death mid-flight is the
       * same epistemic state arriving by a different door.
       */
      state: it.state === 'held' ? 'held'
        : (it.state === 'uncertain' || it.state === 'sending') ? 'uncertain'
          : 'failed',
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
      // The owner stamp survives the round trip (AUD-C2): a normalise that
      // dropped it would un-scope every queued record on every reload.
      ...(typeof it.accountEmail === 'string' && it.accountEmail
        ? { accountEmail: it.accountEmail } : {}),
      ...(typeof it.error === 'string' ? { error: it.error.slice(0, 200) } : {}),
      ...(typeof it.threadId === 'string' ? { threadId: it.threadId } : {}),
      ...(unknownState ? { error: 'unrecognised persisted state; held back from sending' } : {}),
      /* A crash-interrupted row explains ITSELF (EXT2-H5). Without this the
         outbox showed "Delivery status unknown" with no cause, which reads
         as a glitch rather than as the honest answer it is. Only set when
         the record does not already carry a more specific error. */
      ...(it.state === 'sending' && typeof it.error !== 'string'
        ? { error: 'Interrupted while sending — it may already have gone' }
        : {}),
    });
  }
  return out;
}

/**
 * The queue, or an empty list when storage cannot answer.
 *
 * KEPT FOR READERS ONLY. A UI that draws the outbox is right to treat a
 * failed read as "nothing to draw" — it will repaint on the next change.
 * A MUTATOR must not use this; see `readOutbox` and the note on
 * `loadOutboxStrict`.
 */
export async function loadOutbox(storage = STORAGE) {
  const got = await readOutbox(storage);
  return got.value;
}

/**
 * The three-state read (round 12, P0-2).
 *
 * MEASURED BEFORE THIS EXISTED: `retryNow` on a queue of five, with the
 * storage read failing, wrote back a ONE-element array — four real unsent
 * messages destroyed, permanently, with no error anywhere. The mutator did
 * nothing wrong; it asked "what is queued", was told "nothing", and believed
 * it. `loadOutbox` could not tell it otherwise, because a thrown read and an
 * empty queue returned the same `[]`.
 *
 * @returns {Promise<{ok:boolean, value:OutboxItem[], reason?:string}>}
 */
export async function readOutbox(storage = STORAGE) {
  return durableRead(KEY, {
    storage,
    empty: [],
    normalise: normaliseOutbox,
    // An array is the only shape this key may hold. Anything else is a
    // previous version's mistake, not a transient failure, so it is
    // reported as corrupt and may be overwritten.
    isValid: (raw) => Array.isArray(raw),
  });
}

/**
 * Read-modify-write the queue, REFUSING to write over an unreadable base.
 *
 * Every mutator below goes through this. The refusal is the fix: a modify
 * built on a base we failed to read is how five messages became zero.
 *
 * @param {(items:OutboxItem[]) => OutboxItem[]} change
 */
async function mutateOutbox(change, storage = STORAGE) {
  return durableMutate(KEY, change, {
    storage,
    empty: [],
    normalise: normaliseOutbox,
    isValid: (raw) => Array.isArray(raw),
  });
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
 * May THIS session send this queued item? (audit 2026-08-15, AUD-C2)
 *
 * The queue predates account identity, so the rule is asymmetric on purpose:
 * an UNSTAMPED record (queued before the stamp existed, or by a session that
 * never proved one) dispatches — refusing it would strand real mail nobody
 * can identify. A STAMPED record sends only for its own account: a queued
 * draft is a promise made BY someone, and the stamp is how the pump knows
 * the promise is not being handed to a stranger.
 */
export function dispatchable(item, accountEmail) {
  /* P0-1: a known delivery is never dispatchable again, whatever the queue
     still says. This is the guard that turns a lost removal into a stale row
     instead of a duplicate email. */
  if (item && delivered.has(item.id)) return false;
  const mine = typeof item?.accountEmail === 'string'
    ? item.accountEmail.trim().toLowerCase() : '';
  const current = typeof accountEmail === 'string'
    ? accountEmail.trim().toLowerCase() : '';
  /*
   * Legacy UNOWNED rows cannot be assigned safely, so they remain visible and
   * dispatchable for migration compatibility. An OWNED row is different: an
   * unproved current session is not permission to send it. Fail closed until
   * identity activation succeeds.
   *
   * EXT2-M6 WITHDRAWN (audit round 4). I proposed also refusing an unstamped
   * row under an unproved session — "neither sends into the dark". Tested,
   * and it is wrong: `accountEmail` is absent for an ordinary single-account
   * install until identity activation completes, and for every caller that
   * does not thread it through. The change stranded queued mail in seven
   * existing scenarios, which is the precise harm the legacy fail-open exists
   * to prevent, in exchange for a cross-account send that the STAMP already
   * prevents on every row written since AUD-C2.
   *
   * The residual exposure is narrow and bounded: a row queued before the
   * stamp existed, still queued now, sent under a different account. Closing
   * it properly means backfilling stamps at migration, not refusing mail at
   * dispatch. Left as-is deliberately, with the reasoning recorded so it is
   * not re-attempted.
   */
  if (!mine) return true;
  if (!current) return false;
  return mine === current;
}

/**
 * Empty the queue (audit 2026-08-15, AUD-C2) — the first removal verb the
 * outbox ever grew, and deliberately NOT called from the worker. Its one
 * caller is the app's sign-out, UNDER the `clearOutboxOnSignOut` setting
 * (default ON): "nothing is removed" is the house rule, so the removal is
 * a preference, not a policy. A queue kept (setting OFF) is still scoped by
 * `dispatchable`, so keeping it cannot produce a cross-account send.
 */
export async function clearOutbox(storage = STORAGE) {
  try {
    await storage.remove(KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Queue a message.
 *
 * @param {object} draft
 * @param {{holdMs?:number, now?:number, threadId?:string, accountEmail?:string}} [opts]
 * @returns {OutboxItem}
 */
export function enqueue(draft, { holdMs = DEFAULT_HOLD_MS, now = Date.now(), threadId, accountEmail } = {}) {
  return {
    id: makeId(),
    state: 'held',
    draft,
    queuedAt: now,
    // Who queued it (AUD-C2). The dispatch gate is at the pump, not here:
    // enqueueing never needs a session, SENDING does.
    ...(typeof accountEmail === 'string' && accountEmail ? { accountEmail } : {}),
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
  if (!Array.isArray(items)) return [];
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
  if (!Array.isArray(items)) return [];
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
  if (!Array.isArray(items)) return null;
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

/**
 * Errors that describe a PERMANENTLY lost draft attachment (bug-hunt 43 #33).
 * Retrying these cannot succeed -- the source part is gone -- so the first
 * such failure goes straight to stuck. The user's retry button (retryNow)
 * stays the explicit override.
 */
const ATTACHMENT_LOST = /Cannot recover attachment|Could not read attachment/;

/**
 * THE failure-classification predicate, defined ONCE (roadmap Phase 4 /
 * bug-hunt 44 #66/#31). The runner, the worker pump and every test harness
 * decide "how many attempts does this failure cost" HERE -- three places
 * used to carry three copies of this rule, and copies drift.
 */
export function attemptsAfterFailure(item, fullError) {
  if (!item || typeof item !== 'object') return 1;
  const lost = ATTACHMENT_LOST.test(fullError);
  const repeated = (item._fullError || item.error || '') !== '' &&
    (item._fullError || item.error) === fullError;
  return lost || repeated ? MAX_ATTEMPTS : (item.attempts || 0) + 1;
}

/** Record a failure and schedule the retry. Returns a NEW item. */
export function markFailed(item, error, now = Date.now()) {
  if (!item || typeof item !== 'object') return item;
  const full = String(error || 'Send failed');
  const message = full.slice(0, 200);
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
  /*
   * SAME-FAILURE SHORT-CIRCUIT. Compared on the FULL error string, not the
   * truncated one (bug-hunt 43 #3): two different long errors that happen to
   * share their first 200 characters are not the same diagnosis, and the
   * stored copy is truncated for display, not for identity. The rule lives
   * in attemptsAfterFailure, shared with the worker and the harnesses.
   */
  attempts = attemptsAfterFailure(item, full);
  const wait = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
  return {
    ...item,
    state: 'failed',
    attempts,
    nextAttempt: now + wait,
    error: message,
    // Identity copy, trimmed from the persisted blob by normaliseOutbox; the
    // comparison above needs the untruncated string.
    _fullError: full,
  };
}

/** Has this message given up retrying and started waiting for the user? */
export function markUncertain(item, error) {
  const message = String(error?.message || error || 'Delivery status is unknown').slice(0, 200);
  return {
    ...item,
    state: 'uncertain',
    nextAttempt: 0,
    error: message,
  };
}

export function isStuck(item) {
  if (!item || typeof item !== 'object') return false;
  return item.state === 'uncertain' ||
    (item.state === 'failed' && item.attempts >= MAX_ATTEMPTS);
}

/**
 * A human status line for the outbox row.
 *
 * Kept here so the phrasing is testable, and so the row and any notification
 * cannot drift.
 */
export function statusOf(item, now = Date.now()) {
  if (!item || typeof item !== 'object') return 'unknown';
  if (item.state === 'held') {
    const left = Math.max(0, Math.ceil((item.releaseAt - now) / 1000));
    return left > 0 ? `Sending in ${left}s` : 'Sending…';
  }
  if (item.state === 'sending') return 'Sending…';
  if (item.state === 'uncertain') {
    return 'Delivery status unknown — check Sent before retrying';
  }
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
 * IDS WE KNOW GMAIL ACCEPTED, WHOSE REMOVAL MAY NOT HAVE PERSISTED.
 *
 * ============ THE WORST BUG IN THIS FILE (round 12, P0-1) ============
 *
 * `flushOutbox` did: send -> remove from queue -> save queue. `saveOutbox`
 * catches storage errors and returns `false`, and the caller ignored that
 * return. So with storage failing to WRITE:
 *
 *     queue before : 1
 *     Gmail send   : SUCCESS
 *     save queue   : FAILED  (silently)
 *     flush result : sent = 1
 *     queue after  : 1        <- the item is still armed
 *
 * When storage recovered, the next pump saw a due item and SENT IT AGAIN.
 * Measured end to end: two Gmail deliveries for one user action. The
 * recipient gets the email twice.
 *
 * This is NOT the OUTCOME_UNKNOWN case, which exists for "we never learned
 * whether the send landed". Here we know perfectly well that it landed; it
 * is the LOCAL BOOKKEEPING that failed. Retrying a known success is the one
 * thing the pump must never do.
 *
 * The ledger is checked by `dispatchable`, so a stranded item cannot be
 * re-sent by this session no matter how many times the pump runs. It is
 * memory-only ON PURPOSE: persisting it needs the very storage that is
 * broken. Its lifetime therefore matches the tab, which is exactly the
 * window in which the phantom item can still be seen — the recovery write
 * below almost always succeeds long before then, and `normaliseOutbox`
 * already refuses to re-queue anything marked `sent` across a reload.
 */
const delivered = new Set();

/**
 * Record that Gmail has accepted this item, whatever storage then does.
 *
 * EXPORTED BECAUSE THERE ARE TWO PUMPS (round 13, W-1).
 *
 * The ledger above was added for the in-page fallback runner in
 * `flushOutbox`. The SERVICE WORKER has its own pump — `OUTBOX_PUMP` in
 * background/index.js — which reimplements the same send/remove/save
 * sequence and never touched the ledger. So the protection covered the
 * fallback path and left the NORMAL PRODUCTION PATH exposed.
 *
 * MEASURED against a replay of the worker's exact sequence, storage writes
 * failing:
 *
 *     pump 1 reports sent: 1   gmail calls: 1   queue still holds: 1
 *     pump 2 reports sent: 1   TOTAL GMAIL SENDS: 2   <- duplicate email
 *
 * Two functions doing one job is the actual defect; the duplicate send is
 * the symptom. `markDelivered`/`wasDelivered` are the seam both pumps share,
 * so a future third caller cannot miss it either.
 */
export function markDelivered(id) {
  if (id) delivered.add(id);
}

/** Has Gmail already accepted this item in this session? */
export function wasDelivered(id) {
  return delivered.has(id);
}

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
/*
 * THE TTL BOUNDS ONE DISPATCH, AND IS RENEWED PER DISPATCH (round 13, W-3).
 *
 * The old comment claimed this was "longer than the worst-case send (60s
 * budget + retries)". That is true of ONE send and false of a pump: the
 * worker batches up to MAX_PUMP_BATCH = 8 items, each with a 30s fetch
 * budget, so the worst case is 8 x 30s = 240s against a 180s TTL. A slow
 * batch therefore outlived its own lock, a second tab acquired it, and both
 * ran — which is precisely the state the lock exists to make impossible.
 *
 * The number is not the fix; renewal is. `renewPumpLock`/`renewClaim` below
 * re-stamp `at` before each item, so the TTL now bounds the gap between two
 * dispatches rather than the length of the whole run. A crashed tab still
 * releases within one TTL, which is the property that mattered.
 */
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

/*
 * ACQUISITION IS A RACE, SO OWNERSHIP IS VERIFIED, NOT ASSUMED (round 62,
 * roadmap M3 — reproduced: two tabs get-check-set concurrently, BOTH read
 * "no claim" before either writes, and the item double-sends). Storage
 * offers no compare-and-set, so the protocol is last-writer-wins with a
 * settle-and-verify: write a nonce, wait long enough for any concurrent
 * claimant's write to land, then re-read; ONLY the tab whose nonce is
 * stored may send. Two writes serialize through storage, so after the settle
 * exactly one nonce survives, and exactly one tab sees itself.
 */
const CLAIM_SETTLE_MS = 25;

/*
 * PUMP LOCK (round 62, M3 — the real fix for the reproduced race). Per-item
 * claims stop two tabs SENDING the same item, but both tabs still save their
 * own queue snapshot, and the last save resurrects the other tab's removals.
 * The queue has ONE writer per pump window instead: whoever acquires the
 * lock processes the whole queue; the other tab stands down entirely and
 * retries on its next re-arm. Same settle-and-verify protocol as the claim:
 * write a nonce, settle, and only the tab whose nonce survived owns the
 * window. The TTL is the crash backstop, exactly like item claims.
 */
const PUMP_LOCK_KEY = 'outboxPumpLock';
const PUMP_LOCK_TTL = CLAIM_TTL;
async function acquirePumpLock(storage, now, settleMs) {
  try {
    const got = (await storage.get(PUMP_LOCK_KEY)) || {};
    const lock = got[PUMP_LOCK_KEY];
    if (lock && lock.tab !== TAB_ID && now - lock.at < PUMP_LOCK_TTL) return false;
    const nonce = Math.random().toString(36).slice(2);
    await storage.set({ [PUMP_LOCK_KEY]: { tab: TAB_ID, at: now, nonce } });
    // Settle so a concurrent claimant's write lands, then verify ownership.
    // Single-tab callers (and tests) may pass 0; the cross-tab default is
    // CLAIM_SETTLE_MS.
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    const check = (await storage.get(PUMP_LOCK_KEY)) || {};
    return check[PUMP_LOCK_KEY]?.nonce === nonce;
  } catch {
    return true; // storage broken: fall back to per-tab behaviour
  }
}
/**
 * Re-stamp the pump lock so a long batch cannot outlive it (W-3).
 *
 * Only the owner may renew: if another tab has taken the lock (because we
 * genuinely did stall past the TTL), this reports false and the caller
 * stands down rather than continuing to dispatch under a lock it lost.
 */
async function renewPumpLock(storage, now) {
  try {
    const got = (await storage.get(PUMP_LOCK_KEY)) || {};
    const lock = got[PUMP_LOCK_KEY];
    if (lock && lock.tab !== TAB_ID) return false; // someone else owns it now
    await storage.set({ [PUMP_LOCK_KEY]: { ...(lock || {}), tab: TAB_ID, at: now } });
    return true;
  } catch {
    return true; // storage broken: fall back to per-tab behaviour
  }
}

/** Re-stamp one item's claim, for the same reason as the pump lock (W-3). */
async function renewClaim(storage, id, now) {
  try {
    const got = (await storage.get(CLAIM_KEY)) || {};
    const claims = got[CLAIM_KEY] || {};
    const mine = claims[id];
    if (mine && mine.tab !== TAB_ID) return false;
    claims[id] = { ...(mine || {}), tab: TAB_ID, at: now };
    await storage.set({ [CLAIM_KEY]: claims });
    return true;
  } catch {
    return true;
  }
}

async function releasePumpLock(storage) {
  try {
    const got = (await storage.get(PUMP_LOCK_KEY)) || {};
    if (got[PUMP_LOCK_KEY]?.tab === TAB_ID) {
      await storage.remove(PUMP_LOCK_KEY);
    }
  } catch { /* the TTL remains the backstop */ }
}

async function claim(storage, id, now) {
  try {
    const got = (await storage.get(CLAIM_KEY)) || {};
    const claims = got[CLAIM_KEY] || {};
    const c = claims[id];
    if (c && c.tab !== TAB_ID && now - c.at < CLAIM_TTL) return false;
    const nonce = Math.random().toString(36).slice(2);
    claims[id] = { tab: TAB_ID, at: now, nonce };
    await storage.set({ [CLAIM_KEY]: claims });
    // Settle so a concurrent claimant's write lands, then verify ownership.
    if (CLAIM_SETTLE_MS > 0) await new Promise((r) => setTimeout(r, CLAIM_SETTLE_MS));
    const check = (await storage.get(CLAIM_KEY)) || {};
    return check[CLAIM_KEY]?.[id]?.nonce === nonce;
  } catch {
    return true; // storage broken: fall back to per-tab behaviour
  }
}

export async function flushOutbox(/** @type {{send?:(item:any)=>Promise<any>, storage?:any, now?:number, onChange?:(items:any)=>void, settleMs?:number, accountEmail?:string}} */
  { send, storage = STORAGE, now = Date.now(), onChange, settleMs = CLAIM_SETTLE_MS, accountEmail } = {}) {
  /* The SAME owner gate the worker pump applies (AUD-C2): a stamped record
     sends only for its own account. The fallback is the wrong place to
     discover a cross-account send, not the right place to allow one. */
  let wrongAccount = 0;
  const blockedIds = [];
  /* Skipped because Gmail already has them (P0-1), not because of ownership. */
  const alreadyDelivered = [];
  if (inFlight) return { sent: 0, failed: 0, skipped: true };
  let items = await loadOutbox(storage);
  let due = prioritizeDue(dueItems(items, now));
  // An idle pump touches NOTHING: no lock, no writes.
  if (due.length === 0) return { sent: 0, failed: 0, skipped: false };
  // ONE writer per pump window across ALL tabs (round 62, M3). The loser
  // stands down and catches the queue on its next re-arm.
  if (!(await acquirePumpLock(storage, now, settleMs))) {
    return { sent: 0, failed: 0, skipped: true };
  }
  inFlight = true;
  try {
    // Re-read under the lock: another tab may have drained or changed the
    // queue while we were acquiring it.
    items = await loadOutbox(storage);
    due = prioritizeDue(dueItems(items, now));
    if (due.length === 0) return { sent: 0, failed: 0, skipped: false };

    let sent = 0;
    let failed = 0;
    // The ids of what actually left, for the activity log (bug-hunt #27).
    // `send` returns the wire response when it can; the fallback path has
    // no Gmail id to offer and pushes the queue id instead -- something is
    // better than the empty array this used to record.
    const sentIds = [];
    /* Ids that Gmail accepted but whose removal could not be persisted
       (P0-1). Reported so the caller can warn rather than claim success. */
    const unreconciled = [];

    for (const item of due) {
      /*
       * TWO REASONS TO SKIP, AND THEY ARE NOT THE SAME (P0-1).
       *
       * `delivered` means WE ALREADY SENT THIS and failed to record it;
       * reporting that as `wrongAccount` would tell the user their mail is
       * queued for another account when it has in fact gone. Checked first
       * and counted separately.
       */
      if (delivered.has(item.id)) {
        alreadyDelivered.push(item.id);
        continue;
      }
      if (!dispatchable(item, accountEmail)) {
        // Not ours to send; it stays armed for its owner (AUD-C2).
        wrongAccount++;
        blockedIds.push(item.id);
        continue;
      }
      // Claim it before awaiting, so a concurrent load cannot pick it up.
      dispatching.add(item.id);
      if (!(await claim(storage, item.id, now))) {
        dispatching.delete(item.id); // denied claims must not leak (V2 P1-9)
        continue; // another tab owns it
      }
      /* W-3: re-stamp before every dispatch, so the TTL bounds the gap
         between two sends rather than the length of the whole batch. Losing
         the lock here means another tab legitimately took over. */
      if (!(await renewPumpLock(storage, Date.now()))) {
        dispatching.delete(item.id);
        break;
      }
      await renewClaim(storage, item.id, Date.now());
      items = items.map((x) => (x.id === item.id ? { ...x, state: 'sending' } : x));
      await saveOutbox(items, storage);
      onChange?.(items);

      try {
        const res = await send(item.draft);
        // NAMESPACED (PumpResult contract): Gmail id when the wire gave one,
        // queue id otherwise -- never a bare value from mixed spaces.
        sentIds.push(res?.id ? `g:${res.id}` : `q:${item.id}`);
        items = items.filter((x) => x.id !== item.id);
        /*
         * REMOVAL MUST SURVIVE THE OTHER TAB'S SAVES (round 62, M3 — the
         * second reproduced race: two tabs each save their own snapshot, the
         * last save wins, and the first tab's removal is lost — a sent item
         * reappears in the queue and double-sends on the next pump). The
         * item is under OUR claim, so no other tab will SEND it; the only
         * hazard is a lost removal, so remove by read-modify-write and
         * verify, retrying while it keeps reappearing.
         */
        /* P0-1: RECORD THE DELIVERY BEFORE ATTEMPTING TO PERSIST IT.
           Gmail has accepted this message. From this instant the only
           correct behaviour is "never send it again", and that must hold
           even if every storage call below throws. */
        delivered.add(item.id);

        let removalPersisted = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          const fresh = await readOutbox(storage);
          if (fresh.ok === false && fresh.reason === 'unavailable') break; // cannot verify; ledger holds
          if (!fresh.value.some((x) => x.id === item.id)) { removalPersisted = true; break; }
          const res = await mutateOutbox((cur) => cur.filter((x) => x.id !== item.id), storage);
          if (res.ok) { removalPersisted = true; break; }
        }
        if (!removalPersisted) {
          /*
           * The message WENT and we could not write that fact down. Silence
           * here is what produced the duplicate. The item is marked so the
           * UI can show it honestly, the id is counted, and the ledger above
           * guarantees this session will not re-send it.
           */
          unreconciled.push(item.id);
          items = items.map((x) =>
            x.id === item.id
              ? { ...x, state: 'uncertain', error: 'Sent, but this device could not record it. It will not be sent again.' }
              : x);
        }
        await releaseClaim(storage, item.id);
        sent++;
      } catch (err) {
        items = items.map((x) => {
          if (x.id !== item.id) return x;
          return err?.code === 'OUTCOME_UNKNOWN'
            ? markUncertain(x, err)
            : markFailed(x, err?.message || err, now);
        });
        failed++;
      } finally {
        dispatching.delete(item.id);
      }
      await saveOutbox(items, storage);
      onChange?.(items);
    }

    /*
     * CLAIM GARBAGE COLLECTION (bug-hunt 43 #18). releaseClaim runs on the
     * success path only; ids that left the queue by any OTHER route (cancel,
     * a crash before release) used to linger in the claims map forever. The
     * TTL gates freshness, but nothing removed the corpses -- so sweep any
     * claim whose item is no longer queued.
     */
    try {
      const got = (await storage.get(CLAIM_KEY)) || {};
      const claims = got[CLAIM_KEY] || {};
      const alive = new Set(items.map((x) => x.id));
      let changed = false;
      for (const id of Object.keys(claims)) {
        if (!alive.has(id)) { delete claims[id]; changed = true; }
      }
      if (changed) await storage.set({ [CLAIM_KEY]: claims });
    } catch { /* the TTL remains the backstop */ }

    return { sent, failed, skipped: false, sentIds,
           ...(unreconciled.length ? { unreconciled } : {}),
           ...(alreadyDelivered.length ? { alreadyDelivered } : {}),
           ...(wrongAccount ? { wrongAccount, blockedIds } : {}) };
  } finally {
    inFlight = false;
    // Release the pump lock on EVERY exit path that acquired it (the early
    // returns inside the try also pass through here). The TTL is only the
    // crash backstop, not the normal path.
    await releasePumpLock(storage);
  }
}

/** Remove one item -- the undo path, and the "cancel" button on a stuck item. */
export async function cancel(id, storage = STORAGE) {
  /* P0-2: a failed read must not become "the queue is empty, so there is
     nothing to cancel" — and more importantly must not lead to a write. */
  const got = await readOutbox(storage);
  if (got.ok === false && got.reason === 'unavailable') return null;
  const items = got.value;
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
  /* Re-read under mutate so a concurrent pump's write is not clobbered. */
  const res = await mutateOutbox((cur) => cur.filter((x) => x.id !== id), storage);
  if (!res.ok) return null;
  return item;
}

/** Retry a stuck item now, resetting its backoff. */
export async function retryNow(id, storage = STORAGE, now = Date.now()) {
  /*
   * P0-2, THE MEASURED ONE. This function read the queue, mapped over it and
   * wrote the result. With the read failing it mapped over `[]` and wrote
   * `[]`, destroying five queued messages. It now refuses to write at all
   * when the base is unknown, and reports null so the UI can say so.
   */
  const res = await mutateOutbox((items) => items.map((x) =>
    // The stale error goes with the old attempts (bug-hunt 43 #4): keeping
    // it made an identical retry failure read as "the same failure twice",
    // short-circuiting straight back to stuck and showing "attempt 4 of 4"
    // after the user pressed Retry once. A retry is a fresh judgement.
    x.id === id
      ? { ...x, state: 'failed', attempts: 0, nextAttempt: now, error: '', _fullError: '' }
      : x
  ), storage);
  if (!res.ok) return null;
  return res.value.find((x) => x.id === id) || null;
}

/** Test seam. Module state outlives a jsdom boot. */
export function _resetOutbox() {
  inFlight = false;
  dispatching.clear();
  /* `delivered` is module state that outlives a jsdom boot, exactly like
     `dispatching`. Leaving it populated would make a LATER test's send be
     skipped as an already-delivered duplicate — a cross-test leak, and a
     nasty one because it manifests as an unrelated suite going flaky. */
  delivered.clear();
}

/** Is this item on the wire right now? For the UI's disabled state. */
export function isDispatching(id) {
  return dispatching.has(id);
}
