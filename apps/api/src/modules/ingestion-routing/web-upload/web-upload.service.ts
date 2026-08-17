import { randomUUID } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import type { z } from 'zod';

import type { Document as DocumentRow } from '@prisma/client';

import type { Document, DocumentUpload } from '@neoting/contracts/model';
import type { createDocumentUploadBody } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../../common/db/prisma.js';
import { toDocumentResponse } from '../../../common/documents/document-response.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import { AppException } from '../../../common/problem/problem.js';
import { currentTraceId } from '../../../common/trace/trace-context.js';
import { documentIdFor } from '../queue/document-sink.js';
import { type DocumentStore, uploadIntentKey } from '../storage/document-store.js';
import type { IngestJob, IngestQueue } from '../webhooks/whatsapp/ingest-queue.js';
import { fingerprint, type IdempotencyStore } from './idempotency-store.js';
import { isAllowedMime, maxBytesForChannel } from './upload-policy.js';
import { signUploadToken, type UploadClaims, verifyUploadToken } from './upload-token.js';

export interface WebUploadConfig {
  readonly uploadSecret: string;
  readonly uploadTtlSeconds: number;
}

/**
 * The upload intent as the **boundary** produces it, derived from the generated
 * Zod schema rather than the generated `DocumentUploadRequest` interface.
 *
 * Both come from `openapi.yaml`, so this is still a generated type and not a
 * hand-written DTO. They differ in exactly one way that matters here:
 * `exactOptionalPropertyTypes` is on, Zod infers `splitMode?: SplitMode |
 * undefined`, and the interface writes `splitMode?: SplitMode`. Under that flag
 * those are not the same type and a parsed body will not assign to the
 * interface. Taking the schema's own output type means the service is typed by
 * the thing that actually validated the value — one generated source, no cast
 * at the controller to paper over the difference.
 */
export type UploadIntentRequest = z.infer<typeof createDocumentUploadBody>;

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

  async createUpload(ctx: ScopeContext, request: UploadIntentRequest, idempotencyKey?: string): Promise<DocumentUpload> {
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
      // Names the field, never the value. `mimeType` is client-submitted, and
      // this module's rule is that error responses — which are logged and
      // screenshotted far more freely than request bodies — carry no echoed
      // input. The cap message above is fine: `maxBytes` is a server constant.
      throw new AppException(
        'NT-ING-002',
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'The declared MIME type is not on the allowlist for this channel',
        undefined,
        [{ field: 'mimeType', message: 'Not an accepted document type for this channel.' }],
      );
    }

    // THE BUSINESS IS RESOLVED THROUGH RLS BEFORE ANYTHING IS SIGNED, and that
    // is the whole tenancy guarantee on this path.
    //
    // The presigned key is `w/<businessId>/uploads/…`, taken from the request
    // body. Postgres would refuse a foreign `business_id` at completion
    // (`documents_tenant` WITH CHECK) — but by then the bytes are already
    // sitting in another practice's S3 prefix, and object storage has no RLS to
    // undo that. So reachability is decided here, by the same policy, before a
    // URL exists: `businesses_tenant` makes this `findUnique` return null for a
    // business the caller cannot reach.
    //
    // 404, never 403 — a 403 confirms the record exists (packages/contracts/CLAUDE.md).
    const business = await scopedDb(this.prisma, ctx, (db) =>
      db.business.findUnique({ where: { id: request.businessId }, select: { id: true, practiceId: true } }),
    );
    if (business === null) {
      throw new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'No such business', 'No business with that id is reachable.');
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
      // The practice comes from the BUSINESS row, not from the actor's context.
      // They coincide for practice staff, but a business-level actor has no
      // practiceId in scope, and taking it from there would write a document
      // whose practice anchor is null for one uploader and set for another —
      // the same document filed two different ways depending on who sent it.
      practiceId: business.practiceId,
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
      // No dedicated ingest code exists for "the PUT never landed", and 404 is
      // what the contract lists. NT-VAL-001 is the house code for an otherwise
      // uncoded 4xx (see `ProblemFilter.CODE_BY_STATUS`).
      throw new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'No uploaded object was found for this intent');
    }
    if (head.byteLength !== claims.byteSize) {
      // The presigned signature covers Content-Length, so a mismatch should be
      // unreachable through the URL we minted — this catches the object having
      // been replaced by some other path. Cheap (the HEAD already happened),
      // and it fails before the hash pass reads a single byte.
      throw new AppException('NT-ING-003', HttpStatus.CONFLICT, 'The uploaded bytes do not match the declared size');
    }
    // Streamed by the store, NEVER `get()`: completion verifies up to a
    // channel-cap's worth of bytes (100 MB on the accountant lane), and holding
    // them in one Buffer per in-flight request is the request-path weight the
    // presigned two-step exists to avoid.
    const actualHash = await this.store.sha256(claims.s3Key);
    if (actualHash !== byteHash) {
      // NT-ING-003 is "byte hash mismatch between client and storage" — NT-ING-004
      // is sanitisation rejection, a different failure that happens later.
      throw new AppException('NT-ING-003', HttpStatus.CONFLICT, 'The uploaded bytes do not match the declared hash');
    }

    const { row, created } = await this.persistDocument(ctx, uploadId, claims, byteHash);
    // Only the completion that actually CREATED the document enqueues. A second
    // completion of the same intent — a replay with a different Idempotency-Key,
    // or none at all — finds the existing row and must not enqueue again:
    // `BullmqIngestQueue` sets `removeOnComplete: true`, so jobId dedupe lasts
    // only while the job is in the queue, and a re-enqueue after the first job
    // finished is accepted. Harmless today (the worker no-ops on a job with a
    // documentId), a double-sanitisation the moment that TODO lands.
    // Same `{ row, created }` shape as `PrismaDocumentSink` (#20), for the same reason.
    if (created) await this.enqueueSanitisation(row.id, claims, byteHash);

    const response = toDocumentResponse(row);
    await this.remember(idempotencyKey, { uploadId, byteHash }, response);
    return response;
  }

  /**
   * Idempotent on the derived id, so a replayed completion returns the same
   * document rather than a second one. `created` distinguishes the two, because
   * the caller must only enqueue downstream work on a real creation.
   */
  private async persistDocument(
    ctx: ScopeContext,
    uploadId: string,
    claims: UploadClaims,
    byteHash: string,
  ): Promise<{ row: DocumentRow; created: boolean }> {
    const id = documentIdFor(uploadId);
    const outcome = await scopedDb(this.prisma, ctx, async (db) => {
      const existing = await db.document.findUnique({ where: { id } });
      if (existing !== null) return { row: existing, created: false };
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
        return { row: created, created: true };
      } catch (error) {
        if (isUniqueViolation(error)) return null; // concurrent completion won the race
        throw error;
      }
    });
    if (outcome !== null) return outcome;
    // Lost the primary-key race, so the winner created it and enqueued for it.
    const row = await scopedDb(this.prisma, ctx, (db) => db.document.findUnique({ where: { id } }));
    if (row === null) throw new Error(`document ${id} vanished after a unique-violation`);
    return { row, created: false };
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
