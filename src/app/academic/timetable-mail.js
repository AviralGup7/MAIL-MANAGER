import { parseDaysHours } from './timetable.js';
import { detectBitsSource } from '../../classify/sender.js';
/**
 * Deterministic extraction of timetable changes from academic mail.
 *
 * THE CONTRACT
 * ------------
 * A message may affect the timetable ONLY if it matches an explicit pattern
 * below AND names a course already in the user's timetable. Everything else
 * is ignored. There is no scoring, no similarity, no "probably about CS F111".
 *
 * WHY SO STRICT
 * -------------
 * A mail client that silently moves a class to the wrong room is worse than
 * one that does nothing, because the user stops trusting the schedule and has
 * to verify every entry by hand — at which point the feature is a liability.
 * So every rule here is written to FAIL CLOSED: if the message does not state
 * the change unambiguously, we produce a *proposal the user must confirm*, or
 * nothing at all.
 *
 * WHAT THIS MODULE RETURNS
 * ------------------------
 * Never a mutation. It returns findings — `{kind, entryId, field, value,
 * confidence, evidence}` — and the caller decides what to do with them under
 * the precedence rules in timetable.js. `evidence` is always a verbatim quote
 * from the message, so the UI can show the user the sentence the change came
 * from rather than asking them to trust a summary.
 */

/*
 * WHO COUNTS AS OFFICIAL IS DECIDED IN ONE PLACE (round 10, H-1).
 *
 * This module used to carry its own two-entry domain list and test it with
 *
 *     addr.includes(`@${d}`) || addr.includes(`.${d}`)
 *
 * `includes` matches ANYWHERE in the string, so the check accepted
 * `evil@pilani.bits-pilani.ac.in.attacker.com` — a domain an attacker can
 * simply register — along with `x@notpilani.bits-pilani.ac.in` and any
 * address whose display name merely contained the text. Measured: all four
 * returned true. That is the classic suffix-spoof shape, and it gated
 * `scanMessage`, the path that reads a message and proposes timetable
 * changes.
 *
 * `classify/sender.js` already solved this correctly, on a PARSED domain,
 * with a comment naming this exact hazard. The local list was also
 * redundant: `BITS_DOMAINS` contains `bits-pilani.ac.in`, so under suffix
 * matching it covers every campus subdomain the local list did. So the
 * duplicate is deleted rather than repaired — two copies of one security
 * rule is how the copies drift.
 */

/**
 * Supported change patterns.
 *
 * Each has a `test` that must match, and an `extract` that pulls the new value
 * out. `extract` returning null means "the pattern matched but the value was
 * not stated plainly" — which becomes a notify-only finding, not a change.
 */
