import { HttpStatus, Logger } from '@nestjs/common';
import type { Integration as IntegrationRow } from '@prisma/client';

import type { Integration, IntegrationAuthorisation, IntegrationList } from '@neoting/contracts/model';

import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../../common/db/scoped-db.js';
import { AppException } from '../../../common/problem/problem.js';
import { assertCan, resolveActor } from '../../approvals/index.js';
import { freeAgentLedger } from './freeagent.js';
import { VendorApi } from './ledger-http.js';
import { configuredVendors, credentialsFor, type LedgerEnv, ledgerLaneEnabled, vaultKeyFor, vendorConfigFor, vendorConfigForKind } from './ledger-config.js';
import {
  authorizeUrl,
  exchangeCode,
  OAuthError,
  resolveQuickBooksEndpoints,
  signState,
  verifyState,
} from './oauth.js';
import { quickBooksLedger } from './quickbooks.js';
import {
  LEDGER_LIST_KINDS,
  readReferenceList,
  type ReferenceLists,
  writeReferenceLists,
} from './reference-sync.js';
import { sageLedger } from './sage.js';
import { LedgerTokenStore, persistConnection, type ResolvedConnection } from './token-store.js';
import type { ResolvedOrg, VendorLedger } from './vendor-ledger.js';
import { vendorForKind, type VendorConfig, type VendorSlug } from './vendors.js';
import { xeroLedger } from './xero.js';

/**
 * The connection surface (D50, build brief Stage 1) — connect once, see health,
 * sync, disconnect.
 *
 * ⚠ **NOTHING HERE WRITES TO A LEDGER, and that is load-bearing.** Publishing
 * is an approved `publish.batch` proposal and there is no other door
 * (Governance §10). What this service does is manage the CONNECTION: it creates
 * and destroys the credentials a later approval will use, and it reads the
 * client's own lists so coding matches theirs. A connection screen that could
 * post a transaction would be the second way in that the whole Review → Approve
 * spine exists to prevent.
 *
 * ⚠ **Only the firm's super admin may connect or disconnect** (D44's predicate,
 * Shakib 15 Sep 2026). Connecting is the act that decides whether a later
 * Approve lands in real books, so it carries the same authority as the Approve.
 */

const LEDGERS: Readonly<Record<VendorSlug, VendorLedger>> = {
  xero: xeroLedger,
  quickbooks: quickBooksLedger,
  sage: sageLedger,
  freeagent: freeAgentLedger,
};

/**
 * ⚠ Xero has no sandbox: a developer connects a REAL organisation. No
 * environment variable can make that safe, so the screen says it instead.
 */
const CAUTION: Partial<Record<VendorSlug, string>> = {
  xero: 'Xero has no test company of its own. Connect their free Demo Company (UK) unless you mean to write to this client’s real books.',
};

