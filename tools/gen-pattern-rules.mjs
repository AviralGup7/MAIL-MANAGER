/**
 * Regenerate src/classify/pattern-rules.js from CLASSIFICATION_DATA_PACK.md.
 *
 * WHY THIS IS GENERATED AND NOT HAND-WRITTEN
 * ------------------------------------------
 * The first port of this file was written by hand. It rewrote every weight
 * onto a tidy 40/25/15/8 scale and dropped 802 keys, while its header comment
 * claimed the rules were carried over. That is the single worst kind of
 * regression: the code looks deliberate, reads as intentional, and silently
 * classifies differently from the version the user asked to preserve.
 *
 * Generating it from the data pack makes drift impossible to introduce by
 * accident. Re-run after editing the pack:
 *
 *   node tools/gen-pattern-rules.mjs
 *
 * The generated order is BUILT_IN_RULES from data pack section 9, which is the
 * order the old classifier scored in. It does not matter for correctness --
 * stage 2 takes the highest score, not the first match -- but it matters for
 * reproducibility when two rules tie and resolveConflict has to break it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Defaults to the copy committed in this repo. The old default pointed at an
// upload directory that only existed on one machine, so regenerating failed
// for anyone else with a confusing ENOENT.
const PACK =
  process.argv[2] || new URL('../docs/CLASSIFICATION_DATA_PACK.md', import.meta.url).pathname;
const OUT = join(ROOT, 'src/classify/pattern-rules.js');

const md = readFileSync(PACK, 'utf8');

// ---- section 6: the rule objects ------------------------------------------
const block = md.slice(
  md.indexOf('## 6. Pattern Rule Definitions'),
  md.indexOf('## 7. Email Mappings')
);

const rules = {};
for (const sec of block.split(/\n### /).slice(1)) {
  const cat = sec.split('\n')[0].replace(/^\w+\.\s*/, '').trim();
  const code = sec.match(/```js\n([\s\S]*?)```/)?.[1];
  if (!code) continue;
  const body = code.replace(/export\s+default\s*/, '').trim().replace(/;$/, '');
  // eslint-disable-next-line no-new-func
  rules[cat] = new Function(`return (${body})`)();
}

// ---- section 9: scoring order ----------------------------------------------
const orderBlock = md.slice(md.indexOf('## 9. Built-in Rule Order'), md.indexOf('## 10.'));
const camel = [...orderBlock.matchAll(/^\s{2}(\w+),/gm)].map((m) => m[1]);
const toKebab = (s) => s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
const ORDER = camel.map(toKebab);

const ordered = [...ORDER.filter((c) => rules[c]), ...Object.keys(rules).filter((c) => !ORDER.includes(c))];

// ---- emit -------------------------------------------------------------------
const q = (s) => (/^[a-z_$][a-z0-9_$]*$/i.test(s) ? s : `'${s.replace(/'/g, "\\'")}'`);

function emitArray(name, arr, indent) {
  if (!arr?.length) return '';
  const pad = ' '.repeat(indent);
  return `${pad}${name}: [\n${arr.map((v) => `${pad}  '${v.replace(/'/g, "\\'")}',`).join('\n')}\n${pad}],\n`;
}

function emitWeights(name, obj, indent) {
  const keys = Object.keys(obj || {});
  if (!keys.length) return '';
  const pad = ' '.repeat(indent);
  return `${pad}${name}: {\n${keys.map((k) => `${pad}  ${q(k)}: ${obj[k]},`).join('\n')}\n${pad}},\n`;
}

let out = `/**
 * Keyword rules -- stage 2 of classification.
 *
 * ===========================================================================
 * GENERATED FILE -- DO NOT EDIT BY HAND
 * ===========================================================================
 * Source:    CLASSIFICATION_DATA_PACK.md sections 6 and 9
 * Regenerate: node tools/gen-pattern-rules.mjs
 *
 * These values are the ORIGINAL weights from the previous version's
 * \`lib/pattern-classifier/rules/*.js\`, carried over exactly. An earlier
 * hand-written port rewrote all of them onto a 40/25/15/8 scale and dropped
 * 802 keys while claiming to be a faithful copy. See
 * docs/CLASSIFIER-CORRECTION.md. Generating the file removes the opportunity
 * to make that mistake again.
 *
 * SHAPE
 *   { category, senderExact[], senderContains[], subjectWeights{}, snippetWeights{} }
 *
 * SCORING (data pack section 8)
 *   senderExact hit     -> +80 * 1.5   and sets hasSenderMatch
 *   senderContains hit  -> +55 * 1.5   and sets hasSenderMatch
 *   subject keyword     -> +weight * 1.2, subsequent hits * 0.6
 *   snippet keyword     -> +weight * 1.0, subsequent hits * 0.6
 *
 * All keys are matched case-insensitively against a lowercased haystack.
 *
 * ARRAY ORDER is BUILT_IN_RULES from data pack section 9. Stage 2 takes the
 * highest score rather than the first match, so order does not decide the
 * winner -- but it does decide ties, via resolveConflict.
 */

export const PATTERN_RULES = [
`;

for (const cat of ordered) {
  const r = rules[cat];
  out += `  {\n    category: '${cat}',\n`;
  out += emitArray('senderExact', r.senderExact, 4);
  out += emitArray('senderContains', r.senderContains, 4);
  out += emitWeights('subjectWeights', r.subjectWeights, 4);
  out += emitWeights('snippetWeights', r.snippetWeights, 4);
  if (r.senderPenalty) out += emitArray('senderPenalty', r.senderPenalty, 4);
  out += `  },\n`;
}

out += `];\n`;

writeFileSync(OUT, out);

let keys = 0;
for (const r of Object.values(rules)) {
  keys += (r.senderExact || []).length + (r.senderContains || []).length;
  keys += Object.keys(r.subjectWeights || {}).length + Object.keys(r.snippetWeights || {}).length;
}
console.log(`wrote ${OUT}`);
console.log(`  categories: ${ordered.length}`);
console.log(`  total keys: ${keys}`);
console.log(`  order: ${ordered.join(' > ')}`);
