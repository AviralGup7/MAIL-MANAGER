/**
 * Row → reader identity morph (directive §5; animation overhaul P5).
 *
 * THE signature transition: opening a message flies the row's sender and
 * subject into the reader header. The SAME text is the SAME object — the
 * row's line is the reader's title, so the title is never "revealed", it
 * ARRIVES. Two text ghosts ride one PANEL spring each (position + font
 * size lerped; weight snaps only at the reveal frame, hidden behind it).
 *
 * Doctrine compliance (all pinned):
 *  - scan-gated by the CALLER (reader.js's 200ms rapid rule): j/k scanning
 *    skips the morph exactly like it skips the swap animation — arriving
 *    beats watching
 *  - SWAP IS THE FALLBACK, not a layer under it: when the morph flies, the
 *    swap class is withheld (one transition explains the open)
 *  - real surfaces keep state immediately: reader.hidden flips at once,
 *    texts write at once; only VISIBILITY of the two header targets is
 *    borrowed for the flight (a class, not a style war)
 *  - interruption-safe: abort() is synchronous and total (springs cancel,
 *    ghosts die, targets reveal) — fast-j mid-flight, Escape mid-flight,
 *    mailbox switch mid-flight all land clean
 *  - theatre never eats input: ghosts are pointer-events:none, aria-hidden,
 *    and die no later than their rest frame or a hard 1.2s fuse
 */

import { SPRINGS, reducedMotion } from './tokens.js';
import { animateValue } from './spring.js';

/** One in-flight morph at a time, module-owned. */
let flight = null;

const FUSE_MS = 1200;

function lerp(a, b, t) { return a + (b - a) * t; }

/** A single text ghost from sourceEl to destEl, on the shared spring. */
function spawnGhost(sourceEl, destEl, doc) {
  const sb = sourceEl.getBoundingClientRect();
  const db = destEl.getBoundingClientRect();
  if (sb.width === 0 || db.width === 0) return null; // scrolled out / unrevealed

  const sStyle = getComputedStyle(sourceEl);
  const dStyle = getComputedStyle(destEl);
  const ghost = doc.createElement('div');
  ghost.className = 'idghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.textContent = sourceEl.textContent;
  ghost.style.cssText =
    `position:fixed;left:0;top:0;margin:0;padding:0;border:0;` +
    `white-space:nowrap;overflow:hidden;pointer-events:none;` +
    `font-family:${sStyle.fontFamily};font-weight:${sStyle.fontWeight};` +
    `letter-spacing:${sStyle.letterSpacing};line-height:1.2;` +
    `color:${sStyle.color};z-index:220;transform-origin:0 0;`;
  doc.body.appendChild(ghost);

  return {
    ghost,
    from: { x: sb.left, y: sb.top, fs: parseFloat(sStyle.fontSize) || 13 },
    to: { x: db.left, y: db.top, fs: parseFloat(dStyle.fontSize) || 13 },
    write(t) {
      const x = lerp(this.from.x, this.to.x, t);
      const y = lerp(this.from.y, this.to.y, t);
      const fs = lerp(this.from.fs, this.to.fs, t);
      ghost.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
      ghost.style.fontSize = `${fs.toFixed(2)}px`;
    },
  };
}

/**
 * Abort any live flight, synchronously and totally. Idempotent. Exported
 * for readers of the reader: closeReader and mailbox switches call this
 * before doing their own work.
 */
export function abortRowIdentity() {
  if (!flight) return;
  for (const g of flight.ghosts) g.ghost.remove();
  flight.handle.cancel();
  clearTimeout(flight.fuse);
  flight.targets.forEach((t) => t.classList.remove('rmorph-hide'));
  flight = null;
}

/**
 * Fly the row's identity into the reader header.
 *
 * @param {string} rowDomId   element id of the source row
 * @param {Object} els        { subject, from } destinations (reader header)
 * @param {Document} [doc]
 * @returns {boolean} whether a flight actually started (caller falls back
 *   to the swap animation on false: row off-screen, reader hidden, etc.)
 */
export function flyRowIdentity(rowDomId, els, doc = globalThis.document) {
  abortRowIdentity(); // a new flight supersedes any airborne one — total reset
  if (reducedMotion()) return false;
  // No frame clock, no flight: an unschedulable spring's ghost would hang
  // for the fuse's whole 1.2s — a lying "true". Decline the same way
  // spring.js's animateValue does, so the swap plays instead (pin: the
  // rAF-absent decline in motion-reader-morph).
  if (typeof requestAnimationFrame !== 'function') return false;
  if (!doc) return false;

  const row = doc.getElementById(String(rowDomId));
  if (!row) return false;
  const srcFrom = row.querySelector('.r-from');
  const srcSubj = row.querySelector('.r-subj');
  if (!srcFrom || !srcSubj || !els?.from || !els?.subject) return false;
  if (row.offsetParent === null) return false; // display:none lists don't fly

  // The real header takes a flight-long step back (visibility, never hidden
  // — layout is touched by nothing).
  els.from.classList.add('rmorph-hide');
  els.subject.classList.add('rmorph-hide');

  const gFrom = spawnGhost(srcFrom, els.from, doc);
  const gSubj = spawnGhost(srcSubj, els.subject, doc);
  const ghosts = [gFrom, gSubj].filter(Boolean);
  if (ghosts.length === 0) {
    els.from.classList.remove('rmorph-hide');
    els.subject.classList.remove('rmorph-hide');
    return false; // nothing could be measured — honest decline, swap plays
  }

  const targets = [els.from, els.subject];
  const f = {
    ghosts,
    targets,
    fuse: 0,
    handle: animateValue({
      from: 0,
      to: 1,
      preset: SPRINGS.PANEL,
      onUpdate: (t) => { for (const g of ghosts) g.write(t); },
      onRest: land,
    }),
  };
  f.fuse = setTimeout(land, FUSE_MS); // settle-trigger safety — never a ghost left behind
  flight = f;

  function land() {
    if (flight !== f) return; // a newer flight or an abort already owns this
    clearTimeout(f.fuse);
    for (const g of f.ghosts) g.ghost.remove();
    for (const t of f.targets) t.classList.remove('rmorph-hide');
    flight = null;
  }
  return true;
}

/** Test seam. */
export function _flightForTest() { return flight; }
