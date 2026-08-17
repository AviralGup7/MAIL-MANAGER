/**
 * Press physics (directive §3/§22/§23; animation overhaul P3).
 *
 * A press is a complete physical cycle, never a color swap:
 *
 *   pointerdown → 3.5% compression + 1px sink (SAME FRAME — acknowledgement
 *                 must not wait for a spring frame)
 *   hold        → the spring tracks the target; long holds feel compressed
 *   release     → spring back FROM LIVE VELOCITY with SNAP's ~5% overshoot;
 *                 the button visibly recovers, which is what "mass" means
 *   cancel/leave→ the same retarget — the surface is never abandoned
 *                 mid-compression
 *
 * ONE WRITER RULE: while an element is pressing it carries data-pressing,
 * and magnetic.js refuses it — transform ownership is exclusive, era by
 * era. Hover lift lives on the separate `translate` CSS property, so CSS
 * hover and JS press compose instead of fighting over one string.
 *
 * Reduced motion: no springs, no compression, and the element behaves
 * exactly as it did before this module existed.
 */

import { SPRINGS, reducedMotion } from './tokens.js';
import { animateValue } from './spring.js';
import { yieldTransform } from './magnetic.js';

/** Per-element press state. WeakMap: rows come and go; never a leak. */
const yours = new WeakMap();

/**
 * Make an element physically pressable.
 *
 * @param {Element} el
 * @param {Object} [opts]
 * @param {number} [opts.depth=0.035]  scale compression at full press
 * @param {number} [opts.sink=1]       px of downward travel at full press
 */
export function makePressable(el, opts = {}) {
  if (!el || yours.has(el)) return;
  const depth = opts.depth ?? 0.035;
  const sink = opts.sink ?? 1;

  let spring = null;

  const write = (s, y) => {
    el.style.transform = s === 1 && y === 0 ? '' : `scale(${s.toFixed(4)}) translateY(${y.toFixed(2)}px)`;
  };

  const release = () => {
    const cur = spring;
    if (!cur) return;
    // The release IS the recovery: retarget to rest, carrying velocity.
    // No new animation, no state wipe — one of the directive's hard rules.
    cur.retarget(0);
  };

  const down = (e) => {
    // Primary button only; a right-press is not a press.
    if (e.isPrimary === false || (e.button != null && e.button !== 0)) return;
    if (reducedMotion()) return;
    if (el.getAttribute('aria-disabled') === 'true' || el.disabled) return;

    el.dataset.pressing = '1';
    // Claim the transform era from the magnetic field: its in-flight
    // springs would otherwise out-write this press's rest frame.
    yieldTransform(el);
    // Capture the pointer: without it, press-drag-release-OUTSIDE never
    // fires this element's pointerup and the button stays compressed
    // forever. Guarded — jsdom does not implement capture.
    try { el.setPointerCapture?.(e.pointerId); } catch { /* capture is a nicety, not a gate */ }
    // Immediate acknowledgement, one task, before any rAF can land.
    write(1 - depth, sink);
    yours.get(el).lastDown = Date.now();

    if (spring) spring.cancel();
    const from = 0; // channel: 0 = rest, 1 = fully pressed
    spring = animateValue({
      from,
      to: 1,
      preset: SPRINGS.SNAP,
      velocity: 3.4, // arriving "already moving" removes the dead 40ms
      onUpdate: (p) => {
        // p runs 1 → 0 on release; small overshoot below 0 = the bounce
        // back through rest, which is exactly the spring-recovery beat.
        const inv = 1 - p;
        write(inv - depth * p, sink * p);
      },
      onRest: () => {
        spring = null;
        write(1, 0);
        delete el.dataset.pressing;
        el.style.willChange = '';
      },
    });
    el.style.willChange = 'transform';
  };

  const up = () => release();

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
  yours.set(el, { down, up, lastDown: 0 });
}

/** For tests: is this element mid-press? */
export function isPressing(el) {
  if (!el?.dataset) return false;
  return Object.prototype.hasOwnProperty.call(el.dataset, 'pressing');
}
