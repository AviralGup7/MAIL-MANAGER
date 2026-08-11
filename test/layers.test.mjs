/**
 * Layer stack tests.
 *
 * The primitive replaced a nine-branch hand-maintained `Escape` ladder — the
 * only place in this codebase where correctness depended on the order
 * statements appeared in a function. These pin the properties that make the
 * stack a safe replacement for that ordering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const L = await import('../src/app/layers.js');

/** Minimal document stand-in; the primitive only needs these three members. */
function fakeDoc() {
  const listeners = [];
  return {
    activeElement: null,
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    _listeners: listeners,
  };
}

const el = (contains = () => false) => ({ contains, isConnected: true, focus() {} });

test('layers close last-in-first-out', () => {
  L._resetLayers();
  const doc = fakeDoc();
  const log = [];
  L.openLayer({ name: 'a', onClose: () => log.push('a') }, doc);
  L.openLayer({ name: 'b', onClose: () => log.push('b') }, doc);
  L.openLayer({ name: 'c', onClose: () => log.push('c') }, doc);

  assert.equal(L.layerCount(), 3);
  assert.equal(L.topLayerName(), 'c');

  L.closeTopLayer(doc);
  assert.deepEqual(log, ['c'], 'the newest layer closes first');
  assert.equal(L.topLayerName(), 'b');
});

test('a layer can be closed from the middle of the stack', () => {
  // A menu can be dismissed by an outside click while a dialog above it is
  // still open. Popping only the top would close the wrong thing.
  L._resetLayers();
  const doc = fakeDoc();
  const log = [];
  const a = L.openLayer({ name: 'a', onClose: () => log.push('a') }, doc);
  L.openLayer({ name: 'b', onClose: () => log.push('b') }, doc);

  a.close();
  assert.deepEqual(log, ['a']);
  assert.equal(L.topLayerName(), 'b', 'the layer above must survive');
  assert.equal(L.layerCount(), 1);
});

test('closing is idempotent', () => {
  // Overlays are closed from several directions — Escape, an outside click, a
  // button, a selection being made. Teardown must not run twice.
  L._resetLayers();
  const doc = fakeDoc();
  let closes = 0;
  const a = L.openLayer({ onClose: () => closes++ }, doc);
  a.close();
  a.close();
  a.close();
  assert.equal(closes, 1);
});

test('closeTopLayer reports whether it did anything', () => {
  // The shell relies on this to decide whether to keep unwinding into the
  // reader and then the takeover itself.
  L._resetLayers();
  const doc = fakeDoc();
  assert.equal(L.closeTopLayer(doc), false, 'nothing open');
  L.openLayer({ name: 'a' }, doc);
  assert.equal(L.closeTopLayer(doc), true);
  assert.equal(L.closeTopLayer(doc), false);
});

test('focus is captured on open and restored on close', () => {
  L._resetLayers();
  const doc = fakeDoc();
  let focused = 0;
  const trigger = { isConnected: true, focus: () => focused++ };
  doc.activeElement = trigger;

  const a = L.openLayer({ name: 'a' }, doc);
  assert.equal(focused, 0, 'nothing focused while open');
  a.close();
  assert.equal(focused, 1, 'focus returns to where it came from');
});

test('focus is not restored to a node that has left the document', () => {
  // After a re-render the original element may be gone; focusing a detached
  // node silently moves focus to <body>, which breaks the next keystroke.
  L._resetLayers();
  const doc = fakeDoc();
  let focused = 0;
  doc.activeElement = { isConnected: false, focus: () => focused++ };
  const a = L.openLayer({}, doc);
  a.close();
  assert.equal(focused, 0);
});

test('an explicit restoreFocusTo overrides the captured element', () => {
  // A menu should return focus to its trigger button, not to whatever
  // happened to be focused when it opened.
  L._resetLayers();
  const doc = fakeDoc();
  let onTrigger = 0;
  doc.activeElement = { isConnected: true, focus() {} };
  const trigger = { isConnected: true, focus: () => onTrigger++ };
  const a = L.openLayer({ restoreFocusTo: trigger }, doc);
  a.close();
  assert.equal(onTrigger, 1);
});

test('outside-click dismissal is opt-in and wired exactly once', () => {
  L._resetLayers();
  const doc = fakeDoc();
  L.openLayer({ name: 'plain' }, doc);
  assert.equal(doc._listeners.length, 0, 'no listener without the opt-in');

  // trap:false — this test pins the outside-click contract, and the fake
  // node carries no addEventListener for the focus trap to attach.
  const b = L.openLayer({ name: 'menu', node: el(), dismissOnOutsideClick: true, trap: false }, doc);
  assert.equal(doc._listeners.length, 1);
  assert.equal(doc._listeners[0].type, 'mousedown',
    'mousedown, not click: click fires after blur');
  assert.equal(doc._listeners[0].capture, true);

  b.close();
  assert.equal(doc._listeners.length, 0, 'the listener must be removed on close');
});

test('an outside click closes the layer; an inside click does not', () => {
  L._resetLayers();
  const doc = fakeDoc();
  const inside = {};
  const node = el((t) => t === inside);
  let closed = 0;
  L.openLayer({ node, dismissOnOutsideClick: true, onClose: () => closed++, trap: false }, doc);
  const handler = doc._listeners[0].fn;

  handler({ target: inside });
  assert.equal(closed, 0, 'a click inside must not dismiss');
  handler({ target: {} });
  assert.equal(closed, 1);
});

test('a throwing onClose still tears down its listener and restores focus', () => {
  // One broken overlay must not strand a document-level listener or leave
  // focus on <body> for the rest of the session.
  L._resetLayers();
  const doc = fakeDoc();
  let focused = 0;
  doc.activeElement = { isConnected: true, focus: () => focused++ };
  const a = L.openLayer({
    node: el(),
    dismissOnOutsideClick: true,
    trap: false, // the fake node has no addEventListener for the trap
    onClose: () => { throw new Error('boom'); },
  }, doc);

  assert.throws(() => a.close());
  assert.equal(doc._listeners.length, 0, 'listener leaked');
  assert.equal(focused, 1, 'focus was not restored');
  assert.equal(L.layerCount(), 0, 'the layer stayed on the stack');
});

test('closeAllLayers empties the stack outermost-last', () => {
  L._resetLayers();
  const doc = fakeDoc();
  const log = [];
  L.openLayer({ onClose: () => log.push('a') }, doc);
  L.openLayer({ onClose: () => log.push('b') }, doc);
  L.openLayer({ onClose: () => log.push('c') }, doc);
  assert.equal(L.closeAllLayers(doc), 3);
  assert.deepEqual(log, ['c', 'b', 'a']);
  assert.equal(L.hasLayers(), false);
});
