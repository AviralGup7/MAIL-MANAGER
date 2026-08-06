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

import { DAY_MS } from './deadlines.js';
import { addressOf as addr } from './contacts.js';

// Imported rather than redeclared. Two modules each defining their own
// DAY_MS is legal under ES modules but is duplicated truth, and it broke the
// preview bundler, which flattens scopes -- a real signal that the constant
// wanted one owner.

/**
 * Split a query into tokens, respecting quotes.
 * `from:a "b c" -is:read` -> ['from:a', '"b c"', '-is:read']
 */
function tokenize(q) {
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
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]); // day-first: this is an Indian tool
  return null;
}

/** `7d`, `2w`, `3m` -> milliseconds. */
function parseSpan(v) {
  const m = v.match(/^(\d+)\s*([dwmy])$/);
  if (!m) return null;
  const n = Number(m[1]);
  return { d: n * DAY_MS, w: n * 7 * DAY_MS, m: n * 30 * DAY_MS, y: n * 365 * DAY_MS }[m[2]];
}

/**
 * Parse a query string.
 *
 * @returns {{terms:string[], predicate:(msg:object)=>boolean, isEmpty:boolean,
 *   operators:Array<{key:string,value:string,negated:boolean}>}}
 *   `terms` is the free text for the inverted index; `predicate` applies
 *   everything the index cannot express.
 */
export function parseQuery(q, now = Date.now()) {
  const tokens = tokenize(String(q || '').trim());
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
      } else {
        terms.push(unquoted);
      }
      continue;
    }

    const key = body.slice(0, colon).toLowerCase();
    const value = body.slice(colon + 1).replace(/^"|"$/g, '').toLowerCase();
    if (!value) continue;

    const check = buildCheck(key, value, now);
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

function buildCheck(key, value, now) {
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
    case 'label':
      return (m) => (m.category || '').toLowerCase() === value;
    case 'is':
      switch (value) {
        case 'unread': return (m) => !!m.unread;
        case 'read': return (m) => !m.unread;
        case 'starred': return (m) => !!m.starred;
        case 'unstarred': return (m) => !m.starred;
        case 'due': return (m) => typeof m.dueAt === 'number';
        case 'overdue': return (m) => typeof m.dueAt === 'number' && m.dueAt < now;
        case 'important': return (m) => (m.confidence ?? 0) >= 0.9;
        default: return null;
      }
    case 'has':
      switch (value) {
        case 'attachment': return (m) => !!m.hasAttachment;
        case 'deadline': return (m) => typeof m.dueAt === 'number';
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
      const span = parseSpan(value);
      return span === null ? null : (m) => m.date < now - span;
    }
    case 'newer_than': {
      const span = parseSpan(value);
      return span === null ? null : (m) => m.date >= now - span;
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
function splitAddrs(v) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of String(v || '')) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
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
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n');
}
