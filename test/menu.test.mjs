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
