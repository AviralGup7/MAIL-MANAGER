import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('modern UI profile is the default and legacy remains available', async () => {
  globalThis.chrome = { storage: { local: { get: async () => ({}) } } };
  const { SCHEMA } = await import(`../src/app/system/settings.js?t=${Math.random()}`);
  assert.equal(SCHEMA.uiProfile.def, 'modern');
  assert.deepEqual(SCHEMA.uiProfile.values, ['modern', 'legacy']);
});

test('every additive interface layer has an independent setting', async () => {
  globalThis.chrome = { storage: { local: { get: async () => ({}) } } };
  const { SCHEMA } = await import(`../src/app/system/settings.js?t=${Math.random()}`);
  for (const key of [
    'showTelemetry', 'showProvenance', 'readerDossier', 'threadTimeline',
    'queryConsole', 'timetableTerminal', 'operationCenter', 'calmContent',
  ]) assert.equal(SCHEMA[key]?.def, true, `${key} is a real default-on feature`);
});

test('root attributes publish every interface preference', () => {
  const src = read('src/app/system/root-attrs.js');
  for (const attr of [
    'data-ui-profile', 'data-cp-intensity', 'data-telemetry', 'data-provenance',
    'data-reader-dossier', 'data-thread-timeline', 'data-query-console',
    'data-tt-terminal', 'data-operation-center', 'data-calm-content',
  ]) assert.match(src, new RegExp(attr));
});

test('system strip is semantic, bounded and contains only real state slots', () => {
  const html = read('app.html');
  assert.match(html, /<footer id="system-strip" aria-label="System status">/);
  for (const id of ['sys-account', 'sys-mailbox', 'sys-records', 'sys-sync', 'sys-operations']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  const module = read('src/app/workspace/system-telemetry.js');
  assert.doesNotMatch(module, /Math\.random|setInterval|setTimeout/);
  assert.match(module, /store\?\.size/);
  assert.match(module, /state\.lastSync/);
});

test('legacy and telemetry-off settings remove additive chrome', () => {
  const css = read('src/styles/89-ui-innovation.css');
  assert.match(css, /data-ui-profile='legacy'[^}]*#system-strip/s);
  assert.match(css, /data-telemetry='off'[^}]*#system-strip/s);
});
