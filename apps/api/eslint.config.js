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
    },
  },
  { ignores: ['dist/**', 'node_modules/**', '*.config.ts', 'eslint.config.js'] },
];
