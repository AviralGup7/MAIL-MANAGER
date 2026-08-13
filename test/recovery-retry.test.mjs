/**
 * Recovery retries (round 65/h, docs/UX-AUDIT-V4 F9, brief §31).
 *
 * Behavioural coverage of the click-through lives in the integration
 * suite (failed archive → Retry chip → act replayed; failed delta sync →
 * Retry → real SYNC_DELTA). These pins are source-level: the seams that
 * must not quietly lose the affordance.
 *
 * What is deliberately NOT wired, with reasons:
 *   - the offline banner: a network failure is a STATE, not an event —
 *     its design comment already forbids an action while the condition
 *     holds, and auto-recovery is wired to the online event;
 *   - the outbox rail: retry/discard already live there (rails.js);
 *   - classification: local and exception-contained — a mis-file is
 *     corrected through the category menu, while there is no discrete
 *     classification failure toast to attach a Retry to.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appjs = readFileSync(join(ROOT, 'src/app/main.js'), 'utf8');
const toastjs = readFileSync(join(ROOT, 'src/app/overlays/toast.js'), 'utf8');

test('verb failures announce through one toasted surface that carries Retry', () => {
  assert.match(appjs, /function toastFailure\(text, retry\) \{\s*toast\(text, retry\s*\? \{ kind: 'error', action: \{ label: 'Retry', run: retry \} \}\s*: \{ kind: 'error' \}\);/,
    'one surface, so the two rollback paths cannot drift on how failure speaks');
  // Both settlement helpers accept the retry closure and toast through it.
  assert.match(appjs, /function optimistic\(\{\s*\n\s*id, verb, undoVerb, past, failed, done, before, rollback: undoLocal, undoBefore, retry,\s*\n\}\)/,
    'optimistic() accepts the retry closure');
  assert.match(appjs, /undoPayload = \{\}, past, failed, retry,\s*\n\}\) \{/,
    'flagAction accepts it too');
  assert.ok(/toastFailure\(failed, retry\)/.test(appjs), 'both rollback paths toast with it');
  assert.equal(appjs.match(/toastFailure\(failed, retry\)/g).length, 2,
    'flagAction and optimistic — exactly the two');
});

test('Retry replays the ACT, never a bare wire resend', () => {
  assert.match(appjs,
    /const retryAct = \(\) => act\(action, id\);/,
    'undo entries, thread spans and the optimistic travel must replay on a re-attempt');
  const passes = appjs.match(/retry: retryAct,/g) || [];
  assert.ok(passes.length >= 7,
    `every verb case threads the same closure (found ${passes.length})`);
});

test('the three sync loads hand reportError their retry', () => {
  assert.match(appjs, /function reportError\(err, \{ retry \} = \{\}\)/);
  assert.match(appjs, /reportError\(err, \{ retry: \(\) => loadPage\(pageToken\) \}\)/);
  assert.match(appjs, /reportError\(err, \{ retry: \(\) => refresh\(\) \}\)/);
  assert.match(appjs, /reportError\(err, \{ retry: \(\) => loadMailboxPage\(id, pageToken\) \}\)/);
  // And the action only exists where a retry exists.
  assert.match(appjs, /toast\(msg\.slice\(0, 140\), \{\s*kind: 'error',\s*\.\.\.\(retry \? \{ action: \{ label: 'Retry', run: retry \} \} : \{\}\),?\s*\}\);/,
    'a failure without a way forward stays honest about it — no dead chip');
});

test('the toast action primitive is generic and clicks hide the toast first', () => {
  assert.match(toastjs, /el\.toastAction\.hidden = !action;/);
  assert.match(toastjs, /el\.toastAction\.onclick = \(\) => \{\s*hideToast\(\);\s*action\.run\(\);\s*\};/,
    'the failed toast clears before the retry begins — no stacked toasts fight');
});
