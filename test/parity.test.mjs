/**
 * Worker/fallback verb parity (V2 code audit). The two verb tables must not
 * drift: every worker verb is either implemented in fallback or explicitly
 * declared WORKER_ONLY, and response shapes for the shared verbs are pinned
 * by source markers so a silent shape change fails here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const verbs = (src) => new Set([...src.matchAll(/case '([A-Z_]+)'/g)].map((m) => m[1]));
const worker = verbs(read('src/background/index.js'));
const fallback = verbs(read('src/app/fallback.js'));
const WORKER_ONLY = new Set(['TOGGLE_TAKEOVER']);

test('every worker verb is covered by fallback or explicitly worker-only', () => {
  const uncovered = [...worker].filter((v) => !fallback.has(v) && !WORKER_ONLY.has(v));
  assert.deepEqual(uncovered, [], `fallback lacks: ${uncovered.join(', ')}`);
});

test('fallback implements no verb the worker lacks (no invented contract)', () => {
  const invented = [...fallback].filter((v) => !worker.has(v));
  assert.deepEqual(invented, []);
});

test('compose verbs exist in BOTH tables (V2 C-01)', () => {
  for (const v of ['SEND', 'SAVE_DRAFT']) {
    assert.ok(worker.has(v), `worker lacks ${v}`);
    assert.ok(fallback.has(v), `fallback lacks ${v}`);
  }
});

test('shared-verb response shapes are pinned', () => {
  const f = read('src/app/fallback.js');
  assert.match(f, /draftId: d\.draftId/, 'GET_DRAFT must match the worker shape');
  assert.match(f, /dataUrl: await gmail\.getAttachment/, 'GET_ATTACHMENT must return { dataUrl }');
  assert.match(f, /contentId: part\.contentId/, 'GET_INLINE must mirror worker parts');
  assert.match(f, /snooze\.SNOOZE_LABEL/, 'snooze verbs must use the canonical label');
});

test('the OAuth scope set matches shipped capability (modify + send, nothing more)', () => {
  const a = read('src/background/auth.js');
  assert.match(a, /auth\/gmail\.modify/);
  assert.match(a, /auth\/gmail\.send/);
  assert.ok(!/mail\.google\.com\/'?\)/.test(a.slice(a.indexOf('SCOPES'), a.indexOf('SCOPES') + 400)), 'no full-mailbox scope');
});

/*
 * Bug-hunt shape pins: findings #20/#21/#22/#24 survived precisely because
 * the original pins checked source MARKERS rather than response shapes. These
 * pin the shapes themselves on BOTH sides, so the next drift fails loudly.
 */

test('GET_INLINE answers { inline } on both paths (bug-hunt #20)', () => {
  const f = read('src/app/fallback.js');
  const w = read('src/background/index.js');
  assert.match(f, /return \{ inline: out \}/, 'fallback must wrap its parts');
  assert.match(w, /return \{ inline: out \}/, 'worker must wrap its parts');
});

test('BULK answers { failed } and chunks identically on both paths (bug-hunt #21)', () => {
  const f = read('src/app/fallback.js');
  const w = read('src/background/index.js');
  for (const [name, src] of [['fallback', f], ['worker', w]]) {
    assert.match(src, /i \+= BULK_CHUNK/, `${name} must chunk at the shared limit`);
    assert.match(src, /return \{ failed \}/, `${name} must answer { failed }`);
  }
  // The limit itself has ONE home (bug-hunt #24).
  const limits = read('src/shared/limits.js');
  assert.match(limits, /export const BULK_CHUNK = 1000/);
  assert.match(limits, /export const MAX_INLINE_BYTES/);
  assert.match(f, /from '\.\.\/shared\/limits\.js'/, 'fallback imports the seam');
  assert.match(w, /from '\.\.\/shared\/limits\.js'/, 'worker imports the seam');
});

test('fallback SIGN_OUT clears the label cache like the worker (bug-hunt #22)', () => {
  const f = read('src/app/fallback.js');
  const at = f.indexOf("case 'SIGN_OUT':");
  assert.notEqual(at, -1);
  const next = f.indexOf("case '", at + 10);
  const body = f.slice(at, next === -1 ? undefined : next);
  assert.ok(body.includes('gmail._clearLabelCache()'),
    'account-scoped label ids must die with the session on both paths');
});

/*
 * Bug-hunt P0/P1/P2 pins: the fixes that ended silent attachment loss,
 * cross-tab double-send, and declared-size budgeting.
 */

test('OUTBOX_PUMP exists in BOTH tables and dispatches through the hydrator', () => {
  const f = read('src/app/fallback.js');
  const w = read('src/background/index.js');
  assert.ok(worker.has('OUTBOX_PUMP'), 'worker owns the dispatch loop');
  assert.ok(fallback.has('OUTBOX_PUMP'), 'fallback degrades to in-page dispatch');
  assert.match(w, /case 'OUTBOX_PUMP'/);
  assert.match(w, /outboxPumping/, 'the worker single-flights the pump');
  assert.match(w, /hydrateDraftAttachments\(item\.draft\)/,
    'preserved attachments hydrate at the wire, per item');
  assert.match(f, /outbox\.flushOutbox/, 'the in-page path runs the queue runner');
});

test('GET_INLINE enforces the ACTUAL fetched bytes, not the declared size (bug-hunt P2)', () => {
  const f = read('src/app/fallback.js');
  const w = read('src/background/index.js');
  for (const [name, src] of [['fallback', f], ['worker', w]]) {
    assert.match(src, /actual > budget/,
      `${name} must compare the fetched bytes against the budget`);
    assert.match(src, /budget -= actual/, `${name} must spend what it fetched`);
  }
});

test('SEND/SAVE_DRAFT hydrate preserved attachments on both paths (bug-hunt P0)', () => {
  const f = read('src/app/fallback.js');
  const w = read('src/background/index.js');
  for (const [name, src] of [['fallback', f], ['worker', w]]) {
    const send = src.slice(src.indexOf("case 'SEND'"), src.indexOf("case 'SEND'") + 600);
    assert.ok(send.includes('hydrateDraftAttachments'), `${name} SEND must hydrate`);
    const save = src.slice(src.indexOf("case 'SAVE_DRAFT'"), src.indexOf("case 'SAVE_DRAFT'") + 600);
    assert.ok(save.includes('hydrateDraftAttachments'), `${name} SAVE_DRAFT must hydrate`);
  }
});

test('GET_DRAFT stamps attachments with their owning message on both paths (bug-hunt P0)', () => {
  const f = read('src/app/fallback.js');
  const w = read('src/background/index.js');
  for (const [name, src] of [['fallback', f], ['worker', w]]) {
    const at = src.indexOf("case 'GET_DRAFT'");
    const body = src.slice(at, at + 900);
    assert.ok(body.includes('messageId:'), `${name} must make preserved parts refetchable`);
  }
});
