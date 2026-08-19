import type { Env } from '../../../config/env.js';
import { createGraphMediaFetcher } from './graph-media-fetcher.js';
import { FixtureMediaFetcher, type MediaFetcher, seedDemoMedia } from './media-fetcher.js';

/**
 * Pick the media fetcher from config — never by import, so the suite stays
 * offline while staging can talk to Meta. Same shape as `selectDocumentStore`,
 * `selectImageNormaliser` and `selectDocumentGuard`; the `makeGraph` seam keeps
 * this unit-testable without opening a socket.
 *
 * `MEDIA_FETCH` is the name issue #79's acceptance list uses. The neighbouring
 * switches read `INGEST_QUEUE` / `OBJECT_STORE` / `IMAGE_NORMALISER` /
 * `DOCUMENT_GUARD`, so `MEDIA_FETCHER` would be the house-consistent spelling —
 * raised on the issue, deliberately not renamed unilaterally.
 */
export function selectMediaFetcher(
  env: Env,
  makeGraph: (env: Env) => MediaFetcher = (resolved) =>
    createGraphMediaFetcher({ accessToken: resolved.META_MEDIA_ACCESS_TOKEN }),
): MediaFetcher {
  if (env.MEDIA_FETCH === 'graph') return makeGraph(env);

  // DEMO-MOCK: pre-seed the one demo:whatsapp media id (METH Stage 5) so the demo
  // beat lands a document. Guarded to the fixture branch — the graph fetcher above
  // is never touched, so no real Meta media id is ever fabricated.
  const fixture = new FixtureMediaFetcher();
  seedDemoMedia(fixture);
  return fixture;
}
