/**
 * The icon-rail overflow menu (responsive-audit R-A5).
 *
 * WHY THIS EXISTS
 * ---------------
 * The <=860px step turns the sidebar into a 64px icon rail: pure navigation,
 * nothing you have to read. The audit's table claimed every footer verb was
 * lost; the production probe (2026-08-13, 860px and 480px, palette queried
 * via the real Ctrl+K path) found the truth to be one shade narrower:
 *
 *   Activity log    palette reaches it            -> not lost
 *   Back to Gmail   palette row AND the Esc key   -> not lost
 *   Timetable       no control, no palette row    -> LOST
 *   Sign out        no control, no palette row    -> LOST
 *
 * "Icon rail = pure navigation" had erased *exit*. The fix is the smallest
 * surface that restores the whole set the step hides: one kebab in the
 * footer, rendered only where the rail is icons, opening the shared menu
 * primitive with the rail's hidden verbs in their DOM order.
 *
 * WHY THE ITEMS DELEGATE WITH .click()
 * ------------------------------------
 * Each item re-fires the button the rail hid rather than re-implementing its
 * action. Sign-out is not a one-liner: it invalidates the saver, clears the
 * cache, resets every mailbox and stops polling (app.js) — duplicating even
 * one line of that here would create the second, subtly-different sign-out
 * the next edit forgets to update. The buttons are display:none, but a
 * programmatic click still invokes their handlers, so the menu is a pure
 * ACCESS ROUTE and the hidden buttons remain the single implementation.
 *
 * Deliberate non-features:
 *
 *   - No timetable palette command and no sign-out shortcut were added.
 *     R-A5 scoped the fix to the rail; palette growth is a separate
 *     discoverability decision, and sign-out behind a key chord is a
 *     footgun the audit never asked for.
 *   - The badge count is mirrored as trailing text, not re-queried: the
 *     badge's home button is invisible at this width, so the number the
 *     user stops seeing is exactly the number the menu must carry.
 */

import { openMenu } from './menu.js';
import { setIcon } from './icons.js';

const $ = (id) => document.getElementById(id);

export function wireSidebarMore() {
  const btn = $('btn-side-more');
  if (!btn) return;
  setIcon(btn, 'more', { size: 15 });

  btn.addEventListener('click', () => {
    /* Read AT OPEN TIME: the badge mutates as classes are scanned, and a
       menu that shows yesterday's count is a small lie. */
    const badge = $('btn-timetable')?.querySelector('.tt-badge')?.textContent.trim() || '';
    openMenu({
      name: 'sidebar-more',
      label: 'More actions',
      anchor: btn,
      items: [
        // DOM order: the brand-row clock first, then the footer verbs.
        { text: 'Activity log', run: () => $('btn-activity').click() },
        { text: 'Timetable', trailing: badge, run: () => $('btn-timetable').click() },
        /* The one hid-behind-the-rail action with a keyboard route — the
           hint teaches it so the menu gets less necessary over time. */
        { text: 'Back to Gmail', hint: 'Esc', run: () => $('btn-gmail').click() },
        { text: 'Sign out', run: () => $('btn-signout').click() },
      ],
    });
  });
}
