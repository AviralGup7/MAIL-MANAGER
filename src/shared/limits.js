/**
 * Shared limits that cross the app/worker seam.
 *
 * Same doctrine as labels.js (R-5): the GET_INLINE budget is enforced by the
 * service worker AND by the in-page fallback. Two copies of a number like
 * this are two copies of policy, and policy that drifts is a hole. Both
 * sides point DOWN at this module instead.
 *
 * Inline-image budget: 2MB of source bytes becomes roughly 2.7MB of base64
 * in the srcdoc string, which is a large but survivable document. 20 parts
 * covers every legitimate newsletter seen in the data pack with room to
 * spare.
 */
export const MAX_INLINE_BYTES = 2 * 1024 * 1024;
export const MAX_INLINE_PARTS = 20;

/**
 * Gmail's batchModify accepts at most 1000 ids per request. Both bulk paths
 * (worker verb and in-page fallback) chunk at this; the number lives here so
 * they cannot drift.
 */
export const BULK_CHUNK = 1000;
