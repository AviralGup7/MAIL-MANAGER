/**
 * WCAG 2.1 contrast checker for the theme palettes.
 *
 * Written because the accessibility audit flagged contrast as "not yet
 * measured", and the first measurement found --fg-faint failing AA on every
 * surface in BOTH shipped themes -- it is used for dates and snippets, i.e.
 * most of the text in the message list.
 *
 * Themes are data (src/app/themes.js), so this can check every combination
 * mechanically instead of relying on someone eyeballing a colour picker.
 *
 * Run: node tools/check-contrast.mjs
 */

import { THEMES } from '../src/app/themes.js';

const AA_NORMAL = 4.5;
const AA_LARGE = 3.0;   // >=18.66px bold or >=24px
const AA_UI = 3.0;      // borders, icons, focus rings

function luminance(hex) {
  const c = hex.replace('#', '').trim();
  const n = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/** Text roles and the surfaces they are allowed to appear on. */
const SURFACES = ['bg', 'bgRaised', 'bgSunken'];
const TEXT = [
  ['fg', AA_NORMAL],
  ['fgDim', AA_NORMAL],
  ['fgFaint', AA_NORMAL], // dates and snippets are normal-size body text
  ['accent', AA_NORMAL],
  ['danger', AA_NORMAL],
];

export function auditTheme(theme) {
  const problems = [];
  for (const surf of SURFACES) {
    for (const [role, min] of TEXT) {
      const r = contrast(theme[role], theme[surf]);
      if (r < min) {
        problems.push({ theme: theme.name, role, surf, ratio: r, min });
      }
    }
  }
  // The focus ring must be visible against every surface it can land on.
  for (const surf of SURFACES) {
    const r = contrast(theme.accent, theme[surf]);
    if (r < AA_UI) {
      problems.push({ theme: theme.name, role: 'accent(focus ring)', surf, ratio: r, min: AA_UI });
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let failed = 0;
  for (const theme of THEMES) {
    const problems = auditTheme(theme);
    const label = `${theme.name} (${theme.scheme})`;
    if (problems.length === 0) {
      console.log(`✓ ${label.padEnd(28)} all combinations pass AA`);
    } else {
      failed += problems.length;
      console.log(`✗ ${label}`);
      for (const p of problems) {
        console.log(
          `    ${p.role} on ${p.surf}: ${p.ratio.toFixed(2)} (needs ${p.min})`
        );
      }
    }
  }
  console.log(failed ? `\n${failed} contrast failure(s).` : '\nAll themes pass WCAG AA.');
  process.exit(failed ? 1 : 0);
}
