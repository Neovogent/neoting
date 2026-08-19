import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { PrismaChaseAutoClose } from './auto-close.js';

/**
 * Auto-close on inbound match (SoT §4 Stage 8.5), proven end to end against a
 * REAL database as `nt_app`:
 *
 *   an OPEN chase sits on an unmatched Currys transaction → an extracted document
 *   whose supplier + amount + date match it arrives → `PrismaChaseAutoClose`
 *   closes the chase (CLOSED_RECEIVED, stamped with the document), writes the
 *   close to the chase's event log, and writes the accountant's notification. A
 *   non-matching document leaves the chase open. The step runs under the practice
 *   SYSTEM actor through `scopedDb` — the same RLS predicate human writes take.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (red run)
 * when one is configured but unreachable.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P = 'pac_prac';
const BIZ = 'pac_biz';

let owner: PrismaClient;
let app: PrismaClient;

function autoClose(): PrismaChaseAutoClose {
  return new PrismaChaseAutoClose(app);
}

async function deleteSeed(): Promise<void> {
  await owner.notification.deleteMany({ where: { businessId: BIZ } });
  await owner.chaseMessage.deleteMany({ where: { chase: { businessId: BIZ } } });
  await owner.chase.deleteMany({ where: { businessId: BIZ } });
  await owner.document.deleteMany({ where: { practiceId: P } });
  await owner.bankTransaction.deleteMany({ where: { businessId: BIZ } });
  await owner.bankAccount.deleteMany({ where: { businessId: BIZ } });
}

async function cleanup(): Promise<void> {
  await deleteSeed();
  await owner.membership.deleteMany({ where: { id: { startsWith: 'pac_' } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 'pac_' } } });
  await owner.business.deleteMany({ where: { id: BIZ } });
  await owner.practice.deleteMany({ where: { id: P } });
}

/** An unmatched Currys transaction and an OPEN (SENT) chase pointing at it. */
async function seedOpenChaseOnCurrys(): Promise<{ txnId: string; chaseId: string }> {
  const account = await owner.bankAccount.create({ data: { businessId: BIZ, displayName: 'Current' } });
  const txn = await owner.bankTransaction.create({
    data: {
      businessId: BIZ,
      accountId: account.id,
      bookedAt: new Date('2026-08-09T12:00:00.000Z'),
      amountPence: -129_900,
      descriptionRaw: 'CURRYS 1234 LONDON',
      merchantName: 'Currys',
      matchState: 'UNMATCHED',
    },
  });
  const chase = await owner.chase.create({
    data: {
      businessId: BIZ,
      detectionEngine: 'UNMATCHED_TRANSACTION',
      transactionId: txn.id,
      itemRefs: [txn.id],
      state: 'SENT',
      firstSentAt: new Date(),
    },
  });
  return { txnId: txn.id, chaseId: chase.id };
}

/** A persisted, extracted document header — the shape the ingest hook passes in. */
async function seedExtractedDocument(
  id: string,
  header: { supplierName: string; totalPence: number; documentDate: Date },
): Promise<void> {
  await owner.document.create({
    data: {
      id,
      practiceId: P,
      businessId: BIZ,
      s3Key: `w/${BIZ}/documents/${id}`,
      byteHash: `h-${id}`,
      mimeType: 'image/jpeg',
      byteSize: 11,
      channel: 'WHATSAPP',
      originalFilename: 'currys-receipt.jpg',
      inbox: 'COSTS',
      state: 'READY',
      supplierName: header.supplierName,
      totalPence: header.totalPence,
      documentDate: header.documentDate,
    },
  });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.create({ data: { id: P, name: 'PAC' } });
  await owner.user.create({ data: { id: 'pac_sys', kind: 'SYSTEM' } });
  await owner.membership.create({ data: { id: 'pac_mem_sys', userId: 'pac_sys', practiceId: P, role: 'PRACTICE_STANDARD' } });
  await owner.business.create({ data: { id: BIZ, practiceId: P, name: 'American Burger Ltd' } });
});

