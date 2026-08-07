import { parseDaysHours } from './timetable.js';
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

/** Only mail from these domains is considered official enough to act on. */
const ACADEMIC_DOMAINS = [
  'pilani.bits-pilani.ac.in',
  'bits-pilani.ac.in',
];

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
    test: /\b(room|venue|shifted to|moved to|will be held in|relocated to)\b/i,
    extract: (text) => {
      const m = text.match(/\b(?:room|venue|shifted to|moved to|held in|relocated to)\b[^\d]{0,20}(\d{4}[A-Za-z]?)\b/i);
      return m ? m[1] : null;
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
  const addr = String(from || '').toLowerCase();
  return ACADEMIC_DOMAINS.some((d) => addr.includes(`@${d}`) || addr.includes(`.${d}`));
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

  const text = [msg.subject, msg.snippet, msg.body].filter(Boolean).join('\n');
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
