import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../common/db/scope-context.js';
import { PublishesService } from './publishes.service.js';

/**
 * `GET /v1/publishes` against a REAL database (METH Stage 10).
 *
 * The unit tests assert the `where`/`orderBy`/`take` that reach Prisma; they
 * cannot assert the one thing that actually keeps two practices apart, because
 * the fake Prisma has no policies in it. **The tenancy boundary is
 * `publishes_tenant` in `prisma/sql/rls.sql`** — `app_can_access_business
 * (business_id)`, evaluated by Postgres against the GUCs `scopedDb` sets — and
 * only a real connection as `nt_app` can answer for it. The service adds no
 * practice clause of its own precisely so that this is the single mechanism;
 * that design is only safe if something proves the mechanism works, and this is
 * that something.
 *
 * Rows are SEEDED as the owner (DIRECT_URL, which bypasses RLS) and READ as the
 * application (DATABASE_URL, which does not). Writing them through the app role
 * would prove nothing about reads and would make a policy bug look like a
 * setup failure.
 *
 * Gated so `pnpm test` stays offline (issue #16's rule): skipped visibly with
 * no database, and `beforeAll` throws — a red run, not a green one — when it is
 * configured but unreachable.
 *
 *   docker compose up -d && pnpm db:migrate
 *   pnpm --filter @neoting/api test -- publishes.integration
 *
 * Ids are prefixed `p10_` and torn down at BOTH ends (integration tests share
 * one Postgres, and a crashed run must not poison the next one).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P_A = 'p10_prac_a';
const P_B = 'p10_prac_b';
const BIZ_A = 'p10_biz_a';
const BIZ_B = 'p10_biz_b';

/** Distinct instants, in creation order, so "newest first" is a real ordering rather than a tie. */
const T1 = new Date('2026-08-20T09:00:00.000Z');
const T2 = new Date('2026-08-20T09:05:00.000Z');
const T3 = new Date('2026-08-20T09:10:00.000Z');

let owner: PrismaClient;
let app: PrismaClient;
let service: PublishesService;

const STAFF_A = ScopeContextSchema.parse({ actorId: 'p10_user_a', practiceId: P_A });
const STAFF_B = ScopeContextSchema.parse({ actorId: 'p10_user_b', practiceId: P_B });

/** The parsed-query shape the controller hands the service, with the contract's default limit. */
const query = (over: Record<string, unknown> = {}) => ({ limit: 50, ...over }) as never;

async function cleanup(): Promise<void> {
  // Order matters: publishes reference documents and integrations, which
  // reference businesses. `onDelete: Cascade` would handle most of it, but
  // deleting explicitly makes a leftover row a visible failure rather than a
  // silent cascade.
  await owner.publish.deleteMany({ where: { businessId: { in: [BIZ_A, BIZ_B] } } });
  await owner.integration.deleteMany({ where: { businessId: { in: [BIZ_A, BIZ_B] } } });
  await owner.document.deleteMany({ where: { practiceId: { in: [P_A, P_B] } } });
  await owner.business.deleteMany({ where: { id: { in: [BIZ_A, BIZ_B] } } });
  await owner.membership.deleteMany({ where: { id: { startsWith: 'p10_' } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 'p10_' } } });
  await owner.practice.deleteMany({ where: { id: { in: [P_A, P_B] } } });
}

