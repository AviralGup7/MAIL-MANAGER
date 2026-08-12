/**
 * Reader security invariants, pinned (bug-hunt 44 #61 / improvements #43).
 *
 * The reader's safety rests on two controls: the sandbox attributes of the
 * body iframe, and the CSP meta tag generated into every srcdoc. Both are
 * load-bearing and both were untested -- a regression deleting either would
 * pass every other suite while quietly disarming the reader's defences.
 * The asymmetry (one small test protects a major invariant) is why this
 * file exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../app.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app/app.js', import.meta.url), 'utf8');
// The reader cluster moved out of app.js in the round-51 workspace extraction.
const reader = readFileSync(new URL('../src/app/reader.js', import.meta.url), 'utf8');

test('the body iframe sandbox allows neither scripts nor same-origin', () => {
  const m = html.match(/id="r-body"[\s\S]{0,400}?sandbox="([^"]+)"/);
  assert.ok(m, 'the reader iframe keeps its sandbox attribute');
  const flags = m[1].split(/\s+/);
  assert.ok(!flags.includes('allow-scripts'), 'no allow-scripts: mail cannot run code');
  assert.ok(!flags.includes('allow-same-origin'), 'no allow-same-origin: mail cannot reach the app origin');
});

test('every generated srcdoc carries its CSP meta, and the policy stays strict', () => {
  // The CSP is derived from the same decision the sanitiser makes; since
  // arch A2 it is declared in reader-frame.js and interpolated here. The
  // strictness itself is asserted against the contract module below.
  assert.match(reader, /readerCsp\(allowRemote\)/,
    'renderBody builds the policy from the reader frame contract');
  assert.match(reader, /content="\$\{csp\}"/, 'and the srcdoc carries it');
});

test('unhandled rejections are observed and recorded (bug-hunt 44 #67)', () => {
  assert.match(app, /addEventListener\('unhandledrejection'/,
    'the app listens for unhandled rejections');
  const at = app.indexOf("addEventListener('unhandledrejection'");
  const body = app.slice(at, at + 700);
  assert.ok(body.includes('activity.record'),
    'rejections land in the activity ring, not just the console');
});

test('sending warns about unfilled template placeholders (bug-hunt 44 #30)', () => {
  const compose = readFileSync(new URL('../src/app/compose.js', import.meta.url), 'utf8');
  const at = compose.indexOf('async function doSend');
  const body = compose.slice(at, at + 3500);
  assert.match(body, /Unfilled template fields/,
    'the send path names the gaps before a template mails them');
});

test('an embedded boot without a nonce refuses to run (bug-hunt 44 #70)', () => {
  // app.html is web-accessible to mail.google.com; anything on that page can
  // iframe it. The legitimate embedder mints a nonce into the URL, so an
  // embedded boot WITHOUT one must refuse: no start(), no probes, a visible
  // refusal instead.
  assert.match(app, /EMBED_NONCE/, 'the app reads the embed nonce');
  assert.match(app, /IS_EMBEDDED/, 'and knows when it is iframed');
  assert.match(app, /if \(IS_EMBEDDED && !EMBED_NONCE\)/,
    'embedded + nonceless = refuse');
  const gate = app.slice(app.indexOf('if (IS_EMBEDDED && !EMBED_NONCE)'), app.indexOf('if (IS_EMBEDDED && !EMBED_NONCE') + 900);
  assert.ok(gate.includes('boot()') === false || /else \{\s*boot\(\);/.test(app.slice(app.indexOf('if (IS_EMBEDDED && !EMBED_NONCE)'))),
    'boot runs only on the legitimate branches');
  assert.match(app, /\{ type: 'BMM_READY', \.\.\.\(EMBED_NONCE/, 'readiness echoes the nonce');
  assert.match(app, /\{ type: 'BMM_RELEASE', \.\.\.\(EMBED_NONCE/, 'and so does release');
});

test('the reader frame contract is declared once, in reader-frame.js (arch A2)', async () => {
  const rf = await import('../src/app/reader-frame.js');
  // Typography covers every density, within reading bounds.
  for (const d of ['comfortable', 'cosy', 'compact']) {
    const t = rf.READER_TYPOGRAPHY[d];
    assert.ok(t.size >= 13 && t.size <= 16, `${d} stays readable`);
    assert.ok(t.line >= 1.5, `${d} keeps long-form leading`);
  }
  // CSP: strict default; https only when remote images are on.
  assert.match(rf.readerCsp(false), /^default-src 'none'; img-src data:;/);
  assert.match(rf.readerCsp(true), /img-src data: https:/);
  assert.ok(!rf.readerCsp(true).includes('script-src'), 'never a script-src');
  // Sandbox: the two forbidden flags stay forbidden.
  for (const f of rf.READER_SANDBOX_FORBIDDEN) {
    assert.ok(!rf.READER_SANDBOX.includes(f), `${f} stays out of the sandbox`);
  }
  // And app.html still agrees with the contract.
  const m = html.match(/id="r-body"[\s\S]{0,400}?sandbox="([^"]+)"/);
  assert.deepEqual(m[1].trim().split(/\s+/).sort(), [...rf.READER_SANDBOX].sort(),
    'the iframe flags ARE the contract');
});

test('a fail-closed body is announced, never rendered blank (roadmap HIGH #3)', () => {
  /*
   * Source pin by intent: this is a SECURITY communication contract, and the
   * integration harness cannot remove DOMParser from jsdom to exercise it.
   * The branch must (a) trigger on the sanitiser's flag, (b) say the message
   * is intact, and (c) point at Gmail as the alternative.
   */
  assert.match(reader, /if \(stats\.failedClosed\)/, 'the reader honours the flag');
  assert.match(reader, /could not be safely displayed/, 'it says what happened');
  assert.match(reader, /intact/, 'it does not imply the mail is empty');
  assert.match(reader, /Open in Gmail/, 'and it names the alternative');
});
