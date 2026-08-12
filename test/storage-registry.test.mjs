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
const { STORAGE_REGISTRY, BACKUP_KEYS, keyEntry } = await import('../src/app/storage-registry.js');
const { SCHEMA } = await import('../src/app/settings.js');
const backup = await import('../src/app/backup.js');

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
  }
});

test('every settings preference is registered, straight from the schema', () => {
  for (const key of Object.keys(SCHEMA)) {
    const e = keyEntry(key);
    assert.ok(e, `schema key ${key} is registered`);
    assert.equal(e.owner, 'src/app/settings.js');
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
  for (const extra of ['imageAllow', 'accessToken', 'expiresAt']) {
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
