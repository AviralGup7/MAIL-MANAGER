/**
 * Verb intents — triage that survives a dead network (G3, 2026-08-14).
 *
 * WHY THIS EXISTS
 * ---------------
 * M1's body floor made READING local-first. Triage still evaporated: an
 * archive pressed on dead wifi rolled the row back and offered Retry —
 * correct data discipline, wrong product shape. The user SAID what they
 * wanted; the app declining to remember it is the app teaching them not
 * to bother. An intent records the verb, applies it when the network
 * answers, and — the part that keeps it honest — says so at queue time
 * and gives the cancellation right there ("Undo" on the queue toast).
 *
 * THE DISCIPLINE IS BORROWED, NOT NEW
 * ------------------------------------
 * The outbox already proved the queue-shaped primitive (hold window,
 * sequential dispatch, attempts with give-up, activity provenance), and
 * the constraint ledger says the queue rides that pattern rather than
 * becoming a framework. So:
 *
 *   - ONE storage blob ("intents"), whole-written per change; the queue is
 *     tiny by design (a commute's worth of triage, not a warehouse).
 *   - Drain is SEQUENTIAL, re-reading live storage between items (the
 *     outbox's cancel-race lesson: two tabs, or a user flush racing a
 *     drain, must not double-apply or resurrect).
 *   - Attempts are recorded per intent; the give-up is honest (a toast
 *     and an activity line), never silent.
 *   - Scope is ONE verb (archive, single-message). `bulkAct`, the flag
 *     verbs and thread-spanning archives keep today's rollback+Retry —
 *     each joins the queue on the commit that carries its own tests,
 *     which is how the outbox itself grew.
 *
 * BOUNDARIES: the module owns queue persistence and drain mechanics. It
 * does NOT mutate the store or the DOM — the caller's closures do, which
 * is what lets the shell keep ownership of the optimistic state.
 */

import { STORAGE } from '../../platform/storage.js';

const KEY = 'intents';
const VERSION = 1;

/** Give-up count. Matches the outbox's finding: a verb that fails thrice
 *  against a LIVE network is telling you something real — stop replaying it. */
export const INTENT_MAX_ATTEMPTS = 3;

/** In-memory mirror for the session; storage is the truth that survives. */
let mem = null;
let priming = null;
let watching = false;

const isValidRow = (r) =>
  r && typeof r.id === 'string' && typeof r.verb === 'string' && typeof r.targetId === 'string';

/* Two tabs can both drain (the outbox's double-send was reproduced from a
   real duplicate — this class is taken seriously here). Storage is the
   shared truth, and onChanged fires in EVERY context including the
   writer's, so the mirror re-syncs from it. The residual race — two tabs
   in flight on the same head before either persists — degrades to a
   duplicate ARCHIVE verb, which Gmail answers idempotently; that is why
   the queue stays on idempotent verbs. */
function watchExternal() {
  if (watching) return;
  watching = true;
  const onChanged = globalThis.chrome?.storage?.onChanged;
  if (!onChanged?.addListener) return;
  onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    const blob = changes[KEY].newValue;
    mem = blob && blob.v === VERSION && Array.isArray(blob.q)
      ? blob.q.filter(isValidRow)
      : [];
  });
}

function prime(storage = STORAGE) {
  if (mem) return Promise.resolve();
  if (!priming) {
    priming = (async () => {
      mem = [];
      try {
        const got = await storage.get(KEY);
        const blob = got?.[KEY];
        if (blob && blob.v === VERSION && Array.isArray(blob.q)) {
          /* Malformed entries fall individually — one bad row must not
             strand the rest of the queue (the cache's row discipline). */
          mem = blob.q.filter(isValidRow);
        }
      } catch {
        /* an unreadable queue is an empty queue — never a launcher error */
      }
      watchExternal();
    })();
  }
  return priming.then(() => {});
}

async function persist(storage) {
  try {
    await storage.set({ [KEY]: { v: VERSION, q: mem } });
    return true;
  } catch {
    return false; // a queue write failure must not surface mid-triage
  }
}

/**
 * Queue one intent. `rec` = { id, verb, targetId, undoVerb? }.
 * Returns the stored record (with its queue id), or null if the intent
 * was malformed — a refusal the caller can fall back through.
 */
