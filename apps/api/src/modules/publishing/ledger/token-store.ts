import { Logger } from '@nestjs/common';

import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../../common/db/scoped-db.js';
import { OAuthError, refreshTokens, type VendorCredentials } from '../../../common/oauth/oauth.js';
import { type OAuthTokens, seal, unseal } from '../../../common/oauth/token-vault.js';
import type { IntegrationKind } from '@prisma/client';

import { type VendorConfig, type VendorSlug } from './vendors.js';

/**
 * The token vault's read/refresh/persist cycle — and the single most likely
 * source of a silent, unrecoverable bug in this whole feature (build brief).
 *
 * ## Why rotation is dangerous
 *
 * Xero, QuickBooks and Sage all **rotate** the refresh token: the moment one is
 * used, it dies and a new one comes back in the same response. Three things
 * then have to be true or the connection is gone for good, with no error at the
 * moment it breaks and a `invalid_grant` days later:
 *
 * 1. The new token must be **persisted**. Losing the response loses the
 *    connection — a successful refresh that fails to save is worse than a
 *    failed one.
 * 2. It must not be **overwritten by an older one**. Two processes refreshing
 *    at once both hold a "new" token; the loser writing last would install a
 *    token the vendor has already retired.
 * 3. The write must not sit inside a transaction that was open across the HTTP
 *    call, because that is the rule this whole module exists under.
 *
 * ## How all three are satisfied without a lock table
 *
 * The write is **conditional on the blob we refreshed from still being the one
 * in the row** — `updateMany({ where: { id, tokenRef: <exactly what we read> } })`.
 * Postgres compares the whole ciphertext, so a row somebody else has already
 * advanced matches zero rows, our result is discarded, and theirs is re-read
 * and used. That is optimistic concurrency with the column that already exists,
 * and it needs no schema change, no advisory lock and no transaction held open
 * across the network.
 *
 * On top of that sits an ordinary **in-process promise mutex**, which is not a
 * correctness mechanism and is not pretending to be one: it stops the common
 * case — a 500-item batch in one worker noticing an expired token on item 1 and
 * again on items 2 through 500 — from making 500 refresh calls, 499 of which
 * would fail with `invalid_grant` because the first one rotated the token out
 * from under them.
 */

/** Refresh this long before the access token actually dies. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

/** One connection, ready to call a vendor with. */
export interface ResolvedConnection {
  readonly integrationId: string;
  readonly vendor: VendorConfig;
  /** The vendor's own organisation identifier — Xero tenant, Intuit realm, Sage business. */
  readonly orgRef: string | null;
  readonly accessToken: string;
}

/** Our app's registration for each vendor, resolved from config. Never logged. */
export type CredentialsLookup = (slug: VendorSlug) => VendorCredentials | null;

/**
 * Raised when there is nothing to refresh WITH — no row, no stored tokens, no
 * app credentials. The world is broken rather than the vendor saying no, which
 * per the adapter contract is the one case that throws.
 */
export class LedgerConnectionUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerConnectionUnavailable';
  }
}

/**
 * In-flight refreshes, keyed by integration id, shared across every store in
 * this process. Module-level because two `LedgerTokenStore` instances in one
 * process are still one process racing itself.
 */
const inFlight = new Map<string, Promise<OAuthTokens>>();

export class LedgerTokenStore {
  private readonly logger = new Logger(LedgerTokenStore.name);

