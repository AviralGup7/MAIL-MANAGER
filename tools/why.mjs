#!/usr/bin/env node
/**
 * why.mjs — get the REAL error out of "Service worker registration failed".
 *
 * WHY THIS EXISTS
 * ---------------
 * Chrome's message is a category, not a cause. "Status code: 2" is
 * `kErrorStartWorkerFailed` and it names no file, no line and no exception.
 * Six rounds of static analysis have now passed cleanly against a manifest
 * and a worker graph that are byte-identical to a build that worked, so
 * reading the code has stopped producing information.
 *
 * This does the two things that actually extract the cause:
 *
 *   1. Runs the real worker graph through Node's ES module loader in a
 *      worker-shaped global -- no window, no document -- and prints the
 *      genuine exception with a stack if anything throws.
 *
 *   2. Emits a paste-ready DevTools snippet that registers the same file as a
 *      real service worker IN YOUR BROWSER and prints the true error object.
 *      Chrome hides it on the extensions card; it does not hide it from
 *      navigator.serviceWorker.
 *
 * Run:  node tools/why.mjs
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const line = (c = '─') => console.log(c.repeat(66));

console.log();
console.log('Why is the service worker failing?');
line();

/* ── 1. the manifest, as Chrome parses it ─────────────────────────────── */

const mfPath = join(ROOT, 'manifest.json');
let manifest = null;
let raw = '';

try {
  raw = readFileSync(mfPath, 'utf8');
} catch {
  console.log('\n  ✗ manifest.json cannot be read at', mfPath);
  process.exit(1);
}

console.log('\n1. MANIFEST');
console.log(`   path      ${mfPath}`);
console.log(`   bytes     ${raw.length}`);
console.log(`   lines     ${raw.split('\n').length}`);
console.log(`   ends with newline: ${raw.endsWith('\n')}`);
console.log(`   BOM: ${raw.charCodeAt(0) === 0xfeff ? 'YES — Chrome rejects this' : 'no'}`);

try {
  manifest = JSON.parse(raw.replace(/^\uFEFF/, ''));
  console.log('   parses as JSON: yes');
} catch (e) {
  console.log(`\n   ✗ INVALID JSON: ${e.message}`);
  console.log('     Chrome refuses the whole extension. Fix this first.');
  process.exit(1);
}

const keys = Object.keys(manifest);
console.log(`   top-level keys (${keys.length}): ${keys.join(', ')}`);

/*
 * Truncation is worth naming explicitly. A manifest cut short mid-object is
 * still often valid JSON if the braces happen to balance, and the missing
 * keys then look like a deliberate omission rather than damage.
 */
const EXPECTED = [
  'manifest_version', 'name', 'version', 'permissions',
  'host_permissions', 'content_scripts', 'background',
];
const absent = EXPECTED.filter((k) => !(k in manifest));
if (absent.length) {
  console.log(`\n   ⚠ MISSING EXPECTED KEYS: ${absent.join(', ')}`);
  console.log('     A truncated manifest can still parse. Compare against git.');
}

// The mangling seen in three separate pastes.
if (/\[https?:\/\/[^\]]*\]\(/.test(raw)) {
  console.log('\n   ✗ MARKDOWN LINK SYNTAX inside the JSON strings.');
  console.log('     e.g. "[https://mail.google.com/*](https://mail.google.com/*)"');
  console.log('     This parses as JSON and Chrome then rejects the patterns.');
  console.log('     Fix: git checkout manifest.json');
}

/* ── 2. evaluate the worker graph for real ────────────────────────────── */

console.log('\n2. SERVICE WORKER GRAPH');

