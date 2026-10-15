import type { ScopeContext } from '../db/scope-context.js';
import {
  type ApiKeyPrincipal,
  type ContextResolver,
  type HeaderReader,
  setCurrentApiKey,
  unauthenticated,
} from './request-context.js';

/**
 * The API-key resolver (rush/public-api), alongside the session one.
 *
 * `Authorization: Bearer nt_live_…` → the key's practice, acting as the key's
 * own `UserKind.API` user — so every query it makes is `scopedDb` under the same
 * RLS predicate a person's would be, and an API key can only ever see its own
 * practice. Anything else falls through to the wrapped resolver unchanged.
 *
 * WHICH endpoints a key may call, and with which scope, is not decided here: the
 * resolver only knows headers. `PublicApiGuard` reads the route's `@PublicApi`
 * marker and the scopes this resolver records.
 */

export const API_KEY_PREFIX = 'nt_live_';

/** The raw token from an Authorization header, or undefined when it is not an API key. */
export function apiKeyTokenFrom(authorization: string | undefined): string | undefined {
  const match = /^Bearer\s+(nt_live_\S+)$/i.exec(authorization?.trim() ?? '');
  return match?.[1];
}

/** A bearer that is an API key is a WORKSPACE caller, never the portal — the handlers that branch on "a bearer means the portal" ask this first. */
export function isApiKeyAuthorization(authorization: string | undefined): boolean {
  return apiKeyTokenFrom(authorization) !== undefined;
}

export interface VerifiedApiKey extends ApiKeyPrincipal {
  readonly context: ScopeContext;
}

export interface ApiKeyContextDeps {
  /** Token → the key's context and scopes, or null for unknown/revoked/malformed. */
  readonly verifyApiKey: (token: string) => Promise<VerifiedApiKey | null>;
}

export class ApiKeyContextResolver implements ContextResolver {
  constructor(
    private readonly deps: ApiKeyContextDeps,
    private readonly inner: ContextResolver,
  ) {}

  async resolve(headers: HeaderReader): Promise<ScopeContext> {
    const authorization = headers('authorization');
    const token = apiKeyTokenFrom(authorization);
    if (token === undefined) return this.inner.resolve(headers);

    const key = await this.deps.verifyApiKey(token);
    // One detail for unknown, revoked and malformed — the session resolver's stance.
    if (key === null) throw unauthenticated('invalid or revoked API key');
    setCurrentApiKey({ keyId: key.keyId, scopes: key.scopes });
    return key.context;
  }
}
