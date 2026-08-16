import type { ScopeContext } from '../db/scope-context.js';
import type { ContextResolver, HeaderReader } from './request-context.js';

/**
 * The `AUTH_MODE=session` resolver — a deliberate placeholder. Real session and
 * tenancy resolution (cookies, TOTP, delegated OTP → a `ScopeContext`) is S1,
 * Shakib's track. This class is the exact provider S1 swaps its implementation
 * into; until then a session-mode request is a misconfiguration, so it fails
 * loudly rather than inventing a context.
 */
export class SessionContextResolver implements ContextResolver {
  resolve(_headers: HeaderReader): ScopeContext {
    throw new Error('session auth is not implemented yet — it lands with S1 (auth/tenancy)');
  }
}
