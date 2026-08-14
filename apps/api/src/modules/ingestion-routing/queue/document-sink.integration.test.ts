import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import { documentIdFor, type PersistDocumentInput, PrismaDocumentSink } from './document-sink.js';

/**
 * Persistence proven against a REAL database — the point of #20. Unit tests
 * cannot show any of this: every assertion is about what Postgres does with the
 * RLS policies and the GUCs `scopedDb` sets.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (red run)
 * when one is configured but unreachable — a tenancy suite that quietly passes
 * while proving nothing is worse than none.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];

let owner: PrismaClient;
let app: PrismaClient;

const P_A = 'p20_prac_a';
const P_B = 'p20_prac_b';

async function cleanup(): Promise<void> {
  await owner.document.deleteMany({ where: { practiceId: { in: [P_A, P_B] } } });
  await owner.membership.deleteMany({ where: { id: { startsWith: 'p20_' } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 'p20_' } } });
  await owner.practice.deleteMany({ where: { id: { startsWith: 'p20_' } } });
}

beforeAll(async () => {
  if (DATABASE_URL === undefined || OWNER_URL === undefined) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`; // configured-but-unreachable → throw, not skip

  await cleanup();
  await owner.practice.createMany({ data: [{ id: P_A, name: 'P20 A' }, { id: P_B, name: 'P20 B' }] });
  await owner.user.createMany({
    data: [
      { id: 'p20_user_a', email: 'p20a@example.test' },
      { id: 'p20_user_b', email: 'p20b@example.test' },
      { id: 'p20_sys_a', kind: 'SYSTEM' },
      { id: 'p20_sys_b', kind: 'SYSTEM' },
    ],
  });
  await owner.membership.createMany({
    data: [
      { id: 'p20_mem_a', userId: 'p20_user_a', practiceId: P_A, role: 'PRACTICE_ADMIN' },
      { id: 'p20_mem_b', userId: 'p20_user_b', practiceId: P_B, role: 'PRACTICE_ADMIN' },
      { id: 'p20_mem_sys_a', userId: 'p20_sys_a', practiceId: P_A, role: 'PRACTICE_STANDARD' },
      { id: 'p20_mem_sys_b', userId: 'p20_sys_b', practiceId: P_B, role: 'PRACTICE_STANDARD' },
    ],
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

function input(idempotencyKey: string, over: Partial<PersistDocumentInput> = {}): PersistDocumentInput {
  return {
    idempotencyKey,
    practiceId: P_A,
    businessId: null,
    s3Key: `w/_unrouted/documents/${idempotencyKey}`,
    byteHash: `h-${idempotencyKey}`,
    mimeType: 'image/png',
    byteSize: 11,
    channel: 'EMAIL',
    originalFilename: 'receipt.png',
    submitterLabel: 'sender@acme.co',
    routing: { kind: 'unrouted' },
    traceId: 't-int',
    ...over,
  };
}

describe.skipIf(!DATABASE_URL || !OWNER_URL)('PrismaDocumentSink', () => {
  test('persists an unrouted document anchored on its practice, with an ingest event', async () => {
    const { documentId, created } = await new PrismaDocumentSink(app).persist(input('p20-k1'));
    expect(created).toBe(true);

    const row = await owner.document.findUnique({ where: { id: documentId } });
    expect(row?.practiceId).toBe(P_A);
    expect(row?.businessId).toBeNull();
    expect(row?.inbox).toBe('UNROUTED');
    expect(row?.state).toBe('RECEIVED');
    expect(row?.channel).toBe('EMAIL');

    const events = await owner.documentEvent.findMany({ where: { documentId } });
    expect(events).toHaveLength(1);
    expect(events[0]?.stage).toBe('ingest');
    expect(events[0]?.traceId).toBe('t-int');
  });

  test('an unrouted document is visible to its own practice and invisible to another', async () => {
    const { documentId } = await new PrismaDocumentSink(app).persist(input('p20-k2'));
    const ctxA = ScopeContextSchema.parse({ actorId: 'p20_user_a', practiceId: P_A });
    const ctxB = ScopeContextSchema.parse({ actorId: 'p20_user_b', practiceId: P_B });

    const mine = await scopedDb(app, ctxA, (db) => db.document.findUnique({ where: { id: documentId } }));
    const theirs = await scopedDb(app, ctxB, (db) => db.document.findUnique({ where: { id: documentId } }));

    expect(mine?.id).toBe(documentId);
    expect(theirs).toBeNull();
  });

  test('the same job twice yields exactly one row (idempotent on idempotencyKey)', async () => {
    const sink = new PrismaDocumentSink(app);
    const first = await sink.persist(input('p20-k3'));
    const second = await sink.persist(input('p20-k3'));
    expect(second.documentId).toBe(first.documentId);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await owner.document.count({ where: { id: first.documentId } })).toBe(1);
  });

  test('losing the primary-key race is a no-op even when RLS hides the winning row', async () => {
    // The find-then-create in the sink is NOT atomic, and the in-memory
    // ProcessedStore cannot cover it: SES redelivering produces a SECOND BullMQ
    // job that another worker task can run concurrently. Both find nothing, both
    // create, one loses on the primary key.
    //
    // This writes the winning row under practice B and then persists the same
    // job as practice A. That is deliberately the HARD half of the race: under
    // RLS the sink's `findUnique` cannot see B's row, so the early-return is
    // blind and the `create` is what discovers the collision. Without the P2002
    // catch this throws, the job retries, and a correctly-handled redelivery
    // shows up as a DLQ entry and a page.
    //
    // (The easy half — the winner's row being visible to the same practice — is
    // covered by the idempotency test above, which returns before the create.)
    const key = 'p20-race';
    const documentId = documentIdFor(key);
    await owner.document.create({
      data: {
        id: documentId,
        practiceId: P_B,
        s3Key: `w/_unrouted/documents/${key}`,
        byteHash: `h-${key}`,
        mimeType: 'image/png',
        byteSize: 11,
        channel: 'EMAIL',
        originalFilename: 'receipt.png',
        inbox: 'UNROUTED',
        state: 'RECEIVED',
      },
    });

    const result = await new PrismaDocumentSink(app).persist(input(key));
    expect(result).toEqual({ documentId, created: false });

    expect(await owner.document.count({ where: { id: documentId } })).toBe(1);
    // The loser must add nothing at all — not even an event against a row it
    // did not write.
    expect(await owner.documentEvent.count({ where: { documentId } })).toBe(0);
  });

  test('a job for a practice with no SYSTEM actor fails loudly, writing nothing', async () => {
    await expect(
      new PrismaDocumentSink(app).persist(input('p20-k4', { practiceId: 'p20_prac_missing' })),
    ).rejects.toThrow(/SYSTEM/i);
    expect(await owner.document.findUnique({ where: { id: documentIdFor('p20-k4') } })).toBeNull();
  });
});
