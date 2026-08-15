/**
 * The offline banner (extracted from main.js, 2026-08-15 modularisation).
 *
 * WHY IT MOVED. main.js was 3,987 lines and the single choke point every
 * subsystem passed through. This block was one of the few genuinely SEPARABLE
 * seams in it: its whole surface is one DOM node, one module-level handle, and
 * two browser events. Nothing else in the shell reads `offlineBar`, and the
 * only outward calls are the two the shell must own — refreshing and draining
 * the outbox when the network returns — so they arrive as injected callbacks
 * rather than imports. That keeps the dependency pointing one way: the shell
 * knows about this module, this module knows nothing about the shell.
 *
 * WHY THE BANNER EXISTS AT ALL (carried over verbatim, because the reasoning
 * is the design):
 *
 * `navigator.onLine` appeared nowhere in this codebase, so a dropped
 * connection fell to the last branch of reportError() and surfaced as
 * `toast("Failed to fetch")` -- browser jargon, styled as INFORMATION rather
 * than a problem, gone in 2200ms.
 *
 * Three things wrong with that, and the third is the one that matters: offline
 * is not an event, it is a CONDITION. It lasts until the network returns, and
 * a transient toast is the wrong shape for something that is still true thirty
 * seconds later.
 *
 * The right idiom already existed. showWorkerWarning() renders a persistent
 * strip for degraded mode, and its own comment explains why: "a toast is for
 * something that just happened and then stops mattering, and this condition
 * lasts for the whole session." Offline is that condition and never got the
 * treatment.
 *
 * WHAT THE BANNER SAYS IS THE POINT. Not "you are offline" -- the user knows.
 * What they do not know is what still works, and on a campus network that
 * drops several times an hour that is the difference between waiting and
 * retrying by hand until they conclude the app is broken.
 *
 * OWNS            the #net-warn node and its lifecycle; the online/offline
 *                 listeners.
 * DOES NOT OWN    what happens when the network returns (the shell's
 *                 `onOnline` callback), or any mail state.
 */

import { registerReset } from '../core/reset-registry.js';

/** The live banner node, or null. Module-scoped: there is only ever one. */
let offlineBar = null;

/** True when the browser KNOWS it is offline.
 *
 * Feature-detected rather than assumed: jsdom has no `navigator.onLine`, and
 * a missing property must read as "online" (do not block the app) rather than
 * as falsy-therefore-offline.
 */
export function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function showOfflineBanner() {
  if (offlineBar || document.getElementById('net-warn')) return;

  const bar = document.createElement('div');
  bar.id = 'net-warn';
  // `alert`, not `status`: losing the connection is worth interrupting for.
  bar.setAttribute('role', 'alert');

  const text = document.createElement('span');
  text.className = 'sw-warn-text';
  text.textContent =
    'No connection — showing mail already downloaded. '
    + 'Anything you send is queued and goes out automatically when you are back.';

  bar.append(text);
  const main = document.getElementById('main');
  const panes = document.getElementById('panes');
  if (main && panes) main.insertBefore(bar, panes);
  else document.body.prepend(bar);
  offlineBar = bar;
}

export function hideOfflineBanner() {
  offlineBar?.remove();
  offlineBar = null;
}

/**
 * Bind the browser's connectivity events.
 *
 * @param {{onOnline?: () => void}} [handlers]
 *   `onOnline` is the shell's catch-up work — refresh and drain the outbox.
 *   Injected rather than imported so this module cannot reach back into the
 *   shell, which is the whole point of the extraction.
 *
 * IDEMPOTENT. The integration harness boots the shell repeatedly against a
 * fresh window, and a module cached across boots would otherwise stack a new
 * pair of listeners on every one — the classic extraction leak. The bound
 * window is remembered, so re-wiring the SAME window is a no-op and wiring a
 * NEW one starts clean.
 *
 * No Dismiss button, deliberately, unlike the worker banner. That one
 * describes a condition the user can do nothing about and may last the whole
 * session, so dismissing it is reasonable. This one clears itself the moment
 * the network returns -- a dismiss control would only let the user hide a
 * fact that is still true.
 */
let boundWindow = null;
/** @param {{onOnline?: () => void}} [handlers] */
export function wireOfflineBanner({ onOnline } = /** @type {any} */ ({})) {
  const win = globalThis.window;
  if (!win || boundWindow === win) return;
  boundWindow = win;
  win.addEventListener('offline', () => {
    showOfflineBanner();
  });
  win.addEventListener('online', () => {
    hideOfflineBanner();
    // Catch up immediately rather than waiting for the next scheduled poll,
    // and drain anything the outbox has been holding.
    onOnline?.();
  });
}

/**
 * Test seam: forget the bound window and drop any live banner.
 *
 * REGISTERED, NOT MERELY EXPORTED — and this cost a red CI shard.
 *
 * The harness re-imports main.js with a cache-busting query per boot, but
 * THIS module is cached like every other. So after boot #1, `boundWindow`
 * held a window that had since been closed: boot #2 saw a different window,
 * wired nothing... except the guard compared against the stale handle and
 * short-circuited, leaving the second boot with NO offline listeners at all.
 * The test passed alone and failed in sequence, which is the signature of
 * exactly this class of leak.
 *
 * The registry exists for this. Every cached stateful module registers its
 * reset here and the harness runs them all between boots, so the fix is to
 * join the convention rather than invent a private one.
 */
export function _resetOfflineBanner() {
  hideOfflineBanner();
  boundWindow = null;
}

registerReset('offline-banner', _resetOfflineBanner);
