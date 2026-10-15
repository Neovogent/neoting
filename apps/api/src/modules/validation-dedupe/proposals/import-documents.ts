import type { DocumentImportPayload } from '@neoting/contracts/model';
import type { Prisma } from '@prisma/client';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  type FollowUp,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

const KIND = 'document.import' as const;

/** Deterministic, so a replayed approval finds its own rows instead of doubling them. */
export function importedDocumentId(importId: string, rowNumber: number): string {
  return `imp_${importId}_${rowNumber}`;
}

/**
 * `document.import` — one approval turns every row of a Dext / Hubdoc /
 * AutoEntry / Datamolino export into a TO_REVIEW document with its fields
 * pre-filled (rush/documents).
 *
 * `POST /v1/imports` already stored every original under the business's own
 * `w/<businessId>/` prefix; the prefix is re-checked here because the payload
 * is just JSON by the time it reaches an executor. `createMany` keeps a
 * 500-row import to two inserts inside the engine's 10 s transaction.
 */
export const importDocumentsExecutor: ProposalExecutor<typeof KIND, DocumentImportPayload> = {
  kind: KIND,
  async execute(db: ScopedClient, input: ExecutionInput<DocumentImportPayload>): Promise<ExecutionResult> {
    const { payload, proposalId, traceId } = input;
    const record = await db.import.findUnique({
      where: { id: payload.importId },
      select: { id: true, businessId: true, business: { select: { practiceId: true } } },
    });
    if (record === null) throw new ProposalExecutionRefused(KIND, 'the import is not reachable');

    const prefix = `w/${record.businessId}/`;
    if (payload.rows.some((row) => !row.s3Key.startsWith(prefix))) {
      throw new ProposalExecutionRefused(KIND, 'a row names a stored file that does not belong to this client');
    }

    const practiceId = record.business.practiceId;
    const ids = payload.rows.map((row) => importedDocumentId(record.id, row.rowNumber));
    const existing = await db.document.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const have = new Set(existing.map((row) => row.id));
    const fresh = payload.rows.filter((row) => !have.has(importedDocumentId(record.id, row.rowNumber)));

    if (fresh.length > 0) {
      await db.document.createMany({
        data: fresh.map(
          (row): Prisma.DocumentCreateManyInput => ({
            id: importedDocumentId(record.id, row.rowNumber),
            practiceId,
            businessId: record.businessId,
            s3Key: row.s3Key,
            originalFilename: row.originalFilename,
            mimeType: row.mimeType,
            byteSize: row.byteSize,
            byteHash: row.byteHash,
            channel: 'STRUCTURED_IMPORT',
            submitterLabel: `import:${payload.source}`,
            inbox: 'COSTS',
            state: 'TO_REVIEW',
            supplierName: row.supplierName ?? null,
            documentDate: row.documentDate ? new Date(`${row.documentDate}T00:00:00.000Z`) : null,
            currency: row.currency ?? 'GBP',
            totalPence: row.totalPence ?? null,
            taxPence: row.taxPence ?? null,
            reference: row.reference ?? null,
            categoryCode: row.categoryCode ?? null,
            description: row.description ?? null,
          }),
        ),
      });
      await db.documentEvent.createMany({
        data: fresh.map((row) => ({
          documentId: importedDocumentId(record.id, row.rowNumber),
          stage: 'ingest',
          outcome: 'imported',
          traceId,
          detail: {
            proposalId,
            importId: record.id,
            source: payload.source,
            rowNumber: row.rowNumber,
            netPence: row.netPence ?? null,
            hasImage: row.hasImage,
          },
        })),
      });
    }

    await db.import.update({
      where: { id: record.id },
      data: { state: 'imported', rowCount: payload.rows.length, completedAt: new Date() },
    });

    const followUps: FollowUp[] =
      practiceId === null
        ? []
        : fresh.map((row) => ({
            kind: 'dedupe' as const,
            documentId: importedDocumentId(record.id, row.rowNumber),
            businessId: record.businessId,
            practiceId,
          }));

    return {
      changed: ids.map((id) => ({ entity: 'document' as const, id })),
      alreadyApplied: fresh.length === 0,
      followUps,
      detail: { created: fresh.length, skippedExisting: payload.rows.length - fresh.length },
    };
  },
};
