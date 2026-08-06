#!/usr/bin/env node
/**
 * Parse the official BITS timetable + change notice into structured JSON.
 *
 * THIS IS A BUILD-TIME TOOL, NOT PART OF THE EXTENSION. It runs once against
 * the AUGSD documents and emits `src/timetable/data.json`, which ships as a
 * static asset. The app never parses a PDF at runtime.
 *
 * WHY A SEPARATE TOOL
 * -------------------
 * These files are PDF text extractions. The column order is scrambled, rows
 * wrap unpredictably, and the change notice interleaves "from" and "to" values
 * across three physical lines. That is exactly the kind of input where a
 * parser must be allowed to FAIL LOUDLY and be re-run, rather than silently
 * shipping half a timetable into someone's schedule.
 *
 * THE RULE THIS TOOL OBEYS: never invent a field. Every value emitted here is
 * a substring of the source document, or it is absent. Where the source is
 * ambiguous the record is emitted with `unresolved` set and the app asks the
 * user. There is no inference and no defaulting.
 *
 * Usage:
 *   node tools/parse-timetable.mjs <timetable.txt> <notice.txt> [out.json]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ========================================================================== *
 * HOUR MAP — read from the document's own legend, not hardcoded belief.
 * ========================================================================== */

/**
 * Slot number -> clock time, exactly as the LEGEND section states:
 *
 *   1 = 8-8:50AM   2 = 9-9:50AM   3 = 10-10:50AM  4 = 11-11:50AM  5 = 12-12:50PM
 *   6 = 1-1:50PM   7 = 2-2:50PM   8 = 3-3:50PM    9 = 4-4:50PM   10 = 5-5:50PM
 *
 * Encoded as minutes from midnight so overlap detection is integer maths.
 * Every BITS slot is 50 minutes starting on the hour.
 */
