/**
 * The undo stack, and recording an action into it.
 *
 * Named undo-actions.js because undo.js already exists and owns the UndoStack
 * data structure -- this is the app-facing half: what gets recorded, what the
 * toast says, and what happens when the reversal fails.
 */

import { UndoStack } from './undo.js';

/* ========================================================================== *
 * UNDO
 * ========================================================================== */

export const undoStack = new UndoStack();

/**
 * Wrap a destructive action so it can be reversed.
 *
 * Gmail can only undo a send. Because every action here already applies
 * optimistically to the local store, the reversal is instant on screen and the
 * network call is the part nobody waits for.
 */
export function recordUndo(ctx, label, undoFn) {
  undoStack.push(label, undoFn);
  /*
   * The single best reason to prefer this over Gmail used to be communicated
   * as a text SUFFIX: "Archived · Ctrl+Z to undo". A real button is what
   * people reach for in the half-second after a mistake, and the `undo` kind
   * gives the toast a drain line so the window is visible rather than guessed.
   *
   * The keyboard path is unchanged and still works for five minutes — far
   * longer than the toast. The `?` overlay says so.
   */
  ctx.toast(label, {
    kind: 'undo',
    action: { label: 'Undo', run: () => performUndo(ctx) },
  });
}

export async function performUndo(ctx) {
  try {
    const label = await undoStack.undo();
    if (!label) {
      ctx.toast('Nothing to undo', { kind: 'info' });
      return;
    }
    ctx.toast(`Undid: ${label}`, { kind: 'success' });
  } catch (err) {
    ctx.toast(err.message);
  }
}
