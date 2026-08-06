/**
 * Local message cache.
 *
 * WHY THIS EXISTS
 * ---------------
 * `store.js` advertised "DELTA PERSISTENCE" as one of its three headline
 * fixes, and nothing was ever persisted. Every takeover cold-fetched ~100
 * messages before anything appeared, and the `historyId` cursor -- which was
 * being saved correctly -- had no local state to be a delta *against*, which
 * made the whole History API integration decorative.
 *
 * With this, the second and subsequent opens paint from disk immediately and
 * then apply a delta, which is the entire point of tracking a cursor.
 *
 * DESIGN
 *
 *   - ONE key, not one per message. chrome.storage.local is a single LevelDB;
 *     writing 2000 keys is 2000 transactions. The whole cache is one JSON blob
 *     and it is written whole. That sounds like the v1 mistake -- "writes the
 *     ENTIRE email array" -- but v1's error was writing it on EVERY MUTATION,
 *     dozens of times per sync. Here it is written at most once per idle
 *     period, well after the render.
 *
 *   - Writes are deferred to idle and coalesced. A sync that changes 200
 *     messages produces exactly one write, and it happens after paint, so it
 *     never competes with the render for the main thread.
 *
 *   - Headers only. No bodies -- those are fetched on open and are far too
 *     large to cache. A cached record is roughly 300 bytes.
 *
 *   - Bounded. chrome.storage.local is 10MB by default (we dropped
 *     `unlimitedStorage`). CACHE_MAX keeps the blob near 1MB, an order of
 *     magnitude inside the limit even with UTF-16 overhead.
 *
 *   - Versioned. A schema change bumps VERSION and the old blob is discarded
 *     rather than misread.
 */

const KEY = 'msgCache';
const VERSION = 1;

/**
 * How many messages to persist.
 *
 * Lower than the store's 2000 cap on purpose: the cache exists to make the
 * first screen instant, not to be a complete mirror. 500 newest headers is
 * five pages of scrolling before the network is needed at all.
 */
export const CACHE_MAX = 500;

/**
 * Fields worth persisting.
 *
 * This comment used to say "anything derived is recomputed on load". That was
 * NOT TRUE, and two bugs lived in the gap:
 *
 *   - `dueAt` was neither stored nor recomputed, so a warm start showed no
 *     deadline radar at all until the delta returned. That one really is
 *     derivable -- from the subject and snippet, both cached -- so `app.js`
 *     re-derives it on hydrate (see `withDeadline`).
 *   - `hasAttachment` was neither stored nor recomputed, so `has:attachment`
 *     silently matched nothing for every cached message. This one CANNOT be
 *     recomputed: it comes from the Gmail payload, not from any cached text.
 *     So it is stored, in the spare bits of the flags byte.
 *
 * The rule now: a field is either cached here or re-derived on hydrate, and
 * which one is a deliberate choice per field, not an accident.
 *
 * Flags byte: 1 = unread, 2 = starred, 4 = hasAttachment.
 */
function pack(m) {
  return [
    m.id,
    m.threadId,
    m.from,
    m.subject,
    m.snippet,
    m.date,
    (m.unread ? 1 : 0) | (m.starred ? 2 : 0) | (m.hasAttachment ? 4 : 0),
    m.category,
    m.confidence,
    m.source || '',
    m.reason || '',
  ];
}

function unpack(a) {
  return {
    id: a[0],
    threadId: a[1],
    from: a[2],
    subject: a[3],
    snippet: a[4],
    date: a[5],
    unread: (a[6] & 1) !== 0,
    starred: (a[6] & 2) !== 0,
    // Bit 4 is new. An OLD cache blob simply has it clear, which reads as
    // "no attachment" -- the same answer the bug gave, and it self-corrects
    // on the next sync. No version bump needed for a widening flags byte.
    hasAttachment: (a[6] & 4) !== 0,
    category: a[7],
    confidence: a[8],
    source: a[9],
    reason: a[10],
  };
}

/**
 * Read the cache.
 *
 * Never throws. A corrupt or partially-written blob must degrade to a cold
 * start, not to a broken inbox -- this runs before first paint.
 *
 * @returns {Promise<{messages:object[], savedAt:number}|null>}
 */
