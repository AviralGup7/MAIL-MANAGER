/**
 * Cyberpunk interaction controller.
 *
 * Policy lives here; synthesis and finite visual state live in dedicated
 * modules. Two delegated listeners cover the whole app, semantic feedback
 * arrives through one custom event, and every path gates at play time.
 */

import { playCyberpunkCue, disposeCyberpunkAudio } from './cyberpunk-audio.js';
import { cyberpunkArrival, cyberpunkSignal, disposeCyberpunkMotion } from './cyberpunk-motion.js';

let wiredRoot = null;
let lastHover = 0;

function active() {
  if (typeof document === 'undefined') return false;
  const d = document.documentElement.dataset;
  return d.theme === 'cyberpunk';
}

const VOICED = 'button, [role="button"], [role="menuitem"], [role="option"], [role="tab"], a, input, select';

function targetOf(e) {
  const target = e.target;
  if (!target || typeof target.closest !== 'function') return null;
  const control = target.closest(VOICED);
  if (!control || control.disabled || control.getAttribute?.('aria-disabled') === 'true') return null;
  return control;
}

function onClick(e) {
  if (!active()) return;
  const control = targetOf(e);
  if (!control) return;
  const warning = control.classList?.contains('danger') || control.dataset?.act === 'trash';
  playCyberpunkCue(warning ? 'warning' : 'activate', { gesture: true, minGap: 28 });
  cyberpunkSignal(warning ? 'warning' : 'activate', 300);
}

function onHover(e) {
  if (!active() || !targetOf(e)) return;
  const now = Date.now();
  if (now - lastHover < 110) return;
  lastHover = now;
  playCyberpunkCue('navigate', { gesture: true, minGap: 90 });
}

function onFeedback(e) {
  if (!active()) return;
  const kind = e.detail?.kind;
  const cue = kind === 'success' ? 'success' : kind === 'error' ? 'error' :
    kind === 'undo' ? 'warning' : null;
  if (!cue) return;
  playCyberpunkCue(cue, { gesture: false, minGap: 80 });
  cyberpunkSignal(cue, cue === 'error' ? 500 : 380);
}

function onPageHide() {
  disposeCyberpunkMotion();
  void disposeCyberpunkAudio();
}

export function initCyberpunkFx(root = document) {
  if (wiredRoot === root) return;
  disposeCyberpunkFx();
  wiredRoot = root;
  root.addEventListener('click', onClick, true);
  root.addEventListener('pointerover', onHover, true);
  root.addEventListener('bmm:feedback', onFeedback);
  globalThis.addEventListener?.('pagehide', onPageHide, { once: true });
}

export function cyberpunkEnterFx() {
  if (!active()) return;
  cyberpunkArrival();
  // Called from the theme-picker click path, so context creation is legal.
  playCyberpunkCue('arrival', { gesture: true, minGap: 0 });
}

export function disposeCyberpunkFx() {
  if (wiredRoot) {
    wiredRoot.removeEventListener('click', onClick, true);
    wiredRoot.removeEventListener('pointerover', onHover, true);
    wiredRoot.removeEventListener('bmm:feedback', onFeedback);
  }
  wiredRoot = null;
  lastHover = 0;
  disposeCyberpunkMotion();
}

export function _resetCyberpunkFx() {
  disposeCyberpunkFx();
  void disposeCyberpunkAudio();
}
