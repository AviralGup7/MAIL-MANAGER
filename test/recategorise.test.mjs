/**
 * G5 — the recategorise cluster's M4 extraction (2026-08-14).
 *
 * WHY THESE PINS
 * --------------
 * The per-sender correction menu ("this is in the wrong category") was the
 * last classifier-facing UI left in main.js — openRecategoriseMenu,
 * reclassifyAll, countFromSenderIn, ~110 lines whose every call site was
 * inside the cluster except the reader's one button. Per the M4 doctrine
 * (one cluster per round, leaf-first, behavior identical) it joined the
 * category-rule tenant, overlays/category-menu.js, which already owned the
 * sibling menu and the rules blob both menus speak for.
 *
 * An extraction is proven, not believed: these pins hold the ownership move
 * BOTH ways (gone from the shell, present in the tenant), the wiring table
 * that replaced the lexical captures, and the two pieces of doctrine the
 * move must not dilute — the un-teach affordance rides FIRST, and the
 * re-file's scope is counted BEFORE the re-file so the toast can say
 * "23 re-filed", not merely "done".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

const MAIN = 'src/app/main.js';
const TENANT = 'src/app/overlays/category-menu.js';

test('the tenant owns the cluster; the shell defines none of it', () => {
  const tenant = read(TENANT);
  assert.match(tenant, /export function openRecategoriseMenu\(/);
  assert.match(tenant, /function reclassifyAll\(/);
  assert.match(tenant, /function countFromSenderIn\(/);
  const main = read(MAIN);
  assert.ok(!/function openRecategoriseMenu\(/.test(main), 'left the shell');
  assert.ok(!/function reclassifyAll\(/.test(main), 'left the shell');
  assert.ok(!/function countFromSenderIn\(/.test(main), 'left the shell');
  /* And the shell IDL trimmed what only the cluster used: the contacts
     import and the two write-side rules names travel with the tenant. */
  assert.ok(!/addressOf/.test(main), 'addressOf moved with the cluster');
  assert.ok(!/correctSender|clearCorrection/.test(main), 'the write-side verbs moved too');
});

test('the shell wires the tenant: import, wire table, the reader keeps its button', () => {
  const main = read(MAIN);
  assert.match(main, /import \{ openCategoryMenu, openRecategoriseMenu, wireCategoryMenu \} from '\.\/overlays\/category-menu\.js';/);
  const wire = main.slice(main.indexOf('wireCategoryMenu({'), main.indexOf('});', main.indexOf('wireCategoryMenu({')));
  for (const key of ['get store()', 'state', 'ingest', 'syncContextActions', 'renderReaderTags',
                     'getRules', 'setRules', 'saveRules', 'renderList', 'renderSidebar', 'toast']) {
    assert.ok(wire.includes(key), `the wire table carries ${key}`);
  }
  const readerWire = main.slice(main.indexOf('wireReader({'), main.indexOf('});', main.indexOf('wireReader({')));
  assert.match(readerWire, /openRecategoriseMenu/, 'the reader still receives the menu it summons');
});

test('doctrine: un-teaching rides FIRST, and the correction keys by SENDER', () => {
  const tenant = read(TENANT);
  const unTeach = tenant.indexOf("'Use the automatic category'");
  const loop = tenant.indexOf('for (const cat of SIDEBAR_ORDER)');
  assert.ok(unTeach !== -1 && loop !== -1 && unTeach < loop,
    "undoing a mistake outranks making another one — the un-teach item is built before the category loop");
  assert.match(tenant, /addressOf\(msg\.from\)/, 'a correction is about a sender, never one message');
});

test('doctrine: the re-file counts its scope BEFORE moving, and repaints in order', () => {
  const tenant = read(TENANT);
  const count = tenant.indexOf('countFromSenderIn(sender, msg.category)');
  const write = tenant.indexOf('ctx.setRules(correctSender(');
  assert.ok(count !== -1 && write !== -1 && count < write,
    '"23 re-filed" is counted before the move, not discovered after');
  const fn = tenant.slice(tenant.indexOf('function reclassifyAll()'));
  assert.ok(fn.indexOf('ctx.ingest(all)') < fn.indexOf('ctx.renderList()'),
    're-ingest first: one code path knows how corrections, categories and deadlines fit');
  assert.ok(fn.indexOf('ctx.renderReaderTags(open)') > fn.indexOf('ctx.renderSidebar()'),
    'the OPEN message re-files itself visibly, last');
});

test('the tenant holds no edge back into the shell or the reader', () => {
  /* Injection was the extraction's whole bargain: category-menu.js may
     depend on overlays/core/classify/mail-rules, never upward. A future
     `import ... from '../main.js'` would silently re-braid what this
     round spent a commit un-braiding. */
  const tenant = read(TENANT);
  const imports = [...tenant.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0, 'the tenant does import its peers');
  for (const from of imports) {
    assert.ok(!/main\.js$/.test(from), `reached up into the shell: ${from}`);
    assert.ok(!/reader\.js$/.test(from), `reached sideways into the reader: ${from}`);
  }
});
