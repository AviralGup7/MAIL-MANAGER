/**
 * The sidebar rail — mailboxes, categories, freshness.
 *
 * RESPONSIBILITY  Build the two navigation groups once, keep their counts,
 *                 mute states, aria-current marks and roving tabindex honest
 *                 on every render, paint the freshness stamp, and own the
 *                 rail's keyboard/click/context-menu wiring.
 * OWNS            #cats contents, #freshness text, document.title's unread
 *                 stamp.
 * DOES NOT OWN    the stores or their per-mailbox load state (shell maps,
 *                 passed in), category rules (shell state read via ctx), the
 *                 saved-views rail, the snoozed/outbox rails (rails.js).
 * DEPENDS ON      injected ctx (see wireSidebar) + list.js (setCount,
 *                 collapseThreads — the rail must count what the list shows),
 *                 mailboxes.js, rules.js, display.js, icons.js, dom.js, the
 *                 category vocabulary.
 *
 * Extracted in the round-52 workspace sequence (map audits/51 §6 step 5).
 * Depends on list.js, never the reverse.
 */

import { MAILBOXES, showsCategories } from '../mail/mailboxes.js';
import { isMuted } from '../mail/rules.js';
import * as settings from '../system/settings.js';
import { SIDEBAR_ORDER, CATEGORY_LABELS, MUTED_CATEGORIES } from '../../classify/categories.js';
import { CAT_COLOR } from '../core/display.js';
import { icon } from '../core/icons.js';
import { setText } from '../core/dom.js';
import { setCount, collapseThreads } from '../mail/list.js';
import { syncPill } from '../motion/pill.js';

/** Set by wireSidebar at boot. */
let ctx = null;
let el = null;
let state = null;
let storeOf = null;

/**
 * Wire the rail to the shell. Called once, at boot, BEFORE buildSidebar.
 *
 * @param {Object} c
 * @param {()=>import('../mail/store.js').Store} c.store  live store getter
 * @param {Object} c.state          shared app state
 * @param {Object} c.el             cached DOM map
 * @param {Map} c.stores            every mailbox's store (stable reference)
 * @param {Map} c.mailboxState      per-mailbox load state (stable reference)
 * @param {()=>Object} c.getRules   category rules, shell-owned
 * @param {(id:string)=>Promise<void>} c.selectMailbox
 * @param {(key:string)=>void} c.selectCategory
 * @param {(cat:string, anchor:Element)=>void} c.openCategoryMenu
 */
export function wireSidebar(c) {
  ctx = c;
  el = c.el;
  state = c.state;
  // WRAP, DO NOT RESOLVE: live across mailbox switches, like every tenant.
  storeOf = () => c.store;

  el.cats.addEventListener('keydown', (e) => {
    // Query for the buttons rather than reading `children`: the rail is now
    // grouped into mailboxes and categories, so the buttons are grandchildren.
    // Reading `children` here silently returned two wrapper divs and killed
    // arrow navigation entirely.
    const items = [...el.cats.querySelectorAll('.cat')];
    const i = items.indexOf(document.activeElement);
    if (i === -1) return;
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else return;
    e.preventDefault();
    // Move focus without selecting. Selecting on arrow would fire a render per
    // keypress and fight the user as they scan for the category they want.
    items[i].tabIndex = -1;
    items[next].tabIndex = 0;
    items[next].focus();
  });

  el.cats.addEventListener('click', (e) => {
    const b = e.target.closest('.cat');
    if (!b) return;
    if (b.dataset.mailbox) ctx.selectMailbox(b.dataset.mailbox);
    else ctx.selectCategory(b.dataset.cat);
  });

  /*
   * Right-click a category to mute or auto-archive it.
   *
   * This is the feature Gmail structurally cannot offer: it does not know what
   * "Ext Promotions" or "Clubs" means. Reached by context menu because it is a
   * per-category setting, and the category button is the obvious place to look
   * for it -- but it is also in the command palette, so it is not mouse-only.
   */
  el.cats.addEventListener('contextmenu', (e) => {
    const b = e.target.closest('.cat[data-cat]');
    if (!b || b.dataset.cat === 'all') return;
    e.preventDefault();
    ctx.openCategoryMenu(b.dataset.cat, b);
  });
}

