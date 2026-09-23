import { createHmac, randomBytes } from 'node:crypto';

import { z } from 'zod';

import type { OAuthTokens } from './token-vault.js';
import { safeEqual } from './token-vault.js';

/**
 * Authorisation-code OAuth 2.0, once, for every vendor this product connects to.
 *
 * ⚠ **This is shared infrastructure, not the ledger's.** It was written for the
 * four ledgers (D50, build brief Stage 1) and moved here on 21 Sep 2026 when the
 * Document Vault add-on needed the same flow for Google Drive and OneDrive.
 * Nothing in this file names a vendor: everything that differs is a field on
 * {@link OAuthVendor}, and what is left is the RFC, which is the same
 * everywhere.
 *
 * ⚠ **Two vendor branches used to live in `authorizeUrl` and no longer do.**
 * Sage's `filter=apiv3.1` was an `if (vendor.slug === 'sage')`, which is the
 * shape that makes a generic file quietly vendor-specific one line at a time.
 * It is now {@link OAuthVendor.authorizeParams}, and the first proof the
 * abstraction is the right one is that Google's `access_type=offline` +
 * `prompt=consent` — without which Google never issues a refresh token at all —
 * needed no code change to express.
 *
 * ## The state parameter is signed, not stored
 *
 * A connect request and its callback are two different HTTP requests minutes
 * apart, and something has to carry "which client business, started by whom,
 * and is this callback genuinely ours" between them. The usual answer is a row
 * in a table; this one is an HMAC over a small JSON payload, for the same
 * reason `portal-link.ts` signs its links — a table would be a schema change
 * for a value with a ten-minute life, and a signed value cannot be left behind
 * by a callback that never arrives.
 *
 * ⚠ **The state is not a credential and is not treated as one.** It proves the
 * callback belongs to a connect request this server started; it does not prove
 * who is holding it. The callback ALSO requires the practice session and
 * refuses when the two disagree, which is what stops a state URL captured from
 * a browser history from completing somebody else's connection.
 */

/** Ten minutes. Long enough to read a consent screen, short enough to be worthless later. */
const STATE_TTL_MS = 10 * 60 * 1000;

/** How the token endpoint wants the client credentials presented. */
export type TokenEndpointAuth = 'basic' | 'body';

/**
 * Everything this file needs to know about a vendor, and nothing else.
 *
 * Deliberately narrower than the ledger's `VendorConfig`, which also carries
 * attachment limits, idempotency windows and an API base — none of which an
 * OAuth flow has any business seeing. `VendorConfig` satisfies this
 * structurally, so the ledger passes its own table straight in.
 */
export interface OAuthVendor {
  /** Pinned into the signed state, so a state minted for one vendor cannot complete another's callback. */
  readonly slug: string;
  /** What a human sees when this vendor refuses something. */
  readonly label: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  /** Empty string means "send no scope parameter" — FreeAgent takes none, and a blank `scope=` is a request for nothing. */
  readonly scope: string;
  readonly tokenEndpointAuth: TokenEndpointAuth;
  /** How long a refresh token survives with nobody using it. Null where the vendor states none. */
  readonly refreshIdleDays: number | null;
  /**
   * Extra query parameters on the authorise URL.
   *
   * ⚠ For Google this is load-bearing rather than cosmetic: without
   * `access_type=offline` Google returns no refresh token at all, and without
   * `prompt=consent` it returns one only on a user's very first authorisation —
   * so a reconnect after a disconnect silently yields a connection that dies in
   * an hour and cannot be renewed.
   */
  readonly authorizeParams?: Readonly<Record<string, string>>;
}

export const OAuthStateSchema = z.object({
  /** The client business being connected. */
  b: z.string().min(1),
  /** The vendor slug, so a state minted for Xero cannot complete a Sage callback. */
  v: z.string().min(1),
  /** Who pressed Connect. Compared against the session on the callback. */
  a: z.string().min(1),
  /** Replay nonce. */
  n: z.string().min(1),
  /** Expiry, epoch milliseconds. */
  e: z.number().int().positive(),
});

export type OAuthState = z.infer<typeof OAuthStateSchema>;

