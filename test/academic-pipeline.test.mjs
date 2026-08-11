/**
 * The academic intelligence input contract (bug-hunt 44 #46/#47).
 *
 * WHAT IS UNDER TEST
 *   1. Eligibility is "academic sender naming one of your courses", NOT
 *      inbox presence -- the scan consumes the ARRIVING records, so an
 *      auto-archive rule cannot blind the scanner.
 *   2. Bodies are consulted for the candidates the cheap scan cannot
 *      settle, bounded, with failures degrading to the cheap result.
 *   3. The passive-voice room phrasings stay extracted (regression pins on
 *      the two-pass extractor).
 *   4. None of it is a silent reference: the functions the contract names
 *      are really imported where they are called (the class of bug that
 *      once shipped a dead `auth.forceRenew`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ui = readFileSync(new URL('../src/app/timetable-ui.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app/app.js', import.meta.url), 'utf8');

test('the scanner imports every gate it evaluates (no silent references)', () => {
  assert.match(ui, /import \{[^}]*scanMessages[^}]*\} from '\.\/timetable-mail\.js'/s);
  assert.match(ui, /import \{[^}]*isAcademicSender[^}]*\} from '\.\/timetable-mail\.js'/s);
  assert.match(ui, /import \{[^}]*courseNumbersIn[^}]*\} from '\.\/timetable-mail\.js'/s);
});

test('ingest scans academic mail BEFORE auto-archive can hide it (bug-hunt 44 #47)', () => {
  const at = app.indexOf('function ingest(');
  assert.notEqual(at, -1);
  const fn = app.slice(at, at + 2000);
  const scanAt = fn.indexOf('deepScanMessages(');
  const archAt = fn.indexOf('autoArchive(');
  assert.ok(scanAt !== -1, 'the arrival pipeline runs the academic scan');
  assert.ok(archAt !== -1);
  assert.ok(scanAt < archAt,
    'the scan consumes the arriving records, not whatever archiving left behind');
});

test('the body pass is bounded and degrades on failure (bug-hunt 44 #46)', () => {
  const at = ui.indexOf('export async function deepScanMessages');
  assert.notEqual(at, -1);
  const fn = ui.slice(at, at + 2600);
  assert.match(fn, /slice\(0, limit\)/, 'candidates are capped before any fetch');
  assert.match(fn, /catch \{ body = ''/, 'a failed body fetch degrades, it never throws');
  assert.match(fn, /mergeFindings\(\[\.\.\.kept, \.\.\.deep\]\)/,
    'cheap findings stand, and a deep value supersedes its valueless twin');
  assert.match(fn, /f\.actionable/, 'only an actionable cheap finding settles a message');
});

test('passive-voice room changes stay extracted (bug-hunt 44 #12 regression)', async () => {
  const { scanMessage } = await import('../src/app/timetable-mail.js');
  const state = {
    entries: [{
      id: 'CS F111:L1', courseNo: 'CS F111', section: 'L1', kind: 'lecture',
      instructors: [], room: '5105', meetings: [], unresolved: [],
      provenance: {}, history: [],
    }],
    appliedMail: [],
  };
  const msg = (body) => ({ id: 'x', from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>', subject: 'CS F111', snippet: '', body });
  for (const [body, want] of [
    ['The CS F111 L1 class was rescheduled to 6101.', '6101'],
    ['CS F111 L1 has been changed to room 6101.', '6101'],
    ['CS F111 L1 moved from 5105 to 6101.', '6101'],
    ['CS F111 L1 is leaving room 5105 until further notice.', null],
  ]) {
    const room = scanMessage(msg(body), state).find((f) => f.kind === 'room');
    assert.equal(room?.value ?? null, want, body);
  }
});

test('deepScanMessages finds what only the BODY says (bug-hunt 44 #46)', async () => {
  // Stub the platform seam, then load a one-course timetable through the
  // REAL loader so the scan runs against genuine state.
  const blob = {
    schemaVersion: 1, semester: 'TEST', entries: [{
      id: 'CS F111:L1', comCode: 'CS F111', courseNo: 'CS F111', title: 'Programming',
      section: 'L1', kind: 'lecture', instructors: ['X'], room: '5105',
      meetings: [], history: [], unresolved: [], locked: false, linkedTo: '', provenance: {},
    }], conflicts: [], appliedMail: [],
  };
  const store = { timetable: blob };
  globalThis.chrome = {
    storage: { local: {
      get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : Object.fromEntries(k.map((x) => [x, store[x]]))),
      set: async (o) => Object.assign(store, o),
      remove: async () => {},
    } },
    runtime: { getURL: (p) => `chrome-extension://test/${p}` },
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, semester: 'TEST', courses: [], changes: [] }) });
  // The badge is UI; a bare document stub keeps mergeFindings DOM-safe in node.
  globalThis.document = globalThis.document || { getElementById: () => null };

  const uiMod = await import(`../src/app/timetable-ui.js?fresh=${Date.now()}`);
  await uiMod.initTimetable({});

  // Subject/snippet name the course but NOT the room; only the body states it.
  const records = [{
    id: 'm-body-only', from: 'AUGSD <augsd@pilani.bits-pilani.ac.in>',
    subject: 'CS F111 L1 venue update', snippet: 'Please note the change below.',
  }];
  let fetched = 0;
  const findings = await uiMod.deepScanMessages(records, async (id) => {
    fetched++;
    assert.equal(id, 'm-body-only');
    return 'Dear students, CS F111 L1 will be held in room 6101 from Monday.';
  });

  assert.equal(fetched, 1, 'exactly one bounded body fetch for the candidate');
  const room = findings.find((f) => f.kind === 'room');
  assert.ok(room, 'the body-only room change is found');
  assert.equal(room.value, '6101');

  // A NON-academic sender never earns a body fetch.
  const quiet = await uiMod.deepScanMessages(
    [{ id: 'm2', from: 'GitHub <noreply@github.com>', subject: 'CS F111 build', snippet: '' }],
    async () => { throw new Error('must not fetch'); }
  );
  assert.equal(quiet.length, 0);
});
