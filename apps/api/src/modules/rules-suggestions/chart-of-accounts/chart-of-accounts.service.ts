import { HttpStatus, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';

import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../../common/db/scoped-db.js';
import { AppException } from '../../../common/problem/problem.js';
import { readBusinessProfile } from '../../clients-team-settings/index.js';
import { ChartAccountSchema } from './account.js';
import { type ChartBasis, type ChartCategory, type ChartOfAccounts, chartOfAccountsFor, toCategories } from './chart-of-accounts.js';
import { BUSINESS_PROFILE_IDS } from './profiles.js';

/**
 * The client's chart of accounts, persisted (A6).
 *
 * ## Where it lives, and why there is no new table
 *
 * `reference_syncs` — `listKind: 'chart_of_accounts'`, one row per integration,
 * `@@unique([integrationId, listKind])`. That table already exists, already
 * carries RLS keyed on the integration's business, and is **already read by
 * `chat-framework/grounding.ts`**:
 *
 * ```ts
 * // grounding.ts, loadCategories()
 * db.referenceSync.findMany({ where: { listKind: 'chart_of_accounts', integration: { businessId } } })
 * ```
 *
 * It returns empty for every client in the product today, because nothing has
 * ever written that row — the OAuth sync that used to fill it is what D42 and
 * D47 removed. The visible consequence is a sentence an accountant currently
 * gets for every client they try to teach a rule to:
 *
 * > *"This client has no synced chart of accounts yet, so a coding rule has
 * > nothing to code against."*
 *
 * Seeding this row is what makes that sentence go away, with **no change to the
 * chat module at all**. `prisma/` is LAW (G7), so inventing a `chart_of_accounts`
 * table was never on the table; using the one that is already shaped for this
 * and already wired to a consumer is the better answer anyway.
 *
 * ## Two rules this service will not break
 *
 * 1. **It never overwrites.** §24.4.1 says the chart is *owned and edited by the
 *    accountant thereafter*. A re-seed that clobbered an accountant's edits
 *    would be the module overriding a human, which is the one thing A6's brief
 *    says is absolute. `ensure` writes only when the row is absent.
 * 2. **It codes nothing.** Writing a picklist is not a coding decision, and
 *    nothing here touches `documents.category_code`. That column moves only
 *    through the `document.update-coding` proposal a human approved, or through
 *    the extraction pipeline's first read of a brand-new document.
 *
 * ## Why writing it is not a Review → Approve state change
 *
 * Governance §10 governs **changes to the state of things that exist**. Seeding
 * a chart for a client that has none creates a reference list where there was
 * none, changes nothing, and is idempotent — the same class as A11's intake,
 * which the contract marks `x-nt-side-effect: ingest` for exactly this reason.
 * The moment it could *replace* an existing chart it would stop being that, and
 * that is why it cannot.
 */

/** The `list_kind` value `chat-framework` already queries. Do not rename it — it is a cross-module contract in a string column. */
export const CHART_OF_ACCOUNTS_LIST_KIND = 'chart_of_accounts';

/**
 * Bumped when the shape of the stored payload changes. A stored chart at an
 * older version is still read (the accountant may have edited it); the version
 * is what tells a future migration which rows it is looking at.
 */
export const CHART_PAYLOAD_VERSION = 1;

/**
 * The stored payload, parsed on the way out.
 *
 * ⚠ `categories` is the half `chat-framework` reads, and its schema there is
 * `{ code: string, name: string }[]`. This schema is a **superset**, not a
 * different shape: the extra `neoting` block rides alongside so a future reader
 * gets the VAT and tax flags without a second row, and chat's non-strict
 * `z.object` ignores it.
 */
const StoredChartSchema = z.object({
  categories: z.array(z.object({ code: z.string(), name: z.string() })).max(500),
  neoting: z.object({
    version: z.number().int(),
    profileId: z.enum(BUSINESS_PROFILE_IDS),
    basis: z.enum(['PROFILE_MATCHED', 'PROFILE_UNMATCHED', 'NO_PROFILE']),
    accounts: z.array(ChartAccountSchema),
    unmatchedCosts: z.array(z.string()),
    knownSuppliers: z.array(z.string()),
    caveat: z.string(),
  }),
});

export type ChartSource =
  /** Read back from `reference_syncs` — a previous seed, or the accountant's own edits. */
  | 'STORED'
  /** Written by this call. */
  | 'SEEDED'
  /** Derived and returned, but NOT written: this client has no integration row to hang it on. */
  | 'UNSTORED';

export interface ClientChartOfAccounts extends ChartOfAccounts {
  readonly businessId: string;
  readonly source: ChartSource;
  /** The `{ code, name }` pairs, `name` ledger-prefixed — the form A7's `Analysis account` needs. */
  readonly categories: readonly ChartCategory[];
}

export class ChartOfAccountsService {
  private readonly logger = new Logger(ChartOfAccountsService.name);

  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The client's chart, seeding it on first read.
   *
   * Seeding on read rather than only at intake is deliberate: it means **every
   * client already in the database gets a chart the first time anything asks
   * for one**, including the seeded demo clients whose legacy questionnaire
   * reads as no profile at all. Wiring the seed into `POST /v1/businesses` is
   * one line in `clients-team-settings` (see this module's CLAUDE.md) and is an
   * optimisation, not a correctness requirement.
   *
   * **404, never 403** for a business the caller cannot see — RLS makes it
   * invisible, so `findUnique` returns null and there is no ownership check
   * that could confirm it exists.
   */
  async getChartOfAccounts(ctx: ScopeContext, businessId: string): Promise<ClientChartOfAccounts> {
    return scopedDb(this.prisma, ctx, (db) => this.resolve(db, businessId));
  }

  /**
   * Idempotent seed. Returns the chart and whether this call wrote it.
   *
   * The one line client intake owes this module. Safe to call any number of
   * times, safe to call concurrently (the unique index is the backstop), and
   * safe to call for a client whose chart an accountant has since edited — it
   * will not touch it.
   */
  async ensureChartOfAccounts(ctx: ScopeContext, businessId: string): Promise<ClientChartOfAccounts> {
    return this.getChartOfAccounts(ctx, businessId);
  }

  /**
   * The same read, for a caller that already holds an open scoped transaction.
   *
   * `ScopedClient` has no `$transaction`, so this structurally cannot open a
   * second one — the executor discipline the proposal lane uses, applied here
   * so `supplier-coding.service.ts` can resolve a chart and a rule ladder in
   * one transaction rather than two reads that could see different worlds.
   */
  async resolve(db: ScopedClient, businessId: string): Promise<ClientChartOfAccounts> {
    const business = await db.business.findUnique({
      where: { id: businessId },
      select: { id: true, contextQuestionnaire: true },
    });
    if (business === null) {
      // NT-NOT-001 is not in the contract's ErrorCode enum; NT-VAL-001 is the
      // house fallback for an otherwise-uncoded 4xx. The detail never echoes
      // the id back, because that would confirm what the 404 is hiding.
      throw new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'No client with that id.');
    }

    const integration = await db.integration.findFirst({
      where: { businessId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    if (integration !== null) {
      const stored = await db.referenceSync.findUnique({
        where: { integrationId_listKind: { integrationId: integration.id, listKind: CHART_OF_ACCOUNTS_LIST_KIND } },
        select: { payload: true },
      });
      const parsed = readStoredChart(stored?.payload ?? null);
      if (parsed !== null) return { ...parsed, businessId, source: 'STORED' };
      if (stored !== null) {
        // A row exists and does not parse. That is a broken or hand-edited
        // chart, and REPLACING it would be this service overwriting something a
        // human may have written — the one thing it must not do. Fall through
        // to the derived chart, unstored, and say so in the log.
        this.logger.warn(`chart_of_accounts for business ${businessId} did not parse — serving the derived chart, not overwriting`);
        return { ...derive(business.contextQuestionnaire, businessId), source: 'UNSTORED' };
      }
    }

    const derived = derive(business.contextQuestionnaire, businessId);
    if (integration === null) {
      // No integration means nowhere to hang the row (`reference_syncs` is keyed
      // on one, and its RLS policy reads through it). A11's intake creates
      // exactly one VT integration per client, so this is the pre-A11 client and
      // the seeded demo data. The chart still works — it is just not visible to
      // anything that reads the table directly, which today means chat.
      return { ...derived, source: 'UNSTORED' };
    }

    try {
      await db.referenceSync.create({
        data: {
          integrationId: integration.id,
          listKind: CHART_OF_ACCOUNTS_LIST_KIND,
          payload: toStoredPayload(derived) as Prisma.InputJsonObject,
        },
      });
      return { ...derived, source: 'SEEDED' };
    } catch (error) {
      // The genuine race: two callers resolved a chart for the same brand-new
      // client at once. The unique index is the backstop and the loser reads
      // the winner's row rather than failing — a chart is a chart.
      if (!isUniqueViolation(error)) throw error;
      const stored = await db.referenceSync.findUnique({
        where: { integrationId_listKind: { integrationId: integration.id, listKind: CHART_OF_ACCOUNTS_LIST_KIND } },
        select: { payload: true },
      });
      const parsed = readStoredChart(stored?.payload ?? null);
      return parsed === null ? { ...derived, source: 'UNSTORED' } : { ...parsed, businessId, source: 'STORED' };
    }
  }
}

/** The business row's questionnaire column → a chart. The `null` path is documented in `chart-of-accounts.ts`. */
function derive(questionnaire: unknown, businessId: string): Omit<ClientChartOfAccounts, 'source'> {
  const chart = chartOfAccountsFor(readBusinessProfile(questionnaire));
  return { ...chart, businessId, categories: toCategories(chart) };
}

/**
 * A stored payload → a chart, or `null` when it is not one this release
 * understands.
 *
 * **Parse, do not trust** — the column is `Json` and what comes back is
 * whatever was written, by this service, by a hand edit, or by a future
 * migration. A database is a boundary exactly as a request body is.
 *
 * ⚠ **The `neoting` block is REQUIRED, and a payload without one does not
 * parse.** A `{ categories }`-only row could be reconstructed — split each name
 * back on its `': '` — but only by inventing the VAT treatment and tax
 * consequence of every account, and inventing `ALLOWABLE` for something that
 * might be entertaining is precisely the guess §24.4.6 exists to prevent. A row
 * this release cannot read is served as a *derived, unstored* chart with a
 * warning, and is never overwritten.
 */
function readStoredChart(payload: unknown): Omit<ClientChartOfAccounts, 'businessId' | 'source'> | null {
  if (payload === null || payload === undefined) return null;
  const parsed = StoredChartSchema.safeParse(payload);
  if (!parsed.success) return null;

  const block = parsed.data.neoting;
  const basis: ChartBasis = block.basis;
  return {
    profileId: block.profileId,
    basis,
    accounts: block.accounts,
    unmatchedCosts: block.unmatchedCosts,
    knownSuppliers: block.knownSuppliers,
    caveat: block.caveat,
    categories: parsed.data.categories,
  };
}

/** A chart → the `reference_syncs.payload` shape. `categories` first, because that is the half another module already reads. */
function toStoredPayload(chart: Omit<ClientChartOfAccounts, 'source'>): Record<string, unknown> {
  return {
    categories: chart.categories.map((category) => ({ code: category.code, name: category.name })),
    neoting: {
      version: CHART_PAYLOAD_VERSION,
      profileId: chart.profileId,
      basis: chart.basis,
      accounts: chart.accounts,
      unmatchedCosts: chart.unmatchedCosts,
      knownSuppliers: chart.knownSuppliers,
      caveat: chart.caveat,
    },
  };
}

/** Prisma's unique-constraint error (P2002), duck-typed so no value import of Prisma is needed. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2002';
}
