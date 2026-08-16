/**
 * Tests for the academic survivors: enrolment scoping, the course chip, class
 * change detection, and deadline overrides.
 *
 * THE SHARED RISK IN ALL OF THESE IS A CONFIDENT WRONG ANSWER. A course chip
 * for a course the user does not take, a "class cancelled" pin on a Swiggy
 * receipt, or a deadline the parser invented and the user cannot remove -- each
 * is worse than the feature being absent, because each teaches the user to
 * stop believing the surface it appears on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeStorage } from './helpers/storage.mjs';

const mc = await import('../src/app/academic/my-courses.js');
const { detectNotice, summarise, shouldPromote, scanForNotices } = await import('../src/app/academic/notices.js');
const dl = await import('../src/app/academic/deadline-store.js');

const NOW = 1_700_000_000_000;

/* ========================================================================== *
 * ENROLMENT  (58)
 * ========================================================================== */

test('a course can be enrolled and found', () => {
  const list = mc.enrol([], { courseNo: 'CS F111', section: 'L1' });
  assert.equal(mc.isEnrolled(list, 'CS F111'), true);
  assert.equal(mc.sectionFor(list, 'CS F111'), 'L1');
});

test('BITS spacing chaos does not defeat the match', () => {
  // "CS F111", "CSF111", "cs  f111" all appear in real mail, often together.
  const list = mc.enrol([], { courseNo: 'CS F111' });
  for (const variant of ['CSF111', 'cs f111', 'CS  F111', 'cs-f111']) {
    assert.equal(mc.isEnrolled(list, variant), true, variant);
  }
});

test('a course the user does not take is not enrolled', () => {
  const list = mc.enrol([], { courseNo: 'CS F111' });
  assert.equal(mc.isEnrolled(list, 'CS F213'), false);
});

test('enrolling the same course twice updates rather than duplicating', () => {
  let list = mc.enrol([], { courseNo: 'CS F111', section: 'L1' });
  list = mc.enrol(list, { courseNo: 'CS F111', section: 'L2' });
  assert.equal(list.length, 1);
  assert.equal(mc.sectionFor(list, 'CS F111'), 'L2');
});

test('unenrolling removes it', () => {
  const list = mc.unenrol(mc.enrol([], { courseNo: 'CS F111' }), 'CS F111');
  assert.equal(mc.isEnrolled(list, 'CS F111'), false);
});

test('a corrupt enrolment blob degrades to empty', () => {
  for (const bad of [null, 'x', 7, {}, [null], [{ courseNo: 5 }], [{}]]) {
    assert.deepEqual(mc.normaliseEnrolment(bad), []);
  }
});

test('enrolment round-trips through storage', async () => {
  const s = fakeStorage();
  await mc.saveEnrolment(mc.enrol([], { courseNo: 'CS F111', section: 'L1' }), s);
  const back = await mc.loadEnrolment(s);
  assert.equal(back[0].courseNo, 'CS F111');
});

/* ========================================================================== *
 * THE COURSE CHIP  (55)
 * ========================================================================== */

test('a mail mentioning MY course gets a chip', () => {
  const list = mc.enrol([], { courseNo: 'CS F111', section: 'L1' });
  const chip = mc.courseChip(['CS F111'], list);
  assert.equal(chip.label, 'CS F111');
  assert.match(chip.title, /L1/);
});

test('A MAIL MENTIONING A COURSE I DO NOT TAKE GETS NOTHING', () => {
  // The entire justification for feature 58 existing before feature 55.
  const list = mc.enrol([], { courseNo: 'CS F111' });
  assert.equal(mc.courseChip(['CS F213'], list), null);
});

test('with no enrolment recorded, no chip is ever shown', () => {
  assert.equal(mc.courseChip(['CS F111'], []), null);
});

test('a mail mentioning three of my courses shows ONE chip and a count', () => {
  // Three chips on a row is a row that no longer scans.
  let list = mc.enrol([], { courseNo: 'CS F111' });
  list = mc.enrol(list, { courseNo: 'MATH F211' });
  list = mc.enrol(list, { courseNo: 'PHY F110' });
  const chip = mc.courseChip(['MATH F211', 'PHY F110', 'CS F111'], list);
  assert.equal(chip.more, 2);
  assert.match(chip.title, /MATH F211/);
});

