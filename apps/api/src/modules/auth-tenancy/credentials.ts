import type { PrismaClient } from '../../common/db/prisma.js';
import type { Env } from '../../config/env.js';
import { verifyDemoPassword } from './demo-credentials.js';
import { DUMMY_PASSWORD_HASH, verifyPasswordHash } from './password.js';

/**
 * "Did this email and password authenticate anyone, and is that account
 * usable?" — asked once, in one place (launch stage A14).
 *
 * A1 wrote this inside `auth.service.ts` when login was the only caller. A14
 * added a second: **TOTP enrolment is authenticated by password alone**, which
 * is the one route that cannot require a second factor, because its entire
 * purpose is that the caller does not have one yet. A second copy of the
 * password rules would be a second place for "an unverified address may not
 * log in" to stop being true, and the copy that drifted would be the one on the
 * endpoint that hands out authenticator seeds.
 *
 * ## ⚠ The privileged, unscoped `users` read
 *
 * {@link findCredentialRow} runs OUTSIDE `scopedDb`, and that is the same
 * documented exemption `session-scope.ts` takes, on the same grounds: `users`
 * carries no RLS (it is one of the actor tables the policies themselves read —
 * `prisma/CLAUDE.md`, issue #17), and this query is the bootstrap that PRODUCES
 * the identity every scoped query later needs, so it cannot run inside one.
 * **Keep the privileged surface to exactly this query.**
 *
 * ## ⚠ Every branch costs the same work
 *
 * The scrypt burns below always run, for an address that does not exist as much
 * as for one that does, and neither short-circuits the other. Skipping work on
 * a miss makes the miss measurably faster, and a measurable difference between
 * "no such account" and "wrong password" is the account-enumeration oracle that
 * `NT-AUTH-003` — one code for every login failure — exists to close. The same
 * discipline continues into the second factor: `verifySecondFactor` burns an
 * HMAC even when there is no enrolment to check.
 */

/** What a credential check needs, and nothing else. */
export interface CredentialRow {
  readonly id: string;
  readonly kind: string;
  /** Null for a SYSTEM actor. A user with no login address cannot be labelled in an authenticator app. */
  readonly email: string | null;
  readonly passwordHash: string | null;
  readonly emailVerified: boolean;
  readonly deactivatedAt: Date | null;
  /** The AES-GCM envelope holding the TOTP seed and the recovery-code hashes (`totp-secret.ts`). */
  readonly totpSecretRef: string | null;
}

/**
 * The outcome, shaped so the two callers can answer differently **without
 * either one re-deriving the rules**.
 *
 * `unverified` is the whole reason this is not a boolean. Login must collapse
 * it into the uniform `NT-AUTH-003`: "verify your email first" is friendlier
 * and is a confirmed answer to "does this firm have an account here", handed to
 * whoever guessed the address. Enrolment may name it (`NT-AUTH-006`), because
 * by then the caller has already proved the password — there is nothing left to
 * enumerate, and "check your email" is the only thing that gets them moving.
 */
export type CredentialVerdict =
  | { readonly ok: true; readonly user: CredentialRow }
  | { readonly ok: false; readonly reason: 'no-match' }
  | { readonly ok: false; readonly reason: 'unverified'; readonly user: CredentialRow };

const NO_MATCH: CredentialVerdict = Object.freeze({ ok: false, reason: 'no-match' });

/** The privileged by-email lookup. See the header for why it is not inside `scopedDb`. */
export async function findCredentialRow(prisma: PrismaClient, email: string): Promise<CredentialRow | null> {
  return prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      kind: true,
      email: true,
      passwordHash: true,
      emailVerified: true,
      deactivatedAt: true,
      totpSecretRef: true,
    },
  });
}

/**
 * Check the password against the row, in constant work.
 *
 * `email` is the NORMALISED string the caller submitted rather than
 * `user.email`, because the demo-fixture table is keyed on what was typed and
 * the row may be null.
 *
 * The demo-fixture branch is a DEVELOPMENT fallback and nothing more:
 * `verifyDemoPassword` answers null under `NODE_ENV=production` before it reads
 * anything, so the refusal is the signature rather than a call-site convention.
 * It still requires a real, verified, active `users` row — the seed creates one
 * for both fixture accounts — because authenticating against a user who does
 * not exist mints a credential that fails on every subsequent request, which is
 * the confusing failure this module's notes record having hit before.
 */
export function verifyCredentials(
  user: CredentialRow | null,
  email: string,
  password: string,
  nodeEnv: Env['NODE_ENV'],
): CredentialVerdict {
  // ⚠ BOTH ALWAYS RUN, BEFORE ANY BRANCH. See the header.
  const storedMatched = verifyPasswordHash(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  const demoUserId = verifyDemoPassword(email, password, nodeEnv);

  if (user === null) return NO_MATCH;
  // A SYSTEM actor has no person behind it; a deactivated user is not an actor.
  if (user.kind !== 'HUMAN') return NO_MATCH;
  if (user.deactivatedAt !== null) return NO_MATCH;

  const stored = user.passwordHash !== null && storedMatched;
  const demo = demoUserId !== null && demoUserId === user.id;
  if (!stored && !demo) return NO_MATCH;

  // The password is right. Whether the ACCOUNT is usable is a separate
  // question, and the two callers answer it differently — see CredentialVerdict.
  if (!user.emailVerified) return { ok: false, reason: 'unverified', user };
  return { ok: true, user };
}
