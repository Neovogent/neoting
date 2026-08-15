import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

/**
 * The mocked API, running in the page.
 *
 * Started only when `VITE_API_MOCKING=enabled`, so the same build talks to a
 * real backend by pointing `VITE_API_BASE_URL` at it and changing nothing
 * else. Unhandled requests pass through rather than erroring: the app still
 * loads its fonts and its own assets while only the API is intercepted.
 */
export const worker = setupWorker(...handlers);

export async function startMockApi(): Promise<void> {
  await worker.start({
    onUnhandledRequest: 'bypass',
    quiet: false,
    serviceWorker: { url: '/mockServiceWorker.js' },
  });
}
