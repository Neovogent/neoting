import { randomUUID } from 'node:crypto';

import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { runWithTrace } from './trace-context.js';

/**
 * Opens a trace context for every request (Governance §13.1). The traceId is
 * taken from an inbound `x-trace-id` if present (so an upstream trace survives)
 * or minted here, then the whole downstream — controller, guard, and the
 * enqueue that happens inside it — runs within it via AsyncLocalStorage. The
 * webhook log line and the worker log line therefore share one traceId without
 * the controller knowing the mechanism exists.
 */
@Injectable()
export class TraceMiddleware implements NestMiddleware {
  private readonly logger = new Logger('http');

  use(req: Request, _res: Response, next: NextFunction): void {
    const traceId = req.header('x-trace-id') ?? randomUUID();
    runWithTrace(traceId, () => {
      this.logger.log(`${req.method} ${req.originalUrl} trace=${traceId}`);
      next();
    });
  }
}
