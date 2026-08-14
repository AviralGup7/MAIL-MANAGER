/**
 * AUD-M2 pins (audit 2026-08-15): "open mail" reuses the tab of the account
 * the session is reading — with the old first-tab law preserved as the
 * fallback whenever the stamp is unknown, invalid, or unmatched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickGmailTab, authUserOf } from '../src/background/tab-pick.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const tab = (u, id = 1) => ({ id, windowId: 10, url: `https://mail.google.com${u}` });

test('authUserOf reads the /mail/u/N/ segment, with the bare domain as 0', () => {
  assert.equal(authUserOf('https://mail.google.com/mail/u/1/#inbox'), '1');
  assert.equal(authUserOf('https://mail.google.com/mail/u/0/#inbox'), '0');
  assert.equal(authUserOf('https://mail.google.com/'), '0', 'Gmail omits the segment on account 0');
  assert.equal(authUserOf(''), '0');
  assert.equal(authUserOf(undefined), '0');
  assert.equal(authUserOf('https://mail.google.com/mail/u/notanumber/'), '0', 'junk segment yields no match');
});

test('the matching tab wins over query order', () => {
  const first = tab('/mail/u/0/#inbox', 101); // opened first — the old answer
  const second = tab('/mail/u/1/#inbox', 102);
  assert.equal(pickGmailTab([first, second], '1').id, 102,
    'the session reading account 1 gets account 1’s tab');
  assert.equal(pickGmailTab([second, first], '0').id, 101,
    'match by content, not position');
});

test('the first-tab law is preserved as the fallback', () => {
  const first = tab('/mail/u/0/#inbox', 201);
  const second = tab('/mail/u/2/#inbox', 202);
  for (const preferred of ['', undefined, 'banana', '7']) {
    assert.equal(pickGmailTab([first, second], preferred).id, 201,
      `preferred=${JSON.stringify(preferred)}: no match -> first tab, the old behavior`);
  }
  assert.equal(pickGmailTab([], '0'), null, 'no Gmail tab -> the caller creates one');
  assert.equal(pickGmailTab(null, '0'), null);
});

test('the takeover reports its index and the worker consults it (wiring)', () => {
  const main = read('src/app/main.js');
  assert.match(main, /sp\.has\('u'\)[^]*?activeAuthUser: ACCOUNT_INDEX/,
    'only an embedded takeover has a parent URL to report');
  const worker = read('src/background/index.js');
  assert.match(worker, /chrome\.storage\.local\s*\n?\s*\.get\('activeAuthUser'\)[^]*?pickGmailTab\(tabs, activeAuthUser\)/,
    'the stamp is read and consulted');
  assert.match(worker, /import \{ pickGmailTab \} from '\.\/tab-pick\.js';/, 'the choice is the pure module');
});

test('the registry keeps the stamp out of backups, with the reason', async () => {
  const { keyEntry } = await import('../src/app/system/storage-registry.js');
  const entry = keyEntry('activeAuthUser');
  assert.ok(entry, 'registered');
  assert.equal(entry.backup, false);
  assert.ok(entry.reason.length > 20);
});
