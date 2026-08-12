/**
 * Search query parser.
 *
 * Gmail's operators are muscle memory for anyone who uses mail seriously, so a
 * replacement that only does substring matching feels like a downgrade no
 * matter how fast it is. This supports the operators people actually type:
 *
 *   from:augsd            sender contains
 *   to:me                 recipient (we only store our own mailbox, so `me`)
 *   subject:registration  subject only
 *   category:ps           our BITS categories, which Gmail cannot do
 *   label:Thesis          a real Gmail label, including nested Parent/Child
 *   is:unread is:read is:starred is:due is:overdue
 *   has:attachment has:deadline
 *   before:2025-11-20  after:2025-11-01  older_than:7d  newer_than:2d
 *   -from:noreply         negation of any term
 *   "exact phrase"        quoted
 *
 * Everything else is free text, matched against the existing inverted index.
 *
 * DESIGN: parse to a PREDICATE, not to a filtered list. The store owns the
 * indexes and does the fast token lookup; this only narrows what the index
 * returns. Keeping the two separate means the parser never needs to know how
 * the store is implemented, and the store never needs to know about operators.
 */

import { parseAddressList } from './contacts.js';
import { DAY_MS } from './deadlines.js';
import { addressOf as addr } from './contacts.js';

// Imported rather than redeclared. Two modules each defining their own
// DAY_MS is legal under ES modules but is duplicated truth, and it broke the
// preview bundler, which flattens scopes -- a real signal that the constant
// wanted one owner.

/**
 * Split a query into tokens, respecting quotes.
 * `from:a "b c" -is:read` -> ['from:a', '"b c"', '-is:read']
 *
 * Exported (round 65/e): the search chips reuse this same splitter because
 * they EDIT the string the parser reads — two quote-aware lexers would be
 * two truths about where one token ends.
 */
export function tokenize(q) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of q) {
    if (ch === '"') {
      quoted = !quoted;
      cur += ch;
      continue;
    }
    if (ch === ' ' && !quoted) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** `2025-11-20`, `20/11/2025`, `20 Nov 2025` -> ms, or null. */
function parseDate(v) {
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return checkedDate(+m[1], +m[2], +m[3]);
  m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  // day-first: this is an Indian tool
  if (m) return checkedDate(+m[3], +m[2], +m[1]);
  return null;
}

/**
 * Assemble ONLY real dates (bug-hunt #8). Date.UTC silently normalises
 * out-of-range fields -- `32/13/2025` became 1 Feb 2026, and a pasted
 * US-style `11/20/2025` read as 11 Aug 2026 -- so before:/after: filtered
 * on dates nobody ever wrote. An impossible date is no date: null.
 */
function checkedDate(y, month, day) {
  if (month < 1 || month > 12) return null;
  const last = new Date(Date.UTC(y, month, 0)).getUTCDate(); // days in month
  if (day < 1 || day > last) return null;
  return Date.UTC(y, month - 1, day);
}

/**
 * Cutoff timestamp for `older_than` / `newer_than` at time `now`, or null.
 *
 * `d`, `w`, `y` are fixed spans. `m` is a CALENDAR month, matching Gmail
 * (V2 P2-18): `older_than:1m` on 11 March means "before 11 February", not
 * "before 9 February" (30 days). Month-end days clamp to the target month's
 * end (31 Jan - 1m = 28/29 Feb) instead of overflowing into the next month
 * the way a naive setMonth does.
 */
function spanCutoff(v, now) {
  const m = String(v).match(/^(\d+)\s*([dwmy])$/);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'd': return now - n * DAY_MS;
    case 'w': return now - n * 7 * DAY_MS;
    case 'y': return now - n * 365 * DAY_MS;
    case 'm': {
      const d = new Date(now);
      const day = d.getDate();
      d.setDate(1); // shield the month arithmetic from day overflow
      d.setMonth(d.getMonth() - n);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, last));
      return d.getTime();
    }
    default: return null;
  }
}

