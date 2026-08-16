import { createHash, randomUUID } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';

import type { Document as DocumentRow } from '@prisma/client';

import type { Document, DocumentUpload, DocumentUploadRequest } from '@neoting/contracts/model';

import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import { AppException } from '../../../common/problem/problem.js';
import { currentTraceId } from '../../../common/trace/trace-context.js';
import { documentIdFor } from '../queue/document-sink.js';
import { type DocumentStore, uploadIntentKey } from '../storage/document-store.js';
import type { IngestJob, IngestQueue } from '../webhooks/whatsapp/ingest-queue.js';
import { toDocumentResponse } from './document-response.js';
import { fingerprint, type IdempotencyStore } from './idempotency-store.js';
import { isAllowedMime, maxBytesForChannel } from './upload-policy.js';
import { signUploadToken, type UploadClaims, verifyUploadToken } from './upload-token.js';

export interface WebUploadConfig {
  readonly uploadSecret: string;
  readonly uploadTtlSeconds: number;
}

/**
 * Web upload (issue #76), two steps because the API never touches the bytes:
 * `createUpload` presigns a direct PUT and hands back a stateless signed
 * `uploadId`; `completeUpload` verifies what landed, persists the `Document` in
 * RECEIVED through `scopedDb`, and enqueues sanitisation.
 */
