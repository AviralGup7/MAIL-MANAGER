import { STORAGE } from '../platform/storage.js';

/**
 * My courses: the enrolment scoping primitive.  (Features 58 and 55.)
 *
 * WHY THIS IS THE FIRST ACADEMIC THING BUILT
 * ------------------------------------------
 * The elimination pass called this a SCOPING PRIMITIVE rather than a feature,
 * and that is the correct reading. The timetable holds 688 courses and 1681
 * sections. Detecting a course number in a message is easy; deciding whether
 * the user CARES is the entire problem. Without enrolment, a mail mentioning
 * "CS F213" is tagged for a student who has never taken it, and every academic
 * signal downstream is noise wearing a badge.
 *
 * With it, `courseNumbersIn()` -- which already exists and is already tested --
 * becomes precise, and the two survivors that depend on it (the course chip and
 * room-change detection) become worth having.
 *
 * WHAT THIS DOES NOT BECOME
 *
 * It does not become a schedule screen, a planner, or a "my semester"
 * dashboard. Those were all cut on identity. This module stores a list of
 * section ids and answers questions about messages. The only thing it renders
 * is a chip on a mail row.
 *
 * THE MATCH IS DELIBERATELY ASYMMETRIC, AGAIN
 *
 * A message mentioning a course the user is NOT enrolled in is left alone --
 * no chip, no lane change, nothing. A message mentioning one they ARE enrolled
 * in is chipped. There is no third behaviour, and in particular no "probably
 * relevant" guess: a wrong course chip is a small lie on every row it appears
 * on, and the user stops reading chips entirely.
 */

const KEY = 'myCourses';

/**
 * @typedef {Object} Enrolment
 * @property {string} courseNo   'CS F111'
 * @property {string} [section]  'L1' -- optional; some people only know the course
 * @property {string} [comCode]
 */

