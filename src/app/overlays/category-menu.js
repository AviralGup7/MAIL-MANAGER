/**
 * Category-rule menu tenant (extracted per the architecture audit).
 *
 * Mute and auto-archive are rules ABOUT a category, so they live on the
 * category, one menu away. The shell owns the rules state and the renders;
 * this tenant owns the menu's shape and the copy that explains each rule.
 */
import { openMenu } from './menu.js';
import { CATEGORY_LABELS } from '../../classify/categories.js';
import { isMuted, toggleMute, isAutoArchived, toggleAutoArchive } from '../mail/rules.js';

let ctx = null;
export function wireCategoryMenu(c) { ctx = c; }

export function openCategoryMenu(category, anchor) {
  const label = CATEGORY_LABELS[category] || category;

  openMenu({
    name: 'category-menu',
    label: `${label} rules`,
    anchor,
    className: 'cat-menu',
    items: [
      {
        text: `Mute ${label}`,
        hint: 'Hide from the inbox list. Still searchable, nothing deleted.',
        checked: isMuted(ctx.getRules(), category),
        trailing: isMuted(ctx.getRules(), category) ? 'On' : '',
        run: async () => {
          ctx.setRules(toggleMute(ctx.getRules(), category));
          await ctx.saveRules();
          ctx.renderList();
          ctx.renderSidebar();
          ctx.toast(isMuted(ctx.getRules(), category) ? `${label} muted` : `${label} unmuted`);
        },
      },
      {
        text: `Auto-archive ${label}`,
        hint: 'Archive new mail in this category as it arrives.',
        checked: isAutoArchived(ctx.getRules(), category),
        trailing: isAutoArchived(ctx.getRules(), category) ? 'On' : '',
        run: async () => {
          ctx.setRules(toggleAutoArchive(ctx.getRules(), category));
          await ctx.saveRules();
          ctx.renderSidebar();
          ctx.toast(
            isAutoArchived(ctx.getRules(), category)
              ? `New ${label} mail will be archived`
              : 'Auto-archive off for ' + label
          );
        },
      },
    ],
  });
}
