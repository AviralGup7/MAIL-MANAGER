/**
 * Help overlay tenant (extracted per the architecture audit's tenant list).
 *
 * Owns exactly what is specific to help: render the shortcut table, reveal
 * the node, move focus in, and hand the layer lifecycle to layers.js. The
 * shell keeps the `?` key; it only imports these two functions.
 */
import { openLayer, closeWithMotion, cancelExit } from './layers.js';
import { renderShortcuts } from './shortcuts.js';

const $ = (id) => document.getElementById(id);

/** The open help layer, or null. Lifecycle belongs to layers.js. */
let helpLayer = null;

export function openHelp() {
  const help = $('help');
  if (!help || helpLayer) return;
  renderShortcuts($('help-body'), document);
  cancelExit(help);
  help.hidden = false;
  helpLayer = openLayer({
    name: 'help',
    node: help,
    onClose: () => {
      closeWithMotion(help);
      helpLayer = null;
    },
  });
  $('help-close')?.focus();
}

export function closeHelp() {
  helpLayer?.close();
}

export function helpOpen() {
  return !!helpLayer;
}

export function toggleHelp() {
  if (helpLayer) closeHelp();
  else openHelp();
}
