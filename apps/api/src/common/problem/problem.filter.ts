import { randomUUID } from 'node:crypto';

import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import type { ErrorCode } from '@neoting/contracts/model';
import { AppException, buildProblem } from './problem.js';

/**
 * Best-fit `NT-` code for a framework `HttpException` that did not carry its
 * own. The auth statuses map to the auth family; validation to `NT-VAL-001`.
 */
const CODE_BY_STATUS: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: 'NT-VAL-001',
  [HttpStatus.UNAUTHORIZED]: 'NT-AUTH-001',
  [HttpStatus.FORBIDDEN]: 'NT-AUTH-001',
  [HttpStatus.TOO_MANY_REQUESTS]: 'NT-RATE-001',
};

/**
 * The global error boundary. Every thrown error leaves as RFC 7807
 * `problem+json` with a stable `NT-` code and a `traceId` (Governance §3). No
 * internal detail or PII reaches the client.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const traceId = req.header('x-trace-id') ?? randomUUID();

    if (exception instanceof AppException) {
      const status = exception.getStatus();
      this.send(res, status, buildProblem({
        status,
        code: exception.code,
        title: exception.title,
        traceId,
        ...(exception.publicDetail === undefined ? {} : { detail: exception.publicDetail }),
      }));
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = CODE_BY_STATUS[status] ?? 'NT-VAL-001';
      this.send(res, status, buildProblem({ status, code, title: exception.message, traceId }));
      return;
    }

    // Unknown: a bug. Log it server-side with the trace; tell the client nothing.
    this.logger.error(`Unhandled exception [${traceId}]`, exception instanceof Error ? exception.stack : String(exception));
    this.send(res, HttpStatus.INTERNAL_SERVER_ERROR, buildProblem({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'NT-SRV-001',
      title: 'Internal Server Error',
      traceId,
    }));
  }

  private send(res: Response, status: number, body: unknown): void {
    res.status(status).type('application/problem+json').send(body);
  }
}
