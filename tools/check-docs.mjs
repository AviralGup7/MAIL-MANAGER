#!/usr/bin/env node
/**
 * DOC-DRIFT GATE (audit 64 F4, closed 2026-08-14).
 *
 * WHY
 * ---
 * The audit's most-read files described a repo that no longer existed:
 * the README claimed 1,339 tests while the suite declared 1,729, the docs
 * index listed nine of twelve documents, and audit 64's own closing
 * sentence was "the project now has more gates than its documentation
 * remembers — make the docs as gated as the code." A stale README is not a
 * cosmetic issue here: this repo's docs are load-bearing (they are what a
 * new maintainer — human or agent — orients by), and every other class of
 * drift in the project is answered the same way: a gate, not a cleanup.
 *
 * THE INVARIANTS
 * --------------
 *   1. docs/    — every document is in the index; every index row is a
 *                 real document. Both directions: an unlisted file is
 *                 invisible, a listed phantom is a lie.
 *   2. audits/  — the same, for the survivors the README keeps.
 *   3. README   — every "N tests" number the front page states recomputes
 *                 exactly from the suite's declared test() calls. The
 *                 number is a DECLARED tally (loop-generated cases add
 *                 more at runtime, hence "1,729+" phrasing): it is cheap,
 *                 deterministic and — the point — falsifiable on every
 *                 commit.
 *   4. STRUCTURE — every first-level folder under src/app/ is named in
 *                 the growth playbook. A folder that STRUCTURE.md does not
 *                 know is a law nobody enforces.
 *
 * A failure prints the CURRENT truth, so fixing it is an edit, not an
 * investigation. Exit 1 on any fall.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const results = [];
const check = (name, ok, detail = '') =>
  results.push({ name, ok: !!ok, detail: ok ? detail : String(detail) });

/* ---- 1+2 · the two indexes, both directions ----------------------------- */

for (const [dir, index] of [['docs', 'docs/README.md'], ['audits', 'audits/README.md']]) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
  const body = readFileSync(index, 'utf8');
  const unlisted = files.filter((f) => !body.includes(f));
  check(`${dir}/everything-indexed`, unlisted.length === 0,
    unlisted.length ? `missing from ${index}: ${unlisted.join(', ')}` : `${files.length} documents`);
  /* Reverse: every *.md reference the index makes must resolve — relative
     to the index's own folder or to the repo root (cross-references like
     docs/UX-AUDIT-V4.md from the audits README are legitimate links, not
     phantom rows). */
  const refs = [...body.matchAll(/[\w./-]*\.md/g)].map((m) => m[0]);
  const phantoms = [...new Set(refs)].filter((ref) =>
    !existsSync(resolve(dir, ref)) && !existsSync(resolve(ref)));
  check(`${dir}/no-phantom-rows`, phantoms.length === 0,
    phantoms.length ? `named but absent: ${phantoms.join(', ')}` : '');
}

/* ---- 3 · the front page's stated test count recomputes ------------------- */

const declared = readdirSync('test')
  .filter((f) => f.endsWith('.test.mjs'))
  .reduce((sum, f) => sum + (readFileSync(`test/${f}`, 'utf8').match(/^test\(/gm) || []).length, 0);
const readme = readFileSync('README.md', 'utf8');
const stated = [...readme.matchAll(/([\d,]+)\+? (?:declared )?tests/gi)]
  .map((m) => Number(m[1].replace(/,/g, '')));
const countOk = stated.length > 0 && stated.every((n) => n === declared);
check('readme/test-count-is-true', countOk,
  countOk
    ? `${declared} declared`
    : (stated.length
      ? `README says ${stated.join(', ')}; the suite declares ${declared} — update README.md`
      : 'no test count in README.md — expected one'));

/* ---- 4 · every src/app folder is law, not just fact ---------------------- */

const struct = readFileSync('docs/STRUCTURE.md', 'utf8');
const appFolders = readdirSync('src/app', { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name);
const unknownFolders = appFolders.filter((f) => !struct.includes(`${f}/`));
check('structure/folders-are-law', unknownFolders.length === 0,
  unknownFolders.length
    ? `src/app folders missing from docs/STRUCTURE.md: ${unknownFolders.join(', ')}`
    : `${appFolders.length} folders`);

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : '✗ NOT OK'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} doc invariants hold`);
process.exit(failed ? 1 : 0);
