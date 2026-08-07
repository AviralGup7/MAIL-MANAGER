/**
 * The shared menu primitive.
 *
 * WHY THIS EXISTS
 * ---------------
 * The complexity audit measured three hand-rolled menus in app.js -- category
 * rules, recategorise, snooze -- each rebuilding the same container, the same
 * `role="menu"` wiring, the same arrow-key/Escape handler and the same
 * `openLayer` call. Three copies of the identical
 * `items[(i + 1) % items.length]` loop.
 *
 * A fourth menu would have been a fourth copy, and a keyboard fix would have
 * had three places to miss. These tests pin the behaviour the three copies
 * agreed on, so the helper cannot quietly drop one of them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

/** A fresh document with an anchor to hang the menu off. */
function setup() {
  const dom = new JSDOM('<button id="anchor">open</button><div id="reader"></div>');
  const prev = {};
  for (const k of ['window', 'document', 'HTMLElement', 'Node']) prev[k] = globalThis[k];
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  return {
    dom,
    doc: dom.window.document,
    restore() {
      Object.assign(globalThis, prev);
      try { dom.window.close(); } catch { /* best effort */ }
    },
  };
}

const load = async () => {
  const m = await import('../src/app/menu.js?t=' + Math.random());
  return m;
};

test('MENU: builds a labelled menu of buttons', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, restore } = setup();
  try {
    const { openMenu } = await load();
    openMenu({
      name: 'test-menu',
      label: 'Snooze until',
      anchor: doc.getElementById('anchor'),
      items: [
        { text: 'Later today', trailing: '4:00 PM', run() {} },
        { text: 'Tomorrow', trailing: '9:00 AM', run() {} },
      ],
    });

    const node = doc.querySelector('.snooze-menu');
    assert.ok(node, 'a menu must be rendered');
    assert.equal(node.getAttribute('role'), 'menu');
    assert.equal(
      node.getAttribute('aria-label'), 'Snooze until',
      'a menu with no name is unusable with a screen reader'
    );

    const opts = [...node.querySelectorAll('.snooze-opt')];
    assert.equal(opts.length, 2);
    assert.equal(opts[0].tagName, 'BUTTON', 'items must be natively focusable');
    assert.equal(opts[0].getAttribute('role'), 'menuitem');
    assert.match(opts[0].textContent, /Later today/);
    assert.match(opts[0].textContent, /4:00 PM/, 'the trailing hint must render');
  } finally {
    restore();
  }
});

test('MENU: a checkable item reports its state', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The category-rules menu uses menuitemcheckbox with aria-checked; the
   * snooze menu uses plain menuitem. Both shapes must survive the merge --
   * flattening them to one role would either lie about the toggles or add a
   * meaningless aria-checked to every snooze option.
   */
  const { doc, restore } = setup();
  try {
    const { openMenu } = await load();
    openMenu({
      name: 'test-menu',
      label: 'AUGSD rules',
      anchor: doc.getElementById('anchor'),
      items: [
        { text: 'Mute AUGSD', hint: 'Hide from the inbox', checked: true, run() {} },
        { text: 'Auto-archive AUGSD', hint: 'Archive on arrival', checked: false, run() {} },
      ],
    });

    const opts = [...doc.querySelectorAll('.snooze-opt')];
    assert.equal(opts[0].getAttribute('role'), 'menuitemcheckbox');
    assert.equal(opts[0].getAttribute('aria-checked'), 'true');
    assert.equal(opts[1].getAttribute('aria-checked'), 'false');
    assert.match(opts[0].textContent, /Hide from the inbox/, 'the hint must render');
  } finally {
    restore();
  }
});

test('MENU: arrows wrap in both directions and Escape dismisses', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * This handler existed in three identical copies. Wrapping at BOTH ends is
   * the part most likely to be got wrong in a re-implementation: ArrowUp from
   * the first item must land on the last, not do nothing.
   */
  const { doc, dom, restore } = setup();
  try {
    const { openMenu } = await load();
    openMenu({
      name: 'test-menu',
      label: 'Menu',
      anchor: doc.getElementById('anchor'),
      items: [
        { text: 'One', run() {} },
        { text: 'Two', run() {} },
        { text: 'Three', run() {} },
      ],
    });

    const node = doc.querySelector('.snooze-menu');
    const opts = [...node.querySelectorAll('.snooze-opt')];
    assert.equal(doc.activeElement, opts[0], 'the first item takes focus on open');

    const key = (k) => node.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true })
    );

    key('ArrowDown');
    assert.equal(doc.activeElement, opts[1]);
    key('ArrowUp');
    assert.equal(doc.activeElement, opts[0]);
    key('ArrowUp');
    assert.equal(doc.activeElement, opts[2], 'ArrowUp from the first must wrap to the last');
    key('ArrowDown');
    assert.equal(doc.activeElement, opts[0], 'and ArrowDown from the last back to the first');

    key('Escape');
    assert.equal(doc.querySelector('.snooze-menu'), null, 'Escape must dismiss');
  } finally {
    restore();
  }
});

