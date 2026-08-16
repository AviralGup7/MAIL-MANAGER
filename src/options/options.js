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
 * written through `src/app/system/settings.js` rather than touching storage here.
 * One schema, one default per key, one place that coerces a bad stored value
 * -- otherwise the page that writes a setting and the app that reads it drift
 * apart, and the user is the one who finds out.
 */

import * as settings from '../app/system/settings.js';

/**
 * A setting that fails to persist must not fail silently (bug-hunt 43 #17):
 * settings.set rolls the value back and throws; this is where the user hears
 * about it. Every write on this page goes through this wrapper.
 */
function persist(promise) {
  return Promise.resolve(promise).catch(() => {
    const status = $('status');
    if (status) {
      setTone(status, 'error');
      status.textContent = 'Could not save that setting — storage is full or unavailable.';
    }
  });
}
import * as bk from '../app/system/backup.js';
import * as engine from '../app/academic/rule-engine.js';

/**
 * The client ID version 1 shipped with. Offered as a convenience because the
 * user's existing Google Cloud project is already configured for it.
 *
 * NOTE: a client ID is public information. The thing that was leaked in v1 and
 * still needs rotating is the client SECRET, which this build never uses.
 */
const V1_CLIENT_ID = '67277529230-7onu3erjki89r3vcsjmjc4ud2m026tpl.apps.googleusercontent.com';

const $ = (id) => document.getElementById(id);

function setTone(node, tone) {
  if (!node) return;
  node.dataset.tone = tone;
}

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
    setTone(idEl, 'error');
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
    setTone(status, 'neutral');
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
    setTone(status, 'error');
    status.textContent = 'That is a client SECRET. Never paste it here — rotate it instead.';
    return;
  }
  if (!/\.apps\.googleusercontent\.com$/.test(raw)) {
    setTone(status, 'error');
    status.textContent = 'That does not look like a client ID.';
    return;
  }

  await chrome.storage.local.set({ clientId: raw });
  setTone(status, 'success');
  status.textContent = 'Saved.';
  // F1 (39-PRACTICAL): a saved-but-wrong client ID is the #1 first-run
  // drop-off — the user only discovers it at the Gmail sign-in gate. Probe
  // the worker once after saving; the answer is honest either way.
  verifyClientId(status);
  setTimeout(() => (status.textContent = ''), 2500);
}

/**
 * Probe the worker for the auth state after saving a client ID.
 *
 * The service worker may be asleep — that is normal, not an error — so a
 * failed probe leaves "Saved." standing. When it answers, the message names
 * the next step instead of leaving the user to guess.
 */
