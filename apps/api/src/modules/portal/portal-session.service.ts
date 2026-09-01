import { createHash } from 'node:crypto';

import { HttpStatus, Logger } from '@nestjs/common';

import type { PrismaClient } from '../../common/db/prisma.js';
import { systemContext } from '../../common/db/scope-context.js';
import { type ScopedClient, scopedDb } from '../../common/db/scoped-db.js';
import { AppException } from '../../common/problem/problem.js';
import type { Env } from '../../config/env.js';
import { verifyPortalLink } from '../chase/index.js';
import {
  isOtpLocked,
  type OtpAttemptState,
  OTP_ATTEMPTS_CLEARED,
  nextOtpAttempt,
  otpMatches,
} from './otp-attempts.js';
import type { PortalSessionFacts } from './portal-session-context.js';
import { PORTAL_SESSION_TTL_MS, signPortalSessionToken } from './portal-session-token.js';

/**
 * `POST /v1/portal/sessions` — the SMS link plus the OTP become a scoped portal
 * session (METH Stage 9, SoT §4 Stage 8.3).
 *
 * The journey this serves: an accountant approves a chase, `DemoSmsSender`
 * writes the text, the client taps the link on a phone, types six digits, and
 * gets a session that can see exactly the chased items and upload against them
 * — no app, no password, no account.
 *
 * **Every failure is the same `401 NT-OTP-001`.** Unknown token, forged token,
 * expired link, wrong OTP, chase deleted: one code, one detail string, the one
 * the contract publishes. Distinguishing them would tell a guesser which links
 * exist (the NT-AUTH-003 stance, applied here per `openapi.yaml`).
 *
 * **It writes, and it is legitimately outside Review → Approve.** The contract
 * marks it `x-nt-side-effect: ingest` — the same standing as web upload:
 * submitting evidence creates a new record and changes no existing one. No
 * chase moves state here; that happens on the auto-close path (Stage 8) when a
 * matching document actually arrives.
 */

/**
 * The fixed demo verification code (METH_MODE §7, shared with auth-tenancy's
 * TOTP).
 *
 * ⚠ Reachable only under `OTP_MODE=demo`, which `config/env.ts` REFUSES under
 * `NODE_ENV=production` as of launch stage A2. It used to be the whole of the
 * portal's authentication: one code, on every session, for every client of every
 * practice, published here.
 */
const DEMO_OTP_CODE = '000000';

export interface PortalSessionConfig {
  readonly portalLinkSecret: string;
  readonly portalSessionSecret: string;
  readonly otpMode: Env['OTP_MODE'];
}

export interface CreatePortalSessionInput {
  /** The token from the SMS link. Stateless — HMAC over the chase id and expiry (`chase/portal-link.ts`). */
  readonly linkToken: string;
  /** Six digits, already shape-checked by the generated Zod schema at the controller. */
  readonly otp: string;
}

export interface IssuedPortalSession {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * The verification-state columns of an `otp_sessions` row, read before the code
 * is compared: the counter, the lock, and the minted code this link is waiting
 * for. All four have existed in `prisma/schema.prisma` since it was written and
 * none of them was read by anything until A2.
 */
interface AttemptRow extends OtpAttemptState {
  readonly otpHash: string | null;
  readonly otpExpiresAt: Date | null;
}

/** What the practice-scoped bootstrap read out of the chase before any session existed. */
interface ResolvedChase {
  readonly practiceId: string;
  readonly systemUserId: string;
  readonly chaseId: string;
  readonly businessId: string;
  /** Who we texted. Recorded as `requested_from`, separately from who uploads (SoT Stage 8.3). */
  readonly requestedFromContactId: string | null;
  /** That contact's provisioned user, when the row genuinely exists. Null for a phone-number-only contact. */
  readonly delegatedUserId: string | null;
}

export class PortalSessionService {
  private readonly logger = new Logger(PortalSessionService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: PortalSessionConfig,
  ) {}

