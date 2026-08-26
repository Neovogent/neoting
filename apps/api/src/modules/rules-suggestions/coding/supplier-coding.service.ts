import { HttpStatus } from '@nestjs/common';

import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../../common/db/scoped-db.js';
import { AppException } from '../../../common/problem/problem.js';
import { analysisAccount, resolveAccount } from '../chart-of-accounts/account.js';
import type { ChartOfAccountsService, ClientChartOfAccounts } from '../chart-of-accounts/chart-of-accounts.service.js';
import { normaliseSupplierKey } from '../supplier-key.js';
import { authorityForTier, tierRank } from './authority.js';
import type { CodingDecision, SupplierContext } from './coding-decision.js';
import { buildSupplierRuleProposal, type SupplierRuleProposal, type SupplierRuleRefusal } from './rule-proposal.js';

/**
 * **The coding ladder** — A6's second half, and the thing that makes the second
 * invoice from a supplier code itself.
 *
 * ## The loop this closes, end to end
 *
 * 1. Invoice 1 from Nisbets arrives. Nothing codes it: the extractor is not
 *    asked to (`categoryCode` stays null on purpose — *a model opinion written
 *    straight into a category is an unreviewed change to a ledger*), and there
 *    is no rule. It lands in To Review.
 * 2. The accountant codes it by hand. That is a `document.update-coding`
 *    proposal they approve, and its executor writes an accepted `extractions`
 *    row marking `categoryCode` as `HUMAN_CONFIRMED`.
 * 3. **This service reads that**, and {@link SupplierCodingService.resolveForSupplier}
 *    now answers `CODE` on the `LEARNED_HISTORY` rung — the client's own prior
 *    decision, which §24.4.5 names as the thing that should become a
 *    deterministic rule.
 * 4. `rule-proposal.ts` turns it into a `rule.create` proposal. A human
 *    approves it; the existing executor writes the `rules` row.
 * 5. Invoice 2 from Nisbets arrives and `extraction-pipeline.ts` — unchanged —
 *    finds the active `SUPPLIER_CUSTOMER` rule and codes it.
 *
 * Every state change in that chain is an approved ActionProposal. Nothing in
 * this file writes.
 *
 * ## The two guarantees, and where each one lives
 *
 * - **An explicit accountant rule beats everything.** {@link decide} consults
 *   rules FIRST and returns as soon as one sets a category. History is not even
 *   loaded as a competitor — it is loaded for context, and it can never
 *   displace a rule, because there is no code path in which it is compared
 *   against one.
 * - **Nothing overrides a human's correction.** {@link SupplierCodingService.resolveForDocument}
 *   checks the lock BEFORE the ladder runs and returns `LOCKED` with no code to
 *   apply. A rule that disagrees with a human's correction does not win — it is
 *   not consulted.
 */

/**
 * How many of a client's recent coded documents the history lookup reads.
 *
 * A bound rather than "all of them", because normalisation happens in this
 * process (`nisbets ltd` and `NISBETS` are one supplier and Postgres cannot say
 * so through an index) and an unbounded scan on a coding read is the cost bug
 * that ships quietly. 200 is generous at ID volumes — the first client is a
 * single cleaning agency — and the ceiling is stated here rather than
 * discovered later as "why did it stop learning".
 */
export const HISTORY_WINDOW = 200;

/** One prior human-confirmed coding of a supplier by this client. */
export interface SupplierHistoryEntry {
  readonly documentId: string;
  /** The exact spelling on that document — what a rule's `scopeKey` must be. */
  readonly supplierName: string;
  readonly categoryCode: string;
  readonly receivedAt: Date;
}

export interface SupplierHistory {
  readonly entries: readonly SupplierHistoryEntry[];
  /** Distinct category codes across those entries, most recent first. */
  readonly categoryCodes: readonly string[];
  /** Distinct exact spellings, most recent first. The rule's scope key is the first of these. */
  readonly spellings: readonly string[];
}

export interface SupplierCodingResult {
  readonly businessId: string;
  readonly decision: CodingDecision;
  readonly chart: ClientChartOfAccounts;
  readonly history: SupplierHistory;
}

