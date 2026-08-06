/**
 * The timetable model: a persistent academic schedule built from official
 * source data, updated only by deterministic rules.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a planner, not a scheduler, not a guessing engine. Every field of every
 * entry is traceable to one of exactly three things: the official timetable
 * document, an official change notice, or an explicit user action. If a value
 * is not supported by one of those, it is left UNRESOLVED and surfaced --
 * never filled in with a plausible default.
 *
 * This is a DOMAIN module. It is pure: no DOM, no chrome APIs, no fetch. It
 * takes the parsed source data and a stored state, and returns a new state.
 * Persistence is the caller's job (see timetable-store.js), which keeps the
 * rules testable without a browser.
 *
 * PRECEDENCE — the single rule that resolves every conflict
 * ---------------------------------------------------------
 * Higher number wins. When two sources disagree, the higher-precedence value
 * is applied and the loser is recorded in history, not discarded.
 *
 *   5  manual      an explicit user edit
 *   4  notice      an official timetable change notice
 *   3  document    the official timetable document
 *   2  mail        a supported Gmail academic message
 *   1  unresolved  known to be missing; never overwrites anything real
 *
 * Two sources at the SAME precedence that disagree cannot be resolved
 * deterministically, so they are surfaced as a conflict rather than silently
 * ordered by arrival time.
 */

/** Source precedence. Higher wins. */
export const PRECEDENCE = {
  unresolved: 1,
  mail: 2,
  document: 3,
  notice: 4,
  manual: 5,
};

/** Human labels, used in the UI and in explanations. */
export const SOURCE_LABEL = {
  manual: 'your edit',
  notice: 'official change notice',
  document: 'official timetable',
  mail: 'academic email',
  unresolved: 'not yet known',
};

/** Fields an entry carries that can each have their own source. */
export const TRACKED_FIELDS = ['instructors', 'room', 'meetings', 'daysHours'];

const DAY_ORDER = { M: 0, T: 1, W: 2, Th: 3, F: 4, S: 5 };

/* ========================================================================== *
 * STATE SHAPE
 * ========================================================================== */

/**
 * @typedef {object} Provenance
 * @property {string} source     one of PRECEDENCE's keys
 * @property {string} ref        document name, message id, or 'user'
 * @property {number} at         epoch ms when this value was applied
 * @property {string} [note]     verbatim source text, when there is one
 *
 * @typedef {object} Entry
 * @property {string} id             stable: comCode:section
 * @property {string} comCode
 * @property {string} courseNo
 * @property {string} title
 * @property {string} section
 * @property {string} kind           lecture | tutorial | practical
 * @property {string[]} instructors
 * @property {string} room
 * @property {object[]} meetings
 * @property {string[]} unresolved   field names with no supported value
 * @property {boolean} locked        excluded from automatic updates
 * @property {string} linkedTo       the lecture section this hangs off, if any
 * @property {Object<string,Provenance>} provenance  per field
 * @property {object[]} history      every change, newest last
 */

