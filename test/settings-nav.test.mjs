/**
 * The settings category rail, and the knobs it gained (2026-08-13).
 *
 * WHY THESE PINS
 * --------------
 * The panel outgrew its single column the same day it was asked to hold
 * "everything a user would want to control". It answered with a vertical
 * tablist — categories you can hit, one panel you can read — and three NEW
 * schema promises, each landed with its consumer in the same commit (the
 * schema's own doctrine: an entry is a promise, never decoration):
 *
 *   ambience       -> 90-motion-system.css kills .lit::before at the root
 *   snippets       -> 20-list.css kills the list preview line at the root
 *   ctrlEnterSend  -> compose.js reads it at the moment the chord lands
 *
 * What must not drift: the rail is a REAL tablist (aria wiring, roving
 * tabindex, arrows that move selection with focus, Escape left to
 * layers.js), and every new key has exactly one consumer — the attr-stamp
 * pattern density established (applyVisualPrefs, boot + subscribe).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

const panel = read('src/app/overlays/settings-panel.js');
const html = read('app.html');
const shell = read('src/app/main.js');
const rootAttrs = read('src/app/system/root-attrs.js');
const schemaSrc = read('src/app/system/settings.js');
const compose = read('src/app/compose/compose.js');
const css = read('src/styles/87-settings.css');
const motionCss = read('src/styles/90-motion-system.css');
const listCss = read('src/styles/20-list.css');

/* ---- the descriptor + schema grew together ------------------------------ */

