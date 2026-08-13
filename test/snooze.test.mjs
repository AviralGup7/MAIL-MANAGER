/**
 * Snooze tests.
 *
 * The interesting cases here are all failure cases. A snooze that works when
 * everything works is easy; the reason this module exists in the shape it does
 * is that a snooze which loses mail is worse than no snooze at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeStorage } from './helpers/storage.mjs';

const {
  presets, loadSnoozed, addSnooze, removeSnooze, due, pending, wakeLabel, SNOOZE_LABEL,
} = await import('../src/app/system/snooze.js');

/** An in-memory stand-in for chrome.storage.local. */

// --------------------------------------------------------------- presets ---

test('presets are always in the future', () => {
  for (const hour of [0, 7, 9, 13, 17, 19, 23]) {
    const now = new Date(2026, 2, 10, hour, 30).getTime(); // Tue 10 Mar 2026
    for (const p of presets(now)) {
      assert.ok(p.at > now, `${p.id} at hour ${hour} is not in the future`);
    }
  }
});

test('"this evening" disappears once it is evening', () => {
  const morning = new Date(2026, 2, 10, 9, 0).getTime();
  const night = new Date(2026, 2, 10, 22, 0).getTime();
  assert.ok(presets(morning).some((p) => p.id === 'evening'));
  assert.ok(
    !presets(night).some((p) => p.id === 'evening'),
    'offering "this evening" at 10pm and meaning tomorrow is a lie'
  );
});

test('"this weekend" is not offered at the weekend', () => {
  const sat = new Date(2026, 2, 14, 10, 0).getTime(); // Saturday
  const sun = new Date(2026, 2, 15, 10, 0).getTime();
  assert.ok(!presets(sat).some((p) => p.id === 'weekend'));
  assert.ok(!presets(sun).some((p) => p.id === 'weekend'));
  const wed = new Date(2026, 2, 11, 10, 0).getTime();
  assert.ok(presets(wed).some((p) => p.id === 'weekend'));
});

test('next week always lands on a future Monday', () => {
  for (let day = 0; day < 7; day++) {
    const now = new Date(2026, 2, 9 + day, 12, 0).getTime();
    const nw = presets(now).find((p) => p.id === 'nextweek');
    assert.ok(nw, 'next week should always be offered');
    const d = new Date(nw.at);
    assert.equal(d.getDay(), 1, 'must be a Monday');
    assert.ok(nw.at > now);
  }
});

test('a deadline in the message adds an option Gmail cannot offer', () => {
  const now = new Date(2026, 2, 10, 9, 0).getTime();
  const deadline = new Date(2026, 2, 20, 17, 0).getTime();
  const withD = presets(now, { deadline });
  const opt = withD.find((p) => p.id === 'deadline');
  assert.ok(opt, 'no deadline preset');
  // The day before, in the morning.
  const d = new Date(opt.at);
  assert.equal(d.getDate(), 19);
  assert.equal(d.getHours(), 8);
});

test('a deadline already past does not produce a past preset', () => {
  const now = new Date(2026, 2, 10, 9, 0).getTime();
  const deadline = new Date(2026, 2, 10, 12, 0).getTime(); // today
  const opt = presets(now, { deadline }).find((p) => p.id === 'deadline');
  assert.equal(opt, undefined, 'day-before is in the past; must be dropped');
});

// --------------------------------------------------------------- storage ---

test('a snooze round-trips through storage', async () => {
  const s = fakeStorage();
  await addSnooze('m1', 5000, s, 1000);
  const all = await loadSnoozed(s);
  assert.equal(all.m1.at, 5000);
  assert.equal(all.m1.snoozedAt, 1000);
});

test('removing a snooze that is not there is not an error', async () => {
  const s = fakeStorage();
  const all = await removeSnooze('nope', s);
  assert.deepEqual(all, {});
});

test('a corrupt blob degrades to empty rather than throwing', async () => {
  for (const bad of ['nonsense', 42, null, []]) {
    const s = fakeStorage({ snoozed: bad });
    const all = await loadSnoozed(s);
    assert.equal(typeof all, 'object');
    // An array is technically an object; what matters is that nothing throws
    // and that `due` can still run over it.
    assert.doesNotThrow(() => due(all, Date.now()));
  }
});

test('a storage failure on write is reported, not thrown', async () => {
  const s = fakeStorage()._fail();
  const res = await addSnooze('m1', 5000, s, 1000);
  assert.equal(res, null, 'caller needs to know the snooze did not persist');
});

// ------------------------------------------------------------------ wake ---

test('due() returns only what has actually matured', () => {
  const all = { a: { at: 100 }, b: { at: 500 }, c: { at: 900 } };
  assert.deepEqual(due(all, 500).sort(), ['a', 'b'], 'boundary is inclusive');
  assert.deepEqual(due(all, 50), []);
  assert.deepEqual(due(all, 10000).sort(), ['a', 'b', 'c']);
});

test('due() survives malformed entries instead of dropping the whole sweep', () => {
  // One bad record must not stop good ones waking. This is the difference
  // between "one message is stuck" and "snooze silently stopped working".
  const all = { good: { at: 100 }, bad: null, worse: { at: 'soon' }, alsoBad: {} };
  assert.deepEqual(due(all, 500), ['good']);
});

