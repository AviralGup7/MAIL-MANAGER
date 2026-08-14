/**
 * Category rules: mute, auto-archive, and classifier corrections.
 *
 * WHY THIS IS THE FEATURE GMAIL CANNOT COPY
 * -----------------------------------------
 * Gmail's mute is per-thread and its block is per-sender. Neither maps onto
 * what a student actually wants to say, which is "I do not care about club
 * mail during exam weeks". Gmail cannot offer that because Gmail has no idea
 * what BITS mail is; this product classifies every message into one of fifteen
 * categories before it is ever displayed.
 *
 * So the same classification that powers the sidebar powers a triage rule
 * engine, at essentially no additional cost.
 *
 * THREE RULE KINDS
 *
 *   MUTE          hide the category from the inbox list. The mail is still
 *                 there, still in its category, still searchable -- it just
 *                 stops competing for attention. Reversible instantly, and
 *                 nothing is ever deleted.
 *
 *   AUTO-ARCHIVE  actually remove it from the inbox in Gmail. Stronger, and
 *                 destructive-adjacent, so it is opt-in per category and
 *                 reports what it did rather than acting silently.
 *
 *   CORRECTION    the user says "this sender is not Events, it is Academics".
 *                 Stored per sender address and applied BEFORE the generated
 *                 rules, so a correction always wins.
 *
 * WHY CORRECTIONS MATTER MORE THAN THEY LOOK
 * The classifier is validated against a data pack, not against real accuracy,
 * because no labelled corpus of real BITS mail exists. Corrections are both
 * the fix for a wrong bucket AND the mechanism that generates that corpus.
 */

import { addressOf } from '../core/contacts.js';
import { STORAGE } from '../../platform/storage.js';

const KEY = 'categoryRules';

/**
 * @typedef {Object} Rules
 * @property {string[]} muted           category ids hidden from the inbox
 * @property {string[]} autoArchive     category ids archived on arrival
 * @property {Record<string,string>} corrections  sender address -> category
 */

/** @returns {Rules} */
export function emptyRules() {
  return { muted: [], autoArchive: [], corrections: {}, mutedThreads: [] };
}

/** Coerce whatever is in storage into a usable shape. Never throws. */
export function normaliseRules(raw) {
  const out = emptyRules();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (Array.isArray(raw.muted)) out.muted = raw.muted.filter((x) => typeof x === 'string');
  if (Array.isArray(raw.autoArchive)) {
    out.autoArchive = raw.autoArchive.filter((x) => typeof x === 'string');
  }
  if (Array.isArray(raw.mutedThreads)) {
    out.mutedThreads = raw.mutedThreads.filter((x) => typeof x === 'string');
  }
  if (raw.corrections && typeof raw.corrections === 'object' && !Array.isArray(raw.corrections)) {
    for (const [k, v] of Object.entries(raw.corrections)) {
      if (typeof k !== 'string' || typeof v !== 'string') continue;
      /*
       * defineProperty, never `out.corrections[key] = v` (fuzz round 3,
       * 2026-08-14, defect #10a): a corrections key of '__proto__' (a
       * sender literally named that; addressOf needs no '@') goes through
       * the prototype SETTER. With a string value the assignment is
       * silently ignored -- the user's correction vanishes on every
       * load/save round-trip. Backup import carries this map verbatim, so
       * a hostile backup can also plant it. Defining an own data property
       * keeps every other key byte-identical.
       */
      Object.defineProperty(out.corrections, k.toLowerCase(), {
        value: v, writable: true, enumerable: true, configurable: true,
      });
    }
  }
  /*
   * Resolve muted-vs-autoArchive contradictions in favour of muted (fuzz
   * round 3, defect #14). The UI toggles keep the two lists mutually
   * exclusive -- toggleMute drops the archive rule and vice versa -- but a
   * blob arriving from storage/backup can carry BOTH for the same
   * category, which would hide the category locally AND archive it
   * upstream: mail that leaves no trace anywhere. Local-hide wins because
   * it is the reversible half (unmute restores the view; unarchiving mail
   * that Gmail already archived needs a second trip upstream).
   */
  if (out.muted.length && out.autoArchive.length) {
    const muted = new Set(out.muted);
    out.autoArchive = out.autoArchive.filter((c) => !muted.has(c));
  }
  return out;
}

