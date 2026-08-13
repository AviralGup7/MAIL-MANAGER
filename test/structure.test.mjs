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
  const linked = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"]/g)]
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