beforeEach(async () => {
  if (!enabled) return;
  await deleteSeed();
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!enabled)('chase auto-close against a real database', () => {
  test('a matching document closes the chase, writes the event and the notification', async () => {
    const { chaseId } = await seedOpenChaseOnCurrys();
    await seedExtractedDocument('pac_doc_match', {
      supplierName: 'Currys',
      totalPence: 129_900,
      documentDate: new Date('2026-08-09T00:00:00.000Z'),
    });

    const result = await autoClose().run({
      documentId: 'pac_doc_match',
      businessId: BIZ,
      practiceId: P,
      supplierName: 'Currys',
      totalPence: 129_900,
      documentDate: new Date('2026-08-09T00:00:00.000Z'),
      traceId: 'trace-ac',
    });
    expect(result.closedChaseIds).toEqual([chaseId]);

    const chase = await owner.chase.findUnique({ where: { id: chaseId } });
    expect(chase?.state).toBe('CLOSED_RECEIVED');
    expect(chase?.closedByDocumentId).toBe('pac_doc_match');
    expect(chase?.closedReason).toBe('matched-inbound-document');
    expect(chase?.closedAt).not.toBeNull();

    // The chase's event log — a ChaseMessage on the 'event' channel, not an SMS.
    const events = await owner.chaseMessage.findMany({ where: { chaseId, channel: 'event' } });
    expect(events).toHaveLength(1);
    expect(events[0]?.body).toContain('pac_doc_match');
    expect(events[0]?.recipientE164).toBeNull(); // never an outbound send

    // The accountant's in-app notification.
    const notifications = await owner.notification.findMany({ where: { businessId: BIZ, event: 'chase.closed' } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.payload).toMatchObject({ chaseId, documentId: 'pac_doc_match' });
  });

  test('a non-matching document leaves the chase open and writes nothing', async () => {
    const { chaseId } = await seedOpenChaseOnCurrys();
    // Right business, wrong supplier AND wrong amount — must not close the Currys chase.
    await seedExtractedDocument('pac_doc_nomatch', {
      supplierName: 'Google',
      totalPence: 60_000,
      documentDate: new Date('2026-08-05T00:00:00.000Z'),
    });

    const result = await autoClose().run({
      documentId: 'pac_doc_nomatch',
      businessId: BIZ,
      practiceId: P,
      supplierName: 'Google',
      totalPence: 60_000,
      documentDate: new Date('2026-08-05T00:00:00.000Z'),
      traceId: 'trace-ac',
    });
    expect(result.closedChaseIds).toEqual([]);

    const chase = await owner.chase.findUnique({ where: { id: chaseId } });
    expect(chase?.state).toBe('SENT'); // still open
    expect(chase?.closedByDocumentId).toBeNull();
    expect(await owner.chaseMessage.count({ where: { chaseId, channel: 'event' } })).toBe(0);
    expect(await owner.notification.count({ where: { businessId: BIZ, event: 'chase.closed' } })).toBe(0);
  });

  test('re-running the same document is idempotent — closes nothing twice, no duplicate event or notification', async () => {
    const { chaseId } = await seedOpenChaseOnCurrys();
    const input = {
      documentId: 'pac_doc_idem',
      businessId: BIZ,
      practiceId: P,
      supplierName: 'Currys',
      totalPence: 129_900,
      documentDate: new Date('2026-08-09T00:00:00.000Z'),
      traceId: 'trace-ac',
    };
    await seedExtractedDocument('pac_doc_idem', {
      supplierName: 'Currys',
      totalPence: 129_900,
      documentDate: new Date('2026-08-09T00:00:00.000Z'),
    });

    const first = await autoClose().run(input);
    expect(first.closedChaseIds).toEqual([chaseId]);
    const second = await autoClose().run(input); // redelivery / re-extraction
    expect(second.closedChaseIds).toEqual([]);

    // Exactly one event and one notification survive the replay.
    expect(await owner.chaseMessage.count({ where: { chaseId, channel: 'event' } })).toBe(1);
    expect(await owner.notification.count({ where: { businessId: BIZ, event: 'chase.closed' } })).toBe(1);
  });
});
