/**
 * Round 45 Phase 3 pins — the correctness-UX cluster:
 * mailbox-aware deep links, live thread strip, compose budget & identity,
 * and the chunked bulk contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/app/app.js', import.meta.url), 'utf8');
const compose = readFileSync(new URL('../src/app/compose.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/app/app.css', import.meta.url), 'utf8');
// The reader cluster moved out of app.js in the round-51 workspace extraction.
const reader = readFileSync(new URL('../src/app/reader.js', import.meta.url), 'utf8');

test('Open-in-Gmail lands where the message lives (round 45 M1)', () => {
  assert.match(reader, /el\.rOpen\.href = ctx\.gmailUrl\(m\.threadId, urlMailbox\)/,
    'the reader uses the mailbox-aware helper');
  assert.match(reader, /state\.mailbox === 'snoozed' \? 'all' : state\.mailbox/,
    'snoozed maps to All Mail, where the message is reachable');
  assert.ok(!reader.includes('/#inbox/${m.threadId}'),
    'no hardcoded inbox fragment remains');
});

test('the thread strip refreshes when a delta grows the open conversation (round 45 M6)', () => {
  const at = app.indexOf('LIVE THREAD STRIP');
  assert.notEqual(at, -1, 'the delta path re-renders the strip');
  const block = app.slice(at, at + 400);
  assert.match(block, /renderThreadStrip\(state\.selected\)/);
});

test('compose shows the attachment budget while files are chosen (round 45 M3)', () => {
  assert.match(compose, /SIZE BUDGET METER/);
  assert.match(compose, /MAX_ATTACH_BYTES/, 'the meter reads the real ceiling');
  assert.match(compose, /role', 'meter'/, 'and exposes itself as a meter');
  assert.match(compose, /pct >= 100 \? 'over' : pct >= 80 \? 'warn' : 'ok'/,
    'with escalating states');
  assert.match(css, /\.c-budget-fill/, 'styled');
  assert.match(css, /\.c-budget\[data-kind='over'\] \.c-budget-fill \{ background: var\(--danger\)/,
    'and the over state is dangerous on sight');
});

test('a minimised compose keeps its identity (round 45 M4)', () => {
  assert.match(compose, /A MINIMISED DRAFT KEEPS ITS IDENTITY/);
  assert.match(compose, /To: \$\{to\.split\(','\)\[0\]\.trim\(\)\}/,
    'the collapsed bar names the recipient');
  assert.match(compose, /baseTitle/, 'and restores the real title on expand');
});

test('bulk operations report progress and accept cancellation (round 45 M2)', () => {
  const at = app.indexOf('CHUNKED WITH PROGRESS AND CANCEL');
  assert.notEqual(at, -1);
  const block = app.slice(at, at + 3800);
  assert.match(block, /const CHUNK = 1000/, 'the worker chunk size');
  assert.match(block, /of \$\{n\.toLocaleString\(\)\}/, 'progress names the run');
  assert.match(block, /label: 'Cancel'/, 'with a stop affordance');
  assert.match(block, /const unsent = snapshots\.filter/, 'unsent rows come back on cancel');
  assert.match(block, /recordUndo\(ctx, `\$\{verb\} \$\{appliedIds\.length\}/,
    'undo covers exactly what was applied');
});
