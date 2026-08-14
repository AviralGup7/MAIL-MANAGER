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
 * WHY THESE SEVEN
 * Not seven variations on blue. Each one exists for a situation:
 *   - Daylight / Midnight  the neutral defaults, light and dark
 *   - Pilani Dusk          BITS colours, warm — the reason this extension exists
 *   - Solarised            the classic low-eyestrain palette, for long sessions
 *   - Nord                 cool and desaturated, the most "calm" of the darks
 *   - Cyberpunk            the fan skin; neon cyan on near-black maroon, with
 *                          textures, motion and synthesized sound — the skin
 *                          itself is 88-cyberpunk.css + cyberpunk-fx.js
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
 * @property {string} bg
 * @property {string} bgRaised
 * @property {string} bgSunken
 * @property {string} fg
 * @property {string} fgDim
 * @property {string} fgFaint
 * @property {string} line
 * @property {string} lineStrong
 * @property {string} accent
 * @property {string} accentFg
 * @property {string} accentSoft
 * @property {string} danger
 * @property {string} warning
 * @property {string} success
 * @property {string} star
 * @property {string} glow
 * @property {string} btnRadius  button corner radius — '0px' or a --r-* var
 * @property {string} btnCut     button corner-chamfer depth in px, '0px' = none
 *
 * THE SHAPE AXIS (2026-08-14)
 * Themes were colour-only; the shape of every button is now theme data too.
 * The geometry is written ONCE in 10-shell.css (radius + a symmetric
 * top-left/bottom-right chamfer polygon); each theme below supplies only the
 * two numbers. A chamfer with a 0 depth is the full rectangle, so the round
 * themes pay nothing. Hard edges belong to cyberpunk (and to High Contrast,
 * where an edge is information), paper-soft to Solarised, and the others sit
 * in between — switching themes now changes the controls' silhouette, which
 * is the point: shape rides the theme, SETTINGS (see sounds/textures) still
 * outrank it wherever a theme's atmosphere would shout.
 */