const HOUR_START = {
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
const BEYOND_LEGEND = new Set([11, 12]);
const SLOT_MINUTES = 50;

/** Verify the legend in the document still matches the table above. */
function verifyHourLegend(text) {
  // The legend prints the two rows of slot numbers followed by their times.
  // If AUGSD ever renumbers the slots this check fails and the tool stops,
  // rather than emitting a timetable that is silently an hour out.
  const norm = text.replace(/\s+/g, ' ');
  const checks = [
    /1 2 3 4 5 8 - 8:50A ?M 9 - 9:50AM 10 - 10:50AM 11 - 11:50AM 12 - 12:50 ?PM/,
    /6 7 8 9 10 1 - 1:50PM 2 - 2:50PM 3 - 3:5 ?0PM 4 - 4:50PM 5 - 5:50PM/,
  ];
  return checks.every((re) => re.test(norm));
}

const DAYS = ['M', 'T', 'W', 'Th', 'F', 'S'];
const DAY_NAME = {
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

/** "M W 2 T 9" -> "Mon, Wed 09:00-09:50 · Tue 16:00-16:50" */
export function describeMeetings(meetings) {
  const fmt = (m) => {
    const h = Math.floor(m / 60);
    const mm = String(m % 60).padStart(2, '0');
    return `${String(h).padStart(2, '0')}:${mm}`;
  };
  const byHour = new Map();
  for (const mt of meetings) {
    const k = mt.hour;
    if (!byHour.has(k)) byHour.set(k, []);
    byHour.get(k).push(mt.day);
  }
  return [...byHour.entries()]
    .map(([hour, days]) => {
      const s = HOUR_START[hour];
      return `${days.join(', ')} ${fmt(s)}-${fmt(s + SLOT_MINUTES)}`;
    })
    .join(' · ');
}

/* ========================================================================== *
 * THE COURSEWISE TIMETABLE
 * ========================================================================== */

/*
 * A course header row carries every column:
 *
 *   TITLE    COMCOD   COURSENO   L   P   T   S   U   SEC  INSTRUCTOR  ROOM  DAYS&HOURS  MIDSEM  COMPRE
 *   "INTRO TO BIO SCI    2863   BIO F101   2   1   -   -   3   L1   SHASHI PRAKASH SINGH   5102   M W 2   09/10 AN2   14/12 AN"
 *
 * Continuation rows carry only a section, and inherit the course above:
 *
 *   " L2   Shashi Prakash Singh   5102   M W 4   09/10 AN2   14/12 AN"
 *   " Tutorial   T1   Shashi Prakash Singh   6103   Th 7"
 *   " P2   Sandhya Amol Marathe   2206   T 3 4"
 *
 * A bare name on its own line is an ADDITIONAL INSTRUCTOR for the row above,
 * not a new section. Those are attached to the preceding section.
 */

const HEADER_RE = new RegExp(
  '^(?<title>[A-Z][A-Za-z0-9 &/,.()\'’:+-]*?)\\s{2,}' + // course title
  '(?<comcode>\\d{1,4})\\s{2,}' +                        // computer code
  '(?<courseNo>[A-Z][A-Z ]{1,10}\\s?[A-Z]?\\d{3}[A-Z]?)\\s{2,}' + // e.g. BIO F101
  '(?<credits>(?:[-\\d]+\\s{2,}){4,5})' +                // L P T S (U)
  '(?<sec>[LTP]\\d{1,2})\\s{2,}' +                       // section
  '(?<rest>.+)$'
);

const SECTION_RE = new RegExp(
  '^\\s*(?:(?<kind>Tutorial|Practical|Lecture)\\s{2,})?' +
  '(?<sec>[LTP]\\d{1,2})\\s{2,}(?<rest>.+)$'
);

/**
 * Split the tail of a row: INSTRUCTOR  ROOM  DAYS&HOURS  [MIDSEM]  [COMPRE]
 *
 * Room is the anchor: a 4-digit number, optionally with a parenthetical
 * qualifier like "1232(T" from a wrapped cell. Everything before it is the
 * instructor; the days/hours cell is what follows, up to the first exam date.
 */
function splitTail(rest) {
  /*
   * ROOM IS THE ANCHOR, and it has four real spellings in this document:
   *
   *   5105      the ordinary case
   *   2247A     a room with a letter suffix
   *   3254_I    a lab bay
   *   1232(T    a parenthetical that the PDF extractor truncated mid-cell
   *
   * The separator before the room is normally two spaces, but a long
   * instructor name in BLOCK CAPITALS can leave only one ("SYAMANTAK
   * MAJUMDER 1232(T"), so a single space is allowed when the room is followed
   * by a proper two-space gap. Getting this wrong silently drops the room AND
   * the time, because everything after the room is the days/hours cell.
   */
  /*
   * The unterminated-paren case needs its own alternative and must be tried
   * FIRST. "1232(T  T Th 2 F 9" has no closing bracket, so a greedy
   * `\([^)]*\)?` runs past the room and eats the days/hours cell with it --
   * the room came back as "1232(T  T Th 2 F 9   08/10 AN1" and the time was
   * lost. Bounding the fragment to a couple of characters keeps it to the
   * truncated cell it actually is.
   */
  const roomRe =
    /\s{1,}(?<room>\d{4}\([A-Za-z]{1,3}(?:\)|(?=\s))|\d{4}(?:[A-Za-z]|_[A-Za-z0-9]+|\([^)]{0,12}\))?)\s{2,}/;
  const m = rest.match(roomRe);
  if (!m) {
    /*
     * NO ROOM, BUT POSSIBLY STILL A TIME.
     *
     * Two different things produce a roomless row, and treating them alike
     * lost real data:
     *
     *   "L1   RAJDEEP CHOWDHURY"              a study project: no room, no time
     *   "P1   V Manjuladevi   F 8 9"          a lab with a time but no room
     *
     * BITS U104 has seven practicals of the second kind. Returning early here
     * discarded their times too, so the schedule showed a lab with no hours.
     * Try the trailing days/hours cell on its own before giving up.
     */
    const trail = rest.match(/\s{2,}((?:(?:Th|[MTWFS])\s+)+\d{1,2}(?:\s+\d{1,2})*)\s*$/);
    if (trail && parseDaysHours(trail[1]).length) {
      return {
        instructor: rest.slice(0, trail.index).trim(),
        room: '',
        daysHours: trail[1].trim(),
      };
    }
    // Genuinely roomless AND timeless: study projects, thesis, laboratory
    // projects and reading courses are scheduled with the instructor, not in
    // a room or a slot. They stay unresolved rather than invented.
    return { instructor: rest.trim(), room: '', daysHours: '' };
  }
  const instructor = rest.slice(0, m.index).trim();
  const after = rest.slice(m.index + m[0].length);

  // Exam dates look like "08/10 FN2" or "01/12 AN". They terminate the
  // days/hours cell. Tutorials and practicals simply have none.
  const examRe = /\s{2,}(\d{2}\/\d{2})\s+(FN\d?|AN\d?)\b/g;
  const exams = [...after.matchAll(examRe)];
  const daysHours = (exams.length ? after.slice(0, exams[0].index) : after).trim();

  /*
   * PLACE EXAM DATES BY SESSION, NOT BY POSITION.
   *
   * Most rows read "midsem then compre" and taking exams[0] as the midsem
   * works. Eleven sections list only ONE date, and it is the compre -- which
   * this code used to file as the mid-semester exam. CS F111, a first-year
   * core, showed its final exam as a midsem.
   *
   * The document's own legend settles it without any guessing:
   *
   *   10. MIDSEM EXAM DATE (Session)  FN1, FN2, AN1, AN2   90-minute slots
   *   11. COMPRE EXAM DATE (Session)  FN, AN               3-hour slots
   *
   * A NUMBERED session is a midsem; a BARE one is a compre. That is a fact
   * stated by the source, so it decides, and position is only a fallback for
   * a session string the legend does not describe.
   */
  const slots = { midsem: '', compre: '' };
  for (const e of exams) {
    const value = `${e[1]} ${e[2]}`;
    const numbered = /\d$/.test(e[2]);
    const field = numbered ? 'midsem' : 'compre';
    // First writer wins, so a malformed row with two compres keeps the first
    // rather than silently overwriting it.
    if (!slots[field]) slots[field] = value;
  }

  return {
    instructor,
    room: m.groups.room,
    daysHours,
    ...slots,
  };
}

const KIND_OF = { L: 'lecture', T: 'tutorial', P: 'practical' };

/** True for a line that is only a person's name (a co-instructor). */
function isBareName(line) {
  const t = line.trim();
  if (!t || t.length > 60) return false;
  if (/\d{3}/.test(t)) return false;              // rooms, codes, hours
  if (/^(Tutorial|Practical|Lecture|Note|Page)\b/i.test(t)) return false;
  return /^[A-Za-z][A-Za-z .'’()\u2010-\u2015-]*$/.test(t) && /[a-z]/i.test(t);
}

export function parseTimetable(text) {
  const lines = text.split(/\r?\n/);
  const courses = new Map();
  const problems = [];
  let current = null;      // the course being read
  let currentSec = null;   // the section being read
  let kindHint = null;     // set by a "Tutorial"/"Practical" label

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    // Page furniture repeats every ~36 lines and must never become data.
    if (/^\s*(Page\s|\d+\s*$|II\. COURSEWISE|CREDIT|INSTRUCTOR-IN-CHARGE|SEC\s|SESSION|U\/C|H$|Note:)/.test(raw)) {
      continue;
    }

    const h = raw.match(HEADER_RE);
    if (h) {
      const { title, comcode, courseNo, sec, rest } = h.groups;
      /*
       * THE COMPUTER CODE IS THE IDENTITY, NOT THE COURSE NUMBER.
       *
       * One course number can be offered twice as genuinely separate
       * offerings with different credit structures, for different programmes:
       *
       *   CASE STUDIES II        2488  BITS E584  ... 4 units
       *   CASE STUDY II          6008  BITS E584  ... 12 units
       *   RESEARCH METHODOLOGY I 2167  BITS G661  ... 5 units
       *   RESEARCH METHODOLOGY I 6041  BITS G661  ... 15 units
       *
       * Keying on the course number merged them, so the second offering's
       * L1 collided with the first's and was discarded by the duplicate
       * guard -- which is what "BITS E584 L1 room,time" reported twice.
       * A student registered for the 12-unit variant would have been shown
       * the 4-unit one's schedule.
       *
       * The computer code is unique per offering, so it is the key. Both
       * offerings are kept, and the UI shows the title and units to tell
       * them apart.
       */
      const key = comcode;
      const courseNoClean = courseNo.replace(/\s+/g, ' ').trim();
      if (!courses.has(key)) {
        courses.set(key, {
          comCode: comcode,
          courseNo: courseNoClean,
          title: title.replace(/\s+/g, ' ').trim(),
          credits: h.groups.credits.trim().split(/\s{2,}/).filter(Boolean),
          sections: [],
        });
      }
      current = courses.get(key);
      kindHint = null;
      currentSec = addSection(current, sec, rest, problems, key);
      continue;
    }

    if (!current) continue;

    // A standalone "Tutorial" / "Practical" label applies to the rows below.
    const label = raw.match(/^\s*(Tutorial|Practical|Lecture)\s*$/);
    if (label) { kindHint = label[1].toLowerCase(); continue; }

    const s = raw.match(SECTION_RE);
    if (s) {
      if (s.groups.kind) kindHint = s.groups.kind.toLowerCase();
      currentSec = addSection(current, s.groups.sec, s.groups.rest, problems, current.comCode);
      continue;
    }

    // Otherwise: a co-instructor for the section immediately above.
    if (currentSec && isBareName(raw)) {
      currentSec.instructors.push(raw.trim());
    }
  }

  return { courses: [...courses.values()], problems };
}


/**
 * Is this name written in BLOCK CAPITALS, as the legend uses for the
 * instructor-in-charge?
 *
 * Ignores anything that is not a letter, so "V MANJULADEVI(RS)" and
 * "A. K. SHARMA" still count. Requires at least two letters overall, because
 * a single initial tells us nothing about the writer's intent.
 */
function isBlockCaps(name) {
  const letters = String(name).replace(/[^A-Za-z]/g, '');
  if (letters.length < 2) return false;
  return letters === letters.toUpperCase();
}

function addSection(course, sec, rest, problems, courseKey) {
  const tail = splitTail(rest);
  const meetings = parseDaysHours(tail.daysHours);
  const kind = KIND_OF[sec[0]];

  const entry = {
    section: sec,
    kind,
    /*
     * INSTRUCTOR-IN-CHARGE, per legend section 6: "Name in BLOCK LETTERS
     * indicates INSTRUCTOR-IN-CHARGE. Other Names are of Instructors."
     *
     * Recorded from the FIRST row of a section only, because continuation
     * rows carry co-instructors in mixed case. If the section's own name is
     * not in block capitals the document has not marked one, and '' is the
     * honest answer -- picking "probably the first" is exactly the guess this
     * parser refuses to make.
     *
     * Requires two letters so an initial ("A K Sharma") is not mistaken for
     * a capitalised full name.
     */
    inCharge: tail.instructor && isBlockCaps(tail.instructor) ? tail.instructor : '',
    instructors: tail.instructor ? [tail.instructor] : [],
    room: tail.room,
    daysHours: tail.daysHours,
    meetings,
    midsem: tail.midsem || '',
    compre: tail.compre || '',
    // A section we could not fully read is KEPT, flagged, and shown to the
    // user as needing a manual choice. Dropping it would silently shrink the
    // course; guessing would silently corrupt it.
    unresolved: [],
  };
  if (!tail.room) entry.unresolved.push('room');
  if (!meetings.length) entry.unresolved.push('time');
  if (!entry.instructors.length) entry.unresolved.push('instructor');
  if (entry.unresolved.length) {
    problems.push({
      comCode: courseKey,
      courseNo: course.courseNo,
      section: sec,
      missing: entry.unresolved,
    });
  }

  // A repeated section number is a parse fault, not real data.
  const dup = course.sections.find((x) => x.section === sec);
  if (dup) return dup;
  course.sections.push(entry);
  return entry;
}

/* ========================================================================== *
 * THE CHANGE NOTICE
 * ========================================================================== */

/*
 * The notice is grouped under lettered headings, and each row names a course
 * by COMPUTER CODE (not course number) plus a section. Rows wrap badly: the
 * "from" and "to" values often sit on the lines above and below the row that
 * carries the code.
 *
 * Rather than reconstruct every wrapped cell — which is where a parser starts
 * inventing things — this extracts the parts that are UNAMBIGUOUS: the change
 * TYPE, the computer code, the section, and the course number. Those alone are
 * enough to tell the user "AUGSD changed the room for MATH F215 T2, here is
 * the notice", which is honest, and better than a confidently wrong room.
 */

const CHANGE_TYPES = [
  [/A\.\s*New Course\/Section Offered/i, 'new-section'],
  [/B\.\s*Change of Room/i, 'room'],
  [/C\.\s*Change of IC\/Instructor/i, 'instructor'],
  [/D\.\s*Change of Class Time/i, 'time'],
  [/E\.\s*Change of Compre Exam Date/i, 'compre'],
];

export function parseNotice(text) {
  const lines = text.split(/\r?\n/);
  const changes = [];
  let type = null;

  // "w.e.f. 05-Aug-2026" — the date the changes take effect.
  /*
   * The PDF extractor puts spaces INSIDE numbers: the notice reads
   * "w.e.f.   0 5 - Aug - 2026". Matching digit-by-digit and then stripping
   * whitespace is the only reading that survives that. A stricter regex
   * silently produced an empty effective date, which would have shipped a
   * change set with no "as of when".
   */
  const eff = text
    .replace(/\s+/g, ' ')
    .match(/w\.e\.f\.\s*([0-9](?:\s*[0-9])?)\s*-\s*([A-Za-z]{3})\s*-\s*([0-9](?:\s*[0-9]){3})/i);
  const effective = eff
    ? `${eff[1].replace(/\s/g, '').padStart(2, '0')}-${eff[2]}-${eff[3].replace(/\s/g, '')}`
    : '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const t = CHANGE_TYPES.find(([re]) => re.test(line));
    if (t) { type = t[1]; continue; }
    if (!type) continue;

    // A change row: <comcode> ... <SEC> ... <COURSE NO>
    const code = line.match(/^\s*(\d{1,4})\s{2,}/);
    const courseNo = line.match(/([A-Z][A-Z ]{1,10}\s?[A-Z]?\d{3}[A-Z]?)\s*$/);
    const sec = line.match(/\s(?:^|\s)([LTP]\d{1,2})(?:\s|$)/);
    if (!code || !courseNo) continue;

    changes.push({
      type,
      comCode: code[1],
      courseNo: courseNo[1].replace(/\s+/g, ' ').trim(),
      section: sec ? sec[1] : '',
      // The raw line is kept verbatim so the UI can always show the user the
      // exact text AUGSD published, rather than our reading of it.
      raw: line,
      effective,
    });
  }
  return { effective, changes };
}