test('mineAmong filters detected courses down to the enrolment', () => {
  const list = mc.enrol([], { courseNo: 'CS F111' });
  assert.deepEqual(mc.mineAmong(['CS F111', 'BIO G542'], list), ['CS F111']);
});

/* ========================================================================== *
 * AGAINST THE REAL TIMETABLE
 * ========================================================================== */

const data = JSON.parse(readFileSync(new URL('../src/timetable/data.json', import.meta.url), 'utf8'));

test('a real course resolves out of the shipped timetable', () => {
  const c = mc.findCourse(data, 'CS F111');
  assert.ok(c, 'CS F111 is in the parsed data');
  assert.match(c.title, /PROGRAMMING/i);
});

test('its sections are listed with instructor and room', () => {
  const secs = mc.sectionsOf(data, 'CS F111');
  assert.ok(secs.length > 1, 'CS F111 has several sections');
  assert.ok(secs.some((s) => s.instructor), 'instructors are carried through');
});

test('meetings are derived only for the section the user picked', () => {
  const list = mc.enrol([], { courseNo: 'CS F111', section: 'L1' });
  const meetings = mc.myMeetings(data, list);
  assert.ok(meetings.length > 0);
  assert.ok(meetings.every((m) => m.section === 'L1'), 'no other section leaked in');
});

test('enrolMany resolves a list of typed course numbers', () => {
  const list = mc.enrolMany(data, ['cs f111', 'MATHF211']);
  assert.equal(list.length, 2);
  assert.ok(list.every((e) => e.courseNo === e.courseNo.toUpperCase()));
});

test('an unknown course number is kept rather than silently dropped', () => {
  // The user knows their courses better than a parsed PDF does.
  const list = mc.enrolMany(data, ['ZZ F999']);
  assert.equal(list.length, 1);
});

/* ========================================================================== *
 * CLASS CHANGE DETECTION  (57)
 * ========================================================================== */

const acad = { courses: ['CS F111'], isAcademicSender: true };

test('a room change is detected with both rooms and the right direction', () => {
  const n = detectNotice({ subject: "Tomorrow's CS F111 lecture will be held in 6117 instead of 5105." }, acad);
  assert.equal(n.kind, 'room');
  assert.equal(n.room, '6117');
  assert.equal(n.fromRoom, '5105');
  assert.match(summarise(n), /5105 → 6117/);
});

test('a cancellation is detected', () => {
  const n = detectNotice({ subject: 'The Thursday lab is cancelled.' }, acad);
  assert.equal(n.kind, 'cancelled');
});

test('a reschedule is detected with the new time', () => {
  const n = detectNotice({ subject: 'The lecture has been postponed to Friday 11am' }, acad);
  assert.equal(n.kind, 'reschedule');
  assert.match(n.when, /Friday/);
});

test('an extra class is distinguished from a replacement', () => {
  const n = detectNotice({ subject: 'Extra class for CS F111 on Saturday at 4pm' }, acad);
  assert.equal(n.kind, 'extra');
});

test('A CANCELLED SWIGGY ORDER IS NOT A CLASS CANCELLATION', () => {
  assert.equal(detectNotice({ subject: 'Your Swiggy order was cancelled' }, {}), null);
});

test('a routine mention of a room is not a room change', () => {
  assert.equal(detectNotice({ subject: 'Registration opens Monday in room 5105' }, {}), null);
});

test('A RETRACTED NOTICE DOES NOT FIRE', () => {
  // Forwarding last week's cancellation must not pin it to the top today.
  assert.equal(detectNotice({ subject: 'Please disregard: class cancelled notice sent in error' }, acad), null);
  assert.equal(detectNotice({ subject: 'The class was cancelled last Tuesday' }, acad), null);
});

test('confidence rises with corroboration and a bare match never promotes', () => {
  const bare = detectNotice({ subject: 'Venue is 1204 for the guest talk' }, {});
  assert.ok(bare.confidence < 0.7, `bare match scored ${bare.confidence}`);
  assert.equal(shouldPromote(bare), false, 'a bare pattern match must never pin itself');

  const strong = detectNotice({ subject: 'CS F111 class shifted to 6156' }, acad);
  assert.equal(shouldPromote(strong), true);
});

