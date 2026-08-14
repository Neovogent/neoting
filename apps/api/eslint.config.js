import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

/**
 * Flat config, minimal but load-bearing: the rules the review bar (Guideline §6)
 * actually rejects on — no `any` (the "No any" acceptance criterion) and no
 * stray `console`/`debugger` (R9). Kept lint-only (not type-aware) so it runs
 * fast and needs no tsconfig program.
 */
export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
      'no-debugger': 'error',

      // R6, Governance §5.2: every query goes through `scopedDb(ctx)`.
      //
      // An unscoped query does not throw and does not look wrong — it runs with
      // no request context, so RLS returns an empty set (or, on a privileged
      // connection, everything). Both failures are silent, which is exactly why
      // this is a lint error and not a review convention: a reviewer has to
      // notice an absence, and the rule does not.
      //
      // Written as an import restriction rather than a call-shape rule because
      // that is the choke point: PrismaClient cannot be constructed or injected
      // without importing it, and `common/db/**` is the one place allowed to.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              importNames: ['PrismaClient'],
              message:
                'Do not reach for PrismaClient directly (R6). Use scopedDb(ctx, fn) from common/db — an unscoped query is a tenancy leak that fails silently, not loudly. Type-only imports (`import type`) are fine.',
            },
          ],
        },
      ],
    },
  },
  {
    // The wrapper itself, and the tests that prove it, must construct the real
    // client — that is their job. Narrow by path so the exemption cannot spread.
    files: ['src/common/db/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  { ignores: ['dist/**', 'node_modules/**', '*.config.ts', 'eslint.config.js'] },
];
