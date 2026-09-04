import { randomInt } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type { SubscriptionStatus } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import { systemContext } from '../../common/db/scope-context.js';
import { type ScopedClient, scopedDb } from '../../common/db/scoped-db.js';
import type { Env } from '../../config/env.js';
import { composeSignInCodeSms, verifyPortalLink } from '../chase/index.js';
import { hashSetupToken } from '../clients-team-settings/index.js';
import { type NotificationsService, SignInCode } from '../notifications/index.js';
import { hashLinkToken } from './portal-session.service.js';

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
  /** Verifies a CHASE link on the code-request branch — the same secret that signed it. */
  readonly portalLinkSecret: string;
  /**
   * SMS delivery for chase sign-in codes (Phase 3) — present only when
   * `SMS_SENDER=aws` is configured. With it, a chase code goes to the
   * REGISTERED MOBILE first (D45's own words: "OTP to the registered number"),
   * falling back to the registered email when the contact has no mobile.
   * Absent, email carries every code exactly as before.
   */
  readonly smsOtp?: { sendText(toE164: string, body: string): Promise<{ messageId: string }> } | undefined;
}

export interface RequestSignInCodeInput {
  /**
   * From the setup link, on a FIRST sign-in. Absent on every one after that.
   *
   * ⚠ It was required, and that made this a one-week door rather than a portal:
   * the invite expires after seven days, so a client who onboarded, subscribed
   * and came back a fortnight later was locked out of their own workspace with
   * no route back that did not involve telephoning their accountant.
   */
  readonly setupToken?: string | undefined;
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
  /**
   * The business's subscription status at open (5 Sep 2026) — so the journey
   * can skip the subscribe step for an already-entitled client instead of
   * walking them back to the £8.50 screen. Absent when the business has never
   * been through checkout; `NT-BIL-002` on the checkout call remains the
   * server-side guard either way.
   */
  readonly subscriptionStatus?: SubscriptionStatus;
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
  | 'no-practice-actor'
  /** Tokenless sign-in: no contact anywhere has that address. */
  | 'unknown-address'
  /**
   * Tokenless sign-in: the address is a contact of MORE THAN ONE business.
   *
   * ⚠ Refused, never guessed. Picking one would open somebody's books on a coin
   * toss, and the person it opened them to would have no way of telling. Loud in
   * the log precisely because it is a dead end for a real person: an operator
   * has to see it to fix it.
   */
  | 'ambiguous-address';

/** What a sign-in attempt resolves to, by either route. */
interface ResolvedInvite {
  readonly practiceId: string;
  readonly systemUserId: string;
  readonly businessId: string;
  readonly contactId: string | null;
  readonly email: string;
  /**
   * The `otp_sessions.link_token_hash` this attempt reads and writes.
   *
   * On the invite route it is the hash of the setup token, as it always was. On
   * the tokenless route there is no link, so it is derived from the business and
   * the address — stable, so asking for a second code REPLACES the first, and
   * per-address, so two people at the same business do not overwrite each
   * other's code.
   */
  readonly sessionKey: string;
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
    const outcome = await this.resolveClient(input.setupToken, input.email, nowMs);
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
    const linkTokenHash = resolved.sessionKey;

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
   * Mint and email a code for a CHASE link — the half A2's TODO said whoever
   * sends the chase would owe, delivered here instead because the code request
   * is the CLIENT's act, not the send's: minting at send time would start the
   * ten-minute clock before the client ever opened the link.
   *
   * The journey: chase email arrives carrying `/p/<token>` → the portal screen
   * posts the token here → the code goes to the chase's REGISTERED recipient
   * contact (D45 — never to an address the caller types; the link is
   * forwardable and the registered contact is the identity) → the client types
   * it into `POST /portal/sessions`, whose `verifyOtp` already compares
   * against the `otp_hash` this writes.
   *
   * **Silent like the email route, and for the same reason**: whether a link
   * names a live chase is not something an unauthenticated caller may learn.
   * Every refusal — bad token, expired link, vanished chase, no recipient
   * contact, contact without an email — is a logged reason and a uniform 202.
   *
   * The row it writes is the counter-row shape (`verifiedAt: null`,
   * `expiresAt: now`) — deliberately NOT a session, refused by the resolver on
   * two independent checks, exactly as `recordFailedAttempt` writes it. The
   * session appears only when `createSession` verifies the code.
   */
  async requestChaseCode(linkToken: string, nowMs: number = Date.now()): Promise<void> {
    const link = verifyPortalLink(linkToken, this.config.portalLinkSecret, nowMs);
    if (!link.ok) {
      this.logger.warn(`chase code not sent: link-${link.reason}`);
      return;
    }

    const resolved = await this.resolveChaseRecipient(link.chaseId);
    if (resolved.ok === false) {
      this.logger.warn(`chase code not sent: ${resolved.reason} · chase=${link.chaseId}`);
      return;
    }

    const otp = mintOtp();
    const expiresAt = new Date(nowMs + ONBOARDING_OTP_TTL_MS);
    const linkTokenHash = hashLinkToken(linkToken);

    await scopedDb(this.prisma, systemContext(resolved.practiceId, resolved.systemUserId), (db) =>
      db.otpSession.upsert({
        where: { linkTokenHash },
        // Re-requesting REPLACES the code and clears the counter — the
        // onboarding rule; the notifications per-address ceiling is the tap
        // guard.
        update: { otpHash: hashOtp(otp), otpExpiresAt: expiresAt, ...OTP_ATTEMPTS_CLEARED },
        create: {
          linkTokenHash,
          scope: 'DELEGATED_UPLOAD',
          businessId: resolved.businessId,
          chaseId: resolved.chaseId,
          requestedFromContactId: resolved.contactId,
          otpHash: hashOtp(otp),
          otpExpiresAt: expiresAt,
          // NOT a session: unverified and already expired, the
          // recordFailedAttempt shape — `createSession` upserts the real one.
          verifiedAt: null,
          expiresAt: new Date(nowMs),
        },
      }),
    );

    // D45's own words: "OTP to the registered mobile". With the SMS wire
    // configured and a mobile on file, the code goes by TEXT — the carrier-
    // registered sample, verbatim — and email is the fallback, not the twin: a
    // code on two channels is two interception surfaces for one credential.
    const minutes = Math.round(ONBOARDING_OTP_TTL_MS / 60_000);
    if (this.config.smsOtp !== undefined && resolved.mobileE164 !== null) {
      try {
        await this.config.smsOtp.sendText(resolved.mobileE164, composeSignInCodeSms(otp, minutes));
        return;
      } catch (error) {
        // §11: never the number, never the code. The email fallback below still
        // runs — a failed text must not strand a client with no code at all.
        this.logger.warn(
          `chase code SMS failed — falling back to email · business=${resolved.businessId}: ${error instanceof Error ? error.name : 'error'}`,
        );
      }
    }

    if (resolved.email === null) {
      this.logger.warn(`chase code not sent: contact-has-no-email · business=${resolved.businessId}`);
      return;
    }
    try {
      const sent = await this.notifications.sendSignInCode({
        to: resolved.email,
        code: SignInCode.parse(otp),
        expiresInMinutes: minutes,
      });
      if (sent.sent === false) {
        this.logger.warn(
          `chase code not sent: ${sent.reason} · business=${resolved.businessId} domain=${domainOf(resolved.email)}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `chase code could not be sent · business=${resolved.businessId} domain=${domainOf(resolved.email)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * chaseId → its practice, business and the registered recipient's
   * identities. The `resolveChase` sweep (`portal-session.service.ts`),
   * narrowed to what code delivery needs: the chase's NAMED recipient contact
   * and their registered mobile + email. No contact, or a contact with
   * NEITHER identity, refuses — falling back to "the primary contact" would
   * deliver a credential to someone the reviewer never named (D45).
   */
  private async resolveChaseRecipient(
    chaseId: string,
  ): Promise<
    | {
        ok: true;
        practiceId: string;
        systemUserId: string;
        businessId: string;
        chaseId: string;
        contactId: string;
        email: string | null;
        mobileE164: string | null;
      }
    | { ok: false; reason: 'unknown-chase' | 'no-recipient-contact' | 'contact-unreachable' | 'no-practice-actor' }
  > {
    const candidates = await this.systemActorsByPractice();
    if (candidates.length === 0) return { ok: false, reason: 'no-practice-actor' };

    for (const candidate of candidates) {
      const found = await scopedDb(this.prisma, systemContext(candidate.practiceId, candidate.systemUserId), async (db) => {
        const chase = await db.chase.findUnique({
          where: { id: chaseId },
          select: { id: true, businessId: true, recipientContactId: true },
        });
        if (chase === null) return null;
        if (chase.recipientContactId === null) return { refusal: 'no-recipient-contact' as const };
        const contact = await db.contact.findUnique({
          where: { id: chase.recipientContactId },
          select: { id: true, email: true, mobileE164: true },
        });
        if (contact === null) return { refusal: 'no-recipient-contact' as const };
        const email = contact.email === null || contact.email === '' ? null : contact.email;
        const mobileE164 = contact.mobileE164 === null || contact.mobileE164 === '' ? null : contact.mobileE164;
        if (email === null && mobileE164 === null) return { refusal: 'contact-unreachable' as const };
        return {
          practiceId: candidate.practiceId,
          systemUserId: candidate.systemUserId,
          businessId: chase.businessId,
          chaseId: chase.id,
          contactId: contact.id,
          email,
          mobileE164,
        };
      });
      if (found !== null) {
        return 'refusal' in found ? { ok: false, reason: found.refusal } : { ok: true, ...found };
      }
    }
    return { ok: false, reason: 'unknown-chase' };
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
    const outcome = await this.resolveClient(input.setupToken, input.email, nowMs);
    if (outcome.ok === false) {
      this.logger.warn(`onboarding session refused: ${outcome.reason} · domain=${domainOf(input.email)}`);
      return null;
    }
    const resolved = outcome.invite;

    const linkTokenHash = resolved.sessionKey;
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
    const { otpSessionId, subscriptionStatus } = await this.withInviteScope(resolved, async (db) => {
      const row = await db.otpSession.update({
        where: { linkTokenHash },
        // The code is spent. Clearing the hash is what makes it single-use —
        // without this, a code stays live for its full ten minutes after it has
        // already opened a session.
        data: { verifiedAt: new Date(nowMs), otpHash: null, expiresAt, ...OTP_ATTEMPTS_CLEARED },
        select: { id: true },
      });
      // The subscription state at open (5 Sep 2026) — read inside the SAME
      // scoped call, so the journey's skip decision and the session it rides
      // on come from one view of the row.
      const business = await db.business.findUnique({
        where: { id: resolved.businessId },
        select: { subscriptionStatus: true },
      });
      return { otpSessionId: row.id, subscriptionStatus: business?.subscriptionStatus ?? null };
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
      // Omitted, never null, when the business has not been through checkout
      // (`exactOptionalPropertyTypes` — an absent key is the honest shape).
      ...(subscriptionStatus === null ? {} : { subscriptionStatus }),
    };
  }

  /**
   * ⚠ In `demo` mode the REAL code must still work, and that is the whole point
   * of the `||`.
   *
   * `demo` used to accept `000000` and nothing else, which was harmless only
   * while `EMAIL_SENDER=demo` meant no code ever reached a human. With the
   * local SMTP transport (2 Sep 2026) the client now receives a genuine
   * six-digit code by email — and the old branch refused it, answering
   * `NT-OTP-001` for the very code the product had just sent. A screen that
   * emails a credential and then rejects it is the "silent lie" class of
   * failure this codebase refuses everywhere else; here it was self-inflicted.
   *
   * Accepting both adds no exposure: `000000` is already accepted from anyone
   * in this mode, so the genuine code is strictly the narrower credential, and
   * `config/env.ts` REFUSES `OTP_MODE=demo` under `NODE_ENV=production`. The
   * fixed code stays so the offline walkthrough (METH_MODE §1) still runs with
   * no mail server at all.
   */
  /**
   * `POST /portal/setup-previews` — what a setup token names, so the screen
   * the emailed link lands on can PREFILL the registered address (5 Sep 2026
   * review finding: a client typed a different address, and the uniform `202`
   * on the code request meant nothing arrived and nothing said why).
   *
   * ⚠ **This is the one place a setup token answers WITHOUT the address**, and
   * the reason it may is the `invitation-preview` argument one trust level
   * down: the caller holds a token we emailed to the address the answer names,
   * so every fact in the response is already in the message they read the link
   * out of. It answers strictly LESS than that operation (no role, no ids).
   *
   * The gates are `resolveInvite`'s own, minus the address check: unknown,
   * expired, accepted and business-less tokens are one `null`, which the
   * controller turns into the uniform `NT-OTP-001`. The caller's screen
   * degrades to the empty field it had anyway.
   */
  async previewSetup(setupToken: string, nowMs: number = Date.now()): Promise<{ email: string; businessName: string } | null> {
    const tokenHash = hashSetupToken(setupToken);
    const candidates = await this.systemActorsByPractice();
    if (candidates.length === 0) {
      this.logger.warn('setup preview refused: no practice has a SYSTEM actor');
      return null;
    }
    for (const candidate of candidates) {
      const found = await scopedDb(
        this.prisma,
        systemContext(candidate.practiceId, candidate.systemUserId),
        async (db) => {
          const invite = await db.invite.findUnique({
            where: { tokenHash },
            select: { businessId: true, email: true, expiresAt: true, acceptedAt: true },
          });
          if (invite === null || invite.businessId === null || invite.email === null) return null;
          if (invite.expiresAt.getTime() <= nowMs) return null;
          if (invite.acceptedAt !== null) return null;
          const business = await db.business.findUnique({
            where: { id: invite.businessId },
            select: { name: true },
          });
          if (business === null) return null;
          return { email: invite.email, businessName: business.name };
        },
      );
      if (found !== null) return found;
    }
    return null;
  }

  private verifyOtp(otp: string, state: OtpAttemptRow | null, nowMs: number): boolean {
    const genuine = otpMatches(state?.otpHash ?? null, state?.otpExpiresAt ?? null, otp, nowMs);
    if (this.config.otpMode === 'demo') return genuine || otp === DEMO_OTP_CODE;
    return genuine;
  }

  /**
   * Which route this sign-in takes.
   *
   * A setup token means a FIRST sign-in and keeps every check the invite route
   * has always made. No token means the client is coming back, and the address
   * alone names the workspace — which is only safe because it must match a
   * contact of exactly ONE business.
   *
   * Both refuse identically to the caller. The two routes differ in what they
   * check, never in what they admit to.
   */
  private async resolveClient(
    setupToken: string | undefined,
    email: string,
    nowMs: number,
  ): Promise<{ ok: true; invite: ResolvedInvite } | { ok: false; reason: RefusalReason }> {
    return setupToken === undefined || setupToken === ''
      ? this.resolveByAddress(email)
      : this.resolveInvite(setupToken, email, nowMs);
  }

  /**
   * Address → the one workspace it belongs to, for a returning client.
   *
   * ⚠ **EXACTLY ONE, or nothing.** An address that is a contact of two
   * businesses is refused rather than guessed at: picking one would open
   * somebody's books on a coin toss, and the person it opened them to would have
   * no way of telling. It is logged loudly because it is a dead end for a real
   * person — an operator has to see it to fix it.
   *
   * Found the way `resolveInvite` finds an invite — the sanctioned sweep. ONE
   * unscoped read over `memberships` (which carries no RLS) yields each
   * practice's SYSTEM actor, and each context is asked whether it can see a
   * contact with this address. RLS answers, not a filter.
   *
   * There is no `isPrimary` condition, deliberately: D45 lets a client add their
   * own team members and lets those people upload, so any contact of the
   * business is a person entitled to sign in to it.
   *
   * ⚠ **A DEACTIVATED contact is not found here** (2 Sep 2026), and this is the
   * door that makes "remove" mean removed for somebody who is not currently
   * signed in. The other two readers are the ingest sender map (a forwarded
   * email stops routing to the workspace) and `portal-session-context.ts` (a
   * bearer they are holding right now stops working). All three are needed:
   * without this one a revoked person could simply request a fresh code and get
   * a brand-new hour.
   *
   * The caller learns nothing from it. A revoked address falls to
   * `unknown-address`, which `requestSignInCode` answers with the same silent
   * `202` it answers everything with — so this endpoint still reports nothing
   * about who does or does not have access to a workspace, which is the whole
   * reason it is uniform.
   */
  private async resolveByAddress(
    email: string,
  ): Promise<{ ok: true; invite: ResolvedInvite } | { ok: false; reason: RefusalReason }> {
    const wanted = email.trim().toLowerCase();
    const candidates = await this.systemActorsByPractice();
    if (candidates.length === 0) return { ok: false, reason: 'no-practice-actor' };

    const found: ResolvedInvite[] = [];
    for (const candidate of candidates) {
      const rows = await scopedDb(
        this.prisma,
        systemContext(candidate.practiceId, candidate.systemUserId),
        (db) =>
          db.contact.findMany({
            where: { email: { equals: wanted, mode: 'insensitive' }, deactivatedAt: null },
            select: { id: true, businessId: true },
          }),
      );
      for (const row of rows) {
        found.push({
          practiceId: candidate.practiceId,
          systemUserId: candidate.systemUserId,
          businessId: row.businessId,
          contactId: row.id,
          email: wanted,
          sessionKey: signInSessionKey(row.businessId, wanted),
        });
      }
    }

    if (found.length === 0) return { ok: false, reason: 'unknown-address' };
    // Two businesses on one address. Deliberately a dead end rather than a
    // guess — see the header.
    if (found.length > 1) return { ok: false, reason: 'ambiguous-address' };
    return { ok: true, invite: found[0]! };
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
            // The invite route's key is what it always was: the token's hash.
            sessionKey: tokenHash,
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
/**
 * The `otp_sessions` key for a RETURNING client, who has no link to hash.
 *
 * Stable, so asking for a second code replaces the first instead of piling up
 * rows. Per ADDRESS as well as per business, so two people at the same client
 * cannot overwrite each other's code — which would read to the loser as a code
 * that simply never worked.
 *
 * ⚠ It goes through `hashSetupToken` rather than being stored in the clear: the
 * column is `link_token_hash` and it is a hash everywhere else, so a readable
 * value sitting among hashed ones is the kind of inconsistency that later gets
 * "tidied up" into a comparison against the wrong thing. It is not a secret and
 * is not treated as one — it identifies a row, it does not authorise anything.
 */
function signInSessionKey(businessId: string, email: string): string {
  return hashSetupToken(`portal-sign-in:${businessId}:${email}`);
}

function mintOtp(): string {
  return String(randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, '0');
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}
