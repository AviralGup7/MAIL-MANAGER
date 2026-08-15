import { STORAGE } from '../../platform/storage.js';

/**
 * Snooze.
 *
 * Hide a message until a chosen time, then put it back at the top of the
 * inbox. Gmail has this; the audit ranked it high because a student inbox is
 * full of things that matter on a specific future date and are pure noise
 * until then.
 *
 * WHY THIS IS MORE THAN "REMOVE INBOX, ADD IT BACK LATER"
 * ------------------------------------------------------
 * The obvious implementation loses mail. If the wake never fires -- extension
 * disabled, profile moved to another machine, alarm dropped by the browser --
 * the message has been removed from the inbox and nothing will ever put it
 * back. The user does not know it existed, so they cannot go looking.
 *
 * Three defences, all required:
 *
 *   1. A REAL GMAIL LABEL (`BMM/Snoozed`) carries the state, not just local
 *      storage. Wiping the extension leaves the mail findable in Gmail.
 *
 *   2. A VISIBLE SNOOZED VIEW. Nothing is ever invisible; the user can always
 *      see what they deferred and cancel it.
 *
 *   3. A CATCH-UP SWEEP ON EVERY STARTUP, not only on the alarm. Anything
 *      already overdue wakes immediately. This is what makes a missed alarm a
 *      late delivery instead of a lost message.
 *
 * The wake times are deliberately few. A date-time picker for something you
 * do fifteen times a day is friction; Gmail's fixed presets are right, and
 * "this evening / tomorrow / this weekend / next week" covers nearly all of
 * it. `untilDeadline` is ours and Gmail cannot offer it: it reads the date the
 * deadline parser already found in the message.
 */

// Single source of truth lives in src/shared/labels.js so the
// service worker can import it without crossing into the app layer (R-5).
export { SNOOZE_LABEL } from '../../shared/labels.js';
const KEY = 'snoozed';

/** Round to a sensible hour, never to "now + 8h and 37 minutes". */
function at(date, hour) {
  const d = new Date(date);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function startOfTomorrow(now, hour = 8) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  return at(d, hour);
}

/**
 * The preset wake times, resolved against `now`.
 *
 * Presets that have already passed are omitted rather than shown and quietly
 * corrected -- offering "This evening" at 11pm and silently meaning tomorrow
 * evening is the kind of small dishonesty that erodes trust in the feature.
 *
 * @param {number} now
 * @param {{deadline?:number}} ctx
 */
export function presets(now = Date.now(), ctx = {}) {
  const out = [];
  const d = new Date(now);
  const hour = d.getHours();

  if (hour < 18) out.push({ id: 'evening', label: 'This evening', at: at(d, 18) });
  out.push({ id: 'tomorrow', label: 'Tomorrow morning', at: startOfTomorrow(d, 8) });

  // Saturday 8am, unless it already is the weekend.
  const day = d.getDay(); // 0 Sun .. 6 Sat
  if (day !== 6 && day !== 0) {
    const sat = new Date(d);
    sat.setDate(sat.getDate() + (6 - day));
    out.push({ id: 'weekend', label: 'This weekend', at: at(sat, 8) });
  }

  const nextMon = new Date(d);
  nextMon.setDate(nextMon.getDate() + ((8 - day) % 7 || 7));
  out.push({ id: 'nextweek', label: 'Next week', at: at(nextMon, 8) });

  /*
   * OURS, NOT GMAIL'S. The deadline parser already extracted a date from this
   * message; waking the day before it is almost always what the user means
   * when they snooze a message that has a deadline in it.
   */
  if (ctx.deadline) {
    const before = new Date(ctx.deadline);
    before.setDate(before.getDate() - 1);
    const t = at(before, 8);
    if (t > now) out.push({ id: 'deadline', label: 'Day before the deadline', at: t });
  }

  return out.filter((p) => p.at > now);
}

