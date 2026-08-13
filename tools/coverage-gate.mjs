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
  'src/app/compose/outbox.js': [80, 70],
  'src/background/sync.js': [55, 85],
  'src/background/gmail.js': [70, 60],
  'src/app/academic/timetable-mail.js': [80, 70],
};

const SUITES = [
  'test/store.test.mjs', 'test/query-grouping.test.mjs', 'test/features.test.mjs',
  'test/outbox.test.mjs', 'test/sync.test.mjs', 'test/gmail.test.mjs',
  'test/timetable.test.mjs', 'test/academic-pipeline.test.mjs',
];

const res = spawnSync('node', [
  '--max-old-space-size=2048', '--test', '--experimental-test-coverage', '--test-concurrency=1', ...SUITES,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const out = res.stdout || '';
process.stdout.write(out.split('\n').filter((l) => l.includes('|') || l.startsWith('# tests')).join('\n') + '\n');

const rows = new Map();
for (const m of out.matchAll(/^# (\S+)\s+\|\s*([\d.]+)\s+\|\s*([\d.]+)\s+\|/gm)) {
  rows.set(m[1], { line: Number(m[2]), branch: Number(m[3]) });
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