test('a notice for a course the user does not take scores lower', () => {
  const mine = detectNotice({ subject: 'Class shifted to 6156' }, acad);
  const theirs = detectNotice({ subject: 'Class shifted to 6156' }, {});
  assert.ok(mine.confidence > theirs.confidence);
});

test('the day is extracted when the message names one', () => {
  assert.equal(detectNotice({ subject: 'Thursday lab is cancelled' }, acad).day, 4);
});

test('"in 6117 instead of 6117" does not report a bogus change', () => {
  const n = detectNotice({ subject: 'held in 6117 instead of 6117' }, acad);
  assert.equal(n.fromRoom, undefined);
});

test('scanForNotices returns only promotable ones, newest first, capped', () => {
  /*
   * The resolver is per-message, as the real caller's is: it reports the
   * courses detected IN THAT MESSAGE. An earlier version of this test handed
   * the same "mentions your course" context to every message, including a
   * guest-talk announcement that names no course -- which inflated its
   * confidence to 1.0 and made the test fail for the right reason.
   *
   * Worth keeping the note: the boost is doing real work. A venue line in a
   * mail about YOUR course genuinely is more likely to be a room change than
   * the same line in a mail about a talk.
   */
  const msgs = [
    { id: 'a', subject: 'CS F111 class cancelled', date: 1 },
    { id: 'b', subject: 'CS F111 shifted to 6117', date: 5 },
    { id: 'c', subject: 'Venue is 1204 for the talk', date: 9 },
  ];
  const resolve = (m) =>
    m.subject.includes('CS F111') ? acad : { courses: [], isAcademicSender: false };

  const out = scanForNotices(msgs, resolve, { limit: 3 });
  assert.deepEqual(out.map((x) => x.id), ['b', 'a'], 'the guest talk was not confident enough');
});

test('scanForNotices honours its cap', () => {
  const msgs = Array.from({ length: 6 }, (_, i) => ({
    id: `m${i}`, subject: 'CS F111 class cancelled', date: i,
  }));
  assert.equal(scanForNotices(msgs, () => acad, { limit: 3 }).length, 3);
});

test('detectNotice survives junk input', () => {
  for (const bad of [null, undefined, {}, { subject: null }]) {
    assert.doesNotThrow(() => detectNotice(bad, {}));
  }
});

/* ========================================================================== *
 * DEADLINE OVERRIDES  (60, 61)
 * ========================================================================== */

const withDue = { id: 'm1', dueAt: NOW, dueText: 'by Friday' };

test('an extracted deadline is used when there is no override', () => {
  const e = dl.effectiveDeadline(withDue, {});
  assert.equal(e.at, NOW);
  assert.equal(e.source, 'extracted');
});

test('A USER CORRECTION BEATS THE EXTRACTOR', () => {
  const map = dl.correct({}, 'm1', NOW + 86_400_000, { wasText: 'by Friday', wasAt: NOW });
  const e = dl.effectiveDeadline(withDue, map);
  assert.equal(e.at, NOW + 86_400_000);
  assert.equal(e.source, 'user');
});

test('DISMISSING IS NOT THE SAME AS HAVING NO OPINION', () => {
  /*
   * If a dismissal were stored by deleting, the extractor would re-add the
   * same false deadline on the next ingest and the user would dismiss it
   * forever.
   */
  const map = dl.dismiss({}, 'm1', { wasText: 'by Friday', wasAt: NOW });
  const e = dl.effectiveDeadline(withDue, map);
  assert.equal(e.at, null);
  assert.equal(e.source, 'user');
  assert.equal(dl.isOverridden(map, 'm1'), true);
});

test('a manual deadline works on a message the extractor ignored', () => {
  const map = dl.setManual({}, 'm2', NOW);
  assert.equal(dl.dueAtOf({ id: 'm2' }, map), NOW);
});

test('a message with nothing at all has no deadline', () => {
  const e = dl.effectiveDeadline({ id: 'm3' }, {});
  assert.equal(e.at, null);
  assert.equal(e.source, 'none');
});

test('clearing an override restores the extracted value', () => {
  let map = dl.correct({}, 'm1', NOW + 1000);
  map = dl.clearOverride(map, 'm1');
  assert.equal(dl.effectiveDeadline(withDue, map).source, 'extracted');
});

test('an override for a non-finite date is refused', () => {
  assert.deepEqual(dl.correct({}, 'm1', NaN), {});
  assert.deepEqual(dl.setManual({}, 'm1', 'tomorrow'), {});
});

