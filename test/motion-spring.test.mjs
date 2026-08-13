/**
 * The spring's physical contract (animation overhaul P2; audit doc §3.1).
 *
 * WHY THESE PINS EXIST
 * --------------------
 * The whole motion language rests on four presets whose CHARACTER is the
 * design (WHISPER settles dead, SNAP pops ~5%, PANEL deliberately
 * overshoots ~8%, HEFT lands with one gentle ~10% bounce). If a refactor
 * nudges a damping constant, the app silently stops speaking one universe.
 * These pins measure each preset's overshoot/settle behaviour against the
 * documented ζ bands, pin the reversible-animation doctrine (retarget
 * preserves velocity; cancel is silent; the resting write is EXACT), and
 * pin the reduced-motion short-circuit (synchronous park, zero rAF).
 *
 * The integrator is pure; the driver's rAF is faked with a manual clock so
 * every assertion is deterministic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const DT = 1 / 60;

const { SPRINGS, _setReducedForTest } = await import('../src/app/motion/tokens.js');
const { springStep, isSettled, animateValue } = await import('../src/app/motion/spring.js?p=' + Math.random());

/** Integrate a preset until settle; report the trajectory's character. */
function characterize(preset, from = 0, target = 100, maxS = 5) {
  let x = from, v = 0, peak = -Infinity, steps = 0;
  const tMax = maxS / DT;
  while (steps < tMax) {
    [x, v] = springStep(x, v, target, preset, DT);
    steps++;
    peak = Math.max(peak, x);
    if (isSettled(x, v, target)) break;
  }
  return { settled: steps < tMax, overshoot: Math.max(0, peak - target), seconds: steps * DT, finalX: x };
}

test('every preset CONVERGES (no runaway, no ringing forever)', () => {
  for (const [name, preset] of Object.entries(SPRINGS)) {
    const c = characterize(preset);
    assert.ok(c.settled, `${name} must settle within 5s (got ${c.seconds.toFixed(2)}s, x=${c.finalX})`);
    assert.ok(Math.abs(c.finalX - 100) < 0.05, `${name} rests ON the target`);
    assert.ok(c.seconds < 1.6, `${name} is UI-motion, not a lava lamp (${c.seconds.toFixed(2)}s)`);
  }
});

test('preset characters match the documented ζ bands', () => {
  const w = characterize(SPRINGS.WHISPER);
  const s = characterize(SPRINGS.SNAP);
  const p = characterize(SPRINGS.PANEL);
  const h = characterize(SPRINGS.HEFT);
  assert.ok(w.overshoot < 1,
    `WHISPER ≤1% overshoot (ambient must not bounce); got ${w.overshoot.toFixed(2)}%`);
  assert.ok(s.overshoot > 2 && s.overshoot < 8,
    `SNAP ~5% overshoot; got ${s.overshoot.toFixed(2)}%`);
  assert.ok(p.overshoot > 5 && p.overshoot < 12,
    `PANEL ~8% overshoot; got ${p.overshoot.toFixed(2)}%`);
  assert.ok(h.overshoot > 7 && h.overshoot < 14,
    `HEFT ~10% one-bounce; got ${h.overshoot.toFixed(2)}%`);
  // Heavier motion is SLOWER motion — the depth hierarchy is temporal too.
  assert.ok(h.seconds > s.seconds, 'HEFT outlives SNAP (mass reads as time)');
});

test('retarget from live (x, v) redirects WITHOUT a cut (directive §12)', async () => {
  // Interruption mid-flight: after 0.12s toward 100, reverse to 0.
  let x = 0, v = 0;
  const guard = SPRINGS.SNAP;
  for (let i = 0; i < 7; i++) [x, v] = springStep(x, v, 100, guard, DT);
  const vAtCut = v;
  assert.ok(vAtCut > 50, 'mid-flight has real velocity to preserve');
  // The reverse continues FROM that velocity — first step must still move
  // TOWARD 100 (momentum), then turn around smoothly.
  const [x1, v1] = springStep(x, v, 0, guard, DT);
  assert.ok(v1 > 0, 'velocity is preserved across the retarget (no impulse theft)');
  assert.ok(x1 > x, 'position continues with momentum before turning');
  let peak = x1;
  for (let i = 0; i < 300; i++) { [x, v] = springStep(x, v, 0, guard, DT); peak = Math.max(peak, x); if (isSettled(x, v, 0)) break; }
  assert.ok(peak < 400, `no energy explosion from the reversal (peak ${peak.toFixed(1)})`);
  assert.ok(isSettled(x, v, 0), 'and it still arrives');
});

