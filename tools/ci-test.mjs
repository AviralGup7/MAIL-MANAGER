/**
 * CI test runner.
 *
 * `npm test` deliberately SKIPS the jsdom-dependent suites when jsdom is not
 * installed, so a clean checkout works with no install step. That is correct
 * locally and dangerous in CI: a pipeline missing `npm ci` would report
 * success while never running a single DOM test -- including the ones that
 * caught the 400-row cap, the sign-out render bug and the listbox tree.
 *
 * This runner fails if ANY test is skipped, so "skipped because unavailable"
 * can never masquerade as "passed".
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/*
 * SHARDING (round 53). The full suite is one long serial run, and a single
 * CI job concentrates every jsdom document, every crash and every minute of
 * wall time into one place. `--shard i/n` runs ONLY the i-th of n slices so
 * the workflow can fan the suite out across parallel jobs.
 *
 * The split is deterministic and balanced by COUNT: files are sorted, then
 * dealt round-robin, so every shard gets every n-th file and the heavy
 * integration suites (which sort apart) do not all land in one slice. No
 * shard may silently shrink the suite -- the skip-fails rule still applies
 * to whatever a shard runs.
 */
function parseShard(argv) {
  const at = argv.indexOf('--shard');
  if (at === -1) return null;
  const spec = argv[at + 1];
  const m = /^(\d+)\/(\d+)$/.exec(spec || '');
  if (!m) {
    console.error(`✗ --shard expects i/n, got: ${spec ?? '(nothing)'}`);
    process.exit(2);
  }
  const i = Number(m[1]);
  const n = Number(m[2]);
  if (!(n >= 1) || !(i >= 1) || i > n) {
    console.error(`✗ --shard out of range: ${spec}`);
    process.exit(2);
  }
  return { i, n };
}

const ALL_TEST_FILES = readdirSync('test').filter((f) => f.endsWith('.test.mjs')).sort();

function shardFiles(shard) {
  if (!shard) return null; // run the whole directory, as before
  return ALL_TEST_FILES
    .filter((_, idx) => idx % shard.n === shard.i - 1)
    .map((f) => join('test', f));
}

/**
 * COMPLETENESS PROOF (round 61). A shard run must never silently shrink the
 * suite: every test file belongs to EXACTLY ONE shard of the n-way split.
 * The deal is deterministic, so this is checked, not assumed — if the
 * sharding arithmetic ever changes, a hidden file fails the shard here
 * instead of quietly never running in CI.
 */
function proveCompleteCoverage(n) {
  const dealt = [];
  for (let i = 1; i <= n; i++) {
    dealt.push(...ALL_TEST_FILES.filter((_, idx) => idx % n === i - 1));
  }
  const unique = new Set(dealt);
  if (dealt.length !== ALL_TEST_FILES.length || unique.size !== ALL_TEST_FILES.length) {
    console.error(
      `✗ shard coverage is incomplete: ${dealt.length} dealt vs ${ALL_TEST_FILES.length} files`
    );
    process.exit(2);
  }
}

const shard = parseShard(process.argv.slice(2));
if (shard) proveCompleteCoverage(shard.n);
const files = shardFiles(shard);

/*
 * --dry-run: print the shard's manifest as JSON and exit. The self-integrity
 * gate (tools/ci-selfcheck.mjs) drives this for every shard to prove the
 * matrix's slices are non-empty, disjoint and complete WITHOUT trusting the
 * workflow's own reading of them — the gate recomputes from the directory.
 * Exit 3 on an empty shard: an empty slice is a silent skip of nothing,
 * which is exactly the failure shape this runner was built to outlaw.
 */