export class LedgerConnectionsService {
  private readonly logger = new Logger(LedgerConnectionsService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: LedgerEnv,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  /**
   * The sealing key, or a refusal a person can act on.
   *
   * ⚠ **`env.ts` only gates this at boot when `LEDGER_ADAPTER=http`**, which is
   * the right place for the case that matters. But every environment running
   * the lane OFF still serves this controller — the Connections tab has to
   * render a client's export destinations either way — and `parseVaultKey`
   * throws on an empty string. Unguarded that is a 500 on a deployment where
   * nothing is wrong, which is the failure `publishes` calls "a failure with no
   * reason attached".
   *
   * `list` and `disconnect` deliberately do NOT call this: neither opens a
   * sealed blob, and a practice must be able to see and switch off a connection
   * on a deployment that has lost its key.
   */
  private vaultKey(): Buffer {
    try {
      return vaultKeyFor(this.env);
    } catch {
      throw new AppException(
        'NT-SRV-001',
        HttpStatus.SERVICE_UNAVAILABLE,
        'Accounting software connections are not switched on',
        'This deployment is not set up to connect accounting software yet. Nothing is wrong with this client — approved documents are still released for export.',
      );
    }
  }

  /** The whole Connections screen in one read: what is connected, and what could be. */
  async list(ctx: ScopeContext, businessId: string): Promise<IntegrationList> {
    const rows = await scopedDb(this.prisma, ctx, async (db) => {
      // 404-never-403: RLS makes another practice's client invisible, so an
      // absent row and a forbidden one are indistinguishable here, which is
      // exactly right.
      const business = await db.business.findUnique({ where: { id: businessId }, select: { id: true } });
      if (business === null) {
        throw new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'No client with that id.');
      }
      const integrations = await db.integration.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } });
      const counts = new Map<string, NonNullable<Integration['referenceCounts']>>();
      for (const row of integrations) {
        if (vendorForKind(row.kind) === null) continue;
        counts.set(row.id, await countLists(db, row.id));
      }
      return { integrations, counts };
    });

    // ⚠ **ONLY AN ACTIVE ROW BLOCKS ITS VENDOR, and this was a one-way door.**
    //
    // `disconnect` leaves the row in place with `isActive: false` — deliberately,
    // because the health history and the org it was connected to are worth
    // keeping. Counting every row here then removed that vendor from
    // `connectable` forever: the screen showed a dead card with Sync and
    // Disconnect both greyed out, and no way to connect again. Measured on
    // FreeAgent, 20 Sep 2026, immediately after a deliberate disconnect.
    //
    // `persistConnection` upserts on `businessId_kind` and sets `isActive: true`
    // with the health reset, so reconnecting reuses the row rather than making a
    // second one — which is why offering it again is safe.
    const connected = new Set(
      rows.integrations.filter((row) => row.isActive).map((row) => vendorForKind(row.kind)?.slug).filter(Boolean),
    );
    return {
      data: rows.integrations.map((row) => toDto(row, rows.counts.get(row.id) ?? null)),
      connectable: configuredVendors(this.env)
        .filter((slug) => !connected.has(slug))
        .map((slug) => ({
          vendor: slug,
          label: vendorConfigFor(this.env, slug).label,
          caution: CAUTION[slug] ?? null,
        })),
    };
  }

  /**
   * Start a consent journey.
   *
   * Returns a URL and nothing else — no row is written. A connection that
   * exists before consent is granted is a connection that lies on the screen if
   * the practice closes the tab, and the callback has everything it needs in
   * the signed state.
   */
  async authorise(ctx: ScopeContext, businessId: string, slug: VendorSlug): Promise<IntegrationAuthorisation> {
    await scopedDb(this.prisma, ctx, async (db) => {
      const business = await db.business.findUnique({ where: { id: businessId }, select: { id: true } });
      if (business === null) {
        throw new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'No client with that id.');
      }
      // ⚠ THE AUTHORITY CHECK. Ordered AFTER the reachability check so a caller
      // naming somebody else's client gets the 404 that says nothing, and only
      // a caller asking about their own practice learns that authority is what
      // they lack — the billing controller's ordering, applied again.
      assertCan(await resolveActor(db, ctx), 'business.integrations.manage');
    });

    // ⚠ The lane check comes FIRST. A deployment with every credential present
    // but the adapter on `demo` can complete a consent journey and then answer
    // the next release with a fabricated reference — see
    // `PublishGateway.ledgerLaneEnabled`. Refusing here is what makes that
    // unreachable rather than merely unlikely.
    const credentials = ledgerLaneEnabled(this.env) ? credentialsFor(this.env, slug) : null;
    if (credentials === null) {
      throw new AppException(
        'NT-VAL-001',
        HttpStatus.BAD_REQUEST,
        'Not available',
        'This deployment is not set up to connect that accounting software.',
      );
    }

    let vendor = vendorConfigFor(this.env, slug);
    if (slug === 'quickbooks') {
      // ⚠ Intuit's discovery document rather than a hardcoded endpoint — the
      // App Assessment Questionnaire asks whether we do this by name. A failure
      // falls back to the table rather than refusing to connect.
      const discovered = await resolveQuickBooksEndpoints(this.env.LEDGER_SANDBOX, this.fetchImpl);
      if (discovered !== null) vendor = { ...vendor, ...discovered };
    }

    const key = this.vaultKey();
    const state = signState({ b: businessId, v: slug, a: ctx.actorId }, key);
    return {
      authorisationUrl: authorizeUrl(vendor, credentials, state),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
  }

  /**
   * The vendor's redirect back.
   *
   * ⚠ **Two independent checks, and both are required.** The signed `state`
   * proves this callback belongs to a connect request this server started; the
   * session proves who is holding it. Either alone is insufficient — a state
   * captured from a browser history would otherwise complete somebody else's
   * connection, and a session alone would accept a code from anywhere.
   *
   * Returns where to send the browser next. It never renders anything: the
   * practice is mid-journey in the product, and the product is the web app.
   */
  async completeCallback(
    ctx: ScopeContext,
    slug: VendorSlug,
    params: Readonly<Record<string, string>>,
  ): Promise<{ readonly businessId: string; readonly integrationId: string }> {
    const key = this.vaultKey();
    const stateParam = params['state'];
    if (stateParam === undefined) throw badCallback('That connection link is not one this server issued.');
    const state = verifyState(stateParam, key);

    if (state.v !== slug) throw badCallback('That connection link was started for a different accounting package.');
    if (state.a !== ctx.actorId) {
      // Signed in as somebody else, or the link was forwarded. Neither may
      // complete a connection to a client's books.
      throw badCallback('Sign in as the person who started this connection, then try connecting again.');
    }

    const error = params['error'];
    if (error !== undefined) {
      // The practice pressed Cancel at the vendor, or the vendor refused. Not
      // an error of ours and not something to log as one.
      throw badCallback('The connection was not completed at the accounting software. Nothing has changed.');
    }
    const code = params['code'];
    if (code === undefined) throw badCallback('The accounting software did not send back an authorisation.');

    const credentials = credentialsFor(this.env, slug);
    if (credentials === null) throw badCallback('This deployment is not set up to connect that accounting software.');

    let vendor = vendorConfigFor(this.env, slug);
    if (slug === 'quickbooks') {
      const discovered = await resolveQuickBooksEndpoints(this.env.LEDGER_SANDBOX, this.fetchImpl);
      if (discovered !== null) vendor = { ...vendor, ...discovered };
    }

    let tokens;
    try {
      // ⚠ The token exchange, outside every transaction.
      tokens = await exchangeCode(vendor, credentials, code, this.fetchImpl);
    } catch (cause) {
      throw badCallback(cause instanceof OAuthError ? cause.message : 'The connection could not be completed.');
    }

    // The vendor's own organisation identifier, before anything is stored —
    // `orgRef` is what every later call is routed on, and a connection without
    // one is a connection that cannot be used.
    const ledger = LEDGERS[slug];
    const probe: ResolvedConnection = { integrationId: '', vendor, orgRef: null, accessToken: tokens.accessToken };
    let org: ResolvedOrg | null;
    try {
      org = await ledger.resolveOrgRef(new VendorApi(probe, this.fetchImpl), params);
    } catch (cause) {
      this.logger.error(`${vendor.label} callback: could not read the organisation — ${describe(cause)}`);
      throw badCallback(`${vendor.label} did not say which set of books was connected. Try connecting again.`);
    }
    if (org === null) {
      throw badCallback(`${vendor.label} did not say which set of books was connected. Try connecting again.`);
    }

    const integration = await scopedDb(this.prisma, ctx, async (db) => {
      assertCan(await resolveActor(db, ctx), 'business.integrations.manage');
      const business = await db.business.findUnique({ where: { id: state.b }, select: { id: true } });
      if (business === null) throw badCallback('That client is no longer reachable.');
      return persistConnection(db, {
        businessId: state.b,
        kind: vendor.kind,
        orgRef: org.ref,
        orgName: org.name ?? null,
        tokens,
        vaultKey: key,
      });
    });

    // ⚠ The first sync runs HERE, not lazily at the first publish. A practice
    // that connects and immediately approves a batch would otherwise see every
    // item refuse for "no accounts synced", which reads as a broken connection
    // rather than a missing step. A failure is logged and does not undo the
    // connection — the connection is real, and Sync is a button.
    try {
      await this.sync(ctx, integration.id);
    } catch (cause) {
      this.logger.warn(`${vendor.label} connected but the first sync failed — ${describe(cause)}`);
    }

    return { businessId: state.b, integrationId: integration.id };
  }

  /** Pull the client's own lists. Safe to call any number of times. */
  async sync(ctx: ScopeContext, integrationId: string): Promise<Integration> {
    const tokens = new LedgerTokenStore(
      this.prisma,
      ctx,
      this.vaultKey(),
      (slug) => credentialsFor(this.env, slug),
      // ⚠ Env-AWARE, not `vendorForKind`: the sandbox host lives here and
      // nowhere else, and losing it sends every post-connect call to the
      // production API with a sandbox token.
      (kind) => vendorConfigForKind(this.env, kind),
      this.fetchImpl,
    );
    const connection = await tokens.connection(integrationId);

    // ⚠ **An EMPTY stored list forces a FULL read**, whatever the timestamp
    // says. A delta can only ever be applied over something, and a connection
    // whose accounts are gone — because an earlier build wrote a delta over
    // them (18 Sep 2026), or because the first sync half-failed — must be able
    // to repair itself by pressing Sync rather than by reconnecting.
    const state = await scopedDb(this.prisma, ctx, async (db) => {
      const accounts = await readReferenceList(db, integrationId, LEDGER_LIST_KINDS.accounts);
      const row = await db.integration.findUnique({ where: { id: integrationId }, select: { orgName: true } });
      return {
        since: accounts === null || accounts.items.length === 0 ? null : accounts.syncedAt ?? null,
        // ⚠ Whether this connection still cannot say WHICH books it is.
        needsName: row === null || row.orgName === null,
      };
    });

    let fetched: { lists: ReferenceLists; delta?: boolean };
    try {
      // ⚠ The vendor round trip, outside every transaction.
      fetched = await LEDGERS[connection.vendor.slug].fetchLists(
        new VendorApi(connection, this.fetchImpl),
        connection,
        state.since,
      );
    } catch (cause) {
      const message = describe(cause);
      await tokens.markUnhealthy(integrationId, message);
      throw new AppException(
        'NT-SRV-001',
        HttpStatus.BAD_GATEWAY,
        'Could not read the accounting software',
        message,
      );
    }

    // ⚠ **Sync HEALS the organisation name, and that is the whole reason it is
    // here rather than only on the connect path.** `org_name` arrived on
    // 20 Sep 2026; every connection made before it reads null and would show a
    // bare GUID under "Organisation" until somebody reconnected — a consent
    // round trip to fix a label. Pressing Sync is enough instead, which is the
    // same self-repair principle the empty-list branch above is built on.
    //
    // Only when it is MISSING: a name that is already stored costs no second
    // vendor call, and the vendors meter reads. A failure here is logged and
    // dropped — the lists are what Sync is for, and refusing them over a label
    // would be the tail wagging the dog. ⚠ QuickBooks answers null by design
    // (its realm id arrives on a callback that no longer exists here), so this
    // is a no-op for that vendor every time, cheaply.
    let orgName: string | null = null;
    if (state.needsName) {
      try {
        const org = await LEDGERS[connection.vendor.slug].resolveOrgRef(new VendorApi(connection, this.fetchImpl), {});
        orgName = org?.name ?? null;
      } catch (cause) {
        this.logger.warn(`${connection.vendor.label} synced but would not name the organisation — ${describe(cause)}`);
      }
    }

    return scopedDb(this.prisma, ctx, async (db) => {
      // ⚠ A DELTA MERGES; a full list replaces. Replacing with a delta is what
      // turned 76 accounts into 0 on a live connection.
      await writeReferenceLists(db, integrationId, fetched.lists, null, fetched.delta === true ? 'merge' : 'replace');
      const row = await db.integration.update({
        where: { id: integrationId },
        data: {
          lastSyncAt: new Date(),
          health: 'OK',
          lastErrorAt: null,
          lastErrorMessage: null,
          // Never written back to null — an absent name leaves what is stored.
          ...(orgName === null ? {} : { orgName }),
        },
      });
      return toDto(row, await countLists(db, integrationId));
    });
  }

  /**
   * Disconnect.
   *
   * ⚠ **The credentials are DESTROYED, not merely switched off.** A row left
   * carrying a live refresh token is a row that can be reactivated into a
   * connection the practice believes they revoked. Reconnecting is a fresh
   * consent journey, which is the honest shape.
   *
   * ⚠ Nothing already published is touched. A transaction in a client's books
   * belongs to the client.
   */
  async disconnect(ctx: ScopeContext, integrationId: string): Promise<Integration> {
    return scopedDb(this.prisma, ctx, async (db) => {
      assertCan(await resolveActor(db, ctx), 'business.integrations.manage');
      const existing = await db.integration.findUnique({ where: { id: integrationId } });
      if (existing === null || vendorForKind(existing.kind) === null) {
        throw new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'No such connection.');
      }
      const row = await db.integration.update({
        where: { id: integrationId },
        data: {
          isActive: false,
          tokenRef: null,
          tokenExpiresAt: null,
          health: 'UNKNOWN',
          lastErrorAt: null,
          lastErrorMessage: null,
        },
      });
      // The synced lists go with it: they are the client's own commercial data,
      // held only to make our coding match theirs, and there is no reason to
      // keep them once we may no longer read them.
      await db.referenceSync.deleteMany({ where: { integrationId } });
      return toDto(row, null);
    });
  }
}

