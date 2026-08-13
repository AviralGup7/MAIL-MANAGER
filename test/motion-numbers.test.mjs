/**
 * Number tweens (animation overhaul P2; directive §14).
 *
 * The pin: format preservation (prefix/suffix travel), exact final values,
 * reduced-motion instantness, and the no-number honesty rule (no invented
 * zero-to-value theatre when there is nothing to interpolate from).
 *
 * Deterministic via the same fake-frame-clock pattern as motion-spring's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { tweenNumber } = await import('../src/app/motion/numbers.js?q=' + Math.random());
const { _setReducedForTest } = await import('../src/app/motion/tokens.js');

function fakeClock() {
  let queue = [];
  let t = 0;
  globalThis.requestAnimationFrame = (fn) => { queue.push(fn); return queue.length; };
  globalThis.performance = { now: () => t };
  return {
    frame() { t += 1000 / 60; const q = queue; queue = []; for (const fn of q) fn(t); },
    restore() { delete globalThis.requestAnimationFrame; delete globalThis.performance; },
  };
}

const el = (text) => ({ textContent: text });

test('the value tweens while the decoration stays bolted on', () => {
  _setReducedForTest(null);
  const clock = fakeClock();
  try {
    const host = el('8 unread');
    const h = tweenNumber(host, 20);
    assert.ok(h.running());
    clock.frame();
    clock.frame();
    assert.match(host.textContent, /^\d+ unread$/, 'suffix survives every intermediate frame');
    const mid = Number(host.textContent.match(/^(\d+)/)[1]);
    assert.ok(mid > 8 && mid <= 21, `mid-flight shows an interpolating value (got ${mid})`);
    for (let i = 0; i < 400 && h.running(); i++) clock.frame();
    assert.equal(host.textContent, '20 unread', 'final frame is exact');
    assert.equal(h.running(), false);
  } finally {
    clock.restore();
  }
});

test('integers stay integers through the whole flight (no 12.000000)', () => {
  const clock = fakeClock();
  try {
    const host = el('12');
    tweenNumber(host, 13);
    for (let i = 0; i < 10; i++) {
      clock.frame();
      assert.match(host.textContent, /^\d+$/, `frame ${i}: ${host.textContent}`);
    }
  } finally {
    clock.restore();
  }
});

test('no starting number: set the truth plainly, invent no history', () => {
  _setReducedForTest(null);
  const host = el('—');
  const h = tweenNumber(host, 5);
  assert.equal(host.textContent, '5');
  assert.equal(h.running(), false, 'no rAF, no fake ascension');
});

test('reduced motion: the value lands in the same task', () => {
  _setReducedForTest(true);
  const host = el('3 labels');
  const h = tweenNumber(host, 9);
  assert.equal(host.textContent, '9 labels');
  assert.equal(h.running(), false);
  _setReducedForTest(null);
});