export class SupplierCodingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly charts: ChartOfAccountsService,
  ) {}

  /** How this client's documents from this supplier should be coded, and on whose authority. */
  async resolveForSupplier(ctx: ScopeContext, businessId: string, supplierName: string | null): Promise<SupplierCodingResult> {
    return scopedDb(this.prisma, ctx, (db) => this.decide(db, businessId, supplierName));
  }

  /**
   * The same question for one document, with the human lock checked first.
   *
   * **404, never 403** for a document the caller cannot see: RLS makes it
   * invisible and there is no ownership check that could confirm otherwise.
   */
  async resolveForDocument(ctx: ScopeContext, documentId: string): Promise<SupplierCodingResult> {
    return scopedDb(this.prisma, ctx, async (db) => {
      const document = await db.document.findUnique({
        where: { id: documentId },
        select: {
          id: true,
          businessId: true,
          supplierName: true,
          categoryCode: true,
          state: true,
          extractions: {
            where: { isAccepted: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { extractorKind: true, fields: true },
          },
        },
      });
      if (document === null) {
        throw new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'No document with that id.');
      }
      if (document.businessId === null) {
        // Unrouted: no client, so no chart, no rules and no history. Routing is
        // a `document.route` proposal and is somebody else's stage.
        throw new AppException(
          'NT-VAL-001',
          HttpStatus.CONFLICT,
          'Not routed',
          'This document has not been routed to a client yet, so there is no chart of accounts to code it against.',
        );
      }

      const lock = documentLockFor(document);
      if (lock !== null) {
        const chart = await this.charts.resolve(db, document.businessId);
        const history = await loadHistory(db, document.businessId, normaliseSupplierKey(document.supplierName));
        return {
          businessId: document.businessId,
          chart,
          history,
          decision: {
            outcome: 'LOCKED',
            lock,
            categoryCode: document.categoryCode,
            supplier: supplierContext(document.supplierName, chart, history),
            nearMissRuleScopeKeys: [],
            reason:
              lock === 'HUMAN_CORRECTION'
                ? 'A person set this coding and confirmed it. Nothing here overrides that — a rule or a suggestion that disagrees is a card for them to read, never an action.'
                : `This document is ${document.state.toLowerCase()}; its coding is locked and cannot be changed from here.`,
          },
        };
      }

      return this.decide(db, document.businessId, document.supplierName);
    });
  }

  /**
   * The `rule.create` proposal that makes the NEXT invoice from this supplier
   * code itself — or the reason there is none.
   *
   * The caller sends `{ kind, businessId, payload }` to
   * `POST /v1/action-proposals` and a human approves it. **Nothing here writes
   * a rule**; `rule-proposal.ts` explains why at length.
   */
  async proposeSupplierRule(
    ctx: ScopeContext,
    businessId: string,
    supplierName: string | null,
  ): Promise<SupplierRuleProposal | SupplierRuleRefusal> {
    return buildSupplierRuleProposal(await this.resolveForSupplier(ctx, businessId, supplierName));
  }

  /** The same, anchored on a document — so the lock is checked before anything is offered. */
  async proposeRuleFromDocument(ctx: ScopeContext, documentId: string): Promise<SupplierRuleProposal | SupplierRuleRefusal> {
    return buildSupplierRuleProposal(await this.resolveForDocument(ctx, documentId));
  }

  /**
   * The decision itself, inside the caller's transaction.
   *
   * One transaction on purpose: the chart, the rules and the history have to be
   * read from one consistent view. Three separate reads could see an accountant
   * approve a rule half-way through and produce a decision that never existed.
   */
  async decide(db: ScopedClient, businessId: string, supplierName: string | null): Promise<SupplierCodingResult> {
    // Resolving the chart also proves the business is visible under RLS — an
    // invisible one throws 404 from here, before anything else is read.
    const chart = await this.charts.resolve(db, businessId);
    const supplierKey = normaliseSupplierKey(supplierName);
    const history = await loadHistory(db, businessId, supplierKey);
    const supplier = supplierContext(supplierName, chart, history);

    const rules = await db.rule.findMany({
      where: { businessId, isActive: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true, tier: true, scopeKey: true, sets: true },
    });

    const exact: typeof rules = [];
    const nearMiss: string[] = [];
    for (const rule of rules) {
      if (categoryFromSets(rule.sets) === null) continue;
      if (rule.scopeKey === null) {
        // A scope-less rule is only meaningful as a business-wide default.
        if (rule.tier === 'ACCOUNT_DEFAULT') exact.push(rule);
        continue;
      }
      // EXACTLY what `extraction-pipeline.ts` compares, character for
      // character. Matching more loosely here would make this service claim a
      // coding the pipeline will not actually apply.
      if (supplierName !== null && rule.scopeKey === supplierName) exact.push(rule);
      else if (supplierKey !== '' && normaliseSupplierKey(rule.scopeKey) === supplierKey) nearMiss.push(rule.scopeKey);
    }

    // Most specific tier first; within a tier the most recent rule, which is
    // the order the pipeline's `orderBy: { createdAt: 'desc' }` produces.
    exact.sort((a, b) => tierRank(a.tier) - tierRank(b.tier));

    const winner = exact[0];
    if (winner !== undefined) {
      const categoryCode = categoryFromSets(winner.sets);
      // `continue` above guarantees this, but the narrowing has to be earned.
      if (categoryCode !== null) {
        const authority = authorityForTier(winner.tier);
        return {
          businessId,
          chart,
          history,
          decision: {
            outcome: 'CODE',
            authority,
            categoryCode,
            analysisAccount: emittableAccount(chart, categoryCode),
            sourceRuleId: winner.id,
            supplier,
            nearMissRuleScopeKeys: nearMiss,
            reason:
              authority === 'ACCOUNTANT_RULE'
                ? `An accountant's rule for ${winner.scopeKey ?? 'this client'} codes this to ${categoryCode}. An explicit rule outranks everything below it.`
                : `A practice default for this client codes this to ${categoryCode}.`,
          },
        };
      }
    }

    // Nothing explicit. The client's own prior decisions are the next rung —
    // and the ONLY thing below a rule that ID fills. The seeded chart is a
    // picklist, not supplier knowledge, so `CLIENT_CONTEXT` never wins here.
    if (history.categoryCodes.length === 1) {
      const categoryCode = history.categoryCodes[0] as string;
      const times = history.entries.length;
      return {
        businessId,
        chart,
        history,
        decision: {
          outcome: 'CODE',
          authority: 'LEARNED_HISTORY',
          categoryCode,
          analysisAccount: emittableAccount(chart, categoryCode),
          sourceRuleId: null,
          supplier,
          nearMissRuleScopeKeys: nearMiss,
          reason: `This client has coded ${supplier.name ?? 'this supplier'} to ${categoryCode} ${times === 1 ? 'once' : `${times} times`}, by hand. Consistency with the client's own prior treatment is the strongest signal below an explicit rule.`,
        },
      };
    }

    return {
      businessId,
      chart,
      history,
      decision: {
        outcome: 'REVIEW',
        conflictingCategoryCodes: history.categoryCodes,
        supplier,
        nearMissRuleScopeKeys: nearMiss,
        reason: reviewReason(supplier, history, chart),
      },
    };
  }
}

