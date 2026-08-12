import { STORAGE } from '../platform/storage.js';

/**
 * Settings.
 *
 * WHY THIS IS A MODULE AND NOT A FEW `storage.get` CALLS
 * -----------------------------------------------------
 * Before this file there was exactly one preference (`clientId`) and it was
 * read with an ad-hoc `chrome.storage.local.get('clientId')` at the point of
 * use. That pattern does not survive ten preferences: every new one adds
 * another scattered read, another place to forget the default, and another
 * chance for `undefined` to reach a render path and be treated as `false`.
 *
 * So: ONE schema, ONE default per key, ONE typed accessor. A key that is not
 * in the schema cannot be read or written, which means a typo fails loudly
 * here instead of silently returning `undefined` three layers away.
 *
 * DESIGN
 *
 *   - Settings are CACHED in memory after first load. The render path reads
 *     them synchronously (`get`), because making the reader `await` a
 *     preference to decide how to draw is how you get a flash of the wrong
 *     layout.
 *
 *   - Writes are async and notify subscribers. The cache updates FIRST, so a
 *     read immediately after a write returns the new value even though the
 *     storage round trip has not finished.
 *
 *   - Values are COERCED to the schema's type on read. Storage is shared with
 *     older versions of this extension, and a value written by a previous
 *     schema must never crash the current one.
 */

/**
 * @typedef {'bool'|'int'|'enum'|'string'} SettingType
 * @typedef {{type:SettingType, def:any, values?:string[], min?:number, max?:number}} Setting
 */

/** @type {Record<string, Setting>} */
export const SCHEMA = {
  /*
   * WHAT IS *NOT* HERE, AND WHY
   *
   * `density`, `undoSendSeconds` and `autoSyncMinutes` were declared here
   * before anything read them. `density` has since been IMPLEMENTED and is
   * back below; the other two are still absent and still specified rather than
   * stubbed. A schema entry is a PROMISE: `undoSendSeconds:
   * 8` states that undo-send exists and is configurable, when no undo-send
   * feature existed anywhere in the codebase.
   *
   * That is worse than an absent setting, because the next reader believes it.
   * The same mistake as the six dead CSS tokens, and as `LIST_LABELS` --
   * "unfinished" reads as "implemented but unsurfaced".
   *
   * They were removed rather than stubbed. They are specified in
   * audits/08-GMAIL-COMPETITIVE-V2.md and each returns HERE on the commit that
   * implements it, not before. A test enforces this.
   *
   * `density` returned when the token remap shipped. `undoSendSeconds` returns
   * on THIS commit, which routes sending through the outbox -- the hold window
   * is the feature, and it is now real. `autoSyncMinutes` is still absent and
   * still specified rather than stubbed.
   */

  // ---- appearance ----
  theme: { type: 'string', def: 'daylight' },
  /*
   * Density. Returned to the schema by the commit that implements it, as the
   * note below promised.
   *
   * `comfortable` is byte-identical to the pre-feature rendering, so an
   * existing profile sees no change until it asks for one.
   */
  density: { type: 'enum', def: 'comfortable', values: ['comfortable', 'cosy', 'compact'] },

  // ---- sending ----
  /*
   * How long a sent message is HELD before it actually goes.
   *
   * 0 disables undo-send entirely, which is a legitimate preference: some
   * people would rather the mail leave immediately than wait five seconds for
   * a safety net they never use. `outbox.enqueue` treats a 0 hold as "due
   * now", so the queue path is identical either way -- there is no separate
   * unqueued branch to drift.
   */
  undoSendSeconds: { type: 'int', def: 5, min: 0, max: 30 },

  // ---- reading ----
  /*
   * Remote images. Blocking by default is a STRONGER privacy position than
   * Gmail's, which proxies by default and still confirms the read to the
   * sender through cache timing. See audit C-3.
   */
  remoteImages: { type: 'enum', def: 'ask', values: ['ask', 'always', 'never'] },
  markReadOnOpen: { type: 'bool', def: true },
  /*
   * Conversation threading. On by default, because a five-part exchange
   * scattered across the list is the single most common way this product
   * looked less capable than Gmail.
   *
   * A setting rather than a hard rule: some people genuinely prefer a flat
   * chronological list, and the store keeps both views cheap -- `order` is the
   * flat one and `rootIds()` is the collapsed one, from the same index.
   */
  threaded: { type: 'bool', def: true },
  /*
   * Triage lanes: group the list by what needs doing rather than by date.
   *
   * OFF by default. A flat, date-ordered list is what a mail client IS, and
   * grouping is an opinion -- a strong one, and one worth offering, but not
   * one to impose on someone who opened their inbox expecting Gmail.
   */
  lanes: { type: 'bool', def: false },
  coachDone: { type: 'bool', def: false },
  /*
   * THE CONTEXT RAIL (V3). Whether the right rail (due soon / needs you /
   * snoozed / outbox) is visible. ON by default: the rail is where the
   * sidebar's overflow context moved to, and a first-run user should see
   * what the classifier found without having to discover a toggle.
   */
  railOpen: { type: 'bool', def: true },
  /*
   * Delay before a message opened in the reader is marked read. A mis-click
   * should not consume the unread state, which is the one bit of triage the
   * user cannot reconstruct. Gmail marks read almost instantly and is worse
   * for it. 0 restores Gmail's behaviour for anyone who wants it.
   */
  markReadDelayMs: { type: 'int', def: 1200, min: 0, max: 10000 },
  /*
   * AUTO-REFRESH. How often to ask Gmail what changed, in ms.
   *
   * This product used to say "Delta refresh. Never on a timer", which made it
   * a mail VIEWER: new mail appeared only when you pressed `r`. A mail client
   * that does not receive mail on its own is not a mail client.
   *
   * 120s is a deliberate middle. A delta is one cheap request against a
   * stored historyId, not a page fetch, so the cost is small -- but Gmail
   * enforces per-user rate limits and a tab left open all day still adds up.
   * 0 disables it, for anyone who genuinely wants manual control.
   */
  autoRefreshMs: { type: 'int', def: 120000, min: 0, max: 3600000 },
  // P-3: notify on augsd/academics mail when it arrives while the app is
  // closed. The worker reads this key directly from storage; the schema is
  // where the default lives so options and app agree.
  bgNotify: { type: 'bool', def: true },

  // ---- composing ----
  signature: { type: 'string', def: '' },

  // ---- auth ----
  clientId: { type: 'string', def: '' },
};

