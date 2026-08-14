/**
 * Which Gmail tab should "open mail" reuse? (audit 2026-08-15, AUD-M2)
 *
 * THE OLD LAW: the first Gmail tab in query order — which, for a user signed
 * into two accounts, is whichever tab opened FIRST, not the account the
 * session is actually reading. The toolbar button then "helpfully" focused
 * account A's tab and injected the takeover for account B's session.
 *
 * THE NEW LAW, AS A PURE FUNCTION so the property is pinnable: prefer the
 * tab whose /mail/u/N/ matches the session's reported authuser; when the
 * stamp is unknown, invalid, or matches nothing, the first-tab behavior is
 * the fallback — preserved by design (the owner's rule: nothing is
 * removed), because an honest first tab beats no answer.
 */

/**
 * The authuser index a Gmail tab URL carries. The bare domain and any
 * pathless variant are account 0 — the same reading the takeover's
 * accountIndex() has always made.
 */
export function authUserOf(url) {
  const m = /\/mail\/u\/(\d+)\//.exec(String(url || ''));
  return m ? m[1] : '0';
}

/**
 * @param {Array<{id?:number, windowId?:number, url?:string}>} tabs
 * @param {string} [preferred]  the session's reported authuser ('' = unknown)
 * @returns the tab to reuse, or null when the list is empty (caller creates)
 */
export function pickGmailTab(tabs, preferred = '') {
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  const want = /^\d+$/.test(String(preferred ?? '')) ? String(preferred) : '';
  if (want) {
    const hit = tabs.find((t) => authUserOf(t?.url) === want);
    if (hit) return hit;
  }
  return tabs[0];
}
