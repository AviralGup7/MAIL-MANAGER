/**
 * Triage lanes.  (Feature 31, absorbing feature 9's grouping mechanism.)
 *
 * WHY LANES AND NOT A "GROUP BY" DROPDOWN
 * ---------------------------------------
 * The discovery pass proposed both: a user-driven "group by sender / course /
 * day" control, and an automatic priority split. The elimination pass kept the
 * automatic one and cut the control, because a dropdown asks the user to
 * re-derive priority themselves -- which is exactly the work the app is
 * supposed to be doing for them. The partition mechanism is the same either
 * way; only the question differs. This module answers "what should I deal with
 * first", which the app can answer, instead of "how would you like this
 * sorted", which only the user can.
 *
 * THE LANES
 *
 *   needsReply    addressed to me personally, not yet answered, or carrying a
 *                 question. This is the lane that must never be wrong.
 *   deadlines     anything with a due date that has not passed harmlessly.
 *   announcements broadcast institutional mail. The bulk of a campus inbox.
 *   newsletters   promotional and external. Safe to read never.
 *
 * A MESSAGE IS IN EXACTLY ONE LANE. Multi-lane membership was considered and
 * rejected: a message that appears twice makes the counts lie, and makes
 * "archive everything in this lane" ambiguous. Assignment is therefore a
 * priority cascade -- first matching rule wins -- and the order of the cascade
 * IS the product opinion.
 *
 * DEADLINES OUTRANK NEEDS-REPLY on purpose. A form due tonight matters more
 * than a reply you owe, and the reply will still be there tomorrow.
 *
 * WHY THIS IS A MAIL FEATURE AND NOT AN ACADEMIC ONE
 *
 * Nothing here reads the timetable, and nothing here needs the classifier to
 * be right about WHICH BITS category a message is in -- only whether it is
 * institutional at all. The lanes work on a personal Gmail account with no
 * BITS mail in it, which is the test the identity filter applies.
 */

import { audienceOf } from './direct.js';

/** Lane ids, in display order. The order is the priority cascade. */
export const LANES = /** @type {const} */ ([
  'needsReply',
  'deadlines',
  'announcements',
  'newsletters',
]);

/** Human labels for the section headers. */
export const LANE_LABELS = {
  needsReply: 'Needs reply',
  deadlines: 'Deadlines',
  announcements: 'Announcements',
  newsletters: 'Newsletters',
};

/**
 * One-line explanations, shown under an empty lane.
 *
 * An empty section with no explanation reads as a bug. An empty section that
 * says why it is empty reads as good news.
 */
export const LANE_EMPTY = {
  needsReply: 'Nothing is waiting on you.',
  deadlines: 'No dates coming up.',
  announcements: 'No new notices.',
  newsletters: 'Nothing promotional.',
};

/** Categories that are, by definition, not addressed to anyone individually. */
const BROADCAST_CATEGORIES = new Set([
  'external-promotions',
  'external-services',
  'spam',
]);

/**
 * Does the text contain a direct question to the reader?
 *
 * Deliberately narrow. A question mark alone is far too loose -- marketing
 * subject lines are full of them ("Ready for your next internship?"), and a
 * false needs-reply is the one error that destroys trust in the lane.
 */
const ASKS_SOMETHING =
  /\b(please\s+(confirm|reply|respond|revert|submit|share|send|fill|acknowledge)|kindly\s+(confirm|reply|respond|revert|submit|share|send|fill)|let\s+me\s+know|awaiting\s+your|your\s+response\s+is|needs?\s+your\s+(approval|input|confirmation)|can\s+you\s+(please\s+)?(send|share|confirm))\b/i;

/**
 * Assign one message to a lane.
 *
 * @param {object} m               store record
 * @param {object} ctx
 * @param {string} ctx.self        signed-in address
 * @param {number} [ctx.now]
 * @param {(m:object)=>boolean} [ctx.isAnswered] did we already reply in this thread
 * @returns {'needsReply'|'deadlines'|'announcements'|'newsletters'}
 */
