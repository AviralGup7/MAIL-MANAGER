/**
 * Particles (directive §15; animation overhaul P6; spec §3.4).
 *
 * ONE canvas, ONE pool, TWO verbs. This module exists for the moments the
 * tier system calls spectacular-but-rare: the gate assembling itself on
 * first paint, a send finishing, a deletion turning to dust. It is NOT a
 * permanent atmosphere system — the canvas is created on demand and REMOVED
 * when the last particle decays, so an idle app carries zero canvas, zero
 * rAF, zero listeners (§42's "no permanently running particle systems" made
 * structural: there is nothing running to forget to stop).
 *
 * HARD CAP 240 pooled particles, swap-remove, spawn-clamped — a caller
 * passing count:500 gets 240, and a burst during an assemble shares the
 * same pool rather than growing a second one.
 *
 * HONEST DECLINES (P4 doctrine; each returns 0, counts its refusal, leaves
 * no half-built canvas behind):
 *  - reduced motion (the reduced experience is complete without particles)
 *  - no 2d context (jsdom; old webviews)
 *  - no frame clock
 *
 * THE INK: the theme's own --glow, read once per canvas birth and
 * re-alphad. Particles are the ONLY theme-colored effect, and they get the
 * color from the same audited token the shadows use — no new color enters
 * the product, so the contrast gate's 6/6 AA is untouched by construction.
 */

import { reducedMotion } from './tokens.js';

/** Directive §42's "no runaway particle creation", as a number. */
const MAX = 240;

/** pool slots: x,y current · vx,vy velocity · tx,ty attract target (assemble)
 *  · life0/life seconds · size css-px · mode 0=burst 1=assemble */
const pool = [];
let alive = 0;

let canvas = null;
let ctx = null;
let rafId = 0;
let lastT = 0;
let ink = 'rgba(120, 130, 255, 0.9)';
let onResize = null;

/** Test telemetry (counters only, never authority). */
export const __fx = { spawned: 0, declined: 0, loops: 0, tornDown: 0 };

/** Test seam: supply a 2d-context factory (jsdom's canvas returns null). */
let ctxFactoryForTest = null;
export function _setContextFactoryForTest(fn) { ctxFactoryForTest = fn; }

/** Test read: the live pool positions (convergence pins measure, not trust). */
export function __pool() { return pool.slice(0, alive); }

