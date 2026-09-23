import { z } from 'zod';

import { QBO_DISCOVERY } from './vendors.js';

/**
 * Intuit's OAuth endpoints, read rather than assumed.
 *
 * ⚠ **This is the one piece of `oauth.ts` that did NOT move to
 * `common/oauth/` on 21 Sep 2026.** Everything else in that file was the RFC,
 * which is the same for every vendor; this is QuickBooks-specific by
 * definition, and leaving it in the shared module would have been the first
 * vendor branch back inside it.
 *
 * Cached for the life of the process: the document changes on Intuit's release
 * schedule, not ours, and re-fetching it before every connect would add a
 * network dependency to a screen that has one already. A failure here falls
 * back to the table's hardcoded values rather than refusing to connect —
 * discovery is a correctness nicety, and being unable to reach it is not a
 * reason a practice cannot connect their books.
 *
 * The App Assessment Questionnaire asks by name whether we read discovery, so
 * this exists to be answered "yes" truthfully as much as for correctness.
 */
const DiscoverySchema = z
  .object({
    authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
    revocation_endpoint: z.string().url().optional(),
  })
  .passthrough();

let discoveryCache: { authorizeUrl: string; tokenUrl: string } | null = null;

export async function resolveQuickBooksEndpoints(
  sandbox: boolean,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ authorizeUrl: string; tokenUrl: string } | null> {
  if (discoveryCache !== null) return discoveryCache;
  try {
    const response = await fetchImpl(sandbox ? QBO_DISCOVERY.sandbox : QBO_DISCOVERY.production);
    if (!response.ok) return null;
    const document = DiscoverySchema.parse(await response.json());
    discoveryCache = { authorizeUrl: document.authorization_endpoint, tokenUrl: document.token_endpoint };
    return discoveryCache;
  } catch {
    return null;
  }
}

/** Test seam — the cache is process-wide, so a test that populated it must be able to clear it. */
export function resetDiscoveryCache(): void {
  discoveryCache = null;
}
