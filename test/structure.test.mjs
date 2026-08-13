/**
 * Structure pins — the floor-plan guards (docs/STRUCTURE.md).
 *
 * The CSS half landed first: app.css (6,667 lines) became src/styles/ as 26
 * numbered volumes, split at its own section banners, byte-identical to the
 * monolith at split time. These pins keep the split honest as the stylesheet
 * grows toward the 15–25k lines this project is headed for — the whole point
 * of the exercise was that 25,000 lines stay maintainable ONLY if the rules
 * that keep them findable are enforced by tests rather than by memory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundle, styleFiles } from './helpers/css.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('every style volume is NN-name.css and the directory is in cascade order', () => {
  /* The NN- prefix is the manifest. A file that does not carry it could sort
   * anywhere — including after 99-reduced-motion, where it would silently
   * outrank the guard that exists to be last. */
  const raw = readdirSync(join(ROOT, 'src/styles'));
  for (const f of raw) {
    assert.match(f, /^\d{2}-[a-z0-9-]+\.css$/, `${f}: volumes are NN-name.css`);
  }
  assert.deepEqual(raw, [...raw].sort(), 'readdir order must already be cascade order');
});

test('app.html links exactly the discipline volumes, in cascade order', () => {
  /* Runtime and tooling must never disagree about order: the browser sees
   * the <link> run, everything else reads the sorted directory. */
  const html = read('app.html');
  const linked = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)" *\/>/g)]
    .map((m) => m[1]);
  assert.deepEqual(
    linked, styleFiles(),
    'app.html <link> run must equal the sorted src/styles listing — add a volume = add a link'
  );
});

test('token definitions live only in the tokens volumes', () => {
  /* The census pin (package.test) guarantees every var() has a definition;
   * this one guarantees definitions have an ADDRESS. Two defining volumes
   * exist: 00-tokens (the scale) and 86-v3-skin (the V3-era remap, which
   * re-states a subset in source order — that is the remap's mechanism).
   * A third defining site would be the old drift coming back. */
  const DEFINERS = new Set(['src/styles/00-tokens.css', 'src/styles/86-v3-skin.css']);
  for (const file of styleFiles()) {
    if (DEFINERS.has(file)) continue;
    const defs = read(file).match(/^ {2}--[a-z0-9-]+\s*:/gm) || [];
    assert.deepEqual(defs, [], `${file} defines tokens: ${defs.slice(0, 3).join(', ')}`);
  }
});

test('99-reduced-motion.css is last and holds the final rule of the bundle', () => {
  /* Same doctrine as the monolith era, one level up: same specificity means
   * source order decides, so the guard must own the last word — last file in
   * the order AND last block in the bundle. */
  const files = styleFiles();
  assert.equal(files[files.length - 1], 'src/styles/99-reduced-motion.css');
  const bundle = readBundle();
  const lastGuard = bundle.lastIndexOf('@media (prefers-reduced-motion');
  assert.ok(lastGuard !== -1, 'the guard must exist');
  const tailFileLength = read('src/styles/99-reduced-motion.css').length;
  assert.ok(
    lastGuard >= bundle.length - tailFileLength,
    'the final reduced-motion block must live in the last volume'
  );
});

test('every volume is self-contained at a rule boundary', () => {
  /* Slices are taken at section banners, so no volume may open or close
   * mid-rule. The cheap structural check (brace balance) is what once
   * caught the orphaned "}" that silently killed the appearance layer. */
  for (const file of styleFiles()) {
    const css = read(file);
    const open = (css.match(/{/g) || []).length;
    const close = (css.match(/}/g) || []).length;
    assert.equal(open, close, `${file}: ${open} "{" vs ${close} "}"`);
  }
});

/* ========================================================================== *
 * THE JS FLOOR PLAN (structure S2)
 *
 * src/app/ held 73 modules in one directory — fine at 37k lines, fatal at
 * the 100k this project becomes. They now live in folders by product
 * surface, and the cross-folder edges below are a CLOSED SET: a new edge
 * fails this test until it earns a one-line justification here. That is the
 * whole trick: growth stays findable because adding to the map is a
 * deliberate act, never a side effect.
 * ========================================================================== */

/** The folders src/app/ may hold, in reading order. */
const APP_FOLDERS = [
  'core',      // shared vocabulary; imports nothing app-side
  'motion',    // every animation primitive; imports nothing app-side
  'system',    // settings/persistence/fallback services
  'overlays',  // the layer stack: menus, dialogs, toasts, palette
  'mail',      // the inbox domain: store, list, reader, rows, undo
  'search',    // the query language and its UIs
  'compose',   // writing mail: compose, contacts autocomplete, drafts, outbox
  'academic',  // the BITS academic suite: timetable, deadlines, radar, notices
  'workspace', // shell chrome: sidebar, the context rails
];

/**
 * Which folders a folder may import from. Each edge carries its reason, and
 * each reason was read from the code, not guessed — the migration printed
 * the true census and this table is that census, made binding.
 */
