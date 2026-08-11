/**
 * Template tests.
 *
 * The two ways this feature can hurt someone:
 *   1. Destroying a half-written message when a template is applied.
 *   2. Sending a mail to a professor with an unfilled `{{reason}}` in it, or
 *      worse, with a silently blanked hole where the reason should be.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStorage } from './helpers/storage.mjs';

const {
  loadTemplates, saveTemplate, removeTemplate, normaliseTemplates,
  fill, placeholdersIn, unfilled, applyTemplate, autoValues,
  BUILTIN_TEMPLATES,
} = await import('../src/app/templates.js');

// ------------------------------------------------------------- substitution --

test('known placeholders are filled', () => {
  assert.equal(fill('Hello {{name}}', { name: 'Aviral' }), 'Hello Aviral');
});

test('UNKNOWN PLACEHOLDERS SURVIVE RATHER THAN BLANKING', () => {
  /*
   * Blanking produces "leave on  due to ." -- a sentence that reads as a bug
   * and that a hurried user will send anyway. A visible {{reason}} cannot be
   * missed.
   */
  const out = fill('Leave on {{date}} due to {{reason}}', { date: '3 May' });
  assert.equal(out, 'Leave on 3 May due to {{reason}}');
});

test('an empty-string value counts as unfilled', () => {
  assert.match(fill('Hi {{name}}', { name: '' }), /\{\{name\}\}/);
});

test('whitespace inside the braces is tolerated', () => {
  assert.equal(fill('Hi {{ name }}', { name: 'A' }), 'Hi A');
});

test('the same placeholder twice is filled twice', () => {
  assert.equal(fill('{{a}} and {{a}}', { a: 'x' }), 'x and x');
});

test('text with no placeholders is returned unchanged', () => {
  assert.equal(fill('plain text', { a: 1 }), 'plain text');
});

test('nullish input does not throw', () => {
  for (const bad of [null, undefined, 0, {}]) assert.equal(typeof fill(bad, {}), 'string');
});

// ------------------------------------------------------------ placeholders --

test('placeholders are listed in order, without duplicates', () => {
  assert.deepEqual(placeholdersIn('{{b}} {{a}} {{b}}'), ['b', 'a']);
});

test('unfilled reports what still needs the user', () => {
  const body = fill('Leave on {{date}} due to {{reason}}', { date: '3 May' });
  assert.deepEqual(unfilled(body), ['reason']);
});

test('a fully filled body reports nothing outstanding', () => {
  assert.deepEqual(unfilled(fill('Hi {{name}}', { name: 'A' })), []);
});

// ------------------------------------------------------------------ apply --

test('APPLYING A TEMPLATE DOES NOT DESTROY WHAT WAS ALREADY TYPED', () => {
  const draft = { body: 'I already wrote this.' };
  const out = applyTemplate({ body: 'Template text' }, draft, {});
  assert.match(out.body, /Template text/);
  assert.match(out.body, /I already wrote this/);
});

test('a template subject does NOT overwrite a reply subject', () => {
  // Overwriting "Re: Fee payment" silently breaks the thread the user is in.
  const out = applyTemplate(
    { subject: 'Leave request', body: 'x' },
    { subject: 'Re: Fee payment' },
    {}
  );
  assert.equal(out.subject, 'Re: Fee payment');
});

test('a template subject IS used on a fresh message', () => {
  const out = applyTemplate({ subject: 'Leave request — {{date}}', body: 'x' }, {}, { date: '3 May' });
  assert.equal(out.subject, 'Leave request — 3 May');
});

test('apply reports what is still unfilled so the caller can warn', () => {
  const out = applyTemplate({ body: 'Due to {{reason}}' }, {}, {});
  assert.deepEqual(out._unfilled, ['reason']);
});

// --------------------------------------------------------------- built-ins --

test('the shipped templates are all valid', () => {
  assert.ok(BUILTIN_TEMPLATES.length >= 5);
  for (const t of BUILTIN_TEMPLATES) {
    assert.ok(t.id && t.name && t.body, `${t.id} is complete`);
    assert.equal(t.builtin, true);
  }
});

