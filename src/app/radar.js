/**
 * The deadline radar: the "what is due" panel in the sidebar rail.
 *
 * Split out of features.js, which had grown to hold five unrelated things --
 * undo, radar, palette, compose and autocomplete. The complexity audit
 * measured every module-level binding in that file against the section it was
 * used in and found ZERO crossing a boundary, so these were five independent
 * modules sharing a filename rather than one cohesive layer.
 *
 * Reads the store through `ctx` and never reaches into app.js.
 */

import { relativeLabel, urgency } from './deadlines.js';

const $ = (id) => document.getElementById(id);

/* ========================================================================== *
 * DEADLINE RADAR
 * ========================================================================== */

const RADAR_MAX = 6;

/**
 * Render the "due soon" list.
 *
 * Only overdue / today / soon / week are shown. A deadline three weeks out is
 * true but not actionable, and padding the list with those is how a useful
 * panel becomes decoration people stop reading.
 */
export function renderRadar(ctx) {
  const wrap = $('radar');
  const list = $('radar-list');
  if (!wrap || !list) return;

  const now = Date.now();
  const items = [];

  /*
   * THE RADAR IS MULTI-SOURCE.
   *
   * It began as "messages with an extracted dueAt" and now merges three
   * things, which is the refactor the discovery audit identified as blocking
   * five separate features:
   *
   *   1. extracted deadlines, as before
   *   2. USER OVERRIDES -- a corrected date wins over the parser, and a
   *      dismissed one removes the entry entirely. Without this the panel
   *      keeps showing a date the user has explicitly said is wrong, which is
   *      how a useful surface becomes one people stop reading.
   *   3. FOLLOW-UPS -- "no reply yet", which is a deadline the user set on
   *      someone else rather than one imposed on them.
   *
   * `dueOf` is supplied by the shell rather than imported, so this module
   * still knows nothing about the override store.
   */
  const dueOf = ctx.dueAtOf || ((m) => m.dueAt);

  for (const id of ctx.store.idsFor('all')) {
    const m = ctx.store.get(id);
    if (!m) continue;
    const at = dueOf(m);
    if (typeof at !== 'number') continue;
    const u = urgency(at, now);
    if (u === 'later') continue;
    // Carry the effective date so the sort and the label agree with it.
    items.push({ m: { ...m, dueAt: at }, u });
  }

  for (const f of ctx.dueFollowups ? ctx.dueFollowups() : []) {
    const m = ctx.store.get(f.messageId);
    if (!m) continue;
    items.push({
      m: { ...m, dueAt: f.dueAt },
      u: urgency(f.dueAt, now),
      followup: true,
    });
  }

  if (items.length === 0) {
    wrap.hidden = true;
    list.replaceChildren();
    return;
  }

  items.sort((a, b) => a.m.dueAt - b.m.dueAt);

  /*
   * THE HEADING CARRIES THE COUNT AND THE WORST BAND.
   *
   * "Due soon" is the same visual weight as any other list, so the product's
   * cleverest feature reads as a filter. "Due soon · 1 overdue" says, in three
   * words, that something was read, understood and ranked.
   *
   * Only the worst band is named, and only when it is worse than "soon" --
   * naming every band turns a glance into a report.
   */
  const title = $('radar-title');
  if (title) {
    const overdue = items.filter((i) => i.u === 'overdue').length;
    const today = items.filter((i) => i.u === 'today').length;
    let suffix = '';
    if (overdue) suffix = ` · ${overdue} overdue`;
    else if (today) suffix = ` · ${today} today`;
    else suffix = ` · ${items.length}`;
    title.textContent = `Due soon${suffix}`;
  }

  const frag = document.createDocumentFragment();
  for (const { m, u } of items.slice(0, RADAR_MAX)) {
    const li = document.createElement('li');
    li.className = `radar-item radar-${u}`;
    li.dataset.id = m.id;
    li.setAttribute('role', 'button');
    li.tabIndex = 0;

    const when = document.createElement('span');
    when.className = 'radar-when';
    when.textContent = relativeLabel(m.dueAt, now);

    const what = document.createElement('span');
    what.className = 'radar-what';
    what.textContent = m.subject;
    /*
     * SHOW THE WORKING, in the tooltip rather than on the surface.
     *
     * `dueText` is the phrase the date was actually read from -- "last date
     * for submission", "submit by 14 Mar". Surfacing it converts "how did it
     * know that?" (uncanny) into "of course, it read the line" (trustworthy).
     *
     * It goes in the title, not in visible text, because this item is already
     * two columns in a narrow rail and the audit was explicit that this is the
     * one change at risk of reading as noise. A hover is opt-in.
     */
    what.title = m.dueText
      ? `${m.subject}\n\nDeadline read from: "${m.dueText}"`
      : m.subject;

    li.append(when, what);
    frag.appendChild(li);
  }
  list.replaceChildren(frag);
  wrap.hidden = false;
}

export function wireRadar(ctx) {
  const list = $('radar-list');
  if (!list) return;
  const open = (e) => {
    const li = e.target.closest('.radar-item');
    if (li) ctx.openMessage(li.dataset.id);
  };
  list.addEventListener('click', open);
  list.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open(e);
    }
  });
}
