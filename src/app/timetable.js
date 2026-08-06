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
    instructors: [...(section.instructors || [])],
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
export function manualEdit(state, id, field, value, at = Date.now()) {
  let outcome = null;
  const next = mapEntry(state, id, (e) => {
    const r = applyFieldChange(e, field, value, { source: 'manual', ref: 'user', at });
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

  // 4. The same section added twice.
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
