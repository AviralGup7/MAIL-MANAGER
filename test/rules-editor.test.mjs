/**
 * G4 m1 — the rules editor surfaces in settings General (2026-08-14).
 *
 * WHY THESE PINS
 * --------------
 * The rule engine's author surface was options-page-only, and options
 * pages are where features go to be forgotten. The in-app editor
 * (overlays/rules-editor.js, mounted as a settings item kind) keeps the
 * grammar UNCHANGED — that is a claim a pin must keep, or the two
 * surfaces drift one option at a time — while its dry run gets stronger:
 * the options page previews against the header cache and apologises for
 * it; the app holds the mailbox in memory, so the corpus is the live
 * store. These pins hold the four truths that make the feature real
 * rather than mounted: the dry run stays the save gate, no native
 * dialogs sneak in, the shell's boot-loaded rule list follows every
 * save, and the staged styles meet real markup (a fake door cuts both
 * ways).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

test('settings General carries the editor, and the panel routes the kind', () => {
  const panel = read('src/app/overlays/settings-panel.js');
  assert.match(panel, /import \{ buildRulesEditor \} from '\.\/rules-editor\.js';/);
  assert.match(panel, /item\.kind === 'rules' \? buildRulesEditor\(doc, ctx\) :/, 'the builder switch routes it');
  const general = panel.indexOf("id: 'general'");
  const rules = panel.indexOf("kind: 'rules'");
  assert.ok(general !== -1 && rules !== -1 && general < rules, 'the editor rows under General — the milestone names the tab');
});

test('the corpus is the LIVE STORE — the options-page compromise must not leak back', () => {
  const editor = read('src/app/overlays/rules-editor.js');
  assert.match(editor, /ctx\.store\.idsFor\('all'\)/, 'dry run over what is loaded, all of it');
  assert.match(editor, /\) => ctx\.store\.get\(id\)/, 'the getter is the store');
  assert.ok(!/loadCache/.test(editor),
    'reading the header cache here would silently shrink the count — the in-app upgrade IS the corpus');
});

test('the dry run stays the save gate; destructive verbs earn the in-app confirm', () => {
  const editor = read('src/app/overlays/rules-editor.js');
  const addAt = editor.indexOf("addBtn.addEventListener('click'");
  const addBody = editor.slice(addAt);
  assert.ok(addBody.indexOf('dryRun()') < addBody.indexOf('engine.saveRuleList'),
    'SAVING RUNS THE DRY RUN FIRST, ALWAYS — same sentence as options.js');
  assert.ok(addBody.indexOf('result.out.destructive') < addBody.indexOf('confirmDialog({'),
    'the destructive branch asks, naming the count');
  assert.ok(!/[^.]confirm\(|[^.]prompt\(|[^.]alert\(/.test(editor),
    'no native dialogs in the app — confirmDialog is the one lifecycle');
});

test('the grammar is unchanged — the in-app verbs mirror the options select', () => {
  const opts = read('options.html');
  const start = opts.indexOf('id="rule-action"');
  const selectBlock = opts.slice(start, opts.indexOf('</select>', start)); // bound it — later fieldsets have their own selects
  const optionsVerbs = [...selectBlock.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  const editor = read('src/app/overlays/rules-editor.js');
  const inAppVerbs = [...editor.matchAll(/^\s*\['([a-zA-Z]+)',/gm)].map((m) => m[1]);
  assert.deepEqual(inAppVerbs, optionsVerbs,
    'label/category verbs stay options-page grammar (they need a value); drift here forks the mental model');
});

test('a save refreshes the shell\'s boot-loaded list, or rules lag their author', () => {
  const main = read('src/app/main.js');
  assert.match(main, /reloadAutomationRules: async \(\) => \{/, 'ctx carries the hook');
  assert.match(main, /automationRules = await engine\.loadRuleList\(\)/, 'the hook reloads the planFor source');
  const editor = read('src/app/overlays/rules-editor.js');
  assert.match(editor, /await ctx\.reloadAutomationRules\?\.\(\)/, 'every persist rings it');
});

test('the staged styles meet real markup — a fake door cuts both ways', () => {
  const css = read('src/styles/40-suggest.css');
  for (const sel of ['#rule-list', '.rule-row', '.rule-text', '#rule-preview', '.rules-form', '#rule-empty']) {
    assert.ok(css.includes(sel), `${sel} is styled`);
  }
  const editor = read('src/app/overlays/rules-editor.js');
  for (const id of ["'rule-list'", "'rule-empty'", "'rule-query'", "'rule-action'", "'rule-test'", "'rule-add'", "'rule-preview'"]) {
    assert.ok(editor.includes(`.id = ${id}`), `${id} is built`);
  }
});
