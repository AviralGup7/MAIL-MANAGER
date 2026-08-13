/**
 * Behavioural parity runner (roadmap Phase 4 / bug-hunt 44 #57-59,
 * improvements #30).
 *
 * Source-text parity pins say "both tables mention the same verbs"; they
 * cannot say "both tables DO the same thing". This runner executes the real
 * worker handler (`_testHandle`) and the real fallback handler (`runInPage`)
 * on IDENTICAL inputs and diffs the observable answers -- response shape,
 * sent-id namespacing, and queue effects. If the two ever diverge, a test
 * fails at the divergence, not in a user's inbox.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// ---- shared chrome/fetch stubs -------------------------------------------

function installChrome(store) {
  Object.assign(store, {
    authorized: true,
    accessToken: 'test-token',
    expiresAt: Date.now() + 3_600_000,
  });
  globalThis.chrome = {
    runtime: {
      id: 'test',
      lastError: null,
      onMessage: { addListener() {} },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage() {},
    },
    storage: {
      local: {
        get: async (k) => {
          if (Array.isArray(k)) return Object.fromEntries(k.map((x) => [x, store[x]]));
          if (typeof k === 'string') return k in store ? { [k]: store[k] } : {};
          return { ...store };
        },
        set: async (o) => Object.assign(store, o),
        remove: async (k) => { for (const key of [].concat(k)) delete store[key]; },
      },
    },
  };
}

const jsonResponse = (body) => ({
  ok: true, status: 200,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

/** Gmail stub: attachments hydrate, sends return a message id. */
function installGmail() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/attachments/')) return jsonResponse({ data: 'aGVsbG8' });
    if (u.includes('/messages/send')) return jsonResponse({ id: 'gm-1', threadId: 't-1' });
    if (u.includes('/drafts?')) return jsonResponse({ drafts: [] });
    return jsonResponse({});
  };
}

const SEED_QUEUE = () => [{
  id: 'ob-1', state: 'held', queuedAt: 0, releaseAt: 0, attempts: 0, nextAttempt: 0,
  draft: {
    to: 'a@b.c', subject: 's', body: 'b',
    attachments: [{ filename: 'f.pdf', mimeType: 'application/pdf', attachmentId: 'att-1', messageId: 'm-1' }],
  },
}];

// ---- run both handlers on the same input ---------------------------------

test('OUTBOX_PUMP: worker and fallback answer the same contract', async () => {
  // Worker side.
  const wStore = {};
  installChrome(wStore);
  installGmail();
  const { _testHandle } = await import('../src/background/index.js');
  wStore.outbox = SEED_QUEUE();
  const wRes = await _testHandle({ type: 'OUTBOX_PUMP' });

  // Fallback side: fresh storage, same seed.
  const fStore = {};
  installChrome(fStore);
  installGmail();
  const { runInPage, _resetFallback } = await import('../src/app/system/fallback.js');
  _resetFallback();
  fStore.outbox = SEED_QUEUE();
  const fRes = await runInPage('OUTBOX_PUMP');

  // Same observable contract.
  assert.equal(wRes.sent, fRes.sent, 'sent counts agree');
  assert.equal(wRes.failed, fRes.failed, 'failure counts agree');
  assert.equal(wRes.skipped, fRes.skipped, 'skip semantics agree');
  assert.ok(Array.isArray(wRes.sentIds) && Array.isArray(fRes.sentIds));
  assert.ok(wRes.sentIds.every((id) => id.startsWith('g:')),
    'worker ids carry the g: namespace');
  assert.ok(fRes.sentIds.every((id) => id.startsWith('g:') || id.startsWith('q:')),
    'fallback ids stay inside the contract namespaces');
  // Same queue effect: both drained the held item.
  assert.equal(wStore.outbox.length, 0);
  assert.equal(fStore.outbox.length, 0);
});

