/**
 * Category pill glide pins (animation overhaul P5).
 *
 * WHY THESE PINS EXIST
 * --------------------
 * The active-category fill is now ONE physical object that slides between
 * buttons. The failure modes worth a machine check:
 *
 *   - DOUBLE-RENDER: if the button keeps its own fill while the pill glides,
 *     two accent surfaces exist for one truth. CSS pin: .has-pill must strip
 *     the button fill + rail.
 *   - REPURPOSED WEIGHT: the fill must never fade/slide to a place it
 *     already occupies (resize/scroll realigns instantly — no phantom
 *     flight), and a hidden rail must retract rather than leave a glowing
 *     slab over nothing.
 *   - CATEGORY IDENTITY: syncPill tracks keys, not nodes — a re-rendered
 *     button with the same key in the same place is a NO-OP, so the
 *     count-refresh hot path never restarts a flight.
 *
 * Harness: globalThis fake clock + jsdom zero-layout stubs, and the same
 * shared-loop hygiene as motion-reader-morph: every flight is pumped to
 * rest before its clock is restored so spring.js's module rafId is never
 * orphaned inside this process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { JSDOM } = await import('jsdom');
const tokens = await import('../src/app/motion/tokens.js');
const pill = await import('../src/app/motion/pill.js');

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

const HTML = `<div id="cat-group"><button class="cat" data-cat="all">All</button><button class="cat" data-cat="sv-week">Week</button><button class="cat" data-cat="sv-overdue">Over</button></div>`;

function dom() {
  const d = new JSDOM(HTML);
  const prev = {};
  for (const k of ['document', 'HTMLElement', 'Node', 'getComputedStyle']) prev[k] = globalThis[k];
  globalThis.document = d.window.document;
  globalThis.HTMLElement = d.window.HTMLElement;
  globalThis.Node = d.window.Node;
  globalThis.getComputedStyle = d.window.getComputedStyle.bind(d.window);
  const doc = d.window.document;
  const group = doc.getElementById('cat-group');
  // jsdom zeroes layout; offset* are defined on the jsdom prototype as
  // getters (except offsetParent — absent there), so define each as an own
  // property for per-button geometry.
  const geo = {
    all: { l: 8, t: 40, w: 220, h: 36 },
    'sv-week': { l: 8, t: 76, w: 220, h: 36 },
    'sv-overdue': { l: 8, t: 112, w: 220, h: 36 },
  };
  for (const b of group.querySelectorAll('.cat')) {
    const g = geo[b.dataset.cat];
    Object.defineProperty(b, 'offsetLeft', { value: g.l, configurable: true });
    Object.defineProperty(b, 'offsetTop', { value: g.t, configurable: true });
    Object.defineProperty(b, 'offsetWidth', { value: g.w, configurable: true });
    Object.defineProperty(b, 'offsetHeight', { value: g.h, configurable: true });
    Object.defineProperty(b, 'offsetParent', { value: group, configurable: true });
  }
  return {
    doc, group,
    restore() { Object.assign(globalThis, prev); try { d.window.close(); } catch {} },
  };
}

const pump = (clock, n) => { for (let i = 0; i < n; i++) clock.frame(); };

/* jsdom normalises typed lengths (220.00px -> 220px) while transform stays
 * opaque — so pins read VALUES, never serialisations. */
const txOf = (p) => {
  const m = String(p.style.transform).match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px/);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
};
const boxOf = (p) => ({ ...txOf(p), w: parseFloat(p.style.width), h: parseFloat(p.style.height) });
const atBox = (p, x, y, w, h) => {
  const b = boxOf(p);
  return b && Math.abs(b.x - x) < 0.01 && Math.abs(b.y - y) < 0.01 && Math.abs(b.w - w) < 0.01 && Math.abs(b.h - h) < 0.01;
};

/** Shared-loop hygiene: test finished? Land any flight before restore. */
function settle(clock, restore) {
  pump(clock, 2);
  clock.restore();
  restore();
}

