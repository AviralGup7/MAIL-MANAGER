/**
 * Snooze picker tenant (extracted per the architecture audit).
 *
 * A small menu rather than a date-time control: snoozing is a fast,
 * frequent, low-precision decision -- "not now, later" -- and a calendar
 * widget turns a one-keystroke action into a form. Gmail reached the same
 * conclusion. Rendered on demand, torn down on dismiss.
 *
 * Talks to the shell through an explicit ctx: message lookup and the
 * optimistic snooze verb stay owned by the shell.
 */
import { openMenu, closeMenu } from './menu.js';
import { presets as snoozePresets } from '../../features/snooze/model.js';
import { extractDeadline } from '../academic/deadlines.js';

let ctx = null;
export function wireSnoozeMenu(c) { ctx = c; }

export function openSnoozeMenu(id, anchor) {
  const m = ctx.getMessage(id);
  if (!m) return;

  // The deadline the radar already parsed feeds an option Gmail cannot offer.
  let deadline;
  try {
    deadline = extractDeadline(m)?.at;
  } catch {
    deadline = undefined;
  }

  openMenu({
    name: 'snooze-menu',
    label: 'Snooze until',
    anchor,
    // Hangs off the reader's action bar rather than the row, so the menu is
    // not clipped by the list's overflow.
    mountTo: anchor?.closest('#r-actions') || document.getElementById('reader') || document.body,
    items: snoozePresets(Date.now(), { deadline }).map((opt) => ({
      text: opt.label,
      trailing: new Date(opt.at).toLocaleString(undefined, {
        weekday: 'short', hour: 'numeric', minute: '2-digit',
      }),
      run: () => ctx.snoozeMessage(id, opt.at, opt.label),
    })),
  });
}

export function closeSnoozeMenu() {
  closeMenu();
}
