/**
 * Outbox/send acceptance suite — roadmap Phase 1 (HIGH #2).
 *
 * The audit verdict: the outbox DESIGN is strong; what was missing was
 * explicit acceptance coverage for the concerns the synthesis list carried —
 * queue ordering, pump re-arm, failure-messaging discipline, idle behaviour.
 * (Cancellation races, namespaced ids, hydration and backoff already live in
 * outbox.test.mjs / worker-dispatch / parity; they are NOT re-tested here.)
 *
 * Everything here tests the REAL pump path in rails.js against a fake worker
 * verb and a fake storage area — no mock of the module under test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const rails = await import('../src/app/rails.js');
const outbox = await import('../src/app/outbox.js');
const { initToast } = await import('../src/app/toast.js');
const { fakeStorage } = await import('./helpers/storage.mjs');

/** jsdom gives the pump a document (rail DOM guards no-op without nodes). */
function withDom(fn) {
  const dom = new JSDOM('<div id="outbox" hidden><ul id="outbox-list"></ul></div>' +
    '<div id="toast" hidden><span id="toast-text"></span>' +
    '<button id="toast-action" hidden></button><span id="toast-drain"></span>' +
    '<span id="toast-icon"></span><kbd id="toast-kbd"></kbd></div>');
  const prevDoc = globalThis.document;
  globalThis.document = dom.window.document;
  return Promise.resolve()
    .then(() => fn(dom.window.document))
    .finally(() => { globalThis.document = prevDoc; });
}

/** Capture the pump's re-arm timers instead of letting them fire. */
function captureTimers() {
  const captured = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { captured.push(ms); return 0; };
  return {
    captured,
    restore: () => { globalThis.setTimeout = real; },
  };
}

function wirePump(sendImpl) {
  rails.wireRails({
    get store() { return {}; },
    state: {},
    send: sendImpl,
    refresh: async () => {},
    overrides: () => ({}),
  });
}

test('SEND ORDERING: fresh sends outrank retries, retries stay oldest-first', () => {
  // The model contract (outbox.prioritizeDue) and — pinned below — the fact
  // that the worker pump ACTUALLY dispatches through it.
  const mk = (id, state, queuedAt) => ({
    id, state, draft: { to: 'x@y.z' }, queuedAt, releaseAt: 0, attempts: state === 'failed' ? 1 : 0, nextAttempt: 0,
  });
  const out = outbox.prioritizeDue([
    mk('q:retry-old', 'failed', 1),
    mk('q:fresh-1', 'held', 5),
    mk('q:retry-new', 'failed', 2),
    mk('q:fresh-2', 'held', 6),
  ]);
  assert.deepEqual(out.map((i) => i.id),
    ['q:fresh-1', 'q:fresh-2', 'q:retry-old', 'q:retry-new'],
    'held-first, stable within each class');

  const bg = readFileSync(new URL('../src/background/index.js', import.meta.url), 'utf8');
  assert.match(bg, /prioritizeDue\(dueItems\(items\)\)/,
    'the worker dispatches exactly the ordered due set');
});

test('RE-ARM: leftover work re-arms the pump on the short leash', () => withDom(async () => {
  const area = fakeStorage();
  globalThis.chrome = { storage: { local: area } };
  await outbox.saveOutbox([outbox.enqueue({ to: 'a@b.c' }, { holdMs: 0 })], area);
  wirePump(async () => ({ sent: 1, sentIds: ['g:1'], more: true }));

  const t = captureTimers();
  try {
    await rails.pumpOutbox();
    // The pump's own re-arm is the short leash; other captured timers belong
    // to batched subsystems (activity flush) and are none of this test's
    // business. When `more` is set the wake logic is skipped entirely — the
    // leash is the contract.
    assert.ok(t.captured.includes(250), 'leftover work re-arms on the short leash');
  } finally { t.restore(); }
}));

