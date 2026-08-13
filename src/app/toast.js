/**
 * RESPONSIBILITY: the single toast surface — show, announce, drain, hide.
 *
 * OWNS: the toast timer and the hide lifecycle.
 * DOES NOT OWN: the toast DOM nodes (injected; they live in app.html), the
 *   undo stack, any feature logic. `action.run` is supplied by the caller.
 * DEPENDS ON: dom.js (guarded writes), icons.js (kind icon), layers.js
 *   (cancelExit / closeWithMotion).
 *
 * WHY EXTRACTED (round 46 modular strategy): toast was the lowest-risk
 * cluster in app.js — one timer, one surface, called everywhere — so it
 * proves the extraction pattern (inject nodes, move the timer, keep the
 * callers' signature) before the bigger reader extraction.
 */
import { setText } from './dom.js';
import { setIcon } from './icons.js';
import { cancelExit, closeWithMotion } from './layers.js';

let el = null; // injected toast nodes
let toastTimer = 0;
// A toast fired before initToast (early boot, a boot-time error) used to be
// silently dropped. Queue at most one and replay it on init, so the first
// thing the app says is never lost to boot ordering.
let pendingEarly = null;

/** Called once at boot with the toast nodes from the shell's el map. */
export function initToast(nodes) {
  el = nodes;
  if (pendingEarly) {
    const [text, opts] = pendingEarly;
    pendingEarly = null;
    toast(text, opts);
  }
}

export function toast(text, opts = {}) {
  if (!el) {
    pendingEarly = [text, opts];
    return;
  }
  const kind = opts.kind || 'info';
  const ms = opts.ms || (kind === 'error' ? 4000 : kind === 'undo' ? 3600 : 2200);

  setText(el.toastText, text);
  el.toast.dataset.kind = kind;
  /*
   * ERRORS ARE ANNOUNCED, NOT MERELY SHOWN (round 45 Phase 2). role=alert is
   * assertive: an interruption the user must hear about, where 'polite'
   * could wait behind whatever the screen reader is mid-sentence. Every
   * other kind stays a polite status.
   */
  el.toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');

  /*
   * POLISH 7+11: the toast's kind is legible at a glance -- an icon names the
   * event and the undo chip names the recovery key. Both are decoration over
   * the live region, never inside it, so announcements stay clean.
   */
  const KIND_ICON = { success: 'check', error: 'warning', undo: 'back' };
  if (KIND_ICON[kind]) {
    setIcon(el.toastIcon, KIND_ICON[kind], { size: 14 });
    el.toastIcon.hidden = false;
  } else {
    el.toastIcon.hidden = true;
  }
  el.toastKbd.hidden = kind !== 'undo';

  const action = opts.action;
  el.toastAction.hidden = !action;
  if (action) {
    setText(el.toastAction, action.label);
    /*
     * THE NAME MUST FOLLOW THE TEXT (accessibility audit A-A1, AX-proven).
     * app.html ships aria-label="Undo" as the pre-JS name placeholder; an
     * explicit aria-label WINS over the visible text in name computation,
     * and this code only refreshed the text -- so the coach's "Got it" and
     * the outbox's "Show" both announced as "Undo" until this readonly
     * desync was measured in the live AX tree. Stamp the label on the name
     * channel too: what is spoken is what is shown.
     */
    el.toastAction.setAttribute('aria-label', action.label);
    el.toastAction.onclick = () => {
      hideToast();
      action.run();
    };
  } else {
    el.toastAction.onclick = null;
  }

  // Restart the drain from zero. Re-assigning the animation alone does not
  // replay it; the reflow between is what does.
  el.toastDrain.style.animation = 'none';
  void el.toastDrain.offsetWidth;
  el.toastDrain.style.animation = `toast-drain ${ms}ms linear forwards`;

  // Toasts re-fire constantly -- a second one inside the 140ms exit is
  // normal, not an edge case -- so the cancel matters more here than
  // anywhere else.
  cancelExit(el.toast);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}

export function hideToast() {
  if (!el) return;
  clearTimeout(toastTimer);
  closeWithMotion(el.toast);
  el.toastAction.hidden = true;
  el.toastAction.onclick = null;
}
