/**
 * Mutation testing harness.
 *
 * A passing test suite proves the tested paths work. It does NOT prove the
 * tests would notice if the code broke. This applies small, semantically
 * meaningful mutations to the source and reports any that the suite fails to
 * catch — each surviving mutant is a line of code nothing verifies.
 *
 * Found the real gap that motivated this file: disabling the sanitiser's
 * attribute allow-list broke zero tests, because the event-handler guard was
 * silently compensating for it.
 *
 * Usage: node tools/mutate.mjs [testFile] [sourceFile...]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/** Mutations that change behaviour without breaking syntax. */
const RULES = [
  { name: 'negate-strict-eq', find: /([^=!<>])===/g, repl: '$1!==' },
  { name: 'negate-strict-neq', find: /!==/g, repl: '===' },
  { name: 'gte->gt', find: / >= /g, repl: ' > ' },
  { name: 'lte->lt', find: / <= /g, repl: ' < ' },
  { name: 'and->or', find: / && /g, repl: ' || ' },
  { name: 'true->false', find: /\btrue\b/g, repl: 'false' },
  { name: 'drop-negation', find: /\(!([a-zA-Z_$][\w$.]*)\)/g, repl: '($1)' },
];

const testFile = process.argv[2];
const sources = process.argv.slice(3);
if (!testFile || !sources.length) {
  console.error('usage: node tools/mutate.mjs <testFile> <source...>');
  process.exit(2);
}

const runs = (n) => {
  try {
    execSync(`node --test ${testFile} 2>&1`, { encoding: 'utf8', timeout: 180000 });
    return true; // suite passed => mutant SURVIVED
  } catch {
    return false; // suite failed => mutant killed
  }
};

let total = 0;
let survived = 0;
for (const src of sources) {
  const original = readFileSync(src, 'utf8');
  for (const rule of RULES) {
    const hits = [...original.matchAll(rule.find)];
    // Sample at most 6 sites per rule per file, to keep the run bounded.
    const step = Math.max(1, Math.floor(hits.length / 6));
    for (let i = 0; i < hits.length; i += step) {
      const at = hits[i].index;
      const mutated =
        original.slice(0, at) +
        original.slice(at).replace(rule.find, rule.repl.replace('$1', hits[i][1] ?? ''));
      if (mutated === original) continue;
      total++;
      writeFileSync(src, mutated);
      const alive = runs();
      writeFileSync(src, original);
      if (alive) {
        survived++;
        const line = original.slice(0, at).split('\n').length;
        console.log(`SURVIVED  ${src}:${line}  [${rule.name}]  ${
          original.split('\n')[line - 1].trim().slice(0, 72)}`);
      }
    }
  }
}
console.log(`\n${total - survived}/${total} mutants killed` +
  (survived ? `  — ${survived} survived (untested behaviour)` : '  — no gaps found'));
