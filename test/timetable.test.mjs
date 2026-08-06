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
  weekView, summariseMeetings, explainEntry, entriesForMessage, PRECEDENCE,
} from '../src/app/timetable.js';

import {
  scanMessage, scanMessages, matchNotice,
  isAcademicSender, courseNumbersIn, sectionsIn,
} from '../src/app/timetable-mail.js';

import {
  loadTimetable, saveTimetable, clearTimetable,
  searchCourses, courseByComCode, loadSourceData, _resetSourceData,
} from '../src/app/timetable-store.js';

import { parseDaysHours, parseNotice, parseTimetable } from '../tools/parse-timetable.mjs';

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
      midsem: '02/12 AN', compre: '', unresolved: [],
    },
    {
      section: 'L2', kind: 'lecture', instructors: ['Yash Sinha'], room: '5105',
      daysHours: 'M W 2 T 8',
      meetings: [
        { day: 'M', dayName: 'Monday', hour: 2, startMin: 540, endMin: 590 },
        { day: 'W', dayName: 'Wednesday', hour: 2, startMin: 540, endMin: 590 },
        { day: 'T', dayName: 'Tuesday', hour: 8, startMin: 900, endMin: 950 },
      ],
      midsem: '02/12 AN', compre: '', unresolved: [],
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
  assert.equal(found[0].actionable, false, 'the wrapped cells are not parsed into values');
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
