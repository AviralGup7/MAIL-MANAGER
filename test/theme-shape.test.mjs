/**
 * THE SHAPE AXIS (2026-08-14): button GEOMETRY is theme data.
 *
 * Until today every theme recoloured the same 10px-round buttons. The
 * request: "button shape shall pass through themes — hard edges for
 * cyberpunk, and buttons change as the theme changes." So themes.js now
 * carries btnRadius + btnCut per theme, applyTheme writes BOTH tokens on
 * every switch, and 10-shell.css owns the single geometry. These pins keep
 * the axis honest: values stay on the radius scale, switching can never
 * leak one theme's shape into another, and the variety is real.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { THEMES, getTheme } from '../src/app/system/themes.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

test('every theme declares button shape, on the closed scales', () => {
  for (const t of THEMES) {
    assert.match(t.btnRadius || '', /^(0px|var\(--r-(sm|md|lg|xl|full)\))$/,
      `${t.id}.btnRadius must be 0 or a radius token — the scale stays closed`);
    assert.match(t.btnCut || '', /^(\d+(\.\d+)?px|var\(--cp-cut\))$/,
      `${t.id}.btnCut is a pixel depth or the one chamfer knob`);
  }
});

test('applyTheme writes BOTH shape tokens on every switch — no stale geometry', () => {
  const src = read('src/app/system/themes.js');
  /* The residue bug this guards: when a colour key is absent, skipping
     setProperty is fine (the :root fallback holds); when a SHAPE key is
     absent, skipping keeps the PREVIOUS theme's live token — cyberpunk's
     chamfer would follow you into Daylight. The defaults map is the fix,
     and it is pinned, not remembered. */
  assert.match(src, /const SHAPE_DEF = \{ btnRadius: 'var\(--r-md\)', btnCut: '0px' \}/);
  assert.match(src, /else if \(key in SHAPE_DEF\) style\.setProperty\(cssVar, SHAPE_DEF\[key\]\)/,
    'an absent shape key writes the default, never silence');
});

test('the base control rule consumes the tokens — one geometry, seven opinions', () => {
  const shell = read('src/styles/10-shell.css');
  assert.match(shell, /border-radius: var\(--btn-radius\)/);
  assert.match(shell, /clip-path: polygon\(/, 'the symmetric chamfer polygon lives exactly once');
  /* And the skin volume no longer dares to re-cut buttons: */
  const skin = read('src/styles/88-cyberpunk.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(!/html\[data-theme='cyberpunk'\] button \{[^}]*clip-path/s.test(skin),
    'the skin shapes buttons through theme data, not its own clip-path');
});

test('shape variety is real, and cyberpunk is the hard turn', () => {
  const shapes = new Set(THEMES.map((t) => `${t.btnRadius}|${t.btnCut}`));
  assert.ok(shapes.size >= 4,
    'switching themes must visibly change the controls — near-duplicates defeat the axis');
  const cp = getTheme('cyberpunk');
  assert.equal(cp.btnRadius, '0px', 'no rounding anywhere in the skin');
  assert.notEqual(cp.btnCut, '0px', 'the chop is the skin’s silhouette');
});