/**
 * Parse a query string.
 *
 * @returns {{terms:string[], predicate:(msg:object)=>boolean, isEmpty:boolean,
 *   operators:Array<{key:string,value:string,negated:boolean}>}}
 *   `terms` is the free text for the inverted index; `predicate` applies
 *   everything the index cannot express.
 */
export function parseQuery(q, now = Date.now(), ctx = {}) {
  const tokens = tokenize(String(q || '').trim());

  /*
   * OR AND PARENTHESES.  (Feature 48.)
   *
   * The elimination audit called this the AUTOMATION LANGUAGE rather than a
   * search feature, and that is the right way to read it: rules, smart views
   * and bulk-by-rule all express or fail to express their condition based on
   * whether this exists. Implicit AND cannot say "everything academic except
   * the timetable bot", which is the shape of nearly every real filter.
   *
   * Handled here, ahead of the flat token loop, so the common case -- a query
   * with no OR in it -- walks exactly the same code path it always did and
   * pays nothing for a feature it is not using.
   */
  if (hasGrouping(tokens)) return parseGrouped(tokens, now, ctx);

  return compileFlat(tokens, now, {}, ctx);
}

/** Cheap pre-check: is there anything the flat parser cannot handle? */
function hasGrouping(tokens) {
  return tokens.some((t) => /^(or|\|\|)$/i.test(t) || (!t.startsWith('"') && /[()]/.test(t)));
}

/**
 * Split parentheses off tokens so the parser sees them as their own symbols.
 *
 * `tokenize` is quote-aware but not paren-aware, so `(category:clubs` arrives
 * as one token. Quoted tokens are passed through untouched -- a literal
 * bracket inside `"..."` is text the user typed, not structure.
 */
function explode(tokens) {
  const out = [];
  for (const t of tokens) {
    if (t.startsWith('"')) { out.push(t); continue; }
    let body = t;
    // A leading `-(` negates the whole group.
    while (body.startsWith('(') || body.startsWith('-(')) {
      if (body.startsWith('-(')) { out.push('-('); body = body.slice(2); }
      else { out.push('('); body = body.slice(1); }
    }
    const trail = [];
    while (body.endsWith(')')) { trail.push(')'); body = body.slice(0, -1); }
    if (body) out.push(body);
    out.push(...trail);
  }
  return out;
}

/**
 * Recursive-descent parser for grouped queries.
 *
 *   expr   := and ( OR and )*
 *   and    := factor+                  implicit AND, as before
 *   factor := '(' expr ')' | '-(' expr ')' | atom
 *
 * A FLAT SPLIT ON `OR` WAS TRIED FIRST AND WAS WRONG. It ignored nesting, so
 * `(category:clubs OR category:events) is:unread` put the literal word "OR"
 * into the term list and ANDed the two categories -- a query that can never
 * match anything, returned silently as if it were fine. Caught by running it,
 * not by reading it. The lesson is the usual one: a parser that does not track
 * depth is not a parser.
 *
 * WHY THE FREE TEXT STOPS USING THE INVERTED INDEX HERE
 *
 * `terms` is handed to the store, which INTERSECTS postings lists -- an AND.
 * Under an OR that is the wrong operation and there is no honest way to
 * express `(a OR b)` through an interface that only intersects. So a grouped
 * query returns no terms and folds its free text into the predicate: the store
 * yields everything, the predicate narrows it. Bounded by MAX_MESSAGES = 2000,
 * paid only by queries that actually contain an OR.
 */