const PATTERNS = [
  {
    kind: 'cancellation',
    field: null, // does not change a field; it annotates a date
    test: /\b(class(es)?|lecture|tutorial|lab|practical)\b[^.]{0,60}\b(is|are|will be|stands?|has been)\b[^.]{0,20}\bcancell?ed\b/i,
    label: 'Class cancelled',
  },
  {
    kind: 'extra-class',
    field: null,
    test: /\b(extra|make[- ]?up|compensatory|additional)\s+(class|lecture|lab|tutorial|session)\b/i,
    label: 'Extra class',
  },
  {
    kind: 'room',
    field: 'room',
    // "shifted to 6101", "venue: 5105", "will be held in room 1204"
    test: /\b(room|venue|shifted to|moved|will be held in|relocated to|rescheduled|changed to)\b/i,
    /*
     * PICK THE ROOM THE CLASS IS MOVING TO, NOT THE ONE IT IS LEAVING
     * (bug-hunt 43 #12). The old extractor took the FIRST room number in the
     * text, so "leaving 5105, class will be held in 6101" proposed 5105 --
     * the room the message exists to say is WRONG.
     *
     * The fix reads CHANGE SEMANTICS. Every 4-digit candidate is classified
     * by the words immediately before it: a departure marker (leaving / from /
     * was / previously / no longer) tags it OLD; an arrival marker (held in /
     * shifted to / moved to / now in / changed to / venue:) tags it NEW. The
     * proposal is the first NEW-tagged room. When nothing is tagged NEW the
     * extract returns null -- a notify-only finding -- because proposing a
     * room we cannot attribute to the change is exactly the silent-wrong-value
     * failure this module is written to refuse.
     */
    extract: (text) => {
      const T = String(text);
      const rooms = [...T.matchAll(/\b(\d{4}[A-Za-z]?)\b/g)].map((m) => ({
        v: m[1],
        before: T.slice(Math.max(0, m.index - 30), m.index),
      }));
      const DEPART_TAIL = /\b(leaving|left|from|was|previously|no longer)\b[\s:]*$/i;
      const DEPART_ANY = /\b(leaving|left|from|was|previously|earlier|no longer|instead of)\b/i;
      const ARRIVE_TAIL = /\b(held in|shifted to|moved to|relocated to|now in|now at|changed to|will be in|in room|venue|to)\b[\s:]*$/i;
      const ARRIVE_ANY = /\b(held in|will be held in|shifted to|moved to|relocated to|now in|changed to|venue|will be in)\b/i;
      const ROOM_ANY = /\broom\b/i;
      // PASS 1 -- strict: an arrival marker sits RIGHT BEFORE the room, and
      // no departure marker ends the window. The strongest signal wins.
      for (const r of rooms) {
        if (DEPART_TAIL.test(r.before)) continue;
        if (ARRIVE_TAIL.test(r.before)) return r.v;
      }
      // PASS 2 -- loose: an arrival word anywhere in the window, but only
      // when the window carries NO departure word at all (this is what keeps
      // "leaving room 5105" from proposing 5105).
      for (const r of rooms) {
        if (DEPART_ANY.test(r.before)) continue;
        if (ARRIVE_ANY.test(r.before) || ROOM_ANY.test(r.before)) return r.v;
      }
      return null; // no room is attributable to the change: notify only
    },
    label: 'Room change',
  },
  {
    kind: 'instructor',
    field: 'instructors',
    test: /\b(will be (taught|handled|taken)|instructor[- ]in[- ]charge|new instructor|taken over)\b/i,
    // Deliberately no extractor. A human name cannot be delimited reliably in
    // free prose without guessing where it ends, and a wrong instructor is a
    // silent error the user may never notice. Reported for confirmation only.
    extract: () => null,
    label: 'Instructor change',
  },
  {
    kind: 'timetable-correction',
    field: null,
    test: /\b(timetable|time[- ]table)\b[^.]{0,40}\b(correction|revised|change|updated|amend)/i,
    label: 'Timetable correction',
  },
  {
    kind: 'exam',
    field: null,
    test: /\b(quiz|test|mid[- ]?sem(ester)?|compre(hensive)?|exam(ination)?)\b[^.]{0,60}\b(on|scheduled|will be held|date)\b/i,
    label: 'Exam or quiz',
  },
  {
    kind: 'holiday',
    field: null,
    test: /\b(holiday|recess|no classes|classwork suspended|institute closed)\b/i,
    label: 'Holiday or recess',
  },
  {
    kind: 'deadline',
    field: null,
    test: /\b(last date|deadline|due (by|on)|submit (by|before)|closes on)\b/i,
    label: 'Deadline',
  },
];

/**
 * Course number, as written in BITS mail: "CS F111", "MATH F201", "BITS F110".
 * Two to five letters, a space, an optional letter, three digits.
 */
/*
 * The department letters are greedy, so "CSF111" was split as dept "CSF" and
 * no course letter, producing "CSF 111" instead of "CS F111". Requiring the
 * course letter to be present when there is no space (`[A-Z]{2,4}([A-Z])\d{3}`
 * cannot be distinguished by the engine alone) means matching the two shapes
 * separately: spaced, then unspaced with an explicit single course letter.
 */
