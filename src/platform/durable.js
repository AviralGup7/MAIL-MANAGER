/**
 * Durable reads and writes for AUTHORITATIVE user state.
 *
 * ============================================================================
 * THE BUG CLASS THIS EXISTS TO KILL
 * ============================================================================
 *
 * Every persistent store in this project was written the same way:
 *
 *     export async function loadThing(storage = STORAGE) {
 *       try {
 *         const got = (await storage.get(KEY)) || {};
 *         return normalise(got[KEY]);
 *       } catch {
 *         return [];          // <- HERE
 *       }
 *     }
 *
 * That `catch { return [] }` makes "storage did not answer" INDISTINGUISHABLE
 * from "the user has nothing saved". For a CACHE that is correct and even
 * desirable: a cache miss and a cache failure both mean "go and fetch it".
 *
 * For state the user OWNS it is destructive, because the very next thing a
 * mutator does is read-modify-write:
 *
 *     const all = await loadThing();   // [] because storage blipped
 *     all.push(newItem);               // now [newItem]
 *     await saveThing(all);            // 5 real records OVERWRITTEN
 *
 * MEASURED, against the real modules, before this file existed:
 *
 *   outbox   retryNow() with a failing read:  5 queued messages -> 0
 *   snooze   addSnooze() with a failing read: {m-a, m-b} -> {m-c}
 *
 * Both are permanent loss of something the user asked for. In the outbox's
 * case it is unsent mail.
 *
 * ============================================================================
 * THE THREE-STATE READ
 * ============================================================================
 *
 * A read now answers one of three things, and the caller cannot ignore the
 * difference because the value is not returned bare:
 *
 *   { ok: true,  value }              storage answered; this is the truth
 *   { ok: false, reason: 'unavailable' }   storage threw; WE DO NOT KNOW
 *   { ok: false, reason: 'corrupt' }       storage answered with junk
 *
 * `mutate()` below is the important half: it refuses to write when the read
 * did not succeed. A mutation is a read-modify-write, and a modify built on
 * an unknown base is how the two bugs above deleted real data.
 *
 * 'corrupt' is deliberately distinct from 'unavailable'. A corrupt blob is a
 * PERMANENT condition — retrying reads it again forever — so a mutation is
 * allowed to proceed from the normalised (usually empty) value, which is what
 * lets a user recover a store that a previous version wrote badly. An
 * unavailable one is TRANSIENT and must never be written over.
 *
 * ============================================================================
 * WHAT THIS IS NOT
 * ============================================================================
 *
 * Not a transaction manager and not a lock. chrome.storage offers neither, and
 * pretending otherwise in a helper would be worse than the honest gap. Cross-
 * tab serialisation is the outbox pump lock's job. This module solves exactly
 * one problem: never write on top of a base you failed to read.
 */

import { STORAGE } from './storage.js';

/**
 * @template T
 * @typedef {{ok:true, value:T, present:boolean}
 *         | {ok:false, reason:'unavailable'|'corrupt', error?:string, value:T}} DurableRead
 */

/**
 * Read one key, distinguishing "empty" from "unavailable".
 *
 * @template T
 * @param {string} key
 * @param {{storage?:any, normalise?:(raw:any)=>T, empty:T, isValid?:(raw:any)=>boolean}} opts
 * @returns {Promise<DurableRead<T>>}
 */
export async function read(key, { storage = STORAGE, normalise = (x) => x, empty, isValid } = {}) {
  let got;
  try {
    got = await storage.get(key);
  } catch (err) {
    /* THE WHOLE POINT. The caller gets `empty` as a rendering convenience —
       a list UI still has something to draw — but `ok:false` means no
       mutation may be built on it. */
    return { ok: false, reason: 'unavailable', error: String(err?.message || err), value: empty };
  }

  const raw = (got || {})[key];
  if (raw === undefined || raw === null) {
    // Storage answered, and the answer is "nothing here". That is a FACT,
    // and mutating from it is correct.
    return { ok: true, value: normalise(empty), present: false };
  }

  if (isValid && !isValid(raw)) {
    // Storage answered with something we cannot interpret. Permanent, so the
    // caller is allowed to overwrite it — see the header.
    return { ok: false, reason: 'corrupt', value: normalise(empty) };
  }

  return { ok: true, value: normalise(raw), present: true };
}

/**
 * Read-modify-write that REFUSES to write on an unreadable base.
 *
 * This is the function that actually prevents the data loss; `read` only
 * reports. Every authoritative mutator should go through here rather than
 * pairing a bare load with a bare save.
 *
 * @template T
 * @param {string} key
 * @param {(current:T) => T} change
 * @param {{storage?:any, normalise?:(raw:any)=>T, empty:T, isValid?:(raw:any)=>boolean}} opts
 * @returns {Promise<{ok:true, value:T} | {ok:false, reason:'unavailable'|'corrupt'|'write-failed', error?:string}>}
 */
export async function mutate(key, change, { storage = STORAGE, normalise = (x) => x, empty, isValid } = {}) {
  const got = await read(key, { storage, normalise, empty, isValid });

  if (!got.ok && got.reason === 'unavailable') {
    /*
     * THE REFUSAL. Writing here is precisely the bug: the base is unknown, so
     * the result of `change(base)` would silently discard whatever is really
     * stored. The caller must surface this; it must not be swallowed.
     */
    return { ok: false, reason: 'unavailable', error: got.error };
  }

  const next = change(got.value);
  try {
    await storage.set({ [key]: next });
  } catch (err) {
    // The change is REAL but not durable. Distinct from 'unavailable',
    // because the caller may have already performed a matching external
    // effect (an outbox send) and needs to know the local record of it is
    // missing rather than assume the whole operation failed.
    return { ok: false, reason: 'write-failed', error: String(err?.message || err) };
  }
  return { ok: true, value: next };
}

/**
 * Write a value, reporting failure rather than swallowing it.
 *
 * @returns {Promise<{ok:true} | {ok:false, error:string}>}
 */
export async function write(key, value, { storage = STORAGE } = {}) {
  try {
    await storage.set({ [key]: value });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
