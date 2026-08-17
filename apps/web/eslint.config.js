import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import neoting from './eslint/no-literal-string-in-jsx.js';

/**
 * Flat config, deliberately matched to apps/api's rather than invented: the
 * rules the review bar actually rejects on (Guideline §6). `no-explicit-any`
 * and no stray `console`/`debugger` (R9).
 *
 * NOT here yet, and both are tracked rather than forgotten:
 *   · jsx-a11y — Governance §12.5 makes it blocking. It needs the plugin and a
 *     pass over the imported code; landing it in the import PR would bury a
 *     genuine accessibility review inside a 27k-line diff.
 *   · react-hooks — `exhaustive-deps` and `rules-of-hooks` are the two that
 *     would earn their place in a codebase this hook-heavy. Adding the plugin
 *     is a dependency decision, which this repo routes past a human first
 *     (CLAUDE.md), so it is not slipped into the import PR.
 *
 * The third one on that list, the i18n-literal rule, has arrived — see below.
 *
 * Generated output is not a lint surface: `@neoting/contracts` owns its own.
 */
export default [
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2023, sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    // A suppression that no longer suppresses anything is a rule someone thinks
    // is running. Since the literal gate below will attract disable comments,
    // stale and misspelled ones fail here rather than sitting in the file
    // looking like enforcement.
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { '@typescript-eslint': tsPlugin, neoting },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',

      // ── The i18n literal gate (Governance §12.6) ──────────────────────────
      //
      // The rule that stops the catalogue rotting: a string typed straight into
      // JSX fails the build, so the next screen cannot quietly ship untranslated
      // copy. It arrived with the extraction (issue #65) rather than before it,
      // which is why this note used to say "not here yet" — the point of the
      // wait was that a rule failing on 1,200 strings gets switched off, and a
      // rule that is switched off is a comment.
      //
      // `neoting/` rather than `formatjs/` because it is **not** the stock rule:
      // it is `formatjs/no-literal-string-in-jsx` with reports over pure
      // punctuation dropped, because the upstream rule has no option for that
      // in any published version. `eslint/no-literal-string-in-jsx.js` says
      // exactly what it exempts and why. The distinct name is deliberate — a
      // line reading `formatjs/no-literal-string-in-jsx: error` next to a rule
      // that behaves differently would be a quiet lie in the one file reviewers
      // read to find out what is enforced.
      'neoting/no-literal-string-in-jsx': 'error',
    },
  },
  { ignores: ['dist/**', 'node_modules/**', '*.config.ts', 'eslint.config.js', 'src/**/*.msw.ts'] },
];
