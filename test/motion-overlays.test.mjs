/**
 * Overlay physics: camera + morph/FLIP + anchored pop (animation overhaul P4).
 *
 * WHY THESE PINS EXIST
 * --------------------
 * The camera moves the WHOLE chrome — a broken pairing shrinks the app; a
 * rest that leaves inline ink desyncs the theme cross-fade; the morph's
 * NaN guards protect a zero-size box from poisoning every later frame.
 * And the P4 doctrines found in-tree (menus exit instantly; hidden never
 * waits) are re-asserted here as behaviour so this suite fails if a later
 * milestone forgets them.
 *
 * Deterministic: globalThis fake clock + jsdom, same harness contract as
 * motion-micro (see fix cycle 1 there).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { JSDOM } = await import('jsdom');

const tokens = await import('../src/app/motion/tokens.js');
const camera = await import('../src/app/motion/camera.js');
const morph = await import('../src/app/motion/morph.js');

function fakeClock() {
  let queue = [];
  let t = 0;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevPerf = globalThis.performance;
  globalThis.requestAnimationFrame = (fn) => { queue.push(fn); return queue.length; };
  globalThis.performance = { now: () => t };
  return {
    frame() { t += 1000 / 60; const q = queue; queue = []; for (const fn of q) fn(t); },
    restore() {
      if (prevRaf === undefined) delete globalThis.requestAnimationFrame;
      else globalThis.requestAnimationFrame = prevRaf;
      globalThis.performance = prevPerf;
    },
  };
}

function dom(html) {
  const d = new JSDOM(html);
  const prev = {};
  for (const k of ['document', 'HTMLElement', 'Node', 'getComputedStyle']) prev[k] = globalThis[k];
  globalThis.document = d.window.document;
  globalThis.HTMLElement = d.window.HTMLElement;
  globalThis.Node = d.window.Node;
  globalThis.getComputedStyle = d.window.getComputedStyle.bind(d.window);
  return {
    win: d.window, doc: d.window.document,
    restore() { Object.assign(globalThis, prev); try { d.window.close(); } catch {} },
  };
}

const pump = (clock, n = 600) => { for (let i = 0; i < n; i++) clock.frame(); };

test('camera: push deepens the scene, pop unwinds, rest-at-home erases all ink', () => {
  const { doc, restore } = dom('<div id="shell"><main id="c"></main></div>');
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  camera._resetCameraForTest();
  try {
    const shell = doc.getElementById('shell');
    camera.cameraPush(shell);
    pump(clock, 80);
    assert.match(shell.style.transform, /scale\(0\.98/, 'one level = the documented recede');
    const deep = camera.cameraState();
    assert.equal(deep.level, 1);
    camera.cameraPush(shell); // palette over compose nests
    pump(clock, 120);
    assert.equal(camera.cameraState().level, 2);
    const s1 = Number(shell.style.transform.match(/scale\(([\d.]+)\)/)[1]);
    camera.cameraPop(); camera.cameraPop();
    pump(clock, 200);
    assert.equal(camera.cameraState().level, 0);
    assert.equal(shell.style.transform, '', 'home = no inline transform at all');
    assert.equal(shell.style.filter, '', 'home = no inline filter');
    camera.cameraPop(); // the floor: underflow is absorbed, not applied
    assert.equal(camera.cameraState().level, 0, 'a leak-unpop can never shrink the app');
  } finally { tokens._setReducedForTest(null); clock.restore(); camera._resetCameraForTest(); restore(); }
});

test('camera: reduced motion still recedes — instantly, structurally', () => {
  const { doc, restore } = dom('<div id="shell"></div>');
  tokens._setReducedForTest(true);
  camera._resetCameraForTest();
  try {
    const shell = doc.getElementById('shell');
    camera.cameraPush(shell);
    assert.match(shell.style.transform, /scale\(0\.985/, 'depth is structure: same task, zero frames');
    camera.cameraPop();
    assert.equal(shell.style.transform, '', 'and unwinds just as instantly');
  } finally { tokens._setReducedForTest(null); camera._resetCameraForTest(); restore(); }
});

test('morph math: lerpBox interpolates every channel; morphFrame guards the degenerate box', () => {
  const a = { x: 10, y: 20, w: 100, h: 50, r: 4 };
  const b = { x: 110, y: 120, w: 300, h: 200, r: 12 };
  assert.deepEqual(morph.lerpBox(a, b, 0), a);
  assert.deepEqual(morph.lerpBox(a, b, 1), b);
  const mid = morph.lerpBox(a, b, 0.5);
  assert.deepEqual(mid, { x: 60, y: 70, w: 200, h: 125, r: 8 });
  const f = morph.morphFrame(mid, b, 0.5);
  assert.match(f.transform, /translate3d\(-50\.00px, -50\.00px, 0\) scale\(0\.6667, 0\.6250\)/);
  assert.equal(f.borderRadius, '8.0px');
  assert.equal(morph.morphFrame(b, b, 1), null, 'rest frame produces no CSS');
  // Zero-size BASE (a hidden target): scale must degenerate to 1, never NaN.
  const zeroBase = { x: 0, y: 0, w: 0, h: 0, r: 0 };
  const zf = morph.morphFrame(a, zeroBase, 0.3);
  assert.match(zf.transform, /scale\(1, 1\)|scale\(1\.0000, 1\.0000\)/, 'NaN prevented');
});

test('morphGhost: first pose is immediate, flight interpolates, rest erases everything', () => {
  const { doc, restore } = dom('<div id="g" style="position:fixed">ghost</div>');
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  try {
    const g = doc.getElementById('g');
    g.getBoundingClientRect = () => ({ left: 300, top: 200, width: 400, height: 500, right: 700, bottom: 700 });
    let done = false;
    const h = morph.morphGhost(g, { x: 40, y: 80, w: 260, h: 48, r: 24 }, { onDone: () => { done = true; } });
    assert.match(g.style.transform, /-260\.00px, -120\.00px/, 'immediately covering the source pose');
    assert.equal(g.style.pointerEvents, 'none', 'theatre never eats input');
    const seen = new Set();
    for (let i = 0; i < 500 && h.running(); i++) { clock.frame(); seen.add(g.style.transform); }
    assert.ok(seen.size > 3, 'the morph passes through intermediate geometry');
    assert.equal(done, true);
    assert.equal(g.style.transform, '', 'rest erases the transform');
    assert.equal(g.style.transformOrigin, '');
    assert.equal(g.style.borderRadius, '');
    assert.equal(g.style.pointerEvents, '', 'the real surface regains the pointer');
  } finally { tokens._setReducedForTest(null); clock.restore(); restore(); }
});

test('popFrom: synchronous first pose, CSS animation suspended for the flight, restored after', () => {
  const { doc, restore } = dom('<div id="m" style="animation: menu-in 140ms">menu</div>');
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  try {
    const m = doc.getElementById('m');
    m.getBoundingClientRect = () => ({ left: 100, top: 100, width: 200, height: 160, right: 300, bottom: 260 });
    morph.popFrom(m, { x: 150, y: 110 });
    assert.equal(m.style.transform, 'scale(0.8600)', 'the FROM pose lands the same task — no destination flash');
    assert.equal(m.style.animation, 'none', 'declarative entry suspended: one writer');
    pump(clock, 200);
    assert.equal(m.style.transform, '', 'rest erases...');
    assert.equal(m.style.animation, 'menu-in 140ms', '...and hands the declarative world back whole');
  } finally { tokens._setReducedForTest(null); clock.restore(); restore(); }
});

test('popFrom: an anchor outside the box CLAMPS to the edge (live-probe finding)', () => {
  const { doc, restore } = dom('<div id="m">menu</div>');
  tokens._setReducedForTest(false);
  try {
    const m = doc.getElementById('m');
    m.getBoundingClientRect = () => ({ left: 100, top: 100, width: 200, height: 160, right: 300, bottom: 260 });
    morph.popFrom(m, { x: 90226, y: 28740 }); // the full-width-row case, measured
    const [ox, oy] = m.style.transformOrigin.split(' ').map((v) => parseFloat(v));
    assert.ok(ox >= 4 && ox <= 96, `x-origin clamped into the box (got ${ox}%)`);
    assert.ok(oy >= 4 && oy <= 96, `y-origin clamped into the box (got ${oy}%)`);
  } finally { tokens._setReducedForTest(null); restore(); }
});

test('standing doctrines re-asserted: reduced motion = no pop, no ghost flight', () => {
  const { doc, restore } = dom('<div id="m">m</div><div id="g">g</div>');
  tokens._setReducedForTest(true);
  try {
    const m = doc.getElementById('m');
    m.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 });
    const ph = morph.popFrom(m, { x: 10, y: 10 });
    assert.equal(ph.running(), false);
    assert.equal(m.style.transform, '', 'no pop writes under reduced motion');
    const gh = morph.morphGhost(doc.getElementById('g'), { x: 0, y: 0, w: 10, h: 10, r: 0 });
    assert.equal(gh.running(), false);
    assert.equal(doc.getElementById('g').style.transform, '', 'no ghost flight either');
  } finally { tokens._setReducedForTest(null); restore(); }
});
