import { afterEach, expect, test, vi } from 'vitest';
import { ntFetch } from '@neoting/contracts';

/**
 * Where does a browser send its requests when nothing is configured?
 *
 * This test exists because the answer was "the visitor's own machine" and it
 * shipped. The Vercel deploy called `http://localhost:3000/v1/me` from every
 * visitor's browser; nothing was listening, so the request failed as a
 * transport error instead of a 401, `useSession` correctly read that as
 * 'degraded', and the workspace rendered on seed data — a hosted demo running
 * entirely on fixtures, with the explanatory badge suppressed in a production
 * build. Found on 21 Aug 2026 by reading the deployed site's network log, not
 * by any check in this repo.
 *
 * It lives in `apps/web` rather than in `packages/contracts` for two reasons
 * that both matter: this is the consumer whose guarantee it is, and this is the
 * package with a jsdom environment — `window` is the discriminator
 * `http-client.ts` keys on, and a Node-side test cannot exercise the branch
 * that broke.
 *
 * `.env.development` sets `VITE_API_BASE_URL=` to the empty string, which is
 * why dev was always relative and never met the fallback. Vitest does not load
 * that file (mode `test`), so the variable really is undefined here — the exact
 * condition a production build on Vercel has.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function captureRequestUrl(): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal('fetch', (input: unknown) => {
    urls.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  });
  return { urls };
}

test('an unconfigured browser build calls its own origin, never the visitor’s localhost', async () => {
  const { urls } = captureRequestUrl();

  await ntFetch('/me');

  // Relative. This is what makes the Vercel `/v1/*` rewrite apply and keeps the
  // session cookie first-party — the two things the hosted app depends on.
  expect(urls).toEqual(['/v1/me']);
  expect(urls[0]).not.toContain('localhost');
  expect(urls[0]).not.toMatch(/^https?:\/\//);
});

test('the /v1 prefix is added exactly once', async () => {
  const { urls } = captureRequestUrl();

  await ntFetch('/documents?limit=10');

  expect(urls[0]).toBe('/v1/documents?limit=10');
});
