/**
 * The settings panel (2026-08-13).
 *
 * WHY THESE PINS
 * --------------
 * Settings used to live only on the extension options page — a separate
 * window, styled separately, discovered by accident. The panel brings every
 * user-facing schema key one click from the mail, rendered from a descriptor
 * so a new schema key is a new row, not a new feature. What must not drift:
 *
 *   1. COVERAGE. settings.js calls a schema entry a promise; the panel is
 *      where promises are kept. Every user-facing key must appear in the
 *      descriptor, and the three deliberate absences (clientId, coachDone,
 *      paletteRecents) must stay absent — with their reasons on record.
 *   2. THE ONE WRITE PATH. Controls commit through settings.set and nothing
 *      else; themes paint through ctx.setTheme, the same path the topbar
 *      swatch menu uses. A second path is a fork of rollback and repaint.
 *   3. LIFECYCLE. Open/close/focus belong to layers.js, like every overlay.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

const panel = read('src/app/overlays/settings-panel.js');
const html = read('app.html');
const shell = read('src/app/main.js');
const schemaSrc = read('src/app/system/settings.js');
const palette = read('src/app/overlays/palette.js');
const icons = read('src/app/core/icons.js');

/* ---- 1 · coverage ------------------------------------------------------- */

test('every user-facing schema key has a control in the panel', () => {
  const keys = [...schemaSrc.matchAll(/^ {2}(\w+): \{ type:/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 12, `schema census failed — found ${keys.length}`);

  // The three absences, each with its reason already on record in settings.js:
  // auth plumbing belongs to the options page's guided setup; the other two
  // are the machine's receipts, not the user's knobs.
  const WITHHELD = new Set(['clientId', 'coachDone', 'paletteRecents']);

  for (const key of keys) {
    if (WITHHELD.has(key)) {
      assert.ok(!panel.includes(`key: '${key}'`),
        `${key} is deliberately not a panel control — the reason is in settings.js`);
      continue;
    }
    assert.ok(panel.includes(`key: '${key}'`),
      `schema key '${key}' has no control — a schema entry is a promise, and the panel keeps them`);
  }
});

test('enum controls offer exactly the schema values', () => {
  // A select that invents or forgets a value silently relabels the user's
  // choice through coercion. Both enums are pinned whole.
  for (const v of ['comfortable', 'cosy', 'compact']) {
    assert.ok(panel.includes(`'${v}'`), `density option ${v}`);
  }
  for (const v of ['ask', 'always', 'never']) {
    assert.ok(panel.includes(`'${v}'`), `remoteImages option ${v}`);
  }
});

/* ---- 2 · the one write path ---------------------------------------------- */

test('all writes go through settings.set; themes go through ctx.setTheme', () => {
  assert.match(panel, /settings\.set\(key, value\)/, 'controls commit via settings.set');
  assert.doesNotMatch(panel, /storage\.(set|get)/, 'the panel never touches storage directly');
  assert.match(panel, /ctx\.setTheme\(t\.id\)/, 'theme tiles ride the one theme path');
  assert.match(panel, /settings\.subscribe\(/,
    'live bindings: rollback and sibling-surface changes repaint the open panel');
});

/* ---- 3 · lifecycle + wiring ---------------------------------------------- */

test('lifecycle belongs to layers.js; the module self-registers its reset', () => {
  for (const needle of ['openLayer', 'closeWithMotion', 'cancelExit']) {
    assert.ok(panel.includes(needle), `panel uses ${needle}`);
  }
  assert.match(panel, /registerReset\('settings-panel', _resetSettingsPanel\)/);
});

test('the shell wires a topbar button and a palette command', () => {
  assert.match(html, /<button id="btn-settings"[^>]*aria-haspopup="dialog"/,
    'the topbar invoker declares its dialog');
  assert.match(shell, /\$\('btn-settings'\)\.addEventListener\('click', \(\) => openSettings\(ctx\)\)/);
  assert.match(shell, /openSettings: \(\) => openSettings\(ctx\)/, 'ctx carries it to the palette');
  assert.match(palette, /id: 'settings', icon: 'settings', label: 'Open settings'/);
  assert.match(icons, /settings: '<path/, 'the palette glyph exists');
});

test('the rail and the poll timer follow their settings live', () => {
  // A toggle in the panel that needed a reload would read as broken. These
  // two subscriptions are what make those two rows take effect on the spot.
  assert.match(shell, /key === 'railOpen'\) apply\(settings\.get\('railOpen'\) !== false\)/);
  assert.match(shell, /key === 'autoRefreshMs'\) scheduleAutoRefresh\(\)/);
});

test('the dialog shell exists, starts hidden, and is genuinely modal', () => {
  const m = html.match(/<div id="settings"[^>]*>/);
  assert.ok(m, '#settings exists');
  assert.match(m[0], /role="dialog"/);
  assert.match(m[0], /aria-modal="true"/);
  assert.match(m[0], /aria-labelledby="settings-title"/);
  assert.match(m[0], /hidden/, 'starts hidden');
  assert.ok(html.includes('id="settings-body"'), 'the render target exists');
  assert.ok(html.includes('id="settings-options"'), 'the options-page hand-off exists');
});

test('the surface is sized as a dialog, on the ladder, off the geometry pins', () => {
  const css = read('src/styles/87-settings.css');
  assert.match(css, /width: min\(880px, 100%\);/, '880px — inside the asked-for 40–80% band at 1440px');
  assert.match(css, /height: min\(760px, 84vh\);/, 'a surface you read, not a prompt you squeeze through');
  assert.doesNotMatch(css, /z-index/, 'the z-level is one rung of the V3 ladder, not a local decision');
  assert.match(css, /@media \(max-width: 600px\)/, 'phones get a sheet, not a peephole');
  const skin = read('src/styles/86-v3-skin.css');
  assert.match(skin, /--z-settings: 650;/, 'above compose+popovers, below toast+help+palette');
  assert.match(skin, /#settings \{ z-index: var\(--z-settings\); \}/);
  assert.ok(html.includes('src/styles/87-settings.css'), 'the volume is linked');
});

/* ---- behaviour, with a real document ------------------------------------ */

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

function bootDocument() {
  const dom = new JSDOM(`
    <div id="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" hidden>
      <div id="settings-box">
        <header id="settings-head">
          <h2 id="settings-title">Settings</h2>
          <button id="settings-close" aria-label="Close settings"></button>
        </header>
        <div id="settings-body"></div>
        <footer id="settings-foot">
          <button id="settings-options"></button>
        </footer>
      </div>
    </div>`);
  const prev = {};
  for (const k of ['window', 'document', 'HTMLElement', 'Node', 'chrome']) prev[k] = globalThis[k];
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  // A working storage stub: the real chrome.storage shape, in memory.
  const mem = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => (Array.isArray(keys) ? Object.fromEntries(keys.map((k) => [k, mem[k]])) : { ...mem }),
        set: async (obj) => Object.assign(mem, obj),
        onChanged: { addListener() {}, removeListener() {} },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };
  return {
    dom,
    doc: dom.window.document,
    mem,
    restore() {
      Object.assign(globalThis, prev);
      try { dom.window.close(); } catch { /* best effort */ }
    },
  };
}

test('open renders one control per descriptor item and closes through the layer', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { dom, doc, restore } = bootDocument();
  try {
    const settings = await import('../src/app/system/settings.js');
    await settings.loadSettings();
    const sp = await import('../src/app/overlays/settings-panel.js');
    const { THEMES } = await import('../src/app/system/themes.js');

    const themesPicked = [];
    sp.openSettings({ setTheme: (id) => themesPicked.push(id) });

    const node = doc.getElementById('settings');
    assert.equal(node.hidden, false, 'panel is visible');
    assert.equal(sp.settingsOpen(), true);

    /* The descriptor, by shape: 5 checks, 2 selects, 3 sliders, 1 signature,
       and one radio per theme. If SECTIONS gains a control these numbers
       should move with it — the schema-coverage test is the hard guard. */
    assert.equal(node.querySelectorAll('input[type="checkbox"]').length, 5, 'checkboxes');
    assert.equal(node.querySelectorAll('select').length, 2, 'selects');
    assert.equal(node.querySelectorAll('input[type="range"]').length, 3, 'sliders');
    assert.equal(node.querySelectorAll('textarea').length, 1, 'signature');
    assert.equal(node.querySelectorAll('input[name="set-theme"]').length, THEMES.length,
      'one native radio per theme — arrow keys and grouping are the browser\'s job');

    // A theme tile rides ctx.setTheme, nothing else.
    const radios = [...node.querySelectorAll('input[name="set-theme"]')];
    const target = radios.find((r) => !r.checked);
    target.click();
    assert.deepEqual(themesPicked, [target.value], 'ctx.setTheme got the picked theme');

    // A checkbox commits through settings.set — the cache moves on success…
    const before = settings.get('threaded');
    const boxes = [...node.querySelectorAll('input[type="checkbox"]')];
    const threaded = boxes.find((b) => b.getAttribute('aria-label')?.includes('conversations'));
    assert.ok(threaded, 'the threading checkbox is labelled');
    threaded.checked = !before;
    threaded.dispatchEvent(new dom.window.Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(settings.get('threaded'), !before, 'settings.set ran on the same write path');

    // Close button -> layer close -> hidden + state forgotten.
    doc.getElementById('settings-close').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(node.hidden, true, 'closed panel hides');
    assert.equal(sp.settingsOpen(), false);

    sp._resetSettingsPanel();
    settings._reset();
  } finally {
    restore();
  }
});