const swRel = manifest.background?.service_worker;
if (!swRel) {
  console.log('   no background.service_worker declared — nothing to test.');
} else {
  const swAbs = join(ROOT, swRel);
  console.log(`   entry     ${swRel}`);
  if (!existsSync(swAbs)) {
    console.log('   ✗ that file does not exist. This alone fails registration.');
    process.exit(1);
  }

  /*
   * A worker global: no window, no document, and only the chrome.* namespaces
   * the manifest actually grants. Being STRICT here is the point -- a
   * generous stub hides exactly the bug we are hunting, which is code
   * touching an API the manifest never asked for.
   */
  const granted = new Set(manifest.permissions || []);
  const ns = (name, obj) => (granted.has(name) ? obj : undefined);

  globalThis.chrome = {
    runtime: {
      id: 'diagnostic', lastError: null,
      getManifest: () => manifest,
      getURL: (p) => `chrome-extension://diagnostic/${p}`,
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    action: { onClicked: { addListener() {} } },
    commands: manifest.commands
      ? { onCommand: { addListener() {} }, getAll: async () => [] }
      : undefined,
    alarms: ns('alarms', { onAlarm: { addListener() {} }, create() {}, clear() {} }),
    storage: ns('storage', {
      local: { async get() { return {}; }, async set() {}, async remove() {} },
      onChanged: { addListener() {} },
    }),
    identity: ns('identity', {
      getRedirectURL: () => 'https://diagnostic.chromiumapp.org/',
      launchWebAuthFlow() {},
    }),
    scripting: ns('scripting', { executeScript() {}, insertCSS() {} }),
    tabs: { query: async () => [], sendMessage() {}, create() {}, update() {} },
  };

  try {
    await import(pathToFileURL(swAbs).href + `?t=${Date.now()}`);
    console.log('   ✓ the graph evaluates with no exception under NODE');
    console.log();
    console.log('     READ THIS CAREFULLY. It means the JavaScript is valid and');
    console.log('     nothing throws at the top level. It does NOT mean Chrome');
    console.log('     will register it: Chrome never ran. This is Node, with a');
    console.log('     hand-written `chrome` object standing in for the real one.');
    console.log();
    console.log('     Any "[BMM] ..." line printed above came from THIS process,');
    console.log('     not from your browser. It is not evidence of registration.');
    console.log();
    console.log('     Chrome validates the manifest and loads the extension in');
    console.log('     ways nothing here reproduces. If Chrome still refuses, the');
    console.log('     cause is in that layer, and step 3 below is how to see it.');
  } catch (err) {
    console.log('\n   ✗ THE WORKER THREW DURING EVALUATION:\n');
    console.log(`     ${err.constructor.name}: ${err.message}\n`);
    for (const l of String(err.stack || '').split('\n').slice(1, 7)) {
      console.log(`     ${l.trim().replace(ROOT, '.')}`);
    }
    console.log('\n     THIS IS YOUR CAUSE. Chrome reports it as "Status code: 2".');
    process.exit(1);
  }
}

/* ── 3. the browser-side snippet ──────────────────────────────────────── */

const snippetPath = join(ROOT, 'tools', 'paste-into-devtools.js');
const snippet = `/*
 * PASTE THIS INTO THE DEVTOOLS CONSOLE OF ANY EXTENSION PAGE.
 *
 * How to get there:
 *   chrome://extensions -> BITS Mail Manager -> click "Details"
 *   -> scroll to "Inspect views" -> click any listed page
 *   (or open the options page and press F12)
 *
 * Chrome hides the registration error on the extensions card. It does NOT
 * hide it from navigator.serviceWorker.register(), which returns the real
 * exception. That is the whole trick.
 */
(async () => {
  const url = chrome.runtime.getURL('${swRel || 'src/background/index.js'}');
  console.log('[why] attempting to register:', url);

  // Does the file even serve over the extension origin?
  try {
    const res = await fetch(url);
    console.log('[why] fetch status:', res.status, res.statusText);
    const text = await res.text();
    console.log('[why] bytes served:', text.length);
    if (!text.length) console.error('[why] THE FILE IS EMPTY over chrome-extension://');
  } catch (e) {
    console.error('[why] could not fetch the worker file at all:', e);
    return;
  }

  // Then ask the browser to actually start it, and catch the real error.
  try {
    const reg = await navigator.serviceWorker.register(url, { type: 'module' });
    console.log('[why] REGISTERED OK', reg);
    console.log('[why] so the script is fine; the failure is manifest-level.');
  } catch (e) {
    console.error('[why] REAL REGISTRATION ERROR:');
    console.error(e && e.name, '-', e && e.message);
    console.error(e);
  }
})();
`;

writeFileSync(snippetPath, snippet);

console.log('\n3. GET THE BROWSER\'S OWN ERROR');
console.log(`   Wrote ${relative(ROOT, snippetPath)}`);
console.log();
console.log('   Chrome hides the cause on the extensions card, but NOT from');
console.log('   navigator.serviceWorker.register(). Paste that file into the');
console.log('   DevTools console of any extension page:');
console.log();
console.log('     chrome://extensions -> Details -> Inspect views -> (any page)');
console.log('     or just open the options page and press F12');
console.log();
console.log('   It prints the genuine exception. That is the thing that has');
console.log('   been missing from every round of this so far.');
console.log();
console.log('   Until that runs, "the repo is clean" and "Chrome can load it"');
console.log('   are two different claims and only the first has been tested.');
console.log();
line();
console.log();
