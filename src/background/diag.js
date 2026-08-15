/**
 * Worker-side diagnostics counters (audit 2026-08-15, AUD-Q1).
 *
 * THE HOLE THIS FILLS: when a user reports "sync felt slow" or "I got the
 * same notification twice", the codebase had no numbers to answer with —
 * not a single request, retry, renewal or notification was counted
 * anywhere. The audit's registry of silent classes ended with this row.
 *
 * THE HONESTY, STATED IN THE TABLE'S OWN DOCTRINE: these are the WORKER's
 * counters, held in module memory and flushed to storage on the
 * quarter-hour sweep. MV3 workers are killed aggressively, so between
 * flushes the numbers live nowhere — a crash loses the current window.
 * That is accepted, declared, and why the registry rows this backup:false:
 * restoring a previous session's counters would be fiction. The app
 * context gets its own in-memory copy (gmail.js runs there too); only the
 * worker's copy is ever persisted, so `diagCounters` on disk always means
 * "what the worker saw".
 *
 * Deliberately a whitelist: an accidental bump('reguests') must not
 * silently mint a counter. Five is the agreed surface, no more.
 */

const KEY = 'diagCounters';

/** The counter set, complete and closed. */
const counters = {
  requests: 0,        // Gmail fetch attempts (gmail.js fetchRetrying)
  retries: 0,         // attempts beyond the first (same loop)
  notifications: 0,   // cards the background sweep issued (index.js)
  renewals: 0,        // silent renewals that persisted a token (auth.js)
  mismatchClears: 0,  // account changes proven + cleared (auth.js, AUD-C1)
};

/** Count one event. Unknown names are dropped — the surface is closed. */
export function bump(name, n = 1) {
  if (!Object.hasOwn(counters, name)) return;
  counters[name] += Number.isFinite(n) ? n : 0;
}

/** The live counts (this context's copy). */
export function diagSnapshot() {
  return { ...counters };
}

/**
 * Flush to storage. Never throws: a diagnostics write must never become a
 * failure class of its own in the sweep that hosts it.
 */
export async function persistDiag(storage = chrome.storage.local) {
  try {
    const previous = (await storage.get(KEY))?.[KEY] || {};
    const merged = {};
    for (const name of Object.keys(counters)) {
      merged[name] = (Number.isFinite(previous[name]) ? previous[name] : 0) + counters[name];
    }
    await storage.set({ [KEY]: { ...merged, flushedAt: Date.now() } });
    // Counters now represent the unflushed delta. Reset only after the merged
    // write lands, so worker reincarnations never regress persisted totals.
    for (const name of Object.keys(counters)) counters[name] = 0;
  } catch {
    /* best-effort by doctrine — see the header */
  }
}