/**
 * The token endpoint's answer, as any vendor may shape it.
 *
 * `passthrough` on purpose: Xero adds `id_token`, Intuit adds
 * `x_refresh_token_expires_in`, Google adds `id_token`, and a strict schema
 * would reject a vendor for being generous. Every field this codebase actually
 * uses is named and typed; the rest is ignored rather than trusted.
 */
const TokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    // ⚠ Absent on a REFRESH for a vendor that does not rotate. The caller keeps
    // the old one in that case — see the ledger's `token-store.ts`.
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().int().positive().optional(),
    token_type: z.string().optional(),
    scope: z.string().optional(),
    // Sage's name for it.
    refresh_token_expires_in: z.number().int().positive().optional(),
    // Intuit's name for the same thing.
    x_refresh_token_expires_in: z.number().int().positive().optional(),
  })
  .passthrough();

/** An OAuth error response. Every shape the vendors produce. */
const TokenErrorSchema = z
  .object({
    error: z.string().optional(),
    error_description: z.string().optional(),
    // Sage sometimes answers with a plain message.
    message: z.string().optional(),
  })
  .passthrough();

/** Our app's registration with one vendor. Never logged, never returned. */
export interface VendorCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

/** A failure talking to a token endpoint. Carries enough to act on, and no secret. */
export class OAuthError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export function signState(payload: Omit<OAuthState, 'n' | 'e'>, key: Buffer, now = Date.now()): string {
  const state: OAuthState = { ...payload, n: randomBytes(9).toString('base64url'), e: now + STATE_TTL_MS };
  const body = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  return `${body}.${hmac(body, key)}`;
}

/**
 * Verify a callback's `state`, or throw.
 *
 * Signature first, expiry second, and the signature comparison is constant-time
 * — the three lines a CSRF check is usually missing one of.
 */
export function verifyState(value: string, key: Buffer, now = Date.now()): OAuthState {
  const parts = value.split('.');
  if (parts.length !== 2) throw new OAuthError('That connection link is not one this server issued.', false);
  const [body, signature] = parts as [string, string];
  if (!safeEqual(signature, hmac(body, key))) {
    throw new OAuthError('That connection link is not one this server issued.', false);
  }
  let state: OAuthState;
  try {
    state = OAuthStateSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
  } catch {
    throw new OAuthError('That connection link is not one this server issued.', false);
  }
  if (state.e < now) {
    throw new OAuthError('That connection attempt took too long. Start it again from the client screen.', false);
  }
  return state;
}

/**
 * The vendor's consent URL.
 *
 * ⚠ **No PKCE, deliberately.** Every registration here is a CONFIDENTIAL client
 * holding a secret on a server, which is the case PKCE does not add to.
 */
