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

test('background never imports the app presentation layer', () => {
  for (const f of allFiles(join(SRC, 'background'))) {
    for (const imp of staticImports(f)) {
      assert.ok(!imp.startsWith('../app/'), `${rel(f)} imports presentation code: ${imp}`);
    }
  }
});

test('cross-context jobs live in feature-owned models with explicit worker APIs', () => {
  const idx = readFileSync(join(SRC, 'background', 'index.js'), 'utf8');
  const declared = [
    ['snooze/model.js', ['loadSnoozed', 'removeSnooze', 'due', 'nextWakeAt']],
    ['outbox/model.js', ['loadOutbox', 'saveOutbox', 'dueItems', 'markFailed', 'markUncertain', 'prioritizeDue', 'dispatchable']],
  ];
  for (const [file, symbols] of declared) {
    const marker = `from '../features/${file}'`;
    const at = idx.indexOf(marker);
    assert.ok(at !== -1, `the declared ${file} feature import must exist`);
    const open = idx.lastIndexOf('import {', at);
    const names = idx.slice(open + 'import {'.length, idx.indexOf('}', open))
      .split(',').map((s) => s.trim()).filter(Boolean);
    for (const name of names) assert.ok(symbols.includes(name), `worker imports undeclared feature symbol: ${name}`);
  }
  for (const f of allFiles(join(SRC, 'features'))) {
    for (const imp of staticImports(f)) {
      assert.ok(!imp.includes('/app/') && !imp.includes('/background/'),
        `${rel(f)} reaches a context-specific layer: ${imp}`);
    }
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
  // never pays for them. (fallback.js lives in app/system/ since S2, so the
  // declared-path check is two levels up.)
  const fb = readFileSync(join(SRC, 'app', 'system', 'fallback.js'), 'utf8');
  assert.ok(fb.includes("import('../../background/auth.js')"), 'fallback dynamic import preserved');
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
      // Function parameters and call arguments: `store` is a local binding,
      // not an object member, whenever the nearest enclosing opener before
      // the token is a PAREN. A capture (`{ store, ... }`) has a brace as the
      // opener; `applyMute(all, store, { ... })` has a paren, whatever else
      // the call contains. Scan, don't regex: balanced groups with nested
      // braces defeat any pattern that looks only at the line's parens.
      {
        const at = line.indexOf('store');
        let depth = 0, opener = null;
        for (let j = 0; j < at; j++) {
          const ch = line[j];
          if (ch === '(' || ch === '{') { depth++; opener = ch; }
          else if (ch === ')' || ch === '}') depth = Math.max(0, depth - 1);
        }
        if (opener === '(') continue;
      }
      if (/get store\(/.test(line)) continue;
      if (/(^|[=(\s])store\s*[,}]\s*=\s*/.test(line)) continue; // destructure
      assert.fail(
        `${rel(f)}:${i + 1} captures the store binding by value — use 'get store()' (see app.js ctx comment): ${line.trim()}`
      );
    }
  }
});

