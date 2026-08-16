/**
 * The rule engine.  (Features 73, 74, and the matching half of 36.)
 *
 * WHAT WAS HERE BEFORE
 * --------------------
 * `rules.js` supports exactly two behaviours, both keyed on a CATEGORY: mute
 * it, or auto-archive it. That is a useful pair and it is also the entire
 * automation story -- fifteen categories times two verbs. Anything else the
 * user wants ("archive the placement digest but not the shortlists", "star
 * anything from my instructor") has to be done by hand, every time, forever.
 *
 * This module replaces that ceiling with `condition -> actions`, where the
 * condition is the QUERY LANGUAGE the product already has and the actions are
 * the verbs the bulk path already knows how to undo.
 *
 * THE TWO DESIGN CHOICES THAT MATTER
 *
 * 1. THE CONDITION IS A QUERY STRING, NOT A FORM.
 *
 *    A builder UI with dropdowns for field/operator/value is the conventional
 *    approach and it would have needed its own serialisation, its own
 *    validation and its own evaluator -- a second, weaker copy of `query.js`.
 *    Storing the query string means a rule is exactly as expressive as the
 *    search box, `-from:bot` and `(a OR b)` work on day one because feature 48
 *    already shipped them, and the user can PASTE A SEARCH THEY JUST RAN.
 *
 *    The cost is that a rule can be broken by a typo. That is what `dryRun`
 *    is for.
 *
 * 2. NOTHING RUNS WITHOUT A DRY RUN AVAILABLE.
 *
 *    The elimination audit was explicit: a rule engine without its dry run is
 *    "a feature that silently archives mail from a Dean", and the two must
 *    ship in the same commit. So `dryRun` is not a debug helper bolted on the
 *    side -- it is the same code path `apply` uses, with the effects returned
 *    instead of dispatched. They cannot disagree, because there is only one
 *    matcher.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 *
 * It does not touch the network and it does not touch the store. It decides
 * WHAT should happen and returns a plan; the caller dispatches it through the
 * existing bulk path, which already batches, rolls back and records one undo
 * entry. Keeping the decision pure is what makes every case here testable
 * without booting jsdom.
 */

import { dueAtOfNow } from './deadline-store.js';
import { parseQuery } from '../search/query.js';
import { STORAGE } from '../../platform/storage.js';

const KEY = 'automationRules';

/** Actions a rule may take. Deliberately small. */
export const ACTIONS = /** @type {const} */ ([
  'archive',
  'star',
  'markRead',
  'label',
  'category',
  'pin',
  'skipInbox',
]);

/** Actions that need a value (a label name, a category id). */
const NEEDS_VALUE = new Set(['label', 'category']);

/**
 * Actions that MUTATE THE MAILBOX rather than local state.
 *
 * Split out because these are the ones that need a network round trip, need
 * an undo entry, and are the reason the dry run exists. A rule that only sets
 * a local flag is recoverable by deleting the rule; a rule that archives is
 * not.
 */
export const DESTRUCTIVE = new Set(['archive', 'markRead', 'skipInbox']);

/**
 * @typedef {Object} Rule
 * @property {string} id
 * @property {string} name
 * @property {string} query        condition, in the search grammar
 * @property {Array<{type:string, value?:string}>} actions
 * @property {boolean} enabled
 * @property {number} created
 * @property {boolean} [stopProcessing]  do not evaluate later rules on a match
 */

/** A stable id that does not need crypto and does not collide in practice. */
function makeId() {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Coerce anything into a valid rule list. Never throws.
 *
 * Same discipline as `normaliseRules`: storage is shared with older versions
 * and a value written by a previous schema must never crash the current one.
 */
export function normaliseRuleList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.query !== 'string' || !r.query.trim()) continue;

    const actions = Array.isArray(r.actions)
      ? r.actions
          .filter((a) => a && typeof a === 'object' && ACTIONS.includes(a.type))
          .filter((a) => !NEEDS_VALUE.has(a.type) || (typeof a.value === 'string' && a.value))
          .map((a) => ({ type: a.type, ...(a.value ? { value: String(a.value) } : {}) }))
      : [];
    // A rule with no valid actions is not a rule. Keeping it would show an
    // enabled row in the editor that provably does nothing.
    if (actions.length === 0) continue;

    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : makeId(),
      name: typeof r.name === 'string' && r.name ? r.name : r.query,
      query: r.query,
      actions,
      enabled: r.enabled !== false,
      created: Number.isFinite(r.created) ? r.created : Date.now(),
      stopProcessing: r.stopProcessing === true,
    });
  }
  return out;
}

