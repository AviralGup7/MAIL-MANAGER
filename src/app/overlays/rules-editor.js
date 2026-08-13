/**
 * The in-app rules editor (G4 milestone 1, 2026-08-14).
 *
 * WHY THIS EXISTS
 * ---------------
 * The rule engine shipped with an author surface on the OPTIONS page only
 * — and options pages are where features go to be forgotten. M3's
 * milestone 3 asks for authoring surfaced from settings General with the
 * grammar UNCHANGED, and that is what this is: the same condition box, the
 * same three value-less verbs, the same save-only-after-dry-run gate. What
 * changes hands is the corpus: the options preview reads the message CACHE
 * and apologises for it ("of the N messages cached here"), while the app
 * holds the mailbox in memory — so here the dry run counts the corpus
 * itself. engine.dryRun takes the same (rule, ids, get) either way, which
 * is exactly what the M3 harness was shaped for.
 *
 * THE GATE IS THE WHOLE POINT (inherited, not re-argued)
 * ------------------------------------------------------
 * A rule engine without a dry run is "a feature that silently archives
 * mail from a Dean". The count and a sample of what WOULD be touched are
 * shown before anything can be saved; the same matcher produces both, so
 * the preview and the real run cannot disagree. Destructive verbs
 * (engine.DESTRUCTIVE) additionally earn an explicit confirm naming the
 * count — through the in-app confirmDialog, never the native confirm()
 * the options page had no choice but to use.
 *
 * BOUNDARIES: label/category actions need a value and stay options-page
 * grammar (the select mirrors options.html's three verbs — a deliberate
 * subset, not an omission bug). The editor mutates the rule LIST only;
 * applying rules to arrivals is planFor's job, unchanged.
 */

import * as engine from '../academic/rule-engine.js';
import { confirmDialog } from './dialog.js';

/** The three value-less verbs, mirroring options.html's select, one grammar. */
const VERBS = [
  ['archive', 'Archive it'],
  ['star', 'Star it'],
  ['markRead', 'Mark it read'],
];

/**
 * Build the editor, once per settings render.
 *
 * @param {Document} doc
 * @param {Object} ctx  the app ctx — reads `store` (live getter) for the
 *   dry run, and calls `reloadAutomationRules()` after every save so the
 *   shell's boot-loaded list is never stale behind the editor.
 * @returns {HTMLElement}
 */
export function buildRulesEditor(doc, ctx) {
  const root = doc.createElement('div');
  root.className = 'rules-editor';

  const list = doc.createElement('ul');
  list.id = 'rule-list';

  const empty = doc.createElement('p');
  empty.id = 'rule-empty';
  empty.textContent = 'No rules yet.';

  const form = doc.createElement('div');
  form.className = 'rules-form';

  const query = doc.createElement('input');
  query.id = 'rule-query';
  query.type = 'text';
  query.placeholder = 'category:clubs -is:starred';
  query.setAttribute('aria-label', 'Rule condition');
  query.autocomplete = 'off';
  query.spellcheck = false;

  const action = doc.createElement('select');
  action.id = 'rule-action';
  action.setAttribute('aria-label', 'Action');
  for (const [value, text] of VERBS) {
    const opt = doc.createElement('option');
    opt.value = value;
    opt.textContent = text;
    action.appendChild(opt);
  }

  const testBtn = doc.createElement('button');
  testBtn.id = 'rule-test';
  testBtn.className = 'ghost';
  testBtn.type = 'button';
  testBtn.textContent = 'Test';

  const addBtn = doc.createElement('button');
  addBtn.id = 'rule-add';
  addBtn.className = 'ghost';
  addBtn.type = 'button';
  addBtn.textContent = 'Add rule';

  form.append(query, action, testBtn, addBtn);

  const preview = doc.createElement('div');
  preview.id = 'rule-preview';
  preview.setAttribute('role', 'alert');

  root.append(list, empty, form, preview);

  const say = (msg, bad = false) => {
    preview.textContent = msg;
    preview.dataset.bad = String(bad);
  };

  /** Persist a list and keep every reader of it honest. */
  async function persist(rules) {
    await engine.saveRuleList(rules);
    /* The shell keeps its own boot-loaded copy for planFor; a save that
       does not refresh it lags the editor by exactly one rule — a
       "why didn't my rule fire" bug wearing a caching costume. */
    await ctx.reloadAutomationRules?.();
  }

  async function render() {
    const rules = await engine.loadRuleList();
    empty.hidden = rules.length > 0;
    list.replaceChildren();

    for (const r of rules) {
      const li = doc.createElement('li');
      li.className = 'rule-row';

      const on = doc.createElement('input');
      on.type = 'checkbox';
      on.checked = r.enabled;
      on.setAttribute('aria-label', `Enable ${r.name}`);
      on.addEventListener('change', async () => {
        const all = await engine.loadRuleList();
        await persist(all.map((x) => (x.id === r.id ? { ...x, enabled: on.checked } : x)));
      });

      const text = doc.createElement('span');
      text.className = 'rule-text';
      text.textContent = `${r.query} → ${r.actions.map((a) => a.type).join(', ')}`;

      const del = doc.createElement('button');
      del.type = 'button';
      del.className = 'ghost small';
      del.textContent = 'Remove';
      del.addEventListener('click', async () => {
        const all = await engine.loadRuleList();
        await persist(all.filter((x) => x.id !== r.id));
        render();
      });

      li.append(on, text, del);
      list.appendChild(li);
    }
  }

  /** Build a candidate rule from the form, without saving it. */
  function candidate() {
    return engine.makeRule({
      name: query.value.trim(),
      query: query.value.trim(),
      actions: [{ type: action.value }],
    });
  }

  function dryRun() {
    const rule = candidate();
    if (!rule) {
      say('A rule needs a condition and an action.', true);
      return null;
    }
    const check = engine.validateRule(rule);
    if (!check.ok) {
      say(check.reason, true);
      return null;
    }

    /* THE IN-APP UPGRADE: the live store is the corpus, all of it — not
       the header cache the options page is limited to. */
    const out = engine.dryRun(
      rule,
      ctx.store.idsFor('all'),
      (id) => ctx.store.get(id),
    );

    if (out.count === 0) {
      say('Matches nothing among the loaded messages.');
    } else {
      const sample = out.sample.slice(0, 3).map((x) => x.subject).filter(Boolean).join(' · ');
      say(
        `${out.warning ? out.warning + ' ' : ''}` +
        `Would ${action.value} ${out.count} of ${ctx.store.idsFor('all').length} loaded messages` +
        (sample ? `: ${sample}` : ''),
      );
    }
    return { rule, out };
  }

  testBtn.addEventListener('click', dryRun);

  addBtn.addEventListener('click', async () => {
    /* SAVING RUNS THE DRY RUN FIRST, ALWAYS — as the gate, not as a
       convenience (options.js says the same sentence). */
    const result = dryRun();
    if (!result) return;

    if (result.out.destructive && result.out.count > 0) {
      const ok = await confirmDialog({
        title: `Apply this rule now?`,
        body: `This will ${action.value} ${result.out.count} loaded messages now and matching mail as it arrives. Existing mail can be undone per action; the arrivals cannot.`,
        confirmLabel: 'Add rule',
      });
      if (!ok) {
        say('Not saved.');
        return;
      }
    }

    const all = await engine.loadRuleList();
    await persist([...all, result.rule]);
    query.value = '';
    say('Rule saved. It applies to mail as it arrives.');
    render();
  });

  void render();
  return root;
}