  /**
   * Link token + OTP → a portal bearer, with the attempts counted (A2).
   *
   * ⚠ **THE ORDER CHANGED IN A2, AND IT IMPROVED THE TIMING STORY RATHER THAN
   * WEAKENING IT.** This method used to check the link and the OTP together and
   * only resolve the chase once BOTH had passed — so a successful verification
   * was measurably slower than any failure, which is the distinction that
   * actually matters. Counting an attempt needs somewhere to write it, and the
   * only tenant anchor available is the chase, so the resolution now happens for
   * every request whose LINK verifies. What remains distinguishable is
   * "verifies" versus "does not", and a caller already knows which link they
   * were given; what is now indistinguishable is right code versus wrong, which
   * is the pair `NT-OTP-001` exists for.
   *
   * An empty `PORTAL_LINK_SECRET` still throws rather than returning a verdict:
   * fail closed and loud, the house stance for an unset secret.
   */
  async createSession(input: CreatePortalSessionInput, nowMs: number = Date.now()): Promise<IssuedPortalSession> {
    const link = verifyPortalLink(input.linkToken, this.config.portalLinkSecret, nowMs);
    // A token that is not ours anchors nothing, so there is nothing to count it
    // against — and nothing worth counting either: it is 256 bits of HMAC, not
    // a six-digit code (`otp-attempts.ts` states the full argument).
    if (!link.ok) throw verificationFailed();

    const resolved = await this.resolveChase(link.chaseId);
    // A signed link naming a chase that is gone (or whose business has no
    // practice, so no SYSTEM actor can reach it). Same 401 as everything else.
    if (resolved === null) throw verificationFailed();

    const linkTokenHash = hashLinkToken(input.linkToken);
    const attemptState = await this.readAttemptState(resolved, linkTokenHash);

    // Locked: refuse BEFORE comparing the code, so a locked link cannot be used
    // as an oracle that answers faster or slower for a right guess, and so the
    // lock costs the server one read rather than a verification.
    if (isOtpLocked(attemptState, nowMs)) throw verificationFailed();

    if (!this.verifyOtp(input.otp, attemptState, nowMs)) {
      await this.recordFailedAttempt(resolved, linkTokenHash, attemptState, nowMs);
      throw verificationFailed();
    }

    const expiresAt = new Date(nowMs + PORTAL_SESSION_TTL_MS);
    const otpSessionId = await this.recordSession(resolved, linkTokenHash, expiresAt, new Date(nowMs));

    // Governance §11: the session is logged, the credential is not. No link
    // token, no OTP, no bearer — the two ids are what an incident needs.
    this.logger.log(`portal session ${otpSessionId} opened · chase=${resolved.chaseId} business=${resolved.businessId}`);

    return {
      token: signPortalSessionToken(
        {
          otpSessionId,
          businessId: resolved.businessId,
          practiceId: resolved.practiceId,
          expiresAtMs: expiresAt.getTime(),
        },
        this.config.portalSessionSecret,
      ),
      expiresAt,
    };
  }

  /**
   * Add document ids to the session's grant — the ONLY thing that widens what a
   * portal session may touch.
   *
   * The upload path derives the document id from its own signed intent
   * (`documentIdFor(uploadId)`) and appends it here BEFORE completion, because
   * `documents_delegated_upload` keys on `id = ANY(app_granted_item_ids())`:
   * without the grant the delegated context can neither write the row nor read
   * it back. Written with Prisma's scalar-list `push` so two uploads in flight
   * cannot clobber each other's grant with a stale whole-array write; a
   * duplicate id from a race grants nothing extra.
   */
  async grantItems(facts: PortalSessionFacts, itemIds: readonly string[]): Promise<readonly string[]> {
    const missing = itemIds.filter((id) => !facts.grantedItemIds.includes(id));
    if (missing.length === 0) return facts.grantedItemIds;

    await scopedDb(this.prisma, systemContext(facts.practiceId, facts.systemUserId), (db) =>
      db.otpSession.update({
        where: { id: facts.otpSessionId },
        data: { grantedItemIds: { push: missing } },
        select: { id: true },
      }),
    );
    return [...facts.grantedItemIds, ...missing];
  }

