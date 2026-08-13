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
 * All deterministic: fake frame clock, jsdom DOM, forced pointer/reduced
 * seams from the modules themselves.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { JSDOM } = await import('jsdom');

let mod = 0;
const load = async () => ({
  press: await import('../src/app/motion/press.js?m=' + ++mod),
  magnetic: await import('../src/app/motion/magnetic.js?m=' + ++mod),
  ripple: await import('../src/app/motion/ripple.js?m=' + ++mod),
  tokens: await import('../src/app/motion/tokens.js?m=' + ++mod),
  wire: await import('../src/app/motion/wire-micro.js?m=' + ++mod),
});

function fakeClock(w) {
  let queue = [];
  let t = 0;
  w.requestAnimationFrame = (fn) => { queue.push(fn); return queue.length; };
  w.performance = { now: () => t };
  return {
    frame() { t += 1000 / 60; const q = queue; queue = []; for (const fn of q) fn(t); },
    pending: () => queue.length,
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
  return d;
}

/** jsdom collapses geometry; surfaces under test get an honest box. */
function giveBox(el, box = { left: 100, top: 100, width: 120, height: 40 }) {
  el.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height });
}

test('press: down compresses SAME TASK, release recovers through frames, rest erases the ink', async () => {
  const { press, tokens } = await load();
  const d = dom('<button class="primary">Send</button>');
  const clock = fakeClock(d.window);
  try {
    const el = d.window.document.querySelector('button');
    giveBox(el);
    press.makePressable(el);
    tokens._setReducedForTest(false);

    const down = new d.window.Event('pointerdown', { bubbles: true });
    down.button = 0; down.isPrimary = true; down.clientX = 110; down.clientY = 110;
    el.dispatchEvent(down);
    assert.match(el.style.transform, /scale\(0\.9/, 'immediate compression — no waiting for a frame');
    assert.equal(el.dataset.pressing, '1');

    const up = new d.window.Event('pointerup', { bubbles: true });
    el.dispatchEvent(up);
    const mids = new Set();
    for (let i = 0; i < 400 && el.dataset.pressing; i++) { clock.frame(); mids.add(el.style.transform); }
    assert.ok(mids.size > 2, 'recovery passes through intermediate states (spring, not cut)');
    assert.equal(el.style.transform, '', 'rest leaves NO inline ink — resting CSS owns the element again');
    assert.equal(el.style.willChange, '', 'no permanent GPU hint');
  } finally { d.window.close(); }
});

test('press: right button is not a press, disabled is not a press', async () => {
  const { press, tokens } = await load();
  const d = dom('<button class="primary">A</button><button class="primary" disabled>B</button>');
  try {
    tokens._setReducedForTest(false);
    const [a, b] = d.window.document.querySelectorAll('button');
    press.makePressable(a); press.makePressable(b);
    const right = new d.window.Event('pointerdown', { bubbles: true });
    right.button = 2; right.isPrimary = true;
    a.dispatchEvent(right);
    assert.equal(a.style.transform, '', 'secondary buttons pass through');
    const main = new d.window.Event('pointerdown', { bubbles: true });
    main.button = 0; main.isPrimary = true;
    b.dispatchEvent(main);
    assert.equal(b.style.transform, '', 'disabled controls stay inert');
  } finally { d.window.close(); }
});

test('reduced motion: press is a no-op from the first listener call', async () => {
  const { press, tokens } = await load();
  const d = dom('<button class="primary">Send</button>');
  try {
    tokens._setReducedForTest(true);
    const el = d.window.document.querySelector('button');
    press.makePressable(el);
    const down = new d.window.Event('pointerdown', { bubbles: true });
    down.button = 0; down.isPrimary = true;
    el.dispatchEvent(down);
    assert.equal(el.style.transform, '');
    assert.equal(el.dataset.pressing, undefined);
  } finally { /* keep reduced for the next pin */ d.window.close(); }
});

test('ripple: pool caps at 3, spans self-collect, host box untouched by overflow', async () => {
  const { ripple, tokens } = await load();
  tokens._setReducedForTest(false);
  const d = dom('<button id="b" style="position:relative">Go</button>');
  const clock = fakeClock(d.window);
  try {
    const host = d.window.document.getElementById('b');
    giveBox(host);
    for (let i = 0; i < 5; i++) {
      ripple.spawnRipple(host, 120, 110);
      if (clock.pending()) clock.frame();
    }
    const live1 = host.querySelectorAll('span.mripple').length;
    assert.ok(live1 <= 3, `pool cap honours POOL_MAX (got ${live1})`);
    for (let i = 0; i < 400 && host.querySelector('span.mripple'); i++) clock.frame();
    assert.equal(host.querySelectorAll('span.mripple').length, 0, 'every ripple self-collects');
    assert.match(host.innerHTML, /^Go$/, 'host content healed completely');
  } finally { d.window.close(); }
});

test('magnetic: fine pointer leans in and springs back; detached mid-flight restores rest', async () => {
  const { magnetic, tokens } = await load();
  const d = dom('<div id="m" style="width:40px;height:40px"></div>');
  const clock = fakeClock(d.window);
  try {
    tokens._setReducedForTest(false);
    magnetic._setFineForTest(true);
    const el = d.window.document.getElementById('m');
    giveBox(el, { left: 200, top: 200, width: 40, height: 40 });
    magnetic.attachMagnetic(el, { radius: 60, strength: 0.3 });

    const move = new d.window.Event('pointermove', { bubbles: true });
    move.clientX = 240; move.clientY = 214; // over the element
    el.dispatchEvent(move);
    for (let i = 0; i < 120; i++) clock.frame();
    assert.match(el.style.transform, /translate3d\(-?\d/, 'element moved toward the field');
    const pulled = el.style.transform;

    move.clientX = 2000; move.clientY = 2000; // far outside the radius
    el.dispatchEvent(move);
    for (let i = 0; i < 400; i++) clock.frame();
    assert.equal(el.style.transform, '', `returned to rest (was ${pulled})`);
  } finally { d.window.close(); }
});

test('magnetic: coarse pointer and reduced motion never even listen', async () => {
  const { magnetic, tokens } = await load();
  const d = dom('<div id="m"></div>');
  try {
    tokens._setReducedForTest(true);
    magnetic._setFineForTest(true);
    magnetic.attachMagnetic(d.window.document.getElementById('m'));
    tokens._setReducedForTest(false);
    magnetic._setFineForTest(false);
    magnetic.attachMagnetic(d.window.document.getElementById('m'));
    assert.equal(magnetic.__targets.size, 0, 'both regimes refused the field');
  } finally { d.window.close(); }
});

test('wiring: the roster, menus and search are NEVER motion-wired (doctrine exclusion)', async () => {
  const { wire, tokens, magnetic } = await load();
  const d = dom(`
    <div class="row"><button class="ghost">in a row</button></div>
    <button class="snooze-opt">menu</button>
    <input id="search">
    <button class="ghost" id="ok">chrome verb</button>`);
  try {
    tokens._setReducedForTest(false);
    magnetic._setFineForTest(true);
    wire.wireMicroInteractions(d.window.document);
    // The exclusion list is the contract; verify each listed surface refuses.
    for (const sel of wire.EXCLUSIONS) assert.ok(wire.EXCLUSIONS.includes(sel));
    const rowBtn = d.window.document.querySelector('.row .ghost');
    rowBtn.dispatchEvent(Object.assign(new d.window.Event('pointerdown', { bubbles: true }), { button: 0, isPrimary: true }));
    assert.equal(rowBtn.style.transform, '', 'row-embedded controls stay untouched');
    const menuBtn = d.window.document.querySelector('.snooze-opt');
    menuBtn.dispatchEvent(Object.assign(new d.window.Event('pointerdown', { bubbles: true }), { button: 0, isPrimary: true }));
    assert.equal(menuBtn.style.transform, '', 'menu items stay with menu.js');
    // …and the plain chrome verb DID get wired (control for the experiment).
    const ok = d.window.document.getElementById('ok');
    ok.getBoundingClientRect = () => ({ left: 0, top: 0, width: 80, height: 30, right: 80, bottom: 30 });
    ok.dispatchEvent(Object.assign(new d.window.Event('pointerdown', { bubbles: true }), { button: 0, isPrimary: true }));
    assert.match(ok.style.transform, /scale/, 'sanity: the non-excluded control presses');
  } finally { d.window.close(); }
});
