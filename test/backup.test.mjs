/**
 * Backup and restore tests.
 *
 * ONE TEST HERE MATTERS MORE THAN ALL THE OTHERS: a backup file must never
 * contain an OAuth token. A config file people mail to themselves is the worst
 * possible place for a credential, and the allow-list is what prevents it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStorage } from './helpers/storage.mjs';

const {
  exportBackup, importBackup, previewImport, validateBackup, toJson,
  filenameFor, EXPORTED_KEYS, NEVER_EXPORT, BACKUP_VERSION,
} = await import('../src/app/backup.js');

const seeded = () =>
  fakeStorage({
    // Settings are FLAT TOP-LEVEL KEYS. An earlier version of this fake used
    // `{settings: {theme}}`, a shape that has never existed in storage -- and
    // because the exporter looked for the same fictional key, the tests agreed
    // with the bug instead of with the system. See the note in backup.js.
    theme: 'nord',
    density: 'compact',
    categoryRules: { muted: ['clubs'], corrections: { 'a@b.com': 'academics' } },
    automationRules: [{ id: 'r1', query: 'from:x', actions: [{ type: 'archive' }] }],
    myCourses: [{ courseNo: 'CS F111' }],
    // Things that must never leave the machine:
    token: 'ya29.SECRET-ACCESS-TOKEN',
    refreshToken: '1//SECRET-REFRESH',
    messageCache: { m1: { body: 'private mail body' } },
    activityLog: [{ at: 1, verb: 'ARCHIVE' }],
    outbox: [{ id: 'ob1', draft: { to: 'x' } }],
  });

// ------------------------------------------------------------- the big one --

test('A BACKUP NEVER CONTAINS CREDENTIALS OR MAIL CONTENT', async () => {
  const json = toJson(await exportBackup(seeded()));
  assert.doesNotMatch(json, /ya29\./, 'no access token');
  assert.doesNotMatch(json, /SECRET/, 'no secrets of any kind');
  assert.doesNotMatch(json, /private mail body/, 'no cached message content');
  assert.doesNotMatch(json, /activityLog/, 'no diagnostic log');
});

test('the exclusion is an ALLOW-LIST, so a new sensitive key cannot leak', async () => {
  /*
   * A deny-list fails open: the day someone adds a storage key holding
   * something sensitive, a deny-list exports it and nobody notices. This
   * asserts the mechanism, not just today's outcome.
   */
  const s = seeded();
  await s.set({ someFutureSecretKey: 'oops' });
  const backup = await exportBackup(s);
  assert.ok(!('someFutureSecretKey' in backup.data));
  for (const key of Object.keys(backup.data)) {
    assert.ok(EXPORTED_KEYS.includes(key), `${key} is on the allow-list`);
  }
});

test('everything on the never-export list is genuinely absent', async () => {
  const backup = await exportBackup(seeded());
  for (const key of NEVER_EXPORT) {
    assert.ok(!(key in backup.data), `${key} must not be exported`);
  }
});

// ------------------------------------------------------------------ export --

test('what the user configured IS exported', async () => {
  const backup = await exportBackup(seeded());
  assert.equal(backup.data.theme, 'nord');
  assert.equal(backup.data.density, 'compact');
  assert.deepEqual(backup.data.categoryRules.muted, ['clubs']);
  assert.equal(backup.data.automationRules.length, 1);
});

test('the envelope is versioned and self-identifying', async () => {
  const backup = await exportBackup(seeded());
  assert.equal(backup.format, 'bits-mail-manager-backup');
  assert.equal(backup.version, BACKUP_VERSION);
  assert.ok(Array.isArray(backup.keys));
});

test('an empty profile exports cleanly rather than failing', async () => {
  const backup = await exportBackup(fakeStorage());
  assert.deepEqual(backup.data, {});
});

test('ONE UNREADABLE KEY DOES NOT FAIL THE WHOLE EXPORT', async () => {
  // A partial backup is far better than none.
  const s = seeded();
  const realGet = s.get.bind(s);
  s.get = async (k) => {
    if (k === 'templates') throw new Error('corrupt');
    return realGet(k);
  };
  const backup = await exportBackup(s);
  assert.ok(backup.data.theme, 'the rest still came through');
});

test('the filename carries the date so backups do not overwrite', () => {
  const name = filenameFor({ exportedAt: Date.UTC(2026, 7, 8) });
  assert.match(name, /^bmm-backup-2026-08-08\.json$/);
});

// -------------------------------------------------------------- validation --

test('junk is rejected with a reason a human can act on', () => {
  for (const bad of ['not json', '{}', null, 7, '[]', JSON.stringify({ format: 'something-else' })]) {
    const r = validateBackup(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.reason, /\S/);
  }
});

