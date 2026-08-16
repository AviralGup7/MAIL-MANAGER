/**
 * Bug hunt, round 4 of 10 (2026-08-16) — the shell and timetable-ui.
 *
 * These two were found by DRIVING THE APP, not by reading it: a jsdom boot,
 * real clicks, real keystrokes. Neither is visible in the source, because
 * both are about what the code does NOT do — one path that forgot to record
 * an undo, one guard that handled a null but not a throw.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* ========================================================================
 * B16 · the accept path users actually reach recorded no undo
 * ==================================================================== */

test('B16: both timetable accept paths record an undo', async () => {
  /*
   * timetable-ui has TWO accept buttons and only one was reversible.
   *
   * `acceptFinding` — reached when the proposal OUTRANKS what is already
   * there — snapshots the entry and calls recordUndo. The other button,
   * rendered when the dry run refuses, did neither. That is the one the user
   * actually reaches: a room change arrives by MAIL (precedence 2) against a
   * room set by the official DOCUMENT (3), so the common case for a room
   * change is the refusing branch.
   *
   * MEASURED THROUGH THE UI before the fix: click "Set room to 9999", press
   * Ctrl+Z — the room stayed 9999 and the proposal was gone.
   *
   * It is the worse of the two to leave unreversible: a manual edit writes
   * precedence `manual` (5), which outranks the official document FOREVER,
   * so an accidental click does not merely set a wrong room — it permanently
   * stops the real timetable from correcting it. Undo is the only way back.
   *
   * Asserted on the SOURCE because the behaviour needs a full jsdom boot the
   * integration suites own; what must not regress is that neither branch can
   * mutate without registering a reversal.
   */
  const ui = readFileSync(new URL('../src/app/academic/timetable-ui.js', import.meta.url), 'utf8');

  /* Every call that commits a change from a proposal. */
  const accept = ui.slice(ui.indexOf('export async function acceptFinding'));
  assert.match(accept.slice(0, 2000), /recordUndo\(/,
    'acceptFinding must stay reversible');

  /* The manual-edit branch: find the click handler that calls manualEdit and
     require a recordUndo in the same handler. */
  const at = ui.indexOf('const r = manualEdit(');
  assert.notEqual(at, -1, 'the manual-accept branch still exists');
  const handler = ui.slice(at, at + 2200);
  assert.match(handler, /recordUndo\(/,
    'the "Set room to X" branch mutates the timetable and must record an undo');
  /* And the undo must restore the ENTRY, not merely re-open the proposal. */
  assert.match(handler, /prevEntry/,
    'the undo restores a snapshot taken before the edit');
  assert.match(handler, /pending = dedupePending/,
    'and returns the proposal to the Changes room, so the user can re-apply');
});

/* ========================================================================
 * B17 · a decoration could abort the send
 * ==================================================================== */

test('B17: a throwing getContext cannot escape the particle layer', async () => {
  /*
   * `ensureCanvas` guarded the documented null return of getContext (context
   * refused) but not a THROW — and the throw escapes into the SEND path.
   * compose.js's doSend calls fxBurst BETWEEN closeCompose() and the
   * "Sending to …" toast, with no try/catch anywhere above it. An exception
   * there aborts doSend after the panel has closed and before the toast, so
   * the user watches their compose window vanish with no confirmation and no
   * undo affordance for a message that is already queued.
   *
   * Reachable for real: a blocked or exhausted GPU context, a canvas the
   * compositor refuses, or a privacy extension that stubs getContext to
   * throw. Observed live under jsdom.
   *
   * `themeInk`, twenty lines up in the same file, already wraps its DOM read
   * for exactly this reason — decoration must never break a verb.
   */
  const { JSDOM } = await import('jsdom').catch(() => ({ JSDOM: null }));
  if (!JSDOM) return; // jsdom is an optional devDependency

  const dom = new JSDOM('<!doctype html><body>', { pretendToBeVisual: true });
  const prev = { window: globalThis.window, document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.matchMedia = dom.window.matchMedia;
  /* The hostile environment: getContext throws rather than returning null. */
  dom.window.HTMLCanvasElement.prototype.getContext = () => { throw new Error('canvas blocked'); };

  try {
    const { burst } = await import(`../src/app/motion/particles.js?b17=${Date.now()}`);
    let spawned;
    assert.doesNotThrow(() => { spawned = burst(10, 10, { count: 5 }); },
      'a refused canvas must decline, not throw into the caller');
    assert.equal(spawned, 0, 'and it declines honestly rather than claiming particles');
  } finally {
    globalThis.window = prev.window;
    globalThis.document = prev.document;
    globalThis.requestAnimationFrame = prev.requestAnimationFrame;
    dom.window.close();
  }
});

test('B17: the send path still has no try/catch of its own', async () => {
  /*
   * WHY THE FIX BELONGS IN particles.js AND NOT IN doSend.
   *
   * Wrapping the fxBurst call site would fix this one caller and leave every
   * other one exposed — burst() is called from row dismissal, the undo flash
   * and the theme arrival too. The guarantee is "a decoration cannot throw",
   * and it is owned by the decoration.
   *
   * This pin exists so that if someone later "simplifies" particles.js by
   * removing the try, the missing net is visible here rather than only in a
   * user's lost compose window.
   */
  const compose = readFileSync(new URL('../src/app/compose/compose.js', import.meta.url), 'utf8');
  const at = compose.indexOf('async function doSend');
  const body = compose.slice(at, compose.indexOf('\n}', at));
  assert.match(body, /fxBurst\(/, 'doSend still bursts');
  const burstAt = body.indexOf('fxBurst(');
  const between = body.slice(0, burstAt);
  assert.match(between, /closeCompose\(\)/,
    'and still does it after the panel closes — which is why a throw there is invisible');

  const particles = readFileSync(new URL('../src/app/motion/particles.js', import.meta.url), 'utf8');
  const ensure = particles.slice(particles.indexOf('function ensureCanvas'));
  const upToNullGuard = ensure.slice(0, ensure.indexOf('if (!ctx)'));
  assert.match(upToNullGuard, /try \{[\s\S]*getContext[\s\S]*?\} catch/,
    'ensureCanvas owns the guarantee');
});
