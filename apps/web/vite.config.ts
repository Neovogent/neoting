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
    /**
     * Dev proxy (METH Stage 6): `/v1` is forwarded to the API on :3000, so the
     * session cookie is first-party and no CORS surface has to exist — the API
     * deliberately has none. Active when `VITE_API_BASE_URL` is the EMPTY
     * string (`.env.development` sets it so): the http-client then builds
     * relative `/v1/...` URLs, which land here. A non-empty base URL bypasses
     * the proxy entirely, which is what pointing the app at staging means.
     */
    proxy: {
      // `NT_DEV_API_ORIGIN` (a plain env var — not VITE_*, it never reaches
      // client code) repoints the proxy when :3000 is taken, which on a
      // machine running concurrent sessions it sometimes is.
      '/v1': { target: process.env.NT_DEV_API_ORIGIN ?? 'http://localhost:3000', changeOrigin: false },
    },
  },

  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],

    /**
     * A wall-clock budget for transform contention, not for slow assertions.
     *
     * Several suites wait on a dynamic `import()` — either `React.lazy` route
     * chunks (`ChasePortalView.test.tsx` renders the real `App`) or a deliberate
     * `await import('./ChatArea')` that lands after the context mock. Under a
     * 24-file parallel run, vite has to transform that graph on demand, and on a
     * loaded machine a single chunk has been measured taking well over five
     * seconds while the suite reports 60-113s of aggregate import time.
     *
     * That raced vitest's 5s default and failed roughly one run in three — on
     * `origin/main`, with no application change in sight, so this is harness
     * marginality rather than anything a product change introduced. Every one of
     * these files passes deterministically in isolation in about a second.
     *
     * Raising the ceiling costs a green run nothing: a test that resolves in
     * 40ms still resolves in 40ms. It only stops the harness abandoning a chunk
     * that was always going to arrive. A genuinely broken component still fails,
     * just later — the assertions are untouched.
     */
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
