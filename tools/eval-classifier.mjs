#!/usr/bin/env node
/**
 * Classifier evaluation harness (direction G4, 2026-08-14).
 *
 * WHY
 * ---
 * Audit 13's honest sentence: the classifier's accuracy on real BITS mail
 * is UNMEASURED — and the corpus that could measure it already exists but
 * is never read: sender corrections (`categoryRules.corrections`, the
 * address → category map a user builds one frustrated right-click at a
 * time). A correction is a labeled example. This tool replays them
 * through the RAW classifier — corrections deliberately NOT applied — and
 * reports the pre-correction agreement rate: how often the classifier, on
 * its own, already land on what the user said.
 *
 * Run: node tools/eval-classifier.mjs path/to/backup.json
 *
 * The number means what it says and no more: corrections were recorded at
 * correction-time, so a lower rate can mean the rules aged, not that they
 * were born wrong — which is exactly why the number belongs in the soak
 * log (docs/SOAK.md §4), week over week, and not in a one-off shrug.
 * This is a REPORT, not a gate: exit 0 on any parseable backup, exit 2
 * on missing/unreadable input — disagreement is data, never a failure.
 */
import { readFileSync } from 'node:fs';
import { classify } from '../src/classify/index.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/eval-classifier.mjs path/to/backup.json');
  process.exit(2);
}

let backup;
try {
  backup = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`✗ INFRA (exit 2): cannot read ${file}: ${String(e.message || e).split('\n')[0]}`);
  process.exit(2);
}

const corrections = backup?.categoryRules?.corrections || {};
const entries = Object.entries(corrections);

if (!entries.length) {
  console.log('No harvested corrections in this backup yet.');
  console.log('Correct a sender once in the app (category menu → correct),');
  console.log('export a backup from Options, and re-run — that is the corpus.');
  process.exit(0);
}

let agree = 0;
const rows = [];
for (const [addr, wanted] of entries) {
  const got = classify({ from: addr, subject: '', snippet: '' });
  const ok = got.category === wanted;
  if (ok) agree++;
  if (!ok) rows.push({ addr, predicted: got.category, wanted, via: got.source });
}

const checked = entries.length;
const pct = ((agree / checked) * 100).toFixed(1);
console.log('=== CLASSIFIER EVAL (pre-correction agreement) ===');
console.log(`corrections (labeled examples): ${checked}`);
console.log(`raw classifier already agrees:  ${agree}/${checked} (${pct}%)`);
console.log('');
if (rows.length) {
  const width = Math.min(44, Math.max(...rows.map((r) => r.addr.length), 6));
  console.log(`${'address'.padEnd(width)}  predicted → corrected (via)`);
  for (const r of rows) {
    console.log(`${r.addr.padEnd(width)}  ${r.predicted} → ${r.wanted} (${r.via})`);
  }
  console.log('');
  console.log('Each row is a rule that would earn its place in the data pack:');
  console.log('repeated rows for one sender pattern are the next data-pack edit.');
}
process.exit(0);
