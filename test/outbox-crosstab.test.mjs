/**
 * Cross-tab outbox pumping — the verification task (roadmap M3 / phase 5).
 *
 * Two Gmail tabs both run the fallback pump against the SAME profile storage.
 * The coordination is the shared-storage claim (TAB_ID + TTL). This suite
 * REPRODUCES the concurrent scenario in node: two outbox module instances
 * (cache-busted imports = two "tabs", each with its own TAB_ID and inFlight
 * flag) racing over one fake storage, with interleaving awaits.
 *
 * Verdict rule (advisor phase 5): if claims hold, mark resolved; fix only on
 * reproduction. Run the race with real interleaving and count dispatches.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url);
/** Cache-busted import = a second "tab" with its own TAB_ID + inFlight. */
const importTab = () => import(pathToFileURL(join(ROOT.pathname, 'src/app/outbox.js')).href + `?t=${Math.random()}`);

/** One shared chrome.storage.local, async like the real one. */
function sharedStorage() {
  const data = {};
  return {
    data,
    async get(k) {
      await Promise.resolve(); // yield — lets the other tab interleave
      if (typeof k === 'string') return k in data ? { [k]: data[k] } : {};
      const out = {};
      for (const key of k) if (key in data) out[key] = data[key];
      return out;
    },
    async set(obj) {
      await Promise.resolve();
      Object.assign(data, obj);
    },
    async remove(k) {
      await Promise.resolve();
      for (const key of [].concat(k)) delete data[key];
    },
  };
}

function seedItems(storage, n, now) {
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push({
      id: `q:${i}`, state: 'held', draft: { to: `t${i}@x.y` },
      queuedAt: now - 1000, releaseAt: now - 1, attempts: 0, nextAttempt: 0,
    });
  }
  storage.data.outbox = items;
  return items;
}

test('TWO TABS PUMPING CONCURRENTLY SEND EACH MESSAGE EXACTLY ONCE', async () => {
  const storage = sharedStorage();
  const now = Date.now();
  seedItems(storage, 6, now);

  const tabA = await importTab();
  const tabB = await importTab();

  const dispatches = new Map(); // draft.to -> count (send takes the draft)
  const send = async (draft) => {
    dispatches.set(draft.to, (dispatches.get(draft.to) || 0) + 1);
    await Promise.resolve(); // wire latency: widen the race window
    return { id: `g:${draft.to}` };
  };

  // Both tabs pump at the same instant, over the same storage.
  const [ra, rb] = await Promise.all([
    tabA.flushOutbox({ send, storage, now }),
    tabB.flushOutbox({ send, storage, now }),
  ]);

  assert.equal(ra.sent + rb.sent, 6, 'every message leaves exactly once in total');
  for (const [id, n] of dispatches) {
    assert.equal(n, 1, `${id} was dispatched ${n} times — double send`);
  }
  const left = await tabA.loadOutbox(storage);
  assert.equal(left.length, 0, 'the queue drained');
});

test('A STAGGERED SECOND TAB STANDS DOWN WHILE THE CLAIM IS FRESH', async () => {
  const storage = sharedStorage();
  const now = Date.now();
  seedItems(storage, 3, now);

  const tabA = await importTab();
  const tabB = await importTab();

  const dispatches = new Map();
  const send = async (draft) => {
    dispatches.set(draft.to, (dispatches.get(draft.to) || 0) + 1);
    await Promise.resolve();
    return { id: `g:${draft.to}` };
  };

  const first = await tabA.flushOutbox({ send, storage, now });
  assert.equal(first.sent, 3, 'the first tab drains');

  // Second tab arrives while the claims are still fresh (TTL is 180s).
  const second = await tabB.flushOutbox({ send, storage, now: now + 1000 });
  assert.equal(second.sent, 0, 'nothing left to send');
  for (const [, n] of dispatches) assert.equal(n, 1, 'no double send');
});

test('AN EXPIRED CLAIM LETS ANOTHER TAB RESCUE THE ITEM (TTL backstop)', async () => {
  const storage = sharedStorage();
  const now = Date.now();
  // A claim from a tab that died mid-send, long enough ago to be stale.
  storage.data.outboxClaims = { 'q:0': { tab: 'dead-tab', at: now - 200000 } };
  seedItems(storage, 1, now);

  const tab = await importTab();
  let sent = 0;
  const send = async () => { sent++; return { id: 'g:1' }; };
  const r = await tab.flushOutbox({ send, storage, now });
  assert.equal(r.sent, 1, 'a stale claim must not strand the item forever');
  assert.equal(sent, 1);
});

test('REPEATED RACES NEVER DOUBLE-SEND (fuzz the interleaving)', async () => {
  // Ten races of four items each; any double dispatch fails loudly.
  for (let round = 0; round < 10; round++) {
    const storage = sharedStorage();
    const now = Date.now();
    seedItems(storage, 4, now);
    const tabA = await importTab();
    const tabB = await importTab();
    const dispatches = new Map();
    const send = async (draft) => {
      dispatches.set(draft.to, (dispatches.get(draft.to) || 0) + 1);
      // Vary the latency so interleavings differ round to round.
      await new Promise((r) => setTimeout(r, round % 3));
      return { id: `g:${draft.to}` };
    };
    await Promise.all([
      tabA.flushOutbox({ send, storage, now }),
      tabB.flushOutbox({ send, storage, now }),
    ]);
    for (const [id, n] of dispatches) {
      assert.equal(n, 1, `round ${round}: ${id} dispatched ${n} times`);
    }
  }
});
