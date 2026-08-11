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

/*
 * --max-old-space-size mirrors `npm test`, and is not optional.
 *
 * MEASURED: jsdom retains ~2.2MB per document even after close() and an
 * explicit gc() -- 20 closed documents cost 40MB, 60 cost 129MB, linearly.
 * The integration suite boots 141 of them. Run ALONE that still fits in
 * Node's default ~950MB ceiling; run under `node --test test/`, where files
 * execute in parallel and share the budget, it does not -- and the file
 * aborts with SIGABRT. That surfaces as a test failure with no assertion
 * attached, which sends you hunting a logic bug that does not exist. It also
 * means the failure only appears in the full suite, never when you re-run the
 * file to investigate.
 *
 * close() in the harness fixed the leak we owned; this covers the one jsdom
 * owns. Raising the ceiling is the honest fix here -- the alternative is
 * splitting the file for reasons that have nothing to do with what it tests.
 */
const res = spawnSync('node', ['--max-old-space-size=3072', '--test', 'test/'], {
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
const summary = [
  bar,
  `TEST SUMMARY — ${verdict}`,
  `tests: ${total} | passed: ${pass} | failed: ${fail} | skipped: ${skipped}` +
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
