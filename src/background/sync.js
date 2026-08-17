/**
 * Sync orchestration.
 *
 * DESIGN: THE WORKER PULLS, THE APP DECIDES WHEN
 * ----------------------------------------------
 * The old version pushed: a background loop streamed messages into the store
 * as they arrived and every arrival re-rendered. The audit's own verdict was
 * that this was the main source of the lag.
 *
 * Here the app asks for one page at a time (`syncPage`). One page = one list
 * call + one batch call = exactly two HTTP round trips for 100 messages, and
 * on the app side exactly ONE store batch and therefore ONE render.
 *
 * The worker keeps no message state. MV3 kills the worker whenever it likes;
 * anything cached in a module variable here would be a heisenbug. The only
 * persisted thing is `historyId`, and that lives in chrome.storage.
 */

import { listIds, batchMetadata, history, profile, BATCH_SIZE } from './gmail.js';
/* Counters for the failure classes that leave a user in a wrong state
   (audit R3-10). diag.js is pure module state: no chrome.* touch here. */
import { bump } from './diag.js';

const HISTORY_KEY = 'historyId';

export async function getHistoryId() {
  const { [HISTORY_KEY]: id } = await chrome.storage.local.get(HISTORY_KEY);
  return id || null;
}

export async function setHistoryId(id) {
  if (id) await chrome.storage.local.set({ [HISTORY_KEY]: String(id) });
}

/**
 * Commit a cursor only after the caller has durably applied its corresponding
 * snapshot/delta. Numeric Gmail history IDs are monotonic; a late commit from
 * an older concurrent prepare must not move the shared cursor backwards.
 */
/**
 * Advance the shared history cursor, never backwards.
 *
 * WHAT THE COMPARE-AND-SET REALLY BUYS (round 12, P1-9)
 * -----------------------------------------------------
 * The previous implementation read, compared, and wrote across two awaits,
 * with a comment claiming "a late commit from an older concurrent prepare
 * must not move the shared cursor backwards". It does not hold under real
 * concurrency, because both readers can observe the old value before either
 * writes:
 *
 *     tab A reads 100      tab B reads 100
 *     A wants 200          B wants 150
 *     A writes 200
 *                          B writes 150      <- cursor regressed
 *
 * chrome.storage.local offers no compare-and-swap and no transaction, so a
 * genuinely atomic commit is not available. Pretending otherwise in a comment
 * is what let this sit: the claimed invariant was simply not enforced.
 *
 * What IS achievable, and what this now does:
 *
 *   1. RE-READ AND RE-CHECK AFTER THE WRITE. The regression window shrinks to
 *      the storage round trip, and — crucially — a regression that does occur
 *      is DETECTED and repaired rather than left in place.
 *   2. A MONOTONIC IN-PROCESS FLOOR. Within one worker, this function can
 *      never be talked backwards, whatever storage reports. Most concurrency
 *      here is same-process (overlapping syncs), so this covers the common
 *      case completely.
 *
 * The residual cross-process race is bounded and SAFE BY DESIGN: a cursor
 * that regresses causes the next delta to replay changes we already applied,
 * and `upsert` is idempotent. Stale costs a little duplicate work; too-new
 * loses mail irrecoverably. This function only ever errs toward stale.
 */
let cursorFloor = 0n;

export async function commitHistoryId(id) {
  const next = String(id || '');
  if (!next) return null;
  if (!/^\d+$/.test(next)) return getHistoryId();

  const wanted = BigInt(next);
  // The in-process floor: nothing may drag the cursor below what this worker
  // has already committed, regardless of what a concurrent reader saw.
  if (wanted < cursorFloor) return String(cursorFloor);

  const current = await getHistoryId();
  if (/^\d+$/.test(current || '') && BigInt(current) > wanted) {
    cursorFloor = BigInt(current);
    return current;
  }

  /*
   * RE-CHECK THE FLOOR IMMEDIATELY BEFORE WRITING.
   *
   * Checking it once at entry is not enough, and a concurrency test caught
   * this: `await getHistoryId()` is a suspension point, so a commit that
   * entered with a valid `wanted` can be parked there while a HIGHER commit
   * completes end to end. When the stale one resumes, its entry check is
   * long stale and it writes the lower value — the cursor regresses exactly
   * as it did before any of this was added.
   *
   * The floor is raised synchronously by whoever wins, so re-reading it here
   * (no await in between) is what actually enforces monotonicity within the
   * worker.
   */
  if (wanted < cursorFloor) return String(cursorFloor);

  await setHistoryId(next);
  if (wanted > cursorFloor) cursorFloor = wanted;

  /*
   * VERIFY. If a concurrent writer landed between our read and our write and
   * left a HIGHER value, ours has just regressed the cursor — put theirs
   * back. This cannot close the window, but it repairs the outcome, which the
   * original could not do because it never looked again.
   */
  const after = await getHistoryId();
  if (/^\d+$/.test(after || '') && BigInt(after) < wanted) {
    // Our own value did not stick (someone wrote an older one after us).
    await setHistoryId(next);
    return next;
  }
  if (/^\d+$/.test(after || '') && BigInt(after) > wanted) {
    cursorFloor = BigInt(after);
    return after;
  }
  return next;
}

