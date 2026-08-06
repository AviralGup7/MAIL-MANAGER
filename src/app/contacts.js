/**
 * Contact autocomplete.
 *
 * THE PROBLEM
 * `c-to` was `autocomplete="off"` free text. One typo and the mail bounces --
 * or worse, quietly reaches the wrong person, which at an institution with
 * addresses like `f20240294@` and `f20240924@` is not a hypothetical.
 *
 * WHY NO NEW PERMISSION IS NEEDED
 * Every address the user has ever corresponded with is ALREADY in the local
 * store, and `Store.tokenize` already indexes the local part and domain of an
 * address separately. The data structure for this was built for search and
 * costs nothing to reuse. Google's People API would need a new OAuth scope, a
 * new consent screen, and a network round trip per keystroke, for a worse
 * result: it does not know who you actually email.
 *
 * RANKING
 * Frequency first, recency second. Someone you mailed twenty times last term
 * should outrank someone you mailed once yesterday, but not by so much that a
 * new correspondent never surfaces. A simple frequency count with a recency
 * tiebreak matches how people actually think about "who do I mean".
 */

/** Parse one address out of a `Name <addr>` header. */
export function parseAddress(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(s);
  if (m) {
    const name = m[1].trim().replace(/^["']|["']$/g, '');
    const address = m[2].trim().toLowerCase();
    return address.includes('@') ? { name, address } : null;
  }
  return s.includes('@') ? { name: '', address: s.toLowerCase() } : null;
}

/** Split a To/Cc header, which may hold several comma-separated addresses. */
export function parseAddressList(raw) {
  const out = [];
  // Split on commas that are not inside quotes or angle brackets.
  for (const part of String(raw || '').split(/,(?![^<]*>)/)) {
    const a = parseAddress(part);
    if (a) out.push(a);
  }
  return out;
}

/**
 * Build a ranked contact book from the messages we hold.
 *
 * @param {Iterable<{from?:string,to?:string,date?:number}>} messages
 * @param {{selfAddress?:string}} opts
 */
export function buildContacts(messages, opts = {}) {
  const self = (opts.selfAddress || '').toLowerCase();
  /** @type {Map<string,{address:string,name:string,count:number,last:number}>} */
  const map = new Map();

  const note = (parsed, date) => {
    if (!parsed) return;
    const { address, name } = parsed;
    if (!address || address === self) return;
    const hit = map.get(address);
    if (hit) {
      hit.count++;
      if (date > hit.last) hit.last = date;
      // Prefer a real display name over an empty one, and a longer one over
      // an abbreviation -- headers are inconsistent about this.
      if (name && name.length > hit.name.length) hit.name = name;
    } else {
      map.set(address, { address, name: name || '', count: 1, last: date || 0 });
    }
  };

  for (const m of messages) {
    if (!m) continue;
    const d = m.date || 0;
    note(parseAddress(m.from), d);
    for (const a of parseAddressList(m.to)) note(a, d);
  }

  return [...map.values()].sort(
    (a, b) => b.count - a.count || b.last - a.last || a.address.localeCompare(b.address)
  );
}

/**
 * Match a typed fragment against the contact book.
 *
 * Matching is on BOTH the display name and the address, because people search
 * for whichever they remember. A prefix match ranks above a substring match:
 * typing "au" should suggest `augsd@...` before `library-auto@...`.
 */
export function matchContacts(contacts, query, limit = 6) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  const scored = [];
  for (const c of contacts) {
    const name = c.name.toLowerCase();
    const addr = c.address;
    let rank = -1;

    if (addr.startsWith(q)) rank = 0;
    else if (name.startsWith(q)) rank = 1;
    // The local part after any dot/dash boundary, e.g. "smith" in "j.smith@".
    else if (new RegExp(`(^|[.\\-_])${escapeRe(q)}`).test(addr.split('@')[0])) rank = 2;
    else if (name.includes(q)) rank = 3;
    else if (addr.includes(q)) rank = 4;
    else continue;

    scored.push({ c, rank });
  }

  scored.sort((a, b) => a.rank - b.rank || b.c.count - a.c.count || b.c.last - a.c.last);
  return scored.slice(0, limit).map((s) => s.c);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The fragment currently being typed in a multi-recipient field.
 *
 * "a@x.com, bo" is completing "bo", not the whole string. Without this the
 * suggestions go blank the moment a second recipient is added.
 */
export function currentFragment(value, caret = null) {
  const upto = caret === null ? String(value) : String(value).slice(0, caret);
  const start = Math.max(upto.lastIndexOf(','), upto.lastIndexOf(';'));
  return upto.slice(start + 1).trimStart();
}

/** Replace the fragment under the caret with a chosen address. */
export function completeValue(value, address, caret = null) {
  const s = String(value);
  const upto = caret === null ? s : s.slice(0, caret);
  const rest = caret === null ? '' : s.slice(caret);
  const start = Math.max(upto.lastIndexOf(','), upto.lastIndexOf(';'));
  const head = start === -1 ? '' : `${upto.slice(0, start + 1)} `;
  return `${head}${address}, ${rest.trimStart()}`.replace(/,\s*$/, ', ');
}

/** Basic shape check, used to warn before sending rather than to block. */
export function looksLikeAddress(s) {
  return /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(String(s).trim());
}

/** Addresses in a field that do not look like addresses. */
export function invalidAddresses(value) {
  return String(value || '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !looksLikeAddress(parseAddress(s)?.address || s));
}
