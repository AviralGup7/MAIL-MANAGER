/**
 * Magnetic attraction (directive §4; animation overhaul P3).
 *
 * Elements ease TOWARD the cursor inside an attraction radius and snap back
 * when it leaves — the "objects with mass greet you" cue. The pull is a
 * target the spring tracks, so the return is velocity-aware by
 * construction: leave the field mid-approach and the element turns around
 * from whatever it was doing.
 *
 * DISCIPLINE
 *  - pointer:fine only (a thumb cannot be magnetic; coarse gets nothing)
 *  - reduced motion: listeners NEVER attach
 *  - one writer: an element under data-pressing belongs to press.js; the
 *    field steps over it
 *  - one window pointermove listener coalesced through rAF; zero targets
 *    means zero listeners; the loop never spins idle
 */

import { SPRINGS, reducedMotion } from './tokens.js';
import { animateValue } from './spring.js';

const mqFine =
  typeof globalThis.matchMedia === 'function'
    ? globalThis.matchMedia('(pointer: fine)')
    : null;

/** Test seam: force pointer fineness. null restores the live query. */
let forcedFine = null;
export function _setFineForTest(v) { forcedFine = v; }

const pointerIsFine = () => (forcedFine !== null ? forcedFine : !!mqFine?.matches);

/** @type {Set<{el:Element, radius:number, strength:number, x:number, y:number, hx:Object|null, hy:Object|null}>} */
export const __targets = new Set();

let listening = false;
let lastClientX = 0;
let lastClientY = 0;
let scheduled = false;

function writeTransform(t) {
  if (t.x === 0 && t.y === 0) {
    t.el.style.transform = '';
    t.el.style.willChange = '';
  } else {
    t.el.style.transform = `translate3d(${t.x.toFixed(2)}px, ${t.y.toFixed(2)}px, 0)`;
    t.el.style.willChange = 'transform';
  }
}

function drive(t, tx, ty) {
  const mkAxis = (axis, set) => animateValue({
    from: t[axis],
    to: set,
    preset: SPRINGS.WHISPER, // ambient: dead settle, no bounce toward a cursor
    onUpdate: (v) => { t[axis] = v; writeTransform(t); },
    onRest: () => { t[axis === 'x' ? 'hx' : 'hy'] = null; if (!t.hx && !t.hy) { t.x = 0; t.y = 0; writeTransform(t); } },
  });
  if (!t.hx) t.hx = mkAxis('x', tx); else t.hx.retarget(tx);
  if (!t.hy) t.hy = mkAxis('y', ty); else t.hy.retarget(ty);
}

function step() {
  scheduled = false;
  if (!pointerIsFine() || reducedMotion()) return;
  for (const t of [...__targets]) {
    if (!t.el.isConnected) { __targets.delete(t); continue; }
    if (t.el.dataset.pressing) continue; // press.js owns the transform now
    const r = t.el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue; // hidden — no pull cost
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // Radius measured from the EDGE, not the centre: a big Compose pill and
    // a small icon button attract across the same air gap.
    const gapX = Math.max(0, Math.abs(lastClientX - cx) - r.width / 2);
    const gapY = Math.max(0, Math.abs(lastClientY - cy) - r.height / 2);
    const inside = Math.hypot(gapX, gapY) < t.radius;
    drive(t, inside ? (lastClientX - cx) * t.strength : 0,
             inside ? (lastClientY - cy) * t.strength : 0);
  }
}

function onPointerMove(e) {
  lastClientX = e.clientX;
  lastClientY = e.clientY;
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(step);
  }
}

/**
 * @param {Element} el
 * @param {Object} [opts]
 * @param {number} [opts.radius=48]    px of air (from the edge) where pull starts
 * @param {number} [opts.strength=0.3] share of the cursor gap travelled
 */
export function attachMagnetic(el, opts = {}) {
  if (!el || reducedMotion() || !pointerIsFine()) return;
  __targets.add({
    el,
    radius: opts.radius ?? 48,
    strength: opts.strength ?? 0.3,
    x: 0, y: 0, hx: null, hy: null,
  });
  if (!listening) {
    listening = true;
    (el.ownerDocument.defaultView || globalThis).addEventListener('pointermove', onPointerMove, { passive: true });
  }
}

/** Detach one element and return it to rest immediately (no fade-out). */
export function detachMagnetic(el) {
  for (const t of [...__targets]) {
    if (t.el === el) {
      t.hx?.cancel(); t.hy?.cancel();
      __targets.delete(t);
      t.x = 0; t.y = 0;
      writeTransform(t);
    }
  }
}