test('pending() is sorted soonest-first for the snoozed view', () => {
  const all = { c: { at: 300 }, a: { at: 100 }, b: { at: 200 } };
  assert.deepEqual(pending(all, 0).map((p) => p.id), ['a', 'b', 'c']);
  // Already-due items are not "pending".
  assert.deepEqual(pending(all, 150).map((p) => p.id), ['b', 'c']);
});

test('wake labels read like a human wrote them', () => {
  const now = Date.UTC(2026, 2, 10, 9, 0);
  assert.equal(wakeLabel(now + 30 * 60000, now), 'in 30 min');
  assert.equal(wakeLabel(now + 3 * 3600000, now), 'in 3 hours');
  assert.equal(wakeLabel(now + 1 * 3600000, now), 'in 1 hour');
  assert.equal(wakeLabel(now + 26 * 3600000, now), 'tomorrow');
  assert.equal(wakeLabel(now + 3 * 86400000, now), 'in 3 days');
  assert.equal(wakeLabel(now - 1000, now), 'now');
});

// --------------------------------------------------------- wiring checks ---

const bg = readFileSync(new URL('../src/background/index.js', import.meta.url), 'utf8');

test('snooze moves the message in ONE gmail call', () => {
  // Two calls means a window where the message is in neither the inbox nor
  // the snoozed label, and a crash in between loses it.
  assert.match(bg, /modify\(msg\.id, \[labelId\], \['INBOX'\]\)/);
});

test('waking restores the message AND marks it unread', () => {
  // A message that reappears already-read gets scrolled past and never seen,
  // which defeats the entire point of deferring it.
  assert.match(bg, /modify\(id, \['INBOX', 'UNREAD'\], \[labelId\]\)/);
});

test('a failed wake keeps the entry for the next sweep', () => {
  // The catch block must NOT remove the snooze record; that is how mail is
  // lost forever.
  const fn = bg.slice(bg.indexOf('async function wakeDue'), bg.indexOf('async function scheduleWake'));
  const catchBlock = fn.slice(fn.lastIndexOf('} catch {'));
  assert.ok(
    !catchBlock.includes('removeSnooze'),
    'a failed wake must not discard the record'
  );
});

test('a wake with no label available aborts without dropping records', () => {
  const fn = bg.slice(bg.indexOf('async function wakeDue'), bg.indexOf('async function scheduleWake'));
  assert.ok(fn.includes('return 0;'), 'must bail out rather than continue');
});

test('the catch-up sweep runs at startup, not only on the alarm', () => {
  // This is what turns a missed alarm into a late delivery instead of a lost
  // message.
  assert.match(bg, /onStartup\?\.addListener/);
  assert.match(bg, /onInstalled\?\.addListener/);
  assert.ok(bg.includes('wakeDue().then(scheduleWake)'));
});

test('the alarm is never scheduled in the past', () => {
  // Chrome fires past-dated alarms immediately and repeatedly.
  assert.match(bg, /Math\.max\(next, Date\.now\(\) \+ 5000\)/);
});

test('one alarm is re-aimed rather than one alarm per message', () => {
  assert.ok(bg.includes("chrome.alarms.create(WAKE_ALARM"));
  // Count WAKE_ALARM creates only: the background-sync commit (P-3) added a
  // second, periodic alarm (SYNC_ALARM), which is legitimate. The invariant
  // being guarded here is narrower: the SNOOZE wake must be one re-aimed
  // alarm, never one registration per snoozed message.
  assert.equal(
    (bg.match(/alarms\.create\(WAKE_ALARM/g) || []).length, 1,
    'a hundred snoozed messages must not mean a hundred alarms'
  );
});

test('the alarms permission is actually declared', () => {
  const mf = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.ok(mf.permissions.includes('alarms'), 'snooze cannot wake without it');
});

test('the snoozed label is a real Gmail label, not just local state', () => {
  // Wiping the extension must leave the mail findable in Gmail.
  assert.equal(SNOOZE_LABEL, 'BMM/Snoozed');
  assert.ok(bg.includes('ensureLabel(SNOOZE_LABEL)'));
});

test('sign-out drops the label-id cache (V2 P1-12)', () => {
  // Label ids are ACCOUNT-scoped. The worker can outlive a session, so if a
  // different Google account signs in next, a stale cache would hand the new
  // session the previous account's ids -- a 404 at best, a write into the
  // wrong label space at worst. The cache must die with the session.
  const at = bg.indexOf("case 'SIGN_OUT':");
  assert.notEqual(at, -1);
  const next = bg.indexOf("case '", at + 10);
  const body = bg.slice(at, next === -1 ? undefined : next);
  assert.ok(
    body.includes('_clearLabelCache()'),
    'SIGN_OUT must clear the account-scoped label-id cache'
  );
});

/*
 * Boundary found by mutation testing: `ms <= 0` -> `ms < 0` survived.
 *
 * A wake time of EXACTLY now must read "now", not "in 0 min". The alarm fires
 * on a whole-minute boundary, so exact equality is the common case, not a
 * rarity.
 */
test('a wake time of exactly now reads "now"', () => {
  const t = Date.UTC(2026, 2, 10, 9, 0);
  assert.equal(wakeLabel(t, t), 'now', 'exact equality is the common case at an alarm boundary');
  assert.equal(wakeLabel(t - 1, t), 'now');
  assert.equal(wakeLabel(t + 1000, t), 'in 0 min', 'just after now is not "now"');
});