const cache = new Map();
const listeners = new Set();
let loaded = false;

function coerce(key, raw) {
  const s = SCHEMA[key];
  if (!s) return undefined;
  if (raw === undefined || raw === null) return s.def;
  switch (s.type) {
    case 'bool':
      return typeof raw === 'boolean' ? raw : s.def;
    case 'int': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return s.def;
      return Math.min(s.max ?? Infinity, Math.max(s.min ?? -Infinity, Math.round(n)));
    }
    case 'enum':
      return s.values?.includes(raw) ? raw : s.def;
    case 'string':
      return typeof raw === 'string' ? raw : s.def;
    default:
      return s.def;
  }
}

/** Load every known setting into the synchronous cache. Call once at boot. */
export async function loadSettings(storage = STORAGE) {
  const keys = Object.keys(SCHEMA);
  let stored = {};
  try {
    stored = (await storage.get(keys)) || {};
  } catch {
    // Storage unavailable (private mode, quota, tests): every value falls back
    // to its default rather than leaving the app unable to render.
    stored = {};
  }
  for (const key of keys) cache.set(key, coerce(key, stored[key]));
  loaded = true;
  return snapshot();
}

/**
 * Follow settings changed by ANOTHER extension page.
 *
 * WHY THIS IS NECESSARY AND `subscribe()` IS NOT ENOUGH
 * ----------------------------------------------------
 * `subscribe()` notifies listeners in THIS page when THIS page calls `set()`.
 * The options page is a separate extension page with its own module instances,
 * so nothing it writes can reach an in-process listener -- and `subscribe()`
 * had no callers at all, which made the gap invisible.
 *
 * Meanwhile `get()` is a synchronous read of a cache filled once by
 * `loadSettings()` at boot. The result was that turning off "mark read on
 * open" in Options changed nothing in the already-open mail tab: it kept
 * marking mail read until the tab was reloaded, with no indication why.
 *
 * `chrome.storage.onChanged` is the only channel that crosses pages. Values
 * are put through `coerce` exactly as `loadSettings` does, so a hand-edited
 * or corrupt stored value cannot enter the cache by this back door in a shape
 * `loadSettings` would have rejected.
 *
 * @returns {() => void} unsubscribe, for tests and teardown
 */
export function followExternalChanges(area = chrome?.storage) {
  const onChanged = area?.onChanged;
  // Degrades silently: the app must still run where this API is unavailable.
  if (!onChanged?.addListener) return () => {};

  const handler = (changes, areaName) => {
    if (areaName && areaName !== 'local') return;
    for (const key of Object.keys(changes || {})) {
      if (!(key in SCHEMA)) continue; // not ours; the cache holds only schema keys
      const value = coerce(key, changes[key].newValue);
      if (cache.get(key) === value) continue; // no change, no notification
      cache.set(key, value);
      emit(key, value);
    }
  };

  onChanged.addListener(handler);
  return () => onChanged.removeListener?.(handler);
}

/** Synchronous read. Returns the schema default before `loadSettings` runs. */
export function get(key) {
  if (!(key in SCHEMA)) throw new Error(`Unknown setting: ${key}`);
  if (!loaded || !cache.has(key)) return SCHEMA[key].def;
  return cache.get(key);
}

/** Write one setting. Cache updates before the storage round trip. */
export async function set(key, value, storage = STORAGE) {
  if (!(key in SCHEMA)) throw new Error(`Unknown setting: ${key}`);
  const v = coerce(key, value);
  const prev = cache.get(key);
  if (prev === v) return v;
  cache.set(key, v);
  emit(key, v);
  try {
    await storage.set({ [key]: v });
  } catch (err) {
    /*
     * ROLL BACK AND SAY SO (bug-hunt 43 #17). The old behaviour kept the
     * in-memory value and said nothing -- the user changed a setting, it
     * "took", and it silently reverted at next boot. The write is the
     * authoritative operation: if it fails, the cache goes back, the
     * subscribers hear about the reversion, and the caller gets an error it
     * can surface.
     */
    cache.set(key, prev);
    emit(key, prev);
    throw new Error(`SETTINGS_PERSIST_FAILED: ${key} (${err?.message || 'storage unavailable'})`);
  }
  return v;
}

/** Every setting as a plain object. */
export function snapshot() {
  const out = {};
  for (const key of Object.keys(SCHEMA)) out[key] = get(key);
  return out;
}

/** Restore one key to its schema default. */
export async function reset(key, storage = STORAGE) {
  return set(key, SCHEMA[key].def, storage);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(key, value) {
  for (const fn of listeners) {
    try {
      fn(key, value);
    } catch {
      // A broken subscriber must not prevent the others from being told.
    }
  }
}

/** Test seam: forget everything loaded so far. */
export function _reset() {
  cache.clear();
  loaded = false;
  listeners.clear();
}