function parseGrouped(tokens, now, ctx = {}) {
  const toks = explode(tokens);
  let i = 0;
  const operators = [];

  const peek = () => toks[i];
  const isOr = (t) => /^(or|\|\|)$/i.test(t || '');

  /** @returns {(m:object)=>boolean} */
  function parseExpr(depth) {
    const alts = [parseAnd(depth)];
    while (isOr(peek())) {
      i++;
      alts.push(parseAnd(depth));
    }
    return alts.length === 1 ? alts[0] : (m) => alts.some((p) => p(m));
  }

  function parseAnd(depth) {
    const parts = [];
    while (i < toks.length && !isOr(peek()) && peek() !== ')') {
      const p = parseFactor(depth);
      if (p) parts.push(p);
    }
    if (parts.length === 0) return () => true;
    return parts.length === 1 ? parts[0] : (m) => parts.every((p) => p(m));
  }

  function parseFactor(depth) {
    const t = toks[i];
    if (t === '(' || t === '-(') {
      i++;
      // Bounded recursion. Deeply nested input is more likely a typo than a
      // query, and a stack overflow in the search box is not an error message.
      const inner = depth > 12 ? (() => { i++; return () => true; })() : parseExpr(depth + 1);
      if (peek() === ')') i++;
      return t === '-(' ? (m) => !inner(m) : inner;
    }
    if (t === ')') { i++; return null; }
    i++;
    const one = compileFlat([t], now, { textAsPredicate: true }, ctx);
    operators.push(...one.operators);
    return one.predicate || (() => true);
  }

  const predicate = parseExpr(0);
  return {
    terms: [],
    operators,
    isEmpty: toks.length === 0,
    predicate: toks.length === 0 ? null : predicate,
    grouped: true,
  };
}

/**
 * The original flat, implicit-AND parser.
 *
 * @param {string[]} tokens
 * @param {number} now
 * @param {{textAsPredicate?:boolean}} [opts] when set, free text becomes a
 *   predicate instead of an index term -- required under an OR, see above.
 */
function compileFlat(tokens, now, { textAsPredicate = false } = {}, ctx = {}) {
  /** @type {Array<(m:object)=>boolean>} */
  const checks = [];
  const terms = [];
  const operators = [];

  for (const raw of tokens) {
    const negated = raw.startsWith('-');
    const body = negated ? raw.slice(1) : raw;
    const colon = body.indexOf(':');

    if (colon <= 0) {
      // Free text. Quotes mean an exact phrase, which the index cannot do, so
      // it becomes a predicate as well as a term.
      const unquoted = body.replace(/^"|"$/g, '');
      if (!unquoted) continue;
      if (body.startsWith('"') && body.length > 1) {
        const needle = unquoted.toLowerCase();
        checks.push((m) =>
          negated !== `${m.subject} ${m.from} ${m.snippet}`.toLowerCase().includes(needle)
        );
      } else if (negated) {
        const needle = unquoted.toLowerCase();
        checks.push((m) => !`${m.subject} ${m.from} ${m.snippet}`.toLowerCase().includes(needle));
      } else if (textAsPredicate) {
        const needle = unquoted.toLowerCase();
        checks.push((m) => `${m.subject} ${m.from} ${m.snippet}`.toLowerCase().includes(needle));
      } else {
        terms.push(unquoted);
      }
      continue;
    }

    const key = body.slice(0, colon).toLowerCase();
    const value = body.slice(colon + 1).replace(/^"|"$/g, '').toLowerCase();
    if (!value) continue;

    const check = buildCheck(key, value, now, ctx);
    if (!check) {
      // Unknown operator: treat the whole token as free text rather than
      // silently dropping it. Dropping is how a search quietly returns the
      // wrong set and the user never learns why.
      terms.push(body);
      continue;
    }
    operators.push({ key, value, negated });
    checks.push(negated ? (m) => !check(m) : check);
  }

  return {
    terms,
    operators,
    isEmpty: terms.length === 0 && checks.length === 0,
    predicate: checks.length === 0 ? null : (m) => checks.every((c) => c(m)),
  };
}

