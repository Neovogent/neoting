import { type ScopeContext, ScopeContextSchema } from '../db/scope-context.js';
import { type ContextResolver, type HeaderReader, unauthenticated } from './request-context.js';

// Dev headers, lower-cased (Node lower-cases header names). Deliberately the
// same names the generated frontend dev client will send in fixture mode.
const ACTOR_HEADER = 'x-nt-actor';
const PRACTICE_HEADER = 'x-nt-practice';
const BUSINESS_HEADER = 'x-nt-business';

/**
 * The `AUTH_MODE=fixture` resolver — DEV ONLY. It builds a `ScopeContext`
 * straight from `X-NT-Actor` / `X-NT-Practice` / `X-NT-Business` headers, so an
 * endpoint can exercise `scopedDb` before auth exists.
 *
 * This trusts request headers for identity, which is exactly the shape of an
 * auth bypass. It is safe only because `env.ts` refuses `fixture` mode at boot
 * under `NODE_ENV=production` — the guard is structural, not a matter of
 * remembering to set a flag.
 */
export class FixtureContextResolver implements ContextResolver {
  resolve(headers: HeaderReader): ScopeContext {
    const actorId = headers(ACTOR_HEADER)?.trim();
    if (!actorId) throw unauthenticated('missing X-NT-Actor header');

    const practiceId = headers(PRACTICE_HEADER)?.trim() || undefined;
    const businessId = headers(BUSINESS_HEADER)?.trim() || undefined;

    // Parse, don't trust — and let the schema's own rule (needs a practice or a
    // business) reject an actor-only context rather than build one that reads
    // every policy branch as empty.
    const parsed = ScopeContextSchema.safeParse({
      actorId,
      ...(practiceId === undefined ? {} : { practiceId }),
      ...(businessId === undefined ? {} : { businessId }),
    });
    if (!parsed.success) throw unauthenticated('invalid request-context headers');
    return parsed.data;
  }
}
