import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema, systemContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { InMemoryDocumentStore } from '../ingestion-routing/storage/document-store.js';
import { DocumentsService } from '../documents/documents.service.js';
import { IllegalDocumentTransition, StaleDocumentState, transitionDocument } from './document-state.js';

/**
 * The #80 acceptance, proven against a REAL database: a failed ingest is
 * visible via `GET /documents?state=FAILED` WITH its reason — driven through
 * the same `DocumentsService` the controller calls, under the same RLS the
 * request would run under. A unit test cannot show any of this; the fake
 * Prisma answers for everything the policies decide.
 *
 * Skipped visibly when no database is configured; `beforeAll` throws (red run)
 * when one is configured but unreachable.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P_A = 'p80_prac_a';
let owner: PrismaClient;
let app: PrismaClient;

const SYS = systemContext(P_A, 'p80_sys_a');
const STAFF = ScopeContextSchema.parse({ actorId: 'p80_user_a', practiceId: P_A });

async function cleanup(): Promise<void> {
  await owner.document.deleteMany({ where: { practiceId: P_A } });
  await owner.membership.deleteMany({ where: { id: { startsWith: 'p80_' } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 'p80_' } } });
  await owner.practice.deleteMany({ where: { id: P_A } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.create({ data: { id: P_A, name: 'P80 A' } });
  await owner.user.createMany({
    data: [
      { id: 'p80_user_a', email: 'p80a@example.test' },
      { id: 'p80_sys_a', kind: 'SYSTEM' },
    ],
  });
  await owner.membership.createMany({
    data: [
      { id: 'p80_mem_a', userId: 'p80_user_a', practiceId: P_A, role: 'PRACTICE_ADMIN' },
      { id: 'p80_mem_sys', userId: 'p80_sys_a', practiceId: P_A, role: 'PRACTICE_STANDARD' },
    ],
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

async function seedDocument(id: string): Promise<void> {
  await scopedDb(app, SYS, async (db) => {
    await db.document.create({
      data: {
        id,
        practiceId: P_A,
        businessId: null,
        s3Key: `w/_unrouted/${P_A}/documents/${id}`,
        byteHash: `h-${id}`,
        mimeType: 'application/pdf',
        byteSize: 10,
        channel: 'EMAIL',
        originalFilename: 'receipt.pdf',
        inbox: 'UNROUTED',
        state: 'RECEIVED',
      },
    });
  });
}

describe.skipIf(!enabled)('document state machine against a real database', () => {
  test('a failed ingest is visible on the Rejected/Failed surface, with its reason and a retry hint', async () => {
    await seedDocument('p80_doc_failed');

    // The pipeline's path: RECEIVED → PROCESSING → FAILED, driven through the
    // ONE transition function, inside scopedDb like every worker write.
    await scopedDb(app, SYS, async (db) => {
      await transitionDocument(db, { id: 'p80_doc_failed', state: 'RECEIVED' }, { to: 'PROCESSING', traceId: 't-80' });
      await transitionDocument(
        db,
        { id: 'p80_doc_failed', state: 'PROCESSING' },
        { to: 'FAILED', failure: { code: 'NT-ING-004', message: 'The file was rejected by sanitisation.' }, traceId: 't-80' },
      );
    });

    // Read back through the very service GET /v1/documents calls, as practice
    // staff, under RLS. This is the 337-vote surface: reason + retry, visible.
    const service = new DocumentsService(app, new InMemoryDocumentStore());
    const page = await service.listDocuments(
      STAFF,
      { sort: 'receivedAt', order: 'desc', limit: 50, state: ['FAILED'] } as never,
    );

    const row = page.data.find((d) => d.id === 'p80_doc_failed');
    expect(row).toBeDefined();
    expect(row?.failureCode).toBe('NT-ING-004');
    expect(row?.failureMessage).toBe('The file was rejected by sanitisation.');
    expect(row?.retryable).toBe(true);

    // And the processing log has no gap: both transitions are events with the
    // trace id, in order.
    const events = await scopedDb(app, STAFF, (db) =>
      db.documentEvent.findMany({ where: { documentId: 'p80_doc_failed', stage: 'state' }, orderBy: { createdAt: 'asc' } }),
    );
    expect(events.map((e) => e.outcome)).toEqual(['PROCESSING', 'FAILED']);
    expect(events.every((e) => e.traceId === 't-80')).toBe(true);
  });

  test('an illegal move is refused by the machine and never reaches the row', async () => {
    await seedDocument('p80_doc_illegal');
    await expect(
      scopedDb(app, SYS, (db) =>
        transitionDocument(db, { id: 'p80_doc_illegal', state: 'RECEIVED' }, { to: 'PUBLISHED', traceId: 't' }),
      ),
    ).rejects.toThrow(IllegalDocumentTransition);
    const row = await scopedDb(app, STAFF, (db) => db.document.findUnique({ where: { id: 'p80_doc_illegal' } }));
    expect(row?.state).toBe('RECEIVED');
  });

  test('a stale caller loses loudly — the guarded write refuses to clobber a concurrent transition', async () => {
    await seedDocument('p80_doc_stale');
    await scopedDb(app, SYS, (db) =>
      transitionDocument(db, { id: 'p80_doc_stale', state: 'RECEIVED' }, { to: 'PROCESSING', traceId: 't' }),
    );
    // A second caller still holding the RECEIVED snapshot.
    await expect(
      scopedDb(app, SYS, (db) =>
        transitionDocument(db, { id: 'p80_doc_stale', state: 'RECEIVED' }, { to: 'PROCESSING', traceId: 't' }),
      ),
    ).rejects.toThrow(StaleDocumentState);
  });
});
