/**
 * Sender-aware snippet cleaning.  (Feature 29.)
 *
 * WHY A MODULE AND NOT `m.snippet.slice(0, 100)`
 * ----------------------------------------------
 * Gmail's own snippet is the first ~200 characters of the body with the
 * whitespace collapsed. On personal mail that is fine. On BITS mail it is
 * worthless, because institutional mail is written to a template and the first
 * 200 characters are ALWAYS the same:
 *
 *   "Dear Students, Greetings from AUGSD. This is to inform all the students
 *    of the 2024 batch that..."
 *
 * Every row in the list then shows "Dear Students, Greetings from" and the one
 * line of screen real estate that was supposed to let you decide without
 * opening the message tells you nothing at all. That is why the elimination
 * audit judged this feature to KILL the hover-preview card: fix the row and
 * the popover has nothing left to say.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not summarise, and it does not guess at meaning. It deletes spans
 * that are known to be boilerplate and returns what is left. If everything is
 * boilerplate it returns the empty string, and the caller shows nothing --
 * which is honest, and better than a row that lies.
 *
 * ORDER MATTERS. Quoted-reply stripping runs before salutation stripping,
 * because a forwarded mail's quoted section contains its own salutation and
 * removing the salutation first would leave the quote header behind.
 */

import { C0_CONTROLS, BIDI_CONTROLS } from '../../shared/scrub.js';

/**
 * Salutations. Anchored at the start, and each must be followed by a boundary
 * so that "Dear Students" is stripped but a subject line like
 * "Dearness allowance" is not.
 */
const SALUTATIONS = [
  /^(dear|hi|hello|hey)\s+(all|everyone|students?|sir|ma'?am|team|folks)\b[\s,:!.-]*/i,
  /^(dear|hi|hello|hey)\s+[a-z][a-z.'-]*(\s+[a-z][a-z.'-]*){0,2}\s*[,:]\s*/i,
  /^(dear|hi|hello|hey)\b\s*[,:]\s*/i,
  /^(respected|esteemed)\s+[a-z\s/]{0,30}?[,:]\s*/i,
  /^good\s+(morning|afternoon|evening|day)\b[\s,:!.-]*/i,
];

/**
 * Openers with no content. These are the phrases institutional mail uses to
 * clear its throat, and they are followed by the actual message.
 */
const THROAT_CLEARING = [
  /^greetings(\s+(from|to)\s+[^.!,]{0,40})?[\s,.!:-]*/i,
  /^warm\s+greetings[\s,.!:-]*/i,
  /^this\s+is\s+to\s+(inform|intimate|notify|bring\s+to\s+your\s+notice)\s*(?:all\s+)?(?:the\s+)?(?:students?|you|everyone|all|concerned)?\s*(?:that)?[\s,:-]*/i,
  /^it\s+is\s+(hereby\s+)?(informed|notified|intimated)\s*(that)?[\s,:-]*/i,
  /^(kindly|please)\s+(be\s+informed|note)\s*(that)?[\s,:-]*/i,
  /^you\s+are\s+(hereby\s+)?(informed|requested)\s*(that)?[\s,:-]*/i,
  /^with\s+reference\s+to\s+(the\s+)?(above|trailing\s+mail|below)[\s,.:-]*/i,
  /^i\s+hope\s+(this\s+(mail|email)\s+finds\s+you\s+well|you\s+are\s+doing\s+well)[\s,.!:-]*/i,
  /^on\s+behalf\s+of\s+[^,.]{0,40}[\s,.:-]*/i,
];

/**
 * Trailing junk. Unlike the openers these are matched anywhere and everything
 * from the match onward is discarded, because once a disclaimer starts nothing
 * useful follows it.
 */
