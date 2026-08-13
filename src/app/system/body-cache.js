/**
 * Body cache — the local-first floor under the reader (M1, 2026-08-13).
 *
 * WHY THIS EXISTS
 * ---------------
 * The header cache (cache.js) makes the LIST survive a restart; until M1
 * the READER had no such floor. Every open went to the worker, and when the
 * worker could not answer — no connection, a dead service worker, a Gmail
 * blip — a message the user had already read rendered as one red sentence:
 * "Could not load this message." The mail was read before; the copy was
 * here; the app simply had nowhere to keep it.
 *
 * This module keeps the last N opened bodies beside the header cache and
 * hands them back to the reader when the live fetch fails. It is a floor,
 * not an accelerator: the live fetch is ALWAYS tried first unless the
 * browser is certainly offline (the reader owns that call), because mail
 * changes and a cache that prefers itself teaches people to distrust it.
 *
 * DESIGN
 *
 *   - Its OWN key, not a corner of msgCache. Headers churn per sync and are
 *     dropped on resync; bodies churn per read and stay true as long as
 *     their message exists (a body is immutable — edits don't happen, only
 *     deletion, and a deleted message's body is simply never requested).
 *     Sharing a blob would rewrite 500 headers on every open and would
 *     inherit resync's scorched-earth clear for no benefit.
 *
 *   - One JSON blob, written whole, coalesced to idle-ish times — the same
 *     discipline cache.js measured out, at ~1/20 the frequency. Reading
 *     twenty mails in a sitting costs ONE write, not twenty.
 *
 *   - Bounded twice: BODY_CACHE_MAX entries AND BODY_CACHE_BUDGET chars of
 *     html+text in total. The count bound alone is a lie a newsletter can
 *     explode (one marketing blast can carry more markup than fifty plain
 *     mails); the char bound alone lets one giant crowd out everything.
 *     Eviction is strictly oldest-first on whichever bound trips.
 *
 *   - Giants are refused: a body over PER_BODY_LIMIT chars is not cached at
 *     all. It would eat a tenth of the budget by itself, and huge marketing
 *     mail is exactly what you least need to re-read offline.
 *
 *   - The persisted body is the WORKER's body — raw html and all. That is
 *     data at rest, not a render: the only thing that ever turns it into
 *     pixels is the reader's existing renderBodyInto, which runs the same
 *     sanitiser, CSP and sandbox it runs for a fresh fetch. Storing a
 *     pre-sanitised copy would fork the security boundary into two
 *     pipelines that must never disagree; one pipeline, fed by two
 *     sources, cannot disagree with itself.
 *
 *   - inlineData is never persisted. One inline photo as a data: URL can be
 *     larger than the entire budget. The fresh path re-fetches inline parts
 *     on every open anyway, and the offline render shows the same
 *     placeholders a failed GET_INLINE shows today — a degradation that
 *     already exists, not a new one.
 */

import { STORAGE } from '../../platform/storage.js';

const KEY = 'bodyCache';
const VERSION = 1;

/** How many opened bodies to keep. A working set, not an archive: the
 *  mails a student actually re-reads in a week. */
export const BODY_CACHE_MAX = 50;

/** Total chars of html+text across all entries (~2MB against the 10MB
 *  local quota, beside ~1MB of header cache and the settings/rules). */
export const BODY_CACHE_BUDGET = 2_000_000;

/** One body larger than this is refused outright. */
export const PER_BODY_LIMIT = 200_000;

/** How long after the last remember the coalesced write lands. */
const WRITE_DELAY_MS = 1200;

/** In-memory truth for the session. Map<id, entry>, NEWEST LAST — Map
 *  insertion order is the LRU order, and a get/put re-inserts. */
let mem = null;
let priming = null;
let timer = null;
let pendingStorage = null;
let flushListening = false;

const entryChars = (e) => (e.h?.length || 0) + (e.t?.length || 0);

/**
 * The fields worth persisting, with quota-length keys. Header-ish strings
 * are kept whole — the offline copy must be as REPLY-READY as the live one
 * (Reply needs messageId/references to thread correctly); the weight is all
 * in h/t, and the budget governs that.
 */
function pack(body) {
  const slimPart = (p) => ({
    attachmentId: p.attachmentId || '',
    filename: p.filename || '',
    mimeType: p.mimeType || '',
    size: p.size || 0,
  });
  return {
    at: Date.now(),
    h: body.html || '',
    t: body.text || '',
    tid: body.threadId || '',
    f: body.from || '',
    s: body.subject || '',
    to: body.to || '',
    cc: body.cc || '',
    rt: body.replyTo || '',
    d: body.date || 0,
    m: body.messageId || '',
    rf: body.references || '',
    lu: body.listUnsubscribe || '',
    /* Attachment DESCRIPTORS are tiny and cached — the chips render offline,
       and clicking one while offline fails the fetch exactly as it would on
       any other dead connection. The bytes themselves never were here. */
    a: (body.attachments || []).map(slimPart),
    i: (body.inline || []).map(slimPart),
  };
}

/**
 * Rebuild the worker-body shape the reader expects, so the fallback path
 * renders through renderBodyInto UNCHANGED. `offlineAt` is the one field a
 * live body never has: it is what the honest marker dates itself from, and
 * a fresh fetch overwriting it is impossible because a fresh fetch never
 * passes through here.
 */
