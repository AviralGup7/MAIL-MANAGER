/**
 * Storage registry contract (roadmap Phase 3, M-1).
 *
 * The registry exists because two silent defects shipped through hand-kept
 * key lists: a fictional 'settings' key exported nothing, and a fictional
 * 'imageAllowList' key meant the allow-list never backed up. These tests
 * make the registry the ONLY way to be right: well-formed entries, settings
 * coverage straight from the schema, a source sweep that catches any KEY a
 * module declares but the registry does not list, and backup consistency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { STORAGE_REGISTRY, BACKUP_KEYS, ACCOUNT_SCOPED_KEYS, keyEntry } = await import('../src/app/system/storage-registry.js');
const { SCHEMA } = await import('../src/app/system/settings.js');
const backup = await import('../src/app/system/backup.js');

test('every entry is well-formed and keys are unique', () => {
  const seen = new Set();
  for (const e of STORAGE_REGISTRY) {
    assert.match(e.key, /^[a-zA-Z][a-zA-Z0-9]*$/, `sane key name: ${e.key}`);
    assert.ok(!seen.has(e.key), `duplicate key: ${e.key}`);
    seen.add(e.key);
    assert.ok(e.owner, `${e.key} has an owner`);
    assert.ok(e.purpose, `${e.key} has a purpose`);
    assert.equal(typeof e.backup, 'boolean', `${e.key} backup is a decision`);
    if (!e.backup) assert.ok(e.reason, `${e.key} explains why it does not travel`);
    /* Audit R3-04: account scope is a DECISION, never an omission. The
       teardown iterates ACCOUNT_SCOPED_KEYS, so a key that declares nothing
       would silently survive an account change -- which is exactly how
       followups, imageAllow, queryHistory, activityLog, categoryRules and
       deadlineOverrides leaked account A's data into account B's session. */
    assert.equal(typeof e.accountScoped, 'boolean',
      `${e.key} must declare accountScoped (audit R3-04)`);
    assert.ok(e.scopeReason, `${e.key} explains its account-scope decision`);
  }
});

test('every settings preference is registered, straight from the schema', () => {
  for (const key of Object.keys(SCHEMA)) {
    const e = keyEntry(key);
    assert.ok(e, `schema key ${key} is registered`);
    assert.equal(e.owner, 'src/app/system/settings.js');
  }
  assert.equal(keyEntry('clientId').backup, false,
    'clientId stays out of backups by declaration, not omission');
});

test('source sweep: every KEY a module declares is registered', () => {
  /*
   * Walk src/ for key-shaped declarations. This is the completeness catch:
   * a new module that persists under a KEY the registry does not list fails
   * here before it can ship the next silent-backup class of bug.
   */
  const files = [];
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js')) files.push(p);
    }
  })(join(ROOT, 'src'));

  const declared = new Map(); // literal -> file
  const patterns = [
    /\bKEY\s*=\s*'([a-zA-Z][a-zA-Z0-9]*)'/g,
    /\bCLAIM_KEY\s*=\s*'([a-zA-Z][a-zA-Z0-9]*)'/g,
    /\bHISTORY_KEY\s*=\s*'([a-zA-Z][a-zA-Z0-9]*)'/g,
    /\bPUMP_LOCK_KEY\s*=\s*'([a-zA-Z][a-zA-Z0-9]*)'/g,
  ];
  for (const f of files) {
    if (f.endsWith('storage-registry.js')) continue;
    const src = readFileSync(f, 'utf8');
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        // Skip unrelated constants that happen to match (e.g. CSS-key names).
        if (/\.css|\.json/.test(src.slice(Math.max(0, m.index - 60), m.index))) continue;
        declared.set(m[1], f);
      }
    }
  }
  // Keys used without a KEY constant — listed so a removal is noticed.
  // 2026-08-15: diagCounters and activeAuthUser joined the audit's registry
  // rows; both are written inline (persistDiag takes any storage, the
  // authuser report is a one-line set) rather than through a KEY constant.
  for (const extra of ['imageAllow', 'accessToken', 'expiresAt', 'diagCounters', 'activeAuthUser']) {
    declared.set(extra, '(direct use)');
  }

  for (const [key, file] of declared) {
    assert.ok(keyEntry(key),
      `${key} (declared in ${file}) is missing from the storage registry`);
  }
});

test('backup consumes the registry and never touches the forbidden', () => {
  assert.deepEqual(
    backup.EXPORTED_KEYS, BACKUP_KEYS,
    'the backup allow-list IS the registry backup decision'
  );
  const overlap = backup.EXPORTED_KEYS.filter((k) => backup.NEVER_EXPORT.includes(k));
  assert.deepEqual(overlap, [], 'allow-list and never-list are disjoint');
  for (const k of BACKUP_KEYS) {
    assert.ok(!backup.NEVER_EXPORT.includes(k), `${k} cannot be both exported and forbidden`);
  }
});

test('account teardown clears every account-scoped key (audit R3-04)', () => {
  /*
   * The tripwire (AUD-C1) was built correctly and still leaked, because the
   * LIST of what to clear lived in the teardown and was kept by memory.
   * This pins the inverse: the teardown must consume the registry, and the
   * six keys the audit found must be in it.
   */
  const main = readFileSync(join(ROOT, 'src/app/main.js'), 'utf8');
  assert.match(main, /ACCOUNT_SCOPED_KEYS/,
    'endAccountSession must derive its sweep from the registry, not a hand list');

  for (const k of ['followups', 'imageAllow', 'queryHistory', 'activityLog',
                   'categoryRules', 'deadlineOverrides', 'msgCache', 'bodyCache',
                   'intents', 'historyId', 'accountEmail', 'activeAuthUser']) {
    assert.ok(ACCOUNT_SCOPED_KEYS.includes(k), `${k} must be account-scoped`);
  }

  // Deliberate exclusions: these belong to the PERSON, and wiping them on an
  // account change would be a hostile surprise rather than a privacy win.
  for (const k of ['theme', 'density', 'templates', 'savedViews', 'myCourses',
                   'timetable', 'automationRules', 'clientId']) {
    assert.ok(!ACCOUNT_SCOPED_KEYS.includes(k),
      `${k} belongs to the person, not the mailbox`);
  }

  // outboxPumpLock is a TTL-bounded cross-tab mutex: yanking it mid-window
  // would admit a second writer.
  assert.ok(!ACCOUNT_SCOPED_KEYS.includes('outboxPumpLock'),
    'the pump mutex must not be swept mid-window');
});

test('in-memory mirrors of swept keys are reset too (audit R3-04)', () => {
  /*
   * Clearing storage alone is not enough: `imageAllowList` and
   * `followupList` are the copies the app actually reads, and both are
   * written back wholesale on the next user action -- so account A's
   * trusted senders and thread notes would be resurrected under account B.
   */
  const main = readFileSync(join(ROOT, 'src/app/main.js'), 'utf8');
  assert.match(main, /resetImageAllowList\(\)/,
    'the reader image allow-list mirror must be reset on account end');
  assert.match(main, /followupList = \[\];/,
    'the follow-up mirror must be reset on account end');

  const reader = readFileSync(join(ROOT, 'src/app/mail/reader.js'), 'utf8');
  assert.match(reader, /export function resetImageAllowList/,
    'reader must expose the mirror reset it owns');
});
