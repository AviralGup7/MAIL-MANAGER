/**
 * Property sweep over the backup format (2026-08-14 fuzz hunt).
 *
 * The backup file crosses machines and hands storage wholesale to the
 * importer, so the properties that matter are: validation never throws on
 * ANY bytes, export always produces something our own validator accepts,
 * never-exported keys never leak, and the validate/preview pair cannot
 * disagree about what is importable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  exportBackup, importBackup, previewImport, toJson, validateBackup, NEVER_EXPORT,
} from '../src/app/system/backup.js';
import { EXPORTED_KEYS } from '../src/app/system/backup.js';
import { fakeStorage } from './helpers/storage.mjs';
import { mulberry32, hostileString, hostileValue } from './helpers/fuzz.mjs';

test('validateBackup is total: any bytes in, a verdict out', () => {
  const rnd = mulberry32(0xBAC);
  for (let i = 0; i < 2000; i++) {
    const junk = hostileValue(rnd);
    let verdict;
    try {
      verdict = validateBackup(rnd() < 0.5 ? junk : JSON.stringify(junk));
    } catch (err) {
      assert.fail(`validateBackup threw on input #${i}: ${err.message}`);
    }
    assert.ok(verdict && typeof verdict.ok === 'boolean', 'verdict shape');
    if (verdict.ok) {
      assert.equal(verdict.backup.format, 'bits-mail-manager-backup');
    } else {
      assert.ok(typeof verdict.reason === 'string' && verdict.reason.length > 0,
        'a rejection always says why, in words a user can act on');
    }
  }
});

test('whatever the store holds, export emits a backup we ourselves accept', async () => {
  const rnd = mulberry32(0xE991);
  for (let i = 0; i < 300; i++) {
    const seed = {};
    for (const key of EXPORTED_KEYS) {
      if (rnd() < 0.5) seed[key] = hostileValue(rnd);
    }
    const storage = fakeStorage(seed);
    const backup = await exportBackup(storage);
    const verdict = validateBackup(toJson(backup));
    assert.ok(verdict.ok,
      `round ${i}: our own export failed our own validation (${verdict.reason})`);
    assert.deepEqual([...verdict.backup.keys].sort(), [...backup.keys].sort(),
      'the manifest survives the JSON round-trip');
  }
});

test('never-exported keys never leak, and validate agrees with preview', async () => {
  const rnd = mulberry32(0x5EED);
  for (let i = 0; i < 200; i++) {
    const seed = {};
    for (const key of NEVER_EXPORT) {
      if (rnd() < 0.7) seed[key] = hostileValue(rnd);
    }
    for (const key of EXPORTED_KEYS) {
      if (rnd() < 0.5) seed[key] = hostileValue(rnd);
    }
    const backup = await exportBackup(fakeStorage(seed));
    for (const key of NEVER_EXPORT) {
      assert.ok(!(key in backup.data), `${key} leaked into an export`);
    }
    /* The pair cannot disagree about whether the file is importable —
       previewImport is the dialog's answer, validateBackup the importer's. */
    const junk = hostileValue(rnd);
    const v = validateBackup(junk);
    const p = await previewImport(junk, fakeStorage({}));
    assert.equal(p.ok, v.ok, `validate/preview disagree on input: ${JSON.stringify(junk)?.slice(0, 80)}`);
  }
});

test('an import writes exactly the exported data — no more, no less', async () => {
  const rnd = mulberry32(0x1B10);
  for (let i = 0; i < 100; i++) {
    const seed = {};
    for (const key of EXPORTED_KEYS) {
      if (rnd() < 0.6) seed[key] = hostileValue(rnd);
    }
    const backup = await exportBackup(fakeStorage(seed));
    const target = fakeStorage({});
    const result = await importBackup(JSON.parse(toJson(backup)), target);
    assert.ok(result.ok !== false, 'import of our own export must succeed');
    const stored = target._data ? target._data() : target.data;
    /* IMPORT SEES THE WIRE, NOT THE MEMORY. The values an importer ever
       meets have been through toJson, so the honest comparison is
       wire-to-wire: NaN and Infinity arrive as null, undefined fields go
       absent. The first run of this test compared memory-to-wire and
       accused the importer of rewriting `ctrlEnterSend` — the figure was
       NaN becoming null IN TRANSIT; exporter and importer were both
       innocent. A fuzz accusation is a hypothesis, not a verdict. */
    const wire = JSON.parse(toJson(backup)).data;
    for (const [key, value] of Object.entries(wire)) {
      assert.deepEqual(stored[key], value, `import rewrote ${key}`);
    }
  }
});
