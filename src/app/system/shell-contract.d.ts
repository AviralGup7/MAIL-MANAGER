/**
 * The `ctx` contract, as a type (architectural audit ARCH-R2-2).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `ctx` is the only sanctioned path from a feature to the shell, and it is the
 * widest coupling surface in the app: roughly twelve modules read it, one of
 * them 32 times. It had **29 members, 12 of them documented, none of them
 * typed, and no test pinning its shape**. `main.js` is outside the checkJs
 * scope, so the compiler could not see it either.
 *
 * That is the exact shape that produced the palette defect the linter caught:
 * a member used but never provided fails at CALL TIME, in a branch nobody
 * exercises, and nothing in the build can say otherwise.
 *
 * A `.d.ts` rather than JSDoc in `main.js`: the consumers are what need
 * checking, and a declaration file lets each of them reference the contract
 * (`@param {ShellCtx} ctx`) without importing anything at runtime. The shell
 * asserts it satisfies this shape in main.js.
 *
 * HOW TO CHANGE IT. Adding a member here and to `main.js` is one commit;
 * adding it to `main.js` alone is a type error, which is the entire point.
 * Removing one tells you, at build time, every feature that still wants it.
 */

/** A normalised mail record as the store holds it. */
type Msg = Record<string, any>;

/** The shell's live view state. Mutated in place; never replaced. */
type ShellState = Record<string, any>;

export interface ShellCtx {
  /* ---- state ------------------------------------------------------- */
  /** The ACTIVE mailbox store. A getter, never a captured value: the
   *  identity changes when the user switches mailbox. */
  readonly store: any;
  /** The shell's state object, mutated in place. */
  state: ShellState;

  /* ---- the platform boundary --------------------------------------- */
  /** The only way to reach the worker (or its in-page fallback). */
  send: (verb: string, extra?: Record<string, any>) => Promise<any>;

  /* ---- user-visible feedback --------------------------------------- */
  toast: (text: string, opts?: Record<string, any>) => void;

  /* ---- mail verbs --------------------------------------------------- */
  act: (kind: string, id?: string) => any;
  openMessage: (id: string) => any;
  /** The id the reader is showing, accounting for an open thread part. */
  openMessageId: () => string | null | undefined;
  refresh: (opts?: { silent?: boolean }) => any;
  release: () => any;
  /** Ingest normalised records into the active store. */
  ingest: (msgs: Msg[]) => void;
  /** Canonical record shaping, so a feature never invents its own. */
  shape: (msgs: any[]) => Msg[];

  /* ---- rendering ---------------------------------------------------- */
  renderList: () => void;
  /** The ids the list is currently showing — the single choke point. */
  visibleIds: () => string[];

  /* ---- navigation and query ----------------------------------------- */
  selectCategory: (key: string) => any;
  runQuery: (q: string) => any;
  categoryList: () => Array<[string, string]>;

  /* ---- overlays ------------------------------------------------------ */
  toggleHelp: () => any;
  openSettings: () => any;
  openActivityLog: () => any;
  /** The profile page: identity, measured mailbox figures, account actions. */
  openProfile: () => any;
  viewsList: () => any;

  /* ---- appearance ---------------------------------------------------- */
  setTheme: (id: string) => any;
  themes: () => any;

  /* ---- compose and contacts ------------------------------------------ */
  wireAutocomplete: (inputId: string, listId: string) => any;
  refreshContacts: (c?: any) => any;
  /** The signed-in account's display name, for template expansion. */
  profileName: () => string;
  /** The undo-send hold, in milliseconds, from settings. */
  undoSendMs: () => number;
  flushOutbox: () => any;

  /* ---- academic ------------------------------------------------------- */
  reloadAutomationRules: () => Promise<any>;
  /** Deadline for a message, honouring user overrides. */
  dueAtOf: (m: Msg) => number | undefined;
  dueFollowups: () => any[];
}