  constructor(
    private readonly prisma: PrismaClient,
    /** The tenant context every read and write here runs under. RLS, not a filter. */
    private readonly ctx: ScopeContext,
    /** `INTEGRATION_TOKEN_KEY`, already parsed to 32 bytes. */
    private readonly vaultKey: Buffer,
    private readonly credentials: CredentialsLookup,
    /**
     * ⚠ **The vendor config, RESOLVED AGAINST THIS DEPLOYMENT'S ENVIRONMENT.**
     *
     * Required, and deliberately not defaulted to `vendorForKind`. This class
     * used to call that directly, which returns the STATIC config and therefore
     * the production host — so every call after connect went somewhere the
     * connect-time token was never issued for. FreeAgent answered 401 on
     * `/categories` while `/company` had succeeded moments earlier through the
     * sandbox host (20 Sep 2026), and QuickBooks only appeared to work because
     * its static base happened to be the sandbox one.
     *
     * A default here would put that bug back the first time a call site forgot.
     */
    private readonly vendorFor: (kind: IntegrationKind) => VendorConfig | null,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * A usable access token for one connection, refreshing first if it is close
   * to expiry.
   *
   * ⚠ Every database touch is its own short scoped transaction and the vendor
   * call happens between them, never inside one.
   */
  async connection(integrationId: string): Promise<ResolvedConnection> {
    const row = await this.read(integrationId);
    const fresh = Date.parse(row.tokens.accessExpiresAt) - this.now() > REFRESH_MARGIN_MS;
    if (fresh) {
      return { integrationId, vendor: row.vendor, orgRef: row.orgRef, accessToken: row.tokens.accessToken };
    }
    const tokens = await this.refresh(integrationId, row);
    return { integrationId, vendor: row.vendor, orgRef: row.orgRef, accessToken: tokens.accessToken };
  }

  /**
   * Refresh whether or not it is due — what the scheduler calls to keep an idle
   * connection's REFRESH token from ageing out (Xero 60 days, Sage 31,
   * QuickBooks 100), and what the "prove the rotated token persisted" test
   * drives directly.
   */
  async forceRefresh(integrationId: string): Promise<void> {
    await this.refresh(integrationId, await this.read(integrationId));
  }

  /** Record that a vendor answered. Health is what the connection screen renders. */
  async markHealthy(integrationId: string): Promise<void> {
    await scopedDb(this.prisma, this.ctx, (db) =>
      db.integration.updateMany({
        where: { id: integrationId },
        data: { health: 'OK', lastSyncAt: new Date(), lastErrorAt: null, lastErrorMessage: null },
      }),
    );
  }

  /**
   * Record that it did not.
   *
   * ⚠ `message` is OUR sentence, never a vendor body. It is rendered to a
   * practice on the connection screen and stored, and a vendor's error text
   * quotes submitted values back — which here would be somebody's books.
   */
  async markUnhealthy(integrationId: string, message: string): Promise<void> {
    await scopedDb(this.prisma, this.ctx, (db) =>
      db.integration.updateMany({
        where: { id: integrationId },
        data: { health: 'ERROR', lastErrorAt: new Date(), lastErrorMessage: message.slice(0, 500) },
      }),
    );
  }

  private async read(integrationId: string): Promise<StoredConnection> {
    const row = await scopedDb(this.prisma, this.ctx, (db) => loadIntegration(db, integrationId));
    if (row === null) {
      throw new LedgerConnectionUnavailable('that ledger connection is not reachable for this practice');
    }
    const vendor = this.vendorFor(row.kind);
    if (vendor === null) {
      throw new LedgerConnectionUnavailable(`${row.kind} is an export destination, not a ledger connection`);
    }
    if (!row.isActive) {
      throw new LedgerConnectionUnavailable(`the ${vendor.label} connection for this client is switched off`);
    }
    if (row.tokenRef === null || row.tokenRef === '') {
      throw new LedgerConnectionUnavailable(`the ${vendor.label} connection for this client has never been completed`);
    }
    return { vendor, orgRef: row.orgRef, blob: row.tokenRef, tokens: unseal(row.tokenRef, this.vaultKey) };
  }

  /**
   * The refresh itself. Coalesced per connection, conditional on write.
   */
  private async refresh(integrationId: string, stored: StoredConnection): Promise<OAuthTokens> {
    const existing = inFlight.get(integrationId);
    if (existing !== undefined) return existing;

    const work = this.doRefresh(integrationId, stored).finally(() => inFlight.delete(integrationId));
    inFlight.set(integrationId, work);
    return work;
  }

  private async doRefresh(integrationId: string, stored: StoredConnection): Promise<OAuthTokens> {
    const credentials = this.credentials(stored.vendor.slug);
    if (credentials === null) {
      throw new LedgerConnectionUnavailable(
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
        // ⚠ THE CONDITION IS THE WHOLE POINT. `tokenRef` must still be the blob
        // this refresh started from; if another process already advanced it,
        // this matches nothing and ours is dropped rather than installed over a
        // token the vendor has since issued.
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
      // have been retired by the vendor, so it must not be used.
      this.logger.log(`ledger refresh for ${integrationId} lost a race — using the token that was written instead`);
      return (await this.read(integrationId)).tokens;
    }
    return renewed;
  }
}

interface StoredConnection {
  readonly vendor: VendorConfig;
  readonly orgRef: string | null;
  /** The exact ciphertext read from the row — the optimistic-concurrency witness. */
  readonly blob: string;
  readonly tokens: OAuthTokens;
}

async function loadIntegration(db: ScopedClient, integrationId: string) {
  return db.integration.findUnique({
    where: { id: integrationId },
    select: { id: true, kind: true, orgRef: true, tokenRef: true, isActive: true },
  });
}

/**
 * Persist a brand-new connection, or replace the tokens on one that is being
 * reconnected.
 *
 * ⚠ Upsert rather than create: `@@unique([businessId, kind])` means a practice
 * reconnecting a client they already connected is an UPDATE, and a create would
 * fail with a constraint violation at exactly the moment somebody is fixing a
 * broken connection. Reconnecting also clears the error state — a connection
 * that has just proved itself is not still unhealthy.
 */
export async function persistConnection(
  db: ScopedClient,
  input: {
    readonly businessId: string;
    readonly kind: ResolvedConnection['vendor']['kind'];
    readonly orgRef: string | null;
    readonly orgName: string | null;
    readonly tokens: OAuthTokens;
    readonly vaultKey: Buffer;
  },
): Promise<{ readonly id: string }> {
  const data = {
    orgRef: input.orgRef,
    orgName: input.orgName,
    tokenRef: seal(input.tokens, input.vaultKey),
    tokenExpiresAt: new Date(input.tokens.accessExpiresAt),
    health: 'OK',
    isActive: true,
    lastErrorAt: null,
    lastErrorMessage: null,
  };
  return db.integration.upsert({
    where: { businessId_kind: { businessId: input.businessId, kind: input.kind } },
    create: { businessId: input.businessId, kind: input.kind, ...data },
    update: data,
    select: { id: true },
  });
}
