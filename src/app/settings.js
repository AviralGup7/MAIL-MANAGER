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
  // ---- appearance ----
  theme: { type: 'string', def: 'daylight' },
  density: { type: 'enum', def: 'comfortable', values: ['comfortable', 'compact'] },

  // ---- reading ----
  /*
   * Remote images. Blocking by default is a STRONGER privacy position than
   * Gmail's, which proxies by default and still confirms the read to the
   * sender through cache timing. See audit C-3.
   */
  remoteImages: { type: 'enum', def: 'ask', values: ['ask', 'always', 'never'] },
  markReadOnOpen: { type: 'bool', def: true },
  /*
   * Delay before a message opened in the reader is marked read. A mis-click
   * should not consume the unread state, which is the one bit of triage the
   * user cannot reconstruct. Gmail marks read almost instantly and is worse
   * for it. 0 restores Gmail's behaviour for anyone who wants it.
   */
  markReadDelayMs: { type: 'int', def: 1200, min: 0, max: 10000 },

  // ---- composing ----
  signature: { type: 'string', def: '' },
  undoSendSeconds: { type: 'int', def: 8, min: 0, max: 30 },

  // ---- sync ----
  autoSyncMinutes: { type: 'int', def: 5, min: 0, max: 60 },

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
export async function loadSettings(storage = chrome.storage.local) {
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

/** Synchronous read. Returns the schema default before `loadSettings` runs. */
export function get(key) {
  if (!(key in SCHEMA)) throw new Error(`Unknown setting: ${key}`);
  if (!loaded || !cache.has(key)) return SCHEMA[key].def;
  return cache.get(key);
}

/** Write one setting. Cache updates before the storage round trip. */
export async function set(key, value, storage = chrome.storage.local) {
  if (!(key in SCHEMA)) throw new Error(`Unknown setting: ${key}`);
  const v = coerce(key, value);
  const prev = cache.get(key);
  if (prev === v) return v;
  cache.set(key, v);
  emit(key, v);
  try {
    await storage.set({ [key]: v });
  } catch {
    // The in-memory value stands for this session; it simply will not persist.
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
export async function reset(key, storage = chrome.storage.local) {
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