  /**
   * The OTP, both modes (launch stage A2).
   *
   * `demo` is the fixed code, kept so a laptop and CI run the whole client
   * journey offline, and refused at boot in production (`config/env.ts`).
   *
   * `totp` compares against `otp_sessions.otp_hash` / `otp_expires_at` — the
   * two columns the schema has always carried for a real per-session code. It
   * is deliberately NOT the RFC 6238 verifier `auth-tenancy` uses: a client
   * holding a forwarded link on a borrowed phone has no authenticator app and
   * never will, so the portal's second factor is a one-time code we mint and
   * send, which is exactly what those columns describe.
   *
   * ⚠ **NOTHING MINTS THAT CODE YET, so `totp` fails CLOSED here.** Writing
   * `otp_hash` belongs to whoever sends the code: the chase link is minted in
   * `modules/chase` (A13), and the invited-client route is
   * `POST /v1/portal/sign-in-codes`, which `openapi.yaml` publishes and no
   * controller implements. Both are outside A2's owned paths. Until one of them
   * lands, `OTP_MODE=totp` means no portal session can be opened — which is the
   * honest state, and is better than the alternative it replaces.
   */
  private verifyOtp(otp: string, state: AttemptRow | null, nowMs: number): boolean {
    if (this.config.otpMode === 'demo') return otp === DEMO_OTP_CODE;
    return otpMatches(state?.otpHash ?? null, state?.otpExpiresAt ?? null, otp, nowMs);
  }

  /**
   * The counter, the lock and the minted code for this link — or null if this
   * link has never been presented before.
   *
   * Read under the practice SYSTEM context, the same one `recordSession` writes
   * under: `otp_sessions` is a tenant table with no delegated branch (see this
   * module's `CLAUDE.md`), and there is no session yet to be scoped by.
   */
  private async readAttemptState(resolved: ResolvedChase, linkTokenHash: string): Promise<AttemptRow | null> {
    return scopedDb(this.prisma, systemContext(resolved.practiceId, resolved.systemUserId), (db) =>
      db.otpSession.findUnique({
        where: { linkTokenHash },
        select: { attempts: true, lockedUntil: true, otpHash: true, otpExpiresAt: true },
      }),
    );
  }

  /**
   * Count a wrong code, and lock the link once there have been enough.
   *
   * ⚠ **THIS CREATES THE ROW WHEN THERE IS NONE, AND THAT IS THE POINT.** Before
   * A2 an `otp_sessions` row appeared only on a SUCCESSFUL verification, so
   * there was nowhere for a failure to be recorded and the counter columns could
   * never be reached. The row created here is deliberately not a session:
   * `verified_at` stays NULL and `expires_at` is set to now, so
   * `PortalSessionContextResolver` refuses it on two independent checks. It is a
   * counter that happens to live in the sessions table, because that is where
   * the schema put the counter.
   *
   * It is bounded: `link_token_hash` is `@unique`, so one link can produce at
   * most one row however many wrong codes are sent to it. An unauthenticated
   * caller cannot grow the table beyond the number of valid links they hold.
   */
  private async recordFailedAttempt(
    resolved: ResolvedChase,
    linkTokenHash: string,
    state: AttemptRow | null,
    nowMs: number,
  ): Promise<void> {
    const next = nextOtpAttempt(state, nowMs);
    await scopedDb(this.prisma, systemContext(resolved.practiceId, resolved.systemUserId), (db) =>
      db.otpSession.upsert({
        where: { linkTokenHash },
        create: {
          linkTokenHash,
          businessId: resolved.businessId,
          chaseId: resolved.chaseId,
          requestedFromContactId: resolved.requestedFromContactId,
          scope: 'DELEGATED_UPLOAD',
          // NOT a session: unverified, and already expired. Both are re-checked
          // by the resolver, so this row can never be mistaken for a credential.
          verifiedAt: null,
          expiresAt: new Date(nowMs),
          ...next,
        },
        update: next,
        select: { id: true },
      }),
    );
  }

