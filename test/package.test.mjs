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

/*
 * NO SEMANTIC COLOUR MAY BYPASS THE THEME SYSTEM.
 *
 * `#eab308` was hardcoded three times for the starred indicator. Because it
 * was not a token, `npm run contrast` never saw it, and it failed WCAG 1.4.11
 * on NINE of eighteen theme/surface combinations -- including the default
 * theme at 1.77:1 and the theme literally named "High Contrast".
 *
 * Themes are data so that every colour can be checked mechanically. A literal
 * in the stylesheet opts out of that guarantee, so the set of permitted
 * literals is closed here.
 */
test('no hardcoded colour bypasses the theme tokens', () => {
  const css = read('src/app/app.css');
  const body = css.slice(css.indexOf('/*\n * THEME VALUES LIVE IN'));

  /*
   * Scope: DECLARATIONS ONLY, and not the `:root` fallback block.
   *
   * `:root` is where the token defaults legitimately live as literals -- it is
   * the definition site, and themes.js overwrites it at runtime. And `#account`
   * is a selector, not a colour, so matching anywhere would produce nonsense
   * findings and train people to ignore this test.
   */
  const declarations = body
    .split('\n')
    .filter((l) => /^\s*[a-z-]+\s*:/.test(l) && !/^\s*--/.test(l))
    .join('\n');

  // Neutral overlays and shadow scrims are legitimately not themed: a modal
  // backdrop is the absence of a surface, not a surface. Shadows are neutral
  // ink by design and are checked by eye, not for contrast.
  const ALLOWED =
    /^(#fff|#ffffff|#000|#000000|rgba\(0,\s*0,\s*0,[^)]*\)|rgba\(255,\s*255,\s*255,[^)]*\)|rgba\(16,\s*24,\s*40,[^)]*\)|rgba\(128,\s*128,\s*128,[^)]*\)|transparent)$/i;

  const found = [...declarations.matchAll(/(?:^|[\s:,(])(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\))/g)]
    .map((m) => m[1].trim())
    .filter((c) => !ALLOWED.test(c));

  assert.deepEqual(
    [...new Set(found)], [],
    'these colours must become theme tokens so the contrast checker can see them'
  );
});

test('every theme defines every colour role the CSS consumes', () => {
  // A theme missing a role renders that element with an EMPTY custom property,
  // which inherits or falls back to black -- invisible in a dark theme and
  // impossible to spot in review.
  const themes = read('src/app/themes.js');
  const css = read('src/app/app.css');

  // Roles the stylesheet actually reads.
  const used = new Set(
    [...css.matchAll(/var\(--(bg|bg-raised|bg-sunken|fg|fg-dim|fg-faint|line|line-strong|accent|accent-fg|accent-soft|danger|warning|success|star|glow)\b/g)]
      .map((m) => m[1])
  );
  assert.ok(used.has('star'), 'the star token should be in use');

  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const blocks = themes.split(/\n  \{\n/).slice(1);
  assert.equal(blocks.length, 6, 'expected six themes');

  for (const block of blocks) {
    const name = /name: '([^']+)'/.exec(block)?.[1] || '?';
    for (const role of used) {
      assert.ok(
        new RegExp(`\\n\\s{4}${camel(role)}:`).test(block),
        `theme "${name}" is missing the "${camel(role)}" colour`
      );
    }
  }
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

/*
 * THE GENERAL FORM OF THE ABOVE.
 *
 * The hand-written list only covered five selectors, so drift anywhere else
 * went unnoticed. Measuring every selector found seven same-layer duplicates,
 * two of them real bugs: `.primary svg` set `opacity: 0.85` and then
 * immediately overrode it to `1` (the softening was dead code), and
 * `.r-star[aria-pressed='true']` set the same colour twice.
 *
 * This file is deliberately LAYERED -- STRUCTURE, then APPEARANCE, then
 * MOTION, then DEPTH -- so the same selector reappearing in a LATER layer is
 * an intentional override and is allowed. Two blocks in the SAME layer are
 * not: nobody reading either one can know the other exists.
 */
/*
 * NOTHING MAY ANIMATE WHILE THE APP IS IDLE.
 *
 * The file header states this as a standing rule and NO TEST ENFORCED IT.
 * An infinite animation with no gate holds a compositor layer awake forever,
 * which is the defect that made the previous version warm the machine while
 * sitting untouched.
 *
 * Infinite animations are allowed only where they report live work and are
 * switched off by a state that genuinely ends.
 */
test('every infinite animation is gated on a state that ends', () => {
  const css = read('src/app/app.css');
  const lines = css.split('\n');

  // Selectors permitted to loop, each with the reason it terminates.
  const GATED = [
    { sel: '.sk-bar::after', why: 'skeleton, removed on first paint' },
    { sel: "#shell[aria-busy='true']", why: 'progress sweep, cleared when loading ends' },
  ];

  const offenders = [];
  lines.forEach((line, i) => {
    if (!/animation:[^;]*\binfinite\b/.test(line)) return;

    // Walk back to the selector that owns this declaration.
    let owner = '';
    for (let j = i; j >= 0 && j > i - 40; j--) {
      const m = /^([^{}@\s][^{}]*?)\{\s*$/.exec(lines[j].trim());
      if (m) { owner = m[1].trim(); break; }
    }
    if (!GATED.some((g) => owner.includes(g.sel))) {
      offenders.push(`line ${i + 1}: "${owner}" loops forever with no terminating state`);
    }
  });

  assert.deepEqual(offenders, [], 'ungated infinite animations keep a layer awake while idle');
});

test('the gated loading animations still exist', () => {
  // The negative test above passes trivially if the animations are deleted.
  // These are real features -- perceived-performance work -- so assert they
  // are present, or the guarantee above is vacuous.
  const css = read('src/app/app.css');
  assert.match(css, /animation:\s*sk-shimmer[^;]*infinite/, 'skeleton shimmer missing');
  assert.match(css, /animation:\s*sweep[^;]*infinite/, 'topbar progress sweep missing');
});

/*
 * KEYFRAMES DO NOT CASCADE.
 *
 * Two rules with the same selector merge; two `@keyframes` with the same name
 * do NOT -- the later one wholly REPLACES the earlier, which becomes
 * unreachable code that still reads as if it were in effect. `toast-in` and
 * `gate-in` were each defined twice, and the first definition of `toast-in`
 * described a different animation from the one that actually ran.
 */
test('every keyframe is defined exactly once and is actually used', () => {
  const css = read('src/app/app.css').replace(/\/\*[\s\S]*?\*\//g, ' ');

  const counts = new Map();
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)/g)) {
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }

  const duplicated = [...counts].filter(([, n]) => n > 1).map(([k]) => k);
  assert.deepEqual(duplicated, [], 'the later definition silently replaces the earlier');

  const used = new Set([...css.matchAll(/animation:\s*([\w-]+)/g)].map((m) => m[1]));
  const orphans = [...counts.keys()].filter((k) => !used.has(k));
  assert.deepEqual(orphans, [], 'keyframes defined but never referenced');

  const missing = [...used].filter((u) => !counts.has(u));
  assert.deepEqual(missing, [], 'animations referencing a keyframe that does not exist');
});

test('no selector is defined twice within one layer', () => {
  const css = read('src/app/app.css');

  // Blank out comments while preserving line numbers, so a selector mentioned
  // in prose is not mistaken for a rule.
  const blanked = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const lines = blanked.split('\n');

  // Layer boundaries, identified by their banner comments in the real file.
  const starts = [0];
  css.split('\n').forEach((l, i) => {
    if (/^\/\* (APPEARANCE|FEATURES|MOTION REFINEMENTS|ICONOGRAPHY|DEPTH)\b/.test(l)) {
      starts.push(i + 1);
    }
  });
  assert.ok(starts.length >= 5, 'expected the layered section banners to be present');
  const layerOf = (n) => starts.reduce((acc, s, i) => (n >= s ? i : acc), 0);

  /** @type {Map<string, Map<number, number[]>>} */
  const seen = new Map();
  lines.forEach((line, i) => {
    const m = /^([^{}@\s][^{}]*?)\{/.exec(line);
    if (!m) return;
    const sel = m[1].trim().replace(/\s+/g, ' ');
    // Keyframe stops are not selectors.
    if (!sel || sel === 'to' || sel === 'from' || /%/.test(sel)) return;
    const layer = layerOf(i + 1);
    if (!seen.has(sel)) seen.set(sel, new Map());
    const byLayer = seen.get(sel);
    byLayer.set(layer, [...(byLayer.get(layer) || []), i + 1]);
  });

  /*
   * Three legitimate repeats, each verified by reading them:
   *
   *   :root     the token scale and the theme-fallback block are separate
   *             concerns and are commented as such.
   *   body      `html, body { height }` is a reset; `body { … }` is styling.
   *   #listpane one block is the depth treatment, one is a positioning
   *             context for the multi-select layer, in different sections.
   *
   * Listed explicitly rather than loosening the rule, so anything NEW still
   * fails and each exemption had to be justified once.
   */
  const EXEMPT = new Set([':root', 'body', '#listpane']);

  const problems = [];
  for (const [sel, byLayer] of seen) {
    if (EXEMPT.has(sel)) continue;
    for (const [, atLines] of byLayer) {
      if (atLines.length > 1) problems.push(`${sel} at lines ${atLines.join(', ')}`);
    }
  }

  assert.deepEqual(
    problems, [],
    'these selectors are defined more than once inside a single layer'
  );
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

test('decorative overlays cannot swallow clicks', () => {
  // THE CLASS OF BUG THAT MADE THE WHOLE APP UNCLICKABLE, arriving by a
  // different route. Any full-width absolutely-positioned pseudo-element
  // layered over content MUST be pointer-events:none, or it eats every click
  // in the strip it covers -- and that failure is invisible in a screenshot.
  //
  // Checked statically because jsdom does not compute pseudo-element styles,
  // so an integration test cannot see it.
  const css = read('src/app/app.css');
  const overlays = ['#listpane::before', '#topbar::after'];
  for (const sel of overlays) {
    const i = css.indexOf(sel + ' {');
    if (i === -1) continue;
    const block = css.slice(i, css.indexOf('}', i));
    assert.match(
      block,
      /pointer-events:\s*none/,
      `${sel} overlays content but is not click-through`
    );
  }
});

test('scroll listeners are passive', () => {
  // A non-passive scroll listener forces the browser to wait and see whether
  // the handler calls preventDefault before it can scroll. That is a classic
  // source of scroll jank, and this list is the one surface where jank would
  // be most visible.
  const js = read('src/app/app.js');
  const scrollHandlers = [...js.matchAll(/addEventListener\(\s*\n?\s*'scroll'/g)];
  assert.ok(scrollHandlers.length > 0, 'expected at least one scroll listener');
  for (const m of scrollHandlers) {
    const after = js.slice(m.index, m.index + 400);
    assert.match(after, /passive:\s*true/, 'every scroll listener must be passive');
  }
});

test('interactive targets meet WCAG 2.2 minimum size', () => {
  // SC 2.5.8 (Target Size, Minimum) requires 24x24 CSS px. The star was
  // measured at 18px: below the floor and genuinely hard to hit with a
  // trackpad on a list that scrolls. The ICON stays 15px -- a bigger star
  // would shout -- and the pressable area is expanded instead, which is the
  // difference between designing what a control looks like and what it is.
  const css = read('src/app/app.css');
  const i = css.indexOf('.r-star {');
  assert.ok(i !== -1, '.r-star must be defined');
  const block = css.slice(i, css.indexOf('}', i));

  const w = block.match(/width:\s*(\d+)px/);
  const h = block.match(/height:\s*(\d+)px/);
  assert.ok(w && Number(w[1]) >= 24, `star width is ${w?.[1]}px, needs >= 24`);
  assert.ok(h && Number(h[1]) >= 24, `star height is ${h?.[1]}px, needs >= 24`);
});

/*
 * THE GENERAL FORM: every menu row and chip, not just the star.
 *
 * The test above pinned one control. Each new surface -- the snooze picker,
 * the contact autocomplete, the category rule menu -- adds more clickable
 * rows, and "we checked the star once" does not cover them.
 *
 * Heights are computed from the tokens rather than eyeballed: vertical
 * padding x2 plus the line box, which is what the browser will lay out.
 */
test('every menu row and chip clears the 24px hit floor', () => {
  const css = read('src/app/app.css').replace(/\/\*[\s\S]*?\*\//g, ' ');

  const SPACE = { '--s-1': 4, '--s-2': 8, '--s-3': 12, '--s-4': 16, '--s-5': 20, '--s-6': 24 };
  const TYPE = { '--t-xs': 11, '--t-sm': 12, '--t-md': 13, '--t-lg': 15 };
  const resolve = (v) => {
    const tok = /var\((--[a-z0-9-]+)\)/.exec(v);
    if (tok) return SPACE[tok[1]] ?? TYPE[tok[1]] ?? null;
    const raw = /(\d+(?:\.\d+)?)px/.exec(v);
    return raw ? Number(raw[1]) : null;
  };

  // Rows the user clicks in a list or menu.
  const SELECTORS = ['.snooze-opt', '.ac-opt', '.att-chip', '.cat', '.radar-item'];

  const small = [];
  for (const sel of SELECTORS) {
    const re = new RegExp(`(?:^|\\n)${sel.replace(/[.#[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
    const m = re.exec(css);
    assert.ok(m, `${sel} must exist to be audited`);

    const body = m[1];
    const explicit = /(?:^|\s)height:\s*([^;]+);/.exec(body);
    let height;
    if (explicit) {
      height = resolve(explicit[1]);
    } else {
      const pad = /(?:^|\s)padding:\s*([^;]+);/.exec(body);
      const font = /font-size:\s*([^;]+);/.exec(body);
      if (!pad) continue; // no vertical box of its own; inherits
      const vertical = resolve(pad[1].trim().split(/\s+/)[0]);
      const size = font ? resolve(font[1]) : 13;
      if (vertical == null || size == null) continue;
      height = vertical * 2 + Math.round(size * 1.4);
    }
    if (height != null && height < 24) small.push(`${sel} is ~${height}px`);
  }

  assert.deepEqual(small, [], 'these targets are below WCAG 2.2 SC 2.5.8 (24x24)');
});

test('every design token is actually used', () => {
  // A token defined and never referenced is not a design system, it is
  // aspiration. Six were dead: --dur-slow, --lh-body, --radius, --success,
  // --t-2xl, --w-normal. Each was either applied where it belonged or removed.
  const css = read('src/app/app.css');
  const defined = [...css.matchAll(/^ {2}(--[a-z0-9-]+):/gm)].map((m) => m[1]);
  assert.ok(defined.length > 20, 'expected a real token set');

  const dead = defined.filter((t) => !css.includes(`var(${t})`));
  assert.deepEqual(dead, [], `tokens defined but never used: ${dead.join(', ')}`);
});

/*
 * THE SAME RULE, APPLIED TO THE SETTINGS SCHEMA.
 *
 * `--dur-slow` and five other CSS tokens were once defined and never used, and
 * the test above exists because of it. The settings schema then repeated the
 * mistake: `density`, `signature`, `undoSendSeconds` and `autoSyncMinutes`
 * were declared and read by nothing.
 *
 * A dead setting is WORSE than a dead CSS token. `undoSendSeconds: 8` states
 * that undo-send exists and is configurable. It does not exist at all
 * (`grep -r UNDO_SEND` finds nothing), so the schema is not merely unused —
 * it is untrue, and the next reader will believe it.
 *
 * Build it or delete it. This test makes that a decision rather than a drift.
 */
test('every declared setting is actually read by something', () => {
  const schema = read('src/app/settings.js');

  // Keys are declared as `  name: { type: ... }` at one indent level.
  const declared = [...schema.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*): \{ type:/gm)]
    .map((m) => m[1]);
  assert.ok(declared.length >= 5, 'expected a real schema');

  // Consumers: anything under src/ other than the schema itself.
  const sources = [
    'src/app/app.js', 'src/app/features.js', 'src/app/query.js',
    'src/app/themes.js', 'src/app/rules.js', 'src/app/draft-store.js',
    'src/options/options.js', 'src/background/index.js',
    'src/background/auth.js', 'src/background/gmail.js',
  ].map((p) => read(p)).join('\n');

  const dead = declared.filter(
    (key) => !sources.includes(`'${key}'`) && !sources.includes(`"${key}"`)
  );

  assert.deepEqual(
    dead, [],
    'settings declared but never read — implement them or remove them from the schema'
  );
});

test('spacing resolves to the 4px grid', () => {
  // Twenty-odd raw padding values survived the first tokenisation pass because
  // I only converted font-size and radius. Rhythm is what makes a layout feel
  // deliberate, and it is invisible until it is wrong everywhere at once.
  const css = read('src/app/app.css');
  const body = css.slice(css.indexOf('/*\n * THEME VALUES LIVE IN'));
  const offenders = [];
  for (const m of body.matchAll(/\b(padding|gap):\s*([^;]+);/g)) {
    for (const tok of m[2].split(/\s+/)) {
      const px = tok.match(/^(\d+)px$/);
      // 1px and 2px are hairlines, deliberately below the grid.
      if (px && Number(px[1]) > 2) offenders.push(m[0].trim());
    }
  }
  assert.deepEqual([...new Set(offenders)], [], 'off-grid spacing');
});

test('reduced motion zeroes DELAY as well as duration', () => {
  // The half everyone forgets. Zeroing duration alone leaves the staggered
  // list delays intact, so a reduced-motion user still waits up to 450ms
  // watching rows appear one at a time. The motion is gone but the WAITING is
  // not, which reads as the app being slow rather than as an effect — and for
  // someone who enabled the setting because motion makes them ill, a delayed
  // pop-in is exactly what they asked to avoid.
  const css = read('src/app/app.css');
  const block = css.slice(css.lastIndexOf('@media (prefers-reduced-motion'));
  for (const prop of [
    'animation-duration',
    'animation-iteration-count',
    'transition-duration',
    'animation-delay',
    'transition-delay',
  ]) {
    assert.match(
      block,
      new RegExp(`${prop}:[^;]+!important`),
      `reduced motion must override ${prop}`
    );
  }
});

/*
 * ONE DEFINITION OF "THE ADDRESS IN A FROM HEADER".
 *
 * This three-line rule was duplicated verbatim in app.js (`addressOf`),
 * rules.js (`addressOf`) and query.js (`addr`), with a fourth, DIFFERENT
 * implementation in contacts.js (`parseAddress`). Measured, the lenient and
 * strict versions disagree on 6 of 9 representative inputs — so this was one
 * domain concept with two incompatible definitions and three chances to drift.
 *
 * contacts.js now owns it. This fails if a fifth copy appears.
 */
test('the From-header address regex is defined in exactly one module', () => {
  const files = [
    'src/app/app.js', 'src/app/rules.js', 'src/app/query.js',
    'src/app/contacts.js', 'src/app/features.js', 'src/app/store.js',
  ];
  const owners = [];
  for (const f of files) {
    // Strip comments: the doc comments explain the pattern they replaced.
    const src = read(f)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    if (/<\(\[\^>\]\+\)>/.test(src)) owners.push(f);
  }
  assert.deepEqual(
    owners, ['src/app/contacts.js'],
    'the address regex must live only in contacts.js'
  );
});

test('contacts.js exports both the lenient and the strict parser', () => {
  // They are separate functions on purpose: `addressOf` never returns null and
  // is used as a grouping key, `parseAddress` validates and is used when we
  // need a usable mailbox. Collapsing them would silently change either the
  // rule keys or the autocomplete.
  const src = read('src/app/contacts.js');
  assert.match(src, /export function addressOf\(/);
  assert.match(src, /export function parseAddress\(/);
});

/* ========================================================================== *
 * LAYERING RULES
 *
 * docs/ARCHITECTURE.md declares four layers with dependencies pointing
 * downward only. Written down, a rule is documentation; enforced, it is
 * architecture. These make the difference.
 * ========================================================================== */

/** Which layer each module belongs to. */
const LAYER = {
  shell: ['src/app/app.js'],
  features: ['src/app/features.js', 'src/app/layers.js', 'src/app/icons.js',
    'src/app/shortcuts.js', 'src/app/themes.js'],
  domain: ['src/app/store.js', 'src/app/query.js', 'src/app/deadlines.js',
    'src/app/rules.js', 'src/app/snooze.js', 'src/app/contacts.js',
    'src/app/selection.js', 'src/app/undo.js', 'src/app/mailboxes.js'],
  platform: ['src/app/cache.js', 'src/app/settings.js', 'src/app/views.js',
    'src/app/draft-store.js', 'src/app/sanitize.js'],
};
const RANK = { shell: 3, features: 2, domain: 1, platform: 0 };

const layerOf = (file) => {
  for (const [name, files] of Object.entries(LAYER)) if (files.includes(file)) return name;
  return null;
};

test('ARCH: the domain layer is pure — no DOM, no chrome.*, no fetch', () => {
  /*
   * Purity is what makes the classifier and the query language exhaustively
   * testable without a browser, which is why they are the best-tested parts
   * of the system. A single `document.` reference in here would end that.
   *
   * Storage-taking functions are fine: they receive a storage object as a
   * PARAMETER, which is what makes failure injection possible.
   */
  for (const file of LAYER.domain) {
    const src = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    assert.ok(!/\bdocument\./.test(src), `${file} touches the DOM`);
    assert.ok(!/\bwindow\./.test(src), `${file} touches window`);
    assert.ok(!/\bfetch\(/.test(src), `${file} performs I/O`);
  }
});

test('ARCH: dependencies point downward only', () => {
  // A domain module importing a feature, or a feature importing the shell,
  // is the inversion that makes a layered design ceremonial.
  const violations = [];
  for (const files of Object.values(LAYER)) {
    for (const file of files) {
      const from = layerOf(file);
      const src = read(file);
      for (const m of src.matchAll(/from '\.\/([a-z-]+\.js)'/g)) {
        const target = `src/app/${m[1]}`;
        const to = layerOf(target);
        if (!to) continue; // not classified; ignored rather than guessed at
        if (RANK[to] > RANK[from]) {
          violations.push(`${file} (${from}) imports ${target} (${to})`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], 'these imports point upward');
});

test('ARCH: the background worker never touches the DOM', () => {
  // Credentials live in the worker precisely because it renders nothing.
  for (const file of ['src/background/index.js', 'src/background/auth.js',
    'src/background/gmail.js', 'src/background/sync.js']) {
    const src = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    assert.ok(!/\bdocument\./.test(src), `${file} touches the DOM`);
    assert.ok(!/innerHTML|classList/.test(src), `${file} manipulates markup`);
  }
});

test('ARCH: overlays use the layer primitive rather than hand-rolled teardown', () => {
  /*
   * The regression guard for the whole refactor. Five overlays previously
   * each wired their own `document.addEventListener('mousedown', …, true)`
   * and their own focus restoration; two of them fought each other.
   *
   * The primitive is the only sanctioned place for that listener.
   */
  const shell = read('src/app/app.js')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  assert.ok(
    !/document\.addEventListener\('mousedown'/.test(shell),
    'the shell wires an outside-click listener; layers.js owns that'
  );

  const layers = read('src/app/layers.js');
  assert.match(layers, /addEventListener\('mousedown'/,
    'the primitive should own outside-click dismissal');
});

test('ARCH: the Escape handler has no per-overlay branches', () => {
  // The ladder is what the stack replaced. If overlay-specific `close*()`
  // calls reappear here, the ordering fragility is back.
  const src = read('src/app/app.js');
  const handler = src.indexOf("document.addEventListener('keydown'");
  const esc = src.indexOf("if (e.key === 'Escape')", handler);
  const block = src.slice(esc, esc + 1800);
  for (const overlay of ['closeHelp(', 'closeSnoozeMenu(', 'closeCategoryMenu(', 'closeThemeMenu(']) {
    assert.ok(!block.includes(overlay), `${overlay}) is back in the Escape ladder`);
  }
});
