/**
 * The one fetch wrapper every generated client call goes through.
 *
 * It exists so three rules are obeyed by construction rather than by everyone
 * remembering them:
 *
 *   1. `Idempotency-Key` on every mutation (Governance §3). A caller cannot
 *      forget it, because a caller never sets it.
 *   2. `problem+json` becomes a typed `NtProblemError` carrying the stable `NT-`
 *      code and the trace id — so a UI can render "plain English + what to do +
 *      NT- reference code" (SoT §14) without parsing anything itself.
 *   3. The session cookie travels, and nothing else does. No bearer token is
 *      read from storage here; the workspace session is an httpOnly cookie by
 *      design (Governance §11.1).
 */

/** A `problem+json` response, mapped to something a `catch` block can use. */
export class NtProblemError extends Error {
  readonly status: number;
  /** Stable machine code, e.g. `NT-PRP-002`. Shown to the user; has a runbook page. */
  readonly code: string;
  readonly title: string;
  // `| undefined` is written out rather than relying on `?` alone, and it is
  // load-bearing under exactOptionalPropertyTypes: `?` means "may be absent",
  // which is not the same as "may be present and undefined". The constructor
  // assigns `problem.detail` unconditionally, so these ARE the second thing.
  //
  // This package sets exactOptionalPropertyTypes: false for orval's generated
  // output, which was masking it here — apps/web consumes this file as source
  // under the base config, where the flag is on, and surfaced it.
  readonly detail?: string | undefined;
  readonly traceId?: string | undefined;
  readonly fieldErrors?: Array<{ field: string; message: string }> | undefined;

  constructor(problem: {
    status: number;
    code: string;
    title: string;
    detail?: string;
    traceId?: string;
    errors?: Array<{ field: string; message: string }>;
  }) {
    super(problem.detail ?? problem.title);
    this.name = 'NtProblemError';
    this.status = problem.status;
    this.code = problem.code;
    this.title = problem.title;
    this.detail = problem.detail;
    this.traceId = problem.traceId;
    this.fieldErrors = problem.errors;
  }
}

/** Thrown when the API is unreachable or answers with something that is not a problem+json. */
export class NtTransportError extends Error {
  readonly status?: number | undefined; // see the note on NtProblemError's fields
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'NtTransportError';
    this.status = status;
  }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The API origin, resolved for both runtimes this module is loaded in.
 *
 * ⚠ THIS READ USED TO BE DEAD IN THE ONLY RUNTIME THAT MATTERS. It was
 * `process.env.NEXT_PUBLIC_API_URL`, which D37 (SoT v1.5) retired along with
 * Next.js: in a Vite browser build `process` does not exist and `NEXT_PUBLIC_*`
 * is never defined. The branch could not be taken, so setting an env var to
 * point the app at staging silently kept calling localhost — it failed SOFT,
 * which is why nothing surfaced it.
 *
 * Both branches are guarded because this module is imported from two places
 * with different globals: `apps/web` (browser, Vite) and `apps/api` plus its
 * tests (Node). In Node, `import.meta.env` is simply undefined; in the browser,
 * `process` is. Neither guard is defensive tidiness — remove either one and the
 * other runtime throws at module load.
 */
function baseUrl(): string {
  const fromVite =
    typeof import.meta !== 'undefined'
      ? (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL
      : undefined;
  const fromNode = typeof process !== 'undefined' ? process.env?.API_BASE_URL : undefined;
  const origin = fromVite ?? fromNode ?? 'http://localhost:3001';
  return `${origin.replace(/\/$/, '')}/v1`;
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Node 22 always has crypto.randomUUID; this branch only exists so the module
  // is safe to import in an exotic runtime rather than throwing at load time.
  throw new NtTransportError('crypto.randomUUID is unavailable; cannot generate an Idempotency-Key');
}

export async function ntFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);

  if (!headers.has('Accept')) headers.set('Accept', 'application/json, application/problem+json');
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  // Governance §3: honoured on every mutation. Replays return the original
  // result rather than acting twice — which is what stops a retried publish
  // double-posting a bill into someone's books.
  if (MUTATING_METHODS.has(method) && !headers.has('Idempotency-Key')) {
    headers.set('Idempotency-Key', newIdempotencyKey());
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${url}`, {
      ...options,
      method,
      headers,
      // The workspace session is an httpOnly cookie. Nothing else is sent.
      credentials: 'include',
    });
  } catch (cause) {
    throw new NtTransportError(cause instanceof Error ? cause.message : 'Network request failed');
  }

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';

  if (!response.ok) {
    if (contentType.includes('problem+json')) {
      const problem = (await response.json()) as ConstructorParameters<typeof NtProblemError>[0];
      throw new NtProblemError({ ...problem, status: problem.status ?? response.status });
    }
    throw new NtTransportError(`Unexpected ${response.status} response`, response.status);
  }

  if (contentType.includes('text/plain')) return (await response.text()) as T;
  if (!contentType.includes('json')) return undefined as T;

  return (await response.json()) as T;
}

export default ntFetch;
