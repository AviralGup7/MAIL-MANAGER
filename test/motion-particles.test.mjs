/**
 * Particles (animation overhaul P6; audit doc §3.4 row particles.js).
 *
 * WHY THESE PINS EXIST
 * --------------------
 * Directive §42 names the catastrophic failures by name: runaway particle
 * creation, unbounded DOM growth, permanently running systems. This module
 * is the one place those catastrophes COULD live — one canvas, one pool,
 * created on demand, REMOVED when the last particle decays. So the pins are
 * the negations: the cap holds under greedy callers, the loop dies with the
 * last particle, the canvas leaves the DOM, and every decline path (reduced
 * motion, no 2d context, no frame clock) is measured-honest rather than
 * half-built. Plus the one visual claim that matters: assemble CONVERGES.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { JSDOM } = await import('jsdom');

const tokens = await import('../src/app/motion/tokens.js');
const fx = await import('../src/app/motion/particles.js');

function fakeClock() {
  let queue = [];
  let t = 0;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancel = globalThis.cancelAnimationFrame;
  const prevPerf = globalThis.performance;
  globalThis.requestAnimationFrame = (fn) => { queue.push(fn); return queue.length; };
  globalThis.cancelAnimationFrame = () => { queue = []; };
  globalThis.performance = { now: () => t };
  return {
    frame(n = 1) { for (let i = 0; i < n; i++) { t += 1000 / 60; const q = queue; queue = []; for (const fn of q) fn(t); } },
    pending: () => queue.length,
    restore() {
      if (prevRaf === undefined) delete globalThis.requestAnimationFrame;
      else globalThis.requestAnimationFrame = prevRaf;
      if (prevCancel === undefined) delete globalThis.cancelAnimationFrame;
      else globalThis.cancelAnimationFrame = prevCancel;
      globalThis.performance = prevPerf;
    },
  };
}

/** The minimum 2d surface the engine touches. */
function stubCtx2d() {
  return {
    setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {},
    globalAlpha: 1, fillStyle: '',
  };
}

function setup() {
  const dom = new JSDOM('<body><div id="shell"></div></body>');
  const prev = {};
  for (const k of ['window', 'document', 'innerWidth', 'innerHeight']) prev[k] = globalThis[k];
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 860;
  const clock = fakeClock();
  fx._setContextFactoryForTest(stubCtx2d);
  return {
    dom,
    doc: dom.window.document,
    clock,
    canvas: () => dom.window.document.querySelector('canvas.fx-canvas'),
    restore() {
      fx._resetFxForTest();
      clock.restore();
      Object.assign(globalThis, prev);
      try { dom.window.close(); } catch { /* best effort */ }
    },
  };
}

test.afterEach(() => tokens._setReducedForTest(null));

test('the pool cap holds: a greedy burst gets 240, not 500', () => {
  const { clock, restore } = setup();
  try {
    const n = fx.burst(640, 430, { count: 500 });
    assert.equal(n, 240, '§42: share the pool, never grow it');
    assert.equal(fx.__pool().length, 240);
    clock.frame(3);
    assert.ok(fx.__pool().length <= 240, 'still bounded mid-flight');
  } finally {
    restore();
  }
});

test('mixed loads share ONE pool: burst + assemble together stay ≤ 240', () => {
  const { restore } = setup();
  try {
    fx.burst(640, 430, { count: 200 });
    const n = fx.assemble({ left: 100, top: 100, width: 200, height: 80 }, { count: 200 });
    assert.equal(n, 40, 'only the remaining 40 slots were available');
    assert.equal(fx.__pool().length, 240);
  } finally {
    restore();
  }
});