const TAIL_MARKERS = [
  /\bthis\s+(e-?mail|message)\s+(and\s+any\s+)?(attachments?\s+)?(is|are|may\s+be)\s+(confidential|intended)/i,
  /\bdisclaimer\s*:/i,
  /\bplease\s+(do\s+not|don'?t)\s+reply\s+to\s+this\s+(e-?mail|message)/i,
  /\bthis\s+is\s+an?\s+(auto|system)[\s-]?generated\s+(e-?mail|message|mail)/i,
  /\bunsubscribe\b/i,
  /\bsent\s+from\s+my\s+(i(phone|pad)|android|mobile|samsung)/i,
  /\bview\s+this\s+email\s+in\s+your\s+browser/i,
  /\byou\s+are\s+receiving\s+this\s+(e-?mail|message)\s+because/i,
];

/**
 * Quoted reply chrome. Everything from here down belongs to an older message.
 *
 * `On <date> <person> wrote:` is the universal form; the others are Outlook's
 * and Gmail's forward headers, which are extremely common on campus because
 * announcements are forwarded rather than resent.
 */
const QUOTE_MARKERS = [
  /\bon\s+\w{3},?\s+\d{1,2}\s+\w{3,9},?\s+\d{4}.{0,80}?\bwrote\s*:/i,
  /\bon\s+.{0,60}?\bwrote\s*:/i,
  /-{2,80}\s*original\s+message\s*-{0,80}/i,
  /-{2,80}\s*forwarded\s+message\s*-{0,80}/i,
  /\bfrom\s*:\s*.{0,80}?\bsent\s*:\s*/i,
  /^>+\s?/m,
];

/** Signature block: a `--` on its own line, per RFC 3676. */
const SIG_DELIM = /(^|\n)\s*--\s*(\n|$)/;

/**
 * Collapse whitespace, entities and zero-width characters.
 *
 * `&nbsp;` and `&#8203;` arrive constantly from HTML mail that has been
 * flattened to a snippet upstream, and left alone they show as literal
 * `&nbsp;` in the row, which looks broken.
 */
function normalise(text) {
  return String(text || '')
    .replace(/&nbsp;?/gi, ' ')
    .replace(/&amp;?/gi, '&')
    .replace(/&#(\d+);/g, (_, d) => {
      const n = Number(d);
      // Only decode the safe, common ones. Decoding arbitrary code points here
      // would be a sanitiser, and this is not the sanitiser.
      return n === 8203 || n === 160 ? ' ' : _;
    })
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    /*
     * CONTROL CHARACTERS AND BIDI OVERRIDES (round 9, M-10/M-11).
     *
     * notify.js's `cardText` has scrubbed these since bug-hunt #50 before
     * handing a subject to an OS notification; the in-app list row never got
     * the same treatment, so `cleanSnippet('a\u0000b\u0007c')` returned the
     * control characters verbatim and `'a\u202Eb'` kept the override.
     *
     * U+202E in a list row reverses the rest of the LINE, so a sender
     * controls how neighbouring text renders — the same spoof the sanitiser
     * closed for link text in round 8, one layer up. Overrides and isolates
     * go; U+200E/U+200F MARKS are left alone, because legitimate Arabic,
     * Hebrew and Urdu mail needs them and they cannot re-order anything.
     *
     * \n and \t survive this line: the whitespace collapse below turns them
     * into spaces, which is the right answer for a single-line row.
     */
    /* One definition, in src/shared/scrub.js (round 10, I-6). The copy that
       used to sit here had already drifted from sanitize.js's in its
       eslint-disable comments, which is how two copies of a security rule
       become two different rules. */
    .replace(C0_CONTROLS, '')
    .replace(BIDI_CONTROLS, '')
    .replace(/\r/g, '');
}

/** Cut at the earliest quote marker, if any. */
function dropQuoted(text) {
  let cut = text.length;
  for (const re of QUOTE_MARKERS) {
    const m = text.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut);
}

/** Cut at the earliest tail marker, if any. */
function dropTail(text) {
  let cut = text.length;
  for (const re of TAIL_MARKERS) {
    const m = text.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut);
}

/**
 * Strip leading boilerplate, repeatedly.
 *
 * Repeatedly because real mail stacks it: "Dear Students, Greetings from
 * AUGSD. This is to inform you that..." is three separate prefixes and
 * stripping one pass leaves two thirds of the noise.
 *
 * WHY THE LOOP IS SAFE WITHOUT A TIGHT ITERATION CAP
 *
 * A fixed six-pass bound was tried first and was wrong: a message opening with
 * a dozen stacked salutations kept six of them, which is a silently
 * half-cleaned row. The loop is instead bounded by PROGRESS -- it exits the
 * moment a pass changes nothing, and every pass that does change something
 * strictly shortens the string. A strictly decreasing non-negative integer
 * terminates. The generous numeric cap is belt-and-braces against a future
 * pattern that could rewrite rather than shorten.
 */
