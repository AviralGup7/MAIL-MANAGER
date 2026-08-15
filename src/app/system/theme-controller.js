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
export function chooseTheme(id, { state, toast }) {
  const theme = applyTheme(id);
  state.theme = theme.id;
  if (theme.id === 'cyberpunk') cyberpunkEnterFx();
  toast(theme.name, { ms: 1200 });
  void settings.set('theme', theme.id).catch(() => {
    toast('Could not save the theme choice', { kind: 'error' });
  });
  return theme;
}
