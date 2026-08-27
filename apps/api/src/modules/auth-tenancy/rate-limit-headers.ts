import type { Response } from 'express';

import { SIGN_IN_MAX_FAILURES } from './sign-in-throttle.js';

/**
 * The `RateLimited` response headers (`openapi.yaml`, `components.responses`) —
 * seconds, as integers.
 *
 * The global `ProblemFilter` renders only the body: it lives in `common/`, is
 * shared by every module, and teaching it about per-exception headers is a
 * change no launch stage has owned. So the controllers set these themselves,
 * and they do it from here rather than each keeping their own copy — A2 wrote
 * the four lines for login, A14 needed them again on three more routes, and a
 * third copy is where `RateLimit-Limit` starts disagreeing with the number the
 * throttle actually enforces.
 *
 * ⚠ Requires `@Res({ passthrough: true })` at the call site. Without
 * `passthrough` Nest hands the response over entirely and the filter's own
 * `res.status().send()` never runs; with it, these headers survive it.
 */
export function applyRateLimitHeaders(res: Response, retryAfterSeconds: number): void {
  res.setHeader('Retry-After', String(retryAfterSeconds));
  res.setHeader('RateLimit-Limit', String(SIGN_IN_MAX_FAILURES));
  res.setHeader('RateLimit-Remaining', '0');
  res.setHeader('RateLimit-Reset', String(retryAfterSeconds));
}
