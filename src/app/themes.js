/**
 * Themes.
 *
 * DATA, NOT CSS
 * -------------
 * Each theme is an object, not a hand-written CSS block. That is what lets
 * `tools/check-contrast.mjs` walk every text/surface pair in every theme and
 * fail the build on a WCAG violation. Hand-written blocks cannot be audited
 * mechanically, and the first audit of the two original palettes found
 * `--fg-faint` failing AA on every surface in BOTH of them — it is the colour
 * used for dates and snippets, which is most of the text in the message list.
 *
 * Every value below has been through the checker. `npm run contrast`.
 *
 * WHY THESE SIX
 * Not six variations on blue. Each one exists for a situation:
 *   - Daylight / Midnight  the neutral defaults, light and dark
 *   - Pilani Dusk          BITS colours, warm — the reason this extension exists
 *   - Solarised            the classic low-eyestrain palette, for long sessions
 *   - Nord                 cool and desaturated, the most "calm" of the darks
 *   - High Contrast        not a style choice: pure black on white, AAA
 *
 * ADDING ONE
 * Add an object here and it appears in the picker automatically. Run
 * `npm run contrast` before committing; CI runs it too.
 */

/**
 * @typedef {Object} Theme
 * @property {string} id       stable key, persisted in storage
 * @property {string} name     shown in the picker
 * @property {'light'|'dark'} scheme  drives `color-scheme` and the body iframe
 * @property {string} swatch   the dot in the picker
 */

export const THEMES = [
  {
    id: 'daylight',
    name: 'Daylight',
    scheme: 'light',
    swatch: '#1a4fd6',
    bg: '#f4f6f9',
    bgRaised: '#ffffff',
    bgSunken: '#e9edf3',
    fg: '#12151b',
    fgDim: '#4a5260',
    fgFaint: '#616978', // was #8a91a0 — failed AA at 2.95:1
    line: '#dbe1ea',
    lineStrong: '#94a0b3',
    accent: '#1a4fd6',
    accentFg: '#ffffff',
    accentSoft: '#e4ebfb',
    danger: '#b3261e',
    warning: '#8a5a00',
    success: '#0f6b45',
    glow: 'rgba(26, 79, 214, 0.16)',
  },
  {
    id: 'midnight',
    name: 'Midnight',
    scheme: 'dark',
    swatch: '#7aa2ff',
    bg: '#0e1014',
    bgRaised: '#161920',
    bgSunken: '#090b0e',
    fg: '#e9ecf2',
    fgDim: '#a8b0c0',
    fgFaint: '#828b9c', // was #6d7484 — failed AA at 3.72:1
    line: '#252932',
    lineStrong: '#525b6b',
    accent: '#7aa2ff',
    accentFg: '#0b0f18',
    accentSoft: '#1a2338',
    danger: '#ff8578',
    warning: '#e0a83a',
    success: '#4cc38a',
    glow: 'rgba(122, 162, 255, 0.20)',
  },
  {
    id: 'pilani',
    name: 'Pilani Dusk',
    scheme: 'dark',
    swatch: '#e8944a',
    // The desert campus at dusk: warm sand against deep indigo. This is the
    // one theme that is specific to what this extension is for.
    bg: '#14110f',
    bgRaised: '#1d1916',
    bgSunken: '#0d0b0a',
    fg: '#f2ebe3',
    fgDim: '#bdb0a2',
    fgFaint: '#968a7e',
    line: '#2e2822',
    lineStrong: '#5f5245',
    accent: '#e8944a',
    accentFg: '#1a1411',
    accentSoft: '#332318',
    danger: '#f0776a',
    warning: '#dcae4e',
    success: '#67bb8a',
    glow: 'rgba(232, 148, 74, 0.22)',
  },
  {
    id: 'solarised',
    name: 'Solarised',
    scheme: 'light',
    swatch: '#268bd2',
    // Ethan Schoonover's palette, chosen for its flat luminance relationships,
    // which is what makes it comfortable over long reading sessions.
    bg: '#fdf6e3',
    bgRaised: '#fffbf0',
    bgSunken: '#eee8d5',
    fg: '#073642',
    fgDim: '#4a5c62',
    fgFaint: '#59696e', // lifted from the canonical #93a1a1, which fails AA
    line: '#e3ddca',
    lineStrong: '#a49b83',
    accent: '#1c6690', // darkened from #268bd2 for AA on cream
    accentFg: '#ffffff',
    accentSoft: '#e4ecef',
    danger: '#b1382c',
    warning: '#8a6400',
    success: '#5a7000',
    glow: 'rgba(31, 111, 158, 0.16)',
  },
  {
    id: 'nord',
    name: 'Nord',
    scheme: 'dark',
    swatch: '#88c0d0',
    bg: '#2e3440',
    bgRaised: '#3b4252',
    bgSunken: '#272c36',
    fg: '#eceff4',
    fgDim: '#c5cddb',
    fgFaint: '#a7b2c4', // lifted from #4c566a, which is unreadable as text
    line: '#434c5e',
    lineStrong: '#727e94',
    accent: '#88c0d0',
    accentFg: '#2e3440',
    accentSoft: '#3b4a55',
    danger: '#f0a49d',
    warning: '#ebcb8b',
    success: '#a3be8c',
    glow: 'rgba(136, 192, 208, 0.18)',
  },
  {
    id: 'contrast',
    name: 'High Contrast',
    scheme: 'light',
    swatch: '#000000',
    // Not an aesthetic choice. Pure values, AAA everywhere, heavy borders.
    // For low vision, glare, and direct sunlight.
    bg: '#ffffff',
    bgRaised: '#ffffff',
    bgSunken: '#f0f0f0',
    fg: '#000000',
    fgDim: '#1a1a1a',
    fgFaint: '#333333',
    line: '#767676',
    lineStrong: '#000000',
    accent: '#0034c4',
    accentFg: '#ffffff',
    accentSoft: '#dfe6ff',
    danger: '#a1000f',
    warning: '#6b4400',
    success: '#00522f',
    glow: 'rgba(0, 52, 196, 0.22)',
  },
];