/*
 * DEPARTMENT CODES ARE ENUMERATED, NOT PATTERN-MATCHED.
 *
 * The original pattern was `[A-Z]{2,5}` plus an OPTIONAL letter and three
 * digits, which matches far more than a BITS course number:
 *
 *     "Flight AI 202 delayed"   -> AI 202
 *     "ISBN 978 3 16"           -> ISBN 978
 *
 * Harmless while nothing displayed the result. Feature 55 puts a course chip
 * on the message row, so a false positive is now a visible lie on a row the
 * user is scanning -- and the rule this project set for academic detection is
 * that a wrong badge is worse than no badge, because it teaches people to stop
 * reading badges.
 *
 * The real vocabulary is small and known: 33 departments, generated from
 * src/timetable/data.json, and the letter before the digits is MANDATORY
 * (F###, G###, U###, C###T, E###...). Both false positives fail on the letter
 * alone; enumerating the departments as well makes a collision essentially
 * impossible.
 *
 * Kept as a literal rather than imported from data.json because this module is
 * on the ingest path and must not pull in a 652KB JSON file to classify a
 * subject line. tools/check-departments.mjs asserts the two agree.
 */
const DEPTS = 'AN|BIOT|BIO|BITS|CE|CHEM|CHE|CS|DE|ECON|ECE|EEE|EE|ENVS|FIN|GS|HSS|INSTR|MAC|MATH|MEL|MSE|ME|MF|MGTS|MPBA|PHA|PHY|SAN|SCM|SNS|SS|SW';

/*
 * Two alternatives, spaced and unspaced, same as before.
 *
 * A NOTE ON ORDERING, BECAUSE I ASSERTED A HAZARD THAT DOES NOT EXIST.
 *
 * The list is written longest-first within each prefix family (BIOT before
 * BIO, CHEM before CHE) and I claimed that was load-bearing -- that BIO would
 * otherwise shadow BIOT. Tested it: it does not. `\b(BIO)([A-Z])(\d{3})`
 * cannot match "BIOTF110", because after BIO the next character must be a
 * single letter followed by three DIGITS, and "TF11" is not. The spaced
 * alternative fails on the word boundary for the same reason.
 *
 * The ordering is kept because it is clearer to read and costs nothing, but it
 * is a convention, not a correctness requirement. Recorded rather than
 * silently corrected, per the project's rule about disproved suspicions.
 */
const COURSE_RE = new RegExp(
  `\\b(${DEPTS})\\s([A-Z])(\\d{3})([A-Z])?\\b|\\b(${DEPTS})([A-Z])(\\d{3})([A-Z])?\\b`,
  'g'
);

/** Section token: L1, T7, P12. */
const SECTION_RE = /\b([LTP])\s?(\d{1,2})\b/g;

/** Is this address one we will act on? */
export function isAcademicSender(from) {
  return detectBitsSource(String(from || '')).isBits;
}

/**
 * Course numbers mentioned in a message, normalised to the document's spelling.
 *
 * Mail writes "CSF111", "CS F111" and "CS-F111" for the same course. The
 * timetable document writes "CS F111". Normalising both sides to one form is
 * a formatting rule, not an inference — the characters are identical.
 */
export function courseNumbersIn(text) {
  const out = new Set();
  const src = String(text || '').toUpperCase().replace(/[-_]/g, ' ');
  let m;
  COURSE_RE.lastIndex = 0;
  while ((m = COURSE_RE.exec(src))) {
    // Two alternatives: spaced (groups 1-4) or unspaced (groups 5-8).
    const dept = m[1] || m[5];
    const letter = m[1] ? m[2] : m[6];
    const digits = m[1] ? m[3] : m[7];
    const suffix = (m[1] ? m[4] : m[8]) || '';
    out.add(`${dept} ${letter || ''}${digits}${suffix}`.replace(/\s+/g, ' ').trim());
  }
  return [...out];
}

/** Section tokens mentioned in a message. */
export function sectionsIn(text) {
  const out = new Set();
  const src = String(text || '').toUpperCase();
  let m;
  SECTION_RE.lastIndex = 0;
  while ((m = SECTION_RE.exec(src))) out.add(`${m[1]}${Number(m[2])}`);
  return [...out];
}