export async function loadCache(storage = chrome.storage.local) {
  try {
    const got = await storage.get(KEY);
    const blob = got?.[KEY];
    if (!blob || blob.v !== VERSION || !Array.isArray(blob.m)) return null;
    const messages = [];
    for (const row of blob.m) {
      // Skip malformed rows individually; one bad record must not cost the
      // user their whole cache.
      if (Array.isArray(row) && typeof row[0] === 'string') messages.push(unpack(row));
    }
    return messages.length ? { messages, savedAt: blob.t || 0 } : null;
  } catch {
    return null;
  }
}

/** Write the cache immediately. Prefer `scheduleSave`. */
export async function saveCache(messages, storage = chrome.storage.local) {
  const slice = messages.length > CACHE_MAX ? messages.slice(0, CACHE_MAX) : messages;
  try {
    await storage.set({ [KEY]: { v: VERSION, t: Date.now(), m: slice.map(pack) } });
    return true;
  } catch {
    // Quota exceeded, or storage unavailable. The cache is an optimisation;
    // failing to write one must never surface to the user.
    return false;
  }
}

export async function clearCache(storage = chrome.storage.local) {
  try {
    await storage.remove(KEY);
  } catch {
    /* nothing to do */
  }
}

/**
 * Coalesce writes and keep them off the render path.
 *
 * `requestIdleCallback` is the right tool: it runs when the browser has
 * nothing better to do, which is exactly the priority a cache write deserves.
 * The timeout guarantees it still happens on a busy page. Falls back to a
 * timer where idle callbacks are unavailable (notably jsdom).
 */
export function createSaver(getMessages, storage = chrome.storage.local, opts = {}) {
  const { idleTimeout = 2000, minIntervalMs = 1000 } = opts;
  let handle = null;
  let lastWrite = 0;
  let pending = false;

  const hasIdle = typeof requestIdleCallback === 'function';

  // Track WHICH scheduler produced the current handle.
  //
  // Both branches below store into the same `handle`, but one is an idle
  // callback id and the other a timeout id. Cancelling a timeout id with
  // `cancelIdleCallback` is a silent no-op -- the two id spaces are unrelated
  // -- so a throttled save could still fire after `flush()` claimed to have
  // cancelled it, producing a second, stale write.
  let handleKind = null; // 'idle' | 'timeout'

  const schedIdle = (fn) => {
    handleKind = 'idle';
    return hasIdle ? requestIdleCallback(fn, { timeout: idleTimeout }) : setTimeout(fn, 50);
  };
  const schedTimeout = (fn, ms) => {
    handleKind = 'timeout';
    return setTimeout(fn, ms);
  };
  const cancel = (h) => {
    if (h === null) return;
    if (handleKind === 'idle' && hasIdle) cancelIdleCallback(h);
    else clearTimeout(h);
    handleKind = null;
  };

  async function write() {
    handle = null;
    handleKind = null;
    pending = false;
    lastWrite = Date.now();
    await saveCache(getMessages(), storage);
  }

  return {
    /** Request a save. Many calls collapse into one write. */
    schedule() {
      if (handle !== null) return;
      pending = true;
      const since = Date.now() - lastWrite;
      if (since < minIntervalMs) {
        handle = schedTimeout(() => {
          handle = null;
          handleKind = null;
          if (pending) this.schedule();
        }, minIntervalMs - since);
        return;
      }
      handle = schedIdle(write);
    },

    /**
     * Write now.
     *
     * SYNCHRONOUS by design, despite returning a promise for callers that can
     * await it. `pagehide` cannot await anything -- the document is being torn
     * down -- so anything deferred here is simply lost, and losing it means
     * losing the triage the user just performed.
     *
     * `chrome.storage.local.set` accepts the write synchronously and completes
     * it out of process, so issuing it before returning is what actually gets
     * the data to disk. The returned promise is for `release()`, which can
     * await, and for tests.
     */
    flush() {
      cancel(handle);
      handle = null;
      if (!pending) return Promise.resolve();
      pending = false;
      lastWrite = Date.now();
      // Issued immediately, not scheduled.
      return Promise.resolve(saveCache(getMessages(), storage));
    },
    get isPending() {
      return pending;
    },
  };
}
