/**
 * Timetable model, mail rules and persistence.
 *
 * The rule these tests enforce above all others: THE SYSTEM NEVER INVENTS A
 * VALUE. Several of these are written specifically to fail if someone later
 * "improves" the builder by adding a plausible-looking heuristic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  emptyState, entryId, addCourse, removeCourse, makeEntry,
  applyFieldChange, manualEdit, setLocked, restoreFromSource,
  detectConflicts, linkedSections, instructorsFor, sectionsByKind,
  weekView, summariseMeetings, explainEntry, entriesForMessage, examEvents,
  parseDaysHours, switchSection, finalize, resetTimetable,
  validateAgainstSource, PRECEDENCE,
} from '../src/app/timetable.js';

import {
  scanMessage, scanMessages, matchNotice,
  isAcademicSender, courseNumbersIn, sectionsIn,
} from '../src/app/timetable-mail.js';

import {
  loadTimetable, saveTimetable, clearTimetable,
  searchCourses, courseByComCode, loadSourceData, _resetSourceData,
} from '../src/app/timetable-store.js';

// parseDaysHours is DOMAIN (the app reads class times out of change notices);
// parseNotice/parseTimetable are build-time only.
import { parseNotice, parseTimetable } from '../tools/parse-timetable.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* --------------------------------------------------------------- fixtures -- */

const CS = {
  comCode: '1008',
  courseNo: 'CS F111',
  title: 'COMPUTER PROGRAMMING',
  credits: ['3', '1', '-', '-', '4'],
  sections: [
    {
      section: 'L1', kind: 'lecture', instructors: ['VINTI AGARWAL'], room: '5105',
      daysHours: 'M W 3 Th 9',
      meetings: [
        { day: 'M', dayName: 'Monday', hour: 3, startMin: 600, endMin: 650 },
        { day: 'W', dayName: 'Wednesday', hour: 3, startMin: 600, endMin: 650 },
        { day: 'Th', dayName: 'Thursday', hour: 9, startMin: 960, endMin: 1010 },
      ],
      midsem: '', compre: '02/12 AN', unresolved: [],
    },
    {
      section: 'L2', kind: 'lecture', instructors: ['Yash Sinha'], room: '5105',
      daysHours: 'M W 2 T 8',
      meetings: [
        { day: 'M', dayName: 'Monday', hour: 2, startMin: 540, endMin: 590 },
        { day: 'W', dayName: 'Wednesday', hour: 2, startMin: 540, endMin: 590 },
        { day: 'T', dayName: 'Tuesday', hour: 8, startMin: 900, endMin: 950 },
      ],
      midsem: '', compre: '02/12 AN', unresolved: [],
    },
    {
      section: 'P1', kind: 'practical', instructors: ['Manasvi Singh(RS)'], room: '6117',
      daysHours: 'M 6 7',
      meetings: [
        { day: 'M', dayName: 'Monday', hour: 6, startMin: 780, endMin: 830 },
        { day: 'M', dayName: 'Monday', hour: 7, startMin: 840, endMin: 890 },
      ],
      midsem: '', compre: '', unresolved: [],
    },
    {
      section: 'P2', kind: 'practical', instructors: ['Radhika Bohra(RS)'], room: '6118',
      daysHours: 'M 6 7',
      meetings: [
        { day: 'M', dayName: 'Monday', hour: 6, startMin: 780, endMin: 830 },
        { day: 'M', dayName: 'Monday', hour: 7, startMin: 840, endMin: 890 },
      ],
      midsem: '', compre: '', unresolved: [],
    },
  ],
};

/** A course with exactly one tutorial: the deterministic auto-attach case. */
const ONE_TUT = {
  comCode: '2863',
  courseNo: 'BIO F101',
  title: 'INTRO TO BIO SCI',
  sections: [
    {
      section: 'L1', kind: 'lecture', instructors: ['SHASHI PRAKASH SINGH'], room: '5102',
      daysHours: 'M W 2',
      meetings: [
        { day: 'M', dayName: 'Monday', hour: 2, startMin: 540, endMin: 590 },
        { day: 'W', dayName: 'Wednesday', hour: 2, startMin: 540, endMin: 590 },
      ],
      unresolved: [],
    },
    {
      section: 'T1', kind: 'tutorial', instructors: ['Shashi Prakash Singh'], room: '6103',
      daysHours: 'Th 7',
      meetings: [{ day: 'Th', dayName: 'Thursday', hour: 7, startMin: 840, endMin: 890 }],
      unresolved: [],
    },
  ],
};

const fakeStorage = () => {
  const data = {};
  return {
    data,
    async get(k) { return k in data ? { [k]: data[k] } : {}; },
    async set(obj) { Object.assign(data, obj); },
    async remove(k) { delete data[k]; },
  };
};

const build = (course = CS, lectureSec = 'L1') => {
  const lecture = course.sections.find((s) => s.section === lectureSec);
  return addCourse(emptyState(), course, { lecture, ref: 'official timetable' });
};

/* ============================================================== the parser == */

test('PARSE: days and hours become concrete meetings', () => {
  // "M W 2 T 9" is TWO groups: Mon+Wed at hour 2, and Tue at hour 9. Reading
  // it as one group of three days is the obvious wrong answer.
  const m = parseDaysHours('M W 2 T 9');
  assert.deepEqual(
    m.map((x) => `${x.day}${x.hour}`),
    ['M2', 'W2', 'T9']
  );
  assert.equal(m[0].startMin, 9 * 60, 'hour 2 is 9:00 AM per the legend');
  assert.equal(m[0].endMin, 9 * 60 + 50, 'slots are 50 minutes');
});

test('PARSE: Th is Thursday, never a Tuesday followed by an h', () => {
  const m = parseDaysHours('T Th F 4');
  assert.deepEqual(m.map((x) => x.day), ['T', 'Th', 'F']);
  assert.equal(m[1].dayName, 'Thursday');
});

test('PARSE: a multi-hour lab block becomes several meetings', () => {
  // "M 6 7" is a two-hour lab, not a lab at "hour 67".
  const m = parseDaysHours('M 6 7');
  assert.equal(m.length, 2);
  assert.deepEqual(m.map((x) => x.hour), [6, 7]);
});

test('PARSE: an unreadable cell yields nothing rather than a guess', () => {
  // Each of these is malformed in a different way. None may produce a
  // plausible-looking meeting, because a wrong time is worse than no time.
  for (const bad of ['', 'TBA', 'M W', 'X 3', 'M 99', 'see notice']) {
    assert.deepEqual(parseDaysHours(bad), [], `"${bad}" must not parse`);
  }
});

test('PARSE: the real timetable document parses to known-good values', () => {
  // Ground truth read by eye from the source PDF text. If the parser drifts,
  // this is the test that notices.
  const text = readFileSync(
    join(ROOT, 'src/timetable/sources/Timetable_05_Aug_2026_f4b34f8b-8fb7-4f3a-905e-714ab50065a5.txt'),
    'utf8'
  );
  const { courses } = parseTimetable(text);

  const cs = courses.find((c) => c.comCode === '1008');
  assert.equal(cs.courseNo, 'CS F111');
  assert.equal(cs.title, 'COMPUTER PROGRAMMING');
  const l1 = cs.sections.find((s) => s.section === 'L1');
  assert.deepEqual(l1.instructors, ['VINTI AGARWAL']);
  assert.equal(l1.room, '5105');
  assert.equal(l1.daysHours, 'M W 3 Th 9');

  // Co-instructors on their own lines attach to the section above.
  const bio = courses.find((c) => c.comCode === '2863');
  const bioL1 = bio.sections.find((s) => s.section === 'L1');
  assert.equal(bioL1.instructors.length, 3, 'BIO F101 L1 has three instructors');

  // One course number, two genuinely different offerings, kept apart.
  const e584 = courses.filter((c) => c.courseNo === 'BITS E584');
  assert.equal(e584.length, 2, 'both offerings of BITS E584 must survive');
  assert.notEqual(e584[0].comCode, e584[1].comCode);
});

test('PARSE: the change notice yields its effective date and rows', () => {
  const text = readFileSync(
    join(ROOT, 'src/timetable/sources/TIMETABLE_CHANGES_NOTICE_4thAug26_1.txt'),
    'utf8'
  );
  const { effective, changes } = parseNotice(text);
  // The extractor writes "0 5 - Aug - 2026", with spaces inside the number.
  assert.equal(effective, '05-Aug-2026');
  assert.ok(changes.length > 50, `expected many changes, got ${changes.length}`);
  assert.ok(changes.every((c) => c.comCode && c.courseNo), 'every row needs an identity');
  assert.ok(changes.some((c) => c.type === 'room'));
  assert.ok(changes.some((c) => c.type === 'instructor'));
});

/* ================================================================ building == */

test('BUILD: adding a course creates a traceable entry', () => {
  const { state, added } = build();
  assert.equal(added.length, 1);
  const e = state.entries[0];
  assert.equal(e.id, entryId('1008', 'L1'));
  assert.equal(e.courseNo, 'CS F111');
  assert.equal(e.room, '5105');
  assert.equal(e.provenance.room.source, 'document');
  assert.equal(e.history[0].action, 'added');
});

