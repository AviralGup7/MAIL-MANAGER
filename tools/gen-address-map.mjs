/**
 * Generate src/classify/address-map.js from CLASSIFICATION_DATA_PACK.md §7.
 *
 * WHY THIS IS WORTH DOING
 * -----------------------
 * Section 7 holds 152 hand-curated real BITS addresses mapped to categories.
 * The data pack notes they "exist in the repo but are NOT loaded by the
 * classifier code at runtime" -- so this is curated knowledge that has been
 * sitting unused in both versions.
 *
 * An exact address is a stronger signal than any substring rule: there is no
 * ambiguity about whether `ad.swd@pilani.bits-pilani.ac.in` is administration.
 * So this becomes stage 0, ahead of the substring rules, and it is an O(1) Map
 * lookup rather than a scan.
 *
 * Regenerate: node tools/gen-address-map.mjs
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
const OUT = join(ROOT, 'src/classify/address-map.js');

const md = readFileSync(PACK, 'utf8');
const block = md.slice(md.indexOf('## 7. Email Mappings'), md.indexOf('## 8. Pipeline Logic'));

/** address -> category. First writer wins; collisions are reported. */
const map = new Map();
const collisions = [];
const perCat = {};

for (const sec of block.split(/\n### /).slice(1)) {
  const cat = sec
    .split('\n')[0]
    .replace(/^\w+\.\s*/, '')
    .replace(/\s*\(\d+ addresses\)/, '')
    .trim();
  for (const m of sec.matchAll(/"email":\s*"([^"]+)"/g)) {
    const addr = m[1].trim().toLowerCase();
    if (!addr.includes('@')) continue;
    if (map.has(addr)) {
      if (map.get(addr) !== cat) collisions.push({ addr, first: map.get(addr), also: cat });
      continue;
    }
    map.set(addr, cat);
    perCat[cat] = (perCat[cat] || 0) + 1;
  }
}

const entries = [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

let out = `/**
 * Exact sender address -> category.
 *
 * ===========================================================================
 * GENERATED FILE -- DO NOT EDIT BY HAND
 * ===========================================================================
 * Source:     CLASSIFICATION_DATA_PACK.md section 7
 * Regenerate: node tools/gen-address-map.mjs
 *
 * ${entries.length} hand-curated BITS addresses. The data pack records that these
 * "exist in the repo but are NOT loaded by the classifier code at runtime" --
 * they were dead data in the old version. Loading them is the single largest
 * accuracy win available from the pack.
 *
 * WHY THIS RUNS FIRST
 * An exact address admits no ambiguity: ad.swd@pilani.bits-pilani.ac.in IS
 * administration, whatever the subject line says. Substring rules are a
 * heuristic; this is a fact. So it runs ahead of them, at confidence 0.98.
 *
 * WHY A Map AND NOT AN OBJECT
 * Map lookup is O(1) with no prototype chain to walk and no risk of a key
 * like "constructor" or "__proto__" colliding with Object.prototype. The
 * address is attacker-controlled, so that matters.
 */

/** @type {Map<string, string>} lowercased address -> category */
export const ADDRESS_MAP = new Map([
`;

for (const [addr, cat] of entries) {
  out += `  ['${addr}', '${cat}'],\n`;
}

out += `]);

/**
 * Look up an exact address. Returns a category or null.
 * @param {string} address already-lowercased bare address
 */
export function lookupAddress(address) {
  if (!address) return null;
  return ADDRESS_MAP.get(address) || null;
}
`;

writeFileSync(OUT, out);

console.log(`wrote ${OUT}`);
console.log(`  addresses: ${entries.length}`);
for (const [c, n] of Object.entries(perCat).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${c.padEnd(16)} ${n}`);
}
if (collisions.length) {
  console.log(`  COLLISIONS (${collisions.length}) -- first wins:`);
  for (const c of collisions) console.log(`    ${c.addr}: ${c.first} vs ${c.also}`);
}
