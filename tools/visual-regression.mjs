#!/usr/bin/env node
/**
 * Visual regression harness (round 45, arch A5).
 *
 * The contrast checker audits the PALETTE; nothing audited the RENDERED
 * result — which is how a hardcoded white reader frame shipped through six
 * audit rounds. This harness opens the real app in headless Chromium, in
 * every theme × density × supported width, and screenshots it. Baselines
 * live in tools/screenshots/; diff them (any pixel tool) after a visual
 * change.
 *
 * It is a HARNESS, not a judge: the screenshots are the artefact, CI or a
 * human decides what a diff means. Run with: node tools/visual-regression.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = process.env.VR_OUT || join(ROOT, 'tools', 'screenshots');
mkdirSync(OUT, { recursive: true });

/*
 * SERVE OVER HTTP, NOT file://. The app is an ES module graph, and module
 * loads from a `file://` origin are CORS-blocked, so a file:// boot never
 * evaluated any JS (the first revision captured only static HTML). A same-
 * origin static server is the whole fix.
 */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const server = createServer((req, res) => {
  const clean = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'app.html';
  const file = join(ROOT, clean);
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const APP_URL = `http://127.0.0.1:${server.address().port}/app.html`;

const THEMES = THEMES_DATA.map((theme) => theme.id);
const DENSITIES = ['comfortable', 'cosy', 'compact'];
const WIDTHS = [1280, 860, 600, 480]; // the layout-contract ladder

/*
 * Minimal chrome.* double, injected before the app evaluates. Enough for a
 * signed-out boot: storage persists in-memory, the worker answers
 * AUTH_STATUS, nothing reaches the network.
 */
const chromeStub = `
(() => {
  const store = new Map(Object.entries(${JSON.stringify({})}));
  const seed = ${JSON.stringify({ theme: '__THEME__', density: '__DENSITY__' })};
  for (const [k, v] of Object.entries(seed)) store.set(k, v);
  const listeners = [];
  window.chrome = {
    runtime: {
      id: 'visual-regression',
      getURL: (p) => 'chrome-extension://visual-regression/' + p,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: (msg, cb) => {
        if (msg?.type === 'AUTH_STATUS') { cb?.({ signedIn: false }); return; }
        cb?.(null);
      },
    },
    storage: {
      local: {
        get: async (k) => {
          if (Array.isArray(k)) return Object.fromEntries(k.map((x) => [x, store.get(x)]));
          if (typeof k === 'string') return store.has(k) ? { [k]: store.get(k) } : {};
          return Object.fromEntries(store);
        },
        set: async (o) => { for (const [k, v] of Object.entries(o)) store.set(k, v); },
        remove: async (k) => { for (const x of [].concat(k)) store.delete(x); },
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    identity: { getRedirectURL: () => 'https://visual-regression.chromiumapp.org/' },
  };
})();
`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
});

import { THEMES as THEMES_DATA } from '../src/app/system/themes.js';

let taken = 0;
const tokenFailures = [];
try {
  for (const theme of THEMES) {
    for (const density of DENSITIES) {
      for (const width of WIDTHS) {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        await page.addInitScript(chromeStub.replaceAll('__THEME__', theme).replaceAll('__DENSITY__', density));
        await page.goto(APP_URL);
        // Wait for the theme to actually stamp data-theme rather than a fixed
        // delay, so a slow CI never captures a pre-paint frame (round 48).
        try {
          await page.waitForFunction(
            () => document.documentElement.hasAttribute('data-theme'),
            null, { timeout: 2000 }
          );
        } catch { /* fall through to the fixed settle below */ }
        await page.waitForTimeout(150);
        const file = join(OUT, `${theme}.${density}.${width}.png`);
        await page.screenshot({ path: file });
        taken++;

        /*
         * RENDERED-TOKEN GUARD (round 46, arch #10): the screenshots are
         * artefacts; this is the judge for token PROPAGATION. The theme's
         * declared --bg must be what the document actually renders -- the
         * density-in-reader and white-frame gaps were exactly "the token
         * exists but never lands", found by audit instead of by tool.
         */
        if (density === 'comfortable' && width === 1280) {
          const rendered = await page.evaluate(
            () => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
          );
          const declared = (THEMES_DATA.find((t) => t.id === theme) || {}).bg;
          if (declared && rendered && rendered.toLowerCase() !== declared.toLowerCase()) {
            tokenFailures.push(`${theme}: declared ${declared}, rendered ${rendered}`);
          }
        }
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`visual-regression: ${taken} screenshots in ${OUT}`);
if (tokenFailures.length) {
  console.error('rendered-token guard FAILURES:');
  for (const f of tokenFailures) console.error('  ' + f);
  process.exit(1);
}
console.log('rendered-token guard: every theme renders its declared surface');