test('the loop dies with the last particle and the canvas LEAVES the DOM', () => {
  const { clock, canvas, restore } = setup();
  try {
    fx.burst(640, 430, { count: 30 });
    assert.ok(canvas(), 'canvas exists while particles live');
    const tornDownBefore = fx.__fx.tornDown;
    clock.frame(90); // 1.5s at 60fps — past every life0 (max 0.95s on burst)
    assert.equal(fx.__pool().length, 0, 'everything decayed');
    assert.equal(canvas(), null, 'no orphaned canvas (§42 DOM growth, negated)');
    assert.equal(clock.pending(), 0, 'no idle rAF spinning on nothing');
    assert.equal(fx.__fx.tornDown, tornDownBefore + 1, 'teardown ran exactly once');
  } finally {
    restore();
  }
});

test('life after death: a later burst re-creates and re-tears-down cleanly', () => {
  const { clock, canvas, restore } = setup();
  try {
    fx.burst(100, 100, { count: 5 });
    clock.frame(90);
    fx.burst(200, 200, { count: 5 });
    assert.ok(canvas(), 'second birth happens on demand');
    clock.frame(90);
    assert.equal(canvas(), null, 'second death is just as complete');
    assert.equal(fx.__fx.tornDown, 2);
  } finally {
    restore();
  }
});

test('reduced motion: zero spawn, zero canvas, zero frames — the decline is counted', () => {
  tokens._setReducedForTest(true);
  const { clock, canvas, restore } = setup();
  try {
    const n = fx.burst(640, 430, { count: 40 });
    assert.equal(n, 0);
    assert.equal(fx.__fx.declined, 1, 'honest refusal, measured');
    assert.equal(canvas(), null);
    assert.equal(clock.pending(), 0, 'the reduced experience owns no frame budget here');
  } finally {
    restore();
  }
});

test('no 2d context (jsdom default): declines without building anything', () => {
  const dom = new JSDOM('<body></body>');
  const prev = {};
  for (const k of ['window', 'document', 'innerWidth', 'innerHeight']) prev[k] = globalThis[k];
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 600;
  const clock = fakeClock();
  // NO context factory injected — jsdom's getContext('2d') returns null.
  try {
    const n = fx.burst(400, 300, { count: 40 });
    assert.equal(n, 0, 'unsupported environment = honest zero');
    assert.equal(dom.window.document.querySelector('canvas'), null, 'no half-built canvas left behind');
    assert.equal(clock.pending(), 0);
  } finally {
    fx._resetFxForTest();
    clock.restore();
    Object.assign(globalThis, prev);
    try { dom.window.close(); } catch { /* best effort */ }
  }
});

test('assemble CONVERGES: mean distance to the contour drops across frames', () => {
  const { clock, restore } = setup();
  try {
    const rect = { left: 440, top: 300, width: 400, height: 220 };
    fx.assemble(rect, { count: 120 });
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const mean = () => fx.__pool()
      .reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / fx.__pool().length;
    clock.frame(1);
    const before = mean();
    clock.frame(24); // ~0.4s: attraction dominates well before decay
    const after = mean();
    assert.ok(after < before * 0.55, `converging (${before.toFixed(0)}px → ${after.toFixed(0)}px), not wandering`);
  } finally {
    restore();
  }
});

test('the ink is the theme token — particles.js reads --glow and nothing else', () => {
  // Source pin (the palette-recents precedent): the contrast gate can only
  // audit colors that stay inside the theme-token system, so the ONE custom
  // property this module may read is --glow, and a canvas birth rebuilds
  // the ink from it (re-themes mid-session re-tint the next burst).
  const src = readFileSync(new URL('../src/app/motion/particles.js', import.meta.url), 'utf8');
  const reads = src.match(/getPropertyValue\('(--[a-z0-9-]+)'\)/g) || [];
  assert.deepEqual([...new Set(reads)], ["getPropertyValue('--glow')"],
    'one audited token feeds the spectacle; every other color channel stays closed');
  assert.match(src, /function ensureCanvas[\s\S]*?ink = themeInk\(\)/,
    'the ink is rebuilt at canvas BIRTH, not cached at module load');
});
