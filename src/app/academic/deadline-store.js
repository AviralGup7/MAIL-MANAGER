import { STORAGE } from '../../platform/storage.js';

/**
 * Deadline overrides: corrections and manual entries.  (Features 60 and 61.)
 *
 * WHY CORRECTION IS MANDATORY RATHER THAN NICE
 * --------------------------------------------
 * `extractDeadline()` reads dates out of prose. It will be wrong sometimes --
 * not occasionally, but routinely, because institutional mail says things like
 * "submit by Friday" without a date, quotes last year's deadline in a
 * forwarded thread, and mentions three dates of which one is the deadline.
 *
 * A silently wrong entry in the radar is worse than an empty radar. The user
 * cannot tell which entries to trust, so they stop reading the panel, and the
 * panel is the product's flagship academic surface. Correction is the only
 * mechanism that keeps it trustworthy, and it is also the only mechanism that
 * produces a labelled corpus for improving the extractor.
 *
 * WHY MANUAL ENTRY BELONGS IN THE SAME MODULE
 * A correction and a manual deadline are the same record with a different
 * origin: both say "the deadline for this message is X, whatever the parser
 * thinks". Splitting them would mean two stores, two lookups on the render
 * path, and a merge rule to get wrong.
 *
 * THE PRECEDENCE RULE, STATED ONCE
 *
 *   user override  >  extracted  >  nothing
 *
 * A dismissal is an override with no date: it says "there is no deadline
 * here", which is a real and common correction and is NOT the same as having
 * no opinion.
 */

const KEY = 'deadlineOverrides';

/** Cap. Overrides are small, but the list should not grow forever. */
export const MAX_OVERRIDES = 500;

/**
 * @typedef {Object} Override
 * @property {string} messageId
 * @property {number|null} at      the corrected date, or null for "no deadline"
 * @property {'corrected'|'manual'|'dismissed'} origin
 * @property {number} setAt
 * @property {string} [note]
 * @property {string} [wasText]    what the extractor read, kept for the corpus
 * @property {number} [wasAt]      what the extractor decided, for the corpus
 */

/** Coerce storage into a usable map. Never throws. */
export function normaliseOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  let n = 0;
  for (const [id, v] of Object.entries(raw)) {
    if (n >= MAX_OVERRIDES) break;
    if (typeof id !== 'string' || !id) continue;
    if (!v || typeof v !== 'object') continue;
    const at = v.at === null ? null : Number.isFinite(v.at) ? v.at : undefined;
    if (at === undefined) continue;
    const origin = ['corrected', 'manual', 'dismissed'].includes(v.origin) ? v.origin : 'manual';
    /*
     * defineProperty, never `out[id] = ...` (fuzz round 3, 2026-08-14,
     * defect #10b): an id of '__proto__' hits the prototype SETTER, and
     * because the value here is an OBJECT the assignment SUCCEEDS -- the
     * map's prototype is replaced with the override record itself (the
     * entry is simultaneously lost AND every subsequent miss reads
     * through to the override's fields, e.g. map2['at'] would return the
     * poisoned timestamp). 'deadlineOverrides' is backup:true, so this is
     * backup-import reachable.
     */
    Object.defineProperty(out, id, {
      value: {
        messageId: id,
        at,
        origin,
        setAt: Number.isFinite(v.setAt) ? v.setAt : 0,
        ...(typeof v.note === 'string' && v.note ? { note: v.note.slice(0, 200) } : {}),
        ...(typeof v.wasText === 'string' ? { wasText: v.wasText.slice(0, 200) } : {}),
        ...(Number.isFinite(v.wasAt) ? { wasAt: v.wasAt } : {}),
      },
      writable: true, enumerable: true, configurable: true,
    });
    n++;
  }
  return out;
}

export async function loadOverrides(storage = STORAGE) {
  // Stash as the session canonical; dueAtOfNow serves every reader.
  try {
    const got = (await storage.get(KEY)) || {};
    currentOverrides = normaliseOverrides(got[KEY]);
    return currentOverrides;
  } catch {
    currentOverrides = {};
    return currentOverrides;
  }
}