/** Test seam: the in-process floor outlives a module import. */
export function _resetCursorFloor() {
  cursorFloor = 0n;
}

/**
 * One page of the inbox, fully hydrated.
 *
 * @param {{pageToken?:string, max?:number, q?:string, labelIds?:string[], anchorHistory?:boolean}} opts
 * @returns {Promise<{messages:object[], nextPageToken:string, anchorHistoryId:string|null}>}
 */
export async function syncPage({ pageToken = '', max = BATCH_SIZE, q = '', labelIds, anchorHistory = true } = {}) {
  // Read the cursor BEFORE listing, on the first page of a fresh sync.
  //
  // This used to be read AFTER the messages were fetched, which loses mail:
  //
  //   t0  listIds()        -> the inbox as it is now
  //   t1  batchMetadata()  -> hydrate exactly those ids
  //   t2  profile()        -> historyId as of t2
  //
  // Anything that arrived between t0 and t2 is absent from our list, yet the
  // stored cursor already covers it, so the next delta reports no change for
  // it. That message stays invisible until the cursor expires, about a week.
  //
  // Taking the cursor first inverts the failure: it can only be slightly
  // STALE, so the next delta replays a handful of changes we already have.
  // `upsert` is idempotent, so a replay costs nothing. Stale loses nothing;
  // too-new loses mail irrecoverably.
  /*
   * ONLY THE INBOX MOVES THE CURSOR.
   *
   * The historyId is a single account-wide cursor that the inbox's delta sync
   * depends on. Loading a page of Sent or Trash would otherwise advance it
   * past inbox changes that were never fetched, and those changes are then
   * unrecoverable -- exactly the bug fixed above, reintroduced through a
   * different door. Non-inbox mailboxes pass `anchorHistory: false`.
   */
  let anchor = null;
  if (anchorHistory && !pageToken) {
    try {
      anchor = (await profile()).historyId;
    } catch {
      /* a missing cursor only costs a full resync later */
    }
  }

  const { ids, nextPageToken } = await listIds({
    pageToken,
    max: Math.min(max, BATCH_SIZE),
    q,
    labelIds: labelIds || (q ? [] : ['INBOX']),
  });
  if (ids.length === 0) {
    return { messages: [], nextPageToken: '', anchorHistoryId: anchor || null };
  }

  const messages = await batchMetadata(ids);
  /*
   * The same shortfall law as syncDelta (R3-03). A page whose batch lost
   * sub-requests must not hand back an anchor: the app commits that anchor
   * as the delta cursor, which would declare "everything up to here is
   * known" about messages that were never fetched. Dropping the anchor
   * costs at most one extra full page next time; keeping it costs mail.
   */
  const missing = messages.missingIds || [];
  return {
    messages,
    nextPageToken,
    ...(missing.length ? { incomplete: true, missingIds: missing } : {}),
    anchorHistoryId: missing.length ? null : (anchor || null),
  };
}

/**
 * Delta sync since the stored cursor.
 *
 * Returns one of:
 *   { kind: 'delta', added:[msg], removed:[id], patched:[{id,unread,starred}] }
 *   { kind: 'resync' }   -- cursor expired, caller must do a full syncPage run
 *   { kind: 'none' }     -- no cursor yet
 */
/**
 * Beyond this many new messages in one delta, a full resync is both cheaper
 * and safer than a very long chain of batch requests.
 */
const MAX_DELTA_ADDS = 500;

