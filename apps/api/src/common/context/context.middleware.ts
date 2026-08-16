import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { runWithRequestContext } from './request-context.js';

/**
 * Opens the request-context store per request — the house pattern, mirroring
 * `TraceMiddleware`. It captures only a header reader; resolution is deferred to
 * `RequestContext.require()`, which runs inside Nest's pipeline where
 * `ProblemFilter` can turn a bad context into a 401 (an error thrown from
 * Express middleware would sidestep that filter).
 */
@Injectable()
export class ContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    runWithRequestContext((name) => req.header(name), () => {
      next();
    });
  }
}
