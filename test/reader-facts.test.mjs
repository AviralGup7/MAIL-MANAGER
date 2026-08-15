import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { messageFacts, renderMessageFacts } from '../src/app/mail/reader-facts.js';

const message = { id: 'm1', threadId: 't1', unread: true, confidence: 0.9, source: 'rule', _provenance: 'local' };
const store = { thread: () => ({ count: 3 }) };

test('facts prefer useful thread count over opaque Gmail id', () => {
  const facts = messageFacts(message, store, 0.75);
  assert.deepEqual(facts.find(([k]) => k === 'THREAD'), ['THREAD', '3 MESSAGES']);
  assert.equal(facts.some(([, v]) => v === 't1'), false);
});

test('confidence appears only when diagnostic', () => {
  assert.equal(messageFacts(message, store, 0.75).some(([k]) => k === 'CONFIDENCE'), false);
  assert.equal(messageFacts({ ...message, confidence: 0.4 }, store, 0.75).some(([k]) => k === 'CONFIDENCE'), true);
  assert.equal(messageFacts({ ...message, source: 'you' }, store, 0.75).some(([k]) => k === 'CONFIDENCE'), true);
});

test('facts preserve state and provenance truth', () => {
  const facts = Object.fromEntries(messageFacts(message, store, 0.75));
  assert.equal(facts.STATE, 'UNREAD');
  assert.equal(facts.SOURCE, 'LOCAL');
});

test('renderer creates semantic terms and descriptions', () => {
  const dom = new JSDOM('<dl id="facts"></dl>');
  const box = dom.window.document.getElementById('facts');
  renderMessageFacts(box, message, store, 0.75, dom.window.document);
  assert.equal(box.querySelectorAll('dt').length, 3);
  assert.equal(box.querySelectorAll('dd').length, 3);
  assert.equal(box.querySelector('dt').textContent, 'STATE');
});
