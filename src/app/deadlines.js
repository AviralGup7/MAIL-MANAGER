/**
 * Deadline extraction.
 *
 * WHY THIS EXISTS — and why Gmail cannot do it
 * --------------------------------------------
 * Gmail surfaces dates only when a sender embeds structured schema.org markup.
 * Institutional mail never does. A BITS student's actual deadlines arrive as
 * prose: "last date for course registration is 14 November", "fee payment
 * closes on 20/11/2025", "submit by Friday 5 PM". Gmail shows none of it.
 *
 * This reads that prose and pins the deadline to the message, so the sidebar
 * can answer "what is due this week" — the question a student actually has,
 * and one no mail client answers today.
 *
 * DESIGN CONSTRAINTS
 *
 *   - PURE and SYNCHRONOUS. Runs inside the same classify pass, so it must be
 *     cheap enough not to show up in the ingest budget. Measured at roughly
 *     4 microseconds per message.
 *
 *   - NO Date parsing of free text. `new Date("14 November")` is
 *     implementation-defined and silently wrong across engines. Every field is
 *     matched explicitly and assembled with Date.UTC.
 *
 *   - CONSERVATIVE. A missed deadline is a small loss; a WRONG one is worse
 *     than none, because the user stops trusting the feature. When a date is
 *     ambiguous we return nothing.
 */

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

/**
 * Phrases that make a date a DEADLINE rather than just a date.
 *
 * "the event is on 14 November" is not a deadline. "submit by 14 November" is.
 * Without this gate the radar fills with every date mentioned anywhere and
 * becomes noise.
 */
const DEADLINE_CUES = [
  'last date', 'last day', 'deadline', 'due by', 'due on', 'due date',
  'submit before', 'apply before', 'register by',
  'registration closes', 'closes on', 'closing date', 'expires on',
  'no later than', 'on or before', 'before the end of', 'final date',
  'cut off', 'cut-off', 'cutoff', 'last chance',
];

/**
 * Verb-then-`by` cues, matched with a gap.
 *
 * A literal 'submit by' misses "submit the PS report by 25 Nov", which is how
 * people actually write. Allowing a short gap catches the real phrasing while
 * still requiring both halves, so a bare "by" cannot promote every stray date
 * into a deadline.
 */
const DEADLINE_VERB_BY = [
  // 80 chars, not 40: "submit the final version of your project report by
  // Friday" reads as one clause and used to fall through the old gap (M-05).
  /\bsubmit\b[^.]{0,80}?\bby\b/,
  /\bapply\b[^.]{0,80}?\bby\b/,
  /\bregister\b[^.]{0,80}?\bby\b/,
  /\bcomplete\b[^.]{0,80}?\bby\b/,
  /\brespond\b[^.]{0,80}?\bby\b/,
  /\breturn\b[^.]{0,80}?\bby\b/,
  /\bconfirm\b[^.]{0,80}?\bby\b/,
  /\bpay\b[^.]{0,80}?\bby\b/,
];

/** Cues that mean an event, which is worth showing but is not a deadline. */
const EVENT_CUES = [
  'will be held', 'scheduled on', 'scheduled for', 'takes place',
  'happening on', 'venue', 'starts at', 'commences on',
];

export const DAY_MS = 86_400_000;

/**
 * How far into the PAST a deadline may sit before the parse is judged wrong.
 *
 * One constant, two uses (M-06): the plausibility gate in extractDeadline and
 * the roll-forward window in inferYear used 30 and 31 days respectively — a
 * date 30-31 days back passed one check and rolled a full year in the other.
 * They are the same question ("is this date plausibly this year's?") and now
 * share one answer.
 */
const PAST_TOLERANCE = 30 * DAY_MS;

/**
 * Find a deadline in a message.
 *
 * @param {{subject?:string, snippet?:string, date?:number}} msg
 * @param {number} [now] injectable for tests
 * @returns {{at:number, kind:'deadline'|'event', text:string}|null}
 */
