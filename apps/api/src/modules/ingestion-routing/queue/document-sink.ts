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

      await db.document.create({
        data: {
          id: documentId,
          practiceId: input.practiceId,
          businessId: input.businessId,
          s3Key: input.s3Key,
          byteHash: input.byteHash,
          mimeType: input.mimeType,
          byteSize: input.byteSize,
          channel: input.channel,
          originalFilename: input.originalFilename,
          // Business known → its workspace (Costs vs Sales is a later
          // classification, so it defaults to COSTS, the common case). Unknown →
          // UNROUTED, anchored on the practice.
          inbox: input.businessId === null ? 'UNROUTED' : 'COSTS',
          state: 'RECEIVED',
          submitterLabel: input.submitterLabel,
          routingDecision: input.routing as Prisma.InputJsonValue,
        },
      });

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
