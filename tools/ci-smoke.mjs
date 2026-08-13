#!/usr/bin/env node
/**
 * BROWSER SMOKE GATES (long-term direction M2, landed 2026-08-13).
 *
 * WHY THIS EXISTS
 * ---------------
 * This repo's verification culture was probe-measured and MANUAL: every
 * overlay regression was caught by a gitignored .probe*.mjs someone happened
 * to run, and the findings only became pinned *after* shipping. Meanwhile
 * the rails' worst bug of the month — the drawer-regime rail springing open
 * across the mail one second after data lands — is exactly the class of
 * truth a ten-assertion browser suite catches in seconds. The visual
 * harness (tools/visual-regression.mjs) is deliberately "a harness, not a
 * judge"; the render bench in CI is soft-gated by environment. Nothing was
 * a hard, falsifiable gate on USER-visible truth. This file is that gate.
 *
 * THE GATES
 * ---------
 * Each one names a bug that either shipped or was caught a probe-late
 * (the file began as "the ten truths"; the reader floor gates of 2026-08-13
 * made the count a lie, so the heading stopped carrying one):
 *
 *   boot/rows, boot/categories, boot/console-clean   — the app boots at all
 *   rail/column-visible-wide      — the saved preference shows the column
 *   rail/drawer-stays-shut        — the 2026-08-13 bug: no self-open ≤1240px
 *   rail/drawer-summon-dismiss    — explicit manners still work
 *   rail/seam-fold-unfold         — crossing 1240 either way re-derives
 *   compose/off-the-rail          — 0px overlap; centred on the window
 *   settings/one-tab-one-panel    — the tablist contract
 *   settings/density-live         — a schema write repaints without reload
 *   settings/ambience-live        — the attr-stamp path CSS answers
 *   reader/live-has-no-strip      — the provenance strip stays off on live mail
 *   reader/open-remembers-the-body — the floor's write path, real browser
 *   reader/dead-worker-renders-the-floor — kill the worker, the copy renders, dated
 *   reader/floor-miss-is-honest   — a never-opened body still errors, honestly
 *   compose/send-holds-with-undo  — the hold window is real and Undo rides the toast
 *   compose/undo-recalls-the-draft — the Undo really recalls: draft back, queue empty
 *   boot/cold-cache-paints        — sync dead from the first message: the cache paints
 *
 * DETERMINISM
 * -----------
 * Runs against preview.html (node tools/make-preview.mjs) — the real markup
 * and the real modules over the demo corpus, so every assertion is layout
 * and state truth, never network luck. Waits are condition-based except
 * the two that MEASURE a delay itself ("still shut ~1s after data lands"
 * cannot be shortened without unmeasuring it).
 *
 * Env: SMOKE_CHROME pins an executable (bare-metal sandboxes where the
 * registry chromium lacks system libs); CI installs the default one.
 */
import { chromium } from 'playwright-core';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const PREVIEW = new URL('../preview.html', import.meta.url);
if (!existsSync(PREVIEW)) {
  console.error('✗ preview.html missing — run `node tools/make-preview.mjs` first.');
  process.exit(2);
}

/* Infra vs test: a launch failure is CI plumbing, not a broken truth, and
   the exit code says which (2 = infrastructure, 1 = an assertion fell). */
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.SMOKE_CHROME || undefined,
    args: ['--no-sandbox', '--disable-gpu'],
  });
} catch (e) {
  console.error('✗ INFRA (exit 2): chromium failed to launch:', e.message?.split('\n')[0]);
  process.exit(2);
}
/* The version goes in the log: when a rendering truth falls, "which
   Chromium?" is the first question, and the answer must not be a guess. */
console.log('smoke browser:', browser.version());

const results = [];
const check = (name, ok, detail = '') =>
  results.push({ name, ok: !!ok, detail: ok ? detail : String(detail) });

const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const text = m.text();
  /* The TRACER's own noise, not the app's. With snapshots on, Playwright
     probes every frame for a DOM snapshot — including the reader's
     sandboxed body frame, which correctly refuses script execution, which
     Chromium correctly logs. The app cannot produce this message itself:
     its sandboxed frames carry no scripts by construction (the sanitiser
     strips them, and reader-security pins hold that line), so the only
     script that ever knocks on 'about:srcdoc' here is the tracer's. The
     filter is scoped to exactly that class; everything else still counts. */
  if (/^Blocked script execution in 'about:/.test(text)) return;
  errors.push('console: ' + text);
});
/* The trace starts BEFORE the first assertion so a failure anywhere —
   including boot — is replayable (audit #38). Kept only on failure: the
   green discipline ("a pass leaves nothing") applies to traces too. */