test('BUILD: a single tutorial attaches automatically', () => {
  // One option means there is no choice to make, so making it is deterministic.
  const links = linkedSections(ONE_TUT, 'L1');
  assert.equal(links.auto.length, 1);
  assert.equal(links.auto[0].section.section, 'T1');
  assert.equal(links.auto[0].reason, 'only-option');
  assert.equal(links.choose.length, 0);
});

test('BUILD: several practicals must be CHOSEN, never guessed', () => {
  /*
   * THE CENTRAL ANTI-GUESSING TEST.
   *
   * CS F111 L1 has two practicals. The BITS document prints no lecture-to-lab
   * mapping, so "L1 goes with P1" is numerology, not data. If someone later
   * adds that heuristic, `auto` becomes non-empty and this fails.
   */
  const links = linkedSections(CS, 'L1');
  assert.equal(links.auto.length, 0, 'nothing may be auto-attached from an ambiguous set');
  assert.equal(links.choose.length, 1);
  assert.equal(links.choose[0].kind, 'practical');
  assert.equal(links.choose[0].options.length, 2);
});

test('BUILD: instructors are listed for selection, deduplicated', () => {
  const names = instructorsFor(CS);
  assert.deepEqual(names, ['VINTI AGARWAL', 'Yash Sinha']);
  // Case differences are the same person: the header row shouts, the
  // continuation rows do not.
  const dupe = { sections: [
    { kind: 'lecture', instructors: ['HARI OM BANSAL'] },
    { kind: 'lecture', instructors: ['Hari Om Bansal'] },
  ] };
  assert.equal(instructorsFor(dupe).length, 1);
});

test('BUILD: adding the same section twice does not duplicate it', () => {
  const first = build();
  const lecture = CS.sections[0];
  const second = addCourse(first.state, CS, { lecture, ref: 'official timetable' });
  assert.equal(second.state.entries.length, 1);
  assert.equal(second.added.length, 0);
});

test('BUILD: sections are grouped by kind', () => {
  const k = sectionsByKind(CS);
  assert.equal(k.lecture.length, 2);
  assert.equal(k.practical.length, 2);
  assert.equal(k.tutorial.length, 0);
});

/* ============================================================== precedence == */

test('PRECEDENCE: a higher source overwrites a lower one', () => {
  const { state } = build();
  const e = state.entries[0];
  const r = applyFieldChange(e, 'room', '6101', { source: 'notice', ref: 'AUGS/T/5' });
  assert.equal(r.applied, true);
  assert.equal(r.entry.room, '6101');
  assert.equal(r.entry.provenance.room.source, 'notice');
});

test('PRECEDENCE: a lower source never overwrites a higher one', () => {
  const { state } = build();
  const manual = manualEdit(state, state.entries[0].id, 'room', '9999');
  const e = manual.state.entries[0];

  // An official notice is precedence 4; the manual edit is 5.
  const r = applyFieldChange(e, 'room', '6101', { source: 'notice', ref: 'AUGS/T/5' });
  assert.equal(r.applied, false);
  assert.equal(r.entry.room, '9999', "the user's value must survive");
  assert.match(r.reason, /kept your edit/);
});

test('PRECEDENCE: mail cannot override the official document', () => {
  // mail=2, document=3. This is the ordering that stops a stray email from
  // rewriting the timetable.
  assert.ok(PRECEDENCE.mail < PRECEDENCE.document);
  const { state } = build();
  const r = applyFieldChange(state.entries[0], 'room', '1234', {
    source: 'mail', ref: 'msg-1',
  });
  assert.equal(r.applied, false);
  assert.equal(r.entry.room, '5105');
});

test('PRECEDENCE: two equal sources that disagree become a conflict', () => {
  const { state } = build();
  const first = applyFieldChange(state.entries[0], 'room', '6101', {
    source: 'notice', ref: 'notice-A',
  });
  const second = applyFieldChange(first.entry, 'room', '6102', {
    source: 'notice', ref: 'notice-B',
  });
  assert.equal(second.applied, false);
  assert.equal(second.conflict, true, 'the user must decide, not arrival order');
});

test('PRECEDENCE: re-applying the same source and value is idempotent', () => {
  // The mail scan runs on every sync. Applying an unchanged value again must
  // not append history forever.
  const { state } = build();
  const r1 = applyFieldChange(state.entries[0], 'room', '6101', {
    source: 'notice', ref: 'notice-A',
  });
  const r2 = applyFieldChange(r1.entry, 'room', '6101', {
    source: 'notice', ref: 'notice-A',
  });
  assert.equal(r2.applied, false);
  assert.equal(r2.entry.history.length, r1.entry.history.length);
});

/* =================================================================== locks == */

test('LOCK: a locked entry refuses automatic updates but reports them', () => {
  const { state } = build();
  const locked = setLocked(state, state.entries[0].id, true);
  const r = applyFieldChange(locked.entries[0], 'room', '6101', {
    source: 'notice', ref: 'AUGS/T/5',
  });
  assert.equal(r.applied, false);
  assert.equal(r.needsPermission, true, 'the user must be offered the change');
  assert.match(r.reason, /locked/);
});

test('LOCK: a manual edit still works on a locked entry', () => {
  // The lock protects against AUTOMATIC change; it must not lock the user out
  // of their own timetable.
  const { state } = build();
  const locked = setLocked(state, state.entries[0].id, true);
  const r = manualEdit(locked, locked.entries[0].id, 'room', '7777');
  assert.equal(r.applied, true);
  assert.equal(r.state.entries[0].room, '7777');
});

/* ================================================================= restore == */

test('RESTORE: a field returns to the official value, not the previous one', () => {
  /*
   * Two manual edits, then restore. Walking history backwards would return
   * the FIRST edit; "restore the source value" must return the document's.
   */
  const { state } = build();
  const a = manualEdit(state, state.entries[0].id, 'room', 'AAAA');
  const b = manualEdit(a.state, a.state.entries[0].id, 'room', 'BBBB');
  const r = restoreFromSource(b.state, b.state.entries[0].id, 'room', CS);
  assert.equal(r.applied, true);
  assert.equal(r.state.entries[0].room, '5105', 'must be the document value');
  assert.equal(r.state.entries[0].provenance.room.source, 'document');
});

/* =============================================================== conflicts == */

test('CONFLICT: two classes in one slot are detected', () => {
  const { state } = build(CS, 'L1');            // Mon hour 3
  const clash = {
    ...CS, comCode: '9999', courseNo: 'XX F999',
    sections: [{
      section: 'L1', kind: 'lecture', instructors: ['Someone'], room: '1111',
      daysHours: 'M 3',
      meetings: [{ day: 'M', dayName: 'Monday', hour: 3, startMin: 600, endMin: 650 }],
      unresolved: [],
    }],
  };
  const { state: s2 } = addCourse(state, clash, { lecture: clash.sections[0] });
  const overlap = s2.conflicts.filter((c) => c.kind === 'overlap');
  assert.equal(overlap.length, 1);
  assert.equal(overlap[0].severity, 'blocking');
  assert.match(overlap[0].message, /Monday/);
  assert.equal(overlap[0].entryIds.length, 2);
});

test('CONFLICT: a section the document could not describe is surfaced', () => {
  const vague = {
    comCode: '1651', courseNo: 'BIO F266', title: 'STUDY PROJECT',
    sections: [{
      section: 'L1', kind: 'lecture', instructors: ['RAJDEEP CHOWDHURY'],
      room: '', daysHours: '', meetings: [], unresolved: ['room', 'time'],
    }],
  };
  const { state } = addCourse(emptyState(), vague, { lecture: vague.sections[0] });
  const c = state.conflicts.find((x) => x.kind === 'unresolved');
  assert.ok(c, 'an incomplete section must be reported, not hidden');
  assert.deepEqual(c.fields, ['room', 'time']);
  // And it must NOT have been filled with anything.
  assert.equal(state.entries[0].room, '');
  assert.deepEqual(state.entries[0].meetings, []);
  assert.equal(state.entries[0].provenance.room.source, 'unresolved');
});

test('CONFLICT: a clean timetable reports nothing', () => {
  const { state } = build(ONE_TUT, 'L1');
  const withTut = addCourse(state, ONE_TUT, {
    lecture: ONE_TUT.sections[0],
    extraSections: [ONE_TUT.sections[1]],
  });
  assert.deepEqual(withTut.state.conflicts, []);
});

/* ============================================================= mail rules == */

const msg = (over = {}) => ({
  id: 'm1',
  from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
  subject: '',
  snippet: '',
  body: '',
  ...over,
});

test('MAIL: a non-academic sender is ignored entirely', () => {
  const { state } = build();
  const m = msg({
    from: 'Someone <hello@gmail.com>',
    subject: 'CS F111 L1 room changed',
    body: 'The class has been shifted to room 9999.',
  });
  assert.deepEqual(scanMessage(m, state), []);
  assert.equal(isAcademicSender('x@pilani.bits-pilani.ac.in'), true);
  assert.equal(isAcademicSender('x@gmail.com'), false);
});

