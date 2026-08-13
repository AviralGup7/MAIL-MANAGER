#!/usr/bin/env node
/**
 * `timetable-mail.js` hard-codes the department vocabulary so the ingest path
 * does not have to load a 652KB JSON file to classify a subject line. That is
 * the right trade, and it creates a drift risk: the day the timetable is
 * regenerated with a new department, course detection silently stops seeing it.
 *
 * This asserts the literal and the data agree, in both directions.
 */
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('../src/timetable/data.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/app/academic/timetable-mail.js', import.meta.url), 'utf8');

const m = source.match(/const DEPTS = '([^']+)'/);
if (!m) {
  console.error('could not find the DEPTS literal in timetable-mail.js');
  process.exit(1);
}
const declared = new Set(m[1].split('|'));
const actual = new Set(data.courses.map((c) => c.courseNo.split(/\s+/)[0]));

const missing = [...actual].filter((d) => !declared.has(d));
const extra = [...declared].filter((d) => !actual.has(d));

const problems = [];
if (missing.length) problems.push(`in the timetable but NOT detected: ${missing.join(', ')}`);
if (extra.length) problems.push(`detected but not in the timetable: ${extra.join(', ')}`);

/*
 * ORDERING: A WARNING, NOT AN ERROR.
 *
 * This started as a hard failure on the theory that regex alternation is
 * first-match, so BIO before BIOT would make "BIOT F110" match the BIO branch.
 * I tested it and it is FALSE: after the department the pattern demands one
 * letter and three DIGITS, so BIO cannot consume "BIOTF110" and the word
 * boundary rules out the spaced form too.
 *
 * Kept as advice because longest-first is still the clearer way to write the
 * list and protects against a future pattern change that removes the mandatory
 * letter -- but failing the build over a non-bug is how a check loses its
 * credibility.
 */
const order = m[1].split('|');
const shadowed = [];
for (let i = 0; i < order.length; i++) {
  for (let j = i + 1; j < order.length; j++) {
    if (order[j].startsWith(order[i])) shadowed.push(`"${order[j]}" after "${order[i]}"`);
  }
}

if (problems.length) {
  console.error('department drift:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
if (shadowed.length) {
  console.log(`note: prefix pairs not in longest-first order (harmless): ${shadowed.join(', ')}`);
}
console.log(`ok: ${declared.size} departments, matching the timetable`);
