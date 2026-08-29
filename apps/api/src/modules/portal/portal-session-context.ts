import { HttpStatus } from '@nestjs/common';

import type { PrismaClient } from '../../common/db/prisma.js';
import { resolveSystemActor } from '../../common/db/resolve-system-actor.js';
import { type ScopeContext, ScopeContextSchema, systemContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { AppException } from '../../common/problem/problem.js';
import { verifyPortalSessionHeader } from './portal-session-token.js';

/**
 * The resolver the two authenticated portal operations use (METH Stage 9).
 *
 * **Portal endpoints do NOT use the workspace `RequestContext`.** That resolver
 * is chosen once at boot from `AUTH_MODE` and reads the `nt_session` cookie
 * into a practice-staff `ScopeContext`; a portal caller has no cookie, no
 * membership and no workspace. It reads its own `Authorization: Bearer` header
 * instead, and produces something different in kind: the FACTS of an
 * `otp_sessions` row, from which two different scope contexts are built for two
 * different jobs (see below).
 *
 * ## What the delegated RLS actually covers — read this before widening anything
 *
 * `prisma/sql/rls.sql` has exactly TWO delegated branches, and both key on
 * DOCUMENT ids:
 *
 * ```
 * documents_delegated_upload   USING (scope='delegated_upload' AND id = ANY(granted) AND business_id IS NOT NULL)
 *                              WITH CHECK (scope='delegated_upload' AND business_id = app_business_id())
 * extractions_delegated_upload USING/WITH CHECK (scope='delegated_upload' AND document_id = ANY(granted))
 * ```
 *
 * `chases`, `bank_transactions` and `otp_sessions` have NO delegated branch —
 * their policies go through `app_can_access_business()`, which begins
 * `app_session_scope() = 'user'`. **A delegated context reading any of them
 * gets an empty set**, silently. So `GET /portal/context` cannot read the chase
 * under a delegated context, and this resolver cannot read the session row
 * under one either.
 *
 * The honest division, and the one this module states everywhere rather than
 * overclaiming:
 *
 * - **The delegated policies enforce the DOCUMENT boundary.** A portal session
 *   can read and write exactly the document ids in its grant, in its own
 *   business, and nothing else. That is a database guarantee.
 * - **The `otp_sessions` row enforces the CHASE boundary.** Chase and
 *   transaction reads run under the practice SYSTEM context (the worker
 *   pattern) and are CONSTRAINED IN THE QUERY to `facts.chaseId`. That is an
 *   application guarantee resting on a row the server wrote, not on SQL.
 *
 * Both contexts are handed out here so a caller never has to invent one.
 */

/** The `otp_sessions` row as the portal endpoints need it. Facts, not a context — the contexts are derived below. */
export interface PortalSessionFacts {
  readonly otpSessionId: string;
  /** The tenant. Taken from the ROW, not from the token, so the row is what governs. */
  readonly businessId: string;
  readonly practiceId: string;
  /** The practice's SYSTEM actor — the actor chase/transaction reads run as. */
  readonly systemUserId: string;
  /** The actor a delegated write is attributed to. See `resolveDelegatedActor` in the service for why it is what it is. */
  readonly actorId: string;
  /** The chase this session exists to answer. **Null on an ONBOARDING session**, which has no chase — nobody has asked an invited client for anything yet. */
  readonly chaseId: string | null;
  /** The document ids this session may touch. Empty until its first upload — see `delegatedScopeFor`. */
  readonly grantedItemIds: readonly string[];
  readonly expiresAt: Date;
}

/**
 * A delegated context, or the reason there cannot be one.
 *
 * `ScopeContextSchema` REFUSES a `delegated_upload` context with an empty
 * grant ("an empty grant reads as 'no restriction' to a reviewer but denies
 * everything in SQL"), and a session has an empty grant until its first upload
 * is intended. That is an ordinary state, not an error, so it surfaces as a
 * typed result the caller handles — never as a Zod throw from the bottom of a
 * query, which is where it would otherwise appear.
 */
export type DelegatedScopeResult =
  | { readonly ok: true; readonly context: ScopeContext }
  | { readonly ok: false; readonly reason: 'no-granted-items' };

/**
 * The delegated `ScopeContext` — the one the RLS delegated policies were
 * written for. `alsoGrant` lets the upload path include the document id it has
 * just derived and appended to the row, in the same breath, rather than
 * re-reading the session.
 *
 * No `practiceId`: the delegated policies read `app_business_id()` and the
 * granted ids and nothing else, and a practice in scope here would only widen
 * what a later `user`-scope mistake could see.
 */
export function delegatedScopeFor(facts: PortalSessionFacts, alsoGrant: readonly string[] = []): DelegatedScopeResult {
  const grantedItemIds = [...new Set([...facts.grantedItemIds, ...alsoGrant])];
  if (grantedItemIds.length === 0) return { ok: false, reason: 'no-granted-items' };
  return {
    ok: true,
    // Parse, don't construct — the schema's rules are the contract `scopedDb` relies on.
    context: ScopeContextSchema.parse({
      actorId: facts.actorId,
      businessId: facts.businessId,
      sessionScope: 'delegated_upload',
      grantedItemIds,
    }),
  };
}

/**
 * The practice SYSTEM context — the ONLY way to read the chase and its
 * transactions, because those tables have no delegated policy (see the header).
 * Every query made under it must be constrained to `facts.chaseId`: this
 * context can see the whole practice, and the session row is the only thing
 * narrowing it to one chase.
 */
export function systemScopeFor(facts: PortalSessionFacts): ScopeContext {
  return systemContext(facts.practiceId, facts.systemUserId);
}

/**
 * The one distinguishable failure, and the one sentence for it.
 *
 * It said *"Open the link from your text message again"* until 28 Aug 2026.
 * There is no SMS in Initial Delivery — S2 made email the transport and A13
 * sends chases through it (D40/D47) — so that sentence pointed a client at a
 * message that was never sent. `apps/web` swept the same claim at launch M8;
 * this is the server-side copy that pass could not see.
 */
const SESSION_EXPIRED_DETAIL = 'This portal session has expired. Open the link in your email again.';

/** The contract's 401 for `getPortalContext` / `createPortalUpload` — session missing, invalid or expired. */
export function portalSessionRequired(detail: string): AppException {
  return new AppException('NT-OTP-002', HttpStatus.UNAUTHORIZED, 'Portal session required', detail);
}

export interface PortalSessionContextConfig {
  readonly portalSessionSecret: string;
}

export class PortalSessionContextResolver {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: PortalSessionContextConfig,
  ) {}

  /**
   * `Authorization` header → the session's facts, or 401 `NT-OTP-002`.
   *
   * The bearer is verified first (offline, cheap) and the ROW is then re-read
   * and re-checked. Both matter: the signature says the token is ours, the row
   * says the session is still live. A row that has been expired, unverified or
   * repointed since the token was minted loses to the row.
   *
   * ⚠ **There is deliberately no bare `resolve`.** There was, it accepted only
   * `DELEGATED_UPLOAD`, and all three portal doors called it — so a client
   * signed in to their own portal was told `NT-OTP-002` by the very endpoints
   * written for them. It is not restored under that name because `resolve` is
   * the one a reader reaches for by default, and the default must not be the
   * variant that silently excludes half the sessions this module issues. Every
   * caller names the operation it is resolving FOR.
   */
  /**
   * The CONTEXT read, which BOTH kinds of session are entitled to make.
   *
   * ⚠ **This is a deliberate widening and it needs its argument, because the
   * note on `resolveOnboarding` says a scope PARAMETER would be unsafe.** That
   * note is about the WRITE paths, and it stands: answering an upload with the
   * wrong kind of row is how one grant becomes the other.
   *
   * A read is different, and `GET /portal/context` is the one operation both
   * sessions genuinely have. A chase session reads the items it was opened to
   * collect; a client signed in to their own portal reads their own summary.
   * `PortalContextService` already branches on `facts.chaseId` — null on an
   * onboarding row — and **every query on both branches is constrained to
   * `facts.businessId`**, which is the row's own business. Neither can see the
   * other's answer, and neither can widen past its tenant.
   *
   * It was `resolve` (DELEGATED_UPLOAD only), so an onboarding session got
   * `401 NT-OTP-002` from the very endpoint written for it: the business-context
   * branch was unreachable code, and the portal signed a client in and then told
   * them their session was invalid.
   */
  resolveForContext(
    authorizationHeader: string | undefined,
    nowMs: number = Date.now(),
  ): Promise<PortalSessionFacts> {
    return this.factsFor(authorizationHeader, ['DELEGATED_UPLOAD', 'ONBOARDING'], nowMs);
  }

  /**
   * Sending a document, which both kinds of session are also entitled to do.
   *
   * A DELEGATED_UPLOAD session answers a chase. An ONBOARDING session is the
   * client's own portal, and **sending paperwork is the entire point of it** —
   * a portal that can only look at what is wanted is a notice board.
   *
   * What makes it safe is not the scope, it is the tenancy: `createPortalUpload`
   * needs nothing from the session but `facts.businessId`, files the document
   * against that business and no other, and takes no chase. The holder proved
   * control of an address registered as a contact of exactly one business
   * (D45), which is the same identity gate the whole intake lane rests on.
   *
   * The completion that follows is the same story — see `delegated-completion.ts`.
   */
  resolveForUpload(
    authorizationHeader: string | undefined,
    nowMs: number = Date.now(),
  ): Promise<PortalSessionFacts> {
    return this.factsFor(authorizationHeader, ['DELEGATED_UPLOAD', 'ONBOARDING'], nowMs);
  }

  /**
   * The same bearer, the same checks, and a DIFFERENT scope — the invited
   * client's onboarding session (contract-change issue #205).
   *
   * ⚠ **A separate method rather than a parameter on `resolve`, and that is the
   * safety.** The scope check below is not a formality: an `ONBOARDING` row has
   * no chase and an empty grant, so handing it to `resolve` would give a
   * session document-write powers it was never granted. Callers name which kind
   * of session they mean, and a caller that wants the other one gets a 401
   * rather than a widened credential.
   *
   * What an onboarding session can do with these facts is exactly one thing:
   * name its own business. `delegatedScopeFor` refuses it (`grantedItemIds` is
   * empty and stays empty — nothing calls `grantItems` on this scope), and
   * `systemScopeFor` sees the whole practice, so **every query made under it
   * must be constrained to `facts.businessId` in the query**. That is the same
   * application guarantee the chase boundary rests on, and it is stated here
   * because it is the only thing narrowing it.
   */
  resolveOnboarding(
    authorizationHeader: string | undefined,
    nowMs: number = Date.now(),
  ): Promise<PortalSessionFacts> {
    return this.factsFor(authorizationHeader, ['ONBOARDING'], nowMs);
  }

  private async factsFor(
    authorizationHeader: string | undefined,
    /**
     * The kinds of session this caller will accept, named at the call site.
     *
     * A LIST rather than a single value, because two operations — the context
     * read and the upload — are legitimately open to both. It is still the
     * caller naming what it means: nothing here defaults to "any scope", and a
     * caller that wants one kind passes one.
     */
    expectedScopes: readonly ('DELEGATED_UPLOAD' | 'ONBOARDING')[],
    nowMs: number,
  ): Promise<PortalSessionFacts> {
    const verdict = verifyPortalSessionHeader(authorizationHeader, this.config.portalSessionSecret, nowMs);
    if (!verdict.ok) {
      // Expiry is the one distinguishable case: the bearer was genuinely ours,
      // and "tap the link again" is safe and useful to say. Missing, malformed
      // and forged share one detail string — the NT-AUTH-001 stance.
      throw verdict.reason === 'expired'
        ? portalSessionRequired(SESSION_EXPIRED_DETAIL)
        : portalSessionRequired('missing or invalid portal session');
    }
    const claims = verdict.claims;

    // ⚠ The practice comes from the SIGNED TOKEN, and it has to: `otp_sessions`
    // is a tenant table, so reading the row needs a scope context, and the
    // context is what the row would have told us. The bootstrap is broken by
    // bytes we signed ourselves (see `portal-session-token.ts`). This lookup is
    // the same privileged-but-safe shape as `session-scope.ts`'s membership
    // read: `users`/`memberships` carry no RLS.
    const systemUserId = await resolveSystemActor(this.prisma, claims.practiceId);

    const row = await scopedDb(this.prisma, systemContext(claims.practiceId, systemUserId), (db) =>
      db.otpSession.findUnique({
        where: { id: claims.otpSessionId },
        select: {
          id: true,
          businessId: true,
          userId: true,
          scope: true,
          chaseId: true,
          grantedItemIds: true,
          verifiedAt: true,
          expiresAt: true,
        },
      }),
    );

    // One detail string for every one of these. A holder of a stale or
    // hand-made bearer learns "not a session", never which check said so.
    if (row === null) throw portalSessionRequired('missing or invalid portal session');
    // Defence in depth: the token names a business, the row names a business,
    // and a disagreement means one of them is not what we minted. Refuse rather
    // than pick a winner — the delegated context is built from the ROW below.
    if (row.businessId !== claims.businessId) throw portalSessionRequired('missing or invalid portal session');
    // The session must be the KIND the caller asked for. A DELEGATED_UPLOAD row
    // and an ONBOARDING row are different grants, and answering either question
    // with either row is how one becomes the other: the upload path would gain
    // a session with no chase and no grant, and the billing path would gain one
    // that can write documents. `ITEM_MESSAGE` matches neither and is refused
    // by both.
    if (!expectedScopes.includes(row.scope as 'DELEGATED_UPLOAD' | 'ONBOARDING')) {
      throw portalSessionRequired('missing or invalid portal session');
    }
    // A row that exists but was never verified is an OTP that was never passed.
    if (row.verifiedAt === null) throw portalSessionRequired('missing or invalid portal session');
    if (row.expiresAt.getTime() <= nowMs) {
      throw portalSessionRequired(SESSION_EXPIRED_DETAIL);
    }

    return {
      otpSessionId: row.id,
      businessId: row.businessId,
      practiceId: claims.practiceId,
      systemUserId,
      // `userId` is the contact's provisioned user when the contact has one;
      // the SYSTEM actor otherwise. The service decides it at creation and
      // stores it, so who a delegated write is attributed to cannot drift
      // between the session and its uploads.
      actorId: row.userId ?? systemUserId,
      chaseId: row.chaseId,
      grantedItemIds: row.grantedItemIds,
      expiresAt: row.expiresAt,
    };
  }
}
