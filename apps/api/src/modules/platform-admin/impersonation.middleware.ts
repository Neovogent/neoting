import { Inject, Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { getPrismaClient } from '../../common/db/prisma.js';
import { systemContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { buildProblem } from '../../common/problem/problem.js';
import { currentTraceId } from '../../common/trace/trace-context.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import { impersonationRefuses, verifyImpersonation } from '../auth-tenancy/index.js';
import { audit } from './platform-admin.service.js';

/**
 * Support "view as" is READ-ONLY, and this is where that is enforced — before
 * any controller, for every route (rush/admin).
 *
 * While a valid impersonation cookie is present (signed, unexpired, bound to
 * the session beside it):
 *
 * - any non-GET/HEAD/OPTIONS request outside `/v1/admin/*` and logout is
 *   refused `403 NT-PRM-001` without reaching a handler;
 * - every request that IS served is audit-logged on the practice's chain with
 *   the admin's identity, method, path (no query string) and status.
 *
 * The audit is written after the response finishes and its failure is logged,
 * never thrown — the request already happened.
 */
@Injectable()
export class ImpersonationMiddleware implements NestMiddleware {
  readonly #logger = new Logger('Impersonation');

  constructor(@Inject(ENV) private readonly env: Env) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const claims = verifyImpersonation(req.header('cookie'), this.env.SESSION_SECRET);
    if (claims === null) {
      next();
      return;
    }
    const path = (req.originalUrl ?? req.url).split('?')[0] ?? '';

    if (impersonationRefuses(req.method, path)) {
      res
        .status(403)
        .type('application/problem+json')
        .send(
          JSON.stringify(
            buildProblem({
              status: 403,
              code: 'NT-PRM-001',
              title: 'Forbidden',
              traceId: currentTraceId() ?? 'unknown',
              detail: 'Support is viewing this practice read-only. Nothing can be changed while "view as" is on.',
            }),
          ),
        );
      void this.record(claims, req.method, path, 403, true);
      return;
    }

    res.on('finish', () => void this.record(claims, req.method, path, res.statusCode, false));
    next();
  }

  private async record(
    claims: { adminUserId: string; adminEmail: string; practiceId: string },
    method: string,
    path: string,
    status: number,
    refused: boolean,
  ): Promise<void> {
    try {
      const prisma = getPrismaClient();
      // `memberships` carries no RLS — the resolveSystemActor exemption.
      const system = await prisma.membership.findFirst({
        where: { practiceId: claims.practiceId, user: { kind: 'SYSTEM' } },
        select: { userId: true },
      });
      if (system === null) return;
      await scopedDb(prisma, systemContext(claims.practiceId, system.userId), (db) =>
        audit(db, { userId: claims.adminUserId, email: claims.adminEmail }, 'admin.impersonation.request', {
          practiceId: claims.practiceId,
          method,
          path,
          status,
          refused,
        }),
      );
    } catch (error) {
      this.#logger.error(`impersonation audit failed · admin=${claims.adminUserId} ${method} ${path}`, error as Error);
    }
  }
}
