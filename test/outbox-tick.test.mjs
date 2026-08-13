/**
 * The outbox countdown tick (roadmap Phase 5, browser-measured).
 *
 * WHY THIS PIN EXISTS
 * -------------------
 * The Phase-5 verify (2026-08-13, real headless browser, preview mock
 * worker) measured the outbox's repaint behaviour transition by transition:
 *
 *   enqueue -> rail row          ~340ms end-to-end (one worker round trip
 *                                + one render, mock latency included)  OK
 *   due -> sent -> row leaves    ~140ms after releaseAt                OK
 *   external delete -> self-heal 4.3s, bounded by the page's own armed
 *                                wake; no event subscription needed    OK
 *   held countdown text          FROZEN: "Sending in 5s" for the whole
 *                                5s hold, then the row vanished        WRONG
 *
 * A countdown that does not count is the "number that sits there unchanged"
 * outbox.js itself calls the stuck-queue tell. The fix is one 1s repaint of
 * rail TEXT while any row's status is time-derived -- local storage only,
 * the worker is never woken to move a label.
 *
 * These pins freeze: the needsTick truth table (what is time-derived and
 * what is not), the render->tick coupling (armed only while a countdown is
 * on screen), and the two clear paths (every render, and cancelOutboxTimer
 * on shell teardown). No subscriber architecture was added anywhere -- the
 * roadmap's caution stands recorded in the measurements, not just obeyed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const railsSrc = read('src/app/workspace/rails.js');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

const NOW = 1_800_000_000_000;
const heldWaiting = { id: 'a', state: 'held', releaseAt: NOW + 5000, draft: { to: 'x@y.in' } };
const heldDue     = { id: 'b', state: 'held', releaseAt: NOW - 1,    draft: { to: 'x@y.in' } };
const failedWait  = { id: 'c', state: 'failed', attempts: 1, nextAttempt: NOW + 15000, draft: { to: 'x@y.in' } };
const failedDue   = { id: 'd', state: 'failed', attempts: 1, nextAttempt: NOW - 1,     draft: { to: 'x@y.in' } };
const stuckItem   = { id: 'e', state: 'failed', attempts: 4, nextAttempt: NOW + 900000, error: 'boom', draft: { to: 'x@y.in' } };

test('needsTick: only rows whose shown text is a live countdown', async () => {
  const { needsTick } = await import('../src/app/workspace/rails.js?t=' + Math.random());
  assert.ok(needsTick([heldWaiting], NOW), 'a held item inside its undo window counts down');
  assert.ok(!needsTick([heldDue], NOW),
    'held-but-due says "Sending…" until the pump lands -- ticking now would pre-empt the pump by a second');
  assert.ok(needsTick([failedWait], NOW), '"Retrying in 15s" is a countdown too');
  assert.ok(!needsTick([failedDue], NOW), '"Retrying now" is static until the pump, same as Sending…');
  assert.ok(!needsTick([stuckItem], NOW), 'a stuck row shows its error, no countdown, no tick');
  assert.ok(!needsTick([], NOW), 'empty queue: nothing to say, nothing to schedule');
  // One live row anywhere is enough to keep the whole rail honest.
  assert.ok(needsTick([stuckItem, heldWaiting], NOW), 'a mixed list still ticks for its live row');
});

test('renderOutbox arms the tick only while a countdown is on screen', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const dom = new JSDOM('<div id="outbox" hidden><ul id="outbox-list"></ul></div>');
  const prev = {};
  for (const k of ['window', 'document', 'HTMLElement', 'Node']) prev[k] = globalThis[k];
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  try {
    const rails = await import('../src/app/workspace/rails.js?t=' + Math.random());
    const future = Date.now() + 5000;
    await rails.renderOutbox([{ ...heldWaiting, releaseAt: future }]);
    assert.equal(dom.window.document.getElementById('outbox').hidden, false, 'the section appears');
    assert.match(dom.window.document.querySelector('.outbox-status').textContent,
      /^Sending in \ds$/, 'the countdown text renders');
    assert.ok(rails._outboxTickArmed(), 'armed while the countdown shows');

    // Stuck rows offer the way out and do NOT tick (focus safety: they are
    // the only rows with buttons, and a re-rendering list must not steal it).
    await rails.renderOutbox([stuckItem]);
    assert.ok(!rails._outboxTickArmed(), 'cleared when no countdown remains');
    assert.match(dom.window.document.querySelector('.outbox-status').textContent,
      /Could not send/, 'the stuck row shows its error');

    await rails.renderOutbox([]);
    assert.ok(!rails._outboxTickArmed(), 'cleared on empty');
    assert.equal(dom.window.document.getElementById('outbox').hidden, true, 'the section folds away');
  } finally {
    Object.assign(globalThis, prev);
    try { dom.window.close(); } catch { /* best effort */ }
  }
});

test('the tick is coupled to the pump timer, not a parallel architecture', () => {
  // cancelOutboxTimer is the shell's one teardown call; it must drop BOTH
  // timers or a cancelled shell keeps repainting a list nobody owns.
  const fn = railsSrc.slice(railsSrc.indexOf('export function cancelOutboxTimer'));
  assert.match(fn.split('}')[0], /clearTimeout\(outboxTimer\)/, 'pump timer dropped');
  assert.match(fn.split('}')[0], /clearTimeout\(outboxTick\)/, 'countdown tick dropped with it');
  // And the re-render the tick schedules reloads LOCAL storage -- a worker
  // wake for a one-second label move is exactly the cost this avoids.
  const tick = railsSrc.slice(railsSrc.indexOf('outboxTick = setTimeout'));
  assert.match(tick.slice(0, 120), /setTimeout\(\(\) => renderOutbox\(\), 1000\)/,
    'one second, renderOutbox with no args = local reload, zero worker traffic');
});
