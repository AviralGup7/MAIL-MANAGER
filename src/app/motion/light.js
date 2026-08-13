/**
 * The key light (directive §19; animation overhaul P6; spec §3.3).
 *
 * One virtual light source: the cursor. Its position is published as
 * `--lx`/`--ly` on the root element; `.lit` surfaces carry a whisper-alpha
 * radial at exactly that point, so a rail card, the palette and the compose
 * dialog all brighten toward the SAME source — one lighting model, not a
 * gradient per component.
 *
 * DELIBERATE GEOMETRY: the gradient rides `background-attachment: fixed`,
 * i.e. it is positioned in VIEWPORT space, because that is what makes one
 * light read as one light across seven independent boxes. During a camera
 * push (#shell scales ~1.5%) the fixed reference is re-based to the shell
 * for a few hundred ms — a sub-6px wander at the screen edge that
 * self-corrects at rest. Measured and accepted over the honest alternative
 * (per-host rects every frame = seven forced layouts per pointer frame).
 *
 * DISCIPLINE (mirrors magnetic.js, whose lesson file this is):
 *  - pointer:fine only — a thumb carries no light
 *  - reduced motion: the listener NEVER attaches; the :root default pose
 *    leaves a static, ambient sheen, which is the reduced truth of "there
 *    is a light here" without the tracking
 *  - one listener PER WINDOW (jsdom mints a window per test)
 *  - rAF-coalesced: N pointermove events in a frame = ONE pair of writes;
 *    the listener is free, the writes are the budget
 *  - no visible `.lit` host → flush writes nothing: motion coalescers must
 *    never spend on surfaces nobody can see
 *  - hosts are all [hidden]-gated in this product; visibility is read from
 *    the attribute, not offsetParent (jsdom does no layout, and the pin
 *    file must see the same truth the browser does)
 */

import { reducedMotion } from './tokens.js';

const mqFine =
  typeof globalThis.matchMedia === 'function'
    ? globalThis.matchMedia('(pointer: fine)')
    : null;

/** Test seams: force gates. null restores the live queries. */
let forcedFine = null;
export function _setLightFineForTest(v) { forcedFine = v; }

const pointerIsFine = () => (forcedFine !== null ? forcedFine : !!mqFine?.matches);

const listeningWins = new WeakSet();

let win = null;
let dirtyX = 0;
let dirtyY = 0;
let scheduled = false;

/** Test telemetry (the __targets precedent): counters, never state. */
export const __light = { frames: 0, writes: 0, skippedHidden: 0 };

function hosts(doc) {
  try {
    return [...doc.querySelectorAll('.lit')];
  } catch {
    return [];
  }
}

function anyVisible(doc) {
  return hosts(doc).some((el) => !el.closest('[hidden]'));
}

function flush() {
  scheduled = false;
  __light.frames++;
  const doc = win?.document;
  if (!doc) return;
  if (reducedMotion()) return; // OS toggle landed mid-session: stop tracking now
  if (!anyVisible(doc)) {
    __light.skippedHidden++;
    return;
  }
  const root = doc.documentElement;
  root.style.setProperty('--lx', `${Math.round(dirtyX)}px`);
  root.style.setProperty('--ly', `${Math.round(dirtyY)}px`);
  __light.writes++;
}

function onMove(e) {
  dirtyX = e.clientX;
  dirtyY = e.clientY;
  // Motion modules read the frame clock from their own realm (node tests
  // patch globalThis; the browser's globalThis IS the window). Absent a
  // clock — P4's honest-decline doctrine — the write happens immediately:
  // uncoalesced but exact, never silently dropped.
  if (typeof requestAnimationFrame !== 'function') {
    flush();
    return;
  }
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(flush);
  }
}

/**
 * Wire the key light for one document. Presence-gated and idempotent:
 * no `.lit` hosts → no listener; a second call on the same window is a
 * no-op — boot order may never double the plumbing.
 */
export function wireLight(root = globalThis.document) {
  if (!root) return;
  const w = root.defaultView;
  if (!w) return;
  if (reducedMotion() || !pointerIsFine()) return;
  if (hosts(root).length === 0) return; // gate/options pages carry no lit surface
  if (listeningWins.has(w)) return;
  listeningWins.add(w);
  win = w;
  w.addEventListener('pointermove', onMove, { passive: true });
}

/** Test seam: unregister a window (fresh jsdom per case must not leak). */
export function _resetLightForTest() {
  win?.removeEventListener?.('pointermove', onMove);
  win = null;
  scheduled = false;
  __light.frames = 0;
  __light.writes = 0;
  __light.skippedHidden = 0;
  // WeakSet has no delete-by-iteration; the windows it holds are per-test
  // jsdom realms that die with the test, so a stale membership is inert.
}
