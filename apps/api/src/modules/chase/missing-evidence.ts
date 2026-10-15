import { Logger } from '@nestjs/common';
import type { ChaseDetectionEngine, Prisma } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import { systemActorsByPractice } from '../../common/db/resolve-system-actor.js';
import { type ScopeContext, systemContext } from '../../common/db/scope-context.js';
import { type ScopedClient, scopedDb } from '../../common/db/scoped-db.js';
import { detectUnmatchedChases } from './detection.js';
import { type ClientSuppression, isSuppressedForClient, loadClientSuppression, supplierKey } from './suppression.js';

/**
 * The missing-evidence engines (SoT §4 Stage 8), persisted.
 *
 *  (a) bank line with no matched document         — `detectUnmatchedChases`
 *  (b) supplier-statement line with status MISSING — `supplier_statement_lines`
 *  (d) ledger transaction with no attachment       — a READ handed in by the
 *      composition root (the publishing seam), never imported here
 *  (e) expected recurring document not arrived     — {@link detectRecurringGaps}
 *
 * Findings land in `missing_evidence`, keyed (business, engine, refKey) and
 * inserted with `skipDuplicates`, so a RESOLVED or SUPPRESSED finding is never
 * re-raised. Each run also resolves what the evidence has since covered.
 *
 * ⚠ Detection SENDS NOTHING. It writes findings and one in-app notification;
 * asking the client stays the accountant's reviewed `chase.send`.
 */

/** How often the worker sweeps. */
export const MISSING_EVIDENCE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Engine (d)'s lookback. */
const LEDGER_LOOKBACK_DAYS = 90;
/** Engine (e): a recurring document is "late" this many days after its period ends. */
const RECURRING_GRACE_DAYS = 10;
/** Engine (e): stop expecting a supplier after this many silent periods. */
const RECURRING_MAX_SILENT_PERIODS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Engine (d)'s read, structurally — `publishing`'s `readUnattachedLedgerTransactions` fits it. */
export type LedgerUnattachedReader = (
  ctx: ScopeContext,
  businessId: string,
  since: string,
) => Promise<
  readonly {
    readonly vendor: string;
    readonly ok: boolean;
    readonly items: readonly {
      readonly ref: string;
      readonly supplierName: string | null;
      readonly amountPence: number | null;
      readonly date: string | null;
      readonly label: string;
    }[];
  }[]
>;

export interface EvidenceCandidate {
  readonly engine: ChaseDetectionEngine;
  readonly refKey: string;
  readonly transactionId?: string;
  readonly supplierStatementLineId?: string;
  readonly externalRef?: string;
  readonly supplierName: string | null;
  readonly amountPence: number | null;
  readonly occurredAt: Date | null;
  readonly period?: string;
  readonly description: string | null;
}

// ── Engine (e): pure ────────────────────────────────────────────────────────

export interface DatedSupplierDocument {
  readonly documentId: string;
  readonly supplierName: string;
  readonly documentDate: Date;
}

export interface RecurringGap {
  readonly supplierKey: string;
  readonly supplierName: string;
  /** `YYYY-MM` — the month the document was expected in. */
  readonly period: string;
  readonly cadence: 'monthly' | 'quarterly';
}

const monthIndex = (date: Date): number => date.getUTCFullYear() * 12 + date.getUTCMonth();
const periodOf = (index: number): string => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
/** First instant of the month AFTER `index` — when the period has ended. */
const periodEnd = (index: number): number => Date.UTC(Math.floor((index + 1) / 12), (index + 1) % 12, 1);

/**
 * Infer a monthly or quarterly cadence per supplier from the documents already
 * held, and name the first expected period that has not arrived.
 *
 * Cadence = the last three distinct months spaced exactly 1 (monthly) or 3
 * (quarterly) apart. A gap is raised for `last + step` once that period is over
 * by {@link RECURRING_GRACE_DAYS}, and not after the supplier has been silent
 * {@link RECURRING_MAX_SILENT_PERIODS} periods (the relationship has probably
 * ended — asking then is over-chasing). Months are bucketed in UTC.
 * ponytail: three-point cadence, no annual or fortnightly; add when asked.
 */
