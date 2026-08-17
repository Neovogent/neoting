import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import neoting from './eslint/no-literal-string-in-jsx.js';

/**
 * Flat config, deliberately matched to apps/api's rather than invented: the
 * rules the review bar actually rejects on (Guideline §6). `no-explicit-any`
 * and no stray `console`/`debugger` (R9).
 *
 * The two families this note used to defer have now arrived (they waited out
 * the import PR so the a11y pass could be reviewed as itself, not buried in a
 * 27k-line diff, and so the dependency decision went past a human first):
 *   · jsx-a11y — Governance §12.5/§14.3 makes accessibility blocking, so the
 *     recommended set lands at its shipped severity, which is error. A
 *     warning-level a11y rule would be a comment, and this file already
 *     explains below what happens to those.
 *   · react-hooks — `rules-of-hooks` and `exhaustive-deps`, both error, and
 *     deliberately nothing else: v7 ships two dozen compiler-assist rules,
 *     and enabling rules nobody has read is how a config stops meaning
 *     anything. These two are the ones that earn their place in a codebase
 *     this hook-heavy.
 *
 * The third one on the deferral list, the i18n-literal rule, arrived first —
 * see below.
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
    plugins: {
      '@typescript-eslint': tsPlugin,
      'jsx-a11y': jsxA11y,
      'react-hooks': reactHooks,
      neoting,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',

      // ── Accessibility (Governance §12.5, CI family `a11y` §14.3) ──────────
      //
      // The upstream recommended set, spread rather than retyped so an upgrade
      // brings its new rules with it. Every enabled rule in it is already
      // `error` — 31 on, 3 off as of 6.10.2 — which is the right severity
      // here: the review bar treats a missing keyboard path or an unlabeled
      // control as a reject, and the lint severity should say what the review
      // does. This is the static half of the frontend ten's item 6; the axe
      // pass before review is still owed, because a linter cannot see computed
      // contrast or focus order.
      ...jsxA11y.flatConfigs.recommended.rules,

      // ── Hooks (CI family `react-hooks`) ───────────────────────────────────
      //
      // `rules-of-hooks` at error because a conditional hook is a crash with a
      // delay. `exhaustive-deps` at error rather than the shipped `warn`
      // because a warning in CI is invisible (nothing fails, nobody reads the
      // log) — and a stale closure over `AppContext` is precisely the #87
      // class of bug. A dependency that is deliberately omitted gets a
      // targeted disable comment with a reason, which
      // `reportUnusedDisableDirectives` keeps honest.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',

      // ── Money (R5, Governance §1.7; CI family `money-type`, §14.3) ────────
      //
      // The full reasoning lives on the identical block in apps/api's config;
      // the one-line version: the generated Zod's `.int()` and Prisma's Int
      // columns gate the boundaries, but a float that meets a `*Pence` name
      // between boundaries — `totalPence * 1.2`, a fixture typed as pounds —
      // arrives at those gates already rounded and already wrong. This app is
      // where money is displayed as pounds, and that stays legal: the
      // conversion functions (`fromPence`, `toPence`) take pounds/pence
      // *parameters*, not `*Pence`-named fields, so the boundary crossing is
      // visible in the name exactly as it should be. The four entries are kept
      // textually identical to apps/api's — change both or the drift test in
      // apps/api/eslint/money-selectors.test.js fails.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            ':matches(Property[key.name=/Pence$/], Property[key.value=/Pence$/], VariableDeclarator[id.name=/Pence$/], AssignmentExpression[left.name=/Pence$/], AssignmentExpression[left.property.name=/Pence$/], AssignmentExpression[left.property.value=/Pence$/]) > Literal[raw=/^[0-9]*\\.[0-9]+$/]',
          message:
            'R5 (Governance §1.7): money is integer pence — no floats, ever. A float literal in a *Pence slot is a wrong number on its way into the books. Convert at the parse boundary with Math.round, or write integer pence.',
        },
        {
          selector:
            ':matches(Property[key.name=/Pence$/], Property[key.value=/Pence$/], VariableDeclarator[id.name=/Pence$/], AssignmentExpression[left.name=/Pence$/], AssignmentExpression[left.property.name=/Pence$/], AssignmentExpression[left.property.value=/Pence$/]) > UnaryExpression > Literal[raw=/^[0-9]*\\.[0-9]+$/]',
          message:
            'R5 (Governance §1.7): money is integer pence — a signed float is still a float. Write signed integer pence.',
        },
        {
          selector:
            'BinaryExpression[operator=/^[-+*\\/%]$/][right.raw=/^[0-9]*\\.[0-9]+$/]:matches([left.name=/Pence$/], [left.property.name=/Pence$/], [left.property.value=/Pence$/])',
          message:
            'R5 (Governance §1.7): float arithmetic on pence makes a wrong number that Math.round then launders past the .int() boundary. Keep the multiplication in integers and round once at the end — Math.round(pence * 20 / 100), never pence * 0.2, which starts from a constant that has no exact binary form.',
        },
        {
          selector:
            'BinaryExpression[operator=/^[-+*\\/%]$/][left.raw=/^[0-9]*\\.[0-9]+$/]:matches([right.name=/Pence$/], [right.property.name=/Pence$/], [right.property.value=/Pence$/])',
          message:
            'R5 (Governance §1.7): float arithmetic on pence makes a wrong number that Math.round then launders past the .int() boundary. Scale in integers.',
        },
      ],

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