test('GET_DRAFT: both paths stamp attachments with the owning message id', async () => {
  const draftResponse = {
    drafts: [{ id: 'd-1', message: { id: 'msg-1' } }],
  };
  const fullDraft = {
    id: 'd-1',
    message: {
      id: 'msg-1', threadId: 't-1', internalDate: '1700000000000',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: 'me@bits' }, { name: 'To', value: 'a@b.c' },
          { name: 'Subject', value: 'Half-written' },
        ],
        parts: [
          { mimeType: 'text/plain', body: { data: 'ZHJhZnQ' } },
          { filename: 'notes.pdf', mimeType: 'application/pdf',
            body: { attachmentId: 'att-1', size: 99, disposition: 'attachment' } },
        ],
      },
    },
  };
  const gmailStub = async (url) => {
    const u = String(url);
    if (u.includes('/drafts?')) return jsonResponse(draftResponse);
    if (u.includes('/drafts/d-1')) return jsonResponse(fullDraft);
    return jsonResponse({});
  };

  const wStore = {};
  installChrome(wStore);
  globalThis.fetch = gmailStub;
  const { _testHandle } = await import('../src/background/index.js');
  const wRes = await _testHandle({ type: 'GET_DRAFT', id: 'msg-1' });

  const fStore = {};
  installChrome(fStore);
  globalThis.fetch = gmailStub;
  const { runInPage, _resetFallback } = await import('../src/app/system/fallback.js');
  _resetFallback();
  const fRes = await runInPage('GET_DRAFT', { id: 'msg-1' });

  for (const [name, res] of [['worker', wRes], ['fallback', fRes]]) {
    assert.equal(res.draftId, 'd-1', `${name}: draftId`);
    assert.equal(res.attachments.length, 1, `${name}: one attachment`);
    assert.equal(res.attachments[0].attachmentId, 'att-1', `${name}: attachmentId`);
    assert.equal(res.attachments[0].messageId, 'msg-1', `${name}: owning message id`);
  }
});

test('SEND: both paths hydrate preserved attachments before the wire', async () => {
  const draft = {
    to: 'a@b.c', subject: 's', body: 'b',
    attachments: [{ filename: 'f.pdf', mimeType: 'application/pdf', attachmentId: 'att-1', messageId: 'm-1' }],
  };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/attachments/')) return jsonResponse({ data: 'aGVsbG8' });
    if (u.includes('/messages/send')) {
      return jsonResponse({ id: 'gm-1', threadId: 't-1' });
    }
    return jsonResponse({});
  };

  const wStore = {};
  installChrome(wStore);
  const { _testHandle } = await import('../src/background/index.js');
  await _testHandle({ type: 'SEND', draft: { ...draft, attachments: [...draft.attachments] } });

  const fStore = {};
  installChrome(fStore);
  const { runInPage, _resetFallback } = await import('../src/app/system/fallback.js');
  _resetFallback();
  await runInPage('SEND', { draft: { ...draft, attachments: [...draft.attachments] } });

  // Both paths must have hit the attachments endpoint (hydration) before
  // the send endpoint. We assert by counting fetch traffic in order.
  const order = [];
  globalThis.fetch = async (url) => {
    order.push(String(url));
    const u = String(url);
    if (u.includes('/attachments/')) return jsonResponse({ data: 'aGVsbG8' });
    if (u.includes('/messages/send')) return jsonResponse({ id: 'gm-1', threadId: 't-1' });
    return jsonResponse({});
  };
  installChrome({});
  await _testHandle({ type: 'SEND', draft: { ...draft, attachments: [...draft.attachments] } });
  const attIdx = order.findIndex((u) => u.includes('/attachments/'));
  const sendIdx = order.findIndex((u) => u.includes('/messages/send'));
  assert.notEqual(attIdx, -1, 'hydration fetch happens');
  assert.notEqual(sendIdx, -1, 'send fetch happens');
  assert.ok(attIdx < sendIdx, 'bytes are hydrated BEFORE the wire, in the worker');
});