export function emptyState() {
  return {
    schemaVersion: 1,
    semester: '',
    entries: [],
    /** Conflicts awaiting a human decision. */
    conflicts: [],
    /** Message ids already applied, so a re-scan is idempotent. */
    appliedMail: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

export const entryId = (comCode, section) => `${comCode}:${section}`;

/* ========================================================================== *
 * BUILDING — the one-time initial build
 * ========================================================================== */

/**
 * Which sections a course offers, grouped by kind.
 *
 * The UI needs this to ask the three questions in order: which course, which
 * teacher, which lecture section.
 */
export function sectionsByKind(course) {
  const out = { lecture: [], tutorial: [], practical: [] };
  for (const s of course.sections || []) {
    if (out[s.kind]) out[s.kind].push(s);
  }
  return out;
}

/**
 * The distinct instructors teaching a course's lectures.
 *
 * Returned in document order, deduplicated case-insensitively — the source
 * writes the instructor-in-charge in BLOCK CAPITALS on the header row and in
 * mixed case on continuation rows, and they are the same person.
 */
export function instructorsFor(course) {
  const seen = new Map();
  for (const s of course.sections || []) {
    if (s.kind !== 'lecture') continue;
    for (const name of s.instructors || []) {
      const k = name.trim().toLowerCase();
      if (!seen.has(k)) seen.set(k, name.trim());
    }
  }
  return [...seen.values()];
}

/**
 * Sections linked to a chosen lecture.
 *
 * WHAT THE SOURCE ACTUALLY SUPPORTS, and what it does not
 * -------------------------------------------------------
 * The BITS coursewise timetable lists tutorials and practicals as sections of
 * the course. It does NOT print a mapping from lecture section to tutorial
 * section — there is no "L3 goes with T3" column anywhere in the document.
 *
 * So there are exactly two honest cases:
 *
 *   ONE option      the course has a single tutorial (or practical) section.
 *                   Every student in the course must be in it. That is
 *                   deterministic, so it is attached automatically.
 *
 *   MANY options    the course has several. Which one a given student belongs
 *                   to comes from their registration, which is not in this
 *                   document. Attaching "the one with the matching number"
 *                   would be a guess that looks authoritative, so instead the
 *                   user is asked to choose.
 *
 * The numeric-match heuristic is deliberately NOT implemented. L3/T3 pairing
 * is a coincidence of numbering at BITS, not a rule, and a wrong tutorial is
 * worse than an unanswered question.
 */
export function linkedSections(course, lectureSection) {
  const kinds = sectionsByKind(course);
  const result = { auto: [], choose: [] };

  for (const kind of ['tutorial', 'practical']) {
    const options = kinds[kind];
    if (options.length === 0) continue;
    if (options.length === 1) {
      result.auto.push({ kind, section: options[0], reason: 'only-option' });
    } else {
      result.choose.push({ kind, options, lectureSection });
    }
  }
  return result;
}

/**
 * Turn a chosen section into a timetable entry.
 *
 * `unresolved` is copied from the parse, so a section the document could not
 * fully describe arrives already flagged rather than looking complete.
 */
/**
 * Name the five credit columns, per legend section 4.
 *
 *   L = lecture hours/week   P = practical   T = tutorial
 *   S = self-study           U = total units
 *
 * `["3","1","-","-","4"]` carries no meaning at a call site, so nothing could
 * ask "does this course have a lab?" without re-deriving the legend locally.
 *
 * A DASH AND A MISSING VALUE ARE NOT THE SAME THING. The document writes '-'
 * to state that a component does not exist, which is information, and it maps
 * to 0. Anything unparseable maps to null -- unknown -- so a display can tell
 * "this course has no tutorial" from "we could not read the tutorial column".
 * Collapsing both to 0 would invent a fact.
 */
export function parseCredits(cols) {
  const names = ['lecture', 'practical', 'tutorial', 'selfStudy', 'units'];
  const out = {};
  names.forEach((name, i) => {
    const raw = cols?.[i];
    if (raw === '-') { out[name] = 0; return; }
    const n = Number(String(raw ?? '').trim());
    out[name] = String(raw ?? '').trim() !== '' && Number.isFinite(n) ? n : null;
  });
  return out;
}

export function makeEntry(course, section, { source = 'document', ref, at = Date.now(), linkedTo = '' } = {}) {
  const prov = (field) => ({
    source: (section.unresolved || []).includes(field) ? 'unresolved' : source,
    ref: ref || '',
    at,
  });

  return {
    id: entryId(course.comCode, section.section),
    comCode: course.comCode,
    courseNo: course.courseNo,
    title: course.title,
    section: section.section,
    kind: section.kind,
    /*
     * Who to email. Legend section 6 marks the instructor-in-charge in BLOCK
     * CAPITALS; the parser records it per section. '' where the document did
     * not mark one -- see parseCredits' sibling reasoning: a stated absence
     * and an unknown are different, and neither is a guess.
     */
    inCharge: section.inCharge || '',
    instructors: [...(section.instructors || [])],
    // The credit columns, named per legend section 4 rather than left as a
    // positional array nothing can read.
    credits: parseCredits(course.credits),
    room: section.room || '',
    daysHours: section.daysHours || '',
    meetings: (section.meetings || []).map((m) => ({ ...m })),
    midsem: section.midsem || '',
    compre: section.compre || '',
    unresolved: [...(section.unresolved || [])],
    locked: false,
    linkedTo,
    provenance: {
      instructors: prov('instructor'),
      room: prov('room'),
      meetings: prov('time'),
      daysHours: prov('time'),
    },
    history: [{
      at,
      action: 'added',
      source,
      ref: ref || '',
      detail: `Added ${course.courseNo} ${section.section} from the ${SOURCE_LABEL[source]}`,
    }],
  };
}

/**
 * Add a course to the timetable.
 *
 * Adding is idempotent per section: re-adding a section already present is a
 * no-op rather than a duplicate, because the natural user gesture after a
 * mistake is to try again.
 */
export function addCourse(state, course, { lecture, extraSections = [], ref, at = Date.now() }) {
  const next = { ...state, entries: [...state.entries] };
  const added = [];

  const push = (section, linkedTo = '') => {
    const id = entryId(course.comCode, section.section);
    if (next.entries.some((e) => e.id === id)) return;
    const entry = makeEntry(course, section, { ref, at, linkedTo });
    next.entries.push(entry);
    added.push(entry);
  };

  if (lecture) push(lecture);
  for (const s of extraSections) push(s, lecture ? lecture.section : '');

  next.updatedAt = at;
  if (!next.createdAt) next.createdAt = at;
  next.conflicts = detectConflicts(next.entries);
  return { state: next, added };
}

/** Remove a course entirely, or one section of it. */
export function removeCourse(state, comCode, section = null) {
  const keep = (e) => (section ? !(e.comCode === comCode && e.section === section) : e.comCode !== comCode);
  const entries = state.entries.filter(keep);
  return {
    ...state,
    entries,
    conflicts: detectConflicts(entries),
    updatedAt: Date.now(),
  };
}

/**
 * Swap one held section of a course for another.
 *
 * Without this the only route was remove-then-add, which threw away the
 * history of everything else on that course -- and a section swap is a
 * routine event in the first fortnight of a semester.
 *
 * The new section is a genuinely DIFFERENT class: its own room, hours and
 * instructors, all from the source. So this builds a fresh entry rather than
 * mutating fields on the old one, which would leave provenance claiming the
 * document said things about L2 that it said about L1.
 *
 * What carries over is the `locked` flag and the FACT of the switch, recorded
 * in the new entry's history so the change is explainable later.
 *
 * A section the user does not hold is left alone -- no silent insert.
 */
export function switchSection(state, comCode, fromSection, course, toSection, at = Date.now()) {
  const old = state.entries.find(
    (e) => e.comCode === comCode && e.section === fromSection
  );
  if (!old || !toSection) return state;

  const fresh = makeEntry(course, toSection, {
    semester: old.semester,
    source: 'document',
    ref: 'official timetable',
    at,
  });

  const replacement = {
    ...fresh,
    // The lock is a user preference about automation, not a property of the
    // class, so it survives the swap.
    locked: old.locked,
    history: [
      {
        at,
        action: 'switched',
        field: 'section',
        source: 'manual',
        ref: 'user',
        from: fromSection,
        to: toSection.section,
        detail: `Switched from ${fromSection} to ${toSection.section}`,
      },
      ...fresh.history.slice(1),
    ],
  };

  const entries = state.entries.map((e) => (e === old ? replacement : e));
  return { ...state, entries, conflicts: detectConflicts(entries), updatedAt: at };
}

/**
 * Mark the course set complete.
 *
 * A milestone, NOT a freeze. Official notices must still land afterwards,
 * because AUGSD does not care that you pressed a button -- freezing would
 * turn a finalised timetable into a stale one, which is worse than no
 * milestone at all.
 *
 * It refuses while blocking conflicts remain. "Finalise" that happily accepts
 * two classes in one slot means nothing. Needs-input conflicts (a room the
 * document never printed) are advisory and do not block, because they may
 * never be resolvable from the source.
 */
export function finalize(state, at = Date.now()) {
  const blocking = (state.conflicts || []).filter((c) => c.severity === 'blocking');
  if (blocking.length) {
    return {
      ok: false,
      state,
      reason:
        `Resolve ${blocking.length} blocking conflict` +
        `${blocking.length === 1 ? '' : 's'} first: ${blocking[0].message}`,
    };
  }
  return { ok: true, state: { ...state, finalisedAt: at, updatedAt: at }, reason: '' };
}

/**
 * Throw the timetable away and start again.
 *
 * The only sanctioned route back to a full rebuild -- everything else in this
 * system updates incrementally, so a reset is destructive and must be asked
 * for explicitly.
 *
 * NOT simply `emptyState()`: `appliedMail` must be cleared too. That list
 * remembers which messages have already been dealt with so they are not
 * re-proposed. After a reset the timetable is empty, so every one of those
 * messages is unhandled again -- keeping the list would leave the rebuilt
 * timetable permanently deaf to mail it had already seen.
 */
export function resetTimetable(state, at = Date.now()) {
  return {
    ...emptyState(),
    // Keep the semester so the panel header does not blank out mid-rebuild.
    semester: state?.semester || '',
    resetAt: at,
    updatedAt: at,
  };
}

/* ========================================================================== *
 * UPDATING — deterministic, precedence-driven
 * ========================================================================== */

/**
 * Apply a change to one field of one entry, obeying precedence.
 *
 * Returns `{entry, applied, reason}`. When `applied` is false the entry is
 * returned unchanged and `reason` says why — which the UI shows rather than
 * silently doing nothing.
 *
 * A LOCKED entry rejects everything except a manual edit. That is the whole
 * point of the lock: the user has said "leave this alone", and an official
 * notice arriving later must not quietly undo their decision. It is reported,
 * so they can choose to accept it.
 */
export function applyFieldChange(entry, field, value, { source, ref, at = Date.now(), note = '' }) {
  if (!TRACKED_FIELDS.includes(field)) {
    return { entry, applied: false, reason: `"${field}" is not a tracked field` };
  }
  const incoming = PRECEDENCE[source];
  if (!incoming) return { entry, applied: false, reason: `unknown source "${source}"` };

  if (entry.locked && source !== 'manual') {
    return {
      entry,
      applied: false,
      reason: `${entry.courseNo} ${entry.section} is locked against automatic updates`,
      needsPermission: true,
    };
  }

  const currentSource = entry.provenance?.[field]?.source || 'unresolved';
  const current = PRECEDENCE[currentSource] || 1;

  if (incoming < current) {
    return {
      entry,
      applied: false,
      reason: `kept ${SOURCE_LABEL[currentSource]} over ${SOURCE_LABEL[source]}`,
    };
  }
  // Equal precedence from a DIFFERENT reference is not deterministic: two
  // official notices disagreeing is a real-world event and the user must
  // decide. Same reference re-applied is just idempotence.
  if (incoming === current && currentSource !== 'unresolved') {
    const sameRef = entry.provenance[field]?.ref === ref;
    if (!sameRef && !sameValue(entry[field], value)) {
      return {
        entry,
        applied: false,
        reason: `two ${SOURCE_LABEL[source]} sources disagree`,
        conflict: true,
      };
    }
  }

  if (sameValue(entry[field], value)) return { entry, applied: false, reason: 'no change' };

  const previous = entry[field];
  const updated = {
    ...entry,
    [field]: value,
    unresolved: entry.unresolved.filter((u) => !unresolvedNamesFor(field).includes(u)),
    provenance: { ...entry.provenance, [field]: { source, ref, at, note } },
    history: [
      ...entry.history,
      {
        at,
        action: 'changed',
        field,
        source,
        ref,
        from: describeValue(field, previous),
        to: describeValue(field, value),
        detail: `${field} changed by ${SOURCE_LABEL[source]}`,
        note,
      },
    ],
  };
  return { entry: updated, applied: true, reason: '' };
}

/** The parse-time `unresolved` names that a tracked field resolves. */
function unresolvedNamesFor(field) {
  if (field === 'instructors') return ['instructor'];
  if (field === 'room') return ['room'];
  if (field === 'meetings' || field === 'daysHours') return ['time'];
  return [];
}

function sameValue(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

function describeValue(field, v) {
  if (field === 'meetings') return Array.isArray(v) ? summariseMeetings(v) : String(v ?? '');
  if (Array.isArray(v)) return v.join(', ');
  return String(v ?? '');
}

/** Lock or unlock an entry against automatic updates. */
export function setLocked(state, id, locked, at = Date.now()) {
  return mapEntry(state, id, (e) => ({
    ...e,
    locked,
    history: [...e.history, {
      at,
      action: locked ? 'locked' : 'unlocked',
      source: 'manual',
      ref: 'user',
      detail: locked
        ? 'Locked: automatic updates will be reported, not applied'
        : 'Unlocked: automatic updates apply again',
    }],
  }));
}

/** A manual edit. Highest precedence, always wins, always recorded. */
/**
 * A change the user made themselves. Outranks every other source.
 *
 * `ref` defaults to 'user' but is overridable, and that is not cosmetic. When
 * someone accepts a proposal that came from an email, the edit IS theirs --
 * mail cannot outrank the official timetable, so recording it as `manual` is
 * the honest precedence -- but the message is still what prompted it. Pinning
 * `ref` to 'user' threw that away, and the mail could no longer account for
 * what it had caused. Passing the message id keeps the trail intact without
 * weakening the precedence rule.
 */
export function manualEdit(state, id, field, value, at = Date.now(), ref = 'user') {
  let outcome = null;
  const next = mapEntry(state, id, (e) => {
    const r = applyFieldChange(e, field, value, { source: 'manual', ref, at });
    outcome = r;
    return r.entry;
  });
  return { state: { ...next, conflicts: detectConflicts(next.entries) }, ...outcome };
}

/**
 * Restore a field to the value the official source gave.
 *
 * Reads the ORIGINAL section out of the source data rather than walking the
 * history backwards: history can contain several manual edits, and "restore
 * the source value" means the document's value, not the previous one.
 */
export function restoreFromSource(state, id, field, course, at = Date.now()) {
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return { state, applied: false, reason: 'no such entry' };
  const section = (course?.sections || []).find((s) => s.section === entry.section);
  if (!section) return { state, applied: false, reason: 'this section is not in the official timetable' };

  const value = field === 'meetings'
    ? (section.meetings || []).map((m) => ({ ...m }))
    : field === 'instructors'
      ? [...(section.instructors || [])]
      : section[field] ?? '';

  const next = mapEntry(state, id, (e) => ({
    ...e,
    [field]: value,
    provenance: {
      ...e.provenance,
      [field]: { source: 'document', ref: 'official timetable', at },
    },
    history: [...e.history, {
      at,
      action: 'restored',
      field,
      source: 'document',
      ref: 'official timetable',
      from: describeValue(field, e[field]),
      to: describeValue(field, value),
      detail: `${field} restored to the official timetable value`,
    }],
  }));
  return { state: { ...next, conflicts: detectConflicts(next.entries) }, applied: true, reason: '' };
}

function mapEntry(state, id, fn) {
  const entries = state.entries.map((e) => (e.id === id ? fn(e) : e));
  return { ...state, entries, updatedAt: Date.now() };
}

/**
 * Which entries a given source document or message changed, and how.
 *
 * THE LINK HAD ONLY EVER WORKED ONE WAY. An entry explains itself --
 * `provenance[field].ref` names the source and `explainEntry` reads it -- but
 * nothing could answer the reverse. That is the direction users actually ask
 * in: a room change is open in the reader and the question is "has this
 * already been applied to my timetable, or am I about to walk to the wrong
 * room?"
 *
 * The data was already there, in provenance and history. This only reads it.
 *
 * Grouped by ENTRY, not by field: one mail commonly moves a class and changes
 * its room, and reporting that as two links would show the same message twice.
 *
 * `previous` comes from the history record rather than from provenance,
 * because provenance holds only the current value -- the whole point is to be
 * able to say "5105 → 6104".
 *
 * @param {object} state  the timetable state
 * @param {string} ref    a message id, or a notice reference
 * @returns {{entry:object, fields:string[], current:string, previous:string}[]}
 */
export function entriesForMessage(state, ref) {
  // An empty ref must match nothing. Entries created before a source existed
  // can carry ref:'' in provenance, and a loose equality here would link every
  // one of them to "no message at all".
  if (!ref) return [];

  const out = [];
  for (const entry of state?.entries || []) {
    const fields = TRACKED_FIELDS.filter((f) => entry.provenance?.[f]?.ref === ref);
    if (!fields.length) continue;

    // Newest history record for this ref tells us what it replaced. Searching
    // backwards because a field can be changed more than once by the same
    // source, and the most recent transition is the one that still holds.
    const hist = [...(entry.history || [])].reverse();
    const last = hist.find((h) => h.ref === ref && fields.includes(h.field));

    out.push({
      entry,
      fields,
      current: last ? last.to : describeValue(fields[0], entry[fields[0]]),
      previous: last ? last.from : '',
    });
  }
  return out;
}

/* ========================================================================== *
 * DAYS & HOURS (shared with tools/parse-timetable.mjs)
 * ========================================================================== */

export const HOUR_START = {
  1: 8 * 60, 2: 9 * 60, 3: 10 * 60, 4: 11 * 60, 5: 12 * 60,
  6: 13 * 60, 7: 14 * 60, 8: 15 * 60, 9: 16 * 60, 10: 17 * 60,
  /*
   * SLOTS 11 AND 12 ARE USED BUT NOT DOCUMENTED.
   *
   * The legend stops at 10 (5-5:50PM). Yet EEE F111 meets at "T Th F 11",
   * BITS F332 at "W 11 12" and BITS F468 at "Th 11 12" — five courses in all.
   * Dropping them would silently lose real classes from real timetables;
   * inventing a time for them would be exactly the guessing this feature
   * forbids.
   *
   * So they continue the arithmetic the legend establishes — every slot is
   * the next hour — giving 6-6:50PM and 7-7:50PM, and they are tagged
   * `beyondLegend` so the UI can mark the time as needing confirmation. The
   * user sees a real class with a flagged time, not a missing class.
   */
  11: 18 * 60, 12: 19 * 60,
};
/** Slots the printed legend does not cover. Real, but worth flagging. */
export const BEYOND_LEGEND = new Set([11, 12]);
export const SLOT_MINUTES = 50;

export const PARSE_DAYS = ['M', 'T', 'W', 'Th', 'F', 'S'];
export const DAY_NAME = {
  M: 'Monday', T: 'Tuesday', W: 'Wednesday',
  Th: 'Thursday', F: 'Friday', S: 'Saturday',
};

/* ========================================================================== *
 * DAYS & HOURS
 * ========================================================================== */

/**
 * Parse a "DAYS & HOURS" cell into concrete meetings.
 *
 * The notation is a run of day tokens followed by an hour, repeated:
 *
 *   "M W F 9"        -> Mon/Wed/Fri at slot 9
 *   "M W 2 T 9"      -> Mon/Wed at slot 2, AND Tue at slot 9
 *   "M 6 7"          -> Mon at slots 6 AND 7 (a two-hour lab block)
 *   "T Th F 4"       -> Tue/Thu/Fri at slot 4
 *
 * So: accumulate days until a number appears; every number that follows binds
 * to the accumulated day set until the next day token resets it. "Th" must be
 * tested before "T" or every Thursday silently becomes a Tuesday.
 *
 * Returns [] for an unparseable cell rather than a guess. The caller marks the
 * record unresolved, which surfaces to the user.
 */
export function parseDaysHours(cell) {
  if (!cell) return [];
  const tokens = String(cell).trim().split(/\s+/).filter(Boolean);
  const meetings = [];
  let days = [];
  let pendingDays = [];

  for (const tok of tokens) {
    if (/^(Th|M|T|W|F|S)$/.test(tok)) {
      // A day token after an hour begins a NEW group: "M W 2 T 9" is two
      // groups, not one group of three days.
      if (pendingDays.length === 0 && days.length > 0) days = [];
      days.push(tok);
      pendingDays.push(tok);
      continue;
    }
    if (/^\d{1,2}$/.test(tok)) {
      const hour = Number(tok);
      if (!HOUR_START[hour]) return []; // out of the 1..10 range: not a slot
      pendingDays = [];
      for (const d of days) {
        const meeting = {
          day: d,
          dayName: DAY_NAME[d],
          hour,
          startMin: HOUR_START[hour],
          endMin: HOUR_START[hour] + SLOT_MINUTES,
        };
        // Flagged, not dropped: the class is real, the printed legend just
        // does not name this slot. The UI asks the user to confirm.
        if (BEYOND_LEGEND.has(hour)) meeting.beyondLegend = true;
        meetings.push(meeting);
      }
      continue;
    }
    return []; // an unexpected token: refuse the whole cell
  }
  // Day tokens with no hour after them describe nothing usable.
  return pendingDays.length > 0 && meetings.length === 0 ? [] : meetings;
}


/* ========================================================================== *
 * EXAMS
 * ========================================================================== */

/**
 * Exam session times, transcribed from the document's own legend.
 *
 *   10. MIDSEM EXAM DATE (Session)
 *       FN1: 9.00-10.30   FN2: 11.00-12.30   AN1: 14.00-15.30   AN2: 16.00-17.30
 *   11. COMPRE EXAM DATE (Session)
 *       FN: 9.00-12.00    AN: 14.00-17.00
 *
 * The numbered codes are 90-minute mid-semester slots; the bare ones are
 * three-hour comprehensives. That distinction is what tells a lone date in a
 * row which field it belongs to -- see the parser.
 *
 * A session code not listed here yields NO time rather than a guessed one.
 */
export const EXAM_SESSIONS = {
  FN1: [9 * 60, 10 * 60 + 30],
  FN2: [11 * 60, 12 * 60 + 30],
  AN1: [14 * 60, 15 * 60 + 30],
  AN2: [16 * 60, 17 * 60 + 30],
  FN: [9 * 60, 12 * 60],
  AN: [14 * 60, 17 * 60],
};

/**
 * Turn stored exam dates into typed events.
 *
 * The dates were parsed and stored from the beginning and then never modelled,
 * so nothing could render them and nothing could distinguish a mid-semester
 * test from a comprehensive. Pass 2 wants both as first-class event types.
 *
 * The document prints the date as `DD/MM` with no year, so no year is invented
 * here -- `date` stays exactly as the source wrote it. The clock time IS
 * derived, because the legend states it outright.
 *
 * @returns {{type:'midsem'|'compre', courseNo:string, section:string,
 *   entryId:string, date:string, session:string,
 *   startMin:number|null, endMin:number|null, time:string}[]}
 */
export function examEvents(entries) {
  const out = [];
  for (const e of entries || []) {
    for (const type of ['midsem', 'compre']) {
      const raw = (e[type] || '').trim();
      if (!raw) continue;
      const [date, session = ''] = raw.split(/\s+/);
      if (!date) continue;
      const slot = EXAM_SESSIONS[session] || null;
      out.push({
        type,
        courseNo: e.courseNo,
        section: e.section,
        entryId: e.id,
        date,
        session,
        startMin: slot ? slot[0] : null,
        endMin: slot ? slot[1] : null,
        time: slot ? `${fmtTime(slot[0])}-${fmtTime(slot[1])}` : '',
      });
    }
  }
  return out;
}

/* ========================================================================== *
 * CONFLICTS
 * ========================================================================== */

/**
 * Find everything wrong with the timetable as a whole.
 *
 * Recomputed from scratch on every mutation rather than maintained
 * incrementally. The list is at most a few dozen entries, and a conflict set
 * that drifts out of sync with the entries is worse than a cheap recompute.
 */
export function detectConflicts(entries) {
  const conflicts = [];

  // 1. Two classes in the same slot on the same day.
  const slots = new Map();
  for (const e of entries) {
    for (const m of e.meetings || []) {
      const key = `${m.day}:${m.hour}`;
      if (!slots.has(key)) slots.set(key, []);
      slots.get(key).push(e);
    }
  }
  for (const [key, list] of slots) {
    if (list.length < 2) continue;
    const [day, hour] = key.split(':');
    conflicts.push({
      kind: 'overlap',
      severity: 'blocking',
      day,
      hour: Number(hour),
      entryIds: list.map((e) => e.id),
      message:
        `${list.map((e) => `${e.courseNo} ${e.section}`).join(' and ')} are both on ` +
        `${DAY_NAME_LONG[day] || day} at hour ${hour}.`,
    });
  }

  // 2. A section whose value the source never supplied.
  for (const e of entries) {
    if (!e.unresolved.length) continue;
    conflicts.push({
      kind: 'unresolved',
      severity: 'needs-input',
      entryIds: [e.id],
      fields: [...e.unresolved],
      message:
        `${e.courseNo} ${e.section} has no ${e.unresolved.join(' or ')} in the ` +
        'official timetable. Enter it manually, or leave it blank.',
    });
  }

  // 3. A lecture whose linked tutorial or practical was never chosen.
  //    Only reported when the course HAS such sections and none is present.
  const byCourse = new Map();
  for (const e of entries) {
    if (!byCourse.has(e.comCode)) byCourse.set(e.comCode, []);
    byCourse.get(e.comCode).push(e);
  }
  for (const [comCode, list] of byCourse) {
    const pending = list.find((e) => e.pendingLink);
    if (pending) {
      conflicts.push({
        kind: 'missing-link',
        severity: 'needs-input',
        entryIds: [pending.id],
        message: `${pending.courseNo} needs a ${pending.pendingLink} section chosen.`,
      });
    }
  }

  /*
   * 4. Two DIFFERENT courses examined in the same date and session.
   *
   * The clash that actually matters. Two lectures overlapping is an
   * inconvenience you can work around; two comprehensives in the same slot is
   * something you must report to AUGSD, and this is the only place it becomes
   * visible before the day itself.
   *
   * Keyed on date+session, and grouped by COURSE -- a course's own sections,
   * or its midsem and compre falling on one date in different sessions, are
   * not clashes.
   */
  const examSlots = new Map();
  for (const ev of examEvents(entries)) {
    if (!ev.session) continue; // no session stated: nothing to compare
    const key = `${ev.date}|${ev.session}`;
    if (!examSlots.has(key)) examSlots.set(key, new Map());
    examSlots.get(key).set(ev.courseNo, ev);
  }
  for (const [key, byCourseNo] of examSlots) {
    if (byCourseNo.size < 2) continue;
    const [date, session] = key.split('|');
    const evs = [...byCourseNo.values()];
    conflicts.push({
      kind: 'exam-clash',
      severity: 'blocking',
      entryIds: evs.map((e) => e.entryId),
      message:
        `${evs.map((e) => e.courseNo).join(' and ')} are both examined on ` +
        `${date} in session ${session}. Contact AUGSD.`,
    });
  }

  /*
   * 5. A section whose linked lecture is no longer held.
   *
   * `linkedTo` records which lecture a tutorial or practical was attached to.
   * Removing just the lecture left the lab behind, still pointing at an entry
   * that no longer exists -- so the user saw a lab on Monday for a course they
   * believed they had dropped, with nothing to explain it.
   *
   * The lab is NOT auto-deleted. It is a real class on a real schedule, and
   * quietly removing one is worse than showing a broken link: the whole point
   * of this system is that nothing disappears without a reason the user can
   * read. Surfaced as needs-input so they decide.
   */
  const heldSections = new Set(entries.map((e) => `${e.comCode}|${e.section}`));
  for (const e of entries) {
    if (!e.linkedTo) continue;
    if (heldSections.has(`${e.comCode}|${e.linkedTo}`)) continue;
    conflicts.push({
      kind: 'orphan-link',
      severity: 'needs-input',
      entryIds: [e.id],
      message:
        `${e.courseNo} ${e.section} was attached to ${e.linkedTo}, which is no ` +
        'longer in your timetable. Keep it, or remove it.',
    });
  }

  // 6. The same section added twice.
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.id)) {
      conflicts.push({
        kind: 'duplicate',
        severity: 'blocking',
        entryIds: [e.id],
        message: `${e.courseNo} ${e.section} appears more than once.`,
      });
    }
    seen.add(e.id);
  }

  return conflicts;
}