export async function loadRules(storage = STORAGE) {
  try {
    const got = (await storage.get(KEY)) || {};
    return normaliseRules(got[KEY]);
  } catch {
    return emptyRules();
  }
}

export async function saveRules(rules, storage = STORAGE) {
  try {
    await storage.set({ [KEY]: normaliseRules(rules) });
    return true;
  } catch {
    return false;
  }
}

/** Toggle membership of a string list, returning a NEW rules object. */
function toggleIn(rules, field, value) {
  const set = new Set(rules[field]);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  return { ...rules, [field]: [...set] };
}

export function toggleMute(rules, category) {
  const next = toggleIn(rules, 'muted', category);
  /*
   * Muting and auto-archiving the same category is contradictory: one hides
   * it locally and the other removes it upstream. Muting therefore clears any
   * auto-archive rule, rather than leaving two rules that disagree.
   */
  if (next.muted.includes(category)) {
    next.autoArchive = next.autoArchive.filter((c) => c !== category);
  }
  return next;
}

export function toggleAutoArchive(rules, category) {
  const next = toggleIn(rules, 'autoArchive', category);
  if (next.autoArchive.includes(category)) {
    next.muted = next.muted.filter((c) => c !== category);
  }
  return next;
}

export function isMuted(rules, category) {
  return rules.muted.includes(category);
}

export function isAutoArchived(rules, category) {
  return rules.autoArchive.includes(category);
}

/*
 * Address parsing lives in contacts.js, which owns the concept. Re-exported
 * so existing callers keep working, rather than keeping a fourth copy of a
 * rule that was already duplicated three times.
 *
 * Imported AND re-exported: `export { x } from` alone creates no local
 * binding, so the three internal callers below would throw at runtime.
 */
export { addressOf };

/**
 * Record that a sender belongs in a different category than the classifier
 * decided. Keyed on the bare address, because the display name changes.
 */
export function correctSender(rules, from, category) {
  const addr = addressOf(from);
  if (!addr) return rules;
  return { ...rules, corrections: { ...rules.corrections, [addr]: category } };
}

export function clearCorrection(rules, from) {
  const addr = addressOf(from);
  const next = { ...rules.corrections };
  delete next[addr];
  return { ...rules, corrections: next };
}

/**
 * Apply a correction to a classified message.
 *
 * Runs AFTER the classifier and overrides it: a user who has explicitly said
 * where a sender belongs should not have to say it again. `source` is marked
 * so the reader can show that this was a human decision rather than a rule
 * match, and confidence is 1 because the user is not guessing.
 */
export function applyCorrection(rules, msg) {
  const addr = addressOf(msg.from);
  /*
   * Own-read + string check (fuzz round 3, 2026-08-14, defect #4): the
   * sender string is attacker-controlled -- 'constructor', '__proto__',
   * 'hasOwnProperty' all parse as addresses without needing an '@'. A
   * plain `rules.corrections[addr]` walks the PROTOTYPE chain on a miss,
   * so a message "From: Evil <constructor>" would be classified with
   * category = the Object constructor, poisoning every downstream switch
   * and the persisted category. The normalised map holds only string
   * values, but applyCorrection is also reachable with a caller-built
   * rules object, so the type check is not redundant with the loader.
   */
  const category =
    rules.corrections && Object.hasOwn(rules.corrections, addr)
      ? rules.corrections[addr]
      : undefined;
  if (typeof category !== 'string' || !category || category === msg.category) return msg;
  return { ...msg, category, confidence: 1, source: 'you', reason: 'You filed this sender here' };
}

/** Ids to hide from the inbox list because their category is muted. */
export function filterMuted(rules, messages) {
  const muted = new Set(rules.muted);
  const threads = new Set(rules.mutedThreads || []);
  if (!muted.size && !threads.size) return messages;
  return messages.filter((m) => !muted.has(m.category) && !threads.has(m.threadId));
}