await page.context().tracing.start({ screenshots: true, snapshots: true });

let fatal = null;
try {
await page.goto('file://' + PREVIEW.pathname);
await page.waitForSelector('#list .row', { timeout: 15000 });
await page.waitForTimeout(800); // settle past boot reflows

const rows = await page.locator('#list .row').count();
check('boot/rows', rows >= 15, `${rows} rows`);
check('boot/categories', (await page.locator('#cats .cat').length ?? (await page.locator('#cats .cat').count())) >= 5);

const railState = (p) => p.evaluate(() => {
  const el = document.getElementById('rail');
  const cs = getComputedStyle(el);
  if (cs.display === 'none') return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), w: Math.round(r.width), pos: cs.position };
});

/* ---- wide regime: the saved preference owns a real column ---- */
await page.waitForTimeout(1800); // past the data-arrival moment
const wideCol = await railState(page);
check('rail/column-visible-wide', wideCol && wideCol.pos !== 'fixed' && wideCol.w >= 280, JSON.stringify(wideCol));

/* ---- compose: centred, and never on the rail ---- */
await page.click('#btn-compose');
await page.waitForTimeout(500);
const comp = await page.evaluate(() => {
  const r = document.getElementById('compose').getBoundingClientRect();
  return { x: Math.round(r.x), w: Math.round(r.width), bottomGap: Math.round(innerHeight - r.bottom) };
});
const overlap = wideCol && comp ? Math.max(0, Math.min(comp.x + comp.w, wideCol.x + wideCol.w) - Math.max(comp.x, wideCol.x)) : 0;
check('compose/off-the-rail', overlap === 0 && Math.abs(comp.x - (1440 - comp.w) / 2) <= 2,
  `overlap ${overlap}px, x ${comp.x}, w ${comp.w}`);
await page.evaluate(() => { document.getElementById('compose').hidden = true; });

/* ---- compose send keeps an undo window, and the Undo really recalls ----
   G5 (2026-08-14): send must go through the outbox's hold — the toast
   offers Undo and the rail counts the window down — and Undo must be a
   REAL recall: the draft returns to compose and the queue empties. The
   seam this pins is the one a regression would quietly cut: enqueuing is
   easy to keep, the recall path is the part that rots. */
await page.click('#btn-compose');
await page.waitForTimeout(400);
await page.fill('#c-to', 'f20240001@pilani.bits-pilani.ac.in');
await page.fill('#c-subject', 'smoke: undo-send gate');
await page.click('#c-send');
try {
  await page.waitForFunction(
    () => !document.getElementById('toast').hidden &&
          document.getElementById('toast-text').textContent.startsWith('Sending to '),
    { timeout: 6000 },
  );
} catch { /* the check below reports the miss with the UI's actual state */ }
/* The rail row lands one pump round-trip after the toast: flushOutbox is
   fire-and-forget and the pump awaits the worker's OUTBOX_PUMP answer
   (140ms in the stub) before it renders. Wait for the countdown itself —
   condition-based, per this file's determinism law. */
try {
  await page.waitForFunction(
    () => !document.getElementById('outbox').hidden &&
          /^Sending in \d+s$/.test(document.querySelector('.outbox-status')?.textContent || ''),
    { timeout: 6000 },
  );
} catch { /* reported below */ }
const sendUi = await page.evaluate(() => ({
  toastText: document.getElementById('toast-text').textContent,
  toastHidden: document.getElementById('toast').hidden,
  undoVisible: !document.getElementById('toast-action').hidden,
  undoLabel: document.getElementById('toast-action').textContent,
  outboxShown: !document.getElementById('outbox').hidden,
  status: document.querySelector('.outbox-status')?.textContent || '',
}));
check('compose/send-holds-with-undo',
  !sendUi.toastHidden && sendUi.toastText.startsWith('Sending to ') &&
  sendUi.undoVisible && /^undo$/i.test(sendUi.undoLabel.trim()) &&
  sendUi.outboxShown && /^Sending in \d+s$/.test(sendUi.status),
  JSON.stringify(sendUi));