export async function loadRuleList(storage = STORAGE) {
  try {
    const got = (await storage.get(KEY)) || {};
    return normaliseRuleList(got[KEY]);
  } catch {
    return [];
  }
}

export async function saveRuleList(rules, storage = STORAGE) {
  try {
    await storage.set({ [KEY]: normaliseRuleList(rules) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a rule from loose input, filling defaults.
 *
 * Exposed so the "create a rule from this message" path (feature 75) does not
 * have to know the record shape.
 */
export function makeRule(spec) {
  /* Total, like emptyRules()/emptyState() (round 10, I-1 / M-1). Destructuring
     the parameter list threw "Cannot destructure property 'name' of
     'undefined'"; normaliseRuleList then rejects the empty spec and this
     returns null, which is the outcome the signature already promised. */
  const { name, query, actions, enabled = true, stopProcessing = false } = spec || {};
  const [built] = normaliseRuleList([
    { id: makeId(), name, query, actions, enabled, created: Date.now(), stopProcessing },
  ]);
  return built || null;
}

/**
 * Is this rule's condition actually valid?
 *
 * A query that parses to nothing matches EVERY message, which for an archive
 * rule means "archive the entire inbox". That is the single most dangerous
 * input this module can receive, so it is rejected as invalid rather than
 * treated as a wildcard. If someone genuinely wants a catch-all they can write
 * one that says so.
 *
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function validateRule(rule) {
  if (!rule || typeof rule.query !== 'string' || !rule.query.trim()) {
    return { ok: false, reason: 'A rule needs a condition.' };
  }
  const parsed = parseQuery(rule.query, Date.now(), { dueAtOf: dueAtOfNow });
  if (parsed.isEmpty || (!parsed.predicate && parsed.terms.length === 0)) {
    return {
      ok: false,
      reason: 'That condition matches every message. Narrow it before saving.',
    };
  }
  if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
    return { ok: false, reason: 'A rule needs at least one action.' };
  }
  for (const a of rule.actions) {
    if (!ACTIONS.includes(a?.type)) return { ok: false, reason: `Unknown action: ${a?.type}` };
    if (NEEDS_VALUE.has(a.type) && !a.value) {
      return { ok: false, reason: `The "${a.type}" action needs a value.` };
    }
  }
  return { ok: true };
}

/**
 * Turn a query into a predicate that also honours free text.
 *
 * `parseQuery` splits into `terms` (for the store's inverted index) and a
 * `predicate`. A rule is evaluated against ONE message at a time with no index
 * available, so the terms have to be checked here or `from:x urgent` would
 * silently ignore the word "urgent" -- matching more mail than the user asked
 * for, in an engine whose whole risk is matching too much.
 */
export function compileCondition(query, now = Date.now()) {
  const parsed = parseQuery(query, now, { dueAtOf: dueAtOfNow });
  const terms = parsed.terms.map((t) => t.toLowerCase());
  const pred = parsed.predicate;

  return (m) => {
    if (pred && !pred(m)) return false;
    if (terms.length === 0) return true;
    const hay = `${m.subject || ''} ${m.from || ''} ${m.snippet || ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  };
}

/**
 * Which of these ids does a query match?
 *
 * This is also the matching half of feature 36 ("archive all 37 from this
 * sender"): the bulk-by-rule UI asks this, shows the count, and only then
 * dispatches. One matcher for both features means the preview count and the
 * actual operation can never disagree.
 *
 * @param {string} query
 * @param {string[]} ids
 * @param {(id:string)=>object|undefined} get
 */
export function idsMatching(query, ids, get, now = Date.now()) {
  const test = compileCondition(query, now);
  const out = [];
  for (const id of ids) {
    const m = get(id);
    if (m && test(m)) out.push(id);
  }
  return out;
}

/**
 * Evaluate every enabled rule against one message.
 *
 * @returns {{actions:Array<{type:string,value?:string}>, matched:string[]}}
 *   the MERGED action set and the ids of the rules that fired.
 */
export function evaluate(rules, msg, now = Date.now()) {
  /* Total, like normaliseRuleList (round 10, I-1 / M-2). The module defended
     its loader and not its evaluator, so a caller that skipped normalisation
     threw "rules is not iterable" inside the ingest path -- where the honest
     answer to "no rules" is "no actions". */
  if (!Array.isArray(rules)) rules = [];
  const actions = [];
  const matched = [];
  const seen = new Set();

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!validateRule(rule).ok) continue; // a broken rule does nothing, silently to the mailbox but visibly in the editor
    if (!compileCondition(rule.query, now)(msg)) continue;

    matched.push(rule.id);
    for (const a of rule.actions) {
      // De-duplicate: two rules both saying "archive" is one archive.
      const key = `${a.type}:${a.value || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      actions.push(a);
    }
    if (rule.stopProcessing) break;
  }

  return { actions, matched };
}

/**
 * What WOULD this rule do to the messages I already have?  (Feature 74.)
 *
 * Runs against the local corpus, which is capped at MAX_MESSAGES = 2000, so it
 * is instant and needs no network. Returns the sample as well as the count,
 * because a bare number ("this matches 312 messages") is not enough
 * information to approve an archive rule -- the user needs to see WHICH.
 *
 * @param {Rule} rule
 * @param {string[]} ids
 * @param {(id:string)=>object|undefined} get
 * @param {{sample?:number, now?:number}} [opts]
 */
export function dryRun(rule, ids, get, { sample = 12, now = Date.now() } = {}) {
  const check = validateRule(rule);
  if (!check.ok) return { ok: false, reason: check.reason, count: 0, ids: [], sample: [] };

  const matchedIds = idsMatching(rule.query, ids, get, now);

  return {
    ok: true,
    count: matchedIds.length,
    ids: matchedIds,
    sample: matchedIds.slice(0, sample).map((id) => {
      const m = get(id);
      return { id, from: m?.from, subject: m?.subject, date: m?.date };
    }),
    destructive: rule.actions.some((a) => DESTRUCTIVE.has(a.type)),
    /*
     * A rule matching most of the mailbox is nearly always a mistake -- a
     * missing operator, or a term so common it matches everything. Surfaced as
     * a warning rather than blocked, because occasionally it is intended.
     */
    warning:
      ids.length > 0 && matchedIds.length / ids.length > 0.5
        ? `This matches ${matchedIds.length} of ${ids.length} messages. Check the condition.`
        : null,
  };
}

/**
 * Group a plan by action so the caller can issue one batch per verb.
 *
 * The bulk path takes (verb, ids). Dispatching per message would be N requests
 * and N undo entries; per verb it is one of each, which is the difference
 * between an undoable operation and an unusable one.
 *
 * @param {Array<{id:string, actions:Array<{type:string,value?:string}>}>} plans
 * @returns {Array<{type:string, value?:string, ids:string[]}>}
 */
export function batchPlan(plans) {
  /** @type {Map<string, {type:string, value?:string, ids:string[]}>} */
  const groups = new Map();
  for (const { id, actions } of plans) {
    for (const a of actions) {
      const key = `${a.type}:${a.value || ''}`;
      if (!groups.has(key)) {
        groups.set(key, { type: a.type, ...(a.value ? { value: a.value } : {}), ids: [] });
      }
      groups.get(key).ids.push(id);
    }
  }
  return [...groups.values()];
}

/**
 * Plan the rule application for a batch of incoming messages.
 *
 * Called at ingest. Returns a plan; the caller dispatches and logs it.
 */
export function planFor(rules, messages, now = Date.now()) {
  const plans = [];
  const fired = new Map(); // ruleId -> count, for the audit log
  for (const m of messages) {
    const { actions, matched } = evaluate(rules, m, now);
    if (actions.length === 0) continue;
    plans.push({ id: m.id, actions, matched });
    for (const r of matched) fired.set(r, (fired.get(r) || 0) + 1);
  }
  return { plans, batches: batchPlan(plans), fired: Object.fromEntries(fired) };
}
