import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema, systemContext } from './scope-context.js';
import { scopedDb } from './scoped-db.js';

/**
 * The tenancy guarantee, exercised through the real client against a real
 * database. Unit tests cannot prove any of this: every assertion here is about
 * what POSTGRES does with the GUCs we set, and a mock would simply agree with
 * whatever we told it.
 *
 * Skipped — visibly, as `skipped` in the reporter — when no database is
 * CONFIGURED, so `pnpm test` still passes on a machine without Docker. But if
 * one is configured and unreachable, `beforeAll` throws and the run goes red.
 * A tenancy suite that quietly reports green while proving nothing is worse
 * than no suite at all, because it is trusted.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];

let owner: PrismaClient;
let app: PrismaClient;

// `t9_` prefix, distinct from the `t_` rows tenancy-check.sql owns, so the two
// suites can run in any order without deleting each other's fixtures.
const P_A = 't9_prac_a';
const P_B = 't9_prac_b';

beforeAll(async () => {
  if (DATABASE_URL === undefined || OWNER_URL === undefined) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  // Deliberately NOT caught. There are exactly two honest outcomes: no database
  // is configured, in which case `skipIf` above reports the suite as skipped and
  // you can see that it did not run — or one is configured and these assertions
  // execute. "Configured but unreachable, so every test returns early and the
  // run is green" is the third outcome, and it is the one that lets a tenancy
  // regression reach staging behind a passing build.
  await owner.$queryRaw`SELECT 1`;

  await cleanup();

  // Seeded as the owner, which bypasses RLS — the harness may cross tenants,
  // the application may not. That asymmetry is the thing under test.
  await owner.practice.createMany({
    data: [
      { id: P_A, name: 'Scoped Practice A' },
      { id: P_B, name: 'Scoped Practice B' },
    ],
  });
  await owner.business.createMany({
    data: [
      { id: 't9_biz_a', practiceId: P_A, name: 'A Ltd' },
      { id: 't9_biz_b', practiceId: P_B, name: 'B Ltd' },
    ],
  });
  await owner.user.createMany({
    data: [
      { id: 't9_user_a', email: 't9a@example.test' },
      { id: 't9_user_b', email: 't9b@example.test' },
      { id: 't9_sys_a', kind: 'SYSTEM' },
    ],
  });
  await owner.membership.createMany({
    data: [
      { id: 't9_mem_a', userId: 't9_user_a', practiceId: P_A, role: 'PRACTICE_ADMIN' },
      { id: 't9_mem_b', userId: 't9_user_b', practiceId: P_B, role: 'PRACTICE_ADMIN' },
      { id: 't9_mem_sys', userId: 't9_sys_a', practiceId: P_A, role: 'PRACTICE_ADMIN' },
    ],
  });
  await owner.document.createMany({
    data: [
      doc('t9_doc_a', { businessId: 't9_biz_a', practiceId: P_A }),
      doc('t9_doc_b', { businessId: 't9_biz_b', practiceId: P_B }),
      // The common case: arrived by email, sender unrecognised, no business.
      doc('t9_doc_unrouted', { practiceId: P_A, inbox: 'UNROUTED' }),
    ],
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

function doc(id: string, over: Record<string, unknown>) {
  return {
    id,
    s3Key: `k-${id}`,
    originalFilename: `${id}.pdf`,
    mimeType: 'application/pdf',
    byteSize: 10,
    byteHash: `h-${id}`,
    channel: 'EMAIL' as const,
    ...over,
  };
}

async function cleanup() {
  await owner.document.deleteMany({ where: { id: { startsWith: 't9_' } } });
  await owner.membership.deleteMany({ where: { id: { startsWith: 't9_' } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 't9_' } } });
  await owner.business.deleteMany({ where: { id: { startsWith: 't9_' } } });
  await owner.practice.deleteMany({ where: { id: { startsWith: 't9_' } } });
}

const ctxA = ScopeContextSchema.parse({ actorId: 't9_user_a', practiceId: P_A });
const ctxB = ScopeContextSchema.parse({ actorId: 't9_user_b', practiceId: P_B });

describe.skipIf(!DATABASE_URL || !OWNER_URL)('scopedDb', () => {
  test('the application role is not a superuser and cannot bypass RLS', async () => {
    const [role] = await app.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean; me: string }[]>`
      SELECT rolsuper, rolbypassrls, current_user AS me FROM pg_roles WHERE rolname = current_user`;
    // If this fails, every other assertion in this file passes for the wrong
    // reason — a superuser sees everything and the policies are never consulted.
    expect(role?.rolsuper, 'DATABASE_URL connects as a superuser; RLS is inert').toBe(false);
    expect(role?.rolbypassrls).toBe(false);
  });

  test('a practice sees its own documents and not another practice', async () => {
    const seen = await scopedDb(app, ctxA, (db) => db.document.findMany({ where: { id: { startsWith: 't9_' } } }));
    const ids = seen.map((d) => d.id).sort();
    expect(ids).toEqual(['t9_doc_a', 't9_doc_unrouted']);
    expect(ids).not.toContain('t9_doc_b');
  });

  test('asking for another practice by id returns nothing rather than erroring', async () => {
    // The important half of RLS: a cross-tenant read is not a 403, it is an
    // absence. Code that expects a thrown error to signal "denied" will treat
    // this as "deleted" and can happily carry on.
    const stolen = await scopedDb(app, ctxB, (db) => db.document.findUnique({ where: { id: 't9_doc_a' } }));
    expect(stolen).toBeNull();
  });

  test('an unrouted document is visible to its practice and invisible to the other', async () => {
    const mine = await scopedDb(app, ctxA, (db) => db.document.findUnique({ where: { id: 't9_doc_unrouted' } }));
    const theirs = await scopedDb(app, ctxB, (db) => db.document.findUnique({ where: { id: 't9_doc_unrouted' } }));
    expect(mine?.businessId).toBeNull();
    expect(theirs).toBeNull();
  });

  test('a write into another practice is refused by the policy, not merely by convention', async () => {
    await expect(
      scopedDb(app, ctxB, (db) => db.document.create({ data: doc('t9_doc_evil', { businessId: 't9_biz_a', practiceId: P_A }) })),
    ).rejects.toThrow();

    const leaked = await owner.document.findUnique({ where: { id: 't9_doc_evil' } });
    expect(leaked, 'the row must not exist even to the owner connection').toBeNull();
  });

  test('context does not survive the transaction', async () => {
    await scopedDb(app, ctxA, async (db) => db.document.count());
    // Same pooled client, no scope: SET LOCAL died with the previous
    // transaction, so nothing is readable. If this returns rows, context is
    // leaking between requests and every user is seeing the last one's data.
    const after = await app.document.count({ where: { id: { startsWith: 't9_' } } });
    expect(after).toBe(0);
  });

  test('a SYSTEM actor writes an unrouted document through the same policy path', async () => {
    const created = await scopedDb(app, systemContext(P_A, 't9_sys_a'), (db) =>
      db.document.create({ data: doc('t9_doc_sys', { practiceId: P_A, inbox: 'UNROUTED' }) }),
    );
    expect(created.id).toBe('t9_doc_sys');
    expect(created.businessId).toBeNull();

    const seenByHuman = await scopedDb(app, ctxA, (db) => db.document.findUnique({ where: { id: 't9_doc_sys' } }));
    expect(seenByHuman, 'practice staff must be able to route what the worker ingested').not.toBeNull();

    await owner.document.delete({ where: { id: 't9_doc_sys' } });
  });

  test('a comma in a granted item id is rejected rather than silently splitting the grant', () => {
    expect(() =>
      ScopeContextSchema.parse({
        actorId: 't9_user_a',
        businessId: 't9_biz_a',
        sessionScope: 'delegated_upload',
        grantedItemIds: ['doc_1,doc_2'],
      }),
    ).toThrow(/comma/);
  });

  test('a context with neither practice nor business is refused', () => {
    expect(() => ScopeContextSchema.parse({ actorId: 't9_user_a' })).toThrow();
  });
});
