/**
 * Rail visibility — when the For-you rail exists on screen, and WHAT KIND
 * of existence it gets (M4 shell extraction, 2026-08-13).
 *
 * WHY THIS IS A MODULE
 * --------------------
 * The shell owned three postures of one rail: the reserved desktop column,
 * the <=1240px slide-in drawer, and the rule that an overlay never opens
 * ITSELF (the 2026-08-13 overlap: the drawer sprang open the moment data
 * landed ~1s after boot, and the mail list slid under it). That is
 * workspace chrome policy, not composition — so it lives beside the
 * sidebar, and the shell pays one line: wireRailVisibility().
 *
 * DEPENDS ON      system/settings (the `railOpen` key names the DESKTOP
 *                 column preference only — see the boot comment inside)
 * OWNS            body.rail-open, #btn-rail's aria-pressed, drawer manners
 *                 (outside press, Escape), both directions of the 1240 seam
 * DOES NOT OWN    the rail's contents (workspace/rails.js renders those)
 */

import * as settings from '../system/settings.js';

const $ = (id) => document.getElementById(id);

/*
 * The context rail's visibility is CSS's job: `body.rail-open` + the rail's
 * own "hide when every section is empty" :has() rule. All JS owns is the
 * toggle — flip the class, mark the button, remember the choice.
 */
export function wireRailVisibility() {
  const btn = $('btn-rail');
  const close = $('btn-rail-close');
  if (!btn) return;
  /* At <=1240px the rail stops being a column and becomes a drawer: it
     floats over the reader. Drawer manners apply there -- a pointer outside
     it or Escape puts it away -- while at desktop widths it is a sibling
     column and stays put until toggled. The persisted setting still decides
     the initial state either way. */
  const drawerMq = window.matchMedia('(max-width: 1240px)');
  let onOutside = null;

  const detachOutside = () => {
    if (onOutside) {
      document.removeEventListener('pointerdown', onOutside, true);
      onOutside = null;
    }
  };
  const apply = (on) => {
    document.body.classList.toggle('rail-open', on);
    btn.setAttribute('aria-pressed', String(on));
    detachOutside();
    if (on && drawerMq.matches) {
      onOutside = (e) => {
        if (e.target.closest('#rail') || e.target.closest('#btn-rail')) return;
        apply(false);
      };
      document.addEventListener('pointerdown', onOutside, true);
    }
  };
  /*
   * The saved preference names the DESKTOP column. In the drawer regime an
   * unprompted open is a FIXED panel floated over the mail — and because the
   * rail self-hides while its sections are empty, the overlap only APPEARS
   * once the first data lands (user report, 2026-08-13: no overlap at load,
   * then ~1s in the whole mail page slides under the rail). A drawer that
   * opens itself reads as the layout breaking, not as a feature arriving.
   * So the drawer regime starts SHUT: the button still summons the rail and
   * its manners (outside press, Escape) still put it away; only the welcome
   * is withdrawn. At column widths nothing changes.
   */
  apply(settings.get('railOpen') !== false && !drawerMq.matches);

  /* Crossing the seam changes what "open" MEANS — a reserved grid column on
     one side, an overlay on the other. Folding INTO drawer widths puts the
     overlay away without touching the saved preference; unfolding back to
     column widths restores whatever the preference says. (addListener
     fallback: some test doubles predate MediaQueryList.addEventListener.) */
  const onSeam = (mq) => apply(mq.matches ? false : settings.get('railOpen') !== false);
  if (drawerMq.addEventListener) drawerMq.addEventListener('change', onSeam);
  else drawerMq.addListener?.(onSeam);

  /* The rail follows the KEY, not the button: the settings panel (and the
     options page through followExternalChanges) writes the same `railOpen`
     setting, and it must take effect here without a reload. `apply` is
     idempotent, so the button's own write arriving through this subscription
     is a harmless second no-op. */
  settings.subscribe((key) => {
    if (key === 'railOpen') apply(settings.get('railOpen') !== false);
  });
  btn.addEventListener('click', () => {
    const on = !document.body.classList.contains('rail-open');
    settings.set('railOpen', on).catch(() => {});
    apply(on);
  });
  close?.addEventListener('click', () => {
    settings.set('railOpen', false).catch(() => {});
    apply(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerMq.matches && document.body.classList.contains('rail-open')) {
      apply(false);
    }
  });
}