function unpack(id, e) {
  if (!e || typeof e.h !== 'string' || typeof e.t !== 'string') return null;
  return {
    id,
    threadId: e.tid || '',
    html: e.h,
    text: e.t,
    attachments: Array.isArray(e.a) ? e.a : [],
    inline: Array.isArray(e.i) ? e.i : [],
    from: e.f || '',
    subject: e.s || '',
    to: e.to || '',
    cc: e.cc || '',
    replyTo: e.rt || '',
    date: e.d || 0,
    messageId: e.m || '',
    references: e.rf || '',
    listUnsubscribe: e.lu || '',
    offlineAt: e.at || 0,
  };
}

function totalChars() {
  let n = 0;
  for (const e of mem.values()) n += entryChars(e);
  return n;
}

/** Oldest-first eviction on both bounds; the newest entry is never dropped
 *  here even if it alone exceeds the budget (it passed PER_BODY_LIMIT, so
 *  it cannot). */
function prune() {
  while (mem.size > BODY_CACHE_MAX) mem.delete(mem.keys().next().value);
  while (mem.size > 1 && totalChars() > BODY_CACHE_BUDGET) {
    mem.delete(mem.keys().next().value);
  }
}

/**
 * Load the blob once per session. Never throws, never returns: the outcome
 * is that `mem` holds a Map, possibly empty. A corrupt or version-mismatched
 * blob degrades to "no cache", not to a dead reader — the same contract
 * cache.js signs for the list, one surface deeper.
 */
function prime(storage = STORAGE) {
  if (mem) return Promise.resolve();
  if (!priming) {
    priming = (async () => {
      const next = new Map();
      try {
        const got = await storage.get(KEY);
        const blob = got?.[KEY];
        if (blob && blob.v === VERSION && Array.isArray(blob.b)) {
          for (const pair of blob.b) {
            // Skip malformed pairs individually; one bad entry must not
            // cost the rest (cache.js's row discipline).
            if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue;
            next.set(pair[0], pair[1]);
          }
        }
      } catch {
        /* storage itself failed — an empty floor is still a floor */
      }
      mem = next;
    })();
  }
  return priming.then(() => {});
}

function ensureFlushListener() {
  if (flushListening) return;
  flushListening = true;
  /* Self-registered, like the idle scheduler: the shell wires NOTHING for
     this cache. pagehide cannot await, but chrome.storage.local.set accepts
     the write synchronously and completes it out of process — issuing it is
     what matters (cache.js's flush comment, same mechanism). */
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', () => { void flushBodyCache(); });
  }
}

function scheduleWrite(storage) {
  pendingStorage = storage;
  if (timer !== null) return; // many remembers collapse into one write
  ensureFlushListener();
  timer = setTimeout(() => {
    timer = null;
    void writeNow(pendingStorage);
  }, WRITE_DELAY_MS);
  if (typeof timer?.unref === 'function') timer.unref();
}

async function writeNow(storage) {
  if (!mem) return;
  const pairs = [...mem.entries()];
  try {
    await storage.set({ [KEY]: { v: VERSION, b: pairs } });
  } catch {
    /* Quota is the plausible failure (Chrome counts JSON-stringified
       length). The right response to "too big" is to be smaller: drop the
       oldest half and retry ONCE. If even that fails, stay silent — the
       cache is a floor, and a floor must never error at the user. */
    let n = Math.ceil(mem.size / 2);
    while (n-- > 0 && mem.size > 1) mem.delete(mem.keys().next().value);
    try {
      const shrunk = [...mem.entries()];
      await storage.set({ [KEY]: { v: VERSION, b: shrunk } });
    } catch {
      /* give up quietly */
    }
  }
}

/**
 * Persist that this body was opened. Fire-and-forget by design: it never
 * throws (a cache must not surface), and the reader calls it without await
 * right after painting — a storage round trip must not delay the render it
 * just produced.
 */
export async function rememberBody(id, body, storage = STORAGE) {
  try {
    if (typeof id !== 'string' || !body) return false;
    const packed = pack(body);
    if (!packed.h && !packed.t) return false;      // nothing to fall back to
    if (entryChars(packed) > PER_BODY_LIMIT) return false; // giants stay cold
    await prime(storage);
    /* delete+set moves the id to the newest end WITHOUT duplicating it —
       Map insertion order IS the LRU order. */
    mem.delete(id);
    mem.set(id, packed);
    prune();
    scheduleWrite(storage);
    return true;
  } catch {
    return false;
  }
}

/**
 * The saved copy of one body, in worker-body shape plus `offlineAt`, or
 * null. Reading bumps the entry to newest in memory — the session's own
 * eviction then respects what is actually being re-read — but a read bump
 * does NOT schedule a write: it only matters beyond the session which
 * entries were WRITTEN, and every write re-persists the whole blob anyway.
 */
export async function cachedBody(id, storage = STORAGE) {
  await prime(storage);
  const e = mem.get(id);
  if (!e) return null;
  const body = unpack(id, e);
  if (!body) { mem.delete(id); return null; }
  mem.delete(id);
  mem.set(id, e);
  return body;
}

/** Write now if a write is pending. For pagehide and tests. */
export async function flushBodyCache() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (pendingStorage) await writeNow(pendingStorage);
}

/**
 * Forget everything — called from sign-out, and ONLY from sign-out.
 * Resync deliberately keeps bodies (see the module header: a body is
 * immutable and unreachable without its store record); sign-out is
 * different because the ACCOUNT leaves, and nothing of it may stay behind.
 */
export async function clearBodyCache(storage = STORAGE) {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  pendingStorage = null;
  mem = new Map();
  try {
    await storage.remove(KEY);
  } catch {
    /* nothing to do */
  }
}

/** Test hook: return the module to first-open state. Not exported for app
 *  use — the app never needs to re-prime. */
export function _reset() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  mem = null;
  priming = null;
  pendingStorage = null;
  flushListening = false;
}
