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
/*
 * The router listener is CAPTURED, not discarded (audit EXT2-H4). The verb
 * table was reachable through _testHandle, but the envelope the router puts
 * a failure into — the only thing the app ever sees — was not testable at
 * all, which is how a classification that never crossed the wire shipped.
 */
export const routerListeners = [];
globalThis.chrome = {
  runtime: {
    id: 'test',
    onMessage: { addListener(fn) { routerListeners.push(fn); } },
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

/* ==========================================================================
 * THE FAILURE ENVELOPE (audit EXT2-H4)
 *
 * chrome.runtime.sendMessage structured-clones the response, and an Error's
 * own properties do not survive that. So the router used to send nothing but
 * `error` TEXT, and the app re-derived the failure class from it with
 * /401|invalid_grant/i — which matches the hex MESSAGE ID in
 * "Gmail 500 /messages/18f401ab77cd0e12/modify" and signed the user out on
 * an unrelated backend blip.
 *
 * These pin the envelope: the classification crosses the wire as data, and
 * the human text is unchanged so every existing reader still works.
 * ========================================================================== */

/** Drive the real router listener and capture what it answers. */
async function throughRouter(msg) {
  assert.ok(routerListeners.length, 'the worker must have registered its router');
  return new Promise((resolve) => {
    const keptOpen = routerListeners[0](msg, { id: 'test' }, resolve);
    assert.equal(keptOpen, true, 'the channel must stay open for an async reply');
  });
}

test('a failure answer carries status/code/kind, not just a sentence', async () => {
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
  // A 500 on a message whose id contains "401" — the exact reproduction.
  globalThis.fetch = async () => ({
    ok: false, status: 500, text: async () => 'backend error',
    headers: { get: () => null },
  });
  try {
    const res = await throughRouter({ type: 'MARK_READ', id: '18f401ab77cd0e12' });
    assert.equal(res.ok, false);
    assert.equal(res.status, 500, 'the status must cross the wire');
    assert.equal(res.kind, 'server', 'and so must the class');
    assert.equal(res.code, 'GMAIL_500');
    assert.match(res.error, /Gmail 500/, 'the human text is unchanged');
    assert.notEqual(res.status, 401,
      'a message id containing 401 must never be classified as an auth failure');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
});

test('a real 401 is still classified as auth', async () => {
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
  // Every attempt 401s, including the one after forceRenew, so the router
  // surfaces the canonical revoked state rather than looping.
  globalThis.fetch = async (url) => {
    if (String(url).includes('accounts.google.com') || String(url).includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    return { ok: false, status: 401, text: async () => 'invalid credentials',
      headers: { get: () => null } };
  };
  try {
    const res = await throughRouter({ type: 'MARK_READ', id: 'plain-id' });
    assert.equal(res.ok, false);
    /* A 401 does NOT surface as a bare 401: api() owns the renew-once path,
       so the answer is auth.js's own vocabulary. Any of these is the auth
       class; what matters is that it is never mistaken for a server error
       and never reached by a message id that merely contains "401". */
    assert.ok(/AUTH_REVOKED|NOT_SIGNED_IN|AUTH_RENEW_TRANSIENT|401/.test(res.error),
      `a genuine 401 must still read as an auth failure, got: ${res.error}`);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
    // The renew attempt above clears the session; restore it for later tests.
    Object.assign(storage, {
      authorized: true, accessToken: 'test-token', expiresAt: Date.now() + 3_600_000,
    });
  }
});

test('a success answer is unchanged by the envelope work', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ id: 'm1', threadId: 't1' });
  try {
    const res = await throughRouter({ type: 'MARK_READ', id: 'm1' });
    assert.equal(res.ok, true);
    assert.equal(res.data.id, 'm1');
    assert.equal(res.status, undefined, 'a success carries no error classification');
  } finally {
    globalThis.fetch = realFetch;
  }
});