function dropOpeners(text) {
  let out = text;
  for (let pass = 0; pass < 500; pass++) {
    const before = out;
    for (const re of [...SALUTATIONS, ...THROAT_CLEARING]) {
      out = out.replace(re, '');
    }
    out = out.replace(/^[\s,;:.!-]+/, '');
    if (out === before) break;
    if (out.length >= before.length) break; // no progress: bail rather than spin
  }
  return out;
}

/**
 * Clean one snippet.
 *
 * @param {string} raw            the snippet or body text
 * @param {{max?:number}} [opts]  `max` truncates on a word boundary
 * @returns {string} cleaned text, possibly empty
 */
export function cleanSnippet(raw, { max = 140 } = {}) {
  /*
   * BOUND THE WORKING WINDOW BEFORE ANY REGEX TOUCHES IT.
   *
   * Two reasons, one of which was a measured bug.
   *
   * 1. COST. This runs once per row on every render. Gmail's snippet is ~200
   *    characters, but `rowSnippet` is also called with body text, and a body
   *    can be 50KB. Running fifteen patterns over 50KB to produce 140
   *    characters is work thrown away.
   *
   * 2. BACKTRACKING. The forwarded/original-message markers contain `-{2,}`,
   *    and a long run of dashes -- an ASCII separator line, which real mail is
   *    full of -- made the match quadratic. Measured: 500 dashes 10ms, 8000
   *    dashes 267ms. On the render path that is a visible stall, caused by a
   *    message the user cannot see is different.
   *
   * The dash quantifiers are now bounded too, so this cap is defence in depth
   * rather than the only guard. 2000 characters is far more than any
   * boilerplate prefix and leaves plenty of room for the real first sentence.
   */
  const WINDOW = 2000;
  let t = normalise(raw);
  if (t.length > WINDOW) t = t.slice(0, WINDOW);
  if (!t.trim()) return '';

  t = dropQuoted(t);
  const sig = t.match(SIG_DELIM);
  if (sig && sig.index !== undefined) t = t.slice(0, sig.index);
  t = dropTail(t);
  t = dropOpeners(t);

  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return '';

  if (t.length <= max) return t;
  // Truncate on a word boundary so the row never ends mid-word.
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * Would this snippet add anything the subject does not already say?
 *
 * A large share of institutional mail has a body that restates the subject.
 * Rendering both wastes the line and makes the list look repetitive, so the
 * caller can ask first.
 *
 * Compared on word SETS rather than substrings: "Mid-semester exam schedule"
 * vs "The mid semester examination schedule is attached" share enough that the
 * snippet is not worth a line, and neither string contains the other.
 */
export function addsInformation(snippet, subject) {
  const clean = String(snippet || '').trim();
  if (clean.length < 12) return false;

  const words = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3);

  const sub = words(subject);
  const snip = new Set(words(clean));
  if (snip.size === 0) return false;
  if (sub.length === 0) return true;

  /*
   * PREFIX MATCHING, NOT EQUALITY.
   *
   * Exact word matching was tried first and failed on the most common real
   * case: subject "Mid-semester exam schedule", body "The mid semester
   * examination schedule is attached". `exam` and `examination` are the same
   * word to a reader and different strings to a Set, so the snippet scored as
   * novel and consumed a row to say nothing.
   *
   * Four characters is enough to make exam/examination match while keeping
   * register/registration distinct from regard.
   */
  const shares = (w) =>
    sub.some((s) => s === w || (w.length >= 4 && s.length >= 4 && (s.startsWith(w.slice(0, 4)) || w.startsWith(s.slice(0, 4)))));

  let shared = 0;
  for (const w of snip) if (shares(w)) shared++;

  /*
   * 70%, arrived at by running real subject/body pairs rather than by taste.
   * At 80% the "is attached" restatement above still counted as novel; at 60%
   * genuinely new detail was being suppressed.
   */
  return shared / snip.size < 0.7;
}

/**
 * The row-ready snippet: cleaned, and blank when it would be redundant.
 *
 * @param {{snippet?:string, subject?:string}} msg
 * @param {{max?:number}} [opts]
 */
export function rowSnippet(msg, opts) {
  const cleaned = cleanSnippet(msg?.snippet, opts);
  return addsInformation(cleaned, msg?.subject) ? cleaned : '';
}
