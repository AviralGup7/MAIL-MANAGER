/**
 * Ambient platform globals for the M5 contract check (tsc -p tsconfig.json).
 *
 * The app runs in three host shapes — extension page, content-scripted
 * takeover, and jsdom — and each provides a different slice of `chrome`.
 * The real types live behind the platform seam (src/platform/storage.js);
 * these declarations exist so the CHECKED surface can reference the hosts
 * without dragging the extension-types package into a repo that ships none.
 */
/* `var`, not `const`: only `var` globals attach to globalThis, and the
   platform seam reads the host exactly there (globalThis.chrome?.storage). */
declare var chrome: any;