const ALLOWED_EDGES = {
  core: new Set(),
  motion: new Set(),
  system: new Set([
    'core',    // deep-links registers reset seams; direct parses addresses
    'compose', // fallback drives the outbox pump DYNAMICALLY, and only when the worker is dead
  ]),
  overlays: new Set([
    'core',    // toast's icons, layers' reset seam, settings-panel's glyph + seam
    'motion',  // menu pop morphs; palette rides the camera
    'system',  // snooze persistence; palette reads settings; the settings panel IS the schema's UI
    'mail',    // palette runs the undo verbs; category-menu edits rules
    'compose', // the palette's "new mail" verb opens compose
    'academic',// the snooze menu reads deadlines to propose a wake day
  ]),
  mail: new Set([
    'core',       // dom/icons/display/selectors/sanitize primitives
    'motion',     // bulk dust, the reader identity morph
    'system',     // settings (density, threading); snooze storage
    'overlays',   // toasts after actions; row actions open menus
    'search',     // the list renders what the query language selects
    'academic',   // rows surface deadlines and courses beside the mail
    'workspace',  // the list hands its fragment to the rails for lane headers
  ]),
  search: new Set([
    'core',     // contacts parsing, icons
    'system',   // saved views persist through view-store
    'overlays', // suggestions hand power verbs to the palette
    'academic', // the query language knows has:deadline
  ]),
  compose: new Set([
    'core',     // recipient validation lives in contacts
    'motion',   // send burst, pop-from morph
    'system',   // settings (signature, undo window)
    'overlays', // confirm dialogs, layer closes
    'search',   // reply quoting builds on the query module
  ]),
  academic: new Set([
    'core',     // icons/reset seams
    'motion',   // the timetable camera push
    'system',   // lanes' "addressed to me" needs identity (direct)
    'overlays', // the timetable's dialogs stack on the layer primitive
    'mail',     // academic mutations offer undo through undo-actions
    'search',   // the rule engine's conditions ARE the query language
  ]),
  workspace: new Set([
    'core',     // dom/icons/display
    'motion',   // the mailbox pill spring
    'system',   // settings, snooze storage
    'overlays', // the "more" menu; rails toast on wake
    'mail',     // the sidebar reads mailboxes, rules, and row counts from list
    'compose',  // the rails drive the outbox queue
    'academic', // the rails render deadline/activity/lane state
  ]),
};

test('src/app root holds only main.js, and every module joins a folder', () => {
  const entries = readdirSync(join(ROOT, 'src/app'), { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  assert.deepEqual(files, ['main.js'], 'the root holds the shell and nothing else');
  const folders = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(folders, [...APP_FOLDERS].sort());
});

/** All app modules: [rootRelative, folder] pairs ('(shell)' for main.js). */
function appModules() {
  const out = [['src/app/main.js', '(shell)']];
  for (const folder of APP_FOLDERS) {
    for (const f of readdirSync(join(ROOT, 'src/app', folder))) {
      if (f.endsWith('.js')) out.push([`src/app/${folder}/${f}`, folder]);
    }
  }
  return out;
}

/** Comment-aware import extraction: comments (incl. JSDoc `import()` types) are not edges. */
function codeOf(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/** Every static `from '...'` and dynamic `import('...')`, resolved. */
function importTargets(file) {
  const text = codeOf(read(file));
  const out = [];
  for (const m of text.matchAll(/(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
    out.push(join(dirname(join(ROOT, file)), m[1]).slice(ROOT.length + 1).replace(/\\/g, '/'));
  }
  return out;
}

test('cross-folder imports are the registered set — a new edge must justify itself', () => {
  const violations = [];
  for (const [file, folder] of appModules()) {
    for (const target of importTargets(file)) {
      const parts = target.split('/');
      if (parts[0] !== 'src' || parts[1] !== 'app') continue;  // platform/shared/classify: below us
      if (parts.length === 3) { violations.push(`${file} imports the shell (${target})`); continue; }
      if (parts[2] === folder) continue;                       // intra-folder
      if (folder === '(shell)') continue;                      // the shell wires everything
      if (!ALLOWED_EDGES[folder].has(parts[2])) {
        violations.push(`${file} (${folder}) imports ${target} (${parts[2]})`);
      }
    }
  }
  assert.deepEqual(
    violations, [],
    'unregistered cross-folder edges — add the edge AND its reason to ALLOWED_EDGES, or move the code'
  );
});

test('core and motion import nothing app-side', () => {
  /* motion is the portable physics kit — liftable wholesale, which only
   * holds while it has zero outward edges. core is everyone's vocabulary,
   * which holds only while it points at no one. */
  for (const leaf of ['core', 'motion']) {
    for (const [file, folder] of appModules()) {
      if (folder !== leaf) continue;
      for (const target of importTargets(file)) {
        if (target.startsWith(`src/app/${leaf}/`)) continue; // intra-leaf is the leaf
        if (target.startsWith('src/app/')) {
          assert.fail(`${file} reaches into the app (${target}); ${leaf} stays a leaf`);
        }
      }
    }
  }
});

test('the module graph stays acyclic at file level', () => {
  /* The folder table tolerates bidirectional folder pairs (mail<->academic
   * is real: rows show deadlines, the timetable offers undo). What may never
   * happen is a FILE cycle — those are the import-time deadlock the old
   * flatland could not see. All 90+ modules, DFS, back-edge = fail. */
  const graph = new Map();
  for (const [file] of appModules()) {
    graph.set(file, importTargets(file).filter((t) => t.startsWith('src/app/') && t.endsWith('.js')));
  }
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map([...graph.keys()].map((k) => [k, WHITE]));
  const cycle = [];
  const visit = (node, stack) => {
    colour.set(node, GREY);
    for (const next of graph.get(node) || []) {
      if (!colour.has(next)) continue; // not an app module
      if (colour.get(next) === GREY) { cycle.push([...stack, node, next].join(' -> ')); return; }
      if (colour.get(next) === WHITE) visit(next, [...stack, node]);
    }
    colour.set(node, BLACK);
  };
  for (const [file, c] of colour) if (c === WHITE && !cycle.length) visit(file, []);
  assert.deepEqual(cycle, [], 'import cycle detected');
});
