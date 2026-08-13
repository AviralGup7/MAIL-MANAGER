/**
 * Theme tests.
 *
 * Themes are data so they can be audited mechanically. The most valuable test
 * here is the contrast one: the first run of the checker found `--fg-faint`
 * failing WCAG AA on every surface in BOTH original themes, and that is the
 * colour used for dates and snippets — most of the text in the message list.
 * Nobody noticed by looking.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { THEMES, DEFAULT_THEME, getTheme, applyTheme } from '../src/app/system/themes.js';
import { contrast, auditTheme } from '../tools/check-contrast.mjs';

const KEYS = [
  'bg', 'bgRaised', 'bgSunken', 'fg', 'fgDim', 'fgFaint',
  'line', 'lineStrong', 'accent', 'accentFg', 'accentSoft',
  'danger', 'warning', 'success', 'glow',
];

// ------------------------------------------------------------- integrity --

test('every theme defines every colour role', () => {
  // A missing role silently falls back to the :root default, which means a
  // dark theme can inherit a light value and nobody sees it until a user does.
  for (const t of THEMES) {
    for (const k of KEYS) {
      assert.ok(t[k], `${t.id} is missing "${k}"`);
    }
    assert.ok(t.name, `${t.id} has no display name`);
    assert.ok(['light', 'dark'].includes(t.scheme), `${t.id} has an invalid scheme`);
    assert.match(t.swatch, /^#[0-9a-f]{6}$/i, `${t.id} swatch must be a hex colour`);
  }
});

test('theme ids are unique and stable', () => {
  // The id is persisted in chrome.storage, so renaming one silently resets
  // every existing user to the default.
  const ids = THEMES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate theme id');
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9-]*$/, `${id} is not a safe key`);
});

test('colour values are valid hex or rgba', () => {
  for (const t of THEMES) {
    for (const k of KEYS) {
      const v = t[k];
      assert.ok(
        /^#[0-9a-f]{3,8}$/i.test(v) || /^rgba?\(/.test(v),
        `${t.id}.${k} = "${v}" is not a colour`
      );
    }
  }
});

test('both schemes are offered', () => {
  const schemes = new Set(THEMES.map((t) => t.scheme));
  assert.ok(schemes.has('light') && schemes.has('dark'), 'need both light and dark');
});

test('the default theme exists', () => {
  assert.ok(THEMES.some((t) => t.id === DEFAULT_THEME));
});

// -------------------------------------------------------------- contrast --

test('WCAG AA: every text role passes on every surface, in every theme', () => {
  // The regression guard for the actual bug. Run `npm run contrast` for a
  // readable report.
  const failures = THEMES.flatMap(auditTheme);
  assert.deepEqual(
    failures.map((f) => `${f.theme}: ${f.role} on ${f.surf} = ${f.ratio.toFixed(2)}`),
    []
  );
});

test('the specific colour that was broken now passes', () => {
  // fgFaint on bgSunken was 2.72:1 in the original light theme. Body text
  // needs 4.5:1.
  for (const t of THEMES) {
    for (const surf of ['bg', 'bgRaised', 'bgSunken']) {
      const r = contrast(t.fgFaint, t[surf]);
      assert.ok(r >= 4.5, `${t.id}: fgFaint on ${surf} is ${r.toFixed(2)}, needs 4.5`);
    }
  }
});

test('accent text is legible on its own soft background', () => {
  // The selected sidebar row is accent-on-accentSoft; if that pair is weak the
  // current category becomes the hardest thing to read.
  for (const t of THEMES) {
    const r = contrast(t.accent, t.accentSoft);
    assert.ok(r >= 4.5, `${t.id}: accent on accentSoft is ${r.toFixed(2)}`);
  }
});

test('accentFg is legible on accent — that pair is every primary button', () => {
  for (const t of THEMES) {
    const r = contrast(t.accentFg, t.accent);
    assert.ok(r >= 4.5, `${t.id}: accentFg on accent is ${r.toFixed(2)}`);
  }
});

test('borders are visible against their surfaces', () => {
  // A 1px line at 1.2:1 is decorative, not structural. UI components need 3:1.
  for (const t of THEMES) {
    const r = contrast(t.lineStrong, t.bg);
    assert.ok(r >= 2.4, `${t.id}: lineStrong on bg is only ${r.toFixed(2)}`);
  }
});

test('High Contrast actually reaches AAA', () => {
  // It exists for low vision and direct sunlight; AA would not justify it.
  const hc = getTheme('contrast');
  assert.equal(contrast(hc.fg, hc.bg) >= 7, true, 'body text must be AAA');
  assert.ok(contrast(hc.fgDim, hc.bg) >= 7, 'secondary text must be AAA too');
});

test('dark themes are actually dark, light themes actually light', () => {
  for (const t of THEMES) {
    const white = contrast(t.bg, '#ffffff');
    if (t.scheme === 'dark') assert.ok(white > 3, `${t.id} claims dark but bg is pale`);
    else assert.ok(white < 1.6, `${t.id} claims light but bg is dim`);
  }
});

// ----------------------------------------------------------------- apply --

/** Minimal stand-in for documentElement. */
function fakeRoot() {
  const props = new Map();
  return {
    dataset: {},
    style: {
      setProperty: (k, v) => props.set(k, v),
      getPropertyValue: (k) => props.get(k) || '',
    },
    props,
  };
}

test('applyTheme writes every custom property', () => {
  const root = fakeRoot();
  applyTheme('midnight', root);
  assert.equal(root.props.get('--bg'), getTheme('midnight').bg);
  assert.equal(root.props.get('--fg-faint'), getTheme('midnight').fgFaint);
  assert.equal(root.props.get('--line-strong'), getTheme('midnight').lineStrong);
  assert.equal(root.props.size >= KEYS.length, true);
});

test('applyTheme sets the scheme, which drives native controls', () => {
  const root = fakeRoot();
  applyTheme('pilani', root);
  assert.equal(root.dataset.theme, 'pilani');
  assert.equal(root.dataset.scheme, 'dark');
  assert.equal(root.props.get('color-scheme'), 'dark');
});

test('an unknown theme id falls back rather than rendering unstyled', () => {
  // Covers the old binary 'light'/'dark' values stored before the picker
  // existed, and any id from a future version after a downgrade.
  for (const bad of ['light', 'dark', 'nonsense', '', null, undefined]) {
    const root = fakeRoot();
    const applied = applyTheme(bad, root);
    assert.equal(applied.id, DEFAULT_THEME, `"${bad}" should fall back`);
    assert.ok(root.props.get('--bg'), 'must still write a full palette');
  }
});

test('applyTheme returns the theme it applied', () => {
  assert.equal(applyTheme('nord', fakeRoot()).id, 'nord');
});
