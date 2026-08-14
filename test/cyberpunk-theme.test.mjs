/**
 * The Cyberpunk theme (2026-08-14): a full skin — palette, chamfered
 * controls, scanline texture, glitch entrances, synthesized UI audio — that
 * must leave NO residue when another theme is active. The brief's words:
 * "when I switch back it's like nothing changed."
 *
 * These pins make that isolation structural rather than remembered. The
 * palette itself is audited by themes.test.mjs and npm run contrast, like
 * every other theme; what is special here is the GATE, and that is what
 * this file defends.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { THEMES, getTheme } from '../src/app/system/themes.js';
import { styleFiles, bundleStyles } from '../tools/css-bundle.mjs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const GATE = "[data-theme='cyberpunk']";

test('cyberpunk is a first-class theme with every colour role', () => {
  const t = getTheme('cyberpunk');
  assert.notEqual(t.id, 'daylight', 'getTheme fell back to the default — the id is broken');
  assert.equal(t.scheme, 'dark');
  for (const key of ['bg', 'bgRaised', 'bgSunken', 'fg', 'fgDim', 'fgFaint', 'line', 'lineStrong',
    'accent', 'accentFg', 'accentSoft', 'danger', 'warning', 'success', 'star', 'glow', 'swatch']) {
    assert.ok(t[key], `cyberpunk is missing "${key}"`);
  }
  assert.ok(THEMES.every((x) => x.id !== 'cyberpunk' || x.name === 'Cyberpunk'), 'the picker name');
});

test('every rule in the skin volume carries the theme gate', () => {
  const css = read('src/styles/88-cyberpunk.css');
  const sentinel = 'GATE SENTINEL';
  assert.ok(css.includes(sentinel), 'the sentinel separates keyframes from gated rules');
  const gated = css.slice(css.indexOf(sentinel)).replace(/\/\*[\s\S]*?\*\//g, ' ');
  /* Selectors stay one-per-line by volume law (header rule 4), so a rule
     opener is exactly a line that ends in "{" — and each must carry the
     gate or the skin bleeds into the other six themes. */
  const openers = gated.split('\n').filter((l) => /\{\s*$/.test(l));
  assert.ok(openers.length >= 15, 'the skin should actually touch a lot of the app');
  for (const line of openers) {
    assert.ok(line.includes(GATE) || line.startsWith('html.cp-enter'),
      `ungated rule in the cyberpunk volume: ${line.trim()}`);
  }
});

test('skin motion stays finite and skin keyframes stay namespaced', () => {
  const css = read('src/styles/88-cyberpunk.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(!/\binfinite\b/.test(css),
    'the idle-animation law: nothing in the app loops forever but the three loading gates');
  for (const [, name] of css.matchAll(/@keyframes\s+([\w-]+)/g)) {
    assert.ok(name.startsWith('cp-'), `@keyframes ${name} is not namespaced to the skin`);
  }
});

test('the fx module gates on the theme and builds nothing eagerly', () => {
  const fx = read('src/app/system/cyberpunk-fx.js').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  assert.ok(fx.includes("dataset.theme === 'cyberpunk'"), 'play-time gate on the theme attribute');
  assert.ok(fx.indexOf('AudioContext') > fx.indexOf('function audio()'),
    'AudioContext may only be reached through the lazy constructor — creating one at import trips the console-clean smoke gate');
  assert.ok(!/^initCyberpunkFx\(\);?\s*$/m.test(fx), 'no self-wiring; main.js owns the call');
  /* No audio ASSETS anywhere: the kit is oscillator arithmetic by policy, so
     the repo ships no sampled or downloaded game audio. */
  assert.ok(!/\.(mp3|ogg|wav|m4a)\b/i.test(fx), 'sounds are synthesized, never files');
});

test('one owner: only the skin volume and the fx module speak cyberpunk', () => {
  const files = styleFiles().filter((f) => !f.includes('88-cyberpunk'));
  /* Comments first: the definer volumes NAME the gate when recording why the
     skin's tokens live there, and a comment that names the incident is
     decision-record, not a rule (the precedent the options-style pin set). */
  const css = files.map((f) => read(f)).join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(!css.includes("data-theme='cyberpunk'"),
    'another style volume carries cyberpunk rules — the skin has exactly one home');
  /* And the volume is actually shipped: in the directory listing (which is
     the preview bundle's manifest) and linked from app.html in cascade order. */
  assert.ok(styleFiles().includes('src/styles/88-cyberpunk.css'));
  assert.ok(read('app.html').includes('src/styles/88-cyberpunk.css'));
  assert.ok(bundleStyles().includes('GATE SENTINEL'), 'the bundle carries the skin');
});
