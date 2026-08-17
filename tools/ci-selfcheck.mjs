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
/*
 * THE WORKFLOW WITH ITS COMMENTS STRIPPED.
 *
 * Every structural gate below must read this, not `wf`. Twice now a check
 * has failed because a COMMENT quoted the very thing it forbids: splitting
 * the browser steps into their own job added prose naming
 * "Install Chromium (once)" and describing an install, and both
 * `one-chromium-install` and the smoke-ordering check went red while the
 * executable YAML was correct. A gate that cannot tell code from prose
 * reports the explanation as the defect.
 *
 * Defined HERE rather than halfway down the file, where it used to sit —
 * being declared after the checks that needed it is why they were written
 * against the raw text in the first place.
 */
const wfCode = wf.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
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

for (const s of ['test:ci', 'ci:smoke', 'render:bench', 'types', 'contrast', 'bench', 'preview',
  'docs:check', 'operators', 'departments', 'doctor', 'lint', 'lint:py']) {
  check(`script/${s}`, typeof pkg.scripts?.[s] === 'string', pkg.scripts?.[s] ?? 'missing');
}

/*
 * A GATE THAT EXISTS BUT IS NOT WIRED IN IS NOT A GATE (2026-08-15 CI audit).
 *
 * `operators`, `departments` and `doctor` were all runnable, all meaningful,
 * and none of them ran in CI — the only thing standing between the repo and
 * the drift they detect was somebody remembering the command. `operators` was
 * in fact failing at the moment it was wired in, and had been for long enough
 * that nobody noticed. Naming them here means removing one from the workflow
 * is a failing build rather than a silent loss of coverage.
 */
for (const s of ['operators', 'departments', 'doctor', 'lint']) {
  check(`workflow/runs-${s}`, wf.includes(`npm run ${s}`),
    `the ${s} gate is wired into the workflow, not merely available`);
}

/*
 * The Python linter runs as a pinned pip install rather than an npm script,
 * so it needs its own two checks: that it runs at all, and that the version
 * is PINNED. An unpinned linter turns "a new ruff shipped a new rule" into a
 * red build on a commit that changed nothing — the same moving-target problem
 * that keeps `npm audit` off the push path in security.yml.
 */
check('workflow/runs-ruff', /ruff check/.test(wf), 'the Python linter runs in CI');
check('workflow/ruff-pinned', /ruff==\d+\.\d+\.\d+/.test(wf),
  'ruff is pinned to an exact version');

/* ESLint's config must stay correctness-only. A stylistic rule here would
   start reformatting a deliberately comment-dense codebase, and the first
   red build over an indent is when a team stops believing the lint gate. */
try {
  const eslintCfg = readFileSync('eslint.config.mjs', 'utf8');
  const styleRules = ['quotes', 'semi', 'indent', 'max-len', 'comma-dangle', 'space-before'];
  const found = styleRules.filter((r) => new RegExp(`['\"]${r}['\"]\\s*:`).test(eslintCfg));
  check('lint/no-style-rules', found.length === 0,
    found.length ? `stylistic rules crept in: ${found.join(', ')}` : 'correctness rules only');
} catch {
  check('lint/config-exists', false, 'eslint.config.mjs is missing');
}

/* ---- 3 · the workflow keeps its own teeth -------------------------------- */

check('workflow/least-privilege', /permissions:\s*\n\s+contents: read/.test(wf),
  'top-level `permissions: contents: read`');
check('workflow/timeouts', (wf.match(/timeout-minutes:/g) || []).length >= 2,
  'job timeouts present');
check('workflow/one-chromium-install',
  (wfCode.match(/name: Install Chromium \(once\)/g) || []).length === 1
  && (wfCode.match(/playwright-core install chromium/g) || []).length >= 1
  && !/playwright-core install chromium/.test(wfCode.slice(wfCode.indexOf('Browser smoke gates'))),
  'exactly one install STEP, and nothing reinstalls after the smoke gate');
check('workflow/hard-smoke', /node tools\/ci-smoke\.mjs(?!.*\|\|)/.test(wf) && /Browser smoke gates/.test(wf),
  'the smoke gate has no soft-echo');
check('workflow/typecheck-gate', wf.includes('npm run types'), 'checkJs runs in CI');
/* The verdict must depend on EVERY gate job. Hardcoding `[test, checks]`
   silently stopped being true the moment the browser gates became their own
   job — a check that names a fixed list cannot notice a new job it should be
   guarding, which is the failure mode that lets a gate go unwatched. */
