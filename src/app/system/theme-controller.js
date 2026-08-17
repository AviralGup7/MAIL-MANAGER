/**
 * Theme transitions — the two moments a theme is chosen.
 *
 * RESPONSIBILITY  Apply the right theme at boot (saved, else OS-derived) and
 *                 carry out a user-driven switch: apply, voice the one themed
 *                 arrival, report, persist.
 * OWNS            nothing durable. State and the toast arrive as arguments,
 *                 so this module holds no shell reference across a call.
 * DOES NOT OWN    the theme DATA (themes.js), the persistence schema
 *                 (settings.js), or the picker UI (main.js builds the menu).
 *
 * WHY THE SPLIT. Boot must not animate — the FX are for a deliberate change
 * the user just made, not for a page that is still assembling — so the two
 * entry points are separate functions rather than one with a flag.
 *
 * (Module header added 2026-08-15 by the architectural audit, ARCH-R2-5: this
 * was one of two modules in 116 with no header. The house convention is that
 * every module states its boundary; a module that does not is one whose scope
 * is decided by whoever edits it next.)
 */
import { applyTheme, DEFAULT_THEME } from './themes.js';
import { cyberpunkEnterFx } from './cyberpunk-fx.js';
import * as settings from './settings.js';

/** Apply the saved/OS-derived theme before first paint. */
export function applyInitialTheme(savedTheme, osDark, state) {
  const theme = applyTheme(savedTheme || (osDark ? 'midnight' : DEFAULT_THEME));
  state.theme = theme.id;
  return theme;
}

/**
 * User-driven theme transition: apply, voice the one themed arrival, report,
 * and persist through the schema authority.
 */
export function chooseTheme(id, /** @type {{state?:any, toast?:Function}} */ { state, toast } = {}) {
  /* state and toast are REQUIRED collaborators, not options: a theme change
     with nowhere to record itself and nothing to announce it is not a
     partial success, it is a no-op. Refusing here beats crashing one line
     down on `state.theme` (round 11 sweep). */
  if (!state || typeof toast !== 'function') return applyTheme(id);
  const theme = applyTheme(id);
  state.theme = theme.id;
  if (theme.id === 'cyberpunk') cyberpunkEnterFx();
  toast(theme.name, { ms: 1200 });
  void settings.set('theme', theme.id).catch(() => {
    toast('Could not save the theme choice', { kind: 'error' });
  });
  return theme;
}
