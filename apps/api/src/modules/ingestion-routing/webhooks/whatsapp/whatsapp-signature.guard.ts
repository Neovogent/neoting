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
      throw new AppException(
        'NT-AUTH-001',
        HttpStatus.UNAUTHORIZED,
        'Unauthenticated',
        'Webhook signature missing or invalid.',
      );
    }
    return true;
  }
}
