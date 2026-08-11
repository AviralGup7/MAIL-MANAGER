/**
 * The reader frame contract (round 45, arch A2).
 *
 * The message body renders in a separate document, and its safety +
 * appearance rest on artefacts that used to live apart: the sandbox
 * attributes in app.html, the CSP meta generated into the srcdoc, the
 * theme's surface colours, and the reading typography. Four sources, one
 * contract — and the audits kept finding them disagreeing (hardcoded white
 * frame, density ignored, CSP drift).
 *
 * This module is the ONE place the contract is declared. renderBody and the
 * tests both read from here, so the next disagreement is a build failure,
 * not a user complaint.
 */

/**
 * Reading typography per density (round 45 H2). The list obeys the density
 * setting; the reader now does too — within reading bounds at every step,
 * because dense text that stops being readable defeats the user's own
 * request.
 */
export const READER_TYPOGRAPHY = {
  comfortable: { size: 15, line: 1.65, pad: '26px 28px 44px' },
  cosy:        { size: 14, line: 1.6,  pad: '22px 24px 38px' },
  compact:     { size: 13, line: 1.55, pad: '18px 20px 32px' },
};

/** The measure long-form text is constrained to, in ch. */
export const READER_MEASURE_CH = 68;

/**
 * The srcdoc Content-Security-Policy.
 *
 * Derived from the SAME decision the sanitiser made: `https:` appears in
 * img-src only when remote images were actually emitted. img-src only — no
 * script, no frame, no connect; an image request leaks the read to the
 * sender (why it is opt-in) but cannot execute anything.
 */
export function readerCsp(allowRemote) {
  const imgSrc = allowRemote ? 'data: https:' : 'data:';
  return `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data:;`;
}

/**
 * The sandbox flags the body iframe must keep, documented as data so a test
 * can assert them. No allow-scripts, no allow-same-origin: those two lines
 * are the reader's primary defence; everything else is depth.
 */
export const READER_SANDBOX = ['allow-popups', 'allow-popups-to-escape-sandbox'];
export const READER_SANDBOX_FORBIDDEN = ['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-modals'];