  /**
   * chaseId → the chase, its business, its practice and its recipient.
   *
   * ⚠ **THE BOOTSTRAP, and why it looks like this.** This runs BEFORE any
   * session exists, so it cannot be scoped by one. `chases` is a tenant table
   * whose policy is `app_can_access_business(business_id)`, which begins
   * `app_session_scope() = 'user'` — so the read needs a practice-scoped actor,
   * and the practice is precisely what the chase would have told us. The link
   * token carries only `{chaseId, exp}` (Stage 8's format, minted before this
   * stage existed and deliberately not changed here), so the practice has to be
   * found rather than read.
   *
   * It is found the way the workers do it: `resolveSystemActor`'s own tables.
   * ONE unscoped query over `memberships` (joined to `users`) — the sanctioned
   * exemption, safe for the same stated reason as `resolveSystemActor` (#20)
   * and `session-scope.ts`: neither table carries RLS — yields every practice's
   * SYSTEM actor, and each candidate context is asked whether it can see this
   * chase. The first that can, owns it.
   *
   * This is a sweep, and it is honest about being one: it costs one scoped
   * lookup per practice until the chase is found. Acceptable because a portal
   * session is created once per client per chase, never on a hot path — and
   * because the alternative (a practice claim on the LINK token) is a change to
   * Stage 8's minted format and its call site, which is not this stage's to
   * make. The follow-up is recorded in this module's CLAUDE.md.
   *
   * It cannot widen anything: the chase id came out of an HMAC we signed, it
   * names exactly one chase, and only that chase's own business travels back.
   */
  private async resolveChase(chaseId: string): Promise<ResolvedChase | null> {
    for (const candidate of await this.systemActorsByPractice()) {
      const found = await scopedDb(this.prisma, systemContext(candidate.practiceId, candidate.systemUserId), async (db) => {
        const chase = await db.chase.findUnique({
          where: { id: chaseId },
          select: {
            id: true,
            businessId: true,
            recipientContactId: true,
            recipient: { select: { userId: true } },
          },
        });
        // Invisible under this practice's context is indistinguishable from
        // absent, which is the point — RLS answers the question, not a filter.
        if (chase === null) return null;
        return {
          practiceId: candidate.practiceId,
          systemUserId: candidate.systemUserId,
          chaseId: chase.id,
          businessId: chase.businessId,
          requestedFromContactId: chase.recipientContactId,
          delegatedUserId: await this.resolveDelegatedActor(db, chase.recipient?.userId ?? null),
        };
      });
      if (found !== null) return found;
    }
    return null;
  }

  /**
   * Who a delegated write is attributed to — the decision, written down.
   *
   * `documents.submitter_user_id` is a foreign key to `users`, and every policy
   * begins `app_actor_id() IS NOT NULL`, so the actor of a delegated context
   * MUST be a real user row. A contact id is not one, and inventing an id is
   * not an option.
   *
   * So: the recipient contact's provisioned user when that user genuinely
   * exists, and the practice SYSTEM actor otherwise. `Contact.userId` is a bare
   * column with NO foreign key (`prisma/schema.prisma`), so it is checked
   * against `users` rather than trusted — an id naming no row would fail the
   * document FK at upload time, hours later, as a 500 on the client's phone.
   *
   * The honest caveat, stated because the link is deliberately forwardable
   * (SoT Stage 8.3): this names the person we ASKED, who may not be the person
   * holding the phone. That is exactly why the audit trail keeps the two apart
   * — `otp_sessions.requested_from_contact_id` records who was asked, and the
   * session row itself is the uploaded-by-delegated-session record.
   * `otp_sessions.contact_id` is deliberately left NULL: we do not know who
   * forwarded the link to whom, and a guess written into an audit column is
   * worse than an absence.
   *
   * The common case is the SYSTEM actor anyway — SoT §3.3's phone-number-only
   * contacts "can receive chases and upload through OTP links without ever
   * being provisioned as users" — which is the same actor every WhatsApp and
   * email document already carries.
   */
  private async resolveDelegatedActor(db: ScopedClient, contactUserId: string | null): Promise<string | null> {
    if (contactUserId === null) return null;
    const user = await db.user.findUnique({ where: { id: contactUserId }, select: { id: true } });
    return user === null ? null : user.id;
  }