/** @returns {Promise<Record<string, {at:number, snoozedAt:number}>>} */
export async function loadSnoozed(storage = STORAGE) {
  try {
    const got = (await storage.get(KEY)) || {};
    const raw = got[KEY];
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export async function addSnooze(id, wakeAt, storage = STORAGE, now = Date.now()) {
  // A past-due snooze is due on the next tick and vanishes -- the presets
  // filter `> now`; the writer must enforce the same contract (B-09).
  if (!Number.isFinite(wakeAt) || wakeAt <= now) return null;
  const all = await loadSnoozed(storage);
  all[id] = { at: wakeAt, snoozedAt: now };
  try {
    await storage.set({ [KEY]: all });
  } catch {
    return null;
  }
  return all;
}

export async function removeSnooze(id, storage = STORAGE) {
  const all = await loadSnoozed(storage);
  if (!(id in all)) return all;
  delete all[id];
  try {
    await storage.set({ [KEY]: all });
  } catch {
    // Best effort.
  }
  return all;
}

/**
 * Everything whose wake time has passed.
 *
 * Called on the alarm AND on every startup. The startup call is the one that
 * makes a missed alarm survivable.
 */
export function due(all, now = Date.now()) {
  return Object.entries(all)
    /*
     * Number.isFinite, not typeof === 'number' (fuzz round 3, 2026-08-14,
     * defect #5): a damaged row carrying `at: -Infinity` passes the old
     * check and reports due IMMEDIATELY -- the message is silently
     * unsnoozed the moment it is snoozed, which is exactly the "lost mail"
     * failure this module's header swears to prevent. NaN and +Infinity
     * fail `<= now` on their own; only -Infinity escapes, but the guard
     * must be total because the stored blob is not.
     */
    .filter(([, v]) => v && Number.isFinite(v.at) && v.at <= now)
    .map(([id]) => id);
}

/**
 * The next alarm instant for the worker's one wake alarm, or null when
 * nothing is armed (audit 2026-08-15, AUD-L1).
 *
 * `scheduleWake` in background/index.js used to reduce the stored wake
 * times with a `typeof t === 'number'` filter — and NaN is a number. A
 * damaged row (the store is untyped; fuzz round 3 proved the family lives)
 * sailed through to `chrome.alarms.create({ when: NaN })` AFTER the modify
 * that produced it had already succeeded: no alarm, no error, and the
 * snooze looked armed while nothing could ever wake it.
 *
 * Same law as due()/pending(): the guard is Number.isFinite, total, at the
 * boundary. The floor is the second half of the law — Chrome fires
 * past-dated alarms immediately and repeatedly, so "later" is expressed
 * as now + 5s, never as a bare `next` that may sit in the past.
 */
export function nextWakeAt(all, now = Date.now()) {
  let next = Infinity;
  for (const v of Object.values(all || {})) {
    const t = v?.at;
    // Not typeof: NaN and the Infinities are numbers and are not wake times.
    if (!Number.isFinite(t)) continue;
    if (t < next) next = t;
  }
  if (next === Infinity) return null;
  return Math.max(next, now + 5000);
}

/** Still asleep, soonest first -- the order the Snoozed view should show. */
export function pending(all, now = Date.now()) {
  return Object.entries(all)
    /*
     * Same fuzz-5 guard as due(): a row with `at: Infinity` passes
     * `> now` forever, so it lists in the Snoozed view with a wake label
     * computed from an infinite instant ("Invalid Date"). An unbounded
     * deferral is indistinguishable from loss; drop the row instead of
     * displaying a lie.
     */
    .filter(([, v]) => v && Number.isFinite(v.at) && v.at > now)
    .sort((a, b) => a[1].at - b[1].at)
    .map(([id, v]) => ({ id, at: v.at }));
}

/** "in 3 hours", "tomorrow", "on 14 Mar" -- the same voice as the radar. */
export function wakeLabel(wakeAt, now = Date.now()) {
  /* Fuzz round 3 defect #5: a non-finite instant formats as "Invalid Date"
   * (or "in Infinity hours"); a label helper must be total and never show
   * either. Display modules return '' for garbage (display.js contract);
   * this one does the same. */
  if (!Number.isFinite(wakeAt) || !Number.isFinite(now)) return '';
  const ms = wakeAt - now;
  if (ms <= 0) return 'now';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'tomorrow';
  if (days < 7) return `in ${days} days`;
  return new Date(wakeAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
