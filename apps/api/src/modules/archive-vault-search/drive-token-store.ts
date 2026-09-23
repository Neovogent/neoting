import { HttpStatus, Logger } from '@nestjs/common';

import { OAuthError, refreshTokens, type VendorCredentials } from '../../common/oauth/oauth.js';
import { type OAuthTokens, seal, unseal } from '../../common/oauth/token-vault.js';
import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { AppException } from '../../common/problem/problem.js';
import { driveFor, type DriveSlug, type DriveVendor } from './drive-vendors.js';

/**
 * Read a drive connection's tokens, refreshing when they are stale (D51).
 *
 * ⚠ **This is the ledger's `token-store.ts` reasoning applied to two more
 * vendors, and it is deliberately NOT a reuse of that file.** That one is
 * `publishing`-internal, types against the ledger's `VendorConfig`, and carries
 * ledger semantics — the org ref, the sync health, the "this kind is an export
 * destination, not a ledger connection" refusal. Importing it would have meant
 * teaching the ledger about drives.
 *
 * What IS shared is everything that matters for correctness: `seal`/`unseal`
 * and `refreshTokens` are the same functions, out of `common/oauth/`, which is
 * why there is one AES-256-GCM implementation in this repository and not two.
 *
 * ## The rotation rule, which is where this goes wrong silently
 *
 * ⚠ **Microsoft rotates refresh tokens; Google does not.** So OneDrive is in
 * the same class as Xero, QuickBooks and Sage — the old refresh token dies the
 * instant it is used — and Google is in FreeAgent's class, where the response
 * carries no new token and the old one must be carried forward or a SUCCESSFUL
 * refresh destroys the connection.
 *
 * `refreshTokens` already handles the carry-forward. What lives here is the
 * other half: the write is **conditional on the ciphertext we refreshed from
 * still being the one in the row** — `updateMany({ where: { id, tokenRef } })`.
 * Postgres compares the whole blob, so a row another process has already
 * advanced matches zero rows, our result is discarded, and theirs is re-read.
 * Optimistic concurrency on a column that already exists: no lock table, no
 * schema change, and no transaction held open across the network.
 */

/** Refresh this long before the access token actually dies. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

/** One connection, ready to call a drive with. */
export interface ResolvedDrive {
  readonly integrationId: string;
  readonly vendor: DriveVendor;
  readonly accessToken: string;
}

/** Our app's registration for each drive, resolved from config. Never logged. */
export type DriveCredentialsLookup = (slug: DriveSlug) => VendorCredentials | null;

/**
 * In-process coalescing, per connection.
 *
 * Not a correctness mechanism and not pretending to be one — the conditional
 * write above is. This stops the common case: a run of four hundred documents
 * noticing an expired token on file 1 and again on files 2 through 400, making
 * four hundred refresh calls of which 399 would fail `invalid_grant` because
 * the first rotated the token out from under them.
 */
const inFlight = new Map<string, Promise<OAuthTokens>>();

