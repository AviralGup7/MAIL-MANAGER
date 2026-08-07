/*
 * The smallest possible MV3 module service worker.
 *
 * Load this with "Load unpacked" pointed at tools/sw-probe. It has no
 * permissions, no imports, no manifest key and touches no chrome.* API, so
 * there is nothing in it that can fail.
 *
 *   It registers  -> Chrome and your profile are fine, and the fault is
 *                    something specific to the main extension.
 *   It ALSO fails -> the fault is in the browser or the profile, not in any
 *                    code I can reach: enterprise policy, a corrupted
 *                    profile, an unwritable extensions directory, or Chrome
 *                    running from a read-only/exotic filesystem.
 *
 * That single bit of information is worth more than any further static
 * analysis of the real extension, which now passes every check I can write.
 */
console.log('[PROBE] service worker registered OK');
