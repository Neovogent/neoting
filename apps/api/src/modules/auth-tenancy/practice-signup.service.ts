import { HttpStatus } from '@nestjs/common';

import { createPracticeBodyPasswordMin } from '@neoting/contracts/zod';

import { fingerprint, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { PrismaClient } from '../../common/db/prisma.js';
import { AppException } from '../../common/problem/problem.js';
import type { Env } from '../../config/env.js';
import { EMAIL_VERIFICATION_TTL_MS, signEmailVerificationToken } from './email-verification.js';
import { hashPassword } from './password.js';
import { appendTermsAcceptanceEvent } from './signup-audit.js';
import { RecordingSignupMailer, type SignupMailer } from './signup-mailer.js';

/**
 * Practice signup — `POST /v1/practices`, `operationId: createPractice`
 * (launch stage A1, SoT §24.5, the ID LAW batch).
 *
 * Before this existed, `demo-credentials.ts` WAS the credential system: a frozen
 * two-entry table, and only `prisma/seed.ts` could mint a Practice, a User or a
 * Membership. An accountant could not create an account. This is the door.
 *
 * **The response is always 202 and says nothing.** Not laziness — the contract
 * is explicit: telling the caller whether an account was created answers "is
 * this email registered here" for anyone who asks, which is the same
 * enumeration oracle `NT-AUTH-003` exists to close on the login path. The
 * verification mail is what distinguishes the two outcomes, and it goes to the
 * address, not to the caller. A `400` is still a `400`: a password that is too
 * short is the caller's own input and reveals nothing about anyone else.
 *
 * **The account is unusable until the address is verified.** `emailVerified`
 * starts false and `auth.service.ts` refuses to issue a session for a user whose
 * address is unproven. Until then there is a practice with no reachable owner,
 * which is the correct state for something nobody has proved they control.
 */

/**
 * The terms version a signup must name — `docs/legal/terms-of-service.md`,
 * which reads *"Version 0.1 — DRAFT, not for publication until legally
 * reviewed."*
 *
 * The contract: *"A signup naming a version that is not the one in force is
 * refused."* An accountant who accepted v0.1 has a record saying v0.1, and it
 * stays true when v0.2 ships — which is the whole reason the version is
 * captured rather than a boolean `acceptedTerms`.
 *
 * ⚠ **This constant moves when the solicitor-reviewed terms land**, in the same
 * PR that publishes them, or the signup screen will offer a version the server
 * refuses. `docs/launch/PLAN.md` has the legal pack as an open item.
 */
export const TERMS_VERSION_IN_FORCE = '0.1';

export interface PracticeSignupInput {
  readonly practiceName: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly password: string;
  readonly acceptedTermsVersion: string;
}

export interface PracticeSignupRequestMeta {
  readonly idempotencyKey: string;
  readonly traceId: string | null;
}

/** What the unscoped provisioning write produced. Never leaves the server — the response is empty. */
interface ProvisionedTenant {
  readonly practiceId: string;
  readonly userId: string;
}

export class PracticeSignupService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: Env,
    private readonly mailer: SignupMailer,
    private readonly idempotency: IdempotencyStore,
  ) {}

  async signUp(input: PracticeSignupInput, meta: PracticeSignupRequestMeta): Promise<void> {
    // A replayed key does no work twice; the same key with a DIFFERENT payload
    // is a client bug and is a 409 rather than a second practice quietly
    // appearing. The stored fingerprint is a SHA-256 of the body, so the
    // password is not retained in the store in any readable form.
    const requestHash = fingerprint(input);
    const replay = await this.idempotency.get(meta.idempotencyKey);
    if (replay !== null) {
      if (replay.requestHash !== requestHash) {
        throw new AppException(
          'NT-IDM-001',
          HttpStatus.CONFLICT,
          'Idempotency key reused',
          'This Idempotency-Key was already used for a different signup. Use a fresh key.',
        );
      }
      return;
    }

    this.assertMailerCanActuallySend();
    const email = normaliseEmail(input.email);
    assertAcceptableSignup(input);

    // ⚠ HASH BEFORE THE TRANSACTION OPENS. scrypt burns ~50-100 ms of CPU on
    // the event loop; doing it inside would hold a database transaction — and
    // the advisory lock the audit append takes — for the whole burn.
    const passwordHash = hashPassword(input.password);

    const provisioned = await this.provisionPractice({ ...input, email }, passwordHash, meta.traceId);

    // From here on there are NO further queries in this request, scoped or
    // otherwise — the response is an empty 202. Anything a later stage adds
    // here MUST go through `scopedDb(ctx)` built from the practice just
    // created. The exemption below is for provisioning and nothing else.
    if (provisioned === null) {
      // The address already has an account. The caller learns nothing; the
      // account holder is told at the address, where they are the only reader.
      await this.mailer.sendDuplicateSignupNotice({ to: email });
    } else {
      await this.sendVerification(provisioned, { ...input, email });
    }

    await this.idempotency.put(meta.idempotencyKey, { requestHash, response: null });
  }

  /**
   * ⚠⚠ **THE ONE LEGITIMATELY UNSCOPED WRITE IN THIS SYSTEM.** ⚠⚠
   *
   * Read this before changing anything in it, and do not copy its shape
   * anywhere else.
   *
   * **Why it cannot go through `scopedDb`.** `scopedDb(ctx, fn)` sets the five
   * request GUCs every RLS policy reads, and `ScopeContextSchema` refuses a
   * context with neither a practice nor a business — correctly, because such a
   * context makes every policy branch fail and the caller sees an empty
   * database. A signup has no practice and no business to name: the tenant
   * being created is exactly what a session would have been scoped to. There is
   * no context that could be built here that is not a lie.
   *
   * **Why that is safe rather than a bypass.** `prisma/sql/rls.sql` does not
   * enable RLS on `practices`, `users` or `memberships` at all — they are the
   * actor tables the policies themselves read, and a policy that queried a
   * policed table to decide access to it would recurse. Shakib settled this on
   * 14 Aug 2026 (`prisma/CLAUDE.md`, issue #17) precisely so provisioning
   * resolves without any bypass mechanism: nothing here disables, forces or
   * escapes a policy, because there is no policy on these three tables to
   * escape. The membership row therefore exists before the first policed insert
   * needs it, which is the ordering the whole tenancy model depends on.
   *
   * The fourth table, `audit_events`, IS policed — and its append policy is
   * `business_id IS NULL OR app_can_access_business(business_id)`. The
   * terms-acceptance row carries a NULL business, so it satisfies the policy on
   * its own terms with no context set. That is the policy working, not a hole.
   *
   * **Why one transaction.** Three rows that must exist together or not at all:
   * a practice with no owner is unreachable, a user with no membership resolves
   * to a 401 on every request, and a membership pointing at a rolled-back
   * practice cannot exist. The contract says "in one transaction" and means it.
   *
   * Returns null when the address is already taken — checked, and then caught
   * again from the unique index, because between the check and the insert is
   * exactly where a concurrent signup lands.
   */
  private async provisionPractice(
    input: PracticeSignupInput & { readonly email: string },
    passwordHash: string,
    traceId: string | null,
  ): Promise<ProvisionedTenant | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // The cheap, common case: an address that is plainly taken should not
        // create a practice and roll it back. `users.email` is `@unique`, so
        // this is an index probe, and the catch below covers the race it cannot.
        const existing = await tx.user.findUnique({ where: { email: input.email }, select: { id: true } });
        if (existing !== null) return null;

        const practice = await tx.practice.create({
          data: { name: input.practiceName.trim() },
          select: { id: true },
        });

        const user = await tx.user.create({
          data: {
            kind: 'HUMAN',
            email: input.email,
            // False, and it is the point of the whole endpoint. Nothing here
            // may set it true; only proving control of the address may.
            emailVerified: false,
            passwordHash,
            firstName: input.firstName.trim(),
            lastName: input.lastName.trim(),
          },
          select: { id: true },
        });

        await tx.membership.create({
          data: {
            userId: user.id,
            practiceId: practice.id,
            // Practice-WIDE (businessId stays null) so `pickActingMembership`
            // resolves this user to the whole workspace rather than to one
            // client — see `session-scope.ts` for why that ordering matters.
            role: 'PRACTICE_ADMIN',
            // D44: the firm's SUPER ADMIN is the release authority — only they
            // may release a chase or move an item to Published. The first user
            // holds it from the first second the tenant exists, rather than
            // being granted it later by something that would also need a door
            // of its own. `isOwner` is what distinguishes the one super admin
            // from any other PRACTICE_ADMIN the firm later invites.
            isOwner: true,
          },
        });

        await appendTermsAcceptanceEvent(tx, {
          practiceId: practice.id,
          userId: user.id,
          email: input.email,
          acceptedTermsVersion: input.acceptedTermsVersion,
          acceptedAt: new Date(),
          traceId,
        });

        return { practiceId: practice.id, userId: user.id };
      });
    } catch (error) {
      // P2002 on `users.email`: a concurrent signup won the race between the
      // findUnique above and this insert. Same outcome as finding it there —
      // the whole transaction rolled back, so no orphan practice exists.
      if (isUniqueEmailViolation(error)) return null;
      throw error;
    }
  }

  private async sendVerification(
    provisioned: ProvisionedTenant,
    input: PracticeSignupInput & { readonly email: string },
  ): Promise<void> {
    const expiresAtMs = Date.now() + EMAIL_VERIFICATION_TTL_MS;
    const token = signEmailVerificationToken(
      { userId: provisioned.userId, email: input.email, expiresAtMs },
      this.env.SESSION_SECRET,
    );
    await this.mailer.sendEmailVerification({
      to: input.email,
      firstName: input.firstName.trim(),
      practiceName: input.practiceName.trim(),
      token,
      expiresAt: new Date(expiresAtMs),
    });
  }

  /**
   * Refuse to create an account nobody can ever verify.
   *
   * `RecordingSignupMailer` sends nothing — it is the stand-in for S2, which has
   * not merged. In development that is exactly right: the token is readable out
   * of the process and a developer finishes the flow. In production it means a
   * paying accountant's practice is created, charged for, and permanently
   * unusable, with a `202` telling them to check an inbox nothing will arrive
   * in. Refusing is the smaller failure, and it is loud.
   *
   * Request-time, not boot-time, and deliberately so — `config/env.ts` gives the
   * reasoning for `SESSION_SECRET`: a boot gate would crash-loop the deploy and
   * take `/healthz` with it, which reads as a broken image rather than a missing
   * dependency. One endpoint failing honestly is the better shape.
   */
  private assertMailerCanActuallySend(): void {
    if (this.env.NODE_ENV === 'production' && this.mailer instanceof RecordingSignupMailer) {
      throw new AppException(
        'NT-SRV-001',
        HttpStatus.INTERNAL_SERVER_ERROR,
        'Signup is unavailable',
        'Account verification email cannot be sent, so no account may be created right now.',
      );
    }
  }
}