test('built-in ids are unique', () => {
  const ids = BUILTIN_TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every built-in placeholder is either auto-fillable or obviously manual', () => {
  // Guards against a template referencing {{nmae}} and nobody noticing.
  const known = new Set(['name', 'date', 'today', 'subject', 'sender', 'course', 'reason', 'newDate']);
  for (const t of BUILTIN_TEMPLATES) {
    for (const p of placeholdersIn(`${t.subject || ''} ${t.body}`)) {
      assert.ok(known.has(p), `${t.id} uses unknown placeholder {{${p}}}`);
    }
  }
});

test('built-ins are returned even with empty storage', async () => {
  const list = await loadTemplates(fakeStorage());
  assert.equal(list.length, BUILTIN_TEMPLATES.length);
});

// ---------------------------------------------------------------- storage --

test('a custom template round-trips', async () => {
  const s = fakeStorage();
  const saved = await saveTemplate({ name: 'Mine', body: 'Body text' }, s);
  assert.ok(saved.id);
  const list = await loadTemplates(s);
  assert.ok(list.some((t) => t.name === 'Mine'));
});

test('saving with an existing id updates rather than duplicating', async () => {
  const s = fakeStorage();
  const first = await saveTemplate({ name: 'Mine', body: 'v1' }, s);
  await saveTemplate({ id: first.id, name: 'Mine', body: 'v2' }, s);
  const mine = (await loadTemplates(s)).filter((t) => t.name === 'Mine');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].body, 'v2');
});

test('A DELETED BUILT-IN STAYS DELETED', async () => {
  // The shipped set is code, so a delete has to be recorded as a hide or it
  // returns on the next load and the app looks broken.
  const s = fakeStorage();
  await removeTemplate('tpl-ack', s);
  const list = await loadTemplates(s);
  assert.ok(!list.some((t) => t.id === 'tpl-ack'));
});

test('a deleted custom template is gone', async () => {
  const s = fakeStorage();
  const t = await saveTemplate({ name: 'Temp', body: 'x' }, s);
  await removeTemplate(t.id, s);
  assert.ok(!(await loadTemplates(s)).some((x) => x.id === t.id));
});

test('a template with no body is rejected', () => {
  assert.deepEqual(normaliseTemplates([{ name: 'x', body: '  ' }]), []);
});

test('a corrupt blob degrades to the built-ins, not to an error', async () => {
  const list = await loadTemplates(fakeStorage({ templates: 'nonsense' }));
  assert.equal(list.length, BUILTIN_TEMPLATES.length);
});

test('a failing storage write returns null instead of throwing', async () => {
  assert.equal(await saveTemplate({ name: 'x', body: 'y' }, fakeStorage()._fail()), null);
});

// ------------------------------------------------------------ auto values --

test('autoValues supplies a formatted date and the profile name', () => {
  const v = autoValues({ profileName: 'Aviral', now: Date.UTC(2026, 4, 3) });
  assert.equal(v.name, 'Aviral');
  assert.match(v.today, /2026/);
});

test('autoValues omits what it does not know rather than inventing it', () => {
  const v = autoValues({});
  assert.equal(v.name, undefined);
  assert.equal(v.subject, undefined);
});

test('autoValues surfaces the canonical course (bug-hunt #24)', () => {
  // {{course}} used to be impossible: autoValues read message.course, but
  // the GET_BODY shape never had one. The fix routes the CLASSIFIED record
  // in -- the store entry stamped at ingest, same field the row chip uses.
  const v = autoValues({
    profileName: 'aviral g',
    message: { subject: 'Re: PS report', from: 'Prof <p@bits.ac.in>', course: 'PS F111' },
  });
  assert.equal(v.course, 'PS F111');
  assert.equal(v.sender, 'Prof <p@bits.ac.in>');
  const none = autoValues({ message: { subject: 'x' } });
  assert.equal(none.course, undefined, 'no course -> no fake one');
});
