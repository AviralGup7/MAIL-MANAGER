/**
 * Microinteraction wiring + primitives (animation overhaul P3).
 *
 * WHY THESE PINS EXIST
 * --------------------
 * P3 hands transform ownership to springs with era-based exclusivity
 * (press owns during data-pressing, magnetic steps over it), refuses the
 * roster (the no-transform doctrine), and caps every pooled effect. The
 * failure modes are all silent: a double writer = motion blur; an
 * uncapped ripple pool = DOM growth per click (directive §42 names this
 * catastrophic); magnetic-on-touch = a phone user dragging ghosts. Every
 * one of those gets a pin.
 *
 * Harness note (learned the hard way, fix cycle 1): the motion modules run
 * in the NODE realm, so their bare requestAnimationFrame/performance reads
 * are globalThis's — the fake clock patches globalThis, not the jsdom
 * window. Modules are imported ONCE (shared) and every test restores the
 * seams it forced: reduced gate, fine-pointer gate, magnetic registry.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { JSDOM } = await import('jsdom');

const tokens = await import('../src/app/motion/tokens.js');
const press = await import('../src/app/motion/press.js');
const magnetic = await import('../src/app/motion/magnetic.js');
const ripple = await import('../src/app/motion/ripple.js');
const wire = await import('../src/app/motion/wire-micro.js');

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

function dom(html) {
  const d = new JSDOM(html);
  const prev = {};
  for (const k of ['document', 'HTMLElement', 'Node', 'getComputedStyle']) prev[k] = globalThis[k];
  globalThis.document = d.window.document;
  globalThis.HTMLElement = d.window.HTMLElement;
  globalThis.Node = d.window.Node;
  globalThis.getComputedStyle = d.window.getComputedStyle.bind(d.window);
  return {
    win: d.window,
    doc: d.window.document,
    restore() {
      Object.assign(globalThis, prev);
      try { d.window.close(); } catch { /* best effort */ }
    },
  };
}

/** Restore every seam a test may have forced. */
function resetSeams() {
  tokens._setReducedForTest(null);
  magnetic._setFineForTest(null);
  for (const t of [...magnetic.__targets]) magnetic.detachMagnetic(t.el);
}

const downEvt = (win, x = 110, y = 110) =>
  Object.assign(new win.Event('pointerdown', { bubbles: true }), { button: 0, isPrimary: true, clientX: x, clientY: y, pointerId: 1 });

/** jsdom collapses geometry; surfaces under test get an honest box. */
function giveBox(el, box = { left: 100, top: 100, width: 120, height: 40 }) {
  el.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height });
}

