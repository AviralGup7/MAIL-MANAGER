/**
 * Options page tests.
 *
 * The options page had NO tests and one setting. It now writes preferences
 * that change how mail is read -- whether unread state survives a mis-click,
 * and whether remote images are allowed to report you to a sender. Both are
 * consequential enough to verify by driving the real page.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  test('options (skipped: jsdom not installed)', { skip: true }, () => {});
}

/*
 * WINDOWS. `new URL('..', import.meta.url).pathname` returns
 * "/C:/Users/asus/Downloads/..." -- a URL path, with a leading slash before
 * the drive letter. Interpolating that into `${ROOT}/options.html` gave
 * Windows a path it resolved against the current drive, producing
 *
 *   C:\C:\Users\asus\Downloads\MAIL-MANAGER-main\options.html
 *
 * and the read failed. On Linux and macOS `.pathname` happens to be a valid
 * filesystem path, so this file passed here and in CI for months while being
 * broken for every Windows contributor.
 *
 * `fileURLToPath` is the conversion that understands drive letters and
 * percent-encoding; `join` is what produces a correct separator. The other
 * four test files already do it this way -- this one was the outlier.
 *
 * Reported by a user running the suite on Windows, which is the only place
 * it could have been found.
 */
const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)));

async function bootOptions(seed = {}, { slowMs = 0 } = {}) {
  const html = readFileSync(join(ROOT, 'options.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'chrome-extension://test/options.html',
    runScripts: 'outside-only',
  });
  const win = dom.window;
  const store = { ...seed };

  win.chrome = {
    runtime: { id: 't', getURL: () => 'chrome-extension://test/' },
    identity: {
      getRedirectURL: () => 'https://dgeanijfllibcphbblkhacjcbdehihcp.chromiumapp.org/',
    },
    storage: {
      local: {
        async get(k) {
          // Optional latency, to prove the page waits for storage rather than
          // for a task tick.
          if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
          if (Array.isArray(k)) {
            const o = {};
            for (const x of k) if (x in store) o[x] = store[x];
            return o;
          }
          if (typeof k === 'string') return k in store ? { [k]: store[k] } : {};
          return { ...store };
        },
        async set(o) { Object.assign(store, o); },
        async remove(k) { for (const x of [].concat(k)) delete store[x]; },
      },
    },
  };

  const prev = {};
  for (const k of ['window', 'document', 'chrome']) prev[k] = globalThis[k];
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.chrome = win.chrome;

  await import(pathToFileURL(join(ROOT, 'src/options/options.js')).href + `?t=${Math.random()}`);
  await new Promise((r) => setTimeout(r, 60));

  return {
    win, doc: win.document, store,
    restore: () => Object.assign(globalThis, prev),
  };
}

test('preferences load with their schema defaults', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, restore } = await bootOptions();
  try {
    assert.equal(doc.getElementById('markReadOnOpen').checked, true);
    assert.equal(doc.getElementById('markReadDelayMs').value, '1200');
    assert.equal(doc.getElementById('markReadDelayLabel').textContent, '1.2s');
    assert.equal(doc.getElementById('remoteImages').value, 'ask');
  } finally {
    restore();
  }
});

test('a stored preference is reflected, not overwritten by the default', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, restore } = await bootOptions({ remoteImages: 'never', markReadDelayMs: 3000 });
  try {
    assert.equal(doc.getElementById('remoteImages').value, 'never');
    assert.equal(doc.getElementById('markReadDelayMs').value, '3000');
    assert.equal(doc.getElementById('markReadDelayLabel').textContent, '3.0s');
  } finally {
    restore();
  }
});

/*
 * Dragging a slider fires `input` continuously. Writing on each one is a
 * storage round trip per pixel, so the label updates live and the WRITE waits
 * for `change`.
 */
test('dragging the delay slider updates the label without writing', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, store, restore } = await bootOptions();
  try {
    const slider = doc.getElementById('markReadDelayMs');
    slider.value = '2400';
    slider.dispatchEvent(new win.Event('input'));
    assert.equal(doc.getElementById('markReadDelayLabel').textContent, '2.4s');
    assert.equal(store.markReadDelayMs, undefined, 'must not write on every input event');

    slider.dispatchEvent(new win.Event('change'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.markReadDelayMs, 2400, 'commits on change');
  } finally {
    restore();
  }
});

