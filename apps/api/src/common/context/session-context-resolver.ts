import type { ScopeContext } from '../db/scope-context.js';
import { type ContextResolver, type HeaderReader, sessionExpired, unauthenticated } from './request-context.js';

/**
 * The `AUTH_MODE=session` resolver — real since METH Stage 1 (issue #118).
 *
 * cookie → verified `{userId}` → memberships → `ScopeContext`. The two moving
 * parts are INJECTED as functions rather than imported: the cookie format and
 * the membership lookup belong to `modules/auth-tenancy` (its public seam
 * exports both), and `common/` depending on a module's internals would invert
 * the layering. `context.module.ts` is where the two meet — wiring is its job.
 */

/** What the cookie verifier says about this request. Produced by `modules/auth-tenancy/session-cookie.ts`. */
export type SessionVerdict =
  | { readonly ok: true; readonly userId: string }
  /** `invalid` covers missing, malformed AND bad-signature — one bucket, no oracle. `expired` is separate because the UI response differs. */
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' };

export interface SessionContextDeps {
  /** Verify the raw `Cookie` header (as sent — possibly absent) into a verdict. Pure, synchronous. */
  readonly verifyCookieHeader: (cookieHeader: string | undefined) => SessionVerdict;
  /**
   * The verified user's memberships → a `ScopeContext`, or null when they have
   * none. This is the ONE privileged (unscoped) lookup on the request path —
   * see `modules/auth-tenancy/session-scope.ts` for why it is safe.
   */
  readonly loadScopeForUser: (userId: string) => Promise<ScopeContext | null>;
}

export class SessionContextResolver implements ContextResolver {
  constructor(private readonly deps: SessionContextDeps) {}

  async resolve(headers: HeaderReader): Promise<ScopeContext> {
    const verdict = this.deps.verifyCookieHeader(headers('cookie'));
    if (!verdict.ok) {
      // Missing, malformed and forged are ONE detail string on purpose — telling
      // an unauthenticated caller which check failed is an oracle (the same
      // stance as the webhook's NT-INT-001). Expiry is the exception: the cookie
      // was genuinely ours, so "log in again" is safe and more useful.
      if (verdict.reason === 'expired') throw sessionExpired('The session has expired — log in again.');
      throw unauthenticated('missing or invalid session cookie');
    }

    const scope = await this.deps.loadScopeForUser(verdict.userId);
    if (scope === null) {
      // A valid cookie for a user with no memberships (deactivated, or deleted
      // since the cookie was minted). Not an error to hide — but still a 401,
      // because there is no workspace this request could legally see.
      throw unauthenticated('no active workspace membership for this session');
    }
    return scope;
  }
}
