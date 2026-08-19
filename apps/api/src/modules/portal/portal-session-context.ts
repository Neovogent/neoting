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
  /** The chase this session exists to answer. Null only for a non-chase OTP session (onboarding), which this module does not mint. */
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
   */
  async resolve(authorizationHeader: string | undefined, nowMs: number = Date.now()): Promise<PortalSessionFacts> {
    const verdict = verifyPortalSessionHeader(authorizationHeader, this.config.portalSessionSecret, nowMs);
    if (!verdict.ok) {
      // Expiry is the one distinguishable case: the bearer was genuinely ours,
      // and "tap the link again" is safe and useful to say. Missing, malformed
      // and forged share one detail string — the NT-AUTH-001 stance.
      throw verdict.reason === 'expired'
        ? portalSessionRequired('This portal session has expired. Open the link from your text message again.')
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
    // Only a DELEGATED_UPLOAD session may drive the portal. An ONBOARDING or
    // ITEM_MESSAGE row is a different grant with different scope, and this
    // resolver would hand it document-write powers it was never given.
    if (row.scope !== 'DELEGATED_UPLOAD') throw portalSessionRequired('missing or invalid portal session');
    // A row that exists but was never verified is an OTP that was never passed.
    if (row.verifiedAt === null) throw portalSessionRequired('missing or invalid portal session');
    if (row.expiresAt.getTime() <= nowMs) {
      throw portalSessionRequired('This portal session has expired. Open the link from your text message again.');
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