test('MENU: Escape does not also close whatever is underneath', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * All three copies called stopPropagation for the same reason: without it
   * one Escape closes the menu AND the reader behind it, which reads as the
   * app losing your place.
   */
  const { doc, dom, restore } = setup();
  try {
    const { openMenu } = await load();
    let leaked = 0;
    doc.addEventListener('keydown', () => { leaked += 1; });

    openMenu({
      name: 'test-menu',
      label: 'Menu',
      anchor: doc.getElementById('anchor'),
      items: [{ text: 'One', run() {} }],
    });

    doc.querySelector('.snooze-menu').dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    assert.equal(leaked, 0, 'Escape must not reach the document');
  } finally {
    restore();
  }
});

test('MENU: choosing an item runs it and closes first', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Close BEFORE run, which all three copies did. The action may open another
   * layer or re-render the list underneath; leaving a stale menu attached to
   * a node that is about to be replaced is how an orphan ends up in the layer
   * stack.
   */
  const { doc, restore } = setup();
  try {
    const { openMenu } = await load();
    let openAtRun = null;
    openMenu({
      name: 'test-menu',
      label: 'Menu',
      anchor: doc.getElementById('anchor'),
      items: [{
        text: 'Do it',
        run() { openAtRun = doc.querySelector('.snooze-menu'); },
      }],
    });

    doc.querySelector('.snooze-opt').click();
    assert.equal(openAtRun, null, 'the menu must be gone before the action runs');
  } finally {
    restore();
  }
});

test('MENU: opening a second menu replaces the first', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Two menus on screen at once is never intended, and each copy guarded
  // against it by calling its own close() first.
  const { doc, restore } = setup();
  try {
    const { openMenu } = await load();
    const open = (label) => openMenu({
      name: 'test-menu',
      label,
      anchor: doc.getElementById('anchor'),
      items: [{ text: 'x', run() {} }],
    });
    open('First');
    open('Second');

    const nodes = [...doc.querySelectorAll('.snooze-menu')];
    assert.equal(nodes.length, 1, 'only one menu may be open');
    assert.equal(nodes[0].getAttribute('aria-label'), 'Second');
  } finally {
    restore();
  }
});

test('MENU: an async action is awaited before the menu reports done', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // The category menu's actions are async (they persist rules). Dropping the
  // await would make a failed write invisible.
  const { doc, restore } = setup();
  try {
    const { openMenu } = await load();
    let ran = false;
    openMenu({
      name: 'test-menu',
      label: 'Menu',
      anchor: doc.getElementById('anchor'),
      items: [{
        text: 'Async',
        async run() {
          await Promise.resolve();
          ran = true;
        },
      }],
    });

    doc.querySelector('.snooze-opt').click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(ran, true, 'the async action must have completed');
  } finally {
    restore();
  }
});

test('MENU: an empty item list opens nothing', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // A menu with no choices is a dead surface that still traps focus and
  // swallows Escape. Better not to open at all.
  const { doc, restore } = setup();
  try {
    const { openMenu } = await load();
    const handle = openMenu({
      name: 'test-menu',
      label: 'Menu',
      anchor: doc.getElementById('anchor'),
      items: [],
    });
    assert.equal(handle, null);
    assert.equal(doc.querySelector('.snooze-menu'), null);
  } finally {
    restore();
  }
});

/* ========================================================================== *
 * THE FOURTH MENU
 *
 * The first cleanup pass unified three menus and declared the job done. It
 * missed a fourth: the theme picker in app.js, which built its own container,
 * its own `role="menu"`, its own openLayer call and its own arrow handler.
 *
 * The two implementations had ALREADY DRIFTED by the time it was found --
 * the theme menu supported Home/End, the primitive did not. That is not a
 * hypothetical risk of copy-paste; it is the drift, measured, in the same
 * codebase, within one pass. These tests pin the capabilities the theme menu
 * needs so the primitive can absorb it without losing behaviour.
 * ========================================================================== */

