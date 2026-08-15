import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('onboarding names both Gmail scopes and shipped sending', () => {
  const app = read('app.html');
  const options = read('options.html');
  for (const text of [app, options]) {
    assert.match(text, /gmail\.modify/);
    assert.match(text, /gmail\.send/);
  }
  assert.doesNotMatch(options, /cannot send mail/);
});

test('background notification controls are visibly unavailable while sweep is disabled', async () => {
  const options = new JSDOM(read('options.html')).window.document;
  assert.equal(options.getElementById('bgNotify').disabled, true);
  const panel = read('src/app/overlays/settings-panel.js');
  assert.match(panel, /key: 'bgNotify'[^\n]+disabled: true/);
  const schema = read('src/app/system/settings.js');
  assert.match(schema, /bgNotify: \{ type: 'bool', def: false \}/);
});

test('options fieldsets are siblings, not nested under OAuth setup', () => {
  const doc = new JSDOM(read('options.html')).window.document;
  const fields = [...doc.querySelectorAll('main > fieldset')];
  assert.equal(fields.length, doc.querySelectorAll('fieldset').length);
  assert.ok(fields.length >= 8);
});

test('telemetry distinguishes signed out from offline', () => {
  const src = read('src/app/workspace/system-telemetry.js');
  assert.match(src, /return 'SIGNED OUT'/);
  assert.doesNotMatch(src, /!state\?\.signedIn\) return 'OFFLINE'/);
});
