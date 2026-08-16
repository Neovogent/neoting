import { createHash } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import type { PrismaClient } from '../../../common/db/prisma.js';
import { resolveSystemActor } from '../../../common/db/resolve-system-actor.js';
import { systemContext } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';

export interface PersistDocumentInput {
  readonly idempotencyKey: string;
  readonly practiceId: string;
  readonly businessId: string | null;
  readonly s3Key: string;
  readonly byteHash: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly channel: 'EMAIL' | 'WHATSAPP';
  readonly originalFilename: string;
  readonly submitterLabel: string | null;
  readonly routing: unknown;
  readonly traceId: string;
  /** dHash of the sanitised image bytes (#40); null for PDFs and undecodable rasters. */
  readonly perceptualHash: string | null;
  /**
   * What the sender wrote alongside the document — the WhatsApp caption (#79).
   *
   * ⚠ ALREADY WRAPPED in `<untrusted_content>` by the webhook, and it stays that
   * way in the column. A caption is data, never instructions (§9.6), and this
   * value is read back by extraction, which puts it in front of a model. Never
   * unwrap it to store it "more tidily".
   */
  readonly description: string | null;
}

export interface PersistedDocument {
  readonly documentId: string;
  /** false when a redelivery found the row already there — the idempotent no-op. */
  readonly created: boolean;
}

export interface DocumentSink {
  persist(input: PersistDocumentInput): Promise<PersistedDocument>;
}

/**
 * A stable document id derived from the job's `idempotencyKey`.
 *
 * The idempotencyKey — NOT the byteHash — is the dedupe key: the same receipt
 * legitimately forwarded for two different clients has identical bytes but two
 * different jobs and must become two documents, while a redelivery of one job
 * has the same idempotencyKey and must collapse to one. Deriving the primary key
 * from it turns a redelivery into a key collision the sink treats as a no-op.
 */
export function documentIdFor(idempotencyKey: string): string {
  return `doc_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24)}`;
}

/**
 * Postgres unique-violation, surfaced by Prisma as `P2002`.
 *
 * Narrowed by hand rather than by importing `PrismaClientKnownRequestError`,
 * which lives under `@prisma/client/runtime` — a path the `no-restricted-imports`
 * rule guarding `scopedDb` deliberately does not exempt.
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2002';
}

/** Offline fixture — records what would have persisted, idempotent on the id. */
export class InMemoryDocumentSink implements DocumentSink {
  readonly persisted = new Map<string, PersistDocumentInput>();

  async persist(input: PersistDocumentInput): Promise<PersistedDocument> {
    const documentId = documentIdFor(input.idempotencyKey);
    if (this.persisted.has(documentId)) return { documentId, created: false };
    this.persisted.set(documentId, input);
    return { documentId, created: true };
  }
}

/**
 * The real sink: resolve the SYSTEM actor, then write the `Document` and its
 * first `DocumentEvent` in ONE `scopedDb` transaction under the practice's system
 * context, so RLS — not convention — enforces the tenancy anchor. Idempotent on
 * the derived id: a redelivery finds the row and no-ops, adding no duplicate
 * document and no duplicate event.
 */
export class PrismaDocumentSink implements DocumentSink {
  constructor(private readonly prisma: PrismaClient) {}

  async persist(input: PersistDocumentInput): Promise<PersistedDocument> {
    const documentId = documentIdFor(input.idempotencyKey);
    const systemUserId = await resolveSystemActor(this.prisma, input.practiceId);

    return scopedDb(this.prisma, systemContext(input.practiceId, systemUserId), async (db) => {
      const existing = await db.document.findUnique({ where: { id: documentId }, select: { id: true } });
      if (existing !== null) return { documentId, created: false };

      // ⚠ THE find-THEN-create ABOVE IS NOT ATOMIC, AND THE IN-MEMORY
      // ProcessedStore DOES NOT COVER IT. That store is per-process; SES
      // redelivering the same message produces a NEW BullMQ job, which a second
      // worker task can run concurrently with the first. Both find nothing,
      // both create, and one loses on the primary key.
      //
      // Without this catch that loser throws, the job retries, and a redelivery
      // shows up as a DLQ entry and a page for something that was in fact
      // handled correctly. Issue #20's requirement is that a redelivery is a
      // NO-OP — so the collision is the answer, not the error: the row is there,
      // written by the winner, with the same derived id and the same content.
      try {
        await db.document.create({
          data: {
            id: documentId,
            practiceId: input.practiceId,
            businessId: input.businessId,
            s3Key: input.s3Key,
            byteHash: input.byteHash,
            perceptualHash: input.perceptualHash,
            mimeType: input.mimeType,
            byteSize: input.byteSize,
            channel: input.channel,
            originalFilename: input.originalFilename,
            // Business known → its workspace (Costs vs Sales is a later
            // classification, so it defaults to COSTS, the common case). Unknown →
            // UNROUTED, anchored on the practice.
            inbox: input.businessId === null ? 'UNROUTED' : 'COSTS',
            state: 'RECEIVED',
            description: input.description,
            submitterLabel: input.submitterLabel,
            routingDecision: input.routing as Prisma.InputJsonValue,
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) return { documentId, created: false };
        throw error;
      }

      await db.documentEvent.create({
        data: {
          documentId,
          stage: 'ingest',
          outcome: 'received',
          traceId: input.traceId,
          detail: { channel: input.channel } as Prisma.InputJsonValue,
        },
      });

      return { documentId, created: true };
    });
  }
}
