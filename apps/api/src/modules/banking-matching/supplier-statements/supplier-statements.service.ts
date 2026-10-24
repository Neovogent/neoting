import { Injectable } from '@nestjs/common';

import type { SupplierStatement } from '@neoting/contracts/model';

import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../../common/db/scoped-db.js';
import { type CandidateDocument, reconcileSupplierStatement } from './reconcile.js';

/**
 * `GET /v1/supplier-statements` — a client's supplier statements, reconciled
 * against the documents on file at the moment of the read (issue #318).
 *
 * ## Why this endpoint had to exist
 *
 * The accountant's Supplier Statements tab has shown "on file / no document"
 * marks since the prototype, and every one of them was computed IN THE
 * BROWSER out of whatever documents happened to be loaded, plus one invented
 * missing line. `supplier_statements` and `supplier_statement_lines` have
 * existed in prisma just as long, and nothing in this API read them. A
 * reconciliation nobody did, presented as one that was — the highest-trust-
 * cost failure this product can have, on a screen whose whole purpose is to
 * find the invoices nobody knew were missing.
 *
 * ## Computed at read time, written nowhere
 *
 * The outcome per line comes from `reconcileSupplierStatement`, the pure half,
 * fed the stored lines and the client's candidate documents. The stored
 * `status` / `matched_document_id` columns are deliberately NOT written: this
 * is `x-nt-side-effect: none`, and a GET that wrote would be a side-effect path
 * outside Review → Approve. Persisting the verdict is a later write lane.
 *
 * ## Tenancy: RLS, and no second mechanism
 *
 * Every query runs inside ONE `scopedDb` transaction — statements, their
 * lines, the candidate documents and the source filenames all under the same
 * GUCs, so a document RLS withholds is simply absent from the candidate set and
 * the line it would have answered reads `MISSING`, which is what the caller is
 * entitled to see. The `businessId` filter NARROWS a set RLS already bounded;
 * a business outside the caller's reach yields an EMPTY list, never a 404 —
 * the same answer as "that client has no supplier statements".
 *
 * ## There is no POST here and none may be added
 *
 * Nothing in this API creates a supplier statement yet (no upload intent, no
 * extraction step — an emailed statement lands as a plain document). That is
 * the next piece of work and it is a write lane with its own contract-change;
 * a write door on this read surface would be a second way to create one.
 */
@Injectable()
export class SupplierStatementsService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Newest statement period first, then newest row — the `GET /statements` order. */
  async listSupplierStatements(ctx: ScopeContext, businessId?: string): Promise<SupplierStatement[]> {
    return scopedDb(this.prisma, ctx, async (db) => {
      const statements = await db.supplierStatement.findMany({
        where: businessId === undefined ? {} : { businessId },
        orderBy: [{ statementEndDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        select: {
          id: true,
          businessId: true,
          documentId: true,
          supplierName: true,
          statementEndDate: true,
          outstandingBalancePence: true,
          createdAt: true,
          lines: {
            select: { id: true, reference: true, lineDate: true, amountPence: true },
          },
        },
      });
      if (statements.length === 0) return [];

      const businessIds = [...new Set(statements.map((s) => s.businessId))];
      const sourceDocumentIds = statements.flatMap((s) => (s.documentId === null ? [] : [s.documentId]));

      const [candidates, sources] = await Promise.all([
        candidateDocuments(db, businessIds),
        sourceDocumentIds.length === 0
          ? Promise.resolve([])
          : db.document.findMany({
              where: { id: { in: sourceDocumentIds } },
              select: { id: true, originalFilename: true },
            }),
      ]);

      const fileNames = new Map(sources.map((doc) => [doc.id, doc.originalFilename]));
      const sourceIds = new Set(sourceDocumentIds);
      const candidatesByBusiness = new Map<string, CandidateDocument[]>();
      for (const doc of candidates) {
        // The statement's own source file is a summary of invoices, not one of
        // them — it must never answer a line on itself (or on a sibling).
        if (doc.businessId === null || sourceIds.has(doc.id)) continue;
        const list = candidatesByBusiness.get(doc.businessId) ?? [];
        list.push(doc);
        candidatesByBusiness.set(doc.businessId, list);
      }

      return statements.map((row) => {
        const { lines, totals } = reconcileSupplierStatement(
          row.supplierName,
          row.lines,
          candidatesByBusiness.get(row.businessId) ?? [],
        );
        return {
          id: row.id,
          businessId: row.businessId,
          documentId: row.documentId,
          fileName: row.documentId === null ? null : (fileNames.get(row.documentId) ?? null),
          supplierName: row.supplierName,
          statementEndDate: toIsoDate(row.statementEndDate),
          // Integer pence straight through — the supplier's own claim, never recomputed.
          outstandingBalancePence: row.outstandingBalancePence,
          lines: lines.map((line) => ({
            id: line.id,
            reference: line.reference,
            lineDate: toIsoDate(line.lineDate),
            amountPence: line.amountPence,
            outcome: line.outcome,
            matchedDocumentId: line.matchedDocumentId,
          })),
          totals,
          createdAt: row.createdAt.toISOString(),
        };
      });
    });
  }
}

/**
 * The documents that may answer a statement line, for a set of businesses, in
 * one query. The filter is the honest minimum: not in the Trash, carrying a
 * supplier and a total (a line cannot be answered by a document that names
 * neither), not a refusal (`REJECTED`/`FAILED` is not evidence we hold), and
 * not itself a statement (a bank statement is not an invoice). ARCHIVED stays
 * in — processed evidence still proves the invoice exists. The sales side
 * falls out on its own: a sales invoice has `supplierName` null.
 *
 * ⚠ Prisma's `not` on a nullable column drops NULL rows, so the type exclusion
 * is written as an OR that keeps an untyped document in the set.
 */
function candidateDocuments(db: ScopedClient, businessIds: readonly string[]) {
  return db.document.findMany({
    where: {
      businessId: { in: [...businessIds] },
      deletedAt: null,
      supplierName: { not: null },
      totalPence: { not: null },
      state: { notIn: ['REJECTED', 'FAILED'] },
      OR: [{ docType: null }, { docType: { not: 'STATEMENT' } }],
    },
    select: {
      id: true,
      businessId: true,
      supplierName: true,
      totalPence: true,
      documentDate: true,
      reference: true,
      docType: true,
    },
  });
}

/** `YYYY-MM-DD` in UTC — the storage instant, rendered as the date it is (the `GET /statements` rule). */
function toIsoDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}
