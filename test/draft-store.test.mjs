/**
 * Draft autosave tests.
 *
 * Every test here is about NOT LOSING TYPING. The happy path is trivial; the
 * cases that matter are close, crash, send-failure and quota-failure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeStorage } from './helpers/storage.mjs';

const {
  createDraftSaver, saveDraft, loadDraft, clearDraft, isMeaningful, AUTOSAVE_MS,
} = await import('../src/app/draft-store.js');


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

/*
 * features.js is now a barrel; compose and the rest live in their own modules.
 * Scanning only the barrel would find nothing and pass vacuously.
 */
const feat = ['features.js','undo-actions.js','radar.js','palette.js','compose.js','autocomplete.js']
  .map((f) => readFileSync(new URL(`../src/app/${f}`, import.meta.url), 'utf8')).join('\n');
const app = readFileSync(new URL('../src/app/app.js', import.meta.url), 'utf8');

test('the recovery copy is cleared only AFTER the message is durable', () => {
  /*
   * THE BOUNDARY MOVED, THE GUARANTEE DID NOT.
   *
   * This used to require `discard()` to come after `ctx.send('SEND')`, because
   * a direct send that failed would otherwise have destroyed the only copy.
   *
   * Sending is now QUEUED: doSend persists the draft to the outbox, which
   * survives a tab close and retries with backoff, and the worker is called
   * later by the runner. So the moment the message becomes safe is the
   * `saveOutbox` call, not the network round trip -- and clearing after the
   * enqueue is correct rather than premature.
   *
   * The property being protected is unchanged: the local recovery copy must
   * never be dropped while the message exists nowhere else.
   */
  const fn = feat.slice(feat.indexOf('async function doSend'), feat.indexOf('async function openTemplateMenu'));
  const queueAt = fn.indexOf('saveOutbox');
  const clearAt = fn.indexOf('discard()');
  assert.ok(queueAt > 0, 'the draft must be handed to the durable queue');
  assert.ok(clearAt > queueAt, 'clearing before the queue write would lose the message');
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

// ---------------------------------------------- attachment persistence pins --

test('autosave never persists attachment base64 (bug-hunt: charter vs reality)', async () => {
  // The charter says crash recovery restores text, not attachments; the old
  // code persisted the entire collected draft, megabytes of base64 included,
  // on every 800ms autosave. The stored shape must carry metadata only.
  const s = fakeStorage();
  const draft = {
    to: 'a@b.c', subject: 's', body: 'typed', baseBody: '',
    attachments: [
      { filename: 'big.pdf', mimeType: 'application/pdf', size: 999, data: 'A'.repeat(5000) },
      { filename: 'kept.pdf', mimeType: 'application/pdf', size: 5,
        attachmentId: 'att1', messageId: 'm1' },
    ],
  };
  assert.equal(await saveDraft(draft, s), true);
  const stored = (await s.get('composeDraft')).composeDraft;
  assert.equal(stored.attachments[0].data, undefined, 'fresh-file base64 must not reach storage');
  assert.equal(stored.attachments[0].filename, 'big.pdf', 'its name survives for honesty');
  assert.equal(stored.attachments[1].attachmentId, 'att1', 'preserved parts keep their refetch source');
  assert.equal(stored.attachments[1].messageId, 'm1');
});

test('editDraft carries preserved attachments into the panel (bug-hunt P0)', async () => {
  // Source wiring pins: the app side of the preservation contract. Without
  // these, the worker hydrates nothing and the files are rebuilt away.
  const { readFileSync } = await import('node:fs');
  const compose = readFileSync(new URL('../src/app/compose.js', import.meta.url), 'utf8');

  const edit = compose.slice(compose.indexOf('export async function editDraft'), compose.indexOf('export async function editDraft') + 1400);
  assert.ok(edit.includes('attachments: d.attachments || []'),
    'editDraft must hand the draft attachments to openCompose');

  const open = compose.slice(compose.indexOf('export function openCompose'), compose.indexOf('export function openCompose') + 2500);
  assert.ok(open.includes('f.attachmentId && f.messageId'),
    'metadata-only (preserved) attachments must be accepted, not filtered out');
});

test('autosave of a draft with a large attachment stays small (regression)', async () => {
  /*
   * The defect behind bug-hunt P0's companion finding: every 800ms autosave
   * serialised the WHOLE draft, megabytes of attachment base64 included,
   * into the same storage the message cache lives in. This pins the whole
   * saver path -- schedule, debounce, write -- not just storable(): a 3MB
   * attachment must produce a blob that is kilobytes, and the identity
   * skip must still fire on unchanged drafts.
   */
  const s = fakeStorage();
  const big = 'A'.repeat(3 * 1024 * 1024);
  let collected = 0;
  const saver = createDraftSaver(() => {
    collected++;
    return {
      to: 'a@b.c', subject: 's', body: 'typed text', baseBody: '',
      attachments: [
        { filename: 'big.pdf', mimeType: 'application/pdf', size: 3 * 1024 * 1024, data: big },
        { filename: 'kept.pdf', mimeType: 'application/pdf', size: 5,
          attachmentId: 'att-9', messageId: 'm-9' },
      ],
    };
  }, s, { setTimeout: (fn) => setTimeout(fn, 5), clearTimeout });

  saver.schedule();
  await new Promise((r) => setTimeout(r, 40));

  const stored = (await s.get('composeDraft')).composeDraft;
  const bytes = JSON.stringify(stored).length;
  assert.ok(bytes < 10_000, `the blob must be tiny without the base64 (got ${bytes})`);
  assert.equal(stored.attachments[0].data, undefined, 'chosen file: name kept, bytes dropped');
  assert.equal(stored.attachments[1].attachmentId, 'att-9', 'preserved file: refetch source kept');
  assert.ok(collected >= 1);
});

test('the template menu reads the course from the store, not the wire (bug-hunt #24)', async () => {
  // Wiring pin for the {{course}} fix: compose must reach for the canonical
  // classified record via ctx.store, not expect GET_BODY to carry a field it
  // does not have (and never add a second course-detection mechanism).
  const { readFileSync } = await import('node:fs');
  const compose = readFileSync(new URL('../src/app/compose.js', import.meta.url), 'utf8');
  const menu = compose.slice(compose.indexOf('async function openTemplateMenu'), compose.indexOf('async function openTemplateMenu') + 1200);
  assert.ok(menu.includes('ctx.store?.get?.(replyTo.id)'),
    'the course comes from the canonical store record');
  assert.ok(menu.includes('rec?.courses?.[0]'),
    'and from its stamped courses field');
});

test('saveDraft persists the storable shape, never the raw draft (enforcement pin)', async () => {
  /*
   * The metadata-only persistence is the regression guard for the autosave
   * quota defect. This pins the ENFORCEMENT itself: the write must go
   * through storable(), so a future "simplification" back to the raw draft
   * fails here before it ever reaches a quota.
   */
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/app/draft-store.js', import.meta.url), 'utf8');
  assert.match(src, /await storage\.set\(\{ \[KEY\]: storable\(draft, now\) \}\)/,
    'saveDraft must write the storable() shape');
  assert.ok(!/await storage\.set\(\{ \[KEY\]: \{ \.\.\.draft/.test(src),
    'the raw-draft write must never come back');

  // Behavioural twin: two attachments of different kinds, both stripped of
  // data, metadata preserved for the refetchable one.
  const s = fakeStorage();
  await saveDraft({
    to: 'a@b.c', subject: 's', body: 'text', baseBody: '',
    attachments: [
      { filename: 'chosen.bin', mimeType: 'application/octet-stream', size: 100, data: 'AAAA' },
      { filename: 'kept.pdf', mimeType: 'application/pdf', size: 7, attachmentId: 'a-7', messageId: 'm-7' },
    ],
  }, s);
  const stored = (await s.get('composeDraft')).composeDraft;
  for (const a of stored.attachments) assert.equal(a.data, undefined, 'no base64 in storage');
  assert.equal(stored.attachments[1].attachmentId, 'a-7');
});
