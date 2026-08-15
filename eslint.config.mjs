/**
 * ESLint — CORRECTNESS ONLY, NOT STYLE.
 *
 * WHY THIS EXISTS (2026-08-15 CI audit). 35,000 lines of JavaScript had no
 * linter. `checkJs` covers 21% of modules, and the test suite is large but
 * cannot see an unused variable, a shadowed binding, a `case` that falls
 * through, or a promise executor that swallows a rejection. Those are the
 * defect classes a linter catches for free and review reliably misses.
 *
 * WHY IT IS DELIBERATELY NARROW. A linter that reformats a comment-dense
 * codebase would produce a diff nobody can review and would fight the house
 * style on every line — this project writes long explanatory comments and
 * unusual spacing on purpose. So:
 *
 *   - NO stylistic rules. No quotes, semi, indent, max-len, comma-dangle.
 *     Prettier is not here and is not wanted.
 *   - Only rules that describe a BUG or a genuine hazard.
 *   - Anything that would fire on existing, correct, deliberate code is
 *     either off or a warning — a gate that starts red is a gate people
 *     learn to ignore, which is worse than no gate.
 *
 * The rule set is expected to tighten over time. Each promotion from `warn`
 * to `error` should be its own commit that also fixes the hits.
 */

import globals from 'globals';

export default [
  {
    // Generated, vendored, or not ours.
    ignores: [
      'node_modules/**',
      'preview.html',
      'tools/bisect/**',
      // Generated from docs/CLASSIFICATION_DATA_PACK.md and drift-checked in
      // CI; linting the generator's output would mean linting the generator's
      // formatting choices.
      'src/classify/pattern-rules.js',
      'src/classify/address-map.js',
      'src/timetable/**',
    ],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.node,
      },
    },
    linterOptions: {
      // An eslint-disable that no longer suppresses anything is a comment
      // claiming a hazard that is gone. Report them rather than let them rot.
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      /* ---- genuine bugs: these are errors ------------------------------ */
      /*
       * WARN, NOT ERROR, AND ON PURPOSE (2026-08-15).
       *
       * The first run found 43. Twenty-seven were dead IMPORTS in main.js --
       * residue from earlier extractions, removed in the same commit that
       * added this file. The sixteen that remain are local bindings whose
       * removal is a behaviour question, not a lint one (a captured timer
       * handle, a `counts` that documents a shape, two closers kept beside
       * the openers they mirror). Each deserves its own look.
       *
       * A gate that lands red is a gate the team learns to skip, so this
       * stays a warning until the remaining sixteen are individually
       * resolved, then it is promoted to error in the commit that clears the
       * last one. `npm run lint` is wired into CI as a HARD gate today for
       * every other rule in this file.
       */
      'no-unused-vars': ['warn', {
        args: 'none',              // documented-but-unused params are fine
        varsIgnorePattern: '^_',
        caughtErrors: 'none',      // `catch (err) {}` with an unused err is a
                                   // deliberate idiom throughout this tree
      }],
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-class-members': 'error',
      'no-duplicate-case': 'error',
      'no-unsafe-negation': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-compare-neg-zero': 'error',
      /* `while ((m = re.exec(s)) !== null)` is the correct way to walk a
         global regex, and this tree uses it deliberately with the extra
         parens that say "assignment intended". 'except-parens' still catches
         the genuine `if (a = b)` typo. */
      'no-cond-assign': ['error', 'except-parens'],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-sparse-arrays': 'error',
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-obj-calls': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-async-promise-executor': 'error',
      'require-atomic-updates': 'off', // too many false positives on the
                                       // epoch-guard idiom this app uses

      /* ---- security-adjacent: this extension renders untrusted mail ---- */
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-proto': 'error',
      'no-extend-native': 'error',

      /* ---- hazards worth seeing, not worth blocking on yet ------------- */
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-prototype-builtins': 'warn',
      'no-useless-escape': 'warn',
      'no-control-regex': 'off', // header scrubbing legitimately needs these
    },
  },
  {
    /*
     * TESTS MAY HOLD THE WEAPON (2026-08-15).
     *
     * The security suites are supposed to contain attack payloads:
     * sanitize.test.mjs asserts that `javascript:` URLs are refused,
     * fuzz-rules.test.mjs feeds `__proto__` at the rule engine, and
     * package.test.mjs uses `new Function` to evaluate a manifest expression.
     * Flagging those is the linter marking the TEST as the vulnerability it
     * is proving does not exist — the fastest way to get a security suite
     * watered down to satisfy a tool.
     *
     * Unused variables drop to `warn` here for a different reason: a
     * half-built fixture is a smell, not a defect, and a red build over one
     * teaches people to delete assertions.
     */
    files: ['test/**/*.mjs', 'tools/**/*.mjs', 'tools/**/*.js'],
    rules: {
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-script-url': 'off',
      'no-proto': 'off',
      'no-new-func': 'off',
      'no-sparse-arrays': 'off',
    },
  },
];
