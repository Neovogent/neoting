import { randomUUID } from 'node:crypto';

import { HttpStatus, Logger } from '@nestjs/common';
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
import { fingerprint, type IdempotencyStore } from '../../../common/idempotency/idempotency-store.js';
import { assertMayIngest } from '../../billing/index.js';
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
 * A completion arriving from the OTP portal instead of the workspace (METH
 * Stage 9, SoT §4 Stage 8.4) — `completeDocumentUpload` accepts the portal
 * bearer alongside the workspace session, and the contract says why: "a
 * delegated session completes the intents it created, and the RLS delegated
 * policies keep it inside its own grant. One completion path, two trust levels,
 * no second door."
 *
 * Two contexts, because the delegated policies cover exactly two tables:
 *
 *  - `context` is the DELEGATED scope the document row is written under.
 *    `documents_delegated_upload`'s WITH CHECK (`business_id =
 *    app_business_id()`) and USING (`id = ANY(app_granted_item_ids())`) are what
 *    ALLOW the write — not this handler, which never compares a business to
 *    anything. That is the point of routing the portal through RLS rather than
 *    through a trusted flag.
 *  - `eventsContext` is the practice SYSTEM scope, and it is needed because
 *    `document_events` has **no delegated branch**: its policy reaches its
 *    tenant through `app_can_access_document`, which begins
 *    `app_session_scope() = 'user'`. A delegated context inserting an event row
 *    is refused by Postgres. So the provenance row is written immediately after,
 *    under the same actor the workers use.
 */
export interface DelegatedCompletion {
  /** The delegated `ScopeContext` — built from the `otp_sessions` row by the portal seam. */
  readonly context: ScopeContext;
  /** The practice SYSTEM `ScopeContext`, for the one write the delegated scope cannot make. */
  readonly eventsContext: ScopeContext;
  /** The `otp_sessions` row behind this completion. Recorded, so an audit can name the session. */
  readonly otpSessionId: string;
  /** The chase the session exists to answer, when it has one. */
  readonly chaseId: string | null;
  /**
   * Tell the practice that a client uploaded (SoT §4 Stage 8.8 — "notify the
   * accountant when a client uploads", the 45-vote gap).
   *
   * A CLOSURE rather than an injected service, deliberately. This module has no
   * business knowing what a portal notification is, and `WebUploadService` would
   * otherwise grow a constructor dependency on another module for a call it
   * makes on one branch. `delegatedCompletionFor` — which already resolves the
   * session and already reaches the portal seam — closes over both.
   *
   * Called exactly once, on the completion that CREATED the document: notifying
   * at intent time would announce bytes that may never arrive, and notifying on
   * a replay would double-toast.
   */
  readonly notifyUploadReceived: (documentId: string) => Promise<void>;
}

/**
 * What `documents.submitter_label` and the document's own event carry for a
 * portal upload. **The exact string the SoT asks the audit trail to record**
 * (§4 Stage 8.3: "the audit trail records *requested-from* vs
 * *uploaded-by-delegated-session*"), so it is a constant rather than prose
 * retyped in two places.
 *
 * `submitter_user_id` cannot say this: it is a foreign key to `users` and a
 * delegated session is not a user — it is a grant held by whoever the link was
 * forwarded to. The actor there is the recipient contact's provisioned user if
 * one exists and the practice SYSTEM actor otherwise (`portal-session.service.ts`
 * decides it once, at session creation). The *label* is what says the upload
 * came in through a delegated session rather than from that actor at a keyboard.
 * Who we ASKED lives on the session row (`requested_from_contact_id`).
 */
export const DELEGATED_SUBMITTER_LABEL = 'uploaded-by-delegated-session';

/**
 * Web upload (issue #76), two steps because the API never touches the bytes:
 * `createUpload` presigns a direct PUT and hands back a stateless signed
 * `uploadId`; `completeUpload` verifies what landed, persists the `Document` in
 * RECEIVED through `scopedDb`, and enqueues sanitisation.
 *
 * `completeDelegatedUpload` is the same step two under a portal session (METH
 * Stage 9): same token, same storage checks, same derived id, same job — a
 * different scope context and one extra provenance row.
 */
export class WebUploadService {
  private readonly logger = new Logger(WebUploadService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly store: DocumentStore,
    private readonly queue: IngestQueue,
    private readonly idempotency: IdempotencyStore,
    private readonly config: WebUploadConfig,
  ) {}

  async createUpload(ctx: ScopeContext, request: UploadIntentRequest, idempotencyKey?: string): Promise<DocumentUpload> {
    const replay = await this.replayed<DocumentUpload>(null, idempotencyKey, request);
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
      db.business.findUnique({
        where: { id: request.businessId },
        select: { id: true, practiceId: true, subscriptionStatus: true },
      }),
    );
    if (business === null) {
      throw new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'No such business', 'No business with that id is reachable.');
    }

    // ENTITLEMENT (D48), checked here and not in `scopedDb` or an RLS policy —
    // `modules/billing/entitlement.ts` explains at length why that placement is
    // the decision rather than the detail. Checked AFTER reachability so a
    // caller cannot learn whether a business they cannot see is paying, and
    // BEFORE a URL is signed so no bytes reach storage for a workspace that
    // may not accept them. Reading, reviewing, approving and exporting are all
    // untouched by this: the line is that a lapsed client stops ADDING.
    assertMayIngest(business);

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
    await this.remember(null, idempotencyKey, request, response);
    return response;
  }

  /** Step two, from the workspace: the caller's own `ScopeContext` writes the document and its event. */
  async completeUpload(ctx: ScopeContext, uploadId: string, byteHash: string, idempotencyKey?: string): Promise<Document> {
    return this.complete(ctx, null, uploadId, byteHash, idempotencyKey);
  }

  /**
   * Step two, from the OTP portal. Same verification, same storage checks, same
   * derived document id, same enqueued job — the document is simply written
   * under the DELEGATED context, so the RLS delegated policies are what admit
   * it, and its provenance is recorded (see {@link DelegatedCompletion}).
   *
   * The replay namespace is per-session for the same reason the portal's intent
   * store is: `Idempotency-Key` is a client-generated UUID over a shared map,
   * and one session must never be handed another session's response.
   */
  async completeDelegatedUpload(
    caller: DelegatedCompletion,
    uploadId: string,
    byteHash: string,
    idempotencyKey?: string,
  ): Promise<Document> {
    return this.complete(caller.context, caller, uploadId, byteHash, idempotencyKey);
  }

  private async complete(
    ctx: ScopeContext,
    delegated: DelegatedCompletion | null,
    uploadId: string,
    byteHash: string,
    idempotencyKey?: string,
  ): Promise<Document> {
    const replayScope = delegated === null ? null : `portal-complete:${delegated.otpSessionId}`;
    const replay = await this.replayed<Document>(replayScope, idempotencyKey, { uploadId, byteHash });
    if (replay !== null) return replay;

    const verified = verifyUploadToken(uploadId, this.config.uploadSecret);
    if (!verified.ok) {
      throw new AppException('NT-VAL-001', HttpStatus.BAD_REQUEST, 'Invalid uploadId');
    }
    const claims = verified.claims;
    if (claims.expiresAtMs < this.now()) {
      throw new AppException('NT-ING-005', HttpStatus.GONE, 'This upload intent has expired — start a new upload');
    }
    if (delegated !== null) this.assertGranted(delegated, uploadId);

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

    const { row, created } = await this.persistDocument(ctx, uploadId, claims, byteHash, delegated);
    if (delegated !== null && created) await this.afterDelegatedCreate(delegated, row.id, claims);
    // Only the completion that actually CREATED the document enqueues. A second
    // completion of the same intent — a replay with a different Idempotency-Key,
    // or none at all — finds the existing row and must not enqueue again:
    // `BullmqIngestQueue` sets `removeOnComplete: true`, so jobId dedupe lasts
    // only while the job is in the queue, and a re-enqueue after the first job
    // finished is accepted. This mattered more once sanitisation landed (Stage
    // A3) — a second job would re-read, re-decode and re-store the bytes — so
    // the step is idempotent on the document's state as well: only a RECEIVED
    // document is sanitised. Two gates, because this one is check-then-act.
    // Same `{ row, created }` shape as `PrismaDocumentSink` (#20), for the same reason.
    if (created) await this.enqueueSanitisation(row.id, claims, byteHash);

    const response = toDocumentResponse(row);
    await this.remember(replayScope, idempotencyKey, { uploadId, byteHash }, response);
    return response;
  }

  /**
   * A portal session may only complete the intents IT created.
   *
   * The grant is the proof: `createPortalUpload` derives `documentIdFor(uploadId)`
   * at intent time and appends it to `otp_sessions.granted_item_ids`, so an
   * `uploadId` whose derived id is not in this session's grant is one this
   * session never asked for. Without the check the failure is still closed —
   * Postgres refuses the INSERT's RETURNING under
   * `documents_delegated_upload`'s USING clause — but it arrives as a 500 on a
   * phone, and only for a foreign business; a second session inside the SAME
   * business would otherwise be able to complete another's intent.
   *
   * **404, not 403.** An intent this session cannot reach is one that, as far as
   * it is concerned, does not exist (`packages/contracts/CLAUDE.md`).
   */
  private assertGranted(delegated: DelegatedCompletion, uploadId: string): void {
    if (delegated.context.grantedItemIds.includes(documentIdFor(uploadId))) return;
    throw new AppException(
      'NT-VAL-001',
      HttpStatus.NOT_FOUND,
      'No such upload intent',
      'This upload was not started by this portal session.',
    );
  }

  /**
   * The two things a delegated creation owes the rest of the product: the
   * provenance row on the document's timeline, and the practice being told a
   * client uploaded.
   *
   * **Neither may fail the request.** By this point the document is persisted
   * and the bytes are in storage; a failure here would return a 5xx, and the
   * client's retry would find `created: false`, skip the enqueue, and leave the
   * document in RECEIVED forever — the "nothing is ever silently dropped"
   * invariant inverted by a toast. Same stance, same reason, as the ingest
   * processor's auto-close hook: log it, and let the safe direction win.
   */
  private async afterDelegatedCreate(delegated: DelegatedCompletion, documentId: string, claims: UploadClaims): Promise<void> {
    await this.recordDelegatedProvenance(delegated, documentId, claims);
    try {
      await delegated.notifyUploadReceived(documentId);
    } catch (error) {
      this.logger.warn(`portal upload notification for ${documentId} failed (the document is safe): ${String(error)}`);
    }
  }

  /**
   * The delegated provenance row — SoT §4 Stage 8.3's "the audit trail records
   * *requested-from* vs *uploaded-by-delegated-session*", written where a human
   * will see it: the document's own event timeline (`GET /documents/{id}/events`).
   *
   * Written under the practice SYSTEM context, in its own transaction, because
   * `document_events` has no delegated policy (see {@link DelegatedCompletion}).
   * That splits it from the document's own INSERT, so it is best-effort and
   * says so: **the row already carries the label** in `submitter_label`, so a
   * failure here loses the timeline entry, not the provenance. Failing the
   * request instead would be worse than that trade — the document is persisted
   * by this point, and a client retry would find `created: false`, skip the
   * enqueue, and leave the document in RECEIVED forever. Same stance, same
   * reason, as the ingest processor's auto-close hook.
   */
  private async recordDelegatedProvenance(
    delegated: DelegatedCompletion,
    documentId: string,
    claims: UploadClaims,
  ): Promise<void> {
    try {
      await scopedDb(this.prisma, delegated.eventsContext, (db) =>
        db.documentEvent.create({
          data: {
            documentId,
            stage: 'upload',
            outcome: DELEGATED_SUBMITTER_LABEL,
            traceId: currentTraceId() ?? null,
            detail: {
              otpSessionId: delegated.otpSessionId,
              chaseId: delegated.chaseId,
              channel: claims.channel,
              // What the client SAID this answers, never a verified fact — see
              // `UploadClaims.chaseTransactionId`. Auto-close compares the
              // extraction against every open chase regardless.
              declaredTransactionId: claims.chaseTransactionId ?? null,
              // The client's own words about the document (review item 11) —
              // recorded verbatim as data; the display half already landed on
              // the row's filename at intent time.
              clientNote: claims.portalNote ?? null,
            },
          },
        }),
      );
    } catch (error) {
      this.logger.warn(
        `delegated provenance event for ${documentId} failed (submitter_label still records it): ${String(error)}`,
      );
    }
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
    delegated: DelegatedCompletion | null,
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
            // ⚠ THE BROWSER'S CLAIM, and it is only ever a placeholder. The
            // worker's sanitisation step (Stage A3) sniffs the bytes and
            // overwrites this column, along with `s3_key`, `byte_hash`,
            // `byte_size` and `perceptual_hash`, before extraction reads any of
            // them. It has to be written now because the column is NOT NULL and
            // the row exists before the bytes have ever been looked at; nothing
            // downstream may treat it as authoritative until sanitisation has
            // run. This comment said "sniffing overwrites during sanitisation"
            // when no such step existed — now it does.
            mimeType: claims.mimeType,
            byteSize: claims.byteSize,
            byteHash,
            channel: claims.channel as DocumentRow['channel'],
            inbox: 'COSTS', // business is known — routed, Costs by default
            state: 'RECEIVED',
            submitterUserId: ctx.actorId,
            // The provenance that survives even if the event write below (or its
            // delegated equivalent) never lands — it is on the row itself.
            ...(delegated === null ? {} : { submitterLabel: DELEGATED_SUBMITTER_LABEL }),
          },
        });
        // A delegated context CANNOT write this: `document_events` reaches its
        // tenant through `app_can_access_document`, which requires session scope
        // `user`. `recordDelegatedProvenance` writes the portal's event under the
        // practice SYSTEM context immediately after this transaction commits.
        if (delegated === null) {
          await db.documentEvent.create({
            data: { documentId: id, stage: 'upload', outcome: 'received', traceId: currentTraceId() ?? null },
          });
        }
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
    // filename/mimeType/byteSize, so the worker's persist path does not fire on
    // it (it would double-create) — the `documentId` sends it down the
    // already-persisted branch, which since Stage A3 sanitises the bytes, points
    // the row at the cleaned object, and only then dedupes and extracts.
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

  /**
   * The replay store is a flat map keyed by a CLIENT-generated UUID, so a
   * delegated completion namespaces its keys by session (`scope`). Two portal
   * sessions in two businesses reusing one key must miss, not be handed each
   * other's document. The workspace path passes `null` and its keys are
   * unchanged.
   */
  private storeKey(scope: string | null, idempotencyKey: string): string {
    return scope === null ? idempotencyKey : `${scope}:${idempotencyKey}`;
  }

  private async replayed<T>(scope: string | null, idempotencyKey: string | undefined, request: unknown): Promise<T | null> {
    if (idempotencyKey === undefined) return null;
    const record = await this.idempotency.get(this.storeKey(scope, idempotencyKey));
    if (record === null) return null;
    if (record.requestHash !== fingerprint(request)) {
      throw new AppException('NT-IDM-001', HttpStatus.CONFLICT, 'This Idempotency-Key was already used with a different payload');
    }
    return record.response as T;
  }

  private async remember(scope: string | null, idempotencyKey: string | undefined, request: unknown, response: unknown): Promise<void> {
    if (idempotencyKey === undefined) return;
    await this.idempotency.put(this.storeKey(scope, idempotencyKey), { requestHash: fingerprint(request), response });
  }
}

/** Prisma's unique-constraint error (P2002), duck-typed so no value import of Prisma is needed. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2002';
}
