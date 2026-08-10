/**
 * Architecture lints — the standing guards for the layering doctrine.
 *
 * The audit (39/40 ARCH, R-3) asked for these as source-text tests, the same
 * pattern the repo already uses for its CSS/JS contracts. The rules here
 * encode the documented dependency direction:
 *
 *   classify  -> (classify only)            pure domain, zero chrome.*
 *   shared    -> (shared only)              leaf constants
 *   background-> gmail/auth/sync/mime + the ONE declared snooze-domain
 *               import (wake scheduling needs the snooze store helpers)
 *   app       -> app + shared                may NEVER statically import
 *                                            background (fallback.js's
 *                                            dynamic imports are the declared
 *                                            degraded-mode exception)
 *   takeover  -> no imports at all          content script, runs in Gmail
 *
 * And the live-binding guard: the `store` binding is a `let` rebindable per
 * mailbox, so publishing it through an object must use a getter
 * (`get store() { return store; }`). A value capture (`{ store, ... }`) froze
 * the inbox store permanently and broke every feature that read through ctx
 * after a mailbox switch — the single most expensive bug class in this
 * project's history (see app.js's ctx comment).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

function allFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) allFiles(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Static (top-level) imports only; dynamic import() is a different contract. */
function staticImports(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];
  for (const m of src.matchAll(/^import\s+[^'"]*?['"]([^'"]+)['"]/gm)) {
    if (!m[1].startsWith('.')) continue; // bare specifiers: none expected
    out.push(m[1]);
  }
  return out;
}

const rel = (p) => p.slice(ROOT.length + 1).replace(/\\/g, '/');

test('classify imports only within classify (pure domain layer)', () => {
  for (const f of allFiles(join(SRC, 'classify'))) {
    for (const imp of staticImports(f)) {
      assert.ok(
        imp.startsWith('./') || imp.startsWith('../classify'),
        `${rel(f)} imports outside the classify layer: ${imp}`
      );
    }
  }
});

test('shared imports nothing (leaf)', () => {
  for (const f of allFiles(join(SRC, 'shared'))) {
    assert.deepEqual(staticImports(f), [], `${rel(f)} must not import anything`);
  }
});

test('background never imports app statically — except the declared snooze helpers', () => {
  for (const f of allFiles(join(SRC, 'background'))) {
    for (const imp of staticImports(f)) {
      if (!imp.startsWith('../app/')) continue;
      // The one declared edge: the wake alarm needs the snooze store helpers.
      // Everything else from app is a layering violation.
      assert.ok(
        imp === '../app/snooze.js',
        `${rel(f)} imports from the app layer: ${imp} (only ../app/snooze.js is declared)`
      );
    }
  }
  // And even that edge is limited to the three storage helpers, not the label
  // (which lives in shared/labels.js) or any UI code.
  const idx = readFileSync(join(SRC, 'background', 'index.js'), 'utf8');
  const m = idx.match(/^import \{([^}]*)\} from '\.\.\/app\/snooze\.js'/m);
  assert.ok(m, 'the declared snooze import must exist and be explicit');
  for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
    assert.ok(
      ['loadSnoozed', 'removeSnooze', 'due'].includes(name),
      `worker imports undeclared app symbol: ${name}`
    );
  }
});

test('app never imports background statically (fallback dynamic imports are the exception)', () => {
  for (const f of allFiles(join(SRC, 'app'))) {
    for (const imp of staticImports(f)) {
      assert.ok(
        !imp.startsWith('../background'),
        `${rel(f)} statically imports background: ${imp}`
      );
    }
  }
  // The exception is real and must stay dynamic: fallback.js imports the
  // Gmail/auth modules ONLY when the worker is dead, so a healthy session
  // never pays for them.
  const fb = readFileSync(join(SRC, 'app', 'fallback.js'), 'utf8');
  assert.ok(fb.includes("import('../background/auth.js')"), 'fallback dynamic import preserved');
});

test('takeover content script has no imports (runs inside Gmail)', () => {
  for (const f of allFiles(join(SRC, 'takeover'))) {
    assert.deepEqual(staticImports(f), [], `${rel(f)} must not import`);
  }
});

test('the ctx store binding is a getter, never a value capture', () => {
  // The bug class: `ctx = { store, ... }` captures the let-bound store at
  // module load — permanently freezing the inbox store into every consumer.
  // The fix (and the rule): publish live bindings through getters only.
  for (const f of allFiles(join(SRC, 'app')).concat(allFiles(join(SRC, 'background')))) {
    const lines = readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue; // comments
      // Shorthand member `store` or keyed `store:` inside an OBJECT LITERAL.
      // Requiring an opening brace on the line is what distinguishes a
      // literal from a call argument (`f(a, store, b)` matches the same
      // token pattern but is a read, not a capture). Multi-line literals
      // with `store,` alone on a line are a known blind spot; app.js's ctx —
      // the incident site — is fully covered by the getter rule below.
      if (!line.includes('{')) continue;
      if (!/(^|[\s,{])store\s*([,}:]|$)/.test(line)) continue;
      if (/=> store\b/.test(line)) continue; // arrow return, not a member
      // Function parameters and call arguments: `store` inside parens that
      // contain no brace is a local binding, not an object member. A capture
      // like `foo({ store })` has the brace INSIDE the parens and stays.
      const parens = line.match(/\([^)]*\)/g) || [];
      if (parens.some((p) => p.includes('store') && !p.includes('{'))) continue;
      if (/get store\(/.test(line)) continue;
      if (/(^|[=(\s])store\s*[,}]\s*=\s*/.test(line)) continue; // destructure
      assert.fail(
        `${rel(f)}:${i + 1} captures the store binding by value — use 'get store()' (see app.js ctx comment): ${line.trim()}`
      );
    }
  }
});
