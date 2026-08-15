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

/* ==========================================================================
 * OPENED STATES (under-engineering audit P2)
 *
 * The two tests above audit the EMPTY SHELL — the document before any dialog
 * opens, any menu roves, or any toast announces. The audit's finding was that
 * axe appeared in exactly one file and never saw a single one of the ten
 * overlay modules in its open state, which is precisely where the dynamic
 * semantics (roles, accessible names, checked state, live regions) either
 * exist or do not.
 *
 * These boot the real overlay modules into a real document and run the SAME
 * axe rule set against what the user actually faces.
 * ========================================================================== */

/** Run axe over a live document rather than an HTML string. */
async function violationsIn(document) {
  const results = await axe.run(document.documentElement, RULES);
  return results.violations.map((v) => `${v.id}: ${v.nodes.length}`);
}

/** A document with the overlay modules freshly imported against it. */
async function withOverlays(fn) {
  /*
   * The fixture mirrors app.html's real structure: a landmark, and
   * #overlay-root INSIDE it. menu.js mounts to #overlay-root when present and
   * falls back to document.body, so a bare test body put the menu outside
   * every landmark and tripped the `region` rule for a reason that does not
   * exist in the product. Reproducing the real mount point keeps this test
   * about the OVERLAY's semantics rather than re-litigating the shell's,
   * which the two tests above already cover.
   */
  const dom = new JSDOM(
    '<!doctype html><html lang="en"><body><main id="app-main">'
    + '<div id="reader"></div><div id="overlay-root"></div></main></body></html>',
    { pretendToBeVisual: true }
  );
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const bust = `?t=${Math.random()}`;
  const mods = {
    dialog: await import(`../src/app/overlays/dialog.js${bust}`),
    menu: await import(`../src/app/overlays/menu.js${bust}`),
    cat: await import(`../src/app/overlays/category-menu.js${bust}`),
    snooze: await import(`../src/app/overlays/snooze-menu.js${bust}`),
    toast: await import(`../src/app/overlays/toast.js${bust}`),
  };
  try {
    return await fn(mods, dom.window.document);
  } finally {
    try { mods.menu.closeMenu(); } catch { /* already closed */ }
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    dom.window.close();
  }
}

test('an OPEN prompt dialog is accessible', async (t) => {
  if (!JSDOM) return t.skip();
  await withOverlays(async ({ dialog }, document) => {
    const p = dialog.promptDialog({ title: 'Save this view', label: 'Name it' });
    const bad = await violationsIn(document);
    assert.deepEqual(bad, [], `open promptDialog: ${bad.join(', ')}`);
    document.querySelectorAll('.prompt-box button')[1].click();
    await p;
  });
});

test('an OPEN destructive confirm is accessible', async (t) => {
  if (!JSDOM) return t.skip();
  await withOverlays(async ({ dialog }, document) => {
    const p = dialog.confirmDialog({
      title: 'Delete for ever?', body: 'This cannot be undone.',
      confirmLabel: 'Delete', danger: true,
    });
    const bad = await violationsIn(document);
    assert.deepEqual(bad, [], `open confirmDialog: ${bad.join(', ')}`);
    document.querySelector('.prompt-box button:not(.danger)').click();
    await p;
  });
});

test('an OPEN category menu is accessible, checked state and all', async (t) => {
  if (!JSDOM) return t.skip();
  await withOverlays(async ({ cat }, document) => {
    cat.wireCategoryMenu({
      getRules: () => ({ muted: ['augsd'], autoArchive: [], corrections: {} }),
      setRules: () => {}, saveRules: async () => {},
      renderList: () => {}, renderSidebar: () => {}, toast: () => {},
    });
    cat.openCategoryMenu('augsd', document.getElementById('app-main'));
    const bad = await violationsIn(document);
    assert.deepEqual(bad, [], `open category menu: ${bad.join(', ')}`);
  });
});

test('an OPEN snooze menu is accessible', async (t) => {
  if (!JSDOM) return t.skip();
  await withOverlays(async ({ snooze }, document) => {
    snooze.wireSnoozeMenu({
      getMessage: (id) => ({ id, from: 'a@b.c', subject: 'Lab report', snippet: '' }),
      snoozeMessage: () => {},
    });
    snooze.openSnoozeMenu('m1', document.getElementById('reader'));
    const bad = await violationsIn(document);
    assert.deepEqual(bad, [], `open snooze menu: ${bad.join(', ')}`);
  });
});
