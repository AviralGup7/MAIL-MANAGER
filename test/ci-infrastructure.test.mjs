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
import { readFileSync } from 'node:fs';

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