export function detectRecurringGaps(documents: readonly DatedSupplierDocument[], now: Date): RecurringGap[] {
  const bySupplier = new Map<string, { name: string; months: Set<number> }>();
  for (const doc of documents) {
    const key = supplierKey(doc.supplierName);
    if (key === '') continue;
    const entry = bySupplier.get(key) ?? { name: doc.supplierName, months: new Set<number>() };
    entry.months.add(monthIndex(doc.documentDate));
    bySupplier.set(key, entry);
  }

  const gaps: RecurringGap[] = [];
  for (const [key, { name, months }] of bySupplier) {
    const sorted = [...months].sort((a, b) => a - b);
    if (sorted.length < 3) continue;
    const [a, b, c] = sorted.slice(-3) as [number, number, number];
    const step = b - a === 1 && c - b === 1 ? 1 : b - a === 3 && c - b === 3 ? 3 : 0;
    if (step === 0) continue;
    const expected = c + step;
    if (now.getTime() < periodEnd(expected) + RECURRING_GRACE_DAYS * DAY_MS) continue;
    if (monthIndex(now) - expected > step * RECURRING_MAX_SILENT_PERIODS) continue;
    gaps.push({ supplierKey: key, supplierName: name, period: periodOf(expected), cadence: step === 1 ? 'monthly' : 'quarterly' });
  }
  return gaps;
}

// ── One business ────────────────────────────────────────────────────────────

export interface DetectionResult {
  readonly created: number;
  readonly resolved: number;
  readonly suppressed: number;
}

export interface DetectionDeps {
  readonly ledger?: LedgerUnattachedReader;
  readonly now?: () => Date;
}

/**
 * Run every engine for one business under the caller's context and persist the
 * findings. The ledger read (vendor HTTP) happens BEFORE the transaction opens.
 */
export async function detectMissingEvidenceForBusiness(
  prisma: PrismaClient,
  ctx: ScopeContext,
  businessId: string,
  deps: DetectionDeps = {},
): Promise<DetectionResult> {
  const now = deps.now?.() ?? new Date();
  const since = new Date(now.getTime() - LEDGER_LOOKBACK_DAYS * DAY_MS);
  const ledgerReads = deps.ledger === undefined ? [] : await deps.ledger(ctx, businessId, since.toISOString().slice(0, 10));

  return scopedDb(
    prisma,
    ctx,
    async (db) => {
      const suppression = await loadClientSuppression(db, businessId);
      const candidates: EvidenceCandidate[] = [];

      // (a)
      for (const t of await detectUnmatchedChases(db, businessId, suppression)) {
        candidates.push({
          engine: 'UNMATCHED_TRANSACTION',
          refKey: t.transactionId,
          transactionId: t.transactionId,
          supplierName: t.merchantName ?? t.descriptionRaw,
          amountPence: t.amountPence,
          occurredAt: t.bookedAt,
          description: t.descriptionRaw,
        });
      }

      // (b) — read-only on the supplier-statement lane's rows.
      const missingLines = await db.supplierStatementLine.findMany({
        where: { status: 'MISSING', statement: { businessId } },
        select: { id: true, reference: true, lineDate: true, amountPence: true, statement: { select: { supplierName: true } } },
      });
      for (const line of missingLines) {
        candidates.push({
          engine: 'SUPPLIER_STATEMENT_GAP',
          refKey: line.id,
          supplierStatementLineId: line.id,
          supplierName: line.statement.supplierName,
          amountPence: line.amountPence,
          occurredAt: line.lineDate,
          description: line.reference === null ? 'On the supplier statement, not in the books' : `Statement line ${line.reference}`,
        });
      }

      // (d)
      for (const read of ledgerReads) {
        for (const item of read.ok ? read.items : []) {
          candidates.push({
            engine: 'LEDGER_TXN_NO_ATTACHMENT',
            refKey: item.ref,
            externalRef: item.ref,
            supplierName: item.supplierName,
            amountPence: item.amountPence,
            occurredAt: item.date === null ? null : new Date(`${item.date}T00:00:00Z`),
            description: `${item.label} has no receipt attached`,
          });
        }
      }

      // (e)
      const documents = await db.document.findMany({
        where: {
          businessId,
          deletedAt: null,
          supplierName: { not: null },
          documentDate: { not: null, gte: new Date(now.getTime() - 400 * DAY_MS) },
          docType: { not: 'STATEMENT' },
          state: { notIn: ['REJECTED', 'FAILED'] },
        },
        select: { id: true, supplierName: true, documentDate: true },
      });
      const dated = documents.flatMap((d) =>
        d.supplierName === null || d.documentDate === null
          ? []
          : [{ documentId: d.id, supplierName: d.supplierName, documentDate: d.documentDate }],
      );
      for (const gap of detectRecurringGaps(dated, now)) {
        candidates.push({
          engine: 'EXPECTED_RECURRING_MISSING',
          refKey: `${gap.supplierKey}:${gap.period}`,
          supplierName: gap.supplierName,
          amountPence: null,
          occurredAt: new Date(`${gap.period}-01T00:00:00Z`),
          period: gap.period,
          description: `${gap.cadence === 'monthly' ? 'Monthly' : 'Quarterly'} document from ${gap.supplierName} has not arrived for ${gap.period}`,
        });
      }

      const kept = candidates.filter(
        (c) =>
          !isSuppressedForClient(suppression, {
            descriptionRaw: c.engine === 'UNMATCHED_TRANSACTION' ? c.description : null,
            supplierLabel: c.supplierName,
          }),
      );
      const created = kept.length === 0 ? 0 : (await db.missingEvidence.createMany({ data: kept.map((c) => ({ ...c, businessId })), skipDuplicates: true })).count;

      const settled = await settleOpenFindings(db, businessId, suppression, {
        ledgerReads,
        since,
        dated,
        now,
      });

      if (created > 0) {
        await db.notification.create({
          data: {
            businessId,
            event: 'missing-evidence.detected',
            payload: {
              message: `${created} new missing ${created === 1 ? 'document' : 'documents'} found — open the client's Chases tab to ask for ${created === 1 ? 'it' : 'them'}.`,
              count: created,
              engines: [...new Set(kept.map((c) => c.engine))],
            },
          },
        });
      }
      return { created, ...settled };
    },
    { timeoutMs: 30_000 },
  );
}