/** Built once; afterwards only the count text is touched. */
export function buildSidebar() {
  const frag = document.createDocumentFragment();

  /*
   * MAILBOXES FIRST, then the BITS categories.
   *
   * Two distinct kinds of navigation in one rail needs a visible boundary, or
   * "Sent" reads as though it were another category of inbox mail. The
   * mailbox group is where every mail user looks first, so it goes on top.
   */
  const mbGroup = document.createElement('div');
  mbGroup.className = 'rail-group';
  for (const mb of MAILBOXES) {
    mbGroup.appendChild(mailboxButton(mb));
  }
  frag.appendChild(mbGroup);

  const catGroup = document.createElement('div');
  catGroup.className = 'rail-group';
  catGroup.id = 'cat-group';
  const heading = document.createElement('h2');
  heading.className = 'rail-heading';
  heading.textContent = 'Categories';
  catGroup.appendChild(heading);
  catGroup.appendChild(catButton('all', 'All mail', null));
  for (const cat of SIDEBAR_ORDER) {
    catGroup.appendChild(catButton(cat, CATEGORY_LABELS[cat] || cat, CAT_COLOR[cat]));
  }
  frag.appendChild(catGroup);

  el.cats.replaceChildren(frag);
}

function mailboxButton(mb) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cat mailbox';
  b.dataset.mailbox = mb.id;
  b.setAttribute('aria-current', String(state.mailbox === mb.id));
  b.tabIndex = state.mailbox === mb.id ? 0 : -1;

  const ic = document.createElement('span');
  ic.className = 'mb-icon';
  ic.appendChild(icon(MAILBOX_ICON[mb.id] || 'mail'));

  const name = document.createElement('span');
  name.className = 'cat-name';
  name.textContent = mb.label;

  const count = document.createElement('span');
  count.className = 'cat-count';

  b.append(ic, name, count);
  return b;
}

/** Icon per mailbox, from the existing 14-icon set. */
const MAILBOX_ICON = {
  inbox: 'mail',
  snoozed: 'clock',
  sent: 'reply',
  drafts: 'compose',
  starred: 'star',
  spam: 'warning',
  trash: 'trash',
};

function catButton(key, label, color) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cat' + (MUTED_CATEGORIES.has(key) ? ' muted' : '');
  b.dataset.cat = key;
  b.setAttribute('aria-current', String(state.category === key));
  // Roving tabindex: only the CURRENT category is tabbable. Sixteen separate
  // tab stops for one navigation list means a keyboard user traverses the
  // whole sidebar to reach the message list.
  b.tabIndex = state.category === key ? 0 : -1;
  const dot = document.createElement('span');
  dot.className = 'dot';
  if (color) dot.style.setProperty('--c', color);
  const name = document.createElement('span');
  name.className = 'cat-name';
  name.textContent = label;
  const count = document.createElement('span');
  count.className = 'cat-count';
  b.append(dot, name, count);
  return b;
}

/**
 * "Updated 2 min ago", in the product's dry register.
 *
 * Exported shape is a pure function of (then, now) so it can be tested
 * without faking a clock. Deliberately coarse: nobody needs seconds, and a
 * figure that changes every second is a distraction pretending to be
 * information.
 *
 * @param {number} then  epoch ms of the last successful sync, 0 for never
 * @param {number} now   epoch ms
 */
function freshnessLabel(then, now) {
  if (!then) return '';
  const secs = Math.max(0, Math.round((now - then) / 1000));
  // Under a minute reads as "just now" rather than "0 min ago", which looks
  // like a bug even though it is arithmetically correct.
  if (secs < 45) return 'Updated just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `Updated ${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `Updated ${hrs} hr${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `Updated ${days} day${days === 1 ? '' : 's'} ago`;
}

function renderFreshness() {
  if (!el.freshness) return;
  setText(el.freshness, freshnessLabel(state.lastSync, Date.now()));
}

