import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `eslint/**` is the custom lint rule and its test — a gate, not application
    // code (same placement as apps/web). Outside `src/` so it stays out of tsc's
    // include; named here so `pnpm test` still proves the gate gates.
    include: ['src/**/*.test.ts', 'eslint/**/*.test.js'],
    // reflect-metadata is needed once, before any @Injectable/@Controller class
    // is imported, so decorator evaluation has a metadata registry.
    setupFiles: ['./vitest.setup.ts'],
  },
});
