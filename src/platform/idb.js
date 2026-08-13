/**
 * IndexedDB behind the storage seam (G2 milestone 1, 2026-08-14).
 *
 * WHY THIS EXISTS
 * ---------------
 * The seam (platform/storage.js) was built for exactly this swap, and
 * NEXT.md's G2 names what chrome.storage.local cannot give the roadmap:
 * windowing beyond CACHE_MAX (the corpus already outgrows it), deeper
 * body floors, and fuller offline. chrome.storage.local is a ~10MB
 * whole-value JSON bucket; IndexedDB is the browser's real database.
 * TODO #4 waited on one thing: an adapter that speaks the AREA contract —
 * the `get`/`set`/`remove` triple every module's injectable `storage`
 * parameter already pins — so a migration is a one-argument change at the
 * consumer, not a rewrite.
 *
 * THE CONTRACT IS chrome.storage.local's, MEASURED
 * -----------------------------------------------
 *   get('k')         → `{ k: value }`, or `{}` when absent — the missing
 *                      key is OMITTED, never `{ k: undefined }` (the storage
 *                      fake's header documents why that shape matters).
 *   get(['a', 'b'])  → the present keys only.
 *   get(null)        → every entry (what a full backup read wants).
 *   set({ k, ... })  → one entry per key; `undefined` values are SKIPPED —
 *                      chrome's JSON serialisation drops them, and an area
 *                      that stores them cannot round-trip through a backup.
 *   remove('k' | []) → absent keys are not errors.
 *
 * VALUE FIDELITY: callers keep JSON-plain blobs — that was already the law
 * (the backup round-trip enforces it). Under chrome the serialiser was
 * JSON; here it is structured clone, a strict superset for JSON-plain
 * values, so the contract is unchanged. Read aliasing differs deliberately:
 * IDB hands back a fresh structured clone per read — as chrome's own
 * deserialiser does — so a test that mutates a read blob expecting the
 * store to see it was already wrong about chrome; the fake's `data` back
 * door exists for exactly that corruption work and stays test-side.
 *
 * WHAT M1 DOES NOT DO (the honest boundary, so nobody assumes)
 * ------------------------------------------------------------
 *   - NO onChanged. chrome.storage.onChanged (which intents.js watches) has
 *     no IndexedDB equivalent; a consumer needing cross-context news
 *     migrates in its own commit that solves notification (BroadcastChannel
 *     or deliberate re-read), never by silently losing the watch.
 *   - NO consumer is migrated. m1 lands the adapter and its parity proof;
 *     the body floor is the planned first migrant (G2 m2), behind the same
 *     injectable parameter and keeping chrome.storage reachable until the
 *     swap is measured — the smoke's reader/offline-floor gates depend on
 *     the preview stub, which only knows chrome.storage.
 *   - NO quota management. IDB's ceiling is high enough that eviction is a
 *     product decision, not a safety valve.
 *
 * FAILURE DISCIPLINE: an unavailable or failing IndexedDB rejects every
 * operation with an Error naming IndexedDB — a greppable shape the
 * consumer's own try/catch degrades through (every cache path here already
 * treats storage failure as "cold", never "fatal"). A failed open is NOT
 * cached: the next operation gets one fresh attempt, so a transient wedge
 * (blocked, a versionchange) self-heals on the next read instead of
 * condemning the session.
 */

/**
 * Build one storage area over one object store.
 *
 * @param {{db?: string, store?: string, backend?: IDBFactory}} [opts]
 *   `backend` exists for tests (fake-indexeddb); production callers leave
 *   it to `globalThis.indexedDB`, exactly the way STORAGE leaves its area
 *   to `globalThis.chrome`.
 *
 * ONE AREA = ONE DATABASE WITH ONE STORE. Namespacing happens by KEY
 * inside the store, mirroring chrome.storage.local's flat space — this is
 * what lets a migrant keep its existing key names (the body floor's
 * 'bodyCache' lands as-is, so m2's chrome→idb fallback read needs no key
 * mapping). IDB creates object stores only during a version change, so two
 * areas sharing a `db` but differing in `store` cannot both lazily create
 * their store: that is an API misuse, not a runtime condition, and the
 * transaction's own NotFoundError says so.
 * @returns {{get: Function, set: Function, remove: Function}}
 */
export function idbArea({ db = 'bmm', store = 'kv', backend } = {}) {
  const factory = backend ?? globalThis.indexedDB;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!factory?.open) {
        reject(new Error('IndexedDB unavailable in this context'));
        return;
      }
      const req = factory.open(db, 1);
      req.onupgradeneeded = () => {
        /* v1 lays down the one store. A future schema version numbers from
           here — never a silent shape change; a schema entry is a promise. */
        if (!req.result.objectStoreNames.contains(store)) {
          req.result.createObjectStore(store);
        }
      };
      req.onsuccess = () => {
        /* If another context ever upgrades the schema, close rather than
           wedge its upgrade behind our open handle (the classic IDB wedge). */
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB open blocked by another context'));
    }).catch((err) => {
      dbp = null; // one failed open must not condemn every later operation
      throw err;
    });
    return dbp;
  }

  /* Run `plan` in one transaction, resolving with what the plan collected.
     Every request carries an error handler so the browser logs NOTHING
     (an unhandled request error is console noise, and boot/console-clean
     counts it), but preventDefault is never called: the transaction aborts
     on any failure and the single rejection surfaces from onabort/onerror. */
  async function transact(mode, plan) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const collect = { result: undefined }; // per call — concurrent areas never share it
      plan(tx.objectStore(store), collect);
      tx.oncomplete = () => resolve(collect.result);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  return {
    async get(keys) {
      if (typeof keys === 'string') {
        return transact('readonly', (os, collect) => {
          const req = os.get(keys);
          req.onerror = () => { /* handled at the transaction */ };
          req.onsuccess = () => {
            collect.result = req.result === undefined ? {} : { [keys]: req.result };
          };
        });
      }
      if (Array.isArray(keys)) {
        return transact('readonly', (os, collect) => {
          const out = {};
          collect.result = out; // handlers fill it before oncomplete resolves
          for (const k of keys) {
            const req = os.get(k);
            req.onerror = () => { /* handled at the transaction */ };
            req.onsuccess = () => { if (req.result !== undefined) out[k] = req.result; };
          }
        });
      }
      /* get(null) — everything, zipped from parallel key/value walks.
         Events dispatch in request order, so both results are settled by
         the time the second handler runs. */
      return transact('readonly', (os, collect) => {
        const keysReq = os.getAllKeys();
        const valsReq = os.getAll();
        keysReq.onerror = valsReq.onerror = () => { /* handled at the transaction */ };
        valsReq.onsuccess = () => {
          const out = {};
          const ks = keysReq.result || [];
          const vs = valsReq.result || [];
          for (let i = 0; i < ks.length; i++) out[ks[i]] = vs[i];
          collect.result = out;
        };
      });
    },

    async set(entries) {
      return transact('readwrite', (os) => {
        for (const [k, v] of Object.entries(entries || {})) {
          if (v === undefined) continue; // chrome's JSON law: undefined never lands
          const req = os.put(v, k);
          req.onerror = () => { /* handled at the transaction */ };
        }
      });
    },

    async remove(keys) {
      return transact('readwrite', (os) => {
        for (const k of [].concat(keys)) {
          const req = os.delete(k);
          req.onerror = () => { /* handled at the transaction */ };
        }
      });
    },
  };
}