test('MAIL: a course not in the timetable is ignored', () => {
  // The departmental list mails about everything. Only what the user has
  // registered for may be touched.
  const { state } = build();
  const m = msg({
    subject: 'MATH F211 room change',
    body: 'MATH F211 L1 has been shifted to room 6101.',
  });
  assert.deepEqual(scanMessage(m, state), []);
});

test('MAIL: a room change with a stated room is actionable', () => {
  const { state } = build();
  const m = msg({
    subject: 'CS F111 L1 venue',
    body: 'From Monday, CS F111 L1 will be held in room 6101.',
  });
  const f = scanMessage(m, state);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'room');
  assert.equal(f[0].field, 'room');
  assert.equal(f[0].value, '6101');
  assert.equal(f[0].actionable, true);
  assert.match(f[0].evidence, /6101/, 'the user must see the sentence');
});

test('MAIL: an instructor change is reported but never applied', () => {
  /*
   * DELIBERATE LIMIT. A person's name cannot be delimited in free prose
   * without guessing where it ends, and a silently wrong instructor is the
   * kind of error nobody notices until it matters. So: notify, do not act.
   */
  const { state } = build();
  const m = msg({
    subject: 'CS F111 L1',
    body: 'CS F111 L1 will be taught by Dr. Someone Else from next week.',
  });
  const f = scanMessage(m, state);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'instructor');
  assert.equal(f[0].actionable, false, 'must not auto-apply a parsed name');
  assert.equal(f[0].value, null);
});

test('MAIL: a matched pattern with no stated value degrades to a notification', () => {
  const { state } = build();
  const m = msg({
    subject: 'CS F111 L1 room',
    body: 'The room for CS F111 L1 will change. Details to follow.',
  });
  const f = scanMessage(m, state);
  assert.equal(f.length, 1);
  assert.equal(f[0].actionable, false, 'no room number was stated, so none may be applied');
});

test('MAIL: cancellations, extra classes and exams are recognised', () => {
  const { state } = build();
  const cases = [
    ['Tomorrow\'s CS F111 L1 lecture is cancelled.', 'cancellation'],
    ['An extra class for CS F111 L1 will be held on Saturday.', 'extra-class'],
    ['Quiz 1 for CS F111 L1 is scheduled on 20 September.', 'exam'],
  ];
  for (const [body, kind] of cases) {
    const f = scanMessage(msg({ body }), state);
    assert.ok(f.some((x) => x.kind === kind), `"${body}" should yield ${kind}`);
  }
});

test('MAIL: unrelated academic mail produces nothing', () => {
  const { state } = build();
  const m = msg({
    subject: 'Library timings',
    body: 'The library will remain open until midnight during CS F111 week.',
  });
  const f = scanMessage(m, state);
  // It names a course the user has, but matches no supported pattern.
  assert.deepEqual(f, []);
});

test('MAIL: course numbers are recognised however they are written', () => {
  assert.deepEqual(courseNumbersIn('see CS F111 today'), ['CS F111']);
  assert.deepEqual(courseNumbersIn('CSF111'), ['CS F111']);
  assert.deepEqual(courseNumbersIn('cs-f111'), ['CS F111']);
  assert.deepEqual(sectionsIn('sections L1 and P12 affected').sort(), ['L1', 'P12']);
});

test('MAIL: an already-applied message is not scanned again', () => {
  // Idempotence: this runs on every sync, and re-applying a change would
  // resurrect a value the user may have since edited away.
  const { state } = build();
  const m = msg({ body: 'CS F111 L1 will be held in room 6101.' });
  assert.equal(scanMessages([m], state).length, 1);
  const applied = { ...state, appliedMail: ['m1'] };
  assert.equal(scanMessages([m], applied).length, 0);
});

test('MAIL: a message naming no section applies to every section held', () => {
  const two = addCourse(build().state, CS, { lecture: CS.sections[1] });
  const f = scanMessage(msg({ body: 'CS F111 classes are cancelled tomorrow.' }), two.state);
  assert.equal(f.length, 2, 'both L1 and L2 are affected');
});

/* ============================================================ the notice == */

test('NOTICE: rows match on computer code and section', () => {
  const { state } = build();
  const found = matchNotice(
    [{ type: 'room', comCode: '1008', courseNo: 'CS F111', section: 'L1', raw: '1008 L1 5105 6101 CS F111', effective: '05-Aug-2026' }],
    state
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].entryId, entryId('1008', 'L1'));
  assert.equal(found[0].effective, '05-Aug-2026');
  /*
   * This row has BOTH columns -- "5105  6101" is From then To -- so it is now
   * actionable. It previously asserted `false`, back when no notice could
   * carry a value at all and the highest automatic authority in the system
   * could therefore never change anything.
   */
  assert.equal(found[0].actionable, true, 'both columns are present');
  assert.equal(found[0].from, '5105');
  assert.equal(found[0].value, '6101');
  assert.match(found[0].evidence, /1008/);
});

test('NOTICE: a row for a course the user does not have is ignored', () => {
  const { state } = build();
  const found = matchNotice(
    [{ type: 'room', comCode: '9999', courseNo: 'ZZ F999', section: 'L1', raw: 'x' }],
    state
  );
  assert.deepEqual(found, []);
});

/* ============================================================ persistence == */

test('STORE: a timetable round-trips through storage', async () => {
  const s = fakeStorage();
  const { state } = build();
  const w = await saveTimetable(state, s);
  assert.equal(w.ok, true);

  const back = await loadTimetable(s);
  assert.equal(back.entries.length, 1);
  assert.equal(back.entries[0].room, '5105');
  assert.equal(back.entries[0].provenance.room.source, 'document');
  assert.equal(back.entries[0].history.length, 1);
});

test('STORE: a corrupt blob degrades to an empty timetable, never a throw', async () => {
  for (const junk of ['nonsense', 42, { schemaVersion: 99 }, { schemaVersion: 1 }, null]) {
    const s = fakeStorage();
    await s.set({ timetable: junk });
    const back = await loadTimetable(s);
    assert.deepEqual(back.entries, [], `${JSON.stringify(junk)} must degrade`);
  }
});

test('STORE: a write failure is reported, not thrown', async () => {
  // The defect this prevents is a mutator with no failure channel, swallowed
  // inside an async click handler.
  const broken = { async get() { return {}; }, async set() { throw new Error('quota'); }, async remove() {} };
  const r = await saveTimetable(emptyState(), broken);
  assert.equal(r.ok, false);
  assert.match(r.error, /quota/);
});

test('STORE: a read failure degrades instead of throwing', async () => {
  const broken = { async get() { throw new Error('io'); }, async set() {}, async remove() {} };
  const back = await loadTimetable(broken);
  assert.deepEqual(back.entries, []);
});

test('STORE: clearing removes the timetable', async () => {
  const s = fakeStorage();
  await saveTimetable(build().state, s);
  await clearTimetable(s);
  assert.deepEqual((await loadTimetable(s)).entries, []);
});

/* ================================================================= search == */

test('SEARCH: an exact course number outranks a title match', () => {
  const data = { courses: [
    { comCode: '1', courseNo: 'ZZ F100', title: 'ABOUT CS F111 THINGS', sections: [] },
    { comCode: '2', courseNo: 'CS F111', title: 'COMPUTER PROGRAMMING', sections: [] },
  ] };
  assert.equal(searchCourses(data, 'CS F111')[0].comCode, '2');
  assert.equal(searchCourses(data, 'csf111')[0].comCode, '2', 'spacing must not matter');
});

test('SEARCH: an empty query returns nothing', () => {
  assert.deepEqual(searchCourses({ courses: [CS] }, '  '), []);
});

test('SEARCH: a course is found by its computer code', () => {
  assert.equal(courseByComCode({ courses: [CS] }, '1008').courseNo, 'CS F111');
  assert.equal(courseByComCode({ courses: [CS] }, 'nope'), null);
});

test('SOURCE: a failed data load degrades to an empty catalogue', async () => {
  _resetSourceData();
  const d = await loadSourceData(async () => { throw new Error('404'); });
  assert.deepEqual(d.courses, []);
  assert.match(d.error, /404/);
  _resetSourceData();
});

/* ================================================================== views == */

test('VIEW: the week groups meetings by day, in time order', () => {
  const { state } = build();
  const w = weekView(state.entries);
  assert.equal(w.M.length, 1);
  assert.equal(w.Th.length, 1);
  assert.equal(w.M[0].courseNo, 'CS F111');
  assert.equal(w.F.length, 0);
});

test('VIEW: meetings summarise into readable clock times', () => {
  const { state } = build();
  const s = summariseMeetings(state.entries[0].meetings);
  assert.match(s, /M\/W 10:00 AM-10:50 AM/);
  assert.match(s, /Th 4:00 PM-4:50 PM/);
  assert.equal(summariseMeetings([]), 'no scheduled time');
});