test('a NEWER backup is refused rather than half-imported', () => {
  const r = validateBackup({ format: 'bits-mail-manager-backup', version: 999, data: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /newer version/);
});

test('a valid backup passes, from an object or a string', async () => {
  const backup = await exportBackup(seeded());
  assert.equal(validateBackup(backup).ok, true);
  assert.equal(validateBackup(toJson(backup)).ok, true);
});

// ----------------------------------------------------------------- preview --

test('the preview says what would change BEFORE anything is written', async () => {
  const backup = await exportBackup(seeded());
  const target = fakeStorage({ theme: 'daylight' });
  const p = await previewImport(backup, target);
  assert.equal(p.ok, true);
  const themeChange = p.changes.find((c) => c.key === 'theme');
  assert.equal(themeChange.action, 'replace');
  const courses = p.changes.find((c) => c.key === 'myCourses');
  assert.equal(courses.action, 'add');
  assert.equal(target.writes, 0, 'a preview writes nothing');
});

test('the preview counts records so the user can judge the trade', async () => {
  const backup = await exportBackup(seeded());
  const target = fakeStorage({ automationRules: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  const p = await previewImport(backup, target);
  const rules = p.changes.find((c) => c.key === 'automationRules');
  assert.equal(rules.currentCount, 3);
  assert.equal(rules.incomingCount, 1);
});

// ------------------------------------------------------------------ import --

test('a backup round-trips into an empty profile', async () => {
  const backup = await exportBackup(seeded());
  const target = fakeStorage();
  const out = await importBackup(backup, target);
  assert.equal(out.ok, true);
  assert.equal((await target.get('theme')).theme, 'nord');
  assert.equal((await target.get('myCourses')).myCourses.length, 1);
});

test('replace mode overwrites', async () => {
  const backup = await exportBackup(seeded());
  const target = fakeStorage({ automationRules: [{ id: 'old' }] });
  await importBackup(backup, target, { mode: 'replace' });
  const rules = (await target.get('automationRules')).automationRules;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 'r1');
});

test('merge mode unions arrays by id, incoming winning', async () => {
  const backup = await exportBackup(seeded());
  const target = fakeStorage({ automationRules: [{ id: 'old' }, { id: 'r1', query: 'stale' }] });
  await importBackup(backup, target, { mode: 'merge' });
  const rules = (await target.get('automationRules')).automationRules;
  assert.equal(rules.length, 2, 'old survived, r1 was not duplicated');
  assert.equal(rules.find((r) => r.id === 'r1').query, 'from:x', 'incoming won');
});

test('A FAILING KEY DOES NOT ABORT THE WHOLE IMPORT', async () => {
  /*
   * Chrome's storage gives no transaction, so an all-or-nothing write that
   * fails halfway is the worst of both. Per-key writes plus an honest report
   * is the achievable behaviour.
   */
  const backup = await exportBackup(seeded());
  const target = fakeStorage();
  const realSet = target.set.bind(target);
  target.set = async (obj) => {
    if ('automationRules' in obj) throw new Error('quota');
    return realSet(obj);
  };
  const out = await importBackup(backup, target);
  assert.equal(out.ok, false);
  assert.deepEqual(out.failed, ['automationRules']);
  assert.ok(out.applied.includes('theme'), 'the others still landed');
});

test('importing junk changes nothing', async () => {
  const target = fakeStorage();
  const out = await importBackup('not a backup', target);
  assert.equal(out.ok, false);
  assert.equal(target.writes, 0);
});


/* ==========================================================================
 * THE BUG THIS FILE EXISTED TO PREVENT AND DID NOT
 * ========================================================================== */

test('EVERY SETTING IN THE SCHEMA IS EXPORTED (or deliberately withheld)', async () => {
  /*
   * The allow-list originally held one entry, `'settings'` -- a storage key
   * that has never existed, because settings are stored flat. The backup
   * therefore captured ZERO preferences and said nothing, because a missing
   * key is skipped by design.
   *
   * This walks the real schema so the list cannot silently fall behind when a
   * preference is added.
   */
  const { SCHEMA } = await import('../src/app/settings.js');

  // Withheld on purpose, with the reason, so this is a decision and not a gap.
  const WITHHELD = { clientId: 'per-installation OAuth client id' };

  const missing = Object.keys(SCHEMA).filter(
    (k) => !EXPORTED_KEYS.includes(k) && !(k in WITHHELD)
  );
  assert.deepEqual(missing, [], 'settings absent from the backup allow-list');
});

test('a real settings profile round-trips end to end', async () => {
  // Built from settings.js's ACTUAL storage contract, not from a shape the
  // exporter was hoping for.
  const { SCHEMA } = await import('../src/app/settings.js');
  const source = fakeStorage({ theme: 'nord', density: 'compact', threaded: false, signature: 'Aviral' });

  const backup = await exportBackup(source);
  assert.ok(Object.keys(backup.data).length > 0, 'the export captured something at all');

  const target = fakeStorage();
  await importBackup(backup, target);

  for (const key of ['theme', 'density', 'threaded', 'signature']) {
    assert.equal((await target.get(key))[key], (await source.get(key))[key], `${key} survived`);
  }
  assert.ok('theme' in SCHEMA, 'sanity: the probe used real schema keys');
});

test('the OAuth client id is never written to a backup file', async () => {
  const s = fakeStorage({ clientId: '123-abc.apps.googleusercontent.com', theme: 'nord' });
  const json = toJson(await exportBackup(s));
  assert.doesNotMatch(json, /googleusercontent/, 'client id must not travel');
  assert.match(json, /nord/, 'but real preferences still do');
});