export class DriveTokenStore {
  private readonly logger = new Logger(DriveTokenStore.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ScopeContext,
    private readonly vaultKey: Buffer,
    private readonly credentials: DriveCredentialsLookup,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** A usable access token for this connection, refreshed first if it is close to dying. */
  async resolve(integrationId: string): Promise<ResolvedDrive> {
    const stored = await this.read(integrationId);
    const expiresAt = Date.parse(stored.tokens.accessExpiresAt);
    const fresh =
      Number.isFinite(expiresAt) && expiresAt - REFRESH_MARGIN_MS > this.now()
        ? stored.tokens
        : await this.refresh(integrationId, stored);
    return { integrationId, vendor: stored.vendor, accessToken: fresh.accessToken };
  }

  /** Record that a drive answered. Health is what the Vault tab renders. */
  async markHealthy(integrationId: string): Promise<void> {
    await scopedDb(this.prisma, this.ctx, (db) =>
      db.integration.updateMany({
        where: { id: integrationId },
        data: { health: 'OK', lastSyncAt: new Date(), lastErrorAt: null, lastErrorMessage: null },
      }),
    );
  }

  async markUnhealthy(integrationId: string, reason: string): Promise<void> {
    await scopedDb(this.prisma, this.ctx, (db) =>
      db.integration.updateMany({
        where: { id: integrationId },
        // ⚠ 500 characters. The column takes more, but this reaches a client's
        // screen and a vendor that answers with a page of HTML would otherwise
        // put a page of HTML in a portal.
        data: { health: 'ERROR', lastErrorAt: new Date(), lastErrorMessage: reason.slice(0, 500) },
      }),
    );
  }

  private async read(integrationId: string): Promise<StoredDrive> {
    const row = await scopedDb(this.prisma, this.ctx, (db) =>
      db.integration.findFirst({
        where: { id: integrationId },
        select: { id: true, kind: true, tokenRef: true, isActive: true },
      }),
    );
    if (row === null) throw driveUnavailable('that drive connection no longer exists');

    const vendor = driveFor(row.kind);
    if (vendor === null) throw driveUnavailable(`${row.kind} is not a cloud drive`);
    if (!row.isActive) throw driveUnavailable(`the ${vendor.label} connection for this client is switched off`);
    if (row.tokenRef === null) {
      throw driveUnavailable(`the ${vendor.label} connection for this client was never completed`);
    }

    return { vendor, blob: row.tokenRef, tokens: unseal(row.tokenRef, this.vaultKey) };
  }

  private async refresh(integrationId: string, stored: StoredDrive): Promise<OAuthTokens> {
    const existing = inFlight.get(integrationId);
    if (existing !== undefined) return existing;
    const work = this.doRefresh(integrationId, stored).finally(() => inFlight.delete(integrationId));
    inFlight.set(integrationId, work);
    return work;
  }

  private async doRefresh(integrationId: string, stored: StoredDrive): Promise<OAuthTokens> {
    const credentials = this.credentials(stored.vendor.slug);
    if (credentials === null) {
      throw driveUnavailable(
        `this deployment carries no ${stored.vendor.label} application credentials, so its connections cannot be renewed`,
      );
    }

    let renewed: OAuthTokens;
    try {
      // ⚠ THE VENDOR CALL, OUTSIDE EVERY TRANSACTION.
      renewed = await refreshTokens(stored.vendor, credentials, stored.tokens, this.fetchImpl, this.now());
    } catch (error) {
      const message =
        error instanceof OAuthError ? error.message : `${stored.vendor.label} could not renew this connection.`;
      await this.markUnhealthy(integrationId, message);
      throw error;
    }

    const sealed = seal(renewed, this.vaultKey);
    const written = await scopedDb(this.prisma, this.ctx, (db) =>
      db.integration.updateMany({
        // ⚠ THE CONDITION IS THE WHOLE POINT — see the header. `tokenRef` must
        // still be the blob this refresh started from.
        where: { id: integrationId, tokenRef: stored.blob },
        data: {
          tokenRef: sealed,
          tokenExpiresAt: new Date(renewed.accessExpiresAt),
          health: 'OK',
          lastErrorAt: null,
          lastErrorMessage: null,
        },
      }),
    );

    if (written.count === 0) {
      // Somebody else won the race. Theirs is the live token; ours may already
      // have been retired by Microsoft, so it must not be used.
      this.logger.log(`drive refresh for ${integrationId} lost a race — using the token that was written instead`);
      return (await this.read(integrationId)).tokens;
    }
    return renewed;
  }
}

interface StoredDrive {
  readonly vendor: DriveVendor;
  /** The exact ciphertext read from the row — the optimistic-concurrency witness. */
  readonly blob: string;
  readonly tokens: OAuthTokens;
}

/**
 * A connection that cannot be used right now.
 *
 * `NT-INT-001`, 409 — the same code and status the contract gives "no drive of
 * that kind is connected". From a client's point of view a revoked connection
 * and an absent one are the same situation with the same fix, which is to
 * connect it again from the Vault tab.
 */
export function driveUnavailable(reason: string): AppException {
  return new AppException('NT-INT-001', HttpStatus.CONFLICT, 'Drive connection unavailable', reason);
}
