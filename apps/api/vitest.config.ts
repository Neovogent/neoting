import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // ⚠ Integration tests share ONE Postgres. They isolate by id prefix, and
    // that isolation is not airtight: Prisma's `startsWith` compiles to `LIKE
    // 'p4_%'` without escaping the `_`, so extraction-pipeline's cleanup
    // (`p4_`) LIKE-matches duplicate-detector's `p40_prac` and deletes another
    // file's practice mid-test. It surfaces as a foreign-key violation in
    // whichever file lost the race — a failure that moves whenever the file
    // count changes, which reads as "the new stage broke an old test".
    // File-serial execution is the cheap, honest fix (the suite is ~5 s);
    // tightening every prefix is the real one, and it is not this stage's.
    fileParallelism: false,
    // `eslint/**` is the custom lint rule and its test — a gate, not application
    // code (same placement as apps/web). Outside `src/` so it stays out of tsc's
    // include; named here so `pnpm test` still proves the gate gates.
    include: ['src/**/*.test.ts', 'eslint/**/*.test.js'],
    // reflect-metadata is needed once, before any @Injectable/@Controller class
    // is imported, so decorator evaluation has a metadata registry.
    setupFiles: ['./vitest.setup.ts'],
  },
});
