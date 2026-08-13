/**
 * The key light (animation overhaul P6; audit doc §3.3).
 *
 * WHY THESE PINS EXIST
 * --------------------
 * The light is a shared invariant masquerading as decoration: one source,
 * seven surfaces. Its failure modes are silent spend and silent absence —
 * a listener that writes when every host is hidden (waste), a listener
 * attached twice (double writes per frame), writes arriving unbatched
 * (style thrash per pointer event), or the whole thing tracking on a
 * coarse-pointer phone or under reduced motion, where the doctrine says
 * it must not exist at all. Each gets a pin.
 *
 * Harness: motion modules read rAF from their own realm — the fake clock
 * patches globalThis (the motion-micro.test.mjs note). The visibility
 * truth is the [hidden] attribute, identical in jsdom and the browser by
 * construction (the module reads no layout).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { JSDOM } = await import('jsdom');

const tokens = await import('../src/app/motion/tokens.js');
const light = await import('../src/app/motion/light.js');

function fakeClock() {
  let queue = [];
  let t = 0;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevPerf = globalThis.performance;
  globalThis.requestAnimationFrame = (fn) => { queue.push(fn); return queue.length; };
  globalThis.performance = { now: () => t };
  return {
    frame() { t += 1000 / 60; const q = queue; queue = []; for (const fn of q) fn(t); },
    pending: () => queue.length,
    restore() {
      if (prevRaf === undefined) delete globalThis.requestAnimationFrame;
      else globalThis.requestAnimationFrame = prevRaf;
      globalThis.performance = prevPerf;
    },
  };
}

function setup(inner) {
  const dom = new JSDOM(`<main>${inner ?? '<section id="radar" class="lit"></section>'}</main>`);
  const prev = {};
  for (const k of ['window', 'document']) prev[k] = globalThis[k];
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const clock = fakeClock();
  return {
    dom,
    doc: dom.window.document,
    clock,
    move(x, y) {
      // jsdom lacks PointerEvent; the micro pins dispatched Event+coords the
      // same way (test/motion-micro.test.mjs:159).
      dom.window.dispatchEvent(Object.assign(
        new dom.window.Event('pointermove', { bubbles: true }), { clientX: x, clientY: y }));
    },
    restore() {
      clock.restore();
      light._resetLightForTest();
      Object.assign(globalThis, prev);
      try { dom.window.close(); } catch { /* best effort */ }
    },
  };
}

test.afterEach(() => {
  tokens._setReducedForTest(null);
  light._setLightFineForTest(null);
});

test('a pointer frame writes the light position ONCE, from the last event', () => {
  light._setLightFineForTest(true);
  const { doc, clock, move, restore } = setup();
  try {
    light.wireLight(doc);
    move(10, 10); move(80, 90); move(400, 240); // three events, one frame
    clock.frame();
    assert.equal(light.__light.frames, 1, 'three moves coalesced to one flush');
    assert.equal(light.__light.writes, 1, 'one pair of property writes, not three');
    assert.equal(doc.documentElement.style.getPropertyValue('--lx'), '400px', 'last event wins');
    assert.equal(doc.documentElement.style.getPropertyValue('--ly'), '240px');
    move(401, 241);
    clock.frame();
    assert.equal(light.__light.writes, 2, 'a fresh frame writes again — but only per frame');
  } finally {
    restore();
  }
});

test('no visible .lit host → the flush writes nothing', () => {
  light._setLightFineForTest(true);
  const { doc, clock, move, restore } = setup('<section id="radar" class="lit" hidden></section>');
  try {
    light.wireLight(doc);
    move(100, 100);
    clock.frame();
    assert.equal(light.__light.writes, 0, 'hidden hosts spend nothing');
    assert.equal(light.__light.skippedHidden, 1, 'the skip is the counted, honest path');
    assert.equal(doc.documentElement.style.getPropertyValue('--lx'), '');
  } finally {
    restore();
  }
});

test('reduced motion: the listener never attaches', () => {
  tokens._setReducedForTest(true);
  light._setLightFineForTest(true);
  const { doc, clock, move, restore } = setup();
  try {
    light.wireLight(doc);
    move(100, 100);
    assert.equal(clock.pending(), 0, 'no frame was even scheduled');
    clock.frame();
    assert.equal(light.__light.writes, 0, 'the reduced truth is the static :root pose, tracked by no one');
  } finally {
    restore();
  }
});

test('coarse pointer: same absence — a thumb carries no light', () => {
  light._setLightFineForTest(false);
  const { doc, clock, move, restore } = setup();
  try {
    light.wireLight(doc);
    move(100, 100);
    clock.frame();
    assert.equal(light.__light.writes, 0);
  } finally {
    restore();
  }
});

test('no .lit hosts in the document → no listener at all (gate/options pages)', () => {
  light._setLightFineForTest(true);
  const { doc, clock, move, restore } = setup('<p>nothing lit here</p>');
  try {
    light.wireLight(doc);
    move(100, 100);
    clock.frame();
    assert.equal(light.__light.frames, 0, 'absence is absence — zero plumbing');
  } finally {
    restore();
  }
});

test('re-wiring the same window is a no-op (boot may call twice)', () => {
  light._setLightFineForTest(true);
  const { doc, clock, move, restore } = setup();
  try {
    light.wireLight(doc);
    light.wireLight(doc);
    move(50, 60);
    clock.frame();
    assert.equal(light.__light.writes, 1, 'one listener fed one flush');
  } finally {
    restore();
  }
});

test('no frame clock → honest immediate write (P4 decline doctrine)', () => {
  light._setLightFineForTest(true);
  const dom = new JSDOM('<section id="radar" class="lit"></section>');
  const prev = {};
  for (const k of ['window', 'document']) prev[k] = globalThis[k];
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // NO requestAnimationFrame installed at all.
  try {
    light.wireLight(dom.window.document);
    dom.window.dispatchEvent(Object.assign(
      new dom.window.Event('pointermove', { bubbles: true }), { clientX: 42, clientY: 24 }));
    assert.equal(
      dom.window.document.documentElement.style.getPropertyValue('--lx'), '42px',
      'the write lands now — uncoalesced but exact, never silently dropped',
    );
  } finally {
    light._resetLightForTest();
    Object.assign(globalThis, prev);
    try { dom.window.close(); } catch { /* best effort */ }
  }
});
