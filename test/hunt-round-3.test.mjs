/**
 * Bug hunt, round 3 of 10 (2026-08-16).
 *
 * Both defects here are the FOURTH and FIFTH call site of rules this codebase
 * had already written down once: "identity is a parsed mailbox, not a
 * substring" (round 8, H-1) and "text that says the opposite is not evidence"
 * (round 11, B10). They are pinned per call site because that is how they
 * keep coming back — the rule was known, the new caller simply did not use it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ========================================================================
 * B11 · a correction did not follow the sender's plus-tagged mail
 * ==================================================================== */

test('B11: a sender correction follows the whole mailbox, tag included', async () => {
  /*
   * MEASURED: correctSender/applyCorrection keyed on addressOf, which keeps
   * `+tag`. A correction recorded against `augsd@…` did not apply to
   * `augsd+notices@…` — the same sender filing their own mail. The user
   * re-files it, the correction appears not to stick, and nothing on screen
   * explains why.
   */
  const r = await import('../src/app/mail/rules.js');
  let rules = r.emptyRules();
  rules = r.correctSender(rules, 'AUGSD <augsd@pilani.bits-pilani.ac.in>', 'admin');

  const categoryFor = (from) =>
    r.applyCorrection(rules, { id: 'x', from, subject: 's', snippet: '', category: 'other', labels: [] }).category;

  for (const from of [
    'AUGSD <augsd@pilani.bits-pilani.ac.in>',
    'augsd@pilani.bits-pilani.ac.in',
    'AUGSD@PILANI.BITS-PILANI.AC.IN',
    'augsd+notices@pilani.bits-pilani.ac.in',
    'augsd+2026@pilani.bits-pilani.ac.in',
  ]) {
    assert.equal(categoryFor(from), 'admin', from);
  }

  /* And it must not spread to anyone else. A lookalike local part is a
     DIFFERENT mailbox, and folding it would silently re-file a stranger. */
  for (const from of ['notaugsd@pilani.bits-pilani.ac.in', 'augsd@other.z', 'other@x.z']) {
    assert.equal(categoryFor(from), 'other', from);
  }
});

test('B11: clearing a correction clears every tagged form too', async () => {
  /* Set and clear must key identically, or a correction becomes unclearable
     from the tagged address that is showing on screen. */
  const r = await import('../src/app/mail/rules.js');
  let rules = r.correctSender(r.emptyRules(), 'augsd@pilani.bits-pilani.ac.in', 'admin');
  rules = r.clearCorrection(rules, 'augsd+notices@pilani.bits-pilani.ac.in');
  const out = r.applyCorrection(rules,
    { id: 'x', from: 'augsd@pilani.bits-pilani.ac.in', subject: 's', snippet: '', category: 'other', labels: [] });
  assert.equal(out.category, 'other', 'the correction is gone');
});

/* ========================================================================
 * B12 · the notices rail announced the opposite of the message
 * ==================================================================== */

const acad = { courses: ['CS F211'], isAcademicSender: true };
const notice = async (subject) => {
  const n = await import('../src/app/academic/notices.js');
  return n.detectNotice(
    { id: 'x', from: 'augsd@pilani.bits-pilani.ac.in', subject, snippet: '', date: 1, labels: [] }, acad);
};

test('B12: a negated notice is not promoted to the rail', async () => {
  /*
   * MEASURED, all at confidence 1 — which clears shouldPromote and reaches
   * the rail:
   *
   *   'CS F211 class is NOT cancelled'      -> banner "CS F211: class cancelled"
   *   'The extra class has been withdrawn'  -> banner "CS F211: extra class"
   *
   * A student who trusts the banner skips a class that is running. The
   * rail's entire value is being believed at a glance, so a confident lie
   * there is worse than showing nothing.
   */
  const n = await import('../src/app/academic/notices.js');
  for (const subject of [
    'CS F211 class is NOT cancelled',
    'CS F211 class will not be cancelled',
    'CS F211 class is not being rescheduled',
    'The extra class has been withdrawn',
    'The room change notice has been withdrawn',
    'CS F211 venue remains unchanged',
    'No change to the CS F211 schedule',
  ]) {
    const got = await notice(subject);
    assert.equal(got, null, `${subject} -> ${got && n.summarise(got)}`);
    assert.equal(n.shouldPromote(got), false);
  }
});

test('B12: a real notice is still detected, including one containing "not"', async () => {
  /*
   * THE OVER-CORRECTION GUARD, and the reason each pattern binds the
   * negation to its verb rather than matching a bare `not`: a genuine notice
   * legitimately contains "not" in unrelated prose, and a fix that gagged
   * those would pass the test above while destroying the feature.
   */
  assert.equal((await notice('CS F211 class cancelled tomorrow'))?.kind, 'cancelled');
  assert.equal((await notice('Notice: CS F211 room changed to 6101'))?.kind, 'room');
  assert.equal((await notice('Extra class for CS F211 on Saturday'))?.kind, 'extra');

  const withNot = await notice('Students may not park bicycles. CS F211 class cancelled tomorrow.');
  assert.equal(withNot?.kind, 'cancelled',
    'an unrelated "not" elsewhere in the notice must not gag the detector');

  /* "please note" and "notice" contain `not` as a substring — \b protects
     them, and this pins that it stays protected. */
  assert.equal((await notice('Please note: CS F211 class cancelled'))?.kind, 'cancelled');
});