/** @type {Theme[]} without the annotation each literal widens scheme to `string` */
export const THEMES = [
  {
    id: 'daylight',
    name: 'Daylight',
    scheme: 'light',
    swatch: '#1a4fd6',
    // On a light theme the raised surface is already pure white, so depth has
    // to come from the PAGE receding rather than the panel brightening. The
    // ground is cooled and darkened a step; white panels now sit on it
    // clearly instead of nearly matching it.
    bg: '#eef1f6',
    bgRaised: '#ffffff',
    bgSunken: '#e2e7ef',
    fg: '#12151b',
    fgDim: '#4a5260',
    fgFaint: '#5d6573', // darkened again when bgSunken deepened; AA on all three surfaces
    line: '#d3dae5',
    lineStrong: '#8b98ac', // tracks bg; a border must stay >=2.4:1 on the page
    accent: '#1a4fd6',
    accentFg: '#ffffff',
    accentSoft: '#e4ebfb',
    danger: '#b3261e',
    warning: '#8a5a00',
    success: '#0f6b45',
    star: '#8a6100',
    glow: 'rgba(26, 79, 214, 0.16)',
    // The canonical round — what every button looked like before the axis.
    btnRadius: 'var(--r-md)',
    btnCut: '0px',
  },
  {
    id: 'midnight',
    name: 'Midnight',
    scheme: 'dark',
    swatch: '#7aa2ff',
    // Raised lifted from #161920: a panel one step off the page reads as a
    // separate sheet, and at 1.08:1 it did not. Sunken deepened to match, so
    // the three surfaces are evenly spaced rather than two-plus-one.
    bg: '#0d0f14',
    bgRaised: '#181c25',
    bgSunken: '#07090c',
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
    star: '#eab308',
    glow: 'rgba(122, 162, 255, 0.20)',
    // Midnight squarer: --r-sm, the cool low-radius end of the scale.
    btnRadius: 'var(--r-sm)',
    btnCut: '0px',
  },
  {
    id: 'pilani',
    name: 'Pilani Dusk',
    scheme: 'dark',
    swatch: '#e8944a',
    // The desert campus at dusk: warm sand against deep indigo. This is the
    // one theme that is specific to what this extension is for.
    // The raised surface carries slightly MORE warmth than the page, not just
    // more light: a warm sheet over a cooler ground is what dusk actually
    // looks like, and it separates the panels without a border doing the work.
    bg: '#131010',
    bgRaised: '#211c18',
    bgSunken: '#0b0908',
    fg: '#f2ebe3',
    fgDim: '#bdb0a2',
    fgFaint: '#9e9284', // lifted from #968a7e: was 4.47:1 on accentSoft, AA needs 4.5
    line: '#2e2822',
    lineStrong: '#5f5245',
    accent: '#e8944a',
    accentFg: '#1a1411',
    accentSoft: '#332318',
    danger: '#f0776a',
    warning: '#dcae4e',
    success: '#67bb8a',
    star: '#eab308',
    glow: 'rgba(232, 148, 74, 0.22)',
    // Pilani keeps the canonical round.
    btnRadius: 'var(--r-md)',
    btnCut: '0px',
  },
  {
    id: 'solarised',
    name: 'Solarised',
    scheme: 'light',
    swatch: '#268bd2',
    // Ethan Schoonover's palette, chosen for its flat luminance relationships,
    // which is what makes it comfortable over long reading sessions.
    // Solarised's own base3/base2 sit only 1.04:1 apart, which is faithful to
    // the palette and reads as one flat sheet in a three-pane layout. The page
    // steps down toward base2 while the panel keeps the warm highlight, so the
    // relationship stays Solarised and the panels become visible.
    bg: '#f7f0dd',
    bgRaised: '#fffdf6',
    bgSunken: '#e9e2cd',
    fg: '#073642',
    fgDim: '#4a5c62',
    fgFaint: '#54646a', // lifted from canonical #93a1a1; re-darkened for the deeper sunken
    line: '#ddd6c1',
    lineStrong: '#9c9279', // tracks the darkened base3
    accent: '#1c6690', // darkened from #268bd2 for AA on cream
    accentFg: '#ffffff',
    accentSoft: '#e4ecef',
    danger: '#b1382c',
    warning: '#7d5a00',
    success: '#526600', // AA on bgSunken, which is the darkest surface it lands on
    star: '#8a6100',
    glow: 'rgba(31, 111, 158, 0.16)',
    // Solarised is the paper-soft outlier: full pill buttons.
    btnRadius: 'var(--r-full)',
    btnCut: '0px',
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
    fgFaint: '#b6c0d2', // lifted twice: #4c566a unreadable, #a7b2c4 was 4.27:1 on accentSoft
    line: '#434c5e',
    lineStrong: '#727e94',
    accent: '#88c0d0',
    accentFg: '#2e3440',
    accentSoft: '#3b4a55',
    danger: '#f0a49d',
    warning: '#ebcb8b',
    success: '#adc898', // lifted from #a3be8c: was 4.49:1 on accentSoft
    star: '#ebcb8b',
    glow: 'rgba(136, 192, 208, 0.18)',
    // Nord angular-calm: --r-sm.
    btnRadius: 'var(--r-sm)',
    btnCut: '0px',
  },
  {
    id: 'cyberpunk',
    name: 'Cyberpunk',
    scheme: 'dark',
    swatch: '#42d9ea',
    /*
     * AN ORIGINAL INTERPRETATION, not a port. The 2026-08-14 request asked
     * for a theme in the mood of a certain neon-dystopia game; the design
     * language was studied from reference screenshots and re-expressed here
     * as our own palette and our own CSS (88-cyberpunk.css) and synthesized
     * UI sounds (cyberpunk-fx.js). No game artwork, fonts or audio ship in
     * this repo — the skin is token-derived, so tuning this object re-tunes
     * the whole skin.
     *
     * Every role passed the contrast gate at first draft; the closest pairs
     * are fgFaint on accentSoft (4.66) and danger on accentSoft (4.82), both
     * clear of AA's 4.5. Darkening accentSoft further would buy margin but
     * costs the cyan cast that makes the selection read as lit glass.
     */
    bg: '#0b0508',
    bgRaised: '#170b11',
    bgSunken: '#050304',
    fg: '#f5eae6',
    fgDim: '#cfaeb2',
    fgFaint: '#ad8a90', // AA everywhere; on accentSoft it is 4.66, the tightest pair
    line: '#3a2330',
    lineStrong: '#77465a',
    accent: '#42d9ea',
    accentFg: '#032025',
    accentSoft: '#0f2e35',
    danger: '#ff5c78',
    warning: '#f2c14e',
    success: '#4fd6a0',
    star: '#f7dc0a',
    glow: 'rgba(66, 217, 234, 0.22)',
    // The skin's hard turn: no radius, symmetric corner chop, depth from the one --cp-cut knob.
    btnRadius: '0px',
    btnCut: 'var(--cp-cut)',
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
    star: '#6b4400',
    glow: 'rgba(0, 52, 196, 0.22)',
    // High Contrast is square by policy: an edge is information.
    btnRadius: '0px',
    btnCut: '0px',
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
  star: '--star',
  glow: '--glow',
  btnRadius: '--btn-radius',
  btnCut: '--btn-cut',
};

/*
 * The pre-axis look, used when a theme does not speak shape. setProperty is
 * UNCONDITIONAL for these: a colour a theme omits simply keeps its :root
 * fallback, but an omitted SHAPE would keep the PREVIOUS theme's live token
 * — cyberpunk's chamfer silently following you into Daylight. Writing the
 * default on every switch is what makes leaving a heavy theme residue-free.
 */
const SHAPE_DEF = { btnRadius: 'var(--r-md)', btnCut: '0px' };

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
    else if (key in SHAPE_DEF) style.setProperty(cssVar, SHAPE_DEF[key]);
    /* shape keys write the DEFAULT rather than skip — see SHAPE_DEF above:
       skipping is how cyberpunk's chamfer would leak into Daylight. */
  }
  root.dataset.theme = theme.id;
  // Drives form controls, scrollbars and the mail iframe's own rendering.
  root.dataset.scheme = theme.scheme;
  style.setProperty('color-scheme', theme.scheme);
  return theme;
}
