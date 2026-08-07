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

  /*
   * SELF-HEAL ONCE, SILENTLY, BEFORE BOTHERING THE USER.
   *
   * The common cause is a stale/unregistered slot in the profile, and the
   * fix is deterministic. Asking someone to click "Repair" for a problem the
   * page can fix itself is passing our bug to them.
   *
   * Once only, and only on the first open: if it does not take, the banner
   * appears and the button is there for a manual retry. Looping would be
   * worse than the fault.
   */
  if (!autoRepairTried) {
    autoRepairTried = true;
    setState('busy', 'Restarting background service...');
    if (await tryRepair()) {
      const again = await probe();
      if (again.alive && !again.data?.error) {
        setState('ok', 'Background service running.');
        $('repair').hidden = true;
        return;
      }
    }
  }

  setState('warn',
    'Background service is not running. Mail still works - it runs in the tab. '
    + 'Snooze timers are paused.',
    r.why);
  $('repair').hidden = false;
}

/** Has the silent repair already run this session? */
let autoRepairTried = false;

/**
 * Clear the stale registration and register again from the manifest.
 * @returns {Promise<boolean>} whether the attempt completed without throwing
 */
async function tryRepair() {
  const mf = chrome.runtime.getManifest();
  const script = mf.background?.service_worker;
  const type = mf.background?.type;
  if (!script) return false;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) {
      try { await r.unregister(); } catch { /* best effort */ }
    }
    await navigator.serviceWorker.register(
      chrome.runtime.getURL(script),
      type === 'module' ? { type: 'module', scope: '/' } : { scope: '/' }
    );
    await new Promise((r) => setTimeout(r, 600));
    return true;
  } catch {
    return false;
  }
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
  setState('busy', 'Repairing...');
  if (await tryRepair()) {
    await refresh();
  } else {
    setState('warn',
      'Could not restart it. Reloading the extension usually clears this.');
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
