/**
 * Bundle the service-worker graph into ONE classic (non-module) script.
 *
 * WHY THIS EXISTS
 * ---------------
 * Four variants of the worker have now failed to register in the user's
 * Chrome, all with "Status code: 2":
 *
 *   src/background/index.js   type: module   subdirectory
 *   src/background/boot.js    type: module   subdirectory
 *   sw.js                     type: module   ROOT
 *   sw.js, no manifest key    type: module   ROOT, fresh extension ID
 *
 * The fresh ID is the important one: it rules out a poisoned registration
 * slot in the profile, which was the previous hypothesis. And every static
 * check passes, the file serves 200 OK, and the graph evaluates cleanly in a
 * worker-shaped global under Node.
 *
 * THE ONE VARIABLE NEVER CHANGED IS `"type": "module"`.
 *
 * A module service worker needs the browser to fetch and link an ES module
 * graph over chrome-extension://. That is a materially different code path
 * from a classic worker, it is younger, and it is where the remaining
 * unexplained failures in this area live. A classic worker skips it
 * entirely: one file, no linking, no import resolution.
 *
 * So this flattens the graph to a single classic script. It is not elegant,
 * but it removes the last untested variable, and if the extension then
 * registers we will know precisely what the cause was.
 *
 *   node tools/build-sw.mjs        # writes sw.bundle.js
 *
 * HOW IT WORKS, AND WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------------------------
 * The modules here use a restricted subset of ESM: named `export function`,
 * `export const`, `export class`, and static named imports. No default
 * exports, no re-exports, no `import.meta`, no top-level await, no dynamic
 * import (checked before writing this).
 *
 * Because every module shares one scope after concatenation, two modules
 * declaring the same top-level name would collide. That is checked and
 * reported rather than silently producing a broken bundle -- the preview
 * bundler hit exactly that bug twice before, with `DAY_MS` and `$`.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'src/background/index.js');
const OUT = join(ROOT, 'sw.bundle.js');

/** Depth-first, so a module is emitted after everything it imports. */
function order(file, seen = new Set(), out = []) {
  if (seen.has(file)) return out;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/^\s*import[\s\S]*?from\s*['"]([^'"]+)['"]/gm)) {
    const spec = m[1];
    if (!spec.startsWith('.')) throw new Error(`bare specifier "${spec}" in ${relative(ROOT, file)}`);
    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) throw new Error(`missing ${spec} from ${relative(ROOT, file)}`);
    order(target, seen, out);
  }
  out.push(file);
  return out;
}

/**
 * Strip ESM syntax, leaving plain declarations.
 *
 * String-aware, because this codebase contains
 * `chrome.tabs.query({ url: 'https://mail.google.com/*' })` and a naive
 * comment strip treats that `/*` as a comment opener, swallowing thirty
 * lines. That bug has already bitten two other tools here.
 */
function stripEsm(src) {
  let out = '';
  let mode = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '*') { mode = 'block'; out += c + n; i++; continue; }
      if (c === '/' && n === '/') { mode = 'line'; out += c + n; i++; continue; }
      if (c === "'") mode = 'single';
      else if (c === '"') mode = 'double';
      else if (c === '`') mode = 'tick';
      out += c;
      continue;
    }
    if (mode === 'line') { if (c === '\n') mode = 'code'; out += c; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; out += c + n; i++; continue; } out += c; continue; }
    if (c === '\\') { out += c + (n ?? ''); i++; continue; }
    if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"') || (mode === 'tick' && c === '`')) mode = 'code';
    out += c;
  }

  return out
    // `import { a, b } from './x.js';`  — possibly multi-line
    .replace(/^\s*import[\s\S]*?from\s*['"][^'"]+['"];?\s*$/gm, '')
    // `export function f` / `export const x` / `export class C` / `export async function`
    .replace(/^\s*export\s+(?=(async\s+)?(function|const|let|var|class)\b)/gm, '')
    // `export { a, b };`
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '');
}

const files = order(ENTRY);

/* Collision check. One scope means one namespace. */
const declared = new Map();
const clashes = [];
for (const f of files) {
  const body = stripEsm(readFileSync(f, 'utf8'));
  for (const m of body.matchAll(/^(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    if (declared.has(name) && declared.get(name) !== f) {
      clashes.push(`${name}: ${relative(ROOT, declared.get(name))} and ${relative(ROOT, f)}`);
    }
    declared.set(name, f);
  }
}
if (clashes.length) {
  console.error('\nName collisions — these would break in one shared scope:\n');
  for (const c of clashes) console.error(`  ${c}`);
  console.error('\nRename one side, then re-run.\n');
  process.exit(1);
}

const parts = files.map((f) => {
  const rel = relative(ROOT, f);
  return `\n/* ==== ${rel} ${'='.repeat(Math.max(0, 60 - rel.length))} */\n${stripEsm(readFileSync(f, 'utf8'))}`;
});

const banner = `/*
 * GENERATED by tools/build-sw.mjs -- do not edit.
 *
 * The service-worker graph flattened into ONE CLASSIC script, so the manifest
 * can drop "type": "module".
 *
 * Four module-worker variants failed to register in the reporter's Chrome
 * (subdirectory, root, and with a fresh extension ID), while the files served
 * 200 OK and evaluated cleanly under Node. "type": "module" was the only
 * variable never changed, and a module worker uses a materially different
 * fetch-and-link path from a classic one. This removes that variable.
 *
 * Source of truth remains src/background/*.js and src/app/snooze.js. Rebuild
 * with:  npm run build:sw
 *
 * Modules in dependency order:
${files.map((f) => ` *   ${relative(ROOT, f)}`).join('\n')}
 */
'use strict';
`;

writeFileSync(OUT, banner + parts.join('\n') + '\n');
console.log(`wrote ${relative(ROOT, OUT)} — ${files.length} modules, ${readFileSync(OUT, 'utf8').length} chars`);
