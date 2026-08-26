import { HttpStatus } from '@nestjs/common';
import { describe, expect, test } from 'vitest';

import type { PrismaClient } from '../../../common/db/prisma.js';
import { AppException } from '../../../common/problem/problem.js';
import type { DocumentStore } from '../../ingestion-routing/index.js';

import { CapabilityLinkService } from './capability-link.service.js';
import { InMemoryCapabilityLinkRateLimiter, PER_CODE_HOURLY, PER_IP_HOURLY } from './link-rate-limit.js';

/**
 * `GET /d/{code}` is an unauthenticated URL to a client's financial document,
 * so the interesting tests are the ones where it says NO. Every refusal below
 * asserts two things: the status a caller sees, and — where it matters more —
 * that nothing was signed, logged or read on the way to it.
 */

const NOW = new Date('2026-08-26T09:00:00.000Z');
const CODE = 'A7K2M9PQ';

interface Recorded {
  resolverCalls: string[];
  systemActorLookups: unknown[];
  documentFindUnique: unknown[];
  linkUpdates: unknown[];
  events: { documentId: string; stage: string; outcome: string; detail: unknown }[];
  presignGet: unknown[];
  scopeGucs: unknown[][];
}

function harness(
  options: {
    row?: Record<string, unknown> | null;
    document?: Record<string, unknown> | null;
    systemActor?: string | null;
    limiter?: InMemoryCapabilityLinkRateLimiter;
    rowsReturned?: number;
  } = {},
) {
  const calls: Recorded = {
    resolverCalls: [],
    systemActorLookups: [],
    documentFindUnique: [],
    linkUpdates: [],
    events: [],
    presignGet: [],
    scopeGucs: [],
  };

  const row =
    options.row === undefined
      ? {
          link_id: 'dl_1',
          document_id: 'doc_1',
          business_id: 'biz_1',
          practice_id: 'prac_1',
          revoked: false,
          expired: false,
        }
      : options.row;

  const document =
    options.document === undefined
      ? {
          id: 'doc_1',
          s3Key: 'w/biz_1/documents/abc',
          mimeType: 'application/pdf',
          byteSize: 1024,
          originalFilename: 'invoice.pdf',
        }
      : options.document;

  const tx = {
    $executeRaw: async (...args: unknown[]) => {
      calls.scopeGucs.push(args);
      return 0;
    },
    document: {
      findUnique: async (args: unknown) => {
        calls.documentFindUnique.push(args);
        return document;
      },
    },
    documentLink: {
      update: async (args: unknown) => {
        calls.linkUpdates.push(args);
        return {};
      },
    },
    documentEvent: {
      create: async (args: { data: { documentId: string; stage: string; outcome: string; detail: unknown } }) => {
        calls.events.push(args.data);
        return {};
      },
    },
  };

  const prisma = {
    // The ONE unscoped query. `$queryRaw` is a tagged template: strings first,
    // then the bound values — so `values[0]` is the code, proving it is a bind
    // parameter and not interpolated into the SQL.
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.resolverCalls.push(String(values[0]));
      expect(strings.join('?')).toContain('app_resolve_document_link');
      if (row === null) return [];
      return Array.from({ length: options.rowsReturned ?? 1 }, () => row);
    },
    membership: {
      findFirst: async (args: unknown) => {
        calls.systemActorLookups.push(args);
        return options.systemActor === null ? null : { userId: options.systemActor ?? 'sys_1' };
      },
    },
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;

  const store: DocumentStore = {
    put: async () => ({ key: 'k', sha256: 's', byteLength: 0 }),
    get: async () => Buffer.alloc(0),
    sha256: async () => 's',
    head: async () => null,
    presignPut: async () => ({ key: 'k', url: 'https://example.test/put', headers: {} }),
    presignGet: async (input) => {
      calls.presignGet.push(input);
      return { url: 'https://storage.test/obj?sig=x', expiresAt: new Date(NOW.getTime() + 120_000) };
    },
  };

  const limiter = options.limiter ?? new InMemoryCapabilityLinkRateLimiter(() => NOW);
  return { calls, limiter, service: new CapabilityLinkService(prisma, store, limiter, () => NOW) };
}

