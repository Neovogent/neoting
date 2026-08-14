import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';

import { AppException } from '../../../../common/problem/problem.js';
import type { Env } from '../../../../config/env.js';
import { ENV } from '../../../../config/env.module.js';
import { verifyMetaSignature } from './signature.js';

/**
 * Rejects any POST whose `X-Hub-Signature-256` does not verify against the raw
 * body (contract: 401). Applied to the POST handler ONLY — the GET challenge is
 * unsigned, so guarding the controller class would 403 Meta's verification and
 * mark the webhook failed. No payload is trusted until this passes.
 */
@Injectable()
export class WhatsAppSignatureGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RawBodyRequest<Request>>();
    const ok = verifyMetaSignature(
      req.rawBody,
      req.header('x-hub-signature-256'),
      this.env.META_APP_SECRET,
    );
    if (!ok) {
      // NT-INT-001: integration-auth failure (Meta signature), not a user
      // session failure — distinct family per Governance §13.4.
      throw new AppException(
        'NT-INT-001',
        HttpStatus.UNAUTHORIZED,
        'Webhook signature verification failed',
        'The X-Hub-Signature-256 was missing or did not verify.',
      );
    }
    return true;
  }
}
