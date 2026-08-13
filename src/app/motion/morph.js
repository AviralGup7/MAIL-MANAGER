/**
 * Shared-element morphing — FLIP with a spring spine (directive §5/§6;
 * animation overhaul P4/P5; spec: audit doc §3.1).
 *
 * The identity-preserving transition: the SAME object transforms between
 * two geometric states instead of "A fades out, B fades in". Geometry is
 * captured as pure data (first), the layout change happens (last), and the
 * delta is inverted onto a transform (invert) that springs back to identity
 * (play). One normalized spring channel drives the composite — translate,
 * scale and corner-radius share ONE physical body, so interruption mid-
 * morph reverses the whole creature, not three unrelated tweens.
 *
 * Everything here is geometry + spring; measurement is separated from
 * writing so the math is unit-testable without a layout engine.
 */

import { SPRINGS, reducedMotion } from './tokens.js';
import { animateValue } from './spring.js';

/** @typedef {{x:number,y:number,w:number,h:number,r:number}} Box */

/** Capture an element's box as data. radius = top-right border-radius. */
export function measureBox(el) {
  const b = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { x: b.left, y: b.top, w: b.width, h: b.height, r: parseFloat(cs.borderTopRightRadius) || 0 };
}

/** Geometry interpolation — pure, exported for pins. */
export function lerpBox(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t,
    r: a.r + (b.r - a.r) * t,
  };
}

/**
 * Of all FLIP properties, transform writes are the only ones the roster's
 * no-layout doctrine permits. Compose the CSS for `ghost` at normalized
 * progress showing box `cur` anchored at... the ghost's own resting box
 * `base`. Progress 0 = ghost exactly covers `start`; 1 = at rest.
 * Returns the style triple OR null at rest (caller erases ink).
 * Pure.
 */
export function morphFrame(cur, base, t) {
  if (t >= 1) return null;
  // Guard degenerate sizes (hidden elements measure 0): scaling by 0/0 is
  // NaN poison; a missing dimension keeps scale 1 and only slides.
  const sx = base.w > 0 && cur.w > 0 ? cur.w / base.w : 1;
  const sy = base.h > 0 && cur.h > 0 ? cur.h / base.h : 1;
  const dx = cur.x - base.x;
  const dy = cur.y - base.y;
  return {
    transform: `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`,
    transformOrigin: '0 0',
    borderRadius: `${cur.r.toFixed(1)}px`,
  };
}

/**
 * Drive `ghostEl` from box `from` to its own resting position, PANEL-spring
 * by default. The ghost must not intercept input (the REAL surface owns the
 * pointer the whole time — theatre never eats clicks).
 *
 * @returns {{cancel:()=>void, running:()=>boolean}}
 */
export function morphGhost(ghostEl, from, opts = {}) {
  const preset = opts.preset || SPRINGS.PANEL;
  if (reducedMotion()) return { cancel() {}, running: () => false };

  ghostEl.style.pointerEvents = 'none';
  const base = measureBox(ghostEl);
  // First frame already at the start pose — no flash-of-destination.
  const f0 = morphFrame(from, base, 0);
  ghostEl.style.transformOrigin = f0.transformOrigin;
  ghostEl.style.transform = f0.transform;
  if (opts.morphRadius !== false) ghostEl.style.borderRadius = f0.borderRadius;

  return animateValue({
    from: 0,
    to: 1,
    preset,
    onUpdate: (t) => {
      const cur = lerpBox(from, base, t);
      const f = morphFrame(cur, base, t);
      if (!f) return;
      ghostEl.style.transform = f.transform;
      if (opts.morphRadius !== false) ghostEl.style.borderRadius = f.borderRadius;
    },
    onRest: () => {
      // Rest erases every trace — resting CSS owns the element whole.
      ghostEl.style.transform = '';
      ghostEl.style.transformOrigin = '';
      ghostEl.style.borderRadius = '';
      ghostEl.style.pointerEvents = '';
      opts.onDone?.();
    },
  });
}

/**
 * Anchored pop — a popover grows out of the control that created it
 * (directive §35 "popover originates from the button"), velocity-reversible
 * by spring doctrine. Writes transform/opacity on the popup element only;
 * positioning stays with the owner.
 *
 * @param {Element} el       the popup (already visible)
 * @param {{x:number,y:number}} anchor  client point the pop grows FROM
 */
export function popFrom(el, anchor, opts = {}) {
  const preset = opts.preset || SPRINGS.PANEL;
  if (reducedMotion()) return { cancel() {}, running: () => false };

  const b = el.getBoundingClientRect();
  // The anchor can legitimately map OUTSIDE the popup (a right-clicked row
  // is full-width; the menu opens at the pointer, far from its centre) —
  // an unclamped percentage measured 45119% in the live probe, and the pop
  // swung in from another postal code. Clamp to the box with a 4% margin:
  // the pop still grows from the anchor's DIRECTION, never from deep space.
  const clampPct = (v) => Math.min(96, Math.max(4, v));
  const ox = clampPct(((anchor.x - b.left) / Math.max(1, b.width)) * 100);
  const oy = clampPct(((anchor.y - b.top) / Math.max(1, b.height)) * 100);
  el.style.transformOrigin = `${ox.toFixed(1)}% ${oy.toFixed(1)}%`;

  /*
   * The CSS entry animation (menu-in and friends) must be suspended for
   * the flight: an in-running CSS animation OUTRANKS inline transforms, so
   * the two co-writing reads as a skipped beat. Inline `animation: none`
   * wins our frames back; the rest handler restores the declarative world.
   * Under reduced motion popFrom never runs, so the declarative path is the
   * only path and the file-end guard squishes it, as ever.
   */
  const declaredAnim = el.style.animation;
  el.style.animation = 'none';

  // First pose synchronously — no flash of the destination before frame 1.
  // (Same formatting as onUpdate so a frame-diff never catches a haircut.)
  el.style.opacity = (0.2).toFixed(3);
  el.style.transform = `scale(${(0.86).toFixed(4)})`;

  return animateValue({
    from: 0,
    to: 1,
    preset,
    onUpdate: (t) => {
      const s = 0.86 + 0.14 * t;
      el.style.opacity = (0.2 + 0.8 * t).toFixed(3);
      el.style.transform = `scale(${s.toFixed(4)})`;
    },
    onRest: () => {
      el.style.transform = '';
      el.style.opacity = '';
      el.style.transformOrigin = '';
      el.style.animation = declaredAnim;
      opts.onDone?.();
    },
  });
}
