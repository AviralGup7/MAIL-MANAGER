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

// chrome.identity.getRedirectURL() is derived from the extension ID, which
// changes between an unpacked load and a Web Store install. Showing the live
// value avoids the single most common setup failure: redirect_uri_mismatch.
$('redirect').textContent = chrome.identity.getRedirectURL();

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