test('VIEW: every field explains where it came from', () => {
  const { state } = build();
  const lines = explainEntry(state.entries[0]);
  const room = lines.find((l) => l.field === 'room');
  assert.equal(room.value, '5105');
  assert.equal(room.sourceLabel, 'official timetable');
  assert.ok(room.at > 0);
});

/* ================================================================ removal == */

test('REMOVE: a course can be removed whole or by section', () => {
  const withBoth = addCourse(build().state, CS, { lecture: CS.sections[1] });
  const oneGone = removeCourse(withBoth.state, '1008', 'L2');
  assert.equal(oneGone.entries.length, 1);
  const allGone = removeCourse(oneGone, '1008');
  assert.equal(allGone.entries.length, 0);
});

/* ============================================================ traceability == */

test('TRACE: a message links forward to the entries it changed', () => {
  /*
   * THE LINK MUST WORK IN BOTH DIRECTIONS.
   *
   * An entry already explains itself: `provenance[field].ref` names the
   * message, and `explainEntry` reads it. The reverse -- "this mail is open in
   * the reader, what did it do to my timetable?" -- had no way to be answered,
   * even though the data was sitting in provenance and history all along.
   *
   * That is the direction a user actually asks in. You are reading a room
   * change from AUGSD; the question is whether it has already been applied.
   */
  const { state } = build();
  const entry = state.entries[0];
  const changed = applyFieldChange(entry, 'room', '6104', {
    // A NOTICE, not plain mail: mail cannot outrank the official document, so
    // a mail-sourced room change is correctly refused. The notice is the real
    // path a room change takes, and it carries the message id as its ref.
    source: 'notice',
    ref: 'msg-abc',
    note: 'Room changed to 6104',
  });
  assert.ok(changed.applied, 'precondition: the change should apply');

  const after = { ...state, entries: [changed.entry, ...state.entries.slice(1)] };

  const hits = entriesForMessage(after, 'msg-abc');
  assert.equal(hits.length, 1, 'the message should name the entry it changed');
  assert.equal(hits[0].entry.id, entry.id);
  assert.deepEqual(hits[0].fields, ['room']);
  assert.equal(hits[0].current, '6104');
  assert.equal(hits[0].previous, '5105', 'and what the value was before');
});

test('TRACE: a message that changed nothing links to nothing', () => {
  // No false positives: an unrelated id must not match by accident.
  const { state } = build();
  assert.deepEqual(entriesForMessage(state, 'msg-never-seen'), []);
});

test('TRACE: an empty reference matches nothing, not everything', () => {
  /*
   * The guard this pins is easy to lose and expensive to lose.
   *
   * An entry built with no stated source carries `ref: ''` in provenance for
   * every field. Without the empty check, `entriesForMessage(state, '')`
   * matches ALL of them -- so a message with no id would appear to have
   * rewritten the user's entire timetable. The fixture used by the other
   * trace tests passes a real ref, so it cannot catch this; this one builds
   * an entry the way `addCourse` does when the caller states no source.
   */
  const noSource = addCourse(emptyState(), CS, {
    lecture: CS.sections.find((s) => s.section === 'L1'),
  });
  assert.equal(
    noSource.state.entries[0].provenance.room.ref, '',
    'precondition: this entry must have a blank ref'
  );
  assert.deepEqual(
    entriesForMessage(noSource.state, ''), [],
    'a blank reference must not link to every entry ever created'
  );
});

test('TRACE: one message changing two fields is reported once', () => {
  // A single mail can move a class AND change its room. That is one link with
  // two fields, not two links -- otherwise the reader shows the same mail twice.
  const { state } = build();
  const e0 = state.entries[0];
  const a = applyFieldChange(e0, 'room', '6104', { source: 'notice', ref: 'msg-two' });
  const b = applyFieldChange(a.entry, 'instructors', ['A N Other'], {
    source: 'notice', ref: 'msg-two',
  });
  const after = { ...state, entries: [b.entry, ...state.entries.slice(1)] };

  const hits = entriesForMessage(after, 'msg-two');
  assert.equal(hits.length, 1, 'one entry, not one per field');
  assert.deepEqual(hits[0].fields.sort(), ['instructors', 'room']);
});

/* ========================================================== catalogue shape == */

test('CATALOGUE: the shipped data has the size and shape we documented', () => {
  /*
   * A REGRESSION FENCE AROUND THE PARSER.
   *
   * `data.json` is generated, so a change to parse-timetable.mjs can silently
   * halve the catalogue or start dropping instructors and every other test
   * would still pass -- they all use fixtures. These numbers are measured, not
   * aspirational, and are quoted in docs/TIMETABLE.md.
   *
   * Ranges rather than exact counts for the unresolved figures: regenerating
   * from a NEWER official document should not fail the suite, but losing a
   * third of the catalogue should.
   */
  const data = JSON.parse(
    readFileSync(join(ROOT, 'src/timetable/data.json'), 'utf8')
  );

  assert.equal(data.courses.length, 688, 'course count changed');
  const sections = data.courses.flatMap((c) => c.sections || []);
  assert.equal(sections.length, 1681, 'section count changed');
  assert.equal(data.changes.length, 119, 'change-notice row count changed');

  // Every section must have an instructor. This is the field most likely to be
  // silently eaten by a column-splitting bug, and it was clean when measured.
  const noInstructor = sections.filter((s) => !s.instructors?.length);
  assert.equal(noInstructor.length, 0, 'sections appeared with no instructor');

  // Unresolved is EXPECTED -- the document really is incomplete for project
  // and thesis courses -- but a sharp rise means the parser started failing.
  const unresolved = sections.filter((s) => s.unresolved?.length).length;
  assert.ok(
    unresolved / sections.length < 0.20,
    `unresolved rose to ${((unresolved / sections.length) * 100).toFixed(1)}%`
  );
});

test('CATALOGUE: a course with no schedule is unresolved, not invented', () => {
  // BIO F366 LABORATORY PROJECT has credits and an instructor and no time or
  // room anywhere in the document. The honest result is an empty field.
  const data = JSON.parse(
    readFileSync(join(ROOT, 'src/timetable/data.json'), 'utf8')
  );
  const lab = data.courses.find((c) => c.courseNo === 'BIO F366');
  assert.ok(lab, 'BIO F366 should be in the catalogue');
  const s = lab.sections[0];
  assert.deepEqual(s.meetings, [], 'no schedule must stay empty');
  assert.equal(s.room, '', 'no room must stay empty');
  assert.ok(s.instructors.length, 'but the instructor IS stated and must survive');
  assert.ok(s.unresolved.includes('time'), 'and the gap must be declared');
});

/* ============================================== exam sessions (the legend) == */

test('PARSE: a lone exam date is placed by its SESSION, not by its position', () => {
  /*
   * THE LEGEND DISAMBIGUATES WHAT POSITION CANNOT.
   *
   * Most rows carry two dates: midsem then compre. Some carry only one, and
   * the parser assigned the first match to `midsem` unconditionally. For the
   * eleven sections that list only a compre, that put the FINAL EXAM in the
   * mid-semester field -- CS F111 among them, a first-year core.
   *
   * The document's own legend settles it (section 10 and 11):
   *
   *   MIDSEM sessions are FN1, FN2, AN1, AN2   (90-minute slots)
   *   COMPRE sessions are FN, AN               (3-hour slots)
   *
   * So a bare FN/AN is a compre no matter where it appears in the row. This
   * is reading the source harder, not guessing.
   */
  const text = readFileSync(
    join(ROOT, 'src/timetable/sources/Timetable_05_Aug_2026_f4b34f8b-8fb7-4f3a-905e-714ab50065a5.txt'),
    'utf8'
  );
  const { courses } = parseTimetable(text);

  // CS F111 lists ONE date: "02/12 AN". Bare AN => compre.
  const cs = courses.find((c) => c.comCode === '1008');
  const l1 = cs.sections.find((s) => s.section === 'L1');
  assert.equal(l1.compre, '02/12 AN', 'a lone bare-AN date is the compre');
  assert.equal(l1.midsem, '', 'and there is no midsem date to claim');

  // BIO F101 lists BOTH: "09/10 AN2" (numbered => midsem) then "14/12 AN".
  const bio = courses.find((c) => c.comCode === '2863');
  const bioL1 = bio.sections.find((s) => s.section === 'L1');
  assert.equal(bioL1.midsem, '09/10 AN2', 'a numbered session is the midsem');
  assert.equal(bioL1.compre, '14/12 AN');
});

test('PARSE: no section ends up with a bare session in the midsem field', () => {
  // The invariant, across all 1681 sections rather than two hand-picked ones.
  const text = readFileSync(
    join(ROOT, 'src/timetable/sources/Timetable_05_Aug_2026_f4b34f8b-8fb7-4f3a-905e-714ab50065a5.txt'),
    'utf8'
  );
  const { courses } = parseTimetable(text);
  const bad = [];
  for (const c of courses) {
    for (const s of c.sections || []) {
      const session = (s.midsem || '').split(/\s+/)[1] || '';
      if (/^(FN|AN)$/.test(session)) bad.push(`${c.courseNo} ${s.section} ${s.midsem}`);
      const cSession = (s.compre || '').split(/\s+/)[1] || '';
      if (/^(FN|AN)\d$/.test(cSession)) bad.push(`${c.courseNo} ${s.section} compre=${s.compre}`);
    }
  }
  assert.deepEqual(bad, [], 'exam dates filed under the wrong session type');
});