export async function saveOverrides(map, storage = STORAGE) {
  currentOverrides = map || {};
  try {
    await storage.set({ [KEY]: normaliseOverrides(map) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Correct a deadline the extractor got wrong.
 *
 * `wasText` and `wasAt` record what the parser believed. That pair is the
 * labelled corpus: a phrase plus the date a human said it actually meant. It
 * costs a few bytes per correction and it is the only route to an extractor
 * that improves.
 */
export function correct(map, messageId, at, { wasText, wasAt, note, now = Date.now() } = {}) {
  if (!messageId || !Number.isFinite(at)) return map;
  return {
    ...map,
    [messageId]: {
      messageId,
      at,
      origin: 'corrected',
      setAt: now,
      ...(note ? { note } : {}),
      ...(wasText ? { wasText } : {}),
      ...(Number.isFinite(wasAt) ? { wasAt } : {}),
    },
  };
}

/** Add a deadline to a message the extractor found nothing in. */
export function setManual(map, messageId, at, { note, now = Date.now() } = {}) {
  if (!messageId || !Number.isFinite(at)) return map;
  return {
    ...map,
    [messageId]: { messageId, at, origin: 'manual', setAt: now, ...(note ? { note } : {}) },
  };
}

/**
 * Say "there is no deadline here".
 *
 * Stored as an override with a null date rather than by deleting, because
 * deleting would let the extractor re-add it on the next ingest and the user
 * would have to dismiss the same false deadline forever.
 */
export function dismiss(map, messageId, { wasText, wasAt, now = Date.now() } = {}) {
  if (!messageId) return map;
  return {
    ...map,
    [messageId]: {
      messageId,
      at: null,
      origin: 'dismissed',
      setAt: now,
      ...(wasText ? { wasText } : {}),
      ...(Number.isFinite(wasAt) ? { wasAt } : {}),
    },
  };
}

/** Forget an override entirely, restoring whatever the extractor says. */
export function clearOverride(map, messageId) {
  if (!map[messageId]) return map;
  const next = { ...map };
  delete next[messageId];
  return next;
}

/**
 * The effective deadline for a message.
 *
 * THE ONE FUNCTION EVERY READER SHOULD USE. The precedence rule lives here and
 * nowhere else; a caller that reaches for `m.dueAt` directly will silently
 * ignore corrections, which is exactly the bug this module exists to prevent.
 *
 * @returns {{at:number|null, source:'user'|'extracted'|'none', origin?:string, text?:string}}
 */
/*
 * THE loaded override map, module-owned (cross-audit B-03). Every consumer
 * of "does this message have a deadline" reads through dueAtOfNow, so a
 * dismissal or correction propagates to lanes, search, rules and saved
 * views in one hop -- previously each reader picked raw `m.dueAt` and
 * disagreed with the radar.
 */
let currentOverrides = {};

/** @returns {object} the override map loaded for this session */
export function overridesNow() { return currentOverrides; }

/** Canonical deadline accessor: user override beats extraction, always. */
export function dueAtOfNow(msg) {
  const e = effectiveDeadline(msg, currentOverrides);
  return e && Number.isFinite(e.at) ? e.at : undefined;
}

export function effectiveDeadline(msg, map = {}) {
  const o = msg && map[msg.id];
  if (o) {
    return {
      at: o.at,
      source: 'user',
      origin: o.origin,
      ...(o.note ? { text: o.note } : {}),
    };
  }
  /*
   * `Number.isFinite`, not `typeof === 'number'`.
   *
   * NaN is a number. A record carrying `dueAt: NaN` would be reported as a
   * real extracted deadline, and every downstream comparison against it
   * (`dueAt < now`, the radar sort, the lane cascade) silently returns false --
   * so the message would claim a deadline that can never be due, overdue, or
   * ordered.
   *
   * I could not reach this from `extractDeadline`, which returns null for
   * every malformed date I probed it with, so this is not a fix for an
   * observed failure. It is a one-word guard on a public function that other
   * code will pass records to, and the failure mode it prevents is invisible
   * rather than loud.
   */
  if (msg && Number.isFinite(msg.dueAt)) {
    return { at: msg.dueAt, source: 'extracted', ...(msg.dueText ? { text: msg.dueText } : {}) };
  }
  return { at: null, source: 'none' };
}

/** Convenience for filters and lane assignment. */
export function dueAtOf(msg, map) {
  return effectiveDeadline(msg, map).at;
}

/** Has the user expressed an opinion about this message's deadline? */
export function isOverridden(map, messageId) {
  return !!map[messageId];
}

/**
 * Drop overrides for messages that are no longer in the mailbox.
 *
 * Same leak as thread mutes and follow-ups: without a sweep the blob grows
 * forever. Called after a full sync.
 */
export function pruneOverrides(map, liveIds) {
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
  const kept = {};
  let dropped = 0;
  for (const [id, v] of Object.entries(map)) {
    /* Same '__proto__' prototype-setter trap as normaliseOverrides (fuzz
     * round 3, defect #10b): define the entry, do not assign it. */
    if (live.has(id)) {
      Object.defineProperty(kept, id, {
        value: v, writable: true, enumerable: true, configurable: true,
      });
    } else dropped++;
  }
  return dropped === 0 ? map : kept;
}

/**
 * The corrections corpus, for improving the extractor.
 *
 * Only entries where the parser had an opinion AND a human overruled it are
 * useful as training data -- a manual deadline on a message the parser said
 * nothing about teaches nothing about parsing.
 */
export function corpus(map) {
  return Object.values(map)
    .filter((o) => o.wasText && (o.origin === 'corrected' || o.origin === 'dismissed'))
    .map((o) => ({
      phrase: o.wasText,
      parsedAs: o.wasAt ?? null,
      shouldBe: o.at,
      verdict: o.origin === 'dismissed' ? 'not-a-deadline' : 'wrong-date',
    }));
}