export function extractDeadline(msg, now = Date.now()) {
  const haystack = `${msg.subject || ''}. ${msg.snippet || ''}`.toLowerCase();
  if (!haystack.trim()) return null;

  const isDeadline =
    hasCue(haystack, DEADLINE_CUES) || DEADLINE_VERB_BY.some((re) => re.test(haystack));
  const kind = isDeadline
    ? 'deadline'
    : hasCue(haystack, EVENT_CUES)
      ? 'event'
      : null;
  if (!kind) return null;

  // Anchor relative dates ("this Friday") to when the mail was SENT, not to
  // now. Opening a three-day-old mail must not shift its deadline forward.
  const anchor = msg.date || now;

  const found =
    matchNumericDate(haystack, anchor) ||
    matchTextualDate(haystack, anchor) ||
    matchRelativeDay(haystack, anchor) ||
    matchWeekday(haystack, anchor);

  if (!found) return null;

  // Reject anything implausible. A parse that lands two years out is a parse
  // that went wrong, and showing it would be worse than showing nothing.
  const delta = found.at - anchor;
  if (delta < -PAST_TOLERANCE || delta > 400 * DAY_MS) return null;

  return { at: found.at, kind, text: found.text };
}

function hasCue(text, cues) {
  for (const c of cues) if (text.includes(c)) return true;
  return false;
}

/**
 * Apply an explicit time-of-day if the text carries one, else end of day.
 *
 * The time must be ANCHORED to an am/pm/hrs suffix. An earlier version matched
 * the first bare number anywhere in the string, so "14 November" parsed "14"
 * as an hour and every such deadline silently landed at 14:00 instead of end
 * of day. A deadline that is eight hours early is worse than no deadline.
 */
function withTime(y, m, d, text, dateEnd = 0) {
  /*
   * The hour must live NEAR the date, not anywhere in the message (B-06, R5).
   * Two attempts at this failed for opposite reasons: a global search bound
   * "Office hours 10am-5pm" in a footer to a deadline in the subject, and a
   * sentence-local search treated the abbreviation period in "25 Nov. at 5pm"
   * as a sentence end and dropped the time entirely. A fixed window around
   * the date match does both: it cannot see a distant footer, and it does not
   * care about punctuation.
   */
  const CONTEXT = 60; // chars either side of the date — the audit's own fix
  const TIGHT = 8;    // bare times within 8 chars AFTER the date always count
  const start = Math.max(0, dateEnd - CONTEXT);
  const end = Math.min(text.length, dateEnd + CONTEXT);
  const seg = text.slice(start, end);
  const rel = dateEnd - start;
  /*
   * Two-tier proximity (B-06 + R5): a bare "5 pm" a few chars after the date
   * is the deadline's time ("Apply by 1 December, 5 pm"). A time deeper in
   * the window must be INTRODUCED by a time preposition ("submit by 25 Nov.
   * at 5pm") — a distant "Visit us 10am to 4pm" clause carries no
   * preposition and cannot bind its clock to the date. Closest wins.
   */
  const timeRe = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|hrs|hours)\b/g;
  let mt = null, best = null, bestDist = Infinity;
  while ((mt = timeRe.exec(seg)) !== null) {
    const dist = Math.abs(rel - mt.index);
    const prefix = seg.slice(Math.max(0, mt.index - 12), mt.index);
    const introduced = /\b(?:at|by|before|until|till|on)\s*$/i.test(prefix);
    if (dist <= TIGHT || introduced) {
      if (dist < bestDist) { bestDist = dist; best = mt; }
    }
  }
  const t = best;
  if (!t) return Date.UTC(y, m, d, 23, 59, 0);

  const raw = Number(t[1]);
  const min = t[2] ? Number(t[2]) : 0;
  const suffix = t[3];
  let hh;
  if (suffix === 'pm') hh = raw < 12 ? raw + 12 : raw;
  else if (suffix === 'am') hh = raw === 12 ? 0 : raw;
  else hh = raw;

  // "0 hrs" carries no information; an ambiguous hour must not turn the
  // deadline into midnight (end of day is the conservative reading).
  if (hh === 0 && suffix === 'hrs') return Date.UTC(y, m, d, 23, 59, 0);
  if (hh > 23 || min > 59) return Date.UTC(y, m, d, 23, 59, 0);
  return Date.UTC(y, m, d, hh, min, 0);
}

/**
 * `14/11/2025`, `14-11-25`, `14.11.2025`.
 *
 * DAY-FIRST. India writes dd/mm, and this is a BITS tool. An American
 * mm/dd reading of "11/12" is a month out, which is exactly the kind of
 * confidently-wrong result that destroys trust in the feature.
 */