/* ================================================================== exams == */

test('EXAMS: midsem and compre are typed events with real clock times', () => {
  /*
   * Pass 2 asks for midsem and compre as first-class event types, not a
   * generic blob. The dates were being STORED and never modelled, so nothing
   * could render them and nothing could tell one from the other.
   *
   * The session codes come from the document's legend, which gives exact
   * times -- so these are converted, not invented:
   *
   *   FN1 09:00-10:30   FN2 11:00-12:30   AN1 14:00-15:30   AN2 16:00-17:30
   *   FN  09:00-12:00   AN  14:00-17:00
   */
  const { state } = build();
  const withExams = {
    ...state,
    entries: [{ ...state.entries[0], midsem: '09/10 AN2', compre: '14/12 AN' }],
  };

  const events = examEvents(withExams.entries);
  assert.equal(events.length, 2, 'a midsem and a compre');

  const mid = events.find((e) => e.type === 'midsem');
  assert.equal(mid.courseNo, 'CS F111');
  assert.equal(mid.date, '09/10');
  assert.equal(mid.session, 'AN2');
  assert.equal(mid.startMin, 16 * 60, 'AN2 starts at 16:00 per the legend');
  assert.equal(mid.endMin, 17 * 60 + 30);
  assert.match(mid.time, /4:00 PM-5:30 PM/);

  const com = events.find((e) => e.type === 'compre');
  assert.equal(com.session, 'AN');
  assert.equal(com.startMin, 14 * 60, 'a bare AN is the three-hour compre slot');
  assert.equal(com.endMin, 17 * 60);
});

test('EXAMS: a section with no exam date produces no event', () => {
  // Lab and project courses have none. Inventing a placeholder would put a
  // fictional exam on someone's calendar.
  const { state } = build();
  const bare = { ...state, entries: [{ ...state.entries[0], midsem: '', compre: '' }] };
  assert.deepEqual(examEvents(bare.entries), []);
});

test('EXAMS: an unrecognised session yields no time, never a guess', () => {
  // If the legend does not describe the session code, the event still exists
  // -- the date IS known -- but the clock time stays unresolved.
  const { state } = build();
  const odd = { ...state, entries: [{ ...state.entries[0], midsem: '09/10 XX9' }] };
  const [e] = examEvents(odd.entries);
  assert.equal(e.date, '09/10');
  assert.equal(e.startMin, null, 'an unknown session must not be given a time');
  assert.equal(e.time, '', 'and must not be rendered as one');
});

test('EXAMS: two courses examined in the same session are a conflict', () => {
  /*
   * The clash that actually matters to a student. Two classes overlapping is
   * annoying; two COMPRES in the same slot is a problem you must report to
   * AUGSD, and the timetable is the only place it is visible.
   */
  const { state } = build();
  const two = [
    { ...state.entries[0], id: 'a', courseNo: 'CS F111', midsem: '', compre: '14/12 AN' },
    { ...state.entries[0], id: 'b', courseNo: 'MATH F211', midsem: '', compre: '14/12 AN' },
  ];
  const clashes = detectConflicts(two).filter((c) => c.kind === 'exam-clash');
  assert.equal(clashes.length, 1, 'the clash must be surfaced');
  assert.match(clashes[0].message, /14\/12/);
  assert.match(clashes[0].message, /CS F111/);
  assert.match(clashes[0].message, /MATH F211/);
  assert.equal(clashes[0].severity, 'blocking');
});

test('EXAMS: one course\'s own sections do not clash with each other', () => {
  /*
   * THE CASE THAT MAKES THE GROUPING NECESSARY.
   *
   * A course you attend as a lecture plus a lab is two entries, and BOTH
   * carry the same compre date and session -- because it is one exam for one
   * course. Keying the clash detector on entries instead of course numbers
   * reports that as a conflict with itself, which would fire for nearly every
   * course a student holds and train them to ignore the warnings.
   *
   * Two sections, same date, same session, same courseNo: silence.
   */
  const { state } = build();
  const sameCourse = [
    { ...state.entries[0], id: 'a', section: 'L1', midsem: '', compre: '14/12 AN' },
    { ...state.entries[0], id: 'b', section: 'P1', midsem: '', compre: '14/12 AN' },
  ];
  assert.deepEqual(
    detectConflicts(sameCourse).filter((c) => c.kind === 'exam-clash'), [],
    'a course cannot clash with itself'
  );

  // And a midsem and compre on one date in DIFFERENT sessions is also fine.
  const midAndCompre = [{ ...state.entries[0], midsem: '14/12 FN1', compre: '14/12 AN' }];
  assert.deepEqual(
    detectConflicts(midAndCompre).filter((c) => c.kind === 'exam-clash'), []
  );
});

/* ================================================= credits and in-charge == */

test('CREDITS: the L/P/T/S/U array is named, not left positional', () => {
  /*
   * The document stores credits as five bare columns and the legend says what
   * they mean (section 4):
   *
   *   L = lecture hours per week      P = practical hours per week
   *   T = tutorial hours per week     S = self-study hours per week
   *   U = total units
   *
   * `["3","1","-","-","4"]` is unreadable and, worse, unusable -- nothing can
   * ask "does this course have a lab?" without re-deriving the legend at the
   * call site. Pass 2 asks for the credit structure to be part of the model.
   *
   * A dash means the component does not exist, and becomes 0, not null: the
   * document is stating an absence, which is information.
   */
  const { state } = build();
  const c = state.entries[0].credits;
  assert.equal(c.lecture, 3);
  assert.equal(c.practical, 1);
  assert.equal(c.tutorial, 0, 'a dash is a stated absence, so zero');
  assert.equal(c.selfStudy, 0);
  assert.equal(c.units, 4);
});

test('CREDITS: a malformed credit column does not fabricate numbers', () => {
  const odd = { ...CS, credits: ['x', '', undefined, '-', '4'] };
  const { state } = addCourse(emptyState(), odd, {
    lecture: odd.sections.find((s) => s.section === 'L1'),
  });
  const c = state.entries[0].credits;
  assert.equal(c.lecture, null, 'an unparseable value is unknown, not zero');
  assert.equal(c.tutorial, null, 'a missing column is unknown');
  assert.equal(c.selfStudy, 0, 'but a dash really is zero');
  assert.equal(c.units, 4);
});

test('IN-CHARGE: the instructor-in-charge is identified from the source', () => {
  /*
   * Legend section 6: "Name in BLOCK LETTERS indicates INSTRUCTOR-IN-CHARGE.
   * Other Names are of Instructors."
   *
   * This matters practically -- the in-charge is who you email about a clash,
   * a makeup or a grade, and the timetable was flattening them into an
   * undifferentiated list.
   *
   * BIO F101 L1 reads: SHASHI PRAKASH SINGH (caps), then Rajdeep Chowdhury and
   * Syamantak Majumder in mixed case.
   */
  const data = JSON.parse(
    readFileSync(join(ROOT, 'src/timetable/data.json'), 'utf8')
  );
  const bio = data.courses.find((c) => c.courseNo === 'BIO F101');
  const l1 = bio.sections.find((s) => s.section === 'L1');
  assert.equal(l1.inCharge, 'SHASHI PRAKASH SINGH');

  const { state } = addCourse(emptyState(), bio, { lecture: l1 });
  assert.equal(state.entries[0].inCharge, 'SHASHI PRAKASH SINGH');
  assert.ok(
    state.entries[0].instructors.length > 1,
    'the other instructors are still listed'
  );
});

test('IN-CHARGE: a mixed-case-only section claims no in-charge', () => {
  /*
   * Continuation rows carry co-instructors in mixed case. If a section's own
   * name is not in block capitals the document has not marked an in-charge on
   * that row, and inventing one -- "probably the first" -- is exactly the
   * guess this system refuses to make.
   *
   * READ FROM THE PARSED CATALOGUE, NOT FROM THE HAND-WRITTEN FIXTURE. My
   * first version of this test used the fixture, which never runs the parser,
   * so a parser that ignored capitalisation entirely still passed it. The
   * real CS F111 rows are the point:
   *
   *   L1  VINTI AGARWAL   -> in charge
   *   L2  Yash Sinha      -> not marked
   */
  const data = JSON.parse(
    readFileSync(join(ROOT, 'src/timetable/data.json'), 'utf8')
  );
  const cs = data.courses.find((c) => c.courseNo === 'CS F111');
  const l1 = cs.sections.find((s) => s.section === 'L1');
  const l2 = cs.sections.find((s) => s.section === 'L2');

  assert.equal(l1.inCharge, 'VINTI AGARWAL', 'block capitals means in-charge');
  assert.deepEqual(l2.instructors, ['Yash Sinha'], 'precondition: mixed case only');
  assert.equal(l2.inCharge, '', 'a mixed-case name must claim nothing');

  // And it must survive into the built entry.
  const { state } = addCourse(emptyState(), cs, { lecture: l2 });
  assert.equal(state.entries[0].inCharge, '');
});

