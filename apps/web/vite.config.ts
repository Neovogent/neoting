import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

/**
 * `defineConfig` comes from `vitest/config`, not `vite` — vite's own type does
 * not carry the `test` key and rejects it.
 *
 * ⚠ THE BUNDLE BUDGET IS NOW A REVIEW CONDITION, NOT A FRAMEWORK GUARANTEE.
 *
 * SoT §14 requires < 250 KB gzipped per route and the OTP portal to be "the
 * lightest surface in the product" — it loads on a phone, on bad mobile data.
 * Under the Next.js plan both were free: route groups produced them. D37 gave
 * that up knowingly and the amendment is explicit that the requirements survive
 * as build configuration plus review.
 *
 * What is done here: route-level lazy loading (see src/App.tsx) so a screen is
 * fetched when it is opened, and `manualChunks` so React and the data layer
 * cache independently of application code.
 *
 * What is NOT done here, and is tracked separately: the portal is still part of
 * this build's graph rather than a separate entry. Lazy loading keeps it out of
 * the initial download, which is most of the benefit; a genuinely separate
 * entry additionally needs the hand-rolled router split and a host rewrite, and
 * that is its own change.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],

  build: {
    // Raised from Vite's 500 kB default so the warning fires near the number we
    // actually promise rather than well past it.
    chunkSizeWarningLimit: 400,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },

  server: {
    port: 5173,
  },

  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