/**
 * Lower-cased and trimmed, once, here. Addresses are typed many ways and
 * `users.email` is `@unique` on the literal bytes — so "Priya@Firm.test" and
 * "priya@firm.test" would otherwise be two accounts, and the second one would
 * be able to sign up and then never receive anything the first one's chases go
 * to. The login path normalises identically; the two must not disagree.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The refusals that are the CALLER's own input, and therefore safe to name.
 *
 * The controller has already parsed the body with the generated
 * `createPracticeBody`, so in practice these never fire from HTTP. They are
 * here because the service is also called directly by tests and by any future
 * caller, and a rule that only exists at one call site is a rule that is one
 * refactor from not existing.
 */
function assertAcceptableSignup(input: PracticeSignupInput): void {
  if (input.acceptedTermsVersion !== TERMS_VERSION_IN_FORCE) {
    throw new AppException('NT-VAL-001', HttpStatus.BAD_REQUEST, 'Validation failed', 'The terms version accepted is not the version in force.', [
      { field: 'acceptedTermsVersion', message: `Must be the terms version in force (${TERMS_VERSION_IN_FORCE}).` },
    ]);
  }
  // The minimum comes FROM the contract, not from a number retyped here — the
  // spec's own reasoning is that length alone beats a composition rule, which
  // reliably produces `Password1!`. Length is measured in code points, not
  // bytes: a twelve-character passphrase is twelve characters whatever alphabet
  // it is written in.
  if ([...input.password].length < createPracticeBodyPasswordMin) {
    throw new AppException('NT-VAL-001', HttpStatus.BAD_REQUEST, 'Validation failed', 'The password is too short.', [
      { field: 'password', message: `Must be at least ${createPracticeBodyPasswordMin} characters.` },
    ]);
  }
  for (const [field, value] of [
    ['practiceName', input.practiceName],
    ['firstName', input.firstName],
    ['lastName', input.lastName],
  ] as const) {
    // `.min(1)` in the contract passes a single space. A practice called " " is
    // a row nobody can search for and a name no screen can render.
    if (value.trim() === '') {
      throw new AppException('NT-VAL-001', HttpStatus.BAD_REQUEST, 'Validation failed', 'A required name was blank.', [
        { field, message: 'Must not be blank.' },
      ]);
    }
  }
}

/**
 * Prisma's unique-constraint error, duck-typed rather than caught by class.
 * Importing `Prisma.PrismaClientKnownRequestError` as a VALUE from
 * `@prisma/client` here would put a runtime dependency on the generated client
 * into a module that otherwise only receives one, and the shape is stable and
 * documented: `code === 'P2002'`, `meta.target` naming the offending columns.
 */
function isUniqueEmailViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== 'P2002') return false;
  const target = candidate.meta?.target;
  // Narrow to the email index specifically. A P2002 on anything else is a real
  // bug and must not be swallowed as "that address is taken" — that would turn
  // an id collision into a silent no-op signup.
  if (Array.isArray(target)) return target.includes('email');
  return typeof target === 'string' ? target.includes('email') : false;
}