/** `documents.category_code` → the emittable `Ledger: Account`, or null when the code is off-chart. */
function emittableAccount(chart: ClientChartOfAccounts, categoryCode: string): string | null {
  const account = resolveAccount(chart.accounts, categoryCode);
  if (account !== null) return analysisAccount(account);
  // The chart may have been read back as `categories` only. Those names are
  // already in the emittable form, so the pair is enough.
  return chart.categories.find((category) => category.code === categoryCode)?.name ?? null;
}

function supplierContext(
  supplierName: string | null,
  chart: ClientChartOfAccounts,
  history: SupplierHistory,
): SupplierContext {
  const key = normaliseSupplierKey(supplierName);
  return {
    name: supplierName,
    key,
    // Unknown at intake AND unseen in the client's own documents. Either one
    // alone is not enough: a client rarely lists every supplier, and a first
    // document from a supplier they did name is not a surprise.
    isNew: key !== '' && !chart.knownSuppliers.includes(key) && history.entries.length === 0,
  };
}

function reviewReason(supplier: SupplierContext, history: SupplierHistory, chart: ClientChartOfAccounts): string {
  if (supplier.name === null || supplier.key === '') {
    return 'No supplier was read off this document, so there is nothing to match a rule or a prior coding against.';
  }
  if (history.categoryCodes.length > 1) {
    return `This client has coded ${supplier.name} to more than one account before (${history.categoryCodes.join(', ')}). A change of treatment is worth a person looking at, not a tie for this to break.`;
  }
  if (supplier.isNew) {
    return `${supplier.name} is a supplier this client has not named and has not sent before. A new supplier is always review.`;
  }
  if (chart.basis === 'NO_PROFILE') {
    return `Nothing codes ${supplier.name} yet, and this client has no business-type profile — so the chart offered is a generic one rather than one built for them.`;
  }
  return `Nothing codes ${supplier.name} yet: no rule names them and nobody has coded one of their documents by hand. Coding one is what teaches the next.`;
}