/** A deterministic frame pump for the rAF driver. */
function fakeClock() {
  let queue = [];
  let t = 0;
  globalThis.requestAnimationFrame = (fn) => { queue.push(fn); return queue.length; };
  globalThis.performance = { now: () => t };
  return {
    /** advance one 16.67ms frame */
    frame() { t += 1000 / 60; const q = queue; queue = []; for (const fn of q) fn(t); },
    pending: () => queue.length,
    restore() { delete globalThis.requestAnimationFrame; delete globalThis.performance; },
  };
}

test('driver: settles with an EXACT final write, then the loop dies', async () => {
  const clock = fakeClock();
  try {
    let writes = 0, lastX = null, rested = false;
    animateValue({
      from: 0, to: 10, preset: SPRINGS.SNAP,
      onUpdate: (x) => { writes++; lastX = x; },
      onRest: () => { rested = true; },
    });
    assert.ok(clock.pending() > 0, 'the loop is running');
    for (let i = 0; i < 400 && !rested; i++) clock.frame();
    assert.equal(rested, true, 'settles');
    assert.equal(lastX, 10, 'the resting frame writes the EXACT target (no 9.99997 forever)');
    assert.ok(writes > 3, 'it actually animated');
    assert.equal(clock.pending(), 0, 'the rAF loop DIES when nothing is live — no idle spin');
  } finally {
    clock.restore();
  }
});

test('driver: cancel() is silent — no onRest, and the handle reports it', async () => {
  const clock = fakeClock();
  try {
    let rested = false;
    const h = animateValue({ from: 0, to: 500, preset: SPRINGS.HEFT, onRest: () => { rested = true; } });
    clock.frame();
    clock.frame();
    assert.equal(h.running(), true);
    assert.ok(h.velocity() > 0, 'live velocity is observable for gesture hand-off');
    h.cancel();
    for (let i = 0; i < 100; i++) clock.frame();
    assert.equal(h.running(), false);
    assert.equal(rested, false, 'cancel is not a settle — interrupted means interrupted');
  } finally {
    clock.restore();
  }
});

test('driver: retarget mid-flight keeps animating toward the NEW target', async () => {
  const clock = fakeClock();
  try {
    let lastX = 0; let rested = false;
    const h = animateValue({ from: 0, to: 100, preset: SPRINGS.PANEL, onUpdate: (x) => { lastX = x; }, onRest: () => { rested = true; } });
    for (let i = 0; i < 6; i++) clock.frame();
    h.retarget(-40); // user changed their mind
    for (let i = 0; i < 600 && !rested; i++) clock.frame();
    assert.equal(rested, true);
    assert.equal(lastX, -40, 'arrived at the retargeted value, exactly');
  } finally {
    clock.restore();
  }
});

test('reduced motion: synchronous park at target, zero rAF requested', () => {
  _setReducedForTest(true);
  const clock = fakeClock();
  try {
    const seen = [];
    let rested = false;
    const h = animateValue({
      from: 0, to: 42, preset: SPRINGS.HEFT,
      onUpdate: (x) => seen.push(x), onRest: () => { rested = true; },
    });
    assert.deepEqual(seen, [42], 'one synchronous write of the exact target');
    assert.equal(rested, true, 'rest fires in the same task — state never waits for pixels');
    assert.equal(clock.pending(), 0, 'not a single frame requested');
    assert.equal(h.running(), false);
  } finally {
    _setReducedForTest(null);
    clock.restore();
  }
});