if (sendUi.undoVisible) {
  await page.click('#toast-action');
  try {
    await page.waitForFunction(
      () => !document.getElementById('compose').hidden,
      { timeout: 6000 },
    );
  } catch { /* reported below */ }
  /* The rail HIDE is the flushOutbox-in-Undo fix's whole point, and it too
     lands one pump round-trip after cancel: compose reopening wins the
     race. Wait for the hide, or the gate flaps on the stub's 140ms. */
  try {
    await page.waitForFunction(
      () => document.getElementById('outbox').hidden,
      { timeout: 6000 },
    );
  } catch { /* reported below */ }
  const recalled = await page.evaluate(() =>
    globalThis.chrome.storage.local.get('outbox').then((o) => ({
      composeOpen: !document.getElementById('compose').hidden,
      to: document.getElementById('c-to').value,
      subject: document.getElementById('c-subject').value,
      queueDepth: (o.outbox || []).length,
      outboxShown: !document.getElementById('outbox').hidden,
    })));
  /* queueDepth is the TRUTH assertion; outboxShown is the rail's honesty
     (a recalled message must stop counting down immediately, not at the
     hold timer's leisure — that fix landed with this gate). */
  check('compose/undo-recalls-the-draft',
    recalled.composeOpen &&
    recalled.to.includes('f20240001@pilani.bits-pilani.ac.in') &&
    recalled.subject.includes('smoke: undo-send gate') &&
    recalled.queueDepth === 0 && !recalled.outboxShown,
    JSON.stringify(recalled));
  await page.evaluate(() => { document.getElementById('compose').hidden = true; });
}

/* ---- settings: one tab painted, one panel, Escape to layers ---- */
await page.click('#btn-settings');
await page.waitForTimeout(400);
const set1 = await page.evaluate(() => ({
  tabs: document.querySelectorAll('#settings-nav [role="tab"]').length,
  visible: [...document.querySelectorAll('.set-section')].filter((s) => !s.hidden).map((s) => s.id),
}));
check('settings/one-tab-one-panel', set1.tabs === 5 && set1.visible.length === 1 && set1.visible[0] === 'set-p-appearance',
  JSON.stringify(set1));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('settings/escape-closes', await page.evaluate(() => document.getElementById('settings').hidden));

/* ---- settings writes repaint live (density attr; ambience attr + CSS) ---- */
await page.click('#btn-settings');
await page.waitForTimeout(300);
await page.selectOption('#settings-body select[aria-label="Row density"]', 'compact');
await page.waitForTimeout(250);
const dens = await page.evaluate(() => document.documentElement.getAttribute('data-density'));
check('settings/density-live', dens === 'compact', dens);
await page.selectOption('#settings-body select[aria-label="Row density"]', 'comfortable');
await page.evaluate(() => document.querySelector('input[aria-label="Ambient light"]').click());
await page.waitForTimeout(250);
const amb = await page.evaluate(() => ({
  attr: document.documentElement.getAttribute('data-ambience'),
  sheen: getComputedStyle(document.querySelector('.lit'), '::before').display,
}));
check('settings/ambience-live', amb.attr === 'off' && amb.sheen === 'none', JSON.stringify(amb));
await page.evaluate(() => document.querySelector('input[aria-label="Ambient light"]').click()); // restore
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

/* ---- the seam, both directions; the drawer never opens itself ---- */
await page.setViewportSize({ width: 1100, height: 800 });
await page.waitForTimeout(700);
const folded = await railState(page);
check('rail/seam-fold-shuts', folded === null, JSON.stringify(folded));
await page.waitForTimeout(1200); // the measured ~1s data-arrival window
const late = await railState(page);
check('rail/drawer-stays-shut', late === null, JSON.stringify(late));
await page.click('#btn-rail');
await page.waitForTimeout(500);
const drawer = await railState(page);
check('rail/drawer-summons', drawer && drawer.pos === 'fixed', JSON.stringify(drawer));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('rail/drawer-dismisses', (await railState(page)) === null);
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(700);
const restored = await railState(page);
check('rail/seam-unfold-restores', restored && restored.pos !== 'fixed', JSON.stringify(restored));

/* ---- reader: the body floor under a dead worker (M1, 2026-08-13) ---- */
/* Open the first row against the LIVE stub: the body renders, and the
   provenance strip must stay hidden — a live message never wears it. */
await page.click('#list .row');
await page.waitForFunction(
  () => (document.getElementById('r-body')?.srcdoc || '').includes('preview content'),
  { timeout: 8000 },
);
check('reader/live-has-no-strip',
  await page.evaluate(() => document.getElementById('r-offline').hidden));
/* The remember is coalesced (WRITE_DELAY_MS); poll the stubbed storage
   until the blob lands — this is the write path in a real browser. */
const floorWritten = await page.waitForFunction(
  () => globalThis.chrome.storage.local.get('bodyCache')
    .then((o) => Array.isArray(o?.bodyCache?.b) && o.bodyCache.b.length >= 1),
  { timeout: 6000 },
).then(() => true).catch(() => false);
check('reader/open-remembers-the-body', floorWritten);
/* Kill the worker: every send now fails, exactly as a dead connection or
   an unresponsive service worker presents. */
