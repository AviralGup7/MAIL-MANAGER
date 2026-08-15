/**
 * SETTINGS OUTRANK THE THEME (2026-08-14).
 *
 * Themes gained real power this cycle — shape, texture, sound. The request
 * was explicit that settings hold the higher authority: a theme may ship
 * atmosphere, it may not insist on it. Two schema keys (textures, sounds),
 * two root attributes, two consumers. These pins keep the chain whole:
 * schema → panel → root stamp → consumer, because a setting whose guard is
 * missing is exactly the "schema entry as promise" failure this codebase
 * removes on sight.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

test('schema promises both axes, ON by default', () => {
  const src = read('src/app/system/settings.js');
  for (const key of ['textures', 'sounds']) {
    assert.match(src, new RegExp(`${key}: \\{ type: 'bool', def: true \\}`),
      `${key} defaults on — a theme's author meant the atmosphere`);
  }
});

test('the panel offers both under Appearance', () => {
  const panel = read('src/app/overlays/settings-panel.js');
  const appearance = panel.indexOf("id: 'appearance'");
  const reading = panel.indexOf("id: 'reading'");
  for (const key of ['textures', 'sounds']) {
    const at = panel.indexOf(`key: '${key}'`);
    assert.ok(at > appearance && at < reading, `${key} rides in the Appearance section`);
  }
});

test('the one-attribute promise covers both, for every theme', () => {
  const attrs = read('src/app/system/root-attrs.js');
  assert.match(attrs, /setAttribute\('data-textures',/);
  assert.match(attrs, /setAttribute\('data-sounds',/);
  /* Stamped unconditionally — the DOM must say "off", not merely lack "on". */
});

test('each sense has exactly one consumer, attribute-fed', () => {
  const skin = read('src/styles/88-cyberpunk.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(skin.includes("[data-textures='off']"),
    'the texture guard lives in the skin volume, next to what it guards');
  const fx = read('src/app/system/cyberpunk-fx.js').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  const audio = read('src/app/system/cyberpunk-audio.js').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  assert.ok(audio.includes("d.sounds !== 'off'"), 'the synthesizer reads the attribute at play time');
  assert.ok(!/settings\.js/.test(fx + audio), 'FX modules consume root attributes, never the settings store');
  assert.ok(fx.includes("d.theme === 'cyberpunk'"), 'the controller still gates on the theme');
});
