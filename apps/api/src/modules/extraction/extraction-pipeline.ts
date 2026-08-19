/**
 * The extraction pipeline step (METH Stage 4). This is the piece
 * `validation-dedupe/CLAUDE.md` named in its own TODO — "wire the pipeline
 * (extraction completion) onto `resolveProcessedState` when extraction lands" —
 * and the reason a document finally leaves RECEIVED.
 *
 * Per persisted document, in the worker after the sink writes it:
 *   RECEIVED → PROCESSING  (visible immediately)
 *   run the extractor        (a 2–4 s simulated read, OUTSIDE any transaction)
 *   PROCESSING → READY | TO_REVIEW | FAILED
 *
 * It writes the accepted `Extraction`, the coding `Suggestion`s, the denormalised
 * header projection on `documents` (the ONE code path that owns it —
 * prisma/CLAUDE.md open question 3), and a `document_events` row, all under the
 * practice's SYSTEM actor through `scopedDb`, exactly like the sink. It is
 * idempotent and re-entrant: a redelivery or a crash-retry re-reads the state and
 * does nothing twice.
 */

import type { Prisma } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import { resolveSystemActor } from '../../common/db/resolve-system-actor.js';
import { systemContext } from '../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../common/db/scoped-db.js';
import { resolveProcessedState, transitionDocument } from '../validation-dedupe/index.js';
import {
  DEMO_EXTRACTOR_KIND,
  DEMO_MODEL_VERSION,
  type DocumentExtractor,
  type ExtractedDocument,
  type ExtractionOutcome,
  type ExtractionRequest,
} from './document-extractor.js';

export interface ExtractionInput {
  readonly documentId: string;
  /**
   * The practice that anchors the document — the SYSTEM actor's scope. Supplied
   * by the caller (it is needed to build the scoped context BEFORE the row can be
   * read under RLS), the one thing extraction cannot read for itself.
   */
  readonly practiceId: string;
  /** The routed business, or null while Unrouted — the scope for rule honouring. */
  readonly businessId: string | null;
  readonly traceId: string;
}

/**
 * What extraction finished with — the header the auto-close hook (chase, METH
 * Stage 8) needs to compare against open chases, plus the final state so the
 * caller runs auto-close ONLY for a document that actually landed (READY /
 * TO_REVIEW), never a FAILED or skipped one. Money is integer pence; the date is
 * the stored UTC instant. `null` from `run` means "nothing was extracted this
 * call" — a FAILED read, a no-op redelivery, or a document already finalised.
 */
export interface ExtractionCompletion {
  readonly documentId: string;
  readonly businessId: string | null;
  readonly state: 'READY' | 'TO_REVIEW';
  readonly supplierName: string | null;
  readonly totalPence: number | null;
  readonly documentDate: Date | null;
}

export interface ExtractionStep {
  run(input: ExtractionInput): Promise<ExtractionCompletion | null>;
}

export interface ExtractionStepLogger {
  log(message: string): void;
  warn(message: string): void;
}

const NOOP_LOGGER: ExtractionStepLogger = { log() {}, warn() {} };

/**
 * A deterministic 2–4 s "processing" delay derived from the byte hash — same
 * document, same latency (the mocking doctrine's determinism), and long enough
 * that the PROCESSING state renders truthfully in the demo.
 * // DEMO-MOCK: real extraction latency is whatever Textract/vision takes.
 */
export function extractionLatencyMs(byteHash: string): number {
  const seed = Number.parseInt(byteHash.slice(0, 4), 16);
  return 2000 + ((Number.isFinite(seed) ? seed : 0) % 2000);
}

/** The category a supplier rule sets, from its `sets` JSON — null when it sets none. */
export function categoryFromRule(sets: Prisma.JsonValue): string | null {
  if (typeof sets !== 'object' || sets === null || Array.isArray(sets)) return null;
  const value = (sets as Record<string, unknown>)['categoryCode'];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** `YYYY-MM-DD` → a UTC instant for a `DateTime` column (UTC in storage). */
function toStoredDate(ymd: string | null): Date | null {
  return ymd === null ? null : new Date(`${ymd}T00:00:00.000Z`);
}

export interface PrismaExtractionStepOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger?: ExtractionStepLogger;
}

