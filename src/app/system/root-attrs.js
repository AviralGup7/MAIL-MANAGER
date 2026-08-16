/**
 * Root-attribute stamps — the settings that answer through CSS alone
 * (M4 shell extraction, 2026-08-13).
 *
 * THE ONE-ATTRIBUTE PROMISE
 * -------------------------
 * Some settings never need a re-render, because their consequence is pure
 * CSS: density remaps spacing tokens, ambience gates the lit sheen,
 * snippets gate the preview line. For those, JavaScript's whole job is
 * stamping the truth onto :root — once at boot, again on any write — and
 * CSS does the rest. The attribute is written even for the default state,
 * so the DOM always says what the surface believed (a missing attribute
 * and a default value are indistinguishable in a debugger).
 *
 * The SUBSCRIBERS stay in the shell — they also re-render lists beside
 * calling these. The stamps live here because they touch nothing past
 * :root and import nothing back. That self-containment is exactly what
 * made this cluster the second leaf extracted, after rail-visibility.
 */

import * as settings from './settings.js';

/**
 * Push the density setting onto the root element.  (Feature 28.)
 *
 * One attribute. `the style bundle` redefines four spacing tokens and the row height
 * under `:root[data-density=...]`, so every surface follows without a single
 * component knowing the setting exists.
 *
 * `comfortable` writes the attribute too rather than removing it, so the DOM
 * always states the current density -- a missing attribute and the default
 * value would be indistinguishable when debugging a screenshot.
 */
export function applyDensity() {
  const d = settings.get('density') || 'comfortable';
  document.documentElement.setAttribute('data-density', d);
}

/*
 * Push the ambience + snippet settings onto the root element -- the same
 * one-attribute promise applyDensity makes: the consequence is pure CSS
 * (one guard in 90-motion-system, one in 20-list), so no render path reads
 * these keys and no re-render is owed when one moves. The attribute is
 * written even for the default state, so a screenshot always says what the
 * surface believed -- a missing attribute and a default would be
 * indistinguishable when debugging.
 */
export function applyVisualPrefs() {
  const root = document.documentElement;
  root.setAttribute('data-ambience', settings.get('ambience') !== false ? 'on' : 'off');
  root.setAttribute('data-snippets', settings.get('snippets') !== false ? 'on' : 'off');
  /* textures + sounds (2026-08-14): the two override axes a heavy theme must
     answer to. Stamped for EVERY theme, not just skins that consume them —
     the one-attribute promise says the DOM always states what the surface
     believed, and a missing attribute would read as "default" not "off". */
  root.setAttribute('data-textures', settings.get('textures') !== false ? 'on' : 'off');
  root.setAttribute('data-sounds', settings.get('sounds') !== false ? 'on' : 'off');
  root.setAttribute('data-ui-profile', settings.get('uiProfile') || 'modern');
  root.setAttribute('data-cp-intensity', settings.get('cyberpunkIntensity') || 'balanced');
  root.setAttribute('data-cp-audio', settings.get('cyberpunkAudioProfile') || 'semantic');
  root.setAttribute('data-telemetry', settings.get('showTelemetry') !== false ? 'on' : 'off');
  root.setAttribute('data-provenance', settings.get('showProvenance') !== false ? 'on' : 'off');
  root.setAttribute('data-reader-dossier', settings.get('readerDossier') !== false ? 'on' : 'off');
  root.setAttribute('data-thread-timeline', settings.get('threadTimeline') !== false ? 'on' : 'off');
  root.setAttribute('data-query-console', settings.get('queryConsole') !== false ? 'on' : 'off');
  root.setAttribute('data-tt-terminal', settings.get('timetableTerminal') !== false ? 'on' : 'off');
  root.setAttribute('data-operation-center', settings.get('operationCenter') !== false ? 'on' : 'off');
  root.setAttribute('data-calm-content', settings.get('calmContent') !== false ? 'on' : 'off');
  /*
   * POINTER MOTION, RESOLVED (round 7). `auto` is theme-dependent, so the
   * DOM states the DECISION rather than the preference: consumers read one
   * attribute and never re-derive the theme rule. Cyberpunk brings its own
   * motion language, so auto means off there and on everywhere else.
   */
  const pm = settings.get('pointerMotion') || 'auto';
  const themeId = settings.get('theme') || 'daylight';
  const pmOn = pm === 'on' || (pm === 'auto' && themeId !== 'cyberpunk');
  root.setAttribute('data-pointer-motion', pmOn ? 'on' : 'off');
}
