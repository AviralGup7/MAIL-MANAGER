/**
 * Property sweep over the compose template boundary (fuzz campaign round
 * 3, 2026-08-14, defects #8 and #18). Templates are user text, the values
 * map is profile data, and the output goes OUTBOUND to professors and
 * deans -- so the placeholder contract is a promise made on the user's
 * behalf:
 *
 *   - own-read (#8):   only own properties of the values map may
 *                      substitute in. `{{constructor}}` used to emit
 *                      "function Object() { [native code] }" into a mail.
 *   - totality:        any JSON-shaped values map in, a string out.
 *                      A null-prototype value used to make String(value)
 *                      throw and take the compose insert down with it.
 *   - warn-completeness (#18): the pre-send warning must cover the
 *                      subject too; an unfilled `{{course}}` in a
 *                      template subject used to send silently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fill, applyTemplate, unfilled } from '../src/app/compose/templates.js';
import { mulberry32, hostileValue, hostileString } from './helpers/fuzz.mjs';

test('prototype members are not template values', () => {
  for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const out = fill(`{{${key}}}`, {});
    assert.equal(out, `{{${key}}}`, `{{${key}}} must survive, not inherit`);
  }
  assert.ok(!fill('{{toString}}', {}).includes('function'), 'no native-code leak');
  assert.ok(!fill('{{constructor}}', {}).includes('[native code]'), 'no native-code leak');
  // '__proto__' is not a valid placeholder name at all -- the key regex
  // requires an ASCII letter first -- so it always survives intact.
  assert.equal(fill('Hi {{__proto__}}', { __proto__: 'Ananya' }), 'Hi {{__proto__}}');
});

test('fill is total: any values map in, a string out, never a throw', () => {
  const rnd = mulberry32(0x7E09);
  for (let i = 0; i < 900; i++) {
    const text = `{{name}} and ${i % 3 === 0 ? hostileString(rnd) : '{{course}}'}`;
    const values = { name: hostileValue(rnd), course: hostileValue(rnd) };
    if (rnd() < 0.3) values.course = Object.create(null); // the historical thrower
    let out;
    try {
      out = fill(text, values);
    } catch (err) {
      assert.fail(`fill threw (seed 0x7E09 draw ${i}): ${err.message}`);
    }
    assert.equal(typeof out, 'string', `fill must return a string (draw ${i})`);
  }
  // Primitive values still substitute; exotic ones leave the placeholder.
  assert.equal(fill('{{n}}', { n: 42 }), '42');
  assert.equal(fill('{{n}}', { n: true }), 'true');
  assert.equal(fill('{{n}}', { n: 5n }), '5');
  assert.equal(fill('{{n}}', { n: Symbol('x') }), '{{n}}');
  assert.equal(fill('{{n}}', { n: { a: 1 } }), '{{n}}');
  assert.equal(fill('{{n}}', { n: '' }), '{{n}}', 'empty string is unfilled');
});

test('known values substitute exactly as before the hardening', () => {
  const values = { name: 'Aviral', date: '14 August 2026' };
  assert.equal(fill('I am {{name}} writing on {{date}}.', values), 'I am Aviral writing on 14 August 2026.');
  assert.equal(fill('{{reason}} stays visible', values), '{{reason}} stays visible');
  assert.equal(fill('{{ n }}', values), '{{ n }}', 'inner whitespace is part of the name -- {{ n }} is unknown');
  assert.equal(fill(null, values), '', 'nullish text coerces');
});

test('the unfilled warning covers subject AND body', () => {
  const tpl = { id: 't', name: 'T', subject: 'Extension — {{course}}', body: 'Sir, please. {{name}}' };
  // The defect-#18 reproducer: body fully filled, subject not.
  const out = applyTemplate(tpl, { subject: '', body: '' }, { name: 'Aviral' });
  assert.deepEqual(out._unfilled.sort(), ['course'], 'an unfilled subject placeholder must warn');
  assert.equal(out.subject, 'Extension — {{course}}', 'the placeholder stays visible too');
  // A fully filled template warns about nothing.
  const clean = applyTemplate(tpl, { subject: '', body: '' }, { name: 'Aviral', course: 'CS F213' });
  assert.deepEqual(clean._unfilled, []);
  // Reply drafts keep their subject, so its placeholders are not ours to warn about.
  const reply = applyTemplate(tpl, { subject: 'Re: Fee payment', body: '' }, { name: 'Aviral' });
  assert.deepEqual(reply._unfilled, []);
  assert.equal(reply.subject, 'Re: Fee payment');
});

test('unfilled() itself is total over hostile text', () => {
  const rnd = mulberry32(0x7E0B);
  for (let i = 0; i < 400; i++) {
    const v = i % 2 === 0 ? hostileValue(rnd) : hostileString(rnd);
    try {
      const out = unfilled(v);
      assert.ok(Array.isArray(out), `unfilled must list (draw ${i})`);
    } catch (err) {
      assert.fail(`unfilled threw on ${JSON.stringify(v)?.slice(0, 40)} (seed 0x7E0B draw ${i})`);
    }
  }
});
