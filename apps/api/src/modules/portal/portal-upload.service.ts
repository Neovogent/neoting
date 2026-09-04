import { randomUUID } from 'node:crypto';

import { HttpStatus, Logger } from '@nestjs/common';

import type { DocumentUpload } from '@neoting/contracts/model';

import type { PrismaClient } from '../../common/db/prisma.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { fingerprint, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { AppException } from '../../common/problem/problem.js';
import { assertMayIngest } from '../billing/index.js';
import {
  type DocumentStore,
  documentIdFor,
  isAllowedMime,
  maxBytesForChannel,
  signUploadToken,
  type UploadClaims,
  uploadIntentKey,
} from '../ingestion-routing/index.js';
import { type PortalSessionFacts, portalSessionRequired, systemScopeFor } from './portal-session-context.js';
import type { PortalSessionService } from './portal-session.service.js';
import type { PortalUploadIntent, PortalUploadService } from './portal-upload.port.js';

/**
 * `POST /v1/portal/uploads` — the delegated upload intent (METH Stage 9, SoT §4
 * Stage 8.4).
 *
 * The portal's step one of two, and deliberately the SAME two steps web upload
 * takes: declare what is coming, get a presigned `PUT` straight to object
 * storage, then complete through `POST /v1/document-uploads/{uploadId}/complete`
 * — which the contract makes accept the portal bearer for exactly this reason.
 * The API never receives the bytes, which is what keeps the lightest surface in
 * the product light on a phone with one bar.
 *
 * **Everything mechanical is reused, not re-derived** (`ingestion-routing`'s
 * seam): the channel cap, the MIME allowlist, the object key, the signed-token
 * format and the derived document id. A second copy of any of them is how the
 * two lanes start disagreeing about what an upload is, and the disagreement
 * would surface as a client's receipt failing to complete.
 *
 * **What is NOT reused, and why this is its own service.** Three things differ,
 * and each is a tenancy decision rather than a parameter:
 *
 *  1. **The business comes from the session row, never from the request.** The
 *     contract's `PortalUploadRequest` has no `businessId` — the client holding
 *     a forwarded SMS link does not get to name whose books their photo lands
 *     in. Web upload resolves a caller-supplied business through RLS; here the
 *     business is already decided by the `otp_sessions` row the bearer resolved.
 *  2. **The channel is `SMS_PORTAL`, fixed.** It is a fact about how the
 *     document arrived, not a client claim, and it is what pins the 25 MB client
 *     cap (SoT §4 Stage 1) rather than the 100 MB accountant one.
 *  3. **⚠ THE CRUX: the derived document id is granted to the session before the
 *     intent is returned.** See `grantDerivedDocument` below.
 *
 * **It writes, and it is legitimately outside Review → Approve.** The contract
 * marks it `x-nt-side-effect: ingest` — the same standing as web upload:
 * submitting evidence creates a new record and changes no existing one. No chase
 * moves state here; that happens on the auto-close path (Stage 8) when the
 * document actually lands and extraction has read it.
 */

export interface PortalUploadConfig {
  /**
   * `UPLOAD_URL_SECRET` — the SAME secret web upload signs with, and it has to
   * be: completion is `POST /document-uploads/{uploadId}/complete`, which
   * verifies the token with that secret. A portal-specific signing key would
   * mint intents nothing could complete.
   */
  readonly uploadSecret: string;
  readonly uploadTtlSeconds: number;
}

/**
 * The arrival channel every portal document carries. `SMS_PORTAL` maps to the
 * `client` cap channel (25 MB) in `upload-policy.ts` — the contract's own 413
 * text for this operation says 25 MB, and this is where that number comes from.
 */
const PORTAL_CHANNEL = 'SMS_PORTAL';

/** The contract's own ceiling on `PortalUploadRequest.filename`. */
const FILENAME_MAX = 255;

/**
 * The client's note as the document's display filename (review item 11):
 * whitespace-collapsed, path separators stripped (the `safeBasename` concern),
 * the REAL extension kept, clamped to the contract's 255. A note that survives
 * none of that falls back to the declared filename — a rename must never cost
 * the upload.
 */
