/**
 * Draft autosave tests.
 *
 * Every test here is about NOT LOSING TYPING. The happy path is trivial; the
 * cases that matter are close, crash, send-failure and quota-failure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  createDraftSaver, saveDraft, loadDraft, clearDraft, isMeaningful, AUTOSAVE_MS,
} = await import('../src/app/draft-store.js');

function fakeStorage(initial = {}) {
  let data = { ...initial };
  return {
    writes: 0,
    async get(k) { return typeof k === 'string' ? { [k]: data[k] } : { ...data }; },
    async set(obj) { this.writes++; data = { ...data, ...obj }; },
    async remove(k) { delete data[k]; },
    _data: () => data,
  };
}

/** A controllable clock so nothing here sleeps. */
function fakeTimers() {
  let queued = null;
  let nextId = 1;
  return {
    setTimeout: (fn) => { queued = fn; return nextId++; },
    clearTimeout: () => { queued = null; },
    run() { const f = queued; queued = null; if (f) f(); },
    get armed() { return queued !== null; },
  };
}

// ------------------------------------------------------------ meaningful ---

test('an untouched panel is not worth saving', () => {
  assert.equal(isMeaningful({ to: '', cc: '', subject: '', body: '' }), false);
  assert.equal(isMeaningful(null), false);
  assert.equal(isMeaningful({}), false);
});

test('whitespace alone is not meaningful', () => {
  assert.equal(isMeaningful({ to: '   ', subject: '\t', body: '\n\n  ' }), false);
});

test('any real field makes a draft meaningful', () => {
  assert.ok(isMeaningful({ to: 'a@b.com' }));
  assert.ok(isMeaningful({ subject: 'Hi' }));
  assert.ok(isMeaningful({ body: 'text' }));
  assert.ok(isMeaningful({ cc: 'c@d.com' }));
});

/*
 * THE REPLY CASE.
 *
 * openCompose pre-fills a reply with the quoted original. That is not the
 * user typing, so an untouched reply panel must not be offered back to them
 * as "your unsent message".
 */
test('a reply with only its quoted original is not "typed something"', () => {
  const quoted = '\n\n> original message';
  assert.equal(isMeaningful({ body: quoted, baseBody: quoted }), false);
  assert.ok(
    isMeaningful({ body: `Thanks!${quoted}`, baseBody: quoted }),
    'once the user types above the quote it counts'
  );
});

// --------------------------------------------------------------- storage ---

test('a draft round-trips and carries a timestamp', async () => {
  const s = fakeStorage();
  await saveDraft({ to: 'a@b.com', subject: 'S', body: 'B' }, s, 1234);
  const d = await loadDraft(s);
  assert.equal(d.to, 'a@b.com');
  assert.equal(d.savedAt, 1234);
});

test('an empty stored draft is not offered for restore', async () => {
  const s = fakeStorage();
  await saveDraft({ to: '', subject: '', body: '' }, s);
  assert.equal(await loadDraft(s), null);
});

test('a corrupt stored draft does not throw', async () => {
  for (const bad of ['garbage', 7, [], null]) {
    const s = fakeStorage({ composeDraft: bad });
    assert.equal(await loadDraft(s), null);
  }
});

test('a storage quota failure is reported, not thrown', async () => {
  const s = fakeStorage();
  s.set = async () => { throw new Error('QUOTA_BYTES exceeded'); };
  assert.equal(await saveDraft({ to: 'a@b.com' }, s), false);
});

test('clearing a draft that is not there is not an error', async () => {
  const s = fakeStorage();
  assert.equal(await clearDraft(s), true);
});

// ---------------------------------------------------------------- saver ----

test('typing debounces into a single write', async () => {
  const s = fakeStorage();
  const t = fakeTimers();
  let body = '';
  const saver = createDraftSaver(() => ({ to: 'a@b.com', body }), s, {
    setTimeout: t.setTimeout, clearTimeout: t.clearTimeout,
  });

  for (const ch of 'hello') {
    body += ch;
    saver.schedule();
  }
  assert.equal(s.writes, 0, 'must not write on every keystroke');
  t.run();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.writes, 1, 'five keystrokes, one write');
  assert.equal((await loadDraft(s)).body, 'hello');
});

test('flush writes immediately and cancels the pending timer', async () => {
  const s = fakeStorage();
  const t = fakeTimers();
  const saver = createDraftSaver(() => ({ to: 'a@b.com', body: 'x' }), s, {
    setTimeout: t.setTimeout, clearTimeout: t.clearTimeout,
  });
  saver.schedule();
  assert.ok(t.armed);
  await saver.flush();
  assert.equal(s.writes, 1);
  assert.equal(t.armed, false, 'flush must disarm the timer');
});

/*
 * THE CRASH CASE. pagehide fires and the debounce timer will never run. If
 * flush() only worked via the timer, everything typed in the last 800ms is
 * gone -- which is exactly the bug this module exists to prevent.
 */