/**
 * The lock, or `null`.
 *
 * The human check reads the accepted `extractions` row rather than
 * `documents.category_code`, because the column alone cannot tell a value a
 * person chose from one a rule applied. `document.update-coding` writes
 * `provenance: 'HUMAN_CONFIRMED'` on every field it changed, and that is the
 * only writer of it.
 *
 * ⚠ **Known blind spot, stated rather than hidden:** a human who *confirms* an
 * existing value without changing it produces no change set, so the executor
 * writes no new extraction row and there is nothing here to read. Such a
 * document is not locked. Closing that needs a change to `update-coding`'s
 * idempotency branch, which is `validation-dedupe`'s file, not this stage's.
 */
export function documentLockFor(document: {
  readonly state: string;
  readonly extractions: readonly { readonly extractorKind: string; readonly fields: unknown }[];
}): 'HUMAN_CORRECTION' | 'RELEASED_OR_ARCHIVED' | null {
  if (document.state === 'PUBLISHED' || document.state === 'ARCHIVED') return 'RELEASED_OR_ARCHIVED';

  const accepted = document.extractions[0];
  if (accepted === undefined || accepted.extractorKind !== 'human') return null;
  const fields = accepted.fields;
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return null;
  const field = (fields as Record<string, unknown>)['categoryCode'];
  if (typeof field !== 'object' || field === null || Array.isArray(field)) return null;
  return (field as Record<string, unknown>)['provenance'] === 'HUMAN_CONFIRMED' ? 'HUMAN_CORRECTION' : null;
}

/** The category a rule's `sets` JSON assigns, or null when it sets none. */
function categoryFromSets(sets: unknown): string | null {
  if (typeof sets !== 'object' || sets === null || Array.isArray(sets)) return null;
  const value = (sets as Record<string, unknown>)['categoryCode'];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * This client's prior HUMAN-CONFIRMED codings of one supplier, most recent
 * first.
 *
 * Only human-confirmed codings count. A category a rule applied is not
 * evidence — feeding a rule's own output back in as history would make one
 * approved decision look like a growing consensus, and the reviewer-correction
 * metric §24.4.5 says to watch would flatter itself.
 */
async function loadHistory(db: ScopedClient, businessId: string, supplierKey: string): Promise<SupplierHistory> {
  if (supplierKey === '') return { entries: [], categoryCodes: [], spellings: [] };

  const rows = await db.document.findMany({
    where: { businessId, archivedAt: null, categoryCode: { not: null }, supplierName: { not: null } },
    orderBy: { receivedAt: 'desc' },
    take: HISTORY_WINDOW,
    select: {
      id: true,
      supplierName: true,
      categoryCode: true,
      receivedAt: true,
      extractions: {
        where: { isAccepted: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { extractorKind: true, fields: true },
      },
    },
  });

  const entries: SupplierHistoryEntry[] = [];
  for (const row of rows) {
    if (row.supplierName === null || row.categoryCode === null) continue;
    if (normaliseSupplierKey(row.supplierName) !== supplierKey) continue;
    if (documentLockFor({ state: 'READY', extractions: row.extractions }) !== 'HUMAN_CORRECTION') continue;
    entries.push({
      documentId: row.id,
      supplierName: row.supplierName,
      categoryCode: row.categoryCode,
      receivedAt: row.receivedAt,
    });
  }

  return {
    entries,
    categoryCodes: [...new Set(entries.map((entry) => entry.categoryCode))],
    spellings: [...new Set(entries.map((entry) => entry.supplierName))],
  };
}
