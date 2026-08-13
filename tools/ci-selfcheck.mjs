#!/usr/bin/env node
/**
 * CI SELF-INTEGRITY GATE (2026-08-13, direction M2's sibling: the pipeline
 * that proves the pipeline).
 *
 * WHY
 * ---
 * Every other gate here proves something about the APP. Nothing proved
 * anything about the CI ITSELF — so the realistic failure shapes were:
 * the workflow matrix drifting away from the shard count the runner
 * expects, a required npm script renamed and the workflow step quietly
 * following, a hard gate turned soft with one `|| echo`. Each looks like a
 * green build right up until the day it matters.
 *
 * This gate recomputes what the workflow only claims:
 *
 *   1. SHARDS. The matrix lists exactly 1/n..n/n; THROUGH THE RUNNER'S OWN
 *      --dry-run (never a reimplementation — a second deal here would only
 *      prove the two can drift together), every slice is non-empty,
 *      pairwise disjoint, and their union is the whole test directory.
 *   2. SCRIPTS. Every npm script a workflow step names exists locally.
 *   3. GATES. The workflow keeps its own teeth: permissions least-
 *      privilege, job timeouts, one Chromium install, a hard smoke step,
 *      the contract typecheck, the verdict aggregator.
 *
 * A failure here is a CI defect, not an app defect — it fails the checks
 * job before any of the suites pay their cost for the day.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const wf = readFileSync('.github/workflows/ci.yml', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const results = [];
const check = (name, ok, detail = '') =>
  results.push({ name, ok: !!ok, detail: ok ? detail : String(detail) });

/* ---- 1 · shards, recomputed through the runner's own --dry-run ---------- */

const matrix = [...wf.matchAll(/'(1\/8|2\/8|3\/8|4\/8|5\/8|6\/8|7\/8|8\/8)'/g)].map((m) => m[1]);
check('matrix/lists-8-shards', matrix.length === 8 && new Set(matrix).size === 8,
  `found: ${matrix.join(', ') || 'none'}`);

const all = readdirSync('test').filter((f) => f.endsWith('.test.mjs')).sort();
const seen = new Set();
let overlap = 0;
let runnerFault = '';
const shardManifests = [];
for (const spec of ['1/8', '2/8', '3/8', '4/8', '5/8', '6/8', '7/8', '8/8']) {
  const r = spawnSync('node', ['tools/ci-test.mjs', '--shard', spec, '--dry-run'], { encoding: 'utf8' });
  if (r.status !== 0) { runnerFault = `${spec} exited ${r.status}`; break; }
  const manifest = JSON.parse(r.stdout.trim().split('\n').pop());
  if (!manifest.files.length) { runnerFault = `${spec} empty`; break; }
  shardManifests.push(manifest);
  for (const f of manifest.files) {
    if (seen.has(f)) overlap++;
    seen.add(f);
  }
}
check('shards/non-empty+disjoint', !runnerFault && overlap === 0, runnerFault || `${overlap} duplicated`);
check('shards/union-is-the-suite', seen.size === all.length, `${seen.size} of ${all.length} files dealt`);

/* A FLOOR, not a count-pin (2026-08-14 audit #27): a count-pin must be
   edited every time a test file is added, which trains people to edit it
   blindly; a floor guards the catastrophe — half the suite disappearing
   looks exactly like a green build to every other gate. 98 files exist
   the day this lands; 90 is the tripwire, far below growth, far above
   loss. */
check('suite/floor', all.length >= 90, `${all.length} test files`);

/* The manifest as EVIDENCE (audit #8/#23): which file went to which
   slice, counts, and the disjoint/complete verdicts the gate reached.
   The checks job uploads this on every run (`if: always()`), so "what did
   CI actually execute?" is answerable after a PASS as often as after a
   failure. */
writeFileSync('.ci-manifest.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  totalFiles: all.length,
  disjoint: overlap === 0 && !runnerFault,
  complete: seen.size === all.length,
  shards: shardManifests,
}, null, 2) + '\n');

/* ---- 2 · the scripts the workflow names must exist ---------------------- */

for (const s of ['test:ci', 'ci:smoke', 'render:bench', 'types', 'contrast', 'bench', 'preview']) {
  check(`script/${s}`, typeof pkg.scripts?.[s] === 'string', pkg.scripts?.[s] ?? 'missing');
}

/* ---- 3 · the workflow keeps its own teeth -------------------------------- */

check('workflow/least-privilege', /permissions:\s*\n\s+contents: read/.test(wf),
  'top-level `permissions: contents: read`');
check('workflow/timeouts', (wf.match(/timeout-minutes:/g) || []).length >= 2,
  'job timeouts present');
check('workflow/one-chromium-install',
  (wf.match(/Install Chromium \(once\)/g) || []).length === 1 && !/smoke[\s\S]*?install chromium/.test(wf.slice(wf.indexOf('Browser smoke gates'))),
  'one install step; the smoke step reuses it');
check('workflow/hard-smoke', /node tools\/ci-smoke\.mjs(?!.*\|\|)/.test(wf) && /Browser smoke gates/.test(wf),
  'the smoke gate has no soft-echo');
check('workflow/typecheck-gate', wf.includes('npm run types'), 'checkJs runs in CI');
check('workflow/verdict', wf.includes('needs: [test, checks]'), 'the aggregate verdict job exists');
check('workflow/real-verdict', !/echo "?all checks passed/i.test(wf),
  'no fake verdict job (success/failure/cancelled must be read, not printed)');
/* 2026-08-14 audit #43/#44: nothing EXECUTED in the workflow may route
   through npx. npx fetches when the local bin is missing — the exact
   supply-chain shape the pinned playwright-core dependency exists to
   prevent — so the browser install addresses node_modules/.bin directly.
   Comments are stripped first: explaining the rule requires naming it. */
const wfCode = wf.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
check('workflow/no-npx', !/\bnpx\s/.test(wfCode), 'executables come from the lockfile, via npm ci');
check('workflow/manifest-uploaded', /if: always\(\)[\S\s]*?\.ci-manifest\.json/.test(wf),
  'the shard manifest survives green runs too');
check('workflow/traces-on-failure', wf.includes('.smoke-trace.zip'),
  'the trace has an upload path when smoke falls');
/* Superseded runs must cancel themselves, and the one-glance answers must
   land on the run's Summary page (2026-08-14): the shards and the smoke
   gates mirror there from their own tools; the verdict table is the one
   the workflow owes. */
check('workflow/concurrency', /concurrency:\s*\n\s+group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/.test(wf)
  && /cancel-in-progress: true/.test(wf), 'a new push stops paying for a stale answer');
check('workflow/summaries', wfCode.includes('GITHUB_STEP_SUMMARY'), 'the verdict table is written to the Summary page');

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : '✗ NOT OK'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} CI invariants hold`);
process.exit(failed ? 1 : 0);
