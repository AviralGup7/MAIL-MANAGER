/**
 * Bulk bar tenant (extracted per the architecture audit).
 *
 * The bar's wiring -- icons, select-all, the five verbs, the Esc chip and
 * the new-mail pill -- is self-contained; the selection state and the verbs
 * themselves stay owned by the shell and arrive through ctx, because they
 * share `renderedIds`/`selection` with the render loop, which the audit
 * names as load-bearing state that must not move.
 */
import { setIcon } from '../core/icons.js';

const $ = (id) => document.getElementById(id);

export function wireBulkbar(ctx) {
  setIcon($('bulk-cancel'), 'close', { size: 14 });
  setIcon($('r-prev'), 'back', { size: 15 });
  setIcon($('r-next'), 'forward', { size: 15 });
  $('r-prev').addEventListener('click', () => ctx.move(-1));
  $('r-next').addEventListener('click', () => ctx.move(1));
  /*
   * Icon-only action buttons (audit 33). Five text verbs needed 423px in a
   * ~318px pane and left three of themselves unreachable; the icons reuse
   * the glyphs the context bar already uses for the same verbs, and the
   * labels live on aria-label/title in app.html. `warning` IS the spam
   * glyph -- the triangle, deliberately, because spam is a place you visit,
   * not an action you take.
   */
  setIcon($('bulk-read'), 'mail', { size: 15 });
  setIcon($('bulk-star'), 'star', { size: 15 });
  setIcon($('bulk-archive'), 'archive', { size: 15 });
  setIcon($('bulk-spam'), 'warning', { size: 15 });
  setIcon($('bulk-trash'), 'trash', { size: 15 });
  $('bulk-cancel').addEventListener('click', () => ctx.clearSelection());
  ctx.getBulkAll().addEventListener('change', () => {
    if (ctx.getBulkAll().checked) ctx.selectAll();
    else ctx.clearSelection();
    ctx.renderSelection();
  });
  for (const [id, kind] of [
    ['bulk-read', 'read'],
    ['bulk-star', 'star'],
    ['bulk-archive', 'archive'],
    ['bulk-spam', 'spam'],
    ['bulk-trash', 'trash'],
  ]) {
    $(id).addEventListener('click', () => ctx.bulkAct(kind));
  }
}