  /**
   * Every practice's SYSTEM actor, one query, deduplicated.
   *
   * Unscoped on purpose and on the record: `memberships` and `users` carry no
   * RLS (they are the actor tables the policies themselves read), which is the
   * exemption `common/db/resolve-system-actor.ts` states and this reuses rather
   * than inventing a second one. It is `resolveSystemActor` with the practice
   * unknown instead of given.
   */
  private async systemActorsByPractice(): Promise<readonly { practiceId: string; systemUserId: string }[]> {
    const rows = await this.prisma.membership.findMany({
      where: { practiceId: { not: null }, user: { kind: 'SYSTEM' } },
      select: { practiceId: true, userId: true },
      orderBy: { createdAt: 'asc' },
    });

    const byPractice = new Map<string, string>();
    for (const row of rows) {
      if (row.practiceId !== null && !byPractice.has(row.practiceId)) byPractice.set(row.practiceId, row.userId);
    }
    return [...byPractice].map(([practiceId, systemUserId]) => ({ practiceId, systemUserId }));
  }

  /**
   * Create the `otp_sessions` row, or re-verify the one this link already has.
   *
   * `link_token_hash` is `@unique`, so a client who taps the same link twice —
   * a bookmark, a back button, a forward to a colleague who verifies again —
   * must resolve to the SAME row rather than collide on the constraint. That
   * makes this an upsert keyed on the hash: a re-verification refreshes
   * `verified_at` and `expires_at` and leaves `granted_item_ids` alone, so a
   * document already uploaded in this session stays readable to it.
   *
   * The P2002 catch covers the genuine race — two verifications of one link
   * arriving together, both finding nothing and both inserting. The loser
   * re-reads and updates.
   *
   * The hash is a plain SHA-256: the link token is 256 bits of HMAC output, not
   * a guessable secret, so it needs a lookup key that does not store the
   * credential — not a password KDF.
   */
  private async recordSession(
    resolved: ResolvedChase,
    linkTokenHash: string,
    expiresAt: Date,
    verifiedAt: Date,
  ): Promise<string> {
    const shared = {
      businessId: resolved.businessId,
      chaseId: resolved.chaseId,
      requestedFromContactId: resolved.requestedFromContactId,
      userId: resolved.delegatedUserId,
      verifiedAt,
      expiresAt,
      // The code is spent — clearing the hash is what makes a minted chase
      // code single-use (the onboarding lane's rule, applied here now that the
      // chase lane mints codes too). Under OTP_MODE=demo there is no hash and
      // this writes the null it already was.
      otpHash: null,
      // A verification that succeeded clears the counter and the lock (A2).
      // Without this a client who mistyped four times and then got it right
      // would carry four attempts into their next visit and be locked out on
      // one further slip — punished for a mistake they had already corrected.
      ...OTP_ATTEMPTS_CLEARED,
    };

    return scopedDb(this.prisma, systemContext(resolved.practiceId, resolved.systemUserId), async (db) => {
      try {
        const row = await db.otpSession.upsert({
          where: { linkTokenHash },
          // `contactId` is deliberately absent — see `resolveDelegatedActor`.
          // `grantedItemIds` starts empty and is widened by `grantItems` per
          // upload; `ScopeContextSchema` refuses a delegated context until then,
          // which is the intended state, not a bug.
          create: { ...shared, linkTokenHash, scope: 'DELEGATED_UPLOAD' },
          update: shared,
          select: { id: true },
        });
        return row.id;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const existing = await db.otpSession.findUnique({ where: { linkTokenHash }, select: { id: true } });
        if (existing === null) throw error; // not our race after all — surface it
        const row = await db.otpSession.update({ where: { id: existing.id }, data: shared, select: { id: true } });
        return row.id;
      }
    });
  }
}

/**
 * The one 401 this endpoint returns, for every reason it could return one. The
 * title and detail are the contract's own published example, verbatim — a
 * client that special-cases the string keeps working.
 */
function verificationFailed(): AppException {
  return new AppException(
    'NT-OTP-001',
    HttpStatus.UNAUTHORIZED,
    'Verification failed',
    'The link or verification code did not verify. Request a fresh link if this one has expired.',
  );
}

/**
 * The `otp_sessions.link_token_hash` for a CHASE link. Exported because the
 * code-minting path (`portal-onboarding.service.ts`'s chase branch) must write
 * `otp_hash` onto the SAME row this service reads at verification — two
 * hashings would be a code that never matches, silently.
 */
export function hashLinkToken(linkToken: string): string {
  return createHash('sha256').update(linkToken).digest('hex');
}

/** Prisma's unique-constraint error (P2002), duck-typed so no value import of Prisma is needed. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2002';
}
