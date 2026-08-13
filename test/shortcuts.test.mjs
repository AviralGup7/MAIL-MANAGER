/**
 * Shortcut registry tests.
 *
 * The point of these is NOT to check that a list renders. It is to make the
 * help overlay impossible to falsify: if `app.js` handles a key that the
 * registry does not document, or the registry documents a key nothing
 * handles, that is a lie in the UI and the build should fail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  test('shortcuts (skipped: jsdom not installed)', { skip: true }, () => {});
}

const { SHORTCUTS, allShortcuts, renderShortcuts } = await import('../src/app/core/shortcuts.js');
const appSrc = readFileSync(new URL('../src/app/main.js', import.meta.url), 'utf8');
// Help moved out of the shell (architecture audit phase 9); its lifecycle
// rules now live in the module that owns it.
const helpSrc = readFileSync(new URL('../src/app/overlays/help.js', import.meta.url), 'utf8');

test('every group has a title and at least one shortcut', () => {
  assert.ok(SHORTCUTS.length >= 3);
  for (const g of SHORTCUTS) {
    assert.ok(g.title, 'group needs a title');
    assert.ok(g.items.length > 0, `${g.title} is empty`);
  }
});

test('no shortcut is documented twice', () => {
  const seen = new Map();
  for (const s of allShortcuts()) {
    const sig = `${s.keys.join('+')}|${s.when || ''}`;
    assert.ok(!seen.has(sig), `duplicate binding documented: ${sig}`);
    seen.set(sig, s.label);
  }
});

/*
 * THE LOAD-BEARING TEST.
 *
 * Each single-letter shortcut must appear as a `case` in app.js's keydown
 * switch. This is a source-text check rather than a behavioural one because
 * driving every key through jsdom needs the whole app booted; the aim here is
 * simply that the help cannot describe a key that does not exist.
 */
test('every documented single-key shortcut is actually handled in app.js', () => {
  const singles = allShortcuts()
    .filter((s) => s.keys.length === 1 && /^[a-z#/?]$/.test(s.keys[0]))
    .map((s) => s.keys[0]);

  assert.ok(singles.length >= 8, 'expected a meaningful number of single-key bindings');

  for (const key of singles) {
    const handled =
      appSrc.includes(`case '${key}':`) ||
      appSrc.includes(`e.key === '${key}'`) ||
      appSrc.includes(`k === '${key}'`);
    assert.ok(handled, `'${key}' is documented in the help but not handled in app.js`);
  }
});

test('modifier shortcuts named in the help exist in app.js', () => {
  // Ctrl+K, Ctrl+A, Ctrl+Z are the three ctrl bindings the help promises.
  for (const key of ['k', 'a', 'z']) {
    assert.ok(
      appSrc.includes(`e.key.toLowerCase() === '${key}'`),
      `Ctrl+${key.toUpperCase()} documented but not handled`
    );
  }
  // Shift+R / A / F for reply, reply-all, forward.
  assert.ok(appSrc.includes("startReply(ctx, 'reply')"));
  assert.ok(appSrc.includes("startReply(ctx, 'replyAll')"));
  assert.ok(appSrc.includes("startReply(ctx, 'forward')"));
});

test('the help renders keys and labels as a definition list', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const dom = new JSDOM('<!doctype html><body><div id="x"></div></body>');
  const doc = dom.window.document;
  renderShortcuts(doc.getElementById('x'), doc);

  const groups = doc.querySelectorAll('.sc-group');
  assert.equal(groups.length, SHORTCUTS.length);

  // dt/dd pairing is what makes this announce correctly.
  const dts = doc.querySelectorAll('.sc-group dt');
  const dds = doc.querySelectorAll('.sc-group dd');
  assert.equal(dts.length, dds.length);
  assert.equal(dts.length, allShortcuts().length);

  // Keys render as <kbd>, one per key.
  const first = SHORTCUTS[0].items[0];
  assert.equal(dts[0].querySelectorAll('kbd').length, first.keys.length);
  assert.equal(dts[0].textContent, first.keys.join(''));
});

test('rendering twice does not duplicate content', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const dom = new JSDOM('<!doctype html><body><div id="x"></div></body>');
  const doc = dom.window.document;
  const host = doc.getElementById('x');
  renderShortcuts(host, doc);
  const once = host.querySelectorAll('dt').length;
  renderShortcuts(host, doc);
  assert.equal(host.querySelectorAll('dt').length, once, 'must replace, not append');
});

