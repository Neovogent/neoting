import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import neoting from './eslint/no-cross-module-internals.js';

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
    plugins: { '@typescript-eslint': tsPlugin, neoting },
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

      // The module boundary (CI family `module-boundary`, §14.3): a file in
      // modules/<A> may import modules/<B> only through <B>'s public seam,
      // modules/<B>/index.ts. `apps/api/CLAUDE.md` states the boundary and
      // `ingestion-routing/CLAUDE.md` promises it is lint-enforced; this is the
      // enforcement. A custom rule because no stock rule can do it: whether
      // `../storage/x.js` crosses a boundary depends on where the importing
      // file *is*, which a specifier pattern cannot see. The rule lives in
      // `eslint/no-cross-module-internals.js` with its reasoning and its test.
      'neoting/no-cross-module-internals': 'error',

      // ── Money (R5, Governance §1.7; CI family `money-type`, §14.3) ────────
      //
      // The two chokepoints already gate the boundaries: check-contract.mjs +
      // enforce-money-int.mjs put `.int()` on every generated `*Pence` Zod
      // field, and every Prisma money column is Int. What neither can see is a
      // float touching pence BETWEEN boundaries — `Math.round(totalPence * 1.2)`
      // arrives at the boundary as a clean integer that is the wrong number.
      // These selectors catch the float at the moment it meets a `*Pence` name.
      //
      // Keyed on the name convention deliberately: `*Pence` is enforced on the
      // spec side and stated in prisma/schema.prisma, so the name IS the money
      // type in this codebase. Matched shapes only — a float literal born into,
      // assigned to, or arithmetically combined with a pence name — so the rule
      // has no opinion about floats elsewhere (timestamps, ratios, jitter), and
      // `pence / 100` written against a *pounds-returning* boundary function
      // stays legal because its parameter is not a money-typed field name.
      // Zero matches in the codebase on the day it landed; every future match
      // is R5. Kept textually identical to apps/web's block — change both or
      // the drift test in apps/api/eslint/money-selectors.test.js fails.
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
    },
  },
  {
    // The wrapper itself, and the tests that prove it, must construct the real
    // client — that is their job. Integration tests do too: they set fixtures up
    // as the owner and read them back as the app to prove RLS. Narrow by path so
    // the exemption cannot spread to ordinary code.
    files: ['src/common/db/**/*.ts', 'src/**/*.integration.test.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // Integration tests are little composition roots: they assemble real modules
    // around real infrastructure to prove behaviour across the seams, which is
    // the same job `app.module.ts` and `worker/` do in production — and those
    // are exempt by location. Holding these tests to the boundary would force
    // test-only names (fixture stores, detectors) into public seams, inverting
    // what a seam means. Unit tests get no such exemption: they type against
    // the seam like any other consumer.
    files: ['src/**/*.integration.test.ts'],
    rules: { 'neoting/no-cross-module-internals': 'off' },
  },
  { ignores: ['dist/**', 'node_modules/**', '*.config.ts', 'eslint.config.js'] },
];