test('IN-CHARGE: only some sections are marked, and that is expected', () => {
  // A blanket "every section has an in-charge" would mean the caps test is
  // not discriminating; a blanket "none do" would mean it never fires. The
  // real document marks the header row of each course, not every row.
  const data = JSON.parse(
    readFileSync(join(ROOT, 'src/timetable/data.json'), 'utf8')
  );
  const sections = data.courses.flatMap((c) => c.sections || []);
  const marked = sections.filter((s) => s.inCharge).length;
  assert.ok(marked > 400, `too few in-charges (${marked}); the caps test may be broken`);
  assert.ok(
    marked < sections.length * 0.75,
    `too many in-charges (${marked}/${sections.length}); capitalisation is being ignored`
  );
});

/* ====================================================== notice from -> to == */

test('NOTICE: a room change carries the new room, not just a warning', () => {
  /*
   * The change notice is the SECOND-HIGHEST authority in the whole system --
   * above the official timetable, below only the user. It was being parsed,
   * matched to the right entry, and then reported with `value: null` and
   * `actionable: false`, so it could never actually change anything.
   *
   * The notice prints a From and a To column:
   *
   *   B. Change of Room
   *   ... From  To
   *   151   L1   6156   6160 BIO G542
   *
   * Two room numbers in order. Reading the second is not a guess; it is the
   * column the document labelled "To".
   */
  const change = {
    type: 'room', comCode: '151', courseNo: 'BIO G542', section: 'L1',
    raw: '151   L1   6156   6160 BIO G542', effective: '05-Aug-2026',
  };
  const entry = { ...build().state.entries[0], comCode: '151', section: 'L1' };
  const [f] = matchNotice([change], { entries: [entry] });

  assert.equal(f.field, 'room');
  assert.equal(f.from, '6156', 'the old room, for the history record');
  assert.equal(f.value, '6160', 'the NEW room is what gets applied');
  assert.equal(f.actionable, true, 'a notice with a stated value must be usable');
});

test('NOTICE: a room change with only one room stated is not actionable', () => {
  /*
   * PHA G617 reads "145   L1    6108(T) PHA G617" -- the From column wrapped
   * onto other lines and only one room survives on the row. One room is
   * ambiguous: it could be the old or the new. The notice is still shown, but
   * it cannot be applied, which is the no-guessing rule.
   */
  const change = {
    type: 'room', comCode: '145', courseNo: 'PHA G617', section: 'L1',
    raw: '145   L1    6108(T) PHA G617', effective: '05-Aug-2026',
  };
  const entry = { ...build().state.entries[0], comCode: '145', section: 'L1' };
  const [f] = matchNotice([change], { entries: [entry] });

  assert.equal(f.actionable, false, 'one room cannot be told from the other');
  assert.equal(f.value, null);
  assert.match(f.label, /room/i, 'but the user is still told about it');
});

test('NOTICE: an instructor change is reported and never auto-applied', () => {
  // Same restraint as the mail path. Names wrap across lines in this document
  // and a half-read name written into the timetable is worse than a prompt.
  const change = {
    type: 'instructor', comCode: '151', courseNo: 'BIO G542', section: 'L1',
    raw: '151   L1   SOMEONE   SOMEONE ELSE BIO G542', effective: '05-Aug-2026',
  };
  const entry = { ...build().state.entries[0], comCode: '151', section: 'L1' };
  const [f] = matchNotice([change], { entries: [entry] });
  assert.equal(f.actionable, false, 'instructor names are not machine-safe here');
});

test('NOTICE: a class-time change carries parsed meetings when stated', () => {
  // "MW 2 T 9" is the same notation as the main timetable, so it converts
  // with the same parser rather than a second implementation.
  const change = {
    type: 'time', comCode: '3118', courseNo: 'MATH F201', section: 'L1',
    raw: '3118   DIFFERENTIAL EQUATIO   L1   -  M W 2 T 9 MATH F201',
    effective: '05-Aug-2026',
  };
  const entry = { ...build().state.entries[0], comCode: '3118', section: 'L1' };
  const [f] = matchNotice([change], { entries: [entry] });

  assert.equal(f.field, 'meetings');
  assert.equal(f.actionable, true);
  assert.deepEqual(
    f.value.map((m) => `${m.day}${m.hour}`), ['M2', 'W2', 'T9'],
    'the same day/hour rules as the main document'
  );
});

test('NOTICE: applying one uses notice authority, above the document', () => {
  /*
   * Precedence in practice. The room came from the official timetable; the
   * notice outranks it, so this applies WITHOUT asking -- unlike mail, which
   * ranks below the document and must be accepted by the user.
   */
  const entry = { ...build().state.entries[0], comCode: '151', section: 'L1' };
  const r = applyFieldChange(entry, 'room', '6160', {
    source: 'notice', ref: '151/L1',
  });
  assert.equal(r.applied, true);
  assert.equal(r.entry.room, '6160');
  assert.equal(r.entry.provenance.room.source, 'notice');
});

test('NOTICE: an exam date in a time row is not read as a class hour', () => {
  /*
   * FOUND BY HAND, THEN LEFT UNCOVERED -- sabotage caught that.
   *
   * A real row reads "3118  DIFFERENTIAL EQUATIO  L10  -  TThF 4 01/12 MATH
   * F201". The "01" of the date 01/12 looks exactly like an hour, so it
   * parsed as a SECOND class at slot 1 on Tue, Thu and Fri -- three meetings
   * that do not exist, written into the timetable by the highest automatic
   * authority in the system.
   *
   * DD/MM is unambiguous, so dates are stripped before any hour is read.
   */
  const change = {
    type: 'time', comCode: '3118', courseNo: 'MATH F201', section: 'L10',
    raw: '3118   DIFFERENTIAL EQUATIO   L10   -  TThF 4 01/12 MATH F201',
    effective: '05-Aug-2026',
  };
  const entry = { ...build().state.entries[0], comCode: '3118', section: 'L10' };
  const [f] = matchNotice([change], { entries: [entry] });

  assert.deepEqual(
    f.value.map((m) => `${m.day}${m.hour}`), ['T4', 'Th4', 'F4'],
    'the exam date must not become a class at slot 1'
  );
});

test('NOTICE: unspaced day runs parse, and Th is never T followed by h', () => {
  // This document writes "MW 2" and "TThF 4" without spaces, unlike the main
  // timetable. Re-splitting must try Th first or every Thursday becomes a
  // Tuesday plus a stray letter -- the same trap the main parser has.
  const change = {
    type: 'time', comCode: '3118', courseNo: 'MATH F201', section: 'L12',
    raw: '3118   DIFFERENTIAL EQUATIO   L12   -  Santra   TThF 5 MATH F201',
    effective: '05-Aug-2026',
  };
  const entry = { ...build().state.entries[0], comCode: '3118', section: 'L12' };
  const [f] = matchNotice([change], { entries: [entry] });
  assert.deepEqual(f.value.map((m) => `${m.day}${m.hour}`), ['T5', 'Th5', 'F5']);
});

/* ================================================== switch / finalize / reset == */

test('SWITCH: changing section replaces the entry and records why', () => {
  /*
   * A control Pass 2 asks for and the model had no path to: you registered
   * for L1, the section swap came through, and the only way to fix it was to
   * remove the course and add it again -- losing the history of everything
   * else on that course.
   *
   * The replacement is a genuinely different class, so it is a new entry with
   * the new section's own room, time and instructors. What must survive is
   * the RECORD that a switch happened.
   */
  const { state } = build();
  const l2 = CS.sections.find((s) => s.section === 'L2');
  const after = switchSection(state, '1008', 'L1', CS, l2);

  const ids = after.entries.map((e) => e.section);
  assert.ok(!ids.includes('L1'), 'the old section is gone');
  assert.ok(ids.includes('L2'), 'the new one is present');

  const e = after.entries.find((x) => x.section === 'L2');
  assert.equal(e.room, '5105');
  assert.deepEqual(e.meetings.map((m) => `${m.day}${m.hour}`), ['M2', 'W2', 'T8']);
  assert.match(
    e.history[0].detail, /switched from L1/i,
    'the switch must be explainable afterwards'
  );
});

test('SWITCH: a locked entry is not switched silently', () => {
  // Lock means "automation stops touching this". A switch is user-driven, so
  // it IS allowed -- but it must be reported, not slipped through.
  const { state } = build();
  const locked = { ...state, entries: [{ ...state.entries[0], locked: true }] };
  const l2 = CS.sections.find((s) => s.section === 'L2');
  const after = switchSection(locked, '1008', 'L1', CS, l2);
  assert.equal(after.entries[0].section, 'L2', 'the user may still switch');
  assert.equal(after.entries[0].locked, true, 'and the lock carries over');
});

