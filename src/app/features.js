/**
 * Feature layer — a barrel, not a module.
 *
 * WHAT THIS FILE USED TO BE
 * -------------------------
 * One file holding undo, the deadline radar, the command palette, compose and
 * contact autocomplete. The complexity audit measured every module-level
 * binding in it against the section it was used in and found **zero crossing a
 * boundary**: it was five independent modules sharing a filename, not one
 * cohesive layer. Nothing was entangled; they were merely adjacent.
 *
 * Each now lives in its own file. This re-exports them so every existing
 * importer keeps working -- turning a mechanical move into a rename of a
 * dozen public functions would have made a safe change risky for no gain.
 *
 * The `ctx` contract they all share is documented here because it is the one
 * thing genuinely common to all five: features talk to the app through an
 * explicit object rather than reaching into its internals, which is what keeps
 * the render invariant enforceable in one place.
 *
 * @typedef {Object} Ctx
 * @property {import('./store.js').Store} store
 * @property {(type:string, extra?:object)=>Promise<any>} send
 * @property {(text:string)=>void} toast
 * @property {(id:string)=>void} openMessage
 * @property {()=>void} rerender
 * @property {object} state
 */

export { undoStack, recordUndo, performUndo } from './undo-actions.js';
export { renderRadar, wireRadar } from './radar.js';
export {
  openPalette, closePalette, wirePalette, refreshLabels, _setLabels, labelNames,
} from './palette.js';
export {
  openCompose, closeCompose, wireCompose, startReply, editDraft,
  restoreDraftIfAny, flushDraft,
} from './compose.js';
export { wireAutocomplete, refreshContacts } from './autocomplete.js';

import { _resetPalette } from './palette.js';
import { _resetCompose } from './compose.js';
import { _resetContacts } from './autocomplete.js';

/**
 * Test seam: drop the module state of every feature module.
 *
 * Kept as one call because the harness wants one call, but each module now
 * resets ITSELF -- this function no longer knows what a palette layer or a
 * draft saver is. That was the whole point of the split.
 */
export function _resetFeatureState() {
  _resetPalette();
  _resetCompose();
  _resetContacts();
}