export class WebUploadService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly store: DocumentStore,
    private readonly queue: IngestQueue,
    private readonly idempotency: IdempotencyStore,
    private readonly config: WebUploadConfig,
  ) {}

  async createUpload(ctx: ScopeContext, request: DocumentUploadRequest, idempotencyKey?: string): Promise<DocumentUpload> {
    const replay = await this.replayed<DocumentUpload>(idempotencyKey, request);
    if (replay !== null) return replay;

    if (!Number.isInteger(request.byteSize) || request.byteSize < 1) {
      throw new AppException('NT-VAL-001', HttpStatus.BAD_REQUEST, 'byteSize must be a positive integer');
    }
    const maxBytes = maxBytesForChannel(request.channel);
    if (request.byteSize > maxBytes) {
      throw new AppException('NT-ING-001', HttpStatus.PAYLOAD_TOO_LARGE, `Declared size exceeds the ${maxBytes}-byte cap for this channel`);
    }
    if (!isAllowedMime(request.mimeType)) {
      throw new AppException('NT-ING-002', HttpStatus.UNSUPPORTED_MEDIA_TYPE, `Declared MIME type '${request.mimeType}' is not accepted`);
    }

    const key = uploadIntentKey(request.businessId, randomUUID());
    const presigned = await this.store.presignPut({
      key,
      contentType: request.mimeType,
      byteSize: request.byteSize,
      expiresInSeconds: this.config.uploadTtlSeconds,
    });

    const expiresAtMs = this.now() + this.config.uploadTtlSeconds * 1000;
    const claims: UploadClaims = {
      businessId: request.businessId,
      practiceId: ctx.practiceId ?? null,
      channel: request.channel,
      filename: request.filename,
      mimeType: request.mimeType,
      byteSize: request.byteSize,
      splitMode: request.splitMode ?? 'AUTO_SPLIT',
      ...(request.description === undefined ? {} : { description: request.description }),
      ...(request.documentOwnerContactId === undefined ? {} : { documentOwnerContactId: request.documentOwnerContactId }),
      s3Key: key,
      expiresAtMs,
    };

    const response: DocumentUpload = {
      uploadId: signUploadToken(claims, this.config.uploadSecret),
      upload: { method: 'PUT', url: presigned.url, headers: presigned.headers },
      expiresAt: new Date(expiresAtMs).toISOString(),
      maxBytes,
    };
    await this.remember(idempotencyKey, request, response);
    return response;
  }

  async completeUpload(ctx: ScopeContext, uploadId: string, byteHash: string, idempotencyKey?: string): Promise<Document> {
    const replay = await this.replayed<Document>(idempotencyKey, { uploadId, byteHash });
    if (replay !== null) return replay;

    const verified = verifyUploadToken(uploadId, this.config.uploadSecret);
    if (!verified.ok) {
      throw new AppException('NT-VAL-001', HttpStatus.BAD_REQUEST, 'Invalid uploadId');
    }
    const claims = verified.claims;
    if (claims.expiresAtMs < this.now()) {
      throw new AppException('NT-ING-005', HttpStatus.GONE, 'This upload intent has expired — start a new upload');
    }

    // Verify the bytes actually landed and match the client's declared hash. The
    // declared hash is not trusted — it is checked against what is in storage.
    const head = await this.store.head(claims.s3Key);
    if (head === null) {
      throw new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'No uploaded object was found for this intent');
    }
    const bytes = await this.store.get(claims.s3Key);
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== byteHash) {
      throw new AppException('NT-ING-004', HttpStatus.CONFLICT, 'The uploaded bytes do not match the declared hash');
    }

    const row = await this.persistDocument(ctx, uploadId, claims, byteHash);
    await this.enqueueSanitisation(row.id, claims, byteHash);

    const response = toDocumentResponse(row);
    await this.remember(idempotencyKey, { uploadId, byteHash }, response);
    return response;
  }

  /** Idempotent on the derived id, so a replayed completion returns the same document rather than a second one. */
  private async persistDocument(ctx: ScopeContext, uploadId: string, claims: UploadClaims, byteHash: string): Promise<DocumentRow> {
    const id = documentIdFor(uploadId);
    const outcome = await scopedDb(this.prisma, ctx, async (db) => {
      const existing = await db.document.findUnique({ where: { id } });
      if (existing !== null) return existing;
      try {
        const created = await db.document.create({
          data: {
            id,
            businessId: claims.businessId,
            practiceId: claims.practiceId,
            s3Key: claims.s3Key,
            originalFilename: claims.filename,
            mimeType: claims.mimeType, // declared; sniffing overwrites during sanitisation
            byteSize: claims.byteSize,
            byteHash,
            channel: claims.channel as DocumentRow['channel'],
            inbox: 'COSTS', // business is known — routed, Costs by default
            state: 'RECEIVED',
            submitterUserId: ctx.actorId,
          },
        });
        await db.documentEvent.create({
          data: { documentId: id, stage: 'upload', outcome: 'received', traceId: currentTraceId() ?? null },
        });
        return created;
      } catch (error) {
        if (isUniqueViolation(error)) return null; // concurrent completion won the race
        throw error;
      }
    });
    if (outcome !== null) return outcome;
    const row = await scopedDb(this.prisma, ctx, (db) => db.document.findUnique({ where: { id } }));
    if (row === null) throw new Error(`document ${id} vanished after a unique-violation`);
    return row;
  }

  private async enqueueSanitisation(documentId: string, claims: UploadClaims, byteHash: string): Promise<void> {
    // A sanitisation job for an ALREADY-persisted document. It carries no
    // filename/mimeType/byteSize, so the current worker's persist path does not
    // fire on it (it would double-create) — the worker's web-upload sanitisation
    // step is a follow-up; today the acceptance is the document + the job.
    const job: IngestJob = {
      source: 'web_upload',
      idempotencyKey: documentId,
      documentId,
      from: claims.businessId,
      receivedAtSeconds: Math.floor(this.now() / 1000),
      messageType: 'web_upload',
      caption: null,
      routing: { kind: 'matched', businessId: claims.businessId },
      stale: false,
      storageKey: claims.s3Key,
      sha256: byteHash,
      ...(claims.practiceId === null ? {} : { practiceId: claims.practiceId }),
    };
    await this.queue.enqueue(job);
  }

  private now(): number {
    return Date.now();
  }

  private async replayed<T>(idempotencyKey: string | undefined, request: unknown): Promise<T | null> {
    if (idempotencyKey === undefined) return null;
    const record = await this.idempotency.get(idempotencyKey);
    if (record === null) return null;
    if (record.requestHash !== fingerprint(request)) {
      throw new AppException('NT-IDM-001', HttpStatus.CONFLICT, 'This Idempotency-Key was already used with a different payload');
    }
    return record.response as T;
  }

  private async remember(idempotencyKey: string | undefined, request: unknown, response: unknown): Promise<void> {
    if (idempotencyKey === undefined) return;
    await this.idempotency.put(idempotencyKey, { requestHash: fingerprint(request), response });
  }
}

/** Prisma's unique-constraint error (P2002), duck-typed so no value import of Prisma is needed. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2002';
}
