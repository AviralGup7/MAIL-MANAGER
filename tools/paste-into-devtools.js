/*
 * PASTE THIS INTO THE DEVTOOLS CONSOLE OF ANY EXTENSION PAGE.
 *
 *   chrome://extensions -> BITS Mail Manager -> Details
 *   -> "Inspect views" -> click any page   (or open Settings and press F12)
 *
 * WHAT CHANGED, AND WHY THE LAST VERSION WAS WRONG
 * ------------------------------------------------
 * The previous snippet called navigator.serviceWorker.register() on the SAME
 * script the manifest declares, at the SAME scope. Chrome has already
 * reserved that registration for the extension, so a second one competing
 * with it is aborted -- and the AbortError we chased was quite possibly my
 * snippet's own fault rather than evidence of anything.
 *
 * This version does not register anything. It READS the state Chrome already
 * holds, which cannot be confused with a conflict of our own making.
 */
(async () => {
  const log = (...a) => console.log('[why]', ...a);
  const bad = (...a) => console.error('[why]', ...a);

  log('extension id :', chrome.runtime.id);
  log('manifest sw  :', chrome.runtime.getManifest().background?.service_worker);

  // 1. Does the file actually serve over the extension origin?
  const url = chrome.runtime.getURL('sw.js');
  try {
    const res = await fetch(url);
    const text = await res.text();
    log('sw.js fetch  :', res.status, res.statusText, '|', text.length, 'chars');
    log('content-type :', res.headers.get('content-type'));
    if (!text.length) bad('THE FILE IS EMPTY over chrome-extension://');
  } catch (e) {
    bad('cannot fetch sw.js at all:', e);
  }

  // 2. What registration does Chrome already hold? No new one is created.
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    log('existing registrations:', regs.length);
    for (const r of regs) {
      log('  scope   :', r.scope);
      log('  active  :', r.active && r.active.state, r.active && r.active.scriptURL);
      log('  waiting :', r.waiting && r.waiting.state);
      log('  installing:', r.installing && r.installing.state);
    }
    if (!regs.length) {
      bad('Chrome holds NO registration for this extension.');
      bad('That is the failure, and it happened before any code of ours ran.');
    }
  } catch (e) {
    bad('getRegistrations failed:', e);
  }

  // 3. Is the worker answering? This is what actually matters day to day.
  try {
    const res = await new Promise((resolve) => {
      const t = setTimeout(() => resolve('TIMEOUT'), 2000);
      chrome.runtime.sendMessage({ type: 'BMM_BOOT_STATUS' }, (r) => {
        clearTimeout(t);
        const e = chrome.runtime.lastError;
        resolve(e ? `lastError: ${e.message}` : r);
      });
    });
    log('BMM_BOOT_STATUS ->', res);
  } catch (e) {
    bad('probe threw:', e);
  }

  log('---');
  log('If registrations is 0 and the fetch was 200, the script is fine and');
  log('Chrome refused to start it. That is crbug 394523691 territory:');
  log('check chrome://version is >= 137, and try disabling ad blockers.');
})();
