/**
 * Background notification selection (worker-side).
 *
 * The 15-minute background sync (P-3) fetches new mail while the app is
 * closed. This module decides which of those messages are worth a
 * notification — pure and synchronous so it is testable on bare Node, and
 * deliberately conservative: the product doctrine is "a notification you
 * did not want is noise; noise turns the feature off".
 *
 * RULES
 *   - Category allow-list only (augsd, academics). Gmail's own notifications
 *     are all-or-nothing; classifier-driven categories are the one thing
 *     Gmail structurally cannot offer, so that is what we notify on.
 *   - Never more than 3 per run. A burst of mail is one "something happened"
 *     event, not a dozen interruptions.
 *   - Deduplicated against previously notified ids (stored by the caller),
 *     so a delta that is re-synced cannot notify twice.
 */

export const NOTIFY_CATEGORIES = new Set(['augsd', 'academics']);

/** At most this many notifications per background sync run. */
export const NOTIFY_BURST_CAP = 3;

/**
 * @param {Array<{id:string, category?:string, subject?:string, from?:string}>} added
 *        messages as normalised by gmail.js, not yet classified
 * @param {string[]} notifiedIds  ids already notified in previous runs
 * @returns {Array<{id:string, category:string, subject:string, from:string}>}
 */
export function selectNotifiable(added, notifiedIds = []) {
  const seen = new Set(Array.isArray(notifiedIds) ? notifiedIds : []);
  const out = [];
  for (const m of added || []) {
    if (!m || typeof m.id !== 'string') continue;
    if (seen.has(m.id)) continue;
    if (!NOTIFY_CATEGORIES.has(m.category)) continue;
    out.push({
      id: m.id,
      category: m.category,
      subject: String(m.subject || '(no subject)'),
      from: String(m.from || ''),
    });
    if (out.length >= NOTIFY_BURST_CAP) break;
  }
  return out;
}

/** The persisted dedupe list never outgrows this. */
export const NOTIFIED_CAP = 100;

/**
 * Fold a run's notified ids into the persisted dedupe list (audit
 * 2026-08-15, AUD-M3). The merge used to live inline in the sweep as one
 * spread-and-slice — untestable, and its cap was a bare 100 in worker
 * code. Pure here so the properties are pinnable: freshest first (a flood
 * evicts the OLDEST memory, never the newest), no duplicate ids (a corrupt
 * stored list is repaired, not propagated), junk entries dropped, capped.
 *
 * The single-flight guard in index.js is what makes this read-modify-write
 * safe; this function is only the arithmetic of it.
 */
export function mergeNotified(freshIds, prev = []) {
  const out = [];
  const seen = new Set();
  for (const id of [...(freshIds || []), ...(prev || [])]) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= NOTIFIED_CAP) break;
  }
  return out;
}

/**
 * Notification card copy, scrubbed and bounded.
 *
 * Bug-hunt #50 scrubbed the SENDER; the audit (2026-08-15, AUD-L2) found the
 * SUBJECT took the same ride unwashed — a crafted Subject: header carries
 * control characters (newlines that fake a second line of UI) and thousands
 * of characters straight into the OS notification surface. Both sides now
 * pass one gate; only the cap differs (a sender is a name, a subject is a
 * sentence).
 */
export function cardText(s, max = 160) {
  const clean = String(s || '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
