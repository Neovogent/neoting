import { type ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import { ProblemFilter } from './problem.filter.js';
import { AppException } from './problem.js';

function harness(): { host: ArgumentsHost; sent: { status?: number; type?: string; body?: unknown } } {
  const sent: { status?: number; type?: string; body?: unknown } = {};
  const res = {
    status(code: number) { sent.status = code; return this; },
    type(value: string) { sent.type = value; return this; },
    send(body: unknown) { sent.body = body; return this; },
  };
  const req = { header: (): string | undefined => undefined };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  return { host, sent };
}

test('an AppException renders its own NT- code, status and a traceId', () => {
  const { host, sent } = harness();
  new ProblemFilter().catch(
    new AppException('NT-INT-001', HttpStatus.UNAUTHORIZED, 'Webhook signature verification failed'),
    host,
  );
  expect(sent.status).toBe(401);
  expect(sent.type).toBe('application/problem+json');
  expect((sent.body as { code: string }).code).toBe('NT-INT-001');
  expect((sent.body as { traceId: string }).traceId.length).toBeGreaterThan(0);
});

test('an unknown error becomes a 500 NT-SRV-001 and leaks no internal detail', () => {
  const { host, sent } = harness();
  const internalMarker = 'internal-detail-must-not-leak';
  new ProblemFilter().catch(new Error(`boom: ${internalMarker}`), host);
  expect(sent.status).toBe(500);
  expect((sent.body as { code: string }).code).toBe('NT-SRV-001');
  expect(JSON.stringify(sent.body)).not.toContain(internalMarker);
});

test('a framework HttpException maps to a code by status', () => {
  const { host, sent } = harness();
  new ProblemFilter().catch(new HttpException('bad', HttpStatus.BAD_REQUEST), host);
  expect(sent.status).toBe(400);
  expect((sent.body as { code: string }).code).toBe('NT-VAL-001');
});
