import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

/**
 * Flat config, deliberately matched to apps/api's rather than invented: the
 * rules the review bar actually rejects on (Guideline §6). `no-explicit-any`
 * and no stray `console`/`debugger` (R9).
 *
 * NOT here yet, and both are tracked rather than forgotten:
 *   · jsx-a11y — Governance §12.5 makes it blocking. It needs the plugin and a
 *     pass over the imported code; landing it in the import PR would bury a
 *     genuine accessibility review inside a 27k-line diff.
 *   · the i18n-literal rule — it would fail on ~1,200 strings today, so it
 *     arrives with the extraction work, not before it.
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
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
    },
  },
  { ignores: ['dist/**', 'node_modules/**', '*.config.ts', 'eslint.config.js', 'src/**/*.msw.ts'] },
];
