/**
 * Number tweens (directive §14; animation overhaul P2).
 *
 * Badges, unread counts and rail digits should communicate "the VALUE
 * changed", not "the old text was deleted and new text inserted". The tween
 * springs the numeric channel and re-renders through the ORIGINAL format —
 * prefix, suffix and digit grouping travel with the string, so "12 new"
 * stays "12 new" at every intermediate step.
 *
 * Pure text: the element's non-numeric decoration is re-anchored per frame
 * from the parsed pattern, never re-derived from style.
 */

import { SPRINGS } from './tokens.js';
import { animateValue } from './spring.js';

const NUM = /(-?\d[\d,]*(?:\.\d+)?)/;

/**
 * Spring the first number found in el.textContent toward `to`.
 *
 * @param {{textContent:string}} el  any text host (fake-able in tests)
 * @param {number} to
 * @param {Object} [opts]
 * @param {(n:number)=>string} [opts.render]  custom integerisation etc.
 * @param {Object} [opts.preset]
 * @returns {{running:()=>boolean, cancel:()=>void}}
 */
export function tweenNumber(el, to, opts = {}) {
  const text = el.textContent || '';
  const m = text.match(NUM);
  const preset = opts.preset || SPRINGS.SNAP;

  if (!m) {
    // Nothing to interpolate FROM: the honest move is to set the value with
    // no theatre — animating from an invented 0 would lie about history.
    el.textContent = renderWith(text, null, to, opts.render);
    return { running: () => false, cancel() {} };
  }

  const from = Number(m[1].replace(/,/g, ''));
  const hadCommas = m[1].includes(',');
  const fmt = (n) => {
    const r = opts.render ? opts.render(n) : defaultRender(n, from, to, hadCommas);
    return text.slice(0, m.index) + r + text.slice(m.index + m[1].length);
  };
  return animateValue({
    from,
    to,
    preset,
    onUpdate: (x) => { el.textContent = fmt(x); },
  });
}

/** Integers stay integers; a single decimal place survives if it existed. */
function defaultRender(x, from, to, hadCommas) {
  const decimals = Number.isInteger(from) && Number.isInteger(to) ? 0 : 1;
  const n = decimals ? x.toFixed(1) : String(Math.round(x));
  if (!hadCommas) return n;
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: decimals });
}

function renderWith(text, _m, to, render) {
  const r = render ? render(to) : String(to);
  const m = text.match(NUM);
  return m ? text.slice(0, m.index) + r + text.slice(m.index + m[1].length) : r;
}
