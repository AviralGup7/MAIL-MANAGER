/**
 * The reader's stylesheets (under-engineering audit P7).
 *
 * 3,512 lines of CSS were referenced by no test at all. These 434 are the
 * ones that matter most: 30-reader.css and 44-reader-head.css style the pane
 * that displays UNTRUSTED MAIL, and the body iframe's containment is partly a
 * CSS property. A stylesheet nothing reads is a stylesheet a refactor can
 * quietly break.
 *
 * Deliberately NOT a snapshot: a snapshot of 434 lines fails on every
 * cosmetic edit and teaches people to re-bless it without reading. These
 * assert the handful of properties that are load-bearing for SAFETY and
 * LAYOUT, and nothing about appearance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (n) => readFileSync(new URL(`../src/styles/${n}`, import.meta.url), 'utf8');
const READER = read('30-reader.css');
const HEAD = read('44-reader-head.css');
const BOTH = `${READER}\n${HEAD}`;

/** Strip comments so prose about a property is never mistaken for the rule. */
const code = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('the body frame is CONTAINED, so a mail cannot lay itself over the app', async () => {
  /*
   * The reader renders sender-controlled HTML in an iframe. The sandbox stops
   * it SCRIPTING; only layout containment stops a very large or absolutely
   * positioned body from painting over the app chrome around it. Both halves
   * are required and only one of them lives in JavaScript.
   */
  const css = code(BOTH);
  // The rule's own declaration block, not a fixed-length window: a slice
  // measured in characters silently tests the wrong thing the moment a
  // comment above it changes length.
  const m = /#r-body\s*\{([^}]*)\}/.exec(css);
  assert.ok(m, 'the body frame must actually be styled by these sheets');
  const block = m[1];
  assert.match(block, /width\s*:\s*100%/,
    'the frame is pinned to its column rather than sized by its content');
  assert.match(block, /height\s*:\s*100%/,
    'and to its row — an iframe defaults to 150px tall, which crops the mail');
  assert.match(block, /border\s*:\s*0/,
    'no default 2px inset border around untrusted content');
});

test('the reader scrolls INSIDE its pane', async () => {
  // A reader that grows the document instead of scrolling itself takes the
  // list and the rails off-screen with it.
  assert.match(code(BOTH), /overflow(-y)?\s*:\s*(auto|scroll|hidden)/,
    'some containing element must own the scroll');
});

test('nothing in the reader escapes its stacking context', async () => {
  /*
   * `position: fixed` in a pane that renders untrusted content is how an
   * element ends up over the app chrome. The reader is allowed sticky
   * headers; it is not allowed fixed ones.
   */
  const offenders = [...code(BOTH).matchAll(/position\s*:\s*fixed/g)];
  assert.equal(offenders.length, 0,
    'use sticky inside the pane, never fixed — fixed escapes the pane');
});

test('the reader head reserves space rather than overlapping the body', async () => {
  assert.match(code(HEAD), /\.r-head|#r-head|r-subject|r-from/,
    'the head block must be defined in its own file');
});

test('THE TYPOGRAPHY CONTRACT AND THE STYLESHEET AGREE ON DENSITY', async () => {
  /*
   * reader-frame.js declares READER_TYPOGRAPHY per density and bakes it into
   * the iframe srcdoc; the pane around it is styled here. The audits kept
   * finding these two disagreeing (a hardcoded white frame, density ignored),
   * which is why the contract was centralised — but nothing checked that the
   * CSS still honours the same density attribute.
   */
  const { READER_TYPOGRAPHY } = await import('../src/app/mail/reader-frame.js');
  const densities = Object.keys(READER_TYPOGRAPHY);
  assert.deepEqual(densities.sort(), ['comfortable', 'compact', 'cosy'],
    'the three densities the settings panel offers');
  for (const d of densities) {
    const t = READER_TYPOGRAPHY[d];
    assert.ok(t.size >= 12 && t.size <= 18, `${d}: ${t.size}px is outside reading bounds`);
    assert.ok(t.line >= 1.4 && t.line <= 1.9, `${d}: line-height ${t.line} is outside reading bounds`);
    assert.match(t.pad, /^\d+px \d+px \d+px$/, `${d}: padding must be a three-value px shorthand`);
  }
  // Dense must actually be denser — a setting that changes nothing is a lie.
  assert.ok(READER_TYPOGRAPHY.compact.size < READER_TYPOGRAPHY.comfortable.size);
  assert.ok(READER_TYPOGRAPHY.compact.line < READER_TYPOGRAPHY.comfortable.line);
});

test('the reader stylesheets carry no remote fetch', async () => {
  /*
   * A url() in the reader's own chrome would be a request made when a mail is
   * opened — the tracking-pixel channel the sanitiser blocks in the BODY,
   * arriving through the frame around it instead. data: is fine; it fetches
   * nothing.
   */
  const urls = [...code(BOTH).matchAll(/url\(\s*['"]?([^'")]+)/g)].map((m) => m[1].trim());
  const remote = urls.filter((u) => /^(https?:)?\/\//i.test(u));
  assert.deepEqual(remote, [], `remote url() in the reader chrome: ${remote.join(', ')}`);
  assert.equal(code(BOTH).includes('@import'), false, '@import is a remote fetch too');
});

test('both stylesheets are actually shipped by app.html', async () => {
  // A stylesheet that exists but is never linked is dead weight that still
  // has to be maintained; a linked one that was deleted is a broken page.
  const html = readFileSync(new URL('../app.html', import.meta.url), 'utf8');
  for (const name of ['30-reader.css', '44-reader-head.css']) {
    assert.ok(html.includes(name), `${name} is not linked from app.html`);
  }
});