function themeInk() {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--glow');
    const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(raw);
    if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, `; // alpha appended per particle
  } catch { /* best-effort */ }
  return 'rgba(120, 130, 255, ';
}

function ensureCanvas() {
  if (canvas) return true;
  const doc = globalThis.document;
  if (!doc) return false;
  const el = doc.createElement('canvas');
  el.className = 'fx-canvas';
  el.setAttribute('aria-hidden', 'true'); // decoration; AT never meets it
  // BODY, not #overlay-root: the canvas must NOT inherit #shell's camera
  // transform — a burst that scales 0.985 mid-push would read as the
  // particles belonging to the chrome. They are scene-free spectacle.
  doc.body?.appendChild(el);
  ctx = ctxFactoryForTest ? ctxFactoryForTest(el) : el.getContext?.('2d');
  if (!ctx) { el.remove(); return false; }
  canvas = el;
  ink = themeInk();
  sizeCanvas();
  onResize = () => sizeCanvas();
  globalThis.addEventListener?.('resize', onResize, { passive: true });
  return true;
}

function sizeCanvas() {
  if (!canvas) return;
  const vw = globalThis.innerWidth ?? 0;
  const vh = globalThis.innerHeight ?? 0;
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2); // 4K retina at 3x is the bad expensive
  canvas.width = Math.max(1, Math.round(vw * dpr));
  canvas.height = Math.max(1, Math.round(vh * dpr));
  canvas.style.width = `${vw}px`;
  canvas.style.height = `${vh}px`;
  ctx.setTransform?.(dpr, 0, 0, dpr, 0, 0);
}

function teardown() {
  if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
  rafId = 0;
  if (onResize) globalThis.removeEventListener?.('resize', onResize);
  onResize = null;
  canvas?.remove();
  canvas = null;
  ctx = null;
  __fx.tornDown++;
}

function spawn(p) {
  if (alive >= MAX) return false; // share, never grow (§42)
  pool[alive++] = p;
  __fx.spawned++;
  return true;
}

/** Clamp dt like the spring: a sleeping tab resumes without an energy spike. */
const DT_MAX = 1 / 20;

function step(dt) {
  for (let i = alive - 1; i >= 0; i--) {
    const p = pool[i];
    p.life -= dt;
    if (p.mode === 1) {
      // assemble: spring toward the contour point, drag settles it there.
      // Stiffness 18 / drag 6 (ζ≈0.71): numerically swept against the life
      // band 0.75-1.15s — 42% of the distance closed at 0.4s, 97% by 0.8s,
      // so the contour FORMS (and visibly locks) before the fade. The first
      // constants (6.4/4.4, then 10/4.4) stranded particles mid-flight: the
      // convergence pin exists because the eye would have caught it too.
      p.vx += (p.tx - p.x) * 18 * dt;
      p.vy += (p.ty - p.y) * 18 * dt;
      p.vx *= (1 - 6 * dt);
      p.vy *= (1 - 6 * dt);
    } else {
      // burst: launch impulse, mild gravity, drag
      p.vy += 150 * dt;
      p.vx *= (1 - 2.1 * dt);
      p.vy *= (1 - 2.1 * dt);
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.life <= 0) {
      pool[i] = pool[--alive]; // swap-remove: O(1), no allocation churn
      pool[alive] = undefined;
    }
  }
}

function draw() {
  const vw = globalThis.innerWidth ?? 0;
  const vh = globalThis.innerHeight ?? 0;
  ctx.clearRect(0, 0, vw, vh);
  for (let i = 0; i < alive; i++) {
    const p = pool[i];
    const t = Math.max(0, p.life / p.life0);
    ctx.globalAlpha = t * t; // quadratic fade: late-life drops fast, reads as dissolving
    ctx.fillStyle = ink + (p.mode === 1 ? 0.95 : 0.8) + ')';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * (p.mode === 1 ? t : 1), 0, 6.2832);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function loop(t) {
  rafId = 0;
  const dt = Math.min((t - lastT) / 1000, DT_MAX) || 1 / 60;
  lastT = t;
  step(dt);
  if (alive === 0) { teardown(); return; }
  draw();
  rafId = requestAnimationFrame(loop);
}

function kick() {
  if (!rafId) {
    __fx.loops++;
    lastT = (globalThis.performance?.now?.() ?? 0);
    rafId = requestAnimationFrame(loop);
  }
}

function decline() {
  __fx.declined++;
  return 0;
}

/**
 * A radial burst — success flash, delete dust. (cx, cy) in VIEWPORT px;
 * callers measure rects, this module knows no product.
 * @returns {number} particles actually spawned (pool share permitting)
 */
export function burst(cx, cy, { count = 40, speed = [140, 430] } = {}) {
  if (reducedMotion()) return decline();
  if (typeof requestAnimationFrame !== 'function') return decline();
  if (!ensureCanvas()) return decline();
  let n = 0;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = speed[0] + Math.random() * (speed[1] - speed[0]);
    const life0 = 0.5 + Math.random() * 0.45;
    if (!spawn({
      x: cx, y: cy, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      tx: 0, ty: 0, mode: 0, life0, life: life0,
      size: 1.4 + Math.random() * 2.2,
    })) break;
    n++;
  }
  if (n) kick();
  return n;
}

/**
 * Particles converge from off-screen onto a rect's contour, hold, dissolve —
 * the "assemble the object out of the air" moment (gate's first paint).
 * @param {{left:number, top:number, width:number, height:number}} rect
 */
export function assemble(rect, { count = 120 } = {}) {
  if (reducedMotion()) return decline();
  if (typeof requestAnimationFrame !== 'function') return decline();
  if (!ensureCanvas()) return decline();
  const vw = globalThis.innerWidth ?? 0;
  const vh = globalThis.innerHeight ?? 0;
  const per = 2 * (rect.width + rect.height) || 1;
  let n = 0;
  for (let i = 0; i < count; i++) {
    // Evenly walk the perimeter so the contour reads as the object arriving.
    let d = (i / count) * per;
    let tx, ty;
    if (d < rect.width) { tx = rect.left + d; ty = rect.top; }
    else if ((d -= rect.width) < rect.height) { tx = rect.left + rect.width; ty = rect.top + d; }
    else if ((d -= rect.height) < rect.width) { tx = rect.left + rect.width - d; ty = rect.top + rect.height; }
    else { d -= rect.width; tx = rect.left; ty = rect.top + rect.height - d; }
    const fromLeft = Math.random() < 0.5;
    const life0 = 0.75 + Math.random() * 0.4;
    if (!spawn({
      x: fromLeft ? -12 : vw + 12, y: Math.random() * vh,
      vx: 0, vy: 0, tx, ty, mode: 1, life0, life: life0,
      size: 1.3 + Math.random() * 1.9,
    })) break;
    n++;
  }
  if (n) kick();
  return n;
}

/** Test seam: full teardown + pool reset between cases. */
export function _resetFxForTest() {
  teardown();
  alive = 0;
  pool.length = 0;
  __fx.spawned = 0;
  __fx.declined = 0;
  __fx.loops = 0;
  __fx.tornDown = 0;
  ctxFactoryForTest = null;
}
