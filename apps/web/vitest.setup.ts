import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { afterEach } from 'vitest';

import { installMatchMedia, resetViewport } from './src/test/viewport';

/**
 * `findBy*` keeps its OWN clock, and vitest's `testTimeout` does not govern it.
 *
 * This was measured, not assumed: raising `testTimeout` to 20s left
 * `ChasePortalView.test.tsx` failing in exactly the same place, because
 * `findByRole` gives up after testing-library's `asyncUtilTimeout` — 1000ms by
 * default — long before the test itself is in any danger.
 *
 * What those queries are waiting for is a `React.lazy` chunk: the portal screens
 * are lazy by design (SoT §14 wants the OTP portal to be the lightest surface in
 * the product), so `/p/<token>` genuinely cannot paint until a dynamic
 * `import()` resolves. In a 24-file parallel run that import is queued behind
 * vite transforming everything else, and one second is not a realistic budget
 * for it on a loaded machine.
 *
 * Five seconds is a ceiling, not a delay. A query that matches immediately still
 * returns immediately; only the give-up point moves, so a element that never
 * appears still fails the test.
 */
configure({ asyncUtilTimeout: 5000 });

// jsdom has no layout engine; these are the browser APIs the app shell
// touches when a component test renders it (motion reads matchMedia and
// observes resize; ChatArea scrolls). Guarded so a jsdom that grows a real
// implementation wins — with one deliberate exception, `matchMedia`, whose
// reasons are in `src/test/viewport.ts`.
if (typeof window !== 'undefined') {
  /**
   * ⚠ THE LAYOUT MODE IS NOW SOMETHING A TEST CHOOSES, AND ITS DEFAULT IS
   * DESKTOP.
   *
   * This used to be a stub answering `matches: false` to every query. It read
   * as neutral and was not: `useViewport()` turns a universal false into
   * `phone: true`, so after the responsive port `App.tsx` rendered `BottomNav`
   * and never `Sidebar` in any of the 300-odd tests, and every desktop-only
   * branch the port introduced was unexercised while the suite stayed green.
   *
   * `setViewport('phone' | 'tablet' | 'desktop')` from `src/test/viewport.ts`
   * is how a test says which shell it means; `resetViewport()` below puts it
   * back after every test, so the choice cannot leak into the next one.
   */
  installMatchMedia();
  afterEach(resetViewport);

  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};

  // jsdom 25's Blob still has no `arrayBuffer()`. The portal reads the bytes it
  // is about to upload in order to hash them (`byteHash`, the contract's dedupe
  // signal), which every browser this ships to supports. Built out of jsdom's
  // own FileReader, which does exist, so the shim is a real read rather than a
  // stand-in — and `??=`-guarded like the three above, so a jsdom that grows
  // the method wins.
  Blob.prototype.arrayBuffer ??= function readBytes(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error ?? new Error('Could not read the blob'));
      reader.readAsArrayBuffer(this);
    });
  };
}
