/**
 * The stylesheet bundle: one reader for the numbered volumes in src/styles/.
 *
 * app.css grew to 6,667 lines before it became volumes. Every consumer that
 * used to read the monolith — the preview builder, the contrast gate, and the
 * forty-odd contract tests — now reads the BUNDLE through here, so the load
 * order has exactly one definition: the sorted directory. The NN- prefix on
 * each filename is not decoration; it IS the manifest. `NN-name.css` files
 * sort into cascade order, and a test asserts app.html's <link> sequence
 * equals this order, so runtime and tooling can never disagree.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const STYLE_DIR = 'src/styles';

/** Style volume paths relative to the repo root, in cascade order. */
export function styleFiles(root = ROOT) {
  return readdirSync(join(root, STYLE_DIR))
    .filter((f) => f.endsWith('.css'))
    .sort()
    .map((f) => `${STYLE_DIR}/${f}`);
}

/**
 * The full stylesheet as one string, volumes concatenated in cascade order.
 * Joined with '' — each volume carries its own trailing newline, and the
 * split was proven byte-identical to the monolith it replaced.
 */
export function bundleStyles(root = ROOT) {
  return styleFiles(root)
    .map((p) => readFileSync(join(root, p), 'utf8'))
    .join('');
}