test('zero delay reads as "off" rather than "0.0s"', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, restore } = await bootOptions();
  try {
    const slider = doc.getElementById('markReadDelayMs');
    slider.value = '0';
    slider.dispatchEvent(new win.Event('input'));
    assert.equal(doc.getElementById('markReadDelayLabel').textContent, 'off');
  } finally {
    restore();
  }
});

test('the delay control is disabled when marking-read is off', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // A live control that does nothing is worse than an absent one.
  const { doc, win, store, restore } = await bootOptions();
  try {
    const cb = doc.getElementById('markReadOnOpen');
    const slider = doc.getElementById('markReadDelayMs');
    assert.equal(slider.disabled, false);

    cb.checked = false;
    cb.dispatchEvent(new win.Event('change'));
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(store.markReadOnOpen, false);
    assert.equal(slider.disabled, true, 'the dependent control must disable');
  } finally {
    restore();
  }
});

test('the image policy persists', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, store, restore } = await bootOptions();
  try {
    const sel = doc.getElementById('remoteImages');
    sel.value = 'never';
    sel.dispatchEvent(new win.Event('change'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.remoteImages, 'never');
  } finally {
    restore();
  }
});

test('an out-of-range stored value is coerced, not trusted', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Storage is shared with older builds; a value from a previous schema must
  // never reach the UI unchecked.
  const { doc, restore } = await bootOptions({ markReadDelayMs: 999999, remoteImages: 'bogus' });
  try {
    // The schema max is 5000ms; the slider max matches it.
    assert.equal(doc.getElementById('markReadDelayMs').value, '5000', 'clamped to the max');
    assert.equal(doc.getElementById('remoteImages').value, 'ask', 'unknown enum falls back');
  } finally {
    restore();
  }
});

test('the page no longer claims PKCE', async () => {
  // PKCE was tried and abandoned -- Google demands a client_secret from a Web
  // application client even with a verifier. Docs that describe a flow the
  // code does not use send people to the wrong Google Cloud settings.
  const html = readFileSync(join(ROOT, 'options.html'), 'utf8');
  // Strip comments: the source explains WHY PKCE was abandoned, which is
  // worth keeping. What matters is that no user-visible text claims it.
  const visible = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/PKCE/i.test(visible), 'user-visible copy still mentions PKCE');
  assert.match(visible, /implicit/i, 'it should name the flow actually used');
});

test('the client-ID guard still refuses a pasted secret', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  // Guards against the exact mistake v1 institutionalised.
  const { doc, store, restore } = await bootOptions();
  try {
    /*
     * Deliberately SHORT. The repo-wide secret scanner in package.test.mjs
     * flags `GOCSPX-` followed by 10+ characters, and it is right to: a
     * realistic-looking fixture is indistinguishable from a real leak to
     * anyone grepping the repo, including that scanner. The guard under test
     * keys on the prefix, so a short value exercises it exactly the same.
     */
    doc.getElementById('clientId').value = 'GOCSPX-x1';
    doc.getElementById('save').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.clientId, undefined, 'a secret must never be stored');
    assert.match(doc.getElementById('status').textContent, /secret/i);
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------- signature -- */

test('saving a client ID probes the worker and reports signed-in', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const h = await bootOptions();
  try {
    // Extend the harness chrome mock with a worker that answers.
    h.win.chrome.runtime.sendMessage = (msg, cb) => {
      cb({ ok: true, data: { signedIn: true } });
    };
    globalThis.chrome = h.win.chrome;
    h.doc.getElementById('clientId').value = '12345.apps.googleusercontent.com';
    h.doc.getElementById('save').click();
    await new Promise((r) => setTimeout(r, 80));
    assert.match(h.doc.getElementById('status').textContent, /signed in and ready/);
  } finally {
    h.restore();
  }
});

