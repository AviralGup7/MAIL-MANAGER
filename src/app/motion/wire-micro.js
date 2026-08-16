/**
 * Microinteraction wiring (animation overhaul P3; audit doc §2 tier map).
 *
 * THE ONE WIRING TABLE. Which surfaces press, which attract, which ripple —
 * stated once, as data, so the physical language of the app is greppable in
 * a single screen. The primitives (press/magnetic/ripple) know nothing
 * about the product; this module knows nothing about physics.
 *
 * DELIBERATE EXCLUSIONS (pin-enforced — test/motion-micro.test.mjs):
 *  - .row            the roster owns a no-transform doctrine (the style bundle:1097)
 *                    and single-stop keyboard truth; nothing moves there
 *  - menus           snooze-opt/views-pop items: menu.js owns pointer and
 *                    roving focus; their choreography is P4's job
 *  - #search inputs  a compressing text field is a lie about geometry
 *  - the roster's radiance stays CSS (inset wash + selection rail already
 *    speak; the no-transform comment is respected, not overridden)
 *
 * No surface is double-wired: makePressable/attachMagnetic dedupe by
 * element (WeakMap/Set membership), so re-calling wireMicroInteractions is
 * a no-op — boot order may not create duplicates.
 */

import { makePressable } from './press.js';
import { attachMagnetic, detachMagnetic } from './magnetic.js';
import { spawnRipple } from './ripple.js';

/** Pressable = compress + recover. Selector → compression depth. */
const PRESS = [
  ['.primary', { depth: 0.045, sink: 1.2 }],       // Send, Compose: full body press
  ['.ghost', { depth: 0.03 }],                     // chrome verbs: lighter touch
  ['.cat', { depth: 0.025, sink: 0.5 }],           // nav: nearly austere
];

/** Magnetic = lean toward the cursor. Selector → {radius, strength}. */
const MAGNET = [
  ['#btn-compose', { radius: 64, strength: 0.32 }], // the one primary: strong pull
  ['#btn-refresh, #btn-views, #btn-help, #btn-rail', { radius: 40, strength: 0.18 }], // topbar: polite
  ['#side-foot .ghost', { radius: 36, strength: 0.15 }],
  ['.cat', { radius: 28, strength: 0.14 }],
];

/** Ripple = energy worth propagating (rare: primary + bulk verbs). */
const RIPPLE = ['#btn-compose, #c-send, #bulk-actions .ghost.icon'];

/** Surfaces that must NEVER receive motion wiring. */
export const EXCLUSIONS = ['.row', '.snooze-opt', '#views-pop :is(a, button)', '#search'];

const excluded = (el) => EXCLUSIONS.some((sel) => {
  try { return el.matches(sel) || el.closest(sel); } catch { return false; }
});

/**
 * Is the pointer-motion tier switched on right now? (round 7, 2026-08-16)
 *
 * Reads the RESOLVED decision published by applyVisualPrefs, never the raw
 * preference: `auto` is theme-dependent, and re-deriving that rule here
 * would be a second copy of it. A missing attribute means the surface has
 * not published yet (boot, tests), and the historical behaviour was ON, so
 * absence reads as on.
 */
function pointerMotionOn(root) {
  const doc = root?.ownerDocument || (root?.documentElement ? root : globalThis.document);
  const html = doc?.documentElement;
  return html?.getAttribute('data-pointer-motion') !== 'off';
}

export function wireMicroInteractions(root = document) {
  // Presence-gated: every surface listed may be absent in gate/tests.
  const all = (sel) => { try { return [...root.querySelectorAll(sel)]; } catch { return []; } };

  /*
   * OFF MEANS UNWIRE, NOT MERELY SKIP.
   *
   * This function re-runs on every settings change, so a user turning the
   * tier off mid-session must have existing magnetic fields RELEASED —
   * skipping the attach loop would leave already-attached elements pulling
   * forever. detachMagnetic restores the transform it borrowed, so an
   * element mid-approach returns home rather than freezing off-centre.
   *
   * Press and ripple need no teardown: press is per-event and stateless
   * between gestures, and the ripple listener checks the gate at spawn
   * time (below), so both simply stop responding.
   */
  if (!pointerMotionOn(root)) {
    for (const [sel] of MAGNET) for (const el of all(sel)) detachMagnetic(el);
    return;
  }

  for (const [sel, opts] of PRESS) {
    for (const el of all(sel)) if (!excluded(el)) makePressable(el, opts);
  }
  for (const [sel, opts] of MAGNET) {
    for (const el of all(sel)) if (!excluded(el)) attachMagnetic(el, opts);
  }

  // Ripple piggybacks the press: spawn on pointerdown at the press point.
  // One delegated listener — no per-element plumbing to leak.
  if (root.__rippleWired !== true) {
    root.__rippleWired = true;
    root.addEventListener('pointerdown', (e) => {
      // Gate at SPAWN, not at wire time: the listener is delegated and
      // registered once, so it must ask the current answer each time
      // rather than capture the answer it was born with.
      if (!pointerMotionOn(root)) return;
      const host = e.target?.closest?.(RIPPLE[0]);
      if (!host || excluded(host)) return;
      spawnRipple(host, e.clientX, e.clientY);
    }, { passive: true });
  }
}
