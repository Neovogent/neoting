import { Body, Controller, Headers, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';

import type { Document, DocumentUpload } from '@neoting/contracts/model';
import {
  completeDocumentUploadBody,
  completeDocumentUploadHeader,
  completeDocumentUploadParams,
  createDocumentUploadBody,
  createDocumentUploadHeader,
} from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../../common/context/context.module.js';
import type { RequestContext } from '../../../common/context/request-context.js';
import { parseBoundary, parseIdempotencyKey } from '../../../common/validation/parse-boundary.js';
import { PORTAL_SESSION_CONTEXT, PORTAL_UPLOAD_NOTIFIER } from '../../portal/index.js';
import { delegatedCompletionFor, type PortalCompletionNotifier, type PortalCompletionResolver } from './delegated-completion.js';
import { WEB_UPLOAD_SERVICE } from './tokens.js';
import type { WebUploadService } from './web-upload.service.js';

/**
 * Web upload, two steps (issue #76, SoT §4 Stage 1).
 *
 * The API never receives the file. Step one declares what is coming and returns
 * a presigned `PUT` straight to object storage; step two verifies what landed
 * and puts the document into the pipeline. That is what keeps a 100 MB
 * accountant batch off the request path — and keeps the OTP portal usable on a
 * phone with one bar.
 *
 * **This is `ingest`, not `proposal`.** Submitting evidence creates a new record
 * and changes no existing one, so it needs no Approve and introduces no
 * side-effect endpoint outside the Review → Approve spine (Governance §10).
 * The contract says so mechanically: both operations are `x-nt-side-effect:
 * ingest`, which the architectural route-table test reads.
 *
 * Thin by design (apps/api/CLAUDE.md, 200-line cap): parse with the generated
 * schemas, take the request context, call ONE service, return its result.
 */
@Controller('document-uploads')
export class WebUploadController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(WEB_UPLOAD_SERVICE) private readonly service: WebUploadService,
    /**
     * The OTP portal's session resolver — because `completeDocumentUpload`
     * accepts the portal bearer alongside the workspace session (`openapi.yaml`,
     * `security: [workspaceSession, portalSession]`). It resolves a bearer the
     * way `REQUEST_CONTEXT` resolves the `nt_session` cookie: a second way to
     * establish who is asking, not a second endpoint.
     */
    @Inject(PORTAL_SESSION_CONTEXT) private readonly portal: PortalCompletionResolver,
    /**
     * The accountant's "a client uploaded" notification (SoT §4 Stage 8.8). It
     * is injected HERE rather than into the service because this is where the
     * portal's two collaborators meet the completion path — the service takes
     * one closure and stays free of the portal entirely.
     */
    @Inject(PORTAL_UPLOAD_NOTIFIER) private readonly notifier: PortalCompletionNotifier,
  ) {}

  /** Step one — declare the upload, get a presigned PUT. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<DocumentUpload> {
    const key = parseIdempotencyKey(createDocumentUploadHeader, idempotencyKey);
    const request = parseBoundary(createDocumentUploadBody, body, 'request body');
    // `require()` resolves the context here, inside Nest's pipeline, so a bad one
    // leaves as a 401 problem+json rather than an Express-level crash (#75).
    return this.service.createUpload(await this.context.require(), request, key);
  }

  /**
   * Step two — the bytes have landed; verify them and enter the pipeline.
   *
   * **Two trust levels, one path.** The contract puts this operation under
   * `workspaceSession` *and* `portalSession`, because it is also step two for
   * `POST /portal/uploads` (METH Stage 9). An `Authorization` header means the
   * portal: `workspaceSession` is a cookie (`nt_session`), so on this operation
   * that header can only be the portal bearer. The portal branch resolves a
   * DELEGATED scope from the `otp_sessions` row and the RLS delegated policies
   * decide what it may write — the handler compares nothing, which is the whole
   * point of routing the portal through the database's own rules.
   */
  @Post(':uploadId/complete')
  @HttpCode(HttpStatus.CREATED)
  async complete(
    @Param('uploadId') uploadId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<Document> {
    const key = parseIdempotencyKey(completeDocumentUploadHeader, idempotencyKey);
    const params = parseBoundary(completeDocumentUploadParams, { uploadId }, 'uploadId');
    const { byteHash } = parseBoundary(completeDocumentUploadBody, body, 'request body');
    if (authorization !== undefined) {
      const caller = await delegatedCompletionFor(this.portal, this.notifier, authorization);
      return this.service.completeDelegatedUpload(caller, params.uploadId, byteHash, key);
    }
    // `require()` resolves the context inside Nest's pipeline, so a bad one
    // leaves as a 401 problem+json rather than an Express-level crash (#75).
    return this.service.completeUpload(await this.context.require(), params.uploadId, byteHash, key);
  }
}
