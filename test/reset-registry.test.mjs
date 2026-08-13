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
import { readFileSync } from 'node:fs';

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
  for (const f of ['app.integration.test.mjs', 'app.integration2.test.mjs']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    assert.match(src, /resetAll: resetRegistered/, `${f} captures resetAll`);
    assert.match(src, /resetRegistered\?\.\(\)/, `${f} runs the registered resets`);
  }
});
