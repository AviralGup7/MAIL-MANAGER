/** "2 min", "30s", or "Never" for 0. */
function fmtEvery(ms) {
  if (!ms) return 'Never';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)} min`;
}

/**
 * Options page.
 *
 * The OAuth client ID is deliberately not hardcoded in the source, so every
 * install can point at its own Google Cloud project and there is no shared
 * credential whose revocation breaks everybody.
 *
 * Everything else on this page is a PREFERENCE, and preferences are read and
 * written through `src/app/settings.js` rather than touching storage here.
 * One schema, one default per key, one place that coerces a bad stored value
 * -- otherwise the page that writes a setting and the app that reads it drift
 * apart, and the user is the one who finds out.
 */

import * as settings from '../app/settings.js';
import * as bk from '../app/backup.js';

/**
 * The client ID version 1 shipped with. Offered as a convenience because the
 * user's existing Google Cloud project is already configured for it.
 *
 * NOTE: a client ID is public information. The thing that was leaked in v1 and
 * still needs rotating is the client SECRET, which this build never uses.
 */
const V1_CLIENT_ID = '67277529230-7onu3erjki89r3vcsjmjc4ud2m026tpl.apps.googleusercontent.com';

const $ = (id) => document.getElementById(id);

// chrome.identity.getRedirectURL() is derived from the extension ID. Showing
// the live value avoids the single most common setup failure:
// redirect_uri_mismatch.
//
// The ID is stable because manifest.json carries a fixed "key". Without it
// Chrome mints a new keypair on every unpacked load, the ID changes, and this
// URI would have to be re-registered with Google after every single reload.
$('redirect').textContent = chrome.identity.getRedirectURL();

// Surface the ID too, and flag it when it is not the expected one -- an
// unexpected ID means the key is missing or altered, and sign-in WILL fail
// with redirect_uri_mismatch no matter what client ID is entered.
const EXPECTED_ID = 'dgeanijfllibcphbblkhacjcbdehihcp';
const idEl = document.getElementById('extid');
if (idEl) {
  idEl.textContent = chrome.runtime.id;
  if (chrome.runtime.id !== EXPECTED_ID) {
    idEl.style.color = '#c0392b';
    idEl.title =
      'Unexpected extension ID. manifest.json should contain the fixed "key" ' +
      'field; without it the ID changes on every load and OAuth cannot work.';
  }
}

chrome.storage.local.get('clientId').then(({ clientId }) => {
  if (clientId) $('clientId').value = clientId;
});

$('save').addEventListener('click', save);
$('clientId').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') save();
});
$('useDefault').addEventListener('click', () => {
  $('clientId').value = V1_CLIENT_ID;
  save();
});

async function save() {
  const raw = $('clientId').value.trim();
  const status = $('status');

  if (!raw) {
    await chrome.storage.local.remove('clientId');
    status.style.color = '#5b6270';
    status.textContent = 'Cleared.';
    return;
  }
  /*
   * THE SECRET CHECK MUST COME FIRST.
   *
   * It used to sit AFTER the format check, and a real secret
   * (`GOCSPX-...`) does not end in `.apps.googleusercontent.com` -- so it
   * failed the format test and returned with "That does not look like a
   * client ID." The specific, security-relevant warning was UNREACHABLE for
   * every value that could actually trigger it.
   *
   * The generic message is not wrong, but it teaches the user to fix the
   * format rather than to go and rotate a leaked credential, which is the
   * exact mistake v1 institutionalised.
   */
  if (/^GOCSPX-/.test(raw)) {
    status.style.color = '#c0392b';
    status.textContent = 'That is a client SECRET. Never paste it here — rotate it instead.';
    return;
  }
  if (!/\.apps\.googleusercontent\.com$/.test(raw)) {
    status.style.color = '#c0392b';
    status.textContent = 'That does not look like a client ID.';
    return;
  }

  await chrome.storage.local.set({ clientId: raw });
  status.style.color = '#1e9e6a';
  status.textContent = 'Saved.';
  setTimeout(() => (status.textContent = ''), 2500);
}

/* ========================================================================== *
 * PREFERENCES
 *
 * Backed by src/app/settings.js so the schema, the defaults and the coercion
 * live in ONE place. Reading these keys ad-hoc here is what the settings
 * module exists to prevent -- it is how a default drifts between the page
 * that writes it and the app that reads it.
 * ========================================================================== */


const fmtDelay = (ms) => (ms === 0 ? 'off' : `${(ms / 1000).toFixed(1)}s`);

/** "Off" reads better than "0s" for a window that has been disabled. */
function fmtHold(sec) {
  return sec === 0 ? 'off' : `${sec}s`;
}

(async function wirePreferences() {
  await settings.loadSettings();

  const markRead = $('markReadOnOpen');
  const delay = $('markReadDelayMs');
  const delayLabel = $('markReadDelayLabel');
  const images = $('remoteImages');
  const threaded = $('threaded');
  const auto = $('autoRefreshMs');
  const autoLabel = $('autoRefreshLabel');
  const undoSend = $('undoSendSeconds');
  const undoSendLabel = $('undoSendLabel');
  if (!markRead || !delay || !images) return;

  // Reflect stored state.
  markRead.checked = settings.get('markReadOnOpen');
  delay.value = String(settings.get('markReadDelayMs'));
  delayLabel.textContent = fmtDelay(settings.get('markReadDelayMs'));
  images.value = settings.get('remoteImages');
  if (threaded) threaded.checked = settings.get('threaded');
  const lanesBox = $('lanes');
  if (lanesBox) {
    lanesBox.checked = settings.get('lanes');
    lanesBox.addEventListener('change', () => settings.set('lanes', lanesBox.checked));
  }
  if (auto) {
    auto.value = String(settings.get('autoRefreshMs'));
    autoLabel.textContent = fmtEvery(Number(auto.value));
  }
  if (undoSend) {
    undoSend.value = String(settings.get('undoSendSeconds'));
    undoSendLabel.textContent = fmtHold(Number(undoSend.value));

    // `input` for the label, `change` for the write -- same reasoning as the
    // read-delay slider below.
    undoSend.addEventListener('input', () => {
      undoSendLabel.textContent = fmtHold(Number(undoSend.value));
    });
    undoSend.addEventListener('change', async () => {
      await settings.set('undoSendSeconds', Number(undoSend.value));
    });
  }

  /*
   * The delay control is meaningless when marking-read is off, so it is
   * disabled rather than left live and ignored. A control that does nothing
   * is worse than one that is absent.
   */
  const syncEnabled = () => {
    const on = markRead.checked;
    delay.disabled = !on;
    delay.closest('fieldset').querySelector('label[for="markReadDelayMs"]').style.opacity =
      on ? '1' : '0.5';
  };
  syncEnabled();

  markRead.addEventListener('change', async () => {
    await settings.set('markReadOnOpen', markRead.checked);
    syncEnabled();
  });

  // `input` for the live label, `change` for the write: dragging a slider
  // fires input continuously and each one would be a storage round trip.
  delay.addEventListener('input', () => {
    delayLabel.textContent = fmtDelay(Number(delay.value));
  });
  delay.addEventListener('change', async () => {
    await settings.set('markReadDelayMs', Number(delay.value));
  });

  images.addEventListener('change', async () => {
    await settings.set('remoteImages', images.value);
  });

  threaded?.addEventListener('change', async () => {
    await settings.set('threaded', threaded.checked);
  });

  // Same input/change split as the delay slider: live label, one write.
  auto?.addEventListener('input', () => {
    autoLabel.textContent = fmtEvery(Number(auto.value));
  });
  auto?.addEventListener('change', async () => {
    await settings.set('autoRefreshMs', Number(auto.value));
  });
})();

/*
 * Signature.
 *
 * Debounced on `input` rather than written per keystroke, for the same reason
 * the delay slider commits on `change`: a storage round trip per character is
 * waste. `blur` flushes, so leaving the field always persists.
 */
(async function wireSignature() {
  const box = $('signature');
  if (!box) return;

  let timer = 0;
  const commit = () => settings.set('signature', box.value);

  /*
   * Await the load explicitly rather than deferring by a task.
   *
   * `settings.loadSettings()` caches, so this second call is nearly free and
   * resolves after the same fetch the preferences block awaits. A
   * `setTimeout(0)` happened to work, but it depended on the storage promise
   * settling within one task -- true in jsdom, not guaranteed in Chrome, and
   * the failure mode is a silently EMPTY signature box that then overwrites
   * the stored value on blur.
   */
  await settings.loadSettings();
  box.value = settings.get('signature');

  box.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(commit, 400);
  });
  box.addEventListener('blur', () => {
    clearTimeout(timer);
    commit();
  });
})();


/* ========================================================================== *
 * BACKUP AND RESTORE
 * ========================================================================== */

(function wireBackup() {
  const exportBtn = document.getElementById('btn-export');
  const importBtn = document.getElementById('btn-import');
  const file = document.getElementById('import-file');
  const status = document.getElementById('backup-status');
  if (!exportBtn || !importBtn || !file) return;

  const say = (msg, bad = false) => {
    status.textContent = msg;
    status.dataset.bad = String(bad);
  };

  exportBtn.addEventListener('click', async () => {
    try {
      const backup = await bk.exportBackup();
      const blob = new Blob([bk.toJson(backup)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = bk.filenameFor(backup);
      a.click();
      // Revoke on the next turn: revoking synchronously can beat the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      say(`Saved ${backup.keys.length} settings groups.`);
    } catch (err) {
      say(`Could not export: ${err.message}`, true);
    }
  });

  importBtn.addEventListener('click', () => file.click());

  file.addEventListener('change', async () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    try {
      const text = await chosen.text();

      /*
       * PREVIEW, THEN CONFIRM, THEN WRITE.
       *
       * The count per key is what the user actually needs to decide -- "replace
       * my 12 rules with these 5" -- and it is the difference between restoring
       * a backup and losing a semester of corrections to a stray click.
       */
      const preview = await bk.previewImport(text);
      if (!preview.ok) {
        say(preview.reason, true);
        return;
      }
      const summary = preview.changes
        .map((c) => `${c.key}: ${c.currentCount} -> ${c.incomingCount}`)
        .join('\n');
      if (!confirm(`Restore this backup?\n\n${summary}\n\nThis replaces what is there now.`)) {
        say('Restore cancelled.');
        return;
      }

      const out = await bk.importBackup(text);
      if (out.ok) {
        say(`Restored ${out.applied.length} groups. Reopen the mail tab to see them.`);
      } else {
        say(`Restored ${out.applied.length}, failed: ${out.failed.join(', ')}`, true);
      }
    } catch (err) {
      say(`Could not read that file: ${err.message}`, true);
    } finally {
      // Or choosing the same file twice fires no change event.
      file.value = '';
    }
  });
})();
