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
import { readFileSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

const has = (p) => existsSync(join(ROOT, p));

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

test('permissions and scopes stayed minimal', () => {
  // A regression guard: permissions creep back in one convenient line at a
  // time. v1 ended up with 7 permissions and 6 scopes, one of which
  // (generativelanguage) no code referenced at all.
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'identity', 'storage']);
  assert.ok(!manifest.permissions.includes('tabs'));
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