const needsLine = /needs: \[([^\]]+)\]/.exec(wfCode)?.[1] || '';
const verdictNeeds = needsLine.split(',').map((x) => x.trim()).filter(Boolean);
/* Scoped to the `jobs:` block. A bare two-space-indent scan also matched
   `push:` under `on:` — my first version of this gate did exactly that and
   demanded the verdict depend on a trigger. */
const jobsBlock = wfCode.slice(wfCode.indexOf('\njobs:'));
const gateJobs = [...jobsBlock.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)]
  .map((m) => m[1]).filter((j) => j !== 'ci-verdict');
check('workflow/verdict', verdictNeeds.length > 0, 'the aggregate verdict job exists');
check('workflow/verdict-covers-every-job',
  gateJobs.every((j) => verdictNeeds.includes(j)),
  `the verdict must need every gate job — has [${verdictNeeds}], jobs are [${gateJobs}]`);
check('workflow/real-verdict', !/echo "?all checks passed/i.test(wf),
  'no fake verdict job (success/failure/cancelled must be read, not printed)');
/* 2026-08-14 audit #43/#44: nothing EXECUTED in the workflow may route
   through npx. npx fetches when the local bin is missing — the exact
   supply-chain shape the pinned playwright-core dependency exists to
   prevent — so the browser install addresses node_modules/.bin directly.
   Comments are stripped first: explaining the rule requires naming it. */
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
/* Audit 64 residuals as teeth (2026-08-14): the render bench must keep its
   INFRA/THRESHOLD split (exit 2 soft, exit 1 red), and the docs gate must
   stay wired — F4's whole point is that drift becomes a build failure. */
check('workflow/docs-gate', wf.includes('node tools/check-docs.mjs'), 'F4: doc drift is a build failure');
check('render-bench/split-exits', /INFRA \(exit 2\)/.test(readFileSync('tools/render-bench.mjs', 'utf8')),
  'F2: infra is soft, thresholds are red');
check('workflow/render-bench-hard', !/render:bench unavailable \(see tools/.test(wf)
  && /render:bench \|\| code=\$\?/.test(wf.replace(/\n/g, ' ')),
  'F2: no soft-echo blanket remains');

/*
 * HEAP HEADROOM IS A CI INVARIANT NOW (audit R3-01).
 *
 * `npm test` was red on a clean clone because one integration file booted
 * 108 jsdom documents and OOMed. It had been reported once and answered by
 * RAISING --max-old-space-size; the file then grew past the new ceiling too.
 * Nothing in the pipeline noticed either time, because shard COMPLETENESS
 * was proven while per-file resource cost was not measured at all.
 *
 * These checks make the structural fix load-bearing: the budget stays low
 * enough to report a leak, the runner and package.json cannot drift apart,
 * and no single integration file is allowed to grow back into a monolith.
 * The bound is boots-per-file, because that is what actually consumes heap.
 */
const BOOT_CAP = 45;
const pkgJson = JSON.parse(readFileSync('package.json', 'utf8'));
const runnerBudget = /--max-old-space-size=(\d+)/.exec(readFileSync('tools/ci-test.mjs', 'utf8'))?.[1];
const scriptBudget = /--max-old-space-size=(\d+)/.exec(pkgJson.scripts.test || '')?.[1];

check('heap/budgets-agree', runnerBudget === scriptBudget,
  `ci-test.mjs (${runnerBudget}) and npm test (${scriptBudget}) must share one budget`);
check('heap/budget-stays-low', Number(runnerBudget) <= 1400,
  `raising the ceiling hides leaks; split the file instead (currently ${runnerBudget}MB)`);

for (const f of readdirSync('test').filter((n) => n.endsWith('.test.mjs'))) {
  const src = readFileSync('test/' + f, 'utf8');
  const boots = (src.match(/\bawait boot\w*\(/g) || []).length;
  if (!boots) continue;
  check(`heap/boots-bounded:${f}`, boots <= BOOT_CAP,
    `${boots} jsdom boots in one file (cap ${BOOT_CAP}) — split it rather than raising the heap`);
}

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : '✗ NOT OK'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} CI invariants hold`);
process.exit(failed ? 1 : 0);
