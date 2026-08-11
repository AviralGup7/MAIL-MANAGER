/**
 * The REAL worker dispatch table, executed (roadmap Phase 4 / bug-hunt 44
 * #58). Until this file existed, `handle()` was verified only by source pins
 * and emulations -- the actual function never ran in a test process, so a
 * regression inside the verb table (a wrong import, a dead reference, a
 * broken shape) could ship green.
 *
 * chrome is stubbed to the minimum the module touches at import and at verb
 * time; fetch is stubbed per test to stand in for the Gmail API.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const storage = {
  // Signed-in state, so the Gmail layer authenticates instead of throwing
  // NOT_SIGNED_IN before the verbs under test ever run.
  authorized: true,
  accessToken: 'test-token',
  expiresAt: Date.now() + 3_600_000,
};
globalThis.chrome = {
  runtime: {
    id: 'test',
    onMessage: { addListener() {} },
    onStartup: { addListener() {} },
    onInstalled: { addListener() {} },
  },
  storage: {
    local: {
      get: async (k) => {
        if (Array.isArray(k)) return Object.fromEntries(k.map((x) => [x, storage[x]]));
        if (typeof k === 'string') return k in storage ? { [k]: storage[k] } : {};
        return { ...storage };
      },
      set: async (o) => Object.assign(storage, o),
      remove: async (k) => { for (const key of [].concat(k)) delete storage[key]; },
    },
  },
};

const { _testHandle } = await import('../src/background/index.js');

const jsonResponse = (body) => ({
  ok: true, status: 200,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

test('AUTH_STATUS answers from the real handler', async () => {
  const res = await _testHandle({ type: 'AUTH_STATUS' });
  assert.equal(typeof res.signedIn, 'boolean');
});

test('OUTBOX_PUMP hydrates preserved attachments and namespaces sentIds', async () => {
  storage.outbox = [{
    id: 'ob-1', state: 'held', queuedAt: 0, releaseAt: 0, attempts: 0, nextAttempt: 0,
    draft: {
      to: 'a@b.c', subject: 's', body: 'b',
      attachments: [{ filename: 'report.pdf', mimeType: 'application/pdf', attachmentId: 'att-9', messageId: 'm-9' }],
    },
  }];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/attachments/')) return jsonResponse({ data: 'aGVsbG8' }); // base64 "hello"
    if (u.includes('/messages/send')) return jsonResponse({ id: 'gm-77', threadId: 't-1' });
    return jsonResponse({});
  };
  try {
    const res = await _testHandle({ type: 'OUTBOX_PUMP' });
    assert.equal(res.sent, 1);
    assert.equal(res.failed, 0);
    assert.deepEqual(res.sentIds, ['g:gm-77'], 'the Gmail id, g:-namespaced');
    assert.equal(storage.outbox.length, 0, 'the queue drains on success');
  } finally {
    globalThis.fetch = realFetch;
    delete storage.outbox;
  }
});

test('OUTBOX_PUMP: a lost attachment goes straight to stuck', async () => {
  storage.outbox = [{
    id: 'ob-2', state: 'held', queuedAt: 0, releaseAt: 0, attempts: 0, nextAttempt: 0,
    draft: {
      to: 'a@b.c', subject: 's', body: 'b',
      attachments: [{ filename: 'gone.pdf', attachmentId: 'att-x', messageId: 'm-x' }],
    },
  }];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/attachments/')) return { ok: false, status: 404, text: async () => 'gone' };
    return jsonResponse({});
  };
  try {
    const res = await _testHandle({ type: 'OUTBOX_PUMP' });
    assert.equal(res.sent, 0);
    assert.equal(res.failed, 1);
    const [it] = storage.outbox;
    assert.equal(it.state, 'failed');
    assert.equal(it.attempts, 4, 'permanent loss never burns the backoff ladder');
  } finally {
    globalThis.fetch = realFetch;
    delete storage.outbox;
  }
});

test('GET_DRAFT stamps attachments with their owning message id', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/drafts?')) {
      return jsonResponse({ drafts: [{ id: 'd-1', message: { id: 'msg-1' } }] });
    }
    if (u.includes('/drafts/d-1')) {
      return jsonResponse({
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
      });
    }
    return jsonResponse({});
  };
  try {
    const res = await _testHandle({ type: 'GET_DRAFT', id: 'msg-1' });
    assert.equal(res.draftId, 'd-1');
    assert.equal(res.attachments.length, 1);
    assert.equal(res.attachments[0].attachmentId, 'att-1');
    assert.equal(res.attachments[0].messageId, 'msg-1',
      'the refetch source is the draft\'s own message id');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an unknown verb answers with a named error, not a crash', async () => {
  await assert.rejects(() => _testHandle({ type: 'NO_SUCH_VERB' }), /Unknown message: NO_SUCH_VERB/);
});
