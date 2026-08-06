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

console.log(`\nCI summary: ${pass} passed, ${fail} failed, ${skipped} skipped`);

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