/** Coerce storage into a usable list. Never throws. */
export function normaliseEnrolment(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const courseNo = typeof e.courseNo === 'string' ? e.courseNo.trim().toUpperCase() : '';
    if (!courseNo) continue;
    const section = typeof e.section === 'string' ? e.section.trim().toUpperCase() : '';
    // One entry per course+section. A duplicate is a UI bug, not data.
    const key = `${courseNo}|${section}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      courseNo,
      ...(section ? { section } : {}),
      ...(typeof e.comCode === 'string' && e.comCode ? { comCode: e.comCode } : {}),
    });
  }
  return out;
}

export async function loadEnrolment(storage = STORAGE) {
  try {
    const got = (await storage.get(KEY)) || {};
    return normaliseEnrolment(got[KEY]);
  } catch {
    return [];
  }
}

export async function saveEnrolment(list, storage = STORAGE) {
  try {
    await storage.set({ [KEY]: normaliseEnrolment(list) });
    return true;
  } catch {
    return false;
  }
}

/** Add a course, or update the section if it is already there. */
export function enrol(list, { courseNo, section, comCode }) {
  const norm = normaliseEnrolment([{ courseNo, section, comCode }]);
  if (norm.length === 0) return list;
  const [entry] = norm;
  const without = list.filter((e) => e.courseNo !== entry.courseNo);
  return [...without, entry];
}

export function unenrol(list, courseNo) {
  const want = String(courseNo || '').trim().toUpperCase();
  return list.filter((e) => e.courseNo !== want);
}

/**
 * Normalise a course number for comparison.
 *
 * BITS writes course numbers with inconsistent spacing everywhere -- "CS F111",
 * "CSF111", "CS  F111", "cs f111" all appear in real mail, sometimes in the
 * same message. Comparing raw strings finds about half of them.
 */
export function canonical(courseNo) {
  return String(courseNo || '').toUpperCase().replace(/[\s_-]+/g, '');
}

/** Is the user enrolled in this course? */
export function isEnrolled(list, courseNo) {
  const want = canonical(courseNo);
  return list.some((e) => canonical(e.courseNo) === want);
}

/** Their section for a course, if they recorded one. */
export function sectionFor(list, courseNo) {
  const want = canonical(courseNo);
  return list.find((e) => canonical(e.courseNo) === want)?.section || '';
}

/**
 * Which of the user's courses does this message mention?
 *
 * Takes the already-detected course numbers rather than re-scanning, so this
 * module never duplicates `timetable-mail.js`'s parser. One owner per concept.
 *
 * @param {string[]} detected  from courseNumbersIn()
 * @param {Enrolment[]} list
 * @returns {string[]} canonical-matched course numbers, in enrolment order
 */
export function mineAmong(detected, list) {
  if (!detected?.length || !list?.length) return [];
  const found = new Set(detected.map(canonical));
  return list.filter((e) => found.has(canonical(e.courseNo))).map((e) => e.courseNo);
}

/**
 * The chip to render on a message row.  (Feature 55.)
 *
 * Returns null when there is nothing to show, which is the common case, so the
 * caller can skip the DOM work entirely rather than rendering an empty span.
 *
 * ONE CHIP, NOT N. A message mentioning three of the user's courses gets the
 * first plus a count. Three chips on a row is a row that no longer scans, and
 * scanning is the only reason the list exists.
 *
 * @returns {{label:string, courseNo:string, more:number, title:string}|null}
 */
export function courseChip(detected, list) {
  const mine = mineAmong(detected, list);
  if (mine.length === 0) return null;
  const [first] = mine;
  const section = sectionFor(list, first);
  return {
    courseNo: first,
    label: first,
    more: mine.length - 1,
    // The tooltip carries what the chip has no room for.
    title:
      mine.length === 1
        ? `${first}${section ? ` · your section ${section}` : ''}`
        : `${mine.join(', ')}`,
  };
}

/* ========================================================================== *
 * BUILDING THE ENROLMENT FROM THE TIMETABLE
 * ========================================================================== */

/**
 * Look up a course in the parsed timetable.
 *
 * @param {{courses:Array}} data  src/timetable/data.json
 */
export function findCourse(data, courseNo) {
  const want = canonical(courseNo);
  return (data?.courses || []).find((c) => canonical(c.courseNo) === want) || null;
}

/** The sections a user could pick for a course, for the enrolment picker. */
export function sectionsOf(data, courseNo) {
  const c = findCourse(data, courseNo);
  if (!c) return [];
  return (c.sections || []).map((s) => ({
    section: s.section,
    kind: s.kind,
    instructor: s.inCharge || (s.instructors || [])[0] || '',
    room: s.room || '',
    daysHours: s.daysHours || '',
  }));
}

/**
 * The user's meetings for the week, derived from their enrolment.
 *
 * Exists for ONE consumer -- room-change detection needs to know the current
 * room and time to report a change against. It is deliberately not exposed as
 * a schedule view; that was cut.
 */
export function myMeetings(data, list) {
  const out = [];
  for (const e of list) {
    const course = findCourse(data, e.courseNo);
    if (!course) continue;
    for (const s of course.sections || []) {
      if (e.section && s.section !== e.section) continue;
      for (const m of s.meetings || []) {
        out.push({
          courseNo: course.courseNo,
          title: course.title,
          section: s.section,
          room: s.room || '',
          instructor: s.inCharge || '',
          ...m,
        });
      }
    }
  }
  return out;
}

/**
 * Enrol from a list of course numbers, resolving titles where possible.
 *
 * The onboarding path: the user types or pastes their six course numbers and
 * this fills in what the timetable knows.
 */
export function enrolMany(data, courseNumbers) {
  let list = [];
  for (const raw of courseNumbers || []) {
    const c = findCourse(data, raw);
    list = enrol(list, {
      courseNo: c ? c.courseNo : String(raw).trim().toUpperCase(),
      ...(c?.comCode ? { comCode: c.comCode } : {}),
    });
  }
  return list;
}
