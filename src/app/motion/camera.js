/**
 * The camera (directive §8/§10; animation overhaul P4). One virtual camera
 * lives on #shell (perspective: 1200px since P2); pushes and pulls are
 * SCENE moves — the whole chrome recedes a touch while an overlay owns the
 * eye. This is what makes "open the palette" read as camera work rather
 * than a rectangle appearing.
 *
 * Honesty notes:
 *  - the scene move is TRANSFORM + two paint-cheap channels (brightness,
 *    saturate); no blur filter — a full-surface blur costs a repainted
 *    frame per tick on 1200px×800 of bitmap, which is the bad kind of
 *    expensive (§42: spectacular, never pegged)
 *  - the translateZ depth planes exist for CHILDREN; the scene itself
 *    scales, because pushing a perspective container on Z would scale-
 *    crop the edges
 *  - push levels NEST as data (palette over compose = deeper scene), and
 *    every level unwinds through the same spring — reversal mid-push is
 *    the whole point of the spine
 */

import { SPRINGS, reducedMotion } from './tokens.js';
import { animateValue } from './spring.js';

/** Depth per push level: scale sinks 1.5%, brightness a breath. */
const DEPTH = { scale: 0.985, brightness: 0.97, saturate: 0.99 };

let shell = null;
let level = 0;
let cur = { scale: 1, bright: 1, sat: 1 };
let handle = null;

function target() {
  // Geometric per level: two pushes recede twice as much as one, not double.
  return {
    scale: DEPTH.scale ** level,
    bright: DEPTH.brightness ** level,
    sat: DEPTH.saturate ** level,
  };
}

function write(c) {
  if (!shell) return;
  if (c.scale === 1 && c.bright === 1 && c.sat === 1) {
    shell.style.transform = '';
    shell.style.filter = '';
    shell.style.willChange = '';
    return;
  }
  shell.style.transform = `scale(${c.scale.toFixed(5)})`;
  shell.style.filter = `brightness(${c.bright.toFixed(4)}) saturate(${c.sat.toFixed(4)})`;
  shell.style.willChange = 'transform, filter';
}

function drive() {
  if (!shell) return;
  if (handle) { handle.cancel(); handle = null; }
  const t = target();
  if (reducedMotion()) {
    // Reduced motion still recedes — depth is STRUCTURE, not theatre — but
    // arrives in one synchronous write.
    cur = t;
    write(cur);
    return;
  }
  // Re-baseline from the CURRENT pose on every level change: pose
  // continuity is exact and a mid-flight push-then-pop never mis-frames
  // (a normalized retarget would interpolate from a stale start).
  const start = { ...cur };
  handle = animateValue({
    from: 0,
    to: 1,
    preset: SPRINGS.HEFT,
    onUpdate: (p) => {
      cur = {
        scale: start.scale + (t.scale - start.scale) * p,
        bright: start.bright + (t.bright - start.bright) * p,
        sat: start.sat + (t.sat - start.sat) * p,
      };
      write(cur);
    },
    onRest: () => {
      handle = null;
      cur = t;
      write(cur); // exact rest — at home this erases all inline ink
    },
  });
}

/** Take the scene one level DEEPER (overlay opened). */
export function cameraPush(root = document.getElementById('shell')) {
  shell = shell || root;
  level++;
  drive();
}

/** Come back one level (overlay closed). Floors at level 0 — a caller
 *  pairing bug can never shrink the app. */
export function cameraPop() {
  if (level === 0) return;
  level--;
  drive();
}

/** Test/harness read: the applied pose and level. */
export function cameraState() {
  return { level, ...cur };
}

/** Test seam: sever the cached shell so a new document can rebind. */
export function _resetCameraForTest() {
  shell = null;
  level = 0;
  cur = { scale: 1, bright: 1, sat: 1 };
  handle = null;
}