async function refusal(fn: () => Promise<unknown>): Promise<AppException> {
  try {
    await fn();
    throw new Error('expected a refusal, got a resolution');
  } catch (error) {
    if (!(error instanceof AppException)) throw error;
    return error;
  }
}

// ---------------------------------------------------------------------------
// The happy path, only so the refusals mean something
// ---------------------------------------------------------------------------

describe('a live code', () => {
  test('resolves to a short-lived, object-scoped URL — never to the bytes', async () => {
    const { calls, service } = harness();
    const result = await service.resolve({ code: CODE, ip: '203.0.113.9', traceId: 'trace-1' });

    expect(result.url).toBe('https://storage.test/obj?sig=x');
    expect(calls.presignGet).toEqual([
      {
        key: 'w/biz_1/documents/abc',
        expiresInSeconds: 120,
        // The STORED mime type, pinned onto the signed response so a browser
        // cannot sniff the bytes and decide the file is something executable.
        contentType: 'application/pdf',
        filename: 'invoice.pdf',
      },
    ]);
  });

  test('reads ONLY the document the token names', async () => {
    const { calls, service } = harness();
    await service.resolve({ code: CODE });
    // The id comes from the link row, and there is no other filter a caller
    // could influence. RLS is still underneath.
    expect(calls.documentFindUnique).toEqual([
      {
        where: { id: 'doc_1' },
        select: { id: true, s3Key: true, mimeType: true, byteSize: true, originalFilename: true },
      },
    ]);
  });

  test('re-enters through scopedDb as the practice’s SYSTEM actor', async () => {
    const { calls, service } = harness();
    await service.resolve({ code: CODE });
    expect(calls.systemActorLookups).toEqual([
      { where: { practiceId: 'prac_1', user: { kind: 'SYSTEM' } }, select: { userId: true } },
    ]);
    // The GUCs were set on the transaction — the read did not run contextless.
    expect(calls.scopeGucs).toHaveLength(1);
  });

  test('the code reaches SQL as a BOUND PARAMETER, normalised', async () => {
    const { calls, service } = harness();
    await service.resolve({ code: 'a7k2m9pq' });
    expect(calls.resolverCalls).toEqual([CODE]);
  });

  test('⚠ the access is logged and the counter incremented BEFORE the redirect is issued', async () => {
    const { calls, service } = harness();
    await service.resolve({ code: CODE, ip: '203.0.113.9', traceId: 'trace-1' });

    expect(calls.linkUpdates).toEqual([
      { where: { id: 'dl_1' }, data: { accessCount: { increment: 1 }, lastAccessedAt: NOW } },
    ]);
    expect(calls.events).toHaveLength(1);
    expect(calls.events[0]).toMatchObject({ documentId: 'doc_1', stage: 'source-link', outcome: 'accessed', traceId: 'trace-1' });
    // Both writes happened inside the transaction, which resolved before the
    // presign was asked for.
    expect(calls.presignGet).toHaveLength(1);
  });

  test('the caller’s address is pseudonymised, never stored raw', async () => {
    const { calls, service } = harness();
    await service.resolve({ code: CODE, ip: '203.0.113.9' });
    const detail = calls.events[0]?.detail as Record<string, unknown>;
    expect(JSON.stringify(detail)).not.toContain('203.0.113.9');
    expect(detail['callerPseudonym']).toMatch(/^[0-9a-f]{16}$/);
    expect(detail['linkId']).toBe('dl_1');
  });

  test('no address means no pseudonym, not a fabricated one', async () => {
    const { calls, service } = harness();
    await service.resolve({ code: CODE });
    expect((calls.events[0]?.detail as Record<string, unknown>)['callerPseudonym']).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ⚠ THE REFUSALS
// ---------------------------------------------------------------------------

describe('404 — indistinguishable from a code that never existed', () => {
  test('an unknown code', async () => {
    const { calls, service } = harness({ row: null });
    const error = await refusal(() => service.resolve({ code: CODE }));

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.code).toBe('NT-VAL-001');
    // NOTHING was signed, no actor resolved, no scope opened.
    expect(calls.presignGet).toEqual([]);
    expect(calls.systemActorLookups).toEqual([]);
    expect(calls.scopeGucs).toEqual([]);
  });

  test('a malformed code is a 404, never a 400 — a validation error is an oracle', async () => {
    const { calls, service } = harness();
    for (const attempt of ['!!!', 'ABC', "' OR 1=1--", '../../etc/passwd', '12345678', 'A7K2M9PQR2T4X']) {
      const error = await refusal(() => service.resolve({ code: attempt }));
      expect(error.getStatus(), attempt).toBe(HttpStatus.NOT_FOUND);
      expect(error.code, attempt).toBe('NT-VAL-001');
    }
    // The database was never asked about any of them.
    expect(calls.resolverCalls).toEqual([]);
    expect(calls.presignGet).toEqual([]);
  });

  test('the detail never echoes the code back', async () => {
    const { service } = harness({ row: null });
    const error = await refusal(() => service.resolve({ code: CODE }));
    expect(error.publicDetail).not.toContain(CODE);
    expect(error.publicDetail).toBe('No document link with that code.');
  });

  test('a link whose document RLS cannot see is a 404, and NOTHING is signed for it', async () => {
    // The link row exists — this is a document that was moved, erased, or
    // belongs to a business the SYSTEM actor's practice no longer owns. The
    // 404 alone would not prove the point: a refactor that presigned before
    // the lookup would still 404 and still have minted a working URL to
    // somebody's bytes, and object storage has no RLS to undo that.
    const { calls, service } = harness({ document: null });
    const error = await refusal(() => service.resolve({ code: CODE }));

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(calls.presignGet).toEqual([]);
  });

  test('a malformed code still burns rate-limit budget', async () => {
    const limiter = new InMemoryCapabilityLinkRateLimiter(() => NOW);
    const { service } = harness({ limiter });
    for (let i = 0; i < PER_IP_HOURLY; i += 1) {
      await refusal(() => service.resolve({ code: `!!!${i}`, ip: '198.51.100.4' }));
    }
    const error = await refusal(() => service.resolve({ code: CODE, ip: '198.51.100.4' }));
    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });
});

describe('410 — revoked and expired, told apart from 404 on purpose', () => {
  test('a revoked link', async () => {
    const { calls, service } = harness({
      row: { link_id: 'dl_1', document_id: 'doc_1', business_id: 'biz_1', practice_id: 'prac_1', revoked: true, expired: false },
    });
    const error = await refusal(() => service.resolve({ code: CODE }));

    expect(error.getStatus()).toBe(HttpStatus.GONE);
    expect(error.code).toBe('NT-EXP-002');
    expect(error.publicDetail).toContain('revoked');
    // A revoked link resolves NOTHING: no scope opened, no document read, no
    // URL signed. That is what revocation has to mean.
    expect(calls.systemActorLookups).toEqual([]);
    expect(calls.documentFindUnique).toEqual([]);
    expect(calls.presignGet).toEqual([]);
    expect(calls.linkUpdates).toEqual([]);
  });

  test('an expired link', async () => {
    const { calls, service } = harness({
      row: { link_id: 'dl_1', document_id: 'doc_1', business_id: 'biz_1', practice_id: 'prac_1', revoked: false, expired: true },
    });
    const error = await refusal(() => service.resolve({ code: CODE }));

    expect(error.getStatus()).toBe(HttpStatus.GONE);
    expect(error.code).toBe('NT-EXP-002');
    expect(error.publicDetail).toContain('expired');
    expect(calls.presignGet).toEqual([]);
  });

  test('revoked wins the wording when a link is both', async () => {
    const { service } = harness({
      row: { link_id: 'dl_1', document_id: 'doc_1', business_id: 'biz_1', practice_id: 'prac_1', revoked: true, expired: true },
    });
    expect((await refusal(() => service.resolve({ code: CODE }))).publicDetail).toContain('revoked');
  });
});

describe('429 — the ceiling', () => {
  /** A distinct, well-formed code per attempt — what walking the space looks like. */
  const guess = (index: number): string => `A${String(index).padStart(3, '0')}BCDE`;

  test('over the per-IP ceiling, the route stops answering and says how long for', async () => {
    const limiter = new InMemoryCapabilityLinkRateLimiter(() => NOW);
    const { calls, service } = harness({ limiter });
    for (let i = 0; i < PER_IP_HOURLY; i += 1) await service.resolve({ code: guess(i), ip: '203.0.113.9' });

    const error = await refusal(() => service.resolve({ code: guess(999), ip: '203.0.113.9' }));
    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(error.code).toBe('NT-RATE-001');
    expect(error.publicDetail).toMatch(/Try again in \d+ seconds/);
    // It refused before the lookup — the ceiling is not advisory.
    expect(calls.resolverCalls).toHaveLength(PER_IP_HOURLY);
  });

  test('the per-CODE ceiling refuses one leaked link long before the IP ceiling would', async () => {
    const limiter = new InMemoryCapabilityLinkRateLimiter(() => NOW);
    const { calls, service } = harness({ limiter });
    for (let i = 0; i < PER_CODE_HOURLY; i += 1) await service.resolve({ code: CODE, ip: `203.0.113.${i % 200}` });

    // A different address every time, so the IP ceiling has nothing to say —
    // and the link is still shut off. That is the ceiling that bounds a code
    // sitting in a forwarded email.
    const error = await refusal(() => service.resolve({ code: CODE, ip: '198.51.100.7' }));
    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(calls.resolverCalls).toHaveLength(PER_CODE_HOURLY);
  });

  test('the refusal never says WHICH ceiling bound — that would say how to stay under the other', async () => {
    const limiter = new InMemoryCapabilityLinkRateLimiter(() => NOW);
    const { service } = harness({ limiter });
    for (let i = 0; i < PER_IP_HOURLY; i += 1) await service.resolve({ code: guess(i), ip: '203.0.113.9' });

    const error = await refusal(() => service.resolve({ code: guess(999), ip: '203.0.113.9' }));
    expect(error.publicDetail).not.toContain('ip');
    expect(error.publicDetail).not.toContain('code');
  });
});

describe('the resolver’s own integrity', () => {
  test('a business with no practice is a logged 500, not a 404 that hides it forever', async () => {
    const { service } = harness({
      row: { link_id: 'dl_1', document_id: 'doc_1', business_id: 'biz_1', practice_id: null, revoked: false, expired: false },
    });
    await expect(service.resolve({ code: CODE })).rejects.toThrow(/no SYSTEM actor exists/);
  });

  test('two rows for one code refuses rather than serving an arbitrary client’s document', async () => {
    const { service } = harness({ rowsReturned: 2 });
    await expect(service.resolve({ code: CODE })).rejects.toThrow(/UNIQUE constraint on document_links.code is gone/);
  });

  test('a resolver row that does not parse is a loud failure, not a falsy boolean', async () => {
    // `revoked: null` must NOT read as "not revoked". Rule 4: parse, do not
    // trust — including a SECURITY DEFINER function's own return shape.
    const { service } = harness({
      row: { link_id: 'dl_1', document_id: 'doc_1', business_id: 'biz_1', practice_id: 'prac_1', revoked: null, expired: false },
    });
    await expect(service.resolve({ code: CODE })).rejects.toThrow();
  });
});