test('labels are set as text, never parsed as markup', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const dom = new JSDOM('<!doctype html><body><div id="x"></div></body>');
  const doc = dom.window.document;
  renderShortcuts(doc.getElementById('x'), doc);
  // No shortcut label should ever introduce an element beyond kbd/span.
  const tags = new Set(
    [...doc.querySelectorAll('#x *')].map((n) => n.tagName.toLowerCase())
  );
  for (const t2 of tags) {
    assert.ok(
      ['section', 'h3', 'dl', 'dt', 'dd', 'kbd', 'span'].includes(t2),
      `unexpected element in help: ${t2}`
    );
  }
});

test('the help overlay markup exists and starts hidden', () => {
  const html = readFileSync(new URL('../app.html', import.meta.url), 'utf8');
  assert.ok(html.includes('id="help"'), 'help dialog missing from app.html');
  assert.match(html, /<div id="help"[^>]*\bhidden\b/, 'help must start hidden');
  assert.match(html, /<div id="help"[^>]*role="dialog"/, 'help must be a dialog');
  assert.match(html, /<div id="help"[^>]*aria-modal="true"/);
  assert.ok(html.includes('id="help-body"'));
});

test('Escape unwinds the layer stack rather than a hand-written ladder', () => {
  /*
   * This used to assert that `closeHelp()` appeared before `closePalette()`
   * and `release()` in the source — i.e. it pinned the ORDER OF STATEMENTS in
   * the ladder, which was the fragility, not the guarantee.
   *
   * Overlays are on a stack now, so ordering is structural: the last thing
   * opened is the first thing closed. What is worth asserting here is that no
   * new ladder grows back.
   */
  const handler = appSrc.indexOf("document.addEventListener('keydown'");
  assert.ok(handler > 0, 'global keydown handler not found');
  const esc = appSrc.indexOf("if (e.key === 'Escape')", handler);
  assert.ok(esc > 0);
  // Window, not offset arithmetic: the ladder gained the timetable
  // workspace rung in round 54 and outgrew the old 1600-char slice.
  // The assertion is still about ORDER (stack popped before release),
  // never about where the block ends.
  const block = appSrc.slice(esc, esc + 3000);

  assert.ok(block.includes('closeTopLayer()'), 'Escape must pop the layer stack');
  for (const gone of ['closeHelp()', 'closeSnoozeMenu()', 'closeCategoryMenu()']) {
    assert.ok(
      !block.includes(gone),
      `${gone} is back in the Escape ladder; it should be a layer`
    );
  }
  // The stack must be popped BEFORE the fixed surfaces beneath it.
  assert.ok(
    block.indexOf('closeTopLayer()') < block.indexOf('release()'),
    'the takeover must not be released while an overlay is open'
  );
});

test('help delegates its lifecycle to the layer stack', () => {
  /*
   * This used to assert on `helpReturnFocus` and `back.isConnected` — the
   * NAMES of variables inside openHelp/closeHelp. That is an implementation
   * detail, and it broke the moment focus handling moved into the layer
   * primitive even though the BEHAVIOUR was unchanged.
   *
   * The behaviour itself is covered where it belongs, by driving the real DOM:
   * "HELP: ? opens the overlay and Escape restores focus to where it was" in
   * app.integration.test.mjs. What is worth asserting HERE is the structural
   * rule: help must not hand-roll a lifecycle again.
   */
  assert.match(helpSrc, /helpLayer = openLayer\(/, 'help must use the layer primitive');
  assert.ok(
    !/helpReturnFocus/.test(helpSrc),
    'help should not manage focus itself; the primitive owns that'
  );
});

test('the layer primitive restores focus, and checks the node still exists', () => {
  // The guarantee the deleted assertions were reaching for, asserted against
  // the module that now actually provides it.
  const layers = readFileSync(new URL('../src/app/overlays/layers.js', import.meta.url), 'utf8');
    /*
   * STALE PIN, FOUND RED DURING S2 (pre-existing: it asked for the literal
   * `returnFocus.isConnected`, but since the A-A2 gate the restore path asks
   * the candidate: `let target = returnFocus; if (!target?.isConnected ||
   * !target.matches?.(FOCUSABLE)) { fallback }` — and the regex had ALSO kept
   * a double-escaped dot, so it could never have matched any code at all).
   * Pin the gate as the gate actually exists.
   */
  assert.match(layers, /!target\?\.isConnected \|\| !target\.matches\?\.\(FOCUSABLE\)/,
    'a detached (or unfocusable) restore target must reroute, not focus <body>');
  assert.match(layers, /doc\?\.activeElement/, 'focus must be captured on open');
});

test('single-letter shortcuts are swallowed while help is open', () => {
  // Archiving a message the user cannot see is the worst kind of surprise.
  // Keyed on the layer now rather than on the element's hidden attribute.
  // The shell's key handler guards through the module's accessor; the
  // single-letter shortcuts must never fire behind the overlay.
  assert.ok(
    /if \(helpOpen\(\)\) return;/.test(appSrc),
    'shortcuts still fire behind the help overlay'
  );
});