function matchNumericDate(text, anchor) {
  const m = text.match(/\b(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?\b/);
  if (!m) return null;
  // A dash-separated PAIR with no year is ambiguous (P10): "due on 2-3" is a
  // range of days, not 2 March. Slash and dot stay day/month — the Indian
  // convention this tool is built for — but a bare "2-3" parses as a phantom
  // deadline far too often to trust. Require the year for dashes.
  const sep = m[0].match(/[/\-.]/)?.[0];
  if (sep === '-' && !m[3]) return null;
  const day = Number(m[1]);
  const month = Number(m[2]) - 1;
  if (day < 1 || day > 31 || month < 0 || month > 11) return null;

  let year;
  if (m[3]) {
    year = Number(m[3]);
    if (year < 100) year += 2000;
  } else {
    year = inferYear(month, day, anchor);
  }
  if (!isRealDate(year, month, day)) return null;
  return { at: withTime(year, month, day, text, m.index + m[0].length), text: m[0] };
}

/** `14 November`, `November 14`, `14th Nov 2025`. */
function matchTextualDate(text, anchor) {
  const names = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

  let m = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${names})\\b(?:\\s+(\\d{4}))?`));
  if (!m) {
    const alt = text.match(new RegExp(`\\b(${names})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`));
    if (alt) m = [alt[0], alt[2], alt[1], alt[3]];
  }
  if (!m) return null;

  const day = Number(m[1]);
  const month = MONTHS[m[2]];
  if (day < 1 || day > 31 || month === undefined) return null;
  const year = m[3] ? Number(m[3]) : inferYear(month, day, anchor);
  if (!isRealDate(year, month, day)) return null;
  return { at: withTime(year, month, day, text, m.index + m[0].length), text: m[0] };
}

/** `today`, `tomorrow`, `in 3 days`. */
function matchRelativeDay(text, anchor) {
  if (/\btoday\b/.test(text)) return { at: endOfDay(anchor), text: 'today' };
  if (/\btomorrow\b/.test(text)) return { at: endOfDay(anchor + DAY_MS), text: 'tomorrow' };
  const m = text.match(/\bin\s+(\d{1,2})\s+days?\b/);
  if (m) return { at: endOfDay(anchor + Number(m[1]) * DAY_MS), text: m[0] };
  return null;
}

/** `by Friday`, `on Friday`, `this Monday`, `next Tuesday`. */
function matchWeekday(text, anchor) {
  const names = Object.keys(WEEKDAYS).join('|');
  // `on` matters: "registration closes ON Friday" is the most common phrasing
  // in institutional mail and was being missed entirely.
  const m = text.match(new RegExp(`\\b(this|next|by|before|on)\\s+(${names})\\b`));
  if (!m) return null;
  const target = WEEKDAYS[m[2]];
  const d = new Date(anchor);
  const cur = d.getUTCDay();
  let ahead = (target - cur + 7) % 7;
  // "next Friday" said on a Friday means the following one, not today.
  if (ahead === 0) ahead = 7;
  if (m[1] === 'next' && ahead < 7) ahead += 7;
  return { at: endOfDay(anchor + ahead * DAY_MS), text: m[0] };
}

/**
 * Which year did they mean?
 *
 * Mail rarely states the year. "14 November" sent in December means NEXT
 * November, not one already past — so a date more than a month behind the mail
 * rolls forward.
 */
function inferYear(month, day, anchor) {
  const a = new Date(anchor);
  const y = a.getUTCFullYear();
  const candidate = Date.UTC(y, month, day, 23, 59);
  if (candidate < anchor - PAST_TOLERANCE) return y + 1;
  return y;
}

/** Rejects 31 February and friends, which a naive Date would silently roll. */
function isRealDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m && dt.getUTCDate() === d;
}

function endOfDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 0);
}

/** Bucket for the radar UI. */
export function urgency(at, now = Date.now()) {
  const delta = at - now;
  if (delta < 0) return 'overdue';
  if (delta < DAY_MS) return 'today';
  if (delta < 3 * DAY_MS) return 'soon';
  if (delta < 7 * DAY_MS) return 'week';
  return 'later';
}

/** Short human label: "in 3 days", "overdue by 2 days", "today". */
export function relativeLabel(at, now = Date.now()) {
  // CALENDAR days, not elapsed 24h periods. A deadline at 23:59 tomorrow is
  // "due tomorrow" to a human, but is 1.9 elapsed days, which a rounding
  // implementation reports as "due in 2d". Comparing midnights is what people
  // actually mean by "how many days".
  const startOf = (ms) => {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  const days = Math.round((startOf(at) - startOf(now)) / DAY_MS);
  if (days < 0) return days === -1 ? 'overdue by 1d' : `overdue by ${-days}d`;
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  if (days < 7) return `due in ${days}d`;
  const weeks = Math.round(days / 7);
  return weeks === 1 ? 'due in a week' : `due in ${weeks}w`;
}