export function laneOf(m, { self, now = Date.now(), isAnswered = () => false, dueAtOf = null } = {}) {
  if (!m) return 'announcements';

  const category = String(m.category || '');

  /*
   * DEADLINES FIRST.
   *
   * Including overdue ones: an overdue deadline is MORE urgent, not less, and
   * dropping it out of the lane the moment it expires is how a system quietly
   * stops mentioning the thing you missed. It ages out after a week, by which
   * point it is history rather than a task.
   */
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const due = dueAtOf ? dueAtOf(m) : m.dueAt;
  if (Number.isFinite(due) && due > now - WEEK) return 'deadlines';

  // Promotional mail is never in a working lane, however it is addressed.
  if (BROADCAST_CATEGORIES.has(category)) return 'newsletters';

  // Stamped at ingest where possible; live derivation only as the fallback
  // for records that predate the stamp (cross-audit B-02).
  const audience = m.audience || audienceOf(m, self);

  /*
   * NEEDS-REPLY.
   *
   * Three conditions, all required:
   *   - it was addressed to me (To, not Cc -- being kept informed is not a
   *     request), and
   *   - I have not already replied in this thread, and
   *   - it is unread, or it explicitly asks for something.
   *
   * The "unread OR asks" clause is what stops the lane filling with mail the
   * user has read and consciously chosen not to answer.
   */
  if (audience === 'direct' && !isAnswered(m)) {
    const text = `${m.subject || ''} ${m.snippet || ''}`;
    if (m.unread || ASKS_SOMETHING.test(text)) return 'needsReply';
  }

  if (audience === 'broadcast') return 'announcements';

  // Read, answered, or merely Cc'd: real mail, but not a task.
  return 'announcements';
}

/**
 * Partition a list of ids into lanes, preserving the input order within each.
 *
 * Returns ALL lanes including empty ones, because the caller decides whether
 * to render an empty section, and a caller that has to guess which lanes exist
 * will drift from this module the first time a lane is added.
 *
 * @param {string[]} ids
 * @param {(id:string)=>object|undefined} get
 * @param {object} ctx  as `laneOf`
 * @returns {Array<{lane:string, label:string, ids:string[]}>}
 */
export function partition(ids, get, ctx = {}) {
  /** @type {Record<string,string[]>} */
  const buckets = {};
  for (const lane of LANES) buckets[lane] = [];

  for (const id of ids) {
    const m = get(id);
    if (!m || m.fromSearch) continue; // render-only; never triage truth (H4)
    buckets[laneOf(m, ctx)].push(id);
  }

  return LANES.map((lane) => ({
    lane,
    label: LANE_LABELS[lane],
    ids: buckets[lane],
  }));
}

/**
 * Build a "has this thread been answered" predicate from the store.
 *
 * A thread is answered when it contains a message FROM the signed-in user that
 * is newer than the message being judged. Cheap because the thread index is
 * already maintained incrementally by the store.
 *
 * Returns a closure rather than doing the work inline so the render path pays
 * the lookup cost once per message rather than re-deriving `self` each time.
 *
 * @param {{threadIds:(t:string)=>string[], get:(id:string)=>object}} store
 * @param {string} self
 */
export function answeredPredicate(store, self) {
  const me = String(self || '').toLowerCase();
  if (!me) return () => false;

  return (m) => {
    const tid = m?.threadId;
    if (!tid || typeof store?.threadIds !== 'function') return false;
    for (const id of store.threadIds(tid)) {
      const other = store.get(id);
      if (!other || other.id === m.id) continue;
      if (other.date <= m.date) continue;
      if (String(other.from || '').toLowerCase().includes(me)) return true;
    }
    return false;
  };
}

/**
 * A count per lane, for the rail.
 *
 * Counts UNREAD, not total. A lane badge showing every message it contains is
 * the "1,482 unread" problem in miniature: a number that never changes and
 * therefore conveys nothing.
 */
export function laneCounts(ids, get, ctx = {}) {
  const out = {};
  for (const lane of LANES) out[lane] = 0;
  for (const id of ids) {
    const m = get(id);
    if (!m || !m.unread) continue;
    out[laneOf(m, ctx)] += 1;
  }
  return out;
}
