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
