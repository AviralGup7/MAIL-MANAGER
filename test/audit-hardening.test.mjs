/**
 * Hardening pins for the 2026-08-15 system-wide audit, P1 band.
 *
 * The pure laws are pinned behaviourally; the worker's adoption of them is
 * pinned at the source, the house's established pattern for worker wiring
 * (the worker itself is only bootable against a full chrome.* seam, covered
 * by the integration suites on CI).
 *
 *   AUD-M1  SYNC_PAGE swallowed EVERY ensureLabel failure as an empty page
 *   AUD-M3  backgroundSync re-entry broke the notify dedupe's read-modify-write
 *   AUD-L1  NaN wake times reached chrome.alarms.create after a good modify
 *   AUD-L2  the notification card scrubbed the sender but not the subject
 *   AUD-L3  takeOver guarded against itself, not against a second injection
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextWakeAt } from '../src/features/snooze/model.js';
import { mergeNotified, cardText, NOTIFIED_CAP } from '../src/background/notify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_SRC = readFileSync(join(ROOT, 'src/background/index.js'), 'utf8');
const CONTENT_SRC = readFileSync(join(ROOT, 'src/takeover/content.js'), 'utf8');

const NOW = 1_760_000_000_000;

// ------------------------------------------------------------ AUD-L1 alarm --

test('nextWakeAt: nothing armed answers null, and damaged stores arm nothing', () => {
  assert.equal(nextWakeAt({}, NOW), null);
  assert.equal(nextWakeAt(null, NOW), null, 'a missing blob is not a wake');
  // The AUD-L1 family: every one of these used to be a candidate.
  const damaged = {
    a: { at: NaN },
    b: { at: Infinity },
    c: { at: -Infinity },
    d: { at: 'tomorrow' },
    e: {},
    f: null,
  };
  assert.equal(nextWakeAt(damaged, NOW), null,
    'typeof === number lets NaN through; the guard must be finite');
});

test('nextWakeAt: the earliest finite row wins; damaged rows never compete', () => {
  const all = {
    late: { at: NOW + 3_600_000 },
    early: { at: NOW + 60_000 },
    junk: { at: -Infinity }, // would sort before everything if it could
  };
  assert.equal(nextWakeAt(all, NOW), NOW + 60_000);
});

test('nextWakeAt: a past-due wake is floored, not fired immediately', () => {
  // Chrome fires past-dated alarms at once, then the re-aim does it again.
  assert.equal(nextWakeAt({ a: { at: NOW - 5 } }, NOW), NOW + 5000);
  assert.equal(nextWakeAt({ a: { at: NOW + 100 } }, NOW), NOW + 5000,
    'the floor applies inside the 5s window too');
});

test('AUD-L1: scheduleWake delegates the arithmetic to nextWakeAt', () => {
  const fn = INDEX_SRC.slice(
    INDEX_SRC.indexOf('async function scheduleWake'),
    INDEX_SRC.indexOf('async function scheduleWake') + 1200
  );
  assert.match(fn, /nextWakeAt\(all\)/, 'the worker must not re-derive this');
  assert.ok(!/\.filter\(\(t\) => typeof t === 'number'\)/.test(fn),
    'the NaN-passing filter is gone from the alarm path');
  assert.match(fn, /alarms\.clear\(WAKE_ALARM\)/, 'an empty set still disarms the alarm');
});

// ---------------------------------------------------- AUD-M3 notify dedupe --

test('mergeNotified: freshest first, capped, with the newest remembered', () => {
  const fresh = ['n1', 'n2'];
  const prev = ['p1', 'p2'];
  assert.deepEqual(mergeNotified(fresh, prev), ['n1', 'n2', 'p1', 'p2']);

  // A flood: the cap keeps the NEWEST — evicting what just fired is how
  // a re-run re-notifies exactly the mail it already interrupted for.
  const flood = Array.from({ length: 150 }, (_, i) => `f${i}`);
  const merged = mergeNotified(flood, ['old']);
  assert.equal(merged.length, NOTIFIED_CAP);
  assert.equal(merged.length, 100);
  assert.ok(!merged.includes('old'), 'the oldest memory is what evicts');
});

test('mergeNotified: a damaged stored list is repaired, not propagated', () => {
  assert.deepEqual(mergeNotified(['a'], ['a', 'a', '', 42, null, 'b']), ['a', 'b'],
    'duplicates and junk entries do not survive a sweep');
  assert.deepEqual(mergeNotified(undefined, undefined), [], 'absent is empty');
});

test('AUD-M3: the sweep is single-flighted for its whole run', () => {
  assert.match(INDEX_SRC, /let bgSyncRunning = false;/, 'the guard exists');
  assert.match(INDEX_SRC,
    /if \(bgSyncRunning\) return;[^]*?bgSyncRunning = true;[^]*?finally \{\s*bgSyncRunning = false;/s,
    'one flag, whole-run scope, released on every exit');
  assert.match(INDEX_SRC, /mergeNotified\(fresh\.map\(\(m\) => m\.id\), bgNotifiedIds\)/,
    'the inline, unpinned merge is gone');
});

// ------------------------------------------------------------ AUD-L2 cards --

test('cardText: control characters never reach the OS notification', () => {
  assert.equal(cardText('Exam\nPostponed'), 'ExamPostponed',
    'a newline must not fake a second line of UI');
  assert.equal(cardText('One\x00 Two\x1f Three\x7f'), 'One Two Three');
  assert.equal(cardText('\t\t'), '', 'nothing left is the empty string');
});

test('cardText: bidi overrides cannot spoof OS notification text', () => {
  assert.equal(cardText('safe\u202Egpj.exe\u2066'), 'safegpj.exe');
});

test('cardText: bounded, with the ellipsis INSIDE the cap', () => {
  const huge = 'x'.repeat(5000);
  const out = cardText(huge);
  assert.equal(out.length, 160, 'a 5000-char subject is 160 on the card');
  assert.ok(out.endsWith('…'));
  // The sender cap (bug-hunt #50) is the same gate, tighter bound.
  assert.equal(cardText('a'.repeat(50), 40).length, 40);
});

test('AUD-L2: the card passes the subject through the same scrub as the sender', () => {
  assert.match(INDEX_SRC, /message: cardText\(m\.subject\)/);
  assert.match(INDEX_SRC, /function shortSender\(from, max = 40\) \{\s*\/\/ The gate is notify\.js's cardText[^]*?cardText\(from, max\)/,
    'the sender scrub delegates — one scrub, not two dialects');
});

// ---------------------------------------------------------- AUD-M1 empty page --

test('AUD-M1: only “could not create” reads as an empty page', () => {
  const fn = INDEX_SRC.slice(
    INDEX_SRC.indexOf("case 'SYNC_PAGE'"),
    INDEX_SRC.indexOf("case 'SYNC_PAGE'") + 1600
  );
  assert.match(fn, /Could not create/, 'the honest-empty class is named');
  assert.match(fn, /throw err;/, 'every other failure surfaces as itself');
  assert.match(fn, /ensureLabel\(opts\.labelName\)/, 'the resolution path is unchanged');
});

// ------------------------------------------------------------- AUD-L3 host --

test('AUD-L3: a second injection refuses on the DOM witness, not its own state', () => {
  const fn = CONTENT_SRC.slice(
    CONTENT_SRC.indexOf('async function takeOver'),
    CONTENT_SRC.indexOf('async function takeOver') + 1500
  );
  const guard = fn.indexOf('document.getElementById(HOST_ID)');
  assert.ok(guard > -1, 'the shared witness is consulted');
  assert.ok(guard < fn.indexOf("state = 'entering'"),
    'the guard precedes the claim — a refused instance stays idle');
});
