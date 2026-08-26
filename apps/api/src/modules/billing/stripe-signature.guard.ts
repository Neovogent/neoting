import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';

import { AppException } from '../../common/problem/problem.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import { CLOCK } from './tokens.js';
import type { Clock } from './clock.js';
import { verifyStripeSignature } from './stripe-signature.js';

/**
 * Rejects any Stripe webhook whose `Stripe-Signature` does not verify against
 * the raw body (contract: 401). No payload is trusted until this passes — the
 * handler behind it writes subscription state with NO session, so the
 * signature is the entire authorisation for that write.
 *
 * `NT-INT-001`, the same single code the WhatsApp receiver uses, and
 * deliberately so: `docs/runbooks/error-codes.md` explains that inbound
 * webhook auth is one incident class with one runbook, and that telling an
 * unauthenticated caller *which part* of their signature was wrong hands them
 * an oracle for free.
 */
@Injectable()
export class StripeSignatureGuard implements CanActivate {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RawBodyRequest<Request>>();
    const ok = verifyStripeSignature(
      req.rawBody,
      req.header('stripe-signature'),
      this.env.STRIPE_WEBHOOK_SECRET,
      this.clock.now(),
    );
    if (!ok) {
      throw new AppException(
        'NT-INT-001',
        HttpStatus.UNAUTHORIZED,
        'Webhook signature verification failed',
        'The Stripe-Signature was missing, stale or did not verify.',
      );
    }
    return true;
  }
}
