/**
 * Package integrity.
 *
 * The whole reason this file exists: version 2 spent three commits in a state
 * where `manifest.json` and `content.js` both referenced `app.html`, and
 * `app.html` did not exist. Nothing caught it, because nothing checked that
 * the files a manifest promises are actually in the package. Chrome only tells
 * you at load time, and only for some of them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

const has = (p) => existsSync(join(ROOT, p));

/** Every .js file under src/, relative to the repo root. */
function jsFiles(rel = 'src', out = []) {
  for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
    const p = `${rel}/${e.name}`;
    if (e.isDirectory()) jsFiles(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('every file the manifest names exists', () => {
  const missing = [];
  for (const p of Object.values(manifest.icons || {})) if (!has(p)) missing.push(p);
  for (const cs of manifest.content_scripts || []) {
    for (const p of [...(cs.js || []), ...(cs.css || [])]) if (!has(p)) missing.push(p);
  }
  if (manifest.background?.service_worker && !has(manifest.background.service_worker)) {
    missing.push(manifest.background.service_worker);
  }
  if (manifest.options_ui?.page && !has(manifest.options_ui.page)) {
    missing.push(manifest.options_ui.page);
  }
  for (const war of manifest.web_accessible_resources || []) {
    for (const p of war.resources || []) {
      if (p.includes('*')) continue; // globs are checked by the entry-point test
      if (!has(p)) missing.push(p);
    }
  }
  assert.deepEqual(missing, [], `manifest references missing files: ${missing.join(', ')}`);
});

test('app.html exists and loads its script and stylesheet', () => {
  // content.js does chrome.runtime.getURL('app.html'); if this is absent the
  // takeover renders a blank frame and the extension is dead on arrival.
  assert.ok(has('app.html'));
  const html = read('app.html');
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const p = m[1];
    if (/^(https?:|data:|#)/.test(p)) continue;
    assert.ok(has(p), `app.html references missing ${p}`);
  }
});

test('options.html loads its script', () => {
  const html = read('options.html');
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const p = m[1];
    if (/^(https?:|data:|#)/.test(p)) continue;
    assert.ok(has(p), `options.html references missing ${p}`);
  }
});

test('every relative import in src/ resolves', async () => {
  const files = [];
  await walk('src');
  const missing = [];
  for (const f of files) {
    const text = read(f);
    for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(join(ROOT, f)), m[1]);
      if (!existsSync(target)) missing.push(`${f} -> ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `unresolved imports: ${missing.join(', ')}`);

  async function walk(rel) {
    for (const e of await readdir(join(ROOT, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  }
});

test('no OAuth client secret anywhere in the source', async () => {
  // v1 shipped one. This test makes shipping another one a test failure rather
  // than a discovery made by a stranger reading the public repo.
  const offenders = [];
  await walk('.');
  assert.deepEqual(offenders, [], `possible secret in: ${offenders.join(', ')}`);

  async function walk(rel) {
    for (const e of await readdir(join(ROOT, rel), { withFileTypes: true })) {
      if (['.git', 'node_modules', 'icons'].includes(e.name)) continue;
      const p = rel === '.' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      if (!/\.(js|mjs|json|html|css|md|py)$/.test(e.name)) continue;
      // SECURITY.md and README.md quote the v1 mistake verbatim in order to
      // explain it. Documenting a leak is not committing one.
      if (/^(SECURITY|README)\.md$/.test(e.name)) continue;
      const text = read(p);
      // A real secret is GOCSPX- followed by the value. Prose mentioning the
      // prefix (SECURITY.md, options.js's guard) must not trip this.
      if (/GOCSPX-[A-Za-z0-9_-]{10,}/.test(text)) offenders.push(p);
      if (/client_secret\s*[:=]\s*['"][^'"]+['"]/.test(text)) offenders.push(p);
    }
  }
});

test('every chrome.* API the code uses is actually permitted', () => {
  // THIS TEST EXISTS BECAUSE ITS PREDECESSOR CAUSED AN OUTAGE.
  //
  // The old version asserted `!permissions.includes('tabs')` as a
  // minimisation guard, while src/background/index.js called chrome.tabs.*
  // on every toolbar click. The test enforced the bug: it went green while
  // the extension could not work at all. Minimisation is only a virtue when
  // the removed permission is genuinely unused.
  //
  // So this checks the direction that matters -- used implies permitted --
  // rather than asserting a hardcoded list.
  // Only APIs that REQUIRE a permissions entry. Deliberately excludes
  // chrome.tabs: its messaging and lifecycle methods need nothing, and the
  // parts that read tab.url are satisfied by a host permission for the tab in
  // question -- which is narrower than "tabs", since "tabs" would expose the
  // URL of every tab the user has open. That distinction is asserted by the
  // host-permissions test below.
  //
  // Also excludes action, runtime, commands and windows, which need no entry.
  const NEEDS_PERMISSION = {
    scripting: 'scripting',
    storage: 'storage',
    identity: 'identity',
    alarms: 'alarms',
    notifications: 'notifications',
    bookmarks: 'bookmarks',
    downloads: 'downloads',
    history: 'history',
    cookies: 'cookies',
    webRequest: 'webRequest',
    contextMenus: 'contextMenus',
    idle: 'idle',
    sidePanel: 'sidePanel',
  };

  const used = new Set();
  for (const f of jsFiles()) {
    for (const m of read(f).matchAll(/chrome\.([a-zA-Z]+)/g)) used.add(m[1]);
  }

  const granted = new Set(manifest.permissions);
  const missing = [...used]
    .filter((api) => NEEDS_PERMISSION[api] && !granted.has(NEEDS_PERMISSION[api]))
    .sort();

  assert.deepEqual(missing, [], `code calls chrome.${missing.join(', chrome.')} without permission`);
});

test('no permission is granted that the code never uses', () => {
  // The other direction. Unused permissions are what the minimisation effort
  // was actually for -- v1 shipped `notifications` and a generativelanguage
  // host permission that no code referenced.
  const src = jsFiles().map(read).join('\n');
  for (const perm of manifest.permissions) {
    // `scripting` is used via chrome.scripting, `identity` via chrome.identity, etc.
    assert.ok(
      src.includes(`chrome.${perm}`),
      `"${perm}" is granted but chrome.${perm} appears nowhere in src/`
    );
  }
});

test('host permissions cover the pages the extension must read', () => {
  // tab.url is only populated for a tab the extension has host access to.
  // Without mail.google.com here, the toolbar button cannot tell whether it is
  // on Gmail -- which is precisely how it ended up opening a new tab on every
  // click, each one resolving to the browser default account.
  const hosts = manifest.host_permissions.join(' ');
  assert.ok(hosts.includes('https://mail.google.com/*'), 'need host access to read tab.url on Gmail');
  for (const cs of manifest.content_scripts || []) {
    for (const pattern of cs.matches) {
      assert.ok(
        manifest.host_permissions.includes(pattern),
        `content script matches ${pattern} but it is not in host_permissions`
      );
    }
  }
});

test('the keyboard shortcut does not collide with a browser shortcut', () => {
  // Ctrl+Shift+M is the profile switcher in Chrome and Brave. A colliding
  // suggested_key is never delivered to the extension, so the shortcut simply
  // did nothing while opening the browser's own profile menu.
  const RESERVED = [
    'Ctrl+Shift+M', 'Ctrl+Shift+N', 'Ctrl+Shift+T', 'Ctrl+Shift+W',
    'Ctrl+Shift+Q', 'Ctrl+Shift+J', 'Ctrl+Shift+I', 'Ctrl+Shift+B',
    'Ctrl+Shift+O', 'Ctrl+Shift+P', 'Ctrl+Shift+Delete', 'Ctrl+N',
    'Ctrl+T', 'Ctrl+W',
  ];
  for (const [name, cmd] of Object.entries(manifest.commands || {})) {
    for (const key of Object.values(cmd.suggested_key || {})) {
      assert.ok(
        !RESERVED.includes(key),
        `command "${name}" uses ${key}, which the browser reserves`
      );
    }
  }
});

test('scopes stayed minimal', () => {
  const auth = read('src/background/auth.js');
  const scopes = auth.match(/const SCOPES = \[([\s\S]*?)\]/)[1];
  assert.ok(scopes.includes('gmail.modify'));
  for (const banned of ['gmail.send', 'gmail.labels', 'userinfo']) {
    assert.ok(!scopes.includes(banned), `scope ${banned} came back`);
  }
  const hosts = JSON.stringify(manifest.host_permissions);
  assert.ok(!hosts.includes('generativelanguage'), 'the unused AI host permission came back');
});

test('the body iframe never gets allow-scripts or allow-same-origin', () => {
  // The primary XSS control for untrusted mail. Adding either of these to make
  // some newsletter render correctly would silently remove it.
  const html = read('app.html');
  const sandbox = html.match(/id="r-body"[\s\S]*?sandbox="([^"]*)"/)?.[1];
  assert.ok(sandbox !== undefined, 'body iframe lost its sandbox attribute');
  assert.ok(!sandbox.includes('allow-scripts'));
  assert.ok(!sandbox.includes('allow-same-origin'));
});

test('generated classifier files are in sync with the data pack', () => {
  // pattern-rules.js and address-map.js are GENERATED from
  // docs/CLASSIFICATION_DATA_PACK.md. If someone edits either by hand, or
  // edits the pack without regenerating, classification silently diverges from
  // the source of truth -- which is exactly how the first port ended up with
  // 89 of 891 keys while claiming to be a faithful copy.
  const pack = read('docs/CLASSIFICATION_DATA_PACK.md');

  // Section 6 -> pattern-rules.js
  const block = pack.slice(pack.indexOf('## 6. Pattern Rule Definitions'), pack.indexOf('## 7. Email Mappings'));
  let packKeys = 0;
  for (const sec of block.split(/\n### /).slice(1)) {
    const code = sec.match(/```js\n([\s\S]*?)```/)?.[1];
    if (!code) continue;
    const obj = new Function(`return (${code.replace(/export\s+default\s*/, '').trim().replace(/;$/, '')})`)();
    packKeys += (obj.senderExact || []).length + (obj.senderContains || []).length;
    packKeys += Object.keys(obj.subjectWeights || {}).length + Object.keys(obj.snippetWeights || {}).length;
  }

  const rulesSrc = read('src/classify/pattern-rules.js');
  assert.ok(rulesSrc.includes('GENERATED FILE'), 'pattern-rules.js lost its generated banner');
  assert.ok(packKeys > 800, `data pack parsed to only ${packKeys} keys`);

  // Section 7 -> address-map.js
  const mapBlock = pack.slice(pack.indexOf('## 7. Email Mappings'), pack.indexOf('## 8. Pipeline Logic'));
  const packAddrs = new Set([...mapBlock.matchAll(/"email":\s*"([^"]+)"/g)].map((m) => m[1].toLowerCase()));
  const mapSrc = read('src/classify/address-map.js');
  assert.ok(mapSrc.includes('GENERATED FILE'), 'address-map.js lost its generated banner');

  const missing = [...packAddrs].filter((a) => !mapSrc.includes(`'${a}'`));
  assert.deepEqual(missing, [], `addresses in the pack but not the map: ${missing.slice(0, 5).join(', ')}`);
});

test('the listbox has no wrapper between it and its options', () => {
  // Static guard on the template. The integration test asserts the rendered
  // tree; this catches someone reintroducing a <ul> in the HTML, which is how
  // the invalid tree got there the first time.
  const html = read('app.html');
  const listbox = html.match(/<div id="list"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(listbox, '#list must exist');
  assert.ok(/role="listbox"/.test(listbox[0]), '#list must BE the listbox');
  assert.equal(listbox[1].trim(), '', '#list must be empty in the template');
  assert.ok(!/<ul[^>]*id="list"/.test(html), 'the list must not be a <ul>');
});

test('the reading pane is not a live region', () => {
  const html = read('app.html');
  const pane = html.match(/<div id="readpane"[^>]*>/)[0];
  assert.ok(!pane.includes('aria-live'), 'aria-live on the pane announces everything in it');
});

test('every stylesheet parses', async () => {
  // A stray brace makes a browser silently drop the REST of the file. This
  // shipped once: relocating the prefers-reduced-motion block left an orphan
  // "}" behind, and everything after it -- the entire appearance layer --
  // stopped applying. Nothing caught it, because the tests assert on DOM
  // structure and jsdom does not apply stylesheets to them.
  let JSDOM, VirtualConsole;
  try {
    ({ JSDOM, VirtualConsole } = await import('jsdom'));
  } catch {
    return; // graceful skip, as elsewhere
  }
  for (const file of ['src/app/app.css', 'src/takeover/takeover.css']) {
    const css = read(file);
    // Cheap structural check first: it localises the fault far better than a
    // parser error does.
    const open = (css.match(/{/g) || []).length;
    const close = (css.match(/}/g) || []).length;
    assert.equal(open, close, `${file}: ${open} "{" vs ${close} "}"`);

    const errors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => errors.push(e.message));
    new JSDOM(`<style>${css}</style>`, { virtualConsole: vc });
    assert.deepEqual(errors, [], `${file} failed to parse`);
  }
});

test('prefers-reduced-motion is the LAST rule in app.css', () => {
  // Same specificity means source order decides. An override that is not last
  // does not override -- an infinite animation appended after it escapes
  // entirely, which is exactly what happened.
  const css = read('src/app/app.css');
  const i = css.lastIndexOf('@media (prefers-reduced-motion');
  assert.ok(i !== -1, 'the reduced-motion block must exist');
  const after = css.slice(i).split('}').slice(4).join('}');
  assert.equal(after.trim(), '', 'no rules may follow the reduced-motion block');
});

test('the manifest key is present and pins the extension ID', async () => {
  // WHY THIS MATTERS MORE THAN IT LOOKS
  //
  // Chrome derives the extension ID by hashing the public key. With no "key"
  // field it invents a new keypair per unpacked load, so the ID -- and
  // therefore the OAuth redirect URI https://<id>.chromiumapp.org/ -- changes
  // every time. Google then rejects the sign-in with redirect_uri_mismatch,
  // and the only fix is re-registering the URI after every single reload.
  //
  // v1 carried this key. Dropping it in the rewrite is why auth could never
  // have worked on a fresh load.
  const { createHash } = await import('node:crypto');

  assert.ok(manifest.key, 'manifest.key is required to keep the ID stable');

  const der = Buffer.from(manifest.key, 'base64');
  assert.equal(
    der.toString('base64'),
    manifest.key,
    'key must be valid base64 with no whitespace or line breaks'
  );
  assert.equal(der[0], 0x30, 'must be a DER SEQUENCE (SPKI public key)');

  // It must be a PUBLIC key. Committing a private key would let anyone sign
  // an update that Chrome accepts as this extension.
  const { createPublicKey } = await import('node:crypto');
  const parsed = createPublicKey({ key: der, format: 'der', type: 'spki' });
  assert.equal(parsed.type, 'public', 'never commit a private key');
  assert.equal(parsed.asymmetricKeyType, 'rsa');

  // Chrome's ID derivation: first 16 bytes of sha256(DER), each hex nibble
  // mapped 0-f -> a-p.
  const hash = createHash('sha256').update(der).digest('hex').slice(0, 32);
  const id = [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

  assert.equal(
    id,
    'dgeanijfllibcphbblkhacjcbdehihcp',
    'the extension ID changed — every registered OAuth redirect URI is now invalid'
  );
});

test('every element the app hides with [hidden] actually disappears', async () => {
  // THE BUG THIS CATCHES: sign-in completed, the token was stored, and the
  // gate stayed on screen. `hidden` is only a UA-level `display: none`, so
  // `#gate { display: grid }` silently outranked it. Three elements were
  // affected -- gate, reader, and r-loading -- and none of the 241 tests
  // noticed, because they assert on the `hidden` PROPERTY rather than on
  // whether the pixel is painted.
  let JSDOM;
  try {
    ({ JSDOM } = await import('jsdom'));
  } catch {
    return; // graceful skip, as elsewhere
  }

  const css = read('src/app/app.css');
  const html = read('app.html')
    .replace(/<link rel="stylesheet"[^>]*>/, `<style>${css}</style>`)
    .replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html);
  const { window: win } = dom;

  // Every element the app toggles via `.hidden` in app.js.
  const toggled = new Set(
    [...read('src/app/app.js').matchAll(/el\.(\w+)\.hidden\s*=/g)].map((m) => m[1])
  );
  assert.ok(toggled.size >= 5, `expected several hidden-toggled elements, found ${toggled.size}`);

  const stillVisible = [];
  for (const el of win.document.querySelectorAll('#gate, #reader, #r-loading, #thememenu, #empty, #toast, #reader-empty')) {
    el.hidden = true;
    if (win.getComputedStyle(el).display !== 'none') {
      stillVisible.push(`#${el.id} (${win.getComputedStyle(el).display})`);
    }
  }
  assert.deepEqual(stillVisible, [], 'these ignore the hidden attribute');
});

test('the preview bundler survives modules sharing a top-level name', () => {
  // The bundler used to concatenate every module into ONE scope and strip the
  // import/export keywords. That works only while no two files share a
  // top-level name -- and the moment two of them each defined `DAY_MS`, and
  // later `$`, the whole preview died with "Identifier has already been
  // declared" and rendered a blank page.
  //
  // That was a BUNDLER defect, not a source defect: both files are valid ES
  // modules that Node loads without complaint. Renaming symbols to appease the
  // preview would have been fixing the wrong thing.
  const tool = read('tools/make-preview.mjs');
  assert.ok(
    tool.includes('__m['),
    'each module must be emitted in its own closure, keyed in a registry'
  );
  assert.ok(
    !/everything ends up in one module scope/.test(tool),
    'the flat-scope approach must not come back'
  );
});

test('new UI surfaces exist and start hidden', () => {
  // A surface that ships visible-by-default is immediately obvious; one that
  // ships permanently hidden is not, and the [hidden] override bug already
  // caught us once.
  const html = read('app.html');
  for (const id of ['compose', 'palette', 'radar']) {
    const m = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`));
    assert.ok(m, `#${id} must exist in app.html`);
    assert.ok(m[0].includes('hidden'), `#${id} must start hidden`);
  }
  assert.ok(html.includes('id="btn-compose"'), 'compose button must exist');
});

test('the stylesheet uses design tokens, not ad-hoc values', () => {
  // Before tokens the file had ELEVEN font sizes (10, 10.5, 11, 11.5, 12,
  // 12.5, 13, 13.5, 15, 17, 18) and TWELVE corner radii. Each was individually
  // defensible; collectively they are why an interface reads as assembled
  // rather than designed. This keeps the set closed.
  const css = read('src/app/app.css');
  const body = css.slice(css.indexOf('/*\n * THEME VALUES LIVE IN'));

  const sizes = [...body.matchAll(/font-size:\s*([0-9.]+px)/g)].map((m) => m[1]);
  assert.deepEqual(sizes, [], `raw font sizes outside the scale: ${[...new Set(sizes)].join(', ')}`);

  // Multi-value corners (`12px 12px 0 0`) are matched separately below.
  const radii = [...body.matchAll(/border-radius:\s*([0-9]+px);/g)].map((m) => m[1]);
  assert.deepEqual(radii, [], `raw radii outside the scale: ${[...new Set(radii)].join(', ')}`);
});

test('no component is defined in two places', () => {
  // `.row` was previously declared in two blocks 470 lines apart: one set the
  // background, another added the selection rail, and neither could be
  // understood without the other. That is how a component drifts.
  const css = read('src/app/app.css');
  for (const sel of ['.row', '.tag', '.r-bar', '#reader-head', '#empty']) {
    const escaped = sel.replace(/[.#]/g, '\\$&');
    const hits = [...css.matchAll(new RegExp(`^${escaped}\\s*\\{`, 'gm'))].length;
    assert.equal(hits, 1, `${sel} is defined ${hits} times; it must be defined once`);
  }
});

test('the empty state explains WHICH kind of empty it is', () => {
  // "Nothing here." was the same message whether the user over-filtered, hit
  // an empty category, or had genuinely read everything -- three situations
  // needing three different next actions.
  const html = read('app.html');
  assert.ok(html.includes('id="empty-title"'), 'empty state needs a title');
  assert.ok(html.includes('id="empty-sub"'), 'empty state needs an explanation');
  assert.ok(html.includes('id="empty-action"'), 'empty state needs a way out');

  const js = read('src/app/app.js');
  assert.match(js, /No matches/, 'must handle the over-filtered case');
  assert.match(js, /Clear search/, 'must offer an escape from a bad search');
});

test('iconography is one coherent set, not mixed glyphs', () => {
  // The interface previously mixed three hand-drawn SVGs with text glyphs:
  // `x` for close, a hyphen for minimise, a star, an emoji paperclip. That is
  // the clearest tell of an assembled interface, and it fails concretely: a
  // glyph renders in whatever font the platform picks, so it never optically
  // matches a stroked icon beside it and is never quite centred in its button.
  const html = read('app.html');
  const js = read('src/app/app.js') + read('src/app/features.js');

  for (const glyph of ['★', '×', '✓', '📎', '◐']) {
    assert.ok(
      !html.includes(glyph),
      `app.html still uses "${glyph}" as an icon; use icons.js instead`
    );
  }
  // A glyph assigned as content in JS is the same mistake by another route.
  assert.ok(!/textContent = '[★×✓📎◐]'/.test(js), 'a glyph is being set as icon content');
});

test('every icon shares one geometry', () => {
  // Mixed viewBoxes or stroke widths are why an icon set looks bought rather
  // than drawn. One 20x20 grid, one 1.6 stroke, currentColor throughout.
  const src = read('src/app/icons.js');
  assert.match(src, /viewBox', '0 0 20 20'/, 'all icons must share a 20x20 grid');
  assert.match(src, /stroke-width', filled \? '0' : '1\.6'/, 'one stroke weight');
  assert.ok(
    !/fill="#|stroke="#/.test(src),
    'icons must use currentColor so they theme for free'
  );
});
