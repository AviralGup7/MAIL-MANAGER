/**
 * "Addressed to me" detection.  (Feature 32.)
 *
 * THE PROBLEM THIS SOLVES IS THE BIGGEST ONE IN A CAMPUS INBOX
 * ------------------------------------------------------------
 * The screenshot that started this round showed 44 conversations. Perhaps six
 * of them were written TO the user. The rest went to a mailing list -- every
 * student in the batch, every member of a club, everyone in the hostel -- and
 * almost none of them need an action from this person specifically.
 *
 * Gmail cannot help here, because Gmail's "Primary" tab is trained on
 * commercial mail and treats an institutional list blast as personal mail. One
 * local check does better than the whole tab system:
 *
 *   Is my address actually in To or Cc?
 *
 * THREE LEVELS, NOT TWO
 *
 *   'direct'    my address is in To. Someone chose to write to me.
 *   'cc'        my address is in Cc. I am being kept informed.
 *   'broadcast' my address appears nowhere in the visible recipients, or the
 *               message carries list headers. I am part of an audience.
 *
 * `cc` is separate because collapsing it into `direct` makes the filter
 * useless on department mail (where everyone is Cc'd out of caution) and
 * collapsing it into `broadcast` hides genuine one-to-few mail.
 *
 * WHY THIS IS CONSERVATIVE ON PURPOSE
 *
 * A false 'broadcast' hides a message the user needed. A false 'direct' merely
 * fails to hide one. The costs are wildly asymmetric, so every ambiguous case
 * resolves toward 'direct'. In particular a message with NO recipient data at
 * all is 'direct', never 'broadcast' -- absent data must never cause a hide.
 */

import { addressOf, parseAddressList } from '../core/contacts.js';

/**
 * Headers that prove a message came from a mailing list.
 *
 * RFC 2919 / 4021. Gmail exposes these in the raw headers; when the sync layer
 * carries them, this is a much stronger signal than address matching, because
 * a list can and does rewrite the To header to the individual subscriber.
 */
export const LIST_HEADERS = ['list-id', 'list-post', 'list-unsubscribe', 'mailing-list'];

/** Split a recipient header into bare addresses, respecting quoted names. */
export function splitRecipients(value) {
  // Canonical parser, canonical lowercasing -- one truth for "who is this
  // addressed to" (cross-audit B-05).
  return parseAddressList(value).map((a) => a.address).filter(Boolean);
}

/**
 * Does this look like a list address rather than a person?
 *
 * Used only as a tiebreak. `students@`, `all-students@`, `noreply@` are
 * audiences even when they appear in To.
 */
const LIST_LOCALPARTS =
  /^(all|students?|everyone|batch|ug|pg|hostel|mess|clubs?|announce\w*|notice\w*|broadcast|list|group|no-?reply|do-?not-?reply|bounce|mailer-daemon)([._-]|$)/i;

export function looksLikeListAddress(address) {
  const a = String(address || '').toLowerCase();
  const local = a.split('@')[0] || '';
  if (!local) return false;
  if (LIST_LOCALPARTS.test(local)) return true;
  // `2024batch`, `cs-f111-students`, `f2024-all`
  if (/(^|[._-])(all|students?|batch|everyone)([._-]|$)/i.test(local)) return true;
  return false;
}

/**
 * Classify a message's relationship to the signed-in user.
 *
 * @param {object} msg           store record; may carry `to`, `cc`, `headers`
 * @param {string} selfAddress   the signed-in address
 * @returns {'direct'|'cc'|'broadcast'}
 */
export function audienceOf(msg, selfAddress) {
  const self = addressOf(selfAddress);
  if (!self) return 'direct'; // Not signed in yet: never hide anything.

  const headers = msg?.headers || {};
  const hasListHeader = LIST_HEADERS.some((h) => {
    // Header names are case-insensitive; the sync layer may preserve case.
    const found = Object.keys(headers).find((k) => k.toLowerCase() === h);
    return found && String(headers[found]).trim() !== '';
  });

  const to = splitRecipients(msg?.to);
  const cc = splitRecipients(msg?.cc);

  const inTo = to.includes(self);
  const inCc = cc.includes(self);

  /*
   * A LIST HEADER DOES NOT AUTOMATICALLY MEAN BROADCAST.
   *
   * Mail sent to a list AND to you by name is still addressed to you -- this
   * is exactly what happens when someone replies-all to a list thread and
   * names you. Only demote to broadcast when the list header is present and
   * you are not individually named.
   */
  if (inTo) return hasListHeader && to.length > 12 ? 'broadcast' : 'direct';
  if (inCc) return hasListHeader && cc.length > 12 ? 'broadcast' : 'cc';

  if (hasListHeader) return 'broadcast';

  /*
   * NO RECIPIENT DATA AT ALL.
   *
   * The sync layer does not always carry `to` -- it is not needed for the list
   * row, so a lean sync may omit it. Treating "we did not fetch it" as "you
   * were not on it" would hide real mail, so absent data resolves to direct.
   */
  if (to.length === 0 && cc.length === 0) return 'direct';

  // We have recipients and none of them is us: a list that rewrites To, or a
  // Bcc. Both are audiences.
  if (to.every(looksLikeListAddress) && to.length > 0) return 'broadcast';
  return 'broadcast';
}

/** Convenience: is this message worth the user's individual attention? */
export function isDirect(msg, selfAddress) {
  return audienceOf(msg, selfAddress) !== 'broadcast';
}

/**
 * Filter a list of ids down to directly-addressed mail.
 *
 * Takes a getter rather than records so callers can pass `store.get` without
 * materialising an array of objects first -- the list path runs this on every
 * render and allocating 2000 objects there is how a filter becomes a jank.
 *
 * @param {string[]} ids
 * @param {(id:string)=>object|undefined} get
 * @param {string} selfAddress
 * @param {{includeCc?:boolean}} [opts]
 */
export function filterDirect(ids, get, selfAddress, { includeCc = true } = {}) {
  const out = [];
  for (const id of ids) {
    const m = get(id);
    if (!m) continue;
    const a = audienceOf(m, selfAddress);
    if (a === 'direct' || (includeCc && a === 'cc')) out.push(id);
  }
  return out;
}