/* ========================================================================== *
 * MAIN
 * ========================================================================== */

/*
 * Default the inputs from the REPO, not from the shell's cwd.
 *
 * The two classifier generators shipped with defaults pointing at an uploads
 * directory that existed on exactly one machine, so `npm run` reproduced
 * nothing anywhere else. This tool had the opposite failure: no defaults at
 * all, so regenerating meant remembering two long filenames and the argument
 * order. Both make a GENERATED artifact hard to regenerate, which is how a
 * generated artifact quietly becomes hand-maintained.
 *
 * The sources are committed under src/timetable/sources/, so they can be
 * resolved relative to this file and `npm run timetable` just works.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DEFAULTS = {
  tt: resolve(REPO, 'src/timetable/sources/Timetable_05_Aug_2026_f4b34f8b-8fb7-4f3a-905e-714ab50065a5.txt'),
  notice: resolve(REPO, 'src/timetable/sources/TIMETABLE_CHANGES_NOTICE_4thAug26_1.txt'),
  out: resolve(REPO, 'src/timetable/data.json'),
};

function main() {
  const [argTt, argNotice, argOut] = process.argv.slice(2);
  const ttPath = argTt || DEFAULTS.tt;
  const noticePath = argNotice || DEFAULTS.notice;
  const outPath = argOut || DEFAULTS.out;
  const ttText = readFileSync(ttPath, 'utf8');
  const noticeText = readFileSync(noticePath, 'utf8');

  if (!verifyHourLegend(ttText)) {
    console.error(
      'REFUSING TO PARSE: the hour legend in this document does not match the\n' +
      'slot times this tool encodes. Slots may have been renumbered. Check the\n' +
      'LEGEND section and update HOUR_START before re-running.'
    );
    process.exit(1);
  }

  const { courses, problems } = parseTimetable(ttText);
  const notice = parseNotice(noticeText);

  const secCount = courses.reduce((n, c) => n + c.sections.length, 0);
  const out = {
    schemaVersion: 1,
    semester: 'FIRST SEMESTER 2026-2027',
    generatedAt: new Date().toISOString(),
    sources: {
      timetable: ttPath.split('/').pop(),
      notice: noticePath.split('/').pop(),
      noticeEffective: notice.effective,
    },
    hourMap: Object.fromEntries(
      Object.entries(HOUR_START).map(([h, s]) => [h, { startMin: s, endMin: s + SLOT_MINUTES }])
    ),
    courses,
    changes: notice.changes,
  };

  const dest = outPath;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(out));

  console.log(`courses:        ${courses.length}`);
  console.log(`sections:       ${secCount}`);
  console.log(`notice changes: ${notice.changes.length} (w.e.f. ${notice.effective})`);
  console.log(`unresolved:     ${problems.length}`);
  console.log(`written:        ${dest}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
