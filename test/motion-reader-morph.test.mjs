/**
 * Row → reader identity morph pins (animation overhaul P5).
 *
 * WHY THESE PINS EXIST
 * --------------------
 * This is the app's signature transition — the row's sender/subject FLY into
 * the reader header — and it is also the app surface most likely to be
 * interrupted: j/k scan mid-flight, Escape mid-flight, mailbox switch
 * mid-flight. These pins make three promises machine-checkable:
 *
 *   1. HONEST DECLINE. flyRowIdentity returns false for reduced motion, for
 *      a missing/hidden/unmeasurable row, and (fix cycle 1) for an absent
 *      frame clock — and on every false the caller's swap animation plays
 *      with ZERO borrowed state hanging around.
 *   2. TOTAL ABORT. abortRowIdentity (closeReader's first statement) must
 *      leave nothing: no ghosts, no rmorph-hide classes, no live spring, no
 *      pending fuse — and nothing may resurrect afterwards.
 *   3. THE REST FRAME RETURNS EVERYTHING. Whatever visibility the theatre
 *      borrowed is handed back by the landing, by the fuse, or by the abort
 *      — one of the three, always, exactly once.
 *
 * Deterministic: globalThis fake frame clock + jsdom zero-layout stubs,
 * the same harness contract as motion-micro/motion-overlays. The fuse is
 * real wall-clock (1.2s) — the suite pays ~2.6s for two waits, well inside
 * the local budget, because a fuse that only works on a mocked clock is no
 * fuse at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { JSDOM } = await import('jsdom');

const tokens = await import('../src/app/motion/tokens.js');
const rm = await import('../src/app/motion/reader-morph.js');

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

const HTML = `
<div id="row-1">
  <span class="r-from" style="font-size:13px">Alice Example</span>
  <span class="r-subj" style="font-size:13px">Quarterly report</span>
</div>
<div id="row-2">
  <span class="r-from" style="font-size:13px">Bob Sample</span>
  <span class="r-subj" style="font-size:13px">Lunch?</span>
</div>
<header>
  <span id="d-from" style="font-size:15px"></span>
  <h1 id="d-subj" style="font-size:22px"></h1>
</header>`;

function dom() {
  const d = new JSDOM(HTML);
  const prev = {};
  for (const k of ['document', 'HTMLElement', 'Node', 'getComputedStyle']) prev[k] = globalThis[k];
  globalThis.document = d.window.document;
  globalThis.HTMLElement = d.window.HTMLElement;
  globalThis.Node = d.window.Node;
  globalThis.getComputedStyle = d.window.getComputedStyle.bind(d.window);
  return {
    doc: d.window.document,
    restore() { Object.assign(globalThis, prev); try { d.window.close(); } catch {} },
  };
}

/** jsdom has no layout: the row must LOOK visible by hand. */
function box(elm, left, top, width, height) {
  elm.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
}
function visible(elm, doc) {
  Object.defineProperty(elm, 'offsetParent', { value: doc.body, configurable: true });
}

/** A measurable row + header: the flying configuration. */
function stage(doc, rowId = 'row-1') {
  const row = doc.getElementById(rowId);
  visible(row, doc);
  box(row.querySelector('.r-from'), 120, 200, 90, 18);
  box(row.querySelector('.r-subj'), 120, 222, 180, 18);
  const els = { from: doc.getElementById('d-from'), subject: doc.getElementById('d-subj') };
  box(els.from, 320, 56, 200, 20);
  box(els.subject, 320, 84, 420, 30);
  return els;
}

