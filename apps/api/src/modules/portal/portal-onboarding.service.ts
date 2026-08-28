import { randomInt } from 'node:crypto';

import { Logger } from '@nestjs/common';

import type { PrismaClient } from '../../common/db/prisma.js';
import { systemContext } from '../../common/db/scope-context.js';
import { type ScopedClient, scopedDb } from '../../common/db/scoped-db.js';
import type { Env } from '../../config/env.js';
import { hashSetupToken } from '../clients-team-settings/index.js';
import { type NotificationsService, SignInCode } from '../notifications/index.js';

import {
  hashOtp,
  isOtpLocked,
  nextOtpAttempt,
  type OtpAttemptState,
  OTP_ATTEMPTS_CLEARED,
  otpMatches,
} from './otp-attempts.js';
import { PORTAL_SESSION_TTL_MS, signPortalSessionToken } from './portal-session-token.js';

/**
 * The invited client's way in — **the two endpoints `openapi.yaml` published and
 * no controller implemented.**
 *
 * `portal-session.service.ts` said so in a comment: *"the invited-client route
 * is `POST /v1/portal/sign-in-codes`, which `openapi.yaml` publishes and no
 * controller implements"*. A11 built client intake and sends the setup link, M6
 * built the screen that consumes it, and the seam between them belonged to
 * nobody. Walking S7 found it the way a customer would: the link arrives, the
 * screen loads, and the request 404s.
 *
 * Two operations, and they are deliberately asymmetric:
 *
 * | | Answers | Why |
 * |---|---|---|
 * | `requestSignInCode` | **always, silently** | Whether an address is registered on a workspace is not something an unauthenticated caller may learn. The email is what distinguishes the outcomes, and it goes to the address. |
 * | `createOnboardingSession` | throws on any refusal | By then the caller holds a code we sent to that address, so a failure is a real failure. |
 *
 * ⚠ **The setup token is the link, not the credential.** It names the workspace;
 * the six-digit code proves the person. A token alone opens nothing, which is
 * why the token may sit in a URL and the code may never.
 */

/** Six digits. Not five, not eight — {@link SignInCode} enforces the shape and the copy states it. */
const OTP_DIGITS = 6;

/**
 * Ten minutes. Long enough to fetch a phone from another room, short enough that
 * a code left in an inbox overnight is worthless. Stated to the client in the
 * mail (`composeSignInCode`) so the number and the copy cannot drift.
 */
export const ONBOARDING_OTP_TTL_MS = 10 * 60 * 1000;

/** The demo code, and the one place it is compared. Refused in production by `config/env.ts`. */
const DEMO_OTP_CODE = '000000';

export interface PortalOnboardingConfig {
  readonly portalSessionSecret: string;
  readonly otpMode: Env['OTP_MODE'];
}

export interface RequestSignInCodeInput {
  readonly setupToken: string;
  readonly email: string;
}

export interface CreateOnboardingSessionInput extends RequestSignInCodeInput {
  readonly otp: string;
}

export interface IssuedOnboardingSession {
  readonly token: string;
  readonly expiresAt: Date;
  /** The business this session was opened for — the contract's optional `PortalSession.businessId` (#205). */
  readonly businessId: string;
}

/**
 * Why a request was refused. Never reaches the caller — the endpoint answers
 * `202` regardless, and that is the whole point of the operation. It exists so
 * the SERVER can say which refusal happened.
 *
 * ⚠ **A refusal that is silent to the caller AND silent in the logs is
 * undiagnosable, and that cost a night.** `no-practice-actor` is the reason it
 * is spelled out separately from `unknown-token`: a practice with no SYSTEM
 * actor makes the sweep find no candidate, which looks EXACTLY like a token
 * nobody minted. It was the second, and every symptom pointed at the first.
 */
type RefusalReason =
  | 'unknown-token'
  | 'no-business'
  | 'expired'
  | 'already-accepted'
  | 'address-mismatch'
  | 'no-practice-actor';

/** What a valid setup token plus a matching address resolves to. */
interface ResolvedInvite {
  readonly practiceId: string;
  readonly systemUserId: string;
  readonly businessId: string;
  readonly contactId: string | null;
  readonly email: string;
}