const DAY_NAME_LONG = {
  M: 'Monday', T: 'Tuesday', W: 'Wednesday',
  Th: 'Thursday', F: 'Friday', S: 'Saturday',
};

/* ========================================================================== *
 * VIEWS
 * ========================================================================== */

/** The week, as a day -> sorted meetings map. For rendering a grid. */
export function weekView(entries) {
  const week = { M: [], T: [], W: [], Th: [], F: [], S: [] };
  for (const e of entries) {
    for (const m of e.meetings || []) {
      if (!week[m.day]) continue;
      week[m.day].push({
        entryId: e.id,
        courseNo: e.courseNo,
        title: e.title,
        section: e.section,
        kind: e.kind,
        room: e.room,
        instructors: e.instructors,
        hour: m.hour,
        startMin: m.startMin,
        endMin: m.endMin,
        beyondLegend: !!m.beyondLegend,
        locked: e.locked,
      });
    }
  }
  for (const d of Object.keys(week)) week[d].sort((a, b) => a.startMin - b.startMin);
  return week;
}

export function summariseMeetings(meetings) {
  if (!meetings || !meetings.length) return 'no scheduled time';
  const byHour = new Map();
  for (const m of meetings) {
    if (!byHour.has(m.hour)) byHour.set(m.hour, []);
    byHour.get(m.hour).push(m.day);
  }
  return [...byHour.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, days]) => {
      const sorted = days.slice().sort((x, y) => DAY_ORDER[x] - DAY_ORDER[y]);
      const m = meetings.find((z) => z.hour === hour);
      return `${sorted.join('/')} ${fmtTime(m.startMin)}-${fmtTime(m.endMin)}`;
    })
    .join(' · ');
}

export function fmtTime(min) {
  const h = Math.floor(min / 60);
  const mm = String(min % 60).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${ampm}`;
}

/**
 * Explain an entry: where every field came from, in plain words.
 *
 * This is the "source traceability" requirement made concrete. Anything the
 * UI shows about provenance comes from here, so there is one wording.
 */
export function explainEntry(entry) {
  const lines = [];
  for (const field of TRACKED_FIELDS) {
    if (field === 'daysHours') continue; // shown as part of meetings
    const p = entry.provenance?.[field];
    if (!p) continue;
    const value = describeValue(field, entry[field]);
    lines.push({
      field,
      value: value || '—',
      source: p.source,
      sourceLabel: SOURCE_LABEL[p.source],
      ref: p.ref,
      at: p.at,
      note: p.note || '',
    });
  }
  return lines;
}
