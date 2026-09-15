import { createHmac, randomBytes } from 'node:crypto';

import { z } from 'zod';

import type { LedgerTokens } from './token-vault.js';
import { safeEqual } from './token-vault.js';
import { QBO_DISCOVERY, type VendorConfig } from './vendors.js';

/**
 * Authorisation-code OAuth 2.0, once, for all four ledgers (D50, build brief
 * Stage 1).
 *
 * There is no per-vendor branch in this file. Everything that differs between
 * Xero, QuickBooks, Sage and FreeAgent is a field in `vendors.ts`; what is left
 * is the RFC, and the RFC is the same everywhere. The one exception is written
 * down where it happens: QuickBooks' endpoints are read from Intuit's discovery
 * document rather than hardcoded, because the App Assessment Questionnaire asks
 * whether we do that.
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
 * The token endpoint's answer, as any of the four may shape it.
 *
 * `passthrough` on purpose: Xero adds `id_token`, Intuit adds
 * `x_refresh_token_expires_in`, and a strict schema would reject a vendor for
 * being generous. Every field this codebase actually uses is named and typed;
 * the rest is ignored rather than trusted.
 */
const TokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    // ⚠ Absent on a REFRESH for a vendor that does not rotate. The caller keeps
    // the old one in that case — see `token-store.ts`.
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

/** An OAuth error response. Both shapes the four produce. */
const TokenErrorSchema = z
  .object({
    error: z.string().optional(),
    error_description: z.string().optional(),
    // Sage sometimes answers with a plain message.
    message: z.string().optional(),
  })
  .passthrough();

const DiscoverySchema = z
  .object({
    authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
    revocation_endpoint: z.string().url().optional(),
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
 * Where the browser is sent to ask the practice for consent.
 *
 * `response_type=code` on all four; PKCE is deliberately absent because all
 * four of our registrations are CONFIDENTIAL clients holding a secret on a
 * server, which is the case PKCE does not add to. FreeAgent takes no `scope`
 * parameter at all, so an empty scope is omitted rather than sent blank — a
 * blank `scope=` is a request for no permissions on at least one of the four.
 */
export function authorizeUrl(vendor: VendorConfig, credentials: VendorCredentials, state: string): string {
  const url = new URL(vendor.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', credentials.clientId);
  url.searchParams.set('redirect_uri', credentials.redirectUri);
  url.searchParams.set('state', state);
  if (vendor.scope !== '') url.searchParams.set('scope', vendor.scope);
  // Sage routes consent through a filter that picks which of its products the
  // grant is for. Without it the practice is offered the wrong product list.
  if (vendor.slug === 'sage') url.searchParams.set('filter', 'apiv3.1');
  return url.toString();
}

/**
 * Intuit's endpoints, read rather than assumed.
 *
 * Cached for the life of the process: the document changes on Intuit's release
 * schedule, not ours, and re-fetching it before every connect would add a
 * network dependency to a screen that has one already. A failure here falls
 * back to the table's hardcoded values rather than refusing to connect —
 * discovery is a correctness nicety, and being unable to reach it is not a
 * reason a practice cannot connect their books.
 */
let discoveryCache: { authorizeUrl: string; tokenUrl: string } | null = null;

export async function resolveQuickBooksEndpoints(
  sandbox: boolean,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ authorizeUrl: string; tokenUrl: string } | null> {
  if (discoveryCache !== null) return discoveryCache;
  try {
    const response = await fetchImpl(sandbox ? QBO_DISCOVERY.sandbox : QBO_DISCOVERY.production);
    if (!response.ok) return null;
    const document = DiscoverySchema.parse(await response.json());
    discoveryCache = { authorizeUrl: document.authorization_endpoint, tokenUrl: document.token_endpoint };
    return discoveryCache;
  } catch {
    return null;
  }
}

/** Test seam — the cache is process-wide, so a test that populated it must be able to clear it. */
export function resetDiscoveryCache(): void {
  discoveryCache = null;
}

/** Exchange the authorisation code for the first pair of tokens. */
export async function exchangeCode(
  vendor: VendorConfig,
  credentials: VendorCredentials,
  code: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  now = Date.now(),
): Promise<LedgerTokens> {
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
 * ⚠ **`previous` is not decoration.** Xero, QuickBooks and Sage rotate: the
 * response carries a NEW refresh token and the one just sent is dead. FreeAgent
 * does not, and omits the field — so the old value has to be carried forward or
 * the connection would be lost by a successful refresh, which is the funniest
 * and worst version of this bug.
 */
export async function refreshTokens(
  vendor: VendorConfig,
  credentials: VendorCredentials,
  previous: LedgerTokens,
  fetchImpl: typeof fetch = globalThis.fetch,
  now = Date.now(),
): Promise<LedgerTokens> {
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
  vendor: VendorConfig,
  credentials: VendorCredentials,
  params: Record<string, string>,
  previous: LedgerTokens | null,
  fetchImpl: typeof fetch,
  now: number,
): Promise<LedgerTokens> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (vendor.tokenEndpointAuth === 'basic') {
    headers['Authorization'] = `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`;
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
  // one of the four actually issues, so the worst case is refreshing early.
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
function tokenFailure(vendor: VendorConfig, response: Response, text: string): OAuthError {
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
  return new OAuthError(`${vendor.label} could not complete the sign-in step (HTTP ${response.status}).`, response.status >= 500);
}

function hmac(body: string, key: Buffer): string {
  // A distinct purpose string: the same key also seals tokens, and a value
  // signed for one job must not verify for the other.
  return createHmac('sha256', key).update(`ledger-oauth-state.v1.${body}`).digest('base64url');
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
