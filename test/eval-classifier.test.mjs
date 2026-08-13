/**
 * G4 — the evaluation harness reports, never judges (2026-08-14).
 *
 * WHY THESE PINS
 * --------------
 * tools/eval-classifier.mjs turns harvested sender corrections into the
 * classifier's first honest accuracy signal. The pins guard the report's
 * CONTRACT, not the classifier's correctness (that lives in the classify
 * suites): exit codes that separate missing input from measured input, an
 * empty corpus that teaches instead of crashing, and agreement math that
 * counts rather than vibes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { classify } from '../src/classify/index.js';
import { CATEGORY_LABELS } from '../src/classify/categories.js';

const TMP = 'test/.eval-fixture.json';

function run(args) {
  return spawnSync('node', ['tools/eval-classifier.mjs', ...args], { encoding: 'utf8' });
}

test.afterEach(() => { try { rmSync(TMP); } catch { /* absent is fine */ } });

test('missing argument is infrastructure, exit 2', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});

test('an unreadable file is infrastructure, exit 2', () => {
  const r = run(['test/no-such-backup.json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /INFRA \(exit 2\)/);
});

test('an empty corpus teaches, exits 0', () => {
  writeFileSync(TMP, JSON.stringify({ categoryRules: { corrections: {} } }));
  const r = run([TMP]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No harvested corrections/);
});

test('agreement is counted as agreement-per-correction, on math not vibes', () => {
  /* Build the fixture FROM the live classifier so the test states behavior,
     not classifier content: one sender corrected to ITS OWN natural
     category (agrees), one corrected to a guaranteed-different one
     (disagrees) — derived from the category set, never hardcoded. */
  const addr = 'noreply@github.com';
  const natural = classify({ from: addr, subject: '', snippet: '' }).category;
  const second = classify({ from: 'newsletter@example.com', subject: '', snippet: '' }).category;
  const different = Object.keys(CATEGORY_LABELS).find((c) => c !== second);
  writeFileSync(TMP, JSON.stringify({
    categoryRules: { corrections: { [addr]: natural, 'newsletter@example.com': different } },
  }));
  const r = run([TMP]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /corrections \(labeled examples\): 2/);
  assert.match(r.stdout, /already agrees:\s+1\/2 \(50\.0%\)/);
  /* And the disagreement row is named, address-first, with the source. */
  const rowRe = new RegExp(`newsletter@example\\.com\\s+${second} → ${different} \\(`);
  assert.match(r.stdout, rowRe);
});

test('a disagreement is data, never a nonzero exit', () => {
  writeFileSync(TMP, JSON.stringify({
    categoryRules: { corrections: { 'nobody@nothing.example': 'clubs' } },
  }));
  const r = run([TMP]);
  assert.equal(r.status, 0, 'a fully-disagreeing corpus still reports cleanly');
});
