/**
 * Category-rule menu tenant (extracted per the architecture audit).
 *
 * Two menus, one owner, because both speak for the SAME rules blob:
 *
 *   - the per-CATEGORY rules — mute and auto-archive live on the category,
 *     one menu away;
 *   - the per-SENDER corrections — "this is in the wrong category", the
 *     write side of the classifier, joined the tenant in the G5 extraction
 *     (2026-08-14) from main.js, where it sat beside the seed of the first
 *     (it was the last classifier-facing UI left in the shell; every call
 *     site was inside the cluster except the reader's one button).
 *
 * The shell owns the rules state and the renders; this tenant owns the
 * menus' shape and the copy that explains each rule. "Mute" in most
 * clients is vague; here it means "hide from the inbox list", and saying
 * so is the difference between a feature people use and one they are
 * scared of.
 */
import { openMenu } from './menu.js';
import { CATEGORY_LABELS, SIDEBAR_ORDER } from '../../classify/categories.js';
import {
  isMuted, toggleMute, isAutoArchived, toggleAutoArchive, autoArchiveMatchSet,
  correctSender, clearCorrection,
} from '../mail/rules.js';
import { addressOf } from '../core/contacts.js';
import { displayName } from '../core/display.js';
import { confirmDialog } from './dialog.js';

let ctx = null;
/* ctx beyond the rules triplet (wireCategoryMenu's original contract):
   `store` getter, `state`, `ingest`, `syncContextActions`,
   `renderReaderTags` — injected rather than imported so the tenant keeps
   no edge into the shell or the reader (G5 doctrine: inject what you
   don't own). toast arrives through ctx too, as it always has here. */
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

/* ------------------------------------------------------------------ *
 *  The per-SENDER corrections — "this is in the wrong category."      *
 * ------------------------------------------------------------------ *
 *
 * THE WRITE SIDE OF THE CLASSIFIER. For a long time `correctSender` and
 * `clearCorrection` were both implemented, both tested, and called from
 * nowhere -- while `applyCorrection` ran on every ingest. The product
 * faithfully applied a correction store no user could write to.
 *
 * The correction is keyed by SENDER, not by message. One wrong bucket is
 * almost always a whole mailing list in the wrong bucket, and asking the
 * user to fix each message individually is asking them to do the
 * classifier's job. That is also why the rest of the product picks it up
 * immediately: the corrections map is consulted on ingest, so
 * re-ingesting what is in memory re-files everything from that sender at
 * once.
 */
/** How many loaded messages from this sender currently sit in a category. */
function countFromSenderIn(sender, cat) {
  let n = 0;
  for (const id of ctx.store.idsFor('all')) {
    const m = ctx.store.get(id);
    if (m && m.category === cat && addressOf(m.from) === sender) n++;
  }
  return n;
}

export function openRecategoriseMenu(msg, anchor) {
  const current = msg.category;
  const taught = Object.prototype.hasOwnProperty.call(
    ctx.getRules().corrections || {}, addressOf(msg.from)
  );

  const items = [];

  /*
   * Offered FIRST when a correction exists, because undoing a mistake is more
   * urgent than making another one. clearCorrection was referenced nowhere in
   * the app before this menu existed -- teaching a classifier something wrong
   * and being unable to un-teach it is worse than not teaching it at all.
   */
  if (taught) {
    items.push({
      text: 'Use the automatic category',
      hint: 'Forget what I taught you about this sender.',
      run: async () => {
        const sender = addressOf(msg.from);
        const moved = countFromSenderIn(sender, msg.category);
        ctx.setRules(clearCorrection(ctx.getRules(), msg.from));
        await ctx.saveRules();
        reclassifyAll();
        ctx.toast(`Back to the automatic category${moved ? ` — ${moved} re-filed` : ''}`);
      },
    });
  }

  for (const cat of SIDEBAR_ORDER) {
    if (cat === current) continue;
    items.push({
      text: CATEGORY_LABELS[cat] || cat,
      hint: `File mail from ${displayName(msg.from)} here.`,
      run: async () => {
        const sender = addressOf(msg.from);
        // Count BEFORE the re-file: the effect must be reported with its
        // scope, not discovered by hunting the list (round 61, P-1).
        const moved = countFromSenderIn(sender, msg.category);
        ctx.setRules(correctSender(ctx.getRules(), msg.from, cat));
        await ctx.saveRules();
        reclassifyAll();
        ctx.toast(`${displayName(msg.from)} now files under ${CATEGORY_LABELS[cat] || cat} — ${moved} re-filed`);
      },
    });
  }

  openMenu({
    name: 'category-menu',
    label: 'Move to a different category',
    anchor,
    className: 'cat-menu',
    items,
  });
}

/**
 * Re-file everything already in memory against the current corrections.
 *
 * A correction is about a SENDER, so it must apply to the mail already on
 * screen -- not only to whatever arrives next. Re-ingesting is cheap (the
 * classifier is 10.7ms for 2000 messages) and it reuses the one code path
 * that knows how corrections, categories and deadlines fit together.
 */
function reclassifyAll() {
  const store = ctx.store;
  const all = store.idsFor('all').map((id) => store.get(id)).filter(Boolean);
  if (all.length) ctx.ingest(all);
  ctx.renderList();
  ctx.renderSidebar();
  const open = ctx.state.selected && store.get(ctx.state.selected);
  if (open) {
    ctx.syncContextActions(open);
    // P-1: the OPEN message re-files itself visibly — its tag row shows the
    // new category immediately, so the effect of the correction is seen in
    // the place the user is looking, not inferred from the list behind them.
    ctx.renderReaderTags(open);
  }
}