export function renderSidebar() {
  renderFreshness();
  const counts = storeOf().counts();
  const unread = storeOf().unreadCounts();
  let totalUnread = 0;
  for (const n of Object.values(unread)) totalUnread += n;

  /*
   * POLISH 19: the tab is where a student looks when the app is buried.
   * A parenthesised count is the one glanceable unread convention that
   * survives every mail client, so the tab agrees with the rail instead
   * of staying frozen at the app name.
   */
  document.title = totalUnread
    ? `(${totalUnread}) BITS Mail Manager`
    : 'BITS Mail Manager';

  // querySelectorAll, not `children`: the rail is grouped now, so the buttons
  // are grandchildren and `children` would iterate two wrapper divs.
  for (const b of el.cats.querySelectorAll('.cat')) {
    const countEl = b.lastElementChild;

    // Mute state must be visible where it is managed (round 46 #28).
    if (b.dataset.cat) b.dataset.muted = String(ctx.getRules().muted.includes(b.dataset.cat));

    if (b.dataset.mailbox) {
      // A mailbox shows the count of what IT holds, from its own store, and
      // only once loaded -- showing "0" for a mailbox never opened would
      // assert something we have not checked.
      const id = b.dataset.mailbox;
      const s = ctx.stores.get(id);
      const loaded = ctx.mailboxState.get(id)?.loaded;
      // `null` total means "never opened", which renders nothing -- showing
      // "0" for a mailbox we have not fetched would assert something untrue.
      let un = 0;
      let total = null;
      if (id === state.mailbox || loaded) {
        un = s ? sumUnread(s) : 0;
        /*
         * COUNT WHAT THE USER CAN SEE, not what the store holds.
         *
         * `s.size` is the raw message count. With threading on, the list
         * shows one row per CONVERSATION -- so a real inbox displayed
         * "Inbox 32 48" in the rail beside "All mail 44" in the list header.
         * Both numbers were correct and they measured different things,
         * which reads as an arithmetic bug in the product.
         *
         * The rail sits next to the list, so it must agree with the list.
         */
        total = s
          ? (settings.get('threaded') ? s.rootIds().length : s.size)
          : 0;
      }
      setCount(countEl, un, total);
      b.setAttribute('aria-current', String(state.mailbox === id));
      continue;
    }

    const key = b.dataset.cat;
    const u = key === 'all' ? totalUnread : unread[key] || 0;
    /*
     * POLISH 14: a deadline view in the red is a different animal from an
     * inbox with unread mail. The count earns the urgency colour; nothing
     * else moves.
     */
    b.classList.toggle('hot-danger', key === 'sv-overdue' && u > 0);
    b.classList.toggle('hot-warm', key === 'sv-week' && u > 0);
    /*
     * Same rule as the mailboxes above: count CONVERSATIONS when the list is
     * showing conversations, or the rail disagrees with the header beside it.
     * `collapseThreads` is the one place that decision is made, so it is the
     * one place to ask.
     */
    const t = collapseThreads(
      key === 'all' ? storeOf().idsFor('all') : storeOf().idsFor(key)
    ).length;
    /*
     * SHOW BOTH COUNTS, not just the unread one.
     *
     * This used to render `u ? u : t` — the unread count when non-zero, and
     * the total only when everything was read. A category holding 3 unread
     * and 40 read therefore displayed "3", which reads as "there are three
     * messages here". Read mail was always in the list, but the rail said
     * otherwise, and the rail is what people scan.
     *
     * Now both numbers are always present -- see setCount, which renders them
     * as two differently-weighted spans rather than a slash-joined string.
     */
    setCount(countEl, u, t);
    b.setAttribute('aria-current', String(state.category === key));
    // A muted category is dimmed and says so, so the rule is discoverable
    // from the place it applies rather than only from a settings page.
    const muted = isMuted(ctx.getRules(), key);
    b.classList.toggle('is-muted', muted);
    if (muted) b.title = `${CATEGORY_LABELS[key] || key} is muted — hidden from the inbox list`;
    else if (b.title) b.removeAttribute('title');
  }

  /*
   * ONE tab stop for the WHOLE rail.
   *
   * Setting tabIndex per group gave two stops -- the current mailbox and the
   * current category -- which is the exact bug the roving tabindex was
   * introduced to remove, reintroduced by splitting the rail in two. The
   * single stop is the ACTIVE mailbox, or the active category when the
   * category rail is the meaningful one.
   */
  const buttons = [...el.cats.querySelectorAll('.cat')];
  const preferred =
    (showsCategories(state.mailbox) &&
      buttons.find((b) => b.dataset.cat === state.category)) ||
    buttons.find((b) => b.dataset.mailbox === state.mailbox) ||
    buttons[0];
  for (const b of buttons) b.tabIndex = b === preferred ? 0 : -1;

  /*
   * PILL GLIDE (animation P5): the active-category fill is one physical
   * object that slides to its new button on a spring, instead of blinking
   * off here and on there. Synced AFTER every aria-current is final above —
   * the pill must track state, never lead it. Cheap steering: syncPill's
   * same-key hot path is one box read, so count-refresh renders cost
   * nothing. The module owns reduced-motion snaps and retraction when the
   * rail is away; without JS running it, .has-pill is never added and the
   * buttons keep their declarative fill.
   */
  const catGroup = el.cats.querySelector('#cat-group');
  const activeCat = buttons.find((b) => b.dataset.cat === state.category) || null;
  syncPill(catGroup, activeCat, activeCat?.dataset.cat);
}

function sumUnread(s) {
  if (!s) return 0;
  let n = 0;
  for (const v of Object.values(s.unreadCounts())) n += v;
  return n;
}
