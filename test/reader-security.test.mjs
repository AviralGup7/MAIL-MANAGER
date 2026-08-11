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

test('the body iframe sandbox allows neither scripts nor same-origin', () => {
  const m = html.match(/id="r-body"[\s\S]{0,400}?sandbox="([^"]+)"/);
  assert.ok(m, 'the reader iframe keeps its sandbox attribute');
  const flags = m[1].split(/\s+/);
  assert.ok(!flags.includes('allow-scripts'), 'no allow-scripts: mail cannot run code');
  assert.ok(!flags.includes('allow-same-origin'), 'no allow-same-origin: mail cannot reach the app origin');
});

test('every generated srcdoc carries its CSP meta, and the policy stays strict', () => {
  // The CSP is derived from the same decision the sanitiser makes; the
  // default must stay 'none' with img-src as the only content channel.
  assert.match(app, /default-src 'none'; img-src \$\{imgSrc\}/,
    'the srcdoc CSP keeps default-src none with a dynamic img-src');
  assert.match(app, /const imgSrc = allowRemote \? 'data: https:' : 'data:'/,
    'remote images widen img-src only when explicitly allowed');
  assert.ok(!/script-src 'unsafe-inline'/.test(app.slice(app.indexOf('function renderBody'), app.indexOf('function renderBody') + 4000)),
    'the reader CSP never grows an unsafe script-src');
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