/* ========================================================================== *
 * THREAD MUTE  (Feature 83)
 * ========================================================================== *
 *
 * WHY A THIRD MUTE KIND RATHER THAN REUSING THE CATEGORY ONE
 *
 * Category mute answers "I do not care about club mail". It cannot answer the
 * far more common campus problem, which is ONE THREAD going runaway: eighty
 * replies to a hostel mailing list, all in `administration`, where muting the
 * category would also silence the mess-timing notice you actually need.
 *
 * Gmail has this and it is one of its genuinely good features. The difference
 * here is that our mute is LOCAL and reversible with no API call, so muting a
 * thread by mistake costs nothing.
 *
 * WHAT MUTING A THREAD DOES AND DOES NOT DO
 *
 *   does:      hides every message in the thread from the inbox list
 *   does not:  delete, archive, mark read, or touch Gmail in any way
 *
 * The mail stays searchable, stays in its category, and reappears the instant
 * the mute is lifted. Same guarantee category mute already makes: a feature
 * that HIDES mail must never be able to hide it WITHOUT TRACE.
 */

/** Mute or unmute one conversation. Returns a NEW rules object. */
export function toggleThreadMute(rules, threadId) {
  if (!threadId) return rules;
  const set = new Set(rules.mutedThreads || []);
  if (set.has(threadId)) set.delete(threadId);
  else set.add(threadId);
  return { ...rules, mutedThreads: [...set] };
}

export function isThreadMuted(rules, threadId) {
  return !!threadId && (rules.mutedThreads || []).includes(threadId);
}

/**
 * How many messages are hidden by thread mutes specifically.
 *
 * Reported separately from `mutedCount` so the "N hidden" affordance can say
 * WHICH rule is hiding things. A single merged number leaves the user unable
 * to tell whether to unmute a category or a conversation.
 */
export function mutedThreadCount(rules, messages) {
  const threads = new Set(rules.mutedThreads || []);
  if (!threads.size) return 0;
  let n = 0;
  for (const m of messages) if (threads.has(m.threadId)) n++;
  return n;
}

/**
 * Forget mutes for threads that are no longer in the mailbox.
 *
 * Without this the list grows forever: every thread ever muted stays in
 * storage even after the conversation has been deleted, and the blob becomes
 * a slow leak. Called after a full sync, when the live thread set is known.
 */
export function pruneThreadMutes(rules, liveThreadIds) {
  const live = liveThreadIds instanceof Set ? liveThreadIds : new Set(liveThreadIds);
  const kept = (rules.mutedThreads || []).filter((t) => live.has(t));
  if (kept.length === (rules.mutedThreads || []).length) return rules;
  return { ...rules, mutedThreads: kept };
}

/** How many messages the CATEGORY mutes are hiding. Threads are counted separately. */
export function mutedCount(rules, messages) {
  if (!rules.muted.length) return 0;
  const muted = new Set(rules.muted);
  let n = 0;
  for (const m of messages) if (muted.has(m.category)) n++;
  return n;
}

/**
 * What an auto-archive rule WOULD say yes to, today.
 *
 * The dry-run mirror of main.js's ingest filter — the SAME three terms
 * (category, unread, not search-stamped), in one exported place, so the
 * preview the menu shows before the flip can never drift from what the
 * pipeline will actually do at ingest. If the filter grows a fourth term,
 * it grows it here too, or the preview lies.
 *
 * Pure and exported for tests; returns a count and up to `cap` sample
 * subjects so the dialog can name examples without rendering a list.
 */
export function autoArchiveMatchSet(messages, category, cap = 3) {
  let count = 0;
  const samples = [];
  for (const m of messages) {
    if (!m || m.category !== category || !m.unread || m.fromSearch) continue;
    count++;
    if (samples.length < cap) {
      samples.push(String(m.subject || '(no subject)').slice(0, 60));
    }
  }
  return { count, samples };
}
