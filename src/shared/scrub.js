/**
 * ONE DEFINITION OF EVERY CHARACTER WE REFUSE TO DISPLAY.
 *
 * WHY THIS MODULE EXISTS (round 10, I-6 / L-20).
 *
 * The same security-relevant regexes had grown three copies — `sanitize.js`,
 * `snippet.js` and `notify.js` — and they had already started to drift: the
 * two bidi copies were byte-identical but carried different `eslint-disable`
 * comments, and notify's control-character class covers C1 while snippet's
 * covers only C0. A rule about what an attacker may put on screen must have
 * ONE statement, or a fix lands in two places out of three and nobody
 * notices until the third is the one in the screenshot.
 *
 * These live in `src/shared/` rather than `src/app/core/` because the
 * background worker needs them too, and `shared/` is the layer below both.
 *
 * WHAT IS *NOT* STRIPPED, AND WHY
 *
 * `U+200E LRM` and `U+200F RLM` are MARKS, not overrides. Legitimate Arabic,
 * Hebrew and Urdu mail uses them for correct rendering and they cannot
 * re-order neighbouring text. Stripping them would corrupt honest mail to
 * defend against a trick they cannot perform.
 */

/**
 * SHARED /g REGEXES ARE SAFE WITH `.replace`, NOT WITH `.test`. A global
 * regex carries `lastIndex`, so a shared instance used with `.test()` would
 * give a different answer on every other call. `String.prototype.replace`
 * resets it (verified: four consecutive scrubs of the same string agree), and
 * every consumer here uses replace. A caller that wants a predicate must
 * build its own non-global copy.
 */

/**
 * Bidi embedding, override and isolate controls.
 *
 * `U+202A-U+202E` is the embedding/override family and `U+2066-U+2069` the
 * isolate family (LRI/RLI/FSI/PDI). Both exist to re-order the text AROUND
 * them, which is how `report.txt` is made to read `report.exe` — or how a
 * subject line reverses the rest of a list row it does not own.
 */
export const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/**
 * C0 controls except TAB, LF and CR, plus DEL.
 *
 * The three survivors are real whitespace; a caller that wants them gone
 * collapses whitespace afterwards, which is a formatting decision rather than
 * a safety one. Everything else here is invisible and can only mislead.
 */
export const C0_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Every C0 and C1 control, including TAB/LF/CR.
 *
 * For surfaces where a line break is itself the attack — an OS notification
 * card, where a fake second line impersonates trusted chrome.
 */
export const ALL_CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;

/** Strip bidi overrides and isolates; keep LRM/RLM. */
export function stripBidi(value) {
  return String(value ?? '').replace(BIDI_CONTROLS, '');
}

/** Strip invisible C0 controls and DEL; keep TAB, LF, CR. */
export function stripControl(value) {
  return String(value ?? '').replace(C0_CONTROLS, '');
}

/**
 * The full scrub for text that will be shown to a person: no invisible
 * controls, no bidi re-ordering. TAB/LF/CR survive for the caller to fold.
 */
export function scrubDisplay(value) {
  return stripBidi(stripControl(value));
}

/** As `scrubDisplay`, but line breaks go too. For single-line surfaces. */
export function scrubOneLine(value) {
  return String(value ?? '').replace(ALL_CONTROLS, '').replace(BIDI_CONTROLS, '');
}

/**
 * Everything that must not survive inside a URL before it is compared to a
 * scheme allow-list.
 *
 * A DIFFERENT RULE FROM THE DISPLAY SCRUBS, deliberately kept separate
 * (round 10, I-6). It also removes whitespace, because `java\nscript:` and
 * `java script:` both reach the parser as `javascript:` — whitespace is part
 * of the attack here, whereas on a display surface it is honest text.
 */
export const URL_UNSAFE = /[\u0000-\u001F\u007F\s]/g;

/** Strip control characters and whitespace from a URL before matching it. */
export function scrubUrl(value) {
  return String(value ?? '').trim().replace(URL_UNSAFE, '');
}
