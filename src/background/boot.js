/**
 * The service worker entry point: a loader that cannot fail to register.
 *
 * WHY THIS EXISTS
 * ---------------
 * Chrome has refused to register `index.js` with "Service worker registration
 * failed. Status code: 2" across many attempts, while every check passes:
 * the manifest is byte-identical to a build that worked, the module graph
 * evaluates cleanly in a worker-shaped global, all named imports resolve, and
 * `node --check` is happy on every file. The cause is still unidentified.
 *
 * The distinction that matters is between two kinds of failure:
 *
 *   PARSE/LINK failure -- a syntax error, an unresolvable specifier, a missing
 *   named export. These happen BEFORE any line runs, so no amount of
 *   try/catch inside the file can help. Chrome kills the registration.
 *
 *   EVALUATION failure -- a throw while the top-level code runs.
 *
 * A *static* `import` of index.js would inherit both. A *dynamic* `import()`
 * inside a try/catch inherits neither: the loader parses and registers
 * successfully on its own, then attempts the real module, and if that fails
 * for any reason at all it reports the exception instead of taking the whole
 * extension down with it.
 *
 * So this file has no static imports, touches no chrome.* API at the top
 * level, and contains nothing that can throw. If Chrome still cannot register
 * THIS, the fault is provably not in our JavaScript.
 */

/** What went wrong, if anything. Read by the diagnostic below. */
let bootError = null;
let booted = false;

/*
 * A minimal responder installed FIRST, before the real module is attempted.
 *
 * Without it, a failed load means `chrome.runtime.sendMessage` from the app
 * gets no listener at all, which surfaces as "Could not establish connection"
 * -- indistinguishable from the worker being absent. With it, the app gets a
 * real answer explaining why, which is what turns a dead extension into a
 * diagnosable one.
 *
 * It is registered synchronously at top level because MV3 requires listeners
 * to be attached during the first turn of the event loop; adding one after an
 * await is not guaranteed to be honoured on a cold start.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'BMM_BOOT_STATUS') return false;
  sendResponse({
    ok: true,
    data: {
      booted,
      error: bootError
        ? { name: bootError.name, message: bootError.message, stack: bootError.stack }
        : null,
    },
  });
  return true;
});

/*
 * Load the real worker.
 *
 * Deliberately NOT awaited at top level. A top-level await would make this
 * module's own evaluation depend on the dynamic import resolving, which
 * reintroduces exactly the coupling this file exists to break.
 */
import('./index.js')
  .then(() => {
    booted = true;
    console.log('[BMM] service worker ready. Shortcut: Alt+Shift+M');
  })
  .catch((err) => {
    bootError = err;
    /*
     * Loud, and with the stack. This is the message that has been missing
     * from every round of this investigation -- Chrome's own report names no
     * file and no line, and this one does.
     */
    console.error(
      '[BMM] the background module failed to load. The extension is running '
      + 'in a degraded state: the app will fall back to in-page mode.\n'
      + `${err && err.name}: ${err && err.message}`
    );
    if (err && err.stack) console.error(err.stack);

    /*
     * Surface it on the toolbar icon too. A console message helps only
     * someone already looking at the console.
     */
    try {
      chrome.action?.setBadgeText({ text: '!' });
      chrome.action?.setBadgeBackgroundColor({ color: '#b3261e' });
      chrome.action?.setTitle({
        title: 'BITS Mail Manager -- background failed to load. Open Gmail and press Alt+Shift+M.',
      });
    } catch {
      // Badge is a courtesy; never let it mask the original error.
    }
  });
