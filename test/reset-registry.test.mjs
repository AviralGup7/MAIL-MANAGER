/**
 * Reset registry contract (roadmap Phase 3, M-2).
 *
 * The registry exists so a forgotten test seam fails loudly and named,
 * instead of haunting an unrelated test three files away (the round-54
 * layers incident). Importing a stateful module registers it; this test
 * reads the registry back and fails if a known stateful module is missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Importing these modules is what registers them.
// (The features.js barrel used to register the composite 'features' seam; S2
// dissolved it into the three per-module registrations below.)
await import('../src/app/overlays/palette.js');
await import('../src/app/compose/compose.js');
await import('../src/app/compose/autocomplete.js');
await import('../src/app/academic/timetable-ui.js');
await import('../src/app/overlays/menu.js');
await import('../src/app/mail/undo-actions.js');
await import('../src/app/mail/list.js');
await import('../src/app/mail/bulk.js');
await import('../src/app/overlays/layers.js');

const { resetAll, registeredResets } = await import('../src/app/core/reset-registry.js');

test('every known stateful module self-registers', () => {
  const got = new Set(registeredResets());
  for (const name of ['palette', 'compose', 'autocomplete', 'timetable-ui', 'menu', 'undo', 'list', 'bulk', 'layers']) {
    assert.ok(got.has(name), `${name} must register its reset seam`);
  }
});

test('resetAll runs every seam and survives a broken one', () => {
  assert.doesNotThrow(() => resetAll());
});

test('the integration harnesses consume the registry, not hand captures', () => {
  /*
   * Anti-backslide pin: the harnesses must call the registry in restore().
   * A return to seven hand-maintained captures is how the round-54 class of
   * bug comes back.
   */
  /*
   * Both suites are split into parts (audit R3-01) and now share ONE
   * harness, so the pin follows the harness rather than the filenames.
   * That is strictly stronger: previously each monolith could drift from
   * the other, and there was nothing stopping a third suite from
   * hand-rolling its own captures.
   */
  const harness = readFileSync(new URL('./helpers/app-harness.mjs', import.meta.url), 'utf8');
  assert.match(harness, /resetAll: resetRegistered/, 'the harness captures resetAll');
  assert.match(harness, /resetRegistered\?\.\(\)/, 'the harness runs the registered resets');

  /*
   * The mail parts import that harness. The features parts still carry
   * their own boot() -- a different signature (labels, timetable, dead
   * worker), so merging them is a separate piece of work, not a drive-by.
   * What matters for THIS pin is that whichever harness a part uses, it
   * runs the registry rather than hand-maintained captures. So the rule is
   * checked per part against its own source or the shared harness.
   */
  const parts = readdirSync(new URL('.', import.meta.url))
    .filter((n) => /^app\.(mail|features)\.integration\.part.*\.test\.mjs$/.test(n));
  assert.ok(parts.length >= 6, `expected the split parts, found ${parts.length}`);
  for (const f of parts) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    const usesShared = /from '\.\/helpers\/app-harness\.mjs'/.test(src);
    const ownHarness = /resetRegistered\?\.\(\)/.test(src);
    assert.ok(usesShared || ownHarness,
      `${f} must run the registered resets, via the shared harness or its own`);
  }
});