export async function syncDelta() {
  const start = await getHistoryId();
  if (!start) return { kind: 'none' };

  const res = await history(start);
  if (res.tooOld) {
    await chrome.storage.local.remove(HISTORY_KEY);
    bump('resyncs');
    // `exhausted` distinguishes "too much changed" from "cursor expired"
    // (R3-07). Both resync; only one means the user was away.
    return { kind: 'resync', ...(res.exhausted ? { exhausted: true } : {}) };
  }

  const { addIds, removeIds, patched } = reduceHistory(res.changes);

  if (addIds.length > MAX_DELTA_ADDS) {
    // Do NOT advance the cursor: the resync is what will cover these.
    bump('resyncs');
    return { kind: 'resync' };
  }

  // Chunked, not truncated. BATCH_SIZE is Gmail's cap on one /batch request,
  // not a cap on how much mail can arrive between two syncs.
  const added = [];
  /*
   * A SHORT BATCH MUST NOT MOVE THE CURSOR (audit R3-03, HIGH).
   *
   * batchMetadata drops sub-requests that failed (a 500 on 40 of 100 ids is
   * routine under load and arrives inside a 200 OK envelope, so the
   * whole-request retry never sees it). Advancing historyId past ids we
   * never fetched loses that mail until the cursor expires.
   *
   * One retry for the stragglers -- the failure is usually transient and a
   * second attempt is far cheaper than the full resync the alternative
   * forces. Anything still missing withholds nextHistoryId, so the SAME
   * delta replays on the next refresh. Replay is free: upsert is idempotent
   * and reduceHistory is a fold over final state, both by construction.
   */
  const missing = [];
  for (let i = 0; i < addIds.length; i += BATCH_SIZE) {
    const chunk = addIds.slice(i, i + BATCH_SIZE);
    const got = await batchMetadata(chunk);
    added.push(...got);
    if (got.missingIds?.length) missing.push(...got.missingIds);
  }

  if (missing.length) {
    const retried = [];
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      try {
        const got = await batchMetadata(missing.slice(i, i + BATCH_SIZE));
        added.push(...got);
        if (got.missingIds?.length) retried.push(...got.missingIds);
      } catch {
        // The whole retry chunk is unavailable. Treat every id in it as
        // still missing: the cursor stays put and the next delta replays.
        retried.push(...missing.slice(i, i + BATCH_SIZE));
      }
    }
    missing.length = 0;
    missing.push(...retried);
    if (missing.length) bump('cursorWithheld');
  }

  // PREPARE only. Fetching every change is necessary but not sufficient for a
  // commit: the app still has to apply and persist this delta. The caller sends
  // SYNC_COMMIT with nextHistoryId only after that durable boundary.
  return {
    kind: 'delta', added, removed: removeIds, patched,
    // Withheld on a shortfall: the app applies what arrived (upsert is
    // idempotent) but the cursor does not move, so nothing is skipped.
    ...(missing.length ? { incomplete: true, missingIds: missing } : {}),
    nextHistoryId: missing.length ? '' : (res.historyId || start),
  };
}

/**
 * Fold a list of history records into a final state per message.
 *
 * WHY A SINGLE ORDERED MAP AND NOT TWO SETS
 * -----------------------------------------
 * History records are chronological and one message can appear in many of
 * them: arrive, get starred, get archived, get un-archived. The first version
 * of this function accumulated an `added` set and a `removed` set
 * independently, which meant a message that was archived and then un-archived
 * ended up in BOTH, and the caller's apply order silently decided whether the
 * message survived.
 *
 * What the API actually gives us is a sequence of events. Only the last event
 * per message matters. Writing them into one map in order makes that true by
 * construction, and guarantees the returned `added` and `removed` are
 * disjoint -- so the caller cannot get it wrong either.
 *
 * Exported for testing; this is the part with all the ordering subtlety.
 */
export function reduceHistory(records) {
  if (!Array.isArray(records)) return { addIds: [], removeIds: [], patched: [] };
  /** @type {Map<string, 'add'|'remove'>} id -> final presence in our inbox */
  const fate = new Map();
  /** @type {Map<string, {id:string, unread?:boolean, starred?:boolean}>} */
  const patches = new Map();

  const patchFor = (id) => {
    let p = patches.get(id);
    if (!p) patches.set(id, (p = { id }));
    return p;
  };

  for (const h of records || []) {
    for (const { message } of h.messagesAdded || []) {
      // A brand-new message. Only interesting if it landed in the inbox.
      if ((message.labelIds || []).includes('INBOX')) fate.set(message.id, 'add');
    }

    for (const { message } of h.messagesDeleted || []) {
      fate.set(message.id, 'remove');
    }

    for (const { message, labelIds } of h.labelsAdded || []) {
      const ls = labelIds || [];
      if (ls.includes('UNREAD')) patchFor(message.id).unread = true;
      if (ls.includes('STARRED')) patchFor(message.id).starred = true;
      // Gaining INBOX means un-archived, or a thread pulled back by a reply.
      // This never produces a messagesAdded record -- that fires only when a
      // message first enters the mailbox -- so if we ignore it here the message
      // stays invisible until the next full resync.
      if (ls.includes('INBOX')) fate.set(message.id, 'add');
      if (ls.includes('TRASH') || ls.includes('SPAM')) fate.set(message.id, 'remove');
    }

    for (const { message, labelIds } of h.labelsRemoved || []) {
      const ls = labelIds || [];
      if (ls.includes('UNREAD')) patchFor(message.id).unread = false;
      if (ls.includes('STARRED')) patchFor(message.id).starred = false;
      // Losing INBOX is an archive.
      if (ls.includes('INBOX')) fate.set(message.id, 'remove');
    }
  }

  const addIds = [];
  const removeIds = [];
  for (const [id, what] of fate) (what === 'add' ? addIds : removeIds).push(id);

  // A message we are about to fetch fresh does not need a patch -- the fetched
  // metadata is newer. A message we are about to remove cannot use one.
  const skip = new Set([...addIds, ...removeIds]);
  const patched = [];
  for (const p of patches.values()) {
    if (skip.has(p.id)) continue;
    if ('unread' in p || 'starred' in p) patched.push(p);
  }

  return { addIds, removeIds, patched };
}
