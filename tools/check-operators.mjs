#!/usr/bin/env node
/**
 * The teaching surface and the parser must not drift.
 *
 * `suggest.js` advertises an operator vocabulary. `query.js` implements one.
 * If they disagree, the app teaches a syntax it cannot execute -- which is
 * exactly the failure mode that made a separate help sheet a bad idea, and it
 * would be invisible in normal use because both files look fine on their own.
 */
import { readFileSync } from 'node:fs';
import { OPERATORS } from '../src/app/search/suggest.js';
import { parseQuery } from '../src/app/search/query.js';

const problems = [];

for (const { op, example } of OPERATORS) {
  // Structural tokens, not operators.
  if (op === '-' || op === 'OR') continue;

  /*
   * PROBE WITH THE EXAMPLE, NOT WITH A PLACEHOLDER.
   *
   * The first version of this check probed `before:x`. That fails -- not
   * because `before:` is unimplemented, but because `x` is not a date, and
   * `buildCheck` correctly returns null for an unparseable value. The check
   * reported four false drifts on its first run.
   *
   * The lesson is the one this project keeps relearning: a validator that
   * fabricates its own input tests the fabrication. Operators that take a
   * typed value are probed with their documented example, which is the string
   * the user will actually be shown.
   */
  const probe = op.endsWith(':') ? (example || `${op}x`) : op;
  const parsed = parseQuery(probe);

  if (parsed.operators.length === 0) {
    problems.push(`${op} is advertised but the parser does not recognise it (probe: "${probe}")`);
  }
  if (example && !op.endsWith(':')) {
    const ex = parseQuery(example);
    if (ex.operators.length === 0 && ex.terms.length <= 1 && !ex.grouped) {
      problems.push(`${op} example "${example}" does not parse into anything`);
    }
  }
}

// And the reverse: an operator the parser knows but nobody advertises.
const source = readFileSync(new URL('../src/app/search/query.js', import.meta.url), 'utf8');
const implemented = new Set();
for (const m of source.matchAll(/^\s*case '([a-z_]+)':/gm)) implemented.add(m[1]);
const KNOWN_STRUCTURAL = new Set(['direct', 'broadcast', 'unread', 'read', 'starred', 'unstarred',
  'due', 'overdue', 'important', 'attachment', 'deadline']);
const advertised = new Set(OPERATORS.map((o) => o.op.replace(/:.*$/, '').replace(':', '')));

for (const key of implemented) {
  if (KNOWN_STRUCTURAL.has(key)) continue;
  if (!advertised.has(key)) {
    problems.push(`${key}: is implemented in the parser but never suggested to the user`);
  }
}

if (problems.length) {
  console.error('operator drift:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`ok: ${OPERATORS.length} advertised operators all parse, and nothing is hidden`);
