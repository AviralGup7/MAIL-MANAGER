/**
 * AUD-Q1 pins (audit 2026-08-15): the diagnostics counters exist, are
 * closed to their declared five, are lossy-on-purpose, and are wired at the
 * places the audit named. The numbers' job is answering support questions
 * with counts instead of vibes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeStorage } from './helpers/storage.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('the counter surface is exactly the declared set', async () => {
  /*
   * The set is CLOSED on purpose (a typo must not mint a counter), so
   * widening it is a deliberate edit here as well as in diag.js.
   *
   * Widened by audit R3-10: the original five counted a feature that is
   * currently disabled (notifications) and nothing that leaves a user in a
   * wrong state. The four added are the classes that actually strand
   * someone, each previously invisible even to the developer:
   *   batchShortfall   sub-requests silently dropped from a batch (R3-03)
   *   resyncs          full resyncs forced
   *   historyExhausted MAX_HISTORY_PAGES hit -- NOT cursor expiry (R3-07)
   *   cursorWithheld   deltas that refused to advance the cursor (R3-03)
   */
  const diag = await import(`../src/background/diag.js?t=${Math.random()}`);
  assert.deepEqual(
    Object.keys(diag.diagSnapshot()).sort(),
    ['batchShortfall', 'cursorWithheld', 'historyExhausted', 'mismatchClears',
     'notifications', 'renewals', 'requests', 'resyncs', 'retries']
  );
});

test('bump counts; unknown names are dropped, not minted', async () => {
  const diag = await import(`../src/background/diag.js?t=${Math.random()}`);
  diag.bump('requests');
  diag.bump('requests', 3);
  diag.bump('reguests'); // the typo class the whitelist exists for
  diag.bump('renewals', NaN); // a finite guard, same family as fuzz round 3
  const snap = diag.diagSnapshot();
  assert.equal(snap.requests, 4);
  assert.equal(snap.renewals, 0);
  assert.ok(!('reguests' in snap), 'no counter appears by accident');
});

test('persistDiag writes under its key with a flush stamp, and never throws', async () => {
  const diag = await import(`../src/background/diag.js?t=${Math.random()}`);
  diag.bump('renewals');
  const s = fakeStorage();
  await diag.persistDiag(s);
  const got = (await s.get('diagCounters')).diagCounters;
  assert.equal(got.renewals, 1);
  assert.equal(got.mismatchClears, 0, 'zeroes flush too — absence is a number');
  assert.ok(Number.isFinite(got.flushedAt), 'the flush is dated');

  const broken = {
    async set() { throw new Error('disk full'); },
  };
  await diag.persistDiag(broken); // must not throw: doctrine over drama
});

test('separate worker incarnations merge totals instead of regressing them', async () => {
  const s = fakeStorage({
    diagCounters: { requests: 100, retries: 4, notifications: 2, renewals: 3, mismatchClears: 1 },
  });
  const diag = await import(`../src/background/diag.js?t=${Math.random()}`);
  diag.bump('requests');
  await diag.persistDiag(s);
  const got = (await s.get('diagCounters')).diagCounters;
  assert.equal(got.requests, 101);
  assert.equal(got.mismatchClears, 1, 'a quiet incarnation never erases the tripwire count');
  await diag.persistDiag(s);
  assert.equal((await s.get('diagCounters')).diagCounters.requests, 101,
    'flushing twice does not add the same in-memory delta twice');
});

test('the bumps live at the seams the audit named (wiring)', () => {
  const gmail = read('src/background/gmail.js');
  assert.match(gmail, /for \(let attempt = 1;[^]*?bump\('requests'\)/, 'every attempt counted');
  assert.match(gmail, /if \(attempt > 1\) bump\('retries'\)/, 'retries are attempts beyond the first');

  const auth = read('src/background/auth.js');
  assert.match(auth, /bump\('mismatchClears'\)[^]*?throw new Error\('ACCOUNT_CHANGED'\)/,
    'the clearance and its count travel together');
  assert.match(auth, /await persist\(tok\);\s*bump\('renewals'\)/,
    'only a persisted renewal counts');

  const worker = read('src/background/index.js');
  assert.match(worker, /bump\('notifications', fresh\.length\)/, 'cards counted once per sweep');
  assert.match(worker, /void persistDiag\(\);/, 'the sweep tick is the flush rhythm');
});

test('the registry keeps the counters out of backups, with the reason', async () => {
  const { keyEntry } = await import('../src/app/system/storage-registry.js');
  const entry = keyEntry('diagCounters');
  assert.ok(entry, 'registered — the sweep in storage-registry.test pins the KEY');
  assert.equal(entry.backup, false);
  assert.ok(entry.reason.length > 20, 'the exclusion explains itself');
});
