/**
 * Motion tokens — the single source of truth for the app's physical
 * vocabulary (animation overhaul P2; spec: audits/ANIMATION-INTERACTION-AUDIT.md §3.1).
 *
 * WHY CONSTANTS, NOT PROSE: before this module the app had four bespoke
 * cubic-beziers used once each and ~50 transitions on the browser-default
 * ease — every surface invented its own physics. The four presets below are
 * the ONLY masses this app has. Anything that moves picks one, so a button
 * and a panel feel like objects from the same universe, and the whole
 * language can be retuned in one place.
 *
 * The overshoot character of each preset is PINNED in
 * test/motion-spring.test.mjs against the doc's ζ-derived bands.
 */

export const SPRINGS = Object.freeze({
  /** T1 ambient: instant settle, ≤1% overshoot — invisible on opacity/lift. */
  WHISPER: Object.freeze({ stiffness: 420, damping: 34, mass: 1 }),
  /** T2 microinteraction: fast, ~5% overshoot. */
  SNAP: Object.freeze({ stiffness: 360, damping: 26, mass: 1 }),
  /** T3 component: deliberate, ~8% overshoot. */
  PANEL: Object.freeze({ stiffness: 240, damping: 20, mass: 1.1 }),
  /** T4/T5: cinematic arrive, one gentle ~10% bounce. */
  HEFT: Object.freeze({ stiffness: 170, damping: 18, mass: 1.4 }),
});

/**
 * The reduced-motion gate, read LIVE. The CSS file-end guard owns styles;
 * this owns the JS spring loop — both must agree, and both must react to a
 * system-toggle mid-session. matchMedia is absent in node/jsdom, where the
 * default is motion-for-everything (tests opt into reduction explicitly).
 */
const mq =
  typeof globalThis.matchMedia === 'function'
    ? globalThis.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

/** Test seam: force the gate. null restores the live media query. */
let forced = null;
export function _setReducedForTest(v) { forced = v; }

export function reducedMotion() {
  if (forced !== null) return forced;
  return !!mq?.matches;
}

// Live re-check: if the user flips the OS toggle mid-session, the very next
// spring tick already reads the new truth — no listener fan-out needed
// because reducedMotion() is consulted per frame, not cached per animation.
mq?.addEventListener?.('change', () => { /* value is read per frame */ });
