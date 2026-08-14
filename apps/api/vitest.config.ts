import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // reflect-metadata is needed once, before any @Injectable/@Controller class
    // is imported, so decorator evaluation has a metadata registry.
    setupFiles: ['./vitest.setup.ts'],
  },
});
