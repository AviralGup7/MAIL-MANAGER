/**
 * Follow-ups: "I am waiting on a reply to this."  (Feature 6, absorbing 20.)
 *
 * THE FAILURE THIS EXISTS TO CATCH
 * --------------------------------
 * A student mails a professor asking for something -- an extension, a
 * signature, a recommendation -- and never hears back. There is no error, no
 * bounce, and no reminder. The mail simply sits in Sent and the deadline
 * passes. It is the highest-cost silent failure in a student mailbox and no
 * mail client surfaces it, because a client that only looks at the inbox
 * cannot see the absence of a thing.
 *
 * WHY IT IS DISTINCT FROM STAR, SNOOZE AND A DEADLINE
 *
 *   star      "this matters" -- no date, no resolution condition
 *   snooze    "hide this until later" -- it comes back regardless
 *   deadline  a date imposed from OUTSIDE, extracted from the message
 *   follow-up a date I chose, which RESOLVES ITSELF if a reply arrives
 *
 * That last clause is the whole feature. A follow-up is the only one of the
 * four that can be satisfied by something the user does not do, which is why
 * it cannot be folded into any of them. Threading makes the check cheap: "has
 * anything newer arrived in this thread from someone else" is a thread-index
 * lookup, which the store already maintains incrementally.
 *
 * THE RESOLUTION RULE IS DELIBERATELY GENEROUS. Any newer message in the
 * thread from anyone other than me clears the follow-up, even if it is not a
 * real answer. A follow-up that nags after the professor replied "will do" is
 * a follow-up the user turns off.
 */

const KEY = 'followups';

/** Cap. Beyond this the oldest resolved entries are dropped. */
export const MAX_FOLLOWUPS = 200;

const DAY = 24 * 60 * 60 * 1000;

/** Presets offered in the picker, in the order shown. */
export const PRESETS = [
  { id: 'f-2d', label: 'In 2 days', ms: 2 * DAY },
  { id: 'f-3d', label: 'In 3 days', ms: 3 * DAY },
  { id: 'f-1w', label: 'In a week', ms: 7 * DAY },
  { id: 'f-2w', label: 'In two weeks', ms: 14 * DAY },
];

/**
 * @typedef {Object} Followup
 * @property {string} threadId    the key: a follow-up is per CONVERSATION
 * @property {string} messageId   what to open when the user clicks it
 * @property {number} dueAt
 * @property {number} createdAt
 * @property {string} [note]
 */

/** Coerce storage into a usable list. Never throws. */
export function normaliseFollowups(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    if (typeof f.threadId !== 'string' || !f.threadId) continue;
    if (!Number.isFinite(f.dueAt)) continue;
    // One follow-up per thread. A second is an edit, not an addition.
    if (seen.has(f.threadId)) continue;
    seen.add(f.threadId);
    out.push({
      threadId: f.threadId,
      messageId: typeof f.messageId === 'string' ? f.messageId : '',
      dueAt: f.dueAt,
      createdAt: Number.isFinite(f.createdAt) ? f.createdAt : f.dueAt,
      ...(typeof f.note === 'string' && f.note ? { note: f.note.slice(0, 200) } : {}),
    });
  }
  return out;
}

export async function loadFollowups(storage = chrome.storage?.local) {
  try {
    const got = (await storage.get(KEY)) || {};
    return normaliseFollowups(got[KEY]);
  } catch {
    return [];
  }
}

export async function saveFollowups(list, storage = chrome.storage?.local) {
  try {
    await storage.set({ [KEY]: normaliseFollowups(list).slice(0, MAX_FOLLOWUPS) });
    return true;
  } catch {
    return false;
  }
}

/** Add or replace the follow-up for a thread. Returns the NEW list. */
export function setFollowup(list, { threadId, messageId, dueAt, note }, now = Date.now()) {
  if (!threadId || !Number.isFinite(dueAt)) return list;
  const without = list.filter((f) => f.threadId !== threadId);
  return [...without, { threadId, messageId: messageId || '', dueAt, createdAt: now, ...(note ? { note } : {}) }];
}

export function clearFollowup(list, threadId) {
  return list.filter((f) => f.threadId !== threadId);
}

export function hasFollowup(list, threadId) {
  return list.some((f) => f.threadId === threadId);
}

/**
 * Has this thread been answered since the follow-up was set?
 *
 * "Answered" means: any message in the thread, newer than the follow-up's
 * creation, from someone who is not me.
 *
 * The `createdAt` comparison matters. Comparing against the ORIGINAL message
 * date would resolve a follow-up using a reply that arrived before the user
 * even set it -- which happens constantly, because people set a follow-up
 * while reading an old thread.
 *
 * @param {Followup} f
 * @param {{threadIds:(t:string)=>string[], get:(id:string)=>object}} store
 * @param {string} self
 */
export function isAnswered(f, store, self) {
  const me = String(self || '').toLowerCase();
  if (typeof store?.threadIds !== 'function') return false;
  for (const id of store.threadIds(f.threadId)) {
    const m = store.get(id);
    if (!m) continue;
    if (m.date <= f.createdAt) continue;
    const from = String(m.from || '').toLowerCase();
    // A message from me does not answer my own follow-up -- that is a nudge,
    // not a reply, and nudging should not clear the reminder.
    if (me && from.includes(me)) continue;
    return true;
  }
  return false;
}

/**
 * Which follow-ups are due and still unanswered?
 *
 * This is what the radar renders. Answered ones are filtered out here rather
 * than deleted, because deletion belongs to an explicit sweep -- a render
 * function with a side effect on storage is how a list flickers.
 */
export function dueFollowups(list, store, self, now = Date.now()) {
  return list
    .filter((f) => f.dueAt <= now)
    .filter((f) => !isAnswered(f, store, self))
    .sort((a, b) => a.dueAt - b.dueAt);
}

/** Everything still outstanding, due or not. For the "Waiting" view. */
export function openFollowups(list, store, self) {
  return list.filter((f) => !isAnswered(f, store, self)).sort((a, b) => a.dueAt - b.dueAt);
}

/**
 * Drop entries that are resolved or whose thread has left the mailbox.
 *
 * Called after a sync, like `pruneThreadMutes`. Without it the list grows
 * forever and the storage blob becomes a slow leak.
 */
export function pruneFollowups(list, store, self) {
  return list.filter((f) => {
    const ids = typeof store?.threadIds === 'function' ? store.threadIds(f.threadId) : [];
    if (!ids || ids.length === 0) return false; // thread is gone
    return !isAnswered(f, store, self);
  });
}

/**
 * A radar-shaped record, so the deadline radar can render follow-ups without
 * knowing what a follow-up is.
 *
 * This is the "radar wants to be multi-source" refactor the discovery audit
 * identified as blocking five separate features, done for the first consumer.
 */
export function asRadarItem(f, store) {
  const m = typeof store?.get === 'function' ? store.get(f.messageId) : null;
  return {
    kind: 'followup',
    id: f.messageId || f.threadId,
    at: f.dueAt,
    title: m?.subject || 'Waiting for a reply',
    detail: f.note || (m?.to ? `No reply from ${m.to}` : 'No reply yet'),
  };
}