export class PrismaExtractionStep implements ExtractionStep {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: ExtractionStepLogger;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly extractor: DocumentExtractor,
    options: PrismaExtractionStepOptions = {},
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  async run(input: ExtractionInput): Promise<ExtractionCompletion | null> {
    const systemUserId = await resolveSystemActor(this.prisma, input.practiceId);
    const ctx = systemContext(input.practiceId, systemUserId);

    // Phase 1 — claim PROCESSING, and read the identity the extractor needs
    // (filename + byteHash) FROM THE ROW, so this works for every channel: email
    // and WhatsApp thread them through the job, but a web upload is persisted by
    // its own service and its job carries only the documentId. Idempotent: only a
    // RECEIVED (fresh) or an already-PROCESSING (a crash between the phases)
    // document proceeds; a finalised one is a no-op.
    const started = await scopedDb(this.prisma, ctx, (db) => this.begin(db, input));
    if (started === null) return null;

    // Phase 2 — the read itself. Deliberately OUTSIDE any transaction: a 2–4 s
    // delay must not hold a DB row locked.
    await this.sleep(extractionLatencyMs(started.byteHash));
    const outcome = await this.extractor.extract(started);

    // Phase 3 — write results and finalise the state, atomically. The completion
    // (the header + final state) is what the caller hands the auto-close hook; it
    // is null for a FAILED read, so a chase never closes on a document we could
    // not read.
    return scopedDb(this.prisma, ctx, (db) => this.finish(db, input, outcome));
  }

  private async begin(db: ScopedClient, input: ExtractionInput): Promise<ExtractionRequest | null> {
    const doc = await db.document.findUnique({
      where: { id: input.documentId },
      // s3Key and mimeType are what a REAL extractor needs — the bytes, not just
      // their identity (METH Stage 15). DemoExtractor ignores both.
      select: { id: true, state: true, originalFilename: true, byteHash: true, s3Key: true, mimeType: true },
    });
    if (doc === null) {
      this.logger.warn(`extract: document ${input.documentId} not visible — skipping (trace=${input.traceId})`);
      return null;
    }
    const identity: ExtractionRequest = {
      filename: doc.originalFilename,
      byteHash: doc.byteHash,
      s3Key: doc.s3Key,
      mimeType: doc.mimeType,
    };
    if (doc.state === 'PROCESSING') return identity; // re-entrant: a prior attempt got this far
    if (doc.state !== 'RECEIVED') {
      this.logger.log(`extract: ${input.documentId} already ${doc.state} — skipping (idempotent, trace=${input.traceId})`);
      return null;
    }
    await transitionDocument(db, { id: doc.id, state: doc.state }, { to: 'PROCESSING', traceId: input.traceId, detail: { stage: 'extract' } });
    return identity;
  }

  private async finish(db: ScopedClient, input: ExtractionInput, outcome: ExtractionOutcome): Promise<ExtractionCompletion | null> {
    const doc = await db.document.findUnique({ where: { id: input.documentId }, select: { id: true, state: true } });
    if (doc === null || doc.state !== 'PROCESSING') return null; // a concurrent worker finalised it — no-op
    const from = { id: doc.id, state: 'PROCESSING' as const };

    if (!outcome.ok) {
      await transitionDocument(db, from, {
        to: 'FAILED',
        failure: outcome.failure,
        traceId: input.traceId,
        detail: { stage: 'extract' },
      });
      this.logger.warn(`extract: ${input.documentId} FAILED ${outcome.failure.code} (trace=${input.traceId})`);
      return null; // a document we could not read closes no chase
    }

    const extracted = outcome.document;
    const alreadyWritten = await db.extraction.findFirst({
      where: { documentId: input.documentId, isAccepted: true },
      select: { id: true },
    });

    let categoryCode = extracted.categoryCode;
    if (alreadyWritten === null) {
      const rule =
        extracted.supplierName === null || input.businessId === null
          ? null
          : await db.rule.findFirst({
              where: {
                businessId: input.businessId,
                isActive: true,
                tier: 'SUPPLIER_CUSTOMER',
                scopeKey: extracted.supplierName,
              },
              orderBy: { createdAt: 'desc' },
            });
      const ruleCategory = rule === null ? null : categoryFromRule(rule.sets);
      if (ruleCategory !== null) categoryCode = ruleCategory;
      await this.writeExtraction(db, input, extracted, rule?.id ?? null, categoryCode);
    } else {
      // Defensive, not a live path: the extraction write and the final transition
      // below share THIS transaction, so "accepted extraction present but still
      // PROCESSING" cannot arise from a crash between them (both commit or both
      // roll back). The guard keeps the write idempotent anyway — cheap insurance
      // if a future flow (re-extraction) ever splits them. Trust the stored header.
      const stored = await db.document.findUnique({ where: { id: input.documentId }, select: { categoryCode: true } });
      categoryCode = stored?.categoryCode ?? categoryCode;
    }

    const finalState = resolveProcessedState(
      { totalPence: extracted.totalPence, supplierName: extracted.supplierName, categoryCode },
      { validatorFailed: extracted.validatorFailed },
    );
    await transitionDocument(db, from, { to: finalState, traceId: input.traceId, detail: { stage: 'extract', outcome: finalState } });
    this.logger.log(`extract: ${input.documentId} → ${finalState} (trace=${input.traceId})`);

    // The header the auto-close hook compares against open chases. Only a landed
    // document (READY | TO_REVIEW) returns one — the caller runs auto-close on the
    // real product data, not on a validator-blocked or failed read.
    return {
      documentId: input.documentId,
      businessId: input.businessId,
      state: finalState,
      supplierName: extracted.supplierName,
      totalPence: extracted.totalPence,
      documentDate: toStoredDate(extracted.documentDate),
    };
  }

