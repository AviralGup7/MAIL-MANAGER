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
  // Added after --success went from a defined-but-unused token to a real
  // status colour in compose. A semantic colour that is never checked is a
  // contrast failure waiting to ship.
  ['success', AA_NORMAL],
  ['warning', AA_NORMAL],
];

/**
 * Non-text roles: icons and indicators, which WCAG 1.4.11 holds to 3:1.
 *
 * `star` was hardcoded as `#eab308` directly in app.css, so it bypassed this
 * checker entirely and failed on NINE of eighteen theme/surface combinations
 * -- including Daylight, the default, at 1.77:1, and "High Contrast", which
 * advertises AAA. A semantic colour that is not a token is a colour nobody is
 * checking.
 */
const UI_ROLES = [['star', AA_UI]];

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
  for (const surf of SURFACES) {
    for (const [role, min] of UI_ROLES) {
      if (!theme[role]) {
        problems.push({ theme: theme.name, role, surf, ratio: 0, min });
        continue;
      }
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
