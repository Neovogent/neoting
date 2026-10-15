import { type CallHandler, type ExecutionContext, HttpStatus, Inject, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { from, map, mergeMap, type Observable } from 'rxjs';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import type { PrismaClient } from '../../common/db/prisma.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import {
  actorHidesFinancials,
  FINANCIAL_ONLY_PREFIXES,
  redactFinancial,
} from '../../common/financial/financial-visibility.js';
import { AppException } from '../../common/problem/problem.js';
import { PRISMA } from './tokens.js';

/** Surfaces this never touches: they authenticate differently or carry no figures. */
const SKIP_PREFIXES = ['/v1/admin', '/v1/auth', '/v1/me', '/v1/portal', '/v1/webhooks', '/v1/practices', '/v1/practice-'];
const CACHE_TTL_MS = 30_000;

/**
 * Applies `hide_financial_fields` to every workspace response (rush/admin).
 *
 * A member flagged non-finance is refused the three wholly-financial surfaces
 * (403 `NT-PRM-001`) and gets every other `/v1` body with amounts and coding
 * nulled (`redactFinancial`). The flag is resolved from the request's OWN
 * scope, so an impersonating admin (SYSTEM actor) and every unflagged member
 * pass through untouched.
 *
 * ponytail: the flag is cached per actor for 30 s, so a toggle takes up to
 * that long to bite. Drop the cache if that window ever matters.
 */
@Injectable()
export class FinancialVisibilityInterceptor implements NestInterceptor {
  readonly #cache = new Map<string, { at: number; hides: boolean }>();

  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (execution.getType() !== 'http') return next.handle();
    const req = execution.switchToHttp().getRequest<Request>();
    const path = req.originalUrl ?? req.url;
    if (!path.startsWith('/v1/') || SKIP_PREFIXES.some((p) => path.startsWith(p)) || req.header('cookie') === undefined) {
      return next.handle();
    }
    return from(this.hides()).pipe(
      mergeMap((hides) => {
        if (!hides) return next.handle();
        if (FINANCIAL_ONLY_PREFIXES.some((p) => path.startsWith(p))) {
          throw new AppException(
            'NT-PRM-001',
            HttpStatus.FORBIDDEN,
            'Forbidden',
            'Your access hides financial figures, so bank lines, statements and exports are not available to you.',
          );
        }
        return next.handle().pipe(map(redactFinancial));
      }),
    );
  }

  private async hides(): Promise<boolean> {
    let ctx;
    try {
      ctx = await this.context.require();
    } catch {
      return false; // not a workspace session — the handler decides what that means
    }
    const hit = this.#cache.get(ctx.actorId);
    if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.hides;
    const hides = await scopedDb(this.prisma, ctx, (db) => actorHidesFinancials(db, ctx.actorId));
    this.#cache.set(ctx.actorId, { at: Date.now(), hides });
    return hides;
  }
}
