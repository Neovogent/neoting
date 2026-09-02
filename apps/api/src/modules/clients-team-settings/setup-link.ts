import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The **setup link** — how a client first reaches the product (SoT §24.5 step 2,
 * D45, D47).
 *
 * The accountant adds a client; the client is emailed a short setup link and
 * signs in with a code (`POST /portal/sign-in-codes` → `POST
 * /portal/onboarding-sessions`, both of which take a `setupToken`). This file
 * mints that token and nothing else verifies it here.
 *
 * ## The token is a database row, not a signature
 *
 * `invites.token_hash` exists, is `@unique`, and the contract says exactly where
 * the token lives: *"It exists in the email and in `invites.token_hash`, and
 * nowhere else — an invite readable from an API response is an invite anyone
 * with read access can accept."* So the mechanism is the storage the schema
 * already provides rather than a second HMAC scheme beside
 * `PORTAL_LINK_SECRET`:
 *
 * - it can be **revoked** (delete the row) and **consumed** (`accepted_at`),
 *   which a stateless signed token cannot be without a second store anyway;
 * - it needs **no new secret** to rotate, and no boot gate to fail closed on;
 * - the expiry is a column, so "this link stopped working" has an answer a
 *   human can read in the database.
 *
 * **Only the hash is stored.** A database read — a backup, a support query, a
 * leaked dump — must not yield a working link to a client's financial records.
 *
 * ⚠ **The verifier is stage A2's** (`modules/portal`), and it must hash the
 * presented `setupToken` with {@link hashSetupToken} and look the row up by
 * `token_hash`. That is why the function is on this module's public seam: two
 * implementations of "how is this token hashed" is a login that works on one
 * side and not the other.
 */

/**
 * 32 bytes of CSPRNG entropy, base64url — 256 bits, URL-safe, no padding to be
 * mangled by an email client that helpfully wraps a long line.
 */
export function mintSetupToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * `sha256(token)`, hex — what goes in `invites.token_hash`.
 *
 * A plain hash rather than a password KDF, deliberately and unusually: the input
 * is 256 bits of CSPRNG output, not a human-chosen secret, so there is no
 * dictionary to slow an attacker down through. Argon2 here would buy nothing and
 * cost every portal sign-in a CPU-second.
 */
export function hashSetupToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex digests, for the verifier that eventually
 * compares one it computed against one it read.
 *
 * A lookup **by** `token_hash` (the indexed, unique column) is the expected path
 * and leaks nothing; this exists for the branch that has a row in hand already.
 */
export function setupTokenHashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * How long a setup link lasts.
 *
 * Seven days, not the chase link's 24 hours: a chase link is sent to someone
 * who is expecting it about a receipt they remember, while this one lands on a
 * client who has never heard of us and may be on holiday. Long enough to be
 * usable, short enough that a forwarded old email is not a standing key to
 * someone's books. The email states the date it stops working, so the promise is
 * visible rather than implied.
 */
export const SETUP_LINK_TTL_DAYS = 7;

export function setupLinkExpiry(nowMs: number): Date {
  return new Date(nowMs + SETUP_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * The path the client lands on, and the query parameter the token arrives as.
 *
 * `setupToken` is the contract's own name for it (`PortalSignInCodeRequest`,
 * `PortalOnboardingSessionRequest`), so the screen that reads it off the URL and
 * the endpoint that receives it use one word.
 */
export const SETUP_LINK_PATH = '/app/setup';

/**
 * The address a COLLEAGUE's invitation lands on, and the query parameter it
 * arrives as.
 *
 * A different path from {@link SETUP_LINK_PATH} because it is a different
 * journey with a different outcome: `/app/setup` opens a CLIENT's portal with
 * an emailed six-digit code and never a password, while this one creates a user
 * who chooses a password and enrols an authenticator. One path serving both
 * would have to branch on what the token turned out to be — after the screen had
 * already been drawn.
 *
 * `token`, not `setupToken`: the contract's own name for this one
 * (`InvitationPreviewRequest.token`, `InvitationAcceptanceRequest.token`), so
 * the screen that reads it off the URL and the endpoints that receive it use one
 * word.
 *
 * ⚠ **The screen must scrub it out of the address bar before its first
 * request** — it is a credential, and every moment it sits in `location.search`
 * it is in the history and in the next outbound `Referer`. The same rule
 * `/signup/verify` follows.
 */
export const INVITE_LINK_PATH = '/invite';

/**
 * The public web origin, as a fallback.
 *
 * ✅ **`config/env.ts` HAS an `APP_ORIGIN` key now**, and this constant is no
 * longer standing in for a missing one — the composition root passes
 * `env.APP_ORIGIN` and this value is what the schema defaults that variable to.
 * It stays exported because `setup-link.test.ts` builds links with it and
 * because a caller constructing the service by hand should not have to invent an
 * origin.
 */
export const DEFAULT_APP_ORIGIN = 'https://app.neoting.neovogent.com';

/** `<origin>/app/setup?setupToken=<token>` — the whole of the client's link. */
export function buildSetupLink(appOrigin: string, token: string): string {
  return `${trimOrigin(appOrigin)}${SETUP_LINK_PATH}?setupToken=${encodeURIComponent(token)}`;
}

/** `<origin>/invite?token=<token>` — the whole of the colleague's link. */
export function buildInviteLink(appOrigin: string, token: string): string {
  return `${trimOrigin(appOrigin)}${INVITE_LINK_PATH}?token=${encodeURIComponent(token)}`;
}

function trimOrigin(appOrigin: string): string {
  return appOrigin.endsWith('/') ? appOrigin.slice(0, -1) : appOrigin;
}
