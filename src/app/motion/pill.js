/**
 * Active-category pill glide (directive §5 choreography; animation overhaul P5).
 *
 * THE OBJECT READ: there is exactly ONE active-category fill in the rail.
 * When the user switches categories the fill does not fade out there and
 * fade in here — it is the SAME physical object sliding to its new home,
 * riding a PANEL spring with the button's own accent rail on its back.
 *
 * The fill LIVES on the pill: `.has-pill` strips the active button's own
 * background, so the surface can never double-render. Without JS (or on a
 * hard failure) `.has-pill` is never added and the buttons keep their
 * declarative active style — the morph is pure progressive enhancement.
 *
 * Doctrines honoured:
 *  - reduced motion and an absent frame clock both SNAP (state is still
 *    true; the pixels simply skip the journey — P2 park doctrine)
 *  - same category re-synced on a count refresh: nothing happens (the hot
 *    path of renderSidebar costs one box read and zero writes)
 *  - same category, moved box (resize/scroll/font load): instant realign —
 *    a fill slid to a place it already occupies is a phantom flight
 *  - category hidden (rail away/offscreen): the pill retracts; its next
 *    appearance is a snap, never a flight from a stale pose
 *  - mid-flight re-targets continue from the LIVE interpolated pose
 */

import { SPRINGS, reducedMotion } from './tokens.js';
import { animateValue } from './spring.js';

/** Per-group pill state. WeakMap: a rebuilt rail GCs its pill silently. */
const yours = new WeakMap();

function lerp(a, b, t) { return a + (b - a) * t; }
function lerpBox(a, b, t) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) };
}

function writeBox(pill, b) {
  pill.style.display = '';
  pill.style.width = `${b.w.toFixed(2)}px`;
  pill.style.height = `${b.h.toFixed(2)}px`;
  pill.style.transform = `translate3d(${b.x.toFixed(2)}px, ${b.y.toFixed(2)}px, 0)`;
}

/**
 * Sync the pill to the active category button.
 *
 * @param {Element} group  the positioned container the pill lives in (#cat-group)
 * @param {Element|null} btn  the currently-active `.cat` button, or null
 * @param {string} key  identity of `btn` (its dataset.cat) — the pill tracks
 *   identity, not nodes: a re-rendered button with the same key is a no-op
 */
export function syncPill(group, btn, key) {
  if (!group) return;
  let st = yours.get(group);
  if (!st) {
    const pill = document.createElement('div');
    pill.className = 'cat-pill';
    pill.setAttribute('aria-hidden', 'true');
    // First child: with equal z-index the later buttons paint over the fill.
    group.prepend(pill);
    group.classList.add('has-pill');
    st = { pill, key: null, handle: null, from: null, to: null, t: 0 };
    yours.set(group, st);
  }

  const retract = () => {
    if (st.handle) { st.handle.cancel(); st.handle = null; }
    st.key = null; // re-emergence is a snap, never a flight from a stale pose
    st.pill.style.display = 'none';
  };

  // offsetParent is both the visibility probe and (with the positioned
  // group) the guarantee that offset coordinates and the pill share space.
  if (!btn || btn.offsetParent === null) { retract(); return; }

  const to = { x: btn.offsetLeft, y: btn.offsetTop, w: btn.offsetWidth, h: btn.offsetHeight };
  if (to.w === 0 || to.h === 0) { retract(); return; } // zero frame: nothing honest to fill

  if (st.key === key && st.to &&
      Math.abs(st.to.x - to.x) < 0.5 && Math.abs(st.to.y - to.y) < 0.5 &&
      Math.abs(st.to.w - to.w) < 0.5 && Math.abs(st.to.h - to.h) < 0.5) {
    return; // identical identity, identical pose — the count-refresh hot path
  }

  const snap = () => {
    if (st.handle) { st.handle.cancel(); st.handle = null; }
    st.from = to; st.to = to; st.t = 1; st.key = key;
    writeBox(st.pill, to);
  };

  const clockless = typeof requestAnimationFrame !== 'function';
  if (reducedMotion() || clockless || st.key === null) { snap(); return; }
  if (st.key === key) { snap(); return; } // same home, new geometry: realign, don't fly

  // Mid-flight retarget: continue from the LIVE pose, not the last airport.
  const from = st.handle ? lerpBox(st.from, st.to, st.t) : st.to;
  st.from = from; st.to = to; st.t = 0; st.key = key;
  if (st.handle) st.handle.cancel();
  st.handle = animateValue({
    from: 0,
    to: 1,
    preset: SPRINGS.PANEL,
    onUpdate: (t) => { st.t = t; writeBox(st.pill, lerpBox(from, to, t)); },
    onRest: () => { st.handle = null; st.t = 1; writeBox(st.pill, to); },
  });
}

/** Test seam. */
export function _pillForTest(group) { return yours.get(group); }
