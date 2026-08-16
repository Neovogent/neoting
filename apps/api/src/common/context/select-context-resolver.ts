import { FixtureContextResolver } from './fixture-context-resolver.js';
import type { ContextResolver } from './request-context.js';
import { SessionContextResolver } from './session-context-resolver.js';

export type AuthMode = 'fixture' | 'session';

/**
 * Config-selected, not import-selected — the same shape as `INGEST_QUEUE`,
 * `OBJECT_STORE` and `DOCUMENT_GUARD`. Takes the MODE rather than `Env` so it
 * stays trivially unit-testable. The `fixture` path is refused in production by
 * `env.ts`, so this selector never returns the header-trusting resolver there.
 */
export function selectContextResolver(mode: AuthMode): ContextResolver {
  return mode === 'session' ? new SessionContextResolver() : new FixtureContextResolver();
}