test('B12: the stale guard it was added beside still works', async () => {
  /* The negation patterns joined an existing STALE list. Adding to a list is
     how a list gets broken, so its original members are re-pinned here. */
  for (const subject of [
    'CS F211 class was cancelled yesterday',
    'CS F211 class had been shifted — kindly ignore',
    'Please disregard: CS F211 class cancelled',
  ]) {
    assert.equal(await notice(subject), null, subject);
  }
});

/* ========================================================================
 * B13 · reply-all Cc'd the user and duplicated recipients
 * ==================================================================== */

test('B13: reply-all never Ccs the user, in any spelling', async () => {
  /*
   * MEASURED on a realistic thread: a mailing list expanded my address as
   * `f20240294+cs@…`, which did not match `self`, so every reply-all put ME
   * in the Cc — I received a copy of my own message each time. That is the
   * normal shape of list mail, not an exotic one, and reply-all is exactly
   * when it bites.
   */
  const { buildReply } = await import('../src/app/search/query.js');
  const { mailboxOf } = await import('../src/app/core/contacts.js');
  const ME = 'f20240294@pilani.bits-pilani.ac.in';
  const body = (o) => ({ from: 'prof@pilani.bits-pilani.ac.in', to: '', cc: '',
    subject: 'S', text: 'x', date: 0, messageId: '<m>', threadId: 'T', ...o });

  for (const mine of [ME, 'f20240294+cs@pilani.bits-pilani.ac.in',
    'F20240294@PILANI.BITS-PILANI.AC.IN', `Me <${ME}>`]) {
    const r = buildReply(body({ to: `${mine}, classmate@x.z` }), ME, 'replyAll');
    const cc = r.cc.split(/,\s*/).filter(Boolean);
    assert.ok(!cc.some((a) => mailboxOf(a) === mailboxOf(ME)),
      `reply-all Cc'd the user as ${mine}: ${r.cc}`);
    assert.ok(cc.some((a) => a.includes('classmate')), 'the real recipient stays');
  }
});

test('B13: one person is Ccd once, however their address is spelled', async () => {
  /* A TA appearing as ta@… and ta+grading@… was Cc'd twice and received two
     copies. Identity folds; the spelling that goes on the wire does not. */
  const { buildReply } = await import('../src/app/search/query.js');
  const r = buildReply({ from: 'prof@x.z', to: 'ta@x.z, other@x.z',
    cc: 'ta+grading@x.z', subject: 'S', text: 'x', date: 0,
    messageId: '<m>', threadId: 'T' }, 'me@x.z', 'replyAll');
  const cc = r.cc.split(/,\s*/).filter(Boolean);
  assert.equal(cc.filter((a) => a.startsWith('ta')).length, 1, `duplicated: ${r.cc}`);
  assert.equal(cc.length, 2, 'the TA and the other recipient, once each');
});

test('B13: the sender is never also Ccd, and the wire keeps real spellings', async () => {
  const { buildReply } = await import('../src/app/search/query.js');
  const r = buildReply({ from: 'them@y.z', to: 'a@b.c', cc: 'them+x@y.z',
    subject: 'S', text: 'x', date: 0, messageId: '<m>', threadId: 'T' },
  'me@x.z', 'replyAll');
  assert.equal(r.to, 'them@y.z');
  assert.equal(r.cc, 'a@b.c', 'the sender, tagged, is not Ccd on their own reply');

  /* The fold decides identity; it must not REWRITE an address. A recipient
     whose real mailbox includes a tag must receive it as they wrote it. */
  const keep = buildReply({ from: 'p@x.z', to: 'list+members@x.z',
    subject: 'S', text: 'x', date: 0, messageId: '<m>', threadId: 'T' },
  'me@x.z', 'replyAll');
  assert.equal(keep.cc, 'list+members@x.z', 'the tag survives onto the wire');
});

/* ========================================================================
 * B14 · the enrolment list's readers and writers disagreed
 * ==================================================================== */

test('B14: enrolling a differently-spaced course replaces, never duplicates', async () => {
  /*
   * MEASURED against a list holding `CS F211`: enrol({courseNo:'CSF211'})
   * produced TWO rows for one course. isEnrolled then reported true while
   * sectionFor returned whichever row came first — the user sees one course
   * listed twice with different sections and cannot tell which is live.
   */
  const mc = await import('../src/app/academic/my-courses.js');
  let list = mc.enrol([], { courseNo: 'CS F211', section: 'L1', comCode: '1008' });
  for (const spelling of ['CSF211', 'cs f211', 'CS  F211', 'cs-f211']) {
    const next = mc.enrol(list, { courseNo: spelling, section: 'L2', comCode: '1008' });
    assert.equal(next.length, 1, `${spelling} created a duplicate row`);
  }
  /* A genuinely different course still adds. */
  assert.equal(mc.enrol(list, { courseNo: 'MATH F211', section: 'L1', comCode: '2001' }).length, 2);
});

