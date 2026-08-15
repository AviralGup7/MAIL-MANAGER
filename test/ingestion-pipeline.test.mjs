/**
 * End-to-end Gmail→canonical pipeline fixture (V2 P0-3). The V2 audits found
 * unit tests passing on hand-built records carrying fields the sync layer
 * never produced. This fixture walks the REAL production path:
 * fake Gmail metadata → normalise → audience/attachment consumers → Store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalise } from '../src/background/gmail.js';
import { audienceOf } from '../src/app/system/audience.js';
import { Store } from '../src/app/mail/store.js';

const gmailRecord = (over = {}) => ({
  id: 'm1', threadId: 't1', internalDate: '1700000000000',
  snippet: 'plain snippet', labelIds: ['INBOX', 'UNREAD'],
  payload: { headers: [
    { name: 'From', value: 'Registrar <reg@uni.edu>' },
    { name: 'Subject', value: 'Registration open' },
    { name: 'Date', value: 'Mon, 01 Jan 2024 10:00:00 +0000' },
  ], parts: [] },
  ...over,
});

test('normalise populates the canonical fields the shaper promises', () => {
  const m = normalise(gmailRecord({ payload: { headers: [
    { name: 'From', value: 'A <a@x.edu>' },
    { name: 'Subject', value: 'S' },
    { name: 'To', value: 'me@x.edu, other@x.edu' },
    { name: 'Cc', value: 'cc@x.edu' },
    { name: 'List-Id', value: '<list.x.edu>' },
  ] } }));
  assert.equal(m.to, 'me@x.edu, other@x.edu');
  assert.equal(m.cc, 'cc@x.edu');
  assert.equal(m.headers['list-id'], '<list.x.edu>');
});

test('audience sees a list as broadcast through the REAL normalise path', () => {
  const m = normalise(gmailRecord({ payload: { headers: [
    { name: 'From', value: 'News <n@uni.edu>' },
    { name: 'Subject', value: 'Circular' },
    { name: 'To', value: 'all-students@uni.edu' },
    { name: 'List-Unsubscribe', value: '<mailto:unsub@uni.edu>' },
  ] } }));
  assert.equal(audienceOf(m, 'me@uni.edu'), 'broadcast');
});

test('a personal To through the real path is direct', () => {
  const m = normalise(gmailRecord({ payload: { headers: [
    { name: 'From', value: 'Prof <p@uni.edu>' },
    { name: 'Subject', value: 'Your draft' },
    { name: 'To', value: 'me@uni.edu' },
  ] } }));
  assert.equal(audienceOf(m, 'me@uni.edu'), 'direct');
});

test('hasAttachment counts real attachments and ignores inline images', () => {
  const withAtt = normalise(gmailRecord({ payload: { headers: [], parts: [
    { filename: 'a.pdf', body: { attachmentId: 'att1', disposition: 'attachment' } },
  ] } }));
  assert.equal(withAtt.hasAttachment, true);
  const inline = normalise(gmailRecord({ payload: { headers: [], parts: [
    { filename: 'i.png', body: { attachmentId: 'att2', disposition: 'inline' }, headers: [{ name: 'Content-ID', value: '<i>' }] },
  ] } }));
  assert.equal(inline.hasAttachment, false);
});

test('normalised records flow through the Store with counts intact', () => {
  const m = normalise(gmailRecord());
  const store = new Store();
  store.upsert({ ...m, category: 'augsd', confidence: 0.9 });
  assert.deepEqual(store.unreadCounts(), { augsd: 1 });
});