function verifyClientId(status) {
  if (typeof chrome.runtime?.sendMessage !== 'function') return;
  let done = false;
  const finish = (msg) => {
    if (done) return;
    done = true;
    setTone(status, msg.includes('signed in') ? 'success' : 'neutral');
    status.textContent = msg;
    setTimeout(() => (status.textContent = ''), 4000);
  };
  const timer = setTimeout(() => finish('Saved.'), 2000);
  try {
    chrome.runtime.sendMessage({ type: 'AUTH_STATUS' }, (res) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) { finish('Saved.'); return; }
      if (res?.data?.signedIn) finish('Saved — signed in and ready.');
      else finish('Saved — open Gmail and press Alt+Shift+M to sign in.');
    });
  } catch {
    clearTimeout(timer);
    finish('Saved.');
  }
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
  const bgNotify = $('bgNotify');
  if (!markRead || !delay || !images) return;

  // Reflect stored state.
  markRead.checked = settings.get('markReadOnOpen');
  delay.value = String(settings.get('markReadDelayMs'));
  delayLabel.textContent = fmtDelay(settings.get('markReadDelayMs'));
  images.value = settings.get('remoteImages');
  if (threaded) threaded.checked = settings.get('threaded');
  /* Pointer motion (round 7): the press/magnetic/ripple/key-light tier.
     Optional-chained like every control added after the first draft — the
     options page is also booted by tests with a trimmed DOM. */
  const pointerMotion = $('pointerMotion');
  if (pointerMotion) {
    pointerMotion.value = settings.get('pointerMotion');
    pointerMotion.addEventListener('change', () => {
      void persist(settings.set('pointerMotion', pointerMotion.value));
    });
  }
  const lanesBox = $('lanes');
  if (lanesBox) {
    lanesBox.checked = settings.get('lanes');
    lanesBox.addEventListener('change', () => persist(settings.set('lanes', lanesBox.checked)));
  }
  if (auto) {
    auto.value = String(settings.get('autoRefreshMs'));
    autoLabel.textContent = fmtEvery(Number(auto.value));
  }
  if (bgNotify) {
    bgNotify.checked = false;
    bgNotify.disabled = true;
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
      await persist(settings.set('undoSendSeconds', Number(undoSend.value)));
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
    delay.closest('fieldset')?.classList.toggle('delay-disabled', !on);
  };
  syncEnabled();

  markRead.addEventListener('change', async () => {
    await persist(settings.set('markReadOnOpen', markRead.checked));
    syncEnabled();
  });

  // `input` for the live label, `change` for the write: dragging a slider
  // fires input continuously and each one would be a storage round trip.
  delay.addEventListener('input', () => {
    delayLabel.textContent = fmtDelay(Number(delay.value));
  });
  delay.addEventListener('change', async () => {
    await persist(settings.set('markReadDelayMs', Number(delay.value)));
  });

  images.addEventListener('change', async () => {
    await persist(settings.set('remoteImages', images.value));
  });

  threaded?.addEventListener('change', async () => {
    await persist(settings.set('threaded', threaded.checked));
  });

  // Same input/change split as the delay slider: live label, one write.
  auto?.addEventListener('input', () => {
    autoLabel.textContent = fmtEvery(Number(auto.value));
  });
  auto?.addEventListener('change', async () => {
    await persist(settings.set('autoRefreshMs', Number(auto.value)));
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
  const commit = () => persist(settings.set('signature', box.value));

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


/* ========================================================================== *
 * RULES
 * ========================================================================== *
 *
 * The editor lives on the options page and the ENGINE lives in the app, which
 * is the right split: the app has the mailbox in memory, so a dry run costs
 * nothing there and would cost a full sync here.
 *
 * The preview reads the message cache directly. That is a deliberate
 * compromise -- the options page cannot ask the running tab for its store --
 * and it is honest about it: the count says "of the N messages cached here".
 */

(function wireRules() {
  const list = document.getElementById('rule-list');
  const empty = document.getElementById('rule-empty');
  const query = document.getElementById('rule-query');
  const action = document.getElementById('rule-action');
  const testBtn = document.getElementById('rule-test');
  const addBtn = document.getElementById('rule-add');
  const preview = document.getElementById('rule-preview');
  if (!list || !query || !addBtn) return;

  const say = (msg, bad = false) => {
    preview.textContent = msg;
    preview.dataset.bad = String(bad);
  };

  /** The locally cached messages, which is what a dry run can see from here. */
  async function cachedMessages() {
    try {
      const { loadCache } = await import('../app/system/cache.js');
      const blob = await loadCache();
      return blob?.messages || [];
    } catch {
      return [];
    }
  }

  async function render() {
    const rules = await engine.loadRuleList();
    empty.hidden = rules.length > 0;
    list.replaceChildren();

    for (const r of rules) {
      const li = document.createElement('li');
      li.className = 'rule-row';

      const on = document.createElement('input');
      on.type = 'checkbox';
      on.checked = r.enabled;
      on.setAttribute('aria-label', `Enable ${r.name}`);
      on.addEventListener('change', async () => {
        const all = await engine.loadRuleList();
        await engine.saveRuleList(
          all.map((x) => (x.id === r.id ? { ...x, enabled: on.checked } : x))
        );
      });

      const text = document.createElement('span');
      text.className = 'rule-text';
      text.textContent = `${r.query} → ${r.actions.map((a) => a.type).join(', ')}`;

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ghost small';
      del.textContent = 'Remove';
      del.addEventListener('click', async () => {
        const all = await engine.loadRuleList();
        await engine.saveRuleList(all.filter((x) => x.id !== r.id));
        render();
      });

      li.append(on, text, del);
      list.appendChild(li);
    }
  }

  /** Build a candidate rule from the form, without saving it. */
  function candidate() {
    return engine.makeRule({
      name: query.value.trim(),
      query: query.value.trim(),
      actions: [{ type: action.value }],
    });
  }

  async function dryRun() {
    const rule = candidate();
    if (!rule) {
      say('A rule needs a condition and an action.', true);
      return null;
    }
    const check = engine.validateRule(rule);
    if (!check.ok) {
      say(check.reason, true);
      return null;
    }

    const msgs = await cachedMessages();
    const byId = new Map(msgs.map((m) => [m.id, m]));
    const out = engine.dryRun(rule, [...byId.keys()], (id) => byId.get(id));

    if (out.count === 0) {
      say(`Matches nothing among the ${msgs.length} messages cached here.`);
    } else {
      const sample = out.sample.slice(0, 3).map((x) => x.subject).filter(Boolean).join(' · ');
      say(
        `${out.warning ? out.warning + ' ' : ''}` +
        `Would ${action.value} ${out.count} of ${msgs.length} cached messages` +
        (sample ? `: ${sample}` : '')
      );
    }
    return { rule, out };
  }

  testBtn?.addEventListener('click', dryRun);

  addBtn.addEventListener('click', async () => {
    /*
     * SAVING RUNS THE DRY RUN FIRST, ALWAYS.
     *
     * Not as a convenience -- as the gate. A rule cannot be saved without its
     * effect having been computed and shown, which is the whole argument for
     * shipping the two together.
     */
    const result = await dryRun();
    if (!result) return;

    if (result.out.destructive && result.out.count > 0) {
      if (!confirm(`This will ${action.value} ${result.out.count} messages now and on arrival. Continue?`)) {
        say('Not saved.');
        return;
      }
    }

    const all = await engine.loadRuleList();
    await engine.saveRuleList([...all, result.rule]);
    query.value = '';
    say('Rule saved. It applies to mail as it arrives.');
    render();
  });

  render();
})();