test('MENU: Home and End jump to the ends of the list', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The theme picker had these; the primitive did not. Absorbing the fourth
   * menu must not cost the user two keys that already worked -- a refactor
   * that quietly removes behaviour is a regression wearing a tidy hat.
   */
  const { doc, dom, restore } = setup();
  try {
    const { openMenu } = await load();
    openMenu({
      name: 'test-menu',
      label: 'Menu',
      anchor: doc.getElementById('anchor'),
      items: [
        { text: 'One', run() {} },
        { text: 'Two', run() {} },
        { text: 'Three', run() {} },
      ],
    });

    const node = doc.querySelector('.snooze-menu');
    const opts = [...node.querySelectorAll('.snooze-opt')];
    const key = (k) => node.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true })
    );

    key('End');
    assert.equal(doc.activeElement, opts[2], 'End must land on the last item');
    key('Home');
    assert.equal(doc.activeElement, opts[0], 'Home must land on the first item');
  } finally {
    restore();
  }
});

test('MENU: a radio item reports one-of-many, not on-or-off', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * Six themes are a one-of-many choice, so the theme picker used
   * `menuitemradio`. A checkbox says "this can be on or off independently";
   * a radio says "exactly one of these is current". Screen readers announce
   * them differently and the difference is the whole meaning of the menu, so
   * the primitive must carry all three roles, not two.
   */
  const { doc, restore } = setup();
  try {
    const { openMenu } = await load();
    openMenu({
      name: 'test-menu',
      label: 'Theme',
      anchor: doc.getElementById('anchor'),
      items: [
        { text: 'Daylight', selected: true, run() {} },
        { text: 'Midnight', selected: false, run() {} },
      ],
    });

    const opts = [...doc.querySelectorAll('.snooze-opt')];
    assert.equal(opts[0].getAttribute('role'), 'menuitemradio');
    assert.equal(opts[0].getAttribute('aria-checked'), 'true');
    assert.equal(opts[1].getAttribute('aria-checked'), 'false');
    assert.equal(
      opts[0].getAttribute('role') === 'menuitemcheckbox', false,
      'a one-of-many choice must not be announced as a checkbox'
    );
  } finally {
    restore();
  }
});

test('MENU: focus opens on the current item, not always the first', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * The theme picker focused the CURRENT theme on open, so the menu opens
   * where you already are. The primitive focused the first item always.
   * Absorbing the fourth menu without this would move the user's starting
   * point every time they opened the picker.
   */
  const { doc, restore } = setup();
  try {
    const { openMenu } = await load();
    openMenu({
      name: 'test-menu',
      label: 'Theme',
      anchor: doc.getElementById('anchor'),
      items: [
        { text: 'Daylight', selected: false, run() {} },
        { text: 'Nord', selected: true, run() {} },
        { text: 'Midnight', selected: false, run() {} },
      ],
    });

    const opts = [...doc.querySelectorAll('.snooze-opt')];
    assert.equal(doc.activeElement, opts[1], 'the current item takes focus on open');
  } finally {
    restore();
  }
});

test('MENU: a prefix node keeps its box', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * FOUND BY RENDERING THE MENU, NOT BY A TEST.
   *
   * The theme picker puts a 14px round swatch before each name. The primitive
   * wrapped the label in a plain inline <span>, and width/height do not apply
   * to an inline non-replaced element -- so every swatch collapsed and the
   * menu lost the colour that is the entire reason it is a menu rather than a
   * <select>. All 873 tests passed while it was broken.
   *
   * The wrapper now carries `.menu-label` so a caller can lay it out. This
   * pins the hook: without a class there is nothing for CSS to target and the
   * bug returns silently.
   */
  const { doc, restore } = setup();
  try {
    const { openMenu } = await load();
    const dot = doc.createElement('span');
    dot.className = 'theme-dot';

    openMenu({
      name: 'test-menu',
      label: 'Theme',
      anchor: doc.getElementById('anchor'),
      items: [{ text: 'Daylight', selected: true, prefix: dot, run() {} }],
    });

    const label = doc.querySelector('.snooze-opt .menu-label');
    assert.ok(label, 'the label wrapper must be addressable from CSS');
    assert.equal(label.firstElementChild, dot, 'the prefix leads the label');
    assert.equal(
      label.textContent, 'Daylight',
      'and the name still follows it'
    );
  } finally {
    restore();
  }
});
