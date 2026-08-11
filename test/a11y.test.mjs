/**
 * Accessibility assertions (round 45, arch A6).
 *
 * A real screen-reader pass remains TODO #10, but "attributes exist" and
 * "usable by assistive tech" had nothing between them. This runs axe-core
 * (the same engine CI's tooling uses) over the rendered shells, failing on
 * critical/serious structural violations — labels, roles, landmarks,
 * button-name — the class that regressions actually hit. Colour-contrast
 * is audited separately by tools/check-contrast.mjs and is excluded here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let JSDOM;
let axe;
try {
  ({ JSDOM } = await import('jsdom'));
  axe = (await import('axe-core')).default;
} catch {
  test('a11y (skipped: jsdom/axe not installed)', { skip: true }, () => {});
}

const RULES = {
  // Structural only; contrast and colour belong to check-contrast.mjs.
  runOnly: {
    type: 'rule',
    values: [
      'button-name', 'label', 'image-alt', 'aria-allowed-attr',
      'aria-valid-attr-value', 'aria-roles', 'duplicate-id-aria',
      'landmark-unique', 'region',
    ],
  },
};

async function violations(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { document } = dom.window;
  // axe runs in the jsdom document.
  const results = await axe.run(document.documentElement, RULES);
  return results.violations.map((v) => `${v.id}: ${v.nodes.length}`);
}

test('the app shell has no critical/serious structural a11y violations', async (t) => {
  if (!JSDOM) return t.skip();
  const html = readFileSync(new URL('../app.html', import.meta.url), 'utf8');
  const bad = await violations(html);
  assert.deepEqual(bad, [], `app.html: ${bad.join(', ')}`);
});

test('the options page has no critical/serious structural a11y violations', async (t) => {
  if (!JSDOM) return t.skip();
  const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  const bad = await violations(html);
  assert.deepEqual(bad, [], `options.html: ${bad.join(', ')}`);
});