  private async writeExtraction(
    db: ScopedClient,
    input: ExtractionInput,
    extracted: ExtractedDocument,
    sourceRuleId: string | null,
    categoryCode: string | null,
  ): Promise<void> {
    // Line items ride in the existing `fields` jsonb (METH_MODE §3.2: "store it in
    // an existing jsonb field... and note it"). The Extraction row has no
    // line-item column; the contract carries `Extraction.lineItems` but the read
    // projection does not surface it yet — a real gap, flagged on the PR, not
    // papered over. // DEMO-MOCK: proper line-item persistence is a schema/contract call.
    const fields = { ...extracted.fields, lineItems: extracted.lineItems } as unknown as Prisma.InputJsonValue;

    await db.extraction.create({
      data: {
        documentId: input.documentId,
        fields,
        extractorKind: DEMO_EXTRACTOR_KIND,
        modelVersion: DEMO_MODEL_VERSION,
        overallConfidence: extracted.overallConfidence,
        validatorResults: extracted.validatorResults as unknown as Prisma.InputJsonValue,
        isAccepted: true,
      },
    });

    await db.suggestion.createMany({
      data: extracted.suggestions.map((suggestion) => {
        const isCategory = suggestion.field === 'categoryCode';
        const ruleWon = isCategory && sourceRuleId !== null;
        return {
          documentId: input.documentId,
          field: suggestion.field,
          value: (isCategory ? categoryCode : suggestion.value) as Prisma.InputJsonValue,
          confidence: suggestion.confidence,
          reasoning: ruleWon
            ? `Coded by an active supplier rule for ${extracted.supplierName ?? 'this supplier'}.`
            : suggestion.reasoning,
          ...(ruleWon ? { sourceRuleId } : {}),
          modelVersion: DEMO_MODEL_VERSION,
        };
      }),
    });

    // The denormalised header projection — THE single writer (prisma/CLAUDE.md
    // open question 3). Money straight through as pence; dates stored UTC.
    await db.document.update({
      where: { id: input.documentId },
      data: {
        docType: extracted.docType,
        supplierName: extracted.supplierName,
        customerName: extracted.customerName,
        documentDate: toStoredDate(extracted.documentDate),
        dueDate: toStoredDate(extracted.dueDate),
        currency: extracted.currency,
        totalPence: extracted.totalPence,
        taxPence: extracted.taxPence,
        reference: extracted.reference,
        categoryCode,
      },
    });

    await db.documentEvent.create({
      data: {
        documentId: input.documentId,
        stage: 'extract',
        outcome: 'extracted',
        traceId: input.traceId,
        detail: {
          extractorKind: DEMO_EXTRACTOR_KIND,
          modelVersion: DEMO_MODEL_VERSION,
          ...(sourceRuleId === null ? {} : { sourceRuleId }),
        } as Prisma.InputJsonValue,
      },
    });
  }
}

/**
 * Offline fixture — records the calls, so the ingest processor stays
 * unit-testable. Returns a caller-supplied completion (default null) so a
 * processor test can drive the auto-close branch without a real extraction.
 */
export class RecordingExtractionStep implements ExtractionStep {
  readonly runs: ExtractionInput[] = [];

  constructor(private readonly completion: ExtractionCompletion | null = null) {}

  async run(input: ExtractionInput): Promise<ExtractionCompletion | null> {
    this.runs.push(input);
    if (this.completion === null) return null;
    // Reflect the call's document/business so a test needn't restate them.
    return { ...this.completion, documentId: input.documentId, businessId: input.businessId };
  }
}
