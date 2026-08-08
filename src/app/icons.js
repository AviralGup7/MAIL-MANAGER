/**
 * The icon set.
 *
 * WHY THIS EXISTS
 * ---------------
 * The interface was mixing three hand-drawn SVGs with text glyphs used as
 * icons: `–` for minimise, `×` for close, `✓` for the theme tick, `★` for the
 * star, `📎` for attachments. That is the single most common tell of an
 * assembled interface, and it fails in three concrete ways:
 *
 *   1. A glyph renders in whatever font the platform picks. `×` is a
 *      MULTIPLICATION SIGN — it is a different weight, size and baseline on
 *      macOS, Windows and Linux, and it never optically matches a stroked SVG
 *      sitting beside it.
 *   2. `📎` is an emoji. On most systems it renders in full colour, which is
 *      wildly out of place in a monochrome toolbar and cannot be themed.
 *   3. Glyph metrics are unpredictable, so a glyph-in-a-button is never
 *      actually centred — it sits a pixel or two off, and every button
 *      containing one is subtly misaligned against its neighbours.
 *
 * DESIGN RULES, so anything added later matches:
 *   - 20×20 viewBox, 1.6 stroke, round caps and joins.
 *   - `currentColor` only. Never a hardcoded fill, so icons theme for free.
 *   - Optically centred, not mathematically — a triangle centred on its
 *     bounding box looks left-heavy.
 *   - Stroked, not filled, except where a filled shape carries meaning (the
 *     active star).
 */

/** @type {Record<string, string>} name -> inner SVG markup */
const PATHS = {
  compose: '<path d="M4 13.5V16h2.5l7.4-7.4-2.5-2.5L4 13.5Z"/><path d="M13.6 4.9 15.1 6.4"/>',
  refresh: '<path d="M16 10a6 6 0 1 1-1.8-4.3"/><path d="M16 4v3.2h-3.2"/>',
  search: '<circle cx="9" cy="9" r="5.2"/><path d="M12.9 12.9 17 17"/>',
  close: '<path d="M5.5 5.5 14.5 14.5"/><path d="M14.5 5.5 5.5 14.5"/>',
  minimise: '<path d="M5 10h10"/>',
  check: '<path d="M4.5 10.5 8 14l7.5-8"/>',
  // Filled when active, stroked when not — the one place a fill carries meaning.
  star: '<path d="M10 3.4l2.1 4.2 4.7.7-3.4 3.3.8 4.6L10 14l-4.2 2.2.8-4.6L3.2 8.3l4.7-.7L10 3.4Z"/>',
  archive: '<path d="M3.5 6.5h13v3h-13z"/><path d="M5 9.5v6.5h10V9.5"/><path d="M8.5 12.5h3"/>',
  trash: '<path d="M4.5 5.5h11"/><path d="M8 5.5V4h4v1.5"/><path d="M6 5.5 6.7 16h6.6L14 5.5"/>',
  mail: '<rect x="3" y="5" width="14" height="10" rx="2"/><path d="M3.6 6.2 10 10.6l6.4-4.4"/>',
  reply: '<path d="M8 5.5 3.5 9.5 8 13.5"/><path d="M3.5 9.5h6.8a5.2 5.2 0 0 1 5.2 5.2v.8"/>',
  attachment:
    '<path d="M14.5 9.3 9.6 14.2a3.1 3.1 0 0 1-4.4-4.4l5.3-5.3a2.1 2.1 0 0 1 2.9 2.9l-5.2 5.3a1 1 0 0 1-1.5-1.5l4.6-4.6"/>',
  palette:
    '<path d="M10 3a7 7 0 1 0 0 14c.8 0 1.4-.6 1.4-1.4 0-.4-.1-.7-.4-1a1.4 1.4 0 0 1 1-2.4h1.6A3.4 3.4 0 0 0 17 8.8C17 5.6 13.9 3 10 3Z"/><circle cx="7" cy="8.6" r=".9" fill="currentColor" stroke="none"/><circle cx="10" cy="6.6" r=".9" fill="currentColor" stroke="none"/><circle cx="13" cy="8.6" r=".9" fill="currentColor" stroke="none"/>',
  clock: '<circle cx="10" cy="10" r="6.5"/><path d="M10 6.3V10l2.6 1.6"/>',
  back: '<path d="M15.5 10h-11"/><path d="M8.5 5.5 4 10l4.5 4.5"/>',
  // Spam. A triangle rather than an octagon: the octagon reads as "stop /
  // destructive", and spam is a place you visit, not an action you take.
  warning:
    '<path d="M10 4.2 3.4 15.3h13.2L10 4.2Z"/><path d="M10 8.6v3.1"/><path d="M10 13.5h.01"/>',
};

/**
 * Build an icon element.
 *
 * Returns a real SVG node rather than an HTML string, so callers never
 * interpolate markup and there is no path by which an icon name could become
 * an injection point.
 *
 * @param {keyof PATHS} name
 * @param {{size?:number, filled?:boolean, className?:string}} [opts]
 */
export function icon(name, opts = {}) {
  const { size = 16, filled = false, className = '' } = opts;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', filled ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', filled ? '0' : '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (className) svg.setAttribute('class', className);
  svg.innerHTML = PATHS[name] || '';
  return svg;
}

/** Markup form, for the few places that build strings (the body iframe). */
export function iconMarkup(name, size = 16) {
  return (
    `<svg viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" ` +
    `stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`
  );
}

/** Replace a button's text glyph with a real icon, keeping its label. */
export function setIcon(el, name, opts) {
  if (!el) return;
  el.replaceChildren(icon(name, opts));
}

export const ICON_NAMES = Object.keys(PATHS);

/**
 * Shorten a filename from the MIDDLE, keeping the extension visible.
 *
 * CSS can only truncate at the end, which removes the highest-information part
 * of a filename. "Comprehensive_Examination_Timetable_Semester_II_FINAL.pdf"
 * becomes "Comprehensive_Examination_Time…" -- and on institutional mail,
 * where filenames are long, formulaic and differ only near the end, that
 * strips the discriminating information from every chip on screen.
 *
 * Finder, Mail.app and Slack all middle-truncate for this reason. Head and
 * tail both survive: "Comprehensive_Exam…_FINAL.pdf".
 *
 * Callers still set the full name as a `title`, so nothing is lost.
 *
 * @param {string} name
 * @param {number} [max] characters to keep before eliding
 */
export function middleTruncate(name, max = 34) {
  const s = String(name || '');
  if (s.length <= max) return s;

  /*
   * The tail is the extension plus enough of the stem to disambiguate. Sized
   * from the actual extension rather than fixed, so ".pdf" and ".pptx" both
   * survive intact instead of one of them losing a character.
   */
  const dot = s.lastIndexOf('.');
  const ext = dot > 0 && s.length - dot <= 8 ? s.slice(dot) : '';
  const tail = Math.min(12, ext.length + 6);
  const head = Math.max(4, max - tail - 1);

  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
