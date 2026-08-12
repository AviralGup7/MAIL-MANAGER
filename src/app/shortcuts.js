/**
 * Keyboard shortcut registry and help overlay.
 *
 * WHY A REGISTRY RATHER THAN A HARD-CODED PANEL
 * ---------------------------------------------
 * The obvious way to build a `?` overlay is to write the list out in HTML.
 * That list is then a SECOND source of truth, and it starts lying the first
 * time someone adds a binding without updating it. Help that is subtly wrong
 * is worse than no help, because the user stops trusting all of it.
 *
 * So the bindings live here as data, the overlay renders from that data, and
 * a test asserts every documented key is actually handled in `app.js`. Adding
 * a shortcut without documenting it fails the build.
 *
 * DISCOVERABILITY WAS THE ACTUAL PROBLEM. Thirteen shortcuts existed and
 * nothing in the UI mentioned most of them, so the work was already paid for
 * and simply not collected.
 */

/**
 * @typedef {{keys:string[], label:string, when?:string}} Shortcut
 * @typedef {{title:string, items:Shortcut[]}} ShortcutGroup
 */

/** @type {ShortcutGroup[]} */
export const SHORTCUTS = [
  {
    title: 'Navigation',
    items: [
      { keys: ['j'], label: 'Next message' },
      { keys: ['k'], label: 'Previous message' },
      { keys: ['Enter'], label: 'Open the selected message' },
      { keys: ['Esc'], label: 'Close, then step back out to Gmail' },
      { keys: ['/'], label: 'Search' },
      { keys: ['Ctrl', 'K'], label: 'Command palette' },
      { keys: ['?'], label: 'This help' },
    ],
  },
  {
    title: 'Triage',
    items: [
      { keys: ['e'], label: 'Archive', when: 'reader' },
      { keys: ['s'], label: 'Star / unstar', when: 'reader' },
      { keys: ['u'], label: 'Mark unread', when: 'reader' },
      { keys: ['#'], label: 'Delete', when: 'reader' },
      { keys: ['!'], label: 'Report spam (rescues, inside Spam)', when: 'reader' },
      { keys: ['x'], label: 'Tick this row (multi-select)' },
      { keys: ['Ctrl', 'A'], label: 'Select every visible message' },
      { keys: ['Ctrl', 'Z'], label: 'Undo the last action' },
      { keys: ['z'], label: 'Snooze', when: 'reader' },
    ],
  },
  {
    title: 'Writing',
    items: [
      { keys: ['c'], label: 'Compose' },
      { keys: ['Shift', 'R'], label: 'Reply', when: 'reader' },
      { keys: ['Shift', 'A'], label: 'Reply all', when: 'reader' },
      { keys: ['Shift', 'F'], label: 'Forward', when: 'reader' },
      { keys: ['Ctrl', 'Enter'], label: 'Send', when: 'compose' },
    ],
  },
  {
    title: 'Elsewhere',
    items: [
      { keys: ['r'], label: 'Refresh' },
      { keys: ['g'], label: 'Then 0–9: jump to a category (0 = all mail)' },
      { keys: ['Alt', 'Shift', 'M'], label: 'Toggle the takeover from Gmail' },
    ],
  },
  {
    /*
     * The pointer half of the product. It predates this panel and works
     * exactly like a file manager, but nothing SAID so -- and capabilities
     * that are never announced do not exist for most people (round 65/c).
     * These are gestures, not key chords, so the "every documented key is
     * handled" test deliberately cannot see them.
     */
    title: 'Pointer',
    items: [
      { keys: ['Hover'], label: 'Archive / read / snooze / delete, right on the row' },
      { keys: ['Right-click'], label: 'Every verb, from the row you aimed at' },
      { keys: ['Ctrl', 'Click'], label: 'Add one row to the selection' },
      { keys: ['Shift', 'Click'], label: 'Select the range from the last pick' },
      { keys: ['Double-click'], label: 'Open the conversation in Gmail' },
    ],
  },
];

/** Flat list of every documented key combination. Used by the tests. */
export function allShortcuts() {
  return SHORTCUTS.flatMap((g) => g.items);
}

/**
 * Render the overlay content into a container.
 *
 * Built with DOM calls rather than an HTML string: the labels are ours, but
 * building this with innerHTML establishes a pattern that someone later
 * follows with a value that is not.
 */
export function renderShortcuts(container, doc = globalThis.document) {
  const frag = doc.createDocumentFragment();

  for (const group of SHORTCUTS) {
    const section = doc.createElement('section');
    section.className = 'sc-group';

    const h = doc.createElement('h3');
    h.textContent = group.title;
    section.appendChild(h);

    const dl = doc.createElement('dl');
    for (const item of group.items) {
      const dt = doc.createElement('dt');
      for (const key of item.keys) {
        const kbd = doc.createElement('kbd');
        kbd.textContent = key;
        dt.appendChild(kbd);
      }
      const dd = doc.createElement('dd');
      dd.textContent = item.label;
      if (item.when) {
        const note = doc.createElement('span');
        note.className = 'sc-when';
        note.textContent =
          item.when === 'reader' ? 'with a message open'
            : item.when === 'compose' ? 'while composing'
              : item.when;
        dd.appendChild(note);
      }
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    section.appendChild(dl);
    frag.appendChild(section);
  }

  container.replaceChildren(frag);
  return container;
}
