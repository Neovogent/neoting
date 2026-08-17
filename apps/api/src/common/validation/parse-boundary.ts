import { HttpStatus } from '@nestjs/common';
import type { z } from 'zod';

import type { ProblemErrorsItem } from '@neoting/contracts/model';

import { AppException } from '../problem/problem.js';

/**
 * Parse an inbound request part with a **generated** Zod schema from
 * `@neoting/contracts/zod`, or throw 400 `NT-VAL-001` as RFC 7807.
 *
 * This is the boundary rule made mechanical (Governance §3, CLAUDE.md "Zod at
 * every boundary"). It exists as one helper rather than a `try`/`catch` per
 * controller so the failure shape cannot drift between endpoints: every
 * rejection is the same code, the same status, and the same field-level
 * `errors` array the contract declares.
 *
 * **Hand-written DTOs are the thing this prevents.** The schemas come from
 * `openapi.yaml` via orval, so a contract change breaks the build here instead
 * of silently disagreeing with the client generated from the same spec.
 */
export function parseBoundary<T extends z.ZodTypeAny>(schema: T, value: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new AppException(
    'NT-VAL-001',
    HttpStatus.BAD_REQUEST,
    'Validation failed',
    `The ${what} did not match the API contract.`,
    toFieldErrors(parsed.error),
  );
}

/**
 * Zod issues → the contract's `Problem.errors`.
 *
 * Only the field path and Zod's own message are copied. The received VALUE is
 * never echoed: a body may carry a filename or a description a client typed,
 * and error responses are logged and screenshotted far more freely than request
 * bodies are. Naming the field is what a caller needs to fix the call; quoting
 * their data back at them is not.
 *
 * `unrecognized_keys` is expanded rather than passed through. The generated
 * schemas are `.strict()`, so a misspelled field is a 400 — but Zod reports it
 * against the *parent* object with an empty path, which renders as `(body)` and
 * tells a caller who sent `businesId` nothing about which of their seven fields
 * is wrong. One entry per offending key is the answer the `errors` array exists
 * to give. The key is a field NAME, not submitted data, so naming it does not
 * cross the no-echo line above.
 */
function toFieldErrors(error: z.ZodError): ProblemErrorsItem[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        field: [...issue.path, key].join('.'),
        message: 'Unrecognized field. It is not part of the API contract for this request.',
      }));
    }
    return [
      {
        // A top-level failure (a body that is not an object at all) has an empty path.
        field: issue.path.length === 0 ? '(body)' : issue.path.join('.'),
        message: issue.message,
      },
    ];
  });
}

/**
 * The `Idempotency-Key` header, parsed with the operation's own generated header
 * schema.
 *
 * Express lower-cases header names and the generated schema keys on the
 * canonical `Idempotency-Key`, so the value is lifted into the shape the schema
 * expects rather than handing it the whole header bag — which would fail
 * `.strict()` on every other header the request happens to carry.
 *
 * The header is `required: true` in the contract on every mutation (Governance
 * §3), so a missing one is a 400 here, not a silent non-idempotent write.
 */
export function parseIdempotencyKey(schema: z.ZodTypeAny, raw: string | undefined): string {
  const parsed = parseBoundary(schema, { 'Idempotency-Key': raw }, 'Idempotency-Key header') as Record<string, unknown>;
  return parsed['Idempotency-Key'] as string;
}