export function authorizeUrl(vendor: OAuthVendor, credentials: VendorCredentials, state: string): string {
  const url = new URL(vendor.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', credentials.clientId);
  url.searchParams.set('redirect_uri', credentials.redirectUri);
  url.searchParams.set('state', state);
  if (vendor.scope !== '') url.searchParams.set('scope', vendor.scope);
  for (const [name, value] of Object.entries(vendor.authorizeParams ?? {})) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

/** Exchange the authorisation code for the first pair of tokens. */
export async function exchangeCode(
  vendor: OAuthVendor,
  credentials: VendorCredentials,
  code: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  now = Date.now(),
): Promise<OAuthTokens> {
  return postToken(
    vendor,
    credentials,
    { grant_type: 'authorization_code', code, redirect_uri: credentials.redirectUri },
    null,
    fetchImpl,
    now,
  );
}

/**
 * Trade a refresh token for a fresh pair.
 *
 * ⚠ **`previous` is not decoration.** Xero, QuickBooks, Sage and Microsoft all
 * rotate: the response carries a NEW refresh token and the one just sent is
 * dead. FreeAgent and Google do not, and omit the field — so the old value has
 * to be carried forward or the connection would be lost by a SUCCESSFUL
 * refresh, which is the funniest and worst version of this bug.
 */
export async function refreshTokens(
  vendor: OAuthVendor,
  credentials: VendorCredentials,
  previous: OAuthTokens,
  fetchImpl: typeof fetch = globalThis.fetch,
  now = Date.now(),
): Promise<OAuthTokens> {
  return postToken(
    vendor,
    credentials,
    { grant_type: 'refresh_token', refresh_token: previous.refreshToken },
    previous,
    fetchImpl,
    now,
  );
}

async function postToken(
  vendor: OAuthVendor,
  credentials: VendorCredentials,
  params: Record<string, string>,
  previous: OAuthTokens | null,
  fetchImpl: typeof fetch,
  now: number,
): Promise<OAuthTokens> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (vendor.tokenEndpointAuth === 'basic') {
    headers['Authorization'] =
      `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`;
  } else {
    body.set('client_id', credentials.clientId);
    body.set('client_secret', credentials.clientSecret);
  }

  let response: Response;
  try {
    response = await fetchImpl(vendor.tokenUrl, { method: 'POST', headers, body: body.toString() });
  } catch (error) {
    // The network, not the vendor. Retryable, and the message says which.
    throw new OAuthError(
      `${vendor.label} could not be reached (${error instanceof Error ? error.message : 'network error'}).`,
      true,
    );
  }

  const text = await response.text();
  if (!response.ok) throw tokenFailure(vendor, response, text);

  let parsed: z.infer<typeof TokenResponseSchema>;
  try {
    parsed = TokenResponseSchema.parse(JSON.parse(text));
  } catch {
    throw new OAuthError(`${vendor.label} answered the sign-in step with something this build cannot read.`, true);
  }

  const refreshToken = parsed.refresh_token ?? previous?.refreshToken;
  if (refreshToken === undefined) {
    throw new OAuthError(`${vendor.label} did not return the key needed to keep the connection alive.`, false);
  }

  // Default 30 minutes when a vendor omits `expires_in`: shorter than every
  // vendor actually issues, so the worst case is refreshing early.
  const accessSeconds = parsed.expires_in ?? 30 * 60;
  const refreshSeconds = parsed.refresh_token_expires_in ?? parsed.x_refresh_token_expires_in ?? null;
  const idleMs = vendor.refreshIdleDays === null ? null : vendor.refreshIdleDays * 24 * 60 * 60 * 1000;
  const refreshExpiresMs = refreshSeconds !== null ? refreshSeconds * 1000 : idleMs;

  return {
    accessToken: parsed.access_token,
    refreshToken,
    accessExpiresAt: new Date(now + accessSeconds * 1000).toISOString(),
    refreshExpiresAt: refreshExpiresMs === null ? null : new Date(now + refreshExpiresMs).toISOString(),
    scope: parsed.scope ?? null,
  };
}

/**
 * A token-endpoint refusal, turned into something a practice can act on.
 *
 * ⚠ **`invalid_grant` is the one that matters and the one to get right.** It
 * means the refresh token is dead — revoked at the vendor, already rotated, or
 * idle past its window — and no retry will ever fix it. Reporting it as
 * retryable would hide a revoked connection behind a queue that never drains,
 * which is exactly the failure the "break it on purpose" list exists to catch.
 *
 * Nothing from the vendor's body reaches the message. `error_description` is
 * written for a developer and quotes submitted values back; the code goes to
 * the caller and the whole pair belongs in a log, not on a screen.
 */
function tokenFailure(vendor: OAuthVendor, response: Response, text: string): OAuthError {
  const parsed = TokenErrorSchema.safeParse(safeJson(text));
  const code = parsed.success ? (parsed.data.error ?? '') : '';
  if (code === 'invalid_grant' || response.status === 400) {
    return new OAuthError(
      `The ${vendor.label} connection is no longer valid — it was disconnected or expired at ${vendor.label}. Reconnect it from the client's Connections screen.`,
      false,
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new OAuthError(`${vendor.label} refused this app's credentials. This needs attention, not a retry.`, false);
  }
  if (response.status === 429) {
    return new OAuthError(`${vendor.label} is rate-limiting this practice. It will be tried again.`, true);
  }
  return new OAuthError(
    `${vendor.label} could not complete the sign-in step (HTTP ${response.status}).`,
    response.status >= 500,
  );
}

function hmac(body: string, key: Buffer): string {
  // A distinct purpose string: the same key also seals tokens, and a value
  // signed for one job must not verify for the other. The literal keeps its
  // original `ledger-` stem so states already in flight during the 21 Sep 2026
  // move stayed valid; the slug inside the payload is what separates vendors.
  return createHmac('sha256', key).update(`ledger-oauth-state.v1.${body}`).digest('base64url');
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
