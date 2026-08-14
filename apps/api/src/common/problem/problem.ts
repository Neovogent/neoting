import { HttpException, type HttpStatus } from '@nestjs/common';

import type { ErrorCode, Problem } from '@neoting/contracts/model';

/**
 * Build the RFC 7807 `problem+json` body — the only error shape this API
 * returns (Governance §3, contract LAW). `type` links to the code's runbook
 * page (Governance §13.4). Shapes come from `@neoting/contracts/model`; they are
 * never hand-written.
 */
export function buildProblem(args: {
  status: number;
  code: ErrorCode;
  title: string;
  traceId: string;
  detail?: string;
}): Problem {
  const base: Problem = {
    type: `https://neoting.com/problems/${args.code}`,
    title: args.title,
    status: args.status,
    code: args.code,
    traceId: args.traceId,
  };
  // exactOptionalPropertyTypes is on: only add `detail` when present.
  return args.detail === undefined ? base : { ...base, detail: args.detail };
}

/**
 * A domain error that already carries its stable `NT-` code. Throw this instead
 * of a bare `Error` so the wire response is always a valid `problem+json` with a
 * code, rendered by the global {@link ProblemFilter}.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    status: HttpStatus,
    readonly title: string,
    readonly publicDetail?: string,
  ) {
    super(title, status);
  }
}
