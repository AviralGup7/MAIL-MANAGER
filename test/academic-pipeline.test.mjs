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

const ui = readFileSync(new URL('../src/app/academic/timetable-ui.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app/main.js', import.meta.url), 'utf8');


/**
 * The source of one function, from its declaration to its matching brace.
 *
 * Written because two gates in this file sliced a FIXED number of characters
 * and so silently changed meaning whenever a comment grew. Strings, comments
 * and regex literals are skipped so a brace inside them cannot end the slice
 * early.
 */
function sliceFunction(src, at) {
  /*
   * The body brace is the one after the PARAMETER LIST closes. Taking
   * `indexOf('{')` naively finds the brace of a destructured parameter —
   * `deepScanMessages(messages, fetchBody, { limit = 3 })` — and the slice
   * then ends at that parameter's closing brace, yielding the signature and
   * nothing else. (My first version of this helper did exactly that.)
   */
  const lp = src.indexOf('(', at);
  let depth = 0;
  let rp = -1;
  for (let i = lp; i < src.length && lp !== -1; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) { rp = i; break; }
  }
  const open = src.indexOf('{', rp === -1 ? at : rp);
  if (open === -1) return src.slice(at);
  depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i === -1) break; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      const q = c;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === q) break;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  return src.slice(at);
}

test('the scanner imports every gate it evaluates (no silent references)', () => {
  assert.match(ui, /import \{[^}]*scanMessages[^}]*\} from '\.\/timetable-mail\.js'/s);
  assert.match(ui, /import \{[^}]*isAcademicSender[^}]*\} from '\.\/timetable-mail\.js'/s);
  assert.match(ui, /import \{[^}]*courseNumbersIn[^}]*\} from '\.\/timetable-mail\.js'/s);
});

test('ingest scans academic mail BEFORE auto-archive can hide it (bug-hunt 44 #47)', () => {
  /*
   * THE WINDOW IS THE FUNCTION, NOT 2000 CHARACTERS (round 12).
   *
   * This used to slice a fixed 2000-char window after `function ingest(`.
   * Round 5's R5-5 added a docblock inside that window, pushing the
   * `autoArchive(` call to offset 2206 — `indexOf` returned -1, and the test
   * failed reporting that the arrival pipeline no longer auto-archives at
   * all. The ordering it exists to protect was never broken; a COMMENT broke
   * it, and the failure message pointed at the wrong thing entirely.
   *
   * A brace-matched slice cannot be fooled by the length of an explanation,
   * which is the whole point of a gate on ORDER.
   */
  const at = app.indexOf('function ingest(');
  assert.notEqual(at, -1);
  const fn = sliceFunction(app, at);
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
  const fn = sliceFunction(ui, at); // not a fixed window; see sliceFunction
  assert.match(fn, /slice\(0, limit\)/, 'candidates are capped before any fetch');
  assert.match(fn, /catch \{ body = ''/, 'a failed body fetch degrades, it never throws');
  assert.match(fn, /mergeFindings\(\[\.\.\.kept, \.\.\.deep\]\)/,
    'cheap findings stand, and a deep value supersedes its valueless twin');
  assert.match(fn, /f\.actionable/, 'only an actionable cheap finding settles a message');
});

test('passive-voice room changes stay extracted (bug-hunt 44 #12 regression)', async () => {
  const { scanMessage } = await import('../src/app/academic/timetable-mail.js');
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

  const uiMod = await import(`../src/app/academic/timetable-ui.js?fresh=${Date.now()}`);
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
