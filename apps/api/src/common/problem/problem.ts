import { HttpException, type HttpStatus } from '@nestjs/common';

import type { ErrorCode, Problem, ProblemErrorsItem } from '@neoting/contracts/model';

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
  errors?: readonly ProblemErrorsItem[];
  /** The contract's one extension member — `NT-EXP-001` only. See {@link AppException.extension}. */
  publishedOutsidePeriod?: Problem['publishedOutsidePeriod'];
}): Problem {
  const base: Problem = {
    type: `https://neoting.com/problems/${args.code}`,
    title: args.title,
    status: args.status,
    code: args.code,
    traceId: args.traceId,
  };
  // exactOptionalPropertyTypes is on: only add the optional members when present.
  return {
    ...base,
    ...(args.detail === undefined ? {} : { detail: args.detail }),
    // `errors` is how the contract carries field-level validation detail. A bare
    // "Validation failed" tells a client nothing about WHICH field it got wrong,
    // and the spec declares the shape, so we send it rather than make them guess.
    ...(args.errors === undefined ? {} : { errors: [...args.errors] }),
    // RFC 7807 extension member. Contracted (`Problem.publishedOutsidePeriod`)
    // rather than free-form, so the generated client carries it and the web can
    // branch on a number instead of parsing an English sentence.
    ...(args.publishedOutsidePeriod === undefined ? {} : { publishedOutsidePeriod: args.publishedOutsidePeriod }),
  };
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
    /** Field-level detail, for validation failures. Rendered into `Problem.errors`. */
    readonly fieldErrors?: readonly ProblemErrorsItem[],
    /**
     * The one contracted RFC 7807 **extension member**, and it is deliberately
     * a named field rather than an open bag.
     *
     * `NT-EXP-001` is the only refusal that sets it: an export that found
     * nothing tells the accountant how many Published documents this client has
     * just outside the period and where they are, because "nothing" on its own
     * reads as a broken feature rather than as a period to widen. An open
     * `Record<string, unknown>` here would let any refusal put anything on the
     * wire; the contract declares this shape, so the generated client carries
     * it and nothing else can slip through.
     */
    readonly extension?: Pick<Problem, 'publishedOutsidePeriod'>,
  ) {
    super(title, status);
  }
}
