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

test('the modular FX system gates at play time and builds no audio eagerly', () => {
  const fx = read('src/app/system/cyberpunk-fx.js').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  const audio = read('src/app/system/cyberpunk-audio.js').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  assert.ok(fx.includes("theme === 'cyberpunk'"), 'controller gates on the active theme');
  assert.ok(audio.includes("d.sounds !== 'off'"), 'audio gates on the live sound preference');
  assert.ok(audio.indexOf('new AudioCtor') > audio.indexOf('function audio('),
    'the resolved AudioContext constructor exists only behind the lazy gesture gate');
  assert.ok(!/^initCyberpunkFx\(\);?\s*$/m.test(fx), 'no self-wiring; main.js owns the call');
  assert.ok(!/\.(mp3|ogg|wav|m4a)\b/i.test(fx + audio), 'sounds are synthesized, never files');
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

/* ==========================================================================
 * ROUND 5 (2026-08-16): the corner language, the data face, the brackets.
 *
 * Every one of these was found by RENDERING the theme in a browser and
 * measuring computed styles — not by reading CSS. They are pinned here
 * because each is the kind of regression that reappears silently: a new
 * component rule reaching for --r-md, a new readout set in the UI sans, a
 * bracket rule drifting onto full-width chrome again.
 * ========================================================================== */

test('a hard-edged theme collapses the radius scale, keeping the pill idiom', () => {
  const css = read('src/styles/00-tokens.css');
  /* The seam is the SCALE, not a list of selectors: ~111 rules reach for
     --r-* directly and beat the base control rule on cascade order, so
     patching selectors would always leave the next one to be found. */
  const m = css.match(/html\[style\*='--btn-radius: 0px'\]\s*\{([^}]*)\}/);
  assert.ok(m, 'the zero-radius override exists and keys off theme DATA, not a theme id');
  const body = m[1];
  for (const step of ['--r-sm', '--r-md', '--r-lg', '--r-xl']) {
    assert.match(body, new RegExp(`${step}:\\s*0px`), `${step} must flatten`);
  }
  assert.ok(!body.includes('--r-full'),
    '--r-full is the pill/dot idiom: flattening it turns every unread dot into a square');

  /* Keyed off the inline custom property applyTheme writes, so BOTH 0px
     themes get it and a future hard theme inherits it with no new CSS. */
  const zero = THEMES.filter((t) => t.btnRadius === '0px').map((t) => t.id);
  assert.deepEqual(zero.sort(), ['contrast', 'cyberpunk'],
    'if this list changes, confirm the new theme really wants flat corners');
});

test('machine readouts wear the data face; mail content never does', () => {
  const css = read('src/styles/88-cyberpunk.css');
  const gated = css.slice(css.indexOf('GATE SENTINEL'));

  assert.ok(read('src/styles/00-tokens.css').includes('--font-mono:'),
    'the data face is a token, not a fourth hardcoded copy of the stack');
  assert.ok(gated.includes('font-family: var(--font-mono)'),
    'the skin consumes the token');

  /* The pairing is the point: mono for VALUES, the UI sans for everything a
     human wrote. Setting a subject or a snippet in mono would be costume. */
  for (const humanText of ['.r-subj', '.r-snip', '#reader-body', '.r-from']) {
    const rule = new RegExp(`${humanText.replace('.', '\\.')}[^{]*\\{[^}]*--font-mono`);
    assert.ok(!rule.test(gated), `${humanText} is human prose and must not be set in mono`);
  }
});

test('corner brackets designate objects, never full-width chrome', () => {
  const css = read('src/styles/88-cyberpunk.css');
  const gated = css.slice(css.indexOf('GATE SENTINEL'));
  assert.ok(/#radar::after/.test(gated) && /#reader-idle::after/.test(gated),
    'the bracket lives on the compact rail cards');
  /* The first attempt bracketed the full-width headers: at 1440px the marks
     sat ~1200px apart and read as two stray ticks. A bracket is a
     designation; designating a whole header designates nothing. */
  for (const wide of ['#listhead::after', '#reader-head::after', '#topbar::after']) {
    assert.ok(!gated.includes(wide),
      `${wide} is full-width chrome — brackets there read as stray ticks, not a frame`);
  }
  /* Calm is a promise about NOISE, so it drops them; textures-off is a
     promise about ATMOSPHERE, so structure survives it. */
  assert.match(gated, /data-cp-intensity='calm'\] #radar::after/,
    'calm intensity removes the brackets');
});

test('no stadium survives in the hard skin', () => {
  const gated = read('src/styles/88-cyberpunk.css');
  /* #notices > * is a 348x30 BANNER, not a chip: --r-full made it the
     softest shape in the theme and clipped its amber status edge into a
     crescent, deforming the one piece of colour carrying meaning. */
  assert.match(gated, /#notices > \*\s*\{[^}]*border-radius:\s*0/,
    'the notices banner takes the skin corner language, not the pill idiom');
});
