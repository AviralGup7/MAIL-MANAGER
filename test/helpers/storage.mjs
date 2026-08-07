/**
 * One fake for `chrome.storage.local`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Five test files each defined their own `fakeStorage`, and the consistency
 * audit found they had drifted into four different contracts:
 *
 *   cache.test        get/set/remove, `{}` for a missing key, exposes `data`
 *   views.test        get/set/remove, `{}` for a missing key, exposes `d`
 *   draft-store.test  get/set/remove, `{k: undefined}`,       exposes `_data()`
 *                     plus a `writes` counter
 *   rules.test        get/set ONLY,   `{k: undefined}`,       exposes `_data()`
 *   snooze.test       get/set ONLY,   `{k: undefined}`,       exposes `_data()`
 *                     plus `_fail()`
 *
 * Three of the five could not have caught a stray `storage.remove` call
 * because they did not implement it -- the method simply would not exist, and
 * the module under test would throw a TypeError that reads as an unrelated
 * failure. Two disagreed with the other three about what a missing key
 * returns.
 *
 * THE MISSING-KEY SHAPE IS THE INTERESTING ONE. Chrome resolves
 * `storage.local.get('k')` for an absent key to `{}` -- the key is not
 * present -- NOT to `{k: undefined}`. Both shapes happen to yield `undefined`
 * when the caller writes `got[KEY]`, which every module here does, so no bug
 * was hiding behind the disagreement. It was checked rather than assumed.
 * But a fake that is wrong about its contract is a trap set for the next
 * person, and the honest fix is to model the real API once.
 *
 * This models Chrome's actual behaviour: `{}` for a missing key, `remove`
 * accepts a string or an array, and every method is async.
 */

/**
 * @param {Object} [initial] seed data
 * @returns a storage-area double with test affordances
 */
export function fakeStorage(initial = {}) {
  let data = { ...initial };
  return {
    /** How many times `set` was called. Used to assert debouncing. */
    writes: 0,

    async get(keys) {
      if (typeof keys === 'string') {
        // Chrome omits the key entirely when it is absent.
        return keys in data ? { [keys]: data[keys] } : {};
      }
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in data) out[k] = data[k];
        return out;
      }
      return { ...data };
    },

    async set(obj) {
      this.writes += 1;
      data = { ...data, ...obj };
    },

    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },

    /**
     * The raw contents, for assertions.
     *
     * Exposed BOTH ways because the five originals disagreed: three used
     * `_data()`, one used `.data` and one used `.d`. `data` is a live getter
     * rather than a snapshot, so a test that reaches in and mutates the stored
     * object -- cache.test does exactly that, to corrupt a blob on purpose --
     * still affects what the module reads back.
     */
    get data() { return data; },
    _data: () => data,

    /** Make every subsequent write fail, to exercise degradation paths. */
    _fail() {
      this.set = async () => { throw new Error('quota'); };
      return this;
    },
  };
}
