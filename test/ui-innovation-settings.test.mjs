import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('settings exposes modern/legacy and cyberpunk intensity choices', () => {
  const src = read('src/app/overlays/settings-panel.js');
  assert.match(src, /key: 'uiProfile'/);
  assert.match(src, /Modern — information-rich default/);
  assert.match(src, /Legacy — previous chrome and layout/);
  assert.match(src, /key: 'cyberpunkIntensity'/);
  assert.match(src, /key: 'cyberpunkAudioProfile'/);
  for (const value of ['calm', 'balanced', 'maximum']) {
    assert.ok(src.includes(`['${value}'`), `${value} intensity is offered`);
  }
});

test('interface intelligence has one surfaced control per feature', () => {
  const src = read('src/app/overlays/settings-panel.js');
  for (const key of [
    'showTelemetry', 'showProvenance', 'readerDossier', 'threadTimeline',
    'queryConsole', 'timetableTerminal', 'operationCenter', 'calmContent',
  ]) assert.match(src, new RegExp(`key: '${key}'`));
});

test('theme tiles include a live shell preview built from theme data', () => {
  const src = read('src/app/overlays/settings-panel.js');
  assert.match(src, /set-theme-preview/);
  for (const role of ['bgRaised', 'bgSunken', 'lineStrong', 'accent']) {
    assert.match(src, new RegExp(`t\.${role}`));
  }
  assert.match(src, /aria-hidden/);
});

test('new visual preferences reapply without a page reload', () => {
  const src = read('src/app/main.js');
  for (const key of ['uiProfile', 'showTelemetry', 'readerDossier', 'queryConsole', 'calmContent']) {
    assert.match(src, new RegExp(`'${key}'`));
  }
  assert.match(src, /includes\(key\)\) applyVisualPrefs\(\)/);
});

test('new stylesheet is loaded between cyberpunk and motion authority', () => {
  const html = read('app.html');
  const cp = html.indexOf('88-cyberpunk.css');
  const ui = html.indexOf('89-ui-innovation.css');
  const motion = html.indexOf('90-motion-system.css');
  assert.ok(cp < ui && ui < motion);
});
