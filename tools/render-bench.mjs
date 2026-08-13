#!/usr/bin/env node
/**
 * Rendering benchmark (repo TODO #8 — the 60fps claim, finally measured).
 *
 * The data-layer bench (test/bench.mjs) measures classify/store cost; jsdom
 * has no layout engine, so nothing measured PAINT. This harness opens the
 * real app in headless Chromium (like tools/visual-regression.mjs) and
 * measures the four things a mail client is judged on:
 *
 *   1. boot → first painted rows
 *   2. list render cost (per 100-row page, driven through the real "Load
 *      more" button)
 *   3. scroll frame-times (the actual 60fps claim, p50/p95 over a scroll)
 *   4. search interaction latency (keystroke → list update)
 *
 * THRESHOLDS: generous defaults that a software-rendered headless Chromium
 * can meet while still catching a real regression (a render path that went
 * O(n^2), a reflow per keystroke, an animation loop). Override with
 * RENDER_BENCH_* env vars. The benchmark REPORTS numbers; CI decides.
 *
 * Run: node tools/render-bench.mjs
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { join, dirname, extname } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PAGE = 100;

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

/* Generate the message fixture inside the stub: 500 messages, 100 per page. */
const MESSAGES = JSON.stringify(
  Array.from({ length: 500 }, (_, i) => ({
    id: `bm${i}`, threadId: `bt${i}`,
    from: i % 3 === 0 ? 'AUGSD <augsd@pilani.bits-pilani.ac.in>'
      : i % 3 === 1 ? 'Placement Unit <placement@pilani.bits-pilani.ac.in>'
                    : 'GitHub <noreply@github.com>',
    subject: i % 2 ? 'Course registration and exam timetable' : 'Pull request merged',
    snippet: 'unsubscribe deadline semester fee payment', date: Date.now() - i * 1000,
    unread: i % 4 === 0, starred: i % 7 === 0, labels: ['INBOX'],
  }))
);

/* Signed-in worker stub: answers SYNC_PAGE in pages of 100, plus the verbs
 * the boot path touches. All in-memory, nothing reaches the network. */
const chromeStub = `
(() => {
  const store = new Map();
  const msgs = ${MESSAGES};
  const listeners = [];
  window.chrome = {
    runtime: {
      id: 'render-bench',
      getURL: (p) => 'chrome-extension://render-bench/' + p,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: (msg, cb) => {
        const reply = (data) => setTimeout(() => cb?.({ ok: true, data }), 0);
        switch (msg?.type) {
          case 'AUTH_STATUS': return reply({ signedIn: true });
          case 'PROFILE': return reply({ emailAddress: 'bench@pilani.bits-pilani.ac.in' });
          case 'SYNC_PAGE': {
            const start = (msg.opts?.pageToken ? Number(msg.opts.pageToken) : 0) * ${PAGE};
            const slice = msgs.slice(start, start + ${PAGE});
            return reply({ messages: slice, nextPageToken: start + ${PAGE} < msgs.length ? String(start / ${PAGE} + 1) : '' });
          }
          case 'SYNC_DELTA': return reply({ kind: 'delta', added: [], removed: [], patched: [] });
          case 'GET_BODY': return reply({ id: msg.id, html: '<p>body</p>', text: '', attachments: [], inlineData: [] });
          case 'GET_ATTACHMENT': return reply({ dataUrl: 'data:application/pdf;base64,JVBER' });
          case 'LIST_LABELS': return reply([]);
          case 'GET_DRAFT': return reply({ draftId: 'd-1', to: '', cc: '', bcc: '', subject: '', text: '', threadId: '' });
          default: return reply({});
        }
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
    identity: { getRedirectURL: () => 'https://render-bench.chromiumapp.org/' },
  };
})();
`;

/* INFRA vs THRESHOLD (audit 64 F2, closed 2026-08-14). A browser that will
   not launch is the environment's fault and must be SOFT (exit 2 — the
   workflow warns and moves on); a breached threshold is the CODE's fault
   and must burn red (exit 1). One exit code per failure class, the same
   discipline the smoke gate already carried. */
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox'],
  });
} catch (e) {
  console.error('✗ INFRA (exit 2): chromium failed to launch:', String(e?.message || e).split('\n')[0]);
  server.close();
  process.exit(2);
}
/* The version goes in the log for the same reason the smoke gate logs it:
   when a paint number moves, "which Chromium?" is the first question. */
console.log('render bench browser:', browser.version());

const env = (k, d) => Number(process.env[`RENDER_BENCH_${k}`] || d);
/*
 * Regression thresholds for SOFTWARE-rendered headless Chromium (SwiftShader).
 * Real hardware is 10-20x faster; these are set to catch structural
 * regressions — an O(n^2) render path, a reflow per keystroke, a runaway
 * animation loop — not to grade absolute speed. Override per machine with
 * RENDER_BENCH_* env vars. The measured 60fps scroll (16.7ms) is the claim
 * this bench exists to protect, so its limit is the tightest.
 */