const pump = (clock, n) => { for (let i = 0; i < n; i++) clock.frame(); };
const ghostsOf = (doc) => [...doc.querySelectorAll('.idghost')];
const tx = (t) => {
  const m = String(t).match(/translate3d\((-?[\d.]+)px, (-?[\d.]+)px/);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
};

/*
 * SHARED-LOOP HYGIENE (why every finally calls this): spring.js's `live` set
 * and `rafId` are module-global. A flight that never lands (declined clocks
 * discarded mid-flight, fuse waits) leaves the loop's pending tick orphaned
 * in the OLD fake queue — rafId stays truthy and no later flight in this
 * process ever schedules a tick again (motion-micro/overlays avoid this by
 * always pumping to settle before restore). So: abort whatever is airborne,
 * then pump twice — the orphaned tick runs, sees the empty set, and zeroes
 * rafId. Only then may the clock be restored. (Fix cycle 3: tests 3–8 died
 * chained behind exactly one orphaned loop from the pre-fix zero-box test.)
 */
function settle(clock, restore) {
  try { rm.abortRowIdentity(); } catch {}
  pump(clock, 2);
  clock.restore();
  restore();
}

test('reduced motion declines BEFORE any borrowing — zero theatre, swap plays', () => {
  const { doc, restore } = dom();
  const clock = fakeClock();
  tokens._setReducedForTest(true);
  try {
    const els = stage(doc);
    assert.equal(rm.flyRowIdentity('row-1', els), false);
    assert.equal(ghostsOf(doc).length, 0, 'no ghost is ever spawned');
    assert.equal(els.from.classList.length, 0, 'nothing was borrowed from the header');
    assert.equal(rm._flightForTest(), null);
  } finally { tokens._setReducedForTest(null); settle(clock, restore); }
});

test('no frame clock declines too (fix cycle 1) — an unschedulable ghost would hang for the fuse', () => {
  const { doc, restore } = dom();
  const prevRaf = globalThis.requestAnimationFrame;
  delete globalThis.requestAnimationFrame; // the rAF-absent realm, honestly
  tokens._setReducedForTest(false);
  try {
    const els = stage(doc);
    assert.equal(rm.flyRowIdentity('row-1', els), false, 'declines instead of lying true');
    assert.equal(els.from.classList.length, 0);
    assert.equal(ghostsOf(doc).length, 0);
    assert.equal(rm._flightForTest(), null);
  } finally {
    if (prevRaf !== undefined) globalThis.requestAnimationFrame = prevRaf;
    tokens._setReducedForTest(null); restore();
  }
});

test('unmeasurable rows decline honestly — nothing borrowed, nothing spawned', () => {
  const { doc, restore } = dom();
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  try {
    const els = stage(doc);
    // No such row at all.
    assert.equal(rm.flyRowIdentity('row-404', els), false);
    assert.equal(els.from.classList.length, 0);
    // Row exists but jsdom-invisible: no visible() was called on row-2, so
    // offsetParent is null — the display:none-list case.
    assert.equal(rm.flyRowIdentity('row-2', els), false, 'a hidden list does not fly');
    // Fully measurable row but zero-size BOXES: ghosts refuse to spawn from
    // nothing (row-2's sources are jsdom-zero; the header boxes forced zero).
    const row2 = doc.getElementById('row-2');
    visible(row2, doc);
    const els2 = { from: doc.getElementById('d-from'), subject: doc.getElementById('d-subj') };
    box(els2.from, 0, 0, 0, 0);
    box(els2.subject, 0, 0, 0, 0);
    assert.equal(rm.flyRowIdentity('row-2', els2), false, 'zero geometry = honest decline');
    assert.equal(els2.from.classList.contains('rmorph-hide'), false, 'the brief borrow was revoked');
    assert.equal(els2.subject.classList.contains('rmorph-hide'), false);
    assert.equal(ghostsOf(doc).length, 0);
    assert.equal(rm._flightForTest(), null);
  } finally { tokens._setReducedForTest(null); settle(clock, restore); }
});

test('a full flight borrows visibility, interpolates, and its rest frame returns everything', () => {
  const { doc, restore } = dom();
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  try {
    const els = stage(doc);
    assert.equal(rm.flyRowIdentity('row-1', els), true);
    // The borrowing is a CLASS, same-task, on exactly the two header targets.
    assert.ok(els.from.classList.contains('rmorph-hide'));
    assert.ok(els.subject.classList.contains('rmorph-hide'));
    assert.ok(rm._flightForTest(), 'a flight is in flight');
    const [gFrom, gSubj] = ghostsOf(doc);
    assert.equal(ghostsOf(doc).length, 2, 'sender and subject ride separately');
    for (const g of [gFrom, gSubj]) {
      assert.equal(g.getAttribute('aria-hidden'), 'true');
      assert.match(g.style.cssText, /pointer-events:\s*none/, 'theatre never eats input');
      assert.match(g.style.cssText, /position:\s*fixed/);
      assert.match(g.style.cssText, /z-index:\s*220/);
    }
    assert.equal(gFrom.textContent, 'Alice Example', 'the ghost IS the row identity');
    // One frame in: the ghost has moved but is still near its SOURCE — the
    // journey reads row→header, never a destination flash.
    clock.frame();
    const first = tx(gFrom.style.transform);
    assert.ok(first, 'the spring writes transforms');
    assert.ok(Math.abs(first.x - 120) < Math.abs(first.x - 320), 'leaving the row...');
    pump(clock, 400); // full settle (interpolation itself is pinned separately)
    assert.equal(doc.contains(gFrom), false, 'rest removed the sender ghost');
    assert.equal(doc.contains(gSubj), false, 'rest removed the subject ghost');
    assert.equal(els.from.classList.length, 0, 'the header got its visibility back at rest');
    assert.equal(els.subject.classList.length, 0);
    assert.equal(rm._flightForTest(), null, 'no flight record survives its landing');
  } finally { tokens._setReducedForTest(null); settle(clock, restore); }
});

test('the flight passes through intermediate geometry (PANEL spring, undershoot-free start)', () => {
  const { doc, restore } = dom();
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  try {
    const els = stage(doc);
    rm.flyRowIdentity('row-1', els);
    const gFrom = ghostsOf(doc)[0];
    const seen = new Set();
    for (let i = 0; i < 120 && doc.contains(gFrom); i++) {
      clock.frame();
      if (doc.contains(gFrom)) seen.add(gFrom.style.transform);
    }
    assert.ok(seen.size >= 4, `interpolated (${seen.size} distinct poses), not a cut`);
    for (const s of seen) assert.ok(!s.includes('NaN'));
    pump(clock, 400); // let it land so finally-state is clean
    assert.equal(rm._flightForTest(), null);
  } finally { tokens._setReducedForTest(null); settle(clock, restore); }
});

test('abort mid-flight is total and synchronous — and nothing resurrects afterwards', async () => {
  const { doc, restore } = dom();
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  try {
    const els = stage(doc);
    rm.flyRowIdentity('row-1', els);
    pump(clock, 3); // genuinely airborne
    rm.abortRowIdentity(); // what closeReader does, mid-flight
    assert.equal(ghostsOf(doc).length, 0, 'ghosts die the same task');
    assert.equal(els.from.classList.length, 0, 'borrowed visibility returned the same task');
    assert.equal(rm._flightForTest(), null);
    rm.abortRowIdentity(); // idempotent — a double-Escape must not throw
    // No resurrection: not from the rest frame, not from a late fuse.
    pump(clock, 400);
    await new Promise((r) => setTimeout(r, 1300)); // outlive the REAL 1.2s fuse
    assert.equal(ghostsOf(doc).length, 0);
    assert.equal(els.from.classList.length, 0);
  } finally { tokens._setReducedForTest(null); settle(clock, restore); }
});

test('the fuse backstop alone lands a frozen flight — exactly once', async () => {
  const { doc, restore } = dom();
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  try {
    const els = stage(doc);
    rm.flyRowIdentity('row-1', els);
    // A backgrounded tab: zero frames ever pump. The fuse is the only janitor.
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(ghostsOf(doc).length, 0, 'the fuse removed the ghosts');
    assert.equal(els.from.classList.length, 0, 'the fuse returned the visibility');
    assert.equal(rm._flightForTest(), null);
    // Foreground again: the frozen spring was cancelled by land() (fix cycle 2),
    // so pumping is silent — no re-land, no re-remove, no throw.
    pump(clock, 400);
    assert.equal(ghostsOf(doc).length, 0);
    assert.equal(els.from.classList.length, 0);
  } finally { tokens._setReducedForTest(null); settle(clock, restore); }
});

test('a new flight supersedes the airborne one totally (hammer the list, open fast)', async () => {
  const { doc, restore } = dom();
  const clock = fakeClock();
  tokens._setReducedForTest(false);
  try {
    let els = stage(doc, 'row-1');
    rm.flyRowIdentity('row-1', els);
    const firstFlight = rm._flightForTest();
    const firstGhosts = ghostsOf(doc);
    pump(clock, 2);
    els = stage(doc, 'row-2'); // the SAME header targets: visibility re-borrowed
    assert.equal(rm.flyRowIdentity('row-2', els), true);
    assert.notEqual(rm._flightForTest(), firstFlight);
    assert.ok(firstGhosts.every((g) => !doc.contains(g)), 'flight-1 ghosts died at supersede');
    assert.equal(ghostsOf(doc).length, 2, 'exactly flight-2 is airborne');
    assert.ok(els.from.classList.contains('rmorph-hide'), 're-borrowed for the new flight');
    pump(clock, 400);
    assert.equal(rm._flightForTest(), null, 'flight 2 lands clean');
    assert.equal(ghostsOf(doc).length, 0);
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(ghostsOf(doc).length, 0, 'flight-1s cleared fuse can never fire back');
  } finally { tokens._setReducedForTest(null); settle(clock, restore); }
});
