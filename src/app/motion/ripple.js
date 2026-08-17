/**
 * Ripples (directive §24; animation overhaul P3).
 *
 * Energy propagation for significant presses: a bounded circle springs from
 * the press point, clipped by clip-path to the host's own border-radius —
 * the host's box, overflow and layout are NEVER touched, so nothing can
 * reflow (the roster's fixed-height doctrine survives).
 *
 * HARD BOUNDS (directive §42): at most POOL_MAX live ripples per host, each
 * self-collects on completion, none survives RIPPLE_MS + settle. Reduced
 * motion gets no ripple at all.
 */

import { SPRINGS, reducedMotion } from './tokens.js';
import { animateValue } from './spring.js';

const POOL_MAX = 3;
/** Wall-clock ceiling after which the span is collected even if frames stalled. */
const RIPPLE_MS = 700;

/**
 * Spawn a ripple on host at client point (x, y).
 *
 * @param {Element} host
 * @param {number} x clientX of the press
 * @param {number} y clientY of the press
 */
export function spawnRipple(host, x, y) {
  if (!host?.querySelectorAll) return;
  if (reducedMotion()) return;
  if (!host) return;

  // Pool discipline: trim the OLDEST before adding.
  const existing = host.querySelectorAll(':scope > span.mripple');
  if (existing.length >= POOL_MAX) existing[0].remove();

  const rect = host.getBoundingClientRect();
  const d = Math.max(rect.width, rect.height) * 2.4;
  const ox = Math.round(x - rect.left - d / 2);
  const oy = Math.round(y - rect.top - d / 2);
  const radius = getComputedStyle(host).borderRadius || '0px';

  const span = document.createElement('span');
  span.className = 'mripple';
  span.setAttribute('aria-hidden', 'true');
  span.style.cssText =
    `position:absolute;left:${ox}px;top:${oy}px;width:${d}px;height:${d}px;` +
    `border-radius:50%;pointer-events:none;background:currentColor;` +
    `opacity:0;transform:scale(0);`;
  // The circle overshoots the host on every side; clip it to the host's own
  // border box, rounded by the host's radius. Coordinates are span-local
  // (negative insets are legal — they extend beyond the span's box).
  span.style.clipPath = `inset(${-oy}px ${ox + d - rect.width}px ${oy + d - rect.height}px ${-ox}px round ${radius})`;

  // The span anchors to the host, so the host must be a positioning
  // context. Promoting a static host to relative moves NO pixels (relative
  // without offsets is layout-neutral); restore the prior inline value when
  // the last ripple dies.
  const computed = getComputedStyle(host);
  const hadInlinePosition = host.style.position;
  let promoted = false;
  if (computed.position === 'static') {
    host.style.position = 'relative';
    promoted = true;
  }

  host.appendChild(span);

  const collect = () => {
    span.remove();
    clearTimeout(kill);
    if (promoted && host.querySelectorAll(':scope > span.mripple').length === 0) {
      host.style.position = hadInlinePosition;
    }
  };
  const kill = setTimeout(collect, RIPPLE_MS + 400);

  animateValue({
    from: 0,
    to: 1,
    preset: SPRINGS.PANEL,
    onUpdate: (p) => {
      // Scale rides the spring tail; opacity decays ahead of it so the end
      // is a fade, not a pop-out.
      span.style.transform = `scale(${(p * 1.02).toFixed(4)})`;
      span.style.opacity = (0.32 * Math.max(0, 1 - p * 1.35)).toFixed(3);
    },
    onRest: collect,
  });
}
