import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { systemContext } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import { PrismaDuplicateDetector } from './duplicate-detector.js';

/**
 * Duplicate detection proven against a REAL database (issue #40). Two things only
 * Postgres can settle live:
 *   1. that a worker under a practice-only `systemContext` can actually WRITE a
 *      `Duplicate` for a business in its practice — the go/no-go Shakib asked me
 *      to verify before building. A successful write here is that proof: the
 *      `duplicates` WITH CHECK is `app_can_access_business(business_id)`, and the
 *      worker sets no `app.business_id`, so the row is admitted only by the
 *      practice-membership branch of that predicate.
 *   2. that detection is scoped to the business and finds exact / near matches.
 *
 * Skips visibly when no DB is configured; `beforeAll` throws when one is
 * configured but unreachable — never a quiet green.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];

let owner: PrismaClient;
let app: PrismaClient;

const P = 'p40_prac';
const B1 = 'p40_biz_1';
const B2 = 'p40_biz_2';

async function cleanup(): Promise<void> {
  await owner.duplicate.deleteMany({ where: { businessId: { in: [B1, B2] } } });
  await owner.document.deleteMany({ where: { practiceId: P } });
  await owner.membership.deleteMany({ where: { id: { startsWith: 'p40_' } } });
  await owner.business.deleteMany({ where: { id: { in: [B1, B2] } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 'p40_' } } });
  await owner.practice.deleteMany({ where: { id: P } });
}

/** Seed a routed document directly (as owner, bypassing RLS) — the fixtures the detector reads. */
async function seedDoc(id: string, businessId: string, byteHash: string, perceptualHash: string | null): Promise<string> {
  await owner.document.create({
    data: {
      id,
      practiceId: P,
      businessId,
      s3Key: `w/${id}`,
      originalFilename: 'receipt.png',
      mimeType: 'image/png',
      byteSize: 10,
      byteHash,
      perceptualHash,
      channel: 'EMAIL',
      inbox: 'COSTS',
      state: 'RECEIVED',
    },
  });
  return id;
}

beforeAll(async () => {
  if (DATABASE_URL === undefined || OWNER_URL === undefined) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.create({ data: { id: P, name: 'P40' } });
  await owner.user.create({ data: { id: 'p40_sys', kind: 'SYSTEM' } });
  await owner.business.createMany({
    data: [
      { id: B1, practiceId: P, name: 'Biz One' },
      { id: B2, practiceId: P, name: 'Biz Two' },
    ],
  });
  // The SYSTEM actor's membership is PRACTICE-level (no business) — exactly the
  // shape the worker runs as, and the row the practice branch of the predicate reads.
  await owner.membership.create({
    data: { id: 'p40_mem_sys', userId: 'p40_sys', practiceId: P, role: 'PRACTICE_STANDARD' },
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!DATABASE_URL || !OWNER_URL)('PrismaDuplicateDetector', () => {
  test('an exact re-send is flagged on the byte-hash net — and the worker could write it', async () => {
    const a1 = await seedDoc('p40_d_a1', B1, 'hash-exact', null);
    const a2 = await seedDoc('p40_d_a2', B1, 'hash-exact', null);

    const { findings } = await new PrismaDuplicateDetector(app).detect({
      documentId: a2,
      practiceId: P,
      businessId: B1,
      byteHash: 'hash-exact',
      perceptualHash: null,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.otherDocumentId).toBe(a1);
    expect(findings[0]?.signals).toEqual(['byteHash']);
    expect(findings[0]?.score).toBe(1);

    // The row exists, anchored on the business, verdict PENDING — written under a
    // practice-only context, which is the tenancy go/no-go.
    const rows = await owner.duplicate.findMany({ where: { businessId: B1 } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.documentAId).toBe(a1); // ordered pair (a1 < a2)
    expect(rows[0]?.documentBId).toBe(a2);
    expect(rows[0]?.signals).toEqual(['byteHash']);
    expect(rows[0]?.verdict).toBe('PENDING');

    // …and it is readable back through RLS under the same worker context.
    const seen = await scopedDb(app, systemContext(P, 'p40_sys'), (db) =>
      db.duplicate.findMany({ where: { businessId: B1 } }),
    );
    expect(seen).toHaveLength(1);
  });

  test('the same receipt photographed twice is flagged on the perceptual net', async () => {
    await seedDoc('p40_d_img1', B1, 'hash-img1', '0f0f0f0f0f0f0f0f');
    const img2 = await seedDoc('p40_d_img2', B1, 'hash-img2', '0f0f0f0f0f0f0f0e'); // 1 bit off

    const { findings } = await new PrismaDuplicateDetector(app).detect({
      documentId: img2,
      practiceId: P,
      businessId: B1,
      byteHash: 'hash-img2',
      perceptualHash: '0f0f0f0f0f0f0f0e',
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.otherDocumentId).toBe('p40_d_img1');
    expect(findings[0]?.signals).toEqual(['pHash']);
    expect(findings[0]?.score).toBeGreaterThan(0.9);
    expect(findings[0]?.score).toBeLessThan(1);
  });

  test('two genuinely different documents are NOT flagged (a false positive costs more than a miss)', async () => {
    await seedDoc('p40_d_far', B1, 'hash-far', 'ffffffffffffffff');
    const lonely = await seedDoc('p40_d_lonely', B1, 'hash-unique', '0000000000000000'); // far from every seeded hash

    const { findings } = await new PrismaDuplicateDetector(app).detect({
      documentId: lonely,
      practiceId: P,
      businessId: B1,
      byteHash: 'hash-unique',
      perceptualHash: '0000000000000000',
    });

    expect(findings).toHaveLength(0);
    const asA = await owner.duplicate.findMany({ where: { OR: [{ documentAId: lonely }, { documentBId: lonely }] } });
    expect(asA).toHaveLength(0);
  });

  test('detecting the same pair twice yields exactly one row (ordered pair + unique index)', async () => {
    const before = await owner.duplicate.count({ where: { businessId: B1 } });
    await new PrismaDuplicateDetector(app).detect({
      documentId: 'p40_d_a2',
      practiceId: P,
      businessId: B1,
      byteHash: 'hash-exact',
      perceptualHash: null,
    });
    const after = await owner.duplicate.count({ where: { businessId: B1 } });
    expect(after).toBe(before); // no new row — the (a1,a2) pair already exists
  });

  test('detection does not reach across businesses in the same practice', async () => {
    // Same byteHash as a1/a2, but in B2. The B1 detection must not see it.
    await seedDoc('p40_d_other', B2, 'hash-exact', null);

    const { findings } = await new PrismaDuplicateDetector(app).detect({
      documentId: 'p40_d_a2',
      practiceId: P,
      businessId: B1,
      byteHash: 'hash-exact',
      perceptualHash: null,
    });

    expect(findings.map((f) => f.otherDocumentId)).not.toContain('p40_d_other');
    expect(findings.every((f) => f.otherDocumentId.startsWith('p40_d_a'))).toBe(true);
  });
});