/** Resolve or suppress OPEN findings the evidence (or the client's list) now covers. */
async function settleOpenFindings(
  db: ScopedClient,
  businessId: string,
  suppression: ClientSuppression,
  facts: {
    ledgerReads: Awaited<ReturnType<LedgerUnattachedReader>>;
    since: Date;
    dated: readonly DatedSupplierDocument[];
    now: Date;
  },
): Promise<{ resolved: number; suppressed: number }> {
  const open = await db.missingEvidence.findMany({
    where: { businessId, state: 'OPEN' },
    select: {
      id: true,
      engine: true,
      refKey: true,
      transactionId: true,
      supplierStatementLineId: true,
      supplierName: true,
      description: true,
      occurredAt: true,
      period: true,
    },
  });
  if (open.length === 0) return { resolved: 0, suppressed: 0 };

  const txnIds = open.flatMap((o) => (o.transactionId === null ? [] : [o.transactionId]));
  const txns = new Map(
    (
      await db.bankTransaction.findMany({
        where: { id: { in: txnIds } },
        select: { id: true, matchState: true, chaseSuppressed: true, matches: { where: { state: 'CONFIRMED' }, select: { documentId: true }, take: 1 } },
      })
    ).map((t) => [t.id, t]),
  );
  const lineIds = open.flatMap((o) => (o.supplierStatementLineId === null ? [] : [o.supplierStatementLineId]));
  const lines = new Map(
    (
      await db.supplierStatementLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, status: true, matchedDocumentId: true } })
    ).map((l) => [l.id, l]),
  );
  const ledgerOk = new Map<string, Set<string>>();
  for (const read of facts.ledgerReads) if (read.ok) ledgerOk.set(read.vendor, new Set(read.items.map((i) => i.ref)));
  const docInPeriod = new Map<string, string>();
  for (const d of facts.dated) docInPeriod.set(`${supplierKey(d.supplierName)}:${periodOf(monthIndex(d.documentDate))}`, d.documentId);

  let resolved = 0;
  let suppressed = 0;
  const stamp = async (id: string, data: Prisma.MissingEvidenceUpdateManyMutationInput): Promise<void> => {
    // Compare-and-swap on OPEN: a human dismissal in between wins.
    await db.missingEvidence.updateMany({ where: { id, state: 'OPEN' }, data: { ...data, resolvedAt: facts.now } });
  };

  for (const row of open) {
    if (
      isSuppressedForClient(suppression, {
        descriptionRaw: row.engine === 'UNMATCHED_TRANSACTION' ? row.description : null,
        supplierLabel: row.supplierName,
      })
    ) {
      await stamp(row.id, { state: 'SUPPRESSED', resolvedReason: 'suppression-list' });
      suppressed += 1;
      continue;
    }
    let documentId: string | null | undefined;
    let reason: string | null = null;
    switch (row.engine) {
      case 'UNMATCHED_TRANSACTION': {
        const t = row.transactionId === null ? undefined : txns.get(row.transactionId);
        if (t === undefined || t.matchState !== 'UNMATCHED') {
          reason = 'document-matched';
          documentId = t?.matches[0]?.documentId;
        } else if (t.chaseSuppressed) {
          await stamp(row.id, { state: 'SUPPRESSED', resolvedReason: 'suppression-list' });
          suppressed += 1;
          continue;
        }
        break;
      }
      case 'SUPPLIER_STATEMENT_GAP': {
        const line = row.supplierStatementLineId === null ? undefined : lines.get(row.supplierStatementLineId);
        if (line === undefined || line.status !== 'MISSING') {
          reason = 'statement-line-covered';
          documentId = line?.matchedDocumentId;
        }
        break;
      }
      case 'LEDGER_TXN_NO_ATTACHMENT': {
        const seen = ledgerOk.get(row.refKey.split(':')[0] ?? '');
        // Only a successful read, and only inside its window, can say "attached now".
        if (seen !== undefined && !seen.has(row.refKey) && (row.occurredAt === null || row.occurredAt >= facts.since)) {
          reason = 'attachment-added';
        }
        break;
      }
      case 'EXPECTED_RECURRING_MISSING': {
        const found = docInPeriod.get(row.refKey);
        if (found !== undefined) {
          reason = 'document-arrived';
          documentId = found;
        }
        break;
      }
      default:
        break;
    }
    if (reason !== null) {
      await stamp(row.id, { state: 'RESOLVED', resolvedReason: reason, resolvedByDocumentId: documentId ?? null });
      resolved += 1;
    }
  }
  return { resolved, suppressed };
}

