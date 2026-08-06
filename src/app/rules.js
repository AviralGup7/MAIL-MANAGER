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

import { addressOf } from './contacts.js';

const KEY = 'categoryRules';

/**
 * @typedef {Object} Rules
 * @property {string[]} muted           category ids hidden from the inbox
 * @property {string[]} autoArchive     category ids archived on arrival
 * @property {Record<string,string>} corrections  sender address -> category
 */

/** @returns {Rules} */
export function emptyRules() {
  return { muted: [], autoArchive: [], corrections: {} };
}

/** Coerce whatever is in storage into a usable shape. Never throws. */
export function normaliseRules(raw) {
  const out = emptyRules();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (Array.isArray(raw.muted)) out.muted = raw.muted.filter((x) => typeof x === 'string');
  if (Array.isArray(raw.autoArchive)) {
    out.autoArchive = raw.autoArchive.filter((x) => typeof x === 'string');
  }
  if (raw.corrections && typeof raw.corrections === 'object' && !Array.isArray(raw.corrections)) {
    for (const [k, v] of Object.entries(raw.corrections)) {
      if (typeof k === 'string' && typeof v === 'string') out.corrections[k.toLowerCase()] = v;
    }
  }
  return out;
}

export async function loadRules(storage = chrome.storage.local) {
  try {
    const got = (await storage.get(KEY)) || {};
    return normaliseRules(got[KEY]);
  } catch {
    return emptyRules();
  }
}

export async function saveRules(rules, storage = chrome.storage.local) {
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
  const category = rules.corrections[addr];
  if (!category || category === msg.category) return msg;
  return { ...msg, category, confidence: 1, source: 'you', reason: 'You filed this sender here' };
}

/** Ids to hide from the inbox list because their category is muted. */
export function filterMuted(rules, messages) {
  if (!rules.muted.length) return messages;
  const muted = new Set(rules.muted);
  return messages.filter((m) => !muted.has(m.category));
}

/** How many messages a set of rules is currently hiding. */
export function mutedCount(rules, messages) {
  if (!rules.muted.length) return 0;
  const muted = new Set(rules.muted);
  let n = 0;
  for (const m of messages) if (muted.has(m.category)) n++;
  return n;
}
