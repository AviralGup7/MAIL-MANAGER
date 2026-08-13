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

// One listener PER WINDOW, not one globally: the product has exactly one
// document, but tests mint a fresh jsdom window per case — a global latch
// would send every later window's pointermoves into a dead window's void
// (caught by the era-handoff pin failing only in full-file order).
const listeningWins = new WeakSet();

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
  // Remember the field's claim: settling at a NON-ZERO offset is the whole
  // point of magnetism (the element holds against the cursor); only a rest
  // AT ORIGIN may erase the ink. (Fix cycle 2 — the first draft zeroed
  // state at every settle, so "hold" flashed back to home.)
  t.tx = tx; t.ty = ty;
  const mkAxis = (axis, set) => animateValue({
    from: t[axis],
    to: set,
    preset: SPRINGS.WHISPER, // ambient: dead settle, no bounce toward a cursor
    onUpdate: (v) => { t[axis] = v; writeTransform(t); },
    onRest: () => {
      t[axis === 'x' ? 'hx' : 'hy'] = null;
      if (t.hx || t.hy) return;
      if (t.tx === 0 && t.ty === 0) { t.x = 0; t.y = 0; }
      writeTransform(t);
    },
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
  const win = el.ownerDocument.defaultView || globalThis;
  if (!listeningWins.has(win)) {
    listeningWins.add(win);
    listening = true;
    win.addEventListener('pointermove', onPointerMove, { passive: true });
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

/**
 * HAND THE TRANSFORM OVER, mid-flight, without leaving the field. press.js
 * calls this on pointerdown: the step loop already skips [data-pressing]
 * for FUTURE frames, but springs scheduled before the press would keep
 * writing over the press era (measured in the P3 live probe: Compose ended
 * a press at translate3d(0,0,0) — the magnetic rest write outliving the
 * press's own rest). Cancel + zero + erase; the registration STAYS, so the
 * element re-engages on the next pointermove after release.
 */
export function yieldTransform(el) {
  for (const t of [...__targets]) {
    if (t.el !== el) continue;
    t.hx?.cancel(); t.hy?.cancel();
    t.hx = null; t.hy = null;
    t.x = 0; t.y = 0; t.tx = 0; t.ty = 0;
    writeTransform(t);
  }
}