test('RE-ARM: a future hold schedules exactly the next wake, never sooner', () => withDom(async () => {
  const area = fakeStorage();
  globalThis.chrome = { storage: { local: area } };
  const item = outbox.enqueue({ to: 'a@b.c' }, { holdMs: 5000 });
  await outbox.saveOutbox([item], area);
  wirePump(async () => ({ sent: 0, failed: 0, skipped: false }));

  const t = captureTimers();
  try {
    await rails.pumpOutbox();
    assert.equal(t.captured.length, 1, 'one re-arm');
    const delay = t.captured[0];
    assert.ok(delay > 250 && delay <= 5000,
      `the wake follows the hold (${delay}ms), not the short leash`);
  } finally { t.restore(); }
}));

test('IDLE: nothing due means no timer at all — the pump never polls', () => withDom(async () => {
  const area = fakeStorage();
  globalThis.chrome = { storage: { local: area } };
  await outbox.saveOutbox([], area);
  wirePump(async () => ({ sent: 0, failed: 0, skipped: false }));

  const t = captureTimers();
  try {
    await rails.pumpOutbox();
    assert.deepEqual(t.captured, [], 'an idle pump schedules nothing');
  } finally { t.restore(); }
}));

test('MESSAGING: one toast per failure episode — retries stay quiet', () => withDom(async (doc) => {
  const area = fakeStorage();
  globalThis.chrome = { storage: { local: area } };
  await outbox.saveOutbox([outbox.enqueue({ to: 'a@b.c' }, { holdMs: 0 })], area);

  initToast({
    toast: doc.getElementById('toast'),
    toastText: doc.getElementById('toast-text'),
    toastAction: doc.getElementById('toast-action'),
    toastDrain: doc.getElementById('toast-drain'),
    toastIcon: doc.getElementById('toast-icon'),
    toastKbd: doc.getElementById('toast-kbd'),
  });
  const writes = [];
  const textEl = doc.getElementById('toast-text');
  Object.defineProperty(textEl, 'textContent', {
    get() { return writes[writes.length - 1] || ''; },
    set(v) { writes.push(v); },
    configurable: true,
  });

  let fail = true;
  wirePump(async () => {
    if (fail) throw new Error('worker down');
    return { sent: 1, sentIds: ['g:1'], more: false };
  });

  const t = captureTimers();
  try {
    await rails.pumpOutbox();                       // episode starts
    await rails.pumpOutbox();                       // still failing: quiet
    const pauseWrites = writes.filter((w) => w === 'Outbox paused — sending will retry');
    assert.equal(pauseWrites.length, 1, 'the pause is announced exactly once');

    fail = false;
    await rails.pumpOutbox();                       // success ends the episode
    fail = true;
    await rails.pumpOutbox();                       // new failure: new episode
    const after = writes.filter((w) => w === 'Outbox paused — sending will retry');
    assert.equal(after.length, 2, 'a recovered episode may announce again');
  } finally { t.restore(); }
}));

test('MESSAGING: a give-up is announced once, with a way to see it', () => withDom(async (doc) => {
  const area = fakeStorage();
  globalThis.chrome = { storage: { local: area } };
  const stuck = {
    ...outbox.enqueue({ to: 'someone@example.com' }, { holdMs: 0 }),
    state: 'failed',
    attempts: outbox.MAX_ATTEMPTS,
  };
  await outbox.saveOutbox([stuck], area);

  initToast({
    toast: doc.getElementById('toast'),
    toastText: doc.getElementById('toast-text'),
    toastAction: doc.getElementById('toast-action'),
    toastDrain: doc.getElementById('toast-drain'),
    toastIcon: doc.getElementById('toast-icon'),
    toastKbd: doc.getElementById('toast-kbd'),
  });
  const writes = [];
  const textEl2 = doc.getElementById('toast-text');
  Object.defineProperty(textEl2, 'textContent', {
    get() { return writes[writes.length - 1] || ''; },
    set(v) { writes.push(v); },
    configurable: true,
  });

  wirePump(async () => ({ sent: 0, failed: 0, skipped: false }));
  const t = captureTimers();
  try {
    await rails.pumpOutbox();
    await rails.pumpOutbox();
    const announced = writes.filter((w) => /could not send/i.test(w));
    assert.equal(announced.length, 1, 'the give-up is announced exactly once');
    assert.match(announced[0], /someone@example\.com/,
      'and it names who it could not reach');
  } finally { t.restore(); }
}));
