/**
 * Extension doctor — validate what Chrome validates, before Chrome does.
 *
 * WHY THIS EXISTS
 * ---------------
 * The extension failed to load with "Service worker registration failed.
 * Status code: 2" — a message that names no file, no line and no cause. The
 * whole test suite (890 tests) passed at the time, because every one of them
 * runs in jsdom or Node and neither loads a manifest, resolves an extension
 * URL, or registers a worker.
 *
 * This closes that gap. It checks the things Chrome checks at LOAD time, which
 * is the one layer the suite structurally cannot reach.
 *
 * Run: npm run doctor
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Strip comments WITHOUT being fooled by strings.
 *
 * A naive `.replace(/\/\*[\s\S]*?\*\//g, '')` breaks on this very codebase:
 *
 *     chrome.tabs.query({ url: 'https://mail.google.com/*' })
 *
 * The `/*` inside that Gmail match pattern opens a phantom comment that
 * swallows the next thirty lines, so any scan running afterwards silently
 * sees nothing there. That is not hypothetical -- it hid a real unguarded
 * `chrome.commands` call from this checker until sabotage exposed it.
 *
 * Newlines are preserved so reported line numbers stay accurate.
 */
function stripComments(text) {
  let out = '';
  let mode = 'code';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const nx = text[i + 1];
    if (mode === 'code') {
      if (c === '/' && nx === '*') { mode = 'block'; out += '  '; i++; continue; }
      if (c === '/' && nx === '/') { mode = 'line'; out += '  '; i++; continue; }
      if (c === "'") mode = 'single';
      else if (c === '"') mode = 'double';
      else if (c === '`') mode = 'tick';
      out += c;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; } else out += ' ';
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && nx === '/') { mode = 'code'; out += '  '; i++; continue; }
      out += c === '\n' ? c : ' ';
      continue;
    }
    if (c === '\\') { out += c + (nx ?? ''); i++; continue; }
    if ((mode === 'single' && c === "'")
      || (mode === 'double' && c === '"')
      || (mode === 'tick' && c === '`')) mode = 'code';
    out += c;
  }
  return out;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

const fail = (what, why, fix) => problems.push({ what, why, fix });
const rel = (p) => relative(ROOT, p) || p;

/* -------------------------------------------------------------- manifest -- */

const manifestPath = join(ROOT, 'manifest.json');
let manifest = null;

if (!existsSync(manifestPath)) {
  fail('manifest.json is missing', 'Chrome cannot load a directory without one.',
    'Check you selected the repository root in "Load unpacked".');
} else {
  const raw = readFileSync(manifestPath, 'utf8');

  // A BOM makes JSON.parse fail in Chrome with a message that names nothing.
  if (raw.charCodeAt(0) === 0xfeff) {
    fail('manifest.json starts with a byte-order mark',
      'Chrome\'s JSON parser rejects the file outright.',
      'Re-save it as UTF-8 without BOM.');
  }

  try {
    manifest = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    fail('manifest.json is not valid JSON', e.message,
      'Fix the syntax error above. Trailing commas and comments are not allowed.');
  }
}