export async function enqueueIntent(rec, storage = STORAGE) {
  if (!rec || typeof rec.verb !== 'string' || typeof rec.targetId !== 'string') return null;
  await prime(storage);
  const stored = {
    id: `i${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    verb: rec.verb,
    targetId: rec.targetId,
    ...(rec.undoVerb ? { undoVerb: rec.undoVerb } : {}),
    createdAt: Date.now(),
    attempts: 0,
  };
  /*
   * THE SAME VERB ON THE SAME MESSAGE IS ONE INTENT (round 11, B8).
   *
   * Offline, a row does not visibly settle — nothing confirms — so a user
   * taps Archive again. Measured: three taps queued three records and the
   * drain replayed all three, sending `archive:m1` to Gmail three times.
   * Every extra call is a wasted round trip on a connection that just came
   * back, and for a NON-IDEMPOTENT verb it is a second real mutation.
   *
   * Superseding rather than appending also keeps the queue honest about
   * ORDER: archive-then-star-then-archive must still end archived, so the
   * duplicate moves to the back rather than the first occurrence winning.
   * The record keeps its original createdAt so the queue's age is truthful.
   */
  const dupIndex = mem.findIndex((r) => r.verb === stored.verb && r.targetId === stored.targetId);
  if (dupIndex !== -1) {
    stored.createdAt = mem[dupIndex].createdAt;
    mem.splice(dupIndex, 1);
  }
  mem.push(stored);
  await persist(storage);
  return stored;
}

/** Remove an intent by queue id — the queue toast's Undo. Returns true
 *  when something was actually cancelled (callers restore their snapshot
 *  only then). */
export async function cancelIntent(queueId, storage = STORAGE) {
  await prime(storage);
  const before = mem.length;
  mem = mem.filter((r) => r.id !== queueId);
  if (mem.length === before) return false;
  await persist(storage);
  return true;
}

/** How many intents sit queued (badge copy, drain decisions). */
export async function queuedIntentCount(storage = STORAGE) {
  await prime(storage);
  return mem.length;
}

/**
 * Apply what was queued, oldest first, against a live network.
 *
 * @param {{send:(verb:string, extra:Object)=>Promise<any>,
 *          onApplied?:(rec:Object)=>void, onGiveUp?:(rec:Object, err:any)=>void}} io
 * @returns {Promise<{applied:number, gaveUp:number, remaining:number}>}
 *
 * One failure pauses the drain in place: a live network that just refused
 * a verb is likelier to refuse the next, and the queue is patient by
 * design. The attempt count persists either way, so a permanently-poison
 * intent gives up after INTENT_MAX_ATTEMPTS distinct drains — never in a
 * hot loop.
 */
export async function drainIntents(io, storage = STORAGE) {
  await prime(storage);
  const out = { applied: 0, gaveUp: 0, remaining: mem.length };
  while (mem.length) {
    const rec = mem[0];
    try {
      await io.send(rec.verb, { id: rec.targetId });
    } catch (err) {
      rec.attempts = (rec.attempts || 0) + 1;
      if (rec.attempts >= INTENT_MAX_ATTEMPTS) {
        mem.shift();
        if (io.onGiveUp) io.onGiveUp(rec, err);
        out.gaveUp++;
      }
      await persist(storage);
      break; // pause; the next online event resumes
    }
    /* Re-check the head belongs to US before shifting (the outbox's
       cancel-race lesson): the onChanged mirror means an external drain
       has replaced the head — compare by id, because the mirror rewrites
       the array identity even when content is unchanged. */
    if (mem[0]?.id !== rec.id) continue;
    mem.shift();
    await persist(storage);
    if (io.onApplied) io.onApplied(rec);
    out.applied++;
  }
  out.remaining = mem.length;
  return out;
}

/** Forget the queue — sign-out scopes it to the account (same reasoning
 *  as the body floor: the ACCOUNT leaves, nothing of its pending verbs
 *  may stay armed). */
export async function clearIntents(storage = STORAGE) {
  mem = [];
  try {
    await storage.remove(KEY);
  } catch {
    /* nothing to do */
  }
}

/** Test hook: return to first-prime state. */
export function _reset() {
  mem = null;
  priming = null;
  watching = false;
}
