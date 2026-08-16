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

/**
 * The bare address out of a `Name <addr>` header, lowercased.
 *
 * THE SINGLE DEFINITION. This exact three-line function was duplicated
 * verbatim in main.js (`addressOf`), rules.js (`addressOf`) and query.js
 * (`addr`) — three copies of one domain rule, each free to drift.
 *
 * It is deliberately LENIENT: it never returns null, and it does not require
 * an `@`. That matters because its callers use it as a grouping key (which
 * sender did this come from?) where a null would silently drop a rule or a
 * correction. `parseAddress` below is the STRICT counterpart used when we
 * need to know whether something is a usable mailbox — the two disagree on
 * most adversarial inputs, so they are separate functions on purpose rather
 * than one function with a flag. (The original header counted their
 * disagreements; fuzz round 3 changed both parsers and retired the count
 * rather than re-litigate it on every future fix.)
 */
export function addressOf(from) {
  /*
   * [^<>] not [^>] (fuzz round 3, 2026-08-14, defect #12): `[^>]+` scans to
   * the next '>' for EVERY '<' in the string, so a hostile From header of
   * 20k '<' characters cost ~230ms at ingest -- once per message, on the
   * main thread. A bracket body may not contain a bracket; the only
   * divergence is the malformed '<<a>>' shape, which now yields 'a'
   * instead of '<a' -- both are stable garbage grouping keys, and this
   * function's own header documents it as lenient-by-design.
   */
  const m = /<([^<>]+)>/.exec(String(from || ''));
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

/**
 * The same address, reduced to the MAILBOX IT ACTUALLY REACHES.
 *
 * Gmail delivers `me+anything@domain` to `me@domain` — plus-addressing is a
 * first-class feature and students use it constantly (`me+jobs@`, `me+bits@`)
 * precisely so they can filter on it. Comparing the raw strings makes the
 * user a stranger to their own mail: measured, `audienceOf` scored a message
 * addressed to `me+bits@…` as `broadcast` while the identical message to
 * `me@…` scored `direct`, so mail a human sent the user personally landed in
 * the bulk lane nobody reads carefully (round 8, H-1).
 *
 * DELIBERATELY SEPARATE FROM addressOf. That one is the lenient GROUPING key
 * — "which sender is this from?" — and rules, corrections and contact
 * suggestions are all keyed on its exact output. Folding tags there would
 * silently merge `shop+a@` and `shop+b@` into one rule target, which is the
 * opposite of what a user tagging their mail asked for. This function answers
 * a different question — "is this the same MAILBOX as me?" — and is used only
 * where identity is being compared.
 *
 * Dots are NOT folded. Gmail ignores them for @gmail.com only; on every other
 * domain (including pilani.bits-pilani.ac.in, this product's whole audience)
 * `m.e@` and `me@` are different people, and merging them would be a
 * misdelivery rather than a convenience.
 *
 * @param {string} from  a raw header value or a bare address
 * @returns {string} the canonical mailbox, lowercased
 */
export function mailboxOf(from) {
  const addr = addressOf(from);
  const at = addr.lastIndexOf('@');
  if (at <= 0) return addr;
  const local = addr.slice(0, at);
  const domain = addr.slice(at);
  const plus = local.indexOf('+');
  // A leading '+' is not a tag separator, it is the whole local part; keep it.
  return plus > 0 ? local.slice(0, plus) + domain : addr;
}

/** Parse one address out of a `Name <addr>` header. */
export function parseAddress(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  /*
   * The angle form, rewritten linear (fuzz round 3, defect #12). The old
   * `/^(.*?)\s*<([^>]+)>\s*$/` backtracked the lazy prefix against every
   * candidate '<', which cost ~500ms on 20k of nothing but '<'. The
   * equivalent reads, in order, with the same edge semantics:
   *   - the matched '>' must be the LAST '>' (only whitespace may follow),
   *   - the matched '<' is the EARLIEST one after the second-to-last '>',
   *   - the name is everything before it, minus the whitespace gap,
   *   - the old `.` could not span line terminators, so a name containing
   *     one disqualifies the angle form entirely (quirk preserved).
   */
  const gt = s.lastIndexOf('>');
  if (gt !== -1 && /^\s*$/.test(s.slice(gt + 1))) {
    const gt2 = s.lastIndexOf('>', gt - 1);
    for (let p = s.indexOf('<', gt2 + 1); p !== -1 && p < gt; p = s.indexOf('<', p + 1)) {
      if (p + 1 === gt) continue; // `[^>]+` needs at least one char
      const nameRaw = s.slice(0, p).replace(/\s+$/, '');
      if (/[\n\r\u2028\u2029]/.test(nameRaw)) break; // `.` never crossed these
      const name = nameRaw.trim().replace(/^["']|["']$/g, '');
      const address = s.slice(p + 1, gt).trim().toLowerCase();
      if (address.includes('@')) return { name, address };
      /*
       * The old regex returned null here rather than falling through to the
       * bare-address branch (`return address.includes('@') ? ... : null`),
       * so an angle form with an address-less body vetoes the string.
       */
      return null;
    }
  }

  /*
   * The RFC 5322 comment form `addr (Name)` (fuzz round 3, defect #15):
   * Gmail accepts it, the old fallback swallowed it WHOLE as the address
   * (spaces and parens included), and invalidAddresses then cried wolf
   * before every send to a perfectly legal recipient. Recognise a single
   * trailing comment as the display name.
   */
  const comment = /^([^\s()<>]+@[^\s()<>]+)\s*\(([^()]*)\)\s*$/.exec(s);
  if (comment) {
    return { name: comment[2].trim(), address: comment[1].toLowerCase() };
  }

  return s.includes('@') ? { name: '', address: s.toLowerCase() } : null;
}

/** Split a To/Cc header, which may hold several comma-separated addresses. */
export function parseAddressList(raw) {
  const out = [];
  const s = String(raw || '');
  /*
   * Same split as the old `/,(?![^<]*>)/`, made linear (fuzz round 3,
   * defect #12): the lookahead re-scanned to the next '>' for EVERY comma,
   * so 'a@b.c,' x10000 cost ~535ms. The semantics, restated: a comma is a
   * separator unless the NEXT angle bracket after it is a '>'. One pass to
   * index the brackets (there are usually none), one pass over the commas.
   */
  const brackets = [];
  for (let i = s.indexOf('<'); i !== -1; i = s.indexOf('<', i + 1)) brackets.push(i);
  for (let i = s.indexOf('>'); i !== -1; i = s.indexOf('>', i + 1)) brackets.push(i);
  brackets.sort((a, b) => a - b);

  let start = 0;
  let bi = 0;
  for (let c = s.indexOf(','); c !== -1; c = s.indexOf(',', c + 1)) {
    while (bi < brackets.length && brackets[bi] < c) bi++;
    const nextBr = bi < brackets.length ? s[brackets[bi]] : '';
    if (nextBr === '>') continue; // inside an angle bracket: not a separator
    const a = parseAddress(s.slice(start, c));
    if (a) out.push(a);
    start = c + 1;
  }
  const last = parseAddress(s.slice(start));
  if (last) out.push(last);
  return out;
}

/**
 * Build a ranked contact book from the messages we hold.
 *
 * @param {Iterable<{from?:string,to?:string,date?:number}>} messages
 * @param {{selfAddress?:string}} opts
 */
export function buildContacts(messages, opts = {}) {
  /*
   * SELF-EXCLUSION FOLDS THE PLUS TAG (round 11, B5).
   *
   * The comparison was `address === self` on the raw string, so every
   * plus-addressed form of the user's OWN mailbox survived it:
   * `me+tag@x.z` was offered in their own recipient autocomplete, and
   * because a tag is how people file mail, the variants accumulate — the
   * user ends up autocompleting three versions of themselves.
   *
   * `mailboxOf` is the function this codebase already added for exactly
   * this question (round 8, H-1): it strips `+tag` and answers "is this the
   * same mailbox", which is what self-exclusion actually means. Comparing
   * the folded forms costs nothing and closes the whole family at once.
   */
  const self = mailboxOf(opts.selfAddress || '');
  /** @type {Map<string,{address:string,name:string,count:number,last:number}>} */
  const map = new Map();

  const note = (parsed, date) => {
    if (!parsed) return;
    const { address, name } = parsed;
    if (!address || (self && mailboxOf(address) === self)) return;
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