export const DEFAULT_THEME = 'daylight';

/** camelCase key -> the CSS custom property it maps to. */
const CSS_VAR = {
  bg: '--bg',
  bgRaised: '--bg-raised',
  bgSunken: '--bg-sunken',
  fg: '--fg',
  fgDim: '--fg-dim',
  fgFaint: '--fg-faint',
  line: '--line',
  lineStrong: '--line-strong',
  accent: '--accent',
  accentFg: '--accent-fg',
  accentSoft: '--accent-soft',
  danger: '--danger',
  warning: '--warning',
  success: '--success',
  glow: '--glow',
};

export function getTheme(id) {
  return THEMES.find((t) => t.id === id) || THEMES.find((t) => t.id === DEFAULT_THEME);
}

/**
 * Apply a theme by writing custom properties onto the root element.
 *
 * Setting variables rather than swapping a stylesheet means one style
 * recalculation and no reflow: every consumer reads the same var, so nothing
 * needs re-selecting and no rules are re-matched.
 *
 * @param {string} id
 * @param {HTMLElement} root
 * @returns {Theme} the theme actually applied
 */
export function applyTheme(id, root = document.documentElement) {
  const theme = getTheme(id);
  const style = root.style;
  for (const [key, cssVar] of Object.entries(CSS_VAR)) {
    if (theme[key]) style.setProperty(cssVar, theme[key]);
  }
  root.dataset.theme = theme.id;
  // Drives form controls, scrollbars and the mail iframe's own rendering.
  root.dataset.scheme = theme.scheme;
  style.setProperty('color-scheme', theme.scheme);
  return theme;
}
