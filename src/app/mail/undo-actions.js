/**
 * The undo stack, and recording an action into it.
 *
 * Named undo-actions.js because undo.js already exists and owns the UndoStack
 * data structure -- this is the app-facing half: what gets recorded, what the
 * toast says, and what happens when the reversal fails.
 */

import { UndoStack } from './undo.js';
import { registerReset } from '../core/reset-registry.js';

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
  if (!ctx || typeof undoFn !== 'function') return;
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

/**
 * Test seam: empty the stack between jsdom boots.
 *
 * `undoStack` is module-level, and main.js is the only module re-imported with
 * a cache-busting URL -- its imports keep their state. So without this every
 * test inherits the undo entries of every test before it, and a Ctrl+Z pops
 * a NEIGHBOUR'S entry and fires that test's verb.
 *
 * The same hazard is already handled for features.js, timetable-ui.js and
 * menu.js. This file was missed.
 */
function _resetUndo() {
  undoStack.clear();
}

// Self-registered test seam (reset-registry.js, roadmap M-2): cached module
// state must not outlive a cache-busted main.js re-import in the harness.
registerReset('undo', _resetUndo);