test('press: down compresses SAME TASK, release recovers through frames, rest erases the ink', () => {
  const { doc, restore } = dom('<button class="primary">Send</button>');
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  try {
    const el = doc.querySelector('button');
    giveBox(el);
    press.makePressable(el);

    el.dispatchEvent(downEvt(doc.defaultView));
    assert.match(el.style.transform, /scale\(0\.9/, 'immediate compression — no waiting for a frame');
    assert.equal(el.dataset.pressing, '1');

    el.dispatchEvent(new doc.defaultView.Event('pointerup', { bubbles: true }));
    const mids = new Set();
    for (let i = 0; i < 400 && el.dataset.pressing; i++) { clock.frame(); mids.add(el.style.transform); }
    assert.ok(mids.size > 2, 'recovery passes through intermediate states (spring, not cut)');
    assert.equal(el.style.transform, '', 'rest leaves NO inline ink — resting CSS owns the element again');
    assert.equal(el.style.willChange, '', 'no permanent GPU hint');
  } finally { clock.restore(); resetSeams(); restore(); }
});

test('press: right button is not a press, disabled is not a press', () => {
  const { doc, restore } = dom('<button class="primary">A</button><button class="primary" disabled>B</button>');
  tokens._setReducedForTest(false);
  try {
    const [a, b] = doc.querySelectorAll('button');
    press.makePressable(a); press.makePressable(b);
    a.dispatchEvent(Object.assign(downEvt(doc.defaultView), { button: 2 }));
    assert.equal(a.style.transform, '', 'secondary buttons pass through');
    b.dispatchEvent(downEvt(doc.defaultView));
    assert.equal(b.style.transform, '', 'disabled controls stay inert');
  } finally { resetSeams(); restore(); }
});

test('reduced motion: press is a no-op from the first listener call', () => {
  const { doc, restore } = dom('<button class="primary">Send</button>');
  tokens._setReducedForTest(true);
  try {
    const el = doc.querySelector('button');
    press.makePressable(el);
    el.dispatchEvent(downEvt(doc.defaultView));
    assert.equal(el.style.transform, '');
    assert.equal(el.dataset.pressing, undefined);
  } finally { resetSeams(); restore(); }
});

test('ripple: pool caps at 3, spans self-collect, host heals completely', () => {
  tokens._setReducedForTest(false);
  const { doc, restore } = dom('<button id="b" style="position:relative">Go</button>');
  const clock = fakeClock();
  try {
    const host = doc.getElementById('b');
    giveBox(host);
    for (let i = 0; i < 5; i++) {
      ripple.spawnRipple(host, 120, 110);
      if (clock.pending()) clock.frame();
    }
    const liveCount = host.querySelectorAll('span.mripple').length;
    assert.ok(liveCount <= 3, `pool cap honours POOL_MAX (got ${liveCount})`);
    for (let i = 0; i < 400 && host.querySelector('span.mripple'); i++) clock.frame();
    assert.equal(host.querySelectorAll('span.mripple').length, 0, 'every ripple self-collects');
    assert.match(host.innerHTML, /^Go$/, 'host content healed completely');
  } finally { clock.restore(); resetSeams(); restore(); }
});

test('magnetic: fine pointer leans in and springs back to a clean rest', () => {
  const { win, doc, restore } = dom('<div id="m" style="width:40px;height:40px"></div>');
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  magnetic._setFineForTest(true);
  try {
    const el = doc.getElementById('m');
    giveBox(el, { left: 200, top: 200, width: 40, height: 40 });
    magnetic.attachMagnetic(el, { radius: 60, strength: 0.3 });

    el.dispatchEvent(Object.assign(new win.Event('pointermove', { bubbles: true }), { clientX: 240, clientY: 214 }));
    for (let i = 0; i < 120; i++) clock.frame();
    assert.match(el.style.transform, /translate3d\(-?\d/, 'element moved within the field');

    el.dispatchEvent(Object.assign(new win.Event('pointermove', { bubbles: true }), { clientX: 2000, clientY: 2000 }));
    for (let i = 0; i < 400; i++) clock.frame();
    assert.equal(el.style.transform, '', 'returned to rest — the field leaves no residue');
  } finally { clock.restore(); resetSeams(); restore(); }
});

test('magnetic: coarse pointer and reduced motion never even listen', () => {
  const { doc, restore } = dom('<div id="m"></div>');
  try {
    tokens._setReducedForTest(true);
    magnetic._setFineForTest(true);
    magnetic.attachMagnetic(doc.getElementById('m'));
    tokens._setReducedForTest(false);
    magnetic._setFineForTest(false);
    magnetic.attachMagnetic(doc.getElementById('m'));
    assert.equal(magnetic.__targets.size, 0, 'both regimes refused the field');
  } finally { resetSeams(); restore(); }
});

test('era handoff: pressing a LEANING magnetic element leaves zero magnetic ink at rest', () => {
  // Live-probe finding (P3 fix cycle 3): Compose ended a press at
  // translate3d(0,0,0) — the magnetic rest write outliving the press era.
  // press.js must claim the transform the moment pointerdown lands.
  const { win, doc, restore } = dom('<button id="b" class="primary">Go</button>');
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  magnetic._setFineForTest(true);
  try {
    const el = doc.getElementById('b');
    giveBox(el, { left: 200, top: 200, width: 120, height: 40 });
    magnetic.attachMagnetic(el, { radius: 60, strength: 0.3 });
    press.makePressable(el); // the era handoff needs BOTH claimants present
    el.dispatchEvent(Object.assign(new win.Event('pointermove', { bubbles: true }), { clientX: 160, clientY: 220 })); // left-of-centre: lean
    for (let i = 0; i < 30; i++) clock.frame(); // mid-lean, springs still flying
    assert.match(el.style.transform, /translate3d\(-/, 'precondition: leaning');
    el.dispatchEvent(downEvt(win, 210, 210));
    assert.match(el.style.transform, /scale/, 'press owns the transform the same task');
    el.dispatchEvent(new win.Event('pointerup', { bubbles: true }));
    for (let i = 0; i < 400 && el.dataset.pressing; i++) clock.frame();
    assert.equal(el.style.transform, '', 'rest is CLEAN — no orphaned translate3d(0,0,0) from the field');
  } finally { clock.restore(); resetSeams(); restore(); }
});

test('wiring: the roster, menus and search are NEVER motion-wired (doctrine exclusion)', () => {
  const { win, doc, restore } = dom(`
    <div class="row"><button class="ghost">in a row</button></div>
    <button class="snooze-opt">menu</button>
    <input id="search">
    <button class="ghost" id="ok">chrome verb</button>`);
  // A press WITHOUT a frame clock obeys the P2 park doctrine: animateValue
  // round-trips to rest within the same task and erases its ink, so the
  // compression tick is gone before the assertion reads it (probe: will-change
  // residue, transform already ''). This pin needs a schedulable clock like
  // every other press test in the file.
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  magnetic._setFineForTest(true);
  try {
    wire.wireMicroInteractions(doc);
    const rowBtn = doc.querySelector('.row .ghost');
    rowBtn.dispatchEvent(downEvt(win));
    assert.equal(rowBtn.style.transform, '', 'row-embedded controls stay untouched');
    const menuBtn = doc.querySelector('.snooze-opt');
    menuBtn.dispatchEvent(downEvt(win));
    assert.equal(menuBtn.style.transform, '', 'menu items stay with menu.js');
    const ok = doc.getElementById('ok');
    giveBox(ok, { left: 0, top: 0, width: 80, height: 30 });
    ok.dispatchEvent(downEvt(win));
    assert.match(ok.style.transform, /scale/, 'sanity: the non-excluded control presses');
    ok.dispatchEvent(new win.Event('pointerup', { bubbles: true }));
    for (let i = 0; i < 400 && ok.dataset.pressing; i++) clock.frame();
    assert.equal(ok.style.transform, '', 'and releases to a clean rest');
    // one-listener discipline: re-wiring the same root neither re-presses
    // nor double-ripples
    wire.wireMicroInteractions(doc);
    assert.equal(doc.__rippleWired, true, 'the delegated ripple listener is exactly once');
  } finally { clock.restore(); resetSeams(); restore(); }
});