test('flush works even when the timer never fires', async () => {
  const s = fakeStorage();
  const t = fakeTimers();
  const saver = createDraftSaver(() => ({ to: 'a@b.com', body: 'unsaved' }), s, {
    setTimeout: t.setTimeout, clearTimeout: t.clearTimeout,
  });
  saver.schedule();
  await saver.flush(); // simulates pagehide
  assert.equal((await loadDraft(s)).body, 'unsaved');
});

test('identical content is not rewritten', async () => {
  const s = fakeStorage();
  const t = fakeTimers();
  const saver = createDraftSaver(() => ({ to: 'a@b.com', body: 'same' }), s, {
    setTimeout: t.setTimeout, clearTimeout: t.clearTimeout,
  });
  await saver.flush();
  await saver.flush();
  await saver.flush();
  assert.equal(s.writes, 1, 'moving the caret should not cost a write');
});

test('an empty panel never writes at all', async () => {
  const s = fakeStorage();
  const t = fakeTimers();
  const saver = createDraftSaver(() => ({ to: '', body: '' }), s, {
    setTimeout: t.setTimeout, clearTimeout: t.clearTimeout,
  });
  await saver.flush();
  assert.equal(s.writes, 0);
});

test('discard removes the slot and disarms the timer', async () => {
  const s = fakeStorage();
  const t = fakeTimers();
  const saver = createDraftSaver(() => ({ to: 'a@b.com', body: 'x' }), s, {
    setTimeout: t.setTimeout, clearTimeout: t.clearTimeout,
  });
  await saver.flush();
  assert.ok(await loadDraft(s));
  saver.schedule();
  await saver.discard();
  assert.equal(await loadDraft(s), null);
  assert.equal(t.armed, false);
});

test('after discard, the same content saves again', async () => {
  // The de-dupe cache must be cleared by discard, or re-typing the same
  // message after discarding it would silently not be saved.
  const s = fakeStorage();
  const t = fakeTimers();
  const saver = createDraftSaver(() => ({ to: 'a@b.com', body: 'x' }), s, {
    setTimeout: t.setTimeout, clearTimeout: t.clearTimeout,
  });
  await saver.flush();
  await saver.discard();
  await saver.flush();
  assert.ok(await loadDraft(s), 'content after a discard must persist again');
});

// --------------------------------------------------------- wiring checks ---

const feat = readFileSync(new URL('../src/app/features.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app/app.js', import.meta.url), 'utf8');

test('the recovery copy is cleared only AFTER a send succeeds', () => {
  const fn = feat.slice(feat.indexOf('async function doSend'), feat.indexOf('async function doDraft'));
  const sendAt = fn.indexOf("ctx.send('SEND'");
  const clearAt = fn.indexOf('discard()');
  assert.ok(sendAt > 0 && clearAt > sendAt, 'clearing before the send would destroy the message on failure');
  // And it must be inside the try, not the catch.
  assert.ok(!fn.slice(fn.indexOf('} catch')).includes('discard()'));
});

test('closing compose discards the recovery copy too', () => {
  // Otherwise the user is offered back the message they just threw away.
  const fn = feat.slice(feat.indexOf("$('compose-close').addEventListener"));
  assert.ok(fn.slice(0, 600).includes('discard()'));
});

test('autosave is wired by delegation, not per field', () => {
  // A per-field listener is forgotten the next time a field is added.
  assert.match(feat, /panel\.addEventListener\('input'/);
});

test('pagehide flushes the draft', () => {
  const fn = app.slice(app.indexOf("addEventListener('pagehide'"));
  assert.ok(fn.slice(0, 300).includes('flushDraft()'));
});

test('restore is offered, never automatic', () => {
  // Silently reopening compose on load is startling, and the message may
  // already have been sent from another device.
  assert.ok(feat.includes('confirm('), 'restore must ask');
  const fn = feat.slice(feat.indexOf('export async function restoreDraftIfAny'));
  assert.ok(fn.slice(0, 800).includes('discard()'), 'declining must forget the draft');
});

test('the autosave delay is short enough to matter', () => {
  assert.ok(AUTOSAVE_MS <= 1000, 'losing a second of typing is acceptable; more is not');
});

/*
 * Mutation-testing gap: `return timer !== null` -> `=== null` survived,
 * because nothing asserted the `pending` getter both ways. It is the only
 * way a caller can tell whether unsaved keystrokes are still buffered.
 */
test('pending reports whether a write is actually buffered', async () => {
  const s = fakeStorage();
  const t = fakeTimers();
  const saver = createDraftSaver(() => ({ to: 'a@b.com', body: 'x' }), s, {
    setTimeout: t.setTimeout, clearTimeout: t.clearTimeout,
  });

  assert.equal(saver.pending, false, 'nothing typed yet');
  saver.schedule();
  assert.equal(saver.pending, true, 'a write is buffered');
  await saver.flush();
  assert.equal(saver.pending, false, 'flush clears it');
  saver.schedule();
  await saver.discard();
  assert.equal(saver.pending, false, 'discard clears it too');
});