test('the timetable workspace renders in exactly one module (round 57 boundary pin)', () => {
  /*
   * The pilot evaluation's Q2, enforced: an agent improving the timetable
   * must start — and finish — in timetable-ui.js. The shell's role is seams
   * only: the #tt-workspace container, the Esc rung, the rail button. Any
   * tt-* DOM construction migrating into the shell is the boundary eroding,
   * and it is caught here, not in review.
   */
  const app = readFileSync(join(SRC, 'app', 'main.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  const tt = readFileSync(join(SRC, 'app', 'academic', 'timetable-ui.js'), 'utf8');

  assert.ok(!/['"`]tt-[a-z]/.test(app),
    'app.js must construct no tt-* DOM: the workspace renders itself');
  assert.match(tt, /setAttribute\('role', 'tablist'\)/,
    'the tablist lives in the workspace module');
  assert.match(app, /timetableIsOpen\(\)/,
    'the shell keeps exactly its seam: the Esc-ladder rung');
});

/* ==========================================================================
 * THE PLATFORM SEAM IS A LAW, NOT A COMMENT (architectural audit ARCH-R2-1)
 *
 * platform/storage.js opens by calling itself "the one module that owns
 * chrome.* access", whose stated benefit is that "the permission surface is
 * greppable in one place". Neither was true: ten modules touched chrome.*,
 * four of them in the APP LAYER where the seam's own STORAGE export was the
 * right answer (and, in main.js, was already imported two lines away).
 *
 * Nothing enforced it, so the claim had been decorative since it was written.
 * These two tests make the boundary real and — just as important — make its
 * LIMITS explicit, because the original sentence claimed an exclusivity that
 * was never achievable.
 * ========================================================================== */

/** Every src module, as a repo-relative path. */
function srcFiles() {
  return allFiles(SRC).map((p) => p.slice(ROOT.length + 1));
}

/** Source with comments removed: prose ABOUT an API is not a call to it. */
function codeOf(file) {
  return readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');
}

test('the app layer reaches storage through the seam, never chrome.storage', () => {
  /*
   * The app document is the one layer with a complete alternative: STORAGE
   * (a live-binding proxy) and localArea()/sessionArea() cover every storage
   * shape it needs. Using chrome.storage directly there also breaks the
   * integration harness, which swaps globalThis.chrome per boot — a captured
   * area silently belongs to a previous test's window.
   */
  const offenders = [];
  for (const f of srcFiles().filter((x) => x.startsWith('src/app/'))) {
    if (/\bchrome\.storage\b/.test(codeOf(f))) offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    `app-layer modules must use platform/storage.js, not chrome.storage: ${offenders.join(', ')}`);
});

test('chrome.* outside the seam is confined to the layers that have no alternative', () => {
  /*
   * The seam covers STORAGE. It does not cover alarms, identity, tabs,
   * scripting, notifications or runtime messaging — those have no storage-
   * shaped equivalent, and the worker, the content script and the options
   * page must call them directly. That is a boundary, not a violation, and
   * naming it here is what stops the next reader believing the header's
   * absolute phrasing.
   *
   * The list is CLOSED: a new module reaching for chrome.* must either use
   * the seam or be added here deliberately, with a reason.
   */
  const ALLOWED = new Set([
    'src/platform/storage.js',            // the seam itself
    'src/background/index.js',            // alarms, tabs, scripting, action, notifications
    'src/background/auth.js',             // identity + token storage
    'src/background/sync.js',             // history cursor
    'src/background/diag.js',             // counter flush
    'src/takeover/content.js',            // runtime messaging inside Gmail
    'src/options/options.js',             // identity redirect + runtime probe
    'src/app/system/fallback.js',         // runtime messaging (worker probe)
    'src/app/main.js',                    // runtime messaging (the verb bridge)
    'src/app/overlays/settings-panel.js', // runtime.openOptionsPage
    'src/app/academic/timetable-store.js', // runtime.getURL for a packaged asset
  ]);
  const unexpected = srcFiles()
    .filter((f) => !ALLOWED.has(f) && /\bchrome\.[a-zA-Z]/.test(codeOf(f)));
  assert.deepEqual(unexpected, [],
    `new chrome.* callers must use the seam or be declared: ${unexpected.join(', ')}`);
});

/* ==========================================================================
 * THE ctx CONTRACT IS PINNED (architectural audit ARCH-R2-2)
 *
 * `ctx` is the only sanctioned feature -> shell path and the widest coupling
 * surface in the app: ~12 modules read it, one of them 32 times. It had 29
 * members, 12 documented, none typed, and NO test pinning its shape.
 *
 * shell-contract.d.ts now declares it and main.js carries the @type
 * annotation. That annotation is documentation-grade only: main.js cannot
 * join the checkJs scope yet (pulling it in drags its whole import graph and
 * produces 248 pre-existing errors across academic/, compose/ and overlays/ —
 * a real backlog, but a separate one, tracked as its own direction).
 *
 * So the enforcement lives here instead, and it is the property that actually
 * matters: the declaration and the object must not drift apart. A member
 * added to one and not the other is a failing build, which is what stops the
 * next "used but never provided" defect.
 * ========================================================================== */

test('the ctx contract and the shell object agree, member for member', () => {
  const shell = readFileSync(join(ROOT, 'src/app/main.js'), 'utf8');
  const at = shell.indexOf('const ctx = {');
  assert.ok(at !== -1, 'the shell must still build a ctx literal');
  const body = shell.slice(at, shell.indexOf('\n};', at));

  // Top-level members of the literal: `name,` `name:` `name(` and `get name()`.
  const actual = new Set();
  for (const m of body.matchAll(/^ {2}(?:get\s+)?([a-zA-Z_$][\w$]*)\s*[,:(]/gm)) {
    actual.add(m[1]);
  }

  const dts = readFileSync(join(ROOT, 'src/app/system/shell-contract.d.ts'), 'utf8');
  const iface = dts.slice(dts.indexOf('export interface ShellCtx'));
  const declared = new Set();
  for (const m of iface.matchAll(/^ {2}(?:readonly\s+)?([a-zA-Z_$][\w$]*)\s*[?]?\s*:/gm)) {
    declared.add(m[1]);
  }

  const undeclared = [...actual].filter((k) => !declared.has(k)).sort();
  const unused = [...declared].filter((k) => !actual.has(k)).sort();

  assert.deepEqual(undeclared, [],
    `ctx members missing from shell-contract.d.ts: ${undeclared.join(', ')}`);
  assert.deepEqual(unused, [],
    `declared in shell-contract.d.ts but absent from ctx: ${unused.join(', ')}`);
  assert.ok(actual.size >= 25, `sanity: expected the full surface, parsed ${actual.size}`);
});

test('ctx exposes no captured mail state — functions and getters only', () => {
  /*
   * ARCHITECTURE.md §3: "everything on it is either a function or a getter —
   * never a captured value". A captured store or list is stale the moment the
   * user switches mailbox, which is why `store` is a getter. `state` is the
   * one sanctioned exception: a const object mutated in place, so the
   * reference stays valid by construction.
   */
  const shell = readFileSync(join(ROOT, 'src/app/main.js'), 'utf8');
  const at = shell.indexOf('const ctx = {');
  const body = shell.slice(at, shell.indexOf('\n};', at));
  const ALLOWED_VALUES = new Set(['state']);

  const captured = [];
  for (const m of body.matchAll(/^ {2}([a-zA-Z_$][\w$]*),$/gm)) {
    // A bare `name,` is a shorthand value. Fine when it names a FUNCTION
    // declared in the shell; a problem when it names data.
    const name = m[1];
    if (ALLOWED_VALUES.has(name)) continue;
    /* "Is it callable?" has three shapes in this shell, and an earlier
       version of this test only knew the first -- so it reported toast,
       openMessage and toggleHelp as captured state when all three are
       functions. A false positive here would be fixed by deleting the test,
       so it has to recognise every form the shell actually uses. */
    const isFn =
      new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`).test(shell)
      || new RegExp(`(?:^|\\n)(?:const|let)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:\\(|function\\b)`).test(shell)
      || new RegExp(`^import\\s[^;]*\\b${name}\\b[^;]*;`, 'm').test(shell);
    if (!isFn) captured.push(name);
  }
  assert.deepEqual(captured, [],
    `ctx must expose functions/getters, not captured values: ${captured.join(', ')}`);
});