test('CORRECTIONS BUILD A LABELLED CORPUS', () => {
  // The only route to an extractor that improves.
  let map = dl.correct({}, 'm1', NOW + 1000, { wasText: 'by Friday', wasAt: NOW });
  map = dl.dismiss(map, 'm2', { wasText: 'last year: 3 May', wasAt: NOW - 99 });
  map = dl.setManual(map, 'm3', NOW);
  const c = dl.corpus(map);
  assert.equal(c.length, 2, 'the manual entry teaches nothing about parsing');
  assert.ok(c.some((x) => x.verdict === 'not-a-deadline'));
  assert.ok(c.some((x) => x.verdict === 'wrong-date'));
});

test('pruning drops overrides for messages that have left', () => {
  const map = dl.correct({}, 'gone', NOW);
  assert.deepEqual(dl.pruneOverrides(map, new Set(['other'])), {});
});

test('pruning returns the SAME object when nothing changed', () => {
  const map = dl.correct({}, 'm1', NOW);
  assert.equal(dl.pruneOverrides(map, new Set(['m1'])), map);
});

test('a missing liveIds prunes NOTHING, not everything (round 10, M-3)', () => {
  /*
   * `new Set(undefined)` is an EMPTY set, so a forgotten second argument made
   * every override look dead and dropped the lot -- and these are the user's
   * hand-made deadline corrections, a backup:true class of data. The only
   * production caller passes a real Set, so this was latent; "delete
   * everything" is still the wrong failure mode for a missing argument.
   */
  const map = dl.correct(dl.correct({}, 'm1', NOW), 'm2', NOW);
  assert.equal(dl.pruneOverrides(map, undefined), map, 'undefined must prune nothing');
  assert.equal(dl.pruneOverrides(map, null), map, 'null must prune nothing');
  /* An EXPLICITLY empty set still means "nothing is live" and still prunes. */
  assert.deepEqual(dl.pruneOverrides(map, new Set()), {});
  assert.deepEqual(dl.pruneOverrides(map, []), {});
});

test('a corrupt override blob degrades to empty', () => {
  for (const bad of [null, 'x', 7, [], { m1: null }, { m1: { at: 'soon' } }]) {
    assert.deepEqual(dl.normaliseOverrides(bad), {});
  }
});

test('a null date survives normalising, because dismissal depends on it', () => {
  const out = dl.normaliseOverrides({ m1: { at: null, origin: 'dismissed', setAt: 1 } });
  assert.equal(out.m1.at, null);
});

test('overrides round-trip through storage', async () => {
  const s = fakeStorage();
  await dl.saveOverrides(dl.correct({}, 'm1', NOW), s);
  assert.equal((await dl.loadOverrides(s)).m1.at, NOW);
});

test('over the cap, the OLDEST overrides go — not the newest (round 10, L-5)', () => {
  /*
   * MAX_OVERRIDES was enforced only in normaliseOverrides, as a `break` while
   * walking Object.entries — i.e. in insertion order. Measured with 505
   * overrides: the reload kept m0000..m0499 and discarded the five the user
   * had just made. The UI had already confirmed, so the correction simply
   * vanished after a reload, which is the worst shape a data loss can take.
   */
  let map = {};
  for (let i = 0; i < dl.MAX_OVERRIDES + 5; i++) {
    map = dl.setManual(map, `m${String(i).padStart(4, '0')}`, 1000 + i, { now: 1000 + i });
  }
  assert.equal(Object.keys(map).length, dl.MAX_OVERRIDES, 'capped at the write, not only at the load');
  assert.ok('m0504' in map, 'the newest correction survives');
  assert.ok(!('m0000' in map), 'the oldest is the one evicted');

  /* And a reload of an over-cap blob makes the same choice. */
  const over = {};
  for (let i = 0; i < dl.MAX_OVERRIDES + 3; i++) {
    over[`k${String(i).padStart(4, '0')}`] = { at: 5000, origin: 'manual', setAt: 1000 + i };
  }
  const back = dl.normaliseOverrides(over);
  assert.equal(Object.keys(back).length, dl.MAX_OVERRIDES);
  assert.ok('k0502' in back, 'newest survives the reload too');
  assert.ok(!('k0000' in back));
});