function buildCheck(key, value, now, ctx = {}) {
  switch (key) {
    case 'from':
      return (m) => (m.from || '').toLowerCase().includes(value);
    case 'to':
      // We only ever hold the signed-in mailbox, so `to:me` is a tautology and
      // anything else cannot be answered from stored headers. Honest: match
      // everything for `me`, nothing otherwise, rather than pretend.
      return value === 'me' ? () => true : () => false;
    case 'subject':
      return (m) => (m.subject || '').toLowerCase().includes(value);
    case 'category':
      return (m) => (m.category || '').toLowerCase() === value;

    /*
     * `label:` MEANS A GMAIL LABEL, NOT ONE OF OUR CATEGORIES.
     *
     * This used to be a bare alias of `category:`, which quietly answered a
     * different question than the one asked. Someone with a Gmail label called
     * "Thesis" typed `label:thesis`, got zero results, and had no way to tell
     * whether that meant "no matches" or "not supported".
     *
     * Messages carry `labels` -- the raw labelIds from the API -- so this can
     * be answered honestly. Gmail's own label ids are SCREAMING_CASE
     * (INBOX, STARRED, CATEGORY_PROMOTIONS) while user labels keep their
     * display name, so both `label:inbox` and `label:Thesis` work if we
     * compare case-insensitively.
     *
     * Nested labels are `Parent/Child` in the API. Matching the trailing
     * segment too means `label:child` finds it, which is what people expect
     * and what Gmail itself does not do -- a small, defensible improvement.
     */
    case 'label':
      return (m) => (m.labels || []).some((l) => {
        const name = String(l).toLowerCase();
        return name === value || name.endsWith(`/${value}`);
      });
    case 'is':
      switch (value) {
        case 'unread': return (m) => !!m.unread;
        case 'read': return (m) => !m.unread;
        case 'starred': return (m) => !!m.starred;
        case 'unstarred': return (m) => !m.starred;
        // Canonical deadline reads (cross-audit B-03): the override-aware
        // accessor when the caller has one, never raw `m.dueAt` alone.
        case 'due': return (m) => Number.isFinite(ctx.dueAtOf ? ctx.dueAtOf(m) : m.dueAt);
        case 'overdue': return (m) => {
          const at = ctx.dueAtOf ? ctx.dueAtOf(m) : m.dueAt;
          return Number.isFinite(at) && at < now;
        };
        case 'important': return (m) => (m.confidence ?? 0) >= 0.9;

        /*
         * `is:direct` -- addressed to me personally rather than to an
         * audience. Feature 32.
         *
         * WHY THE SELF ADDRESS IS READ OFF THE MESSAGE AND NOT PASSED IN
         *
         * `buildCheck` has no access to the signed-in identity and threading
         * one through would change the signature of every operator for the
         * benefit of one. The ingest path already knows who we are, so it
         * stamps `audience` onto the record once, at the point where the
         * information is free. This operator reads that stamp.
         *
         * A record without the stamp -- anything ingested before this shipped,
         * or by a path that does not classify -- is treated as DIRECT. Same
         * asymmetry as direct.js itself: never hide mail because a field is
         * missing.
         */
        case 'direct': return (m) => m.audience !== 'broadcast';
        case 'broadcast': return (m) => m.audience === 'broadcast';
        default: return null;
      }
    case 'has':
      switch (value) {
        case 'attachment': return (m) => !!m.hasAttachment;
        case 'deadline': return (m) => Number.isFinite(ctx.dueAtOf ? ctx.dueAtOf(m) : m.dueAt);
        default: return null;
      }
    case 'before': {
      const t = parseDate(value);
      return t === null ? null : (m) => m.date < t;
    }
    case 'after': {
      const t = parseDate(value);
      return t === null ? null : (m) => m.date >= t;
    }
    case 'older_than': {
      const t = spanCutoff(value, now);
      return t === null ? null : (m) => m.date < t;
    }
    case 'newer_than': {
      const t = spanCutoff(value, now);
      return t === null ? null : (m) => m.date >= t;
    }
    default:
      return null;
  }
}

/** Human summary of what a query is doing, shown under the search box. */
export function describeQuery(parsed) {
  const bits = [];
  for (const o of parsed.operators) {
    bits.push(`${o.negated ? 'not ' : ''}${o.key}:${o.value}`);
  }
  if (parsed.terms.length) bits.push(`text "${parsed.terms.join(' ')}"`);
  return bits.join(' · ');
}

// ============================================================================
// REPLY / FORWARD SCAFFOLDING
// ============================================================================