function displayFilename(note: string | null | undefined, filename: string): string {
  if (note === null || note === undefined) return filename;
  const safe = note.replace(/[\\/]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (safe === '') return filename;
  const dot = filename.lastIndexOf('.');
  const extension = dot > 0 ? filename.slice(dot) : '';
  return `${safe.slice(0, FILENAME_MAX - extension.length)}${extension}`;
}

export class PrismaPortalUploadService implements PortalUploadService {
  private readonly logger = new Logger(PrismaPortalUploadService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly store: DocumentStore,
    private readonly sessions: PortalSessionService,
    private readonly idempotency: IdempotencyStore,
    private readonly config: PortalUploadConfig,
  ) {}

  /**
   * Mint a delegated upload intent for this portal session.
   *
   * `facts` are the resolved `otp_sessions` row (never the raw bearer), so the
   * tenant, the practice and the actor are already decided by the time anything
   * here runs.
   */
  async createPortalUpload(
    facts: PortalSessionFacts,
    request: PortalUploadIntent,
    idempotencyKey?: string,
  ): Promise<DocumentUpload> {
    const replay = await this.replayed(facts, idempotencyKey, request);
    if (replay !== null) return replay;

    this.assertAcceptable(request);

    // The practice comes from the BUSINESS ROW, not from the bearer's claims and
    // not from the caller. It is the document's tenancy anchor and it decides
    // whether the worker can extract at all (`ingest-processor.ts` skips a job
    // with no practice), so it is read from the row that owns the answer. The
    // read also proves the session's business is still reachable at all.
    const business = await scopedDb(this.prisma, systemScopeFor(facts), (db) =>
      db.business.findUnique({
        where: { id: facts.businessId },
        select: { id: true, practiceId: true, subscriptionStatus: true },
      }),
    );
    if (business === null) {
      // The session names a business that is gone (or that its own practice can
      // no longer reach). That is a session which cannot be honoured, not a
      // missing document — and `NT-OTP-002` is the only 4xx this operation
      // declares besides validation. A 404 would also be off-contract here.
      this.logger.warn(`portal session ${facts.otpSessionId} names unreachable business ${facts.businessId}`);
      // ⚠ It said "Open the link from your text message again" until 2 Sep 2026.
      // There is no SMS in Initial Delivery — S2 made email the transport and
      // A13 sends chases through it (D40/D47) — so that sentence pointed a
      // client at a message that was never sent. `apps/web` swept the same claim
      // at launch M8 and `portal-session-context.ts` swept its own copy on
      // 28 Aug; this was the third instance, which neither pass could see.
      throw portalSessionRequired('This portal session is no longer valid. Open the link in your email again.');
    }

    // ENTITLEMENT (D48). The client is the payer under D48, so the surface the
    // client uploads through is exactly where the rule has to bite — gating
    // only the accountant's own upload would leave the main ID path open.
    //
    // ✅ **The 402 is DECLARED now** (2 Sep 2026). `createPortalUpload` listed
    // 400/401/409/413/415/429/500 and no 402 while `createDocumentUpload`
    // declared one — so a client generated from the spec had no branch for the
    // single most likely refusal on the main ID intake path, and the one the
    // client themselves can fix. The behaviour was always contracted
    // (`docs/runbooks/error-codes.md` puts `NT-BIL-001` at 402 on "any
    // entitlement-gated operation", and the Stripe webhook's own description
    // says new uploads stop at a lapse); only the response was missing, and it
    // stayed missing because the G7 ceremony made a one-line spec addition a
    // process. That ceremony was retired on 1 Sep.
    assertMayIngest(business);

    const key = uploadIntentKey(facts.businessId, randomUUID());
    const presigned = await this.store.presignPut({
      key,
      contentType: request.mimeType,
      byteSize: request.byteSize,
      expiresInSeconds: this.config.uploadTtlSeconds,
    });

    const expiresAtMs = Date.now() + this.config.uploadTtlSeconds * 1000;
    const claims: UploadClaims = {
      businessId: facts.businessId,
      practiceId: business.practiceId,
      channel: PORTAL_CHANNEL,
      // The client's own name for the document, when they gave one (review
      // item 11): "July fuel receipt.jpg" instead of IMG_2937.jpg, keeping the
      // REAL extension — `formatFor` picks the statement lane's reader off it,
      // and a renamed CSV must still read as one. No note → the filename as
      // declared, exactly as before.
      filename: displayFilename(request.note, request.filename),
      mimeType: request.mimeType,
      byteSize: request.byteSize,
      // Nothing splits yet (web-upload's own out-of-scope note), and a phone
      // photo of one receipt is one document. `AUTO_SPLIT` would be a promise
      // this lane has no reason to make.
      splitMode: 'SINGLE_DOCUMENT',
      ...(request.transactionId === undefined || request.transactionId === null
        ? {}
        : { chaseTransactionId: request.transactionId }),
      // The unedited note rides too, so completion can record what the client
      // SAID on the provenance event — carried, never trusted, like the
      // transaction declaration above it.
      ...(request.note === undefined || request.note === null ? {} : { portalNote: request.note }),
      s3Key: key,
      expiresAtMs,
    };
    const uploadId = signUploadToken(claims, this.config.uploadSecret);

    await this.grantDerivedDocument(facts, uploadId);

    const response: DocumentUpload = {
      uploadId,
      upload: { method: 'PUT', url: presigned.url, headers: presigned.headers },
      expiresAt: new Date(expiresAtMs).toISOString(),
      maxBytes: maxBytesForChannel(PORTAL_CHANNEL),
    };
    await this.remember(facts, idempotencyKey, request, response);
    return response;
  }

  /**
   * ⚠ **THE CRUX OF THE DELEGATED PATH.** Read this before changing anything
   * about the order of `createUpload`.
   *
   * `documents_delegated_upload` (prisma/sql/rls.sql) keys on
   * `id = ANY(app_granted_item_ids())`. A delegated context can therefore write
   * and read exactly the document ids in its grant — and a freshly-verified
   * session's grant is EMPTY, because nothing has been uploaded yet. Completion
   * under that context would be refused by Postgres, and `ScopeContextSchema`
   * refuses to even build the context (an empty grant "reads as no restriction
   * to a reviewer but denies everything in SQL").
   *
   * The document id is knowable before the document exists: completion derives
   * it as `documentIdFor(uploadId)` from the signed intent. So it is computed
   * here and appended to `otp_sessions.granted_item_ids` BEFORE the intent is
   * handed back — after which the delegated context covers exactly the one
   * document this client is about to create, and nothing else. RLS, not the
   * handler, is then what allows the write.
   *
   * It happens after the token is signed (the id derives from it) and before the
   * response is returned or remembered: a client that never receives the intent
   * holds nothing it could complete, and a grant for a document that is never
   * created grants access to a row that does not exist.
   *
   * Idempotent by construction — `grantItems` appends only ids the session does
   * not already hold, and a replayed `Idempotency-Key` returns above without
   * reaching here at all.
   */
  private async grantDerivedDocument(facts: PortalSessionFacts, uploadId: string): Promise<void> {
    const documentId = documentIdFor(uploadId);
    await this.sessions.grantItems(facts, [documentId]);
    this.logger.log(`portal session ${facts.otpSessionId} granted document ${documentId}`);
  }

  /**
   * The two declared refusals, checked exactly as web upload checks them and for
   * the same reasons — same helpers, same codes, same "name the field, never
   * echo the value" rule for the MIME message (an error response is logged and
   * screenshotted far more freely than a request body).
   */
  private assertAcceptable(request: PortalUploadIntent): void {
    // The generated schema is `zod.number().min(1)` — a MINIMUM, not `.int()`.
    // `1.5` and `1e21` both pass the boundary and would go into the presigned
    // content-length and the `byte_size` column. Web upload re-checks this for
    // the same reason; the contract's `type: integer` is not what the generator
    // emitted.
    if (!Number.isInteger(request.byteSize) || request.byteSize < 1) {
      throw new AppException('NT-VAL-001', HttpStatus.BAD_REQUEST, 'byteSize must be a positive integer');
    }
    const maxBytes = maxBytesForChannel(PORTAL_CHANNEL);
    if (request.byteSize > maxBytes) {
      throw new AppException(
        'NT-ING-001',
        HttpStatus.PAYLOAD_TOO_LARGE,
        `Declared size exceeds the ${maxBytes}-byte cap for this channel`,
        'Client-side compression should have prevented this for a camera photo.',
      );
    }
    if (!isAllowedMime(request.mimeType)) {
      throw new AppException(
        'NT-ING-002',
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'The declared MIME type is not on the allowlist for this channel',
        undefined,
        [{ field: 'mimeType', message: 'Not an accepted document type for this channel.' }],
      );
    }
  }

  /**
   * The replay store key is NAMESPACED BY SESSION, and that is a tenancy
   * decision rather than tidiness.
   *
   * `Idempotency-Key` is a client-generated UUID and the store is a flat map. If
   * two portal sessions in two different businesses used the same key with the
   * same body — a UUID collision, a client library with a fixed key, a hostile
   * guess — the second caller would be handed the FIRST caller's intent, which
   * carries the first caller's `businessId` in its signed claims. Prefixing with
   * the session id makes that a miss instead: the second caller mints their own
   * intent under their own session.
   *
   * The fingerprint carries the session id too, so a same-key-different-payload
   * replay is still the contract's 409 `NT-IDM-001` within a session.
   */
  private storeKey(facts: PortalSessionFacts, idempotencyKey: string): string {
    return `portal-upload:${facts.otpSessionId}:${idempotencyKey}`;
  }

  private async replayed(
    facts: PortalSessionFacts,
    idempotencyKey: string | undefined,
    request: unknown,
  ): Promise<DocumentUpload | null> {
    if (idempotencyKey === undefined) return null;
    const record = await this.idempotency.get(this.storeKey(facts, idempotencyKey));
    if (record === null) return null;
    if (record.requestHash !== fingerprint({ otpSessionId: facts.otpSessionId, request })) {
      throw new AppException('NT-IDM-001', HttpStatus.CONFLICT, 'This Idempotency-Key was already used with a different payload');
    }
    return record.response as DocumentUpload;
  }

  private async remember(
    facts: PortalSessionFacts,
    idempotencyKey: string | undefined,
    request: unknown,
    response: unknown,
  ): Promise<void> {
    if (idempotencyKey === undefined) return;
    await this.idempotency.put(this.storeKey(facts, idempotencyKey), {
      requestHash: fingerprint({ otpSessionId: facts.otpSessionId, request }),
      response,
    });
  }
}
