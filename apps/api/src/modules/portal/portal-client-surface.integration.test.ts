import { type Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { RequestContext } from '../../common/context/request-context.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import type { AppException } from '../../common/problem/problem.js';
import { BillingController } from '../billing/billing.controller.js';
import type { BillingService } from '../billing/billing.service.js';
import { DocumentsController } from '../documents/documents.controller.js';
import { DocumentsService } from '../documents/documents.service.js';
import { InMemoryDocumentStore } from '../ingestion-routing/storage/document-store.js';
import { PortalDocumentsService } from './portal-documents.service.js';
import { delegatedScopeFor, PortalSessionContextResolver } from './portal-session-context.js';
import { signPortalSessionToken } from './portal-session-token.js';

/**
 * The CLIENT's own portal surface, against a REAL database as `nt_app` (D49).
 *
 * The three things only Postgres can answer about what a signed-in client may
 * reach — each of them a different KIND of boundary, which is the reason this
 * suite exists rather than being folded into the unit tests:
 *
 * 1. **`GET /portal/documents` shows this client's documents and no other's.**
 *    The boundary here is the QUERY, not SQL: the read runs under the practice
 *    SYSTEM context (there is no RLS branch meaning "this client's whole
 *    business"), so `where: { businessId }` is the only thing narrowing it.
 *    Proven with a SECOND BUSINESS IN THE SAME PRACTICE — a second practice
 *    would have proved nothing, because RLS would have hidden it anyway and the
 *    test would pass with the filter deleted.
 * 2. **`GET /documents/{id}/original` opens exactly what (1) LISTS.** ⚠ This
 *    read said "honours the GRANT, and SQL is what honours it" until 7 Sep 2026,
 *    and that was true and useless: a grant holds only what the CURRENT sign-in
 *    uploaded, so a client could browse their own list and open nothing on it
 *    (review item 18). On Shakib's ruling the boundary is now the same
 *    application guarantee as (1) — `portalVisibleDocuments(facts)`, the one
 *    expression both surfaces filter with — so the pair that matters is a
 *    document of the client's own business against one of the OTHER business in
 *    the SAME practice, plus an ARCHIVED row the list hides.
 * 3. **`POST /billing/portal-sessions` 404s a body naming another business.**
 *    The portal principal landed on that operation with this guard, and the
 *    guard is the ENTIRE tenancy check on that path — `systemScopeFor` sees the
 *    whole practice, so RLS narrows nothing.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (red run)
 * when one is configured but unreachable — a tenancy suite that quietly reports
 * green is worse than none. Ids are disjointly prefixed `pcs_` and torn down at
 * both ends BY EXPLICIT ID LIST, because this Postgres is shared and now holds
 * real data pulled from staging: nothing here may delete by anything broader
 * than its own ids.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const SESSION_SECRET = 'pcs-portal-session-secret';

const PRACTICE = 'pcs_prac';
const BIZ_MINE = 'pcs_biz_mine';
const BIZ_THEIRS = 'pcs_biz_theirs';
const SYS_USER = 'pcs_usr_sys';
const MEMBERSHIP = 'pcs_mem_sys';

const DOC_SENT = 'pcs_doc_sent';
const DOC_REVIEW = 'pcs_doc_review';
const DOC_FILED = 'pcs_doc_filed';
const DOC_BROKEN = 'pcs_doc_broken';
const DOC_ARCHIVED = 'pcs_doc_archived';
const DOC_THEIRS = 'pcs_doc_theirs';
const ALL_DOCS = [DOC_SENT, DOC_REVIEW, DOC_FILED, DOC_BROKEN, DOC_ARCHIVED, DOC_THEIRS];

const CONTACT_MINE = 'pcs_con_mine';

/**
 * A plain MEMBER of the same business, and the session they hold (review item
 * 44). Not `is_primary` and no `portal_role`, so `effectivePortalRole` derives
 * `BUSINESS_STANDARD` — the staff member added to photograph receipts, who
 * until this package could mint a Stripe customer-portal session and reach the
 * card, every invoice and cancellation.
 */
const CONTACT_MEMBER = 'pcs_con_member';
const SESSION_MEMBER = 'pcs_otp_member';

const SESSION_MINE = 'pcs_otp_mine';
const SESSION_THEIRS = 'pcs_otp_theirs';
const ALL_SESSIONS = [SESSION_MINE, SESSION_THEIRS, SESSION_MEMBER];

/**
 * The PERSON holding the session (review item 44, 6 Sep 2026).
 *
 * ⚠ **The fixture used to write no `contact_id`, and no real onboarding session
 * looks like that.** Both own-portal sign-in routes set it — `resolveByAddress`
 * to the contact whose address proved control, `resolveInvite` to the contact
 * the invitation names — and intake writes the contact and the invite in one
 * transaction, so an invited client always has one. The `?? null` on the invite
 * route is defensive against a state this product cannot currently produce.
 *
 * It mattered the day billing gained an authority check: a session that cannot
 * be resolved to a person holds `role: null`, which every branch of `assertCan`
 * refuses — correctly, and the test asserting the customer portal opens then
 * failed for a reason that had nothing to do with what it was written to
 * assert. Its subject is TENANCY (*"for the session's OWN business"*), so the
 * fix is to make the fixture look like reality rather than to soften the guard.
 *
 * `is_primary` makes them the workspace's OWNER by `effectivePortalRole`'s
 * derivation, which is who D48 says pays.
 */


let owner: PrismaClient;
let app: PrismaClient;

/** The bearer a signed-in client actually holds, minted for a row this suite wrote. */
function bearerFor(otpSessionId: string, businessId: string): string {
  return `Bearer ${signPortalSessionToken(
    { otpSessionId, businessId, practiceId: PRACTICE, expiresAtMs: Date.now() + 30 * 60_000 },
    SESSION_SECRET,
  )}`;
}

const resolver = (): PortalSessionContextResolver =>
  new PortalSessionContextResolver(app, { portalSessionSecret: SESSION_SECRET });

/** Facts through the REAL resolver, so these tests exercise the session a request would. */
const factsFor = (otpSessionId: string, businessId: string) =>
  resolver().resolveOnboarding(bearerFor(otpSessionId, businessId));

const grab = async (run: () => Promise<unknown>): Promise<AppException> => {
  try {
    await run();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a throw');
};

/**
 * Teardown by EXPLICIT ID LIST, never by prefix scan or by a bare `deleteMany`.
 * This database holds production data pulled from staging.
 */
async function cleanup(): Promise<void> {
  await owner.otpSession.deleteMany({ where: { id: { in: ALL_SESSIONS } } });
  await owner.contact.deleteMany({ where: { id: { in: [CONTACT_MINE, CONTACT_MEMBER] } } });
  await owner.documentEvent.deleteMany({ where: { documentId: { in: ALL_DOCS } } });
  await owner.document.deleteMany({ where: { id: { in: ALL_DOCS } } });
  await owner.membership.deleteMany({ where: { id: { in: [MEMBERSHIP] } } });
  await owner.user.deleteMany({ where: { id: { in: [SYS_USER] } } });
  await owner.business.deleteMany({ where: { id: { in: [BIZ_MINE, BIZ_THEIRS] } } });
  await owner.practice.deleteMany({ where: { id: { in: [PRACTICE] } } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.create({ data: { id: PRACTICE, name: 'PCS Practice' } });
  // ⚠ TWO businesses in ONE practice. The practice SYSTEM context can see both,
  // so this is the pair that makes assertion (1) mean anything.
  await owner.business.createMany({
    data: [
      { id: BIZ_MINE, practiceId: PRACTICE, name: 'American Burger' },
      { id: BIZ_THEIRS, practiceId: PRACTICE, name: 'The Other Client' },
    ],
  });
  // The person the session belongs to — `is_primary`, so `effectivePortalRole`
  // derives BUSINESS_ADMIN and they are the workspace's owner. See CONTACT_MINE.
  await owner.contact.createMany({
    data: [
      {
        id: CONTACT_MINE,
        businessId: BIZ_MINE,
        firstName: 'Owner',
        email: 'pcs-owner@example.test',
        isPrimary: true,
      },
      // The member. Same business, not primary, no portal_role.
      {
        id: CONTACT_MEMBER,
        businessId: BIZ_MINE,
        firstName: 'Staff',
        email: 'pcs-staff@example.test',
        isPrimary: false,
      },
    ],
  });
  await owner.user.create({ data: { id: SYS_USER, email: 'pcs-system@example.test', kind: 'SYSTEM' } });
  await owner.membership.create({
    data: { id: MEMBERSHIP, userId: SYS_USER, practiceId: PRACTICE, role: 'PRACTICE_STANDARD' },
  });

  const doc = (
    id: string,
    businessId: string,
    over: Partial<Prisma.DocumentCreateManyInput> = {},
  ): Prisma.DocumentCreateManyInput => ({
    id,
    businessId,
    practiceId: PRACTICE,
    s3Key: `w/${businessId}/documents/${id}`,
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
      // The client's own file, across the states the five client words cover.
      doc(DOC_SENT, BIZ_MINE, {
        state: 'PROCESSING',
        receivedAt: new Date('2026-08-20T09:00:00.000Z'),
      }),
      doc(DOC_REVIEW, BIZ_MINE, {
        state: 'TO_REVIEW',
        supplierName: 'Currys',
        documentDate: new Date('2026-08-09T00:00:00.000Z'),
        currency: 'GBP',
        totalPence: 129_900,
        // Practice-only working state, on the row and never in the projection.
        categoryCode: '7500',
        receivedAt: new Date('2026-08-19T09:00:00.000Z'),
      }),
      doc(DOC_FILED, BIZ_MINE, { state: 'PUBLISHED', receivedAt: new Date('2026-08-18T09:00:00.000Z') }),
      doc(DOC_BROKEN, BIZ_MINE, {
        state: 'FAILED',
        failureCode: 'NT-DOC-ENCRYPTED',
        failureMessage: 'Password-protected PDF',
        receivedAt: new Date('2026-08-17T09:00:00.000Z'),
      }),
      doc(DOC_ARCHIVED, BIZ_MINE, {
        state: 'ARCHIVED',
        archivedAt: new Date('2026-08-21T09:00:00.000Z'),
        receivedAt: new Date('2026-08-16T09:00:00.000Z'),
      }),
      // The OTHER client in the SAME practice. Never visible through the portal.
      doc(DOC_THEIRS, BIZ_THEIRS, { state: 'TO_REVIEW', supplierName: 'Not Yours', receivedAt: new Date('2026-08-25T09:00:00.000Z') }),
    ],
  });

  // The client's own portal session (D47): ONBOARDING scope, no chase, and a
  // grant holding exactly the one document it "sent" — which is what
  // `createPortalUpload` does through `grantItems`.
  const live = { verifiedAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60_000) };
  await owner.otpSession.createMany({
    data: [
      {
        id: SESSION_MINE,
        businessId: BIZ_MINE,
        practiceId: PRACTICE,
        // WHO is holding it. See CONTACT_MINE.
        contactId: CONTACT_MINE,
        scope: 'ONBOARDING',
        grantedItemIds: [DOC_SENT],
        linkTokenHash: 'pcs-link-hash-mine',
        ...live,
      },
      // The member's own live session on the SAME business as SESSION_MINE, so
      // the only thing separating them is who is holding it.
      {
        id: SESSION_MEMBER,
        businessId: BIZ_MINE,
        practiceId: PRACTICE,
        contactId: CONTACT_MEMBER,
        scope: 'ONBOARDING',
        grantedItemIds: [],
        linkTokenHash: 'pcs-link-hash-member',
        ...live,
      },
      {
        id: SESSION_THEIRS,
        businessId: BIZ_THEIRS,
        practiceId: PRACTICE,
        scope: 'ONBOARDING',
        grantedItemIds: [],
        linkTokenHash: 'pcs-link-hash-theirs',
        ...live,
      },
    ],
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!enabled)("the client's own portal surface against real RLS", () => {
  test('⚠ a portal bearer sees ONLY its own business\'s documents — proven against a second business in the SAME practice', async () => {
    const facts = await factsFor(SESSION_MINE, BIZ_MINE);
    const page = await new PortalDocumentsService(app).listDocuments(facts, { limit: 50 } as never);

    // The other client is in the same practice, so the SYSTEM context this read
    // runs under can see their row. The `where` clause is the only thing that
    // does not. Delete it and this is the assertion that goes red.
    expect(page.data.map((d) => d.id)).not.toContain(DOC_THEIRS);
    expect(page.data.map((d) => d.supplierName)).not.toContain('Not Yours');

    // Newest first, ARCHIVED absent.
    expect(page.data.map((d) => d.id)).toEqual([DOC_SENT, DOC_REVIEW, DOC_FILED, DOC_BROKEN]);
  });

  test("the OTHER client's session sees the other client's document, and none of this one's", async () => {
    // The mirror image, which is what proves the filter is derived from the
    // session rather than hard-coded or accidentally constant.
    const facts = await factsFor(SESSION_THEIRS, BIZ_THEIRS);
    const page = await new PortalDocumentsService(app).listDocuments(facts, { limit: 50 } as never);
    expect(page.data.map((d) => d.id)).toEqual([DOC_THEIRS]);
  });

  test('the status is the CLIENT\'s vocabulary, and the practice\'s working state never leaves', async () => {
    const facts = await factsFor(SESSION_MINE, BIZ_MINE);
    const page = await new PortalDocumentsService(app).listDocuments(facts, { limit: 50 } as never);

    expect(page.data.map((d) => [d.id, d.status])).toEqual([
      [DOC_SENT, 'processing'],
      [DOC_REVIEW, 'with_accountant'],
      [DOC_FILED, 'filed'],
      // A password-protected PDF is "send it again" to the person who sent it.
      [DOC_BROKEN, 'needs_another_copy'],
    ]);

    // The failure CODE and the coding are on the rows above and reach nobody.
    const serialised = JSON.stringify(page.data);
    expect(serialised).not.toContain('NT-DOC-ENCRYPTED');
    expect(serialised).not.toContain('Password-protected');
    expect(serialised).not.toContain('7500');
    expect(serialised).not.toContain('TO_REVIEW');

    // Money is the integer pence the extraction recorded, with its currency.
    const reviewed = page.data.find((d) => d.id === DOC_REVIEW);
    expect(reviewed?.totalPence).toBe(129_900);
    expect(reviewed?.currency).toBe('GBP');
    expect(reviewed?.documentDate).toBe('2026-08-09');
  });

  test('⚠ getDocumentOriginal opens what the client\u2019s own LIST shows, and nothing outside it (review item 18)', async () => {
    // A store that would sign ANYTHING it is asked to. That is deliberate: a 404
    // alone does not prove a refusal is safe, because a refactor that presigned
    // before the lookup would still throw 404 and would still have minted a
    // working URL to bytes the client may not have. Object storage has no RLS to
    // undo that, so the assertion has to be that nothing was signed.
    const signed: string[] = [];
    const store = {
      presignGet: async (input: { key: string }) => {
        signed.push(input.key);
        return { url: `https://fixture.local/${input.key}?sig=x`, expiresAt: new Date(Date.now() + 300_000) };
      },
    } as unknown as InMemoryDocumentStore;

    // Driven through the CONTROLLER, because the controller is what decides
    // which principal is asking and what bounds it. Calling the service with a
    // hand-built context would be testing the arguments this suite passed in.
    const cookie = { require: async () => { throw new Error('the cookie path must not be taken here'); } } as unknown as RequestContext;
    const controller = new DocumentsController(cookie, new DocumentsService(app, store), resolver());
    const mine = bearerFor(SESSION_MINE, BIZ_MINE);

    // The receipt this session sent — in its grant, and openable before and
    // after the widening.
    const sent = await controller.original(DOC_SENT, mine);
    expect(sent.url).toContain(DOC_SENT);
    expect(sent.mimeType).toBe('image/jpeg');

    // ⚠ The change (review item 18, Shakib's ruling of 7 Sep 2026): a document
    // in the client's own business that this session did NOT upload. It was a
    // 404 — the grant holds only what the current sign-in sent, so a client
    // could browse a list and open nothing on it — and it opens now.
    const notMine = await controller.original(DOC_REVIEW, mine);
    expect(notMine.url).toContain(DOC_REVIEW);

    // What still refuses, and it is the whole tenancy of this path now that RLS
    // is not narrowing it: another business's document, in the SAME practice —
    // the only pair that isolates the `businessId` predicate from RLS, which
    // would have hidden a second practice anyway. 404, never a 403 that would
    // confirm it exists.
    const foreign = await grab(() => controller.original(DOC_THEIRS, mine));
    expect(foreign.getStatus()).toBe(404);
    expect(foreign.code).toBe('NT-VAL-001');

    // And the claim the ruling actually rests on: **the set a client can open is
    // the set the client's own list shows.** An ARCHIVED document is absent from
    // `GET /portal/documents`, so it must be unopenable too — otherwise the two
    // surfaces disagree about what the client has, and the more permissive one
    // wins on the day it matters.
    const archived = await grab(() => controller.original(DOC_ARCHIVED, mine));
    expect(archived.getStatus()).toBe(404);

    // Nothing was signed for any refusal. Exactly the two keys that opened.
    expect(signed).toEqual([
      `w/${BIZ_MINE}/documents/${DOC_SENT}`,
      `w/${BIZ_MINE}/documents/${DOC_REVIEW}`,
    ]);
  });

  test('a session that has never uploaded still has an empty grant — it is simply no longer what bounds a read', async () => {
    // Kept, and re-pointed. The empty grant used to be the whole reason an
    // onboarding session could open nothing: `ScopeContextSchema` refuses a
    // `delegated_upload` context with no granted items, so no context could be
    // built at all. `getDocumentOriginal` no longer builds one — but the UPLOAD
    // path still does, so this fact and its refusal both have to keep holding.
    const facts = await factsFor(SESSION_THEIRS, BIZ_THEIRS);
    expect(facts.grantedItemIds).toEqual([]);
    expect(delegatedScopeFor(facts)).toEqual({ ok: false, reason: 'no-granted-items' });
  });

  test('⚠ the billing customer portal 404s a body naming ANOTHER business, and nothing reaches Stripe', async () => {
    const reached: ScopeContext[] = [];
    const service = {
      createPortalSession: async (ctx: ScopeContext) => {
        reached.push(ctx);
        return { url: 'https://billing.stripe.com/p/session/x', expiresAt: null };
      },
    } as unknown as BillingService;
    const cookie = { require: async () => { throw new Error('the cookie path must not be taken here'); } } as unknown as RequestContext;
    const controller = new BillingController(cookie, service, resolver());

    const key = '3f1a9d2e-6c4b-4a8e-9f1d-2b7c5e8a0d43';
    const error = await grab(() =>
      controller.portal(
        // This client's own bearer, naming the OTHER business in the same practice.
        { businessId: BIZ_THEIRS, returnUrl: 'https://app.example/back' },
        key,
        bearerFor(SESSION_MINE, BIZ_MINE),
      ),
    );

    // 404 and never 403: a 403 would confirm `BIZ_THEIRS` exists, and a client
    // holding a forwarded setup link does not get to enumerate a practice.
    expect(error.getStatus()).toBe(404);
    expect(error.code).toBe('NT-VAL-001');
    expect(reached).toEqual([]);
  });

  test('the billing customer portal DOES open for the session\'s own business', async () => {
    const reached: ScopeContext[] = [];
    const service = {
      createPortalSession: async (ctx: ScopeContext) => {
        reached.push(ctx);
        return { url: 'https://billing.stripe.com/p/session/x', expiresAt: null };
      },
    } as unknown as BillingService;
    const cookie = { require: async () => { throw new Error('the cookie path must not be taken here'); } } as unknown as RequestContext;
    const controller = new BillingController(cookie, service, resolver());

    const key = '9c2e4b71-8d35-4f60-b1a7-5e0c3d9f2a18';
    const result = await controller.portal(
      { businessId: BIZ_MINE, returnUrl: 'https://app.example/back' },
      key,
      bearerFor(SESSION_MINE, BIZ_MINE),
    );

    expect(result.url).toContain('billing.stripe.com');
    // The practice SYSTEM context, which is why the 404 above is the whole of
    // the check: this scope can see every business in `PRACTICE`.
    expect(reached).toEqual([
      { actorId: SYS_USER, practiceId: PRACTICE, sessionScope: 'user', grantedItemIds: [] },
    ]);
  });

  /**
   * **⚠ Review item 44, against the real row.**
   *
   * `billing.controller.test.ts` pins the same refusal with the actor STUBBED,
   * which is the right unit for "does the controller ask". This is the half a
   * stub cannot cover: that `resolveActor` reads the authority out of
   * `contacts` — through `systemScopeFor`, bounded by the session's own
   * business — and gets it right for a person nobody wrote a role for.
   *
   * `CONTACT_MEMBER` carries no `portal_role` at all, so the answer comes from
   * `effectivePortalRole`'s derivation (`is_primary` false → `BUSINESS_STANDARD`).
   * That derivation is what makes this work for every business that existed
   * before the column did, and it is the case a hand-set role would have
   * quietly skipped.
   */
  test('⚠ the customer portal REFUSES a plain member of the same business, and nothing reaches Stripe', async () => {
    const reached: ScopeContext[] = [];
    const service = {
      createPortalSession: async (ctx: ScopeContext) => {
        reached.push(ctx);
        return { url: 'https://billing.stripe.com/p/session/x', expiresAt: null };
      },
    } as unknown as BillingService;
    const cookie = { require: async () => { throw new Error('the cookie path must not be taken here'); } } as unknown as RequestContext;
    const controller = new BillingController(cookie, service, resolver());

    const key = '3f1b7c92-6a48-4d05-9e3f-2c8b7a41d6e0';
    let code: string | undefined;
    let status: number | undefined;
    try {
      await controller.portal(
        { businessId: BIZ_MINE, returnUrl: 'https://app.example/back' },
        key,
        // The SAME business as the passing test above. The only difference is
        // who the session belongs to.
        bearerFor(SESSION_MEMBER, BIZ_MINE),
      );
    } catch (error) {
      const problem = error as { code?: string; getStatus?: () => number };
      code = problem.code;
      status = problem.getStatus?.();
    }

    expect(code).toBe('NT-PRM-001');
    expect(status).toBe(403);
    // The assertion that matters: nothing reached the service, so nothing
    // reached Stripe and no session was minted.
    expect(reached).toEqual([]);
  });
});