const LIMITS = {
  bootMs: env('BOOT_MS', 2000),
  pageMs: env('PAGE_MS', 2500),
  scrollP95Ms: env('SCROLL_P95', 50),
  searchMs: env('SEARCH_MS', 2500),
};

const results = {};
const failures = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(chromeStub);
  await page.goto(APP_URL);

  // 1. boot → first painted rows
  const bootT0 = Date.now();
  await page.waitForFunction(
    () => document.querySelectorAll('.row').length >= 100,
    null, { timeout: LIMITS.bootMs + 2000 }
  );
  results.bootMs = Date.now() - bootT0;

  // 2. list render cost: click "Load more" four times. Timed in-page with a
  // MutationObserver on the row container, so the number is the app's true
  // render latency, not playwright's polling interval.
  const pageTimes = [];
  for (let i = 0; i < 4; i++) {
    const ms = await page.evaluate(async () => {
      const list = document.getElementById('list');
      const before = document.querySelectorAll('.row').length;
      const done = new Promise((res) => {
        const mo = new MutationObserver(() => {
          if (document.querySelectorAll('.row').length > before) { mo.disconnect(); res(performance.now()); }
        });
        mo.observe(list, { childList: true, subtree: true });
      });
      const t0 = performance.now();
      document.getElementById('btn-more')?.click();
      const t1 = await Promise.race([done, new Promise((r) => setTimeout(() => r(performance.now()), 5000))]);
      return t1 - t0;
    });
    pageTimes.push(ms);
  }
  results.pageMs = pageTimes;
  results.pageMsAvg = pageTimes.reduce((a, b) => a + b, 0) / pageTimes.length;

  // 3. scroll frame-times: rAF deltas over a programmatic scroll
  const frameTimes = await page.evaluate(async () => {
    const scroller = document.querySelector('#scroller');
    const deltas = [];
    let rafId = 0;
    const sample = () => new Promise((res) => {
      let last = performance.now();
      const tick = (t) => {
        deltas.push(t - last); last = t;
        if (deltas.length >= 90) { cancelAnimationFrame(rafId); res(); return; }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    });
    const p = sample();
    // scroll in bursts, the way a user reads
    for (let i = 0; i < 30; i++) {
      scroller.scrollTop += 120;
      await new Promise((r) => setTimeout(r, 16));
    }
    await p;
    return deltas;
  });
  const sorted = [...frameTimes].sort((a, b) => a - b);
  results.scrollP50 = sorted[Math.floor(sorted.length * 0.5)];
  results.scrollP95 = sorted[Math.floor(sorted.length * 0.95)];
  results.scrollMax = sorted[sorted.length - 1];

  // 4. search latency: one input event → list updated, timed in-page.
  const searchMs = await page.evaluate(async () => {
    const input = document.getElementById('search');
    const list = document.getElementById('list');
    const before = document.querySelectorAll('.row').length;
    const done = new Promise((res) => {
      const mo = new MutationObserver(() => {
        if (document.querySelectorAll('.row').length < before) { mo.disconnect(); res(performance.now()); }
      });
      mo.observe(list, { childList: true, subtree: true });
    });
    input.focus();
    input.value = 'registration';
    const t0 = performance.now();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const t1 = await Promise.race([done, new Promise((r) => setTimeout(() => r(performance.now()), 5000))]);
    return t1 - t0;
  });
  results.searchMs = searchMs;

  await page.close();
} finally {
  await browser.close();
  server.close();
}

/* ---------------- report ---------------- */
const round1 = (n) => Math.round(n * 10) / 10;
console.log('=== RENDERING BENCHMARK (headless Chromium) ===');
console.log(`boot → ${PAGE} rows painted:        ${results.bootMs}ms  (limit ${LIMITS.bootMs}ms)`);
console.log(`list page render (×${results.pageMs.length}):        avg ${round1(results.pageMsAvg)}ms  (limit ${LIMITS.pageMs}ms)`);
console.log(`scroll frame-time:  p50 ${round1(results.scrollP50)}ms  p95 ${round1(results.scrollP95)}ms  max ${round1(results.scrollMax)}ms  (p95 limit ${LIMITS.scrollP95Ms}ms)`);
console.log(`search keystroke → update:          ${results.searchMs}ms  (limit ${LIMITS.searchMs}ms)`);
console.log('');

const check = (name, got, limit) => {
  const ok = got <= limit;
  if (!ok) failures.push(`${name}: ${got}ms > ${limit}ms`);
  return ok;
};
const ok = [
  check('boot', results.bootMs, LIMITS.bootMs),
  check('page-avg', results.pageMsAvg, LIMITS.pageMs),
  check('scroll-p95', results.scrollP95, LIMITS.scrollP95Ms),
  check('search', results.searchMs, LIMITS.searchMs),
].every(Boolean);

console.log(ok ? 'RENDER BENCH: PASS' : `RENDER BENCH: FAIL\n${failures.join('\n')}`);
process.exit(ok ? 0 : 1);