test('saving a client ID reports the next step when not yet signed in', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const h = await bootOptions();
  try {
    h.win.chrome.runtime.sendMessage = (msg, cb) => {
      cb({ ok: true, data: { signedIn: false } });
    };
    globalThis.chrome = h.win.chrome;
    h.doc.getElementById('clientId').value = '12345.apps.googleusercontent.com';
    h.doc.getElementById('save').click();
    await new Promise((r) => setTimeout(r, 80));
    assert.match(h.doc.getElementById('status').textContent, /open Gmail/);
  } finally {
    h.restore();
  }
});

test('an existing signature loads into the field', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, restore } = await bootOptions({ signature: 'Aviral Gupta' });
  try {
    assert.equal(doc.getElementById('signature').value, 'Aviral Gupta');
  } finally {
    restore();
  }
});

test('the signature field does not race a slow storage read', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * This was a real hazard. The field was populated from a `setTimeout(0)`,
   * which happens to win in jsdom but is not guaranteed in Chrome. The failure
   * mode is nasty: the box renders EMPTY, and the blur handler then writes
   * that empty value over the user's stored signature.
   */
  const { doc, restore } = await bootOptions({ signature: 'Persisted' }, { slowMs: 25 });
  try {
    assert.equal(
      doc.getElementById('signature').value, 'Persisted',
      'the field must wait for storage, not for a task tick'
    );
  } finally {
    restore();
  }
});

test('leaving the signature field persists it', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  const { doc, win, store, restore } = await bootOptions();
  try {
    const box = doc.getElementById('signature');
    box.value = 'New Sig';
    box.dispatchEvent(new win.Event('blur'));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(store.signature, 'New Sig');
  } finally {
    restore();
  }
});

test('every setting in the schema has a control on this page', async (t) => {
  if (!JSDOM) return t.skip('jsdom not installed');
  /*
   * `clientId` and `theme` are handled elsewhere (its own fieldset, and the
   * in-app theme picker). `coachDone` is an internal one-time flag (the
   * coach toast) that deliberately has no user-facing control; `railOpen`
   * is the same class -- its control is the in-app rail toggle, which is
   * where a user actually looks for it (round 64.5). Both are schema-backed
   * so backup/restore round-trips them. `paletteRecents` is likewise
   * control-free by design (round 65/f): it is observed usage history the
   * machine maintains, and a text field full of command ids would be a knob
   * nobody should have to polish. Everything else must be
   * reachable, or it is a setting the user cannot change -- which is how
   * dead schema entries start.
   */
  const { doc, restore } = await bootOptions();
  try {
    const schema = readFileSync(join(ROOT, 'src/app/system/settings.js'), 'utf8');
    const declared = [...schema.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*): \{ type:/gm)]
      .map((m) => m[1]);

    /* `ambience`, `snippets` and `ctrlEnterSend` belong to this set from
       the day the in-app settings panel shipped (2026-08-13): the panel
       keeps every user-facing key one click from the mail, so the options
       page keeps only workflows (rules dry-run, backup, sign-in). The two
       theme-authority axes, `textures` and `sounds`, are that same class
       (2026-08-14): skin atmosphere toggles live beside Ambient light on
       the panel's Appearance sheet, and the authority pins in
       settings-authority.test.mjs watch the chain. `clearOutboxOnSignOut`
       joins them (2026-08-15, AUD-C2): its control is a send-semantics
       choice, so it lives on the panel's Composing sheet beside the undo
       window it governs, and settings-panel.test.mjs counts it there. */
    const ELSEWHERE = new Set([
      'clientId', 'theme', 'coachDone', 'railOpen', 'paletteRecents',
      'ambience', 'snippets', 'ctrlEnterSend', 'textures', 'sounds',
      'clearOutboxOnSignOut',
      // UI generation controls live in the in-app Interface intelligence
      // sheet, where their result is visible immediately.
      'uiProfile', 'cyberpunkIntensity', 'showTelemetry', 'showProvenance',
      'readerDossier', 'threadTimeline', 'queryConsole', 'timetableTerminal',
      'operationCenter', 'calmContent',
    ]);
    const missing = declared
      .filter((k) => !ELSEWHERE.has(k))
      .filter((k) => !doc.getElementById(k));

    assert.deepEqual(missing, [], 'settings with no control on the options page');
  } finally {
    restore();
  }
});
