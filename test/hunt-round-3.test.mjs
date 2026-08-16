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
