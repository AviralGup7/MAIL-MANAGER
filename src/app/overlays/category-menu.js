/**
 * Category-rule menu tenant (extracted per the architecture audit).
 *
 * Mute and auto-archive are rules ABOUT a category, so they live on the
 * category, one menu away. The shell owns the rules state and the renders;
 * this tenant owns the menu's shape and the copy that explains each rule.
 */
import { openMenu } from './menu.js';
import { CATEGORY_LABELS } from '../../classify/categories.js';
import { isMuted, toggleMute, isAutoArchived, toggleAutoArchive, autoArchiveMatchSet } from '../mail/rules.js';
import { confirmDialog } from './dialog.js';

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
          /* The ON flip is where a destructive-adjacent rule begins, so it
             is earned through a DRY RUN: name the current match set, restate
             the arrivals-only contract, keep or drop with both eyes open
             (M3, 2026-08-13). Turning OFF stays one click — putting out a
             fire needs no preview. */
          if (!isAutoArchived(ctx.getRules(), category)
              && !(await confirmAutoArchive(ctx, category, label))) return;
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

/**
 * The dry run before the flip. The count and samples come from
 * autoArchiveMatchSet — the mirror of the ingest filter — and the body
 * states the two things that keep the rule honest: it acts on NEW arrivals
 * only, and it flips back off here at any time.
 */
async function confirmAutoArchive(ctx, category, label) {
  const store = ctx.store;
  const all = store?.order ? store.order.map((id) => store.get(id)).filter(Boolean) : [];
  const { count, samples } = autoArchiveMatchSet(all, category);
  const sample = samples.length ? ` ("${samples.join('", "')}"${count > samples.length ? ', …' : ''})` : '';
  const body = count
    ? `${count} unread ${label} message${count === 1 ? '' : 's'} match this rule right now${sample}. The rule acts on NEW arrivals only — existing mail stays put; turn it off here any time.`
    : `No unread ${label} mail matches right now. The rule acts on NEW arrivals only; turn it off here any time.`;
  return confirmDialog({
    title: `Auto-archive ${label}?`,
    body,
    confirmLabel: 'Turn on',
  });
}