test('first sync places the pill exactly — no flight for a first impression', () => {
  const { doc, group, restore } = dom();
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  try {
    pill.syncPill(group, group.querySelector('[data-cat="all"]'), 'all');
    const p = group.querySelector('.cat-pill');
    assert.ok(p, 'the pill node exists');
    assert.equal(p.getAttribute('aria-hidden'), 'true', 'decorative: not an AT surface');
    assert.ok(group.classList.contains('has-pill'), 'group knows the pill owns the fill');
    assert.ok(atBox(p, 8, 40, 220, 36), `pill at home: ${p.style.transform} ${p.style.width}`);
    assert.equal(pill._pillForTest(group).handle, null, 'no spring was ever armed');
    assert.equal(group.querySelectorAll('.cat-pill').length, 1, 'one pill, ever');
  } finally { tokens._setReducedForTest(null); settle(clock, restore); }
});

test('same key, same pose: NO-OP — the count-refresh hot path writes nothing', () => {
  const { doc, group, restore } = dom();
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  try {
    const btn = group.querySelector('[data-cat="all"]');
    pill.syncPill(group, btn, 'all');
    const p = group.querySelector('.cat-pill');
    const ink = p.style.cssText;
    pill.syncPill(group, btn, 'all');
    pill.syncPill(group, btn, 'all');
    assert.equal(p.style.cssText, ink, 'zero churn on re-sync');
    assert.equal(pill._pillForTest(group).handle, null);
  } finally { tokens._setReducedForTest(null); settle(clock, restore); }
});

test('a category switch glides: intermediate poses march, rest lands EXACT', () => {
  const { doc, group, restore } = dom();
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  try {
    pill.syncPill(group, group.querySelector('[data-cat="all"]'), 'all');
    const p = group.querySelector('.cat-pill');
    pill.syncPill(group, group.querySelector('[data-cat="sv-week"]'), 'sv-week');
    assert.ok(pill._pillForTest(group).handle, 'a flight is armed');
    const seen = new Set();
    for (let i = 0; i < 60 && pill._pillForTest(group).handle; i++) { clock.frame(); seen.add(p.style.transform); }
    assert.ok(seen.size >= 3, `interpolated (${seen.size} poses), not a cut`);
    pump(clock, 400);
    assert.ok(atBox(p, 8, 76, 220, 36), 'rest writes the exact target');
    assert.equal(pill._pillForTest(group).key, 'sv-week');
  } finally { tokens._setReducedForTest(null); settle(clock, restore); }
});

test('mid-flight retarget continues from the LIVE pose and still lands exact', () => {
  const { doc, group, restore } = dom();
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  try {
    pill.syncPill(group, group.querySelector('[data-cat="all"]'), 'all');
    const p = group.querySelector('.cat-pill');
    pill.syncPill(group, group.querySelector('[data-cat="sv-week"]'), 'sv-week');
    pump(clock, 5); // airborne toward sv-week
    const livePose = p.style.transform;
    const lp = txOf(p); assert.ok(Math.abs(lp.y - 40) > 0.5, 'had left home');
    assert.ok(Math.abs(lp.y - 76) > 0.5, 'had not arrived');
    pill.syncPill(group, group.querySelector('[data-cat="sv-overdue"]'), 'sv-overdue'); // user changed their mind mid-flight
    pump(clock, 400);
    assert.ok(atBox(p, 8, 112, 220, 36), 'redirected flight lands exactly');
    assert.equal(pill._pillForTest(group).handle, null, 'loop is done with it');
  } finally { tokens._setReducedForTest(null); settle(clock, restore); }
});

test('reduced motion: the pill snaps — the truth never waits for a journey', () => {
  const { doc, group, restore } = dom();
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  try {
    pill.syncPill(group, group.querySelector('[data-cat="all"]'), 'all');
    tokens._setReducedForTest(true);
    pill.syncPill(group, group.querySelector('[data-cat="sv-week"]'), 'sv-week');
    const p = group.querySelector('.cat-pill');
    assert.ok(atBox(p, 8, 76, 220, 36), 'already there, same task');
    assert.equal(pill._pillForTest(group).handle, null, 'no rAF was ever requested');
    pump(clock, 60);
    assert.ok(atBox(p, 8, 76, 220, 36), 'and stays there');
  } finally { tokens._setReducedForTest(null); settle(clock, restore); }
});