test('SWITCH: switching a section that is not held changes nothing', () => {
  const { state } = build();
  const l2 = CS.sections.find((s) => s.section === 'L2');
  const after = switchSection(state, '1008', 'L9', CS, l2);
  assert.deepEqual(
    after.entries.map((e) => e.section), state.entries.map((e) => e.section),
    'no silent insert for a section the user never had'
  );
});

test('FINALIZE: a timetable with blocking conflicts cannot be finalised', () => {
  /*
   * "Finalize once the course set is complete" only means something if it
   * refuses when the timetable is not actually usable. Blocking conflicts --
   * two classes in one slot, two compres in one session -- must be resolved
   * first. Needs-input conflicts are advisory and do not block.
   */
  const clash = [
    { ...build().state.entries[0], id: 'a', courseNo: 'CS F111' },
    { ...build().state.entries[0], id: 'b', courseNo: 'MATH F211' },
  ];
  const bad = { ...emptyState(), entries: clash, conflicts: detectConflicts(clash) };
  const r = finalize(bad);
  assert.equal(r.ok, false);
  assert.match(r.reason, /conflict/i);
  assert.equal(r.state.finalisedAt, undefined, 'nothing is recorded on refusal');
});

test('FINALIZE: a clean timetable is stamped and reports what it locked in', () => {
  const { state } = build();
  const r = finalize(state);
  assert.equal(r.ok, true);
  assert.ok(r.state.finalisedAt > 0, 'the moment is recorded');
  assert.equal(r.state.entries.length, state.entries.length);
});

test('FINALIZE: finalising does not freeze the timetable', () => {
  // It is a milestone, not a lock. Official notices must still land, because
  // AUGSD does not care that you pressed a button.
  const { state } = build();
  const done = finalize(state).state;
  const r = applyFieldChange(done.entries[0], 'room', '6101', {
    source: 'notice', ref: 'n1',
  });
  assert.equal(r.applied, true, 'a notice still outranks a finalised entry');
});

test('RESET: an explicit reset clears the timetable and says so', () => {
  /*
   * The ONLY sanctioned way back to a rebuild. Everything else in this system
   * updates incrementally; a full reset is destructive and therefore explicit.
   */
  const { state } = build();
  const after = resetTimetable(state);
  assert.deepEqual(after.entries, []);
  assert.deepEqual(after.conflicts, []);
  assert.equal(after.finalisedAt, undefined);
  assert.ok(after.resetAt > 0, 'the reset itself is recorded');
});

test('RESET: appliedMail is cleared so past updates can be seen again', () => {
  /*
   * Subtle, and the reason this is not just `emptyState()`.
   *
   * `appliedMail` remembers which messages have already been handled so they
   * are not re-proposed. After a reset the timetable is empty, so every one
   * of those messages is unhandled again -- keeping the list would make the
   * rebuilt timetable permanently deaf to mail it had already seen.
   */
  const seeded = { ...build().state, appliedMail: ['m1', 'm2'] };
  assert.deepEqual(resetTimetable(seeded).appliedMail, []);
});

/* ===================================================== integrity / recovery == */

test('RECOVER: one corrupt entry does not take the whole timetable down', async () => {
  /*
   * FOUND BY PROBING, NOT BY REVIEW.
   *
   * loadTimetable checked that `entries` was an array and stopped there. A
   * blob whose array holds junk -- a null, an object with no meetings, a
   * meetings field that is a string -- loaded "successfully" and then threw
   * on the first render:
   *
   *   weekView       -> Cannot read properties of null (reading 'meetings')
   *   detectConflicts-> same
   *   examEvents     -> Cannot read properties of null (reading 'midsem')
   *
   * So a single bad record made the panel unopenable, which is precisely the
   * "silently corrupted / unusable" failure Pass 3 exists to prevent. A
   * partial timetable the user can see and repair beats a total loss.
   */
  const blob = {
    schemaVersion: 1,
    entries: [
      null,
      { id: 'no-fields' },
      { id: 'bad-meetings', comCode: '1', courseNo: 'X', section: 'L1', meetings: 'nope' },
      // One genuinely good entry, which MUST survive.
      { ...build().state.entries[0] },
    ],
  };
  const st = await loadTimetable({ get: async () => ({ timetable: blob }) });

  assert.equal(st.entries.length, 1, 'only the usable entry is kept');
  assert.equal(st.entries[0].courseNo, 'CS F111');
  assert.equal(st.dropped, 3, 'and the loss is reported, not hidden');

  // The three functions that crashed must now all cope.
  assert.doesNotThrow(() => weekView(st.entries));
  assert.doesNotThrow(() => detectConflicts(st.entries));
  assert.doesNotThrow(() => examEvents(st.entries));
});

test('RECOVER: a repaired entry keeps every field it legitimately had', async () => {
  // Repair must not be a quiet downgrade: a good entry has to survive the
  // load byte-for-byte, or "recovery" becomes its own kind of data loss.
  const good = build().state.entries[0];
  const st = await loadTimetable({
    get: async () => ({ timetable: { schemaVersion: 1, entries: [good] } }),
  });
  assert.equal(st.dropped, 0);
  assert.deepEqual(st.entries[0], good);
});

test('INTEGRITY: a practical left behind by its lecture is surfaced', () => {
  /*
   * FOUND BY PROBING. Pass 3 names this exactly: "a lecture exists without
   * its linked practical where one was required" -- and the inverse, which is
   * what actually happens.
   *
   * Removing just the lecture left P1 in the timetable with
   * `linkedTo: 'L1'` pointing at an entry that no longer exists, and
   * detectConflicts said nothing. The user sees a lab on Monday for a course
   * they believe they dropped, and nothing explains it.
   *
   * The lab is NOT auto-deleted. It is real, it is on the user's schedule,
   * and silently removing a class is worse than showing a broken link. This
   * surfaces it and lets them decide.
   */
  const withBoth = addCourse(emptyState(), CS, {
    lecture: CS.sections.find((s) => s.section === 'L1'),
    extraSections: [CS.sections.find((s) => s.section === 'P1')],
  }).state;
  assert.equal(withBoth.entries.length, 2, 'precondition: lecture and lab');

  const orphaned = removeCourse(withBoth, '1008', 'L1');
  assert.equal(orphaned.entries.length, 1, 'the lab is kept, not silently dropped');

  const broken = orphaned.conflicts.filter((c) => c.kind === 'orphan-link');
  assert.equal(broken.length, 1, 'the dangling link must be reported');
  assert.match(broken[0].message, /P1/);
  assert.match(broken[0].message, /L1/, 'and name the section that went missing');
  assert.equal(broken[0].severity, 'needs-input');
});

test('INTEGRITY: a linked pair that is intact reports nothing', () => {
  // The control. A lab whose lecture is present is the normal case and must
  // stay silent, or the warning becomes noise people learn to ignore.
  const withBoth = addCourse(emptyState(), CS, {
    lecture: CS.sections.find((s) => s.section === 'L1'),
    extraSections: [CS.sections.find((s) => s.section === 'P1')],
  }).state;
  assert.deepEqual(
    withBoth.conflicts.filter((c) => c.kind === 'orphan-link'), [],
    'an intact pair is not a conflict'
  );
});

test('INTEGRITY: removing the whole course removes the link too', () => {
  // Dropping the course entirely is deliberate and complete -- there is no
  // orphan, so there must be no warning.
  const withBoth = addCourse(emptyState(), CS, {
    lecture: CS.sections.find((s) => s.section === 'L1'),
    extraSections: [CS.sections.find((s) => s.section === 'P1')],
  }).state;
  const gone = removeCourse(withBoth, '1008');
  assert.deepEqual(gone.entries, []);
  assert.deepEqual(gone.conflicts, []);
});

/* ============================================== validation against the source == */

test('VALIDATE: a held section the catalogue no longer offers is reported', () => {
  /*
   * Pass 3 requires "course exists in the source" and "section exists in the
   * source". Nothing checked either, because addCourse only ever ran against
   * a catalogue that by definition contained the section.
   *
   * The case that matters is a REGENERATED catalogue: `npm run timetable`
   * against a revised document, or a new semester. A section that is no
   * longer offered stays in the timetable forever, and the user keeps
   * attending a class that has moved.
   *
   * Deliberately NOT auto-removed. The entry may carry manual edits and a
   * history, and the document being revised is not proof the user dropped the
   * class -- only that the source changed. Surface it and let them decide.
   */
  const { state } = build();
  const revised = {
    courses: [{
      comCode: '1008', courseNo: 'CS F111', title: 'COMPUTER PROGRAMMING',
      sections: [{ section: 'L2', kind: 'lecture' }],
    }],
  };
  const found = validateAgainstSource(state, revised);

  assert.equal(found.length, 1, 'the vanished section must be reported');
  assert.equal(found[0].kind, 'stale-section');
  assert.equal(found[0].severity, 'needs-input');
  assert.match(found[0].message, /L1/);
  assert.match(found[0].message, /no longer/i);
});

