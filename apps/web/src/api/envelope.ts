/**
 * ⚠ The generated response type says `{ status, data }`; the runtime value is
 * the RAW BODY.
 *
 * orval's `httpClient: 'fetch'` types every operation as a status-discriminated
 * envelope, but the configured mutator — `packages/contracts/src/http-client.ts`
 * — returns `await response.json()`, which is the body itself. The two
 * disagree and TypeScript believes the type, so a caller that trusts it reaches
 * one level too deep and hands a Zod schema the wrong object.
 *
 * Unwrapped by SHAPE rather than by type, so this is correct today and still
 * correct if the mutator is ever changed to return the envelope the types
 * describe. Every api-layer module that parses a generated call's result goes
 * through this before the Zod parse; `api/documents.ts` predates it and reads
 * `query.data.data` on the typed assumption instead — see `apps/web/CLAUDE.md`.
 */
export function unwrapBody(value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    'status' in value &&
    typeof (value as { status: unknown }).status === 'number'
  ) {
    return (value as { data: unknown }).data;
  }
  return value;
}
