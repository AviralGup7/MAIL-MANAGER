#!/usr/bin/env node
/**
 * Coverage gate (round 45, arch A8).
 *
 * NOT an arbitrary percentage target — a regression fence on the modules
 * whose bugs have historically been silent. Coverage on this tree can only
 * grow or break, never visibly shrink; a floor on the critical directories
 * makes shrinkage a failing build instead of a quiet drift.
 *
 * Floors are set BELOW current measured values so the gate never fails on
 * adoption, and the expectation is to raise them whenever a module climbs.
 * Run: npm run coverage
 */
import { spawnSync } from 'node:child_process';

const FLOORS = {
  // [line %, branch %] — measured 2026-08: store 99.5/88, query 99/87,
  // outbox 98/75, sync 61/94, gmail 87/77, timetable-mail 100/75. Floors sit
  // a few points under the measurement: a fence against regression, never
  // an arbitrary target. Raise them whenever a module climbs.
  'src/app/mail/store.js': [90, 80],
  'src/app/search/query.js': [80, 70],
  'src/features/outbox/model.js': [80, 70],
  'src/background/sync.js': [55, 85],
  'src/background/gmail.js': [70, 60],
  'src/app/academic/timetable-mail.js': [80, 70],
  /*
   * THE SECURITY MODULE IS FENCED (under-engineering audit P1).
   *
   * auth.js had the WORST branch coverage of any critical module in the tree
   * and was not in this gate at all — while five of the six modules that were
   * fenced already sat above 86% line. Verification had been added where it
   * was easy rather than where it was risky, and this is the clearest single
   * instance: the module implementing an OAuth flow that OAuth 2.1 removed,
   * least verified, unfenced.
   *
   * Floors sit just under the measured value (65 line / 46 branch across the
   * three auth suites), per this file's own doctrine: a fence against
   * regression, never an arbitrary target. Raise them whenever it climbs.
   */
  'src/background/auth.js': [60, 42],
};

const SUITES = [
  'test/store.test.mjs', 'test/query-grouping.test.mjs', 'test/feature-contracts.test.mjs',
  'test/outbox.test.mjs', 'test/sync.test.mjs', 'test/gmail.test.mjs',
  'test/timetable.test.mjs', 'test/academic-pipeline.test.mjs',
  // The auth trio, so the floor above has data to stand on.
  'test/auth.test.mjs', 'test/auth-retry.test.mjs', 'test/account-identity.test.mjs',
];

const res = spawnSync('node', [
  '--max-old-space-size=2048', '--test', '--experimental-test-coverage', '--test-concurrency=1', ...SUITES,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const out = res.stdout || '';
process.stdout.write(out.split('\n').filter((l) => l.includes('|') || l.startsWith('# tests')).join('\n') + '\n');

/*
 * KEEP THE BEST ROW PER FILE, NOT THE LAST (under-engineering audit P1).
 *
 * `--test-concurrency=1` still reports one coverage table PER TEST PROCESS,
 * so a module exercised by several suites appears several times with wildly
 * different numbers — auth.js ranges 39%-71% line across its three suites
 * depending on which paths that suite drives. `rows.set` kept whichever
 * happened to print last, which made the gate's reading a coin flip: the same
 * commit could pass or fail on process ordering alone.
 *
 * The union of what every suite covered is the honest figure, and max-per-
 * metric is the closest approximation available from the printed tables.
 */
const rows = new Map();
for (const m of out.matchAll(/^# (\S+)\s+\|\s*([\d.]+)\s+\|\s*([\d.]+)\s+\|/gm)) {
  const prev = rows.get(m[1]);
  const next = { line: Number(m[2]), branch: Number(m[3]) };
  rows.set(m[1], prev
    ? { line: Math.max(prev.line, next.line), branch: Math.max(prev.branch, next.branch) }
    : next);
}

let failed = 0;
for (const [file, [lineFloor, branchFloor]] of Object.entries(FLOORS)) {
  const row = rows.get(file);
  if (!row) {
    console.error(`coverage gate: NO DATA for ${file} -- the suite stopped exercising it; that is a failure, not a pass.`);
    failed++;
    continue;
  }
  if (row.line < lineFloor || row.branch < branchFloor) {
    console.error(`coverage gate: ${file} at ${row.line}% line / ${row.branch}% branch, floors are ${lineFloor}/${branchFloor}.`);
    failed++;
  } else {
    console.log(`coverage ok: ${file} ${row.line}% line / ${row.branch}% branch (floors ${lineFloor}/${branchFloor})`);
  }
}

if (failed) {
  console.error(`\ncoverage gate: ${failed} file(s) below floor`);
  process.exit(1);
}
console.log('\ncoverage gate: all protected modules above their floors');
