/**
 * Reset registry — the self-registering test seam (roadmap Phase 3, M-2).
 *
 * RESPONSIBILITY  One place where every stateful cached module registers its
 *                 test reset, and one call that runs them all.
 * OWNS            the registry map only.
 * DOES NOT OWN    any reset logic — each module keeps its own `_reset*`.
 * DEPENDS ON      nothing (leaf module: registering must never create an
 *                 import edge back into what is being registered).
 *
 * WHY THIS EXISTS
 * ---------------
 * app.js is re-imported per test boot with a cache-busting URL, but every
 * other module is CACHED — so module-level state outlives a boot. The
 * integration harness used to capture each module's `_reset*` by hand and
 * call each one in restore(). That worked until it didn't: round 54's
 * layers incident was exactly a forgotten seam, and the failure was silent
 * and order-dependent.
 *
 * Self-registration inverts the obligation: a stateful module that wants to
 * survive test isolation registers ITSELF at import time, and the harness
 * calls ONE function. Forgetting a seam is still possible, but now the
 * registry test lists who registered and the omission shows up as a named
 * gap instead of a haunted test three files away.
 */

const resets = new Map();

/** Register this module's reset. Idempotent per name (modules are cached). */
export function registerReset(name, fn) {
  resets.set(name, fn);
}

/** Run every registered reset. One broken reset must not strand the rest. */
export function resetAll() {
  for (const fn of resets.values()) {
    try { fn(); } catch { /* a broken seam must not mask the real result */ }
  }
}

/** Who registered — the registry test reads this to spot omissions. */
export function registeredResets() {
  return [...resets.keys()];
}