test('same key, NEW geometry (resize/font load): instant realign, no phantom flight', () => {
  const { doc, group, restore } = dom();
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  try {
    const btn = group.querySelector('[data-cat="all"]');
    pill.syncPill(group, btn, 'all');
    Object.defineProperty(btn, 'offsetTop', { value: 52, configurable: true }); // the rail reflowed
    pill.syncPill(group, btn, 'all');
    const p = group.querySelector('.cat-pill');
    assert.ok(atBox(p, 8, 52, 220, 36), 'realigned the same task');
    assert.equal(pill._pillForTest(group).handle, null, 'a fill does not fly to its own home');
  } finally { tokens._setReducedForTest(null); settle(clock, restore); }
});

test('hidden rail retracts; re-emergence snaps — never a flight from a stale pose', () => {
  const { doc, group, restore } = dom();
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  try {
    const btn = group.querySelector('[data-cat="all"]');
    pill.syncPill(group, btn, 'all');
    Object.defineProperty(btn, 'offsetParent', { value: null, configurable: true }); // display:none
    pill.syncPill(group, btn, 'all');
    const p = group.querySelector('.cat-pill');
    assert.equal(p.style.display, 'none', 'retracted while unseen');
    assert.equal(pill._pillForTest(group).key, null, 'pose knowledge dropped');
    Object.defineProperty(btn, 'offsetParent', { value: group, configurable: true });
    pill.syncPill(group, btn, 'all');
    assert.ok(atBox(p, 8, 40, 220, 36), 'snapped back exactly');
    assert.equal(pill._pillForTest(group).handle, null, 'no flight from nowhere');
    pill.syncPill(group, null, null); // rail entirely away
    assert.equal(p.style.display, 'none', 'null target retracts too');
  } finally { tokens._setReducedForTest(null); settle(clock, restore); }
});

// --- seam pins: the wiring must not drift from the module --------------

test('seam: renderSidebar syncs the pill after aria-current is final', () => {
  const src = readFileSync(new URL('../src/app/sidebar.js', import.meta.url), 'utf8');
  const render = src.slice(src.indexOf('export function renderSidebar'));
  const syncAt = render.indexOf('syncPill(');
  assert.ok(syncAt > 0, 'renderSidebar calls syncPill');
  assert.ok(render.indexOf("b.setAttribute('aria-current'") > -1 &&
            render.indexOf("b.setAttribute('aria-current'") < syncAt,
    'the pill follows state, never leads it');
  assert.match(render, /tabIndex[^\n]*\n[\s\S]{0,1200}syncPill/, 'synced at the END of the render');
});

test('seam: compose seeds from the Compose button only on hidden→open', () => {
  const src = readFileSync(new URL('../src/app/compose.js', import.meta.url), 'utf8');
  const open = src.slice(src.indexOf('export function openCompose'), src.indexOf('renderFiles()'));
  assert.match(open, /const wasHidden = panel\.hidden/, 'hidden state captured before reveal');
  assert.match(open, /if \(wasHidden\)[\s\S]{0,400}\$?\('btn-compose'\)[\s\S]{0,200}popFrom\(panel/, 'a birth seeds from the invoker; a restore does not');
});

test('seam: the pill owns the fill under .has-pill — never double-rendered', () => {
  const css = readFileSync(new URL('../src/app/app.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /#cat-group\.has-pill \.cat\[aria-current='true'\]\s*\{[^}]*background:\s*transparent/, 'button fill is handed over');
  assert.match(css, /#cat-group\.has-pill \.cat\[aria-current='true'\]::before\s*\{\s*content:\s*none/, 'button rail is handed over');
  assert.match(css, /\.cat-pill::before\s*\{[^}]*background:\s*var\(--accent\)/, 'the rail rides the pill');
  const pillBlock = css.match(/\.cat-pill\s*\{([\s\S]*?)\}/);
  assert.ok(pillBlock, 'pill block exists');
  assert.ok(!/transition/.test(pillBlock[1]), 'the spring owns the pill — never a CSS transition');
});