/** Pull the bare address out of a header value. */
// `addr` is contacts.js's addressOf, imported above — one definition.

/** Split a comma-separated address header, respecting quoted display names. */
/*
 * ONE address-list parser (cross-audit B-05). contacts.parseAddressList is
 * the RFC-aware canonical (quotes + angle brackets); reply-all reconstruction
 * keeps the display name so recipients stay human-readable.
 */
function splitAddrs(v) {
  return parseAddressList(v).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address));
}

/**
 * Build the pre-filled fields for a reply.
 *
 * @param {object} body    the GET_BODY payload (carries the real headers)
 * @param {string} selfEmail the signed-in address, excluded from reply-all
 * @param {'reply'|'replyAll'|'forward'} mode
 */
export function buildReply(body, selfEmail, mode = 'reply') {
  const self = (selfEmail || '').toLowerCase();
  // Reply-To wins over From. Mailing lists and no-reply senders rely on this,
  // and ignoring it sends the reply somewhere nobody reads.
  const target = body.replyTo || body.from || '';

  const subjectRaw = body.subject || '';
  const prefix = mode === 'forward' ? 'Fwd: ' : 'Re: ';
  // Do not stack prefixes: "Re: Re: Re:" is the mark of a broken client.
  const stripped = subjectRaw.replace(/^\s*((re|fwd|fw)\s*:\s*)+/i, '');
  const subject = prefix + stripped;

  let to = '';
  let cc = '';
  if (mode === 'reply') {
    to = target;
  } else if (mode === 'replyAll') {
    to = target;
    // Everyone on To and Cc, minus ourselves and minus the person we are
    // already replying to. Duplicating them is a common and irritating bug.
    const seen = new Set([addr(target), self].filter(Boolean));
    const others = [];
    for (const a of [...splitAddrs(body.to), ...splitAddrs(body.cc)]) {
      const bare = addr(a);
      if (!bare || seen.has(bare)) continue;
      seen.add(bare);
      others.push(a);
    }
    cc = others.join(', ');
  }

  return {
    to,
    cc,
    subject,
    threadId: mode === 'forward' ? '' : body.threadId || '',
    inReplyTo: mode === 'forward' ? '' : body.messageId || '',
    // RFC 5322: References is the chain, with the parent appended.
    references:
      mode === 'forward'
        ? ''
        : [body.references, body.messageId].filter(Boolean).join(' ').trim(),
    quoted: quoteBody(body, mode),
  };
}

/** The `> ` quoted original, as every mail client has done since 1985. */
function quoteBody(body, mode) {
  const text = (body.text || stripTags(body.html || '')).trim();
  if (!text) return '';
  /*
   * The attribution line.
   *
   * "On <sender> wrote:" was missing the date, which is half of what an
   * attribution is for -- the recipient of a long thread needs to know WHEN
   * the quoted part was said, not only by whom. Every mail client since 1985
   * includes it, and its absence is one of those details that reads as
   * amateur without the reader being able to say why.
   */
  const when = body.date
    ? new Date(body.date).toLocaleString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    })
    : '';
  const head =
    mode === 'forward'
      ? `\n\n---------- Forwarded message ----------\nFrom: ${body.from}\n${
        when ? `Date: ${when}\n` : ''
      }Subject: ${body.subject}\nTo: ${body.to || ''}\n\n`
      : `\n\n${when ? `On ${when}, ` : 'On '}${body.from} wrote:\n`;
  const quoted = text
    .split('\n')
    .slice(0, 200) // a 5000-line newsletter must not become the reply
    .map((l) => (mode === 'forward' ? l : `> ${l}`))
    .join('\n');
  return head + quoted;
}

function stripTags(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    // &amp; LAST (bug-hunt 44 #1): the same double-decode that was fixed in
    // gmail.js's decodeEntities survived here. Decoding &amp; first turns a
    // literal "&amp;lt;" into "&lt;" and then into "<" -- one decode pass
    // must mean one decode, so reply quotes stopped surfacing stray tags.
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n');
}
