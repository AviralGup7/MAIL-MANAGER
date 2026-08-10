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
