import { type Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { PortalContextService } from './portal-context.service.js';
import { PortalDocumentsService } from './portal-documents.service.js';
import { PortalSessionContextResolver } from './portal-session-context.js';
import { signPortalSessionToken } from './portal-session-token.js';

/**
 * **A document the practice deleted must be gone from the CLIENT's portal — the
 * list and the count together** (soft delete, 2 Sep 2026; `documents.deleted_at`
 * and `common/documents/deleted-documents.ts`).
 *
 * ## Why this is its own suite, against a real database
 *
 * This is the only leak in the soft-delete sweep where the person reading the
 * screen is **not** the person who deleted the row. An accountant looking at a
 * stale count has a Trash tab to go and check; a client has nothing — they see a
 * receipt their firm has withdrawn, and they act on it. So the assertion has to
 * be made where the tenancy of this surface actually lives.
 *
 * And that is the second reason: `GET /portal/documents` and
 * `PortalSummary.documentsSent` both run under the practice **SYSTEM** context
 * (there is no RLS branch meaning "this client's whole business"), so **no
 * database guarantee excludes Trash here**. `notDeleted()` in the `where` is the
 * entire mechanism, exactly as `businessId` is the entire tenancy. A unit test
 * over a Prisma double would assert the shape of a predicate; this asserts that
 * Postgres, asked as the portal asks it, does not return the row.
 *
 * ## The pairing is the point
 *
 * The list and the summary are asserted in the same fixture, on the same rows,
 * because the failure this guards is not either one alone — it is the two
 * **disagreeing**. A portal that says "2 sent" over a list of 1 tells a client
 * that something they sent has gone missing, which is a worse lie than either
 * number is on its own, and is precisely what shipping the list filter without
 * the count filter would have produced.
 *
 * `lastDocumentAt` is in the same assertion for the same reason, and the fixture
 * is built to catch it: the DELETED document is the **most recently created**
 * one, so a `findFirst` that still sees Trash dates the client's last upload to
 * a document that is not in their list.
 *
 * ## ⚠ Ids and teardown
 *
 * Prefix **`ptr_`** — disjoint from `p9_`, `p9u_`, `pcs_` and `ppl_`, the four
 * other portal suites, and from every other suite's namespace. Teardown is BY
 * EXPLICIT ID LIST at both ends, never a prefix scan and never a broad
 * `deleteMany`: this local Postgres holds real client data, so a delete wider
 * than this file's own rows is not a slow test, it is data loss.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (a red run)
 * when one is configured but unreachable — a suite about what a client may see
 * that quietly reports green is worse than no suite.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const SESSION_SECRET = 'ptr-portal-session-secret';

const PRACTICE = 'ptr_prac';
const BIZ = 'ptr_biz';
const SYS_USER = 'ptr_usr_sys';
const MEMBERSHIP = 'ptr_mem_sys';

/** Still in the client's file. */
const DOC_LIVE = 'ptr_doc_live';
/** Deleted by the PRACTICE. The client never asked for this and cannot see the Trash tab. */
const DOC_DELETED = 'ptr_doc_deleted';
const ALL_DOCS = [DOC_LIVE, DOC_DELETED];

const SESSION = 'ptr_otp_session';

/** The deleted document is the NEWER of the two, so `lastDocumentAt` is a real question. */
const CREATED_LIVE = new Date('2026-08-18T09:00:00.000Z');
const CREATED_DELETED = new Date('2026-08-24T09:00:00.000Z');

let owner: PrismaClient;
let app: PrismaClient;

/** The bearer a signed-in client actually holds, minted for a row this suite wrote. */
const bearer = (): string =>
  `Bearer ${signPortalSessionToken(
    { otpSessionId: SESSION, businessId: BIZ, practiceId: PRACTICE, expiresAtMs: Date.now() + 30 * 60_000 },
    SESSION_SECRET,
  )}`;

/** Facts through the REAL resolver, so these tests exercise the session a request would. */
const facts = () =>
  new PortalSessionContextResolver(app, { portalSessionSecret: SESSION_SECRET }).resolveOnboarding(bearer());

/**
 * Teardown by EXPLICIT ID LIST, never by prefix scan or by a bare `deleteMany`.
 * This database holds real client data.
 */
async function cleanup(): Promise<void> {
  await owner.otpSession.deleteMany({ where: { id: { in: [SESSION] } } });
  await owner.documentEvent.deleteMany({ where: { documentId: { in: ALL_DOCS } } });
  await owner.document.deleteMany({ where: { id: { in: ALL_DOCS } } });
  await owner.membership.deleteMany({ where: { id: { in: [MEMBERSHIP] } } });
  await owner.user.deleteMany({ where: { id: { in: [SYS_USER] } } });
  await owner.business.deleteMany({ where: { id: { in: [BIZ] } } });
  await owner.practice.deleteMany({ where: { id: { in: [PRACTICE] } } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.create({ data: { id: PRACTICE, name: 'PTR Practice' } });
  await owner.business.create({
    data: {
      id: BIZ,
      practiceId: PRACTICE,
      name: 'American Burger',
      // `getBusinessContext` reads these three for `PortalSummary.subscription`.
      subscriptionStatus: 'ACTIVE',
      plan: 'standard',
    },
  });
  await owner.user.create({ data: { id: SYS_USER, email: 'ptr-system@example.test', kind: 'SYSTEM' } });
  await owner.membership.create({
    data: { id: MEMBERSHIP, userId: SYS_USER, practiceId: PRACTICE, role: 'PRACTICE_STANDARD' },
  });

  const doc = (
    id: string,
    over: Partial<Prisma.DocumentCreateManyInput> = {},
  ): Prisma.DocumentCreateManyInput => ({
    id,
    businessId: BIZ,
    practiceId: PRACTICE,
    s3Key: `w/${BIZ}/documents/${id}`,
    originalFilename: `${id}.jpg`,
    mimeType: 'image/jpeg',
    byteSize: 2048,
    byteHash: id.padEnd(64, '0'),
    channel: 'SMS_PORTAL' as const,
    inbox: 'COSTS' as const,
    ...over,
  });

  await owner.document.createMany({
    data: [
      doc(DOC_LIVE, {
        state: 'TO_REVIEW',
        supplierName: 'Bidfood',
        receivedAt: new Date('2026-08-18T09:00:00.000Z'),
        createdAt: CREATED_LIVE,
      }),
      // ⚠ TO_REVIEW, not ARCHIVED, and deliberately so: `whereFor` already
      // excluded ARCHIVED, so an archived row would pass this suite with
      // `notDeleted()` deleted. The state has to be one the portal DOES serve,
      // leaving `deleted_at` as the only thing that can exclude it.
      doc(DOC_DELETED, {
        state: 'TO_REVIEW',
        supplierName: 'Deleted By The Practice',
        receivedAt: new Date('2026-08-24T09:00:00.000Z'),
        createdAt: CREATED_DELETED,
        deletedAt: new Date('2026-08-25T11:00:00.000Z'),
      }),
    ],
  });

  await owner.otpSession.create({
    data: {
      id: SESSION,
      businessId: BIZ,
      practiceId: PRACTICE,
      // The client's own workspace session (D47) — the only scope
      // `GET /portal/documents` accepts.
      scope: 'ONBOARDING',
      grantedItemIds: [],
      linkTokenHash: 'ptr-link-hash',
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!enabled)('a document the practice deleted is gone from the client portal', () => {
  test('⚠ GET /portal/documents does not serve a deleted document', async () => {
    const page = await new PortalDocumentsService(app).listDocuments(await facts(), { limit: 50 } as never);

    expect(page.data.map((d) => d.id)).toEqual([DOC_LIVE]);
    // The supplier name is the one an untrusted string would have carried onto
    // the client's screen, so it is asserted absent by value as well as by id.
    expect(page.data.map((d) => d.supplierName)).not.toContain('Deleted By The Practice');
  });

  test('⚠ PortalSummary.documentsSent counts the same set the list shows — 1, not 2', async () => {
    const context = await new PortalContextService(app).getContext(await facts());

    // The number and the list are two statements about one set. "2 sent" over a
    // list of 1 tells this client something they sent has gone missing.
    expect(context.summary?.documentsSent).toBe(1);
  });

  test('lastDocumentAt is the newest LIVE document, not the newer deleted one', async () => {
    const context = await new PortalContextService(app).getContext(await facts());

    expect(context.summary?.lastDocumentAt).toBe(CREATED_LIVE.toISOString());
    expect(context.summary?.lastDocumentAt).not.toBe(CREATED_DELETED.toISOString());
  });

  test('the row is still there — this is a FILTER, and restore has something to restore', async () => {
    // The whole design of soft delete is that the record survives
    // (`POST /v1/documents/{id}/restoration`). A test that only proved absence
    // from the portal would pass just as well against a hard delete, which is a
    // different and unrecoverable product.
    const row = await owner.document.findUnique({
      where: { id: DOC_DELETED },
      select: { state: true, deletedAt: true },
    });

    expect(row?.deletedAt).not.toBeNull();
    // `state` is untouched by deletion, which is what makes a restore able to
    // put the document back where it was.
    expect(row?.state).toBe('TO_REVIEW');
  });
});
