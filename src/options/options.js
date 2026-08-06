/**
 * Options page.
 *
 * One setting: the OAuth client ID. Deliberately not hardcoded in the source,
 * so every install can point at its own Google Cloud project and there is no
 * shared credential whose revocation breaks everybody.
 */

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
  if (!/\.apps\.googleusercontent\.com$/.test(raw)) {
    status.style.color = '#c0392b';
    status.textContent = 'That does not look like a client ID.';
    return;
  }
  if (/^GOCSPX-/.test(raw)) {
    // Guard against the exact mistake v1 institutionalised.
    status.style.color = '#c0392b';
    status.textContent = 'That is a client SECRET. Never paste it here — rotate it instead.';
    return;
  }

  await chrome.storage.local.set({ clientId: raw });
  status.style.color = '#1e9e6a';
  status.textContent = 'Saved.';
  setTimeout(() => (status.textContent = ''), 2500);
}
