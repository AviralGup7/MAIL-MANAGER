/**
 * Truthful system telemetry for the modern UI profile.
 *
 * This is intentionally a projection, never a second state store. Every label
 * comes from the shared shell state or the live mailbox Store. No timers, fake
 * coordinates, random numerals or infrastructure details enter the strip.
 */

let ctx = null;
const $ = (id) => document.getElementById(id);

/** @param {{state:object, store:()=>any, openOperations?:()=>void}} c */
export function wireSystemTelemetry(c) {
  ctx = c;
  $('sys-operations')?.addEventListener('click', () => ctx?.openOperations?.());
  renderSystemTelemetry();
}

function syncLabel(state) {
  if (!state?.signedIn) return 'OFFLINE';
  if (state.loading) return 'PREPARING';
  if (!state.lastSync) return 'WAITING';
  return 'COMMITTED';
}

export function renderSystemTelemetry() {
  if (!ctx) return;
  const state = ctx.state || {};
  const store = ctx.store?.();
  const account = String(state.selfEmail || '').trim();
  const mailbox = String(state.mailbox || 'inbox').toUpperCase();
  const count = Math.max(0, Number(store?.size || 0));

  const accountEl = $('sys-account');
  const mailboxEl = $('sys-mailbox');
  const recordsEl = $('sys-records');
  const syncEl = $('sys-sync');
  if (accountEl) {
    accountEl.textContent = account ? 'VERIFIED' : 'UNVERIFIED';
    accountEl.title = account || 'No verified account';
  }
  if (mailboxEl) mailboxEl.textContent = mailbox;
  if (recordsEl) recordsEl.textContent = String(count).padStart(4, '0');
  if (syncEl) syncEl.textContent = syncLabel(state);
}

export function _resetSystemTelemetry() {
  ctx = null;
}