test('B14: unenrolling by any spelling actually removes the course', async () => {
  /* unenrol compared raw uppercase, so unenrol('CSF211') on a `CS F211` row
     removed nothing — the course stayed enrolled and the button looked dead. */
  const mc = await import('../src/app/academic/my-courses.js');
  const list = mc.enrol([], { courseNo: 'CS F211', section: 'L1', comCode: '1008' });
  for (const spelling of ['CS F211', 'CSF211', 'csf211', 'cs  f211']) {
    assert.equal(mc.unenrol(list, spelling).length, 0, `unenrol('${spelling}') did nothing`);
  }
  assert.equal(mc.unenrol(list, 'MATH F211').length, 1, 'another course is untouched');
});

test('B14: every enrolment function agrees on what a course number is', async () => {
  /*
   * THE INVARIANT, not the instances. Readers used canonical() and writers
   * did not; asserting they now AGREE is what stops the next function from
   * picking the wrong one.
   */
  const mc = await import('../src/app/academic/my-courses.js');
  const list = mc.enrol([], { courseNo: 'CS F211', section: 'L1', comCode: '1008' });
  for (const spelling of ['CS F211', 'CSF211', 'cs f211', 'CS  F211']) {
    assert.equal(mc.isEnrolled(list, spelling), true, `isEnrolled ${spelling}`);
    assert.equal(mc.sectionFor(list, spelling), 'L1', `sectionFor ${spelling}`);
    assert.equal(mc.mineAmong([spelling], list).length, 1, `mineAmong ${spelling}`);
    assert.equal(mc.unenrol(list, spelling).length, 0, `unenrol ${spelling}`);
    assert.equal(mc.enrol(list, { courseNo: spelling, section: 'L1' }).length, 1, `enrol ${spelling}`);
  }
});

/* ========================================================================
 * THE CLASS, NOT THE INSTANCES
 * ==================================================================== */

test('no module decides sender identity with a substring test', async () => {
  /*
   * SEVEN CALL SITES OF ONE RULE, FOUND ONE AT A TIME.
   *
   *   round 8  H-1  audience.js       plus-tag broke Needs-reply
   *   round 10 H-1  timetable-mail.js `includes` accepted a lookalike domain
   *   round 11 B5   contacts.js       plus-tagged self in own contacts
   *   round 11 B6   followups.js      'notme@x.z' read as me, forever nagging
   *   round 11 B7   lanes.js          a FORGED display name answered for me
   *   round 11 B11  rules.js          corrections did not follow +tag mail
   *   round 11 B13  query.js          reply-all Ccd me and duplicated a TA
   *
   * Each was fixed where it was found; the rule was already written down
   * every time. Fixing instances one per round is losing, so this asserts
   * the CLASS: a source line may not test whether a raw header CONTAINS an
   * identity. `mailboxOf()` parses and folds, and is the only sanctioned
   * answer to "is this the same person".
   *
   * PRECISION MATTERS MORE THAN REACH HERE. My first version flagged
   * `audience.js`, which is CORRECT code: `to.includes(self)` there is
   * Array.includes over recipients already parsed by splitRecipients, and
   * banning it would have pushed a good module toward a worse pattern.
   *
   * So the gate matches the shape that was actually wrong every time — a
   * STRING coerced from a raw header, tested for containment:
   *
   *     String(m.from || '').toLowerCase().includes(me)
   *     from.includes(me)                     // `from` is the raw header
   *
   * and not a containment test on an array. The distinction is the
   * `String(...)`/`.toLowerCase()` chain and the bare header identifier;
   * a parsed list is always assigned to a plural name first.
   */
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');

  const IDENTITY = [
    /String\s*\([^)]*\)\s*(?:\.\s*toLowerCase\s*\(\)\s*)?\.\s*includes\s*\(\s*(?:me|self|selfEmail|myAddress)\b/,
    /\b(?:from|sender|fromHeader)\s*\.\s*(?:toLowerCase\s*\(\)\s*\.\s*)?includes\s*\(\s*(?:me|self|selfEmail|myAddress)\b/,
  ];
  const offenders = [];

  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      /* Comments record the defect and must keep naming it. */
      const code = readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ');
      code.split('\n').forEach((line, i) => {
        if (IDENTITY.some((re) => re.test(line))) offenders.push(`${full}:${i + 1}: ${line.trim()}`);
      });
    }
  };
  walk('src');

  assert.deepEqual(offenders, [],
    'identity is a parsed mailbox, not a substring — use mailboxOf() from core/contacts.js');
});