async function countLists(db: ScopedClient, integrationId: string): Promise<NonNullable<Integration['referenceCounts']>> {
  const [accounts, suppliers, taxRates, bankAccounts] = await Promise.all([
    readReferenceList(db, integrationId, LEDGER_LIST_KINDS.accounts),
    readReferenceList(db, integrationId, LEDGER_LIST_KINDS.suppliers),
    readReferenceList(db, integrationId, LEDGER_LIST_KINDS.taxRates),
    readReferenceList(db, integrationId, LEDGER_LIST_KINDS.bankAccounts),
  ]);
  return {
    accounts: accounts?.items.length ?? 0,
    suppliers: suppliers?.items.length ?? 0,
    taxRates: taxRates?.items.length ?? 0,
    bankAccounts: bankAccounts?.items.length ?? 0,
  };
}

/**
 * The row as a screen needs it.
 *
 * ⚠ **`tokenRef` never appears, in any shape.** Not the blob, not its length,
 * not a boolean derived anywhere but here. `isConnected` is the one fact a
 * screen needs from it.
 */
function toDto(row: IntegrationRow, referenceCounts: NonNullable<Integration['referenceCounts']> | null): Integration {
  const vendor: VendorConfig | null = vendorForKind(row.kind);
  return {
    id: row.id,
    businessId: row.businessId,
    kind: row.kind,
    vendor: vendor?.slug ?? null,
    label: vendor?.label ?? row.kind,
    orgRef: row.orgRef,
    connectedOrganisation: row.orgName,
    isActive: row.isActive,
    isConnected: row.tokenRef !== null && row.tokenRef !== '',
    health: isHealth(row.health) ? row.health : 'UNKNOWN',
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    lastErrorMessage: row.lastErrorMessage,
    referenceCounts,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `health` is a free string column; the contract's enum is three values. Parse, don't trust. */
function isHealth(value: string | null): value is 'OK' | 'ERROR' | 'UNKNOWN' {
  return value === 'OK' || value === 'ERROR' || value === 'UNKNOWN';
}

function badCallback(detail: string): AppException {
  return new AppException('NT-VAL-001', HttpStatus.BAD_REQUEST, 'Connection not completed', detail);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The accounting software could not be reached.';
}
