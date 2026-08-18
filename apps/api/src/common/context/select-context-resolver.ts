import { FixtureContextResolver } from './fixture-context-resolver.js';
import type { ContextResolver } from './request-context.js';
import { type SessionContextDeps, SessionContextResolver } from './session-context-resolver.js';

export type AuthMode = 'fixture' | 'session';

/**
 * Config-selected, not import-selected — the same shape as `INGEST_QUEUE`,
 * `OBJECT_STORE` and `DOCUMENT_GUARD`. Takes the MODE rather than `Env` so it
 * stays trivially unit-testable. The `fixture` path is refused in production by
 * `env.ts`, so this selector never returns the header-trusting resolver there.
 *
 * `session` mode needs its two collaborators (cookie verifier + membership
 * loader — see `SessionContextDeps`). They are required by signature rather
 * than optional-and-checked, so forgetting to wire them is a compile error in
 * `context.module.ts`, not a request-time 500.
 */
export function selectContextResolver(mode: AuthMode, sessionDeps: SessionContextDeps): ContextResolver {
  return mode === 'session' ? new SessionContextResolver(sessionDeps) : new FixtureContextResolver();
}
