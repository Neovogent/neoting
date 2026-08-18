import type { UpdateCodingPayload } from '@neoting/contracts/model';
import type { Prisma } from '@prisma/client';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { transitionDocument } from '../document-state.js';
import { resolveProcessedState } from '../readiness.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

/**
 * `document.update-coding` — a human correcting or confirming a document's
 * coding (METH S3, issue #122; named in SoT §8.2 as a state change, which is
 * why it is a proposal and not a `PATCH`).
 *
 * Two surfaces move together, atomically:
 *
 * - **The denormalised header fields** on `documents` — the projection lists
 *   and search read (prisma/CLAUDE.md open question 3 says they must be
 *   written by one code path only; on the correction path, this is it).
 * - **The extraction surface** — a NEW accepted `extractions` row
 *   (`extractor_kind: 'human'`, keyed by the approver), carrying the prior
 *   accepted fields with the corrected ones overwritten as
 *   `provenance: HUMAN_CONFIRMED` / `wasCorrected: true`. A new row rather
 *   than a mutation, because `GET /documents/{id}/extractions` is the
 *   history surface and history is append-only; the previous row loses
 *   `is_accepted`, never its content.
 *
 * The readiness consequence is real product logic: a correction that supplies
 * the last missing mandatory field moves TO_REVIEW → READY, and one that
 * blanks nothing can never demote (the payload carries values, not deletions).
 * Both edges go through the state machine so the event log has no gaps. The
 * validator context is passed empty — the confidence/validator seam in
 * `readiness.ts` is deliberately unfilled, and a human-confirmed value is the
 * strongest provenance the product has.
 *
 * `createRuleFromCorrection` is a recorded seam, exactly like route's
 * `teachRouterForSender`: the rules engine is another lane (`rule.create`,
 * METH S13), so the flag lands on the event for that executor-to-be rather
 * than being silently dropped.
 */
export const updateCodingExecutor: ProposalExecutor<'document.update-coding', UpdateCodingPayload> = {
  kind: 'document.update-coding',

  async execute(db: ScopedClient, input: ExecutionInput<UpdateCodingPayload>): Promise<ExecutionResult> {
    const { payload, traceId, proposalId, ctx } = input;

    const document = await db.document.findUnique({
      where: { id: payload.documentId },
      select: {
        id: true,
        state: true,
        docType: true,
        supplierName: true,
        customerName: true,
        documentDate: true,
        dueDate: true,
        currency: true,
        totalPence: true,
        taxPence: true,
        reference: true,
        categoryCode: true,
        description: true,
        projectRef: true,
      },
    });
    if (document === null) {
      throw new ProposalExecutionRefused('document.update-coding', 'no document with that id');
    }
    // After approval, item details lock (approvals CLAUDE.md). A published
    // document is un-editable until publishing data is cleared through the
    // archive path; an archived one is out of every working queue by design.
    if (document.state === 'PUBLISHED' || document.state === 'ARCHIVED') {
      throw new ProposalExecutionRefused('document.update-coding', `cannot update coding on a ${document.state} document — it is locked`);
    }

    const changes = collectChanges(document, payload.fields);

    // Idempotent replay: the engine may retry after a crash between effect and
    // record. Every value already in place is a success that does nothing —
    // no second event, no second extraction row.
    if (changes.length === 0) {
      return { changed: [{ entity: 'document', id: document.id }], alreadyApplied: true, followUps: [] };
    }

    const data: Prisma.DocumentUpdateInput = {};
    for (const change of changes) {
      (data as Record<string, unknown>)[change.field] = change.write;
    }
    await db.document.update({ where: { id: document.id }, data });

    // The extraction surface: prior accepted fields, corrected ones overwritten
    // as HUMAN_CONFIRMED. Confidence is null on purpose — the contract pairs it
    // with AI_SUGGESTED, and a human answer is not a probability.
    const accepted = await db.extraction.findFirst({
      where: { documentId: document.id, isAccepted: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true, fields: true },
    });
    const priorFields = isJsonObject(accepted?.fields) ? accepted.fields : {};
    const correctedFields: Record<string, unknown> = { ...priorFields };
    for (const change of changes) {
      correctedFields[change.field] = {
        value: change.extractedValue,
        provenance: 'HUMAN_CONFIRMED',
        confidence: null,
        source: `proposal:${proposalId}`,
        wasCorrected: true,
      };
    }
    if (accepted !== null) {
      await db.extraction.update({ where: { id: accepted.id }, data: { isAccepted: false } });
    }
    await db.extraction.create({
      data: {
        documentId: document.id,
        fields: correctedFields as Prisma.InputJsonObject,
        extractorKind: 'human',
        isAccepted: true,
        keyedByUserId: ctx.actorId,
      },
    });

    await db.documentEvent.create({
      data: {
        documentId: document.id,
        stage: 'coding',
        outcome: 'updated',
        traceId,
        detail: {
          proposalId,
          fields: changes.map((c) => c.field).join(','),
          // The seam, recorded rather than dropped (route's teachRouterForSender
          // shape): the rules lane reads this when rule.create lands (METH S13).
          ...(payload.createRuleFromCorrection === true ? { createRuleDeferred: true } : {}),
        },
      },
    });

    // Readiness consequence, through the machine so the log has no gaps.
    // Only the TO_REVIEW → READY edge can fire here: corrections carry values,
    // never deletions, so a correction cannot take a mandatory field away.
    if (document.state === 'TO_REVIEW') {
      const after = {
        totalPence: valueAfter(changes, 'totalPence', document.totalPence) as number | null,
        supplierName: valueAfter(changes, 'supplierName', document.supplierName) as string | null,
        categoryCode: valueAfter(changes, 'categoryCode', document.categoryCode) as string | null,
      };
      if (resolveProcessedState(after) === 'READY') {
        await transitionDocument(db, document, { to: 'READY', traceId, detail: { proposalId, via: 'update-coding' } });
      }
    }

    return {
      changed: [{ entity: 'document', id: document.id }],
      alreadyApplied: false,
      followUps: [],
      detail: { fields: changes.map((c) => c.field).join(',') },
    };
  },
};

