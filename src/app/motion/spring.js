/**
 * The spring — the one integrator every JS-driven motion routes through
 * (animation overhaul P2; spec §3.1/§3.5/§12 of the audit doc).
 *
 * WHY A SPRING AND NOT A CURVE: a cubic-bezier is a film — it plays from
 * t=0 and cannot be redirected without a visible cut. A spring is an
 * object — it has position AND velocity, so "user changed their mind
 * mid-flight" is a retarget from live (x, v), not a restart. That one
 * property is what makes rapid interaction feel expensive, and it is the
 * entire reversible-animation doctrine (directive §12) in a box.
 *
 * ARCHITECTURE: one shared rAF loop steps every live animation (semi-
 * implicit Euler; dt clamped so a backgrounded tab resumes without an
 * energy spike). Pure stepping is exported separately so node tests can
 * verify convergence, overshoot bands and retarget continuity without a
 * DOM or a frame clock.
 *
 * REDUCED MOTION (inviolable doctrine 0.1): reducedMotion() parks every
 * new animation at its target SYNCHRONOUSLY. The state was already true;
 * the pixels arrive in the same task.
 */

import { SPRINGS, reducedMotion } from './tokens.js';

/** Clamp per-step dt: a sleeping tab must not teleport on resume. */
const DT_MAX = 1 / 20; // 50ms

/** Rest thresholds — sub-pixel, sub-pixel-per-second. */
const X_EPS = 0.05;
const V_EPS = 0.5;

/**
 * One semi-implicit Euler step. Exported pure for tests.
 *
 * @returns {[number, number]} the stepped [position, velocity]
 */
export function springStep(x, v, target, spring, dt) {
  if (!spring) return { x, v };
  const { stiffness: k, damping: c, mass: m } = spring;
  // F = -k(x - target) - c·v
  const a = (-k * (x - target) - c * v) / m;
  const v2 = v + a * dt;
  const x2 = x + v2 * dt;
  return [x2, v2];
}

/** Settled means both slow AND close — either alone re-fires forever. */
export function isSettled(x, v, target) {
  return Math.abs(x - target) < X_EPS && Math.abs(v) < V_EPS;
}

/** @typedef {Object} AnimHandle
 * @property {(to:number, preset?:Object)=>void} retarget  redirect mid-flight, keeping velocity
 * @property {()=>void} cancel  silent stop — no onRest, no final write
 * @property {()=>number} velocity  live v, for gesture hand-off
 * @property {()=>boolean} running */

const live = new Set();
let rafId = 0;
let lastT = 0;

function tick(t) {
  const dt = Math.min((t - lastT) / 1000, DT_MAX);
  lastT = t;
  const reduced = reducedMotion();
  for (const a of [...live]) {
    if (reduced) {
      // OS toggle landed MID-FLIGHT: park at the target this frame. The
      // reduced contract is not "finish what you started", it is "motion
      // ends now".
      live.delete(a);
      a.onUpdate?.(a.target, 0);
      a.onRest?.();
      continue;
    }
    const [x2, v2] = springStep(a.x, a.v, a.target, a.spring, dt);
    a.x = x2;
    a.v = v2;
    if (isSettled(a.x, a.v, a.target)) {
      live.delete(a);
      a.onUpdate?.(a.target, 0);
      a.onRest?.();
    } else {
      a.onUpdate?.(a.x, a.v);
    }
  }
  if (live.size === 0) {
    rafId = 0;
    return; // the loop dies with its last animation — no idle rAF, ever
  }
  rafId = requestAnimationFrame(tick);
}

/**
 * Animate one scalar channel from `from` to `to` under a spring preset.
 *
 * onUpdate receives (x, v) every frame, INCLUDING one guaranteed call with
 * the exact target on settle (callers may round their DOM writes — the
 * resting state must still be exact).
 *
 * Under reduced motion: onUpdate(to) + onRest() fire synchronously and no
 * rAF is requested — the loop is as absent as the CSS guard is absolute.
 *
 * @returns {AnimHandle}
 */
export function animateValue({ from, to, preset = SPRINGS.SNAP, velocity = 0, onUpdate, onRest } = {}) {
  // No frame clock, no animation: an unschedulable spring IS its end state.
  // node consumers (menu tests through popFrom) hit exactly this path —
  // mirror of closeWithMotion's typeof-rAF guard in layers.js.
  if (reducedMotion() || typeof requestAnimationFrame !== 'function') {
    onUpdate?.(to, 0);
    onRest?.();
    return {
      retarget(_to2) { /* already at rest — nothing to redirect */ },
      cancel() {},
      velocity: () => 0,
      running: () => false,
    };
  }
  const a = {
    x: from, v: velocity, target: to,
    spring: preset, onUpdate, onRest,
  };
  live.add(a);
  if (!rafId) {
    lastT = performance.now();
    rafId = requestAnimationFrame(tick);
  }
  return {
    retarget(to2, preset2) {
      a.target = to2;
      if (preset2) a.spring = preset2;
      // x and v are deliberately NOT touched: reversal from live state is
      // the whole point (directive §12 — never restart, never cut).
      if (!rafId) {
        lastT = performance.now();
        rafId = requestAnimationFrame(tick);
      }
    },
    cancel() { live.delete(a); },
    velocity: () => a.v,
    running: () => live.has(a),
  };
}
