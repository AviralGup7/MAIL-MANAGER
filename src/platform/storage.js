/**
 * Platform seam — the one module that owns `chrome.*` access (audit 39/40
 * ARCH R-7).
 *
 * WHY: every module used to default its injectable storage parameter to the
 * bare `chrome.storage.local`. That scattered the permission surface across
 * the tree and gave the test doubles ~20 distinct chrome mocks to agree on.
 * This module is the single definition of "the storage we use", so:
 *
 *   - the permission surface is greppable in one place,
 *   - every module keeps its injectable parameter (tests still pass a fake),
 *     but the DEFAULT now comes from here,
 *   - a future storage backend change (e.g. IndexedDB for the cache) has one
 *     seam to swap instead of fifty.
 *
 * `chrome.storage` may be absent in some test globals; the getters return
 * undefined and the caller's injectable parameter is what tests actually use.
 */

/** The extension's local storage area. */
export function localArea() {
  return globalThis.chrome?.storage?.local;
}

/** The memory-only session area, when the browser provides it. */
export function sessionArea() {
  return globalThis.chrome?.storage?.session || localArea();
}

/** Default storage for modules that persist per-install data.
 *
 * A live-binding GETTER, not a captured object: the module default
 * `storage = STORAGE` runs at CALL time, so it always resolves to the
 * current globalThis.chrome.storage.local — the integration harness swaps
 * `globalThis.chrome` per boot, and a captured area would leak the first
 * test's mock into every later one.
 */
export const STORAGE = new Proxy(/** @type {any} */ ({}), {
  get(_t, prop) {
    const area = localArea();
    // Methods must keep `this` = the area, or `storage.get` called through
    // the proxy loses its receiver and throws on `this`-sensitive mocks.
    const v = area ? area[prop] : undefined;
    return typeof v === 'function' ? v.bind(area) : v;
  },
});

/** Default storage for the OAuth token (session-preferred, local fallback). */
export const TOKEN_STORAGE = sessionArea;