if (process.argv.includes('--dry-run') && shard) {
  console.log(JSON.stringify({ shard: `${shard.i}/${shard.n}`, count: files.length, files: files.map((f) => f.replace(/^test\//, '')) }));
  process.exit(files.length ? 0 : 3);
}

const args = ['--max-old-space-size=1400', '--test'].concat(files ?? ['test/']);

if (files) {
  console.log(`Shard ${shard.i}/${shard.n}: running ${files.length} of ${ALL_TEST_FILES.length} test files`);
  // The manifest: exactly which files this shard owns, visible in the CI
  // log. Summing the four manifests reproduces the full suite — nothing can
  // hide between shards.
  console.log(`  files: ${files.map((f) => f.replace(/^test\//, '')).join(', ')}`);
}

/*
 * --max-old-space-size mirrors `npm test`, and is not optional.
 *
 * MEASURED: jsdom retains memory per document even after close() and an
 * explicit gc(). The integration suite used to boot 108 documents in ONE
 * file, which crossed the ceiling and aborted with SIGABRT -- a failure
 * with no assertion attached, which sends you hunting a logic bug that does
 * not exist.
 *
 * THE CEILING CAME BACK DOWN (audit R3-01). It had been raised to 3072 to
 * make that file fit; the file then grew past 3072 too. Raising a ceiling
 * buys time and hides the trend, so the fix was structural instead: the
 * integration suite is split into four parts, and `node --test` runs each
 * FILE in its own process. Every part now passes at 700MB -- half of this
 * budget -- so 1400 is headroom, not a wall being scraped.
 *
 * KEEP IT LOW ON PURPOSE. A budget that a leak can quietly consume is a
 * budget that stops reporting leaks. If a part starts failing here, split
 * it (the parts are ~18 boots each); do not raise this number.
 *
 * Sharding reduces how many files share one ceiling at once, which is one
 * more reason it exists.
 */
const res = spawnSync('node', args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});

process.stdout.write(res.stdout || '');

const num = (label) => {
  const m = (res.stdout || '').match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
  return m ? Number(m[1]) : 0;
};

const pass = num('pass');
const fail = num('fail');
const skipped = num('skipped');
const total = num('tests');
const dur = (res.stdout || '').match(/^# duration_ms ([\d.]+)$/m);

/*
 * THE PASTEABLE SUMMARY (round 52).
 *
 * The full TAP log is thousands of lines; the maintainer needs one small
 * block to paste back into the working session: the verdict, the counts,
 * and for every failure its name, file:line, duration and the first line of
 * the error. Emitted with loud delimiters at the very end of the CI log and
 * mirrored into the GitHub step summary when running under Actions.
 */
function collectFailures(tap) {
  const out = [];
  const lines = tap.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^not ok \d+ - (.*)$/);
    if (!m) continue;
    const name = m[1];
    let location = '';
    let failureType = '';
    let error = '';
    let duration = '';
    // The YAML diagnostics block follows within the next ~20 lines.
    for (let j = i + 1; j < Math.min(i + 30, lines.length); j++) {
      const t = lines[j].trim();
      if (t.startsWith('location:')) location = t.slice('location:'.length).trim().replace(/^'|'$/g, '');
      if (t.startsWith('failureType:')) failureType = t.slice('failureType:'.length).trim();
      if (t.startsWith('duration_ms:')) duration = t.slice('duration_ms:'.length).trim();
      if (t.startsWith('error:')) {
        // error: may be inline or open a |- block; take the first real text.
        const inline = t.slice('error:'.length).trim();
        if (inline && inline !== '|-') error = inline;
        else {
          for (let k = j + 1; k < Math.min(j + 8, lines.length); k++) {
            const cand = lines[k].trim();
            if (cand) { error = cand; break; }
          }
        }
      }
      if (t === '...') break;
    }
    out.push({ name, location, failureType, error, duration });
  }
  return out;
}

const failures = collectFailures(res.stdout || '');
// A run can DIE (OOM abort, SIGTERM) with zero failing counters -- counters
// alone would call that a PASS. The child's exit status and signal are the
// tie-breaker: `node --test` exits non-zero exactly when tests fail OR the
// run did not complete.
const crashed = !!(res.error || res.signal || (res.status !== 0 && fail === 0));
const verdict = crashed ? 'CRASHED' : (fail === 0 && skipped === 0 && pass > 0 ? 'PASS' : 'FAIL');
const bar = '='.repeat(56);
const shardTag = shard ? ` — shard ${shard.i}/${shard.n}` : '';
const summary = [
  bar,
  `TEST SUMMARY${shardTag} — ${verdict}`,
  `files: ${files ? files.length : ALL_TEST_FILES.length} | tests: ${total} | passed: ${pass} | failed: ${fail} | skipped: ${skipped}` +
    (dur ? ` | duration: ${Math.round(Number(dur[1]) / 1000)}s` : '') +
    (crashed ? ` | RUN DID NOT COMPLETE (status=${res.status}${res.signal ? `, signal=${res.signal}` : ''})` : ''),
  ...(failures.length
    ? ['Failed tests:',
       ...failures.map((f, i) => [
         `  ${i + 1}. ${f.name}`,
         f.location ? `     at: ${f.location}` : null,
         f.duration ? `     took: ${Math.round(Number(f.duration))}ms` : null,
         `     reason: ${f.failureType || 'unknown'}${f.error ? ` — ${f.error.slice(0, 200)}` : ''}`,
       ].filter(Boolean).join('\n'))]
    : ['Failed tests: none']),
  bar,
].join('\n');

console.log(`\n${summary}`);

// On GitHub Actions, also land it on the run's Summary page.
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `\n\`\`\`\n${summary}\n\`\`\`\n`
  );
}

console.log(`\nCI summary: ${pass} passed, ${fail} failed, ${skipped} skipped`);

if (crashed) {
  console.error('\n✗ The test run CRASHED before completing — counters above are partial.');
  process.exit(1);
}
if (fail > 0) {
  console.error(`\n✗ ${fail} test(s) failed.`);
  process.exit(1);
}
if (skipped > 0) {
  console.error(
    `\n✗ ${skipped} test(s) were SKIPPED.\n` +
      `  In CI every test must run. This usually means jsdom is missing —\n` +
      `  run "npm ci" before "npm run test:ci".`
  );
  process.exit(1);
}
if (pass === 0) {
  console.error('\n✗ No tests ran at all.');
  process.exit(1);
}
console.log('✓ All tests ran and passed.');