function document(id: string, practiceId: string, businessId: string) {
  return {
    id,
    practiceId,
    businessId,
    s3Key: `w/${businessId}/documents/${id}`,
    byteHash: `h-${id}`,
    mimeType: 'application/pdf',
    byteSize: 2048,
    channel: 'WEB_UPLOAD' as const,
    originalFilename: 'bill.pdf',
    inbox: 'COSTS' as const,
    state: 'READY' as const,
  };
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`; // configured-but-unreachable → throw, not skip
  service = new PublishesService(app);

  await cleanup();
  await owner.practice.createMany({ data: [{ id: P_A, name: 'P10 A' }, { id: P_B, name: 'P10 B' }] });
  await owner.user.createMany({
    data: [
      { id: 'p10_user_a', email: 'p10a@example.test' },
      { id: 'p10_user_b', email: 'p10b@example.test' },
    ],
  });
  await owner.membership.createMany({
    data: [
      { id: 'p10_mem_a', userId: 'p10_user_a', practiceId: P_A, role: 'PRACTICE_ADMIN' },
      { id: 'p10_mem_b', userId: 'p10_user_b', practiceId: P_B, role: 'PRACTICE_ADMIN' },
    ],
  });
  await owner.business.createMany({
    data: [
      { id: BIZ_A, practiceId: P_A, name: 'P10 Client A' },
      { id: BIZ_B, practiceId: P_B, name: 'P10 Client B' },
    ],
  });
  await owner.document.createMany({
    data: [
      document('p10_doc_a1', P_A, BIZ_A),
      document('p10_doc_a2', P_A, BIZ_A),
      document('p10_doc_a3', P_A, BIZ_A),
      document('p10_doc_b1', P_B, BIZ_B),
    ],
  });
  await owner.integration.create({ data: { id: 'p10_int_a', businessId: BIZ_A, kind: 'XERO', orgRef: 'p10-org', isActive: true } });

  // One batch of three for A — one of each state, which is also the demo's
  // shape (two land, one fails and is retried) — and one row for B, whose only
  // job is to be invisible to A.
  await owner.publish.createMany({
    data: [
      {
        id: 'p10_pub_a1',
        businessId: BIZ_A,
        documentId: 'p10_doc_a1',
        integrationId: 'p10_int_a',
        mode: 'MANUAL',
        state: 'SUCCEEDED',
        externalRef: 'XERO-INV-0001',
        idempotencyKey: 'p10_prop_1:p10_doc_a1',
        attachmentSent: true,
        actionProposalId: 'p10_prop_1',
        createdAt: T1,
        completedAt: T1,
      },
      {
        id: 'p10_pub_a2',
        businessId: BIZ_A,
        documentId: 'p10_doc_a2',
        integrationId: 'p10_int_a',
        mode: 'MANUAL',
        state: 'FAILED',
        idempotencyKey: 'p10_prop_1:p10_doc_a2',
        attachmentSent: false,
        actionProposalId: 'p10_prop_1',
        failureCode: 'NT-PUB-002',
        failureMessage: 'Xero rejected the bill: the supplier contact was locked by another update.',
        createdAt: T2,
        completedAt: T2,
      },
      {
        id: 'p10_pub_a3',
        businessId: BIZ_A,
        documentId: 'p10_doc_a3',
        // Null, and legally so: "the business's single active integration".
        integrationId: null,
        mode: 'AUTO',
        state: 'QUEUED',
        idempotencyKey: 'p10_prop_2:p10_doc_a3',
        attachmentSent: false,
        actionProposalId: 'p10_prop_2',
        createdAt: T3,
      },
      {
        id: 'p10_pub_b1',
        businessId: BIZ_B,
        documentId: 'p10_doc_b1',
        mode: 'MANUAL',
        state: 'SUCCEEDED',
        externalRef: 'XERO-INV-0999',
        idempotencyKey: 'p10_prop_9:p10_doc_b1',
        attachmentSent: true,
        createdAt: T3,
        completedAt: T3,
      },
    ],
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!enabled)('GET /v1/publishes against a real database', () => {
  test("practice A sees its own attempts, newest first, and only its own", async () => {
    const page = await service.listPublishes(STAFF_A, query());

    expect(page.data.map((p) => p.id)).toEqual(['p10_pub_a3', 'p10_pub_a2', 'p10_pub_a1']);
    expect(page.data.every((p) => p.businessId === BIZ_A)).toBe(true);
    expect(page.pageInfo).toEqual({ hasMore: false, nextCursor: null });
  });

  test('ANOTHER PRACTICE SEES NONE OF THEM — RLS is the boundary, not the filters', async () => {
    // The whole point of the file. B's staff run the identical query, with no
    // filter narrowing anything, and A's three rows are simply not in the
    // result set — removed by the policy before Prisma ever sees them.
    const page = await service.listPublishes(STAFF_B, query());

    const ids = page.data.map((p) => p.id);
    expect(ids).not.toContain('p10_pub_a1');
    expect(ids).not.toContain('p10_pub_a2');
    expect(ids).not.toContain('p10_pub_a3');
    expect(ids).toContain('p10_pub_b1');
    expect(page.data.every((p) => p.businessId === BIZ_B)).toBe(true);
  });

  test("filtering by another practice's businessId is an EMPTY PAGE — not 404, not 403", async () => {
    // A 404 or a 403 would confirm that `p10_biz_a` exists. The rows were
    // already invisible, so the filter matches none of them and the honest
    // answer is an empty page.
    const page = await service.listPublishes(STAFF_B, query({ businessId: BIZ_A }));

    expect(page.data).toEqual([]);
    expect(page.pageInfo).toEqual({ hasMore: false, nextCursor: null });
  });

  test('a FAILED row comes back carrying its reason, and no success reference', async () => {
    const page = await service.listPublishes(STAFF_A, query({ state: ['FAILED'] }));

    expect(page.data).toHaveLength(1);
    const [failed] = page.data;
    expect(failed?.id).toBe('p10_pub_a2');
    expect(failed?.failureCode).toBe('NT-PUB-002');
    expect(failed?.failureMessage).toContain('locked by another update');
    expect(failed?.externalRef).toBeNull();
    expect(failed?.attachmentSent).toBe(false);
    // ISO-8601 UTC out of a `timestamptz`, straight from the projection.
    expect(failed?.completedAt).toBe(T2.toISOString());
  });

  test('a repeated state widens; an omitted one means every state', async () => {
    const widened = await service.listPublishes(STAFF_A, query({ state: ['QUEUED', 'FAILED'] }));
    expect(widened.data.map((p) => p.id)).toEqual(['p10_pub_a3', 'p10_pub_a2']);

    const all = await service.listPublishes(STAFF_A, query());
    expect(all.data).toHaveLength(3);
  });

  test('the QUEUED row reports null completion and a null integration, explicitly', async () => {
    const page = await service.listPublishes(STAFF_A, query({ state: ['QUEUED'] }));
    const [queued] = page.data;

    expect(queued?.id).toBe('p10_pub_a3');
    expect(queued?.completedAt).toBeNull();
    expect(queued?.externalRef).toBeNull();
    expect(queued?.integrationId).toBeNull();
    expect(queued?.mode).toBe('AUTO');
  });

  test('paging one row at a time never skips or repeats, and the last page has no cursor', async () => {
    // The keyset acceptance criterion, against real SQL: three pages of one,
    // each seeking past the previous row, with the cursor round-tripping
    // through base64 and back into a `timestamptz` comparison. Comparing the
    // ISO STRING instead of a Date is the classic failure here, and it only
    // shows up on the days text ordering and time ordering disagree.
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let requests = 0; requests < 5; requests += 1) {
      const page: Awaited<ReturnType<PublishesService['listPublishes']>> = await service.listPublishes(
        STAFF_A,
        query(cursor === null ? { limit: 1 } : { limit: 1, cursor }),
      );
      seen.push(...page.data.map((p) => p.id));
      cursor = page.pageInfo.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toEqual(['p10_pub_a3', 'p10_pub_a2', 'p10_pub_a1']);
    expect(new Set(seen).size).toBe(seen.length); // no repeats
    expect(cursor).toBeNull(); // and no cursor dangling off the end
  });

  test('the internal columns are not readable through this surface at all', async () => {
    // `idempotency_key` is on the row in the database — the test asserts it is
    // in the DATABASE and not in the RESPONSE, which is the only assertion that
    // distinguishes "not projected" from "not stored".
    const stored = await owner.publish.findUnique({ where: { id: 'p10_pub_a1' } });
    expect(stored?.idempotencyKey).toBe('p10_prop_1:p10_doc_a1');

    const page = await service.listPublishes(STAFF_A, query({ state: ['SUCCEEDED'] }));
    expect(page.data[0]).not.toHaveProperty('idempotencyKey');
    expect(page.data[0]).not.toHaveProperty('publishedByUserId');
  });
});