/** A verbatim sentence containing the match, for the UI to quote. */
/**
 * Cut the message at its first quoted-reply marker (round 11, B10).
 *
 * A reply carries the notice it is answering, and that notice usually states
 * the very change the reply is WITHDRAWING. Measured: a body reading
 * "> the class has been shifted to room 1111 / please ignore the message
 * below" produced a proposal to move the class to 1111 — the app acted on
 * the text the human explicitly told it to ignore.
 *
 * The markers are the same shapes snippet.js cuts on. Only the text ABOVE
 * the first one is the sender's own words, and only those may drive a
 * timetable change.
 */
function dropQuoted(text) {
  const src = String(text || '');
  let cut = src.length;
  for (const re of [
    /^\s*>/m,                                   // a quoted line
    /^\s*On .{0,80}\bwrote:/mi,                 // "On Mon, X wrote:"
    /^-{2,}\s*Original Message\s*-{2,}/mi,
    /^\s*From:\s.+$/mi,                         // a forwarded header block
  ]) {
    const m = src.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  return src.slice(0, cut);
}

/** Words that flip the meaning of the sentence they sit in. */
const NEGATORS = /\b(not|no longer|never|cancel(?:led|s)? the (?:change|update)|withdrawn|ignore|disregard|stands? unchanged|remains? unchanged|unchanged)\b/i;

/**
 * Does the sentence that MATCHED say the opposite of what it matched?
 *
 * Read on the matched sentence, not the whole message: a long notice
 * legitimately contains "not" somewhere far from the claim, and rejecting on
 * that would fail closed so often the feature would stop working.
 *
 * `cancellation` is exempt from the bare `cancel...` negator for the obvious
 * reason — its own pattern is built from that word — so the negator list
 * spells out the phrases that negate a cancellation instead.
 */
function negated(text, re) {
  const sentence = quote(text, re);
  if (!sentence) return false;
  return NEGATORS.test(sentence);
}

function quote(text, re) {
  /*
   * Prefer the LONGEST matching sentence.
   *
   * The subject line is prepended to the body, and a subject like
   * "CS F111 L1 venue" matches the room pattern while carrying none of the
   * information the user needs. Taking the first match quoted the subject and
   * threw away the sentence that actually stated the new room. Length is a
   * reliable proxy here because the informative sentence is the one with the
   * value in it.
   */
  const sentences = String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter((x) => re.test(x));
  if (!sentences.length) return '';
  const best = sentences.reduce((a, b) => (b.length > a.length ? b : a));
  return best.length > 240 ? `${best.slice(0, 237)}…` : best;
}

/**
 * Scan one message against one timetable.
 *
 * @param {object} msg    {id, from, subject, snippet, body}
 * @param {object} state  the timetable state
 * @returns {object[]}    findings, possibly empty
 *
 * FOUR GATES, in order. A message must pass all of them:
 *   1. the sender is an academic address
 *   2. the message names a course that is IN the user's timetable
 *   3. it matches a supported pattern
 *   4. if the pattern changes a field, the new value is stated plainly
 *
 * Failing gate 4 downgrades a change to a notification, which is the honest
 * outcome: "AUGSD says something about the room for CS F111 L1 — read it".
 */
export function scanMessage(msg, state) {
  if (!msg || !isAcademicSender(msg.from)) return [];

  const text = dropQuoted([msg.subject, msg.snippet, msg.body].filter(Boolean).join('\n'));
  if (!text.trim()) return [];

  const courses = courseNumbersIn(text);
  if (!courses.length) return [];

  // Gate 2: only courses the user actually has. This is what stops the
  // department-wide mailing list from rewriting a timetable it has nothing
  // to do with.
  const mine = state.entries.filter((e) => courses.includes(e.courseNo));
  if (!mine.length) return [];

  const mentioned = sectionsIn(text);
  const findings = [];

  for (const pattern of PATTERNS) {
    if (!pattern.test.test(text)) continue;
    /*
     * A SENTENCE THAT SAYS THE OPPOSITE IS NOT EVIDENCE (round 11, B10).
     *
     * This module's header promises to FAIL CLOSED — "if the message does
     * not state the change unambiguously, we produce a proposal the user
     * must confirm, or nothing at all". It did not. Measured:
     *
     *   'the class will NOT be shifted to room 9999'   -> room -> 9999
     *   'the class is NOT cancelled'                   -> cancellation
     *   'contrary to the notice, it has not been moved to 9999' -> 9999
     *
     * A correction notice is exactly the kind of mail that names a room and
     * then denies it, and acting on the denial is the failure the header
     * calls "worse than doing nothing": the user stops trusting the
     * schedule. The matched SENTENCE is re-read for a negation rather than
     * the whole message, because a long notice legitimately contains "not"
     * somewhere far from the claim.
     */
    if (negated(text, pattern.test)) continue;

    // Narrow to the named section when the mail names one; otherwise the
    // finding applies to every section of that course the user has.
    const targets = mentioned.length
      ? mine.filter((e) => mentioned.includes(e.section))
      : mine;
    if (!targets.length) continue;

    const evidence = quote(text, pattern.test);

    for (const entry of targets) {
      const value = pattern.extract ? pattern.extract(text) : null;

      if (pattern.field && value !== null) {
        findings.push({
          kind: pattern.kind,
          label: pattern.label,
          entryId: entry.id,
          courseNo: entry.courseNo,
          section: entry.section,
          field: pattern.field,
          value: pattern.field === 'instructors' ? [value] : value,
          actionable: true,
          messageId: msg.id,
          evidence,
        });
      } else {
        // Notification only: we know something changed, we will not pretend
        // to know what to.
        findings.push({
          kind: pattern.kind,
          label: pattern.label,
          entryId: entry.id,
          courseNo: entry.courseNo,
          section: entry.section,
          field: pattern.field || null,
          value: null,
          actionable: false,
          messageId: msg.id,
          evidence,
        });
      }
    }
  }

  return dedupe(findings);
}

/** One finding per (kind, entry, message). Patterns can overlap on one line. */
function dedupe(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const k = `${f.kind}|${f.entryId}|${f.messageId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

/**
 * Scan many messages, skipping ones already applied.
 *
 * Idempotence matters: this runs on every sync, and a message that has already
 * been turned into a change must not produce it again — that would resurrect a
 * value the user has since edited.
 */
export function scanMessages(messages, state) {
  /*
   * ONE SET FOR BOTH KINDS OF REPEAT.
   *
   * `appliedMail` covers messages handled in a PREVIOUS session. It did not
   * cover a duplicate inside the CURRENT input -- the same message returned by
   * two mailbox queries, or a re-scan concatenating results -- so the user was
   * asked to approve the same room change twice.
   *
   * Adding each id as it is consumed makes the scan idempotent within a call
   * as well as across sessions. A message with no id is skipped rather than
   * treated as a repeat of the last one: '' would collide with itself.
   */
  /* Total, like scanMessage (round 10, M-14 -- the report flagged this as
     unverified; probed: `scanMessages(null)` threw on `state.appliedMail`).
     No state means nothing to compare a message against, so no findings. */
  if (!state || typeof state !== 'object' || !Array.isArray(state.entries)) return [];
  const seen = new Set(state.appliedMail || []);
  const out = [];
  for (const m of messages || []) {
    if (!m || !m.id) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(...scanMessage(m, state));
  }
  return out;
}

/* ========================================================================== *
 * THE OFFICIAL CHANGE NOTICE
 * ========================================================================== */

/**
 * Match parsed change-notice rows against the user's timetable.
 *
 * The notice is precedence 4 — above the document, below a manual edit. Rows
 * are matched on computer code AND section, both of which the notice prints
 * unambiguously, so this needs no text analysis at all.
 *
 * The notice's own wrapped cells are NOT parsed into new values (see
 * tools/parse-timetable.mjs for why). So every notice match is a confirmation
 * request carrying the verbatim row, not an automatic edit. That is a
 * deliberate limit of what the source supports, and it is stated to the user.
 */
export function matchNotice(changes, state) {
  if (!Array.isArray(changes)) return [];
  const out = [];
  for (const c of changes || []) {
    const targets = state.entries.filter(
      (e) => e.comCode === c.comCode && (!c.section || e.section === c.section)
    );
    for (const entry of targets) {
      const { value, from } = noticeValue(c);
      out.push({
        kind: `notice-${c.type}`,
        label: NOTICE_LABEL[c.type] || 'Timetable change',
        entryId: entry.id,
        courseNo: entry.courseNo,
        section: entry.section,
        field: NOTICE_FIELD[c.type] || null,
        value,
        from,
        // A notice outranks the official timetable, so an actionable one can
        // be applied without asking. Actionable requires BOTH a target field
        // and a value we could read unambiguously.
        actionable: Boolean(NOTICE_FIELD[c.type] && value !== null),
        noticeRef: `${c.comCode}/${c.section || '-'}`,
        effective: c.effective,
        evidence: c.raw,
      });
    }
  }
  return out;
}


/**
 * Read the NEW value out of a change-notice row.
 *
 * The notice is the second-highest authority in the system, above the official
 * timetable. It was being matched to the right entry and then reported with no
 * value at all, so the highest automatic authority could never change anything.
 *
 * The document prints From and To as two columns:
 *
 *   B. Change of Room
 *   ... From   To
 *   151   L1   6156   6160 BIO G542      -> 6156 becomes 6160
 *
 * Reading the second is not inference; it is the column the source labelled
 * "To". But that only holds when BOTH columns survived on the row. Some rows
 * wrap ("145  L1   6108(T) PHA G617" has one room) and a single value is
 * genuinely ambiguous -- it could be the old or the new. Those return null and
 * stay non-actionable: reported to the user, never applied.
 *
 * Instructor changes are deliberately never actionable. Names wrap across
 * lines in this document and a half-read name written into the timetable is
 * worse than a prompt. Same restraint the mail path already uses.
 *
 * @returns {{value: string|object[]|null, from: string|null}}
 */
function noticeValue(c) {
  const raw = String(c.raw || '');

  if (c.type === 'room') {
    // Four-digit room numbers, optionally suffixed with a day hint: 6108(T).
    const rooms = [...raw.matchAll(/\b(\d{4})(?:\([A-Za-z ]+\))?/g)].map((m) => m[1]);
    // The computer code is also numeric but is not four digits here; guard
    // anyway by dropping anything equal to it.
    const rest = rooms.filter((r) => r !== c.comCode);
    if (rest.length < 2) return { value: null, from: rest[0] ?? null };
    return { value: rest[rest.length - 1], from: rest[0] };
  }

  if (c.type === 'time') {
    // Same notation as the main timetable, so the same parser -- not a second
    // implementation that can drift from it.
    /*
     * Capture the WHOLE cell, not the first group.
     *
     * "M W 2 T 9" is two groups and an earlier version of this pattern stopped
     * after the first hour, silently dropping the Tuesday class. So the match
     * repeats day-runs-then-hours as a unit.
     *
     * This document also writes days unspaced ("MW 2", "TThF 4"), so the days
     * are re-split before parsing -- Th first, or every Thursday becomes a
     * Tuesday followed by a stray h.
     */
    /*
     * Strip exam dates FIRST. A row can read "TThF 4 01/12", and the leading
     * "01" of the date looks exactly like an hour -- it parsed as a second
     * class at slot 1 on all three days, inventing three meetings that do not
     * exist. DD/MM is unambiguous and goes before anything else is read.
     */
    const noDates = raw.replace(/\b\d{1,2}\/\d{1,2}\b/g, ' ');
    const cell = noDates.match(/((?:(?:Th|[MTWFS])\s*)+\d{1,2}(?:\s+\d{1,2})*(?:\s*(?:Th|[MTWFS])\s*)*(?:\d{1,2}\s*)*)/);
    if (!cell) return { value: null, from: null };
    const spaced = cell[1].replace(/(Th|[MTWFS])/g, ' $1 ').replace(/\s+/g, ' ').trim();
    const meetings = parseDaysHours(spaced);
    return { value: meetings.length ? meetings : null, from: null };
  }

  return { value: null, from: null };
}

const NOTICE_LABEL = {
  room: 'Official room change',
  instructor: 'Official instructor change',
  time: 'Official class-time change',
  compre: 'Official compre date change',
  'new-section': 'New section offered',
};

const NOTICE_FIELD = {
  room: 'room',
  instructor: 'instructors',
  time: 'meetings',
};