await page.evaluate(() => {
  globalThis.chrome.runtime.sendMessage = (msg, cb) =>
    setTimeout(() => cb({ ok: false, error: 'dead worker' }), 10);
});
await page.keyboard.press('Escape'); // close the reader
await page.waitForTimeout(300);
await page.click('#list .row'); // the SAME message, now against the floor
await page.waitForFunction(
  () => (document.getElementById('r-body')?.srcdoc || '').includes('preview content'),
  { timeout: 8000 },
);
const strip = await page.evaluate(() => ({
  hidden: document.getElementById('r-offline').hidden,
  text: document.getElementById('r-offline-text').textContent,
}));
check('reader/dead-worker-renders-the-floor',
  !strip.hidden && strip.text.startsWith('Offline copy — saved '), JSON.stringify(strip));
/* And a message that was NEVER opened must still get the honest error —
   the floor declines rather than inventing a body. */
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.evaluate(() => {
  [...document.querySelectorAll('#list .row')][1]?.click();
});
await page.waitForFunction(
  () => (document.getElementById('r-body')?.srcdoc || '').length > 0,
  { timeout: 8000 },
);
const miss = await page.evaluate(() => document.getElementById('r-body').srcdoc);
check('reader/floor-miss-is-honest',
  miss.includes('Could not load this message.'), miss.slice(0, 80));
await page.keyboard.press('Escape');

/* ---- cold-cache boot: sync dead from the very first message (G5) ----
   The scenario the whole local-first architecture exists for: a laptop
   opened on dead wifi. The first load already ran the app's real save
   path (the cache below is ITS write, not a planted fixture), the stub
   persists it across the reload, and ?nosync=1 makes both SYNC verbs
   answer like a dead network. The cached rows must paint anyway — if
   boot ever re-orders to network-first, this gate goes red before a
   user on a hostel staircase finds out. */
const warmCached = await page.evaluate(() =>
  globalThis.chrome.storage.local.get('msgCache')
    .then((o) => (o.msgCache?.m || []).length));
await page.goto('file://' + PREVIEW.pathname + '?nosync=1');
await page.waitForSelector('#list .row', { timeout: 15000 });
await page.waitForTimeout(600); // let the doomed sync answer; the rows must survive it
const warmRows = await page.locator('#list .row').count();
check('boot/cold-cache-paints', warmCached >= 15 && warmRows >= 15,
  `${warmRows} cached rows with sync dead (cache held ${warmCached})`);
} catch (e) {
  /* A thrown gate (selector timeout, dead renderer) is infrastructure, and
     the exit code will say so — with the partial results still printed. */
  fatal = e;
  results.push({ name: 'flow/completes', ok: false, detail: String(e).split('\n')[0] });
}

check('boot/console-clean', errors.length === 0, errors.slice(0, 3).join(' | '));

/* On failure, leave the scene behind: screenshot, live DOM, captured
   console, and the trace — everything a manual .probe used to collect by
   hand, plus the one thing it could not (a replayable recording). Best
   effort on purpose: artifact capture may never mask the failure. */
if (fatal || results.some((r) => !r.ok)) {
  try {
    await page.context().tracing.stop({ path: '.smoke-trace.zip' });
    await page.screenshot({ path: '.smoke-failure.png' });
    writeFileSync('.smoke-failure.html', await page.content());
    writeFileSync('.smoke-failure.txt',
      (fatal ? 'FATAL: ' + String(fatal) + '\n\n' : '') + (errors.join('\n') || '(no console errors)'));
    console.log('failure artifacts: .smoke-failure.{png,html,txt} + .smoke-trace.zip');
  } catch (e) {
    console.log('artifact capture failed:', String(e));
  }
} else {
  try {
    await page.context().tracing.stop(); // green: discard, keep nothing
  } catch { /* a stopped trace is not a finding */ }
}

await browser.close();

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : '✗ NOT OK'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} smoke gates green`);

/* Mirror the gate table onto the run's Summary page under Actions —
   the shard runner already does this for tests; the browser truths
   belong on the same page (2026-08-14). Locally the env var is absent
   and this is a no-op. */
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map((r) =>
    `| ${r.name} | ${r.ok ? 'pass' : 'FAIL'} | ${r.detail.replace(/\n/g, ' ').slice(0, 160)} |`);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `\n## Browser smoke gates — ${results.length - failed}/${results.length} green\n\n` +
    `Chromium ${browser.version()}\n\n| gate | result | detail |\n| --- | --- | --- |\n` + rows.join('\n') + '\n',
  );
}
process.exit(fatal ? 2 : failed ? 1 : 0);
