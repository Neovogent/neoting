import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { AlsRequestContext, runWithRequestContext, type HeaderReader } from '../../common/context/request-context.js';
import { SessionContextResolver } from '../../common/context/session-context-resolver.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import type { Env } from '../../config/env.js';
import { AuthService } from './auth.service.js';
import { InMemorySignInThrottle } from './sign-in-throttle.js';
import { BusinessesService } from './businesses.service.js';
import { SESSION_COOKIE_NAME, signSessionToken, verifySessionCookieHeader } from './session-cookie.js';
import { loadScopeForUser } from './session-scope.js';

/**
 * The Stage 1 acceptance, minus HTTP (no supertest in the devDependencies — a
 * dependency needs a human, and the curl acceptance covers the wire): a signed
 * cookie resolves through the REAL `SessionContextResolver` deps into a
 * `ScopeContext`, and that context reads exactly its own practice's documents
 * under RLS. Same doctrine as `scoped-db.integration.test.ts`: skipped when no
 * database is configured, red when one is configured and unreachable.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const SECRET = 'integration-session-secret';

let owner: PrismaClient;
let app: PrismaClient;

// `s1a_` prefix — distinct from `t9_` (scoped-db) and `t_` (tenancy-check).
const P_MINE = 's1a_prac_mine';
const P_OTHER = 's1a_prac_other';
const U_MINE = 's1a_user_mine';
const U_BIZ = 's1a_user_biz';
const U_GONE = 's1a_user_gone';

describe.skipIf(DATABASE_URL === undefined || OWNER_URL === undefined)('session auth against the real database', () => {
  beforeAll(async () => {
    if (DATABASE_URL === undefined || OWNER_URL === undefined) return; // skipIf already skips; this narrows the types
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    await owner.$queryRaw`SELECT 1`; // configured-but-unreachable must go RED, not quietly green

    await cleanup();
    await owner.practice.createMany({
      data: [
        { id: P_MINE, name: 'S1A Mine LLP' },
        { id: P_OTHER, name: 'S1A Other LLP' },
      ],
    });
    await owner.business.createMany({
      data: [
        { id: 's1a_biz_1', practiceId: P_MINE, name: 'S1A Burger Ltd' },
        { id: 's1a_biz_2', practiceId: P_MINE, name: 'S1A Cosmo Ltd' },
        { id: 's1a_biz_other', practiceId: P_OTHER, name: 'S1A Stranger Ltd' },
      ],
    });
    await owner.user.createMany({
      data: [
        { id: U_MINE, email: 's1a-mine@example.test', firstName: 'Mina' },
        { id: U_BIZ, email: 's1a-biz@example.test' },
        { id: U_GONE, email: 's1a-gone@example.test', deactivatedAt: new Date() },
      ],
    });
    await owner.membership.createMany({
      data: [
        { id: 's1a_mem_mine', userId: U_MINE, practiceId: P_MINE, role: 'PRACTICE_ADMIN' },
        { id: 's1a_mem_biz', userId: U_BIZ, businessId: 's1a_biz_1', role: 'BUSINESS_ADMIN' },
        { id: 's1a_mem_gone', userId: U_GONE, practiceId: P_MINE, role: 'PRACTICE_STANDARD' },
      ],
    });
    await owner.document.createMany({
      data: [
        doc('s1a_doc_mine', { businessId: 's1a_biz_1', practiceId: P_MINE }),
        doc('s1a_doc_other', { businessId: 's1a_biz_other', practiceId: P_OTHER }),
        // The GET /businesses counts cast (METH Stage 6): two waiting, one
        // ready, REJECTED and FAILED folding into one `failed`, and an
        // unrouted document that must be counted NOWHERE (contract wording).
        // `s1a_cnt_` rather than `s1a_doc_`, so the acceptance test's
        // startsWith('s1a_doc_') visibility assertion keeps its exact set.
        doc('s1a_cnt_1', { businessId: 's1a_biz_1', practiceId: P_MINE, state: 'TO_REVIEW' }),
        doc('s1a_cnt_2', { businessId: 's1a_biz_1', practiceId: P_MINE, state: 'TO_REVIEW' }),
        doc('s1a_cnt_3', { businessId: 's1a_biz_1', practiceId: P_MINE, state: 'READY' }),
        doc('s1a_cnt_4', { businessId: 's1a_biz_1', practiceId: P_MINE, state: 'REJECTED', failureCode: 'NT-ING-001', failureMessage: 'refused' }),
        doc('s1a_cnt_5', { businessId: 's1a_biz_1', practiceId: P_MINE, state: 'FAILED', failureCode: 'NT-EXT-001', failureMessage: 'unreadable' }),
        doc('s1a_cnt_6', { practiceId: P_MINE, state: 'TO_REVIEW' }),
      ],
    });
  });

  afterAll(async () => {
    if (owner !== undefined) await cleanup();
    await owner?.$disconnect();
    await app?.$disconnect();
  });

  /** The production wiring, minus Nest: real verifier, real membership loader, real database. */
  function sessionContext(): AlsRequestContext {
    return new AlsRequestContext(
      new SessionContextResolver({
        verifyCookieHeader: (cookieHeader) => verifySessionCookieHeader(cookieHeader, SECRET),
        loadScopeForUser: (userId) => loadScopeForUser(app, userId),
      }),
    );
  }

  function cookieFor(userId: string): HeaderReader {
    const token = signSessionToken({ userId, expiresAtMs: Date.now() + 60_000 }, SECRET);
    const map: Record<string, string> = { cookie: `${SESSION_COOKIE_NAME}=${token}` };
    return (name) => map[name.toLowerCase()];
  }

  test('the acceptance path: signed cookie → ScopeContext → documents scoped to MY practice only', async () => {
    const requestContext = sessionContext();
    const ctx = await runWithRequestContext(cookieFor(U_MINE), () => requestContext.require());
    expect(ctx).toMatchObject({ actorId: U_MINE, practiceId: P_MINE });

    const docs = await scopedDb(app, ctx, (db) => db.document.findMany({ where: { id: { startsWith: 's1a_doc_' } } }));
    expect(docs.map((d) => d.id)).toEqual(['s1a_doc_mine']); // the other practice's row is invisible, not filtered
  });

  test('a business-only login resolves to a business context', async () => {
    const scope = await loadScopeForUser(app, U_BIZ);
    expect(scope).toMatchObject({ actorId: U_BIZ, businessId: 's1a_biz_1' });
    expect(scope?.practiceId).toBeUndefined();
  });

  test('a deactivated user has no scope — the cookie may be valid, the session is not', async () => {
    expect(await loadScopeForUser(app, U_GONE)).toBeNull();
  });

  test('GET /me shape: practice cast + RLS-visible businesses, from the practice context', async () => {
    const scope = await loadScopeForUser(app, U_MINE);
    expect(scope).not.toBeNull();
    const me = await new AuthService(app, { SESSION_SECRET: SECRET, OTP_MODE: 'demo' } as Env, new InMemorySignInThrottle()).me(scope!);
    expect(me.user.id).toBe(U_MINE);
    expect(me.practice).toEqual({ id: P_MINE, name: 'S1A Mine LLP' });
    expect(me.role).toBe('PRACTICE_ADMIN');
    expect(me.businesses.map((b) => b.id).sort()).toEqual(['s1a_biz_1', 's1a_biz_2']); // never s1a_biz_other
  });

  test('GET /businesses shape: alphabetical, RLS-scoped, counts folded per the contract', async () => {
    const scope = await loadScopeForUser(app, U_MINE);
    expect(scope).not.toBeNull();

    const page = await new BusinessesService(app).listBusinesses(scope!, { limit: 10 });
    // Alphabetical ("S1A Burger" before "S1A Cosmo"), and the other
    // practice's business is invisible, not filtered.
    expect(page.data.map((b) => b.id)).toEqual(['s1a_biz_1', 's1a_biz_2']);
    // REJECTED and FAILED together are `failed`; the RECEIVED-state document
    // and the unrouted TO_REVIEW one (s1a_cnt_6, no business) count nowhere.
    expect(page.data[0]!.counts).toEqual({ toReview: 2, ready: 1, failed: 2 });
    expect(page.data[1]!.counts).toEqual({ toReview: 0, ready: 0, failed: 0 });
    expect(page.pageInfo).toEqual({ nextCursor: null, hasMore: false });
  });

  test('GET /businesses paginates on the alphabetical cursor', async () => {
    const scope = await loadScopeForUser(app, U_MINE);
    const service = new BusinessesService(app);

    const first = await service.listBusinesses(scope!, { limit: 1 });
    expect(first.data.map((b) => b.id)).toEqual(['s1a_biz_1']);
    expect(first.pageInfo.hasMore).toBe(true);

    const second = await service.listBusinesses(scope!, { limit: 1, cursor: first.pageInfo.nextCursor! });
    expect(second.data.map((b) => b.id)).toEqual(['s1a_biz_2']);
    expect(second.pageInfo.hasMore).toBe(false);
  });
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

async function cleanup(): Promise<void> {
  await owner.document.deleteMany({ where: { id: { startsWith: 's1a_' } } });
  await owner.membership.deleteMany({ where: { id: { startsWith: 's1a_' } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 's1a_' } } });
  await owner.business.deleteMany({ where: { id: { startsWith: 's1a_' } } });
  await owner.practice.deleteMany({ where: { id: { startsWith: 's1a_' } } });
}
