/**
 * Row quick actions + row context menu (round 65/b, docs/UX-AUDIT-V4 F3/F12).
 *
 * BEFORE: acting on a list row meant opening it (verbs live in the reader),
 * multi-selecting it (verbs live in the bulk bar), or remembering e/u/z/#.
 * None of those is discoverable from the row itself, so the highest-frequency
 * object in the app had zero visible affordances.
 *
 * AFTER: the row shows what it can do. On hover (or keyboard selection, or
 * focus within) four icon verbs appear where the date normally sits -- the
 * date is a fact you read once; the verbs are what you do next, so the fact
 * yields to them, Gmail-style. Right-click (and Shift+F10 / the menu key for
 * keyboard users) opens the full verb set in a menu built by the shared menu
 * primitive: mounted under #overlay-root, Esc-safe, focus-restoring.
 *
 * Everything routes through the EXISTING verb layer (`act`, `openSnoozeMenu`):
 * no new action paths, so undo, optimistic updates and thread-spanning rules
 * behave exactly as they do from the keyboard.
 */

import { openMenu } from '../overlays/menu.js';
import { setIcon } from '../core/icons.js';
import { openSnoozeMenu } from '../overlays/snooze-menu.js';

/**
 * Ordered by frequency in a campus inbox: archive, read/unread, snooze, and
 * delete LAST -- a destructive verb never sits in the easiest hit position.
 */
const QUICK = [
  { verb: 'archive', icon: 'archive', label: 'Archive', key: 'e' },
  { verb: 'unread', icon: 'mail', label: 'Mark read', key: 'u', dynamic: true },
  { verb: 'snooze', icon: 'clock', label: 'Snooze', key: 'z' },
  { verb: 'trash', icon: 'trash', label: 'Delete', key: '#' },
];

function runQuick(ctx, verb, m, anchorEl) {
  if (verb === 'snooze') {
    // Snooze is a CHOICE, not a verb with one answer: open its time menu
    // anchored at the button, same as `z` does for the selected row.
    openSnoozeMenu(m.id, anchorEl);
    return;
  }
  ctx.act(verb, m.id);
}

/**
 * Attach the hover verb cluster to a freshly built row. Called from
 * list.js `buildRow`; `fillRow` keeps the dynamic read/unread label honest.
 *
 * `tabindex="-1"` ON PURPOSE: the keyboard path for these same verbs is
 * e/u/z/# and the listbox owns its roster -- five extra tab stops per row
 * would make tab order unusable for exactly the users who already have the
 * faster path.
 */
export function buildRowActions(li) {
  if (!li?.querySelector) return;
  const wrap = document.createElement('span');
  wrap.className = 'r-actions';
  /* One verb cluster per row, and the date has right of way until the row is
     attended; CSS owns the reveal. */
  for (const a of QUICK) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'r-act';
    b.tabIndex = -1;
    b.dataset.verb = a.verb;
    b.title = `${a.label} (${a.key})`;
    b.setAttribute('aria-label', a.label);
    setIcon(b, a.icon); // sized by the `.r-act svg` rule, like every card sibling
    wrap.appendChild(b);
  }
  return wrap;
}

/** The read/unread toggle names both directions; sync it to the message. */
export function syncRowActions(li, m) {
  if (!li?.querySelector || !m) return;
  const toggle = li.querySelector('.r-act[data-verb="unread"]');
  if (!toggle || !m) return;
  const label = m.unread ? 'Mark read' : 'Mark unread';
  toggle.setAttribute('aria-label', label);
  toggle.title = `${label} (u)`;
}

function contextItems(ctx, m, anchorLi) {
  const { act, openMessage, state } = ctx;
  const items = [
    {
      text: 'Open',
      hint: m.subject || '(no subject)',
      trailing: '⏎',
      run: async () => openMessage(m.id),
    },
    {
      text: 'Archive',
      trailing: 'e',
      run: async () => act('archive', m.id),
    },
    {
      text: m.unread ? 'Mark read' : 'Mark unread',
      trailing: 'u',
      run: async () => act('unread', m.id),
    },
    {
      text: m.starred ? 'Unstar' : 'Star',
      trailing: 's',
      run: async () => act('star', m.id),
    },
    {
      text: 'Snooze…',
      hint: 'Pick a time; the row leaves until then.',
      trailing: 'z',
      run: async () => openSnoozeMenu(m.id, anchorLi),
    },
  ];
  if (state.mailbox === 'trash') {
    items.push({
      text: 'Restore',
      hint: 'Back to where it was. Undoable.',
      run: async () => act('restore', m.id),
    });
  } else {
    // Delete is never the last click you cannot take back: TRASH has undo.
    items.push({
      text: 'Delete',
      hint: 'Moves to Trash; undoable, and Trash can restore it.',
      trailing: '#',
      run: async () => act('trash', m.id),
    });
    items.push(
      state.mailbox === 'spam'
        ? {
            text: 'Not spam',
            hint: 'Rescues the sender too, not only this mail.',
            trailing: '!',
            run: async () => act('spam', m.id),
          }
        : {
            text: 'Report spam',
            className: 'menu-danger',
            hint: 'Trains the filter against this sender. Undoable.',
            trailing: '!',
            run: async () => act('spam', m.id),
          }
    );
  }
  return items;
}

function openRowMenu(ctx, li) {
  const m = ctx.store.get(li.dataset.id);
  if (!m) return;
  openMenu({
    name: 'row-menu',
    label: `Actions for ${m.subject || m.from}`,
    anchor: li,
    className: 'row-menu',
    items: contextItems(ctx, m, li),
  });
}

/**
 * Wire the list once: delegated hover-verb clicks, right-click menu, and the
 * keyboard context-menu key. Delegation, not per-row listeners -- rows are
 * recycled and re-filled, and a listener per row is the leak that gets found
 * at message ten thousand.
 */
export function wireRowActions(ctx) {
  const list = document.getElementById('list');
  if (!list) return;

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.r-act');
    if (!btn) return;
    /* A verb is not an open: never let the row's open handler see this. */
    e.preventDefault();
    e.stopPropagation();
    const li = btn.closest('.row');
    const m = li?.dataset.id && ctx.store.get(li.dataset.id);
    if (m) runQuick(ctx, btn.dataset.verb, m, btn);
  });

  list.addEventListener('contextmenu', (e) => {
    const li = e.target.closest('.row');
    if (!li?.dataset.id) return;
    /* The browser's own menu on a message row is the tell of a web page
       wearing an app's clothes (same rule as text-selecting chrome). */
    e.preventDefault();
    openRowMenu(ctx, li);
  });

  /* Shift+F10 and the dedicated menu key are how a keyboard user right-
     clicks. The selected row is the anchor. */
  list.addEventListener('keydown', (e) => {
    if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return;
    const li = list.querySelector('.row[aria-selected="true"]');
    if (!li) return;
    e.preventDefault();
    openRowMenu(ctx, li);
  });
}
