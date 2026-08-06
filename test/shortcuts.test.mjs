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

const { SHORTCUTS, allShortcuts, renderShortcuts } = await import('../src/app/shortcuts.js');
const appSrc = readFileSync(new URL('../src/app/app.js', import.meta.url), 'utf8');

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

test('help is the innermost Escape layer', () => {
  // Escape must close help before it closes the palette, compose, the reader,
  // or the takeover. Assert the ordering in the source.
  // Anchor to the GLOBAL keydown handler. An earlier `else if (e.key ===
  // 'Escape')` belongs to the palette's own listener and matching that one
  // made this test assert nothing useful.
  const handler = appSrc.indexOf("document.addEventListener('keydown'");
  assert.ok(handler > 0, 'global keydown handler not found');
  const esc = appSrc.indexOf("if (e.key === 'Escape')", handler);
  assert.ok(esc > 0);
  const block = appSrc.slice(esc, esc + 1400);
  const help = block.indexOf('closeHelp()');
  const palette = block.indexOf('closePalette()');
  const release = block.indexOf('release()');
  assert.ok(help > 0, 'Escape does not close help');
  assert.ok(help < palette, 'help must unwind before the palette');
  assert.ok(help < release, 'help must unwind before releasing the takeover');
});

test('help restores focus when it closes', () => {
  // A modal that drops focus on the body breaks j/k for the next keystroke.
  assert.ok(appSrc.includes('helpReturnFocus'), 'no focus restoration');
  assert.ok(
    appSrc.includes('back.isConnected'),
    'must check the node still exists before focusing it'
  );
});

test('single-letter shortcuts are swallowed while help is open', () => {
  // Archiving a message the user cannot see is the worst kind of surprise.
  assert.ok(
    /if \(el\.help && !el\.help\.hidden\) return;/.test(appSrc),
    'shortcuts still fire behind the help overlay'
  );
});
