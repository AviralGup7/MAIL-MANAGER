/**
 * CI infrastructure pins (2026-08-13).
 *
 * WHY THESE PINS
 * --------------
 * The pipeline's strength used to be asserted by READING the workflow by
 * hand. These pins make the machine do it: the runner's --dry-run proves
 * shard shape without running a suite, the self-check gate proves the
 * workflow kept its teeth, and the smoke tool's failure path — artifacts,
 * infra-vs-assertion exit codes — is honoured in source because a failed
 * smoke with no evidence was exactly what M2 existed to prevent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const read = (rel) => readFileSync(rel, 'utf8');

test('runner --dry-run emits a non-empty disjoint manifest per shard', () => {
  const seen = new Set();
  for (const i of ['1', '2', '3', '4', '5', '6', '7', '8']) {
    const r = spawnSync('node', ['tools/ci-test.mjs', '--shard', `${i}/8`, '--dry-run'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `shard ${i}/8 dry-run must exit 0: ${r.stderr.slice(0, 120)}`);
    const manifest = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.ok(manifest.files.length > 0, `shard ${i}/8 may not be empty`);
    for (const f of manifest.files) {
      assert.ok(!seen.has(f), `${f} dealt twice`);
      seen.add(f);
    }
  }
});

test('the self-integrity gate itself is green on this checkout', () => {
  const r = spawnSync('node', ['tools/ci-selfcheck.mjs'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout.split('\n').filter((l) => l.includes('NOT OK')).join('\n') || r.stderr);
});

test('the smoke gate distinguishes plumbing from truth failures', () => {
  const src = read('tools/ci-smoke.mjs');
  assert.match(src, /INFRA \(exit 2\)/, 'browser launch failure exits 2, not 1');
  assert.match(src, /process\.exit\(fatal \? 2 : failed \? 1 : 0\)/, 'one exit code per failure class');
  assert.match(src, /browser\.version\(\)/, 'the browser version is in the log');
  assert.match(src, /\.smoke-failure\.png[\s\S]*\.smoke-failure\.html[\s\S]*\.smoke-failure\.txt/,
    'a failed smoke leaves a scene: screenshot, DOM, console');
});

test('the workflow keeps least-privilege, timeouts, one install, real verdict', () => {
  const wf = read('.github/workflows/ci.yml');
  assert.match(wf, /permissions:\s*\n\s+contents: read/, 'least privilege');
  assert.ok((wf.match(/timeout-minutes:/g) || []).length >= 3, 'jobs have timeouts');
  assert.match(wf, /Install Chromium \(once\)/, 'the doubled install stays merged');
  assert.match(wf, /if: failure\(\)/, 'failure evidence uploads only on failure');
  assert.match(wf, /needs: \[test, checks\][\s\S]*?if \[ "\$TEST" != "success" \]/,
    'the verdict reads results, it does not print them');
});

/* 2026-08-14 audit, the second pass: the leftovers from the 50-point review
   that were real gaps — the npx route, manifests that vanished with the
   logs, traces that only existed as a suggestion, the missing update
   discovery, and the audit that must never gate a push. */
test('no npx executed anywhere in the workflows; the browser comes from the lockfile', () => {
  // Comments are stripped before the sweep — explaining the rule requires
  // naming it, and a comment is not an executable route.
  const uncommented = (s) => s.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
  const ci = uncommented(read('.github/workflows/ci.yml'));
  const sec = uncommented(read('.github/workflows/security.yml'));
  assert.ok(!/\bnpx\s/.test(ci), 'ci.yml executable routes via node_modules/.bin');
  assert.ok(!/\bnpx\s/.test(sec), 'security.yml executable routes via node_modules/.bin');
  assert.match(ci, /node_modules\/\.bin\/playwright-core install chromium/);
});

test('the shard manifest is written by the gate and survives green runs', () => {
  const self = read('tools/ci-selfcheck.mjs');
  assert.match(self, /writeFileSync\('\.ci-manifest\.json'/, 'the gate produces the evidence');
  assert.match(self, /disjoint: overlap === 0/, 'the verdicts are IN the evidence');
  const wf = read('.github/workflows/ci.yml');
  assert.match(wf, /if: always\(\)[\s\S]*?\.ci-manifest\.json/, 'uploaded even when nothing failed');
});

test('the suite floor guards disappearance without pinning growth', () => {
  const self = read('tools/ci-selfcheck.mjs');
  assert.match(self, /all\.length >= 90/, 'the tripwire exists');
  /* And it is truthful at authoring time: the real suite is well above
     it — a floor that already trips on the current suite would be a lie,
     not a guard. */
  const files = readdirSync('test').filter((f) => f.endsWith('.test.mjs'));
  assert.ok(files.length >= 98, `expected the real suite, found ${files.length}`);
});

test('a failed smoke keeps a replayable trace; a green one keeps nothing', () => {
  const src = read('tools/ci-smoke.mjs');
  assert.match(src, /tracing\.start\(\{ screenshots: true, snapshots: true \}\)/,
    'the trace records from before the first gate');
  assert.match(src, /tracing\.stop\(\{ path: '\.smoke-trace\.zip' \}\)/, 'failure stops WITH a path');
  assert.match(src, /tracing\.stop\(\); \/\/ green: discard/, 'success discards');
  const wf = read('.github/workflows/ci.yml');
  assert.match(wf, /\.smoke-trace\.zip/, 'the trace has an upload path');
});

test('updates are discovered (dependabot), vulnerabilities scheduled, never push-gated', () => {
  const bot = read('.github/dependabot.yml');
  assert.match(bot, /package-ecosystem: github-actions/, 'pinned SHAs get bump PRs');
  assert.match(bot, /package-ecosystem: npm/, 'dependencies get bump PRs');

  const sec = read('.github/workflows/security.yml');
  assert.match(sec, /schedule:/, 'the audit runs weekly');
  assert.match(sec, /workflow_dispatch:/, '…and by hand');
  assert.match(sec, /npm audit --audit-level=high/, 'high+ only — the signal channel stays clean');
  assert.ok(!/on:\s*\n\s*push/.test(sec),
    'a moving advisory database must never gate a push — a red nobody believes');
});

test('runs cancel when superseded; every gate mirrors to the Summary page', () => {
  const wf = read('.github/workflows/ci.yml');
  assert.match(wf, /concurrency:\s*\n\s+group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/,
    'the concurrency group names the ref');
  assert.match(wf, /cancel-in-progress: true/, 'a new push stops paying for a stale answer');
  assert.match(wf, /needs: \[test, checks\][\s\S]*?GITHUB_STEP_SUMMARY/,
    'the verdict table lands on the Summary page');
  assert.match(read('tools/ci-test.mjs'), /GITHUB_STEP_SUMMARY/,
    'shard TEST SUMMARYs mirror (round 52, kept)');
  assert.match(read('tools/ci-smoke.mjs'), /GITHUB_STEP_SUMMARY/,
    'the browser-gate table mirrors too');
});