interface FieldChange {
  readonly field: string;
  /** What goes into the document column (dates as Date). */
  readonly write: unknown;
  /** What goes into the ExtractedField value (dates as YYYY-MM-DD, per contract). */
  readonly extractedValue: string | number | boolean | null;
}

type HeaderRow = {
  readonly docType: string | null;
  readonly supplierName: string | null;
  readonly customerName: string | null;
  readonly documentDate: Date | null;
  readonly dueDate: Date | null;
  readonly currency: string | null;
  readonly totalPence: number | null;
  readonly taxPence: number | null;
  readonly reference: string | null;
  readonly categoryCode: string | null;
  readonly description: string | null;
  readonly projectRef: string | null;
};

/** The provided fields that actually differ from what the row holds. */
function collectChanges(row: HeaderRow, fields: UpdateCodingPayload['fields']): FieldChange[] {
  const changes: FieldChange[] = [];

  const scalar = (field: keyof HeaderRow, value: string | number | undefined): void => {
    if (value === undefined || row[field] === value) return;
    changes.push({ field, write: value, extractedValue: value });
  };
  // Dates arrive as `YYYY-MM-DD` (format: date) and are stored as UTC midnight —
  // UTC in storage, Europe/London only at render (the repo invariant).
  const date = (field: 'documentDate' | 'dueDate', value: string | undefined): void => {
    if (value === undefined) return;
    const write = new Date(`${value}T00:00:00.000Z`);
    if (row[field]?.getTime() === write.getTime()) return;
    changes.push({ field, write, extractedValue: value });
  };

  scalar('docType', fields.docType);
  scalar('supplierName', fields.supplierName);
  scalar('customerName', fields.customerName);
  date('documentDate', fields.documentDate);
  date('dueDate', fields.dueDate);
  scalar('currency', fields.currency);
  scalar('totalPence', fields.totalPence);
  scalar('taxPence', fields.taxPence);
  scalar('reference', fields.reference);
  scalar('categoryCode', fields.categoryCode);
  scalar('description', fields.description);
  scalar('projectRef', fields.projectRef);
  return changes;
}

function valueAfter(changes: readonly FieldChange[], field: string, current: unknown): unknown {
  return changes.find((c) => c.field === field)?.write ?? current;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
