import { Body, Controller, Headers, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';

import { createPracticeBody, createPracticeHeader } from '@neoting/contracts/zod';

import { currentTraceId } from '../../common/trace/trace-context.js';
import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import type { PracticeSignupService } from './practice-signup.service.js';
import { PRACTICE_SIGNUP_SERVICE } from './tokens.js';

/**
 * `POST /v1/practices` — the only door a tenant that does not exist yet can come
 * through (launch stage A1, ID LAW batch, SoT §24.5).
 *
 * ⚠ **This controller never calls `this.context.require()`, and must not.** It
 * has no `RequestContext` injected at all, so there is nothing here that could
 * accidentally read one. The contract declares `security: []` on this operation
 * for the same reason the service's provisioning write is unscoped: the tenant a
 * session would have been scoped to is what this request creates.
 *
 * Thin by design (`apps/api/CLAUDE.md`): parse with the generated schemas, call
 * ONE service method, return nothing.
 *
 * **204 vs 202.** The contract says `202` with an empty body, and that is the
 * honest code: the account is accepted, but it is not usable until somebody
 * proves control of the address. `204` would claim the work is finished.
 */
@Controller('practices')
export class PracticesController {
  constructor(@Inject(PRACTICE_SIGNUP_SERVICE) private readonly service: PracticeSignupService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async signUp(@Body() body: unknown, @Headers('idempotency-key') idempotencyKey: string | undefined): Promise<void> {
    const key = parseIdempotencyKey(createPracticeHeader, idempotencyKey);
    const input = parseBoundary(createPracticeBody, body, 'request body');
    await this.service.signUp(input, { idempotencyKey: key, traceId: currentTraceId() ?? null });
  }
}