test('five named sections, in order, each holding its own keys', () => {
  for (const id of ['appearance', 'reading', 'composing', 'sync', 'general']) {
    assert.ok(panel.includes(`id: '${id}'`), `section ${id} exists`);
  }
  /* Reading order is the rail's order — general last, troubleshooting
     classes of settings read top-down. */
  const order = ['appearance', 'reading', 'composing', 'sync', 'general']
    .map((id) => panel.indexOf(`id: '${id}'`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'nav order is stable');
  for (const key of ['ambience', 'snippets', 'ctrlEnterSend']) {
    assert.ok(panel.includes(`key: '${key}'`), `descriptor holds ${key}`);
    assert.match(schemaSrc, new RegExp(`${key}: \\{ type: 'bool', def: true \\}`),
      `schema promises ${key} with its default`);
  }
});

/* ---- every new key has exactly one consumer ------------------------------ */

test('consumers: one attr-stamp, one CSS guard per effect; compose gates the chord', () => {
  assert.match(rootAttrs, /function applyVisualPrefs\(\) \{[\s\S]*?data-ambience[\s\S]*?data-snippets/,
    'one stamper owns both attributes, the way applyDensity owns density');
  assert.match(shell, /applyVisualPrefs\(\);\n\s*\n?\s*initToast\(/,
    'boot stamps the root before first paint');
  assert.match(shell, /key === 'ambience' \|\| key === 'snippets'\) applyVisualPrefs\(\)/,
    'a panel toggle takes effect without reload');
  assert.match(motionCss, /:root\[data-ambience='off'\] \.lit::before \{\n  display: none;/,
    'the sheen dies at the root, next to the rule it guards');
  assert.match(listCss, /:root\[data-snippets='off'\] \.r-snip \{\n  display: none;/,
    'the preview line dies at the root, next to the bloom it defers to');
  assert.match(compose, /e\.key === 'Enter' && settings\.get\('ctrlEnterSend'\) !== false/,
    'the chord consults the setting at the moment it lands');
});

/* ---- the rail is a real tablist ------------------------------------------ */

test('tablist semantics are wired in the module, the markup and the skin', () => {
  assert.match(panel, /tab\.setAttribute\('role', 'tab'\)/);
  assert.match(panel, /sec\.setAttribute\('role', 'tabpanel'\)/);
  assert.match(panel, /tab\.setAttribute\('aria-controls', `set-p-\$\{s\.id\}`\)/);
  assert.match(panel, /sec\.setAttribute\('aria-labelledby', `set-t-\$\{section\.id\}`\)/);
  assert.match(panel, /tab\.tabIndex = on \? 0 : -1/, 'roving tabindex');
  assert.match(panel, /e\.key === 'ArrowDown' \|\| e\.key === 'ArrowRight'/, 'both arrow axes rove');
  assert.match(panel, /if \(j === null\) return;/, 'Escape stays layers.js business — never prevented here');
  assert.match(html, /<nav id="settings-nav" role="tablist" aria-orientation="vertical"/);
  assert.match(css, /\.set-nav\[aria-selected='true'\]/, 'the selected tab has a painted state');
  assert.match(css, /\.set-section\[hidden\] \{\n  display: none;/, 'hidden survives a future display rule');
  assert.match(css, /#settings-main \{[\s\S]*?display: flex;/, 'rail-left, panel-right split');
});

test('actions: the shortcuts sheet and restore-defaults, off the schema path', () => {
  assert.match(panel, /kind: 'action', label: 'Keyboard shortcuts', button: 'Show every key',\n\s+hint: '[^']+',\n\s+run: \(ctx\) => ctx\.toggleHelp\?\.\(\)/);
  assert.match(panel, /async function restoreDefaults\(\) \{[\s\S]*?settings\.reset\(key\)/,
    'restore rides settings.reset — the one write path, not a storage fork');
});

/* ---- behaviour, with a real document ------------------------------------- */

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
        <div id="settings-main">
          <nav id="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections"></nav>
          <div id="settings-body"></div>
        </div>
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
    restore() {
      Object.assign(globalThis, prev);
      try { dom.window.close(); } catch { /* best effort */ }
    },
  };
}

test('one visible panel, roving selection, arrows move focus; Escape untouched', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { dom, doc, restore } = bootDocument();
  try {
    const settings = await import('../src/app/system/settings.js');
    await settings.loadSettings();
    const sp = await import('../src/app/overlays/settings-panel.js');

    sp.openSettings({});
    const tabs = [...doc.querySelectorAll('#settings-nav [role="tab"]')];
    assert.deepEqual(tabs.map((b) => b.textContent),
      ['Appearance', 'Reading', 'Composing', 'Sync & notifications', 'General'],
      'one tab per section, in descriptor order');
    const visible = () => [...doc.querySelectorAll('.set-section')].filter((s) => !s.hidden);
    assert.equal(visible().length, 1, 'exactly one panel painted');
    assert.equal(visible()[0].id, 'set-p-appearance', 'first section by default');
    assert.deepEqual(tabs.map((b) => b.tabIndex), [0, -1, -1, -1, -1], 'roving tabindex');
    assert.equal(tabs[0].getAttribute('aria-controls'), 'set-p-appearance');
    assert.equal(doc.getElementById('set-p-appearance').getAttribute('aria-labelledby'), 'set-t-appearance');

    /* Click moves selection and the panel; the roving stop follows. */
    tabs[1].click();
    assert.equal(visible()[0].id, 'set-p-reading');
    assert.deepEqual(tabs.map((b) => b.tabIndex), [-1, 0, -1, -1, -1]);
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true');

    /* Arrow keys move selection WITH focus (auto-activation), wrapping. */
    tabs[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(visible()[0].id, 'set-p-composing');
    assert.equal(doc.activeElement, tabs[2], 'focus follows the arrow');
    tabs[2].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    assert.equal(visible()[0].id, 'set-p-general');
    assert.equal(doc.activeElement, tabs[4]);
    tabs[4].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(visible()[0].id, 'set-p-appearance', 'wraps at the end');

    /* Escape is NOT the rail's: if the rail swallowed it, layers.js could
       never close the dialog from a tab. */
    const esc = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    tabs[0].dispatchEvent(esc);
    assert.equal(esc.defaultPrevented, false, 'Escape passes through to the layer');

    sp._resetSettingsPanel();
    settings._reset();
  } finally {
    restore();
  }
});

test('action rows run their function; restore-defaults returns the schema', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, restore } = bootDocument();
  try {
    const settings = await import('../src/app/system/settings.js');
    await settings.loadSettings();
    const sp = await import('../src/app/overlays/settings-panel.js');

    let helpCalls = 0;
    sp.openSettings({ toggleHelp: () => helpCalls++ });
    [...doc.querySelectorAll('#settings-nav [role="tab"]')].pop().click(); // General
    const buttons = [...doc.querySelectorAll('#settings-body .set-row button')];
    assert.deepEqual(buttons.map((b) => b.textContent), ['Show every key', 'Restore all defaults']);

    buttons[0].click();
    assert.equal(helpCalls, 1, 'the shortcuts sheet rides ctx.toggleHelp');

    await settings.set('density', 'compact');
    assert.equal(settings.get('density'), 'compact');
    buttons[1].click();
    await new Promise((r) => setTimeout(r, 30)); // the reset loop is async
    assert.equal(settings.get('density'), 'comfortable', 'restore put the schema default back');
    assert.equal(settings.get('ctrlEnterSend'), true, 'new keys restore too');

    sp._resetSettingsPanel();
    settings._reset();
  } finally {
    restore();
  }
});
