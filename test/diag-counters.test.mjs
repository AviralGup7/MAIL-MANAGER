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

test('the counter surface is exactly the declared five', async () => {
  const diag = await import(`../src/background/diag.js?t=${Math.random()}`);
  assert.deepEqual(
    Object.keys(diag.diagSnapshot()).sort(),
    ['mismatchClears', 'notifications', 'renewals', 'requests', 'retries']
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