export class PortalOnboardingService {
  private readonly logger = new Logger(PortalOnboardingService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: PortalOnboardingConfig,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Mint a code, store its hash, email it — or do nothing at all, silently.
   *
   * ⚠ **This method cannot report failure, and that is the contract.** A
   * mismatched address, an expired invite, an already-accepted one and a token
   * that was never ours are all indistinguishable from success to the caller.
   * Anything else answers *"is this address registered on this workspace"* for
   * whoever asks, and the setup link travels by email through people who are
   * not always the client.
   *
   * The one thing it does NOT swallow is a send failure that is our fault — the
   * caller still sees `202`, but the log carries it, because a client waiting
   * for a code that never left is otherwise invisible.
   */
  async requestSignInCode(input: RequestSignInCodeInput, nowMs: number = Date.now()): Promise<void> {
    const outcome = await this.resolveInvite(input.setupToken, input.email, nowMs);
    if (outcome.ok === false) {
      // §11: the reason and the address's DOMAIN. Never the address, never the
      // token. The CALLER still learns nothing — this is the server telling its
      // operator why nothing was sent, which is the only way an invited client
      // reporting "no email arrived" is answerable at all.
      this.logger.warn(`sign-in code not sent: ${outcome.reason} · domain=${domainOf(input.email)}`);
      return;
    }
    const resolved = outcome.invite;

    const otp = mintOtp();
    const expiresAt = new Date(nowMs + ONBOARDING_OTP_TTL_MS);
    const linkTokenHash = hashSetupToken(input.setupToken);

    await this.withInviteScope(resolved, (db) =>
      db.otpSession.upsert({
        where: { linkTokenHash },
        // Re-requesting a code REPLACES the previous one and clears the attempt
        // counter. A client who mistyped twice and asked for a fresh code has
        // not earned a lockout; the per-address and per-IP ceilings in
        // `notifications` are what stop this being an unbounded mail tap.
        update: {
          otpHash: hashOtp(otp),
          otpExpiresAt: expiresAt,
          ...OTP_ATTEMPTS_CLEARED,
        },
        create: {
          linkTokenHash,
          scope: 'ONBOARDING',
          businessId: resolved.businessId,
          practiceId: resolved.practiceId,
          contactId: resolved.contactId,
          otpHash: hashOtp(otp),
          otpExpiresAt: expiresAt,
          // The ROW lives as long as the invite does; the CODE lives ten
          // minutes. Two different clocks, and conflating them would either
          // expire the link or keep a code alive for a week.
          expiresAt: new Date(nowMs + PORTAL_SESSION_TTL_MS + ONBOARDING_OTP_TTL_MS),
        },
      }),
    );

    try {
      const sent = await this.notifications.sendSignInCode({
        to: resolved.email,
        code: SignInCode.parse(otp),
        expiresInMinutes: Math.round(ONBOARDING_OTP_TTL_MS / 60_000),
      });
      // ⚠ A REFUSAL IS RETURNED, NOT THROWN, so `catch` never sees it.
      // `NotificationsService` answers with a verdict precisely so a sign-in
      // endpoint can stay uniform to its caller — but uniform to the CALLER was
      // read as silent everywhere, and a rate-limited code looked identical to
      // a delivered one from the outside and from the logs.
      if (sent.sent === false) {
        this.logger.warn(
          `sign-in code not sent: ${sent.reason} · business=${resolved.businessId} domain=${domainOf(resolved.email)}`,
        );
      }
    } catch (error) {
      // Governance §11: the address's DOMAIN and the business, never the address
      // and never the code.
      this.logger.error(
        `onboarding code could not be sent · business=${resolved.businessId} domain=${domainOf(resolved.email)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Exchange the setup token, the address and the code for a portal session.
   *
   * The lockout is the same one the chase path uses, keyed on the same
   * `otp_sessions` row, so five wrong guesses cost fifteen minutes here too. It
   * is checked BEFORE the code is compared, so a locked link cannot be used as
   * a timing oracle.
   */
  async createOnboardingSession(
    input: CreateOnboardingSessionInput,
    nowMs: number = Date.now(),
  ): Promise<IssuedOnboardingSession | null> {
    const outcome = await this.resolveInvite(input.setupToken, input.email, nowMs);
    if (outcome.ok === false) {
      this.logger.warn(`onboarding session refused: ${outcome.reason} · domain=${domainOf(input.email)}`);
      return null;
    }
    const resolved = outcome.invite;

    const linkTokenHash = hashSetupToken(input.setupToken);
    const state = await this.withInviteScope(resolved, (db) =>
      db.otpSession.findUnique({
        where: { linkTokenHash },
        select: { id: true, otpHash: true, otpExpiresAt: true, attempts: true, lockedUntil: true },
      }),
    );

    if (isOtpLocked(state, nowMs)) return null;
    if (!this.verifyOtp(input.otp, state, nowMs)) {
      if (state !== null) {
        await this.withInviteScope(resolved, (db) =>
          db.otpSession.update({
            where: { id: state.id },
            data: nextOtpAttempt(state, nowMs),
          }),
        );
      }
      return null;
    }

    const expiresAt = new Date(nowMs + PORTAL_SESSION_TTL_MS);
    const otpSessionId = await this.withInviteScope(resolved, async (db) => {
      const row = await db.otpSession.update({
        where: { linkTokenHash },
        // The code is spent. Clearing the hash is what makes it single-use —
        // without this, a code stays live for its full ten minutes after it has
        // already opened a session.
        data: { verifiedAt: new Date(nowMs), otpHash: null, expiresAt, ...OTP_ATTEMPTS_CLEARED },
        select: { id: true },
      });
      return row.id;
    });

    // §11: the session and the tenant, never the token, the code or the address.
    this.logger.log(`onboarding session ${otpSessionId} opened · business=${resolved.businessId}`);

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
      businessId: resolved.businessId,
    };
  }

  private verifyOtp(otp: string, state: OtpAttemptRow | null, nowMs: number): boolean {
    if (this.config.otpMode === 'demo') return otp === DEMO_OTP_CODE;
    return otpMatches(state?.otpHash ?? null, state?.otpExpiresAt ?? null, otp, nowMs);
  }

  /**
   * Setup token + address → the workspace it names, or null.
   *
   * ⚠ **Every refusal returns the same `null`**, and the caller may not learn
   * which: unknown token, expired invite, already accepted, wrong address. They
   * are one outcome on purpose.
   *
   * Found the way `resolveChase` finds a chase — the sanctioned sweep. ONE
   * unscoped read over `memberships` (which carries no RLS) yields each
   * practice's SYSTEM actor, and each context is asked whether it can see this
   * invite. RLS answers, not a filter. It costs one scoped lookup per practice
   * and runs once per client at onboarding, never on a hot path; the same
   * follow-up `portal-session.service.ts` records applies here.
   */
  private async resolveInvite(
    setupToken: string,
    email: string,
    nowMs: number,
  ): Promise<{ ok: true; invite: ResolvedInvite } | { ok: false; reason: RefusalReason }> {
    const tokenHash = hashSetupToken(setupToken);
    const wanted = email.trim().toLowerCase();

    const candidates = await this.systemActorsByPractice();
    // ⚠ No practice has a SYSTEM actor, so there is nothing to search UNDER.
    // Distinguished from `unknown-token` because the two are indistinguishable
    // from every symptom and have nothing in common as fixes: this one is an
    // unprovisioned tenant (`db/backfill-system-actors.ts`), not a bad link.
    if (candidates.length === 0) return { ok: false, reason: 'no-practice-actor' };

    let reason: RefusalReason = 'unknown-token';
    for (const candidate of candidates) {
      const found = await scopedDb(
        this.prisma,
        systemContext(candidate.practiceId, candidate.systemUserId),
        async (db) => {
          const invite = await db.invite.findUnique({
            where: { tokenHash },
            select: { businessId: true, email: true, expiresAt: true, acceptedAt: true },
          });
          // `reason` is only ever narrowed by a practice that can SEE the row —
          // a practice that cannot leaves it as `unknown-token`, which is what
          // the sweep means for every other practice in the account.
          if (invite === null) return null;
          if (invite.businessId === null) { reason = 'no-business'; return null; }
          if (invite.expiresAt.getTime() <= nowMs) { reason = 'expired'; return null; }
          if (invite.acceptedAt !== null) { reason = 'already-accepted'; return null; }
          // D45: the address must be the one the accountant registered. A
          // mismatch is not reported — see this method's header.
          if ((invite.email ?? '').toLowerCase() !== wanted) { reason = 'address-mismatch'; return null; }

          const contact = await db.contact.findFirst({
            where: { businessId: invite.businessId, email: { equals: wanted, mode: 'insensitive' } },
            select: { id: true },
          });

          return {
            practiceId: candidate.practiceId,
            systemUserId: candidate.systemUserId,
            businessId: invite.businessId,
            contactId: contact?.id ?? null,
            email: wanted,
          } satisfies ResolvedInvite;
        },
      );
      if (found !== null) return { ok: true, invite: found };
    }
    return { ok: false, reason };
  }

  private withInviteScope<T>(resolved: ResolvedInvite, work: (db: ScopedClient) => Promise<T>): Promise<T> {
    return scopedDb(this.prisma, systemContext(resolved.practiceId, resolved.systemUserId), work);
  }

  /** `memberships` joined to `users` carries no RLS — the same sanctioned exemption `resolveChase` uses. */
  private async systemActorsByPractice(): Promise<readonly { practiceId: string; systemUserId: string }[]> {
    const rows = await this.prisma.membership.findMany({
      where: { practiceId: { not: null }, user: { kind: 'SYSTEM' } },
      select: { practiceId: true, userId: true },
    });
    return rows.flatMap((row) =>
      row.practiceId === null ? [] : [{ practiceId: row.practiceId, systemUserId: row.userId }],
    );
  }
}

interface OtpAttemptRow extends OtpAttemptState {
  readonly otpHash: string | null;
  readonly otpExpiresAt: Date | null;
}

/**
 * Six digits, uniformly distributed, leading zeros kept.
 *
 * `randomInt` rather than `randomBytes(n) % 1_000_000`: the modulo is biased
 * towards low values and `randomInt` rejection-samples for us. `padStart` rather
 * than a 100000–999999 range, because excluding codes that begin with a zero
 * throws away a tenth of the space to no benefit.
 */
function mintOtp(): string {
  return String(randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, '0');
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}
