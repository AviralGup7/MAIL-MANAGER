/**
 * Background notification selection (P-3).
 *
 * The worker syncs every 15 minutes while the app is closed; this pins what
 * may interrupt the user. The doctrine: category allow-list, burst cap,
 * dedupe — a notification the user did not want is noise.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectNotifiable, cardText, NOTIFY_CATEGORIES, NOTIFY_BURST_CAP } from '../src/background/notify.js';

const INDEX_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src/background/index.js'),
  'utf8'
);

const m = (id, category, subject = 'S') => ({ id, category, subject, from: 'a@b.c' });

test('only allow-listed categories are notifiable', () => {
  const added = [
    m('1', 'augsd', 'Registration deadline'),
    m('2', 'academics', 'Exam schedule'),
    m('3', 'external-promotions', 'Discount!'),
    m('4', 'clubs', 'Hackathon'),
  ];
  const out = selectNotifiable(added);
  assert.deepEqual(out.map((x) => x.id), ['1', '2'], 'only augsd + academics');
  assert.deepEqual([...NOTIFY_CATEGORIES], ['augsd', 'academics']);
});

test('previously notified ids are never re-notified', () => {
  const added = [m('1', 'augsd'), m('2', 'augsd')];
  const out = selectNotifiable(added, ['1']);
  assert.deepEqual(out.map((x) => x.id), ['2']);
});

test('a re-synced delta cannot notify twice for the same id', () => {
  const added = [m('1', 'augsd'), m('2', 'augsd')];
  const first = selectNotifiable(added, []);
  const ids = [...first.map((x) => x.id), 'old'];
  const second = selectNotifiable(added, ids);
  assert.deepEqual(second, [], 'no repeats');
});

test('the burst is capped so a mail flood is one event, not a dozen', () => {
  const added = Array.from({ length: 20 }, (_, i) => m(`f${i}`, 'augsd'));
  const out = selectNotifiable(added);
  assert.equal(out.length, NOTIFY_BURST_CAP);
  assert.equal(out.length, 3);
});

test('malformed records are skipped, not fatal', () => {
  const added = [null, undefined, { category: 'augsd' }, m('ok', 'academics')];
  const out = selectNotifiable(added);
  assert.deepEqual(out.map((x) => x.id), ['ok']);
});

test('the subject and sender survive for the notification body', () => {
  const out = selectNotifiable([m('1', 'augsd', 'Fee payment reminder')]);
  assert.equal(out[0].subject, 'Fee payment reminder');
  assert.equal(out[0].from, 'a@b.c');
});

// --------------------------------------------------------------- bug-hunt 50 --

test('notification titles scrub control chars and truncate the sender', () => {
  // A crafted From header must not inject line breaks into the notification
  // card, and a 200-char display name must not push the subject off it.
  assert.match(INDEX_SRC, /shortSender\(m\.from\)/, 'title uses the scrubber');
  /* 2026-08-15 (AUD-L2): the scrub itself moved to notify.js's cardText,
     one gate shared by sender AND subject; shortSender keeps only the
     name-or-fallback rule. The behavioural pins (chars out, ellipsis
     inside the cap) live in audit-hardening.test.mjs. */
  /* ASSERTED ON BEHAVIOUR, NOT ON THE SOURCE TEXT (round 10, I-6). These
     three used to grep notify.js for the regex literals, so moving the one
     shared definition into src/shared/scrub.js broke a passing test without
     changing a single output. A test that reads the implementation cannot
     survive a refactor it should not have noticed. */
  assert.equal(cardText('Exam\nPostponed\u0000\u001f\u007f'), 'ExamPostponed',
    'C0/C1 control chars scrubbed');
  assert.equal(cardText('safe\u202Egpj.exe\u2066'), 'safegpj.exe',
    'bidi overrides scrubbed too');
  assert.equal(cardText('\u200Fشكرا'), '\u200Fشكرا', 'RLM is a mark, not an override');
  const long = cardText('x'.repeat(500), 40);
  assert.equal(long.length, 40, 'truncated with the ellipsis INSIDE the cap');
  assert.ok(long.endsWith('…'));
  assert.match(INDEX_SRC, /cardText\(from, max\) \|\| 'BITS mail'/, 'empty sender falls back');
});