// ── The sweep ───────────────────────────────────────────────────────────────

/**
 * Every active business of every practice, under that practice's SYSTEM actor
 * (the sanctioned sweep — RLS answers, not a filter). One business failing
 * never ends the sweep.
 */
export async function runMissingEvidenceSweep(
  prisma: PrismaClient,
  deps: DetectionDeps = {},
): Promise<{ businesses: number; created: number; resolved: number; failed: number }> {
  const logger = new Logger('MissingEvidenceSweep');
  let businesses = 0;
  let created = 0;
  let resolved = 0;
  let failed = 0;
  for (const practice of await systemActorsByPractice(prisma)) {
    const ctx = systemContext(practice.practiceId, practice.systemUserId);
    const rows = await scopedDb(prisma, ctx, (db) =>
      db.business.findMany({ where: { practiceId: practice.practiceId, isActive: true }, select: { id: true } }),
    );
    for (const { id } of rows) {
      businesses += 1;
      try {
        const result = await detectMissingEvidenceForBusiness(prisma, ctx, id, deps);
        created += result.created;
        resolved += result.resolved;
      } catch (error) {
        failed += 1;
        logger.warn(`missing-evidence detection failed for business ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (created + resolved + failed > 0) {
    logger.log(`missing-evidence sweep: ${businesses} businesses, ${created} new, ${resolved} resolved, ${failed} failed`);
  }
  return { businesses, created, resolved, failed };
}