test('VALIDATE: a course dropped from the catalogue entirely is reported', () => {
  // Whole-course removal is a different message: "the section moved" and
  // "the course is not offered" need different actions from the user.
  /*
   * A NON-EMPTY catalogue that lacks this course. An empty list cannot be the
   * signal: loadSourceData degrades to `{courses: []}` on a failed fetch, and
   * treating that as "every class you have was cancelled" turns a transient
   * load error into a screen of alarming nonsense. See the test below.
   */
  const { state } = build();
  const found = validateAgainstSource(state, {
    courses: [{ comCode: '9999', courseNo: 'ZZ F999', title: 'OTHER', sections: [] }],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'stale-course');
  assert.match(found[0].message, /CS F111/);
});

test('VALIDATE: a timetable matching its source reports nothing', () => {
  // The control. This runs on every load, so a false positive here would
  // greet every user with a warning about a perfectly good timetable.
  const { state } = build();
  assert.deepEqual(validateAgainstSource(state, { courses: [CS] }), []);
});

test('VALIDATE: a missing or empty catalogue is not evidence of staleness', () => {
  /*
   * IMPORTANT NEGATIVE CASE. loadSourceData degrades to an empty catalogue on
   * a packaging error or a failed fetch. Treating that as "every one of your
   * classes has been cancelled" would turn a transient load failure into a
   * screen full of alarming nonsense.
   *
   * No source means no opinion.
   */
  const { state } = build();
  assert.deepEqual(validateAgainstSource(state, null), [], 'no source at all');
  assert.deepEqual(validateAgainstSource(state, {}), [], 'a source with no courses key');
  assert.deepEqual(
    validateAgainstSource(state, { courses: [] }), [],
    'and an empty course list, which is what a failed load actually produces'
  );
});

/* ================================================================ idempotency == */

test('IDEMPOTENT: the same message twice in one scan yields one proposal', () => {
  /*
   * FOUND BY PROBING. Pass 3 names "duplicate mail-triggered updates" and
   * "the same source processed twice must not create duplicate data".
   *
   * `appliedMail` correctly suppressed messages handled in a PREVIOUS session,
   * but the set was never told about ids seen during the current loop. A
   * duplicate in the input -- the same message returned by two mailbox
   * queries, or a re-scan concatenating results -- produced two identical
   * proposals, so the user was asked to approve the same room change twice.
   */
  const { state } = build();
  const msg = {
    id: 'm1',
    from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
    subject: 'CS F111 L1 venue change',
    snippet: 'CS F111 L1 will be held in room 6101.',
    date: Date.now(),
  };

  assert.equal(scanMessages([msg], state).length, 1, 'precondition: one proposal');
  assert.equal(
    scanMessages([msg, { ...msg }], state).length, 1,
    'the same id twice must not double the proposals'
  );
});

test('IDEMPOTENT: two different messages about one change are both offered', () => {
  /*
   * THE LIMIT OF THE DEDUPE, stated deliberately.
   *
   * A forward or a reply is a genuinely different message with its own id.
   * Collapsing them would mean guessing that two texts describe the same
   * event, which is inference -- exactly what this system refuses to do. Both
   * are offered; accepting one applies the change and the other then becomes
   * a no-op through precedence ("no change").
   */
  const { state } = build();
  const base = {
    from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
    subject: 'CS F111 L1 venue change',
    snippet: 'CS F111 L1 will be held in room 6101.',
    date: Date.now(),
  };
  const found = scanMessages([{ ...base, id: 'm1' }, { ...base, id: 'm2' }], state);
  assert.equal(found.length, 2, 'distinct ids are distinct messages');
});

test('IDEMPOTENT: a message already applied stays suppressed across a reload', () => {
  // The cross-session half. appliedMail is persisted, so a message handled
  // last week must not reappear every time the app opens.
  const { state } = build();
  const msg = {
    id: 'm1',
    from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
    subject: 'CS F111 L1 venue change',
    snippet: 'CS F111 L1 will be held in room 6101.',
    date: Date.now(),
  };
  assert.deepEqual(scanMessages([msg], { ...state, appliedMail: ['m1'] }), []);
});

/* ========================================== the Pass 3 final integrity check == */

test('SEMESTER: a full semester of updates leaves the timetable coherent', async () => {
  /*
   * PASS 3's FINAL CHECKLIST, AS A SIMULATION.
   *
   * The individual hardening behaviours each have focused tests. This exists
   * because integrity is a property of a SEQUENCE, not of any single call --
   * repeated updates, reloads and duplicate sources are exactly where a
   * record-keeping system rots, and none of the unit tests would notice drift
   * that only appears after twenty operations.
   *
   * It walks a plausible semester and then asserts every invariant Pass 3
   * lists under "final integrity checks" at once.
   */
  const lecture = CS.sections.find((s) => s.section === 'L1');
  const lab = CS.sections.find((s) => s.section === 'P1');

  // Week 0: build.
  let st = addCourse(emptyState(), CS, {
    lecture, extraSections: [lab], ref: 'official timetable',
  }).state;

  // Week 1: an official notice moves the room. Applied twice, as a re-issued
  // notice would be.
  for (let i = 0; i < 2; i++) {
    const r = applyFieldChange(st.entries[0], 'room', '6101', {
      source: 'notice', ref: 'n1',
    });
    if (r.applied) st = { ...st, entries: [r.entry, ...st.entries.slice(1)] };
  }

  // Week 2: the user overrides the room themselves.
  st = manualEdit(st, st.entries[0].id, 'room', '7001').state;

  // Week 3: a mail tries to change it back. It must lose to the manual edit.
  const beaten = applyFieldChange(st.entries[0], 'room', '5105', {
    source: 'mail', ref: 'm9',
  });
  assert.equal(beaten.applied, false, 'mail must not overwrite a manual edit');

  // Week 4: lock the class, then a notice tries again.
  st = setLocked(st, st.entries[0].id, true);
  const blocked = applyFieldChange(st.entries[0], 'room', '8001', {
    source: 'notice', ref: 'n2',
  });
  assert.equal(blocked.applied, false, 'a locked entry rejects automation');
  assert.equal(blocked.needsPermission, true, 'and says why');

  // Week 5: save, reload, and keep going on the reloaded state.
  let disk = null;
  const w = await saveTimetable(st, { set: async (o) => { disk = JSON.parse(JSON.stringify(o.timetable)); } });
  assert.equal(w.ok, true);
  const reloaded = await loadTimetable({ get: async () => ({ timetable: disk }) });
  assert.equal(reloaded.dropped, 0, 'nothing may be lost on reload');

  // ---- the invariants, all at once ------------------------------------

  // 1. No duplicate events.
  const ids = reloaded.entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate entries');

  // 2. Every entry still traces to a source.
  for (const e of reloaded.entries) {
    for (const f of ['room', 'meetings', 'instructors']) {
      assert.ok(e.provenance?.[f]?.source, `${e.section}.${f} lost its source`);
    }
  }

  // 3. The manual override survived every automatic attempt AND the reload.
  const l1 = reloaded.entries.find((e) => e.section === 'L1');
  assert.equal(l1.room, '7001', 'the manual room must survive');
  assert.equal(l1.provenance.room.source, 'manual');
  assert.equal(l1.locked, true, 'and so must the lock');

  // 4. History is append-only and records the losing values.
  const rooms = l1.history.filter((h) => h.field === 'room');
  assert.ok(rooms.length >= 2, 'each accepted room change is recorded');
  assert.ok(
    rooms.some((h) => String(h.from).includes('5105')),
    'the original value must still be recoverable from history'
  );

  // 5. Linked sections remain reachable and consistent.
  const p1 = reloaded.entries.find((e) => e.section === 'P1');
  assert.equal(p1.linkedTo, 'L1');
  assert.ok(
    reloaded.entries.some((e) => e.section === p1.linkedTo),
    'the linked lecture must still be present'
  );
  assert.deepEqual(
    detectConflicts(reloaded.entries).filter((c) => c.kind === 'orphan-link'), [],
    'an intact pair must not be reported as orphaned'
  );

  // 6. Time conversion is still faithful to the source notation.
  assert.equal(l1.daysHours, 'M W 3 Th 9', 'the source notation is preserved');
  assert.deepEqual(
    l1.meetings.map((m) => `${m.day}${m.hour}`), ['M3', 'W3', 'Th9'],
    'and the expansion still matches it'
  );
  assert.equal(l1.meetings[0].startMin, 600, 'slot 3 is 10:00 per the legend');

  // 7. Exams survive and stay typed.
  const exams = examEvents(reloaded.entries);
  assert.ok(exams.some((e) => e.type === 'compre'), 'the compre must survive');

  // 8. Mail already handled stays handled.
  assert.deepEqual(
    scanMessages([{
      id: 'm9', from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
      subject: 'CS F111 L1 venue change',
      snippet: 'CS F111 L1 will be held in room 6101.', date: Date.now(),
    }], { ...reloaded, appliedMail: ['m9'] }),
    [], 'an applied message must not return'
  );

  // 9. Still matches the catalogue it was built from.
  assert.deepEqual(
    validateAgainstSource(reloaded, { courses: [CS] }), [],
    'a timetable built from this catalogue must not read as stale'
  );
});
