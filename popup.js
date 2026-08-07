/**
 * The toolbar popup.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two problems, one surface.
 *
 * 1. `chrome.action.onClicked` only fires if a service worker is alive to
 *    receive it. With registration failing, the toolbar button did literally
 *    nothing — which is what the user reported. A `default_popup` is rendered
 *    by the browser with no worker involved, so it always opens.
 *
 * 2. Chromium bug 394523691: another installed extension holding `webRequest`
 *    or `declarativeNetRequest` can reset the URL loader factories while our
 *    worker is registering, aborting it. Chrome reports only
 *    "Status code: 2". Fixed in Chrome 137.0.7115.0; before that the
 *    documented workaround is to register again, which usually succeeds
 *    because nothing else is loading at that moment.
 *
 * So this popup reports the true state and can repair it in one click,
 * instead of the user being told to reload the extension by hand.
 */

const $ = (id) => document.getElementById(id);

/** Paint the status strip. */
function setState(kind, text, detail) {
  const el = $('state');
  el.className = kind;
  el.textContent = text;
  const d = $('detail');
  if (detail) {
    d.textContent = detail;
    d.hidden = false;
  } else {
    d.hidden = true;
  }
}

/**
 * Is the worker answering?
 *
 * `sendMessage` with no receiver does NOT reject — it calls back with
 * `undefined` and sets `lastError`. That property must be READ or Chrome logs
 * an unchecked-error warning, so it is read deliberately here.
 */
function probe(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish({ alive: false, why: 'no reply' }), timeoutMs);
    try {
      chrome.runtime.sendMessage({ type: 'BMM_BOOT_STATUS' }, (res) => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) return finish({ alive: false, why: err.message });
        if (!res) return finish({ alive: false, why: 'empty response' });
        finish({ alive: true, data: res.data });
      });
    } catch (e) {
      clearTimeout(timer);
      finish({ alive: false, why: e.message });
    }
  });
}

async function refresh() {
  setState('busy', 'Checking background service…');
  const r = await probe();

  if (r.alive) {
    const bootErr = r.data?.error;
    if (bootErr) {
      // The worker registered but its module failed to load — boot.js caught it.
      setState('warn', 'Background loaded with an error.',
        `${bootErr.name}: ${bootErr.message}`);
      $('repair').hidden = false;
      return;
    }
    setState('ok', 'Background service running.');
    $('repair').hidden = true;
    return;
  }

  setState('warn',
    'Background service is not running. Mail still works — it runs in the tab. '
    + 'Snooze timers are paused.',
    r.why);
  $('repair').hidden = false;
}

/**
 * Try to get the worker registered.
 *
 * Registering the SAME script again is the documented workaround for
 * bug 394523691: the original attempt was interrupted by another extension
 * loading, and a second attempt usually lands because nothing else is in
 * flight. If it still fails we report the real exception, which is strictly
 * more than Chrome's own UI offers.
 */
$('repair').addEventListener('click', async () => {
  setState('busy', 'Retrying…');
  const url = chrome.runtime.getURL('sw.js');
  try {
    const reg = await navigator.serviceWorker.register(url, { type: 'module', scope: '/' });
    // Give it a moment to evaluate before asking whether it answers.
    await new Promise((r) => setTimeout(r, 400));
    void reg;
    await refresh();
  } catch (e) {
    setState('warn', 'Could not start the background service.',
      `${e.name}: ${e.message}`);
  }
});

/**
 * Open the takeover.
 *
 * Prefers an existing Gmail tab and asks the CONTENT SCRIPT directly, which
 * needs no worker. Falls back to opening Gmail if none is open.
 */
$('open').addEventListener('click', async () => {
  const [gmail] = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
  if (gmail?.id) {
    await chrome.tabs.update(gmail.id, { active: true });
    if (gmail.windowId != null) await chrome.windows.update(gmail.windowId, { focused: true });
    try {
      await chrome.tabs.sendMessage(gmail.id, { type: 'BMM_TOGGLE' });
    } catch {
      // The content script may not be injected in a tab opened before install.
      // Reloading it is the honest fix, and cheaper than explaining why not.
      await chrome.tabs.reload(gmail.id);
    }
  } else {
    await chrome.tabs.create({ url: 'https://mail.google.com/' });
  }
  window.close();
});

$('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

refresh();