if (manifest) {
  /*
   * MARKDOWN-MANGLED URLS.
   *
   * This is here because it actually happened: a manifest pasted through a
   * chat client came back with every URL rewritten as `[url](url)`. The file
   * is still valid JSON -- the mangling is inside the string -- so a JSON
   * check passes and Chrome then rejects the match patterns. Worth naming
   * explicitly, because the symptom looks nothing like the cause.
   */
  const walk = (node, path = '') => {
    if (typeof node === 'string') {
      /*
       * UNANCHORED, and that matters.
       *
       * This test used `^\[.*\]\(.*\)$`, which only matches a value that is
       * ENTIRELY a markdown link. It therefore caught the mangled
       * host_permissions entries and sailed straight past
       *
       *   "script-src 'self'; ... connect-src 'self'
       *    [https://gmail.googleapis.com](https://gmail.googleapis.com) ..."
       *
       * where the mangling is embedded inside a longer policy string. That is
       * the worst possible miss: a CSP is PARSED by Chrome rather than merely
       * read, an unparseable one can reject the extension outright, and the
       * checker reported "no problems found".
       */
      const md = /\[(https?:\/\/[^\]]*)\]\((https?:\/\/[^)]*)\)/.exec(node);
      if (md) {
        fail(`markdown link syntax in ${path}`,
          `The value contains "${md[0].slice(0, 60)}…" — that is a markdown link, `
          + 'not a URL. It is inside a longer string, so the JSON still parses '
          + 'and the damage is invisible until Chrome rejects it.',
          'This usually means the file was pasted through a chat or editor that '
          + 'auto-linkified it. Restore with: git checkout manifest.json');
      }
      return;
    }
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(manifest);

  // Match patterns Chrome will accept.
  const patternOk = (p) => p === '<all_urls>'
    || /^(\*|https?|file|ftp):\/\/(\*|\*\.[^/*]+|[^/*]+)?\/.*$/.test(p);

  const checkPatterns = (list, where) => {
    for (const p of list || []) {
      if (!patternOk(p)) {
        fail(`invalid match pattern in ${where}`, `"${p}" is not a valid match pattern.`,
          'It must look like https://mail.google.com/* — scheme, host, then a path.');
      }
    }
  };
  checkPatterns(manifest.host_permissions, 'host_permissions');
  for (const [i, cs] of (manifest.content_scripts || []).entries()) {
    checkPatterns(cs.matches, `content_scripts[${i}].matches`);
  }
  for (const [i, war] of (manifest.web_accessible_resources || []).entries()) {
    checkPatterns(war.matches, `web_accessible_resources[${i}].matches`);
  }

  /* ---- the service worker, which is what failed to register ---- */

  const sw = manifest.background?.service_worker;
  if (!sw) {
    fail('no background.service_worker declared',
      'MV3 needs one for the extension to do anything in the background.',
      'Add "background": { "service_worker": "...", "type": "module" }.');
  } else {
    const swPath = join(ROOT, sw);
    if (!existsSync(swPath)) {
      fail('the service worker file does not exist',
        `manifest points at "${sw}" and there is no such file.`,
        'Fix the path, or check the casing — it is case-sensitive.');
    } else {
      /*
       * Walk the whole static import graph the way the BROWSER does, which is
       * stricter than Node in two ways that matter:
       *   - the extension is served over chrome-extension://, so every
       *     specifier must resolve to a real file with its extension written
       *     out. Node's resolver forgives a missing ".js"; the browser does
       *     not, and the failure surfaces as a registration error naming
       *     nothing.
       *   - bare specifiers ("lodash") have no meaning without an import map.
       */
      const seen = new Set();
      const stack = [swPath];
      let count = 0;
      while (stack.length) {
        const file = stack.pop();
        if (seen.has(file)) continue;
        seen.add(file);
        count += 1;
        const src = readFileSync(file, 'utf8');
        /*
         * COMMENTS ARE NOT IMPORTS.
         *
         * The old pattern allowed [\s\S]*? between the keyword and `from`,
         * so it happily spanned newlines: a doc comment whose line began
         * with " * ... export ..." and which later contained the word
         * `from` followed by ANY quoted string was reported as a bare
         * import. It fired on the phrase "cursor expired" in a sync.js
         * comment and named a dependency that does not exist -- a load-time
         * gate whose failure message sends you looking for the wrong thing
         * is worse than no gate.
         *
         * Comments are stripped first, and the specifier match no longer
         * crosses a line break.
         */
        const code = src
          .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
          .replace(/^\s*\/\/.*$/gm, '');       // line comments
        const specs = [...code.matchAll(
          /^\s*(?:import|export)\b[^\n]*?\bfrom\s*['"]([^'"]+)['"]/gm
        )].map((m) => m[1]);
        // Side-effect imports (`import './x.js'`) have no `from`.
        specs.push(...[...code.matchAll(
          /^\s*import\s*['"]([^'"]+)['"]/gm
        )].map((m) => m[1]));

        for (const spec of specs) {
          if (!spec.startsWith('.') && !spec.startsWith('/')) {
            fail('bare import specifier in the service worker graph',
              `${rel(file)} imports "${spec}", which the browser cannot resolve.`,
              'Use a relative path with a .js extension, or bundle the dependency.');
            continue;
          }
          if (!/\.[a-z]+$/i.test(spec)) {
            fail('extensionless import in the service worker graph',
              `${rel(file)} imports "${spec}" with no file extension.`,
              'Node forgives this; the browser does not. Write the ".js".');
          }
          const target = resolve(dirname(file), spec);
          if (!existsSync(target)) {
            fail('unresolved import in the service worker graph',
              `${rel(file)} imports "${spec}" → ${rel(target)}, which does not exist.`,
              'Fix the path or the casing.');
            continue;
          }
          stack.push(target);
        }

        /*
         * APIs that do not exist in a worker. Referencing one at module top
         * level throws during evaluation, and Chrome reports that as a bare
         * registration failure rather than as the ReferenceError it is.
         */
        const stripped = stripComments(src);
        for (const api of ['document', 'window', 'localStorage', 'XMLHttpRequest']) {
          const hit = new RegExp(`(^|[^.\\w'"\`])${api}\\s*[.\\[]`).exec(stripped);
          if (hit) {
            fail(`${api} referenced in the service worker graph`,
              `${rel(file)} uses \`${api}\`, which does not exist in a worker.`,
              `Guard it, or move that code to the page. Workers have no DOM.`);
          }
        }
        /*
         * UNGUARDED TOP-LEVEL chrome.* ACCESS.
         *
         * This is the one that actually bit us. A statement like
         *
         *     chrome.action.onClicked.addListener(...)
         *
         * at module top level throws a TypeError during evaluation if
         * `chrome.action` is undefined -- and that aborts the entire worker.
         * Chrome reports exactly "Service worker registration failed. Status
         * code: 2", naming no file, no line and no cause.
         *
         * `chrome.action` is undefined whenever the manifest's `action` key is
         * missing or malformed. Same for `commands`, `alarms`, `notifications`
         * and every other optional namespace. The fix is a `?.`; the cost of
         * missing it is an extension that looks completely dead.
         *
         * `runtime` is excluded: it always exists in a real worker, so
         * guarding it would hide genuine breakage rather than prevent it.
         */
        const ALWAYS_PRESENT = new Set(['runtime']);
        for (const hit of stripped.matchAll(/^chrome\.([a-zA-Z]+)\.(\w+)/gm)) {
          const [, ns, prop] = hit;
          if (ALWAYS_PRESENT.has(ns)) continue;
          fail(`unguarded top-level chrome.${ns} in the service worker`,
            `${rel(file)} runs \`chrome.${ns}.${prop}\` at module top level. If the `
            + `manifest does not grant "${ns}", this throws during evaluation and the `
            + `whole worker fails to register with no usable error.`,
            `Write chrome.${ns}?.${prop} so a missing capability costs that feature `
            + 'rather than the entire extension.');
        }

        if (/\bimportScripts\s*\(/.test(stripped) && manifest.background?.type === 'module') {
          fail('importScripts() in a module service worker',
            `${rel(file)} calls importScripts(), which is illegal when type is "module".`,
            'Use a static import instead.');
        }
      }
      notes.push(`service worker graph: ${count} module${count === 1 ? '' : 's'}, all resolved`);
    }
  }

  /* ---- every other file the manifest names ---- */

  const named = [];
  for (const [size, p] of Object.entries(manifest.icons || {})) named.push([`icons.${size}`, p]);
  for (const [i, cs] of (manifest.content_scripts || []).entries()) {
    for (const p of cs.js || []) named.push([`content_scripts[${i}].js`, p]);
    for (const p of cs.css || []) named.push([`content_scripts[${i}].css`, p]);
  }
  if (manifest.options_ui?.page) named.push(['options_ui.page', manifest.options_ui.page]);
  if (manifest.action?.default_popup) named.push(['action.default_popup', manifest.action.default_popup]);

  for (const [where, p] of named) {
    const abs = join(ROOT, p);
    if (!existsSync(abs)) {
      fail(`${where} points at a missing file`, `"${p}" does not exist.`, 'Fix the path or the casing.');
    } else if (statSync(abs).size === 0) {
      fail(`${where} is an empty file`, `"${p}" is 0 bytes.`, 'Chrome may reject it.');
    }
  }

  /* ---- the key, which decides the extension ID ---- */

  if (manifest.key) {
    const k = manifest.key;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(k)) {
      fail('manifest.key is not valid base64',
        'Chrome refuses to load the extension and reports no usable detail.',
        'Re-copy the key, or remove it entirely — it only pins the extension ID.');
    } else {
      const der = Buffer.from(k, 'base64');
      if (der[0] !== 0x30) {
        fail('manifest.key does not decode to a public key',
          'The decoded bytes are not a DER SPKI structure.',
          'Re-copy it, or remove the field to let Chrome assign an ID.');
      }
    }
  }

  /* ---- CSP, which silently breaks pages rather than the worker ---- */

  const csp = manifest.content_security_policy?.extension_pages;
  if (csp && !/script-src[^;]*'self'/.test(csp)) {
    fail('extension_pages CSP does not allow \'self\' scripts',
      'app.html would load with no JavaScript at all.',
      "Include script-src 'self'.");
  }
}

/* ----------------------------------------------------------------- report -- */

console.log('\nBITS Mail Manager — extension doctor\n');
for (const n of notes) console.log(`  ok    ${n}`);

if (!problems.length) {
  console.log('  ok    manifest, match patterns, named files and key all valid\n');
  console.log('No load-time problems found.\n');
  console.log('If Chrome still refuses to register the worker, the cause is in the');
  console.log('browser rather than the files: reload the unpacked extension, check');
  console.log('chrome://extensions for a load error, and open the service worker');
  console.log('console from that page for the real message.\n');
  process.exit(0);
}

console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} found:\n`);
for (const [i, p] of problems.entries()) {
  console.log(`  ${i + 1}. ${p.what}`);
  console.log(`     why: ${p.why}`);
  console.log(`     fix: ${p.fix}\n`);
}
process.exit(1);
